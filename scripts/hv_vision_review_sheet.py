#!/usr/bin/env python3
"""Antigen Visual Classifier v0 — shadow review-queue HTML contact sheet.

SHADOW / OFFLINE / DEV-ONLY. Renders the human review queue
(dev-artifacts/hv-vision-review/review-queue.jsonl) as a single static HTML
contact sheet so a reviewer can eyeball every captured frame next to the model
prediction, the heuristic label, and any human label — and triage / hand-label
quickly. NOTHING here is wired into the Antigen runtime; nothing under apps/
imports it. Output lands under the gitignored dev-artifacts/.

Hard rules this tool obeys (same as the rest of the harness):
  1. Offline / dev-only. No runtime imports, no new dependencies (stdlib only),
     no production behavior change.
  2. No raw screenshot bytes embedded. The sheet references the already-captured
     frame.png files by RELATIVE path (never base64), so it stays small and the
     images are never duplicated into a committed-looking artifact.
  3. Static review surface. The sheet does NOT save edits — it is a read-only
     visual aid for manual labeling. Label options are shown as plain reference
     chips, not interactive controls.
  4. Detect-and-route only. This is a STATE classification review artifact. It
     must NEVER be used to solve, click, press, hold, type into, OCR, classify
     answers for, or bypass CAPTCHA / human verification.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_review_sheet.py
  ... --queue <path>          # override review-queue.jsonl location
  ... --dataset-dir <path>    # override frame.png dataset root
  ... --out <path>            # override review-sheet.html output
"""

from __future__ import annotations

import argparse
import html
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
DEFAULT_DATASET_DIR = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-dataset")
DEFAULT_OUT = os.path.join(_REPO_ROOT, "dev-artifacts", "hv-vision-review", "review-sheet.html")

# Highest priority first (requirement 8).
REVIEW_REASON_ORDER = [
    "high_consequence_prediction",
    "heuristic_model_disagreement",
    "low_confidence",
    "new_domain",
    "sampled_baseline",
]

# Static label options shown as reference chips (requirement 10). The sheet does
# not save edits; these are a visual reminder of the allowed label vocabulary.
LABEL_OPTIONS = [
    "false_positive_normal_page",
    "false_positive_normal_modal",
    "cookie_banner",
    "page_level_hv_wall",
    "newsletter_modal",
    "sign_in_drawer",
]

# Metadata fields rendered per card, in display order (requirement 7).
META_FIELDS = [
    "event_id",
    "origin_host",
    "activation_reason",
    "trigger_basis",
    "model_predicted_label",
    "model_confidence",
    "heuristic_label",
    "human_label",
    "review_status",
    "review_reason",
    "notes",
]


def load_queue(path: str) -> List[Dict[str, Any]]:
    """Read the JSONL review queue. Tolerate (and warn about) malformed lines."""
    events: List[Dict[str, Any]] = []
    if not os.path.exists(path):
        print(f"error: review queue not found: {path}", file=sys.stderr)
        return events
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(f"warning: skipping malformed line {lineno}: {exc}", file=sys.stderr)
    return events


def sort_key(event: Dict[str, Any]):
    """Priority sort: review_reason order, then lower/null confidence first."""
    reason = event.get("review_reason")
    try:
        reason_rank = REVIEW_REASON_ORDER.index(reason)
    except ValueError:
        reason_rank = len(REVIEW_REASON_ORDER)  # unknown reasons sort last
    conf = event.get("model_confidence")
    # null confidence first (group 0), then ascending confidence (requirement 9).
    if conf is None:
        return (reason_rank, 0, 0.0)
    return (reason_rank, 1, float(conf))


def fmt_conf(conf: Optional[float]) -> str:
    if conf is None:
        return "—"
    try:
        return f"{float(conf):.4f}"
    except (TypeError, ValueError):
        return html.escape(str(conf))


def img_src(event: Dict[str, Any], html_dir: str, dataset_dir: str) -> Optional[str]:
    """Relative path from the HTML file to the frame.png (never base64)."""
    frame_path = event.get("frame_path")
    if not frame_path:
        capture_dir = event.get("capture_dir")
        if not capture_dir:
            return None
        frame_path = os.path.join(capture_dir, "frame.png")
    abs_frame = os.path.join(dataset_dir, frame_path)
    rel = os.path.relpath(abs_frame, html_dir)
    return rel.replace(os.sep, "/")


