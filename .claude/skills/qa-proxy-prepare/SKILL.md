---
name: qa-proxy-prepare
description: Reads a device test plan (Markdown or Jira wiki markup), finds every server-driven state it needs that no qa-proxy scenario produces yet, and has one sub-agent per missing scenario write it (via `/qa-proxy-scenario`, with its test), then verifies them and writes a resolved plan, a manifest and a patch. An orchestrator - it never writes scenario code itself and never touches a device. Used by `/qa-device` Phase 1b and by the CI QA workflow before the proxy starts; run it directly when a plan says "no qa-proxy scenario does that yet" and you want the scenarios written before a QA run.
argument-hint: "<test plan or cases file> [--out <dir>] [--no-docs]"
---

# Prepare the QA-proxy scenarios a test plan needs

A test plan often needs a server state the account cannot produce - an HTTP 402 from the chat
endpoint, a subscription in its billing grace period, zero credits. The QA proxy (`docs/technical/QA-proxy.md`)
arranges that, but only if a scenario for it exists. This skill closes that gap **before** the run:
it collects the needs, writes the missing scenarios through sub-agents, checks them, and hands back a
plan whose preconditions name concrete specs.

You are the orchestrator. Never run `/qa-proxy-scenario` in your own turn: it traces Retrofit
interfaces, response models, mappers and caches, and that trail is exactly what this skill exists to
keep out of the caller's context. Never touch a device - no `adb`, no mobile MCP.

## Input

`$ARGUMENTS`:

- **The plan** - a path to a test plan or cases file. Markdown (`QA proxy: \`spec\``) or Jira wiki
  markup (`QA proxy: {{spec}}`), as posted on a ticket. Read it in full.
- `--out <dir>` - where the four outputs go. Default: `/tmp/qa-proxy-prepare-<YYYYMMDD-HHMMSS>/`.
  Create it, and print its path at the end.
- `--no-docs` - the caller's `docs/` is read-only (CI checks docs out read-only): skip the
  docs row in `/qa-proxy-scenario` Phase 7.

Whatever happens, finish with `<out>/status.txt` written (step 5). A caller reads it to decide what
to do next; a missing file reads as a crash.

## 1. Collect the needs

```bash
node ${CLAUDE_SKILL_DIR}/scripts/check_proxy_specs.mjs --cases <plan>
```

It uses the proxy's own parser and registry, reads both backticked and `{{wiki}}` specs, and prints
one `PROBLEM:` line per spec it cannot run. It also reads the plan's **`QA proxy scenarios` section**
- the specification the case-writing skills leave for exactly this step: one entry per scenario to
write, with `State`, `Rewrites` (`METHOD /path` → fields and values), `Params`, `The app also needs`
and `Cases`. Run it with `--json` as well: `specifications` holds every entry, and each
`MISSING_SCENARIO` / `UNREAD_PARAM` problem carries `specified: true` when the section covers it.

| Problem | Need |
|---|---|
| `MISSING_SCENARIO` | A scenario of that name, accepting those params - the section's entry is the brief |
| `UNSPECIFIED_SCENARIO` | The same, with no entry: the sub-agent derives the endpoint and fields from the code (slower, and it may find no scenario can produce the state). Still a need |
| `UNREAD_PARAM` | A typo → note it for the resolved plan. A param the scenario should support (`specified: true`, or the plan reads that way) → extend that scenario |
| `DESCRIBED_NEED` | An HTTP route after "QA proxy" (`{{POST /assistant/v1/chat}}`) - a scenario rewriting that route |
| `SYNTAX` | Not a need. Fix it in the resolved plan (`,` between params → `:`) |
| `BROKEN_SCENARIO` | A file already in `qa-proxy/scenarios/` fails validation. Stop: write `FAILED` with the error |

