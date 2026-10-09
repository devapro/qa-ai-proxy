import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ScenarioError, ScenarioRegistry } from '../src/scenario-registry.js';
import { SCENARIOS_DIR, startTestProxy } from './support.js';

const tempDirs = [];

async function registryWith(files) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-proxy-scenarios-'));
    tempDirs.push(dir);
    for (const [name, source] of Object.entries(files)) await writeFile(path.join(dir, name), source);
    return new ScenarioRegistry(dir);
}

after(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('ScenarioRegistry', () => {
    test('every checked-in scenario passes validation', async () => {
        const registry = new ScenarioRegistry(SCENARIOS_DIR);

        await registry.load();

        assert.ok(registry.list().some((scenario) => scenario.name === 'billing-grace-period'));
    });

    test('rejects a scenario whose name does not match its file', async () => {
        const registry = await registryWith({
            'wrong.js': `export default { name: 'other', description: 'x', http: [{ path: '/a', onResponse() {} }] };`,
        });

        await assert.rejects(registry.load(), (error) => error instanceof ScenarioError && /must match the file name/.test(error.message));
    });

    test('rejects an http rule without a hook', async () => {
        const registry = await registryWith({
            'no-hook.js': `export default { name: 'no-hook', description: 'x', http: [{ path: '/a' }] };`,
        });

        await assert.rejects(registry.load(), /needs `onRequest` or `onResponse`/);
    });

    test('merges activation params over defaults', async () => {
        const registry = new ScenarioRegistry(SCENARIOS_DIR);
        await registry.load();

        assert.deepEqual(registry.activate('billing-grace-period', { daysAgo: 7 }), { daysAgo: 7 });
        assert.deepEqual(registry.activate('billing-grace-period'), { daysAgo: 3 });
    });

    test('replaceActive keeps the previous set when an entry is unknown', async () => {
        const registry = new ScenarioRegistry(SCENARIOS_DIR);
        await registry.load();
        registry.activate('billing-grace-period');
        const activeRules = registry.activeHttpRules().length;

        assert.throws(() => registry.replaceActive([{ name: 'missing' }]), /Unknown scenario "missing"/);
        assert.ok(activeRules > 0);
        assert.equal(registry.activeHttpRules().length, activeRules);
    });

    test('reload picks up an edited scenario', async () => {
        const registry = await registryWith({
            'edit-me.js': `export default { name: 'edit-me', description: 'v1', http: [{ path: '/a', onResponse() {} }] };`,
        });
        await registry.load();
        await writeFile(
            path.join(tempDirs.at(-1), 'edit-me.js'),
            `export default { name: 'edit-me', description: 'v2', http: [{ path: '/a', onResponse() {} }] };`,
        );

        await registry.load();

        assert.equal(registry.list()[0].description, 'v2');
    });
});

describe('control API errors', () => {
    test('answers 400 for an unknown scenario, 404 for an unknown route and 405 for a wrong method', async () => {
        const proxy = await startTestProxy();
        try {
            assert.equal((await proxy.control('POST', '/active', { name: 'missing' })).status, 400);
            assert.equal((await proxy.control('GET', '/nope')).status, 404);
            assert.equal((await proxy.control('PATCH', '/active')).status, 405);
            assert.equal((await proxy.control('DELETE', '/active/billing-grace-period')).status, 404);
        } finally {
            await proxy.stop();
        }
    });
});
