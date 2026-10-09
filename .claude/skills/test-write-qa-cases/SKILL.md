---
name: test-write-qa-cases
description: Writes device test cases for a feature from its spec or ticket, in the Markdown format /qa-device runs - one case per start state, steps by visible label, one expected bullet per check - and names every server-driven state as a QA-proxy spec, specifying any scenario that does not exist yet so the QA run can write it. Use when asked to write test cases / a test plan for a feature.
argument-hint: "<spec path | ticket ID>"
---

Write test cases a human tester **or** an AI device agent can execute against the real debug app.
Output: `docs/qa-plans/<feature>.test-cases.md`.

## 1. Read the source

The spec or ticket, plus the feature's API contract. List every user-visible behaviour and the
**start state** each needs: account tier, remote-config arm, device setting, data the account must
hold - and **server state** the account cannot produce on demand (grace period, entitlement expired,
quota exhausted, an error response, a socket event).

## 2. Group into cases

One case per distinct start state; checks that share a start state go in one case, and every check
is asserted in exactly one case.

## 3. Write each case

```markdown
### TC-1: <Screen> - <User state> - <Short title>

**Precondition:** Cold start. Signed in as the subscriber test account · RC billingBannerEnabled = true · QA proxy: `billing-grace-period:daysAgo=10`

**Steps:**
1. Open Profile from the bottom bar
2. Tap the "Update payment method" banner

**Expected:**
- (step 1) The banner reads "Payment failed 10 days ago"
- (step 2) The store's subscription page opens
```

Steps: imperative, by visible label, 3-8 per case, every step an action; checks live in
`Expected:` tagged with their step.

### Server-driven states - always a QA-proxy spec

A server state is **never** described in prose alone ("account in grace period", "the chat endpoint
returns 402"): without a spec the runner cannot arrange it. Write `QA proxy: <spec>` in the
precondition:

- an existing scenario from `qa-proxy/scenarios/` (`docs/technical/QA-proxy.md` § "Available
  scenarios"), with params: `ai-credits:left=0:cost=5`. `:` joins params, `,` starts another
  scenario;
- or a **new** scenario you name here (kebab-case, named for the server state, not the test) and
  **specify** in the document's `## QA proxy scenarios` section:

```markdown
## QA proxy scenarios

### `assistant-chat-status`

- **State:** sending a message fails with the given HTTP status; the chat shows the matching error
- **Rewrites:** `POST /assistant/v1/chat` → answer `status` with body `{"detail": "qa-proxy"}` without contacting the server
- **Params:** `status` (default `500`)
- **The app also needs:** signed-in user, RC aiAssistantEnabled = true
- **Cases:** TC-4, TC-5, TC-6
```

Keep the five bullet labels exactly - they are parsed. `Rewrites` names the request from the
Retrofit interface and each field with its wire name. Every value a case varies is a `Param`.

Also name every **other** field the app's gate reads. If the banner only shows for Play Store
subscriptions and the test account's real subscription is from the App Store, the spec must also
rewrite the store (`billing-grace-period:store=PLAY_STORE`) - otherwise the gate silently stays
closed and the case fails for the wrong reason.

## 4. Validate

```bash
node .claude/skills/qa-proxy-prepare/scripts/check_proxy_specs.mjs --cases <file> --allow-specified-missing
```

It must exit 0: every spec is runnable, or names a scenario/param the `## QA proxy scenarios`
section specifies (the QA run writes those before the proxy starts). Fix `SYNTAX` and typo
`UNREAD_PARAM`s; add an entry for every `UNSPECIFIED_SCENARIO`.
