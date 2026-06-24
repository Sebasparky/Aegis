#!/usr/bin/env python3
"""VGC release-ready debug crops — offline HTML contact sheet.

OFFLINE / DEV-ONLY operator aid. Renders the crop sequence captured by the
double-flag-gated release-ready debug capture
(`ANTIGEN_HV_DEBUG=true ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS=true`) so an operator
can eyeball, per probe, the EXACT crops the release-ready detector compared —
baseline / previous / current / diff — next to the safe bucketed metadata, and
answer one question after a live B&BW press-and-hold run:

    "Is release-ready judging the actual hold progress control, or is the
     hold-anchor crop too broad / noisy?"

NOTHING here is wired into the Antigen runtime; nothing under apps/ imports it.
It reads the gitignored capture dir and writes a static HTML file. Stdlib only.

Hard rules (same as the rest of the harness):
  1. Offline / dev-only. No runtime imports, no new dependencies, no behavior change.
  2. No raw bytes embedded — references the already-captured *.png by RELATIVE path.
  3. Read-only visual aid. Detect-and-route review only — NEVER used to solve, click,
     press, hold, or bypass CAPTCHA / human verification.

Layout consumed:
  dev-artifacts/vgc-release-ready-debug/<capsule_id>/<probe_id>/
    baseline.png  previous.png?  current.png  diff.png?  meta.json

Usage:
  python3 scripts/vgc_release_ready_debug_sheet.py
  ... --crops-dir <path>   # override capture root
  ... --out <path>         # override output HTML path
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
from typing import Any, Dict, List, Optional

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_SCRIPT_DIR)

DEFAULT_CROPS_DIR = os.path.join(_REPO_ROOT, "dev-artifacts", "vgc-release-ready-debug")
DEFAULT_OUT = os.path.join(_REPO_ROOT, "dev-artifacts", "vgc-release-ready-debug", "debug-sheet.html")

# Frames shown left-to-right per probe row.
FRAME_ORDER = ["baseline", "previous", "current", "diff"]

# Metadata fields rendered per row, in display order.
META_FIELDS = [
    "probe_id",
    "created_at",
    "crop_source",
    "candidate_kind",
    "found",
    "fill_bucket",
    "cumulative_bucket",
    "recent_bucket",
    "strict_strength",
    "temporally_confirmed",
    "consecutive_full",
    "fired",
]


def load_probes(crops_dir: str) -> List[Dict[str, Any]]:
    """Walk <crops_dir>/<capsule_id>/<probe_id>/meta.json. Sort by capsule, then probe."""
    probes: List[Dict[str, Any]] = []
    if not os.path.isdir(crops_dir):
        print(f"error: crops dir not found: {crops_dir}", file=sys.stderr)
        return probes
    for capsule_id in sorted(os.listdir(crops_dir)):
        cap_dir = os.path.join(crops_dir, capsule_id)
        if not os.path.isdir(cap_dir):
            continue
        for probe_id in sorted(os.listdir(cap_dir)):
            probe_dir = os.path.join(cap_dir, probe_id)
            meta_path = os.path.join(probe_dir, "meta.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, json.JSONDecodeError) as exc:
                print(f"warning: skipping {meta_path}: {exc}", file=sys.stderr)
                continue
            probes.append({"capsule_id": capsule_id, "probe_dir": probe_dir, "meta": meta})
    return probes


def probe_sort_key(p: Dict[str, Any]):
    pid = str(p["meta"].get("probe_id", ""))
    return (p["capsule_id"], pid)


def frame_img(probe_dir: str, html_dir: str, name: str) -> str:
    abs_png = os.path.join(probe_dir, f"{name}.png")
    if not os.path.exists(abs_png):
        return f"<div class='frame missing'><div class='frame-h'>{name}</div><div class='muted'>—</div></div>"
    rel = os.path.relpath(abs_png, html_dir).replace(os.sep, "/")
    return (
        f"<div class='frame'><div class='frame-h'>{name}</div>"
        f"<img loading='lazy' src='{html.escape(rel)}' alt='{name}'></div>"
    )


def render_meta(meta: Dict[str, Any]) -> str:
    rows = []
    for field in META_FIELDS:
        val = meta.get(field)
        disp = "<span class='muted'>—</span>" if val is None else html.escape(str(val))
        rows.append(f"<tr><th>{field}</th><td>{disp}</td></tr>")
    return "<table class='meta'>" + "".join(rows) + "</table>"


def render_row(probe: Dict[str, Any], html_dir: str) -> str:
    meta = probe["meta"]
    frames = "".join(frame_img(probe["probe_dir"], html_dir, n) for n in FRAME_ORDER)
    fired = bool(meta.get("fired"))
    badge = "<span class='badge fired'>fired</span>" if fired else "<span class='badge'>holding</span>"
    return f"""
    <article class="row">
      <div class="row-head">
        <span class="cap">{html.escape(str(probe['capsule_id']))}</span>
        <span class="pid">#{html.escape(str(meta.get('probe_id', '?')))}</span>
        {badge}
      </div>
      <div class="row-body">
        <div class="frames">{frames}</div>
        <div class="meta-block">{render_meta(meta)}</div>
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
  .row { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; margin-bottom: 18px;
         overflow: hidden; }
  .row-head { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
              border-bottom: 1px solid #eef1f5; background: #fafbfc; }
  .cap { font-weight: 600; }
  .pid { color: #6b7280; font-variant-numeric: tabular-nums; }
  .badge { margin-left: auto; font-size: 11px; font-weight: 700; text-transform: uppercase;
           letter-spacing: .03em; padding: 2px 8px; border-radius: 6px; background: #e6e8eb; color: #6b7280; }
  .badge.fired { background: #fde2e1; color: #c0392b; }
  .row-body { display: flex; gap: 18px; padding: 14px 16px; flex-wrap: wrap; }
  .frames { display: flex; gap: 10px; flex-wrap: wrap; }
  .frame { width: 200px; }
  .frame-h { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: #6b7280;
             margin-bottom: 4px; }
  .frame img { width: 100%; height: auto; display: block; border: 1px solid #e3e6ea; border-radius: 6px;
               background: #11151a; }
  .frame.missing { color: #9aa1a9; }
  .meta-block { min-width: 260px; }
  table.meta { border-collapse: collapse; }
  table.meta th { text-align: left; color: #6b7280; font-weight: 600; padding: 2px 10px 2px 0;
                  white-space: nowrap; vertical-align: top; }
  table.meta td { padding: 2px 0; font-variant-numeric: tabular-nums; }
  .muted { color: #9aa1a9; }
"""


def render_html(probes: List[Dict[str, Any]], html_dir: str) -> str:
    rows = "\n".join(render_row(p, html_dir) for p in probes)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VGC Release-Ready — Debug Crop Sheet</title>
<style>{STYLE}</style>
</head>
<body>
  <h1>VGC Release-Ready — Debug Crop Sheet</h1>
  <p class="sub">OFFLINE / DEV-ONLY. Each row is one release-ready probe: baseline / previous /
     current / diff next to the bucketed read. Use it to check whether the crop actually
     contains the press-and-hold control, or is too broad / noisy. {len(probes)} probe(s).</p>
  {rows if probes else "<p class='muted'>no probes captured</p>"}
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Render captured release-ready debug crops as a static HTML sheet.")
    parser.add_argument("--crops-dir", default=DEFAULT_CROPS_DIR, help="Capture root (<capsule_id>/<probe_id>/)")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output HTML path")
    args = parser.parse_args()

    probes = load_probes(args.crops_dir)
    probes.sort(key=probe_sort_key)

    out_path = os.path.abspath(args.out)
    html_dir = os.path.dirname(out_path)
    os.makedirs(html_dir, exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(render_html(probes, html_dir))

    print(f"wrote {out_path} ({len(probes)} probes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
