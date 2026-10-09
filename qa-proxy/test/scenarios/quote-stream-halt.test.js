import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import scenario from '../../scenarios/quote-stream-halt.js';
import { proxyAgent, startTestProxy } from '../support.js';

const onServerMessage = scenario.socket[0].onServerMessage;
const frame = (json) => ({ text: JSON.stringify(json), json, isBinary: false });

describe('quote-stream-halt hooks', () => {
    test('drops price frames for the halted symbol', () => {
        assert.equal(onServerMessage(frame({ type: 'price', symbol: 'AAPL', price: 1 }), { params: scenario.params }), null);
    });

    test('forwards other symbols and other frame types unchanged', () => {
        const params = scenario.params;

        assert.equal(onServerMessage(frame({ type: 'price', symbol: 'MSFT', price: 1 }), { params }), undefined);
        assert.equal(onServerMessage(frame({ type: 'heartbeat' }), { params }), undefined);
        assert.equal(onServerMessage({ text: 'not json', json: undefined, isBinary: false }, { params }), undefined);
    });

    test('announces the halt for the symbol param when the socket opens', () => {
        const sent = [];
        scenario.socket[0].onOpen({ params: { symbol: 'TSLA' }, sendToClient: (message) => sent.push(message) });

        assert.deepEqual(sent, [{ type: 'status', symbol: 'TSLA', status: 'halted' }]);
    });
});

describe('quote-stream-halt through the proxy', () => {
    let upstreamServer;
    let upstreamPort;
    let proxy;

    before(async () => {
        upstreamServer = http.createServer();
        new WebSocketServer({ server: upstreamServer }).on('connection', (socket) => {
            socket.send(JSON.stringify({ type: 'price', symbol: 'AAPL', price: 190 }));
            socket.send(JSON.stringify({ type: 'price', symbol: 'MSFT', price: 410 }));
        });
        await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
        upstreamPort = upstreamServer.address().port;
        proxy = await startTestProxy();
        await proxy.control('PUT', '/active', [{ name: 'quote-stream-halt' }]);
    });

    after(async () => {
        await proxy.stop();
        upstreamServer.closeAllConnections?.();
        await new Promise((resolve) => upstreamServer.close(resolve));
    });

    test('the app sees the halt event and only the other symbol\'s prices', async () => {
        const client = new WebSocket(`ws://127.0.0.1:${upstreamPort}/quotes`, { agent: proxyAgent(proxy) });
        const messages = await new Promise((resolve, reject) => {
            const received = [];
            client.on('message', (data) => {
                received.push(JSON.parse(data.toString('utf8')));
                if (received.length === 2) resolve(received);
            });
            client.on('error', reject);
        });
        client.close();

        assert.deepEqual(
            new Set(messages.map((message) => `${message.type}:${message.symbol}`)),
            new Set(['status:AAPL', 'price:MSFT']),
        );
    });
});
