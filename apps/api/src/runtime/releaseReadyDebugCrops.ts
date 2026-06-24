// ─── Release-Ready Debug Crop Capture (dev-only, double-flag-gated) ────────────
//
// A DEV-ONLY diagnostic that saves the EXACT crop sequence the release-ready
// detector compares (baseline / previous / current / diff) plus safe bucketed
// metadata to a local, gitignored directory, so an operator can answer one
// question after a live press-and-hold run:
//
//   "Is release-ready judging the actual hold progress control, or is the
//    hold-anchor crop too broad / noisy?"
//
// Today the only signal is bucketed telemetry (cumulative_bucket / recent_bucket /
// whole_crop_mode). That cannot show WHICH pixels the whole-crop temporal read is
// plateauing on — a wide, noisy hold-anchor crop can plateau-fire well before the
// real control is full. This module makes the crops visually inspectable.
//
// ── HARD BOUNDARIES ──────────────────────────────────────────────────────────
// - DOUBLE-GATED. Writes NOTHING unless BOTH ANTIGEN_HV_DEBUG and
//   ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS are "true". Off ⇒ every export is an
//   early-return no-op and behavior is byte-identical.
// - BEST-EFFORT / NEVER THROWS. Every IO path is try/catch-wrapped. A capture
//   failure must never alter release-ready behavior, cadence, streak logic, the
//   hold lifecycle, or the returned estimate.
// - NEVER AGENT-VISIBLE. Crop bytes live on disk (and transiently in this module's
//   memory) ONLY. They are never returned to an agent, never embedded in any API
//   response, never logged. Safe telemetry here is `probe_id` + enums/buckets only —
//   never a file path, coordinate, dimension, selector, URL, or pixel.
// - UI GUIDANCE ONLY (unchanged). This module observes; it never clears the VGC,
//   releases the hold, resumes the agent, or changes any threshold.

import fs from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import { logHvDebug } from "./humanVerificationState.js";
import type { SelectedCropSource } from "./visualHandoffMonitor.js";

// Local copies of the safe enum vocabularies (type-only coupling — no runtime import
// of the detector/whole-crop modules, so this leaf module can be imported by them
// without a cycle).
type CandidateKind =
  | "bar"
  | "ring"
  | "pill_fill"
  | "bar_fill"
  | "hold_anchor_whole_crop"
  | "none";
type RatioBucket = "lt0_5" | "0_5_1" | "1_1_5" | "1_5_2" | "2_3" | "3_5" | "ge5";
type StrictStrength = "very_strong" | "moderate" | "none";
type FillBucket = "none" | "lt50" | "50_75" | "75_92" | "ge92";
/** Why the color-agnostic control-fill detector found (or rejected) a control candidate. */
type ControlRejectionReason =
  | "none"
  | "low_contrast"
  | "too_small"
  | "bad_aspect"
  | "too_broad"
  | "off_center";
/** The whole-crop temporal read's compared-frame mode (progress/telemetry only). */
type WholeCropMode = "strict_plateau" | "relaxed_sustained" | "not_strong";
/** Why the control-fill detector reported the frame as release-capable (or not). Mirrors the
 *  detector's `ChosenReleaseReason` (type-only copy — no runtime import, avoids a cycle). */
type ChosenReleaseReason =
  | "none"
  | "column_fill_ge92"
  | "solid_state"
  | "completed_marker";

// Control-measurement diagnostic enums (type-only copies of the detector's vocab — no runtime
// import, avoids a cycle). All bucketed/enum/boolean; raw px/coords/ratios NEVER reach meta.
type ControlBoundsStatus = "locked" | "unresolved" | "pending_baseline";
type ControlSizeBucket = "tiny" | "small" | "medium" | "large" | "xl";
type ControlPositionBucket = "near_start" | "center" | "near_end";
type ControlAspectBucket = "lt2" | "2_4" | "4_8" | "ge8";
type EdgeSampleCountBucket = "none" | "lt8" | "8_24" | "ge24";
type EdgeOffLevelSide = "none" | "left" | "right" | "both" | "unknown";
type UniformSignalFailureReason =
  | "none"
  | "current_not_uniform"
  | "unchanged_uniform_baseline"
  | "insufficient_changed_area"
  | "unresolved_bounds"
  | "unknown";
type SolidStateGuardReason =
  | "passed_changed_area"
  | "passed_baseline_nonuniform"
  | "failed_no_material_change"
  | "failed_current_not_uniform"
  | "unknown";
type MarkerDeltaBucket = "none" | "below_min" | "in_band" | "above_max";
type MarkerFailureReason =
  | "none"
  | "center_delta_too_low"
  | "marker_area_too_small"
  | "marker_area_too_large"
  | "surround_not_uniform"
  | "unresolved_bounds"
  | "unknown";

/** Raw control geometry in crop-pixel space, used ONLY to render the dev-only overlay PNG.
 *  NEVER serialized to meta.json — meta stays enums/buckets/booleans. */
