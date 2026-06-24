// ─── Visual HV Handoff Monitor — model-driven live status + completion ────────
//
// The capsule-lifecycle visual polling loop. While a Visual Gesture Capsule (VGC)
// is active, this polls the SAME trained local visual classifier the snapshot HV
// gate uses (classifyHoldPresenceViaModel → redacted screenshot + localhost
// sidecar) about every 500ms and drives the live handoff status. It is the SINGLE
// COMPLETION AUTHORITY when ANTIGEN_HV_VISUAL_HANDOFF is on: the only place that
// marks a visual/opaque capsule `cleared` and publishes `completed`.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Bot-protection providers render the press-and-hold / challenge inside protected
// cross-origin/opaque iframes the host DOM cannot see. The DOM presence probe
// therefore returns a false "absent" for a wall that is still visually present,
// which previously published `completed` while the wall was up (the
// `challenge_gone_at_start` bug). The visual model judges the RENDERED screen, so
// it is the correct primary signal; the DOM is demoted to auxiliary/debug.
//
// ── LIFECYCLE & SAFETY (load-bearing) ────────────────────────────────────────
// - Polling starts ONLY after a VGC is minted and stops HARD on
//   completed/expired/cancelled (or a missing capsule). It is NOT continuous
//   monitoring of normal browsing — no VGC ⇒ no loop.
//   TODO(ui-start-gate): once the Antigen UI exposes a "Start verification"
//   button, move the polling START from mint-time to Start-click time.
// - In-flight guard: never overlap screenshot/model calls. If a model call is
//   still running when a tick fires, the tick is skipped.
// - Completion requires a STABLE visual clear (VGC_STABLE_CLEAR_CONSECUTIVE
//   consecutive confident-benign checks, no intervening wall_present) — never a
//   single frame, never a DOM signal.
// - No OCR, no site/challenge-text hardcode, no auto-solve/click/press/hold/type.
//   The model only judges; the only press is the user's gated hold (hold module).
// - Memory-only, fail-soft, safe-fields-only. The loop never throws into a timer;
//   published updates carry only enums/booleans/ids/hostname — never cdp_url,
//   coordinates, bytes, frame paths, page text, selectors, or secrets.
//
// Gated behind ANTIGEN_HV_VISUAL_HANDOFF (default off). When off this module is
// inert (no monitor is ever started) and behavior is byte-identical to today.

import {
  getVisualGestureCapsule,
  isTerminalVisualGestureStatus,
  markGestureCapsuleCleared,
} from "./visualGestureCapsule.js";
import { getTaskBrowserSessionCdpUrl } from "./taskBrowserSessions.js";
import {
  publishHvHandoffUpdate,
  type HvHandoffPhase,
} from "./humanVerificationHandoff.js";
import {
  classifyHoldPresenceViaModel,
  type VgcHoldModelResult,
} from "./visualGestureCapsuleHoldClassifier.js";
import { isVisualJudgmentEnabled } from "./visualBlockerClassifier/visualJudgment.js";
import {
  validateAndPadCropWithReason,
  type CropInvalidReason,
  type CropBuckets,
} from "./visualBlockerClassifier/datasetCapture.js";
import { logHvDebug } from "./humanVerificationState.js";
import { resolveSnapshotCdpTarget } from "./cdpTargetSelection.js";
import {
  captureRedactedScreenshot,
  computeBlockerCropBox,
  computeInnerControlCropBox,
  cropPng,
  type BlockerCropBox,
} from "./screenshotRedaction.js";
import {
  type ProgressFillEstimate,
  type ReleaseReadyBand,
} from "./visualReleaseReadyDetector.js";
import {
  estimateReleaseReadyWithWholeCropFallback,
  clearWholeCropProgress,
} from "./visualReleaseReadyWholeCrop.js";

// ─── Flag ─────────────────────────────────────────────────────────────────────

/**
 * Visual-model-driven HV handoff live status + completion. Default OFF.
 *
 * Deliberately ALSO requires the visual judgment model to be enabled: without an
 * available model the loop could never confirm a stable clear, so a capsule could
 * never auto-complete. Requiring both keeps this INERT (and the existing
 * DOM-driven completion intact, byte-identical) unless the model is genuinely
 * available to be the primary signal.
 */
export function isVisualHvHandoffEnabled(): boolean {
  return process.env.ANTIGEN_HV_VISUAL_HANDOFF === "true" && isVisualJudgmentEnabled();
}

/**
 * Release-ready visual sub-state. Default OFF and ALSO requires the visual
 * handoff loop (this module only runs then). When off, the `still_active` path is
 * byte-identical to today: no capture, no crop, no probe, no `release_ready`.
 */
export function isReleaseReadyEnabled(): boolean {
  return process.env.ANTIGEN_HV_RELEASE_READY === "true" && isVisualHvHandoffEnabled();
}

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Visual model poll cadence while a VGC handoff is active (~500ms). */
export const VGC_HANDOFF_MODEL_POLL_INTERVAL_MS = 500;

/**
 * Consecutive confident-benign model checks required to publish `completed`. A
 * single benign frame is NOT enough (a wall can flicker / re-render); the streak
 * resets on anything that is not a confident clear (wall_present / uncertain /
 * unavailable), so only a clean run of consecutive clears completes.
 */
export const VGC_STABLE_CLEAR_CONSECUTIVE = 2;

// ─── Pure stable-clear state machine (unit-tested core) ───────────────────────

/** Coarse per-tick verdict, derived from the advisory model result. */
export type VgcHandoffVerdict = "wall_present" | "looks_clear" | "uncertain" | "unavailable";

