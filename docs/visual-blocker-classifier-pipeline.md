# VisualBlockerClassifierPipeline — Design Memo

> **Status:** Design / architecture memo. **Not implementation work.**
> Companion to [`docs/antigen-vision-blocker-classifier.md`](./antigen-vision-blocker-classifier.md) (the north star). This memo specifies the *layer* that sits between the existing `SurfaceBoundaryRouter` and any VGC / credential / approval action.
> Do **not** modify runtime code, add dependencies, implement flags, implement screenshot/crop capture, or change VGC behavior based on this document. This is direction to return to deliberately.

## Why this memo exists

The live B&BW run proved exactly one thing: **`unreadable_dominant_surface` is a strong trigger for *visual classification*.** It did **not** prove we should mint a Visual Gesture Capsule (VGC) directly from the router.

The danger to avoid is collapsing the architecture:

```
WRONG:  surface_boundary_route_decided = visual_classifier_candidate  →  mint VGC
```

That conflates three distinct decisions. The correct separation:

- **SurfaceBoundaryRouter** decides *"this rendered browser state needs visual classification."* (Not "HV.")
- **VisualBlockerClassifierPipeline** decides *blocker / user-presence type.*
- **Policy** decides *VGC / credentials / approval / dismiss / wait / fail-closed.*

No layer skips ahead. The router must **never** directly mint a VGC.

## Where it sits

```
Stage 1  existing structural/geometry signals (unchanged, fast path)
Stage 2  SurfaceBoundaryRouter → route_decided = visual_classifier_candidate   (decides: NEEDS VISUAL CLASSIFICATION)
Stage 3  VisualBlockerClassifierPipeline                                        ← THE NEW LAYER
            ├─ build VisualClassifierCandidate
            ├─ capture / crop / redact → VisualClassifierInput
            ├─ classifier adapter → VisualClassifierResult (blocker_type + safe outputs)
            └─ dataset capture (dev-only, gated) — future
Stage 4  Policy engine maps VisualClassifierResult → PolicyDecision            (decides: VGC / credential / approval / dismiss / fail-closed)
Stage 5  Existing flows execute the PolicyDecision (VGC mint, credential, approval...)
```

### Current code reality (today)

- `SurfaceBoundaryRouter` already exists as **shadow telemetry only**: `apps/api/src/runtime/surfaceBoundary.ts` (`classifySurfaceBoundary`). It already computes `route_decided = "visual_classifier_candidate"` for two bases — `unreadable_dominant_surface` and `opaque_dominant_surface` — and is logged under `ANTIGEN_HV_DEBUG`. It gates nothing.
- The shadow decision is computed at `apps/api/src/routes/agent-api.ts` immediately after `classifySurfaceBoundary(surfaceSignals)` (the `snapshot_hv_gate` telemetry block). **That is the future call site** for the pipeline — a single, gated, shadow-only seam. (No edit is proposed here.)
- The VGC mint path (`rejectNoProgressActionAsHumanVerification`, `createVisualGestureCapsuleForOpaqueHv`) is reached through a *separate* structural/geometry path and must remain the only way a VGC is created.

**Recenter:** the proven shadow-telemetry milestone (router decision logging) should be committed on its own, *before* any pipeline work begins. Pipeline work starts as a separate branch/commit (Phase 1 below).

## Proposed interfaces (for a future Phase 1 — not implemented)

Booleans / enums / buckets / IDs only. No rects, coordinates, iframe `src`, raw text, base64, or selectors ever leave the module's safe views. Blocker enums are taken **verbatim** from the north-star memo.

