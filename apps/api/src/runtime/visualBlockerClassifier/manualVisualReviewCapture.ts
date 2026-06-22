/**
 * Manual visual-review hard-negative capture (dev/QA-only).
 *
 * Why this exists: the activation-gated runtime judgment seam (`evaluateVisualJudgment`)
 * only records a review event when the snapshot HV gate fires. Benign, visually-useful
 * pages that return a NORMAL snapshot never enter the review/training pipeline, which
 * lets HV bias grow unchecked (dangerous false-HV predictions on ordinary e-commerce/
 * search pages). This module lets a QA operator EXPLICITLY collect such a page as a
 * hard negative — without faking an HV activation.
 *
 * Hard guarantees:
 *   - Dev/QA-only and gated by `ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE`. Off ⇒ no-op,
 *     no I/O, byte-identical.
 *   - EXPLICIT/MANUAL only. There is no watcher and no automatic per-snapshot capture;
 *     the only caller is the flag-gated dev tool/endpoint, invoked by hand.
 *   - NO classifier call. This path collects frames; it never predicts a label
 *     (model_* fields are null/empty at capture).
 *   - Reuses the fail-closed redaction primitive (`captureRedactedScreenshot`) — no
 *     second screenshot path. Bytes live ONLY on disk, never logged/returned.
 *   - Appends ONE safe event to the SAME runtime judgment queue the offline importer
 *     (`scripts/hv_vision_import_runtime_judgments.py`) already folds into
 *     `dataset-index.csv` + `review-queue.jsonl`. This module NEVER writes those two
 *     files itself and never duplicates importer/upsert logic.
 *   - Safe metadata only: hostname (never a full URL/path/query), ids, the sanitized
 *     capture reason, and a repo-relative frame path. `label`/`human_label` empty and
 *     `review_status: "pending"` — labeling and training selection stay human/offline.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveSnapshotCdpTarget } from "../cdpTargetSelection.js";
import { captureRedactedScreenshot } from "../screenshotRedaction.js";
import { isManualVisualReviewCaptureEnabled } from "./flags.js";
import { resolveDevArtifactsRoot, resolveQueuePath } from "./visualJudgment.js";

/** Source tag stamped on manual captures (carried through by the offline importer). */
export const MANUAL_CAPTURE_SOURCE = "manual_visual_review_capture";

/** Safe redacted-screenshot shape (default seam → captureRedactedScreenshot). */
export type ManualCaptureScreenshot = { ok: true; base64: string } | { ok: false };

async function defaultCaptureRedactedFrame(cdpUrl: string): Promise<ManualCaptureScreenshot> {
  const resolved = await resolveSnapshotCdpTarget(cdpUrl);
  if (!resolved) return { ok: false };
  const shot = await captureRedactedScreenshot({
    browserWsUrl: resolved.browserWsUrl,
    pageTargetId: resolved.target.id,
  });
  return shot.ok ? { ok: true, base64: shot.base64 } : { ok: false };
}

export interface ManualVisualReviewCaptureArgs {
  cdpUrl: string | null | undefined;
  /** Hostname only — caller derives from the session's current URL. */
  originHost: string;
  /** Sanitized slug describing why this benign page is a hard negative. */
  captureReason: string;
  /** Optional sanitized free-text basis for the QA decision. */
  manualBasis?: string | null;
  /** Browser session id (recorded for review context only). */
  sessionId?: string | null;
}

export interface ManualVisualReviewCaptureSeams {
  captureRedactedFrame?: (cdpUrl: string) => Promise<ManualCaptureScreenshot>;
  /** Frame output root override (tests). */
  frameRoot?: string;
  /** Queue file override (tests). */
  queuePath?: string;
  /** Clock seam (date dir + created_at). */
  now?: () => Date;
}

export type ManualVisualReviewCaptureResult =
  | {
      captured: true;
      event_id: string;
      origin_host: string;
      capture_reason: string;
      source: string;
      created_at: string;
    }
  | {
      captured: false;
      skip_reason: "flag_disabled" | "no_session" | "redaction_failed" | "write_failed";
    };

/** UTC YYYY-MM-DD date-directory name. */
function dateDir(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Capture one manual hard-negative review candidate. NEVER throws. Off-flag is a no-op.
 * On success returns SAFE metadata only (no path, no bytes, no full URL).
 */
export async function captureManualVisualReviewCandidate(
  args: ManualVisualReviewCaptureArgs,
  seams: ManualVisualReviewCaptureSeams = {},
): Promise<ManualVisualReviewCaptureResult> {
  if (!isManualVisualReviewCaptureEnabled()) return { captured: false, skip_reason: "flag_disabled" };
  if (!args.cdpUrl) return { captured: false, skip_reason: "no_session" };

  const now = seams.now ? seams.now() : new Date();
  const event_id = randomUUID();
  const created_at = now.toISOString();

  // 1. Redacted frame (reused fail-closed primitive). No classifier call.
  let shot: ManualCaptureScreenshot;
  try {
    shot = await (seams.captureRedactedFrame ?? defaultCaptureRedactedFrame)(args.cdpUrl);
  } catch {
    return { captured: false, skip_reason: "redaction_failed" };
  }
  if (!shot.ok) return { captured: false, skip_reason: "redaction_failed" };

  // 2. Persist the redacted frame to the SAME gitignored dev-local layout the
  //    activation-gated judgment seam uses, so the offline importer's _resolve_frame
  //    finds it. The JSONL carries only the repo-root-relative path (incl. the
  //    `dev-artifacts/` segment) — never an absolute path.
  let frameRelPath: string;
  try {
    const devArtifactsRoot = resolveDevArtifactsRoot();
    const root = seams.frameRoot ?? path.join(devArtifactsRoot, "hv-vision-runtime-frames");
    const abs = path.join(root, dateDir(now), event_id, "frame.png");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(shot.base64, "base64"));
    frameRelPath = path.relative(path.dirname(devArtifactsRoot), abs);
  } catch {
    return { captured: false, skip_reason: "write_failed" };
  }

  // 3. Append ONE safe manual event to the runtime judgment queue. The existing
  //    offline importer folds it into the dataset index + review queue (dedup by
  //    event_id, label-empty until a human reviews it). We deliberately do NOT write
  //    dataset-index.csv / review-queue.jsonl here.
  const event = {
    schema_version: "hv-vision-manual-capture/v0",
    event_id,
    created_at,
    session_id: args.sessionId ?? null,
    activation_reason: MANUAL_CAPTURE_SOURCE,
    source: MANUAL_CAPTURE_SOURCE,
    capture_reason: args.captureReason,
    manual_basis: args.manualBasis ?? null,
    trigger_basis: args.manualBasis ?? null,
    origin_host: args.originHost,
    frame_path: frameRelPath,
    // No classifier was run for a manual capture — these stay null/empty.
    model_predicted_label: null,
    model_confidence: null,
    model_top_3: [] as Array<{ label: string; prob: number }>,
    outcome: null,
    runtime_action_taken_by_model: false,
    // Label/training selection are human + offline only.
    human_label: null,
    review_status: "pending" as const,
    review_reason: args.captureReason,
  };
  try {
    const file = seams.queuePath ?? resolveQueuePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    return { captured: false, skip_reason: "write_failed" };
  }

  return {
    captured: true,
    event_id,
    origin_host: args.originHost,
    capture_reason: args.captureReason,
    source: MANUAL_CAPTURE_SOURCE,
    created_at,
  };
}
