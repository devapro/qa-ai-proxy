# QA proxy: arranging server-driven states on a device

The QA proxy (`qa-proxy/`) lets a device test put the app into a state only the backend can
produce - a subscription in its grace period, an exhausted quota, an error response, a live-quote
event - without a test account that is really in that state. The debug app talks to the **real**
backend through the proxy, and a JavaScript *scenario* rewrites the chosen response or WebSocket
frame on the way back.

This is the canonical contract. The `/qa-proxy-scenario` skill follows it when it writes a scenario;
the same steps work by hand.

## Scope

- **Debug builds only.** The app routes through the proxy when launched with
  `--es debug_qa_proxy <host:port>`. Release builds ignore the switch.
- **The app's own traffic only** - the OkHttp clients behind the app's APIs and its WebSocket.
  SDKs (analytics, ads, crash reporting, remote config), WebViews and the rest of the device connect
  directly. A scenario therefore cannot rewrite SDK traffic.
- **Never** the device-wide proxy setting (`settings put global http_proxy`): every SDK would fail
  TLS against the proxy's CA and the app would stop behaving like a real install.

## How it works

```
app (debug) ──debug_qa_proxy──► qa-proxy :8080 ──► real backend
   └── SDKs, WebViews: direct        │  ▲
                     scenarios/*.js ─┘  └─ control API :8090 ◄── test / QA agent
```

- **HTTP(S):** TLS is intercepted with the proxy's own CA (mockttp). A request matching an active
  scenario rule runs through the scenario's hooks; everything else passes through untouched.
- **WebSocket:** every upgrade goes to an in-process relay that performs the real upstream handshake
  **first** (a `401` stays a `401`), then pipes every frame through the active socket hooks.
- **App side:** a `ProxySelector` returns `[HTTP proxy, DIRECT]` while an address is stored, so a
  stopped proxy never takes the app offline - and a case that ran without the proxy is detected
  through the log, not through a broken app.

## Enabling it

### Locally

```bash
cd qa-proxy && npm ci
QA_PROXY_ACTIVE=billing-grace-period npm start     # proxy :8080, control :8090

adb shell am force-stop com.example.app
adb shell am start -W -n com.example.app/.LauncherActivity --es debug_qa_proxy 10.0.2.2:8080
# afterwards:
adb shell am start -W -n com.example.app/.LauncherActivity --es debug_qa_proxy none
```

`10.0.2.2` is the host as seen from an emulator; a physical device on the same network uses the
machine's LAN IP.

### Docker / CI

`docker/qa-proxy.sh <compose-file> <emulator-service> <action> [scenarios]`:

| Action | Does |
|---|---|
| `attach [scenarios]` | Starts the proxy, sets the scenario list, launches the app with the proxy address |
| `use <scenarios>` | Replaces the scenario list between tests - no restart, no relaunch |
| `launch` | Relaunches the app with the address, e.g. after `pm clear` |
| `log` | Requests and frames a scenario modified, hook errors, TLS failures |
| `status` | Container state and the address the app has stored |
| `detach` | Launches the app with `none`, then stops the proxy |

From inside the agent container (no `docker` there): `node qa-proxy/src/set-scenarios.js '<spec>'`
(reads `$QA_PROXY_URL`), the app address is `"$(getent hosts qa-proxy | awk '{print $1}'):8080"`.

### How the app keeps the address

- **Stored** until launched with `none` or `pm clear`. Helper agents' plain relaunches keep it.
- **Requests made before the launcher activity** go direct on the launch that sets it. Use a priming
  launch (launch with the argument, force-stop, launch again) when the scenario targets such a request.
- A running app picks up a changed address on its next *new* connection - relaunch after changing it.

## Scenario list format

| Spec | Meaning |
|---|---|
| `billing-grace-period` | One scenario with default params |
| `billing-grace-period:daysAgo=10:store=PLAY_STORE` | Params joined with `:` |
| `billing-grace-period:daysAgo=10,ai-credits:left=0` | `,` starts another scenario (values parse as JSON, else string) |
| `[{"name":"ai-credits","params":{"left":0}}]` | JSON array |
| `none` or empty | Pass-through |

Setting a list **replaces** the active set, all or nothing: an unknown name rejects the whole list,
so a typo fails test setup instead of silently running against real data.

In a test case, the precondition names the mechanism:

```
Precondition: Signed in as the subscriber test account · QA proxy: `billing-grace-period:store=PLAY_STORE`
```

Name **every** field the app's gate reads, not just the headline one.

## Available scenarios

| Scenario | Rewrites | Params | The app also needs |
|---|---|---|---|
| `billing-grace-period` | `GET /users/v1/profile` → `subscription_status: "grace_period"`, `status_changed_at` = now − `daysAgo`. Other fields real; an error becomes a 200. With `store`, `POST /billing/v1/subscription` → `plan.store` | `daysAgo` (3); `store` (not rewritten) | Signed-in subscriber; RC `billingBannerEnabled = true` |
| `ai-credits` | `GET /assistant/v1/credits` → `credits_left`, `request_cost`, `can_run`. An error becomes a 200; `fail=true` answers 500 | `left` (50); `cost` (5); `fail` (false) | Signed-in user; RC `aiAssistantEnabled = true` |
| `quote-stream-halt` | Socket `/quotes`: drops `price` frames for `symbol`, injects a `halted` status frame on open | `symbol` (`AAPL`) | The instrument in the watchlist |