```ts
export type BlockerType =
  | "normal_or_unblocked"
  | "non_hv_modal"
  | "cookie_banner"
  | "login_wall"
  | "marketing_modal"
  | "hv_full_page"
  | "hv_center_modal"
  | "hv_small_widget"
  | "hv_press_hold"
  | "hv_interaction_active"
  | "hv_cleared_or_settling"
  | "unknown_blocked";

export type ConfidenceBucket = "low" | "medium" | "high";

// Stage 2 → Stage 3 handoff
export interface VisualClassifierCandidate {
  candidate_id: string;
  browser_session_id: string;
  domain: string;
  page_url?: string;                       // same-origin display only; never to agent
  trigger_basis: "opaque_dominant_surface" | "unreadable_dominant_surface";
  candidate_reason: "opaque_iframe" | "unreadable_dominant_surface" | "visual_dom_mismatch";
  dominant_surface_kind:
    | "scrim_center_modal" | "top_layer_dialog" | "fixed_overlay" | "iframe" | "unknown";
  signals: {
    scrim_seen: boolean;
    centered_modal_seen: boolean;
    opaque_iframe_seen: boolean;
    visual_dom_contradiction_seen: boolean;
    dominant_text_uninspectable: boolean;
    pointer_interceptor_seen: boolean;
  };
  created_at: string;
}

// Stage 3 capture output — bytes are internal/memory-only, NEVER in a safe view
export interface VisualClassifierInput {
  candidate_id: string;
  region: "full_viewport" | "blocker_crop";   // crop preferred; full only as fallback
  png_base64: string;                          // redacted; never returned to agent/API
  viewport_css_width: number;
  viewport_css_height: number;
  redaction: VisualClassifierInputRedactionStatus;
  captured_at: string;
}

export interface VisualClassifierInputRedactionStatus {
  redacted_field_count: number;                // count only
  redaction_verified: boolean;                 // false ⇒ fail-closed, input discarded
  crop_applied: boolean;
  sensitive_fields_present: boolean;
}

// Stage 3 classifier output — north-star "safe outputs"
export interface VisualClassifierResult {
  candidate_id: string;
  blocker_type: BlockerType;
  confidence_bucket: ConfidenceBucket;
  user_presence_required: boolean;
  wall_visible: boolean;
  safe_to_resume: boolean;
  classifier_source: "shadow_stub" | "dev_heuristic" | "manual_qa" | "model";
  model_version?: string;                      // only when classifier_source === "model"
  classified_at: string;
}

// Stage 4 policy output
export type PolicyDecisionAction =
  | "route_to_user_presence_vgc"
  | "route_to_credential_flow"
  | "route_to_approval_flow"
  | "agent_may_handle"            // cookie / marketing, policy-permitting
  | "wait_and_recheck"            // hv_cleared_or_settling
  | "live_guidance_keep_holding"  // hv_interaction_active
  | "fail_closed_or_ask_user";    // unknown_blocked

export interface PolicyDecision {
  candidate_id: string;
  action: PolicyDecisionAction;
  enforced: boolean;              // v0/Phase 1: always false (shadow)
  basis_blocker_type: BlockerType;
  confidence_bucket: ConfidenceBucket;
  decided_at: string;
}

export interface DatasetCaptureDecision {
  capture: boolean;
  skip_reason?:
    | "flag_disabled" | "redaction_unverified" | "not_a_candidate"
    | "rate_limited" | "no_session";
}
```

## What the classifier returns before the CNN exists

**Recommended v0: a shadow-only stub returning `unknown_blocked`, paired with dataset capture.**

- `classifier_source: "shadow_stub"`, `blocker_type: "unknown_blocked"`, `confidence_bucket: "low"`, `user_presence_required: false`, `wall_visible: true`, `safe_to_resume: false`.
- It never asserts HV and never enforces. Its value is exercising the pipeline shape, emitting telemetry, and (later, when a dataset flag is on) writing redacted crops + safe metadata for offline labeling.
- A **dev heuristic** adapter and a **manual-QA label** tool are deferred and kept explicitly separate from any auto-label/training path, so we never train on the model's own guess.

This is the safest v0 because `unknown_blocked` + `low` maps to `fail_closed_or_ask_user`, and in shadow mode even that is `enforced: false` — the live VGC path is unchanged.

