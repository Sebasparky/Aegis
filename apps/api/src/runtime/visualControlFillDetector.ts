// ─── Color-Agnostic Press-and-Hold Control-Fill Detector ──────────────────────
//
// The SOLE release-ready ("Release now") trigger for the VGC press-and-hold relay. It
// answers the question the temporal whole-crop fallback could not answer safely:
//
//     "Is the ACTUAL visual progress control geometrically full/complete?"
//   — not —
//     "Has the crop stopped changing?"  (a slow half-full bar plateaus too).
//
// It is COLOR-AGNOSTIC by construction: it never looks at hue or any specific colour. It
// works on a luminance grid using geometry (a horizontally-oriented pill/bar control) and a
// BASELINE-RELATIVE difference (how many control columns have transitioned away from the
// hold's unfilled baseline). Because it counts transitioned columns / total columns it is
// also fill-DIRECTION agnostic — left-to-right and centre-out animations both reach 1.0 at
// completion — and polarity agnostic (a dark-on-light or light-on-dark fill both register as
// an absolute luminance change).
//
// ── HARD BOUNDARIES ──────────────────────────────────────────────────────────
// - UI GUIDANCE ONLY. A full read nudges the user to RELEASE. This module NEVER clears the
//   capsule, releases the hold, completes the handoff, or resumes the agent. Completion stays
//   the monitor's post-release stable visual-clear authority. `release_ready` keeps
//   `agent_should_wait:true`.
// - NORMAL CONFIRMATION. A found estimate carries NO `temporally_confirmed`, so the outer
//   streak (advanceReleaseReady) still demands fill_ratio ≥ FULL_RATIO_THRESHOLD (0.92) on
//   VGC_RELEASE_READY_CONSECUTIVE (2) consecutive, position-stable frames before firing.
// - BASELINE-LOCKED BOUNDS. The control bounds are resolved ONCE from the hold's baseline
//   frame (which shows the UNFILLED track) and then locked. We never track the fill front as
//   if it were the whole control — that would read ~100% from the first filled pixel. If the
//   baseline yields no valid control candidate, the detector fails closed for the whole hold
//   (`{found:false}` every frame) and the user simply keeps holding until the post-release
//   `looks_clear` streak completes the handoff.
// - FAIL CLOSED. Decode failure / dims change / unresolved bounds / ambiguous fill ⇒
//   `{found:false}` (= keep holding).
// - SAFE OUTPUT ONLY. Returns the shared `ProgressFillEstimate`; the band carries only [0,1]
//   crop fractions (never raw px). Pixel grids and pixel bounds live ONLY in this module's
//   memory-only state Map and never leave it. Telemetry is coarse (enums/buckets/booleans)
//   and ANTIGEN_HV_DEBUG-gated.

import { logHvDebug } from "./humanVerificationState.js";
import {
  noteControlFillDiagnostics,
  noteControlOverlayGeometry,
} from "./releaseReadyDebugCrops.js";
import {
  decodeLuminance,
} from "./visualReleaseReadyWholeCrop.js";
import { FULL_RATIO_THRESHOLD } from "./visualReleaseReadyDetector.js";
import type {
  ProgressFillEstimate,
  ReleaseReadyBand,
} from "./visualReleaseReadyDetector.js";

// ─── Tunables (heuristic; geometry/contrast only — NO colour) ─────────────────

/** Min |luminance − card-background| for a baseline pixel to count as control "ink" (track). */
const CONTROL_CONTRAST = 24;
/** A row is part of a wide horizontal structure when ≥ this fraction of its pixels are ink. */
const ROW_INK_MIN_FRAC = 0.3;
/** Within the control row band, a column belongs to the control when ≥ this fraction of its
 *  band rows are ink. */
const COL_INK_MIN_FRAC = 0.3;
/** Reject tiny/noisy candidates. */
const MIN_CONTROL_W_PX = 40;
const MIN_CONTROL_H_PX = 6;
/** Reject square/tall candidates — a progress pill/bar is horizontally elongated. */
const MIN_CONTROL_ASPECT = 2.5;
/** A bar (vs pill) is very wide+thin; used only to label candidate_kind. */
const BAR_ASPECT = 6;
/** Reject candidates that engulf the whole card/background (not a control). */
const TOO_BROAD_AREA_FRAC = 0.92;
const TOO_BROAD_H_FRAC = 0.7;
/** The control must be roughly centred in the hold-anchor crop. */
const CENTER_X_LO = 0.15;
const CENTER_X_HI = 0.85;
const CENTER_Y_LO = 0.2;
const CENTER_Y_HI = 0.97;
/** Min |cur − baseline| luminance delta for a control pixel to count as "filled/transitioned". */
const FILL_LUMA_DELTA = 30;
/** A column has transitioned when ≥ this fraction of its band rows changed vs baseline. */
const COL_FILL_ROW_FRAC = 0.4;
/** Top fraction of the crop sampled for the card-background luminance estimate. */
const BG_SAMPLE_TOP_FRAC = 0.08;