`GET /scenarios` lists what the running proxy loaded, with descriptions and defaults.

## Writing a scenario

One file per server state: `qa-proxy/scenarios/<name>.js`, `<name>` kebab-case and equal to the
file name.

```js
export default {
    name: 'billing-grace-period',
    description: 'What state the user ends up in, and what else the app needs to show it.',
    params: { daysAgo: 3 },                      // defaults; a spec overrides them
    http: [
        {
            method: 'GET',                       // optional, upper-case
            path: '/users/v1/profile',           // exact string or RegExp
            // host: 'api.example.com',          // optional
            // url: /lang=en/,                   // optional, full URL
            onRequest(request, ctx) {},          // optional
            onResponse(response, ctx) {},        // optional
        },
    ],
    socket: [
        {
            path: '/quotes',                     // optional; host optional too
            onOpen(ctx) {},
            onServerMessage(message, ctx) {},    // server → app
            onClientMessage(message, ctx) {},    // app → server
        },
    ],
};
```

### HTTP hooks

`request` = `{ method, url, host, path, headers, text, json }`; `response` = `{ status, headers,
text, json }` (bodies decoded; `json` undefined when not JSON). `ctx` = `{ params, log(message) }`,
plus `ctx.request` in `onResponse`.

| Hook returns | Effect |
|---|---|
| `undefined` | Unchanged |
| `{ status?, headers?, json? \| text? }` from `onResponse` | Replaces those parts; body re-encoded to the response's `Content-Encoding` |
| `{ method?, url?, headers?, json? \| text? }` from `onRequest` | Rewrites the request sent upstream |
| `{ respond: { status?, headers?, json? \| text? } }` from `onRequest` | Answers without contacting the server |

### Socket hooks

`message` = `{ text, json, data, isBinary }`; `ctx` = `{ params, url, log, sendToClient, sendToServer }`.

| Hook returns | Effect |
|---|---|
| `undefined` | Forwarded unchanged |
| `null` | Dropped |
| string / object / Buffer | Replaces the frame (object → JSON text, Buffer → binary) |
| array | Replaces the frame with several |

Frame formats are not guessable: `PUT /capture {"socketFrames":true}`, open the screen, read the
frames in `GET /log` before writing hooks.

### Rules

- Rewrite the real response; don't replace it - spread upstream `json`, override only what the
  state needs.
- Match on `path`, not host, unless two hosts serve the same path.
- Time-relative values are computed inside the hook, never at module load.
- Everything a test may vary is a param with a default.
- One scenario = one server state; a test that needs two activates two.
- No network calls, secrets or file I/O in a scenario.
- Several matching scenarios apply in activation order. A hook that throws leaves the traffic
  unchanged and is recorded in the log.

### Testing

`qa-proxy/test/scenarios/<name>.test.js`: hook unit tests (happy path, error upstream, every param)
plus one end-to-end test through the proxy against a local HTTPS upstream. `npm test` also validates
every file in `scenarios/`. CI runs it on every PR touching `qa-proxy/`.

## Control API (:8090, unauthenticated - loopback or compose network only)

| Method & path | Body | Does |
|---|---|---|
| `GET /health` | | Liveness |
| `GET /scenarios` · `POST /scenarios/reload` | | List loaded scenarios · re-read `scenarios/` |
| `GET /active` · `PUT /active` | `[{name, params?}]` | Active set · replace it (all or nothing) |
| `POST /active` | `{name, params?}` | Add one / update its params |
| `DELETE /active` · `DELETE /active/<name>` | | Clear all · remove one |
| `POST /socket/emit` | `{message, host?, path?}` | Push a server event to open sockets (`409` when none matched) |
| `GET /socket/connections` | | Open sockets |
| `PUT /capture` | `{socketFrames: true}` | Also log unmodified frames |
| `GET /log?modified=true&limit=N` · `DELETE /log` | | Traffic log (rewrites, hook errors, TLS failures) · clear |
| `GET /ca.pem` | | The proxy CA |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `QA_PROXY_ACTIVE` | - | Scenario list at start-up |
| `QA_PROXY_PORT` / `QA_PROXY_CONTROL_PORT` | `8080` / `8090` | Ports |
| `QA_PROXY_CONTROL_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Control API bind address |
| `QA_PROXY_INSECURE_UPSTREAM` | `false` | Accept invalid upstream certificates (self-signed staging) |
| `QA_PROXY_CA_DIR` | `qa-proxy/.ca/` | Where the CA is kept between runs |
| `QA_PROXY_LOG_CAPACITY` | `1000` | Traffic-log entries in memory |

## Troubleshooting

| Symptom | Cause |
|---|---|
| `GET /log` empty after launching the app | App not launched with the address, `pm clear` wiped it, or the address is wrong for the device (the app fell back to direct) - `qa-proxy.sh ... status` |
| The request never appears in the log | The app didn't send it - check the gating in the consuming repository |
| In the log, `modifiedBy` empty | No active scenario matched - check `GET /active` and the rule's method/path |
| An entry has `errors` | The hook threw; the real response passed through |
| `tls-error` entries | Something routed device-wide traffic through the proxy (leftover global `http_proxy`) |
| An SDK request never appears | Expected - SDK traffic is not routed |
| Connections slow to start after the proxy stopped | The stored address points at a host that no longer answers - launch with `none` |
