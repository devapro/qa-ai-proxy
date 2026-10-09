# qa-proxy

A man-in-the-middle proxy for device QA: the debug app sends its own traffic to the real backend
through it, and JavaScript scenarios in `scenarios/` rewrite chosen responses and WebSocket frames on
the way. SDKs and WebViews are not routed through it.

Contract and reference: [`docs/technical/QA-proxy.md`](../docs/technical/QA-proxy.md). To add a
scenario, use the `/qa-proxy-scenario` skill.

```bash
npm ci
npm test                                         # proxy + every scenario
QA_PROXY_ACTIVE=billing-grace-period npm start   # proxy :8080, control :8090

adb shell am force-stop com.example.app
adb shell am start -W -n com.example.app/.LauncherActivity --es debug_qa_proxy 10.0.2.2:8080
```

The app stores the address until it is launched with `--es debug_qa_proxy none` or its data is
cleared. In Docker / CI use `docker/qa-proxy.sh` instead.
