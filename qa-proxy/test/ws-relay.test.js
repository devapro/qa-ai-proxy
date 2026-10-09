import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { FIXTURE_SCENARIOS_DIR, proxyAgent, startHttpsUpstream, startTestProxy } from './support.js';

function collect(socket, count) {
    const messages = [];
    return new Promise((resolve, reject) => {
        socket.on('message', (data) => {
            messages.push(data.toString('utf8'));
            if (messages.length === count) resolve(messages);
        });
        socket.on('error', reject);
    });
}

describe('WebSocket relay over plain ws', () => {
    let upstreamServer;
    let upstreamPort;
    let proxy;

    before(async () => {
        upstreamServer = http.createServer();
        const wss = new WebSocketServer({ server: upstreamServer });
        wss.on('connection', (socket) => {
            socket.send('hello');
            socket.send(JSON.stringify({ price: 10 }));
            socket.send('drop-me');
            socket.on('message', (data) => {
                const text = data.toString('utf8');
                if (text === 'close-me') socket.close(4001, 'bye');
                else socket.send(`echo:${text}`);
            });
        });
        await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
        upstreamPort = upstreamServer.address().port;
        proxy = await startTestProxy({ scenariosDir: FIXTURE_SCENARIOS_DIR, activeScenarios: ['socket-rewrite'] });
    });

    after(async () => {
        await proxy.stop();
        upstreamServer.closeAllConnections?.();
        await new Promise((resolve) => upstreamServer.close(resolve));
    });

    const connect = () => new WebSocket(`ws://127.0.0.1:${upstreamPort}/stream`, { agent: proxyAgent(proxy) });

    test('rewrites, drops and injects server frames', async () => {
        const client = connect();
        const messages = await collect(client, 3);
        client.close();

        assert.deepEqual(new Set(messages), new Set(['{"event":"injected-on-open"}', 'hello-modified', '{"price":20}']));
    });

    test('rewrites client frames before they reach the server', async () => {
        const client = connect();
        await collect(client, 3);
        const reply = collect(client, 1);
        client.send('client-rename');

        assert.deepEqual(await reply, ['echo:client-renamed-modified']);
        client.close();
    });

    test('control API lists the connection and emits a server event into it', async () => {
        const client = connect();
        await collect(client, 3);

        const connections = await proxy.control('GET', '/socket/connections');
        const received = collect(client, 1);
        const emit = await proxy.control('POST', '/socket/emit', { path: '/stream', message: { event: 'from-qa' } });

        assert.equal(connections.json.length, 1);
        assert.equal(connections.json[0].url, `ws://127.0.0.1:${upstreamPort}/stream`);
        assert.deepEqual(emit.json, { delivered: 1 });
        assert.deepEqual(await received, ['{"event":"from-qa"}']);
        client.close();
        await once(client, 'close');
    });

    test('emit reports 409 when no connection matches', async () => {
        const emit = await proxy.control('POST', '/socket/emit', { path: '/nothing', message: 'x' });

        assert.equal(emit.status, 409);
        assert.deepEqual(emit.json, { delivered: 0 });
    });

    test('capture records unmodified frames only while enabled', async () => {
        await proxy.control('DELETE', '/active');
        await proxy.control('PUT', '/capture', { socketFrames: true });
        await proxy.control('DELETE', '/log');
        const client = connect();
        await collect(client, 3);
        await proxy.control('PUT', '/capture', { socketFrames: false });
        const log = await proxy.control('GET', '/log');
        await proxy.control('PUT', '/active', [{ name: 'socket-rewrite' }]);
        client.close();

        const observed = log.json.filter((entry) => entry.action === 'observed').map((entry) => entry.preview);
        assert.deepEqual(observed, ['hello', '{"price":10}', 'drop-me']);
    });

    test('forwards the server close code to the client', async () => {
        const client = connect();
        await collect(client, 3);
        client.send('close-me');

        const [code, reason] = await once(client, 'close');
        assert.equal(code, 4001);
        assert.equal(reason.toString(), 'bye');
    });
});

describe('WebSocket relay over TLS', () => {
    let upstream;
    let proxy;

    before(async () => {
        upstream = await startHttpsUpstream(async (server) => {
            await server.forAnyWebSocket('/reject').thenRejectConnection(401, 'Unauthorized');
            await server.forAnyWebSocket().thenEcho();
        });
        proxy = await startTestProxy({ scenariosDir: FIXTURE_SCENARIOS_DIR, activeScenarios: ['socket-rewrite'] });
    });

    after(async () => {
        await proxy.stop();
        await upstream.stop();
    });

    test('relays wss traffic through the scenario hooks', async () => {
        const client = new WebSocket(`wss://localhost:${upstream.port}/echo`, { agent: proxyAgent(proxy), ca: proxy.caCert });
        const injected = collect(client, 1);
        await once(client, 'open');
        assert.deepEqual(await injected, ['{"event":"injected-on-open"}']);

        const reply = collect(client, 1);
        client.send('ping');

        assert.deepEqual(await reply, ['ping-modified']);
        client.close();
    });

    test('relays the real handshake rejection instead of accepting the socket', async () => {
        const client = new WebSocket(`wss://localhost:${upstream.port}/reject`, { agent: proxyAgent(proxy), ca: proxy.caCert });

        const [handshake, response] = await once(client, 'unexpected-response');
        handshake.destroy();

        assert.equal(response.statusCode, 401);
    });
});