## Screenshot / crop capture (future — reuse, do not rebuild)

When Phase 2 implements capture, it must **reuse** the existing fail-closed redaction machinery, not add a second screenshot path:

- `captureRedactedScreenshot()` — `apps/api/src/runtime/screenshotRedaction.ts` — already runs `Page.captureScreenshot`, top-level remask, OPPWA iframe marking, and the `redactPngBoxes` pixel pass, and returns `redacted_field_count`.
- Crop preference: derive a `clip` around the dominant-surface box (the codebase currently never passes `clip`); the crop only **narrows** the already-redacted frame, never widens it. Fall back to `full_viewport` when geometry is unavailable. Note: headless `Page.captureScreenshot` is flaky on the current box — capture tests must self-skip without Chromium/CDP.
- Bytes are memory-only (like `visualGestureCapsuleScreenshotFrames` / `challengeCodes`), never persisted in prod, never logged, never in an agent/API response. Dataset records (dev-only) are gitignored. Safe metadata only — no base64, no rects.

## Dataset capture → future CNN training (future)

- Capture only on a real `VisualClassifierCandidate` (stuck/classifier-triggered events) — never random browsing — and only behind a dev/beta dataset flag.
- Per candidate: a redacted crop + a `meta.json` of safe metadata (trigger basis, DOM/geometry signals, stub prediction, confidence bucket, eventual outcome, manual label slot). `label` is null until a human sets it.
- **Never auto-train on the model's own guesses.** Distinguish *outcome labels* (strong, automatic: user completed VGC and page resumed ⇒ HV; agent dismissed and resumed ⇒ non-HV modal; agent accepted cookies ⇒ cookie banner) from *manual QA labels*. The stub prediction never becomes truth.
- Offline training lives outside the request path (a `tools/hv-vision/` dir, added later): trains a tiny classifier, evaluates on a **holdout**, **versions** the artifact, supports rollback. Beta capture requires opt-in and customer/org controls.

## Relationship to "agent stuck"

Stuck is **not** "repeated failures." The autonomy-boundary trigger set (from the north star):

| Trigger | Status |
|---|---|
| `unreadable_dominant_surface` | **proven today** — the first high-quality trigger |
| `opaque_dominant_surface` | already routes to `visual_classifier_candidate` |
| visual / DOM contradiction | already a router input |
| repeated equivalent action attempts | future |
| no semantic progress | future |
| pointer-interception clusters | future |
| repeated stale / no-progress fallback | exists, but `legacy_no_progress_fallback` basis only — never primary |

**Why `unreadable_dominant_surface` is the first high-quality trigger:** it is precisely the memo's motivating case — the rendered browser clearly shows a wall, but the DOM/snapshot path *cannot read it* (challenge text inside a cross-origin iframe / closed shadow / canvas). It requires scrim **and** centered surface **and** non-extractable text, so it is high precision and low false-positive — the cleanest first signal to feed a classifier and seed the dataset. Broader stuck heuristics are added later as *additional candidate sources*, each adding a new `trigger_basis` without changing the classifier or policy contracts.

## Future policy mapping (model classifies; policy governs)

| blocker_type | PolicyDecisionAction |
|---|---|
| `hv_full_page` / `hv_center_modal` / `hv_small_widget` / `hv_press_hold` | `route_to_user_presence_vgc` (existing VGC mint path) |
| `hv_interaction_active` | `live_guidance_keep_holding` (existing VGC hold/heartbeat UI) |
| `hv_cleared_or_settling` | `wait_and_recheck` (existing recheck/settle path) |
| `login_wall` | `route_to_credential_flow` (`request_secret_field_injection`) |
| payment / checkout boundary | `route_to_approval_flow` |
| `cookie_banner` / `marketing_modal` | `agent_may_handle` (policy-permitting) |
| `unknown_blocked` / low-confidence | `fail_closed_or_ask_user` |

