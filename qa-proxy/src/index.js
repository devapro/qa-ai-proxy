import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startQaProxy } from './qa-proxy.js';
import { parseScenarioSpec } from './scenario-spec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const logger = {
    info: (message) => console.log(`${new Date().toISOString()} ${message}`),
    error: (message) => console.error(`${new Date().toISOString()} ERROR ${message}`),
};

const qaProxy = await startQaProxy({
    proxyPort: Number(env.QA_PROXY_PORT ?? 8080),
    controlPort: Number(env.QA_PROXY_CONTROL_PORT ?? 8090),
    controlHost: env.QA_PROXY_CONTROL_HOST ?? '127.0.0.1',
    scenariosDir: env.QA_PROXY_SCENARIOS_DIR ?? path.join(root, 'scenarios'),
    caDir: env.QA_PROXY_CA_DIR ?? path.join(root, '.ca'),
    insecureUpstream: env.QA_PROXY_INSECURE_UPSTREAM === 'true',
    activeScenarios: parseScenarioSpec(env.QA_PROXY_ACTIVE),
    logCapacity: Number(env.QA_PROXY_LOG_CAPACITY ?? 1000),
    logger,
});

logger.info(`qa-proxy listening: proxy :${qaProxy.proxyPort}, control :${qaProxy.controlPort}`);

const shutdown = async (signal) => {
    logger.info(`${signal} received, stopping`);
    await qaProxy.stop();
    process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
