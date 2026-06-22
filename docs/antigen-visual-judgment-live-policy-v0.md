# Antigen Visual-Judgment Live Policy v0 — Design Memo

**Status:** Design-only. No runtime, code, config, package, or build change accompanies this memo.
This document proposes the first *narrow* live policy for activation-gated HV (human-verification)
visual judgment. The proposed live flag (`ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY`) and the proposed
pure policy-decision function do **not** exist yet — they are described here for review before any
implementation slice.

**Companion docs**

- `docs/antigen-visual-judgment-runtime-v0.md` — the implemented dry-run runtime this builds on
- `docs/antigen-vision-blocker-classifier.md` — foundational classifier direction
- `docs/visual-blocker-classifier-pipeline.md` — Phase 1–5 shadow pipeline architecture
- `docs/antigen-visual-judgment-review-queue.md` — offline review queue spec

**Standing principle (does not change):** Antigen detects and routes. It never solves, clicks,
presses, holds, types into, or otherwise bypasses any human-verification challenge. This live
policy only narrows *when a heuristic stop is suppressed* on a confidently-benign false positive.
It adds **zero** new interaction with any challenge. **Stop/routing remains the default failure
mode** at every decision point below.

---

## Why this exists

The offline/manual hard-negative loop is complete. The current threshold-aware error report at
`hv_action_threshold = 0.85` reads:

- `false_hv_any_count: 1`
- `false_hv_actionable_count: 0`
- `false_hv_low_confidence_count: 1` (doubleverify.com, ~0.516 confidence — below the action
  threshold; model-improvement signal only)
- `missed_hv_count: 0`

The visual judgment runtime v0 already scores frames and writes a review queue, but it is
**dry-run only** — it never changes behavior. Today, when the heuristic detector flags a possible
HV wall, Antigen stops and routes to user-presence handling even on a confident false positive
(e.g. a HubSpot marketing modal). The model now exists to recognize many of those false positives.

This memo defines the **smallest, safest** way to let the model *suppress a heuristic HV stop* —
and only that — inside the already activation-gated path, with stop/routing as the default and
conservative thresholds throughout.

---

## 1. Scope

This is **not** broad live classifier usage. The live policy is bounded by all of the following:

- **Activation-gated only.** Visual judgment runs *only* inside an already activation-gated snapshot
  HV path — i.e. when the heuristic detector has already decided to mint an HV stop in
  `snapshotVisualJudgment(triggerBasis)` (`apps/api/src/routes/agent-api.ts`, the memoized call
  used by the screen-level and structural page-level HV mint branches). Suppression can only happen
  inside that path. There is no other entry point.
- **No continuous watching.** No per-page-load classification, no background polling, no
  speculative scoring of normal pages.
- **No classifier call without an activation reason.** If the heuristic did not raise a possible-HV
  activation reason, the model is never invoked.
- **No challenge solving or interaction.** The policy may only *keep* or *suppress* a stop. It never
  clicks, presses, holds, types, or submits.
- **No page scraping / OCR solving.** The model receives a redacted frame for classification, not a
  text-extraction or challenge-solving pipeline.
- **No automatic use on normal pages.** Pages that never triggered the heuristic HV path are never
  affected by this policy.

---

## 2. Decision taxonomy

The live policy distinguishes exactly these decisions. Each maps to a concrete runtime effect.

| Decision | Meaning | Runtime effect |
|---|---|---|
| `heuristic_hv_stop` | The heuristic detector raised a possible-HV activation reason; this is the entry state for every case below. | Default: stop/route unless a later decision explicitly suppresses. |
| `visual_hv_confirmed` | Model agrees with the heuristic: `page_level_hv_wall` at `confidence ≥ hv_action_threshold`. | Keep the existing `HUMAN_VERIFICATION_REQUIRED` stop/routing; optionally annotate the reason as `visual_hv_confirmed`. No behavior change vs. heuristic. |
| `visual_benign_suppression_candidate` | Model confidently predicts a benign label at `confidence ≥ benign_suppression_threshold`, and no strong challenge-wall heuristic remains. | In the narrow experiment only: suppress the HV stop and return the normal snapshot. Record a structured suppression event. |
| `visual_uncertain` | Model is below both thresholds, or model and heuristic disagree in a way that does not meet the strict suppression rules. | Do **not** suppress. Keep the heuristic stop. Record `visual_uncertain`. |
| `visual_low_confidence_hv` | Model predicts `page_level_hv_wall` but `confidence < hv_action_threshold`. | Not used for routing. The low-confidence HV prediction never *causes* a stop and never *justifies* a suppression. Logged for model improvement only. |
| `visual_runtime_no_action` | Sidecar/model unavailable, frame capture failed, or flags disabled. | Fail safe to pure heuristic behavior. No suppression. |

