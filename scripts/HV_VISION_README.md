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
the groups are individually toggleable. Compare presets via `--features`:

```bash
... scripts/hv_vision_train.py --features grayscale_only
... scripts/hv_vision_train.py --features color_only
... scripts/hv_vision_train.py --features combined     # default
```

Feature groups: grayscale layout (primary, weighted), edge/gradient per-tile
stats, coarse contrast/threshold structure, and secondary RGB histogram +
per-tile color means.

## Files

| File | Role |
|---|---|
| `hv_vision_features.py` | Deterministic feature extractor (shared) |
| `hv_vision_train.py` | Train + report + save artifacts |
| `hv_vision_predict.py` | Single-frame prediction CLI |
| `hv_vision_eval.py` | Re-score a saved model (optional) |
| `hv-vision-requirements.txt` | Pinned offline deps |
