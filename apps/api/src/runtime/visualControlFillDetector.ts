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
import { noteControlFillDiagnostics } from "./releaseReadyDebugCrops.js";
import {
  decodeLuminance,
} from "./visualReleaseReadyWholeCrop.js";
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

// ─── Safe telemetry enums ─────────────────────────────────────────────────────

export type ControlRejectionReason =
  | "none"
  | "low_contrast"
  | "too_small"
  | "bad_aspect"
  | "too_broad"
  | "off_center";

export type ControlFillKind = "pill_fill" | "bar_fill";

/** Coarse fill bucket for safe telemetry — mirrors the monitor's `fillBucket` mapping. */
function fillBucket(ratio: number | undefined): "none" | "lt50" | "50_75" | "75_92" | "ge92" {
  if (ratio === undefined) return "none";
  if (ratio < 0.5) return "lt50";
  if (ratio < 0.75) return "50_75";
  if (ratio < 0.92) return "75_92";
  return "ge92";
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
      fired: false,
    });
    noteControlFillDiagnostics(capsuleId, {
      chosen_candidate_kind: bounds ? bounds.kind : undefined,
      control_candidate_seen: bounds !== null,
      control_rejection_reason: rejection,
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
      fired: false,
    });
    noteControlFillDiagnostics(capsuleId, {
      chosen_candidate_kind: undefined,
      control_candidate_seen: false,
      control_rejection_reason: prior.rejection,
    });
    return { found: false };
  }

  const fillRatio = estimateFillWithinBounds(
    prior.baselineLum,
    decoded.L,
    prior.W,
    prior.bounds,
  );

  logHvDebug({
    scope: "vgc_release_ready_control_fill",
    control_fill_state: "measured",
    candidate_kind: prior.bounds.kind,
    control_candidate_seen: true,
    control_rejection_reason: "none",
    fill_bucket: fillBucket(fillRatio),
    // The outer streak owns the real fire (and logs it) — a single full frame never fires.
    fired: false,
  });
  noteControlFillDiagnostics(capsuleId, {
    chosen_candidate_kind: prior.bounds.kind,
    control_candidate_seen: true,
    control_rejection_reason: "none",
  });

  // NO temporally_confirmed: the control-fill read is instantaneous, so it must earn the
  // normal outer 2-frame, position-stable streak at fill_ratio ≥ FULL_RATIO_THRESHOLD.
  return { found: true, fill_ratio: fillRatio, band: prior.bounds.band };
}
