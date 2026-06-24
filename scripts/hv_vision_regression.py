#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — B&BW press-and-hold regression guard.

SHADOW / OFFLINE / DEV-ONLY. Asserts that the saved model classifies the known
Bath & Body Works PerimeterX "Before we continue / Press & Hold" human-verification
walls as ``page_level_hv_wall`` — and NOT as ``newsletter_modal`` — so the specific
regression that prompted this work (a centered press-hold card over the bright
"Semi-Annual Sale" homepage hero being read as a benign newsletter modal) cannot
silently come back after a retrain.

WHY THIS IS A SCRIPT, NOT A COMMITTED TEST FIXTURE
--------------------------------------------------
The regression frames are redacted screenshots that live ONLY under the gitignored
``dev-artifacts/hv-vision-dataset/`` tree. Raw pixels stay user/debug-only and are
NEVER committed. So this guard references the frames by dataset-relative path and
SELF-SKIPS (exit 0) when the model or the frames are absent — the same "self-skip
when the local artifact is missing" pattern the dev-only benchmark tests use. On a
dev box that has the dataset + a freshly trained ``model.joblib`` it runs for real.

It changes NO runtime behavior, performs NO OCR, and never solves/clicks/holds or
bypasses the challenge — it only scores already-captured frames offline.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_regression.py
  ... --model <path>   # default dev-artifacts/hv-vision-models/model.joblib
"""

from __future__ import annotations

import argparse
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)
sys.path.insert(0, _SCRIPT_DIR)

from hv_vision_predict import predict  # noqa: E402

DEFAULT_MODEL = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-models", "model.joblib")
DATASET_ROOT = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-dataset")

HV_LABEL = "page_level_hv_wall"
FORBIDDEN_TOP_LABEL = "newsletter_modal"

# Known B&BW press-and-hold HV walls (dataset-relative capture dirs). These are the
# exact frames that regressed to `newsletter_modal` (a centered press-hold card over
# the bright Semi-Annual homepage hero). Add new confirmed press-hold frames here.
REGRESSION_CAPTURE_DIRS = [
    "2026-06-24/a256bc31-d3ef-4f17-9986-33554a7af35a",  # the reported case (conf was 0.4323 newsletter_modal)
    "2026-06-24/42d01adc-a0fe-4ff5-ba15-a01a45d38215",
    "2026-06-24/73f9743b-7028-45d3-9e62-365d6ddd6d2b",
    "2026-06-24/d8dcfcac-06a7-4e9b-b741-0fcda03d6489",
]


def _frame_path(capture_dir: str) -> str:
    return os.path.join(DATASET_ROOT, capture_dir, "frame.png")


def main() -> int:
    ap = argparse.ArgumentParser(description="B&BW press-hold HV-wall regression guard (shadow/dev-only).")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--review-threshold", type=float, default=0.60)
    args = ap.parse_args()

    if not os.path.isfile(args.model):
        print(f"SKIP: model not found ({args.model}). Train it first; nothing to assert.")
        return 0

    present = [(cd, _frame_path(cd)) for cd in REGRESSION_CAPTURE_DIRS if os.path.isfile(_frame_path(cd))]
    missing = [cd for cd in REGRESSION_CAPTURE_DIRS if not os.path.isfile(_frame_path(cd))]
    if not present:
        print("SKIP: no regression frames on disk (dev-only dataset absent). Nothing to assert.")
        return 0

    failures = []
    print(f"B&BW press-hold HV-wall regression — model={os.path.relpath(args.model, _REPO_ROOT)}")
    for cd, fp in present:
        out = predict(fp, args.model, args.review_threshold)
        top = out["predicted_label"]
        probs = {t["label"]: (t["prob"] or 0.0) for t in out["top_3"]}
        hv_p = probs.get(HV_LABEL, 0.0)
        nl_p = probs.get(FORBIDDEN_TOP_LABEL, 0.0)
        ok = top == HV_LABEL and top != FORBIDDEN_TOP_LABEL and hv_p >= nl_p
        status = "OK  " if ok else "FAIL"
        print(f"  {status} {cd}  pred={top} conf={out['confidence']}  "
              f"hv={round(hv_p, 3)} newsletter={round(nl_p, 3)}")
        if not ok:
            failures.append(cd)

    if missing:
        print(f"  note: {len(missing)} listed frame(s) absent on this box (skipped).")

    if failures:
        print(f"\nFAILED: {len(failures)}/{len(present)} B&BW press-hold frame(s) NOT classified as "
              f"{HV_LABEL} (regressed). Re-check labels/retrain before shipping the model.")
        return 1
    print(f"\nPASS: all {len(present)} B&BW press-hold frame(s) classified as {HV_LABEL} "
          f"(never {FORBIDDEN_TOP_LABEL}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