Every action reuses an **existing** flow (VGC orchestrator, credential injection, approval inbox). The pipeline never invents a new action surface. In shadow phases, all decisions are `enforced: false`.

## Telemetry (future — safe booleans/enums/buckets only)

Emitted via existing `logHvActionDebug` / `recordBrowserTraceEvent` patterns, gated by `ANTIGEN_HV_DEBUG` (dataset events additionally gated by the dataset flag):

- `visual_classifier_candidate_created` — `{ candidate_id, trigger_basis, candidate_reason, dominant_surface_kind }`
- `visual_classifier_invoked` — `{ candidate_id, classifier_source, region }`
- `visual_classifier_result` — `{ candidate_id, blocker_type, confidence_bucket, user_presence_required, wall_visible, safe_to_resume, classifier_source, model_version? }`
- `visual_classifier_policy_decision` — `{ candidate_id, action, enforced, basis_blocker_type, confidence_bucket }`
- `visual_classifier_input_redaction_status` — `{ candidate_id, redacted_field_count, redaction_verified, crop_applied, sensitive_fields_present }`
- `vision_dataset_capture_written` — `{ candidate_id, region, redacted_field_count }`
- `vision_dataset_capture_skipped` — `{ candidate_id, skip_reason }`

No base64, rects, `src`, or raw text. Trace enums stay enum-gated (no free text into enums).

## Phased plan (each phase is a separate branch/commit)

- **Phase 0 (now):** this memo. Commit the **existing shadow-telemetry milestone separately, first.** No pipeline code.
- **Phase 1 — pipeline skeleton + shadow stub:** new `apps/api/src/runtime/visualBlockerClassifier/` module, `shadowStubAdapter` returning `unknown_blocked`, telemetry events, single gated shadow call site after `classifySurfaceBoundary`. `enforced: false` everywhere; byte-identical when off.
- **Phase 2 — dataset capture:** crop capture via reused redaction, gitignored writer, dataset flag, manual-label dev tool, outcome-label correlation.
- **Phase 3 — manual labels + holdout dataset** (north star Phase 2).
- **Phase 4 — tiny local model adapter** (north star Phase 3): `modelAdapter` behind its own flag, second-stage confirmation only, still mostly shadow.
- **Phase 5 — enforced policy, per action** (north star Phases 4–5): flip `enforced` per action, reusing existing VGC/credential/approval flows; live VGC user-presence feedback; controlled active learning.

## Flags (to be implemented in their phases, not now)

- `ANTIGEN_HV_VISION_CLASSIFIER` — enable the pipeline (shadow). Default off ⇒ byte-identical.
- `ANTIGEN_HV_VISION_DATASET` — enable dev-only redacted dataset capture + labeling tool. Default off.
- Later: per-phase enforcement flag(s) and a model-adapter flag. All registered in `getAntigenRuntimeStatus()` (`antigenRuntimeFlags.ts`).

## Manual hard-negative capture (dev/QA-only)

The activation-gated dataset/judgment seams only record a frame when the snapshot HV
gate fires. Benign pages that return a **normal** snapshot (ordinary e-commerce /
search pages) therefore never enter the review/training pipeline — which lets HV bias
grow and produces dangerous false-HV predictions on harmless pages. Manual capture
closes that gap by letting a QA operator **explicitly** collect such a page as a hard
negative, without faking an HV activation.

- **Flag:** `ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE` (default off ⇒ tool/endpoint
  unavailable and no-op, byte-identical). Registered in `getAntigenRuntimeStatus()`.
- **Surface:** the dev/QA MCP tool `antigen_capture_visual_review_candidate` (in
  `examples/antigen-browser-adapter.mjs`) → the flag-gated endpoint
  `POST /api/agent/v1/runtime/capture-visual-review-candidate`. Call it **only after a
  normal `antigen_snapshot`**, when you intentionally want to keep the current page as
  a hard negative. It is never automatic and never watches.
