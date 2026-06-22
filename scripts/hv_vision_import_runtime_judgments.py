#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — runtime judgment import/review bridge.

SHADOW / OFFLINE / DEV-ONLY. Bridges runtime "visual judgment" QA events into the
offline HV vision review pipeline so a human can review and label them, and so they
can later be DELIBERATELY selected into training manifests. NOTHING here is wired
into the Antigen runtime; this script imports nothing from apps/ and never touches
the live system. Output lands under the gitignored dev-artifacts/.

Why this exists: the activation-gated runtime visual-judgment seam appends safe,
redacted-frame events to dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl
during dry-run QA. Those events carry the model's live prediction and the activation
context, but they are not yet reviewable in the offline pipeline (review queue ->
review sheet -> reviewed export -> manifests -> train). This tool copies the captured
frames into the dataset, records them in the dataset index, and merges review-queue
entries so the existing hv_vision_review_sheet.py renders them.

Hard rules this tool obeys (same as the rest of the harness):
  1. Activation-gated upstream. This is a static importer over ALREADY-captured
     runtime candidates, never a watcher.
  2. Detect-and-route only. The queue records page-STATE classification for human
     review / training. It must NEVER be used to solve, click, press, hold, type
     into, OCR, classify answers for, or bypass CAPTCHA / human verification.
  3. No raw bytes / privacy. Paths and ids only (never screenshot bytes), domain is
     hostname-only, no URL path/query, no coordinates/selectors.
  4. No automatic labeling. Imported rows have an EMPTY label until a human sets it;
     the model's prediction is recorded as context only, never copied into `label`.
  5. No automatic training. Imported rows are not added to any training manifest.

Usage:
  python3 scripts/hv_vision_import_runtime_judgments.py
  ... --dry-run            # compute + print, write nothing
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from typing import Dict, List, Optional

# Resolve repo paths relative to this file so the script runs from anywhere.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)

DEFAULT_RUNTIME_QUEUE = os.path.join(
    _REPO_ROOT, "dev-artifacts", "hv-vision-review", "runtime-judgment-queue.jsonl"
)
DEFAULT_DATASET_ROOT = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-dataset")
DEFAULT_DATASET_INDEX = os.path.join(
    _REPO_ROOT, "dev-artifacts", "hv-vision-reports", "dataset-index.csv"
)
DEFAULT_REVIEW_QUEUE = os.path.join(
    _REPO_ROOT, "dev-artifacts", "hv-vision-review", "review-queue.jsonl"
)
DEFAULT_SUMMARY = os.path.join(
    _REPO_ROOT, "dev-artifacts", "hv-vision-review", "runtime-import-summary.json"
)

# The offline review queue's event shape/version (see hv_vision_review_queue.py).
REVIEW_SCHEMA_VERSION = "hv-vision-review/v0"
# Default source for runtime-judgment events. A per-event `source` (e.g. a manual
# hard-negative capture tagged "manual_visual_review_capture") is preserved when present.
SOURCE_TAG = "runtime_judgment_queue"

# Exact dataset-index.csv columns (must match hv_vision_train.load_dataset()).
DATASET_INDEX_COLS = [
    "capture_dir",
    "domain",
    "candidate_id",
    "label",
    "trigger_basis",
    "frame_png",
    "blocker_crop_png",
]

# Human-entered review fields preserved across re-runs (and review-queue rebuilds).
_PRESERVE_HUMAN_STATUSES = {"reviewed", "skipped"}


def _read_jsonl(path: str) -> List[Dict]:
    """Read a JSONL file into a list of dicts; tolerate blank/garbage lines."""
    out: List[Dict] = []
    if not os.path.isfile(path):
        return out
    with open(path, newline="") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _date_from_created_at(created_at: Optional[str]) -> str:
    """YYYY-MM-DD from an ISO `created_at`; fall back to today (UTC)."""
    if created_at and len(created_at) >= 10:
        candidate = created_at[:10]
        try:
            datetime.strptime(candidate, "%Y-%m-%d")
            return candidate
        except ValueError:
            pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _resolve_frame(frame_path: Optional[str]) -> Optional[str]:
    """Resolve a runtime frame_path from the repo root; None if unresolvable.

    Returns an absolute path to an existing file, or None when frame_path is
    missing/empty or the file does not exist (e.g. a malformed relative path that
    dropped the `dev-artifacts/` segment)."""
    if not frame_path:
        return None
    abs_path = frame_path if os.path.isabs(frame_path) else os.path.join(_REPO_ROOT, frame_path)
    return abs_path if os.path.isfile(abs_path) else None


