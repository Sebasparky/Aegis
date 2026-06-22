# HUMAN_VERIFICATION_REQUIRED Return-Path Diagnostic Memo

**Status:** Diagnostic only. No runtime/behavior/HTTP/policy/classifier changes. Not committed.
**Scope:** `apps/api/src/routes/agent-api.ts` (HV-required emit sites) + the visual-judgment shadow telemetry pipeline (`apps/api/src/runtime/visualBlockerClassifier/visualJudgment.ts`).
**Date:** 2026-06-22
**Prompted by:** QA observed `hcaptcha.com` and `hubspot.com` produce **fresh** runtime queue events with a `live_policy_shadow` block, while `etsy.com` and `example.com` returned `HUMAN_VERIFICATION_REQUIRED` with **no fresh queue event** (only old events with `shadow: none`).

---

## TL;DR — the core conclusion

> **`HUMAN_VERIFICATION_REQUIRED` does NOT always imply a fresh visual-judgment queue event.**
>
> Only the **snapshot-mint path** (`POST /runtime/browser-snapshot`) currently calls `snapshotVisualJudgment(...)`. The **reuse guards** (active VGC capsule / cached HV marker) and the **action no-progress backstops** (click/type/set-value failures) can emit the canonical 409 `HUMAN_VERIFICATION_REQUIRED` **without ever running visual judgment**, so they append **no** queue event.

Therefore an event-less 409 is **expected behavior**, not a telemetry or live-policy failure. The shadow telemetry is wired into exactly one of the five HV emit sites.

Supporting reads of the QA evidence:

- **hCaptcha / HubSpot (fresh events):** confirm the new shadow telemetry works correctly *when the snapshot visual-judgment path actually runs*. The page freshly minted HV via the snapshot endpoint → `snapshotVisualJudgment(...)` ran → one queue event with `live_policy_shadow` was appended.
- **Etsy / example.com (no fresh event):** now explained as the 409 most likely originating from a **guard or no-progress backstop path**, none of which call `snapshotVisualJudgment(...)`. This is **not** a live-policy failure and **not** evidence the classifier or flags are broken. The pre-existing "old events, shadow none" entries predate the shadow telemetry slice; subsequent stops reuse cached HV/VGC state instead of re-detecting.

---

## The single canonical emitter

All 409 `HUMAN_VERIFICATION_REQUIRED` responses flow through one function:

- `sendHumanVerificationRequired(...)` — `agent-api.ts:556`
  - Sets `error_code: "HUMAN_VERIFICATION_REQUIRED"` / `error.code: "HUMAN_VERIFICATION_REQUIRED"` and the safe (no bytes/coords/cdp/refs) capsule view.

It is called from **exactly five sites**. Only the fifth is preceded by a `snapshotVisualJudgment(...)` call.

---

## The five `HUMAN_VERIFICATION_REQUIRED` return sites

| # | Emit line | Path / function | Surface type | Trigger condition | Trigger basis (judgment) | Visual-judgment coverage | Fresh queue event? |
|---|-----------|-----------------|--------------|-------------------|--------------------------|--------------------------|--------------------|
| 1 | `agent-api.ts:724` | `rejectIfVisualGestureCapsuleActive()` — pre-action guard, also called from browser-navigation-state (`5780`) and the browser-snapshot pre-extract guard (`5868`) | **VGC reuse** | An active (non-terminal) Visual Gesture Capsule already exists for the session (`getActiveVisualGestureCapsuleForBrowserSession`); fails closed and **reuses** it (`reason: "reused_existing_capsule"`, `created_capsule: false`) | — (none) | **NOT covered** — no judgment call | **No** |
| 2 | `agent-api.ts:785` | `rejectIfHumanVerificationActive()` — pre-action guard (click / type / set-value) | **Cached HV marker** | A cached HV marker from a **prior** snapshot is present (`getActiveHumanVerification`) and its request is still live; re-emits 409 until a fresh snapshot re-evaluates | — (none) | **NOT covered** — no judgment call | **No** |
| 3 | `agent-api.ts:974` | `rejectNoProgressActionAsHumanVerification()` | **No-progress / ambiguous** | An action made **no progress**; live CDP probe (`detectAmbiguousVisualObstructionViaCDP`) finds an opaque overlay (no structural wall) → mints an ambiguous-block VGC | — (none) | **NOT covered** — no judgment call | **No** |
| 4 | `agent-api.ts:1052` | `rejectNoProgressActionAsHumanVerification()` | **No-progress / structural** | An action made **no progress**; live CDP probe (`detectLiveHumanVerificationWall`) finds a **structural** page-level wall → mints HV request (+ page-level VGC) | — (none) | **NOT covered** — no judgment call | **No** |
| 5 | `agent-api.ts:6843` | `POST /api/agent/v1/runtime/browser-snapshot` (`snapshotMintedHv`) | **Snapshot mint** | This snapshot **freshly minted** HV — screen-level wall, structural page-level wall, or ambiguous obstruction | `page_level_hv_wall` / `unreadable_dominant_surface` | **COVERED** — `snapshotVisualJudgment(...)` runs at the mint decision before emit | **Yes** (when `ANTIGEN_VISUAL_JUDGMENT_ENABLED=true`) |