interface ControlOverlayGeom {
  bounds: { x0: number; x1: number; y0: number; y1: number };
  /** Number of leftmost/rightmost columns sampled as the uniform "edge" zones. */
  edgeInsetCols: number;
  /** Excluded centre marker (checkmark) zone. */
  markerZone: { cx0: number; cx1: number; cy0: number; cy1: number };
  /** Off-level edge tints (red when off-level, blue when at-level). */
  offLevelLeft: boolean;
  offLevelRight: boolean;
}

/** Repo-relative default root (gitignored). */
const DEBUG_SUBDIR = path.join("dev-artifacts", "vgc-release-ready-debug");

/**
 * The single gate. BOTH flags required. Mirrors the detector's `shouldEmitDetectorDebug`
 * (both ANTIGEN_HV_DEBUG and a feature flag) so debug crops never write under the
 * generic HV-debug flag alone.
 */
export function isReleaseReadyDebugCropsEnabled(): boolean {
  return (
    process.env.ANTIGEN_HV_DEBUG === "true" &&
    process.env.ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS === "true"
  );
}

// ─── Per-capsule transient state (memory-only; crop bytes never leave the host) ─

/** Diagnostics collected from the detector / whole-crop paths DURING a probe, before
 * the crop bytes arrive (`noteProbeCrop` runs after the estimate is computed). */
interface PendingDiag {
  /** The seam's FINAL chosen candidate kind (set by `noteChosenSelection` after the
   * decision). Kept as the legacy field name so the existing sheet column is unchanged. */
  candidate_kind: CandidateKind;
  cumulative_bucket: RatioBucket | null;
  recent_bucket: RatioBucket | null;
  strict_strength: StrictStrength | null;
  temporally_confirmed: boolean | null;
  /** Color-agnostic control-fill detector: whether a control candidate was located. */
  control_candidate_seen: boolean | null;
  /** Color-agnostic control-fill detector: rejection reason (or `none` on success). */
  control_rejection_reason: ControlRejectionReason | null;
  /** Whole-crop temporal read's compared-frame mode (progress/telemetry evidence only). */
  whole_crop_mode: WholeCropMode | null;
  // ── Seam decision breakdown (primary vs control vs chosen) ──
  // These make the "partial primary did NOT block control-fill" routing visible in the
  // sheet — exactly the bug this fixes. Bucketed/enum-only; never raw ratios.
  /** Per-shape (bar/ring) detector's candidate kind, regardless of whether it won. */
  primary_candidate_kind: CandidateKind;
  /** Per-shape detector's fill bucket (`none` when it found nothing). */
  primary_fill_bucket: FillBucket;
  /** Control-fill detector's candidate kind when it located a control (else null). */
  control_candidate_kind: CandidateKind | null;
  /** Control-fill detector's fill bucket when it measured one (else null). */
  control_fill_bucket: FillBucket | null;
  // ── Completed-state signal breakdown (why a uniform solid + checkmark reads full even when
  // the left-to-right column count stayed low). Bucketed/boolean/enum only. ──
  /** Raw geometric transitioned-columns bucket (before completed-state signals). */
  transitioned_columns_bucket: FillBucket | null;
  /** Fraction-of-control-changed-vs-baseline bucket. */
  changed_area_bucket: FillBucket | null;
  /** A compact centre mark (checkmark) landed in the plausible band (pre-surround gate). */
  center_completion_signal_seen: boolean | null;
  /** A centre mark on a solid surround — the completion-marker trigger. */
  completed_marker_seen: boolean | null;
  /** Which signal made the frame release-capable (or `none`). */
  chosen_release_reason: ChosenReleaseReason | null;
  /** Which estimate the seam returned. */
  chosen_candidate_kind: CandidateKind;
  /** The chosen estimate's fill bucket. */
  chosen_fill_bucket: FillBucket;
  // ── Control-measurement breakdown (dev-only visibility: what bounds were locked + WHY each
  // release path failed). Bucketed/enum/boolean only; null until a measured frame notes them. ──
  control_bounds_status: ControlBoundsStatus | null;
  control_bounds_size_bucket: ControlSizeBucket | null;
  control_bounds_horizontal_position_bucket: ControlPositionBucket | null;
  control_bounds_vertical_position_bucket: ControlPositionBucket | null;
  control_bounds_aspect_bucket: ControlAspectBucket | null;
  base_edge_uniform_bucket: FillBucket | null;
  cur_edge_uniform_bucket: FillBucket | null;
  edge_off_level_side_bucket: EdgeOffLevelSide | null;
  edge_sample_count_bucket: EdgeSampleCountBucket | null;
  uniform_signal_seen: boolean | null;
  uniform_signal_failure_reason: UniformSignalFailureReason | null;
  solid_state_guard_reason: SolidStateGuardReason | null;
  marker_delta_bucket: MarkerDeltaBucket | null;
  marker_area_bucket: FillBucket | null;
  marker_failure_reason: MarkerFailureReason | null;
}