/** Next handoff action for a verdict, given the current consecutive-clear streak. */
export type VgcHandoffAction = "complete" | "still_active" | "checking" | "wait";

/**
 * Advance the stable-clear streak. `looks_clear` increments the streak and
 * completes once it reaches VGC_STABLE_CLEAR_CONSECUTIVE; the first clear only
 * arms `checking` (looks_complete_checking, still waiting). Everything else
 * RESETS the streak (fail-closed): `wall_present` → still_active,
 * `uncertain`/`unavailable` → keep waiting. Pure; exported for direct testing.
 */
export function advanceStableClear(
  consecutiveClear: number,
  verdict: VgcHandoffVerdict,
): { consecutiveClear: number; action: VgcHandoffAction } {
  if (verdict === "looks_clear") {
    const n = consecutiveClear + 1;
    return n >= VGC_STABLE_CLEAR_CONSECUTIVE
      ? { consecutiveClear: n, action: "complete" }
      : { consecutiveClear: n, action: "checking" };
  }
  if (verdict === "wall_present") return { consecutiveClear: 0, action: "still_active" };
  // uncertain / unavailable → keep waiting; never complete; reset the streak.
  return { consecutiveClear: 0, action: "wait" };
}

/** Reduce the advisory model result to a coarse verdict (unavailable when no usable result). */
export function verdictFromModelResult(r: VgcHoldModelResult): VgcHandoffVerdict {
  if (!r.available) return "unavailable";
  if (r.verdict === "wall_present") return "wall_present";
  if (r.verdict === "looks_clear") return "looks_clear";
  return "uncertain";
}

// ─── Release-ready (full-bar) detection — pure core ───────────────────────────

/** Fill ratio at/above which a press-and-hold bar reads "full". */
export const FULL_RATIO_THRESHOLD = 0.92;

/** Consecutive full-and-stable frames required to publish `release_ready`. */
export const VGC_RELEASE_READY_CONSECUTIVE = 2;

/**
 * Min spacing between release-ready capture+probe attempts. The capture and the
 * blocker-box probe each open their OWN short-lived CDP connection (separate from
 * the model poll), so we run them at most this often rather than every ~500ms tick.
 */
export const VGC_RELEASE_READY_PROBE_INTERVAL_MS = 750;

/**
 * Cross-frame band overlap (position stability): same vertical center (±0.1) and a
 * horizontal IoU ≥ 0.5. Rejects a spinner / animated region whose bright band
 * jumps between frames. Bands are crop fractions, so this is frame-size independent.
 */
export function releaseReadyBandsOverlap(a: ReleaseReadyBand, b: ReleaseReadyBand): boolean {
  if (Math.abs(a.y_center - b.y_center) > 0.1) return false;
  const interLeft = Math.max(a.x0, b.x0);
  const interRight = Math.min(a.x1, b.x1);
  const inter = Math.max(0, interRight - interLeft);
  const union = Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0);
  return union > 0 && inter / union >= 0.5;
}

/**
 * Advance the consecutive-full streak. A frame counts toward the streak ONLY when
 * a bar was found, its fill ratio ≥ FULL_RATIO_THRESHOLD, and its band overlaps the
 * previous frame's band (the first full frame has no reference and counts as 1).
 * Anything else resets the streak (fail-closed): a non-full frame still carries its
 * band forward so the next frame's overlap test has a reference; a not-found frame
 * clears the reference. `fire` is true once the streak reaches the threshold. Pure.
 */
export function advanceReleaseReady(
  consecutiveFull: number,
  lastBand: ReleaseReadyBand | undefined,
  estimate: ProgressFillEstimate,
): { consecutiveFull: number; lastBand: ReleaseReadyBand | undefined; fire: boolean } {
  if (!estimate.found || estimate.fill_ratio === undefined || !estimate.band) {
    return { consecutiveFull: 0, lastBand: undefined, fire: false };
  }
  const band = estimate.band;
  if (estimate.fill_ratio < FULL_RATIO_THRESHOLD) {
    // Not full yet — reset the streak but keep the band as the overlap reference.
    return { consecutiveFull: 0, lastBand: band, fire: false };
  }
  const stable = lastBand ? releaseReadyBandsOverlap(lastBand, band) : true;
  const next = stable ? consecutiveFull + 1 : 1;
  // A temporally-confirmed estimate (the whole-crop plateau fallback) has already
  // established cross-frame stability internally, so it fires on its first full frame.
  // The instantaneous per-shape detector still needs VGC_RELEASE_READY_CONSECUTIVE.
  const required = estimate.temporally_confirmed ? 1 : VGC_RELEASE_READY_CONSECUTIVE;
  return { consecutiveFull: next, lastBand: band, fire: next >= required };
}

/** Coarse fill bucket for safe telemetry (never the raw ratio). */
function fillBucket(ratio: number | undefined): string {
  if (ratio === undefined) return "none";
  if (ratio < 0.5) return "lt50";
  if (ratio < 0.75) return "50_75";
  if (ratio < FULL_RATIO_THRESHOLD) return "75_92";
  return "ge92";
}

/**
 * Read a PNG's pixel width/height from its IHDR header only — no full decode. Returns
 * null on any malformed/short buffer. Used solely to derive coarse diagnostic buckets;
 * the exact dimensions never leave this function or get logged.
 */
