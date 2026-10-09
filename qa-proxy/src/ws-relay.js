import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { matchesPattern } from './scenario-registry.js';

export const RELAY_PATH_PREFIX = { wss: '/__qa-proxy-wss', ws: '/__qa-proxy-ws' };

const HANDSHAKE_HEADERS = new Set([
    'host',
    'connection',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-protocol',
]);
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 30_000;

export async function startWsRelay({ registry, trafficLog, logger, insecureUpstream }) {
    const server = http.createServer((_, response) => {
        response.writeHead(426).end();
    });
    const wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        handleProtocols: (_, request) => request.qaUpstreamProtocol || false,
    });
    const connections = new Map();
    const capture = { socketFrames: false };
    let nextId = 0;

    server.on('upgrade', (request, socket, head) => {
        let target;
        try {
            target = upstreamUrl(request);
        } catch (error) {
            logger.error(`[ws-relay] rejected upgrade for ${request.url}: ${error.message}`);
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
        }

        const upstream = new WebSocket(target, parseProtocols(request.headers['sec-websocket-protocol']), {
            headers: forwardedHeaders(request.headers),
            perMessageDeflate: false,
            rejectUnauthorized: !insecureUpstream,
            handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
        });
        let upgraded = false;
        let rejected = false;

        socket.on('error', () => upstream.terminate());
        socket.once('close', () => {
            if (!upgraded) upstream.terminate();
        });

        upstream.once('unexpected-response', (upstreamRequest, upstreamResponse) => {
            rejected = true;
            relayRejection(upstreamResponse, socket, () => upstreamRequest.destroy());
            trafficLog.socketEvent(`ws-${++nextId}`, 'handshake', target, { status: upstreamResponse.statusCode });
        });
        upstream.once('error', (error) => {
            if (upgraded || rejected) return;
            logger.error(`[ws-relay] upstream ${target} failed: ${error.message}`);
            if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        });
        upstream.once('open', () => {
            upgraded = true;
            upstream.pause();
            request.qaUpstreamProtocol = upstream.protocol;
            wss.handleUpgrade(request, socket, head, (client) => bridge(client, upstream, target));
        });
    });

    function bridge(client, upstream, url) {
        const id = ++nextId;
        const { hostname, pathname } = new URL(url);
        const connection = { id, url, host: hostname, path: pathname, client, openedAt: new Date().toISOString() };
        connections.set(id, connection);
        trafficLog.socketEvent(id, 'open', url, {});

        const rules = () =>
            registry
                .activeSocketRules()
                .filter(({ rule }) => matchesPattern(rule.host, hostname) && matchesPattern(rule.path, pathname));

        const context = (scenario, params) => ({
            params,
            url,
            log: (message) => logger.info(`[${scenario}] ${url}: ${message}`),
            sendToClient: (message) => inject(client, 'toClient', message, scenario),
            sendToServer: (message) => inject(upstream, 'toServer', message, scenario),
        });

        const inject = (target, direction, message, scenario) => {
            for (const frame of normalizeReplacement(message)) {
                if (target.readyState !== WebSocket.OPEN) return;
                target.send(frame.data, { binary: frame.isBinary });
                trafficLog.socketEvent(id, direction, url, { action: 'injected', modifiedBy: [scenario], preview: preview(frame) });
            }
        };

        const pipeline = (hookName, target, direction) => {
            let queue = Promise.resolve();
            return (data, isBinary) => {
                queue = queue.then(async () => {
                    let frames = [{ data: Buffer.from(data), isBinary }];
                    const touchedBy = [];
                    for (const { scenario, params, rule } of rules()) {
                        const hook = rule[hookName];
                        if (!hook) continue;
                        const next = [];
                        for (const frame of frames) {
                            const result = await runHook(scenario, url, () => hook(messageView(frame), context(scenario, params)));
                            if (result === undefined) {
                                next.push(frame);
                            } else {
                                next.push(...normalizeReplacement(result));
                                touchedBy.push(scenario);
                            }
                        }
                        frames = next;
                    }
                    if (touchedBy.length > 0) {
                        trafficLog.socketEvent(id, direction, url, {
                            action: frames.length === 0 ? 'dropped' : 'modified',
                            modifiedBy: [...new Set(touchedBy)],
                            preview: frames.map(preview).join(' | '),
                        });
                    } else if (capture.socketFrames) {
                        trafficLog.socketEvent(id, direction, url, { action: 'observed', preview: frames.map(preview).join(' | ') });
                    }
                    for (const frame of frames) {
                        if (target.readyState === WebSocket.OPEN) target.send(frame.data, { binary: frame.isBinary });
                    }
                });
            };
        };

        upstream.on('message', pipeline('onServerMessage', client, 'toClient'));
        client.on('message', pipeline('onClientMessage', upstream, 'toServer'));

        client.on('close', (code, reason) => {
            connections.delete(id);
            trafficLog.socketEvent(id, 'close', url, { by: 'client', code });
            closePeer(upstream, code, reason);
        });
        upstream.on('close', (code, reason) => {
            trafficLog.socketEvent(id, 'close', url, { by: 'server', code });
            closePeer(client, code, reason);
        });
        client.on('error', (error) => logger.error(`[ws-relay] client ${url}: ${error.message}`));
        upstream.on('error', (error) => logger.error(`[ws-relay] upstream ${url}: ${error.message}`));
        upstream.resume();

        for (const { scenario, params, rule } of rules()) {
            if (rule.onOpen) runHook(scenario, url, () => rule.onOpen(context(scenario, params)));
        }
    }

    async function runHook(scenario, url, hook) {
        try {
            return await hook();
        } catch (error) {
            logger.error(`[${scenario}] socket hook failed for ${url}: ${error.stack ?? error}`);
            trafficLog.socketEvent(`err-${++nextId}`, 'error', url, { errors: [{ scenario, message: String(error?.message ?? error) }] });
            return undefined;
        }
    }

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        port: server.address().port,
        capture,
        connections: () =>
            [...connections.values()].map(({ id, url, host, path, openedAt }) => ({ id, url, host, path, openedAt })),
        emit({ host, path, message }) {
            let delivered = 0;
            for (const connection of connections.values()) {
                if (!matchesPattern(host, connection.host) || !matchesPattern(path, connection.path)) continue;
                if (connection.client.readyState !== WebSocket.OPEN) continue;
                for (const frame of normalizeReplacement(message)) {
                    connection.client.send(frame.data, { binary: frame.isBinary });
                    trafficLog.socketEvent(connection.id, 'toClient', connection.url, {
                        action: 'injected',
                        modifiedBy: ['control-api'],
                        preview: preview(frame),
                    });
                }
                delivered++;
            }
            return delivered;
        },
        async stop() {
            for (const connection of connections.values()) connection.client.terminate();
            wss.close();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

function upstreamUrl(request) {
    const [scheme, prefix] = Object.entries(RELAY_PATH_PREFIX).find(([, value]) => request.url.startsWith(value)) ?? [];
    if (!scheme) throw new Error('path is missing the relay scheme prefix');
    const host = request.headers.host;
    if (!host) throw new Error('Host header is missing');
    const rest = request.url.slice(prefix.length);
    return `${scheme}://${host}${rest.startsWith('/') ? rest : `/${rest}`}`;
}

function forwardedHeaders(headers) {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !HANDSHAKE_HEADERS.has(name)));
}

