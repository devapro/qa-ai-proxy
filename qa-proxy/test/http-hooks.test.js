import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FIXTURE_SCENARIOS_DIR, httpsThroughProxy, startHttpsUpstream, startTestProxy } from './support.js';

describe('HTTP hooks', () => {
    let upstream;
    let proxy;
    let serverHits = 0;

    before(async () => {
        upstream = await startHttpsUpstream(async (server) => {
            await server.forPost('/echo-body').thenCallback(async (request) => ({ json: await request.body.getJson() }));
            await server.forGet('/never-reaches-server').thenCallback(() => {
                serverHits++;
                return { statusCode: 200 };
            });
            await server.forGet('/broken').thenJson(200, { real: true });
        });
        proxy = await startTestProxy({ scenariosDir: FIXTURE_SCENARIOS_DIR, activeScenarios: ['request-rewrite'] });
    });

    after(async () => {
        await proxy.stop();
        await upstream.stop();
    });

    test('onRequest rewrites the body the server receives', async () => {
        const response = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}/echo-body`, {
            method: 'POST',
            body: { original: 1 },
        });

        assert.deepEqual(response.json, { original: 1, injected: true });
    });

    test('onRequest can answer without contacting the server, and the log names the scenario', async () => {
        await proxy.control('DELETE', '/log');

        const response = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}/never-reaches-server`);
        const log = await proxy.control('GET', '/log?modified=true');

        assert.equal(response.status, 418);
        assert.deepEqual(response.json, { short: 'circuit' });
        assert.equal(serverHits, 0);
        assert.deepEqual(log.json.map((entry) => entry.modifiedBy), [['request-rewrite']]);
    });

    test('a throwing hook passes the real response through and is reported in the log', async () => {
        await proxy.control('DELETE', '/log');

        const response = await httpsThroughProxy(proxy, `https://localhost:${upstream.port}/broken`);
        const log = await proxy.control('GET', '/log?modified=true');

        assert.deepEqual(response.json, { real: true });
        assert.equal(log.json.length, 1);
        assert.deepEqual(log.json[0].errors, [{ scenario: 'request-rewrite', message: 'scenario bug' }]);
    });
});