- **No classifier:** this path collects a redacted frame only; it never predicts a
  label (`model_*` are null/empty at capture) and never solves/inspects a challenge.
- **Write path (reuse, no duplication):** `manualVisualReviewCapture.ts` reuses
  `captureRedactedScreenshot`, writes `frame.png` under
  `dev-artifacts/hv-vision-runtime-frames/<date>/<event_id>/`, and appends **one** safe
  event (`source: "manual_visual_review_capture"`, `review_status: "pending"`, empty
  `label`/`human_label`) to `dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl`.
  It does **not** write `dataset-index.csv` or `review-queue.jsonl` directly.
- **Into the review sheet:** run the existing importer to fold the queue into the
  dataset index + review queue (dedup by `event_id`, human labels preserved):

  ```
  python3 scripts/hv_vision_import_runtime_judgments.py
  python3 scripts/hv_vision_review_sheet.py
  ```

  Suggested `capture_reason`: `ecommerce_search_hard_negative`. Later label in the
  review sheet as `false_positive_normal_page` / `false_positive_normal_modal` /
  `cookie_banner` / `sign_in_drawer` as appropriate, then export/build-manifests/train.
- **Training stays deliberate:** a manual capture only enters training after a human
  sets `human_label` + `review_status: reviewed` and it is selected through the manifest
  pipeline — the export step requires `review_status == "reviewed"` and a non-empty
  `human_label`.

## Risks / false-positive safeguards

- **Collapsing the architecture** (the named risk): router output is consumed read-only; the only path to a VGC stays the existing mint flow, reached only via an `enforced` policy decision in a later phase. Shadow phases cannot mint.
- **False HV:** v0 returns `unknown_blocked` and never enforces. The two trigger bases are already high-precision. Benign hero/marketing surfaces (e.g. `homepage-hero-no-scrim`) are exactly what the dataset will teach us to separate.
- **Secret leakage:** bytes memory-only and never in responses; reuse fail-closed `captureRedactedScreenshot`; dataset gitignored, dev-only, opt-in; crop only narrows the redacted frame.
- **Training on guesses:** `classifier_source` provenance + null-`label` discipline; outcome labels kept distinct from predictions.
- **Latency:** pipeline runs only on a `visual_classifier_candidate` (rare, already-stuck), never the hot path; capture reuses one CDP connection.

## Non-goals

- No CAPTCHA solving, no provider-specific bypass, no challenge coordinates or answers to the agent.
- No raw screenshots to agents; no base64/rects/src/raw-text in any response, log, or dataset metadata.
- No always-on visual monitoring — second look only when Stage 1/2 say blocked.
- No direct VGC mint from the router or classifier; policy governs, and only in later enforced phases.
- No model training in v0; no new runtime deps; no automatic/unreviewed online learning.
- Does not replace the rule-based baseline — a sharper second stage at the boundary.

## Tests (to add with their phases)

- `visual-blocker-classifier-pipeline.test.ts` — candidate built only for the two router bases; off-flag ⇒ never runs; stub returns `unknown_blocked`/`low`; `enforced` always false in shadow.
- `visual-blocker-classifier-policy.test.ts` — every `BlockerType` maps to the table above; `unknown_blocked` ⇒ `fail_closed_or_ask_user`.
- `visual-blocker-classifier-redaction.test.ts` — input discarded (`skip_reason: "redaction_unverified"`) on redaction mismatch; safe views expose no base64/rects; capture cases self-skip without Chromium/CDP.
- `visual-blocker-classifier-dataset.test.ts` — capture gated by flag; `skip_reason` enum coverage; meta never contains base64/rects/text; `label` null by default; stub predictions excluded from training reads.
- Reuse fixtures: `screen-hv-wall-over-product-page.html`, `homepage-hero-no-scrim.html`, `split-overlay-press-and-hold-shadow.html`.