/** A fully-assembled crop bundle awaiting the `fired` decision from the monitor tick. */
interface PendingProbe extends PendingDiag {
  probe_id: string; // zero-padded probeIndex, e.g. "0007"
  currentPngB64: string;
  baselinePngB64: string;
  previousPngB64: string | undefined; // absent on the first probe of a hold
  crop_source: SelectedCropSource;
  /** Locked control geometry for the overlay PNG (absent when no measured frame). */
  overlayGeom: ControlOverlayGeom | undefined;
}

interface CapsuleDebugState {
  probeIndex: number;
  baselinePngB64: string | undefined; // first crop seen this hold (fixed reference)
  previousPngB64: string | undefined; // last crop captured (rolls each probe)
  pendingDiag: PendingDiag | undefined; // notes for the in-flight probe
  pendingOverlayGeom: ControlOverlayGeom | undefined; // overlay geometry for the in-flight probe
  pending: PendingProbe | undefined; // bundle awaiting commit
}

const states = new Map<string, CapsuleDebugState>();

function getState(capsuleId: string): CapsuleDebugState {
  let s = states.get(capsuleId);
  if (!s) {
    s = {
      probeIndex: 0,
      baselinePngB64: undefined,
      previousPngB64: undefined,
      pendingDiag: undefined,
      pendingOverlayGeom: undefined,
      pending: undefined,
    };
    states.set(capsuleId, s);
  }
  return s;
}

function freshDiag(): PendingDiag {
  return {
    candidate_kind: "none",
    cumulative_bucket: null,
    recent_bucket: null,
    strict_strength: null,
    temporally_confirmed: null,
    control_candidate_seen: null,
    control_rejection_reason: null,
    whole_crop_mode: null,
    primary_candidate_kind: "none",
    primary_fill_bucket: "none",
    control_candidate_kind: null,
    control_fill_bucket: null,
    transitioned_columns_bucket: null,
    changed_area_bucket: null,
    center_completion_signal_seen: null,
    completed_marker_seen: null,
    chosen_release_reason: null,
    chosen_candidate_kind: "none",
    chosen_fill_bucket: "none",
    control_bounds_status: null,
    control_bounds_size_bucket: null,
    control_bounds_horizontal_position_bucket: null,
    control_bounds_vertical_position_bucket: null,
    control_bounds_aspect_bucket: null,
    base_edge_uniform_bucket: null,
    cur_edge_uniform_bucket: null,
    edge_off_level_side_bucket: null,
    edge_sample_count_bucket: null,
    uniform_signal_seen: null,
    uniform_signal_failure_reason: null,
    solid_state_guard_reason: null,
    marker_delta_bucket: null,
    marker_area_bucket: null,
    marker_failure_reason: null,
  };
}

/** Coarse fill bucket for disk-only debug meta — mirrors the detectors' `fillBucket`. */
function fillBucketFromRatio(ratio: number | undefined): FillBucket {
  if (ratio === undefined) return "none";
  if (ratio < 0.5) return "lt50";
  if (ratio < 0.75) return "50_75";
  if (ratio < 0.92) return "75_92";
  return "ge92";
}

// ─── Notes from the detector / whole-crop paths (run inside the probe) ─────────

/**
 * Record the per-shape detector's chosen candidate kind for the in-flight probe.
 * Called from `estimateProgressFillRatio` (flag-gated there too). The whole-crop note
 * below runs LATER in the same probe and overrides `candidate_kind` when the temporal
 * fallback is the one that produced the estimate — natural last-writer-wins precedence
 * matches the execution order.
 */
export function noteDetectorDiagnostics(
  capsuleId: string,
  diag: { chosen_candidate_kind: CandidateKind; fill_ratio?: number },
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  // The per-shape detector runs FIRST in every probe, so this note opens a fresh
  // diagnostics slot — resetting the buckets so a prior probe's whole-crop values can
  // never leak into a frame where the temporal fallback did not run. Records the primary
  // (per-shape) breakdown; `candidate_kind`/`chosen_*` seed to primary and are finalized by
  // `noteChosenSelection` once the seam picks a winner.
  const primaryBucket = fillBucketFromRatio(diag.fill_ratio);
  s.pendingDiag = {
    ...freshDiag(),
    candidate_kind: diag.chosen_candidate_kind,
    primary_candidate_kind: diag.chosen_candidate_kind,
    primary_fill_bucket: primaryBucket,
    chosen_candidate_kind: diag.chosen_candidate_kind,
    chosen_fill_bucket: primaryBucket,
  };
}

/**
 * Record the whole-crop temporal fallback's bucketed diagnostics for the in-flight
 * probe (the `compared` path only — baseline/decode frames have no comparison yet).
 * All values are the SAME coarse buckets the existing `vgc_release_ready_whole_crop`
 * log already emits.
 */
