import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import scenario from '../../scenarios/billing-grace-period.js';
import { httpsRawThroughProxy, httpsThroughProxy, startHttpsUpstream, startTestProxy } from '../support.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILE_PATH = '/users/v1/profile';
const SUBSCRIPTION_PATH = '/billing/v1/subscription';
const onProfile = scenario.http[0].onResponse;
const onSubscription = scenario.http[1].onResponse;
const APP_STORE_SUBSCRIPTION = { status: 'ACTIVE', plan: { period_months: 12, store: 'APP_STORE' }, other: 1 };

function assertDaysAgo(isoDate, days) {
    const expected = Date.now() - days * DAY_MS;
    assert.ok(Math.abs(new Date(isoDate).getTime() - expected) < 5_000, `${isoDate} is not ${days} days ago`);
}

describe('billing-grace-period profile hook', () => {
    test('marks an active subscriber as in grace period and keeps other fields', () => {
        const result = onProfile(
            { status: 200, json: { subscription_status: 'active', status_changed_at: '2026-01-01T00:00:00Z', other: 1 } },
            { params: scenario.params },
        );

        assert.equal(result.status, 200);
        assert.equal(result.json.subscription_status, 'grace_period');
        assert.equal(result.json.other, 1);
        assertDaysAgo(result.json.status_changed_at, 3);
    });

    test('replaces a failed upstream response with a 200 grace-period body', () => {
        const result = onProfile({ status: 404, json: { error: 'not found' } }, { params: scenario.params });

        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.json).sort(), ['status_changed_at', 'subscription_status']);
    });

    test('honours the daysAgo param', () => {
        const result = onProfile({ status: 200, json: {} }, { params: { daysAgo: 10 } });

        assertDaysAgo(result.json.status_changed_at, 10);
    });
});

describe('billing-grace-period subscription hook', () => {
    test('leaves the subscription untouched by default', () => {
        assert.equal(onSubscription({ status: 200, json: APP_STORE_SUBSCRIPTION }, { params: scenario.params }), undefined);
    });

    test('rewrites only plan.store when store is set', () => {
        const result = onSubscription({ status: 200, json: APP_STORE_SUBSCRIPTION }, { params: { store: 'PLAY_STORE' } });

        assert.equal(result.status, undefined);
        assert.deepEqual(result.json, { status: 'ACTIVE', plan: { period_months: 12, store: 'PLAY_STORE' }, other: 1 });
    });

    test('does not invent a subscription for a failed or plan-less response', () => {
        const params = { store: 'PLAY_STORE' };

        assert.equal(onSubscription({ status: 404, json: { code: 'not_found' } }, { params }), undefined);
        assert.equal(onSubscription({ status: 200, json: { status: 'ACTIVE' } }, { params }), undefined);
    });
});

describe('billing-grace-period through the proxy', () => {
    let upstream;
    let gzipUpstream;
    let proxy;

    before(async () => {
        upstream = await startHttpsUpstream(async (server) => {
            await server.forGet(PROFILE_PATH).thenJson(200, { subscription_status: 'active' });
            await server.forGet('/other').thenJson(200, { untouched: true });
            await server.forPost(SUBSCRIPTION_PATH).thenJson(200, APP_STORE_SUBSCRIPTION);
        });
        gzipUpstream = await startHttpsUpstream(async (server) => {
            await server.forGet(PROFILE_PATH).thenReply(200, gzipSync(JSON.stringify({ subscription_status: 'active', extra: 'kept' })), {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
            });
        });
        proxy = await startTestProxy();
    });

    after(async () => {
        await proxy.stop();
        await upstream.stop();
        await gzipUpstream.stop();
    });

    test('passes the real response through while the scenario is inactive', async () => {
        await proxy.control('DELETE', '/active');

        const response = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}${PROFILE_PATH}`);

        assert.equal(response.json.subscription_status, 'active');
    });

    test('rewrites the real response once activated, with params', async () => {
        await proxy.control('PUT', '/active', [{ name: 'billing-grace-period', params: { daysAgo: 5 } }]);

        const response = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}${PROFILE_PATH}`);

        assert.equal(response.json.subscription_status, 'grace_period');
        assertDaysAgo(response.json.status_changed_at, 5);
    });

    test('rewrites the store when store is passed', async () => {
        await proxy.control('PUT', '/active', [{ name: 'billing-grace-period', params: { store: 'PLAY_STORE' } }]);

        const response = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}${SUBSCRIPTION_PATH}`, { method: 'POST', body: {} });

        assert.equal(response.json.plan.store, 'PLAY_STORE');
        assert.equal(response.json.plan.period_months, 12);
    });

    test('re-encodes a gzip upstream body', async () => {
        await proxy.control('PUT', '/active', [{ name: 'billing-grace-period' }]);

        const response = await httpsRawThroughProxy(proxy, `https://localhost:${gzipUpstream.port}${PROFILE_PATH}`);

        assert.equal(response.headers['content-encoding'], 'gzip');
        const body = JSON.parse(gunzipSync(response.body).toString('utf8'));
        assert.equal(body.subscription_status, 'grace_period');
        assert.equal(body.extra, 'kept');
    });

    test('leaves other endpoints untouched and records the rewrite in the log', async () => {
        await proxy.control('PUT', '/active', [{ name: 'billing-grace-period' }]);
        await proxy.control('DELETE', '/log');

        const other = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}/other`);
        await httpsThroughProxy(proxy, `https://localhost:${upstream.port}${PROFILE_PATH}`);
        const log = await proxy.control('GET', '/log?modified=true');

        assert.deepEqual(other.json, { untouched: true });
        assert.equal(log.json.length, 1);
        assert.match(log.json[0].url, /\/users\/v1\/profile$/);
        assert.deepEqual(log.json[0].modifiedBy, ['billing-grace-period']);
    });
});