def _normalize_top_3(model_top_3) -> List[Dict]:
    """Normalize runtime `{label, confidence}` entries to the offline `{label, prob}`
    shape used by the existing review queue / review sheet. Drops nothing else."""
    out: List[Dict] = []
    if not isinstance(model_top_3, list):
        return out
    for entry in model_top_3:
        if not isinstance(entry, dict):
            continue
        prob = entry.get("prob", entry.get("confidence"))
        out.append({"label": entry.get("label"), "prob": prob})
    return out


def _dedup_runtime_events(events: List[Dict]) -> List[Dict]:
    """Deduplicate by event_id (last occurrence wins); drop events with no id."""
    by_id: Dict[str, Dict] = {}
    for ev in events:
        eid = ev.get("event_id")
        if not eid:
            continue
        by_id[eid] = ev
    return list(by_id.values())


def _load_review_queue_by_id(path: str) -> Dict[str, Dict]:
    """Existing review-queue rows keyed by event_id (preserve human work)."""
    by_id: Dict[str, Dict] = {}
    for ev in _read_jsonl(path):
        eid = ev.get("event_id")
        if eid:
            by_id[eid] = ev
    return by_id


def _load_dataset_index(path: str) -> List[Dict]:
    """Existing dataset-index rows in original order (unchanged on pass-through)."""
    rows: List[Dict] = []
    if not os.path.isfile(path):
        return rows
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            rows.append({c: (r.get(c) or "") for c in DATASET_INDEX_COLS})
    return rows