export function noteWholeCropDiagnostics(
  capsuleId: string,
  diag: {
    chosen_candidate_kind: CandidateKind;
    cumulative_bucket: RatioBucket;
    recent_bucket: RatioBucket;
    strict_strength: StrictStrength;
    temporally_confirmed: boolean;
    whole_crop_mode: WholeCropMode;
  },
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  s.pendingDiag = {
    ...(s.pendingDiag ?? freshDiag()),
    candidate_kind: diag.chosen_candidate_kind,
    cumulative_bucket: diag.cumulative_bucket,
    recent_bucket: diag.recent_bucket,
    strict_strength: diag.strict_strength,
    temporally_confirmed: diag.temporally_confirmed,
    whole_crop_mode: diag.whole_crop_mode,
  };
}

/**
 * Record the color-agnostic control-fill detector's diagnostics for the in-flight probe.
 * Called from `evaluateControlFill` (flag-gated there too). Runs AFTER the per-shape detector
 * note and BEFORE the whole-crop note in the same probe. `chosen_candidate_kind` overrides
 * `candidate_kind` ONLY when the detector located a control (`pill_fill`/`bar_fill`); when it
 * found nothing it leaves the prior kind untouched and records only the seen/reason fields.
 */
export function noteControlFillDiagnostics(
  capsuleId: string,
  diag: {
    chosen_candidate_kind?: "pill_fill" | "bar_fill";
    control_fill_ratio?: number;
    control_candidate_seen: boolean;
    control_rejection_reason: ControlRejectionReason;
    // Completed-state breakdown (only present on measured frames).
    transitioned_columns_ratio?: number;
    changed_area_ratio?: number;
    center_completion_signal_seen?: boolean;
    completed_marker_seen?: boolean;
    chosen_release_reason?: ChosenReleaseReason;
    // ── Control-measurement breakdown (already bucketed/enum by the detector). All optional:
    // the early-return paths pass only `control_bounds_status` (+ unresolved reasons). ──
    control_bounds_status?: ControlBoundsStatus;
    control_bounds_size_bucket?: ControlSizeBucket;
    control_bounds_horizontal_position_bucket?: ControlPositionBucket;
    control_bounds_vertical_position_bucket?: ControlPositionBucket;
    control_bounds_aspect_bucket?: ControlAspectBucket;
    base_edge_uniform_bucket?: FillBucket;
    cur_edge_uniform_bucket?: FillBucket;
    edge_off_level_side_bucket?: EdgeOffLevelSide;
    edge_sample_count_bucket?: EdgeSampleCountBucket;
    uniform_signal_seen?: boolean;
    uniform_signal_failure_reason?: UniformSignalFailureReason;
    solid_state_guard_reason?: SolidStateGuardReason;
    marker_delta_bucket?: MarkerDeltaBucket;
    marker_area_bucket?: FillBucket;
    marker_failure_reason?: MarkerFailureReason;
  },
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  const base = s.pendingDiag ?? freshDiag();
  // Record the control-fill breakdown into its OWN slots. The legacy `candidate_kind` /
  // `chosen_*` are NOT touched here — the seam's `noteChosenSelection` is the sole authority
  // on the winner, so a partial-primary frame where control loses is reported correctly.
  s.pendingDiag = {
    ...base,
    control_candidate_seen: diag.control_candidate_seen,
    control_rejection_reason: diag.control_rejection_reason,
    ...(diag.chosen_candidate_kind ? { control_candidate_kind: diag.chosen_candidate_kind } : {}),
    ...(diag.chosen_candidate_kind
      ? { control_fill_bucket: fillBucketFromRatio(diag.control_fill_ratio) }
      : {}),
    ...(diag.transitioned_columns_ratio !== undefined
      ? { transitioned_columns_bucket: fillBucketFromRatio(diag.transitioned_columns_ratio) }
      : {}),
    ...(diag.changed_area_ratio !== undefined
      ? { changed_area_bucket: fillBucketFromRatio(diag.changed_area_ratio) }
      : {}),
    ...(diag.center_completion_signal_seen !== undefined
      ? { center_completion_signal_seen: diag.center_completion_signal_seen }
      : {}),
    ...(diag.completed_marker_seen !== undefined
      ? { completed_marker_seen: diag.completed_marker_seen }
      : {}),
    ...(diag.chosen_release_reason !== undefined
      ? { chosen_release_reason: diag.chosen_release_reason }
      : {}),
    // Control-measurement breakdown — store each already-bucketed value when present.
    ...(diag.control_bounds_status !== undefined
      ? { control_bounds_status: diag.control_bounds_status }
      : {}),
    ...(diag.control_bounds_size_bucket !== undefined
      ? { control_bounds_size_bucket: diag.control_bounds_size_bucket }
      : {}),
    ...(diag.control_bounds_horizontal_position_bucket !== undefined
      ? { control_bounds_horizontal_position_bucket: diag.control_bounds_horizontal_position_bucket }
      : {}),
    ...(diag.control_bounds_vertical_position_bucket !== undefined
      ? { control_bounds_vertical_position_bucket: diag.control_bounds_vertical_position_bucket }
      : {}),
    ...(diag.control_bounds_aspect_bucket !== undefined
      ? { control_bounds_aspect_bucket: diag.control_bounds_aspect_bucket }
      : {}),
    ...(diag.base_edge_uniform_bucket !== undefined
      ? { base_edge_uniform_bucket: diag.base_edge_uniform_bucket }
      : {}),
    ...(diag.cur_edge_uniform_bucket !== undefined
      ? { cur_edge_uniform_bucket: diag.cur_edge_uniform_bucket }
      : {}),
    ...(diag.edge_off_level_side_bucket !== undefined
      ? { edge_off_level_side_bucket: diag.edge_off_level_side_bucket }
      : {}),
    ...(diag.edge_sample_count_bucket !== undefined
      ? { edge_sample_count_bucket: diag.edge_sample_count_bucket }
      : {}),
    ...(diag.uniform_signal_seen !== undefined
      ? { uniform_signal_seen: diag.uniform_signal_seen }
      : {}),
    ...(diag.uniform_signal_failure_reason !== undefined
      ? { uniform_signal_failure_reason: diag.uniform_signal_failure_reason }
      : {}),
    ...(diag.solid_state_guard_reason !== undefined
      ? { solid_state_guard_reason: diag.solid_state_guard_reason }
      : {}),
    ...(diag.marker_delta_bucket !== undefined
      ? { marker_delta_bucket: diag.marker_delta_bucket }
      : {}),
    ...(diag.marker_area_bucket !== undefined
      ? { marker_area_bucket: diag.marker_area_bucket }
      : {}),
    ...(diag.marker_failure_reason !== undefined
      ? { marker_failure_reason: diag.marker_failure_reason }
      : {}),
  };
}

