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

### Train from explicit manifests (deliberate split)

By default the trainer computes its own internal stratified split from
`dataset-index.csv`. To instead train/eval from **explicit, sampled manifests**
built by `hv_vision_build_manifests.py` (see "Build sampled train/eval manifests"
below), pass both manifests:

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_train.py \
  --train-manifest dev-artifacts/hv-vision-splits/train-manifest.csv \
  --eval-manifest  dev-artifacts/hv-vision-splits/eval-manifest.csv
```

In manifest mode the trainer:

- Uses the manifests **exactly** — it performs **no** internal `train_test_split`;
  the `split` column in each manifest is authoritative.
- Resolves each image from the manifest `frame_path` (dataset-root-relative) under
  `dev-artifacts/hv-vision-dataset/`.
- Takes the label from the manifest `effective_label` column.
- Writes the same artifacts (`model.joblib`, `label_map.json`, `metrics.json`) to
  `dev-artifacts/hv-vision-models/`.

`metrics.json` records which source was used so the two modes are never confused:

- internal split → `"training_data_source": "internal_split_dataset_index"`
- explicit manifests → `"training_data_source": "explicit_train_eval_manifests"`,
  plus `train_manifest` / `eval_manifest` paths, `train_rows` / `eval_rows` counts,
  and `label_source_counts` / `selection_reason_counts` (total + per split). The
  lowest-confidence examples also carry `event_id` and `selection_reason` when present.

Both `--train-manifest` and `--eval-manifest` must be provided together; passing
only one is a usage error.

> **Reviewed labels are a candidate pool, not the training set.** Training consumes
> only the explicit sampled manifests produced by `hv_vision_build_manifests.py` —
> never `reviewed-training-index.csv` directly, and never every new/reviewed capture
> automatically. This keeps the train/eval split deliberate and reproducible.

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

## Error report (high-consequence failure modes)

Turn `metrics.json` into a focused error report that surfaces the classifier's
dangerous failure modes — above all **false `page_level_hv_wall` predictions**
(the model claiming a benign page is a human-verification wall, which would
wrongly gate the agent):

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_error_report.py
```

Reads `dev-artifacts/hv-vision-models/metrics.json` and, optionally,
`dev-artifacts/hv-vision-splits/eval-manifest.csv` (joined on `capture_dir`) to
backfill `event_id` / `selection_reason` for examples that lack them. It sorts
the lowest-confidence examples into these categories:

1. **`dangerous_false_hv`** — true label is benign but predicted
   `page_level_hv_wall` (any false HV). This is split **by confidence** against
   `--hv-action-threshold` (default `0.85`):
   - **`false_hv_actionable`** — confidence `>=` the action threshold; at runtime
     this would wrongly route a benign page to a human (the real risk).
   - **`false_hv_low_confidence`** — below the action threshold (or unknown
     confidence). Useful model-debugging signal, but would **not** trigger
     runtime routing under the current threshold.
2. **`missed_hv`** — true label is `page_level_hv_wall` but predicted something
   else.
3. **`low_confidence_correct_hv`** — correct HV prediction below
   `--low-confidence-threshold` (default `0.80`).
4. **`high_confidence_wrong`** — any wrong prediction above
   `--high-confidence-threshold` (default `0.75`).

The summary reports `false_hv_any_count` (whole-eval total, from the **confusion
matrix**), `false_hv_actionable_count`, and `false_hv_low_confidence_count`;
`dangerous_false_hv_count` is retained as a backward-compat alias for the "any"
total. The actionable-vs-low-confidence split is computed over the per-example
lowest-confidence subset (the only place per-example confidence exists). The
**Recommended focus** only says "DANGEROUS" when there is at least one
*actionable* false HV — a low-confidence-only false positive is reported as a
model-improvement note, not a runtime risk. Writes
`dev-artifacts/hv-vision-reports/error-report.json` and `error-report.md`, prints
a summary, and exits.

Flags: `--metrics`, `--eval-manifest`, `--out-dir`, `--low-confidence-threshold`,
`--high-confidence-threshold`, `--hv-action-threshold` (default `0.85`),
`--hv-label`. **Stores no screenshot bytes** (only string `capture_dir` paths are
referenced) and changes **no** runtime behavior — it only reads the metrics
artifact and writes a report under the gitignored `dev-artifacts/`.

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

## Import runtime judgments (runtime QA → review pipeline)

