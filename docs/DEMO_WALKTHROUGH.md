# Aegis Rails — Demo Walkthrough

**Duration:** 5–7 minutes  
**Goal:** Show the full Aegis Rails lifecycle — private recording, verification, marketplace submission, and live external recording — in a coherent narrative.

---

## Before You Start

### 1. Reset demo data

```bash
npm run seed:demo
```

This writes a clean 4-route state and backs up the old store. Always run this before a demo to guarantee the expected routes are present.

### 2. Start the dev server

```bash
npm run dev
```

Wait for all three services to be ready:

| Service | URL | What it is |
|---|---|---|
| Web UI | `http://localhost:3000` | Aegis dashboard |
| Mock bank | `http://localhost:3001` | Banking demo app |
| API | `http://localhost:4000` | Aegis backend |

### 3. Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `apps/extension/` directory
5. **Aegis Recorder** appears in the toolbar

If you've loaded it before, click the refresh icon on the extension card after any code change.

---

## Demo Route Overview

After `npm run seed:demo`, `/rails` shows exactly four routes — one per product state:

| Route | Domain | Tier | Marketplace | What it demonstrates |
|---|---|---|---|---|
| Demo Banking Workflow | localhost | Verified | Private — ready for review | Local demo, visual replay, parameterized variable |
| Wikipedia Search | en.wikipedia.org | Verified | Approved | External recording, marketplace-approved |
| Account Statement Draft | localhost | Draft | Needs verification | Private use without verification |
| Wikipedia Topic Lookup | en.wikipedia.org | Verified | Pending review | Review queue |

---

## Main Demo Flow

### Open Recorded Skills

Open `http://localhost:3000/rails`.

> "This is the Recorded Skills workspace. Each card is a workflow route — a structured, inspectable execution path for a specific task on a specific site."

Point to the two-row status on any card:

> "Every skill shows two statuses. Private use is always ready — you can use a skill the moment you record it, no verification needed. Marketplace readiness is separate. Verification and review are only required if you want to share a skill with other users or agents."

---

### Preview a local route

Click **Preview** on **Demo Banking Workflow**.

The right panel opens. Walk through it:

- **Route Health** checklist — locator quality, value policies, verification status
- **Capability badges** — Local demo · Visual replay · Parameterized
- **Steps** — navigate Statements → select month (variable: `select_month`) → click Download Statement

> "This route is parameterized. The agent can pass a different month at runtime without touching the route. The route itself stores no sensitive values — only the structure."

---

### Local visual replay

With the banking route preview open, click **Replay on Local Demo**.

The mock bank app at `localhost:3001` opens and the route replays step-by-step.

> "Visual replay lets you verify what the agent will do before it runs. Same locators, same element matching — exactly what an agent would execute."

---

### External visual replay

Click **Preview** on **Wikipedia Search**.

Click **Replay on Wikipedia**.

Chrome opens `en.wikipedia.org`, fills the search box with "Michigan", and clicks Search.

> "This route was recorded on live Wikipedia using the Chrome extension. Verification ran the same Playwright replay and confirmed the locators are stable. The verification evidence is stored in the route."

---

### Verify a draft route

Find **Account Statement Draft** (trust tier: Draft). Click **Preview**.

Route Health shows: locators are present, but no verification run yet.

Click **Verify** on the card.

The tier badge updates to **Verified** in place, and the Route Health checklist fills in.

> "Verification is a Playwright replay against the real page. Aegis confirms the locators resolve, the steps execute, and nothing unexpected happens. The route moves from draft to verified — now it can be submitted for marketplace review."

---

### Submit for marketplace review

On the now-verified Account Statement Draft card, the Marketplace status row shows **Ready for review** and the Submit button is enabled.

Click **Submit for Review**.

The status updates to **Pending review** and the Submit button goes amber/disabled.

> "Submission sends the route to the internal review queue. The route stays fully usable privately — submitting it doesn't change anything for the owner. It just starts the marketplace review process."

---

### Review a pending route

Open `http://localhost:3000/marketplace-review`.

**Wikipedia Topic Lookup** is waiting for review (submitted at seed time). **Account Statement Draft** also appears if you just submitted it.

Walk through the ReviewCard:

- Trust tier badge, domain, step count, risk level, submitted time
- Key signals: approval gates, forbidden actions, sensitive values, variables

> "This is the internal review queue. A reviewer reads the declared permissions and signals, checks the verification evidence, and approves or rejects. Once approved, the route appears in the public registry for any agent to discover."