Then read every precondition and the shared setup. **A server-driven state with no spec at all is a
need too**: "→ HTTP 402 (new scenario, see note)", "the chat endpoint fails with 500", "subscription in
grace period", "entitlement expired", "No qa-proxy scenario does that yet". Before counting one, check
`qa-proxy/scenarios/` and `docs/technical/QA-proxy.md` § "Available scenarios" - when an
existing scenario already produces the state, the need is just its spec, written into the resolved
plan; nothing is written. A state the account or Remote Config arranges (tier, RC arm, cleared data)
is not a proxy need.

No needs at all → write `NONE_NEEDED`, copy the plan unchanged to `<out>/qa_test_plan.resolved.md`,
write an empty manifest, and stop.

## 2. Group the needs by server state

**One scenario per server state.** Several cases that need the same endpoint in different shapes are
one scenario with a param - TC-4 to TC-8 needing `POST /assistant/v1/chat` to answer
402 or 500 become one `assistant-chat-status:status=<402|500>`, not five scenarios. A new param on an
existing scenario beats a copy (`/qa-proxy-scenario` Phase 3). Two unrelated states stay two
scenarios.

When the plan already names a spec (`MISSING_SCENARIO`), that name and those params are the contract:
the scenario must accept exactly them. Otherwise pick a kebab-case name for the state, not for the
test (`assistant-chat-status`, not `tc-4-paywall`).

## 3. Dispatch one sub-agent per scenario

One `general-purpose` sub-agent per scenario, **all in one message so they run in parallel**. They
write disjoint files - `qa-proxy/scenarios/<name>.js` and `qa-proxy/test/scenarios/<name>.test.js`.
The exception: two needs that extend the **same existing** scenario go to one sub-agent, or run one
after the other - never two agents editing one file.

```
Agent(subagent_type: "general-purpose", description: "Write qa-proxy scenario <name>",
      prompt: "Run /qa-proxy-scenario for: <the state>. ...")
```

Brief each with:

- **The specification entry**, verbatim, when the plan's `QA proxy scenarios` section has one for
  the scenario - its `State`, `Rewrites`, `Params`, `The app also needs` and `Cases`. It is the
  contract: the scenario rewrites that request and those fields, and accepts those params. Where the
  code disagrees (another path, wire name or type), the code wins and the sub-agent says so in its
  report, so the resolved plan can follow.
- **The state in the plan's words** - the precondition text verbatim, and which cases need it.
- **The spec the cases will use** - name and params (`assistant-chat-status:status=402`). The scenario
  must accept exactly that, or the sub-agent says why not and proposes the spec it accepts instead.
- **What the plan already says about the trigger** - the screen, the account tier, the RC flags. The
  sub-agent finds the gate itself (`/qa-proxy-scenario` Phase 2); do not trace it here.
- **When extending**, the existing scenario to extend and the param to add.
- **These overrides of `/qa-proxy-scenario`:**
  - Skip Phase 6 (on-device check). The first case that uses the scenario confirms it through
    `GET /log?modified=true`.
  - Skip Phase 7 (docs row) when `--no-docs` was given. Otherwise keep it.
  - Do not commit, branch or push.
  - If no scenario can produce the state - the app never sends the request for this user, or the
    state is not server-driven - write nothing and say so.
- **This return block**, exactly, as the last thing it says:

  ```
  Scenario: <name> | NONE
  Action: written | extended | unresolved
  Endpoint: <METHOD path>, ...
  Params: <param>=<default>, ...   (for extended: only the params this run added)
  Specs: TC-4=<spec>; TC-5=<spec>; ...
  Tests: <npm test pass count, or the failure>
  Reason: <only for unresolved - why no scenario can produce the state>
  ```

## 4. Verify the results yourself

Do not take a sub-agent's word for it. Once they have all returned:

```bash
cd qa-proxy && npm ci && npm test                                         # every test passes
node ${CLAUDE_SKILL_DIR}/scripts/check_proxy_specs.mjs '<spec>' [...]     # every spec the agents returned: RUNNABLE: True
```

