// ─── VGC hold — model-informed presence (ADVISORY status only) ───────────────
//
// A thin wrapper over the EXISTING visual-judgment sidecar seam, used during an
// active press-and-hold to INFORM the live handoff status text ("verification
// still active" vs "looks complete — checking…"). It reuses the same trained
// local classifier the snapshot HV gate uses (captureRedactedScreenshot +
// callVisualJudgmentSidecar) — no second model path, no Anthropic API.
//
// ── BOUNDARY (load-bearing) ──────────────────────────────────────────────────
// This is ADVISORY ONLY. It NEVER releases a hold, clears a capsule, or resumes
// the agent. The conservative DOM probe + recheck + 20s ceiling remain the sole
// authority on completion. A `looks_clear` verdict here only drives the advisory
// `looks_complete_checking` status; it must never set agent_should_wait = false.
//
// Isolated in its own module so visualGestureCapsuleHold.ts can use the model
// seam without pulling the capture/sidecar value-import graph into a cycle.
//
// Flag-gated: when ANTIGEN_VISUAL_JUDGMENT_ENABLED is off this returns
// `{ available: false, verdict: "uncertain" }` immediately — no capture, no
// sidecar call — so the in-hold loop stays byte-identical to today (DOM-only).
//
// SAFETY: captures a REDACTED frame (the same fail-closed primitive), writes it
// to a private temp file ONLY long enough for the sidecar to read it, then
// deletes it. Returns only a coarse verdict + the model's label/confidence —
// never bytes, paths, coordinates, or page text.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveSnapshotCdpTarget } from "./cdpTargetSelection.js";
import { captureRedactedScreenshot } from "./screenshotRedaction.js";
import {
  BENIGN_LABELS,
  HV_WALL_LABEL,
  callVisualJudgmentSidecar,
  getVisualJudgmentBenignThreshold,
  getVisualJudgmentHvThreshold,
  isVisualJudgmentEnabled,
} from "./visualBlockerClassifier/visualJudgment.js";

/** Coarse advisory verdict consumed by the in-hold status enrichment. */
export type VgcHoldModelVerdict = "wall_present" | "looks_clear" | "uncertain";

export interface VgcHoldModelResult {
  /** True only when the model actually produced a usable result this call. */
  available: boolean;
  verdict: VgcHoldModelVerdict;
  /** Model label enum (e.g. "page_level_hv_wall") — never raw page text. */
  model_label?: string;
  model_confidence?: number;
}

/** In-memory redacted-frame shot (matches visualJudgment.ts's seam shape). */
type HoldFrameShot = { ok: true; base64: string } | { ok: false };

export interface VgcHoldClassifierSeams {
  /** Capture a redacted frame (default: CDP target resolve + captureRedactedScreenshot). */
  captureRedactedFrame?: (cdpUrl: string) => Promise<HoldFrameShot>;
  /** Ask the sidecar with an on-disk frame path (default: callVisualJudgmentSidecar). */
  callSidecar?: typeof callVisualJudgmentSidecar;
}

async function defaultCaptureRedactedFrame(cdpUrl: string): Promise<HoldFrameShot> {
  const resolved = await resolveSnapshotCdpTarget(cdpUrl);
  if (!resolved) return { ok: false };
  const shot = await captureRedactedScreenshot({
    browserWsUrl: resolved.browserWsUrl,
    pageTargetId: resolved.target.id,
  });
  return shot.ok ? { ok: true, base64: shot.base64 } : { ok: false };
}

const UNAVAILABLE: VgcHoldModelResult = { available: false, verdict: "uncertain" };

/**
 * Run ONE advisory model presence judgment for an active hold. NEVER throws; any
 * failure (flag off, capture fail, sidecar down/timeout, unusable label) returns
 * `{ available: false, verdict: "uncertain" }` so the caller falls back to the
 * conservative DOM probe. Conservative mapping (fail toward "wall_present"/
 * "uncertain", never a premature "looks_clear"):
 *   - page_level_hv_wall  & conf ≥ HV threshold     → wall_present
 *   - a benign label      & conf ≥ benign threshold → looks_clear
 *   - otherwise (incl. null / low conf)              → uncertain
 */
export async function classifyHoldPresenceViaModel(args: {
  cdpUrl: string;
  seams?: VgcHoldClassifierSeams;
}): Promise<VgcHoldModelResult> {
  if (!isVisualJudgmentEnabled()) return UNAVAILABLE;

  const captureFrame = args.seams?.captureRedactedFrame ?? defaultCaptureRedactedFrame;
  const callSidecar = args.seams?.callSidecar ?? callVisualJudgmentSidecar;

  let tmpPath: string | undefined;
  try {
    const shot = await captureFrame(args.cdpUrl);
    if (!shot.ok) return UNAVAILABLE;

    // The sidecar reads a path; write the redacted bytes to a private temp file
    // for the duration of the call only, then delete (finally). Never logged.
    tmpPath = path.join(os.tmpdir(), `aegis-vgc-hold-${randomUUID()}.png`);
    fs.writeFileSync(tmpPath, Buffer.from(shot.base64, "base64"));

    const result = await callSidecar(tmpPath);
    if (!result) return UNAVAILABLE;

    const label = result.predictedLabel;
    const confidence = typeof result.confidence === "number" ? result.confidence : 0;

    let verdict: VgcHoldModelVerdict = "uncertain";
    if (label === HV_WALL_LABEL && confidence >= getVisualJudgmentHvThreshold()) {
      verdict = "wall_present";
    } else if (
      (BENIGN_LABELS as readonly string[]).includes(label) &&
      confidence >= getVisualJudgmentBenignThreshold()
    ) {
      verdict = "looks_clear";
    }

    return {
      available: true,
      verdict,
      ...(typeof label === "string" ? { model_label: label } : {}),
      ...(Number.isFinite(confidence) ? { model_confidence: confidence } : {}),
    };
  } catch {
    return UNAVAILABLE;
  } finally {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}
