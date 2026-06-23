/**
 * VisualBlockerClassifierPipeline — dev-only dataset capture (Phase 2A).
 *
 * When `ANTIGEN_HV_VISION_DATASET` is on AND the pipeline produced a real
 * `visual_classifier_candidate`, capture a redacted full-viewport frame plus safe
 * metadata to a LOCAL, GITIGNORED dataset directory to seed a future CNN training
 * set (docs/visual-blocker-classifier-pipeline.md, "Phase 2 — dataset capture").
 *
 * Hard guarantees:
 *   - Dev/local only: writes `dev-artifacts/hv-vision-dataset/<date>/<candidate_id>/`
 *     `{frame.png, blocker_crop.png?, meta.json}`. `frame.png` is ALWAYS the full
 *     redacted viewport; `blocker_crop.png` is an OPTIONAL separate file written only
 *     when a safe blocker crop was produced — the crop never replaces `frame.png`.
 *     No API route, no labeling UI, no persistence.
 *   - Fire-and-forget: never throws, never affects the request. Off-flag ⇒ no writes,
 *     no telemetry, behavior byte-identical.
 *   - Bytes (the redacted PNG) live ONLY on disk — never logged, never returned, never
 *     embedded in meta. meta.json is safe-keys only (booleans/enums/buckets/counts/
 *     hostname/ids); `label`/`outcome` are null at capture.
 *   - Reuses the fail-closed redaction primitive (`captureRedactedScreenshot`) — no
 *     second screenshot path. The optional crop (Phase 2B) is computed from the
 *     already-redacted frame; any crop failure safely omits `blocker_crop.png`.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveSnapshotCdpTarget } from "../cdpTargetSelection.js";
import { captureRedactedScreenshot, computeBlockerCropBox, cropPng } from "../screenshotRedaction.js";
import { isHvVisionDatasetEnabled } from "./flags.js";
import type {
  DatasetCaptureDecision,
  PipelineOutcome,
  VisionDatasetCaptureMeta,
  VisionDatasetCaptureResult,
} from "./types.js";

/** Repo-relative default dataset root (gitignored). */
const DATASET_SUBDIR = path.join("dev-artifacts", "hv-vision-dataset");

/** Throttle: at most one capture per browser session per this window (anti-flood). */
const THROTTLE_WINDOW_MS = 15_000;
const lastCaptureBySession = new Map<string, number>();

/**
 * Safe redacted-screenshot shape this module consumes. The default seam maps
 * `captureRedactedScreenshot` into it; tests inject a fake. `base64` is the redacted
 * PNG — memory-only, written straight to disk, never logged or returned.
 */
export type DatasetScreenshot =
  | { ok: true; base64: string; redacted_field_count: number }
  | { ok: false; redaction_mismatch?: boolean };

/**
 * Internal-only blocker-region geometry for Phase 2B cropping. This object lives
 * ONLY in memory inside this module between the capture-time re-probe and the local
 * crop — it is NEVER logged, stored, returned to an agent, or written to meta.json,
 * and it never flows through the snapshot/`surfaceSignals`/`hvDebug`/trace path.
 */
export interface VisualDatasetCropHint {
  box: { x: number; y: number; w: number; h: number };
  viewport: { vw: number; vh: number };
  source: "capture_reprobe";
}

/** Padding around the blocker rect so the (future) classifier sees context. */
const CROP_PAD_FRACTION = 0.12;
const CROP_PAD_MIN_PX = 24;
/** Minimum crop edge — below this (where the viewport allows) we fall back. */
const MIN_CROP_PX = 160;
/** A crop covering ≳ this fraction of the viewport adds nothing → full_viewport. */
const MAX_CROP_VIEWPORT_FRACTION = 0.9;

export interface CaptureVisionDatasetSeams {
  /** Capture a redacted full-viewport PNG for this CDP session. */
  screenshotProvider?: (cdpUrl: string) => Promise<DatasetScreenshot>;
  /**
   * Re-probe the live page for the dominant blocker rect (Phase 2B). Returns null
   * when no safe crop can be determined → full_viewport fallback. Tests inject a fake.
   */
  cropProbe?: (cdpUrl: string) => Promise<VisualDatasetCropHint | null>;
  /** Dataset root override (tests pass a tmp dir). */
  outputRoot?: string;
  /** Clock seam (date dir + created_at). */
  now?: () => Date;
  /** Disable the per-session throttle (tests). */
  disableThrottle?: boolean;
}

export interface CaptureVisionDatasetArgs {
  outcome: PipelineOutcome;
  cdpUrl: string | null | undefined;
}