// ── Completed-state signals (geometry/contrast only — NO colour) ──────────────
// The baseline-relative column count under-reads a control whose baseline is ALREADY
// partially filled (B&BW: the locked first probe is a half-blue button) and whose
// completion is a UNIFORM SOLID block + a centred checkmark — the previously-filled
// columns never transition. These absolute-current-state signals recognise that case
// without re-tuning the column count, staying color/polarity/direction agnostic.
/** A column is "at the dominant level" when its mean luminance is within this band of the
 *  control's median column mean. Wide enough to absorb a thin checkmark's per-column lift
 *  and rounded pill-end columns; narrow enough that a real unfilled remainder (a distinct
 *  track level) is NOT at-level. */
const LEVEL_TOL = 40;
/** A frame is "uniform/solid" when ≥ this fraction of control columns are at the dominant
 *  level — i.e. no unfilled remainder survives. */
const UNIFORM_FRAC = 0.92;
/** Min fraction of control pixels that must have changed vs the baseline for a uniform
 *  current frame to count as a COMPLETED fill (rules out an untouched/empty solid track). */
const CHANGED_AREA_MIN = 0.3;
/** Min |cur − baseline| for a centre pixel to count toward the completion-marker (checkmark)
 *  signal — stricter than FILL_LUMA_DELTA (a checkmark is high-contrast against the fill). */
const MARKER_LUMA_DELTA = 60;
/** Plausible compact-mark band: the centre marker fraction must land in [lo, hi] — below lo is
 *  noise, above hi is a whole-region change (not a discrete mark). */
const MARKER_MIN_FRAC = 0.04;
const MARKER_MAX_FRAC = 0.6;
/** Central sub-region of the control bounds inspected for the completion marker. */
const MARKER_X_INSET_FRAC = 0.3; // central ~40% width
const MARKER_Y_INSET_FRAC = 0.2; // central ~60% height
/** The effective fill_ratio a completed-state signal reports (≥ FULL_RATIO_THRESHOLD so the
 *  unchanged outer 0.92 / 2-frame streak still governs the actual fire). */
const COMPLETION_RATIO = 0.96;

// ─── Safe telemetry enums ─────────────────────────────────────────────────────

export type ControlRejectionReason =
  | "none"
  | "low_contrast"
  | "too_small"
  | "bad_aspect"
  | "too_broad"
  | "off_center";

export type ControlFillKind = "pill_fill" | "bar_fill";

/** Why the detector reported the frame as release-capable (or not). `solid_state` and
 *  `completed_marker` are the completed-state family (uniform solid / centred checkmark);
 *  `column_fill_ge92` is the classic left-to-right bar reaching full. */
export type ChosenReleaseReason =
  | "none"
  | "column_fill_ge92"
  | "solid_state"
  | "completed_marker";

// ─── Dev-only measurement-diagnostics enums (disk/telemetry only — NEVER agent-facing) ──
// These let an operator see WHAT the detector locked onto and WHY a completed-looking control
// failed each release path, without exposing any pixel / coordinate / ratio. Bucketed/enum
// only; surfaced through `noteControlFillDiagnostics` under the double debug-crop gate.

export type ControlBoundsStatus = "locked" | "unresolved" | "pending_baseline";
export type ControlSizeBucket = "tiny" | "small" | "medium" | "large" | "xl";
export type ControlPositionBucket = "near_start" | "center" | "near_end";
export type ControlAspectBucket = "lt2" | "2_4" | "4_8" | "ge8";
export type EdgeSampleCountBucket = "none" | "lt8" | "8_24" | "ge24";
/** Which end(s) of the control held an off-level edge column on the current frame. */
export type EdgeOffLevelSide = "none" | "left" | "right" | "both" | "unknown";
/** Why the uniform-solid completion signal did NOT fire on a measured frame. */
export type UniformSignalFailureReason =
  | "none"
  | "current_not_uniform"
  | "unchanged_uniform_baseline"
  | "insufficient_changed_area"
  | "unresolved_bounds"
  | "unknown";
/** Outcome of the solid-state material-change guard (why the solid path passed/failed). */
export type SolidStateGuardReason =
  | "passed_changed_area"
  | "passed_baseline_nonuniform"
  | "failed_no_material_change"
  | "failed_current_not_uniform"
  | "unknown";
/** Where the centre-marker fraction landed relative to the plausible compact-mark band. */
export type MarkerDeltaBucket = "none" | "below_min" | "in_band" | "above_max";
/** Why the completion-marker (checkmark) signal did NOT fire on a measured frame. */
export type MarkerFailureReason =
  | "none"
  | "center_delta_too_low"
  | "marker_area_too_small"
  | "marker_area_too_large"
  | "surround_not_uniform"
  | "unresolved_bounds"
  | "unknown";

/** Raw per-frame measurement diagnostics (memory-only; bucketed before they ever leave the
 *  module). Carried alongside the decision signals so the evaluator can bucket+forward them
 *  to the disk-only debug-crop note. No firing behavior depends on these. */
