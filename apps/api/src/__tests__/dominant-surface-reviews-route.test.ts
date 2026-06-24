/**
 * Dominant Surface Review — internal route tests.
 *
 * Proves the internal user-facing endpoints:
 *  - list returns safe views only (no bytes / browser detail),
 *  - screenshot bytes are confined to GET /:id/screenshot ONLY,
 *  - acknowledge is terminal and drops the item from the list,
 *  - clean not_found / frame-unavailable responses with no browser detail.
 *
 * Reviews + frames are seeded through the runtime helper (no public create route).
 * The redacted-screenshot primitive is module-mocked so no real CDP runs.
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const captureRedactedScreenshotMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/screenshotRedaction.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/screenshotRedaction.js")>(
    "../runtime/screenshotRedaction.js",
  );
  return { ...actual, captureRedactedScreenshot: captureRedactedScreenshotMock };
});

import {
  createOrReuseDominantSurfaceReview,
  clearDominantSurfaceReviewsForTests,
} from "../runtime/dominantSurfaceReview.js";
import { dominantSurfaceReviewRoutes } from "../routes/dominant-surface-reviews.js";

const TARGET = { browserWsUrl: "ws://localhost:9222/devtools/browser/abc", pageTargetId: "TARGET_1" };

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(dominantSurfaceReviewRoutes);
  await server.ready();
});

afterAll(() => server.close());

beforeEach(() => {
  clearDominantSurfaceReviewsForTests();
  vi.clearAllMocks();
  captureRedactedScreenshotMock.mockResolvedValue({
    ok: true,
    base64: "QUJD",
    mimeType: "image/png",
    redacted_field_count: 0,
  });
});

async function seedReview() {
  return createOrReuseDominantSurfaceReview({
    browser_session_id: "tbsess_dsr_route",
    domain: "www.bathandbodyworks.com",
    model_label: "newsletter_modal",
    model_confidence: 0.4274,
    trigger_basis: "unreadable_dominant_surface",
    resolved_target: TARGET,
  });
}

describe("GET /api/internal/dominant-surface-reviews", () => {
  it("returns safe views only — no bytes, no browser detail", async () => {
    await seedReview();
    const res = await server.inject({ method: "GET", url: "/api/internal/dominant-surface-reviews" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].outcome).toBe("uncertain");
    expect(body.data[0].confirmed_human_verification).toBe(false);
    expect(body.data[0].screenshot_available).toBe(true);
    const raw = JSON.stringify(body);
    for (const banned of ["QUJD", "png_base64", "tbsess_dsr_route", "ws://", "TARGET_1", "9222"]) {
      expect(raw).not.toContain(banned);
    }
  });
});

describe("GET /api/internal/dominant-surface-reviews/:id/screenshot", () => {
  it("is the ONLY place bytes appear", async () => {
    const review = await seedReview();
    const res = await server.inject({
      method: "GET",
      url: `/api/internal/dominant-surface-reviews/${review!.review_id}/screenshot`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mime_type).toBe("image/png");
    expect(body.png_base64).toBe("QUJD");
  });

  it("404s for an unknown review", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/internal/dominant-surface-reviews/dsr_nope/screenshot",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("404s SCREENSHOT_FRAME_UNAVAILABLE when no frame was captured", async () => {
    captureRedactedScreenshotMock.mockResolvedValueOnce({ ok: false, error_code: "SCREENSHOT_REDACTION_FAILED" });
    const review = await seedReview();
    const res = await server.inject({
      method: "GET",
      url: `/api/internal/dominant-surface-reviews/${review!.review_id}/screenshot`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SCREENSHOT_FRAME_UNAVAILABLE");
  });
});

describe("POST /api/internal/dominant-surface-reviews/:id/acknowledge", () => {
  it("is terminal and drops the item from the active list", async () => {
    const review = await seedReview();
    const ack = await server.inject({
      method: "POST",
      url: `/api/internal/dominant-surface-reviews/${review!.review_id}/acknowledge`,
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().data.status).toBe("acknowledged");

    const list = await server.inject({ method: "GET", url: "/api/internal/dominant-surface-reviews" });
    expect(list.json().data).toHaveLength(0);
  });

  it("404s for an unknown review", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/dominant-surface-reviews/dsr_nope/acknowledge",
    });
    expect(res.statusCode).toBe(404);
  });
});