Key invariant from this taxonomy: **a stop is never created by the model, and a stop is only ever
removed by `visual_benign_suppression_candidate`.** Every other decision leaves the heuristic stop
in place.

---

## 3. Threshold policy proposal

Framed against the current report's thresholds:

- **`hv_action_threshold` — default `0.85`.** Mirrors `--hv-action-threshold` in
  `scripts/hv_vision_error_report.py` and the existing `ANTIGEN_VISUAL_JUDGMENT_HV_THRESHOLD`. A
  `page_level_hv_wall` prediction at or above this is treated as confirmed HV; below it is
  low-confidence and non-actionable.
- **`benign_suppression_threshold` — proposed default `0.95`.** This is the minimum model
  confidence in a *benign* label required to suppress a heuristic HV stop in live mode. `0.90` is
  discussed only as a possible floor for later, more-reviewed stages — it is **not** the default.
  > **Note — deliberately stricter than dry-run.** The existing dry-run runtime uses
  > `ANTIGEN_VISUAL_JUDGMENT_BENIGN_THRESHOLD` defaulting to `0.80` for *scoring/labeling* the
  > review queue. Live *suppression* is a behavior change with real downside, so it must be more
  > conservative: the live policy proposes `0.95` and does **not** reuse the `0.80` dry-run value
  > for suppression. (Whether this becomes a new flag or a stricter constant is an implementation
  > detail for a later slice; it is not introduced by this memo.)
- **Uncertain band.** Anything below the action/suppression thresholds, or any model/heuristic
  disagreement that does not meet the strict suppression rules, lands in `visual_uncertain` and
  keeps the stop.
- **Hard rule.** Action is **never** taken from low-confidence HV predictions. A low-confidence
  `page_level_hv_wall` neither forces a stop nor authorizes a suppression.

Benign labels eligible for suppression (from the model vocabulary): `false_positive_normal_page`,
`false_positive_normal_modal`, `cookie_banner`, `newsletter_modal`, `sign_in_drawer`. The HV label
is `page_level_hv_wall`.

---

## 4. Live behavior v0

Given an activation-gated `heuristic_hv_stop`, exactly one branch applies:

1. **Heuristic HV + model strongly agrees** — `page_level_hv_wall` with
   `confidence ≥ hv_action_threshold`:
   - Keep the existing `HUMAN_VERIFICATION_REQUIRED` stop/routing exactly as today.
   - Optionally annotate the decision reason as `visual_hv_confirmed`.
   - No behavior change relative to heuristic-only.

2. **Heuristic HV + model strongly predicts benign** — a benign label with
   `confidence ≥ benign_suppression_threshold`, and no strong challenge-wall heuristic still
   asserting a wall:
   - In the narrow experiment **only**: suppress the HV stop and allow the normal snapshot to
     return (the same 200 the snapshot would have produced absent the heuristic mint).
   - Record a signed/structured suppression event (Section 6) marking that suppression happened,
     including the model label, confidence, and thresholds used.

3. **Model uncertain** — below thresholds or disagreement not meeting strict suppression rules:
   - Do **not** suppress. Keep the heuristic stop.
   - Record `visual_uncertain`.

4. **Model predicts HV below threshold** — `page_level_hv_wall` with
   `confidence < hv_action_threshold`:
   - Treat as `visual_low_confidence_hv`. Do not use for routing in either direction.
   - This is the doubleverify.com-style case: logged for model improvement, never actionable.

5. **Sidecar/model unavailable** — connection failure, timeout, malformed response, capture failure,
   or flags off:
   - Fail safe to heuristic behavior (`visual_runtime_no_action`). **No suppression.**

In all branches except (2), the existing stop/routing is preserved. **Stop/routing remains the
default failure mode.**

---

## 5. Safety rails

- **Separate live flag.** Live behavior is gated by a new, proposed
  **`ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY=true`** (proposed / not implemented). It is distinct from
  the dry-run flag.
- **Dry-run stays default true.** `ANTIGEN_VISUAL_JUDGMENT_DRY_RUN` remains default `true`. The live
  policy never silently turns dry-run off.
- **Both gates required.** Live suppression is active only if `ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY`
  **and** `ANTIGEN_VISUAL_JUDGMENT_ENABLED` are both `true`. Either off ⇒ heuristic behavior.
- **Domain allowlist / dev-only QA gate.** The initial experiment runs only against an explicit
  domain allowlist, or at minimum behind a dev-only QA flag. No suppression on un-allowlisted
  domains.
- **No production default.** None of the above defaults to on in any production configuration.
- **Sensitive surfaces are never affected.** Classifier suppression must never affect user secrets,
  credentials, payments, checkout, account changes, or approval-gated actions. Sensitive-action
  collars still win unconditionally; suppression of an HV *stop* never relaxes a sensitive-action
  gate or a collar.