function readPngPixelSize(base64: string): { w: number; h: number } | null {
  try {
    const buf = Buffer.from(base64, "base64");
    // PNG: 8-byte signature, then IHDR length(4)+type(4), then width(4)@16, height(4)@20.
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (!(w > 0) || !(h > 0)) return null;
    return { w, h };
  } catch {
    return null;
  }
}

/** PNG pixel width vs CSS viewport width → coarse size relationship (no raw sizes). */
function screenshotSizeBucket(pngW: number | undefined, vw: number): string {
  if (!pngW || !Number.isFinite(pngW) || !Number.isFinite(vw) || vw <= 0) return "unknown";
  const ratio = pngW / vw;
  if (ratio >= 0.95 && ratio <= 1.05) return "matches_viewport";
  return ratio > 1 ? "larger_than_viewport" : "smaller_than_viewport";
}

/** PNG-to-CSS scale relationship → coarse devicePixelRatio bucket (no raw sizes). */
function scaleBucket(pngW: number | undefined, vw: number): string {
  if (!pngW || !Number.isFinite(pngW) || !Number.isFinite(vw) || vw <= 0) return "unknown";
  const ratio = pngW / vw;
  if (ratio >= 0.95 && ratio <= 1.05) return "css";
  if (ratio >= 1.9 && ratio <= 2.1) return "screenshot";
  if (ratio > 1.05) return "upscaled";
  return "mismatch_suspected";
}

// ─── Release-ready probe seam (active hold + capture + crop + detect) ──────────

/** Predicate: is a live, unreleased press-hold active for this capsule? */
export type HoldActiveProbe = (capsuleId: string) => boolean;
let holdActiveProbe: HoldActiveProbe | undefined;

/**
 * Register the "is a hold active?" predicate. The hold module registers
 * `hasLiveVgcHoldSession` at load so the monitor never imports it (no cycle). When
 * unset, the release-ready detector never runs (fail-closed: no press ⇒ no nudge).
 */
export function registerVgcHoldActiveProbe(probe: HoldActiveProbe): void {
  holdActiveProbe = probe;
}

/**
 * Predicate: the live hold's anchor (the user's actual press point) + viewport, or
 * undefined when no live hold / no frame. The hold module registers this at load (same
 * no-cycle seam as the active-hold probe). The point is the STRONGEST evidence of where
 * the press-and-hold control is, so release-ready crops around it first. CSS viewport px
 * — the raw point NEVER leaves this seam; only `point_bucket` is safe to log.
 */
export type HoldAnchorProbe = (
  capsuleId: string,
) => { point: { x: number; y: number }; viewport: { vw: number; vh: number }; point_bucket: string } | undefined;
let holdAnchorProbe: HoldAnchorProbe | undefined;

/** Register the hold-anchor resolver. When unset, the hold-anchor crop path is skipped
 *  (the release-ready fallback degrades to DOM inner-control / center-region). */
export function registerVgcHoldAnchorProbe(probe: HoldAnchorProbe): void {
  holdAnchorProbe = probe;
}

/** A full release-ready estimate for a session: capture → crop → detect. Async. */
export type ReleaseReadyProbe = (cdpUrl: string, capsuleId: string) => Promise<ProgressFillEstimate>;

// ─── Release-ready crop selection (pure; hold-anchor first) ───────────────────

/** Coarse candidate-count bucket for safe telemetry (never the raw count). */
export function cropCandidateCountBucket(n: number): "0" | "1" | "2_4" | "5_plus" {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 4) return "2_4";
  return "5_plus";
}

/** Which strategy produced the selected release-ready crop (safe enum, loggable). */
export type SelectedCropSource = "dominant_surface" | "hold_anchor" | "inner_control" | "center_region";

/** A chosen release-ready crop: rect (CSS viewport px) + the viewport it is expressed in
 *  (so the caller scales correctly under any deviceScaleFactor) + safe enums. */
export interface ReleaseReadyCropSelection {
  rect: { x: number; y: number; w: number; h: number };
  viewport: { vw: number; vh: number };
  source: SelectedCropSource;
  size_bucket: CropBuckets["box_size_bucket"];
}

/** Candidate inputs for `selectReleaseReadyCrop`, resolved by the caller (no I/O here). */
export interface ReleaseReadyCropCandidates {
  /** The live hold's press point + its viewport (CSS px). Strongest signal. */
  holdAnchor?: { point: { x: number; y: number }; viewport: { vw: number; vh: number } };
  /** A DOM inner-control box found inside the dominant surface (fallback). */
  innerControl?: BlockerCropBox | null;
}

// Hold-anchor crop: a compact region centered on the user's press point — sized to
// capture a press/hold ring or bar, NOT the whole modal. Viewport-fraction with px
// floor/ceiling so it is the control regardless of viewport. CSS viewport px.
const HOLD_ANCHOR_W_FRACTION = 0.35;
const HOLD_ANCHOR_H_FRACTION = 0.3;
const HOLD_ANCHOR_MIN_W = 220;
const HOLD_ANCHOR_MIN_H = 160;
const HOLD_ANCHOR_MAX_W = 460;
const HOLD_ANCHOR_MAX_H = 320;
// Geometric center-region fallback: a centered sub-rect of the (oversized) dominant box.
const CENTER_REGION_W_FRACTION = 0.6;
const CENTER_REGION_H_FRACTION = 0.45;

function clampDim(frac: number, vp: number, min: number, max: number): number {
  const d = frac * vp;
  // Never exceed the viewport edge (a tiny viewport could be smaller than `min`).
  return Math.min(vp, Math.max(min, Math.min(max, d)));
}