def render_top3(event: Dict[str, Any]) -> str:
    top3 = event.get("model_top_3") or []
    items = []
    for entry in top3:
        if isinstance(entry, dict):
            label = html.escape(str(entry.get("label", "?")))
            prob = entry.get("prob")
            prob_txt = fmt_conf(prob) if isinstance(prob, (int, float)) else html.escape(str(prob))
            items.append(f"<li><span class='t3-label'>{label}</span> <span class='t3-prob'>{prob_txt}</span></li>")
    if not items:
        return "<div class='muted'>—</div>"
    return "<ol class='top3'>" + "".join(items) + "</ol>"


def render_summary(events: List[Dict[str, Any]]) -> str:
    total = len(events)
    by_reason = Counter(e.get("review_reason") or "(none)" for e in events)
    by_label = Counter(e.get("model_predicted_label") or "(none)" for e in events)
    by_status = Counter(e.get("review_status") or "(none)" for e in events)

    def chips(counter: Counter, order: Optional[List[str]] = None) -> str:
        keys = list(order) if order else []
        for k in counter:
            if k not in keys:
                keys.append(k)
        cells = []
        for k in keys:
            if k not in counter:
                continue
            cells.append(
                f"<span class='count-chip'><span class='ck'>{html.escape(str(k))}</span>"
                f"<span class='cv'>{counter[k]}</span></span>"
            )
        return "".join(cells) or "<span class='muted'>none</span>"

    status_order = ["pending", "reviewed", "skipped"]
    return f"""
    <section class="summary">
      <div class="summary-total">Total events: <strong>{total}</strong></div>
      <div class="summary-row"><div class="summary-h">By review reason</div>{chips(by_reason, REVIEW_REASON_ORDER)}</div>
      <div class="summary-row"><div class="summary-h">By predicted label</div>{chips(by_label, LABEL_OPTIONS)}</div>
      <div class="summary-row"><div class="summary-h">By review status</div>{chips(by_status, status_order)}</div>
    </section>
    """


def render_card(event: Dict[str, Any], html_dir: str, dataset_dir: str) -> str:
    src = img_src(event, html_dir, dataset_dir)
    if src and os.path.exists(os.path.join(html_dir, src)):
        img_html = f"<img loading='lazy' src='{html.escape(src)}' alt='frame'>"
    else:
        missing = html.escape(src or "(no frame path)")
        img_html = f"<div class='missing-frame'>missing frame<br><span class='muted'>{missing}</span></div>"

    predicted = event.get("model_predicted_label")
    human = event.get("human_label")
    mismatch = bool(human) and human != predicted

    rows = []
    for field in META_FIELDS:
        val = event.get(field)
        if field == "model_confidence":
            disp = fmt_conf(val)
        elif val is None or val == "":
            disp = "<span class='muted'>—</span>"
        else:
            disp = html.escape(str(val))
        cls = ""
        if field == "human_label" and mismatch:
            cls = " class='mismatch'"
        rows.append(f"<tr{cls}><th>{field}</th><td>{disp}</td></tr>")

    status = (event.get("review_status") or "pending").lower()
    badges = [f"<span class='badge status-{html.escape(status)}'>{html.escape(status)}</span>"]
    if mismatch:
        badges.append("<span class='badge mismatch-badge'>human ≠ model</span>")

    label_chips = "".join(
        f"<span class='label-opt'>{html.escape(opt)}</span>" for opt in LABEL_OPTIONS
    )

    return f"""
    <article class="card">
      <div class="card-img">{img_html}</div>
      <div class="card-body">
        <div class="card-badges">{''.join(badges)}</div>
        <table class="meta">{''.join(rows)}</table>
        <div class="top3-block"><div class="block-h">model_top_3</div>{render_top3(event)}</div>
        <div class="labels-block"><div class="block-h">label options (manual)</div>
          <div class="label-opts">{label_chips}</div>
        </div>
      </div>
    </article>
    """


