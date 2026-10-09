---
name: qa-proxy-scenario
description: Writes a qa-proxy scenario (JS rewriting a real backend response or WebSocket frame so the debug app shows a server-driven state - billing grace period, entitlement, quota, error, socket event) plus its test. Use when a test needs a state the test account can't produce.
argument-hint: "[the server state to produce - free text, a ticket ID, or a test-case precondition]"
---

You are adding a scenario to `qa-proxy/`, the MITM proxy the debug app talks to the real backend
through during device QA. `docs/technical/QA-proxy.md` is the canonical reference for the scenario
contract, the scenario-list format, the control API and the list of available scenarios - read it
first and follow it; this skill is the procedure. When they disagree, the doc wins.

## Input

$ARGUMENTS

If it is a ticket ID, fetch the ticket. If it names a test case or test-case file, read the
precondition that needs the state - and the file's `QA proxy scenarios` entry for it, when there is
one (`State`, `Rewrites` = `METHOD /path` → fields and values, `Params`, `The app also needs`,
`Cases`). The entry is the contract - the name and params the cases already use - so keep them
unless Phase 2 shows the code disagrees (another path, wire name or type); then the code wins, and
your report says what changed so the cases can follow.

## Phase 1 - Pin down the state

Write down, in one or two sentences, what the app must believe and what the user must see. Then find
the contract that drives it - the feature spec / API doc names the endpoint and fields.

List every *other* condition the screen needs - account tier, store, remote-config arm, frequency
caps, data the account must hold. A scenario only changes server data; the rest belongs in the
precondition, and the report must say so.

Do not ask the user whether the state is testable. Finding the endpoint is research.

## Phase 2 - Trace the endpoint in the app

Read the code that consumes the data, not only the docs - the code decides what the scenario must
send:

- **Path and method:** the Retrofit / Ktor interface. Match on `path` only unless two hosts serve
  the same path; hosts differ between environments.
- **Wire names and types:** the response model - `@Json(name = ...)` / `@SerialName(...)`,
  nullability, custom adapters (a date adapter decides whether you send ISO-8601 or epoch millis).
- **Interpretation:** the mapper (case-insensitive compare? a status that only counts when another
  field is set?).
- **Gating:** when the request is not made at all (e.g. a repository skips it for signed-out
  users). If the app never sends the request, no scenario can help - the precondition must arrange
  that part (the right test account).
- **Failure handling:** what a non-2xx means to the app. If a failure reads as "not in the state",
  force `status: 200` - the upstream may legitimately answer 404 for a user outside the state.
- **Caching:** HTTP cache, Room/DataStore caches, "refresh only on pull" rules. The precondition has
  to say how to force a fresh request (relaunch, pull-to-refresh, clear data).

For **sockets**, find the message model the app parses, and capture real frames before writing
hooks. Frame formats are not guessable:

```bash
curl -s -X PUT -d '{"socketFrames":true}' "$QA_PROXY_URL/capture"   # locally: http://127.0.0.1:8090
# open the target screen on the device, then:
curl -s "$QA_PROXY_URL/log?limit=200" | jq '.[] | select(.kind=="socket") | {direction, preview}'
```

## Phase 3 - Reuse or create

List `qa-proxy/scenarios/`. **One scenario = one server state.** If an existing scenario produces
the same state, add a `param` instead of a copy. A test that needs two states activates two
scenarios - do not merge unrelated states into one file.

## Phase 4 - Write the scenario

`qa-proxy/scenarios/<name>.js`, kebab-case `name` equal to the file name, named for the server
state (`assistant-chat-status`), not for the test (`tc-4-paywall`). Follow the contract in
`docs/technical/QA-proxy.md` § "Writing a scenario". `scenarios/billing-grace-period.js` is the
reference implementation.

- **Rewrite the real response; don't replace it.** Spread the upstream `json` and override only the
  fields the state needs, so fields the scenario doesn't know about stay real. Replace the whole
  body only when the upstream status is an error.
- **Compute time-relative values at response time** (`Date.now()` inside the hook), never at module
  load - a proxy runs for hours.
- **Everything a test may vary is a `param`** with a sensible default. Params from a spec string
  arrive as JSON-parsed values or strings - accept both (`params.fail === true || params.fail === 'true'`).
- **Validate params and throw on garbage.** A throwing hook passes the real response through and is
  logged as an error - visible - instead of sending the app a body it cannot parse.
- **`description`** says what state the user ends up in *and* what else the app needs to show it
  (account, store, RC arm). QA reads it via `GET /scenarios`.
- **No network calls, no secrets, no file I/O.** A scenario is a pure function of the traffic and
  its params.

## Phase 5 - Test it

Add `qa-proxy/test/scenarios/<name>.test.js`, modelled on `test/scenarios/billing-grace-period.test.js`:

1. **Hook unit tests** - call the hook as a plain function with a fake `response`/`message` and
   `{ params }`: the happy path, an error upstream, and every param.
2. **One end-to-end test through the proxy** - `startHttpsUpstream` + `startTestProxy` from
   `test/support.js`, activate with `proxy.control('PUT', '/active', [...])`, assert the client
   receives the rewritten body and `GET /log?modified=true` names the scenario.

```bash
cd qa-proxy && npm test
```

All tests must pass. The registry test also validates every file in `scenarios/`, so a malformed
scenario fails there first.

## Phase 6 - Verify on a device

If `adb devices` shows a device, verify the state in the real app. If none is reachable, say so in
the report - do not claim on-device verification.

Only the app's own traffic goes through the proxy, and the app is routed by a launch argument -
never by the device-wide `http_proxy` setting, which breaks every SDK's TLS.

- **Local emulator:** `QA_PROXY_ACTIVE=<name> npm start` in `qa-proxy/`, then force-stop the app and
  launch it with `adb shell am start -W -n <package>/<launcher activity> --es debug_qa_proxy 10.0.2.2:8080`.
- **Docker stack:** `docker/qa-proxy.sh <compose-file> <emulator-service> attach <name>`.

Open the screen and check two things: `GET /log?modified=true` shows the request rewritten by your
scenario, and the screen shows the state. The app falls back to a direct connection when the proxy
is not listening, so an empty log means the screen showed real data. Delegate screen checks to the
`mobile-devices` agent.

**Always restore the app afterwards**, even when verification fails: launch it with
`--es debug_qa_proxy none` (local) or run `qa-proxy.sh ... detach` (Docker). The address is stored
until then, so the next session would otherwise read fake server state.

## Phase 7 - Document it

Add a row for the new scenario to `docs/technical/QA-proxy.md` § "Available scenarios": what it
rewrites, its params and defaults, and what else the app needs to show the state.

## Phase 8 - Report

- Scenario name, what it rewrites (endpoint/frames + fields), params and defaults.
- The **precondition line** test cases should use, naming the concrete mechanism:
  `QA proxy: <name>[:param=value]` + the account/RC requirements from Phase 1.
- Test results (`npm test` pass count) and the on-device result, or why there wasn't one.
