import http from 'node:http';
import { ScenarioError } from './scenario-registry.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_LOG_LIMIT = 100;

export async function startControlApi({ port, host, registry, trafficLog, relay, caCertPem, logger }) {
    const routes = [
        ['GET', /^\/health$/, () => ({ status: 200, json: { ok: true } })],
        ['GET', /^\/ca\.pem$/, () => ({ status: 200, text: caCertPem, contentType: 'application/x-pem-file' })],
        ['GET', /^\/scenarios$/, () => ({ status: 200, json: registry.list() })],
        [
            'POST',
            /^\/scenarios\/reload$/,
            async () => {
                await registry.load();
                return { status: 200, json: registry.list() };
            },
        ],
        [
            'GET',
            /^\/active$/,
            () => ({ status: 200, json: registry.list().filter((scenario) => scenario.active) }),
        ],
        [
            'PUT',
            /^\/active$/,
            (_, body) => {
                registry.replaceActive(body);
                return { status: 200, json: registry.list().filter((scenario) => scenario.active) };
            },
        ],
        [
            'POST',
            /^\/active$/,
            (_, body) => {
                const params = registry.activate(body?.name, body?.params ?? {});
                return { status: 200, json: { name: body.name, params } };
            },
        ],
        [
            'DELETE',
            /^\/active$/,
            () => {
                registry.reset();
                return { status: 200, json: [] };
            },
        ],
        [
            'DELETE',
            /^\/active\/([a-z0-9-]+)$/,
            ([, name]) => (registry.deactivate(name) ? { status: 200, json: { name } } : notFound(`"${name}" is not active`)),
        ],
        ['GET', /^\/capture$/, () => ({ status: 200, json: relay.capture })],
        [
            'PUT',
            /^\/capture$/,
            (_, body) => {
                if (typeof body?.socketFrames !== 'boolean') throw new ScenarioError('`socketFrames` must be a boolean');
                relay.capture.socketFrames = body.socketFrames;
                return { status: 200, json: relay.capture };
            },
        ],
        ['GET', /^\/socket\/connections$/, () => ({ status: 200, json: relay.connections() })],
        [
            'POST',
            /^\/socket\/emit$/,
            (_, body) => {
                if (body?.message === undefined) throw new ScenarioError('`message` is required');
                const delivered = relay.emit({ host: body.host, path: body.path, message: body.message });
                return { status: delivered > 0 ? 200 : 409, json: { delivered } };
            },
        ],
        [
            'GET',
            /^\/log$/,
            (_, __, query) => ({
                status: 200,
                json: trafficLog.entries({
                    limit: Number(query.get('limit')) || DEFAULT_LOG_LIMIT,
                    modifiedOnly: query.get('modified') === 'true',
                }),
            }),
        ],
        [
            'DELETE',
            /^\/log$/,
            () => {
                trafficLog.clear();
                return { status: 200, json: [] };
            },
        ],
    ];

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://control');
        const candidates = routes.filter(([, pattern]) => pattern.test(url.pathname));
        const route = candidates.find(([method]) => method === request.method);
        let result;
        try {
            if (!route) {
                result = candidates.length > 0 ? { status: 405, json: { error: 'Method not allowed' } } : notFound('No such endpoint');
            } else {
                const body = await readJson(request);
                result = await route[2](url.pathname.match(route[1]), body, url.searchParams);
            }
        } catch (error) {
            if (error instanceof ScenarioError || error instanceof SyntaxError) {
                result = { status: 400, json: { error: error.message } };
            } else {
                logger.error(`[control] ${request.method} ${url.pathname}: ${error.stack ?? error}`);
                result = { status: 500, json: { error: error.message } };
            }
        }
        if (result.text !== undefined) {
            response.writeHead(result.status, { 'content-type': result.contentType ?? 'text/plain; charset=utf-8' }).end(result.text);
        } else {
            response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result.json, null, 2));
        }
    });

    await new Promise((resolve) => server.listen(port, host, resolve));
    return {
        port: server.address().port,
        stop: () => new Promise((resolve) => server.close(resolve)),
    };
}

function notFound(message) {
    return { status: 404, json: { error: message } };
}

async function readJson(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new ScenarioError('Request body too large');
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : undefined;
}
