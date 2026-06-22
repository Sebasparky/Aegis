#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — reviewed-label retraining overlay export.

SHADOW / OFFLINE / DEV-ONLY. Turns the human review queue
(dev-artifacts/hv-vision-review/review-queue.jsonl) into a clean, retraining-ready
label index where a reviewer's human_label OVERRIDES the original/heuristic label
for rows that have been reviewed. This is an OVERLAY / EXPORT only — it NEVER
mutates the source dataset (dev-artifacts/hv-vision-dataset/*/meta.json stays
untouched). Output lands under the gitignored dev-artifacts/. NOTHING here is
wired into the Antigen runtime; nothing under apps/ imports it.

Hard rules this tool obeys (same as the rest of the harness):
  1. Offline / dev-only. No runtime imports, no new dependencies (stdlib only),
     no production behavior change.
  2. Non-destructive. Reads the review queue JSONL and writes a CSV + summary
     JSON. It does NOT open, read, or write the source dataset meta.json files,
     and it stores NO screenshot bytes (frame paths are referenced as strings).
  3. Detect-and-route only. This is a STATE classification label artifact. It
     must NEVER be used to solve, click, press, hold, type into, OCR, classify
     answers for, or bypass CAPTCHA / human verification.

Label-override rule:
  - review_status == "reviewed" AND non-empty human_label
        -> effective_label = human_label, label_source = "human_reviewed"
  - everything else is skipped by default. With --include-unreviewed-fallback,
    those rows are included using the heuristic_label, marked
    label_source = "heuristic_unreviewed".

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_export_reviewed_index.py
  ... --include-unreviewed-fallback   # also emit pending rows w/ heuristic label
  ... --queue <path>                  # override review-queue.jsonl location
  ... --out-csv <path>                # override reviewed-training-index.csv
  ... --out-summary <path>            # override reviewed-training-summary.json
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Resolve repo paths relative to this file so the script runs from anywhere.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)

DEFAULT_QUEUE = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-review", "review-queue.jsonl")
DEFAULT_OUT_CSV = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-review", "reviewed-training-index.csv")
DEFAULT_OUT_SUMMARY = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-review", "reviewed-training-summary.json")

# CSV columns, in fixed order.
CSV_COLUMNS = [
    "capture_dir",
    "frame_path",
    "origin_host",
    "effective_label",
    "label_source",
    "heuristic_label",
    "human_label",
    "review_status",
    "review_reason",
    "model_predicted_label",
    "model_confidence",
    "event_id",
]


def _clean(value: Any) -> str:
    """Coerce a queue field to a clean CSV string ('' for None/missing)."""
    if value is None:
        return ""
    return str(value)


def _nonempty(value: Any) -> bool:
    """True when a value is present and not just whitespace."""
    return value is not None and str(value).strip() != ""


def read_queue(path: str) -> List[Dict[str, Any]]:
    """Read review-queue.jsonl line by line (tolerating blank lines)."""
    events: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(
                    f"warning: skipping malformed JSON at {path}:{line_no}: {exc}",
                    file=sys.stderr,
                )
    return events


def build_rows(
    events: List[Dict[str, Any]],
    include_unreviewed_fallback: bool,
) -> Dict[str, Any]:
    """Compute exported rows + counters from the queue events."""
    rows: List[Dict[str, Any]] = []
    total_queue_events = len(events)
    reviewed_rows = 0
    pending_rows = 0
    skipped_unreviewed_rows = 0
    effective_label_counts: Counter = Counter()
    label_source_counts: Counter = Counter()

    for ev in events:
        review_status = ev.get("review_status")
        human_label = ev.get("human_label")
        heuristic_label = ev.get("heuristic_label")

        is_human_reviewed = review_status == "reviewed" and _nonempty(human_label)
        if review_status != "reviewed":
            pending_rows += 1

        if is_human_reviewed:
            effective_label = str(human_label).strip()
            label_source = "human_reviewed"
        else:
            # Not a human-reviewed export. Only included under the fallback flag.
            if not include_unreviewed_fallback:
                skipped_unreviewed_rows += 1
                continue
            effective_label = str(heuristic_label).strip() if _nonempty(heuristic_label) else ""
            label_source = "heuristic_unreviewed"

        row = {
            "capture_dir": _clean(ev.get("capture_dir")),
            "frame_path": _clean(ev.get("frame_path")),
            "origin_host": _clean(ev.get("origin_host")),
            "effective_label": effective_label,
            "label_source": label_source,
            "heuristic_label": _clean(heuristic_label),
            "human_label": _clean(human_label),
            "review_status": _clean(review_status),
            "review_reason": _clean(ev.get("review_reason")),
            "model_predicted_label": _clean(ev.get("model_predicted_label")),
            "model_confidence": _clean(ev.get("model_confidence")),
            "event_id": _clean(ev.get("event_id")),
        }
        rows.append(row)

        if label_source == "human_reviewed":
            reviewed_rows += 1
        effective_label_counts[effective_label or "(empty)"] += 1
        label_source_counts[label_source] += 1

    summary = {
        "total_queue_events": total_queue_events,
        "exported_rows": len(rows),
        "reviewed_rows": reviewed_rows,
        "pending_rows": pending_rows,
        "skipped_unreviewed_rows": skipped_unreviewed_rows,
        "include_unreviewed_fallback": include_unreviewed_fallback,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "effective_label_counts": dict(sorted(effective_label_counts.items())),
        "label_source_counts": dict(sorted(label_source_counts.items())),
    }
    return {"rows": rows, "summary": summary}


def write_csv(path: str, rows: List[Dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_summary(path: str, summary: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
        fh.write("\n")


def print_summary(summary: Dict[str, Any], out_csv: str, out_summary: str) -> None:
    print("HV vision reviewed-label export — overlay only (source dataset untouched)")
    print(f"  total_queue_events      : {summary['total_queue_events']}")
    print(f"  exported_rows           : {summary['exported_rows']}")
    print(f"  reviewed_rows           : {summary['reviewed_rows']}")
    print(f"  pending_rows            : {summary['pending_rows']}")
    print(f"  skipped_unreviewed_rows : {summary['skipped_unreviewed_rows']}")
    print(f"  include_unreviewed_fallback : {summary['include_unreviewed_fallback']}")
    print("  effective_label_counts:")
    for label, count in summary["effective_label_counts"].items():
        print(f"    {label}: {count}")
    print("  label_source_counts:")
    for source, count in summary["label_source_counts"].items():
        print(f"    {source}: {count}")
    print(f"  wrote CSV     : {out_csv}")
    print(f"  wrote summary : {out_summary}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Export the HV vision review queue as a retraining label overlay "
        "(human_label overrides heuristic label for reviewed rows). Does NOT mutate "
        "the source dataset.",
    )
    ap.add_argument("--queue", default=DEFAULT_QUEUE, help="review-queue.jsonl location")
    ap.add_argument("--out-csv", default=DEFAULT_OUT_CSV, help="reviewed-training-index.csv output")
    ap.add_argument(
        "--out-summary",
        default=DEFAULT_OUT_SUMMARY,
        help="reviewed-training-summary.json output",
    )
    ap.add_argument(
        "--include-unreviewed-fallback",
        action="store_true",
        help="also include unreviewed (pending) rows using heuristic_label, "
        "marked label_source=heuristic_unreviewed",
    )
    args = ap.parse_args()

    if not os.path.exists(args.queue):
        print(f"error: review queue not found: {args.queue}", file=sys.stderr)
        return 2

    events = read_queue(args.queue)
    built = build_rows(events, include_unreviewed_fallback=args.include_unreviewed_fallback)

    write_csv(args.out_csv, built["rows"])
    write_summary(args.out_summary, built["summary"])
    print_summary(built["summary"], args.out_csv, args.out_summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
