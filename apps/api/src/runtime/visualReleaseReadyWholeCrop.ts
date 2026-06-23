// ─── Release-Ready Whole-Crop Active-Hold Fallback (press-and-hold HV) ─────────
//
// A conservative, fail-closed TEMPORAL fallback for the release-ready "Release now"
// nudge. The per-shape detector (visualReleaseReadyDetector.ts) only succeeds when it
// can isolate a wide+thin BAR band or a compact BUTTON/RING sub-candidate inside the
// crop and measure fill INSIDE it. Some real press-and-hold affordances (e.g. the
// live B&BW wall) read as neither shape, so the detector returns `found:false` even
// though the hold-anchor crop clearly contains a filling progress affordance.
//
// This module adds a generic, no-shape-hardcode read of the WHOLE hold-anchor crop:
// a press-and-hold affordance CHANGES continuously while filling, then STOPS changing
// once full (it sits at "release now"). Two signals together are a strong "full" read:
//   - cumulative change vs the hold's BASELINE crop  → high once a lot has filled.
//   - recent change vs the PREVIOUS probe frame      → low once it has PLATEAUED (full).
// Firing only when cumulative is high AND recent is ~0 tells "filled and stopped" apart
// from both "still filling" (recent high) and a perpetual spinner (recent never drops).
//
// ── HARD BOUNDARIES ──────────────────────────────────────────────────────────
// - UI GUIDANCE ONLY. NEVER completion authority. A full read means the user should
//   RELEASE — completion stays the monitor's stable visual-clear authority AFTER
//   release. This module never clears the capsule, releases the hold, or resumes the
//   agent. The `release_ready` phase keeps `agent_should_wait:true`.
// - STRICT SOURCE GATE. The fallback runs ONLY for a `hold_anchor` crop (the user's
//   actual live press point). It MUST NOT run for `dominant_surface` / `inner_control`
//   / `center_region` — those geometry/DOM fallbacks are not trustworthy for a temporal
//   whole-crop read. Enforced with an explicit `=== "hold_anchor"` check (not a
//   negation) so any future SelectedCropSource value defaults to the safe no-fallback path.
// - FAIL CLOSED. No baseline yet / dims mismatch / weak cumulative / not-plateaued ⇒
//   `{ found:false }` (= keep holding). Consecutiveness is delegated to the EXISTING
//   outer streak (advanceReleaseReady + VGC_RELEASE_READY_CONSECUTIVE): a single strong
//   frame never fires; two consecutive strong (plateaued) frames do.
// - SAFE OUTPUT ONLY. Returns the same `ProgressFillEstimate` shape the detector does;
//   the band is a CONSTANT whole-crop descriptor (never raw coords). Pixel grids live
//   only in this module's memory-only state Map and never leave it. Telemetry is coarse
//   (enums/buckets/booleans) and ANTIGEN_HV_DEBUG-gated.

import { PNG } from "pngjs";

import { logHvDebug } from "./humanVerificationState.js";
import {
  estimateProgressFillRatio,
  type ProgressFillEstimate,
  type ReleaseReadyBand,
} from "./visualReleaseReadyDetector.js";
import type { SelectedCropSource } from "./visualHandoffMonitor.js";

// ─── Tunables (heuristic; conservative — bias hard AGAINST firing) ─────────────

/** Per-pixel luminance delta (0–255) for a pixel to count as "changed" between frames. */
const CHANGE_LUMA_DELTA = 30;
/** Min fraction of crop pixels that must differ from the BASELINE before "a lot has filled". */
const CUMULATIVE_STRONG_MIN = 0.03;
/** Max fraction of crop pixels allowed to differ from the PREVIOUS frame to read "plateaued". */
const RECENT_PLATEAU_MAX = 0.006;
/** Fill ratio reported on a strong frame — at/above FULL_RATIO_THRESHOLD so the outer streak counts it. */
const STRONG_FILL_RATIO = 1;