export interface ControlMeasurementDiag {
  /** Edge-uniform fraction of the LOCKED baseline frame (raw [0,1]). */
  baseEdgeUniformFraction: number;
  /** Edge-uniform fraction of the CURRENT frame (raw [0,1]). */
  curEdgeUniformFraction: number;
  /** Number of edge columns actually sampled (outside the central marker band). */
  edgeSampleCount: number;
  /** Which end(s) of the current frame held an off-level edge column. */
  edgeOffLevelSide: EdgeOffLevelSide;
  /** Off-level booleans (overlay-only tinting; never serialized to meta). */
  curOffLevelLeft: boolean;
  curOffLevelRight: boolean;
  /** Centre-marker changed-pixel fraction (raw [0,1]). */
  markerFraction: number;
  uniformSignalFailureReason: UniformSignalFailureReason;
  solidStateGuardReason: SolidStateGuardReason;
  markerFailureReason: MarkerFailureReason;
}

/** Bucketed/boolean completion-signal read for a measured frame (telemetry + tests). No raw
 *  ratios escape this module — buckets only. */
export interface CompletionSignals {
  /** Geometric left-to-right transitioned-columns ratio (the existing estimate). */
  columnFillRatio: number;
  /** Fraction of control pixels changed vs the locked baseline. */
  changedAreaRatio: number;
  /** Current frame is a uniform solid fill that materially changed from the baseline. */
  uniformFillSignal: boolean;
  /** A compact high-contrast centre mark (checkmark) on a solid surround. */
  completedMarkerSeen: boolean;
  /** The centre-mark fraction landed in the plausible compact-mark band (pre-surround gate). */
  centerCompletionSignalSeen: boolean;
  /** The effective fill_ratio after folding in the completed-state signals. */
  effectiveFillRatio: number;
  chosenReleaseReason: ChosenReleaseReason;
  /** Dev-only raw measurement diagnostics (bucketed before leaving the module). */
  measurement: ControlMeasurementDiag;
}

/** Coarse fill bucket for safe telemetry — mirrors the monitor's `fillBucket` mapping. */
function fillBucket(ratio: number | undefined): "none" | "lt50" | "50_75" | "75_92" | "ge92" {
  if (ratio === undefined) return "none";
  if (ratio < 0.5) return "lt50";
  if (ratio < 0.75) return "50_75";
  if (ratio < 0.92) return "75_92";
  return "ge92";
}

// ─── Dev-only bucket helpers for measurement diagnostics (enum-only, never raw) ────

/** Control area as a fraction of the whole crop → size band. Answers "are the locked bounds
 *  tightly on the pill, or do they engulf text/background?". */
function boundsSizeBucket(areaFrac: number): ControlSizeBucket {
  if (areaFrac < 0.02) return "tiny";
  if (areaFrac < 0.06) return "small";
  if (areaFrac < 0.15) return "medium";
  if (areaFrac < 0.35) return "large";
  return "xl";
}

/** Centre position (x or y) as a fraction of the crop dimension → shifted/centred band. For
 *  the vertical axis, `near_start` ≈ top and `near_end` ≈ bottom. */
function positionBucket(centerFrac: number): ControlPositionBucket {
  if (centerFrac < 0.4) return "near_start";
  if (centerFrac > 0.6) return "near_end";
  return "center";
}

/** Width/height aspect band — a press-and-hold pill/bar is horizontally elongated. */
function aspectBucket(aspect: number): ControlAspectBucket {
  if (aspect < 2) return "lt2";
  if (aspect < 4) return "2_4";
  if (aspect < 8) return "4_8";
  return "ge8";
}

/** How many edge columns were actually sampled for the uniformity read. */
function edgeSampleCountBucket(n: number): EdgeSampleCountBucket {
  if (n <= 0) return "none";
  if (n < 8) return "lt8";
  if (n < 24) return "8_24";
  return "ge24";
}

/** Where the centre-marker fraction landed relative to the plausible compact-mark band. */
function markerDeltaBucket(markerFrac: number): MarkerDeltaBucket {
  if (markerFrac <= 0) return "none";
  if (markerFrac < MARKER_MIN_FRAC) return "below_min";
  if (markerFrac > MARKER_MAX_FRAC) return "above_max";
  return "in_band";
}

// ─── Per-capsule state (memory-only; pixel grids + bounds never leave this module) ─

interface ControlBounds {
  /** Inclusive pixel column range of the control. */
  x0: number;
  x1: number;
  /** Inclusive pixel row range of the control. */
  y0: number;
  y1: number;
  kind: ControlFillKind;
  band: ReleaseReadyBand;
}

interface ControlFillState {
  W: number;
  H: number;
  /** Fixed baseline luminance grid captured at the first active-hold probe (unfilled control). */
  baselineLum: Float32Array;
  /** Locked control bounds resolved from the baseline, or null when unresolved. */
  bounds: ControlBounds | null;
  /** True once we have run baseline resolution (success OR failure) — bounds are locked after. */
  resolved: boolean;
  /** Why the baseline produced no valid control candidate (for telemetry). */
  rejection: ControlRejectionReason;
}

