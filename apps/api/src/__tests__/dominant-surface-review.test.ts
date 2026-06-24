/**
 * Dominant Surface Review (uncertain, NON-HV) — unit suite.
 *
 * The user-visible attention record minted by the proactive action preflight's
 * UNCERTAIN dominant-surface hard block. Verifies dedup, lifecycle, lazy expiry,
 * best-effort screenshot capture, and the safe-view data discipline (no raw
 * fields; literal `false` safety flags; bytes never in the safe view).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createOrReuseDominantSurfaceReview,
  listActiveDominantSurfaceReviews,
  getDominantSurfaceReview,
  getDominantSurfaceReviewScreenshotFrame,
  acknowledgeDominantSurfaceReview,
  getSafeDominantSurfaceReviewView,
  expireDominantSurfaceReviews,
  clearDominantSurfaceReviewsForTests,
  DOMINANT_SURFACE_REVIEW_TTL_MS,
} from "../runtime/dominantSurfaceReview.js";

const TARGET = { browserWsUrl: "ws://localhost:9222/devtools/browser/abc", pageTargetId: "TARGET_1" };
const FRAME_OK = vi.fn(async () => ({ ok: true as const, base64: "QUJD" }));
const FRAME_FAIL = vi.fn(async () => ({ ok: false as const }));

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    browser_session_id: "tbsess_dsr_1",
    domain: "www.bathandbodyworks.com",
    model_label: "newsletter_modal",
    model_confidence: 0.4274,
    trigger_basis: "unreadable_dominant_surface" as const,
    resolved_target: TARGET,
    ...overrides,
  };
}

beforeEach(() => {
  clearDominantSurfaceReviewsForTests();
  vi.clearAllMocks();
});

describe("createOrReuseDominantSurfaceReview", () => {
  it("creates a pending review with a redacted frame (best-effort capture succeeded)", async () => {
    const review = await createOrReuseDominantSurfaceReview(baseInput(), { captureFrame: FRAME_OK });
    expect(review).toBeDefined();
    expect(review!.review_id).toMatch(/^dsr_/);
    expect(review!.status).toBe("pending_review");
    expect(review!.outcome).toBe("uncertain");
    expect(review!.domain).toBe("www.bathandbodyworks.com");
    expect(review!.model_label).toBe("newsletter_modal");
    expect(review!.model_confidence).toBeCloseTo(0.4274);
    expect(review!.confirmed_human_verification).toBe(false);
    expect(review!.raw_surface_revealed_to_agent).toBe(false);
    expect(getDominantSurfaceReviewScreenshotFrame(review!.review_id)?.png_base64).toBe("QUJD");
    expect(listActiveDominantSurfaceReviews()).toHaveLength(1);
  });

  it("normalizes a full URL domain down to a hostname", async () => {
    const review = await createOrReuseDominantSurfaceReview(
      baseInput({ domain: "https://www.example.com/path?q=1" }),
      { captureFrame: FRAME_OK },
    );
    expect(review!.domain).toBe("www.example.com");
  });

  it("reuses the existing pending review for the same session + domain (no duplicate)", async () => {
    const a = await createOrReuseDominantSurfaceReview(baseInput(), { captureFrame: FRAME_OK });
    const b = await createOrReuseDominantSurfaceReview(baseInput(), { captureFrame: FRAME_OK });
    expect(b!.review_id).toBe(a!.review_id);
    expect(listActiveDominantSurfaceReviews()).toHaveLength(1);
  });

  it("creates separate reviews for different domains on the same session", async () => {
    await createOrReuseDominantSurfaceReview(baseInput(), { captureFrame: FRAME_OK });
    await createOrReuseDominantSurfaceReview(baseInput({ domain: "other.example.com" }), {
      captureFrame: FRAME_OK,
    });
    expect(listActiveDominantSurfaceReviews()).toHaveLength(2);
  });

  it("still creates the record when screenshot capture fails (screenshot_available false)", async () => {
    const review = await createOrReuseDominantSurfaceReview(baseInput(), { captureFrame: FRAME_FAIL });
    expect(review).toBeDefined();
    expect(getDominantSurfaceReviewScreenshotFrame(review!.review_id)).toBeUndefined();
    expect(getSafeDominantSurfaceReviewView(review!).screenshot_available).toBe(false);
  });

  it("returns undefined for an unusable input (missing session id)", async () => {
    const review = await createOrReuseDominantSurfaceReview(
      baseInput({ browser_session_id: "" }),
      { captureFrame: FRAME_OK },
    );
    expect(review).toBeUndefined();
    expect(listActiveDominantSurfaceReviews()).toHaveLength(0);
  });
});

describe("acknowledge + lifecycle", () => {
  it("acknowledging is terminal, removes the item from the active list, and purges the frame", async () => {
    const review = await createOrReuseDominantSurfaceReview(baseInput(), { captureFrame: FRAME_OK });
    const acked = acknowledgeDominantSurfaceReview(review!.review_id);
    expect(acked!.status).toBe("acknowledged");
    expect(listActiveDominantSurfaceReviews()).toHaveLength(0);
    expect(getDominantSurfaceReviewScreenshotFrame(review!.review_id)).toBeUndefined();
  });

  it("acknowledging an unknown id returns undefined", () => {
    expect(acknowledgeDominantSurfaceReview("dsr_nope")).toBeUndefined();
  });

  it("lazily expires a pending review past its TTL", async () => {
    const now = Date.now();
    const review = await createOrReuseDominantSurfaceReview(baseInput(), {
      captureFrame: FRAME_OK,
      now: () => now,
    });
    expireDominantSurfaceReviews(now + DOMINANT_SURFACE_REVIEW_TTL_MS + 1);
    expect(getDominantSurfaceReview(review!.review_id)?.status).toBe("expired");
    expect(listActiveDominantSurfaceReviews()).toHaveLength(0);
  });
});

describe("safe view discipline", () => {
  it("exposes only safe fields with literal false safety flags and no bytes", async () => {
    const review = await createOrReuseDominantSurfaceReview(baseInput(), { captureFrame: FRAME_OK });
    const view = getSafeDominantSurfaceReviewView(review!);
    expect(view.outcome).toBe("uncertain");
    expect(view.confirmed_human_verification).toBe(false);
    expect(view.raw_surface_revealed_to_agent).toBe(false);
    expect(view.screenshot_available).toBe(true);
    const raw = JSON.stringify(view);
    for (const banned of ["QUJD", "png_base64", "browser_session_id", "tbsess_dsr_1", "ws://", "TARGET_1", "cdp"]) {
      expect(raw).not.toContain(banned);
    }
  });
});
