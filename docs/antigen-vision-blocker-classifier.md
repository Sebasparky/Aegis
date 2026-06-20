# Antigen Vision Blocker Classifier — Future Direction

> **Status:** Future direction / design memo. **Not implementation work.**
> Do **not** modify runtime code, add dependencies, or build the model based on this document.
> This is a product/engineering memo we can return to deliberately later.

> **Related design memo:** [`docs/visual-blocker-classifier-pipeline.md`](./visual-blocker-classifier-pipeline.md) expands this direction into a staged SurfaceBoundaryRouter → VisualBlockerClassifierPipeline → Policy architecture, while preserving the rule that visual classification does not directly mint VGC.

## Why this matters

Language-model agents keep getting better at normal browsing. As they do, the share of failures that look like "the agent couldn't figure out the page" shrinks, and the share that looks like "the agent hit a trust boundary or a web blocker" grows. That is exactly Antigen's territory.

We have been debugging human-verification (HV) detection where the **visible browser clearly shows a Press & Hold wall**, but the DOM/snapshot path can miss it — or worse, exposes background page DOM instead of the overlay. Our response so far has been a steadily growing pile of rule-based, geometry, and DOM heuristics (screen-level HV detection, overlay-wall probes, VGC no-progress fallbacks, geometry obstruction scoring, and so on). Each one fixes a specific site and adds fragility.

The direction in this memo: keep the rules as the fast first stage, but add a **small, local, second-stage visual classifier** that looks at the rendered browser state **only when Antigen already believes the agent is stuck**. Agents get broader; Antigen gets sharper at the boundaries.

**Hard safety line:** this classifier may only classify **blocker state** and **user-presence state**. It must never solve CAPTCHAs, never bypass human verification, and never hand challenge details to the agent.

## Purpose & status

This document captures the long-term direction for using a small local CNN / vision classifier as a second-stage blocker detector for Antigen.

- This is **NOT implementation work right now.**
- Do **not** modify runtime code.
- Do **not** add dependencies.
- Do **not** build or train the model.
- This is a clear product/technical direction document to return to later.

## Context

Antigen is a trust, permission, and user-presence layer for autonomous browser agents. The division of labor is:

- **The agent** handles normal web tasks — navigation, reading, clicking, summarizing, ordinary form interaction.
- **Antigen** intervenes at trust boundaries:
  - human verification (HV / Press & Hold / "are you human" walls)
  - credentials / login
  - payment and checkout confirmation
  - account changes
  - identity / status verification (KYC, age, eligibility)
  - ambiguous blockers where the page state is unclear

The recurring problem driving this memo: during HV debugging, the **rendered browser shows the wall**, but the **DOM/snapshot path can miss it or expose background page DOM** behind the overlay. That mismatch is the signal that a visual surface classifier — one that observes what is actually rendered — would catch cases our structural heuristics keep slipping on, especially when other Antigen signals already say the agent is stuck.

## Core thesis

As language-model agents improve, they will handle more and more of normal browsing complexity on their own. The **residual failure cases concentrate at trust-boundary events and web blockers**.

Antigen improves over time by **learning from those stuck moments**. The split stays clean:

- Agents get **broader** — more of the open web, more task types.
- Antigen gets **sharper at the boundaries** — better at recognizing exactly the moments where a human, a credential, an approval, or a fail-closed pause is required.

## Safety framing

The vision model **must not** solve CAPTCHAs or bypass human verification. It may only classify blocker state and user-presence state.

### Safe (in scope)

- Detect that a human-verification surface is **visible**.
- Detect that **user presence is required**.
- Detect that the user's **live interaction appears active** (e.g. a hold in progress).
- Detect that the **wall appears cleared**.
- Tell Antigen whether to **pause, continue, ask the user, or fail closed**.

### Unsafe / out of scope

- Predict exact challenge coordinates for the agent.
- Solve image/text puzzles.
- Choose CAPTCHA answers.
- Automate hidden verification behavior.
- Send raw screenshots or sensitive page content to the agent.
- Train the agent to bypass provider defenses.

The classifier's job ends at "what kind of boundary is this, and what should Antigen do about it." It never produces an action that advances a challenge on the user's behalf.

## Architecture direction

A staged system. The expensive visual stage runs only after cheap structural signals say the agent is blocked.

### Stage 1 — Existing Antigen signals run first

Run the signals we already have, with no visual model involved:

- failed clicks
- repeated stale refs
- pointer interception
- no progress
- DOM / visual mismatch
- structural HV hints
- sensitive workflow boundaries

These remain the baseline and the fast path.

### Stage 2 — Trigger a local visual classifier only when blocked

Only when Stage 1 indicates the agent appears blocked:

- capture a **screenshot or cropped visual region**
- **no always-on, high-frequency monitoring** during normal browsing
- **local inference preferred**
- **no LLM tokens required** for inference

This is a targeted second look, not continuous surveillance of the page.

### Stage 3 — Classifier outputs safe enums / booleans only

The classifier returns structured, non-actionable outputs:

- `blocker_type`:
  - `normal_or_unblocked`
  - `non_hv_modal`
  - `cookie_banner`
  - `login_wall`
  - `marketing_modal`
  - `hv_full_page`
  - `hv_center_modal`
  - `hv_small_widget`
  - `hv_press_hold`
  - `hv_interaction_active`
  - `hv_cleared_or_settling`
  - `unknown_blocked`
- `confidence_bucket`: `low` / `medium` / `high`
- `user_presence_required`: boolean
- `wall_visible`: boolean
- `safe_to_resume`: boolean

No coordinates, no answers, no free-form page text.

### Stage 4 — Antigen policy engine maps output to action

The policy engine — not the model — decides what happens:

- **HV** (`hv_*`) → trigger the user-presence / VGC flow.
- **login wall** → credential flow.
- **payment / checkout confirmation** → approval flow.
- **marketing modal / cookie banner** → agent may handle if policy allows.
- **unknown blocker** → fail closed or ask the user.

The model classifies; the policy engine governs.

## User experience direction

The user should **not** have to hunt for the browser tab the agent is working in. Antigen should surface the interaction **inside the Antigen website/app**.

For HV, the app shows live, plain-language state:

- "Human verification detected."
- "Press and hold."
- "Keep holding…"
- "Progress detected…"
- "Verification clearing…"
- "Done — agent will resume."

This live feedback must come from **Antigen's local visual state classifier** — not from the agent and not from an LLM loop. The user is interacting with Antigen's read of the rendered state, in Antigen's surface.

## Training / data direction

An **active-learning loop**, scoped tightly to stuck events.

- During QA/beta, when the agent gets stuck, Antigen can capture **redacted screenshots/crops plus safe metadata**.
- Store **only high-value stuck events**, not random browsing.
- **Redact or avoid sensitive information**: passwords, cards, addresses, emails, phone numbers, account data, checkout details, private messages.
- Prefer **cropped suspected-blocker regions** over full-screen storage.
- Suggested stored metadata:
  - trigger reason
  - existing DOM / geometry signals
  - current classifier prediction
  - confidence bucket
  - eventual user/system outcome
  - manual label if reviewed
- **Do not automatically train on the model's own guesses.**
- Use human/QA-reviewed labels or **strong outcome labels**:
  - user completed verification and page resumed → likely HV
  - user dismissed popup and agent resumed → non-HV modal
  - agent accepted cookies → cookie banner
  - manual QA review → confirmed label

## Model lifecycle

- Collect data continuously.
- Train periodically **offline**.
- Evaluate against a **holdout set**.
- **Version** models.
- **Roll back** if a model gets worse.
- Keep **customer/org controls** for data collection.
- Make dataset capture **opt-in** for beta/production.

## Suggested phases

**Phase 0** — Finish the current rule-based / geometry / DOM baseline. Do **not** block current VGC work on the CNN.

**Phase 1** — Add **dev-only** screenshot/crop capture for stuck events, gated behind a flag such as `ANTIGEN_HV_VISION_DATASET=true`.

**Phase 2** — Manually label a small dataset across the classes:

- `normal_or_unblocked`
- `non_hv_modal`
- `cookie_banner`
- `login_wall`
- `marketing_modal`
- `hv_full_page`
- `hv_center_modal`
- `hv_small_widget`
- `hv_press_hold`
- `hv_interaction_active`
- `hv_cleared_or_settling`
- `unknown_blocked`

**Phase 3** — Train a **tiny local classifier** as a **second-stage confirmation only**.

**Phase 4** — Use the classifier for **live user-presence feedback** during VGC.

**Phase 5** — Introduce **controlled active learning** from real beta/production stuck events.

## When to pivot from rules to CNN

Document the pivot criteria. Move when:

- the rule-based detector keeps accumulating fragile heuristics;
- the visual browser clearly shows HV but DOM/snapshot **repeatedly misses it**;
- we need **polished live feedback** such as progress detection;
- we need robust handling of **small / non-modal HV widgets**;
- the **false-positive / false-negative tradeoff** becomes painful;
- we have **enough labeled stuck-event data** to train and evaluate.

## Non-goals

- No CAPTCHA solving.
- No provider-specific bypasses.
- No raw screenshot exposure to agents.
- No automatic, unreviewed online learning.
- No replacing the current rule-based baseline immediately.
