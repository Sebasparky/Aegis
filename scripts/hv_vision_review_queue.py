#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — shadow review-queue builder.

SHADOW / OFFLINE / DEV-ONLY. Builds (or idempotently updates) a human review
queue of page-state classification candidates from the redacted dataset and the
current offline model. NOTHING here is wired into the Antigen runtime; nothing
under apps/ imports it. Output lands under the gitignored dev-artifacts/.

Why this exists: when the activation-gated "visual judgment" seam eventually runs
in shadow mode, Antigen needs a clean, privacy-safe place to set aside candidate
examples (model prediction + page context — never raw screenshot bytes) so a
human can review them and so the dataset can grow for future training. This script
seeds that artifact from the data we already have.

Hard rules this tool obeys (same as the rest of the harness):
  1. Activation-gated. No activation reason ⇒ no screenshot ⇒ no model call.
     Antigen never continuously watches or classifies the screen. This queue is a
     static artifact of ALREADY-captured candidates, not a watcher.
  2. Detect-and-route only. The queue records page-STATE classification for human
     review / training. It must NEVER be used to solve, click, press, hold, type
     into, OCR, classify answers for, or bypass CAPTCHA / human verification.
  3. No raw bytes / privacy. Paths and ids only (never screenshot bytes), domain
     is hostname-only, no URL path/query, no coordinates/selectors.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_review_queue.py
  ... --no-model            # seed without model predictions
  ... --csv                 # also write a flattened review-queue.csv
  ... --include-all         # queue every row (non-flagged => sampled_baseline)
  ... --sample-baseline-every 5
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np

# Resolve repo paths relative to this file so the script runs from anywhere.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)
sys.path.insert(0, _SCRIPT_DIR)

# Import-safe: both modules guard their main() with `if __name__ == "__main__"`.
from hv_vision_features import FeatureConfig, extract_features  # noqa: E402
from hv_vision_train import load_dataset  # noqa: E402

DEFAULT_INDEX = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-reports", "dataset-index.csv")
DEFAULT_DATASET_ROOT = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-dataset")
DEFAULT_MODEL = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-models", "model.joblib")
DEFAULT_OUT = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-review", "review-queue.jsonl")

DEFAULT_REVIEW_THRESHOLD = 0.60
DEFAULT_SAMPLE_EVERY = 5
SCHEMA_VERSION = "hv-vision-review/v0"

# Predicted labels that warrant review regardless of confidence: human-verification
# and other high-consequence page states. Routing only — never solving/bypassing.
HIGH_CONSEQUENCE_LABELS = {
    "page_level_hv_wall",
    "unreadable_hv_overlay",
    "browser_check_interstitial",
    "auth_wall",
}

# Fields a human may fill in by hand-editing the JSONL; preserved across re-runs.
_PRESERVE_HUMAN_STATUSES = {"reviewed", "skipped"}


def score_frame(frame_path: str, clf, scaler, cfg: FeatureConfig) -> Dict:
    """Mirror hv_vision_predict.predict()'s output shape for one frame.

    Returns {predicted_label, confidence, top_3}. Loading the model once and
    calling this in a loop avoids predict()'s per-call joblib.load."""
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
        predicted_label = str(clf.predict(x)[0])
        confidence = None
        top_3 = [{"label": predicted_label, "prob": None}]
    return {"predicted_label": predicted_label, "confidence": confidence, "top_3": top_3}


def pick_review_reason(
    predicted_label: Optional[str],
    confidence: Optional[float],
    heuristic_label: Optional[str],
    origin_host: str,
    known_hosts: set,
    threshold: float,
    is_baseline_sample: bool,
) -> Optional[str]:
    """Single primary review reason by priority (keeps the by-reason summary clean).

    Returns None when nothing fires and the row is not a baseline sample (caller
    decides whether to drop it)."""
    # 1. High-consequence prediction (human-verification / auth walls).
    if predicted_label in HIGH_CONSEQUENCE_LABELS:
        return "high_consequence_prediction"
    # Without a model, high-consequence can still be inferred from the reference label.
    if predicted_label is None and heuristic_label in HIGH_CONSEQUENCE_LABELS:
        return "high_consequence_prediction"
    # 2. Model disagrees with the reference/heuristic label.
    if predicted_label is not None and heuristic_label is not None and predicted_label != heuristic_label:
        return "heuristic_model_disagreement"
    # 3. Low / missing confidence.
    if predicted_label is not None and (confidence is None or confidence < threshold):
        return "low_confidence"
    # 4. First time we have seen this host.
    if origin_host and origin_host not in known_hosts:
        return "new_domain"
    # 5. Clean & confident & agreeing & known host -> baseline sample only.
    if is_baseline_sample:
        return "sampled_baseline"
    return None


