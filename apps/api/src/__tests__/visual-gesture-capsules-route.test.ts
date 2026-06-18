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

// Module-mock the M1E relay seam: seams can't be injected over HTTP, so the
// route's relayVisualGestureCapsuleGesture is replaced wholesale. No real
// CDP/pointer dispatch ever runs in these tests.
vi.mock("../runtime/visualGestureCapsuleRelay.js", () => ({
  relayVisualGestureCapsuleGesture: vi.fn(),
}));
import { relayVisualGestureCapsuleGesture } from "../runtime/visualGestureCapsuleRelay.js";

// Module-mock the M1G recheck helper: seams can't be injected over HTTP, so the
// route's recheckVisualGestureCapsule is replaced wholesale. No real CDP / probe
// ever runs in these tests.
vi.mock("../runtime/visualGestureCapsuleRecheck.js", () => ({
  recheckVisualGestureCapsule: vi.fn(),
}));
import { recheckVisualGestureCapsule } from "../runtime/visualGestureCapsuleRecheck.js";
import { visualGestureCapsuleRoutes } from "../routes/visual-gesture-capsules.js";

const mockedCapture = vi.mocked(captureVisualGestureCapsuleScreenshotFrame);
const mockedRelay = vi.mocked(relayVisualGestureCapsuleGesture);
const mockedRecheck = vi.mocked(recheckVisualGestureCapsule);

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
  mockedRelay.mockReset();
  mockedRecheck.mockReset();
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

