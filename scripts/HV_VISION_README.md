# Antigen Visual Classifier v0 — Offline / Shadow-Mode Harness

**Status: SHADOW / OFFLINE / DEV-ONLY. Not wired into the Antigen runtime.**

This is a self-contained Python harness that trains and evaluates a small
page-state classifier on the redacted visual-blocker dataset
(`dev-artifacts/hv-vision-dataset/`). It exists to start measuring whether
visual judgment is feasible — it does **not** change any production behavior and
nothing under `apps/` imports it.

## Hard rules this harness obeys

1. **Shadow / offline / dev-only.** No runtime imports this code. No network.
   No model downloads. Artifacts stay under the gitignored `dev-artifacts/`.
2. **Activation-gated (for any future runtime use).** Antigen must **never**
   continuously watch or classify the agent's screen. A visual model may only
   ever run when existing suspicious-state logic fires: repeated no-progress,
   action failure, stale-ref loop, navigation timeout, possible human
   verification, protected boundary, or agent-requested help. No activation
   reason ⇒ no screenshot ⇒ no model call.
3. **Safety boundary — detect and route only.** The classifier predicts page
   *state* (normal page, normal modal, cookie banner, sign-in drawer, newsletter
   modal, page-level human-verification wall). It performs **no OCR** and must
   **never** solve, click, hold, type into, classify answers for, or bypass
   CAPTCHA / human verification.
4. **Lightweight deps only.** Pillow + numpy + scikit-learn. No
   torch/transformers/onnxruntime/opencv.

## Setup (one-time)

```bash
python3 -m venv dev-artifacts/hv-vision-venv
dev-artifacts/hv-vision-venv/bin/pip install -r scripts/hv-vision-requirements.txt
```

(`dev-artifacts/` is gitignored, so the venv and all generated artifacts are
never committed.)

## Train

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_train.py
```

Reads `dev-artifacts/hv-vision-reports/dataset-index.csv`, resolves each row to
`dev-artifacts/hv-vision-dataset/<capture_dir>/frame.png`, extracts features,
trains a logistic-regression classifier, prints a report, and writes:

- `dev-artifacts/hv-vision-models/model.joblib`
- `dev-artifacts/hv-vision-models/label_map.json`
- `dev-artifacts/hv-vision-models/metrics.json`

> The current dataset is ~38 frames with two singleton classes
> (`newsletter_modal`, `sign_in_drawer`). Singleton classes are forced into the
> training split and go unevaluated. **All metrics are directional, not
> conclusive**, at this size.

## Predict (single frame)

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_predict.py \
  dev-artifacts/hv-vision-dataset/<date>/<uuid>/frame.png
```

Outputs JSON: `predicted_label`, `confidence`, `top_3`, and `needs_human_review`
(true when confidence < `--review-threshold`, default 0.60).

## Eval (re-score saved model, optional)

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_eval.py
```

## Feature-group comparison

The extractor (`hv_vision_features.py`) is grayscale-first but keeps color, and
the groups are individually toggleable. You can compare a single preset at a
time via `hv_vision_train.py --features`:

```bash
... scripts/hv_vision_train.py --features grayscale_only
... scripts/hv_vision_train.py --features color_only
... scripts/hv_vision_train.py --features combined     # default
```

Or run all three at once with the comparison harness, which reuses the exact
same deterministic split / seed / classifier / test-size and writes a single
report:

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_compare_features.py
```

It prints a concise table (`preset | accuracy | page_level_hv_wall P/R/F1 |
notes`) and writes `dev-artifacts/hv-vision-models/feature-comparison.json`
(accuracy, per-label P/R/F1, confusion matrix, lowest-confidence examples, and
the singleton train-only labels for each preset). It does NOT overwrite
`model.joblib`.

Feature groups: grayscale layout (primary, weighted), edge/gradient per-tile
stats, coarse contrast/threshold structure, and secondary RGB histogram +
per-tile color means.

## Shadow review queue

Build a privacy-safe human review queue of page-state candidates (model prediction
+ page context, **never screenshot bytes**) from the current dataset + model:

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_review_queue.py
```

Writes `dev-artifacts/hv-vision-review/review-queue.jsonl` (one review event per
line) + a `review-queue-summary.json` with counts (total queued, by predicted
label, by review reason, by confidence bucket). Re-running is idempotent and
preserves any human-entered `human_label` / `review_status` / `notes`. Flags:
`--no-model`, `--csv`, `--include-all`, `--sample-baseline-every N`,
`--review-threshold`. This is page-state classification for human review/training
only — **not** CAPTCHA solving; Antigen detects and routes, it never solves or
bypasses human verification. Schema and review-reason semantics:
`docs/antigen-visual-judgment-review-queue.md`.

## Review sheet (visual contact sheet)

Render the review queue as a single static HTML contact sheet so a reviewer can
eyeball every captured frame next to its model prediction, heuristic label, and
human label — and hand-label quickly:

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_review_sheet.py
```

Writes `dev-artifacts/hv-vision-review/review-sheet.html`. It is offline / dev-only,
references the existing `frame.png` files by **relative path** (never embedded
base64 image bytes), and is **static** — it does not save edits; the label options
are shown as plain reference chips for manual labeling. Cards are sorted highest
priority first (`high_consequence_prediction` → `heuristic_model_disagreement` →
`low_confidence` → `new_domain` → `sampled_baseline`; within a reason, lower/null
confidence first), with summary counts (total, by review reason, by predicted
label, by review status) at the top. Flags: `--queue`, `--dataset-dir`, `--out`.

## Reviewed-label export (retraining overlay)

Turn the human review work into a clean, retraining-ready label index. For every
queue row that has been **reviewed** with a non-empty `human_label`, the human
label **overrides** the original/heuristic label (`label_source=human_reviewed`):

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_export_reviewed_index.py
```

By default this exports **reviewed-only** rows. Pass `--include-unreviewed-fallback`
to also emit the still-pending rows using their `heuristic_label`, marked
`label_source=heuristic_unreviewed`:

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_export_reviewed_index.py --include-unreviewed-fallback
```

Writes `dev-artifacts/hv-vision-review/reviewed-training-index.csv` (columns:
`capture_dir, frame_path, origin_host, effective_label, label_source,
heuristic_label, human_label, review_status, review_reason, model_predicted_label,
model_confidence, event_id`) and `dev-artifacts/hv-vision-review/reviewed-training-summary.json`
(row/label/source counts), and prints the same summary to stdout. Flags: `--queue`,
`--out-csv`, `--out-summary`, `--include-unreviewed-fallback`.

**This is an overlay / export for retraining and does NOT mutate the source
dataset** — `dev-artifacts/hv-vision-dataset/*/meta.json` files are never touched,
and no screenshot bytes are stored (frame paths are referenced as strings).

## Files

| File | Role |
|---|---|
| `hv_vision_features.py` | Deterministic feature extractor (shared) |
| `hv_vision_train.py` | Train + report + save artifacts |
| `hv_vision_predict.py` | Single-frame prediction CLI |
| `hv_vision_eval.py` | Re-score a saved model (optional) |
| `hv_vision_compare_features.py` | Compare grayscale/color/combined presets → one report |
| `hv_vision_review_queue.py` | Build/update the shadow human review queue (offline/dev-only) |
| `hv_vision_review_sheet.py` | Render the review queue as a static HTML contact sheet (offline/dev-only) |
| `hv_vision_export_reviewed_index.py` | Export reviewed human labels as a retraining overlay index (offline/dev-only; does not mutate the dataset) |
| `hv-vision-requirements.txt` | Pinned offline deps |
