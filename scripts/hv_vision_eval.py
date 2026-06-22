#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — re-evaluate a saved model (optional).

SHADOW / OFFLINE / DEV-ONLY. Reloads a model trained by hv_vision_train.py,
re-derives the SAME deterministic split (same seed/test_size), and recomputes
eval metrics without retraining. This is the seam for later grayscale-only /
color-only / combined comparison runs.

Not wired to runtime. Detect-and-route only; never solve/bypass human
verification. Any future runtime use must be activation-gated.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_eval.py \\
      [--model ...] [--seed 42] [--test-size 0.25]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)
sys.path.insert(0, _SCRIPT_DIR)

from hv_vision_features import FeatureConfig, extract_features  # noqa: E402
from hv_vision_train import (  # noqa: E402
    DEFAULT_DATASET_ROOT,
    DEFAULT_INDEX,
    DEFAULT_OUT_DIR,
    DEFAULT_SEED,
    DEFAULT_TEST_SIZE,
    build_split,
    load_dataset,
    _counts,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="Antigen Visual Classifier v0 — eval saved model (shadow/dev-only).")
    ap.add_argument("--model", default=os.path.join(DEFAULT_OUT_DIR, "model.joblib"))
    ap.add_argument("--dataset-index", default=DEFAULT_INDEX)
    ap.add_argument("--dataset-root", default=DEFAULT_DATASET_ROOT)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--test-size", type=float, default=DEFAULT_TEST_SIZE)
    args = ap.parse_args()

    import joblib
    from sklearn.metrics import accuracy_score, classification_report

    artifact = joblib.load(args.model)
    clf = artifact["classifier"]
    scaler = artifact["scaler"]
    cfg = FeatureConfig.from_dict(artifact["feature_config"])

    rows, skips = load_dataset(args.dataset_index, args.dataset_root)
    _, eval_idx, forced_train = build_split(rows, args.test_size, args.seed)
    if not eval_idx:
        print("Empty eval set — nothing to evaluate.")
        return 0

    X = np.vstack([extract_features(rows[i].frame_path, cfg) for i in eval_idx])
    X = scaler.transform(X)
    y_true = [rows[i].label for i in eval_idx]
    y_pred = list(clf.predict(X))

    print("=== Antigen Visual Classifier v0 — EVAL (shadow/offline/dev-only) ===")
    print(f"model: {args.model}")
    print(f"feature_preset: {artifact.get('feature_preset')}  trained_at: {artifact.get('trained_at')}")
    print(f"eval examples: {len(eval_idx)}   eval class counts: {_counts(y_true)}")
    if forced_train:
        print(f"singleton classes excluded from eval: {forced_train}")
    print(f"\neval accuracy: {accuracy_score(y_true, y_pred):.4f}\n")
    print(classification_report(y_true, y_pred, zero_division=0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
