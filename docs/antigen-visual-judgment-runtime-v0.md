# Activation-Gated Visual Judgment v0 (runtime stuck-state handling)

**Status:** implemented, flag-gated, default OFF, dev-local. Wired only at the
snapshot human-verification (HV) gate. Companion to
`docs/antigen-visual-judgment-runtime-seam.md` (the type seam) and
`apps/api/src/runtime/visualBlockerClassifier/runtimeSeam.ts`.

## Why this exists

Antigen's heuristic HV detection at the snapshot gate over-fires on benign
surfaces (the documented marketing-hero / healthy-cart false positives). When it
fires, it mints a Visual Gesture Capsule (VGC) and returns a `409
HUMAN_VERIFICATION_REQUIRED`, which stalls a real login/purchase QA flow even
though no human verification is actually present.

This slice lets the existing visual classifier *help* those flows: when a wall is
already detected, ask the model whether the page is a real wall or a benign
surface, then either **continue past a confident false positive** or **confirm a
real wall and route to the existing human-takeover path**. Every decision is
logged for continued learning.

This is **not** model autonomy. See "Why this is not model autonomy" below.

## The activation-gated boundary

A screenshot is captured and the model is asked **only** from inside a snapshot
branch that has **already** detected an HV wall (the three mint sub-paths:
screen-level wall, structural page-level wall, ambiguous visual obstruction). The
capture + sidecar call are **memoized to at most once per snapshot**.

- No activation reason ⇒ no screenshot ⇒ no model call.
- No continuous watching, no per-page-load classification, no polling.
- With the flag OFF, `evaluateVisualJudgment` returns immediately with no capture,
  no sidecar call, and no queue write — behavior is byte-identical.

## Architecture — sidecar, not shell-out

The runtime must **not** shell out to or import the offline Python harness
(`scripts/hv_vision_*`). Instead it reaches inference through a dev-only
**localhost HTTP sidecar**:

```
runtime (agent-api snapshot gate)
  └─ evaluateVisualJudgment()                     apps/api/.../visualJudgment.ts
       ├─ captureRedactedScreenshot()  (reused fail-closed redaction primitive)
       ├─ write redacted frame.png      (gitignored dev-artifacts/hv-vision-runtime-frames/)
       └─ POST http://127.0.0.1:8782/predict {frame_path}
            └─ hv_vision_sidecar.py     (the sidecar MAY import the harness)
                 └─ hv_vision_predict.predict()  → model.joblib
```

- Start the sidecar: `npm run vision:judgment:sidecar` (uses the
  `dev-artifacts/hv-vision-venv` python).
- The sidecar binds loopback only, returns label/confidence/top_3/model_version,
  and **never** returns screenshot bytes.
- If the sidecar is down/slow/missing the model, the HTTP call fails (short
  timeout) and the runtime **fails soft to `uncertain`** — it never crashes or
  blocks, and it still queues a review event.

## Decision policy and thresholds

Labels come from the trained 6-class model. Benign labels (suppressible):
`false_positive_normal_page`, `false_positive_normal_modal`, `cookie_banner`,
`newsletter_modal`, `sign_in_drawer`. The single HV label is `page_level_hv_wall`.

| Model verdict | Outcome | Runtime effect |
|---|---|---|
| `page_level_hv_wall`, `confidence ≥ HV_THRESHOLD` (default **0.85**) | `confident_human_needed` | **No change** — existing mint/409 runs (model only confirms). Logged `high_consequence_prediction`. |
| benign label, `confidence ≥ BENIGN_THRESHOLD` (default **0.80**) | `confident_false_positive_or_benign` | **Suppress** the mint/409 (only when not dry-run) → snapshot returns its normal 200; flow continues. Logged `benign_suppression`. |
| anything else (incl. low-confidence HV, unknown label, sidecar unavailable) | `uncertain` | **No change** — existing conservative mint/409 runs. |

Only `confident_false_positive_or_benign` (and only when `DRY_RUN=false`) changes
behavior. `confident_human_needed` and `uncertain` both fall through to today's
exact conservative path.

### Why the HV threshold is conservative

The dangerous error is a **false benign → real wall** (the model calls a real wall
"cookie_banner", we suppress, and the user is silently stuck). So:

- Benign suppression requires **high** confidence on a benign label.
- The HV threshold is held conservative; a `page_level_hv_wall` prediction *below*
  the HV threshold does **not** suppress — it lands in `uncertain` and keeps the
  wall behavior.
- **Every** `page_level_hv_wall` prediction is logged to the review queue
  (`high_consequence_prediction`), so misses are inspectable.

## Why this is not model autonomy

- Antigen still only **detects and routes**. The model never clicks, presses,
  holds, drags, types into, OCRs, classifies the answer of, or bypasses any
  CAPTCHA / human-verification / 2FA / passkey check.
- The only behavior the model can produce is to **decline to escalate** a
  *heuristic* HV alarm that is itself frequently wrong. It cannot route *toward* a
  challenge or act against one.
- A confirmed wall (`confident_human_needed`) routes to the **existing**
  user-presence VGC / human-takeover path — the same path heuristics use today.
- `VisualJudgmentResult.advisoryOnly` is the literal `true`.

## Review queue (continued learning)

Every invocation appends one JSONL line to
`dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl` (override with
`ANTIGEN_VISUAL_JUDGMENT_QUEUE`). Schema `hv-vision-runtime-judgment/v0`:

```
schema_version, event_id, created_at, session_id, activation_reason,
trigger_basis, origin_host (hostname only),
frame_path (repo-root-relative, includes the dev-artifacts/ segment —
  e.g. dev-artifacts/hv-vision-runtime-frames/.../frame.png — never absolute, or null),
model_predicted_label, model_confidence, model_top_3,
outcome, runtime_action_taken_by_model, human_label (null),
review_status ("pending"), review_reason
```

Data safety: **no** screenshot bytes, **no** full URL/path/query, **no**
selectors, coordinates, raw page text, or iframe src. `origin_host` is a bare
hostname. The redacted frame lives only on disk under a gitignored dir; its
relative path is written to this dev-local queue (so suppressions/uncertain cases
stay reviewable) but is **never** emitted to a console log line or any API/agent
response.

The `[VisualJudgment]` debug log (gated by `ANTIGEN_HV_DEBUG`) prints
label/confidence/outcome and whether behavior changed — never the frame path.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `ANTIGEN_VISUAL_JUDGMENT_ENABLED` | `false` | Master gate. Off ⇒ byte-identical. |
| `ANTIGEN_VISUAL_JUDGMENT_DRY_RUN` | `false` | Log/queue decisions but never suppress. |
| `ANTIGEN_VISUAL_JUDGMENT_SIDECAR_URL` | `http://127.0.0.1:8782` | Runtime → sidecar base URL. |
| `ANTIGEN_VISUAL_JUDGMENT_QUEUE` | `dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl` | Review queue path. |
| `ANTIGEN_VISUAL_JUDGMENT_HV_THRESHOLD` | `0.85` | Min confidence for confident_human_needed. |
| `ANTIGEN_VISUAL_JUDGMENT_BENIGN_THRESHOLD` | `0.80` | Min confidence to suppress a benign verdict. |
| `ANTIGEN_VISUAL_JUDGMENT_MODEL_PATH` | trained `model.joblib` | Sidecar-side: model to load. |
| `ANTIGEN_VISUAL_JUDGMENT_PORT` | `8782` | Sidecar-side: loopback port. |

## Rollout

1. **Observe first:** run with `ENABLED=true DRY_RUN=true`. The queue fills with
   real decisions and behavior is unchanged. Inspect
   `runtime-judgment-queue.jsonl` (especially `benign_suppression` rows that
   *would* have suppressed, and all `high_consequence_prediction` rows).
2. **Enable suppression:** once the dry-run rows look safe, set `DRY_RUN=false`.
   Only high-confidence benign verdicts suppress; everything else stays
   conservative.
3. **Follow-up (not in v0):** the no-progress action backstop
   (`REALISTIC_CLICK_FAILED` etc.) is intentionally **not** wired yet — revisit
   after inspecting v0 runtime logs.

## Scope (v0)

- Wired **only** at the snapshot HV gate. No change to the no-progress action
  backstop, ref-stale loop, or `REALISTIC_*_FAILED` handling.
- No live UI in this slice — only an internal status shape
  (`getLastVisualJudgmentForSession`) is exposed for a later UI live-update layer.
- No training, manifest, or dataset-selection changes.