/**
 * Stash the locked control geometry (raw px in crop space) for the in-flight probe, used ONLY
 * to render `control_overlay.png` at commit. Double-gated; no-op off. The geometry NEVER
 * reaches meta.json — it is an overlay-image input only, consistent with the crop bytes.
 */
export function noteControlOverlayGeometry(capsuleId: string, geom: ControlOverlayGeom): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  s.pendingOverlayGeom = geom;
}

/**
 * Record the seam's FINAL routing decision for the in-flight probe. Called from the seam
 * (`estimateReleaseReadyWithWholeCropFallback`) AFTER it has chosen which estimate to return,
 * so the chosen candidate/bucket is correct even on the partial-primary path where the
 * whole-crop note would otherwise clobber `candidate_kind`. `source` selects which already-
 * recorded breakdown (primary or control) becomes the chosen one. Flag-gated; no-op off.
 */
export function noteChosenSelection(
  capsuleId: string,
  source: "primary" | "control",
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  const base = s.pendingDiag ?? freshDiag();
  const chosenKind: CandidateKind =
    source === "control" ? base.control_candidate_kind ?? "none" : base.primary_candidate_kind;
  const chosenBucket: FillBucket =
    source === "control" ? base.control_fill_bucket ?? "none" : base.primary_fill_bucket;
  s.pendingDiag = {
    ...base,
    candidate_kind: chosenKind,
    chosen_candidate_kind: chosenKind,
    chosen_fill_bucket: chosenBucket,
  };
}

// ─── Crop bytes (run at the end of the probe, once the crop exists) ────────────

/**
 * Stash the current probe's crop bytes + source, fold in any diagnostics noted during
 * the probe, and roll the baseline/previous references. Builds the `pending` bundle the
 * monitor commits after the fire decision. No disk IO here. No-op when the flag is off.
 */
export function noteProbeCrop(
  capsuleId: string,
  args: { croppedPngB64: string; cropSource: SelectedCropSource },
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  if (!s.baselinePngB64) s.baselinePngB64 = args.croppedPngB64;
  s.probeIndex += 1;
  const diag = s.pendingDiag ?? freshDiag();
  s.pending = {
    probe_id: String(s.probeIndex).padStart(4, "0"),
    currentPngB64: args.croppedPngB64,
    baselinePngB64: s.baselinePngB64,
    previousPngB64: s.previousPngB64,
    crop_source: args.cropSource,
    overlayGeom: s.pendingOverlayGeom,
    ...diag,
  };
  // Roll forward for the NEXT probe. baseline stays fixed for the whole hold.
  s.previousPngB64 = args.croppedPngB64;
  s.pendingDiag = undefined;
  s.pendingOverlayGeom = undefined;
}

// ─── Commit (run from the monitor tick, once `fired` is known) ─────────────────

export interface CommitProbeCropOpts {
  /** Output root override (tests pass a tmp dir). */
  outputRoot?: string;
  /** Clock seam (created_at). */
  now?: () => Date;
}

/**
 * Finalize the in-flight probe: write baseline/previous/current/diff PNGs + meta.json
 * to `<root>/vgc-release-ready-debug/<capsule_id>/<probe_id>/`, then clear the pending
 * slot. NEVER throws. No-op when the flag is off or no probe is pending.
 *
 * `fill_bucket` / `found` / `fired` / `consecutive_full` are the SAME safe scalars the
 * monitor already logs under `scope: vgc_release_ready`.
 */