// Key: capsule_id. Cleared on monitor stop / hold-end (clearControlFill) — see
// visualHandoffMonitor + visualGestureCapsuleHold cleanup paths.
const controlFillStates = new Map<string, ControlFillState>();

/** Drop the per-capsule control-fill state. Idempotent. Call on EVERY monitor stop / hold-end. */
export function clearControlFill(capsuleId: string): void {
  controlFillStates.delete(capsuleId);
}

/** Test-only: drop all control-fill state between cases. */
export function clearControlFillForTests(): void {
  controlFillStates.clear();
}

/** Test-only: coarse current state for a capsule (no pixels) — `none` when absent. */
export function controlFillStateKindForTests(
  capsuleId: string,
): "none" | "tracking_resolved" | "tracking_unresolved" {
  const s = controlFillStates.get(capsuleId);
  if (!s) return "none";
  return s.bounds ? "tracking_resolved" : "tracking_unresolved";
}

// ─── Pure geometry helpers ────────────────────────────────────────────────────

/** Median luminance of the top `BG_SAMPLE_TOP_FRAC` rows — the card background estimate. */
function estimateBackground(L: Float32Array, W: number, H: number): number {
  const topRows = Math.max(2, Math.floor(H * BG_SAMPLE_TOP_FRAC));
  const samples: number[] = [];
  for (let y = 0; y < topRows; y++) {
    for (let x = 0; x < W; x++) samples.push(L[W * y + x]);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

/** Longest contiguous run of `true` in `mask` → [start, end] inclusive, or null if none. */
function longestRun(mask: boolean[]): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let runStart = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && runStart < 0) runStart = i;
    if (!on && runStart >= 0) {
      const run = { start: runStart, end: i - 1 };
      if (!best || run.end - run.start > best.end - best.start) best = run;
      runStart = -1;
    }
  }
  return best;
}

/**
 * Resolve the control bounds from the baseline luminance grid. Returns the bounds and a
 * rejection reason (`none` on success). Pure: no state, never throws.
 */
function resolveControlBounds(
  L: Float32Array,
  W: number,
  H: number,
): { bounds: ControlBounds | null; rejection: ControlRejectionReason } {
  const bg = estimateBackground(L, W, H);

  // Row projection: rows whose ink coverage spans a wide horizontal structure.
  const rowMask: boolean[] = new Array(H).fill(false);
  for (let y = 0; y < H; y++) {
    let ink = 0;
    for (let x = 0; x < W; x++) {
      if (Math.abs(L[W * y + x] - bg) >= CONTROL_CONTRAST) ink += 1;
    }
    rowMask[y] = ink >= ROW_INK_MIN_FRAC * W;
  }
  const yRun = longestRun(rowMask);
  if (!yRun) return { bounds: null, rejection: "low_contrast" };
  const { start: y0, end: y1 } = yRun;
  const bandH = y1 - y0 + 1;

  // Column projection within the row band: columns belonging to the control.
  const colMask: boolean[] = new Array(W).fill(false);
  for (let x = 0; x < W; x++) {
    let ink = 0;
    for (let y = y0; y <= y1; y++) {
      if (Math.abs(L[W * y + x] - bg) >= CONTROL_CONTRAST) ink += 1;
    }
    colMask[x] = ink >= COL_INK_MIN_FRAC * bandH;
  }
  const xRun = longestRun(colMask);
  if (!xRun) return { bounds: null, rejection: "low_contrast" };
  const { start: x0, end: x1 } = xRun;
  const width = x1 - x0 + 1;
  const height = bandH;

  if (width < MIN_CONTROL_W_PX || height < MIN_CONTROL_H_PX) {
    return { bounds: null, rejection: "too_small" };
  }
  // "Engulfs the card" is checked BEFORE aspect so a region that spans most of the crop is
  // reported as too_broad (not mislabeled bad_aspect) — and so a near-full block can never be
  // mistaken for a progress control.
  if ((width * height) / (W * H) > TOO_BROAD_AREA_FRAC || height > TOO_BROAD_H_FRAC * H) {
    return { bounds: null, rejection: "too_broad" };
  }
  const aspect = width / height;
  if (aspect < MIN_CONTROL_ASPECT) {
    return { bounds: null, rejection: "bad_aspect" };
  }
  const cx = (x0 + x1) / 2 / W;
  const cy = (y0 + y1) / 2 / H;
  if (cx < CENTER_X_LO || cx > CENTER_X_HI || cy < CENTER_Y_LO || cy > CENTER_Y_HI) {
    return { bounds: null, rejection: "off_center" };
  }

  const band: ReleaseReadyBand = {
    y_center: (y0 + y1) / 2 / H,
    x0: x0 / W,
    x1: (x1 + 1) / W,
  };
  const kind: ControlFillKind = aspect >= BAR_ASPECT ? "bar_fill" : "pill_fill";
  return { bounds: { x0, x1, y0, y1, kind, band }, rejection: "none" };
}

/**
 * Estimate the fill ratio inside locked control bounds by counting columns that have
 * transitioned away from the baseline. Smoothed across columns (3-wide majority) to suppress
 * shimmer. Direction-agnostic: returns transitioned_columns / total_columns. Pure.
 */
