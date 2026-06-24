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
// - PROGRESS / TELEMETRY ONLY — NEVER A RELEASE TRIGGER. This temporal "crop stopped
//   changing" read is NOT proof the visual control is geometrically complete: on a slow /
//   long hold a half-full bar advancing slowly reads as a plateau and would fire "Release
//   now" prematurely. So `evaluateWholeCropProgress` ALWAYS returns `{ found:false }`. It
//   still computes the cumulative/recent/strict/relaxed signals and emits them as bucketed
//   telemetry + debug-crop notes (progress evidence), but it never returns `found:true`,
//   `fill_ratio`, a band, or `temporally_confirmed` for firing. The sole release trigger is
//   the direct, color-agnostic control-fill detector (visualControlFillDetector.ts).
// - UI GUIDANCE ONLY. NEVER completion authority. Even the control-fill detector only nudges
//   the user to RELEASE — completion stays the monitor's stable visual-clear authority AFTER
//   release. This module never clears the capsule, releases the hold, or resumes the agent.
//   The `release_ready` phase keeps `agent_should_wait:true`.
// - STRICT SOURCE GATE. The fallback telemetry runs ONLY for a `hold_anchor` crop (the user's
//   actual live press point). It MUST NOT run for `dominant_surface` / `inner_control`
//   / `center_region` — those geometry/DOM fallbacks are not trustworthy for a temporal
//   whole-crop read. Enforced with an explicit `=== "hold_anchor"` check (not a
//   negation) so any future SelectedCropSource value defaults to the safe no-fallback path.
// - FAIL CLOSED. No baseline yet / dims mismatch / weak cumulative / not-plateaued ⇒
//   `{ found:false }` (= keep holding) — as does every other frame now.
// - SAFE OUTPUT ONLY. Returns the same `ProgressFillEstimate` shape the detector does;
//   the band is a CONSTANT whole-crop descriptor (never raw coords). Pixel grids live
//   only in this module's memory-only state Map and never leave it. Telemetry is coarse
//   (enums/buckets/booleans) and ANTIGEN_HV_DEBUG-gated.

import { PNG } from "pngjs";

import { logHvDebug } from "./humanVerificationState.js";
import { noteChosenSelection, noteWholeCropDiagnostics } from "./releaseReadyDebugCrops.js";
import { evaluateControlFill } from "./visualControlFillDetector.js";
import {
  estimateProgressFillRatio,
  FULL_RATIO_THRESHOLD,
  type ProgressFillEstimate,
  type ReleaseReadyBand,
} from "./visualReleaseReadyDetector.js";
import type { SelectedCropSource } from "./visualHandoffMonitor.js";

// ─── Tunables (heuristic; conservative — bias hard AGAINST firing) ─────────────

/** Per-pixel luminance delta (0–255) for a pixel to count as "changed" between frames. */
const CHANGE_LUMA_DELTA = 30;
/** Min fraction of crop pixels that must differ from the BASELINE before "a lot has filled". */
const CUMULATIVE_STRONG_MIN = 0.03;
/**
 * Min cumulative-change fraction (the `ge5` bucket boundary) for a STRICT-plateau frame to be
 * trusted as a SINGLE-FRAME (`temporally_confirmed`) release-ready read. A strict plateau at
 * moderate cumulative (the `3_5` bucket: 3–5% changed) only means "some progress paused" — NOT
 * site acceptance — so it must still earn the normal outer 2-frame streak. Only a very strong
 * strict plateau (≥5% changed) or the relaxed-sustained path (already 3 consecutive frames) may
 * fire on the first full frame. Bias is hard AGAINST premature "Release now".
 */
const CUMULATIVE_VERY_STRONG_MIN = 0.05;
/**
 * Max fraction of crop pixels allowed to differ from the PREVIOUS frame to read "plateaued"
 * via the STRICT condition. Raised from 0.006 → 0.012: real press-and-hold widgets keep tiny
 * shimmer/animation even when full, so 0.6% was too strict and delayed the "Release now" read.
 */
