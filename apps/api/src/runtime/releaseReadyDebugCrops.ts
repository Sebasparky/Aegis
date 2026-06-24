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
}

/** A fully-assembled crop bundle awaiting the `fired` decision from the monitor tick. */
interface PendingProbe extends PendingDiag {
  probe_id: string; // zero-padded probeIndex, e.g. "0007"
  currentPngB64: string;
  baselinePngB64: string;
  previousPngB64: string | undefined; // absent on the first probe of a hold
  crop_source: SelectedCropSource;
}

interface CapsuleDebugState {
  probeIndex: number;
  baselinePngB64: string | undefined; // first crop seen this hold (fixed reference)
  previousPngB64: string | undefined; // last crop captured (rolls each probe)
  pendingDiag: PendingDiag | undefined; // notes for the in-flight probe
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
  };
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
  diag: { chosen_candidate_kind: CandidateKind },
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  // The per-shape detector runs FIRST in every probe, so this note opens a fresh
  // diagnostics slot — resetting the buckets so a prior probe's whole-crop values can
  // never leak into a frame where the temporal fallback did not run.
  s.pendingDiag = { ...freshDiag(), candidate_kind: diag.chosen_candidate_kind };
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
    control_candidate_seen: boolean;
    control_rejection_reason: ControlRejectionReason;
  },
): void {
  if (!isReleaseReadyDebugCropsEnabled()) return;
  const s = getState(capsuleId);
  const base = s.pendingDiag ?? freshDiag();
  s.pendingDiag = {
    ...base,
    ...(diag.chosen_candidate_kind ? { candidate_kind: diag.chosen_candidate_kind } : {}),
    control_candidate_seen: diag.control_candidate_seen,
    control_rejection_reason: diag.control_rejection_reason,
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
    ...diag,
  };
  // Roll forward for the NEXT probe. baseline stays fixed for the whole hold.
  s.previousPngB64 = args.croppedPngB64;
  s.pendingDiag = undefined;
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

    const meta = buildMeta(capsuleId, pending, result, nowDate.toISOString(), diffWritten);
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
  consecutive_full: number;
  fired: boolean;
  has_previous: boolean;
  has_diff: boolean;
}

function buildMeta(
  capsuleId: string,
  pending: PendingProbe,
  result: { found: boolean; fired: boolean; consecutive_full: number; fill_bucket: FillBucket },
  createdAt: string,
  diffWritten: boolean,
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
    consecutive_full: result.consecutive_full,
    fired: result.fired,
    has_previous: pending.previousPngB64 !== undefined,
    has_diff: diffWritten,
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