/**
 * Safe dataset telemetry. No-op unless the dataset flag is on. Callers MUST pass only
 * safe scalars — never paths, base64, domain-as-leak, rects, urls, or values. Mirrors
 * `logVisionClassifierDebug` in pipeline.ts.
 */
function logVisionDatasetDebug(fields: Record<string, string | number | boolean>): void {
  if (!isHvVisionDatasetEnabled()) return;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  // eslint-disable-next-line no-console
  console.log(`[VisionDataset] ${parts.join(" ")}`);
}

/** Default screenshot seam — mirrors `defaultVgcCapture`; no protected-field args. */
const defaultScreenshotProvider = async (cdpUrl: string): Promise<DatasetScreenshot> => {
  const resolved = await resolveSnapshotCdpTarget(cdpUrl);
  if (!resolved) return { ok: false };
  const shot = await captureRedactedScreenshot({
    browserWsUrl: resolved.browserWsUrl,
    pageTargetId: resolved.target.id,
  });
  if (!shot.ok) {
    return { ok: false, ...(shot.redaction_mismatch ? { redaction_mismatch: true } : {}) };
  }
  return { ok: true, base64: shot.base64, redacted_field_count: shot.redacted_field_count };
};

/**
 * Default crop seam — a dataset-capture-only re-probe of the live page for the
 * dominant blocker rect. Geometry stays internal: it is mapped straight into a
 * `VisualDatasetCropHint`, consumed by the local crop, then discarded. Null on any
 * failure ⇒ full_viewport fallback.
 */
const defaultCropProbe = async (cdpUrl: string): Promise<VisualDatasetCropHint | null> => {
  const resolved = await resolveSnapshotCdpTarget(cdpUrl);
  if (!resolved) return null;
  const found = await computeBlockerCropBox({
    browserWsUrl: resolved.browserWsUrl,
    pageTargetId: resolved.target.id,
  });
  if (!found) return null;
  return { box: found.box, viewport: found.viewport, source: "capture_reprobe" };
};

/** Safe crop outcome — only `base64` plus the three meta-safe descriptors. */
interface CropResolution {
  base64: string;
  region: "blocker_crop" | "full_viewport";
  crop_applied: boolean;
  crop_source: "capture_reprobe" | "fallback_full_viewport";
}

function fullViewportFallback(fullBase64: string): CropResolution {
  return {
    base64: fullBase64,
    region: "full_viewport",
    crop_applied: false,
    crop_source: "fallback_full_viewport",
  };
}

/**
 * Closed enum describing why `validateAndPadCrop` rejected (or accepted) a hint.
 * Diagnostic-only — never affects the crop decision; safe to log. `ok` means a crop
 * was produced. Each non-`ok` value maps 1:1 to a `null`-return path below.
 */
export type CropInvalidReason =
  | "ok"
  | "invalid_dimensions" // viewport or box non-finite, or box.w/h <= 0
  | "box_outside_viewport" // box fully off-screen
  | "no_intersection" // post-pad/clamp width or height collapsed to <= 0
  | "box_too_small" // still under MIN_CROP_PX where the viewport could satisfy it
  | "box_too_large"; // crop ≈ whole viewport (>= MAX_CROP_VIEWPORT_FRACTION)

/**
 * Coarse, safe geometry buckets for diagnostics. All values are fixed enums — never
 * raw coordinates, dimensions, or fractions. Computed from the raw hint regardless of
 * whether the crop succeeds.
 */
export interface CropBuckets {
  box_size_bucket: "tiny" | "small" | "medium" | "large" | "full_viewport" | "oversized" | "unknown";
  box_position_bucket: "center" | "edge" | "partial_offscreen" | "offscreen" | "unknown";
  viewport_size_bucket: "mobile" | "desktop" | "large" | "unknown";
  box_source_bucket: "active_vgc" | "center_modal" | "dominant_surface" | "iframe" | "fallback" | "unknown";
}