Bridge runtime "visual judgment" dry-run QA events into the offline review pipeline
so they become human-reviewable captures. The runtime seam appends safe, redacted
events to `dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl`; this importer
copies each captured frame into the dataset and records it for review:

```bash
python3 scripts/hv_vision_import_runtime_judgments.py
```

(Stdlib-only — no venv required. Pass `--dry-run` to compute and print without
writing anything.)

For each runtime event it:

- Copies the frame to
  `dev-artifacts/hv-vision-dataset/<date>/<event_id>/frame.png` and writes a safe
  `meta.json` next to it (**safe metadata only — never screenshot bytes**: event_id,
  origin_host, activation_reason, trigger_basis, model prediction/confidence/top-3,
  outcome, runtime_action_taken_by_model, review_reason, label, human_label,
  review_status, `source: runtime_judgment_queue`).
- Upserts `dev-artifacts/hv-vision-reports/dataset-index.csv` (existing rows preserved
  unchanged). **The imported row's `label` is left EMPTY** — the model's prediction is
  recorded as context only and is **never** copied into `label`. Empty-label rows are
  skipped by both the trainer and the review-queue builder, so importing changes **no**
  training/manifest behavior; the label is filled only by a human reviewer.
- Merges `dev-artifacts/hv-vision-review/review-queue.jsonl` using the existing review
  event shape (`hv-vision-review/v0`), keyed by `event_id`, tagged
  `source: runtime_judgment_queue`. Existing rows (offline and prior runtime) are kept,
  and any human-entered `human_label` / `review_status` / `notes` are **preserved**.
- Writes `dev-artifacts/hv-vision-review/runtime-import-summary.json` (counts by
  predicted label / review reason / outcome, skip counts, and any events with an empty
  `origin_host` to inspect before labeling).

It is **idempotent** (deduplicates by `event_id` / `candidate_id`; reruns add no
duplicates), **never mutates** `runtime-judgment-queue.jsonl`, imports nothing from
`apps/`, and adds no dependencies. Skipped events: missing `event_id`, or a
`frame_path` that is null or does not resolve from the repo root. After importing, run
the review sheet below to label the new captures.

> **Re-run after a review-queue rebuild.** `hv_vision_review_queue.py` *rebuilds*
> `review-queue.jsonl` from `dataset-index.csv` and drops rows whose `label` is empty —
> which includes still-pending (un-labeled) runtime imports. If you run that builder,
> simply **re-run `hv_vision_import_runtime_judgments.py`** afterward to re-add the
> pending runtime review entries (already-reviewed runtime rows keep their human label).

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

## Build sampled train/eval manifests

Reviewed labels form a **candidate pool, not an automatic training set.** The
review queue accumulates continuously from the crawl stream, which is currently
dominated by false positives, cookie banners, and normal pages/modals, and which
over-represents whichever domains/classes arrived first. Training directly from
"whatever arrived" would inherit that bias. So: capture broadly, review
carefully, but **train from sampled, balanced manifests** that you build
deliberately and periodically — not on every new capture.