/** Box centered on the hold point, clamped into the viewport (CSS px). */
export function holdAnchorCropBox(
  point: { x: number; y: number },
  viewport: { vw: number; vh: number },
): { x: number; y: number; w: number; h: number } {
  const w = clampDim(HOLD_ANCHOR_W_FRACTION, viewport.vw, HOLD_ANCHOR_MIN_W, HOLD_ANCHOR_MAX_W);
  const h = clampDim(HOLD_ANCHOR_H_FRACTION, viewport.vh, HOLD_ANCHOR_MIN_H, HOLD_ANCHOR_MAX_H);
  const x = Math.max(0, Math.min(point.x - w / 2, viewport.vw - w));
  const y = Math.max(0, Math.min(point.y - h / 2, viewport.vh - h));
  return { x, y, w, h };
}

/** Centered sub-rect of a (too-large) dominant box (CSS px). */
function centerRegionBox(box: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; w: number; h: number } {
  const w = box.w * CENTER_REGION_W_FRACTION;
  const h = box.h * CENTER_REGION_H_FRACTION;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * Choose the release-ready crop. Priority: a valid+tight DOMINANT crop wins (today's
 * path). Only when the dominant box is rejected SPECIFICALLY for being too large do we
 * fall back to a tighter region: the user's HOLD ANCHOR first (direct evidence of the
 * control, robust to opaque iframes), then a DOM INNER-CONTROL box, then a geometric
 * CENTER-REGION of the dominant box. Any other dominant rejection (invalid geometry, too
 * small) returns null — we never fabricate a crop from unusable geometry. PURE: no I/O,
 * candidates supplied by the caller; fully unit-testable. No coordinate is ever logged.
 */
export function selectReleaseReadyCrop(
  dominant: BlockerCropBox,
  candidates: ReleaseReadyCropCandidates,
): { selection: ReleaseReadyCropSelection | null; dominantReason: CropInvalidReason } {
  const dv = validateAndPadCropWithReason({
    box: dominant.box,
    viewport: dominant.viewport,
    source: "capture_reprobe",
  });
  if (dv.crop) {
    return {
      selection: {
        rect: dv.crop,
        viewport: dominant.viewport,
        source: "dominant_surface",
        size_bucket: dv.buckets.box_size_bucket,
      },
      dominantReason: dv.reason,
    };
  }
  // Only an OVERSIZED dominant crop is rescuable by a tighter region.
  if (dv.reason !== "box_too_large") {
    return { selection: null, dominantReason: dv.reason };
  }

  // 1. Hold anchor — the strongest signal (where the user is actually pressing).
  if (candidates.holdAnchor) {
    const vp = candidates.holdAnchor.viewport;
    const v = validateAndPadCropWithReason({
      box: holdAnchorCropBox(candidates.holdAnchor.point, vp),
      viewport: vp,
      source: "capture_reprobe",
    });
    if (v.crop) {
      return {
        selection: { rect: v.crop, viewport: vp, source: "hold_anchor", size_bucket: v.buckets.box_size_bucket },
        dominantReason: dv.reason,
      };
    }
  }

  // 2. DOM inner-control box found inside the dominant surface.
  if (candidates.innerControl) {
    const ic = candidates.innerControl;
    const v = validateAndPadCropWithReason({ box: ic.box, viewport: ic.viewport, source: "capture_reprobe" });
    if (v.crop) {
      return {
        selection: {
          rect: v.crop,
          viewport: ic.viewport,
          source: "inner_control",
          size_bucket: v.buckets.box_size_bucket,
        },
        dominantReason: dv.reason,
      };
    }
  }

  // 3. Geometric centered sub-region of the dominant box.
  const cr = validateAndPadCropWithReason({
    box: centerRegionBox(dominant.box),
    viewport: dominant.viewport,
    source: "capture_reprobe",
  });
  if (cr.crop) {
    return {
      selection: {
        rect: cr.crop,
        viewport: dominant.viewport,
        source: "center_region",
        size_bucket: cr.buckets.box_size_bucket,
      },
      dominantReason: dv.reason,
    };
  }

  return { selection: null, dominantReason: dv.reason };
}

/**
 * Default release-ready probe. Reuses the fail-closed redaction + blocker-crop
 * primitives (the same path dataset capture uses): resolve target → redacted
 * screenshot → blocker crop box → SELECT a tight crop (hold-anchor first, then DOM
 * inner-control, then center-region when the dominant surface is oversized) → crop →
 * pixel detector. Any failure returns `{ found:false }`. Geometry stays internal; only a
 * coarse estimate leaves. The hold-anchor lookup is a cheap in-memory probe; the DOM
 * inner-control probe (its own CDP socket) runs ONLY when there is no hold to anchor on.
 */