def confidence_bucket(confidence: Optional[float]) -> str:
    if confidence is None:
        return "none"
    if confidence < 0.4:
        return "very_low"
    if confidence < 0.6:
        return "low"
    if confidence < 0.8:
        return "medium"
    return "high"


def load_existing(out_path: str) -> Dict[str, Dict]:
    """Load existing queue keyed by event_id so re-runs can preserve human work."""
    existing: Dict[str, Dict] = {}
    if not os.path.isfile(out_path):
        return existing
    with open(out_path, newline="") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            eid = ev.get("event_id")
            if eid:
                existing[eid] = ev
    return existing


def candidate_id_from_capture_dir(capture_dir: str) -> str:
    """capture_dir is `<YYYY-MM-DD>/<uuid>`; the uuid is the candidate id."""
    return os.path.basename(capture_dir.rstrip("/"))


def build_queue(args) -> int:
    rows, skips = load_dataset(args.dataset_index, args.dataset_root)
    if not rows:
        print(f"ERROR: no usable rows loaded from {args.dataset_index}", file=sys.stderr)
        return 2

    clf = scaler = cfg = None
    if not args.no_model:
        if not os.path.isfile(args.model):
            print(
                f"ERROR: model not found: {args.model}\n"
                f"Run scripts/hv_vision_train.py first, or pass --no-model to seed "
                f"without predictions.",
                file=sys.stderr,
            )
            return 2
        import joblib

        artifact = joblib.load(args.model)
        clf = artifact["classifier"]
        scaler = artifact["scaler"]
        cfg = FeatureConfig.from_dict(artifact["feature_config"])

    existing = load_existing(args.out)
    # Hosts already represented in a prior queue count as "known" for new_domain.
    known_hosts: set = {
        ev.get("origin_host") for ev in existing.values() if ev.get("origin_host")
    }

    now = datetime.now(timezone.utc).isoformat()
    events: List[Dict] = []

    for i, row in enumerate(rows):
        candidate_id = candidate_id_from_capture_dir(row.capture_dir)
        event_id = f"offline:{candidate_id}"

        if clf is not None:
            scored = score_frame(row.frame_path, clf, scaler, cfg)
            predicted_label = scored["predicted_label"]
            confidence = scored["confidence"]
            top_3 = scored["top_3"]
        else:
            predicted_label = None
            confidence = None
            top_3 = []

        heuristic_label = row.label or None
        origin_host = row.domain

        is_baseline_sample = args.include_all or (
            args.sample_baseline_every > 0 and (i % args.sample_baseline_every == 0)
        )
        reason = pick_review_reason(
            predicted_label,
            confidence,
            heuristic_label,
            origin_host,
            known_hosts,
            args.review_threshold,
            is_baseline_sample,
        )
        # Mark host seen AFTER reason selection so the first occurrence flags new_domain.
        if origin_host:
            known_hosts.add(origin_host)

        if reason is None:
            continue  # clean/confident/known and not sampled -> not queued

        prior = existing.get(event_id)
        event = {
            "schema_version": SCHEMA_VERSION,
            "event_id": event_id,
            "created_at": prior.get("created_at", now) if prior else now,
            "session_id": None,  # offline dataset examples have no live session
            "activation_reason": "offline_dataset_backfill",
            "trigger_basis": row.trigger_basis or None,
            "origin_host": origin_host,
            "capture_dir": row.capture_dir,
            "frame_path": os.path.join(row.capture_dir, "frame.png"),
            "model_predicted_label": predicted_label,
            "model_confidence": confidence,
            "model_top_3": top_3,
            "heuristic_label": heuristic_label,
            # Preserve any human-entered values across re-runs.
            "human_label": prior.get("human_label") if prior else None,
            "review_status": "pending",
            "review_reason": reason,
            "notes": prior.get("notes", "") if prior else "",
        }
        if prior:
            prior_status = prior.get("review_status")
            if prior_status in _PRESERVE_HUMAN_STATUSES:
                event["review_status"] = prior_status
        events.append(event)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")

    summary = summarize(events, rows, skips, args)
    summary_path = os.path.join(os.path.dirname(args.out), "review-queue-summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    if args.csv:
        csv_path = os.path.splitext(args.out)[0] + ".csv"
        write_csv(events, csv_path)

    print_summary(summary, args, summary_path)
    return 0


def summarize(events: List[Dict], rows, skips, args) -> Dict:
    by_predicted: Dict[str, int] = {}
    by_reason: Dict[str, int] = {}
    by_bucket: Dict[str, int] = {}
    for ev in events:
        pl = ev["model_predicted_label"] if ev["model_predicted_label"] is not None else "(no model)"
        by_predicted[pl] = by_predicted.get(pl, 0) + 1
        by_reason[ev["review_reason"]] = by_reason.get(ev["review_reason"], 0) + 1
        b = confidence_bucket(ev["model_confidence"])
        by_bucket[b] = by_bucket.get(b, 0) + 1
    return {
        "harness": "antigen-visual-classifier-v0",
        "mode": "shadow_offline_dev_only",
        "runtime_wired": False,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_used": (not args.no_model),
        "review_threshold": args.review_threshold,
        "sample_baseline_every": (0 if args.include_all else args.sample_baseline_every),
        "include_all": args.include_all,
        "dataset_rows_usable": len(rows),
        "dataset_skips": skips,
        "total_queued": len(events),
        "by_predicted_label": dict(sorted(by_predicted.items(), key=lambda kv: (-kv[1], kv[0]))),
        "by_review_reason": dict(sorted(by_reason.items(), key=lambda kv: (-kv[1], kv[0]))),
        "by_confidence_bucket": dict(sorted(by_bucket.items(), key=lambda kv: (-kv[1], kv[0]))),
    }


def write_csv(events: List[Dict], csv_path: str) -> None:
    """Flattened view; model_top_3 serialized as a compact `label:prob|...` string."""
    cols = [
        "schema_version", "event_id", "created_at", "session_id", "activation_reason",
        "trigger_basis", "origin_host", "capture_dir", "frame_path",
        "model_predicted_label", "model_confidence", "model_top_3",
        "heuristic_label", "human_label", "review_status", "review_reason", "notes",
    ]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for ev in events:
            top3 = "|".join(
                f"{t.get('label')}:{t.get('prob')}" for t in ev.get("model_top_3", [])
            )
            r = dict(ev)
            r["model_top_3"] = top3
            w.writerow({c: r.get(c) for c in cols})


def print_summary(summary: Dict, args, summary_path: str) -> None:
    print("=== Antigen Visual Classifier v0 — SHADOW review queue (OFFLINE / DEV-ONLY) ===")
    print("(not wired to runtime; page-state classification for human review only —")
    print(" Antigen detects and routes; it never solves/bypasses human verification)\n")
    print(f"Usable dataset rows: {summary['dataset_rows_usable']}  (skipped: {summary['dataset_skips']})")
    print(f"Model used: {summary['model_used']}   review_threshold={summary['review_threshold']}")
    print(f"Total queued: {summary['total_queued']}\n")
    print("By predicted label:")
    for k, v in summary["by_predicted_label"].items():
        print(f"  {k:30s} {v}")
    print("\nBy review reason:")
    for k, v in summary["by_review_reason"].items():
        print(f"  {k:30s} {v}")
    print("\nBy confidence bucket:")
    for k, v in summary["by_confidence_bucket"].items():
        print(f"  {k:30s} {v}")
    print("\nWrote:")
    print(f"  queue:    {args.out}")
    print(f"  summary:  {summary_path}")
    if args.csv:
        print(f"  csv:      {os.path.splitext(args.out)[0] + '.csv'}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Antigen Visual Classifier v0 — shadow review-queue builder (offline/dev-only).",
    )
    ap.add_argument("--dataset-index", default=DEFAULT_INDEX)
    ap.add_argument("--dataset-root", default=DEFAULT_DATASET_ROOT)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--review-threshold", type=float, default=DEFAULT_REVIEW_THRESHOLD)
    ap.add_argument(
        "--sample-baseline-every", type=int, default=DEFAULT_SAMPLE_EVERY,
        help="Queue 1-in-N clean/confident rows as sampled_baseline (0 disables).",
    )
    ap.add_argument(
        "--include-all", action="store_true",
        help="Queue every dataset row (non-flagged rows become sampled_baseline).",
    )
    ap.add_argument(
        "--no-model", action="store_true",
        help="Seed without model predictions (model fields null).",
    )
    ap.add_argument("--csv", action="store_true", help="Also write a flattened review-queue.csv.")
    args = ap.parse_args()
    return build_queue(args)


if __name__ == "__main__":
    raise SystemExit(main())
