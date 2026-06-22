# Antigen Visual-Judgment Shadow Review Queue

**Status: SHADOW / OFFLINE / DEV-ONLY. Not wired into the Antigen runtime.**

When the activation-gated "visual judgment" seam eventually runs in **shadow mode**,
Antigen needs a clean, privacy-safe place to set aside *candidate examples* — the model's
page-state prediction plus page context, **never raw screenshot bytes** — so a human can
review them and so the dataset can grow for future training.

This document specifies the **review-queue artifact** and the dev tooling that produces it
(`scripts/hv_vision_review_queue.py`). It is part of the offline harness described in
`scripts/HV_VISION_README.md`; nothing here changes production behavior and nothing under
`apps/` imports it.

## Safety boundary (non-negotiable)

- **Page-state classification for human review/training only — NOT CAPTCHA solving.** The
  queue records what *state* a page is in (normal page, normal modal, cookie banner,
  sign-in drawer, newsletter modal, page-level human-verification wall, …). Antigen
  **detects and routes only**. It must never solve, click, press, hold, type into, OCR,
  classify answers for, or bypass CAPTCHA / human verification. The queue must never be
  framed or used as a step toward any of those.
- **Activation-gated.** No activation reason ⇒ no screenshot ⇒ no model call. Antigen never
  continuously watches or classifies the screen. This queue is a **static artifact of
  already-captured candidates**, not a watcher. The script reads frames that were already
  captured under activation gating; it opens no browser and takes no new screenshots.
- **No raw bytes / privacy.** Events store **paths and ids only**, never screenshot bytes.
  `origin_host` is **hostname-only** (no URL path/query). No coordinates, no selectors, no
  page text. Everything lives under the gitignored `dev-artifacts/`.

## Where it lives

```
dev-artifacts/hv-vision-review/
  review-queue.jsonl            # canonical, one review event per line
  review-queue-summary.json     # counts (regenerated each run)
  review-queue.csv              # optional flattened view (--csv)
```

`dev-artifacts/` is gitignored, so the queue and its summary are **never committed**.

## Review-event schema (`hv-vision-review/v0`)

Canonical format is **JSONL** — one JSON object per line:

| field | type | notes |
|---|---|---|
| `schema_version` | string | `"hv-vision-review/v0"` |
| `event_id` | string | stable id; `offline:<candidate_id>` for dataset rows (lets re-runs match) |
| `created_at` | ISO string | preserved across updates |
| `session_id` | string \| null | `null` for offline dataset examples; live browser session id otherwise |
| `activation_reason` | string | why visual judgment was allowed to run; `offline_dataset_backfill` for seeds. In live shadow mode this is the real suspicious-state reason (repeated no-progress, action failure, stale-ref loop, navigation timeout, possible human verification, protected boundary, agent-requested help) |
| `trigger_basis` | string \| null | the visual-candidate basis (e.g. `unreadable_dominant_surface`, `page_level_hv_wall`) |
| `origin_host` | string | **hostname only** |
| `capture_dir` | string | relative dir under the dataset root |
| `frame_path` | string | relative `<capture_dir>/frame.png` — **path only, never bytes** |
| `model_predicted_label` | string \| null | `null` when the queue is built with `--no-model` |
| `model_confidence` | number \| null | top-1 probability, or `null` for no-proba classifiers / `--no-model` |
| `model_top_3` | array | `[{ "label", "prob" }]`; `prob` may be `null`; `[]` under `--no-model` |
| `heuristic_label` | string \| null | reference label. For offline seeds this is the curated dataset `label`; in live shadow mode it would be the rule-based classifier's coarse `blocker_type` |
| `human_label` | string \| null | `null` until a human reviews; the reviewer fills this in |
| `review_status` | enum | `pending` \| `reviewed` \| `skipped` |
| `review_reason` | enum | `low_confidence` \| `heuristic_model_disagreement` \| `new_domain` \| `high_consequence_prediction` \| `sampled_baseline` |
| `notes` | string | operator free-text; `""` on seed |

### Optional CSV view (`--csv`)

`review-queue.csv` is a flattened convenience view with the same columns; `model_top_3` is
serialized as a compact `label:prob|label:prob|...` string. JSONL remains canonical.

## Review-reason semantics

Each event gets **one primary** `review_reason`, chosen by priority (so the by-reason
summary stays clean and a reviewer can triage top-down):

1. `high_consequence_prediction` — predicted label is in the human-verification /
   high-consequence set (`page_level_hv_wall`, `unreadable_hv_overlay`,
   `browser_check_interstitial`, `auth_wall`). These get reviewed regardless of confidence.
   (Under `--no-model`, inferred from `heuristic_label`.)
2. `heuristic_model_disagreement` — `model_predicted_label != heuristic_label`.
3. `low_confidence` — `model_confidence` is null or below `--review-threshold` (default 0.60).
4. `new_domain` — first time this `origin_host` appears (across the existing queue + rows
   processed this run).
5. `sampled_baseline` — fallback for clean / confident / agreeing / known-host rows. Only a
   deterministic **1-in-N sample** is queued (`--sample-baseline-every`, default 5) so
   "sampled_baseline" stays honest; the rest are not queued. `--include-all` queues every
   row (non-flagged ⇒ `sampled_baseline`).

## Offline field-mapping notes

When seeding from the existing redacted dataset (`dev-artifacts/hv-vision-reports/dataset-index.csv`):

- `session_id` = `null` (historical captures, no live session).
- `activation_reason` = `"offline_dataset_backfill"` (these are historical captures, not a
  live activation).
- `heuristic_label` = the dataset's existing curated `label` (used as the reference the
  model is compared against). The `human_label` slot stays `null` so this is a **fresh**
  review pass rather than a claim that the rows are already adjudicated.

## Build / update workflow

The harness venv is set up once per `scripts/HV_VISION_README.md`. Build the queue with:

```bash
dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_review_queue.py
# options:
#   --no-model                 seed without predictions (model fields null)
#   --csv                      also write review-queue.csv
#   --include-all              queue every row (non-flagged => sampled_baseline)
#   --sample-baseline-every N  1-in-N baseline sampling (default 5; 0 disables)
#   --review-threshold 0.60    low_confidence cutoff
```

**Idempotent updates.** Re-running rebuilds the queue from the current dataset + model but
**preserves human work**: for any event whose `event_id` matches an existing line, the
`human_label`, `notes`, and a `reviewed`/`skipped` `review_status` are carried over, while
`created_at` is preserved and the model fields are refreshed. A reviewer can therefore label
by hand-editing `review-queue.jsonl` (set `human_label`, flip `review_status` to `reviewed`
or `skipped`, add `notes`) and safely re-run later.

### Example summary output

```
Total queued: 36
By predicted label:   false_positive_normal_page 12  cookie_banner 7  page_level_hv_wall 7 ...
By review reason:     new_domain 23  high_consequence_prediction 7  heuristic_model_disagreement 6
By confidence bucket: high 32  low 2  medium 2
```

Confidence buckets: `very_low` (<0.4), `low` (0.4–0.6), `medium` (0.6–0.8), `high` (≥0.8),
`none` (null / no-proba classifier / `--no-model`).

> The current dataset is ~38 frames with tiny/singleton classes. Like the rest of the v0
> harness, anything derived from it is **directional, not conclusive**.