async function defaultReleaseReadyProbe(cdpUrl: string, capsuleId: string): Promise<ProgressFillEstimate> {
  // Diagnostic-only: a fixed-enum `stage` marker at each fail-closed early return
  // proves whether the detector wrapper is reached and, if not, exactly which probe
  // stage bails. Safe by construction — `stage` is a closed enum string; no pixels,
  // crop boxes, coordinates, target ids, URLs, or image data. `logHvDebug` no-ops
  // unless ANTIGEN_HV_DEBUG=true, so this is byte-neutral when debug is off and never
  // alters monitor lifecycle, cadence, completion, hold state, or streak logic.
  try {
    const resolved = await resolveSnapshotCdpTarget(cdpUrl);
    if (!resolved) {
      logHvDebug({ scope: "vgc_release_ready_probe", stage: "no_cdp_target" });
      return { found: false };
    }
    const shot = await captureRedactedScreenshot({
      browserWsUrl: resolved.browserWsUrl,
      pageTargetId: resolved.target.id,
    });
    if (!shot.ok) {
      logHvDebug({ scope: "vgc_release_ready_probe", stage: "screenshot_not_ok" });
      return { found: false };
    }
    const found = await computeBlockerCropBox({
      browserWsUrl: resolved.browserWsUrl,
      pageTargetId: resolved.target.id,
    });
    if (!found) {
      logHvDebug({ scope: "vgc_release_ready_probe", stage: "no_crop_box" });
      return { found: false };
    }

    // Validate the dominant box once. When it is rejected SPECIFICALLY for being too
    // large, resolve tighter candidates in priority order: the live HOLD ANCHOR first
    // (a cheap in-memory lookup, the strongest signal), and ONLY when there is no hold to
    // anchor on do we pay the extra CDP socket for a DOM inner-control probe.
    const dominantCheck = validateAndPadCropWithReason({
      box: found.box,
      viewport: found.viewport,
      source: "capture_reprobe",
    });
    let holdAnchor: ReleaseReadyCropCandidates["holdAnchor"];
    let holdAnchorPointBucket: string | undefined;
    let innerControl: BlockerCropBox | null = null;
    let candidateCount = 0;
    if (!dominantCheck.crop && dominantCheck.reason === "box_too_large") {
      const anchor = holdAnchorProbe?.(capsuleId);
      if (anchor) {
        holdAnchor = { point: anchor.point, viewport: anchor.viewport };
        holdAnchorPointBucket = anchor.point_bucket;
      } else {
        const inner = await computeInnerControlCropBox({
          browserWsUrl: resolved.browserWsUrl,
          pageTargetId: resolved.target.id,
          within: found.box,
        });
        innerControl = inner.best;
        candidateCount = inner.candidate_count;
      }
    }

    const { selection } = selectReleaseReadyCrop(found, { holdAnchor, innerControl });
    if (!selection) {
      // Keep the original coarse marker (continuity), then add a richer, fixed-enum
      // breakdown of WHY no crop could be selected. All fields are closed enums / coarse
      // buckets — no raw coordinates, dimensions, sizes, pixels, or image data.
      logHvDebug({ scope: "vgc_release_ready_probe", stage: "crop_invalid" });
      const pngSize = readPngPixelSize(shot.base64);
      logHvDebug({
        scope: "vgc_release_ready_crop",
        crop_invalid_reason: dominantCheck.reason,
        dominant_rejection_reason_bucket: dominantCheck.reason,
        hold_anchor_available: holdAnchor !== undefined,
        candidate_count_bucket: cropCandidateCountBucket(candidateCount),
        box_source_bucket: dominantCheck.buckets.box_source_bucket,
        box_size_bucket: dominantCheck.buckets.box_size_bucket,
        box_position_bucket: dominantCheck.buckets.box_position_bucket,
        viewport_size_bucket: dominantCheck.buckets.viewport_size_bucket,
        screenshot_size_bucket: screenshotSizeBucket(pngSize?.w, found.viewport.vw),
        scale_bucket: scaleBucket(pngSize?.w, found.viewport.vw),
      });
      return { found: false };
    }

    logHvDebug({
      scope: "vgc_release_ready_crop",
      stage: "candidate_crop_selected",
      selected_crop_source_bucket: selection.source,
      selected_crop_size_bucket: selection.size_bucket,
      dominant_rejection_reason_bucket: dominantCheck.crop ? "none" : dominantCheck.reason,
      hold_anchor_available: holdAnchor !== undefined,
      ...(holdAnchorPointBucket ? { hold_anchor_point_bucket: holdAnchorPointBucket } : {}),
      ...(selection.source === "inner_control"
        ? { candidate_count_bucket: cropCandidateCountBucket(candidateCount) }
        : {}),
    });

    let cropped: string;
    try {
      // Scale CSS-px rect → image px using the viewport the rect is expressed in, so an
      // upscaled (HiDPI) screenshot crops the correct region (cropPng does the scaling).
      cropped = cropPng(shot.base64, selection.rect, selection.viewport);
    } catch {
      logHvDebug({ scope: "vgc_release_ready_probe", stage: "crop_threw" });
      return { found: false };
    }
    logHvDebug({ scope: "vgc_release_ready_probe", stage: "detector_invoked" });
    // Per-shape detector first; only a `hold_anchor` crop with no sub-candidate falls
    // back to the conservative whole-crop temporal read (strict source gate inside).
    return estimateReleaseReadyWithWholeCropFallback(capsuleId, cropped, selection.source);
  } catch {
    logHvDebug({ scope: "vgc_release_ready_probe", stage: "probe_threw" });
    return { found: false };
  }
}

// ─── Hold release seam (avoids a hold ⇄ monitor import cycle) ─────────────────

type HoldReleaseHook = (capsuleId: string) => void;
let holdReleaseHook: HoldReleaseHook | undefined;

/**
 * Register the callback the monitor invokes on completion to release any live
 * press-hold mouse for the capsule. The hold module registers this at load, so
 * the monitor never imports the hold module (no cycle). Best-effort / no-op when
 * unset. The monitor never depends on a release succeeding.
 */
export function registerVgcHoldReleaseHook(hook: HoldReleaseHook): void {
  holdReleaseHook = hook;
}

// ─── Injectable deps (production defaults) ────────────────────────────────────

