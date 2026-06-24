// ─── Dominant Surface Review (uncertain, NON-HV) ─────────────────────────────
//
// User-visible attention record for the proactive action preflight's UNCERTAIN
// dominant-surface hard block (409 ACTION_BLOCKED_DOMINANT_SURFACE).
//
// WHY THIS EXISTS: when the vision classifier is UNCERTAIN over a dominant
// surface, the preflight correctly refuses to act AND correctly refuses to mint
// a Visual Gesture Capsule (uncertain must NEVER be called human verification).
// Previously that block created no state at all — no VGC, no HV request, no
// review object — so the agent was blocked while the user had nothing to see or
// act on in the Antigen UI. That made an agent-facing hard block invisible to
// the user. This record closes that gap: it is a clearly-NON-HV "needs review"
// item carrying a redacted screenshot the user can inspect.
//
// ── BOUNDARY ─────────────────────────────────────────────────────────────────
// This is NOT human verification. It NEVER mints/clears a VGC, never relays a
// gesture, never releases a hold, never resumes the agent. The agent stays
// blocked and recovers ONLY by re-running antigen_snapshot once the surface
// clears. `confirmed_human_verification` is the literal `false` everywhere.
//
// ── DATA SAFETY ──────────────────────────────────────────────────────────────
// SAFE FIELDS ONLY. `domain` is hostname only. The safe view never carries a
// full URL/path/query, selector, coordinate, DOM rect, raw/OCR page text,
// screenshot bytes/base64, cdp_url, target_id, or viewport dims. Redacted PNG
// bytes live in EXACTLY one place — the dedicated frame store, surfaced only by
// the internal screenshot endpoint (mirrors the VGC bytes discipline).
//
// Memory-only, lazy-expired (mirrors humanVerificationHandoff.ts / VGC).

import { HUMAN_VERIFICATION_TTL_MS } from "../lib/humanVerificationLifecycle.js";
import { newId } from "../store/index.js";
import { resolveSnapshotCdpTarget } from "./cdpTargetSelection.js";
import { captureRedactedScreenshot } from "./screenshotRedaction.js";
import type { HvHandoffTriggerBasis } from "./humanVerificationHandoff.js";

/** Review TTL aligns with the HV/VGC TTL (~3 min). Memory-only, lazy-expired. */
export const DOMINANT_SURFACE_REVIEW_TTL_MS = HUMAN_VERIFICATION_TTL_MS;

/**
 * Per-screenshot freshness window. A static frame of a live page goes stale fast,
 * so the held frame gets a short TTL capped by the review TTL (mirrors the VGC
 * frame freshness constant). Each frame's `expires_at` is
 * `min(now + this, review.expires_at)`.
 */
export const DOMINANT_SURFACE_REVIEW_FRAME_TTL_MS = 45_000;

/**
 * Review lifecycle. Non-terminal: `pending_review`. Terminal: `acknowledged`,
 * `expired`. There is no "cleared"/"resolved" by Antigen — clearing is the live
 * surface disappearing, observed by the agent's next antigen_snapshot.
 */
export type DominantSurfaceReviewStatus = "pending_review" | "acknowledged" | "expired";

const TERMINAL_STATUSES: ReadonlySet<DominantSurfaceReviewStatus> = new Set([
  "acknowledged",
  "expired",
]);

export function isTerminalDominantSurfaceReviewStatus(
  status: DominantSurfaceReviewStatus,
): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * One uncertain-dominant-surface review. Owns a single blocked-surface attention
 * item for a browser session + domain. NON-HV by construction.
 */
export interface DominantSurfaceReview {
  review_id: string;
  browser_session_id: string;
  /** Hostname only. */
  domain: string;
  /** Classifier label enum (e.g. "newsletter_modal") — never raw page text. */
  model_label?: string;
  /** Model confidence in [0,1]. */
  model_confidence?: number;
  trigger_basis?: HvHandoffTriggerBasis;
  /** Literal — this record is ALWAYS the uncertain outcome. */
  outcome: "uncertain";
  status: DominantSurfaceReviewStatus;
  /** Literal — uncertain is never confirmed human verification. */
  confirmed_human_verification: false;
  /** Literal — the surface is never revealed to the agent. */
  raw_surface_revealed_to_agent: false;
  /** Capture metadata only — present iff a live redacted frame is held. */
  screenshot_captured_at?: string;
  screenshot_expires_at?: string;
  created_at: string;
  expires_at: string;
}

/** One held, redacted viewport frame. Bytes NEVER appear in a safe view. */
interface DominantSurfaceReviewScreenshotFrame {
  review_id: string;
  png_base64: string;
  mime_type: "image/png";
  captured_at: string;
  expires_at: string;
}

// Memory-only stores. Never persisted, never logged with content.
const reviews = new Map<string, DominantSurfaceReview>();
const reviewFrames = new Map<string, DominantSurfaceReviewScreenshotFrame>();

