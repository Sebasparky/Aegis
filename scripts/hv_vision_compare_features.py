#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — offline feature-preset comparison.

SHADOW / OFFLINE / DEV-ONLY. Runs the existing training/eval pipeline across the
three feature presets (grayscale_only, color_only, combined) using the SAME
deterministic split, seed, dataset, classifier, and test_size, then writes a
single comparison report. Trains nothing into the live model artifact and is NOT
wired into the Antigen runtime.

Any future runtime use of a model must remain activation-gated by existing
suspicious-state logic (repeated no-progress, action failure, stale-ref loop,
navigation timeout, possible human verification, protected boundary, or
agent-requested help) — never continuous screen watching. Detect-and-route only;
never solve/click/hold/OCR/bypass CAPTCHA or human verification.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_compare_features.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)
sys.path.insert(0, _SCRIPT_DIR)

from hv_vision_features import feature_groups_preset  # noqa: E402
from hv_vision_train import (  # noqa: E402
    DEFAULT_DATASET_ROOT,
    DEFAULT_INDEX,
    DEFAULT_OUT_DIR,
    DEFAULT_SEED,
    DEFAULT_TEST_SIZE,
    build_split,
    load_dataset,
    train_and_evaluate,
    _counts,
)

PRESETS = ["grayscale_only", "color_only", "combined"]
FOCUS_LABEL = "page_level_hv_wall"  # the human-verification class we care most about


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Antigen Visual Classifier v0 — compare feature presets (shadow/offline/dev-only)."
    )
    ap.add_argument("--dataset-index", default=DEFAULT_INDEX)
    ap.add_argument("--dataset-root", default=DEFAULT_DATASET_ROOT)
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    ap.add_argument("--classifier", choices=["logreg", "centroid"], default="logreg")
    ap.add_argument("--test-size", type=float, default=DEFAULT_TEST_SIZE)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--low-conf-n", type=int, default=5)
    args = ap.parse_args()

    import sklearn

    print("=== Antigen Visual Classifier v0 — FEATURE COMPARISON (shadow/offline/dev-only) ===")
    print("(not wired to runtime; any future runtime use must be activation-gated)\n")

    rows, skips = load_dataset(args.dataset_index, args.dataset_root)
    if not rows:
        print(f"ERROR: no usable rows loaded from {args.dataset_index}", file=sys.stderr)
        return 2

    all_labels = [r.label for r in rows]
    label_counts = _counts(all_labels)

    # One deterministic split, reused for every preset (same seed/test_size).
    train_idx, eval_idx, forced_train = build_split(rows, args.test_size, args.seed)

    print(f"Usable frames: {len(rows)}  (skipped: {skips})")
    print(f"Split (seed={args.seed}, test_size={args.test_size}, classifier={args.classifier}): "
          f"train={len(train_idx)} eval={len(eval_idx)}")
    if forced_train:
        print(f"Singleton classes forced into TRAIN (unevaluated): {forced_train}")
    print("(38-image dataset with tiny classes — comparison is DIRECTIONAL, not conclusive)\n")

    results = {}
    for preset in PRESETS:
        cfg = feature_groups_preset(preset)
        res = train_and_evaluate(
            rows, train_idx, eval_idx, cfg, args.classifier, all_labels, args.low_conf_n
        )
        focus = res["per_label"].get(FOCUS_LABEL, {})
        results[preset] = {
            "feature_config": cfg.to_dict(),
            "accuracy": res["accuracy"],
            "per_label": res["per_label"],
            "confusion_matrix": {"label_order": res["class_labels"], "matrix": res["confusion_matrix"]},
            "lowest_confidence_examples": res["lowest_confidence_examples"],
            "focus_label": FOCUS_LABEL,
            "focus_metrics": focus,
        }

    # ---- Concise table ----
    print(f"{'preset':16s} | {'acc':>6s} | {FOCUS_LABEL} P/R/F1            | notes")
    print("-" * 88)
    for preset in PRESETS:
        r = results[preset]
        acc = r["accuracy"]
        fm = r["focus_metrics"]
        prf = (
            f"{fm.get('precision', 0):.2f}/{fm.get('recall', 0):.2f}/{fm.get('f1', 0):.2f} "
            f"(n={fm.get('eval_support', 0)})"
            if fm
            else "n/a"
        )
        note = "best acc" if acc is not None and acc == max(
            (results[p]["accuracy"] or -1) for p in PRESETS
        ) else ""
        acc_s = f"{acc:.3f}" if acc is not None else "n/a"
        print(f"{preset:16s} | {acc_s:>6s} | {prf:28s} | {note}")
    print()

    # ---- Write report ----
    os.makedirs(args.out_dir, exist_ok=True)
    report = {
        "harness": "antigen-visual-classifier-v0-feature-comparison",
        "mode": "shadow_offline_dev_only",
        "runtime_wired": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sklearn_version": sklearn.__version__,
        "classifier": args.classifier,
        "seed": args.seed,
        "test_size": args.test_size,
        "dataset_skips": skips,
        "label_counts": label_counts,
        "split": {
            "train": len(train_idx),
            "eval": len(eval_idx),
            "forced_train_singleton_labels": forced_train,
            "train_class_counts": _counts([rows[i].label for i in train_idx]),
            "eval_class_counts": _counts([rows[i].label for i in eval_idx]),
        },
        "focus_label": FOCUS_LABEL,
        "presets": results,
        "caveat": "38-image dataset with tiny/singleton classes — comparison is directional only.",
    }
    out_path = os.path.join(args.out_dir, "feature-comparison.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"Wrote comparison report: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
