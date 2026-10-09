import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import scenario from '../../scenarios/ai-credits.js';
import { httpsThroughProxy, startHttpsUpstream, startTestProxy } from '../support.js';

const CREDITS_PATH = '/assistant/v1/credits';
const onResponse = scenario.http[0].onResponse;

describe('ai-credits hook', () => {
    test('sets the balance from the defaults and keeps other fields', () => {
        const result = onResponse({ status: 200, json: { credits_left: 999, plan: 'pro' } }, { params: scenario.params });

        assert.deepEqual(result, { status: 200, json: { credits_left: 50, request_cost: 5, can_run: true, plan: 'pro' } });
    });

    test('reports can_run = false when the balance is below the cost', () => {
        const result = onResponse({ status: 200, json: {} }, { params: { ...scenario.params, left: 4 } });

        assert.equal(result.json.can_run, false);
    });

    test('accepts params that arrive as strings from a scenario spec', () => {
        const result = onResponse({ status: 200, json: {} }, { params: { left: '0', cost: '5', fail: 'false' } });

        assert.deepEqual(result.json, { credits_left: 0, request_cost: 5, can_run: false });
    });

    test('replaces a failed upstream response with a 200 balance', () => {
        const result = onResponse({ status: 503, json: { error: 'down' } }, { params: scenario.params });

        assert.deepEqual(result, { status: 200, json: { credits_left: 50, request_cost: 5, can_run: true } });
    });

    test('answers 500 when fail is set', () => {
        assert.equal(onResponse({ status: 200, json: {} }, { params: { ...scenario.params, fail: true } }).status, 500);
        assert.equal(onResponse({ status: 200, json: {} }, { params: { ...scenario.params, fail: 'true' } }).status, 500);
    });

    test('rejects a non-integer balance instead of sending garbage to the app', () => {
        assert.throws(() => onResponse({ status: 200, json: {} }, { params: { ...scenario.params, left: 'lots' } }), /left must be an integer/);
    });
});

describe('ai-credits through the proxy', () => {
    let upstream;
    let proxy;

    before(async () => {
        upstream = await startHttpsUpstream(async (server) => {
            await server.forGet(CREDITS_PATH).thenJson(200, { credits_left: 999, request_cost: 5, can_run: true });
        });
        proxy = await startTestProxy();
    });

    after(async () => {
        await proxy.stop();
        await upstream.stop();
    });

    test('serves an empty balance and logs the rewrite', async () => {
        await proxy.control('PUT', '/active', [{ name: 'ai-credits', params: { left: 0 } }]);
        await proxy.control('DELETE', '/log');

        const response = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}${CREDITS_PATH}`);
        const log = await proxy.control('GET', '/log?modified=true');

        assert.deepEqual(response.json, { credits_left: 0, request_cost: 5, can_run: false });
        assert.deepEqual(log.json[0].modifiedBy, ['ai-credits']);
    });
});