/** Bounded ISO confidence clamp; non-finite / out-of-range → undefined (dropped). */
function safeConfidence(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

/** Coerce a free string to a hostname-only token (drop any path/query/scheme). */
function safeDomain(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) return "unknown";
  const raw = input.trim();
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || "unknown";
  } catch {
    const token = raw.split(/[/\\?#\s]/)[0];
    return token && /^[a-zA-Z0-9.:-]+$/.test(token) ? token : "unknown";
  }
}

/** Drop a review's frame AND its frame-derived capture metadata on the record. */
function purgeReviewFrame(reviewId: string): void {
  reviewFrames.delete(reviewId);
  const review = reviews.get(reviewId);
  if (review) {
    delete review.screenshot_captured_at;
    delete review.screenshot_expires_at;
  }
}

/** Lazy frame expiry: drop any frame past its own (shorter) freshness window. */
function expireReviewFrames(nowMs: number): void {
  for (const frame of [...reviewFrames.values()]) {
    if (new Date(frame.expires_at).getTime() <= nowMs) {
      purgeReviewFrame(frame.review_id);
    }
  }
}

/**
 * Lazy expiry: mark any non-terminal review past its TTL as `expired`, purge
 * frames for terminal reviews, and drop frames past their own (shorter) window.
 * Called by every read path so callers never observe a stale review/frame.
 */
export function expireDominantSurfaceReviews(nowMs: number = Date.now()): void {
  for (const review of reviews.values()) {
    if (!isTerminalDominantSurfaceReviewStatus(review.status)) {
      if (new Date(review.expires_at).getTime() <= nowMs) {
        review.status = "expired";
      }
    }
    if (isTerminalDominantSurfaceReviewStatus(review.status)) {
      purgeReviewFrame(review.review_id);
    }
  }
  expireReviewFrames(nowMs);
}

/** Best-effort redacted screenshot seam. Default → live CDP capture. */
export type DominantSurfaceReviewCaptureResult = { ok: true; base64: string } | { ok: false };

async function defaultCaptureFrame(
  resolvedTarget: { browserWsUrl: string; pageTargetId: string },
): Promise<DominantSurfaceReviewCaptureResult> {
  const shot = await captureRedactedScreenshot({
    browserWsUrl: resolvedTarget.browserWsUrl,
    pageTargetId: resolvedTarget.pageTargetId,
  });
  return shot.ok ? { ok: true, base64: shot.base64 } : { ok: false };
}

export interface CreateOrReuseDominantSurfaceReviewInput {
  browser_session_id: string;
  domain: string;
  model_label?: string;
  model_confidence?: number;
  trigger_basis?: HvHandoffTriggerBasis;
  /** Either pass a resolved CDP target, or a cdp_url to resolve, for the frame. */
  resolved_target?: { browserWsUrl: string; pageTargetId: string };
  cdp_url?: string | null;
}

export interface DominantSurfaceReviewSeams {
  captureFrame?: (
    resolvedTarget: { browserWsUrl: string; pageTargetId: string },
  ) => Promise<DominantSurfaceReviewCaptureResult>;
  now?: () => number;
}

/**
 * Create a pending review for an uncertain dominant-surface block, or REUSE the
 * existing pending review for the same session + domain (repeated blocked actions
 * must not spawn duplicates). NEVER throws — screenshot capture is best-effort; on
 * any capture failure the record is still created with `screenshot_available: false`.
 * Creating a review must never break the 409 block.
 */
export async function createOrReuseDominantSurfaceReview(
  input: CreateOrReuseDominantSurfaceReviewInput,
  seams: DominantSurfaceReviewSeams = {},
): Promise<DominantSurfaceReview | undefined> {
  try {
    if (
      !input ||
      typeof input.browser_session_id !== "string" ||
      input.browser_session_id.length === 0
    ) {
      return undefined;
    }
    const now = seams.now ? seams.now() : Date.now();
    expireDominantSurfaceReviews(now);
    const domain = safeDomain(input.domain);

    // Reuse: an active pending review for this session + domain stays the single
    // attention item across repeated blocked actions. Refresh its TTL + model meta.
    const existing = [...reviews.values()].find(
      (r) =>
        r.status === "pending_review" &&
        r.browser_session_id === input.browser_session_id &&
        r.domain === domain,
    );
    const review: DominantSurfaceReview =
      existing ??
      ({
        review_id: newId("dsr"),
        browser_session_id: input.browser_session_id,
        domain,
        outcome: "uncertain",
        status: "pending_review",
        confirmed_human_verification: false,
        raw_surface_revealed_to_agent: false,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + DOMINANT_SURFACE_REVIEW_TTL_MS).toISOString(),
      } satisfies DominantSurfaceReview);

    if (typeof input.model_label === "string" && input.model_label) {
      review.model_label = input.model_label;
    }
    const conf = safeConfidence(input.model_confidence);
    if (conf !== undefined) review.model_confidence = conf;
    if (input.trigger_basis) review.trigger_basis = input.trigger_basis;
    if (existing) {
      // Refresh TTL so a persistent block keeps the attention item alive.
      review.expires_at = new Date(now + DOMINANT_SURFACE_REVIEW_TTL_MS).toISOString();
    }
    reviews.set(review.review_id, review);

    // Best-effort redacted frame — never blocks record creation on failure.
    let resolvedTarget = input.resolved_target;
    if (!resolvedTarget && input.cdp_url) {
      try {
        const resolved = await resolveSnapshotCdpTarget(input.cdp_url);
        if (resolved) {
          resolvedTarget = { browserWsUrl: resolved.browserWsUrl, pageTargetId: resolved.target.id };
        }
      } catch {
        /* leave undefined → no frame */
      }
    }
    if (resolvedTarget) {
      try {
        const shot = await (seams.captureFrame ?? defaultCaptureFrame)(resolvedTarget);
        if (shot.ok) {
          const frameNow = seams.now ? seams.now() : Date.now();
          const reviewExpiresMs = new Date(review.expires_at).getTime();
          const frameExpiresMs = Math.min(
            frameNow + DOMINANT_SURFACE_REVIEW_FRAME_TTL_MS,
            reviewExpiresMs,
          );
          const captured_at = new Date(frameNow).toISOString();
          const expires_at = new Date(frameExpiresMs).toISOString();
          reviewFrames.set(review.review_id, {
            review_id: review.review_id,
            png_base64: shot.base64,
            mime_type: "image/png",
            captured_at,
            expires_at,
          });
          review.screenshot_captured_at = captured_at;
          review.screenshot_expires_at = expires_at;
        }
      } catch {
        /* best-effort — record stays without a frame */
      }
    }
    return review;
  } catch {
    return undefined;
  }
}

