#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — focused error report over training metrics.

SHADOW / OFFLINE / DEV-ONLY. Reads the metrics written by hv_vision_train.py
(dev-artifacts/hv-vision-models/metrics.json) and produces a focused error report
that surfaces the visual classifier's high-consequence failure modes — above all
DANGEROUS FALSE page_level_hv_wall predictions (the model claiming a benign page
is a human-verification wall, which would wrongly gate the agent). Output lands
under the gitignored dev-artifacts/. NOTHING here is wired into the Antigen
runtime; nothing under apps/ imports it.

Hard rules this tool obeys (same as the rest of the harness):
  1. Offline / dev-only. No runtime imports, no new dependencies (stdlib only),
     no production behavior change. No network.
  2. Read-only over artifacts. It reads metrics.json (and, optionally, the eval
     manifest CSV for event metadata) and writes a report JSON + Markdown. It
     stores NO screenshot bytes — only string paths (capture_dir) are referenced.
  3. Detect-and-route only. This is an error-analysis artifact over STATE
     classification. It must NEVER be used to solve, click, press, hold, type
     into, OCR, classify answers for, or bypass CAPTCHA / human verification.

Error categories (an example may fall in more than one):
  1. dangerous_false_hv      true != HV  and  predicted == HV   (any false HV)
     This bucket is further split BY CONFIDENCE against --hv-action-threshold:
       - false_hv_actionable      false HV with confidence >= action threshold
                                   (would route to a human at runtime — real risk)
       - false_hv_low_confidence  false HV below the action threshold (or unknown
                                   confidence) — useful model-debugging signal,
                                   but would NOT trigger runtime routing
  2. missed_hv               true == HV  and  predicted != HV
  3. low_confidence_correct_hv  true == predicted == HV and confidence < thresh
  4. high_confidence_wrong   true != predicted and confidence > thresh

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_error_report.py
  ... --metrics <path>                    # override metrics.json location
  ... --eval-manifest <path>              # optional event-metadata enrichment
  ... --out-dir <path>                    # override report output dir
  ... --low-confidence-threshold 0.80     # low-confidence correct HV cutoff
  ... --high-confidence-threshold 0.75    # high-confidence wrong cutoff
  ... --hv-action-threshold 0.85          # runtime action-routing cutoff for
                                          #   splitting actionable vs low-conf
                                          #   false HV (reporting only)
  ... --hv-label page_level_hv_wall       # the dangerous label name
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

DEFAULT_METRICS = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-models", "metrics.json")
DEFAULT_EVAL_MANIFEST = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-splits", "eval-manifest.csv")
DEFAULT_OUT_DIR = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-reports")

DEFAULT_HV_LABEL = "page_level_hv_wall"
DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.80
DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.75
DEFAULT_HV_ACTION_THRESHOLD = 0.85


def _rel(path: str) -> str:
    """Repo-root-relative display path (falls back to the raw path)."""
    try:
        return os.path.relpath(path, _REPO_ROOT)
    except ValueError:
        return path


def load_metrics(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        raise SystemExit(
            f"error: metrics file not found: {_rel(path)}\n"
            f"       Train first: scripts/hv_vision_train.py"
        )
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"error: could not parse metrics JSON {_rel(path)}: {exc}")
    if not isinstance(data, dict):
        raise SystemExit(f"error: metrics JSON {_rel(path)} is not an object")
    return data


