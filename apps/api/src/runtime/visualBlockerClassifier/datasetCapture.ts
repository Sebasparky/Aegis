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
 *     `{frame.png, meta.json}`. No API route, no labeling UI, no persistence.
 *   - Fire-and-forget: never throws, never affects the request. Off-flag ⇒ no writes,
 *     no telemetry, behavior byte-identical.
 *   - Bytes (the redacted PNG) live ONLY on disk — never logged, never returned, never
 *     embedded in meta. meta.json is safe-keys only (booleans/enums/buckets/counts/
 *     hostname/ids); `label`/`outcome` are null at capture.
 *   - Reuses the fail-closed redaction primitive (`captureRedactedScreenshot`) — no
 *     second screenshot path. No crop in 2A (full viewport only); crop is Phase 2B.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveSnapshotCdpTarget } from "../cdpTargetSelection.js";
import { captureRedactedScreenshot } from "../screenshotRedaction.js";
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

export interface CaptureVisionDatasetSeams {
  /** Capture a redacted full-viewport PNG for this CDP session. */
  screenshotProvider?: (cdpUrl: string) => Promise<DatasetScreenshot>;
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
    region: "full_viewport",
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

  // 2. Write frame.png + meta.json to the gitignored local dataset dir.
  try {
    const nowDate = seams.now ? seams.now() : new Date();
    const root = resolveDatasetRoot(seams.outputRoot);
    const dir = path.join(root, dateDir(nowDate), candidateId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "frame.png"), Buffer.from(shot.base64, "base64"));
    const meta = buildMeta(outcome, shot.redacted_field_count, nowDate.toISOString());
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

  // 3. Safe telemetry — candidate_id + region + count only. No paths, base64, or domain.
  logVisionDatasetDebug({
    event: "vision_dataset_capture_written",
    candidate_id: candidateId,
    region: "full_viewport",
    redacted_field_count: shot.redacted_field_count,
  });
  return { written: true };
}

/** Test-only: reset the in-memory throttle between cases. */
export function __resetVisionDatasetThrottle(): void {
  lastCaptureBySession.clear();
}