Notes:
- Sites **1–4 are the gap.** They emit a fully-formed 409 (often with a safe VGC view) but never touch the visual-judgment pipeline, so no `runtime-judgment-queue.jsonl` entry is appended.
- Site **5 is the only path that produces the `live_policy_shadow` queue events seen for hCaptcha / HubSpot.**

---

## The three `snapshotVisualJudgment(...)` call sites

`snapshotVisualJudgment` is defined at `agent-api.ts:6031` (a per-snapshot memoized wrapper around `evaluateVisualJudgment`, imported at `agent-api.ts:77`). It is called from exactly three places — **all inside the browser-snapshot endpoint, all upstream of the site-5 emit (`6843`)**:

| Call line | Mint case it gates | `triggerBasis` |
|-----------|--------------------|----------------|
| `agent-api.ts:6078` | Screen-level visible "Press & Hold" wall (`screenHvWallCandidate`) | `"page_level_hv_wall"` |
| `agent-api.ts:6249` | Structural page-level wall (`structuralIsPageLevel = !hvMember && !!pageWall`) | `"page_level_hv_wall"` |
| `agent-api.ts:6386` | Ambiguous visual obstruction fallback (`ambiguousProbe` non-null) | `"unreadable_dominant_surface"` |

A high-confidence benign verdict (and only when **not** dry-run) sets `suppress: true` and the corresponding mint is skipped; everything else (`confident_human_needed`, `uncertain`, classifier-unavailable) returns `suppress: false` and the existing conservative mint/409 runs unchanged.

### Per-snapshot memoization (important for event counting)

`snapshotVisualJudgment` caches in `visualJudgmentCache` (`agent-api.ts:6030`): the **first** call within a snapshot runs `evaluateVisualJudgment` (and appends one queue event); later calls in the same snapshot return the cached result with **no second event**. So a single snapshot yields **at most one** queue event regardless of how many of the three call sites fire. This is intra-snapshot only — a *new* snapshot that reaches a mint decision appends a *new* event.

### Always-append + flag gating (in `visualJudgment.ts`)

- `evaluateVisualJudgment` returns early `{ ran:false, suppress:false }` — byte-identical, no capture/sidecar/queue — when `ANTIGEN_VISUAL_JUDGMENT_ENABLED !== "true"` (`isVisualJudgmentEnabled`).
- When enabled, it **always** appends a review event (`appendVisualJudgmentReviewEvent`, ~`visualJudgment.ts:489`), **including** sidecar-down / frame-capture failure (the event is still written with null model fields). There is no "ran the classifier but skipped the append" path other than the flag being off.
- `ANTIGEN_VISUAL_JUDGMENT_DRY_RUN === "true"` runs the classifier and queues the decision but **never suppresses** (safe rollout step).
- The `live_policy_shadow` block in each event records what the live policy *would* decide, with `live_policy_enabled: false` / `domain_allowed: false` hardcoded — shadow-only, never acted on this slice.
- Queue file: `dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl` (override via `ANTIGEN_VISUAL_JUDGMENT_QUEUE`).

---

## The `hvMember` (per-element relay) carve-out

In the snapshot endpoint, a per-element HV control with a real DOM control box is found as `hvMember` (`agent-api.ts:6049`). The judgment call sites are gated on `!hvMember` by design (`6071`, `6243`), and the `hvMember`-only branch (`else if (hvMember || pageWall)` at `6262`) sets `snapshotMintedHv` **only** when `isPageLevel` (i.e. `!hvMember && pageWall`). So a pure `hvMember`:

- keeps its **DOM live-relay** path,
- returns **200** with `hvSnapshotInfo` (not a 409),
- runs **no** visual judgment and appends **no** queue event.

This is consistent and expected — it is only relevant to the etsy/example.com question if a *subsequent action* then trips the cached-marker guard (site 2) and emits the event-less 409 there.

---

## Why Etsy and example.com returned HV with no fresh queue event

Because site 5 (snapshot mint) **always** calls `snapshotVisualJudgment(...)` before emitting, an event-less 409 **cannot** have come from the snapshot mint path. It must have come from sites 1–4. Ranked hypotheses:

- **H1 (primary) — reuse guards (sites 1/2).** The original HV detection happened on an earlier snapshot (the "old events, shadow none" entries predate the shadow telemetry code). Every subsequent action then re-emits 409 via the **active-VGC-capsule guard (724)** or the **cached-HV-marker guard (785)**, neither of which re-runs judgment. Result: repeated 409s, zero new queue events.
- **H2 — no-progress backstops (sites 3/4).** An action made no progress and the live CDP probe minted HV/VGC structurally or ambiguously (`974` / `1052`). These paths have **no** judgment wiring at all, so they never append an event.
- **H3 (less likely) — `hvMember` relay.** Detected as a per-element control → judgment skipped by design and the snapshot returns 200; only produces a 409 indirectly if a later action trips site 2.
- **H4 (ruled out) — classifier ran but append failed.** Rejected: the append is best-effort-always (even on sidecar/frame failure it still writes), and the hCaptcha/HubSpot events prove the flag and build were live during QA. An event-less stop is not consistent with "judgment ran."

**Bottom line:** the Etsy/example.com gap is a **telemetry-coverage gap across HV emit sites**, not a live-policy regression and not a broken classifier.

---

## How to reproduce / attribute which path fired

- **Distinguish snapshot-mint vs. guard reuse:** call `antigen_snapshot` directly against the page. If it mints fresh HV, the snapshot path (site 5) runs and a queue event should appear. If instead an *action* (click/type/set-value) returns the 409, it is a guard/backstop path (sites 1–4) and no event is expected.
- **Inspect the queue file:** `dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl` — count events before/after; a per-domain `origin_host` + `created_at` delta tells you whether judgment ran.
- **`ANTIGEN_HV_DEBUG` attribution:** the 409 responses carry `hv_debug` / `snapshotHvDebug` with `scope` and `reason`. Discriminating values:
  - `scope: "hv_active_guard"`, `reason: "reused_existing_capsule"` → site 1 (no event expected).
  - `rejectIfHumanVerificationActive` cached-marker → site 2 (no event expected).
  - `scope: "no_progress_backstop"` (structural or ambiguous) → sites 3/4 (no event expected).
  - `scope: "snapshot_hv"` / `"snapshot_screen_hv"`, `returned_409: true` → site 5 (event expected; `reason: "visual_judgment_benign_suppressed"` means judgment ran and suppressed).
- **Confirm flags:** `ANTIGEN_VISUAL_JUDGMENT_ENABLED=true` (events only appear when on); `ANTIGEN_VISUAL_JUDGMENT_DRY_RUN=true` queues without suppressing.

---

## Recommended next implementation slice (NOT done here)

**Observability / attribution first — not live suppression.** The fix is to make every HV stop attributable, not to start suppressing on guard paths.

1. **Attribution markers on the reuse guards (sites 1/2):** emit a lightweight, behavior-neutral telemetry marker (e.g. `reused_existing` / `no_fresh_judgment`) so an event-less 409 is explicitly explained rather than looking like a missing/failed event. No HTTP-shape or policy change.
2. **Optional judgment-telemetry append on the no-progress backstops (sites 3/4):** consider wiring an activation-gated, shadow-only `evaluateVisualJudgment(...)` (or a minimal queue append) at the `974`/`1052` mint decisions so action-triggered HV also produces shadow telemetry — strictly dry-run/shadow, **no suppression**.
3. Only after attribution coverage is complete and the queue reflects all five sites should live-suppression behavior be reconsidered — and that remains gated behind `ANTIGEN_VISUAL_JUDGMENT_ENABLED` + removal of dry-run.

These are diagnostic recommendations only; no change is made in this memo.

---

## File / line index (approximate, for navigation)

- `agent-api.ts:556` — `sendHumanVerificationRequired` (canonical 409 emitter)
- `agent-api.ts:724` — site 1 emit (reused VGC capsule guard)
- `agent-api.ts:785` — site 2 emit (cached HV marker guard)
- `agent-api.ts:974` — site 3 emit (no-progress ambiguous backstop)
- `agent-api.ts:1052` — site 4 emit (no-progress structural backstop)
- `agent-api.ts:6031` — `snapshotVisualJudgment` definition (+ `visualJudgmentCache` at `6030`)
- `agent-api.ts:6078` / `6249` / `6386` — the three judgment call sites
- `agent-api.ts:6843` — site 5 emit (snapshot mint)
- `runtime/visualBlockerClassifier/visualJudgment.ts` — `evaluateVisualJudgment`, `appendVisualJudgmentReviewEvent`, flag getters, `live_policy_shadow`