export function commitProbeCrop(
  capsuleId: string,
  result: { found: boolean; fired: boolean; consecutive_full: number; fill_bucket: FillBucket },
  opts: CommitProbeCropOpts = {},
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = states.get(capsuleId);
  const pending = s?.pending;
  if (!s || !pending) return;
  s.pending = undefined;

  try {
    const nowDate = opts.now ? opts.now() : new Date();
    const root = resolveDebugRoot(opts.outputRoot);
    const dir = path.join(root, sanitizeSegment(capsuleId), pending.probe_id);
    fs.mkdirSync(dir, { recursive: true });

    // current is always written; baseline is the fixed first crop; previous is absent on
    // the first probe of a hold; diff only when previous exists and dims match.
    fs.writeFileSync(path.join(dir, "current.png"), Buffer.from(pending.currentPngB64, "base64"));
    fs.writeFileSync(path.join(dir, "baseline.png"), Buffer.from(pending.baselinePngB64, "base64"));
    let diffWritten = false;
    if (pending.previousPngB64 !== undefined) {
      fs.writeFileSync(path.join(dir, "previous.png"), Buffer.from(pending.previousPngB64, "base64"));
      const diff = buildDiffPng(pending.previousPngB64, pending.currentPngB64);
      if (diff) {
        fs.writeFileSync(path.join(dir, "diff.png"), Buffer.from(diff, "base64"));
        diffWritten = true;
      }
    }

    // Optional control-fill measurement overlay (operator-only pixel annotations on the current
    // crop). Only present when a measured frame stashed locked geometry; fail-soft (null → skip).
    let overlayWritten = false;
    if (pending.overlayGeom !== undefined) {
      const overlay = buildControlOverlayPng(pending.currentPngB64, pending.overlayGeom);
      if (overlay) {
        fs.writeFileSync(path.join(dir, "control_overlay.png"), Buffer.from(overlay, "base64"));
        overlayWritten = true;
      }
    }

    const meta = buildMeta(capsuleId, pending, result, nowDate.toISOString(), diffWritten, overlayWritten);
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    // Safe telemetry — probe_id + enums/buckets/booleans only. No path, no pixels.
    logHvDebug({
      scope: "vgc_release_ready_debug_crop",
      debug_crop_event: "written",
      probe_id: pending.probe_id,
      crop_source: pending.crop_source,
      candidate_kind: pending.candidate_kind,
      fill_bucket: result.fill_bucket,
      fired: result.fired,
      diff_written: diffWritten,
      control_overlay_written: overlayWritten,
    });
  } catch {
    // Best-effort: a write failure must never affect release-ready behavior.
    logHvDebug({
      scope: "vgc_release_ready_debug_crop",
      debug_crop_event: "write_failed",
      probe_id: pending.probe_id,
    });
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/** Drop the per-capsule debug state. Idempotent. Call on EVERY monitor stop path
 * (alongside `clearWholeCropProgress`). */
export function clearReleaseReadyDebugCrops(capsuleId: string): void {
  states.delete(capsuleId);
}

/** Test-only: drop all debug state between cases. */
export function clearAllReleaseReadyDebugCropsForTests(): void {
  states.clear();
}

// ─── meta.json (allowlist-built — safe enums/buckets/booleans/ids only) ────────

/** Exhaustive, fixed key set written to meta.json. No coordinates, dimensions, pixel
 * counts, paths, URLs, selectors, or raw ratios are ever included. */
interface ReleaseReadyDebugMeta {
  capsule_id: string;
  probe_id: string;
  created_at: string;
  crop_source: SelectedCropSource;
  candidate_kind: CandidateKind;
  found: boolean;
  fill_bucket: FillBucket;
  cumulative_bucket: RatioBucket | null;
  recent_bucket: RatioBucket | null;
  strict_strength: StrictStrength | null;
  temporally_confirmed: boolean | null;
  control_candidate_seen: boolean | null;
  control_rejection_reason: ControlRejectionReason | null;
  whole_crop_mode: WholeCropMode | null;
  /** INVARIANT: the whole-crop temporal read never fires release_ready — always false. */
  whole_crop_release_triggered: boolean;
  // Seam decision breakdown (primary vs control vs chosen) — see PendingDiag.
  primary_candidate_kind: CandidateKind;
  primary_fill_bucket: FillBucket;
  control_candidate_kind: CandidateKind | null;
  control_fill_bucket: FillBucket | null;
  transitioned_columns_bucket: FillBucket | null;
  changed_area_bucket: FillBucket | null;
  center_completion_signal_seen: boolean | null;
  completed_marker_seen: boolean | null;
  chosen_release_reason: ChosenReleaseReason | null;
  chosen_candidate_kind: CandidateKind;
  chosen_fill_bucket: FillBucket;
  // Control-measurement breakdown (dev-only; bucketed/enum/boolean — never px/coords).
  control_bounds_status: ControlBoundsStatus | null;
  control_bounds_size_bucket: ControlSizeBucket | null;
  control_bounds_horizontal_position_bucket: ControlPositionBucket | null;
  control_bounds_vertical_position_bucket: ControlPositionBucket | null;
  control_bounds_aspect_bucket: ControlAspectBucket | null;
  base_edge_uniform_bucket: FillBucket | null;
  cur_edge_uniform_bucket: FillBucket | null;
  edge_off_level_side_bucket: EdgeOffLevelSide | null;
  edge_sample_count_bucket: EdgeSampleCountBucket | null;
  uniform_signal_seen: boolean | null;
  uniform_signal_failure_reason: UniformSignalFailureReason | null;
  solid_state_guard_reason: SolidStateGuardReason | null;
  marker_delta_bucket: MarkerDeltaBucket | null;
  marker_area_bucket: FillBucket | null;
  marker_failure_reason: MarkerFailureReason | null;
  consecutive_full: number;
  fired: boolean;
  has_previous: boolean;
  has_diff: boolean;
  /** Whether the operator-only control-fill overlay PNG was written this probe. */
  has_control_overlay: boolean;
}

function buildMeta(
  capsuleId: string,
  pending: PendingProbe,
  result: { found: boolean; fired: boolean; consecutive_full: number; fill_bucket: FillBucket },
  createdAt: string,
  diffWritten: boolean,
  overlayWritten: boolean,
): ReleaseReadyDebugMeta {
  return {
    capsule_id: capsuleId,
    probe_id: pending.probe_id,
    created_at: createdAt,
    crop_source: pending.crop_source,
    candidate_kind: pending.candidate_kind,
    found: result.found,
    fill_bucket: result.fill_bucket,
    cumulative_bucket: pending.cumulative_bucket,
    recent_bucket: pending.recent_bucket,
    strict_strength: pending.strict_strength,
    temporally_confirmed: pending.temporally_confirmed,
    control_candidate_seen: pending.control_candidate_seen,
    control_rejection_reason: pending.control_rejection_reason,
    whole_crop_mode: pending.whole_crop_mode,
    // Hard invariant surfaced in the sheet: the whole-crop plateau is never a release trigger.
    whole_crop_release_triggered: false,
    primary_candidate_kind: pending.primary_candidate_kind,
    primary_fill_bucket: pending.primary_fill_bucket,
    control_candidate_kind: pending.control_candidate_kind,
    control_fill_bucket: pending.control_fill_bucket,
    transitioned_columns_bucket: pending.transitioned_columns_bucket,
    changed_area_bucket: pending.changed_area_bucket,
    center_completion_signal_seen: pending.center_completion_signal_seen,
    completed_marker_seen: pending.completed_marker_seen,
    chosen_release_reason: pending.chosen_release_reason,
    chosen_candidate_kind: pending.chosen_candidate_kind,
    chosen_fill_bucket: pending.chosen_fill_bucket,
    control_bounds_status: pending.control_bounds_status,
    control_bounds_size_bucket: pending.control_bounds_size_bucket,
    control_bounds_horizontal_position_bucket: pending.control_bounds_horizontal_position_bucket,
    control_bounds_vertical_position_bucket: pending.control_bounds_vertical_position_bucket,
    control_bounds_aspect_bucket: pending.control_bounds_aspect_bucket,
    base_edge_uniform_bucket: pending.base_edge_uniform_bucket,
    cur_edge_uniform_bucket: pending.cur_edge_uniform_bucket,
    edge_off_level_side_bucket: pending.edge_off_level_side_bucket,
    edge_sample_count_bucket: pending.edge_sample_count_bucket,
    uniform_signal_seen: pending.uniform_signal_seen,
    uniform_signal_failure_reason: pending.uniform_signal_failure_reason,
    solid_state_guard_reason: pending.solid_state_guard_reason,
    marker_delta_bucket: pending.marker_delta_bucket,
    marker_area_bucket: pending.marker_area_bucket,
    marker_failure_reason: pending.marker_failure_reason,
    consecutive_full: result.consecutive_full,
    fired: result.fired,
    has_previous: pending.previousPngB64 !== undefined,
    has_diff: diffWritten,
    has_control_overlay: overlayWritten,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A grayscale absolute-luminance-difference PNG (base64) of two equal-size crops, for
 * a quick visual "what changed between frames" read. Returns null on any decode failure
 * or a dims mismatch — diff is always optional, never throws. Self-contained pngjs
 * decode (no runtime import of the whole-crop module → no import cycle). */
function buildDiffPng(prevB64: string, curB64: string): string | null {
  try {
    const a = PNG.sync.read(Buffer.from(prevB64, "base64"));
    const b = PNG.sync.read(Buffer.from(curB64, "base64"));
    if (a.width !== b.width || a.height !== b.height) return null;
    if (a.width <= 0 || a.height <= 0) return null;
    const out = new PNG({ width: a.width, height: a.height });
    for (let i = 0; i < a.data.length; i += 4) {
      const la = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
      const lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
      const d = Math.min(255, Math.round(Math.abs(la - lb)));
      out.data[i] = d;
      out.data[i + 1] = d;
      out.data[i + 2] = d;
      out.data[i + 3] = 255;
    }
    return PNG.sync.write(out).toString("base64");
  } catch {
    return null;
  }
}

/**
 * Operator-only control-fill measurement overlay (base64 PNG) drawn over the CURRENT crop:
 *   - GREEN rectangle  = the locked control bounds the detector measured inside;
 *   - BLUE/RED shading  = the left/right EDGE sample zones (red = that end held an off-level
 *                          column → an unfilled remainder → not uniform);
 *   - RED rectangle     = the excluded centre MARKER (checkmark) zone.
 * This answers, at a glance, whether the rectangle sits on the pill, the edge zones sit on the
 * pill ends, and the marker zone covers the dots/checkmark. Pixel annotations are allowed here
 * because this is a local dev image artifact (like baseline/current/diff) — NEVER agent-visible,
 * double-gated, and never serialized to meta.json. Returns null on any decode failure or
 * out-of-range geometry (overlay is always optional, never throws). Self-contained pngjs. */
function buildControlOverlayPng(curB64: string, geom: ControlOverlayGeom): string | null {
  try {
    const img = PNG.sync.read(Buffer.from(curB64, "base64"));
    const { width, height } = img;
    if (width <= 0 || height <= 0) return null;
    const { bounds, edgeInsetCols, markerZone } = geom;
    // Reject geometry that does not fit the current crop (dims may have changed between frames).
    if (bounds.x1 < bounds.x0 || bounds.y1 < bounds.y0) return null;
    if (bounds.x0 < 0 || bounds.y0 < 0 || bounds.x1 >= width || bounds.y1 >= height) return null;

    const out = new PNG({ width, height });
    out.data.set(img.data);
    const clampX = (x: number): number => Math.max(0, Math.min(width - 1, x));
    const clampY = (y: number): number => Math.max(0, Math.min(height - 1, y));
    const setPx = (x: number, y: number, r: number, g: number, b: number): void => {
      const i = (width * clampY(y) + clampX(x)) << 2;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    };
    // Semi-transparent blend so the underlying control stays visible under the zone shading.
    const blend = (x: number, y: number, r: number, g: number, b: number): void => {
      const i = (width * clampY(y) + clampX(x)) << 2;
      out.data[i] = (out.data[i] + r) >> 1;
      out.data[i + 1] = (out.data[i + 1] + g) >> 1;
      out.data[i + 2] = (out.data[i + 2] + b) >> 1;
      out.data[i + 3] = 255;
    };
    const rectOutline = (
      rx0: number,
      ry0: number,
      rx1: number,
      ry1: number,
      r: number,
      g: number,
      b: number,
    ): void => {
      for (let x = rx0; x <= rx1; x++) {
        setPx(x, ry0, r, g, b);
        setPx(x, ry1, r, g, b);
      }
      for (let y = ry0; y <= ry1; y++) {
        setPx(rx0, y, r, g, b);
        setPx(rx1, y, r, g, b);
      }
    };

    const inset = Math.max(0, edgeInsetCols);
    // Left edge sample zone.
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      for (let x = bounds.x0; x < bounds.x0 + inset && x <= bounds.x1; x++) {
        if (geom.offLevelLeft) blend(x, y, 220, 40, 40);
        else blend(x, y, 40, 40, 220);
      }
    }
    // Right edge sample zone.
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      for (let x = bounds.x1 - inset + 1; x <= bounds.x1 && x >= bounds.x0; x++) {
        if (geom.offLevelRight) blend(x, y, 220, 40, 40);
        else blend(x, y, 40, 40, 220);
      }
    }
    // Excluded centre marker zone outline (red), then the locked bounds outline (green) on top.
    if (markerZone.cx1 >= markerZone.cx0 && markerZone.cy1 >= markerZone.cy0) {
      rectOutline(markerZone.cx0, markerZone.cy0, markerZone.cx1, markerZone.cy1, 230, 30, 30);
    }
    rectOutline(bounds.x0, bounds.y0, bounds.x1, bounds.y1, 30, 220, 30);

    return PNG.sync.write(out).toString("base64");
  } catch {
    return null;
  }
}

/** Keep capsule_id safe as a single path segment (defense-in-depth — capsule ids are
 * already opaque slugs). Never allows traversal. */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

/**
 * Resolve the debug-crop root. Override wins; otherwise the repo-root
 * `dev-artifacts/vgc-release-ready-debug` (resolution mirrors `resolveDatasetRoot`:
 * try cwd, then two up — apps/api → repo root, then one up).
 */
function resolveDebugRoot(override?: string): string {
  if (override) return override;
  const candidates = [
    path.resolve(process.cwd(), "dev-artifacts"),
    path.resolve(process.cwd(), "../..", "dev-artifacts"),
    path.resolve(process.cwd(), "..", "dev-artifacts"),
  ];
  const existingParent = candidates.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });
  if (existingParent) return path.join(existingParent, "vgc-release-ready-debug");
  return path.resolve(process.cwd(), "../..", DEBUG_SUBDIR);
}
