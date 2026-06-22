#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — deliberate train/eval manifest builder.

SHADOW / OFFLINE / DEV-ONLY. Turns the curated reviewed-label POOL
(dev-artifacts/hv-vision-review/reviewed-training-index.csv, produced by
hv_vision_export_reviewed_index.py) into deliberate, reproducible train/eval
manifests. This is the SELECTION step that sits between the label pool and any
future training run.

Why this exists: reviewed labels accumulate continuously from the crawl stream,
which is currently dominated by false positives, cookie banners, and normal
pages/modals, and which over-represents whichever domains/classes arrived first.
If a trainer consumes every reviewed/new capture directly, the model inherits
that bias. So: capture broadly, review carefully, but TRAIN FROM SAMPLED,
BALANCED MANIFESTS. New captures never enter training automatically.

This script never trains, never reads screenshot bytes, and never mutates the
source dataset (dev-artifacts/hv-vision-dataset/*/meta.json stays untouched). It
only reads the reviewed-index CSV and writes manifest CSVs + a summary JSON under
the gitignored dev-artifacts/. NOTHING here is wired into the Antigen runtime;
nothing under apps/ imports it.

Hard rules this tool obeys (same as the rest of the harness):
  1. Offline / dev-only. No runtime imports, no new dependencies (stdlib only),
     no production behavior change.
  2. Non-destructive. Reads the reviewed-index CSV (and optionally the
     dataset-index CSV as a read-only reference) and writes manifest CSVs + a
     summary JSON. It stores NO screenshot bytes (frame paths are strings) and
     does NOT touch source dataset meta.json files.
  3. Detect-and-route only. These are page-STATE label manifests. They must
     NEVER be used to solve, click, press, hold, type into, OCR, classify
     answers for, or bypass CAPTCHA / human verification.

Design rules baked into the split:
  - Labels accumulate continuously; training data is selected deliberately.
  - Keep a frozen eval set conceptually separate from training
    (see --freeze-existing-eval).
  - Avoid over-representing first-arriving domains/classes (per-domain cap +
    label grouping).
  - Prefer label balance and minimize domain leakage between train and eval.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_build_manifests.py
  ... --include-heuristic-unreviewed   # EXPERIMENTS ONLY: also use pending rows
  ... --freeze-existing-eval           # preserve an existing eval-manifest.csv
  ... --eval-ratio 0.25 --max-per-domain 3 --min-eval-per-label 1 --seed 42
  ... --reviewed-index <path> --out-dir <dir>
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# Resolve repo paths relative to this file so the script runs from anywhere.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)

DEFAULT_REVIEWED_INDEX = os.path.join(
    _REPO_ROOT, "dev-artifacts", "hv-vision-review", "reviewed-training-index.csv"
)
DEFAULT_DATASET_INDEX = os.path.join(
    _REPO_ROOT, "dev-artifacts", "hv-vision-reports", "dataset-index.csv"
)
DEFAULT_OUT_DIR = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-splits")

TRAIN_MANIFEST_NAME = "train-manifest.csv"
EVAL_MANIFEST_NAME = "eval-manifest.csv"
SUMMARY_NAME = "split-summary.json"

# Manifest CSV columns, in fixed order.
MANIFEST_COLUMNS = [
    "split",
    "capture_dir",
    "frame_path",
    "origin_host",
    "effective_label",
    "label_source",
    "review_status",
    "review_reason",
    "event_id",
    "selection_reason",
]

LABEL_SOURCE_HUMAN = "human_reviewed"
LABEL_SOURCE_HEURISTIC = "heuristic_unreviewed"


def _clean(value: Any) -> str:
    """Coerce a CSV field to a clean string ('' for None/missing)."""
    if value is None:
        return ""
    return str(value).strip()


def read_reviewed_index(path: str) -> List[Dict[str, str]]:
    """Read reviewed-training-index.csv into a list of dict rows."""
    rows: List[Dict[str, str]] = []
    with open(path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for raw in reader:
            rows.append({k: _clean(v) for k, v in raw.items()})
    return rows


def read_existing_eval_event_ids(path: str) -> List[str]:
    """Read event_ids from an existing eval-manifest.csv (for freezing)."""
    if not os.path.exists(path):
        return []
    event_ids: List[str] = []
    with open(path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for raw in reader:
            ev = _clean(raw.get("event_id"))
            if ev:
                event_ids.append(ev)
    return event_ids


def _row_key(row: Dict[str, str]) -> str:
    """Stable per-row identity used for deterministic ordering."""
    # event_id is the canonical identity; fall back to capture_dir/frame_path
    # so rows without an event_id still sort deterministically.
    return row.get("event_id") or f"{row.get('capture_dir')}::{row.get('frame_path')}"


def apply_domain_cap(
    rows: List[Dict[str, str]],
    max_per_domain: int,
    rng: random.Random,
) -> Tuple[List[Dict[str, str]], Counter]:
    """Cap rows per origin_host WITHIN a single label group.

    Only drops rows when there are genuinely more than `max_per_domain` from the
    same domain — we never drop a label's only examples. Returns the kept rows
    (deterministically ordered) plus a Counter of how many were dropped per
    (label-scoped) domain.
    """
    if max_per_domain <= 0:
        return list(rows), Counter()

    by_domain: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_domain[row.get("origin_host", "")].append(row)

    kept: List[Dict[str, str]] = []
    capped: Counter = Counter()
    for domain in sorted(by_domain.keys()):
        group = sorted(by_domain[domain], key=_row_key)
        if len(group) > max_per_domain:
            # Deterministic shuffle, then keep the first max_per_domain.
            rng.shuffle(group)
            kept.extend(group[:max_per_domain])
            capped[domain] += len(group) - max_per_domain
        else:
            kept.extend(group)
    return kept, capped


def split_label_group(
    label: str,
    rows: List[Dict[str, str]],
    eval_ratio: float,
    min_eval_per_label: int,
    allow_small_label_leak: bool,
    frozen_eval_ids: set,
    rng: random.Random,
) -> Tuple[List[Dict[str, str]], List[Dict[str, str]], Optional[str]]:
    """Split one label's rows into (train, eval), honoring frozen eval rows.

    Returns (train_rows, eval_rows, train_only_reason). When the group is too
    small to carve out an eval holdout, train_only_reason is non-None and all
    rows go to train.
    """
    ordered = sorted(rows, key=_row_key)

    # Frozen eval rows for this label are pinned into eval up front.
    frozen = [r for r in ordered if r.get("event_id") in frozen_eval_ids]
    remaining = [r for r in ordered if r.get("event_id") not in frozen_eval_ids]

    total = len(ordered)
    # Minimum group size to carve out an eval holdout while leaving >=1 in train.
    # With a singleton (or a group that's all-frozen) we cannot split.
    if len(remaining) <= 1 and not frozen:
        return list(ordered), [], "too_few_examples"

    # Target eval count from the ratio, but at least min_eval_per_label, and
    # always leave at least one row for training.
    target_eval = max(min_eval_per_label, round(eval_ratio * total))
    max_eval = max(0, total - 1)  # keep >=1 for train
    target_eval = min(target_eval, max_eval)

    if target_eval <= 0:
        # Nothing can be held out without emptying train.
        return list(ordered), [], "too_few_examples"

    eval_rows: List[Dict[str, str]] = list(frozen)
    need = target_eval - len(eval_rows)

    if need > 0:
        # Prefer eval rows from domains NOT already represented in this label's
        # train pool, to reduce domain leakage. Train pool starts as "remaining
        # minus whatever we hold out", but we approximate leakage avoidance by
        # picking eval domains that are the *least* represented first.
        domain_counts: Counter = Counter(r.get("origin_host", "") for r in remaining)
        # Group remaining by domain, deterministic order.
        by_domain: Dict[str, List[Dict[str, str]]] = defaultdict(list)
        for r in remaining:
            by_domain[r.get("origin_host", "")].append(r)
        for d in by_domain:
            ordered_group = sorted(by_domain[d], key=_row_key)
            rng.shuffle(ordered_group)
            by_domain[d] = ordered_group

        # Domains sorted so that low-count (more unique) domains contribute eval
        # first — this keeps high-volume crawl domains in train and gives eval
        # un-leaked domains where possible. Deterministic tie-break by name.
        domain_order = sorted(by_domain.keys(), key=lambda d: (domain_counts[d], d))

        picked_unleaked: List[Dict[str, str]] = []
        # First pass: take ONE row from each distinct domain (un-leaked eval).
        for d in domain_order:
            if need <= 0:
                break
            if by_domain[d]:
                picked_unleaked.append(by_domain[d].pop(0))
                need -= 1
        eval_rows.extend(picked_unleaked)

        # Second pass (only if still short): allow additional rows from domains
        # already used — this is same-domain leakage and is recorded.
        leaked = False
        if need > 0:
            leftover = [r for d in domain_order for r in by_domain[d]]
            leftover = sorted(leftover, key=_row_key)
            rng.shuffle(leftover)
            take = leftover[:need]
            if take and not allow_small_label_leak:
                # Without the leak flag we still must reach min_eval_per_label,
                # so we take what we need but flag it as a warning-worthy leak.
                leaked = True
            elif take:
                leaked = True
            eval_rows.extend(take)
            need -= len(take)

    eval_ids = {r.get("event_id") for r in eval_rows}
    train_rows = [r for r in ordered if r.get("event_id") not in eval_ids]

    # Safety: never empty the train set for a non-singleton label.
    if not train_rows and eval_rows:
        # Push the last eval row back to train (deterministic).
        moved = sorted(eval_rows, key=_row_key)[-1]
        eval_rows = [r for r in eval_rows if r is not moved]
        train_rows = [moved]

    return train_rows, eval_rows, None


def build_split(
    rows: List[Dict[str, str]],
    *,
    eval_ratio: float,
    max_per_domain: int,
    min_eval_per_label: int,
    include_heuristic_unreviewed: bool,
    allow_small_label_leak: bool,
    frozen_eval_ids: List[str],
    seed: int,
) -> Dict[str, Any]:
    """Compute deterministic train/eval manifests + a summary."""
    rng = random.Random(seed)
    total_input_rows = len(rows)
    warnings: List[str] = []

    # Filter by label_source.
    allowed_sources = {LABEL_SOURCE_HUMAN}
    if include_heuristic_unreviewed:
        allowed_sources.add(LABEL_SOURCE_HEURISTIC)

    selected = [
        r
        for r in rows
        if r.get("label_source") in allowed_sources and r.get("effective_label")
    ]
    dropped_blank_label = sum(
        1
        for r in rows
        if r.get("label_source") in allowed_sources and not r.get("effective_label")
    )
    if dropped_blank_label:
        warnings.append(
            f"{dropped_blank_label} row(s) had an empty effective_label and were skipped."
        )

    frozen_set = set(frozen_eval_ids)

    # Group by effective_label, deterministic order.
    by_label: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for r in selected:
        by_label[r.get("effective_label", "")].append(r)

    capped_domains: Counter = Counter()
    train_rows: List[Dict[str, str]] = []
    eval_rows: List[Dict[str, str]] = []
    train_only_labels: List[str] = []
    leaked_labels: List[str] = []

    for label in sorted(by_label.keys()):
        group = by_label[label]
        # 1) Per-domain cap within the label (never drops a label's only rows).
        capped_group, capped_here = apply_domain_cap(group, max_per_domain, rng)
        for d, n in capped_here.items():
            capped_domains[f"{label}::{d}"] += n

        # 2) Train/eval split for the label.
        tr, ev, train_only_reason = split_label_group(
            label,
            capped_group,
            eval_ratio=eval_ratio,
            min_eval_per_label=min_eval_per_label,
            allow_small_label_leak=allow_small_label_leak,
            frozen_eval_ids=frozen_set,
            rng=rng,
        )

        if train_only_reason is not None:
            train_only_labels.append(label)

        # Detect same-domain leakage between this label's train and eval.
        train_domains = {r.get("origin_host", "") for r in tr}
        eval_domains = {r.get("origin_host", "") for r in ev}
        leaked_domains = train_domains & eval_domains
        if leaked_domains:
            leaked_labels.append(label)

        # Tag selection_reason per row.
        for r in tr:
            r = dict(r)
            r["split"] = "train"
            if train_only_reason is not None:
                r["selection_reason"] = "train_only_low_count"
            else:
                r["selection_reason"] = "train_holdout"
            train_rows.append(r)
        for r in ev:
            r = dict(r)
            r["split"] = "eval"
            if r.get("event_id") in frozen_set:
                r["selection_reason"] = "frozen_eval_preserved"
            elif r.get("origin_host", "") in train_domains:
                r["selection_reason"] = "eval_holdout_same_domain_leak"
            else:
                r["selection_reason"] = "eval_holdout_unleaked_domain"
            eval_rows.append(r)

    if leaked_labels:
        warnings.append(
            "Same-domain leakage between train and eval for label(s): "
            + ", ".join(sorted(set(leaked_labels)))
            + " (pool too small to fully separate domains)."
        )
    if train_only_labels:
        warnings.append(
            "Label(s) too small to hold out eval examples (train-only): "
            + ", ".join(sorted(set(train_only_labels)))
            + "."
        )

    selected_rows = len(train_rows) + len(eval_rows)
    if selected_rows < 30:
        warnings.append(
            f"TINY POOL: only {selected_rows} selected row(s). This is an initial "
            "small split, NOT a statistically meaningful dataset. Expect "
            "train-only and eval-light labels. Review more captures before "
            "drawing conclusions."
        )
    if not eval_rows:
        warnings.append(
            "Eval manifest is EMPTY — no label had enough examples to hold out an "
            "eval row. Review/curate more labels, or lower --min-eval-per-label."
        )

    def _counts(items: List[Dict[str, str]], key: str) -> Dict[str, int]:
        return dict(sorted(Counter(i.get(key, "") for i in items).items()))

    summary: Dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "seed": seed,
        "eval_ratio": eval_ratio,
        "max_per_domain": max_per_domain,
        "min_eval_per_label": min_eval_per_label,
        "include_heuristic_unreviewed": include_heuristic_unreviewed,
        "allow_small_label_leak": allow_small_label_leak,
        "total_input_rows": total_input_rows,
        "selected_rows": selected_rows,
        "train_rows": len(train_rows),
        "eval_rows": len(eval_rows),
        "label_counts_total": _counts(train_rows + eval_rows, "effective_label"),
        "label_counts_train": _counts(train_rows, "effective_label"),
        "label_counts_eval": _counts(eval_rows, "effective_label"),
        "domain_counts_total": _counts(train_rows + eval_rows, "origin_host"),
        "domain_counts_train": _counts(train_rows, "origin_host"),
        "domain_counts_eval": _counts(eval_rows, "origin_host"),
        "train_only_labels_due_to_low_count": sorted(set(train_only_labels)),
        "capped_domains": dict(sorted(capped_domains.items())) if capped_domains else {},
        "warnings": warnings,
    }

    return {"train": train_rows, "eval": eval_rows, "summary": summary}


def write_manifest(path: str, split_name: str, rows: List[Dict[str, str]]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    ordered = sorted(rows, key=lambda r: (r.get("effective_label", ""), _row_key(r)))
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=MANIFEST_COLUMNS)
        writer.writeheader()
        for row in ordered:
            writer.writerow({col: _clean(row.get(col)) for col in MANIFEST_COLUMNS})


def write_summary(path: str, summary: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
        fh.write("\n")


def print_summary(summary: Dict[str, Any], out_dir: str) -> None:
    print("HV vision train/eval manifest builder — deliberate split (pool, not auto-train)")
    print(f"  seed                         : {summary['seed']}")
    print(f"  eval_ratio                   : {summary['eval_ratio']}")
    print(f"  max_per_domain               : {summary['max_per_domain']}")
    print(f"  min_eval_per_label           : {summary['min_eval_per_label']}")
    print(f"  include_heuristic_unreviewed : {summary['include_heuristic_unreviewed']}")
    print(f"  total_input_rows             : {summary['total_input_rows']}")
    print(f"  selected_rows                : {summary['selected_rows']}")
    print(f"  train_rows                   : {summary['train_rows']}")
    print(f"  eval_rows                    : {summary['eval_rows']}")
    if "frozen_eval_preserved_count" in summary:
        print(f"  frozen_eval_preserved_count  : {summary['frozen_eval_preserved_count']}")
        print(f"  frozen_eval_missing_count    : {summary['frozen_eval_missing_count']}")
    print("  label_counts_train:")
    for label, count in summary["label_counts_train"].items():
        print(f"    {label}: {count}")
    print("  label_counts_eval:")
    if summary["label_counts_eval"]:
        for label, count in summary["label_counts_eval"].items():
            print(f"    {label}: {count}")
    else:
        print("    (none)")
    if summary["train_only_labels_due_to_low_count"]:
        print("  train_only_labels_due_to_low_count:")
        for label in summary["train_only_labels_due_to_low_count"]:
            print(f"    {label}")
    if summary["warnings"]:
        print("  warnings:")
        for w in summary["warnings"]:
            print(f"    - {w}")
    print(f"  wrote train manifest : {os.path.join(out_dir, TRAIN_MANIFEST_NAME)}")
    print(f"  wrote eval manifest  : {os.path.join(out_dir, EVAL_MANIFEST_NAME)}")
    print(f"  wrote summary        : {os.path.join(out_dir, SUMMARY_NAME)}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build deliberate, reproducible train/eval manifests from the "
        "curated reviewed-label pool. Reviewed labels are a candidate pool, NOT an "
        "automatic training set. Does NOT train and does NOT mutate the dataset.",
    )
    ap.add_argument(
        "--reviewed-index",
        default=DEFAULT_REVIEWED_INDEX,
        help="reviewed-training-index.csv input (from hv_vision_export_reviewed_index.py)",
    )
    ap.add_argument(
        "--dataset-index",
        default=DEFAULT_DATASET_INDEX,
        help="dataset-index.csv, read-only fallback/source reference (not mutated)",
    )
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="output directory for manifests")
    ap.add_argument("--seed", type=int, default=42, help="deterministic RNG seed")
    ap.add_argument("--eval-ratio", type=float, default=0.25, help="target eval fraction per label")
    ap.add_argument(
        "--max-per-domain",
        type=int,
        default=3,
        help="cap examples per origin_host within a label (0 disables the cap)",
    )
    ap.add_argument(
        "--min-eval-per-label",
        type=int,
        default=1,
        help="minimum eval examples per label that has enough rows to split",
    )
    ap.add_argument(
        "--include-heuristic-unreviewed",
        action="store_true",
        help="EXPERIMENTS ONLY: also include label_source=heuristic_unreviewed rows",
    )
    ap.add_argument(
        "--freeze-existing-eval",
        action="store_true",
        help="if eval-manifest.csv exists, preserve those eval rows and build train around them",
    )
    ap.add_argument(
        "--allow-small-label-leak",
        action="store_true",
        help="allow same-domain train/eval leakage when the pool is too small to separate",
    )
    args = ap.parse_args()

    if not os.path.exists(args.reviewed_index):
        print(
            f"error: reviewed index not found: {args.reviewed_index}\n"
            "       run scripts/hv_vision_export_reviewed_index.py first.",
            file=sys.stderr,
        )
        return 2

    rows = read_reviewed_index(args.reviewed_index)
    if not rows:
        print(
            f"warning: reviewed index is empty: {args.reviewed_index}",
            file=sys.stderr,
        )

    # Freeze handling: read existing eval-manifest.csv event_ids if requested.
    eval_manifest_path = os.path.join(args.out_dir, EVAL_MANIFEST_NAME)
    frozen_eval_ids: List[str] = []
    frozen_preserved_count: Optional[int] = None
    frozen_missing_count: Optional[int] = None
    if args.freeze_existing_eval:
        existing_eval_ids = read_existing_eval_event_ids(eval_manifest_path)
        present_ids = {r.get("event_id") for r in rows if r.get("event_id")}
        frozen_eval_ids = [e for e in existing_eval_ids if e in present_ids]
        frozen_preserved_count = len(frozen_eval_ids)
        frozen_missing_count = len([e for e in existing_eval_ids if e not in present_ids])

    result = build_split(
        rows,
        eval_ratio=args.eval_ratio,
        max_per_domain=args.max_per_domain,
        min_eval_per_label=args.min_eval_per_label,
        include_heuristic_unreviewed=args.include_heuristic_unreviewed,
        allow_small_label_leak=args.allow_small_label_leak,
        frozen_eval_ids=frozen_eval_ids,
        seed=args.seed,
    )

    summary = result["summary"]
    if args.freeze_existing_eval:
        summary["frozen_eval_preserved_count"] = frozen_preserved_count
        summary["frozen_eval_missing_count"] = frozen_missing_count
        if frozen_missing_count:
            summary["warnings"].append(
                f"{frozen_missing_count} frozen eval row(s) disappeared from the "
                "reviewed index and were dropped from the eval set."
            )

    train_path = os.path.join(args.out_dir, TRAIN_MANIFEST_NAME)
    write_manifest(train_path, "train", result["train"])
    write_manifest(eval_manifest_path, "eval", result["eval"])
    write_summary(os.path.join(args.out_dir, SUMMARY_NAME), summary)
    print_summary(summary, args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
