# AI Assistant & Billing - Test Cases

Runnable with `/qa-device docs/qa-plans/ai-assistant.test-cases.md`.

**Common preconditions:** debug build installed · RC aiAssistantEnabled = true · RC billingBannerEnabled = true

## QA proxy scenarios

Server states the cases need that no scenario in `qa-proxy/scenarios/` produces yet. The QA run
writes each one from this specification before the proxy starts; nothing here is committed by the
run. Cases that need a scenario name it in their own precondition.

### `assistant-chat-status`

- **State:** sending a chat message fails with the given HTTP status; the chat shows the paywall for 402 and the generic error for 500
- **Rewrites:** `POST /assistant/v1/chat` → answered by the proxy with `status` and body `{"detail": "qa-proxy assistant-chat-status"}`, without contacting the server; every other request stays real
- **Params:** `status` (default `500`)
- **The app also needs:** a signed-in user; credits available (otherwise the app never sends the message)
- **Cases:** TC-4, TC-5

---

## Profile

### TC-1: Profile - Subscriber in grace period - Payment banner

**Precondition:** Cold start. Signed in as the subscriber test account · QA proxy: `billing-grace-period:daysAgo=10:store=PLAY_STORE`

**Steps:**
1. Open Profile from the bottom bar
2. Tap the "Update payment method" banner

**Expected:**
- (step 1) The banner reads "Your payment failed 10 days ago"
- (step 2) The Google Play subscriptions page opens

---

## AI Assistant

### TC-2: Assistant - Out of credits - Upgrade prompt

**Precondition:** Cold start. Signed in as the free test account · QA proxy: `ai-credits:left=0:cost=5`

**Steps:**
1. Open any instrument and tap "Ask AI"

**Expected:**
- (step 1) The "You're out of credits" sheet opens with an "Upgrade" button

---

### TC-3: Assistant - Credits check fails - Error dialog

**Precondition:** Cold start. Signed in as the free test account · QA proxy: `ai-credits:fail=true`

**Steps:**
1. Open any instrument and tap "Ask AI"

**Expected:**
- (step 1) The generic "Something went wrong" dialog shows with a "Retry" button

---

### TC-4: Assistant - Chat answers 402 - Paywall

**Precondition:** Cold start. Signed in as the free test account · QA proxy: `assistant-chat-status:status=402`

**Steps:**
1. Open any instrument and tap "Ask AI"
2. Type "Summarise today's move" and tap Send

**Expected:**
- (step 2) The paywall opens; the typed message stays in the composer

---

### TC-5: Assistant - Chat answers 500 - Error inline

**Precondition:** Cold start. Signed in as the free test account · QA proxy: `assistant-chat-status:status=500`

**Steps:**
1. Open any instrument and tap "Ask AI"
2. Type "Summarise today's move" and tap Send

**Expected:**
- (step 2) The message shows "Couldn't send - tap to retry"

---

## Instrument

### TC-6: Instrument - Live stream reports a halt - Halted badge

**Precondition:** Cold start. Signed in as the free test account with AAPL in the watchlist · QA proxy: `quote-stream-halt:symbol=AAPL`

**Steps:**
1. Open AAPL from the watchlist

**Expected:**
- (step 1) A "Trading halted" badge shows next to the price, and the price stops updating
