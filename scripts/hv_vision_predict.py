#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — single-frame prediction CLI.

SHADOW / OFFLINE / DEV-ONLY. Loads a model trained by hv_vision_train.py and
predicts the page-state label for one frame.png. Output is ADVISORY only and is
NOT consumed by the Antigen runtime.

Any future runtime use of this prediction MUST remain activation-gated by
existing suspicious-state logic (repeated no-progress, action failure, stale-ref
loop, navigation timeout, possible human verification, protected boundary, or
agent-requested help) — never continuous screen watching. Antigen detects page
state and routes only; it must never solve/click/hold/OCR/bypass CAPTCHA or
human verification.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_predict.py <frame.png> \\
      [--model dev-artifacts/hv-vision-models/model.joblib] [--review-threshold 0.6]
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

DEFAULT_MODEL = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-models", "model.joblib")
DEFAULT_REVIEW_THRESHOLD = 0.60


def predict(frame_path: str, model_path: str, review_threshold: float) -> dict:
    import joblib

    if not os.path.isfile(frame_path):
        raise FileNotFoundError(f"frame not found: {frame_path}")
    if not os.path.isfile(model_path):
        raise FileNotFoundError(f"model not found: {model_path} (run hv_vision_train.py first)")

    artifact = joblib.load(model_path)
    clf = artifact["classifier"]
    scaler = artifact["scaler"]
    cfg = FeatureConfig.from_dict(artifact["feature_config"])

    x = extract_features(frame_path, cfg).reshape(1, -1)
    x = scaler.transform(x)

    classes = list(clf.classes_)
    if hasattr(clf, "predict_proba"):
        proba = clf.predict_proba(x)[0]
        order = np.argsort(proba)[::-1]
        predicted_label = classes[int(order[0])]
        confidence = round(float(proba[int(order[0])]), 4)
        top_3 = [
            {"label": classes[int(k)], "prob": round(float(proba[int(k)]), 4)}
            for k in order[:3]
        ]
    else:
        # NearestCentroid etc. — no probabilities; report label, confidence n/a.
        predicted_label = str(clf.predict(x)[0])
        confidence = None
        top_3 = [{"label": predicted_label, "prob": None}]

    needs_human_review = confidence is None or confidence < review_threshold

    return {
        "mode": "shadow_offline_dev_only",
        "runtime_wired": False,
        "frame": frame_path,
        "predicted_label": predicted_label,
        "confidence": confidence,
        "top_3": top_3,
        "review_threshold": review_threshold,
        "needs_human_review": needs_human_review,
        "advisory": "Page-state estimate only. Antigen detects and routes; it does not solve/bypass human verification.",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Antigen Visual Classifier v0 — predict (shadow/dev-only).")
    ap.add_argument("frame_png_path")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--review-threshold", type=float, default=DEFAULT_REVIEW_THRESHOLD)
    args = ap.parse_args()

    result = predict(args.frame_png_path, args.model, args.review_threshold)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