/** Box area as a fraction of the viewport → coarse size bucket. */
function cropSizeBucket(box: { w: number; h: number }, vp: { vw: number; vh: number }): CropBuckets["box_size_bucket"] {
  const { w, h } = box;
  const { vw, vh } = vp;
  if (![w, h, vw, vh].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return "unknown";
  const frac = (w * h) / (vw * vh);
  if (frac < 0.02) return "tiny";
  if (frac < 0.1) return "small";
  if (frac < 0.35) return "medium";
  if (frac < 0.75) return "large";
  if (frac < MAX_CROP_VIEWPORT_FRACTION) return "full_viewport";
  return "oversized";
}

/** Box center / edge-clipping relative to the viewport → coarse position bucket. */
function cropPositionBucket(
  box: { x: number; y: number; w: number; h: number },
  vp: { vw: number; vh: number },
): CropBuckets["box_position_bucket"] {
  const { x, y, w, h } = box;
  const { vw, vh } = vp;
  if (![x, y, w, h, vw, vh].every((v) => Number.isFinite(v)) || vw <= 0 || vh <= 0) return "unknown";
  // Fully off-screen.
  if (x >= vw || y >= vh || x + w <= 0 || y + h <= 0) return "offscreen";
  // Any edge clipped by the viewport.
  if (x < 0 || y < 0 || x + w > vw || y + h > vh) return "partial_offscreen";
  const cx = (x + w / 2) / vw;
  const cy = (y + h / 2) / vh;
  if (Math.abs(cx - 0.5) <= 0.15 && Math.abs(cy - 0.5) <= 0.15) return "center";
  return "edge";
}

/** Viewport CSS width → coarse device-class bucket. */
function viewportSizeBucket(vw: number): CropBuckets["viewport_size_bucket"] {
  if (!Number.isFinite(vw) || vw <= 0) return "unknown";
  if (vw < 768) return "mobile";
  if (vw < 1440) return "desktop";
  return "large";
}

/**
 * Reason-returning core of `validateAndPadCrop`. Same geometry rules, no threshold
 * changes — it additionally tags each outcome with a `CropInvalidReason` and coarse
 * `CropBuckets` for diagnostics. `validateAndPadCrop` is a thin wrapper over this, so
 * existing callers stay behavior-identical. No coordinate ever leaves this module.
 */
export function validateAndPadCropWithReason(hint: VisualDatasetCropHint): {
  crop: { x: number; y: number; w: number; h: number } | null;
  reason: CropInvalidReason;
  buckets: CropBuckets;
} {
  const { box, viewport } = hint;
  const { vw, vh } = viewport;
  // The current probe yields a single dominant blocking surface with no kind label.
  // Enriching this would require changing BLOCKER_CROP_PROBE_EXPR (out of scope for a
  // diagnostic patch), so map the only known source to "dominant_surface".
  const buckets: CropBuckets = {
    box_size_bucket: cropSizeBucket(box, viewport),
    box_position_bucket: cropPositionBucket(box, viewport),
    viewport_size_bucket: viewportSizeBucket(vw),
    box_source_bucket: hint.source === "capture_reprobe" ? "dominant_surface" : "unknown",
  };
  const fail = (reason: CropInvalidReason) => ({ crop: null, reason, buckets });

  if (!(vw > 0 && vh > 0) || !Number.isFinite(vw) || !Number.isFinite(vh)) return fail("invalid_dimensions");
  const vals = [box.x, box.y, box.w, box.h];
  if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v))) return fail("invalid_dimensions");
  if (box.w <= 0 || box.h <= 0) return fail("invalid_dimensions");
  // Fully off-screen → no usable crop.
  if (box.x >= vw || box.y >= vh || box.x + box.w <= 0 || box.y + box.h <= 0) return fail("box_outside_viewport");

  const pad = Math.max(CROP_PAD_MIN_PX, Math.round(CROP_PAD_FRACTION * Math.max(box.w, box.h)));
  let x0 = Math.max(0, Math.min(vw, box.x - pad));
  let y0 = Math.max(0, Math.min(vh, box.y - pad));
  let x1 = Math.max(0, Math.min(vw, box.x + box.w + pad));
  let y1 = Math.max(0, Math.min(vh, box.y + box.h + pad));
  let w = x1 - x0;
  let h = y1 - y0;
  if (w <= 0 || h <= 0) return fail("no_intersection");

  // Grow toward the minimum edge where the viewport has room.
  if (w < MIN_CROP_PX && vw >= MIN_CROP_PX) {
    x0 = Math.max(0, Math.min(x0 - (MIN_CROP_PX - w) / 2, vw - MIN_CROP_PX));
    x1 = x0 + MIN_CROP_PX;
    w = x1 - x0;
  }
  if (h < MIN_CROP_PX && vh >= MIN_CROP_PX) {
    y0 = Math.max(0, Math.min(y0 - (MIN_CROP_PX - h) / 2, vh - MIN_CROP_PX));
    y1 = y0 + MIN_CROP_PX;
    h = y1 - y0;
  }
  // Still under min where the viewport could have satisfied it → unreliable, fall back.
  if ((w < MIN_CROP_PX && vw >= MIN_CROP_PX) || (h < MIN_CROP_PX && vh >= MIN_CROP_PX)) return fail("box_too_small");

  // Crop ≈ whole viewport → adds nothing over the full frame.
  if ((w * h) / (vw * vh) >= MAX_CROP_VIEWPORT_FRACTION) return fail("box_too_large");

  return { crop: { x: x0, y: y0, w, h }, reason: "ok", buckets };
}