- **Auditable telemetry.** Every visual suppression is logged as auditable runtime telemetry
  (Section 6).
- **Strong-wall guard.** Suppression must not happen if a challenge-like text/visual wall is
  strongly present by heuristic and the model is not highly confident benign. Strong heuristic wall
  evidence + anything short of high-confidence benign ⇒ keep the stop.
- **Default failure mode.** Stop/routing is the default outcome whenever any condition is unmet,
  ambiguous, or unavailable.

---

## 6. Event / telemetry requirements

Each live evaluation appends one safe event (proposed extension of the existing
`hv-vision-runtime-judgment/v0` shape — e.g. an added `policy_mode` field or a `…/v0-live`
schema; the exact schema change belongs to the implementation slice, not this memo). Fields:

- `event_id`
- `created_at`
- `browser_session_id`
- `origin_host` (hostname only)
- `activation_reason`
- `trigger_basis`
- `heuristic_label`
- `model_predicted_label`
- `model_confidence`
- `model_top_3`
- `hv_action_threshold`
- `benign_suppression_threshold`
- `policy_decision` (one of the Section 2 decisions)
- `runtime_action_taken_by_model` (suppression yes/no — Antigen never *interacts*; this records
  only whether a stop was suppressed)
- mode: `dry_run` / `live`
- `reason`
- `frame_path` (only when a dev artifact capture exists)

**Redaction (already enforced; unchanged):** no full URL/path/query, no selectors, no coordinates,
no raw text, and no screenshot bytes in the JSONL. `origin_host` is hostname-only; `frame_path` is a
relative dev-artifact path, never base64.

---

## 7. QA plan

- **Stage 0 — current.** Dry-run only. No behavior change. (Where we are today.)
- **Stage 1 — live-policy shadow report.** Run the live policy in report-only mode: compute the
  decision and emit telemetry, but do **not** suppress. Confirm the report matches expectations.
- **Stage 2 — live benign-suppression, dev/local only.** Enable suppression on dev/local only, for
  the known false-positive cases on the allowlist.
- **Stage 3 — expanded dev-domain set.** Widen the allowlist to more reviewed dev domains.
- **Stage 4 — gated.** Never proceed to broad production without a much larger, reviewed eval set.

**Concrete gates to advance between stages:**

- `false_hv_actionable_count = 0` at `hv_action_threshold`.
- `missed_hv_count = 0`.
- At least **N** reviewed benign suppressions with **no** observed bad suppression (N set per stage;
  larger for later stages).
- Manual review of **every** suppression event.
- Rollback switch verified — flipping `ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY` off provably restores
  pure heuristic behavior.

---

## 8. Initial candidate behavior

Using current examples:

- **HubSpot false-positive modal** — suppression candidate. A confident benign-modal prediction
  inside the activation-gated path is the target case for Stage 2 suppression.
- **hCaptcha normal page** — benign suppression candidate where the page is a normal page, not a
  live wall.
- **Etsy true HV wall** — must **not** be suppressed. A real `page_level_hv_wall` keeps the stop.
- **eBay false HV** — already fixed by hard negatives; should classify cleanly and not require
  suppression to behave correctly.
- **DoubleVerify** — remains a low-confidence false HV (~0.516, below `hv_action_threshold`). It must
  stay `visual_low_confidence_hv`: never actionable, model-improvement signal only.

---

## 9. Non-goals

- Not training a CNN yet.
- Not solving CAPTCHAs or any human-verification challenge.
- Not replacing heuristics — the policy layers on top of them and defaults to them.
- Not enabling broad classifier-based navigation.
- Not classifying all pages.
- Not auto-labeling training data.

---

## 10. Recommended next implementation slice

> The following describes the recommended next step **after** this memo is approved. It is **not**
> part of this docs-only change.

The smallest safe implementation is a **pure policy-decision function with unit tests only**:

- **Inputs:** the heuristic decision + the model output (`predicted_label`, `confidence`,
  `top_3`) + thresholds (`hv_action_threshold`, `benign_suppression_threshold`) + flags
  (`ANTIGEN_VISUAL_JUDGMENT_ENABLED`, `ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY`, dry-run, allowlist).
- **Outputs:** one of `allow_heuristic_stop`, `suppress_heuristic_stop`, `dry_run_only`, `no_action`.
- **Constraints:**
  - No API route changes.
  - No live behavior change.
  - No call site wiring until the pure policy tests pass.

This isolates the entire decision into a deterministic, fully-testable function before any live
behavior is wired into `snapshotVisualJudgment`. Suppression behavior is enabled only in a later,
separately-reviewed slice, behind both flags and the domain allowlist, with stop/routing remaining
the default failure mode throughout.