Add an optional note, then click **Approve** or **Reject**.

The card disappears. Back on `/rails`, the route card shows the updated status.

---

## Live External Recording Flow

This section demonstrates recording a new route on a live website. Do this after the main flow.

### 1. Navigate to Wikipedia

Open a new Chrome tab and go to `https://en.wikipedia.org`.

### 2. Start recording

Click the **Aegis Recorder** icon in the toolbar.

The popup opens. Domain shows `en.wikipedia.org`. Status: **Idle**.

Click **Start Recording**.

Status changes to **Recording** with a green pulsing dot.

### 3. Perform the workflow

- Click the search box
- Type a search query (e.g. `Ann Arbor`)
- Click the **Search** button (magnifying glass)

Watch the popup — each interaction appears as a badge-tagged event row (FILL, CLICK, NAVIGATE). Events are captured using the accessibility tree and resolved labels, not raw coordinates.

### 4. Stop and submit

Click **Stop Recording** in the popup.

Status returns to **Idle**. The event list shows the captured steps.

Click **Submit to Aegis**.

The popup shows: `✓ Saved as Wikipedia Search (route_XXXXXXXX…)`

### 5. Verify it appeared

Open `http://localhost:3000/rails`.

The new route appears as an **unverified draft** for `en.wikipedia.org`.

> "Recorded, compiled, and saved — no code written. The route is private, immediately replayable, and ready for verification if you want to submit it to the marketplace."

---

## Talking Points

**Aegis is the App Store model for agent workflows.**  
Private skills are like apps you build for yourself — no review needed. Marketplace skills are like publishing to the App Store — they go through verification and human review before other users' agents can use them.

**Private skills need no verification.**  
The moment a recording is submitted, the route exists and is usable. Verification is not a gating step for personal use — it is a prerequisite only for marketplace submission.

**Routes are declarative, not arbitrary scripts.**  
A route is a structured JSON object — readable, diffable, reviewable. It contains no executable code. It cannot be modified after publication. An agent following a route is not running stranger's JavaScript inside your account.

**Sensitive values are protected.**  
The recorder classifies each input field. Passwords and card numbers produce `sensitive_redacted` — the value is stripped before it ever leaves the browser. Safe values produce `safe_literal`. Runtime-variable values are passed at execution time by the collar, not stored in the route.

**Verification evidence is explicit.**  
The verification report in each route shows which locators resolved, which steps executed, and the confidence score for each element match. Nothing is asserted without evidence.

**Collars always win.**  
A route declares its required permissions, but the user's collar sets the outer boundary. If a collar blocks `payment`, a route step that would trigger a payment is still blocked — routes cannot override user restrictions.

---

## What Not to Demo Yet

Avoid these in any demo or recording session:

| Target | Why |
|---|---|
| Gmail, Outlook, messaging apps | Message content is sensitive; auth required |
| LinkedIn, Facebook | Professional/personal PII; auth required |
| Any bank or financial portal | Credentials, payment flows |
| Checkout or purchase flows | Payment card fields |
| Medical or legal portals | Regulated PII |
| Any site requiring login | Credentials are sensitive |
| Arbitrary website verification | Playwright verification is scoped to sites with reliable ARIA; untested sites may fail unpredictably |
| Claiming this is a real public marketplace | The review queue is an internal prototype |

---

## Troubleshooting

**Routes from a previous session are still showing**  
Run `npm run seed:demo` and hard-reload the page (`Cmd+Shift+R`). The API reads from disk on each request so no restart is needed.

**Port already in use**  
Check for processes on 3000, 3001, or 4000:
```bash
lsof -ti :3000 -ti :3001 -ti :4000 | xargs kill -9
```
Then re-run `npm run dev`.

**Extension not capturing events**  
Reload the extension after any code change: `chrome://extensions` → refresh icon on Aegis Recorder. Then close and reopen the popup.

**Submit to Aegis fails with network error**  
The API must be running at `localhost:4000`. Confirm `npm run dev` is active and the API service is healthy.

**Playwright / Chromium not installed**  
Run:
```bash
npx playwright install chromium
```
Verification requires Chromium to be present in the Playwright cache.

**Visual replay opens a blank page**  
For local demo replay, the mock bank at `localhost:3001` must be running. Confirm `npm run dev` started all three services. For Wikipedia replay, a live internet connection is required.

**Route stuck in "pending_review" after approval**  
Hard-reload `/rails` — the card polls data on mount but does not live-update after a review action taken on a different page.