This script turns the reviewed-label pool
(`dev-artifacts/hv-vision-review/reviewed-training-index.csv`) into a
deterministic, reproducible train/eval split:

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_build_manifests.py
```

Writes `dev-artifacts/hv-vision-splits/train-manifest.csv`,
`dev-artifacts/hv-vision-splits/eval-manifest.csv` (columns: `split, capture_dir,
frame_path, origin_host, effective_label, label_source, review_status,
review_reason, event_id, selection_reason`), and
`dev-artifacts/hv-vision-splits/split-summary.json` (seed/params, per-label and
per-domain counts for total/train/eval, `train_only_labels_due_to_low_count`,
`capped_domains`, and `warnings`).

How the split is chosen (deterministic with `--seed`): rows are grouped by
`effective_label`; a per-domain cap (`--max-per-domain`, default 3) prevents any
one crawl domain from dominating a label; labels with enough rows hold out at
least `--min-eval-per-label` (default 1) eval examples (`--eval-ratio` default
0.25), preferring eval examples from domains **not** used in that label's train
set to reduce leakage; labels too small to split are train-only and listed in the
summary. No rows are duplicated/oversampled.

- **Default uses only `human_reviewed` labels.** Pass
  `--include-heuristic-unreviewed` **for experiments only** to also pull in
  pending `heuristic_unreviewed` rows.
- **Freeze the eval set** with `--freeze-existing-eval`: if an
  `eval-manifest.csv` already exists, its eval rows are preserved exactly (unless
  they disappeared from the reviewed index) and train is rebuilt around them; the
  summary reports `frozen_eval_preserved_count` / `frozen_eval_missing_count`.
- `--allow-small-label-leak` permits same-domain train/eval overlap when the pool
  is too small to separate domains.

> The current reviewed pool is tiny (~14 rows). The script still produces
> manifests, but the summary will warn that this is an **initial small split, not
> a statistically meaningful dataset** — expect train-only and eval-light labels.
> This script does NOT train and does NOT mutate the source dataset; it only
> reads the reviewed index and writes manifests under the gitignored
> `dev-artifacts/`. Flags: `--reviewed-index`, `--out-dir`, `--seed`,
> `--eval-ratio`, `--max-per-domain`, `--min-eval-per-label`,
> `--include-heuristic-unreviewed`, `--freeze-existing-eval`,
> `--allow-small-label-leak`.

## Regression guard (B&BW press-and-hold)

Guard against the specific regression that prompted the press-hold work: a centered
"Before we continue / Press & Hold" PerimeterX card over the bright B&BW "Semi-Annual
Sale" homepage hero being read as a benign `newsletter_modal` (model confidence ~0.43 →
`uncertain` → invisible dominant-surface block, no guided relay).

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_regression.py
```

Asserts the saved model classifies the known B&BW press-hold frames as
`page_level_hv_wall` (and never tops out at `newsletter_modal`). Run it after any
retrain. It is **shadow/offline/dev-only**, references frames by dataset-relative path
under the gitignored `dev-artifacts/hv-vision-dataset/`, and **self-skips (exit 0)** when
the model or the frames are absent (e.g. on CI / a fresh checkout) — raw pixels are never
committed. Add new confirmed press-hold capture dirs to `REGRESSION_CAPTURE_DIRS`.

> **Known gap (`missed_hv`).** The 64×64 grayscale features cannot read text, so a
> "white card over a page" is intrinsically ambiguous to the model. After the B&BW
> retrain, `page_level_hv_wall` recall on the held-out eval is ~0.44 — B&BW-style walls
> are learned, but several *other-domain* HV walls (etsy, sweetwater, chegg, …) are still
> confidently predicted `false_positive_normal_page`. The thumbnail-size experiment
> (64 → 96 → 128) showed **no recall improvement** and slightly lower accuracy (more
> feature dims, same tiny train set), so `DEFAULT_THUMB` stays 64. The real fix for
> `missed_hv` is more diverse HV-wall training data across domains — not bigger
> thumbnails. The runtime stays safe meanwhile: `uncertain` never mints a VGC, and the
> Dominant Surface Review catches ambiguous blocking surfaces.

## Files

| File | Role |
|---|---|
| `hv_vision_features.py` | Deterministic feature extractor (shared) |
| `hv_vision_train.py` | Train + report + save artifacts |
| `hv_vision_predict.py` | Single-frame prediction CLI |
| `hv_vision_eval.py` | Re-score a saved model (optional) |
| `hv_vision_error_report.py` | Focused error report over metrics.json: dangerous false HV predictions, missed walls, confident mistakes (offline/dev-only) |
| `hv_vision_compare_features.py` | Compare grayscale/color/combined presets → one report |
| `hv_vision_import_runtime_judgments.py` | Import runtime visual-judgment QA events into the offline review pipeline (offline/dev-only; empty labels, no auto-train, never mutates the runtime queue) |
| `hv_vision_review_queue.py` | Build/update the shadow human review queue (offline/dev-only) |
| `hv_vision_review_sheet.py` | Render the review queue as a static HTML contact sheet (offline/dev-only) |
| `hv_vision_export_reviewed_index.py` | Export reviewed human labels as a retraining overlay index (offline/dev-only; does not mutate the dataset) |
| `hv_vision_build_manifests.py` | Build deliberate, balanced train/eval manifests from the reviewed-label pool (offline/dev-only; does not train or mutate the dataset) |
| `hv_vision_regression.py` | B&BW press-hold regression guard: asserts known press-hold frames classify as `page_level_hv_wall` (never `newsletter_modal`); self-skips when model/frames absent (offline/dev-only) |
| `hv-vision-requirements.txt` | Pinned offline deps |