| What came back | What you do |
|---|---|
| Tests pass and every returned spec is runnable | Resolved |
| `Action: unresolved` | Record it under `unresolved` with the agent's `Reason` |
| A test fails, or a spec is not runnable | Send the failure to the **same** sub-agent once (`SendMessage`, or a fresh agent with its report and the error when `SendMessage` is unavailable). Re-verify |
| It fails again | Revert that scenario's files (`git checkout --` an extended file, delete a new one), re-run `npm test` so the rest still passes, and record the need under `unresolved` with the failure as the reason |

**Never hand back a scenario that has not passed verification.** `npm test` validates every file in
`scenarios/`, so one broken file also breaks the proxy's startup for every other case.

## 5. Write the outputs

All four, into `<out>/`:

1. **`qa_test_plan.resolved.md`** - the plan with every need replaced by its concrete spec, in the
   plan's own markup: `{{assistant-chat-status:status=402}}` in wiki, `` `assistant-chat-status:status=402` ``
   in Markdown. Prose like "→ HTTP 402 (new scenario, see note)" becomes `QA proxy: <spec>`. Fix the
   `SYNTAX` and typo specs found in step 1. Leave an unresolved need's text as it was. Keep the
   `QA proxy scenarios` section - it documents what this run wrote - and when a sub-agent's
   scenario deviated from its entry (another endpoint, field or param), update the entry to what was
   written. Then:

   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/check_proxy_specs.mjs --cases <out>/qa_test_plan.resolved.md
   ```

   Every `PROBLEM:` still printed must belong to a need under `unresolved`. Anything else is a defect
   in the resolved plan - fix it.
2. **`scenarios.json`**:

   ```json
   {
     "written":    [{ "name": "assistant-chat-status", "params": { "status": 402 },
                      "endpoint": "POST /assistant/v1/chat", "cases": ["TC-4", "TC-5"] }],
     "extended":   [{ "name": "ai-credits", "params": { "fail": false },
                      "endpoint": "GET /assistant/v1/credits", "cases": ["TC-2"] }],
     "unresolved": [{ "need": "subscription in grace period", "cases": ["TC-9"],
                      "reason": "the app never sends the request for a user without permissions" }]
   }
   ```

   Always all three keys, empty arrays included. `params` are the defaults (for `extended`, only the
   params this run added). `cases` uses the plan's own case ids.
3. **`qa-proxy-scenarios.patch`** - everything this run changed under `qa-proxy/`, new files
   included, so a developer can review and commit it:

   ```bash
   NEW="$(git ls-files --others --exclude-standard -- qa-proxy/)"
   [ -n "$NEW" ] && git add -N -- $NEW          # intent-to-add, so git diff shows the new files
   git diff -- qa-proxy/ > <out>/qa-proxy-scenarios.patch
   [ -n "$NEW" ] && git reset -q -- $NEW
   ```

   Empty when nothing was written.
4. **`status.txt`** - one word:

   | Status | When |
   |---|---|
   | `READY` | Every need is resolved |
   | `PARTIAL` | Some needs resolved, some under `unresolved` |
   | `NONE_NEEDED` | The plan needs no scenario that does not already exist |
   | `FAILED` | No need could be resolved, or the run broke (`npm ci` failed, `BROKEN_SCENARIO`). Still write the other files as far as you got |

## 6. Report

```
QA-proxy scenarios: <READY | PARTIAL | NONE_NEEDED | FAILED>
  written:    assistant-chat-status (status) - TC-4...TC-8
  extended:   -
  unresolved: TC-9 "subscription in grace period" - <reason>
Resolved plan: <out>/qa_test_plan.resolved.md
Patch:         <out>/qa-proxy-scenarios.patch (uncommitted - review before committing)
```

## Rules that do not bend

- **Never commit, branch or push** the scenarios. In CI they live only as the patch artifact.
- **The generated JS runs only inside the `qa-proxy` and `agent` containers**, both on the compose
  network with no `ports:` mapping and no secrets mounted into `qa-proxy`
  (`docker/compose/qa-proxy.base.yml`). Never add a port mapping, a secret or a network call to an
  external host in a scenario.
- **No false PASS downstream.** A scenario that exists is not a scenario that applied: the QA run
  still marks a case PASS only when `/log?modified=true` shows its scenario rewrote the request.