export function getDominantSurfaceReview(reviewId: string): DominantSurfaceReview | undefined {
  expireDominantSurfaceReviews();
  return reviews.get(reviewId);
}

export function listActiveDominantSurfaceReviews(): DominantSurfaceReview[] {
  expireDominantSurfaceReviews();
  return [...reviews.values()]
    .filter((r) => !isTerminalDominantSurfaceReviewStatus(r.status))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** Held redacted frame for a review (runs lazy expiry; expired → undefined). */
export function getDominantSurfaceReviewScreenshotFrame(
  reviewId: string,
): DominantSurfaceReviewScreenshotFrame | undefined {
  expireDominantSurfaceReviews();
  return reviewFrames.get(reviewId);
}

/**
 * Acknowledge (terminal) a pending review. Idempotent for already-terminal
 * reviews. Returns the review, or undefined when not found.
 */
export function acknowledgeDominantSurfaceReview(
  reviewId: string,
): DominantSurfaceReview | undefined {
  expireDominantSurfaceReviews();
  const review = reviews.get(reviewId);
  if (!review) return undefined;
  if (review.status === "pending_review") {
    review.status = "acknowledged";
    purgeReviewFrame(reviewId);
  }
  return review;
}

/**
 * Safe view (internal/user-facing). SAFE FIELDS ONLY. The two `*_false` fields
 * are echoed as the literals they are; bytes/coords/urls never appear.
 */
export interface SafeDominantSurfaceReviewView {
  review_id: string;
  status: DominantSurfaceReviewStatus;
  domain: string;
  model_label?: string;
  model_confidence?: number;
  trigger_basis?: HvHandoffTriggerBasis;
  outcome: "uncertain";
  confirmed_human_verification: false;
  raw_surface_revealed_to_agent: false;
  /** Whether a live (non-expired) redacted frame is held. Bytes never exposed. */
  screenshot_available: boolean;
  screenshot_captured_at?: string;
  screenshot_expires_at?: string;
  created_at: string;
  expires_at: string;
}

export function getSafeDominantSurfaceReviewView(
  review: DominantSurfaceReview,
): SafeDominantSurfaceReviewView {
  const frame = getDominantSurfaceReviewScreenshotFrame(review.review_id);
  return {
    review_id: review.review_id,
    status: review.status,
    domain: review.domain,
    ...(review.model_label ? { model_label: review.model_label } : {}),
    ...(review.model_confidence !== undefined ? { model_confidence: review.model_confidence } : {}),
    ...(review.trigger_basis ? { trigger_basis: review.trigger_basis } : {}),
    outcome: "uncertain",
    confirmed_human_verification: false,
    raw_surface_revealed_to_agent: false,
    screenshot_available: !!frame,
    ...(frame
      ? { screenshot_captured_at: frame.captured_at, screenshot_expires_at: frame.expires_at }
      : {}),
    created_at: review.created_at,
    expires_at: review.expires_at,
  };
}

/** Test-only: drop all reviews AND frames between cases. */
export function clearDominantSurfaceReviewsForTests(): void {
  reviews.clear();
  reviewFrames.clear();
}