/**
 * Constant whole-crop band descriptor. Centered, full-width/height in crop fractions,
 * so it OVERLAPS ITSELF across frames (releaseReadyBandsOverlap is trivially true) and
 * the existing outer streak (advanceReleaseReady) counts consecutive strong frames. It
 * carries NO raw coordinates — only [0,1] crop fractions — and is never serialized to an
 * agent (the monitor publishes only a phase enum).
 */
export const WHOLE_CROP_BAND: ReleaseReadyBand = { y_center: 0.5, x0: 0, x1: 1 };

// ─── Pure luminance helpers (same weights as the detector) ────────────────────

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Decode a base64 PNG to a row-major luminance grid. Returns null on any decode failure. */
export function decodeLuminance(
  croppedPngBase64: string,
): { W: number; H: number; L: Float32Array } | null {
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(croppedPngBase64, "base64"));
  } catch {
    return null;
  }
  const W = png.width;
  const H = png.height;
  if (!(W > 0) || !(H > 0)) return null;
  const L = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (W * y + x) << 2;
      L[W * y + x] = luminance(png.data[idx], png.data[idx + 1], png.data[idx + 2]);
    }
  }
  return { W, H, L };
}

/** Fraction of pixels whose luminance differs by ≥ CHANGE_LUMA_DELTA between two equal-size grids. */
function changedRatio(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  if (n === 0 || b.length !== n) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) >= CHANGE_LUMA_DELTA) changed += 1;
  }
  return changed / n;
}

/**
 * Pure comparison core: cumulative change of `cur` vs `base` and recent change of `cur`
 * vs `prev`. All three grids MUST share W×H (the caller guards dims). No state, never
 * throws. Exported for direct unit testing.
 */
export function compareCropFrames(
  baseLum: Float32Array,
  prevLum: Float32Array,
  curLum: Float32Array,
): { cumulative_change_ratio: number; recent_change_ratio: number } {
  return {
    cumulative_change_ratio: changedRatio(curLum, baseLum),
    recent_change_ratio: changedRatio(curLum, prevLum),
  };
}

/** A frame is "strong" (plateaued-full) when a lot has filled AND it has stopped advancing. */
export function isStrongProgress(cumulative: number, recent: number): boolean {
  return cumulative >= CUMULATIVE_STRONG_MIN && recent <= RECENT_PLATEAU_MAX;
}

// ─── Coarse, safe telemetry buckets ───────────────────────────────────────────

/** Coarse change-ratio bucket for safe telemetry (never the raw ratio). */
export function ratioBucket(ratio: number): "lt1" | "1_3" | "3_strong" | "ge_strong" {
  if (ratio < 0.01) return "lt1";
  if (ratio < 0.03) return "1_3";
  if (ratio < CUMULATIVE_STRONG_MIN) return "3_strong";
  return "ge_strong";
}

// ─── Per-capsule temporal state (memory-only; pixel grids never leave this module) ─

interface WholeCropState {
  W: number;
  H: number;
  /** Fixed reference captured at the first active-hold probe (the empty/low affordance). */
  baselineLum: Float32Array;
  /** The previous probe frame, for the frame-to-frame plateau signal. */
  prevLum: Float32Array;
}

// Key: capsule_id. One entry per active capsule. Cleared on monitor stop / capsule
// cleanup (clearWholeCropProgress) — see visualHandoffMonitor.stopVisualHandoffMonitor.
const wholeCropStates = new Map<string, WholeCropState>();

/** Drop the per-capsule temporal state. Idempotent. Called on EVERY monitor stop path. */
export function clearWholeCropProgress(capsuleId: string): void {
  wholeCropStates.delete(capsuleId);
}

/** Test-only: drop all whole-crop state between cases. */
export function clearWholeCropProgressForTests(): void {
  wholeCropStates.clear();
}

/** Test-only: coarse current state for a capsule (no pixels) — `none` when absent. */
export function wholeCropStateKindForTests(
  capsuleId: string,
): "none" | "tracking" {
  return wholeCropStates.has(capsuleId) ? "tracking" : "none";
}

