#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — offline training harness.

SHADOW / OFFLINE / DEV-ONLY. Reads the redacted dev-artifacts/hv-vision-dataset/
frames, extracts deterministic hand-crafted features (see hv_vision_features.py),
trains a small classifier (logistic regression by default), and writes a local
model artifact + metrics. NOTHING here is wired into the Antigen runtime.

Any FUTURE runtime use of a model trained here MUST remain activation-gated by
existing suspicious-state logic (repeated no-progress, action failure, stale-ref
loop, navigation timeout, possible human verification, protected boundary, or
agent-requested help). Antigen must never continuously watch/classify the screen,
and must never solve/click/hold/OCR/bypass CAPTCHA or human verification — it
detects page state and routes only.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_train.py
  ... --features {combined,grayscale_only,color_only} --classifier {logreg,centroid}
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from typing import Dict, List, Tuple

import numpy as np

# Resolve repo paths relative to this file so the scripts run from anywhere.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)
sys.path.insert(0, _SCRIPT_DIR)

from hv_vision_features import (  # noqa: E402
    FeatureConfig,
    extract_features,
    feature_groups_preset,
)

DEFAULT_INDEX = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-reports", "dataset-index.csv")
DEFAULT_DATASET_ROOT = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-dataset")
DEFAULT_OUT_DIR = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-models")
DEFAULT_SEED = 42
DEFAULT_TEST_SIZE = 0.25


class DatasetRow:
    __slots__ = (
        "capture_dir",
        "domain",
        "label",
        "trigger_basis",
        "frame_path",
        "event_id",
        "label_source",
        "selection_reason",
    )

    def __init__(
        self,
        capture_dir: str,
        domain: str,
        label: str,
        trigger_basis: str,
        frame_path: str,
        event_id: str = "",
        label_source: str = "",
        selection_reason: str = "",
    ):
        self.capture_dir = capture_dir
        self.domain = domain
        self.label = label
        self.trigger_basis = trigger_basis
        self.frame_path = frame_path
        # Manifest provenance (empty in dataset-index mode).
        self.event_id = event_id
        self.label_source = label_source
        self.selection_reason = selection_reason


