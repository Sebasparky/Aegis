/**
 * Visual Gesture Capsule — M1D internal route tests.
 *
 * Proves the internal user-facing endpoints:
 *  - respect the ANTIGEN_VISUAL_GESTURE_CAPSULE flag (list → empty+disabled;
 *    non-list → structured 404 VISUAL_GESTURE_CAPSULE_DISABLED),
 *  - confine screenshot bytes to GET /:id/screenshot ONLY,
 *  - never leak png_base64, viewport dimensions, coordinates, gesture traces, or
 *    strategy in list / recapture / recheck / cancel responses,
 *  - return clean missing/expired/not_found responses with no browser detail,
 *  - never falsely mark a capsule cleared via the recheck stub.
 *
 * Capsules and frames are seeded through the runtime helpers (no public create
 * route). The M1C capture helper is module-mocked so recapture exercises the
 * route without real Chromium/CDP.
 */

import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import {
  createVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  getVisualGestureCapsule,
  getVisualGestureCapsuleScreenshotFrame,
  cancelVisualGestureCapsule,
  clearVisualGestureCapsulesForTests,
  VISUAL_GESTURE_SCREENSHOT_FRAME_TTL_MS,
} from "../runtime/visualGestureCapsule.js";
import type { CaptureVisualGestureCapsuleScreenshotFrameResult } from "../runtime/visualGestureCapsuleCapture.js";

// Module-mock the M1C capture helper: seams can't be injected over HTTP, so the
// route's captureVisualGestureCapsuleScreenshotFrame is replaced wholesale.
vi.mock("../runtime/visualGestureCapsuleCapture.js", () => ({
  captureVisualGestureCapsuleScreenshotFrame: vi.fn(),
}));
import { captureVisualGestureCapsuleScreenshotFrame } from "../runtime/visualGestureCapsuleCapture.js";
import { visualGestureCapsuleRoutes } from "../routes/visual-gesture-capsules.js";

const mockedCapture = vi.mocked(captureVisualGestureCapsuleScreenshotFrame);

const BASE = {
  human_verification_request_id: "hvr_route_001",
  browser_session_id: "tbs_route_001",
  domain: "example.com",
  page_url: "https://example.com/checkout",
};

const PNG = "iVBORnonsenseBYTES==";

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(visualGestureCapsuleRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  mockedCapture.mockReset();
  vi.useRealTimers();
});

function enable() {
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
}

/** Seed an active capsule (flag must be enabled for the frame store to accept). */
function seedCapsule() {
  return createVisualGestureCapsule(BASE);
}

/** Seed an active capsule WITH a stored screenshot frame. */
function seedCapsuleWithFrame() {
  const capsule = createVisualGestureCapsule(BASE);
  const stored = storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
    png_base64: PNG,
    viewport_css_width: 1280,
    viewport_css_height: 800,
  });
  expect(stored.ok).toBe(true);
  return capsule;
}

// Fields that must NEVER appear in non-screenshot responses.
function assertNoByteOrGeometryLeak(rawBody: string) {
  expect(rawBody).not.toContain(PNG);
  expect(rawBody).not.toContain("png_base64");
  expect(rawBody).not.toContain("viewport_css_width");
  expect(rawBody).not.toContain("viewport_css_height");
  // No raw/mapped coordinates or gesture geometry.
  expect(rawBody).not.toContain("cssX");
  expect(rawBody).not.toContain("cssY");
}

describe("flag disabled", () => {
  it("list returns an empty, disabled list (200)", async () => {
    // Seed while enabled, then disable so a record exists but the flag is off.
    enable();
    seedCapsule();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;

    const res = await server.inject({ method: "GET", url: "/api/internal/visual-gesture-capsules" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ ok: true, data: [], disabled: true });
  });

  it("screenshot/recapture/recheck/cancel return structured 404 disabled", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();
    const id = capsule.capsule_id;
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;

    const calls = [
      { method: "GET" as const, url: `/api/internal/visual-gesture-capsules/${id}/screenshot` },
      { method: "POST" as const, url: `/api/internal/visual-gesture-capsules/${id}/recapture`, payload: { cdp_url: "http://localhost:9222" } },
      { method: "POST" as const, url: `/api/internal/visual-gesture-capsules/${id}/recheck` },
      { method: "POST" as const, url: `/api/internal/visual-gesture-capsules/${id}/cancel` },
    ];
    for (const call of calls) {
      const res = await server.inject(call as any);
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VISUAL_GESTURE_CAPSULE_DISABLED");
    }
    // The capture helper must never run when the flag is off.
    expect(mockedCapture).not.toHaveBeenCalled();
  });
});