describe("POST /:id/recheck (M1G)", () => {
  it("flag disabled → 404 disabled, helper not called", async () => {
    // Seed while enabled, then disable so a record exists but the flag is off.
    enable();
    const capsule = seedCapsule();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
      payload: { cdp_url: "http://localhost:9222" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("VISUAL_GESTURE_CAPSULE_DISABLED");
    expect(mockedRecheck).not.toHaveBeenCalled();
  });

  it("missing cdp_url → 400 VALIDATION_ERROR, helper not called", async () => {
    enable();
    const capsule = seedCapsule();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(mockedRecheck).not.toHaveBeenCalled();
  });

  it("success cleared → safe shape; no leaked cdp_url/target_id/expected_url", async () => {
    enable();
    const capsule = seedCapsule();
    mockedRecheck.mockImplementation(async () => {
      // Drive the real store so the re-fetched safe view reflects the clear.
      const { markGestureCapsuleCleared } = await import("../runtime/visualGestureCapsule.js");
      markGestureCapsuleCleared(capsule.capsule_id);
      return {
        ok: true,
        capsule_id: capsule.capsule_id,
        outcome: "cleared",
        status: "cleared",
        attempt_count: 0,
      };
    });

    // Distinctive sentinels that cannot collide with ISO timestamps, ids, or the
    // capsule's own page_url (which is legitimately echoed in the safe view).
    const TARGET_SENTINEL = "tgtSENTINELxq";
    const EXPECTED_URL_SENTINEL = "https://probe.invalid/sentinel";
    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
      payload: { cdp_url: "http://localhost:9222", target_id: TARGET_SENTINEL, expected_url: EXPECTED_URL_SENTINEL },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.recheck).toBe("cleared");
    expect(body.status).toBe("cleared");
    expect(body.attempt_count).toBe(0);
    expect(body.data.status).toBe("cleared");
    expect(body.data.raw_gesture_revealed_to_agent).toBe(false);
    expect(body.data.screenshot_revealed_to_agent).toBe(false);

    // The request's connection inputs must never be reflected back.
    expect(res.body).not.toContain("http://localhost:9222");
    expect(res.body).not.toContain(TARGET_SENTINEL);
    expect(res.body).not.toContain(EXPECTED_URL_SENTINEL);
    assertNoByteOrGeometryLeak(res.body);

    expect(mockedRecheck).toHaveBeenCalledTimes(1);
    expect(mockedRecheck).toHaveBeenCalledWith({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      targetId: TARGET_SENTINEL,
      expectedUrl: EXPECTED_URL_SENTINEL,
    });
  });

  it("success still_present → returns attempt_count/status, safe view only", async () => {
    enable();
    const capsule = seedCapsule();
    mockedRecheck.mockResolvedValue({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "still_present",
      status: "rejected_retryable",
      attempt_count: 1,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
      payload: { cdp_url: "http://localhost:9222" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recheck).toBe("still_present");
    expect(body.status).toBe("rejected_retryable");
    expect(body.attempt_count).toBe(1);
    expect(body.data.capsule_id).toBe(capsule.capsule_id);
    assertNoByteOrGeometryLeak(res.body);
  });

  it("success unknown → safe response, no attempt burn implied", async () => {
    enable();
    const capsule = seedCapsule();
    mockedRecheck.mockResolvedValue({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "unknown",
      status: "checking",
      attempt_count: 0,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
      payload: { cdp_url: "http://localhost:9222" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recheck).toBe("unknown");
    expect(body.status).toBe("checking");
    expect(body.attempt_count).toBe(0);
    assertNoByteOrGeometryLeak(res.body);
  });

  it("maps each recheck refusal reason to a safe status/code", async () => {
    enable();
    const capsule = seedCapsule();
    const cases: Array<[string, number, string]> = [
      ["flag_disabled", 404, "VISUAL_GESTURE_CAPSULE_DISABLED"],
      ["not_found", 404, "NOT_FOUND"],
      ["terminal", 409, "TERMINAL"],
      ["invalid_state", 409, "INVALID_STATE"],
      ["probe_failed", 502, "PROBE_FAILED"],
      ["state_update_failed", 409, "STATE_UPDATE_FAILED"],
    ];
    for (const [reason, status, code] of cases) {
      mockedRecheck.mockResolvedValueOnce({ ok: false, reason: reason as any });
      const res = await server.inject({
        method: "POST",
        url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
        payload: { cdp_url: "http://localhost:9222" },
      });
      expect(res.statusCode).toBe(status);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(code);
      assertNoByteOrGeometryLeak(res.body);
    }
  });

  it("non-leakage guard across JSON and raw body", async () => {
    enable();
    const capsule = createVisualGestureCapsule(BASE);
    const stored = storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
      png_base64: PNG,
      viewport_css_width: 640,
      viewport_css_height: 400,
    });
    expect(stored.ok).toBe(true);

    mockedRecheck.mockResolvedValue({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "still_present",
      status: "rejected_retryable",
      attempt_count: 1,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
      payload: { cdp_url: "http://localhost:9222", target_id: "tgtSENTINELxq", expected_url: "https://probe.invalid/sentinel" },
    });

    const forbiddenStrings = [
      "png_base64",
      "fx",
      "fy",
      "cssX",
      "cssY",
      "duration_ms",
      "cdp_url",
      "target_id",
      "expected_url",
      "viewport_css_width",
      "viewport_css_height",
      "path",
      "strategy",
      "postMessage",
      "perimeterx",
      "control_box",
    ];
    const serialized = JSON.stringify(res.json());
    for (const token of forbiddenStrings) {
      expect(serialized).not.toContain(token);
      expect(res.body).not.toContain(token);
    }
    // The supplied connection inputs must not be echoed.
    expect(res.body).not.toContain("http://localhost:9222");
    expect(res.body).not.toContain("tgtSENTINELxq");
    expect(res.body).not.toContain("https://probe.invalid/sentinel");

    // Viewport dimensions (640, 400) must not appear as numeric values anywhere.
    const numbers: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "number") numbers.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(res.json());
    expect(numbers).not.toContain(640);
    expect(numbers).not.toContain(400);
  });

  it("post-recheck capsule vanish → safe 409 STATE_UPDATE_FAILED", async () => {
    enable();
    const capsule = seedCapsule();
    mockedRecheck.mockImplementation(async () => {
      clearVisualGestureCapsulesForTests();
      return {
        ok: true,
        capsule_id: capsule.capsule_id,
        outcome: "unknown",
        status: "checking",
        attempt_count: 0,
      };
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/recheck`,
      payload: { cdp_url: "http://localhost:9222" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("STATE_UPDATE_FAILED");
  });

  it("returns NOT_FOUND when the helper reports not_found", async () => {
    enable();
    mockedRecheck.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/visual-gesture-capsules/vgc_nope/recheck",
      payload: { cdp_url: "http://localhost:9222" },
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

describe("POST /:id/gesture", () => {
  const TAP = { kind: "tap" as const, fx: 0.5, fy: 0.5 };
  const PRESS_HOLD = { kind: "press_hold" as const, fx: 0.5, fy: 0.5, duration_ms: 1200 };

  it("flag disabled → 404 disabled, relay not called", async () => {
    // Seed while enabled, then disable so a record exists but the flag is off.
    enable();
    const capsule = seedCapsuleWithFrame();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
      payload: { cdp_url: "http://localhost:9222", gesture: TAP },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("VISUAL_GESTURE_CAPSULE_DISABLED");
    expect(mockedRelay).not.toHaveBeenCalled();
  });

  it("missing cdp_url → 400 VALIDATION_ERROR, relay not called", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
      payload: { gesture: TAP },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(mockedRelay).not.toHaveBeenCalled();
  });

  it("malformed gesture → 400 VALIDATION_ERROR, relay not called", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();

    // Missing kind/fx/fy and a non-object gesture both reject at the route.
    for (const bad of [
      { cdp_url: "http://localhost:9222", gesture: { kind: "tap" } },
      { cdp_url: "http://localhost:9222", gesture: { fx: 0.5, fy: 0.5 } },
      { cdp_url: "http://localhost:9222", gesture: "not-an-object" },
      { cdp_url: "http://localhost:9222" },
    ]) {
      const res = await server.inject({
        method: "POST",
        url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
        payload: bad as any,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(mockedRelay).not.toHaveBeenCalled();
  });

  it("tap success → relay called with args; safe metadata only", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();
    mockedRelay.mockResolvedValue({
      ok: true,
      capsule_id: capsule.capsule_id,
      status: "checking",
      gesture_relayed: true,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
      payload: { cdp_url: "http://localhost:9222", target_id: "T1", gesture: TAP },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.gesture_relayed).toBe(true);
    expect(body.status).toBe("checking");
    // data is a safe view, not the raw capsule.
    expect(body.data.capsule_id).toBe(capsule.capsule_id);
    expect(body.data.raw_gesture_revealed_to_agent).toBe(false);
    expect(body.data.screenshot_revealed_to_agent).toBe(false);
    assertNoByteOrGeometryLeak(res.body);

    expect(mockedRelay).toHaveBeenCalledTimes(1);
    expect(mockedRelay).toHaveBeenCalledWith({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      targetId: "T1",
      gesture: TAP,
    });
  });

  it("press_hold success → relay gets duration_ms but response omits it", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();
    mockedRelay.mockResolvedValue({
      ok: true,
      capsule_id: capsule.capsule_id,
      status: "checking",
      gesture_relayed: true,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
      payload: { cdp_url: "http://localhost:9222", gesture: PRESS_HOLD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gesture_relayed).toBe(true);
    // Relay receives the duration-bearing gesture (no target_id → undefined).
    expect(mockedRelay).toHaveBeenCalledWith({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      targetId: undefined,
      gesture: PRESS_HOLD,
    });
    // But the response must not echo the duration.
    expect(res.body).not.toContain("duration_ms");
    expect(res.body).not.toContain("1200");
    assertNoByteOrGeometryLeak(res.body);
  });

  it("maps each relay refusal reason to a safe status/code", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();
    const cases: Array<[string, number, string]> = [
      ["not_found", 404, "NOT_FOUND"],
      ["terminal", 409, "TERMINAL"],
      ["manual_fallback", 409, "MANUAL_FALLBACK"],
      ["invalid_gesture", 400, "INVALID_GESTURE"],
      ["invalid_coordinates", 400, "INVALID_COORDINATES"],
      ["screenshot_frame_unavailable", 409, "SCREENSHOT_FRAME_UNAVAILABLE"],
      ["pointer_dispatch_failed", 502, "POINTER_DISPATCH_FAILED"],
      ["store_or_state_failed", 409, "STORE_OR_STATE_FAILED"],
    ];
    for (const [reason, status, code] of cases) {
      mockedRelay.mockResolvedValueOnce({ ok: false, reason: reason as any });
      const res = await server.inject({
        method: "POST",
        url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
        payload: { cdp_url: "http://localhost:9222", gesture: TAP },
      });
      expect(res.statusCode).toBe(status);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(code);
      assertNoByteOrGeometryLeak(res.body);
    }
  });

  it("does not echo browser/pointer internals on failure", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();
    mockedRelay.mockResolvedValue({ ok: false, reason: "pointer_dispatch_failed" });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
      payload: { cdp_url: "http://localhost:9222", target_id: "T1", gesture: TAP },
    });
    expect(res.statusCode).toBe(502);
    // Neither the cdp_url nor target_id supplied in the request is reflected back.
    expect(res.body).not.toContain("http://localhost:9222");
    expect(res.body).not.toContain("T1");
  });

  it("non-leakage guard across JSON and raw body", async () => {
    enable();
    // Seed the frame with the example viewport dims (640x400) so the dimension
    // checks below are meaningful — they must never surface in the response.
    const capsule = createVisualGestureCapsule(BASE);
    const stored = storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
      png_base64: PNG,
      viewport_css_width: 640,
      viewport_css_height: 400,
    });
    expect(stored.ok).toBe(true);

    mockedRelay.mockResolvedValue({
      ok: true,
      capsule_id: capsule.capsule_id,
      status: "checking",
      gesture_relayed: true,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
      payload: { cdp_url: "http://localhost:9222", target_id: "T1", gesture: PRESS_HOLD },
    });

    // String field-name / strategy tokens: check both parsed JSON and raw body.
    // (Bare numeric dims are checked separately via numeric values to avoid
    // false positives from ISO-timestamp millisecond digits.)
    const forbiddenStrings = [
      "png_base64",
      "fx",
      "fy",
      "cssX",
      "cssY",
      "duration_ms",
      "cdp_url",
      "target_id",
      "viewport_css_width",
      "viewport_css_height",
      "path",
      "strategy",
    ];
    const serialized = JSON.stringify(res.json());
    for (const token of forbiddenStrings) {
      expect(serialized).not.toContain(token);
      expect(res.body).not.toContain(token);
    }

    // Viewport dimensions (640, 400) must not appear as numeric values anywhere
    // in the response — robust against timestamp/id substring collisions.
    const numbers: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "number") numbers.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(res.json());
    expect(numbers).not.toContain(640);
    expect(numbers).not.toContain(400);
  });

  it("post-relay capsule vanish → safe 409 STORE_OR_STATE_FAILED", async () => {
    enable();
    const capsule = seedCapsuleWithFrame();
    // Relay reports success, but the capsule is gone by the time we re-fetch.
    mockedRelay.mockImplementation(async () => {
      cancelVisualGestureCapsule(capsule.capsule_id);
      clearVisualGestureCapsulesForTests();
      return {
        ok: true,
        capsule_id: capsule.capsule_id,
        status: "checking",
        gesture_relayed: true,
      };
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/visual-gesture-capsules/${capsule.capsule_id}/gesture`,
      payload: { cdp_url: "http://localhost:9222", gesture: TAP },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("STORE_OR_STATE_FAILED");
  });
});
