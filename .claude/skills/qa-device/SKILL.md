---
name: qa-device
description: Runs a device test plan (Markdown, inline or a file) against the installed debug app on an emulator or device - one mobile-devices sub-agent per case, preconditions (data clear, launch arguments, account, QA-proxy scenarios) arranged by the orchestrator before each case, a screenshot and recording per case, and a report. Use when the user says "QA this", "run the test plan", "validate on the emulator", or hands over test steps to execute on a device.
argument-hint: "<test plan path or text> [--scenarios-manifest <scenarios.json>]"
---

You are running a QA session against the debug app on a connected device or emulator. The app is
already installed - do not build or install it unless asked.

This skill is the **orchestrator**. It never taps the screen itself: every case runs in its own
`mobile-devices` sub-agent, so screenshots and UI trees stay out of this conversation. What the
sub-agent cannot do - clear data, pass launch arguments, start the proxy, switch scenarios - you do
here, before the sub-agent starts.

## Phase 1 - Parse the plan

Extract every case: **Title**, **Precondition**, **Steps**, **Expected** (one bullet per check,
tagged with its step). A shared-setup block ("Common preconditions") is added to every case's
precondition; a case's own precondition wins where they conflict.

A `QA proxy scenarios` section is **not** shared setup. It specifies scenarios that do not exist yet
(`State`, `Rewrites`, `Params`, `The app also needs`, `Cases`) for Phase 1b. Cases that need a
scenario name it in their own precondition (`QA proxy: billing-grace-period:daysAgo=10`).

Print the parsed cases with how each precondition will be arranged, plus the scenarios Phase 1b
would write:

```
TC-1: Profile - grace-period banner
  Precondition: signed in as the subscriber test account · QA proxy: billing-grace-period
  Arranged as:  pm clear · RC billingBannerEnabled=true · app-auth subscriber · proxy billing-grace-period
  Steps: open Profile → tap the banner
  Expected: (step 1) "Update payment method" banner shows · (step 2) store billing page opens

Proxy scenarios to write first (Phase 1b):
  - assistant-chat-status:status=<402|500> - TC-4...TC-6
    Adds qa-proxy/scenarios/<name>.js + its test (not committed)
```

Ask once: **"Proceed with these cases?"** That confirmation also covers writing the listed
scenarios. In CI (no human) proceed without asking.

## Phase 1b - Missing proxy scenarios

Skip this phase when `--scenarios-manifest` is given (CI already ran `/qa-proxy-prepare`): read the
manifest instead; a case whose need is under `unresolved` is BLOCKED.

Otherwise, before printing the plan:

```bash
node .claude/skills/qa-proxy-prepare/scripts/check_proxy_specs.mjs --cases <plan file>
```

Every `MISSING_SCENARIO`, `UNSPECIFIED_SCENARIO`, `DESCRIBED_NEED`, or `UNREAD_PARAM` for a param a
scenario should support is a scenario to write. So is a precondition that describes a server state
in prose ("chat endpoint returns 402") once `qa-proxy/scenarios/` and `docs/technical/QA-proxy.md`
show nothing produces it.

After confirmation, dispatch **one** `general-purpose` sub-agent running
`/qa-proxy-prepare <plan file> --out <work dir>` - never in your own turn; its code reading would
bury the run you still have to drive. Then continue with `<work dir>/qa_test_plan.resolved.md`, keep
`scenarios.json`, and `POST /scenarios/reload` on a proxy that was already running.

## Phase 2 - Report directory

`qa-reports/YYYY-MM-DD-HHmm-<slug>/` with `screenshots/` and `videos/`. Pass its absolute path to
every sub-agent.

## Phase 3 - Execute, one case at a time

Sequentially - cases share one device.

### Arrange the precondition (you, not the sub-agent)

| Precondition says | Mechanism |
|---|---|
| Fresh install / data cleared | `adb shell pm clear <package>` - this also wipes the stored proxy address |
| A remote-config value | `--es <rcKey> <value>` debug launch argument in the priming launch |
| Signed in as a tier / signed out | One `app-auth` sub-agent (keeps the sign-in out of the case recording) |
| **A server-driven state** | **The QA proxy - below** |
| Anything else (data the account holds) | Pass to the sub-agent as text; it returns BLOCKED if it doesn't hold |

Order: `pm clear` → **one priming launch** with every launch argument (including
`--es debug_qa_proxy <address>`) → force-stop → `app-auth` → set the proxy scenarios → start the
sub-agent with `Starting app state: cold start`.

### The QA proxy

| | Local emulator | Inside the CI `agent` container |
|---|---|---|
| Proxy running | `cd qa-proxy && npm ci && npm start` (background) | started by the workflow |
| Address for the app | `10.0.2.2:8080` | `"$(getent hosts qa-proxy \| awk '{print $1}'):8080"` |
| Set a case's scenarios | `node qa-proxy/src/set-scenarios.js '<spec>'` | the same (reads `$QA_PROXY_URL`) |
| Check the rewrite | `curl -s 'http://127.0.0.1:8090/log?modified=true'` | `curl -s "$QA_PROXY_URL/log?modified=true"` |

1. **Route the app once** with `--es debug_qa_proxy <address>`. Never use the device-wide
   `http_proxy` setting - it breaks every SDK's TLS. The address is stored, so the sub-agents' cold
   starts keep it; `pm clear` wipes it.
2. **Before each case, set exactly that case's list** - `none` for a case without one, so the
   previous case's state cannot leak. `DELETE /log` too. An unknown scenario name fails the command:
   the case is BLOCKED, never run against real data.
3. **After the case, read `GET /log?modified=true`.** The case can PASS only if the log shows its
   scenario rewrote the request. An empty log means the app fell back to a direct connection and the
   case saw real data → BLOCKED with that reason. An entry with `errors` means the hook threw →
   BLOCKED. This also is the first on-device check of a scenario written in Phase 1b.
4. **When the run ends,** launch once with `--es debug_qa_proxy none`; locally, stop the proxy.

### The per-case sub-agent

One `mobile-devices` sub-agent per case. Its prompt carries: the report dir, the case id, title,
steps, expected bullets, the starting state, and this return contract:

```
CASE: TC-N
VERDICT: PASS | FAIL | BLOCKED
CHECKS: (step k) <expected> - PASS|FAIL - <what was on screen>
SCREENSHOT: <path>
VIDEO: <path>
NOTES: <anything unexpected>
```

The sub-agent must not relaunch the app with launch arguments, touch proxy settings or switch
scenarios. Combine its verdict with step 3 above: a sub-agent PASS with an unmodified proxy log is
BLOCKED.

## Phase 4 - Report

`report.md` in the report dir: a summary table (case, verdict, reason), then per case the merged
precondition and *how it was arranged* (`pm clear · RC ... · app-auth ... · proxy <spec>`), each check,
links to the screenshot and video, and for proxy cases the log line that proves the rewrite.

If Phase 1b wrote scenarios, copy `scenarios.json` and `qa-proxy-scenarios.patch` into the report
dir and say plainly that they are **uncommitted** and need review.