/**
 * Validate, pad, and clamp the blocker rect (viewport CSS px). Returns a safe crop
 * rect, or null when the geometry is missing/invalid, too tight to satisfy the min
 * size, or so broad that the crop is effectively the whole viewport — every null
 * routes to a full_viewport fallback. Thin wrapper over `validateAndPadCropWithReason`;
 * behavior-identical to the prior implementation. No coordinate ever leaves this module.
 */
export function validateAndPadCrop(
  hint: VisualDatasetCropHint,
): { x: number; y: number; w: number; h: number } | null {
  return validateAndPadCropWithReason(hint).crop;
}

/**
 * Decide the saved frame. A valid crop hint yields a blocker-region crop of the
 * already-redacted frame; anything else (no hint, invalid/too-broad geometry, or a
 * cropPng failure) safely keeps the full redacted viewport. NEVER throws.
 */
export function resolveCrop(hint: VisualDatasetCropHint | null, fullBase64: string): CropResolution {
  if (!hint) return fullViewportFallback(fullBase64);
  const rect = validateAndPadCrop(hint);
  if (!rect) return fullViewportFallback(fullBase64);
  try {
    const cropped = cropPng(fullBase64, rect, hint.viewport);
    return {
      base64: cropped,
      region: "blocker_crop",
      crop_applied: true,
      crop_source: "capture_reprobe",
    };
  } catch {
    return fullViewportFallback(fullBase64);
  }
}

/**
 * Resolve the dataset root. Env override wins; otherwise the repo-root
 * `dev-artifacts/hv-vision-dataset` (resolution mirrors pointerProfileLoader: try cwd,
 * then two up — apps/api → repo root, then one up).
 */
function resolveDatasetRoot(override?: string): string {
  if (override) return override;
  const envDir = process.env.ANTIGEN_HV_VISION_DATASET_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
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
  if (existingParent) return path.join(existingParent, "hv-vision-dataset");
  // None exist yet — default to repo-root layout from apps/api cwd.
  return path.resolve(process.cwd(), "../..", DATASET_SUBDIR);
}

