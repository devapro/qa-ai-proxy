import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCENARIO_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export class ScenarioError extends Error {}

export class ScenarioRegistry {
    #dir;
    #scenarios = new Map();
    #active = [];

    constructor(dir) {
        this.#dir = dir;
    }

    async load() {
        const files = (await readdir(this.#dir)).filter((file) => file.endsWith('.js')).sort();
        const loaded = new Map();
        const version = Date.now();
        for (const file of files) {
            // The query string defeats the ESM module cache so /scenarios/reload picks up edits.
            const moduleUrl = `${pathToFileURL(path.join(this.#dir, file)).href}?v=${version}`;
            const { default: scenario } = await import(moduleUrl);
            validateScenario(scenario, file);
            loaded.set(scenario.name, scenario);
        }
        this.#scenarios = loaded;
        this.#active = this.#active
            .filter(({ scenario }) => loaded.has(scenario.name))
            .map(({ scenario, params }) => ({ scenario: loaded.get(scenario.name), params }));
    }

    list() {
        return [...this.#scenarios.values()].map((scenario) => {
            const active = this.#active.find((entry) => entry.scenario.name === scenario.name);
            return {
                name: scenario.name,
                description: scenario.description,
                defaultParams: scenario.params ?? {},
                active: Boolean(active),
                params: active?.params ?? null,
            };
        });
    }

    activate(name, params = {}) {
        const scenario = this.#scenarios.get(name);
        if (!scenario) {
            throw new ScenarioError(`Unknown scenario "${name}". Known: ${[...this.#scenarios.keys()].join(', ')}`);
        }
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
            throw new ScenarioError(`Params for "${name}" must be a JSON object`);
        }
        const entry = { scenario, params: { ...(scenario.params ?? {}), ...params } };
        const index = this.#active.findIndex((active) => active.scenario.name === name);
        if (index >= 0) {
            this.#active[index] = entry;
        } else {
            this.#active.push(entry);
        }
        return entry.params;
    }

    replaceActive(entries) {
        if (!Array.isArray(entries)) {
            throw new ScenarioError('Expected a JSON array of { "name", "params" } objects');
        }
        const previous = this.#active;
        this.#active = [];
        try {
            for (const entry of entries) {
                this.activate(entry?.name, entry?.params ?? {});
            }
        } catch (error) {
            this.#active = previous;
            throw error;
        }
    }

    deactivate(name) {
        const before = this.#active.length;
        this.#active = this.#active.filter((entry) => entry.scenario.name !== name);
        return this.#active.length !== before;
    }

    reset() {
        this.#active = [];
    }

    activeHttpRules() {
        return this.#active.flatMap(({ scenario, params }) =>
            (scenario.http ?? []).map((rule) => ({ scenario: scenario.name, params, rule })),
        );
    }

    activeSocketRules() {
        return this.#active.flatMap(({ scenario, params }) =>
            (scenario.socket ?? []).map((rule) => ({ scenario: scenario.name, params, rule })),
        );
    }
}

function validateScenario(scenario, file) {
    const fail = (message) => {
        throw new ScenarioError(`${file}: ${message}`);
    };
    if (!scenario || typeof scenario !== 'object') fail('must `export default` a scenario object');
    if (!SCENARIO_NAME.test(scenario.name ?? '')) fail('`name` must be kebab-case');
    if (`${scenario.name}.js` !== file) fail(`\`name\` "${scenario.name}" must match the file name`);
    if (typeof scenario.description !== 'string' || !scenario.description.trim()) fail('`description` is required');
    if (scenario.params !== undefined && (typeof scenario.params !== 'object' || Array.isArray(scenario.params))) {
        fail('`params` must be an object of default values');
    }
    if (!scenario.http?.length && !scenario.socket?.length) fail('declare at least one `http` or `socket` rule');

    (scenario.http ?? []).forEach((rule, index) => {
        const where = `http[${index}]`;
        if (rule.method !== undefined && !HTTP_METHODS.has(rule.method)) fail(`${where}.method must be an upper-case HTTP method`);
        if (rule.path === undefined && rule.url === undefined) fail(`${where} needs \`path\` or \`url\``);
        checkPattern(rule.path, `${where}.path`, fail);
        checkPattern(rule.url, `${where}.url`, fail);
        checkPattern(rule.host, `${where}.host`, fail);
        if (typeof rule.onRequest !== 'function' && typeof rule.onResponse !== 'function') {
            fail(`${where} needs \`onRequest\` or \`onResponse\``);
        }
    });

    (scenario.socket ?? []).forEach((rule, index) => {
        const where = `socket[${index}]`;
        checkPattern(rule.host, `${where}.host`, fail);
        checkPattern(rule.path, `${where}.path`, fail);
        const hooks = ['onOpen', 'onServerMessage', 'onClientMessage'];
        if (!hooks.some((hook) => typeof rule[hook] === 'function')) fail(`${where} needs one of ${hooks.join(', ')}`);
    });
}

function checkPattern(pattern, where, fail) {
    if (pattern !== undefined && typeof pattern !== 'string' && !(pattern instanceof RegExp)) {
        fail(`${where} must be a string or RegExp`);
    }
}

export function matchesPattern(pattern, value) {
    if (pattern === undefined) return true;
    return pattern instanceof RegExp ? pattern.test(value) : pattern === value;
}