def _counts(values) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for v in values:
        key = v if v not in (None, "") else "(none)"
        out[key] = out.get(key, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


def run_import(args) -> int:
    runtime_events = _dedup_runtime_events(_read_jsonl(args.runtime_queue))
    total_lines = len(_read_jsonl(args.runtime_queue))
    if not os.path.isfile(args.runtime_queue):
        print(f"ERROR: runtime queue not found: {args.runtime_queue}", file=sys.stderr)
        return 2

    existing_review = _load_review_queue_by_id(args.review_queue)
    dataset_rows = _load_dataset_index(args.dataset_index)
    dataset_by_candidate = {r["candidate_id"]: r for r in dataset_rows if r.get("candidate_id")}

    now = datetime.now(timezone.utc).isoformat()

    skipped_missing_frame: List[str] = []
    skipped_no_event_id = total_lines - len(runtime_events)
    empty_origin_host: List[str] = []
    newly_imported = 0
    updated_existing = 0
    # New review rows to merge in, keyed by event_id.
    new_review_rows: Dict[str, Dict] = {}

    for ev in runtime_events:
        event_id = ev.get("event_id")
        frame_abs = _resolve_frame(ev.get("frame_path"))
        if frame_abs is None:
            skipped_missing_frame.append(event_id)
            continue

        date = _date_from_created_at(ev.get("created_at"))
        capture_dir = f"{date}/{event_id}"
        origin_host = ev.get("origin_host") or ""
        if not origin_host:
            empty_origin_host.append(event_id)

        top_3 = _normalize_top_3(ev.get("model_top_3"))

        # Preserve any prior human review for this event (req: reviewed labels kept).
        prior = existing_review.get(event_id)
        prior_status = prior.get("review_status") if prior else None
        human_label = prior.get("human_label") if prior else None
        if prior_status in _PRESERVE_HUMAN_STATUSES:
            review_status = prior_status
            notes = prior.get("notes", "") if prior else ""
        else:
            review_status = "pending"
            notes = prior.get("notes", "") if prior else ""
        # Label is human-only: model predictions are NEVER copied into `label`.
        effective_label = human_label if (review_status == "reviewed" and human_label) else ""

        is_new = event_id not in dataset_by_candidate
        if is_new:
            newly_imported += 1
        else:
            updated_existing += 1

        # --- copy frame + write meta.json into the dataset ---
        dest_dir = os.path.join(args.dataset_root, date, event_id)
        meta = {
            "schema_version": "hv-vision-runtime-import/v0",
            "event_id": event_id,
            "origin_host": origin_host,
            "created_at": ev.get("created_at"),
            "activation_reason": ev.get("activation_reason"),
            "trigger_basis": ev.get("trigger_basis"),
            "model_predicted_label": ev.get("model_predicted_label"),
            "model_confidence": ev.get("model_confidence"),
            "model_top_3": top_3,
            "outcome": ev.get("outcome"),
            "runtime_action_taken_by_model": ev.get("runtime_action_taken_by_model"),
            "review_reason": ev.get("review_reason"),
            # capture_reason is carried for manual hard-negative captures (None otherwise).
            "capture_reason": ev.get("capture_reason"),
            "label": effective_label,
            "human_label": human_label,
            "review_status": review_status,
            "source": ev.get("source") or SOURCE_TAG,
            "imported_at": now,
        }
        if not args.dry_run:
            os.makedirs(dest_dir, exist_ok=True)
            shutil.copy2(frame_abs, os.path.join(dest_dir, "frame.png"))
            with open(os.path.join(dest_dir, "meta.json"), "w") as f:
                json.dump(meta, f, indent=2)

        # --- upsert dataset-index row (empty label unless human-reviewed) ---
        index_row = {
            "capture_dir": capture_dir,
            "domain": origin_host,
            "candidate_id": event_id,
            "label": effective_label,
            "trigger_basis": ev.get("trigger_basis") or "",
            "frame_png": "yes",
            "blocker_crop_png": "no",
        }
        if event_id in dataset_by_candidate:
            dataset_by_candidate[event_id].update(index_row)
        else:
            dataset_rows.append(index_row)
            dataset_by_candidate[event_id] = index_row

        # --- review-queue row (offline review event shape) ---
        new_review_rows[event_id] = {
            "schema_version": REVIEW_SCHEMA_VERSION,
            "event_id": event_id,
            "created_at": (prior.get("created_at") if prior else ev.get("created_at")) or now,
            "session_id": ev.get("session_id"),
            "activation_reason": ev.get("activation_reason"),
            "trigger_basis": ev.get("trigger_basis") or None,
            "origin_host": origin_host,
            "capture_dir": capture_dir,
            "frame_path": f"{capture_dir}/frame.png",
            "model_predicted_label": ev.get("model_predicted_label"),
            "model_confidence": ev.get("model_confidence"),
            "model_top_3": top_3,
            # No inferred heuristic label for runtime imports.
            "heuristic_label": None,
            "human_label": human_label,
            "review_status": review_status,
            "review_reason": ev.get("review_reason"),
            # Carried for manual hard-negative captures (None for runtime judgments).
            "capture_reason": ev.get("capture_reason"),
            "notes": notes,
            "source": ev.get("source") or SOURCE_TAG,
        }

    # Merge review queue: keep ALL existing rows, upsert the runtime rows.
    merged_review: Dict[str, Dict] = dict(existing_review)
    merged_review.update(new_review_rows)
    review_out_rows = list(merged_review.values())

    if not args.dry_run:
        os.makedirs(os.path.dirname(args.dataset_index), exist_ok=True)
        with open(args.dataset_index, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=DATASET_INDEX_COLS)
            w.writeheader()
            for r in dataset_rows:
                w.writerow({c: r.get(c, "") for c in DATASET_INDEX_COLS})

        os.makedirs(os.path.dirname(args.review_queue), exist_ok=True)
        with open(args.review_queue, "w") as f:
            for r in review_out_rows:
                f.write(json.dumps(r) + "\n")

    imported_events = [
        ev for ev in runtime_events if ev.get("event_id") not in skipped_missing_frame
    ]
    summary = {
        "harness": "antigen-visual-classifier-v0",
        "mode": "shadow_offline_dev_only",
        "runtime_wired": False,
        "generated_at": now,
        "dry_run": args.dry_run,
        "runtime_queue": args.runtime_queue,
        "total_runtime_lines": total_lines,
        "unique_event_ids": len(runtime_events),
        "imported": len(imported_events),
        "newly_imported": newly_imported,
        "updated_existing": updated_existing,
        "skipped_missing_frame": len(skipped_missing_frame),
        "skipped_missing_frame_event_ids": skipped_missing_frame,
        "skipped_no_event_id": skipped_no_event_id,
        "review_queue_total": len(review_out_rows),
        "by_model_predicted_label": _counts(
            ev.get("model_predicted_label") for ev in imported_events
        ),
        "by_review_reason": _counts(ev.get("review_reason") for ev in imported_events),
        "by_outcome": _counts(ev.get("outcome") for ev in imported_events),
        "runtime_action_taken_count": sum(
            1 for ev in imported_events if ev.get("runtime_action_taken_by_model")
        ),
        "empty_origin_host_event_ids": empty_origin_host,
    }
    if not args.dry_run:
        os.makedirs(os.path.dirname(args.summary), exist_ok=True)
        with open(args.summary, "w") as f:
            json.dump(summary, f, indent=2)

    _print_summary(summary, args)
    return 0


def _print_summary(summary: Dict, args) -> None:
    print("=== Antigen Visual Classifier v0 — runtime judgment import (OFFLINE / DEV-ONLY) ===")
    print("(not wired to runtime; page-state captures for human review only —")
    print(" Antigen detects and routes; it never solves/bypasses human verification)\n")
    if summary["dry_run"]:
        print("DRY RUN — no files written.\n")
    print(f"Runtime queue: {summary['runtime_queue']}")
    print(
        f"Lines: {summary['total_runtime_lines']}  unique event_ids: {summary['unique_event_ids']}"
    )
    print(
        f"Imported: {summary['imported']} "
        f"(new={summary['newly_imported']} updated={summary['updated_existing']})"
    )
    print(
        f"Skipped: missing_frame={summary['skipped_missing_frame']} "
        f"no_event_id={summary['skipped_no_event_id']}"
    )
    if summary["skipped_missing_frame_event_ids"]:
        print(f"  missing-frame event ids: {summary['skipped_missing_frame_event_ids']}")
    if summary["empty_origin_host_event_ids"]:
        print(
            "  NOTE: empty origin_host (inspect before labeling): "
            f"{summary['empty_origin_host_event_ids']}"
        )
    print("\nBy model predicted label:")
    for k, v in summary["by_model_predicted_label"].items():
        print(f"  {k:34s} {v}")
    print("\nBy review reason:")
    for k, v in summary["by_review_reason"].items():
        print(f"  {k:34s} {v}")
    print(f"\nReview queue total rows: {summary['review_queue_total']}")
    if not summary["dry_run"]:
        print("\nWrote:")
        print(f"  dataset captures: {args.dataset_root}/<date>/<event_id>/")
        print(f"  dataset index:    {args.dataset_index}")
        print(f"  review queue:     {args.review_queue}")
        print(f"  summary:          {args.summary}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Antigen Visual Classifier v0 — runtime judgment import bridge (offline/dev-only).",
    )
    ap.add_argument("--runtime-queue", default=DEFAULT_RUNTIME_QUEUE)
    ap.add_argument("--dataset-root", default=DEFAULT_DATASET_ROOT)
    ap.add_argument("--dataset-index", default=DEFAULT_DATASET_INDEX)
    ap.add_argument("--review-queue", default=DEFAULT_REVIEW_QUEUE)
    ap.add_argument("--summary", default=DEFAULT_SUMMARY)
    ap.add_argument(
        "--dry-run", action="store_true", help="Compute and print only; write nothing."
    )
    args = ap.parse_args()
    return run_import(args)


if __name__ == "__main__":
    raise SystemExit(main())