const RECENT_PLATEAU_MAX = 0.012;
/**
 * RELAXED plateau ceiling for the sustained-evidence path (condition B). A frame counts toward
 * the relaxed streak when recent change ≤ this AND cumulative is strong; the streak must hold
 * for RELAXED_STRONG_MIN_CONSECUTIVE frames before it reads strong, so a noisier-but-clearly-full
 * widget can still surface without the strict 1.2% threshold.
 */
const RECENT_PLATEAU_RELAXED_MAX = 0.018;
/** Consecutive relaxed-ok compared frames required before the relaxed sustained path reads strong. */
const RELAXED_STRONG_MIN_CONSECUTIVE = 3;

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

/**
 * Coarse change-ratio bucket for safe telemetry (never the raw ratio). Finer than the original
 * 4-bucket set so the strict/relaxed plateau region (≈1–2%) is legible in ANTIGEN_HV_DEBUG logs
 * without exposing pixels, dims, or the raw ratio.
 */
export function ratioBucket(
  ratio: number,
): "lt0_5" | "0_5_1" | "1_1_5" | "1_5_2" | "2_3" | "3_5" | "ge5" {
  if (ratio < 0.005) return "lt0_5";
  if (ratio < 0.01) return "0_5_1";
  if (ratio < 0.015) return "1_1_5";
  if (ratio < 0.02) return "1_5_2";
  if (ratio < 0.03) return "2_3";
  if (ratio < 0.05) return "3_5";
  return "ge5";
}

// ─── Per-capsule temporal state (memory-only; pixel grids never leave this module) ─

interface WholeCropState {
  W: number;
  H: number;
  /** Fixed reference captured at the first active-hold probe (the empty/low affordance). */
  baselineLum: Float32Array;
  /** The previous probe frame, for the frame-to-frame plateau signal. */
  prevLum: Float32Array;
  /**
   * Consecutive compared frames meeting the RELAXED sustained condition (strong cumulative +
   * recent ≤ RECENT_PLATEAU_RELAXED_MAX). Resets to 0 the moment a frame fails it. The relaxed
   * sustained path reads strong only once this reaches RELAXED_STRONG_MIN_CONSECUTIVE.
   */
  relaxedSustainedCount: number;
}