export interface VisualHandoffMonitorDeps {
  /** Advisory model presence classifier (default classifyHoldPresenceViaModel). */
  classifyModel?: (args: { cdpUrl: string }) => Promise<VgcHoldModelResult>;
  /** Live cdp_url resolver from a browser session (default taskBrowserSessions). */
  resolveCdpUrl?: (browserSessionId: string) => string | undefined;
  /** Override the release hook for tests (default: the registered hook). */
  releaseHold?: HoldReleaseHook;
  /** Poll cadence override (tests). */
  intervalMs?: number;
  /** Override the "is a hold active?" predicate (default: the registered probe). */
  activeHoldProbe?: HoldActiveProbe;
  /** Override the release-ready capture+crop+detect probe (default: real CDP probe). */
  releaseReadyProbe?: ReleaseReadyProbe;
  /** Release-ready probe min spacing override (tests; 0 ⇒ probe every still_active tick). */
  releaseProbeIntervalMs?: number;
}

interface MonitorEntry {
  capsule_id: string;
  /** Fallback cdp_url captured at start; the live session resolver wins per tick. */
  cdp_url: string;
  classifyModel: NonNullable<VisualHandoffMonitorDeps["classifyModel"]>;
  resolveCdpUrl: NonNullable<VisualHandoffMonitorDeps["resolveCdpUrl"]>;
  releaseHold?: HoldReleaseHook;
  intervalMs: number;
  consecutive_clear: number;
  /** In-flight guard — never overlap screenshot/model calls. */
  model_in_flight: boolean;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  // ─── Release-ready (full-bar) detection state ───────────────────────────────
  activeHoldProbe?: HoldActiveProbe;
  releaseReadyProbe: ReleaseReadyProbe;
  releaseProbeIntervalMs: number;
  /** Consecutive full-and-stable frames so far (independent of consecutive_clear). */
  consecutive_full: number;
  /** Previous full/partial frame's band, for cross-frame overlap stability. */
  last_band?: ReleaseReadyBand;
  /** Last release-ready probe time (ms) — caps the extra capture/CDP cadence. */
  last_release_probe_ms: number;
  /** In-flight guard for the (slower) release-ready capture+probe. */
  release_probe_in_flight: boolean;
  /**
   * True once this monitor has published `release_ready`; pins it across `wall_present`
   * ticks until the hold ends durably or the monitor moves to a clear/terminal phase.
   * Private to this monitor — NOT read back from the shared handoff ring (other
   * publishers, e.g. the hold's in-hold model advisory, clobber that ring mid-hold).
   */
  release_ready_sticky: boolean;
}

// Memory-only. Key: capsule_id. One monitor per capsule.
const monitors = new Map<string, MonitorEntry>();

/** True while a live monitor exists for the capsule. */
export function hasActiveVisualHandoffMonitor(capsuleId: string): boolean {
  const m = monitors.get(capsuleId);
  return !!m && !m.stopped;
}

/** Publish a safe handoff status update for the capsule (best-effort, never throws). */
function publishMonitorHandoff(
  capsuleId: string,
  phase: HvHandoffPhase,
  model?: { model_label?: string; model_confidence?: number },
  opts?: { allowReleaseReadyDowngrade?: boolean },
): void {
  const capsule = getVisualGestureCapsule(capsuleId);
  if (!capsule) return;
  publishHvHandoffUpdate({
    browser_session_id: capsule.browser_session_id,
    source: "visual_gesture_capsule",
    phase,
    capsule_id: capsule.capsule_id,
    human_verification_request_id: capsule.human_verification_request_id,
    domain: capsule.domain,
    presence_source: "model",
    ...(model?.model_label ? { model_label: model.model_label } : {}),
    ...(model?.model_confidence !== undefined ? { model_confidence: model.model_confidence } : {}),
    ...(opts?.allowReleaseReadyDowngrade ? { allow_release_ready_downgrade: true } : {}),
  });
}

/**
 * Sticky guard: true when this monitor has already published `release_ready` AND a live hold is
 * still active. Used to keep `release_ready` pinned across `wall_present` ticks (no `still_active`
 * downgrade) so the "Release now" nudge stays visible while the user holds. UI guidance only —
 * does not affect completion, the hold, or agent resumption.
 *
 * The "already reached release_ready" memory is the monitor-private `entry.release_ready_sticky`
 * flag, NOT the shared handoff ring: the ring is last-writer-wins and gets clobbered to
 * `still_active` mid-hold by the hold module's in-hold model advisory, which would otherwise
 * silently drop the sticky pin before `hold_ended`. The hold-active half is the durable
 * `hold_started`/`hold_ended` source of truth (`hasLiveVgcHoldSession` via the `holdActiveProbe`
 * seam).
 */
function isReleaseReadyStickyDuringHold(entry: MonitorEntry): boolean {
  if (!entry.release_ready_sticky) return false;
  const isHoldActive = entry.activeHoldProbe ?? holdActiveProbe;
  return !!isHoldActive && isHoldActive(entry.capsule_id) === true;
}

function armTick(entry: MonitorEntry): void {
  if (entry.stopped) return;
  entry.timer = setTimeout(() => {
    void runTick(entry);
  }, entry.intervalMs);
}