function estimateFillWithinBounds(
  baseLum: Float32Array,
  curLum: Float32Array,
  W: number,
  bounds: ControlBounds,
): number {
  const { x0, x1, y0, y1 } = bounds;
  const bandH = y1 - y0 + 1;
  const cols: number[] = []; // 1 = transitioned, 0 = not
  for (let x = x0; x <= x1; x++) {
    let changed = 0;
    for (let y = y0; y <= y1; y++) {
      const i = W * y + x;
      if (Math.abs(curLum[i] - baseLum[i]) >= FILL_LUMA_DELTA) changed += 1;
    }
    cols.push(changed >= COL_FILL_ROW_FRAC * bandH ? 1 : 0);
  }
  // 3-wide majority smoothing (edges compare against available neighbours only).
  let transitioned = 0;
  for (let i = 0; i < cols.length; i++) {
    let sum = cols[i];
    let n = 1;
    if (i > 0) {
      sum += cols[i - 1];
      n += 1;
    }
    if (i < cols.length - 1) {
      sum += cols[i + 1];
      n += 1;
    }
    if (sum * 2 > n) transitioned += 1;
  }
  return cols.length > 0 ? transitioned / cols.length : 0;
}

/** Per-column mean luminance across the control's row band, left→right. Pure. */
function columnMeans(L: Float32Array, W: number, bounds: ControlBounds): number[] {
  const { x0, x1, y0, y1 } = bounds;
  const bandH = y1 - y0 + 1;
  const means: number[] = [];
  for (let x = x0; x <= x1; x++) {
    let sum = 0;
    for (let y = y0; y <= y1; y++) sum += L[W * y + x];
    means.push(sum / bandH);
  }
  return means;
}

/** Median of a numeric array (non-mutating). Returns 0 for empty input. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Fraction of the control's EDGE columns (outside the central marker band) whose mean
 * luminance sits within `LEVEL_TOL` of the median column mean — i.e. no unfilled REMAINDER
 * survives at either end.
 *
 * WHY EDGES-ONLY (do not "simplify" to all columns):
 *   The completion question is "is there any unfilled track left?", NOT "is the whole control
 *   one flat colour?". Those differ precisely because of the completion CHECKMARK. A finished
 *   B&BW button is a solid fill with a bold white check in the CENTRE; that check lifts the
 *   central columns' means well past `LEVEL_TOL`, so an all-columns uniformity test reads the
 *   completed control as "not uniform" and never fires (this is exactly what an earlier
 *   all-columns version did — the completed-state test caught it). Skipping the central
 *   marker band removes the checkmark's only foothold while losing NO ability to see an
 *   unfilled remainder, because of this invariant:
 *
 *     An unfilled remainder spans [fillFrac, 1.0] (or [0, fillFrac] / both ends for a
 *     right→left / centre-out fill), so it ALWAYS reaches an outer edge. It can never hide
 *     entirely inside the excluded centre band — x=0 and/or x=1 are always outside it.
 *
 *   Therefore: any incomplete fill leaves an off-level EDGE run → not uniform (stays partial);
 *   a complete fill has fill-level edges → uniform, whatever sits in the centre. Direction-
 *   agnostic and colour/polarity agnostic (absolute |mean − median|). Pure.
 */
interface EdgeUniformDetail {
  /** Fraction of sampled edge columns at the dominant level (the existing uniform measure). */
  fraction: number;
  /** Edge columns actually sampled (outside the central marker band). */
  sampleCount: number;
  /** A left-half edge column was off-level. */
  offLevelLeft: boolean;
  /** A right-half edge column was off-level. */
  offLevelRight: boolean;
}

/**
 * Same edge-uniformity arithmetic as {@link edgeUniformFraction} (identical median, LEVEL_TOL,
 * and inset skip → `fraction` is byte-identical) but ALSO reports the sampled count and which
 * end(s) held an off-level column. The extra tallies are dev-diagnostics only and never change
 * the decision. Pure.
 */
function edgeUniformDetail(means: number[], insetFrac: number): EdgeUniformDetail {
  const n = means.length;
  if (n === 0) return { fraction: 0, sampleCount: 0, offLevelLeft: false, offLevelRight: false };
  const inset = Math.floor(n * insetFrac);
  const med = median(means);
  let atLevel = 0;
  let count = 0;
  let offLevelLeft = false;
  let offLevelRight = false;
  for (let i = 0; i < n; i++) {
    // Skip the central marker band: a bold checkmark lives here and would otherwise break
    // uniformity, yet an unfilled remainder can never be confined to it (see docblock).
    if (i >= inset && i < n - inset) continue;
    count += 1;
    if (Math.abs(means[i] - med) <= LEVEL_TOL) {
      atLevel += 1;
    } else if (i < inset) {
      offLevelLeft = true;
    } else {
      offLevelRight = true;
    }
  }
  return {
    fraction: count > 0 ? atLevel / count : 0,
    sampleCount: count,
    offLevelLeft,
    offLevelRight,
  };
}

