import mockttp from 'mockttp';
import { loadOrCreateCa } from './certificate-authority.js';
import { startControlApi } from './control-api.js';
import { createHttpHooks } from './http-hooks.js';
import { ScenarioRegistry } from './scenario-registry.js';
import { TrafficLog } from './traffic-log.js';
import { RELAY_PATH_PREFIX, startWsRelay } from './ws-relay.js';

export async function startQaProxy(config) {
    const { logger } = config;
    const ca = await loadOrCreateCa(config.caDir);
    const registry = new ScenarioRegistry(config.scenariosDir);
    await registry.load();
    registry.replaceActive(config.activeScenarios);

    const trafficLog = new TrafficLog(config.logCapacity);
    const relay = await startWsRelay({ registry, trafficLog, logger, insecureUpstream: config.insecureUpstream });
    const hooks = createHttpHooks({ registry, trafficLog, logger });

    const proxy = mockttp.getLocal({
        https: { key: ca.key, cert: ca.cert },
        cors: false,
        recordTraffic: false,
        suggestChanges: false,
    });
    await proxy.start(config.proxyPort);

    const passThrough = { ignoreHostHttpsErrors: config.insecureUpstream };
    await proxy.forAnyRequest().matching(hooks.matches).thenPassThrough({
        ...passThrough,
        beforeRequest: hooks.beforeRequest,
        beforeResponse: hooks.beforeResponse,
    });
    await proxy.forUnmatchedRequest().thenPassThrough(passThrough);
    for (const [scheme, prefix] of Object.entries(RELAY_PATH_PREFIX)) {
        await proxy
            .forAnyWebSocket()
            .withProtocol(scheme)
            .thenPassThrough({
                transformRequest: {
                    setProtocol: 'ws',
                    replaceHost: { targetHost: `127.0.0.1:${relay.port}`, updateHostHeader: false },
                    matchReplacePath: [[/^/, prefix]],
                },
            });
    }
    await proxy.on('request-initiated', (request) => trafficLog.requestStarted(request.id, request.method, request.url));
    await proxy.on('response', (response) => trafficLog.responseCompleted(response.id, response.statusCode));
    await proxy.on('tls-client-error', (failure) =>
        trafficLog.tlsFailure(failure.id, failure.tlsMetadata?.sniHostname ?? failure.destination?.hostname, failure.failureCause),
    );

    const control = await startControlApi({
        port: config.controlPort,
        host: config.controlHost,
        registry,
        trafficLog,
        relay,
        caCertPem: ca.cert,
        logger,
    });

    return {
        proxyPort: proxy.port,
        controlPort: control.port,
        caCert: ca.cert,
        async stop() {
            await control.stop();
            await proxy.stop();
            await relay.stop();
        },
    };
}