async function runTick(entry: MonitorEntry): Promise<void> {
  if (entry.stopped) return;

  // Hard-stop on terminal / missing capsule (covers expiry + cancel without an
  // explicit stop call). Self-cleans the monitor.
  const capsule = getVisualGestureCapsule(entry.capsule_id);
  if (!capsule || isTerminalVisualGestureStatus(capsule.status)) {
    stopVisualHandoffMonitor(entry.capsule_id);
    return;
  }

  // In-flight guard: never overlap screenshot/model calls — skip this tick.
  if (entry.model_in_flight) {
    armTick(entry);
    return;
  }

  const cdpUrl = entry.resolveCdpUrl(capsule.browser_session_id) ?? entry.cdp_url;

  entry.model_in_flight = true;
  let result: VgcHoldModelResult;
  try {
    result = await entry.classifyModel({ cdpUrl });
  } catch {
    result = { available: false, verdict: "uncertain" };
  } finally {
    entry.model_in_flight = false;
  }
  if (entry.stopped) return;

  const verdict = verdictFromModelResult(result);
  const advanced = advanceStableClear(entry.consecutive_clear, verdict);
  entry.consecutive_clear = advanced.consecutiveClear;
  const model = {
    ...(result.model_label ? { model_label: result.model_label } : {}),
    ...(result.model_confidence !== undefined ? { model_confidence: result.model_confidence } : {}),
  };

  logHvDebug({
    scope: "vgc_handoff_monitor",
    verdict,
    action: advanced.action,
    consecutive_clear: entry.consecutive_clear,
  });

  if (advanced.action === "complete") {
    // STABLE visual clear is the SOLE completion authority. Mark cleared, publish
    // `completed`, release any live hold, and stop the loop.
    entry.release_ready_sticky = false;
    markGestureCapsuleCleared(entry.capsule_id);
    publishMonitorHandoff(entry.capsule_id, "completed", model);
    const release = entry.releaseHold ?? holdReleaseHook;
    if (release) {
      try {
        release(entry.capsule_id);
      } catch {
        /* best-effort — completion never depends on the release */
      }
    }
    stopVisualHandoffMonitor(entry.capsule_id);
    return;
  }

  // Optionally check whether the press-and-hold progress bar reads full so we can
  // nudge "Release now" while the wall is still present. Runs for a `wall_present` OR
  // `uncertain` verdict during a LIVE hold — the model often stays `uncertain` while a
  // cross-origin/opaque wall is visibly present, so gating only on `wall_present` (the
  // conservative-ambiguous case) would never surface the nudge. UI guidance ONLY: it
  // never clears the capsule, releases the hold, or resumes the agent. `looks_clear`
  // (checking/complete) always wins and never runs the detector.
  const releaseReady = await evaluateReleaseReadyPhase(entry, cdpUrl, verdict);
  if (entry.stopped) return;

  if (advanced.action === "still_active") {
    // wall_present. Publish release_ready on a fire. Otherwise keep release_ready STICKY while the
    // hold is live: once "Release now" has surfaced, a subsequent wall_present tick must NOT
    // downgrade the UI back to still_active (the nudge is easy to miss). Re-publishing keeps the
    // phase fresh (avoids TTL expiry). Sticky ends naturally when the hold ends (falls through to
    // still_active), or via the complete/checking branches and terminal-capsule self-clean.
    if (releaseReady) {
      entry.release_ready_sticky = true;
      publishMonitorHandoff(entry.capsule_id, releaseReady, model);
    } else if (isReleaseReadyStickyDuringHold(entry)) {
      publishMonitorHandoff(entry.capsule_id, "release_ready", model);
    } else {
      entry.release_ready_sticky = false; // hold ended durably, or release_ready never reached
      // Durable end / regression: the hold is no longer active here (the sticky guard above
      // already failed), so this still_active is a LEGITIMATE downgrade — pass the explicit
      // marker so the non-downgrade latch lets it through.
      publishMonitorHandoff(entry.capsule_id, "still_active", model, {
        allowReleaseReadyDowngrade: true,
      });
    }
  } else if (advanced.action === "checking") {
    // looks_clear / checking supersedes the "Release now" nudge — lift the sticky pin.
    entry.release_ready_sticky = false;
    publishMonitorHandoff(entry.capsule_id, "looks_complete_checking", model);
  } else if (releaseReady) {
    // action === "wait" (uncertain / unavailable): publish ONLY on a positive fire so
    // an uncertain-but-walled hold can still nudge "Release now"; otherwise keep the
    // last phase (avoids ring/history flap). `unavailable` never fires (helper filters).
    entry.release_ready_sticky = true;
    publishMonitorHandoff(entry.capsule_id, releaseReady, model);
  }
  // action === "wait" with no fire: publish nothing — keep the last phase.

  armTick(entry);
}

/** Bucketed, safe (enums only) skip telemetry for a non-running release-ready tick. */
function logReleaseReadySkip(verdict: VgcHandoffVerdict, reason: string): void {
  logHvDebug({ scope: "vgc_release_ready", verdict, reason, fired: false });
}

/**
 * Evaluate the (flag-gated) release-ready full-bar detector for this tick. Returns
 * `"release_ready"` only when a stable full bar is detected during a LIVE hold; `null`
 * otherwise (the caller keeps the existing phase). Runs only for a `wall_present` or
 * `uncertain` verdict — `looks_clear` is owned by the completion path and `unavailable`
 * never probes or completes. Fail-closed and best-effort: any miss/throw returns `null`.
 * The detector runs only when the flag is on, a press is active, and the cadence/in-flight
 * guards allow it (the extra capture + blocker probe each open their own CDP socket). All
 * telemetry is bucketed/safe (enums + counts only) and emitted under ANTIGEN_HV_DEBUG.
 */