describe("GET list (enabled)", () => {
  it("returns only safe views — no bytes, dims, or coords", async () => {
    enable();
    seedCapsuleWithFrame();

    const res = await server.inject({ method: "GET", url: "/api/internal/visual-gesture-capsules" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    const view = body.data[0];
    expect(view.screenshot_available).toBe(true);
    expect(view.raw_gesture_revealed_to_agent).toBe(false);
    expect(view.screenshot_revealed_to_agent).toBe(false);
    expect(view.purchase_authorized).toBe(false);
    assertNoByteOrGeometryLeak(res.body);
  });

  it("excludes terminal and expired capsules", async () => {
    enable();
    const cancelled = seedCapsule();
    cancelVisualGestureCapsule(cancelled.capsule_id); // terminal

    // A second capsule pushed past its TTL becomes expired (terminal). The list
    // call runs while fake timers are still active so lazy expiry sees the
    // advanced clock; afterEach restores real timers.
    vi.useFakeTimers();
    const expired = seedCapsule();
    vi.advanceTimersByTime(1000 * 60 * 60); // 1h ≫ capsule TTL
    const active = seedCapsule(); // created at the advanced time → fresh

    const res = await server.inject({ method: "GET", url: "/api/internal/visual-gesture-capsules" });
    const body = res.json();
    const ids = body.data.map((v: any) => v.capsule_id);
    expect(ids).toContain(active.capsule_id);
    expect(ids).not.toContain(cancelled.capsule_id);
    expect(ids).not.toContain(expired.capsule_id);
  });
});

describe("GET /:id/screenshot", () => {
  it("returns png_base64 only for an active live frame", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/screenshot`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.mime_type).toBe("image/png");
    expect(body.png_base64).toBe(PNG);
    expect(typeof body.captured_at).toBe("string");
    expect(typeof body.expires_at).toBe("string");
  });

  it("does not include viewport dims, coords, or strategy", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/screenshot`,
    });
    const body = res.json();
    expect(body).not.toHaveProperty("viewport_css_width");
    expect(body).not.toHaveProperty("viewport_css_height");
    expect(res.body).not.toContain("cssX");
    expect(res.body).not.toContain("cssY");
    expect(res.body).not.toContain("supported_gestures");
  });

  it("returns a clean missing/expired response after frame TTL expiry", async () => {
    enable();
    vi.useFakeTimers();
    const capsule = seedCapsuleWithFrame();
    // Advance past the frame TTL (45s) but well within the capsule TTL (~3min),
    // so the frame is gone while the capsule is still active. Call inject while
    // fake timers are active so lazy frame expiry sees the advanced clock.
    vi.advanceTimersByTime(VISUAL_GESTURE_SCREENSHOT_FRAME_TTL_MS + 1000);

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/screenshot`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("SCREENSHOT_FRAME_UNAVAILABLE");
  });

  it("returns NOT_FOUND for an unknown capsule id", async () => {
    enable();
    const res = await server.inject({
      method: "GET",
      url: "/api/internal/visual-gesture-capsules/vgc_does_not_exist/screenshot",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

describe("POST /:id/recapture", () => {
  it("calls the capture helper and returns metadata only (no bytes)", async () => {
    enable();
    const capsule = seedCapsule();
    mockedCapture.mockResolvedValue({
      ok: true,
      capsule_id: capsule.capsule_id,
      screenshot_available: true,
      screenshot_captured_at: "2026-06-18T00:00:00.000Z",
      screenshot_expires_at: "2026-06-18T00:00:45.000Z",
    } satisfies CaptureVisualGestureCapsuleScreenshotFrameResult);

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recapture`,
      payload: { cdp_url: "http://localhost:9222", target_id: "T1", expected_url: "https://example.com" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.screenshot_available).toBe(true);
    expect(body.screenshot_captured_at).toBe("2026-06-18T00:00:00.000Z");
    expect(body.screenshot_expires_at).toBe("2026-06-18T00:00:45.000Z");
    assertNoByteOrGeometryLeak(res.body);

    expect(mockedCapture).toHaveBeenCalledTimes(1);
    expect(mockedCapture).toHaveBeenCalledWith({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      targetId: "T1",
      expectedUrl: "https://example.com",
    });
  });

  it("requires cdp_url", async () => {
    enable();
    const capsule = seedCapsule();
    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recapture`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it("propagates a safe error reason on capture failure (no bytes)", async () => {
    enable();
    const capsule = seedCapsule();
    mockedCapture.mockResolvedValue({ ok: false, reason: "capture_failed", error: "cdp_target_unavailable" });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recapture`,
      payload: { cdp_url: "http://localhost:9222" },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CAPTURE_FAILED");
    // Internal capture error string must not be echoed to the caller.
    expect(res.body).not.toContain("cdp_target_unavailable");
    assertNoByteOrGeometryLeak(res.body);
  });

  it("returns NOT_FOUND for an unknown capsule id", async () => {
    enable();
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/visual-gesture-capsules/vgc_nope/recapture",
      payload: { cdp_url: "http://localhost:9222" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(mockedCapture).not.toHaveBeenCalled();
  });
});

describe("POST /:id/recheck (stub)", () => {
  it("does not falsely mark the capsule cleared", async () => {
    enable();
    const capsule = seedCapsule();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.recheck).toBe("unwired");
    expect(body.status).toBe("awaiting_user_gesture");
    expect(body.data.status).not.toBe("cleared");
    // The stored record must not have transitioned either.
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("awaiting_user_gesture");
    assertNoByteOrGeometryLeak(res.body);
  });

  it("returns NOT_FOUND for an unknown capsule id", async () => {
    enable();
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/visual-gesture-capsules/vgc_nope/recheck",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

describe("POST /:id/cancel", () => {
  it("cancels the capsule and purges the screenshot frame", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();
    expect(getVisualGestureCapsuleScreenshotFrame(capsule.capsule_id)).toBeDefined();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(true);
    expect(body.data.status).toBe("cancelled");
    expect(body.data.screenshot_available).toBe(false);

    // Frame is gone, and the cancelled capsule is excluded from the active list.
    expect(getVisualGestureCapsuleScreenshotFrame(capsule.capsule_id)).toBeUndefined();
    assertNoByteOrGeometryLeak(res.body);
  });

  it("returns NOT_FOUND for an unknown capsule id", async () => {
    enable();
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/visual-gesture-capsules/vgc_nope/cancel",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
