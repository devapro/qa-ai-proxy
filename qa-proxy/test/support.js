import { mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import mockttp from 'mockttp';
import { startQaProxy } from '../src/qa-proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_DIR = path.resolve(here, '..', 'scenarios');
export const FIXTURE_SCENARIOS_DIR = path.join(here, 'fixtures', 'scenarios');

const silentLogger = { info: () => {}, error: () => {} };

export async function startTestProxy({ scenariosDir = SCENARIOS_DIR, activeScenarios = [], logger = silentLogger } = {}) {
    const caDir = await mkdtemp(path.join(os.tmpdir(), 'qa-proxy-ca-'));
    const qaProxy = await startQaProxy({
        proxyPort: 0,
        controlPort: 0,
        controlHost: '127.0.0.1',
        scenariosDir,
        caDir,
        insecureUpstream: true,
        activeScenarios: activeScenarios.map((name) => ({ name })),
        logCapacity: 100,
        logger,
    });
    return {
        ...qaProxy,
        proxyUrl: `http://127.0.0.1:${qaProxy.proxyPort}`,
        control: (method, route, body) => control(qaProxy.controlPort, method, route, body),
        async stop() {
            await qaProxy.stop();
            await rm(caDir, { recursive: true, force: true });
        },
    };
}

export async function startHttpsUpstream(configure) {
    const ca = await mockttp.generateCACertificate();
    const upstream = mockttp.getLocal({ https: ca, recordTraffic: false });
    await upstream.start();
    await configure(upstream);
    return upstream;
}

export function proxyAgent(testProxy) {
    return new HttpsProxyAgent(testProxy.proxyUrl, { ca: testProxy.caCert });
}

export function httpsRawThroughProxy(testProxy, url, { method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
        const request = https.request(url, { method, agent: proxyAgent(testProxy), ca: testProxy.caCert }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        if (body !== undefined) {
            request.setHeader('content-type', 'application/json');
            request.write(JSON.stringify(body));
        }
        request.end();
    });
}

export async function httpsThroughProxy(testProxy, url, options) {
    const response = await httpsRawThroughProxy(testProxy, url, options);
    const text = response.body.toString('utf8');
    return { status: response.status, headers: response.headers, text, json: safeJson(text) };
}

async function control(port, method, route, body) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: safeJson(text), text };
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