async function evaluateReleaseReadyPhase(
  entry: MonitorEntry,
  cdpUrl: string,
  verdict: VgcHandoffVerdict,
): Promise<"release_ready" | null> {
  try {
    // Flag off → byte-identical to today: no capture, no probe, no telemetry.
    if (!isReleaseReadyEnabled()) return null;

    // Verdict gate: only an active wall (wall_present) or an unsure-but-walled tick
    // (uncertain) may probe. looks_clear is owned by the completion path; unavailable
    // never probes or completes.
    if (verdict === "looks_clear") {
      logReleaseReadySkip(verdict, "skip_verdict_looks_clear");
      return null;
    }
    if (verdict !== "wall_present" && verdict !== "uncertain") {
      logReleaseReadySkip(verdict, "skip_verdict_unavailable");
      return null;
    }

    const isHoldActive = entry.activeHoldProbe ?? holdActiveProbe;
    if (!isHoldActive || isHoldActive(entry.capsule_id) !== true) {
      logReleaseReadySkip(verdict, "skip_no_active_hold");
      return null;
    }
    if (entry.release_probe_in_flight) {
      logReleaseReadySkip(verdict, "skip_in_flight");
      return null;
    }
    if (Date.now() - entry.last_release_probe_ms < entry.releaseProbeIntervalMs) {
      logReleaseReadySkip(verdict, "skip_cadence");
      return null;
    }

    entry.release_probe_in_flight = true;
    entry.last_release_probe_ms = Date.now();
    let estimate: ProgressFillEstimate = { found: false };
    try {
      estimate = await entry.releaseReadyProbe(cdpUrl, entry.capsule_id);
    } catch {
      estimate = { found: false };
    } finally {
      entry.release_probe_in_flight = false;
    }
    if (entry.stopped) return null;

    const adv = advanceReleaseReady(entry.consecutive_full, entry.last_band, estimate);
    entry.consecutive_full = adv.consecutiveFull;
    entry.last_band = adv.lastBand;

    const reason = !estimate.found
      ? "probe_found_false"
      : (estimate.fill_ratio ?? 0) < FULL_RATIO_THRESHOLD
        ? "probe_partial"
        : adv.fire
          ? "probe_full_fired"
          : "probe_full_streak_1";

    logHvDebug({
      scope: "vgc_release_ready",
      verdict,
      reason,
      found: estimate.found,
      fill_bucket: fillBucket(estimate.fill_ratio),
      consecutive_full: entry.consecutive_full,
      // True when this fire used the whole-crop temporal single-frame path (no 2-frame streak).
      single_frame: estimate.temporally_confirmed === true,
      fired: adv.fire,
    });

    return adv.fire ? "release_ready" : null;
  } catch {
    return null;
  }
}

/**
 * Start the visual handoff monitor for a freshly-minted capsule. No-op when the
 * flag is off, when a monitor already exists for the capsule, or when the capsule
 * is missing/terminal. Idempotent — safe to call again (e.g. from hold-start) to
 * ensure the loop is running with a known-good cdp_url.
 */
export function startVisualHandoffMonitor(
  args: { capsuleId: string; cdpUrl: string; browserSessionId?: string },
  deps: VisualHandoffMonitorDeps = {},
): void {
  if (!isVisualHvHandoffEnabled()) return;
  if (hasActiveVisualHandoffMonitor(args.capsuleId)) return;
  const capsule = getVisualGestureCapsule(args.capsuleId);
  if (!capsule || isTerminalVisualGestureStatus(capsule.status)) return;

  const entry: MonitorEntry = {
    capsule_id: args.capsuleId,
    cdp_url: args.cdpUrl,
    classifyModel: deps.classifyModel ?? classifyHoldPresenceViaModel,
    resolveCdpUrl: deps.resolveCdpUrl ?? getTaskBrowserSessionCdpUrl,
    ...(deps.releaseHold ? { releaseHold: deps.releaseHold } : {}),
    intervalMs: deps.intervalMs ?? VGC_HANDOFF_MODEL_POLL_INTERVAL_MS,
    consecutive_clear: 0,
    model_in_flight: false,
    stopped: false,
    ...(deps.activeHoldProbe ? { activeHoldProbe: deps.activeHoldProbe } : {}),
    releaseReadyProbe: deps.releaseReadyProbe ?? defaultReleaseReadyProbe,
    releaseProbeIntervalMs: deps.releaseProbeIntervalMs ?? VGC_RELEASE_READY_PROBE_INTERVAL_MS,
    consecutive_full: 0,
    last_release_probe_ms: 0,
    release_probe_in_flight: false,
    release_ready_sticky: false,
  };
  monitors.set(args.capsuleId, entry);
  logHvDebug({ scope: "vgc_handoff_monitor", monitor_event: "started" });
  armTick(entry);
}

/** Stop + drop the monitor for a capsule. Idempotent. */
export function stopVisualHandoffMonitor(capsuleId: string): void {
  const entry = monitors.get(capsuleId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  monitors.delete(capsuleId);
  // Single choke point for every real teardown (terminal/expiry/cancel, completion,
  // external cancel route, manual stop): drop the per-capsule whole-crop pixel state.
  clearWholeCropProgress(capsuleId);
  logHvDebug({ scope: "vgc_handoff_monitor", monitor_event: "stopped" });
}

/** Test-only: stop + drop all monitors between cases. */
export function clearVisualHandoffMonitorsForTests(): void {
  for (const [capsuleId, entry] of monitors) {
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    // The test path bypasses stopVisualHandoffMonitor's body — clear state per entry.
    clearWholeCropProgress(capsuleId);
  }
  monitors.clear();
}