/** Fraction of control pixels whose |cur − baseline| ≥ FILL_LUMA_DELTA. Pure. */
function changedAreaRatio(
  baseLum: Float32Array,
  curLum: Float32Array,
  W: number,
  bounds: ControlBounds,
): number {
  const { x0, x1, y0, y1 } = bounds;
  let changed = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = W * y + x;
      if (Math.abs(curLum[i] - baseLum[i]) >= FILL_LUMA_DELTA) changed += 1;
      total += 1;
    }
  }
  return total > 0 ? changed / total : 0;
}

/**
 * Fraction of pixels in the CENTRAL sub-region of the control that changed from baseline by a
 * large (marker-grade) delta — the checkmark signature. Pure.
 */
function centerMarkerFraction(
  baseLum: Float32Array,
  curLum: Float32Array,
  W: number,
  bounds: ControlBounds,
): number {
  const { x0, x1, y0, y1 } = bounds;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const cx0 = x0 + Math.floor(w * MARKER_X_INSET_FRAC);
  const cx1 = x1 - Math.floor(w * MARKER_X_INSET_FRAC);
  const cy0 = y0 + Math.floor(h * MARKER_Y_INSET_FRAC);
  const cy1 = y1 - Math.floor(h * MARKER_Y_INSET_FRAC);
  if (cx1 < cx0 || cy1 < cy0) return 0;
  let mark = 0;
  let total = 0;
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const i = W * y + x;
      if (Math.abs(curLum[i] - baseLum[i]) >= MARKER_LUMA_DELTA) mark += 1;
      total += 1;
    }
  }
  return total > 0 ? mark / total : 0;
}

/**
 * Combine the geometric column-fill estimate with the absolute completed-state signals into
 * an effective fill ratio + a release reason. Color/polarity/direction agnostic, pure, never
 * throws. The completed-state signals only ever RAISE the ratio to a full value — the outer
 * 0.92 / 2-frame, position-stable streak still governs the actual fire.
 */
function computeCompletionSignals(
  baseLum: Float32Array,
  curLum: Float32Array,
  W: number,
  bounds: ControlBounds,
): CompletionSignals {
  const columnFillRatio = estimateFillWithinBounds(baseLum, curLum, W, bounds);
  const changed = changedAreaRatio(baseLum, curLum, W, bounds);

  // "Solid completed state": the current frame is uniform AND materially changed from the
  // baseline (so an untouched/empty solid track does not qualify). A baseline that was itself
  // non-uniform (B&BW two-tone) becoming uniform is, on its own, evidence the fill completed.
  // The `*Detail` variants carry the SAME `fraction` plus dev-only off-level/sample tallies.
  const curDetail = edgeUniformDetail(columnMeans(curLum, W, bounds), MARKER_X_INSET_FRAC);
  const baseDetail = edgeUniformDetail(columnMeans(baseLum, W, bounds), MARKER_X_INSET_FRAC);
  const curUniform = curDetail.fraction >= UNIFORM_FRAC;
  const baselineUniform = baseDetail.fraction >= UNIFORM_FRAC;
  const uniformFillSignal = curUniform && (changed >= CHANGED_AREA_MIN || !baselineUniform);

  // "Completion marker" (checkmark): a compact high-contrast centre mark ON a solid surround.
  // The solid-surround requirement makes this impossible to trip on weak shimmer over a
  // still-partial bar.
  const markerFrac = centerMarkerFraction(baseLum, curLum, W, bounds);
  const centerCompletionSignalSeen = markerFrac >= MARKER_MIN_FRAC && markerFrac <= MARKER_MAX_FRAC;
  const completedMarkerSeen = centerCompletionSignalSeen && curUniform;

  let effectiveFillRatio = columnFillRatio;
  let chosenReleaseReason: ChosenReleaseReason = "none";
  if (columnFillRatio >= FULL_RATIO_THRESHOLD) {
    chosenReleaseReason = "column_fill_ge92";
  } else if (uniformFillSignal) {
    effectiveFillRatio = COMPLETION_RATIO;
    chosenReleaseReason = "solid_state";
  } else if (completedMarkerSeen) {
    effectiveFillRatio = COMPLETION_RATIO;
    chosenReleaseReason = "completed_marker";
  }

  // ── Dev-only measurement diagnostics (read-only of the SAME decision values above) ──
  const edgeOffLevelSide: EdgeOffLevelSide =
    curDetail.offLevelLeft && curDetail.offLevelRight
      ? "both"
      : curDetail.offLevelLeft
        ? "left"
        : curDetail.offLevelRight
          ? "right"
          : "none";

  let uniformSignalFailureReason: UniformSignalFailureReason = "none";
  if (!uniformFillSignal) {
    if (!curUniform) uniformSignalFailureReason = "current_not_uniform";
    else if (baselineUniform && changed < CHANGED_AREA_MIN)
      uniformSignalFailureReason = "unchanged_uniform_baseline";
    else uniformSignalFailureReason = "insufficient_changed_area";
  }

  let solidStateGuardReason: SolidStateGuardReason;
  if (!curUniform) solidStateGuardReason = "failed_current_not_uniform";
  else if (changed >= CHANGED_AREA_MIN) solidStateGuardReason = "passed_changed_area";
  else if (!baselineUniform) solidStateGuardReason = "passed_baseline_nonuniform";
  else solidStateGuardReason = "failed_no_material_change";

  let markerFailureReason: MarkerFailureReason = "none";
  if (!completedMarkerSeen) {
    if (markerFrac <= 0) markerFailureReason = "center_delta_too_low";
    else if (markerFrac < MARKER_MIN_FRAC) markerFailureReason = "marker_area_too_small";
    else if (markerFrac > MARKER_MAX_FRAC) markerFailureReason = "marker_area_too_large";
    else if (!curUniform) markerFailureReason = "surround_not_uniform";
    else markerFailureReason = "unknown";
  }

  return {
    columnFillRatio,
    changedAreaRatio: changed,
    uniformFillSignal,
    completedMarkerSeen,
    centerCompletionSignalSeen,
    effectiveFillRatio,
    chosenReleaseReason,
    measurement: {
      baseEdgeUniformFraction: baseDetail.fraction,
      curEdgeUniformFraction: curDetail.fraction,
      edgeSampleCount: curDetail.sampleCount,
      edgeOffLevelSide,
      curOffLevelLeft: curDetail.offLevelLeft,
      curOffLevelRight: curDetail.offLevelRight,
      markerFraction: markerFrac,
      uniformSignalFailureReason,
      solidStateGuardReason,
      markerFailureReason,
    },
  };
}