STYLE = """
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 24px; background: #f4f5f7; color: #1d2129; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; margin: 0 0 20px; font-size: 13px; }
  .summary { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px;
             padding: 16px 18px; margin-bottom: 24px; }
  .summary-total { font-size: 15px; margin-bottom: 10px; }
  .summary-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0; }
  .summary-h { width: 160px; min-width: 160px; color: #6b7280; font-weight: 600; }
  .count-chip { display: inline-flex; align-items: center; gap: 6px; background: #eef1f5;
                border-radius: 14px; padding: 2px 4px 2px 10px; font-size: 12px; }
  .count-chip .cv { background: #1d2129; color: #fff; border-radius: 10px; padding: 1px 8px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 18px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; overflow: hidden;
          display: flex; flex-direction: column; }
  .card-img { background: #11151a; display: flex; align-items: center; justify-content: center; }
  .card-img img { width: 100%; height: auto; display: block; max-height: 320px; object-fit: contain; }
  .missing-frame { color: #c0392b; text-align: center; padding: 48px 12px; font-weight: 600; }
  .card-body { padding: 14px 16px; }
  .card-badges { margin-bottom: 8px; }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase;
           letter-spacing: .03em; padding: 2px 8px; border-radius: 6px; margin-right: 6px; }
  .status-pending { background: #fff4d6; color: #8a6d00; }
  .status-reviewed { background: #d8f5e1; color: #1d7a3f; }
  .status-skipped { background: #e6e8eb; color: #6b7280; }
  .mismatch-badge { background: #fde2e1; color: #c0392b; }
  table.meta { width: 100%; border-collapse: collapse; }
  table.meta th { text-align: left; color: #6b7280; font-weight: 600; width: 150px;
                  vertical-align: top; padding: 3px 8px 3px 0; white-space: nowrap; }
  table.meta td { padding: 3px 0; vertical-align: top; word-break: break-word; }
  table.meta tr.mismatch td { color: #c0392b; font-weight: 700; }
  .muted { color: #9aa1a9; }
  .block-h { color: #6b7280; font-weight: 600; margin: 12px 0 4px; font-size: 12px;
             text-transform: uppercase; letter-spacing: .03em; }
  ol.top3 { margin: 0; padding-left: 20px; }
  ol.top3 li { display: flex; justify-content: space-between; max-width: 280px; }
  .t3-prob { color: #6b7280; }
  .label-opts { display: flex; flex-wrap: wrap; gap: 6px; }
  .label-opt { font-size: 12px; background: #eef1f5; border: 1px solid #dfe3e8;
               border-radius: 6px; padding: 2px 8px; color: #41464c; }
"""


def render_html(events: List[Dict[str, Any]], html_dir: str, dataset_dir: str) -> str:
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    cards = "\n".join(render_card(e, html_dir, dataset_dir) for e in events)
    summary = render_summary(events)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HV Vision — Shadow Review Sheet</title>
<style>{STYLE}</style>
</head>
<body>
  <h1>HV Vision — Shadow Review Sheet</h1>
  <p class="sub">SHADOW / OFFLINE / DEV-ONLY. Static manual-labeling aid — edits are not saved.
     Generated {generated}. Sorted by review priority (high-consequence first, then lower/null confidence).</p>
  {summary}
  <div class="grid">
  {cards}
  </div>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Render the HV vision review queue as a static HTML contact sheet.")
    parser.add_argument("--queue", default=DEFAULT_QUEUE, help="Path to review-queue.jsonl")
    parser.add_argument("--dataset-dir", default=DEFAULT_DATASET_DIR, help="Root dir holding <frame_path> frame.png files")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output review-sheet.html path")
    args = parser.parse_args()

    events = load_queue(args.queue)
    if not events:
        print("no events to render", file=sys.stderr)
        # Still write an (empty) sheet so the output is deterministic.

    events.sort(key=sort_key)

    out_path = os.path.abspath(args.out)
    html_dir = os.path.dirname(out_path)
    dataset_dir = os.path.abspath(args.dataset_dir)
    os.makedirs(html_dir, exist_ok=True)

    html_doc = render_html(events, html_dir, dataset_dir)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html_doc)

    print(f"wrote {out_path} ({len(events)} events)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
