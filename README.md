# Examples - a QA proxy setup laid out like a real repository

Every file here sits at the path it would have in an Android project. Copy the parts you need;
[My blog post](https://devapro.github.io/en/2026/10/07/ai-managed-server-states-qa-proxy/) explains why each one exists.

```
examples/
├── qa-proxy/                         ← the proxy (Node 22, mockttp + ws) - runnable, `npm ci && npm test`
│   ├── src/
│   │   ├── index.js                  entry point: env config → startQaProxy
│   │   ├── qa-proxy.js               wires mockttp, hooks, relay, control API
│   │   ├── http-hooks.js             runs scenario onRequest/onResponse hooks
│   │   ├── ws-relay.js               WebSocket relay: real handshake first, then frame hooks
│   │   ├── scenario-registry.js      loads + validates scenarios/, active set (all-or-nothing)
│   │   ├── scenario-spec.js          "name:param=value,other" parser
│   │   ├── control-api.js            :8090 REST API
│   │   ├── traffic-log.js            the proof log (modifiedBy / errors / tls-error)
│   │   ├── certificate-authority.js  persistent CA
│   │   └── set-scenarios.js          CLI: replace the active list
│   ├── scenarios/
│   │   ├── billing-grace-period.js   onResponse rewrite of two endpoints, time-relative value, params
│   │   ├── ai-credits.js             onResponse rewrite + forced failure param + param validation
│   │   └── quote-stream-halt.js      WebSocket: drop frames + inject on open
│   ├── test/                         proxy tests + one test file per scenario
│   └── Dockerfile, package.json
│
├── app/src/                          ← the Android side (debug-only)
│   ├── main/java/com/example/app/network/qaproxy/
│   │   ├── QaProxySettings(.kt|Impl.kt)  stores host:port, debug builds only
│   │   ├── QaProxySelector.kt            [HTTP proxy, DIRECT] - never cuts the app off
│   │   ├── DebugLaunchArguments.kt       reads `--es debug_qa_proxy <host:port|none>`
│   │   ├── LauncherActivity.kt           applies it on launch
│   │   ├── HttpClientFactory.kt          proxySelector on the debug OkHttpClient
│   │   └── QaProxyModule.kt              Hilt wiring (same idea for Koin/manual DI)
│   ├── debug/res/xml/network_security_config.xml   trusting the proxy CA in debug only
│   └── test/.../QaProxySelectorTest.kt
│
├── docker/
│   ├── docker-compose.yml            emulator + agent + qa-proxy (profile `qa-proxy`)
│   └── qa-proxy.sh                   attach | use | launch | log | status | detach
│
├── .github/
│   ├── workflows/qa-proxy-tests.yml  PR gate for proxy + scenarios
│   ├── workflows/qa-device.yml       prepare scenarios → start proxy → AI QA run → artifact
│   └── prompts/qa-proxy-prepare.md   CI constraints for the headless preparation step
│
├── .claude/
│   ├── skills/test-write-qa-cases/   writes plans whose preconditions are proxy specs
│   ├── skills/qa-proxy-prepare/      orchestrator: missing scenarios → sub-agents → verify → outputs
│   │   └── scripts/check_proxy_specs.mjs   deterministic checker (uses the proxy's own parser)
│   ├── skills/qa-proxy-scenario/     worker: trace the endpoint, write scenario + test
│   ├── skills/qa-device/             runner: arrange preconditions, one sub-agent per case, log proof
│   └── agents/mobile-devices.md      per-case device agent (never touches proxy settings)
│
└── docs/
    ├── technical/QA-proxy.md         the canonical contract (scenario API, control API, troubleshooting)
    └── qa-plans/
        ├── ai-assistant.test-cases.md        a plan: existing specs + one specified-but-missing scenario
        └── sample-run-output/                what /qa-proxy-prepare produced for it (real, tested)
            ├── status.txt                    READY
            ├── scenarios.json                manifest: written / extended / unresolved
            ├── qa_test_plan.resolved.md      the plan the QA run executes
            └── qa-proxy-scenarios.patch      the uncommitted scenario + test, for review
```

## Try it

```bash
cd qa-proxy && npm ci && npm test                     # 45 tests: proxy, relay, every scenario
cd .. && node --test .claude/skills/qa-proxy-prepare/scripts/check_proxy_specs.test.mjs
node .claude/skills/qa-proxy-prepare/scripts/check_proxy_specs.mjs --cases docs/qa-plans/ai-assistant.test-cases.md
```

The last command reports `MISSING_SCENARIO assistant-chat-status ... PREPARABLE: True` - the state a
plan is in before `/qa-proxy-prepare` runs. Applying `sample-run-output/qa-proxy-scenarios.patch`
(`git apply` from `examples/`) makes it `RUNNABLE: True`.

Placeholders you must replace: package `com.example.app`, `.LauncherActivity`, the endpoints in the
scenarios, `docker/agent` (your agent image) and `docker/wait-for-emulator.sh`.