def load_manifest_index(path: str) -> Dict[str, Dict[str, str]]:
    """Optional capture_dir -> {event_id, selection_reason} map for enrichment.

    Missing/unreadable manifest is non-fatal — enrichment is best-effort.
    """
    index: Dict[str, Dict[str, str]] = {}
    if not path or not os.path.exists(path):
        return index
    try:
        with open(path, "r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                capture_dir = (row.get("capture_dir") or "").strip()
                if not capture_dir:
                    continue
                index[capture_dir] = {
                    "event_id": (row.get("event_id") or "").strip(),
                    "selection_reason": (row.get("selection_reason") or "").strip(),
                }
    except OSError as exc:
        # Best-effort only — never fail the report over an optional input.
        print(f"warning: could not read eval manifest {_rel(path)}: {exc}", file=sys.stderr)
    return index


def normalize_example(
    raw: Dict[str, Any], manifest_index: Dict[str, Dict[str, str]]
) -> Dict[str, Any]:
    """Project a lowest_confidence_examples entry to the report shape.

    Enriches missing event_id / selection_reason from the eval manifest (by
    capture_dir) when available. No screenshot bytes are ever touched.
    """
    capture_dir = raw.get("capture_dir") or ""
    enrich = manifest_index.get(capture_dir, {})
    event_id = raw.get("event_id") or enrich.get("event_id") or None
    selection_reason = raw.get("selection_reason") or enrich.get("selection_reason") or None

    confidence = raw.get("confidence")
    try:
        confidence = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        confidence = None

    return {
        "domain": raw.get("domain") or None,
        "capture_dir": capture_dir or None,
        "event_id": event_id,
        "true_label": raw.get("true_label") or None,
        "predicted_label": raw.get("predicted_label") or None,
        "confidence": confidence,
        "selection_reason": selection_reason,
        "top_3": raw.get("top_3") if isinstance(raw.get("top_3"), list) else None,
    }


def confusion_totals(confusion: Dict[str, Any], hv_label: str) -> Dict[str, int]:
    """Eval-wide dangerous-false-HV / missed-HV counts from the confusion matrix.

    The per-example list is only the lowest-confidence subset, so the matrix
    gives the authoritative whole-eval totals.
    """
    out = {"dangerous_false_hv": 0, "missed_hv": 0}
    label_order = confusion.get("label_order")
    matrix = confusion.get("matrix")
    if not isinstance(label_order, list) or not isinstance(matrix, list):
        return out
    if hv_label not in label_order:
        return out
    hv_idx = label_order.index(hv_label)
    for true_idx, row in enumerate(matrix):
        if not isinstance(row, list):
            continue
        for pred_idx, count in enumerate(row):
            try:
                count = int(count)
            except (TypeError, ValueError):
                continue
            if count <= 0:
                continue
            if pred_idx == hv_idx and true_idx != hv_idx:
                out["dangerous_false_hv"] += count
            elif true_idx == hv_idx and pred_idx != hv_idx:
                out["missed_hv"] += count
    return out


def categorize(
    examples: List[Dict[str, Any]],
    hv_label: str,
    low_threshold: float,
    high_threshold: float,
    hv_action_threshold: float,
) -> Dict[str, List[Dict[str, Any]]]:
    # `dangerous_false_hv` is the full detailed false-HV set (any false HV).
    # `false_hv_actionable` / `false_hv_low_confidence` split it by confidence
    # against the runtime action threshold — reporting only.
    cats: Dict[str, List[Dict[str, Any]]] = {
        "dangerous_false_hv": [],
        "false_hv_actionable": [],
        "false_hv_low_confidence": [],
        "missed_hv": [],
        "low_confidence_correct_hv": [],
        "high_confidence_wrong": [],
    }
    for ex in examples:
        true_label = ex.get("true_label")
        pred_label = ex.get("predicted_label")
        conf = ex.get("confidence")

        if true_label != hv_label and pred_label == hv_label:
            cats["dangerous_false_hv"].append(ex)
            # Unknown confidence cannot be called actionable — it falls to the
            # low-confidence bucket conservatively (would not route at runtime).
            if conf is not None and conf >= hv_action_threshold:
                cats["false_hv_actionable"].append(ex)
            else:
                cats["false_hv_low_confidence"].append(ex)
        if true_label == hv_label and pred_label != hv_label:
            cats["missed_hv"].append(ex)
        if (
            true_label == hv_label
            and pred_label == hv_label
            and conf is not None
            and conf < low_threshold
        ):
            cats["low_confidence_correct_hv"].append(ex)
        if (
            true_label is not None
            and pred_label is not None
            and true_label != pred_label
            and conf is not None
            and conf > high_threshold
        ):
            cats["high_confidence_wrong"].append(ex)
    return cats


def recommend_focus(
    cats: Dict[str, List[Dict[str, Any]]],
    totals: Dict[str, int],
    hv_label: str,
    hv_action_threshold: float,
) -> str:
    actionable = cats["false_hv_actionable"]
    low_conf_false = cats["false_hv_low_confidence"]
    missed = cats["missed_hv"]
    wrong = cats["high_confidence_wrong"]
    # Only ACTIONABLE false HV (confidence >= action threshold) is a runtime
    # risk — those would wrongly route a benign page to a human.
    if actionable:
        domains = sorted({ex["domain"] for ex in actionable if ex.get("domain")})
        domain_hint = f" (e.g. {', '.join(domains)})" if domains else ""
        return (
            f"DANGEROUS: model predicts '{hv_label}' on benign pages at or above "
            f"the action threshold ({hv_action_threshold}){domain_hint}. These would "
            f"route to a human at runtime. Capture and review MORE NEGATIVE (non-wall) "
            f"frames on these domains so the classifier learns they are not "
            f"human-verification walls."
        )
    if missed:
        domains = sorted({ex["domain"] for ex in missed if ex.get("domain")})
        domain_hint = f" (e.g. {', '.join(domains)})" if domains else ""
        return (
            f"Model MISSED real '{hv_label}' walls{domain_hint}. "
            f"Capture and review more true human-verification wall frames."
        )
    if wrong:
        domains = sorted({ex["domain"] for ex in wrong if ex.get("domain")})
        domain_hint = f" (e.g. {', '.join(domains)})" if domains else ""
        return (
            f"Confident mistakes outside the HV class{domain_hint}. "
            f"Review these high-confidence wrong predictions before retraining."
        )
    if low_conf_false:
        domains = sorted({ex["domain"] for ex in low_conf_false if ex.get("domain")})
        domain_hint = f" (e.g. {', '.join(domains)})" if domains else ""
        return (
            f"Low-confidence false '{hv_label}' predictions below the action "
            f"threshold ({hv_action_threshold}){domain_hint}. Below action threshold; "
            f"useful for model improvement, but would not trigger runtime routing "
            f"under current threshold."
        )
    return (
        "No high-consequence errors in the current eval subset. Expand eval "
        "coverage (more domains / classes) to keep this signal meaningful."
    )


def build_report(
    metrics: Dict[str, Any],
    manifest_index: Dict[str, Dict[str, str]],
    metrics_path: str,
    hv_label: str,
    low_threshold: float,
    high_threshold: float,
    hv_action_threshold: float,
) -> Dict[str, Any]:
    raw_examples = metrics.get("lowest_confidence_examples")
    if not isinstance(raw_examples, list):
        raw_examples = []
    examples = [
        normalize_example(ex, manifest_index)
        for ex in raw_examples
        if isinstance(ex, dict)
    ]

    confusion = metrics.get("confusion_matrix")
    confusion = confusion if isinstance(confusion, dict) else {}
    label_order = confusion.get("label_order") if isinstance(confusion.get("label_order"), list) else []

    totals = confusion_totals(confusion, hv_label)
    cats = categorize(
        examples, hv_label, low_threshold, high_threshold, hv_action_threshold
    )
    focus = recommend_focus(cats, totals, hv_label, hv_action_threshold)

    return {
        "harness": "antigen-visual-classifier-v0",
        "report": "hv_vision_error_report",
        "mode": "shadow_offline_dev_only",
        "runtime_wired": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "metrics_source": _rel(metrics_path),
        "training_data_source": metrics.get("training_data_source"),
        "eval_accuracy": metrics.get("eval_accuracy"),
        "label_order": label_order,
        "hv_label": hv_label,
        "thresholds": {
            "low_confidence_threshold": low_threshold,
            "high_confidence_threshold": high_threshold,
            "hv_action_threshold": hv_action_threshold,
        },
        # Matrix-derived totals are authoritative over the whole eval set; the
        # *_detailed counts (and the actionable / low-confidence split, which
        # needs per-example confidence) reflect only the lowest-confidence
        # example subset for which we have per-example metadata.
        "summary": {
            # `false_hv_any_count` is the whole-eval false-HV total (matrix);
            # `dangerous_false_hv_count` is retained as its backward-compat alias.
            "false_hv_any_count": totals["dangerous_false_hv"],
            "false_hv_actionable_count": len(cats["false_hv_actionable"]),
            "false_hv_low_confidence_count": len(cats["false_hv_low_confidence"]),
            "dangerous_false_hv_count": totals["dangerous_false_hv"],
            "missed_hv_count": totals["missed_hv"],
            "dangerous_false_hv_count_detailed": len(cats["dangerous_false_hv"]),
            "missed_hv_count_detailed": len(cats["missed_hv"]),
            "low_confidence_correct_hv_count": len(cats["low_confidence_correct_hv"]),
            "high_confidence_wrong_count": len(cats["high_confidence_wrong"]),
            "examples_analyzed": len(examples),
        },
        "dangerous_false_hv": cats["dangerous_false_hv"],
        "false_hv_actionable": cats["false_hv_actionable"],
        "false_hv_low_confidence": cats["false_hv_low_confidence"],
        "missed_hv": cats["missed_hv"],
        "low_confidence_correct_hv": cats["low_confidence_correct_hv"],
        "high_confidence_wrong": cats["high_confidence_wrong"],
        "recommended_focus": focus,
    }


def _fmt_conf(conf: Optional[float]) -> str:
    return f"{conf:.4f}" if isinstance(conf, (int, float)) else "n/a"


def _example_lines(examples: List[Dict[str, Any]]) -> List[str]:
    if not examples:
        return ["_none_", ""]
    lines: List[str] = []
    for ex in examples:
        lines.append(
            f"- **{ex.get('domain') or '(unknown domain)'}** — "
            f"`{ex.get('true_label')}` → `{ex.get('predicted_label')}` "
            f"(confidence {_fmt_conf(ex.get('confidence'))})"
        )
        lines.append(f"  - capture_dir: `{ex.get('capture_dir') or 'n/a'}`")
        if ex.get("event_id"):
            lines.append(f"  - event_id: `{ex['event_id']}`")
        if ex.get("selection_reason"):
            lines.append(f"  - selection_reason: `{ex['selection_reason']}`")
    lines.append("")
    return lines


def render_markdown(report: Dict[str, Any]) -> str:
    s = report["summary"]
    out: List[str] = []
    out.append("# HV Vision — Error Report")
    out.append("")
    out.append("**SHADOW / OFFLINE / DEV-ONLY.** Error analysis over the trained "
               "visual classifier's metrics. Not wired into the Antigen runtime; "
               "stores no screenshot bytes. Detect-and-route classification only — "
               "never solves or bypasses human verification.")
    out.append("")
    out.append(f"- Generated: `{report['generated_at']}`")
    out.append(f"- Metrics source: `{report['metrics_source']}`")
    out.append(f"- Training data source: `{report.get('training_data_source')}`")
    out.append(f"- Eval accuracy: `{report.get('eval_accuracy')}`")
    out.append(f"- HV label: `{report['hv_label']}`")
    out.append(f"- Label order: {', '.join(f'`{l}`' for l in report['label_order']) or '_none_'}")
    out.append(
        f"- Thresholds: low_confidence < "
        f"`{report['thresholds']['low_confidence_threshold']}`, "
        f"high_confidence > `{report['thresholds']['high_confidence_threshold']}`, "
        f"hv_action >= `{report['thresholds']['hv_action_threshold']}`"
    )
    out.append("")
    action_thresh = report["thresholds"]["hv_action_threshold"]
    out.append("## Summary")
    out.append("")
    out.append(f"- **False `{report['hv_label']}` — any (eval total): {s['false_hv_any_count']}** "
               f"(detailed examples: {s['dangerous_false_hv_count_detailed']})")
    out.append(f"  - **Actionable (confidence >= `{action_thresh}`): {s['false_hv_actionable_count']}** "
               f"— would route to a human at runtime")
    out.append(f"  - Low-confidence (below action threshold): {s['false_hv_low_confidence_count']} "
               f"— model-debugging signal only")
    out.append(f"- **Missed HV walls (eval total): {s['missed_hv_count']}** "
               f"(detailed examples: {s['missed_hv_count_detailed']})")
    out.append(f"- Low-confidence correct HV: {s['low_confidence_correct_hv_count']}")
    out.append(f"- High-confidence wrong: {s['high_confidence_wrong_count']}")
    out.append(f"- Examples analyzed (lowest-confidence subset): {s['examples_analyzed']}")
    out.append("")
    out.append(f"**Recommended focus:** {report['recommended_focus']}")
    out.append("")
    out.append(f"## Actionable false `{report['hv_label']}` predictions (confidence >= `{action_thresh}`)")
    out.append("")
    out.append("True label is benign but the model predicted a human-verification "
               "wall at or above the action threshold — this would wrongly gate the "
               "agent at runtime (highest risk).")
    out.append("")
    out.extend(_example_lines(report["false_hv_actionable"]))
    out.append(f"## Low-confidence false `{report['hv_label']}` predictions (below `{action_thresh}`)")
    out.append("")
    out.append("True label is benign and the model predicted a human-verification "
               "wall, but below the action threshold. Below action threshold; useful "
               "for model improvement, but would not trigger runtime routing under "
               "current threshold.")
    out.append("")
    out.extend(_example_lines(report["false_hv_low_confidence"]))
    out.append("## Missed HV walls")
    out.append("")
    out.append("True label is a human-verification wall but the model predicted "
               "something else.")
    out.append("")
    out.extend(_example_lines(report["missed_hv"]))
    out.append("## Low-confidence correct HV predictions")
    out.append("")
    out.extend(_example_lines(report["low_confidence_correct_hv"]))
    out.append("## High-confidence wrong predictions")
    out.append("")
    out.extend(_example_lines(report["high_confidence_wrong"]))
    return "\n".join(out).rstrip() + "\n"


def print_summary(report: Dict[str, Any]) -> None:
    s = report["summary"]
    print("HV Vision — Error Report (shadow / offline / dev-only)")
    print(f"  metrics source           : {report['metrics_source']}")
    print(f"  training_data_source     : {report.get('training_data_source')}")
    print(f"  eval_accuracy            : {report.get('eval_accuracy')}")
    print(f"  label order              : {', '.join(report['label_order']) or '(none)'}")
    print(f"  hv_action_threshold      : {report['thresholds']['hv_action_threshold']}")
    print(f"  false_hv_any_count       : {s['false_hv_any_count']} "
          f"(detailed: {s['dangerous_false_hv_count_detailed']})")
    print(f"  false_hv_actionable_count: {s['false_hv_actionable_count']}")
    print(f"  false_hv_low_conf_count  : {s['false_hv_low_confidence_count']}")
    print(f"  missed_hv_count          : {s['missed_hv_count']} "
          f"(detailed: {s['missed_hv_count_detailed']})")
    print(f"  high_confidence_wrong    : {s['high_confidence_wrong_count']}")
    print(f"  low_confidence_correct_hv: {s['low_confidence_correct_hv_count']}")
    print(f"  recommended focus        : {report['recommended_focus']}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Focused HV visual-classifier error report (offline/dev-only)."
    )
    parser.add_argument("--metrics", default=DEFAULT_METRICS,
                        help="Path to metrics.json (default: dev-artifacts/hv-vision-models/metrics.json)")
    parser.add_argument("--eval-manifest", default=DEFAULT_EVAL_MANIFEST,
                        help="Optional eval-manifest.csv for event metadata enrichment")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR,
                        help="Output directory for error-report.json / .md")
    parser.add_argument("--low-confidence-threshold", type=float,
                        default=DEFAULT_LOW_CONFIDENCE_THRESHOLD,
                        help="Correct HV predictions below this are flagged (default 0.80)")
    parser.add_argument("--high-confidence-threshold", type=float,
                        default=DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
                        help="Wrong predictions above this are flagged (default 0.75)")
    parser.add_argument("--hv-action-threshold", type=float,
                        default=DEFAULT_HV_ACTION_THRESHOLD,
                        help="Runtime action-routing cutoff: false HV at or above "
                             "this confidence is 'actionable'; below is "
                             "low-confidence model-debugging signal (default 0.85)")
    parser.add_argument("--hv-label", default=DEFAULT_HV_LABEL,
                        help="The dangerous human-verification wall label name")
    args = parser.parse_args()

    metrics = load_metrics(args.metrics)
    manifest_index = load_manifest_index(args.eval_manifest)

    report = build_report(
        metrics=metrics,
        manifest_index=manifest_index,
        metrics_path=args.metrics,
        hv_label=args.hv_label,
        low_threshold=args.low_confidence_threshold,
        high_threshold=args.high_confidence_threshold,
        hv_action_threshold=args.hv_action_threshold,
    )

    os.makedirs(args.out_dir, exist_ok=True)
    out_json = os.path.join(args.out_dir, "error-report.json")
    out_md = os.path.join(args.out_dir, "error-report.md")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
        fh.write("\n")
    with open(out_md, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(report))

    print_summary(report)
    print()
    print(f"wrote {_rel(out_json)}")
    print(f"wrote {_rel(out_md)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
