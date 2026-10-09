import { matchesPattern } from './scenario-registry.js';

export function createHttpHooks({ registry, trafficLog, logger }) {
    const findRules = (request) => {
        const url = new URL(request.url);
        return registry.activeHttpRules().filter(
            ({ rule }) =>
                matchesPattern(rule.method, request.method) &&
                matchesPattern(rule.host, url.hostname) &&
                matchesPattern(rule.path, url.pathname) &&
                matchesPattern(rule.url, request.url),
        );
    };

    const matches = (request) => findRules(request).length > 0;

    const beforeRequest = async (request) => {
        const rules = findRules(request).filter(({ rule }) => rule.onRequest);
        if (rules.length === 0) return undefined;

        let view = await requestView(request);
        let changed = false;
        for (const { scenario, params, rule } of rules) {
            const result = await runHook(scenario, request, () => rule.onRequest(view, hookContext(scenario, params, request, logger)));
            if (result === undefined) continue;
            changed = true;
            trafficLog.markModified(request.id, scenario);
            if (result.respond) {
                const respond = result.respond;
                return { response: toMockttpResponse(withBody({ headers: {}, ...pick(respond, ['status', 'headers']) }, respond)) };
            }
            view = mergeRequest(view, result);
        }
        if (!changed) return undefined;
        return {
            method: view.method,
            url: view.url,
            headers: view.headers,
            ...bodyField(view),
        };
    };

    const beforeResponse = async (response, request) => {
        const rules = findRules(request).filter(({ rule }) => rule.onResponse);
        if (rules.length === 0) return undefined;

        let view = await responseView(response);
        let changed = false;
        for (const { scenario, params, rule } of rules) {
            const result = await runHook(scenario, request, () =>
                rule.onResponse(view, { ...hookContext(scenario, params, request, logger), request: summary(request) }),
            );
            if (result === undefined) continue;
            changed = true;
            trafficLog.markModified(request.id, scenario);
            view = mergeResponse(view, result);
        }
        if (!changed) return undefined;
        return toMockttpResponse(view);
    };

    async function runHook(scenario, request, hook) {
        try {
            return await hook();
        } catch (error) {
            trafficLog.markError(request.id, scenario, error);
            logger.error(`[${scenario}] hook failed for ${request.method} ${request.url}: ${error.stack ?? error}`);
            return undefined;
        }
    }

    return { matches, beforeRequest, beforeResponse };
}

function hookContext(scenario, params, request, logger) {
    return {
        params,
        log: (message) => logger.info(`[${scenario}] ${request.method} ${request.url}: ${message}`),
    };
}

function summary(request) {
    const url = new URL(request.url);
    return { method: request.method, url: request.url, host: url.hostname, path: url.pathname, headers: request.headers };
}

async function requestView(request) {
    const text = (await request.body.getText()) ?? '';
    return { ...summary(request), text, json: parseJson(text) };
}

async function responseView(response) {
    const text = (await response.body.getText()) ?? '';
    return { status: response.statusCode, headers: { ...response.headers }, text, json: parseJson(text) };
}

function mergeRequest(view, result) {
    const next = { ...view, ...pick(result, ['method', 'url', 'headers']) };
    return withBody(next, result);
}

function mergeResponse(view, result) {
    const next = { ...view, ...pick(result, ['status', 'headers']) };
    return withBody(next, result);
}

function withBody(view, result) {
    if (result.json !== undefined) {
        return {
            ...view,
            headers: { ...view.headers, 'content-type': 'application/json; charset=utf-8' },
            text: JSON.stringify(result.json),
            json: result.json,
        };
    }
    if (result.text !== undefined) {
        return { ...view, text: result.text, json: parseJson(result.text) };
    }
    return view;
}

function toMockttpResponse(view) {
    return { statusCode: view.status ?? 200, headers: view.headers, ...bodyField(view) };
}

function bodyField(view) {
    return view.text === undefined ? {} : { body: view.text };
}

function pick(source, keys) {
    return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function parseJson(text) {
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