/**
 * Stateful per-capsule whole-crop evaluator. First call (or after a dims change) captures
 * the BASELINE + previous and returns `{found:false}` (cannot compare yet). Subsequent
 * calls compute the cumulative/recent change signals and return a STRONG estimate
 * (`found:true, fill_ratio:1, band: WHOLE_CROP_BAND`) only on a plateaued-full frame —
 * otherwise `{found:false}`. The outer streak owns the consecutive-frame requirement.
 * Never throws; any decode failure fails closed to `{found:false}`.
 */
export function evaluateWholeCropProgress(
  capsuleId: string,
  croppedPngBase64: string,
): ProgressFillEstimate {
  const decoded = decodeLuminance(croppedPngBase64);
  if (!decoded) {
    logHvDebug({
      scope: "vgc_release_ready_whole_crop",
      chosen_candidate_kind: "hold_anchor_whole_crop",
      whole_crop_state: "decode_failed",
      strong: false,
      fired: false,
    });
    return { found: false };
  }

  const prior = wholeCropStates.get(capsuleId);

  // First probe for this capsule, or a viewport/dims change: (re)baseline, fail closed.
  if (!prior || prior.W !== decoded.W || prior.H !== decoded.H) {
    wholeCropStates.set(capsuleId, {
      W: decoded.W,
      H: decoded.H,
      baselineLum: decoded.L,
      prevLum: decoded.L,
    });
    logHvDebug({
      scope: "vgc_release_ready_whole_crop",
      chosen_candidate_kind: "hold_anchor_whole_crop",
      whole_crop_state: prior ? "dims_changed" : "baseline_captured",
      strong: false,
      fired: false,
    });
    return { found: false };
  }

  const { cumulative_change_ratio, recent_change_ratio } = compareCropFrames(
    prior.baselineLum,
    prior.prevLum,
    decoded.L,
  );
  const strong = isStrongProgress(cumulative_change_ratio, recent_change_ratio);

  // Advance the previous frame (baseline stays fixed for the whole hold).
  prior.prevLum = decoded.L;

  logHvDebug({
    scope: "vgc_release_ready_whole_crop",
    chosen_candidate_kind: "hold_anchor_whole_crop",
    whole_crop_state: "compared",
    cumulative_bucket: ratioBucket(cumulative_change_ratio),
    recent_bucket: ratioBucket(recent_change_ratio),
    strong,
    // The outer streak owns the real fire (and logs it) — a single strong frame never fires.
    fired: false,
  });

  return strong
    ? { found: true, fill_ratio: STRONG_FILL_RATIO, band: WHOLE_CROP_BAND }
    : { found: false };
}

/**
 * The single seam the release-ready probe calls. Runs the existing per-shape detector
 * first; if it found an affordance, returns that verbatim (whole-crop state untouched).
 * Only when the detector found nothing AND the crop is the user's `hold_anchor` does the
 * temporal whole-crop fallback run. Any other crop source returns the detector's
 * `{found:false}` and never creates whole-crop state.
 *
 * Note: this seam is reached only from `defaultReleaseReadyProbe`, which itself runs only
 * under the ANTIGEN_HV_RELEASE_READY path and after the upstream active-hold gate — so
 * "active hold" is structurally guaranteed for a `hold_anchor` crop here.
 */
export function estimateReleaseReadyWithWholeCropFallback(
  capsuleId: string,
  croppedPngBase64: string,
  cropSource: SelectedCropSource,
): ProgressFillEstimate {
  const primary = estimateProgressFillRatio(croppedPngBase64);
  if (primary.found) return primary;
  // STRICT SOURCE GATE: explicit positive equality — only the live press-point crop.
  if (cropSource === "hold_anchor") {
    return evaluateWholeCropProgress(capsuleId, croppedPngBase64);
  }
  return primary;
}