// ─── Public evaluator ─────────────────────────────────────────────────────────

/**
 * Stateful per-capsule control-fill evaluator. The FIRST call (or after a dims change)
 * captures the baseline, resolves+locks the control bounds, and returns `{found:false}`
 * (cannot measure fill against the baseline yet). Subsequent calls measure the fill ratio
 * inside the locked bounds and return `{found:true, fill_ratio, band}` (NO
 * `temporally_confirmed` — the outer streak still demands the normal 0.92 / 2-frame
 * confirmation). If the baseline yielded no valid control candidate, every frame returns
 * `{found:false}` (fail closed for the whole hold). Never throws.
 */
export function evaluateControlFill(
  capsuleId: string,
  croppedPngBase64: string,
): ProgressFillEstimate {
  const decoded = decodeLuminance(croppedPngBase64);
  if (!decoded) {
    logHvDebug({
      scope: "vgc_release_ready_control_fill",
      control_fill_state: "decode_failed",
      control_candidate_seen: false,
      fired: false,
    });
    return { found: false };
  }

  const prior = controlFillStates.get(capsuleId);

  // First probe for this capsule, or a viewport/dims change: (re)baseline + resolve bounds.
  if (!prior || prior.W !== decoded.W || prior.H !== decoded.H) {
    const { bounds, rejection } = resolveControlBounds(decoded.L, decoded.W, decoded.H);
    controlFillStates.set(capsuleId, {
      W: decoded.W,
      H: decoded.H,
      baselineLum: decoded.L,
      bounds,
      resolved: true,
      rejection,
    });
    logHvDebug({
      scope: "vgc_release_ready_control_fill",
      control_fill_state: prior ? "dims_changed" : "baseline_captured",
      candidate_kind: bounds ? bounds.kind : "none",
      control_candidate_seen: bounds !== null,
      control_rejection_reason: rejection,
      control_bounds_status: bounds ? "pending_baseline" : "unresolved",
      fired: false,
    });
    noteControlFillDiagnostics(capsuleId, {
      chosen_candidate_kind: bounds ? bounds.kind : undefined,
      control_candidate_seen: bounds !== null,
      control_rejection_reason: rejection,
      control_bounds_status: bounds ? "pending_baseline" : "unresolved",
    });
    return { found: false };
  }

  // Baseline yielded no valid control candidate → fail closed for the whole hold.
  if (!prior.bounds) {
    logHvDebug({
      scope: "vgc_release_ready_control_fill",
      control_fill_state: "bounds_unresolved",
      control_candidate_seen: false,
      control_rejection_reason: prior.rejection,
      control_bounds_status: "unresolved",
      fired: false,
    });
    noteControlFillDiagnostics(capsuleId, {
      chosen_candidate_kind: undefined,
      control_candidate_seen: false,
      control_rejection_reason: prior.rejection,
      control_bounds_status: "unresolved",
      uniform_signal_failure_reason: "unresolved_bounds",
      marker_failure_reason: "unresolved_bounds",
    });
    return { found: false };
  }

  const signals = computeCompletionSignals(
    prior.baselineLum,
    decoded.L,
    prior.W,
    prior.bounds,
  );
  const fillRatio = signals.effectiveFillRatio;

  logHvDebug({
    scope: "vgc_release_ready_control_fill",
    control_fill_state: "measured",
    candidate_kind: prior.bounds.kind,
    control_candidate_seen: true,
    control_rejection_reason: "none",
    control_bounds_status: "locked",
    // The final effective bucket (after completed-state signals) plus the raw geometric and
    // changed-area buckets, so an operator can see WHY a completed solid+checkmark frame reads
    // ge92 even when the left-to-right column count alone stayed low.
    fill_bucket: fillBucket(fillRatio),
    control_fill_bucket: fillBucket(fillRatio),
    transitioned_columns_bucket: fillBucket(signals.columnFillRatio),
    changed_area_bucket: fillBucket(signals.changedAreaRatio),
    center_completion_signal_seen: signals.centerCompletionSignalSeen,
    completed_marker_seen: signals.completedMarkerSeen,
    chosen_release_reason: signals.chosenReleaseReason,
    // The outer streak owns the real fire (and logs it) — a single full frame never fires.
    fired: false,
  });
  // Bucket the locked bounds against the crop so an operator can see whether the rectangle
  // is tightly on the pill or engulfing text/background (the suspected miss). Raw px stay here.
  const b = prior.bounds;
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const areaFrac = (bw * bh) / (prior.W * prior.H);
  const cxFrac = (b.x0 + b.x1) / 2 / prior.W;
  const cyFrac = (b.y0 + b.y1) / 2 / prior.H;
  const m = signals.measurement;

  noteControlFillDiagnostics(capsuleId, {
    chosen_candidate_kind: b.kind,
    control_fill_ratio: fillRatio,
    control_candidate_seen: true,
    control_rejection_reason: "none",
    transitioned_columns_ratio: signals.columnFillRatio,
    changed_area_ratio: signals.changedAreaRatio,
    center_completion_signal_seen: signals.centerCompletionSignalSeen,
    completed_marker_seen: signals.completedMarkerSeen,
    chosen_release_reason: signals.chosenReleaseReason,
    // ── Control-measurement breakdown (already bucketed/enum — answers WHY a completed-looking
    // control still reads partial: bad bounds vs. non-uniform current vs. weak marker). ──
    control_bounds_status: "locked",
    control_bounds_size_bucket: boundsSizeBucket(areaFrac),
    control_bounds_horizontal_position_bucket: positionBucket(cxFrac),
    control_bounds_vertical_position_bucket: positionBucket(cyFrac),
    control_bounds_aspect_bucket: aspectBucket(bw / bh),
    base_edge_uniform_bucket: fillBucket(m.baseEdgeUniformFraction),
    cur_edge_uniform_bucket: fillBucket(m.curEdgeUniformFraction),
    edge_off_level_side_bucket: m.edgeOffLevelSide,
    edge_sample_count_bucket: edgeSampleCountBucket(m.edgeSampleCount),
    uniform_signal_seen: signals.uniformFillSignal,
    uniform_signal_failure_reason: m.uniformSignalFailureReason,
    solid_state_guard_reason: m.solidStateGuardReason,
    marker_delta_bucket: markerDeltaBucket(m.markerFraction),
    marker_area_bucket: fillBucket(m.markerFraction),
    marker_failure_reason: m.markerFailureReason,
  });

  // Overlay geometry: RAW px in crop space, used ONLY to draw the dev-only control_overlay.png
  // (never serialized to meta.json). Double-gated inside the note; no-op otherwise.
  const edgeInsetCols = Math.floor(bw * MARKER_X_INSET_FRAC);
  noteControlOverlayGeometry(capsuleId, {
    bounds: { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 },
    edgeInsetCols,
    markerZone: {
      cx0: b.x0 + Math.floor(bw * MARKER_X_INSET_FRAC),
      cx1: b.x1 - Math.floor(bw * MARKER_X_INSET_FRAC),
      cy0: b.y0 + Math.floor(bh * MARKER_Y_INSET_FRAC),
      cy1: b.y1 - Math.floor(bh * MARKER_Y_INSET_FRAC),
    },
    offLevelLeft: m.curOffLevelLeft,
    offLevelRight: m.curOffLevelRight,
  });

  // NO temporally_confirmed: the control-fill read is instantaneous, so it must earn the
  // normal outer 2-frame, position-stable streak at fill_ratio ≥ FULL_RATIO_THRESHOLD.
  return { found: true, fill_ratio: fillRatio, band: prior.bounds.band };
}

/**
 * Test-only: compute the completed-state signals for a baseline/current crop pair without
 * touching the per-capsule state Map. Returns the bucketed/boolean read (no raw ratios leave
 * the runtime in production — this is for unit assertions only). Returns null on decode
 * failure, dims mismatch, or a baseline with no resolvable control.
 */
export function evaluateCompletionSignalsForTests(
  baselinePngBase64: string,
  currentPngBase64: string,
): CompletionSignals | null {
  const base = decodeLuminance(baselinePngBase64);
  const cur = decodeLuminance(currentPngBase64);
  if (!base || !cur) return null;
  if (base.W !== cur.W || base.H !== cur.H) return null;
  const { bounds } = resolveControlBounds(base.L, base.W, base.H);
  if (!bounds) return null;
  return computeCompletionSignals(base.L, cur.L, base.W, bounds);
}
