import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { parseScenarioSpec } from '../src/scenario-spec.js';
import { startTestProxy } from './support.js';

const run = promisify(execFile);
const SET_SCENARIOS = path.resolve(import.meta.dirname, '..', 'src', 'set-scenarios.js');

describe('parseScenarioSpec', () => {
    test('treats an empty spec and "none" as no scenarios', () => {
        assert.deepEqual(parseScenarioSpec(''), []);
        assert.deepEqual(parseScenarioSpec('none'), []);
    });

    test('parses names and typed key=value params', () => {
        assert.deepEqual(parseScenarioSpec('billing-grace-period:daysAgo=10, other:flag=true:label=pro'), [
            { name: 'billing-grace-period', params: { daysAgo: 10 } },
            { name: 'other', params: { flag: true, label: 'pro' } },
        ]);
    });

    test('accepts a JSON array', () => {
        assert.deepEqual(parseScenarioSpec('[{"name":"billing-grace-period","params":{"daysAgo":1}}]'), [
            { name: 'billing-grace-period', params: { daysAgo: 1 } },
        ]);
    });

    test('rejects a param without a value', () => {
        assert.throws(() => parseScenarioSpec('billing-grace-period:daysAgo'), /is not key=value/);
    });
});

describe('set-scenarios CLI', () => {
    test('replaces the active set and fails on an unknown scenario', async () => {
        const proxy = await startTestProxy();
        const env = { ...process.env, QA_PROXY_URL: `http://127.0.0.1:${proxy.controlPort}` };
        try {
            const { stdout } = await run(process.execPath, [SET_SCENARIOS, 'billing-grace-period:daysAgo=10'], { env });
            assert.match(stdout, /Active scenarios: billing-grace-period {"daysAgo":10}/);

            await assert.rejects(run(process.execPath, [SET_SCENARIOS, 'billing-grace-period,missing'], { env }), /Unknown scenario "missing"/);
            assert.deepEqual((await proxy.control('GET', '/active')).json.map(({ name }) => name), ['billing-grace-period']);

            const { stdout: cleared } = await run(process.execPath, [SET_SCENARIOS, 'none'], { env });
            assert.match(cleared, /No active scenarios/);
        } finally {
            await proxy.stop();
        }
    });
});