/** UTC YYYY-MM-DD date-directory name. */
function dateDir(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure pre-flight decision (no I/O). Determines whether a capture should be attempted.
 */
export function decideDatasetCapture(
  args: CaptureVisionDatasetArgs,
  seams: CaptureVisionDatasetSeams = {},
): DatasetCaptureDecision {
  if (!isHvVisionDatasetEnabled()) return { capture: false, skip_reason: "flag_disabled" };
  if (!args.outcome.ran) return { capture: false, skip_reason: "not_a_candidate" };
  if (!args.cdpUrl) return { capture: false, skip_reason: "no_session" };

  if (!seams.disableThrottle) {
    const sessionId = args.outcome.candidate.browser_session_id;
    const nowMs = (seams.now ? seams.now() : new Date()).getTime();
    const last = lastCaptureBySession.get(sessionId);
    if (last !== undefined && nowMs - last < THROTTLE_WINDOW_MS) {
      return { capture: false, skip_reason: "rate_limited" };
    }
  }
  return { capture: true };
}

/**
 * Build the safe meta object. Allowlist construction only — there is no path that
 * copies a screenshot, value, url, rect, or raw text into the result.
 */
function buildMeta(
  outcome: Extract<PipelineOutcome, { ran: true }>,
  redactedFieldCount: number,
  createdAt: string,
  crop: Pick<CropResolution, "region" | "crop_applied" | "crop_source">,
): VisionDatasetCaptureMeta {
  const { candidate, result, policy } = outcome;
  return {
    candidate_id: candidate.candidate_id,
    created_at: createdAt,
    domain: candidate.domain,
    trigger_basis: candidate.trigger_basis,
    candidate_reason: candidate.candidate_reason,
    dominant_surface_kind: candidate.dominant_surface_kind,
    signals: { ...candidate.signals },
    classifier_source: result.classifier_source,
    blocker_type: result.blocker_type,
    confidence_bucket: result.confidence_bucket,
    policy_action: policy.action,
    policy_enforced: false,
    redaction_verified: true,
    redacted_field_count: redactedFieldCount,
    region: crop.region,
    crop_applied: crop.crop_applied,
    crop_source: crop.crop_source,
    label: null,
    outcome: null,
  };
}

/**
 * Capture a dev-only dataset record. NEVER throws. Returns a safe written/skip result.
 * Emits `vision_dataset_capture_written` / `vision_dataset_capture_skipped` (safe scalars).
 */
export async function captureVisionDatasetRecord(
  args: CaptureVisionDatasetArgs,
  seams: CaptureVisionDatasetSeams = {},
): Promise<VisionDatasetCaptureResult> {
  const decision = decideDatasetCapture(args, seams);
  const candidateId = args.outcome.ran ? args.outcome.candidate.candidate_id : "unknown";

  if (!decision.capture) {
    const skip_reason = decision.skip_reason ?? "flag_disabled";
    logVisionDatasetDebug({ event: "vision_dataset_capture_skipped", candidate_id: candidateId, skip_reason });
    return { written: false, skip_reason };
  }
  // decision.capture === true ⇒ ran true + cdpUrl present (guaranteed by decideDatasetCapture).
  const outcome = args.outcome as Extract<PipelineOutcome, { ran: true }>;
  const cdpUrl = args.cdpUrl as string;

  // 1. Redacted screenshot (reused fail-closed primitive).
  let shot: DatasetScreenshot;
  try {
    shot = await (seams.screenshotProvider ?? defaultScreenshotProvider)(cdpUrl);
  } catch {
    logVisionDatasetDebug({
      event: "vision_dataset_capture_skipped",
      candidate_id: candidateId,
      skip_reason: "redaction_failed",
    });
    return { written: false, skip_reason: "redaction_failed" };
  }
  if (!shot.ok) {
    const skip_reason = shot.redaction_mismatch ? "redaction_unverified" : "redaction_failed";
    logVisionDatasetDebug({ event: "vision_dataset_capture_skipped", candidate_id: candidateId, skip_reason });
    return { written: false, skip_reason };
  }

  // 2. Blocker-region crop (Phase 2B). Best-effort re-probe → crop the ALREADY-redacted
  //    frame locally. Any miss/failure/invalid geometry falls back to the full viewport;
  //    cropping never throws, never skips the write, and never reveals a coordinate.
  let cropHint: VisualDatasetCropHint | null = null;
  try {
    cropHint = await (seams.cropProbe ?? defaultCropProbe)(cdpUrl);
  } catch {
    cropHint = null;
  }
  const crop = resolveCrop(cropHint, shot.base64);

  // 3. Write frame.png (ALWAYS the full redacted viewport) + the optional
  //    blocker_crop.png + meta.json to the gitignored local dataset dir. The crop is
  //    a SEPARATE file and never replaces frame.png. If the crop write fails, downgrade
  //    the meta descriptor to full_viewport so meta.json never claims a crop that isn't
  //    on disk.
  let cropMeta: CropResolution = crop;
  try {
    const nowDate = seams.now ? seams.now() : new Date();
    const root = resolveDatasetRoot(seams.outputRoot);
    const dir = path.join(root, dateDir(nowDate), candidateId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "frame.png"), Buffer.from(shot.base64, "base64"));
    if (crop.crop_applied) {
      try {
        fs.writeFileSync(path.join(dir, "blocker_crop.png"), Buffer.from(crop.base64, "base64"));
      } catch {
        // Crop file failed to write — keep frame.png + meta honest (no crop on disk).
        cropMeta = fullViewportFallback(shot.base64);
      }
    }
    const meta = buildMeta(outcome, shot.redacted_field_count, nowDate.toISOString(), cropMeta);
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    // Record throttle marker only on a successful write.
    if (!seams.disableThrottle) {
      lastCaptureBySession.set(outcome.candidate.browser_session_id, nowDate.getTime());
    }
  } catch {
    logVisionDatasetDebug({
      event: "vision_dataset_capture_skipped",
      candidate_id: candidateId,
      skip_reason: "write_failed",
    });
    return { written: false, skip_reason: "write_failed" };
  }

  // 4. Safe telemetry — id + region/crop flags + count only. No paths, base64, domain,
  //    or coordinates ever appear here.
  logVisionDatasetDebug({
    event: "vision_dataset_capture_written",
    candidate_id: candidateId,
    region: cropMeta.region,
    crop_applied: cropMeta.crop_applied,
    crop_source: cropMeta.crop_source,
    redacted_field_count: shot.redacted_field_count,
  });
  return { written: true };
}

/** Test-only: reset the in-memory throttle between cases. */
export function __resetVisionDatasetThrottle(): void {
  lastCaptureBySession.clear();
}