def load_dataset(index_csv: str, dataset_root: str) -> Tuple[List[DatasetRow], Dict[str, int]]:
    """Parse the dataset index, keep only usable rows, resolve frame.png paths.

    Skips rows where frame_png != 'yes', label is empty, or the frame.png is
    missing on disk. Returns (rows, skip_counts)."""
    rows: List[DatasetRow] = []
    skips = {"no_frame_flag": 0, "no_label": 0, "missing_file": 0}

    with open(index_csv, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            label = (r.get("label") or "").strip()
            if (r.get("frame_png") or "").strip().lower() != "yes":
                skips["no_frame_flag"] += 1
                continue
            if not label:
                skips["no_label"] += 1
                continue
            capture_dir = (r.get("capture_dir") or "").strip()
            frame_path = os.path.join(dataset_root, capture_dir, "frame.png")
            if not os.path.isfile(frame_path):
                skips["missing_file"] += 1
                continue
            rows.append(
                DatasetRow(
                    capture_dir=capture_dir,
                    domain=(r.get("domain") or "").strip(),
                    label=label,
                    trigger_basis=(r.get("trigger_basis") or "").strip(),
                    frame_path=frame_path,
                )
            )
    return rows, skips


def load_manifest(manifest_csv: str, dataset_root: str) -> Tuple[List[DatasetRow], Dict[str, int]]:
    """Parse an explicit train/eval manifest produced by hv_vision_build_manifests.py.

    Manifest columns: split, capture_dir, frame_path, origin_host, effective_label,
    label_source, review_status, review_reason, event_id, selection_reason.

    The label comes from `effective_label`; the image resolves from `frame_path`
    (dataset-root-relative) under dataset_root. Rows with an empty label or a
    missing frame.png are skipped. Returns (rows, skip_counts). This NEVER mutates
    the manifest or any source dataset meta.json."""
    rows: List[DatasetRow] = []
    skips = {"no_label": 0, "missing_file": 0}

    with open(manifest_csv, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            label = (r.get("effective_label") or "").strip()
            if not label:
                skips["no_label"] += 1
                continue
            rel_frame = (r.get("frame_path") or "").strip()
            frame_path = os.path.join(dataset_root, rel_frame)
            if not os.path.isfile(frame_path):
                skips["missing_file"] += 1
                continue
            rows.append(
                DatasetRow(
                    capture_dir=(r.get("capture_dir") or "").strip(),
                    domain=(r.get("origin_host") or "").strip(),
                    label=label,
                    trigger_basis="",
                    frame_path=frame_path,
                    event_id=(r.get("event_id") or "").strip(),
                    label_source=(r.get("label_source") or "").strip(),
                    selection_reason=(r.get("selection_reason") or "").strip(),
                )
            )
    return rows, skips


def build_split(
    rows: List[DatasetRow], test_size: float, seed: int
) -> Tuple[List[int], List[int], List[str]]:
    """Deterministic train/eval split.

    Classes with only ONE labeled example cannot appear in both splits, so they
    are forced into TRAIN (and therefore go unevaluated). The remaining
    multi-instance classes are stratified-split with a fixed random_state.

    Returns (train_idx, eval_idx, forced_train_labels)."""
    from sklearn.model_selection import train_test_split

    labels = [r.label for r in rows]
    counts: Dict[str, int] = {}
    for lb in labels:
        counts[lb] = counts.get(lb, 0) + 1

    singleton_labels = sorted([lb for lb, c in counts.items() if c < 2])
    singleton_set = set(singleton_labels)

    multi_idx = [i for i, r in enumerate(rows) if r.label not in singleton_set]
    forced_train_idx = [i for i, r in enumerate(rows) if r.label in singleton_set]

    multi_labels = [rows[i].label for i in multi_idx]
    tr_idx, ev_idx = train_test_split(
        multi_idx,
        test_size=test_size,
        random_state=seed,
        stratify=multi_labels,
    )

    train_idx = sorted(forced_train_idx + list(tr_idx))
    eval_idx = sorted(list(ev_idx))
    return train_idx, eval_idx, singleton_labels


def _featurize(rows: List[DatasetRow], idxs: List[int], cfg: FeatureConfig) -> np.ndarray:
    return np.vstack([extract_features(rows[i].frame_path, cfg) for i in idxs])


def _counts(labels: List[str]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for lb in labels:
        out[lb] = out.get(lb, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


def train_and_evaluate(
    rows: List[DatasetRow],
    train_idx: List[int],
    eval_idx: List[int],
    cfg: FeatureConfig,
    classifier_name: str,
    all_labels: List[str] | None = None,
    low_conf_n: int = 5,
) -> Dict:
    """Featurize -> scale -> fit -> evaluate for one FeatureConfig.

    Pure compute, no printing or file I/O. Shared by main() and the offline
    feature-comparison harness so both follow one code path. Returns the fitted
    clf/scaler plus accuracy, confusion matrix, per-label P/R/F1, and the
    lowest-confidence eval examples."""
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import LogisticRegression
    from sklearn.neighbors import NearestCentroid
    from sklearn.metrics import (
        accuracy_score,
        confusion_matrix,
        precision_recall_fscore_support,
    )

    if all_labels is None:
        all_labels = [r.label for r in rows]

    X_train = _featurize(rows, train_idx, cfg)
    X_eval = _featurize(rows, eval_idx, cfg)
    y_train = [rows[i].label for i in train_idx]
    y_eval = [rows[i].label for i in eval_idx]

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_eval_s = scaler.transform(X_eval)

    if classifier_name == "logreg":
        clf = LogisticRegression(max_iter=2000, C=1.0)
    else:
        clf = NearestCentroid()
    clf.fit(X_train_s, y_train)

    # Label ordering for the model + confusion matrix (sorted, stable).
    class_labels = sorted(set(all_labels))
    label_map = {i: lb for i, lb in enumerate(class_labels)}

    y_pred = list(clf.predict(X_eval_s))
    acc = float(accuracy_score(y_eval, y_pred)) if eval_idx else None

    # Confidence per eval example (probabilities if available, else not reported).
    has_proba = hasattr(clf, "predict_proba")
    low_conf: List[Dict] = []
    if has_proba and eval_idx:
        proba = clf.predict_proba(X_eval_s)
        proba_classes = list(clf.classes_)
        conf = proba.max(axis=1)
        order = np.argsort(conf)  # ascending = least confident first
        for j in order[:low_conf_n]:
            row = rows[eval_idx[j]]
            top3_i = np.argsort(proba[j])[::-1][:3]
            ex = {
                "capture_dir": row.capture_dir,
                "domain": row.domain,
                "true_label": y_eval[j],
                "predicted_label": y_pred[j],
                "confidence": round(float(conf[j]), 4),
                "top_3": [
                    {"label": proba_classes[k], "prob": round(float(proba[j][k]), 4)}
                    for k in top3_i
                ],
            }
            # Manifest provenance, included only when available (kept absent in
            # dataset-index mode so that output is byte-identical to before).
            if row.event_id:
                ex["event_id"] = row.event_id
            if row.selection_reason:
                ex["selection_reason"] = row.selection_reason
            low_conf.append(ex)

    cm = confusion_matrix(y_eval, y_pred, labels=class_labels).tolist() if eval_idx else []
    prec, rec, f1, support = (
        precision_recall_fscore_support(y_eval, y_pred, labels=class_labels, zero_division=0)
        if eval_idx
        else ([], [], [], [])
    )
    per_label = {
        class_labels[i]: {
            "precision": round(float(prec[i]), 4),
            "recall": round(float(rec[i]), 4),
            "f1": round(float(f1[i]), 4),
            "eval_support": int(support[i]),
        }
        for i in range(len(class_labels))
    } if eval_idx else {}

    return {
        "clf": clf,
        "scaler": scaler,
        "class_labels": class_labels,
        "label_map": label_map,
        "y_pred": y_pred,
        "y_eval": y_eval,
        "accuracy": acc,
        "confusion_matrix": cm,
        "per_label": per_label,
        "lowest_confidence_examples": low_conf,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Antigen Visual Classifier v0 — offline trainer (shadow/dev-only).")
    ap.add_argument("--dataset-index", default=DEFAULT_INDEX)
    ap.add_argument("--dataset-root", default=DEFAULT_DATASET_ROOT)
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    ap.add_argument("--features", choices=["combined", "grayscale_only", "color_only"], default="combined")
    ap.add_argument("--classifier", choices=["logreg", "centroid"], default="logreg")
    ap.add_argument("--test-size", type=float, default=DEFAULT_TEST_SIZE)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--low-conf-n", type=int, default=5, help="How many lowest-confidence eval examples to report.")
    ap.add_argument(
        "--train-manifest",
        default=None,
        help="Explicit train manifest CSV (from hv_vision_build_manifests.py). "
        "When set together with --eval-manifest, trains/evals from the manifests "
        "exactly and performs NO internal train/eval split.",
    )
    ap.add_argument(
        "--eval-manifest",
        default=None,
        help="Explicit eval manifest CSV. Must be provided together with --train-manifest.",
    )
    args = ap.parse_args()

    # Manifest mode requires BOTH manifests; exactly-one is a usage error.
    if bool(args.train_manifest) != bool(args.eval_manifest):
        print(
            "ERROR: --train-manifest and --eval-manifest must be provided together.",
            file=sys.stderr,
        )
        return 2
    manifest_mode = bool(args.train_manifest) and bool(args.eval_manifest)

    import sklearn
    import joblib

    print("=== Antigen Visual Classifier v0 — OFFLINE / SHADOW / DEV-ONLY ===")
    print("(not wired to runtime; any future runtime use must be activation-gated)\n")

    cfg = feature_groups_preset(args.features)

    if manifest_mode:
        training_data_source = "explicit_train_eval_manifests"
        train_rows, train_skips = load_manifest(args.train_manifest, args.dataset_root)
        eval_rows, eval_skips = load_manifest(args.eval_manifest, args.dataset_root)
        rows = train_rows + eval_rows
        if not rows:
            print(
                f"ERROR: no usable rows loaded from manifests {args.train_manifest} / {args.eval_manifest}",
                file=sys.stderr,
            )
            return 2
        # The manifests ARE the split — no internal train_test_split.
        train_idx = list(range(len(train_rows)))
        eval_idx = list(range(len(train_rows), len(rows)))
        forced_train: List[str] = []
        # Merge skip counts (manifest skip keys differ from dataset-index ones).
        skips = {
            "train": train_skips,
            "eval": eval_skips,
        }
        all_labels = [r.label for r in rows]
        label_counts = _counts(all_labels)

        label_source_counts = _counts([r.label_source for r in rows if r.label_source])
        selection_reason_counts = _counts([r.selection_reason for r in rows if r.selection_reason])

        print("Training data source: explicit_train_eval_manifests")
        print(f"  train manifest: {args.train_manifest}")
        print(f"  eval  manifest: {args.eval_manifest}")
        print(f"Usable frames: {len(rows)}  (skipped: train={train_skips} eval={eval_skips})")
        print("Label counts:")
        for lb, c in label_counts.items():
            print(f"  {lb:30s} {c}")
        print()
        print(f"Split (from manifests, features={args.features}):")
        print(f"  train: {len(train_idx)}   eval: {len(eval_idx)}")
        print(f"  train class counts: {_counts([rows[i].label for i in train_idx])}")
        print(f"  eval  class counts: {_counts([rows[i].label for i in eval_idx])}")
        if label_source_counts:
            print(f"  label_source counts:    {label_source_counts}")
        if selection_reason_counts:
            print(f"  selection_reason counts: {selection_reason_counts}")
        print("  (small dataset — metrics are DIRECTIONAL, not conclusive)\n")
    else:
        training_data_source = "internal_split_dataset_index"
        rows, skips = load_dataset(args.dataset_index, args.dataset_root)
        if not rows:
            print(f"ERROR: no usable rows loaded from {args.dataset_index}", file=sys.stderr)
            return 2

        all_labels = [r.label for r in rows]
        label_counts = _counts(all_labels)
        label_source_counts = {}
        selection_reason_counts = {}
        print("Training data source: internal_split_dataset_index")
        print(f"Usable frames: {len(rows)}  (skipped: {skips})")
        print("Label counts:")
        for lb, c in label_counts.items():
            print(f"  {lb:30s} {c}")
        print()

        train_idx, eval_idx, forced_train = build_split(rows, args.test_size, args.seed)

        print(f"Split (seed={args.seed}, test_size={args.test_size}, features={args.features}):")
        print(f"  train: {len(train_idx)}   eval: {len(eval_idx)}")
        if forced_train:
            print(f"  NOTE: singleton classes forced into TRAIN (unevaluated): {forced_train}")
        print(f"  train class counts: {_counts([rows[i].label for i in train_idx])}")
        print(f"  eval  class counts: {_counts([rows[i].label for i in eval_idx])}")
        print("  (38-image dataset with tiny classes — metrics are DIRECTIONAL, not conclusive)\n")

    result = train_and_evaluate(
        rows, train_idx, eval_idx, cfg, args.classifier, all_labels, args.low_conf_n
    )
    clf = result["clf"]
    scaler = result["scaler"]
    class_labels = result["class_labels"]
    label_map = result["label_map"]
    acc = result["accuracy"]
    cm = result["confusion_matrix"]
    per_label = result["per_label"]
    low_conf = result["lowest_confidence_examples"]

    # ---- Report to stdout ----
    print(f"Classifier: {args.classifier}   sklearn={sklearn.__version__}")
    print(f"Eval accuracy: {acc if acc is not None else 'n/a (empty eval set)'}\n")

    if eval_idx:
        print("Confusion matrix (rows=true, cols=pred), label order:")
        print("  " + ", ".join(class_labels))
        for i, lb in enumerate(class_labels):
            print(f"  {lb:30s} {cm[i]}")
        print()

        print("Per-label precision / recall / f1 (eval support):")
        for lb, m in per_label.items():
            print(f"  {lb:30s} P={m['precision']:.3f} R={m['recall']:.3f} F1={m['f1']:.3f} (n={m['eval_support']})")
        print()

        if low_conf:
            print(f"Lowest-confidence eval examples (n={len(low_conf)}):")
            for ex in low_conf:
                print(f"  [{ex['confidence']:.3f}] true={ex['true_label']} pred={ex['predicted_label']} "
                      f"{ex['domain']} ({ex['capture_dir']})")
            print()

    # ---- Save artifacts ----
    os.makedirs(args.out_dir, exist_ok=True)
    trained_at = datetime.now(timezone.utc).isoformat()

    model_path = os.path.join(args.out_dir, "model.joblib")
    joblib.dump(
        {
            "classifier": clf,
            "scaler": scaler,
            "feature_config": cfg.to_dict(),
            "feature_preset": args.features,
            "label_map": label_map,
            "class_labels": class_labels,
            "sklearn_version": sklearn.__version__,
            "trained_at": trained_at,
            "training_data_source": training_data_source,
            "harness": "antigen-visual-classifier-v0 (shadow/offline/dev-only)",
        },
        model_path,
    )

    label_map_path = os.path.join(args.out_dir, "label_map.json")
    with open(label_map_path, "w") as f:
        json.dump({"label_map": label_map, "class_labels": class_labels}, f, indent=2)

    metrics = {
        "harness": "antigen-visual-classifier-v0",
        "mode": "shadow_offline_dev_only",
        "runtime_wired": False,
        "trained_at": trained_at,
        "sklearn_version": sklearn.__version__,
        "feature_preset": args.features,
        "feature_config": cfg.to_dict(),
        "classifier": args.classifier,
        "training_data_source": training_data_source,
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
        "eval_accuracy": acc,
        "confusion_matrix": {"label_order": class_labels, "matrix": cm},
        "per_label": per_label,
        "lowest_confidence_examples": low_conf,
        "caveat": (
            "Small dataset with tiny/singleton classes — metrics are directional only."
            if manifest_mode
            else "38-image dataset with tiny/singleton classes — metrics are directional only."
        ),
    }

    if manifest_mode:
        # Explicit-manifest provenance (omitted in dataset-index mode).
        metrics["train_manifest"] = args.train_manifest
        metrics["eval_manifest"] = args.eval_manifest
        metrics["train_rows"] = len(train_idx)
        metrics["eval_rows"] = len(eval_idx)
        if label_source_counts:
            metrics["label_source_counts"] = {
                "total": label_source_counts,
                "train": _counts([rows[i].label_source for i in train_idx if rows[i].label_source]),
                "eval": _counts([rows[i].label_source for i in eval_idx if rows[i].label_source]),
            }
        if selection_reason_counts:
            metrics["selection_reason_counts"] = {
                "total": selection_reason_counts,
                "train": _counts([rows[i].selection_reason for i in train_idx if rows[i].selection_reason]),
                "eval": _counts([rows[i].selection_reason for i in eval_idx if rows[i].selection_reason]),
            }

    metrics_path = os.path.join(args.out_dir, "metrics.json")
    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2)

    print("Saved artifacts:")
    print(f"  model:    {model_path}")
    print(f"  labels:   {label_map_path}")
    print(f"  metrics:  {metrics_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