/** Coarse sustained-streak bucket for safe telemetry (never the raw count beyond the floor). */
function sustainedBucket(count: number): "0" | "1" | "2" | "3_plus" {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  return "3_plus";
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
 * Stateful per-capsule whole-crop evaluator — PROGRESS / TELEMETRY ONLY. First call (or after
 * a dims change) captures the BASELINE + previous. Subsequent calls compute the cumulative /
 * recent change signals and emit them as bucketed telemetry + debug-crop notes (strict /
 * relaxed plateau strength, progress_seen). It ALWAYS returns `{ found:false }`: a temporal
 * "crop stopped changing" plateau is not proof the control is visually complete, so it can
 * never fire release_ready (that is the control-fill detector's sole job). Never throws; any
 * decode failure also fails closed to `{found:false}`.
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
      relaxedSustainedCount: 0,
    });
    logHvDebug({
      scope: "vgc_release_ready_whole_crop",
      chosen_candidate_kind: "hold_anchor_whole_crop",
      whole_crop_state: prior ? "dims_changed" : "baseline_captured",
      whole_crop_mode: prior ? "dims_changed" : "baseline_captured",
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

  // Condition A (strict): a lot has filled AND it has nearly stopped (recent ≤ RECENT_PLATEAU_MAX).
  const strict = isStrongProgress(cumulative_change_ratio, recent_change_ratio);

  // Condition B (relaxed sustained): strong cumulative + a slightly noisier plateau, but only after
  // it has held for RELAXED_STRONG_MIN_CONSECUTIVE consecutive compared frames. Reset the streak the
  // moment cumulative drops below the floor or recent exceeds the relaxed ceiling.
  const relaxedOk =
    cumulative_change_ratio >= CUMULATIVE_STRONG_MIN &&
    recent_change_ratio <= RECENT_PLATEAU_RELAXED_MAX;
  prior.relaxedSustainedCount = relaxedOk ? prior.relaxedSustainedCount + 1 : 0;
  const relaxedSustained = prior.relaxedSustainedCount >= RELAXED_STRONG_MIN_CONSECUTIVE;

  const strong = strict || relaxedSustained;

  // SINGLE-FRAME gate. A strong read is `found:true` so the outer streak can build, but it may
  // fire on the FIRST full frame (temporally_confirmed) only when the evidence is itself a strong
  // multi-frame plateau:
  //   • relaxedSustained — already required RELAXED_STRONG_MIN_CONSECUTIVE consecutive relaxed-ok
  //     frames, so its temporal stability is established internally.
  //   • a VERY strong strict plateau (cumulative ≥ CUMULATIVE_VERY_STRONG_MIN, the `ge5` bucket).
  // A moderate strict plateau (the `3_5` bucket) is "progress paused", not acceptance, so it is
  // found:true but temporally_confirmed:false and must earn the normal outer 2-frame streak.
  const strictVeryStrong = strict && cumulative_change_ratio >= CUMULATIVE_VERY_STRONG_MIN;
  const temporallyConfirmed = relaxedSustained || strictVeryStrong;

  // Advance the previous frame (baseline stays fixed for the whole hold).
  prior.prevLum = decoded.L;

  const strictStrength: "very_strong" | "moderate" | "none" = strict
    ? strictVeryStrong
      ? "very_strong"
      : "moderate"
    : "none";

  logHvDebug({
    scope: "vgc_release_ready_whole_crop",
    chosen_candidate_kind: "hold_anchor_whole_crop",
    whole_crop_state: "compared",
    whole_crop_mode: strict ? "strict_plateau" : relaxedSustained ? "relaxed_sustained" : "not_strong",
    cumulative_bucket: ratioBucket(cumulative_change_ratio),
    recent_bucket: ratioBucket(recent_change_ratio),
    sustained_bucket: sustainedBucket(prior.relaxedSustainedCount),
    strong,
    // Bucketed strictness of the strict-plateau read: moderate `3_5` vs `very_strong` (`ge5`).
    // enum-only, debug-gated. NOTE: strictness no longer gates any release fire (see below).
    strict_strength: strictStrength,
    // Eligibility this frame WOULD have had under the old single-frame fire rule — kept as
    // pure progress telemetry only; it no longer reaches advanceReleaseReady.
    temporally_confirmed: temporallyConfirmed,
    // Whether a meaningful amount has filled vs baseline (progress evidence, not a trigger).
    progress_seen: cumulative_change_ratio >= CUMULATIVE_STRONG_MIN,
    // INVARIANT: the whole-crop temporal read NEVER fires release_ready. It is progress /
    // telemetry / debug evidence only — the color-agnostic control-fill detector is the sole
    // release trigger. This flag documents that at the log layer and must stay false.
    whole_crop_used_as_release_trigger: false,
    // The outer streak owns the real fire (and logs it) — whole-crop never fires.
    fired: false,
  });

  // Dev-only debug-crop note (double-flag-gated inside; no-op otherwise). Surfaces the
  // SAME coarse buckets above so the captured crop sequence carries the temporal read.
  noteWholeCropDiagnostics(capsuleId, {
    chosen_candidate_kind: "hold_anchor_whole_crop",
    cumulative_bucket: ratioBucket(cumulative_change_ratio),
    recent_bucket: ratioBucket(recent_change_ratio),
    strict_strength: strictStrength,
    temporally_confirmed: temporallyConfirmed,
    whole_crop_mode: strict ? "strict_plateau" : relaxedSustained ? "relaxed_sustained" : "not_strong",
  });

  // INVARIANT (safety patch): the whole-crop temporal read NEVER returns a release-ready /
  // full estimate. A "crop stopped changing" plateau is NOT proof the control is visually
  // complete — on slow/long holds a half-full bar advancing slowly reads as a plateau and
  // would fire "Release now" prematurely. All firing now comes from the direct, color-agnostic
  // control-fill detector (visualControlFillDetector.ts). This path stays as progress /
  // telemetry / debug evidence only, so it ALWAYS returns `{ found:false }` regardless of how
  // strong the plateau read was (`strong` / `temporallyConfirmed` survive only as telemetry).
  return { found: false };
}

/**
 * The single seam the release-ready probe calls. Resolution order for a release estimate:
 *
 *   1. The stateless per-shape detector (bar/ring). If it returned a RELEASE-CAPABLE estimate
 *      (`found` AND `fill_ratio >= FULL_RATIO_THRESHOLD`), return it — control-fill could only
 *      match it, never beat it. A merely `found:true` PARTIAL estimate does NOT short-circuit:
 *      `found` means "some affordance was isolated," not "release-ready," so a partial bar must
 *      not block the control-fill detector (that block was the bug this seam fixes).
 *   2. ONLY for the user's `hold_anchor` crop (strict positive `=== "hold_anchor"` gate):
 *      a. The COLOR-AGNOSTIC control-fill detector — the sole new release trigger. If it
 *         measured fill inside a baseline-locked control, return the MORE release-capable of
 *         {partial primary, control} (higher `fill_ratio`; ties go to control).
 *      b. Otherwise run the whole-crop temporal read for PROGRESS / TELEMETRY ONLY (it always
 *         returns `{found:false}`), then return the partial `primary` if one exists (so the
 *         sheet/telemetry reflects real progress) else `{found:false}`.
 *
 * Any other crop source returns the per-shape detector's estimate and never creates control /
 * whole-crop state.
 *
 * Firing is unchanged and lives downstream in `advanceReleaseReady`: a returned estimate only
 * fires when `fill_ratio >= FULL_RATIO_THRESHOLD` AND the position-stable streak completes.
 * Returning a partial primary here can never fire (it resets the streak below threshold).
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
  const primary = estimateProgressFillRatio(croppedPngBase64, capsuleId);
  // A release-capable primary wins outright — and so do ALL non-hold_anchor crops (strict
  // source gate: control-fill / whole-crop run only for the live press-point crop).
  if (isReleaseCapable(primary) || cropSource !== "hold_anchor") {
    noteChosenSelection(capsuleId, "primary");
    return primary;
  }
  // hold_anchor + primary not release-capable (not found, or found-but-partial): a partial
  // primary must NOT block control-fill, the sole color-agnostic release trigger.
  const controlFill = evaluateControlFill(capsuleId, croppedPngBase64);
  if (controlFill.found) {
    const chosen = chooseHigherFill(primary, controlFill);
    noteChosenSelection(capsuleId, chosen === controlFill ? "control" : "primary");
    return chosen;
  }
  // Control-fill found nothing. Whole-crop runs for progress/telemetry/debug evidence only —
  // it never returns found:true. Surface the partial primary (telemetry) if there was one.
  evaluateWholeCropProgress(capsuleId, croppedPngBase64);
  noteChosenSelection(capsuleId, "primary");
  return primary.found ? primary : { found: false };
}

/** Release-capable = a found estimate whose fill is at/above the fire threshold. `found:true`
 * alone is NOT release-capable — that conflation was the seam bug. */
function isReleaseCapable(e: ProgressFillEstimate): boolean {
  return e.found && e.fill_ratio !== undefined && e.fill_ratio >= FULL_RATIO_THRESHOLD;
}

/** Pick the more release-capable estimate (higher `fill_ratio`). Ties go to `b` (control),
 * the intended release trigger with a baseline-locked, frame-stable band. A not-found side
 * always loses to a found one. */
function chooseHigherFill(
  a: ProgressFillEstimate,
  b: ProgressFillEstimate,
): ProgressFillEstimate {
  if (!a.found) return b;
  if (!b.found) return a;
  return (b.fill_ratio ?? 0) >= (a.fill_ratio ?? 0) ? b : a;
}