function parseProtocols(header) {
    return header ? header.split(',').map((protocol) => protocol.trim()).filter(Boolean) : [];
}

function relayRejection(response, socket, onRelayed) {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = Object.entries(response.headers)
            .filter(([name]) => !['connection', 'transfer-encoding', 'content-length'].includes(name))
            .map(([name, value]) => `${name}: ${value}`);
        socket.end(
            Buffer.concat([
                Buffer.from(
                    [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`, ...headers, `Content-Length: ${body.length}`, 'Connection: close', '', ''].join('\r\n'),
                ),
                body,
            ]),
        );
        onRelayed();
    });
    response.on('error', () => {
        socket.destroy();
        onRelayed();
    });
}

function closePeer(peer, code, reason) {
    if (peer.readyState === WebSocket.CLOSING || peer.readyState === WebSocket.CLOSED) return;
    if (code === 1006) {
        peer.terminate();
    } else if (UNSENDABLE_CLOSE_CODES.has(code)) {
        peer.close();
    } else {
        peer.close(code, reason);
    }
}

function messageView(frame) {
    const text = frame.isBinary ? undefined : frame.data.toString('utf8');
    let json;
    if (text !== undefined) {
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
    }
    return { data: frame.data, isBinary: frame.isBinary, text, json };
}

function normalizeReplacement(result) {
    if (result === null || result === undefined) return [];
    if (Array.isArray(result)) return result.flatMap(normalizeReplacement);
    if (typeof result === 'string') return [{ data: Buffer.from(result), isBinary: false }];
    if (Buffer.isBuffer(result) || result instanceof Uint8Array) return [{ data: Buffer.from(result), isBinary: true }];
    return [{ data: Buffer.from(JSON.stringify(result)), isBinary: false }];
}

function preview(frame) {
    return frame.isBinary ? `<binary ${frame.data.length} bytes>` : frame.data.toString('utf8').slice(0, 300);
}
