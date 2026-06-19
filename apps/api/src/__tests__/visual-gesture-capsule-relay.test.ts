import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

import {
  createVisualGestureCapsule,
  getVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  cancelVisualGestureCapsule,
  markGestureAttemptRejected,
  getSafeVisualGestureCapsuleView,
  clearVisualGestureCapsulesForTests,
  MAX_GESTURE_ATTEMPTS,
} from "../runtime/visualGestureCapsule.js";
import {
  relayVisualGestureCapsuleGesture,
  validateVisualGesturePayload,
  holdDurationBucket,
  HOLD_MIN_DURATION_MS,
  type VisualGesturePointerRelay,
  type VisualGestureRelayGesture,
} from "../runtime/visualGestureCapsuleRelay.js";
import { HOLD_MAX_DURATION_MS } from "../runtime/humanPresenceRelay.js";

const BASE = {
  human_verification_request_id: "hvr_relay_001",
  browser_session_id: "tbs_relay_001",
  domain: "example.com",
  page_url: "https://example.com/checkout",
};

const PNG = "iVBORw0KGgoREDACTED==";
const VW = 1280;
const VH = 800;

// Dispatch-reaching tests inject a live-viewport reader that matches the captured
// frame, so the viewport-drift guard passes and the test stays focused on mapping
// / dispatch. (Drift behavior itself is covered in the hardening suite.)
const matchingViewport = async () => ({ width: VW, height: VH });

// Viewport / coordinate magnitudes that must never surface as real numeric
// fields in a relay result or safe view. Checked as parsed numbers (not raw
// string substrings) so capsule IDs or ISO timestamps that happen to contain
// these digits can't cause a false failure.
const FORBIDDEN_NUMERIC_VALUES = [1280, 800, 640, 400];

/** Recursively collect every numeric value in a JSON-ish object/array tree. */
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => collectNumbers(v, out));
  return out;
}

interface FakePointerRelay extends VisualGesturePointerRelay {
  tapCalls: Array<{ cdpUrl: string; targetId?: string; x: number; y: number }>;
  holdCalls: Array<{ cdpUrl: string; targetId?: string; x: number; y: number; durationMs: number }>;
  totalCalls(): number;
}

function makeFakeRelay(
  result: { ok: true } | { ok: false; error?: string } = { ok: true },
): FakePointerRelay {
  const relay: FakePointerRelay = {
    tapCalls: [],
    holdCalls: [],
    totalCalls() {
      return relay.tapCalls.length + relay.holdCalls.length;
    },
    async tapAtPoint(args) {
      relay.tapCalls.push({ ...args });
      return result;
    },
    async pressHoldAtPoint(args) {
      relay.holdCalls.push({ ...args });
      return result;
    },
  };
  return relay;
}

function seedCapsule() {
  return createVisualGestureCapsule(BASE);
}

function seedCapsuleWithFrame() {
  const capsule = createVisualGestureCapsule(BASE);
  const stored = storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
    png_base64: PNG,
    viewport_css_width: VW,
    viewport_css_height: VH,
  });
  expect(stored.ok).toBe(true);
  return capsule;
}

beforeEach(() => {
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
});

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  vi.useRealTimers();
});

describe("validateVisualGesturePayload", () => {
  it("accepts tap and bounded press_hold", () => {
    expect(validateVisualGesturePayload({ kind: "tap", fx: 0.5, fy: 0.5 }).ok).toBe(true);
    expect(
      validateVisualGesturePayload({ kind: "press_hold", fx: 0.1, fy: 0.2, duration_ms: 1000 }).ok,
    ).toBe(true);
  });

  it("rejects unknown gesture kinds as invalid_gesture", () => {
    const bad = { kind: "drag", fx: 0.5, fy: 0.5 } as unknown as VisualGestureRelayGesture;
    expect(validateVisualGesturePayload(bad)).toEqual({ ok: false, reason: "invalid_gesture" });
  });

  it("rejects out-of-range fx/fy as invalid_coordinates", () => {
    expect(validateVisualGesturePayload({ kind: "tap", fx: 1.5, fy: 0.5 })).toEqual({
      ok: false,
      reason: "invalid_coordinates",
    });
    expect(validateVisualGesturePayload({ kind: "tap", fx: 0.5, fy: Number.NaN })).toEqual({
      ok: false,
      reason: "invalid_coordinates",
    });
  });

  it("rejects too-short and too-long press_hold durations as invalid_gesture", () => {
    expect(
      validateVisualGesturePayload({
        kind: "press_hold",
        fx: 0.5,
        fy: 0.5,
        duration_ms: HOLD_MIN_DURATION_MS - 1,
      }),
    ).toEqual({ ok: false, reason: "invalid_gesture" });
    expect(
      validateVisualGesturePayload({
        kind: "press_hold",
        fx: 0.5,
        fy: 0.5,
        duration_ms: HOLD_MAX_DURATION_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "invalid_gesture" });
  });
});

describe("holdDurationBucket", () => {
  it("maps durations to coarse buckets (never the raw ms)", () => {
    expect(holdDurationBucket(undefined)).toBe("<250ms"); // tap / no duration
    expect(holdDurationBucket(0)).toBe("<250ms");
    expect(holdDurationBucket(60)).toBe("<250ms"); // TAP_DWELL_MS
    expect(holdDurationBucket(249)).toBe("<250ms");
    expect(holdDurationBucket(250)).toBe("250-999ms");
    expect(holdDurationBucket(500)).toBe("250-999ms");
    expect(holdDurationBucket(999)).toBe("250-999ms");
    expect(holdDurationBucket(1000)).toBe("1-3s");
    expect(holdDurationBucket(1500)).toBe("1-3s");
    expect(holdDurationBucket(2999)).toBe("1-3s");
    expect(holdDurationBucket(3000)).toBe("3s+");
    expect(holdDurationBucket(5000)).toBe("3s+");
  });

  it("non-finite input is treated as the lowest bucket", () => {
    expect(holdDurationBucket(Number.NaN)).toBe("<250ms");
    expect(holdDurationBucket(Number.POSITIVE_INFINITY)).toBe("<250ms");
  });
});

describe("relayVisualGestureCapsuleGesture", () => {
  it("1. flag disabled -> flag_disabled, no pointer relay call", async () => {
    const capsule = seedCapsuleWithFrame();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
    });

    expect(res).toEqual({ ok: false, reason: "flag_disabled" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("2. missing capsule -> not_found", async () => {
    const relay = makeFakeRelay();
    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: "vgc_does_not_exist",
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("3. terminal capsule -> terminal, no dispatch", async () => {
    const capsule = seedCapsuleWithFrame();
    cancelVisualGestureCapsule(capsule.capsule_id);
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "terminal" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("4a. no screenshot frame -> screenshot_frame_unavailable, no dispatch", async () => {
    const capsule = seedCapsule(); // no frame stored
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "screenshot_frame_unavailable" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("4b. expired screenshot frame -> screenshot_frame_unavailable, no dispatch", async () => {
    vi.useFakeTimers();
    const capsule = seedCapsuleWithFrame();
    // Frame TTL is 45s; advance past it so the lazy-expiry drops the frame.
    vi.advanceTimersByTime(46_000);
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "screenshot_frame_unavailable" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("5. tap maps fx/fy to CSS viewport coords and calls the tap relay", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      targetId: "TARGET_A",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
      readLiveViewport: matchingViewport,
    });

    expect(res.ok).toBe(true);
    expect(relay.tapCalls).toHaveLength(1);
    expect(relay.tapCalls[0]).toEqual({
      cdpUrl: "http://localhost:9222",
      targetId: "TARGET_A",
      x: 640, // 0.5 * 1280
      y: 400, // 0.5 * 800
    });
    expect(relay.holdCalls).toHaveLength(0);
  });

  it("6. press_hold maps fx/fy and calls the pressHold relay with bounded duration", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "press_hold", fx: 0.25, fy: 0.75, duration_ms: 1500 },
      pointerRelay: relay,
      readLiveViewport: matchingViewport,
    });

    expect(res.ok).toBe(true);
    expect(relay.holdCalls).toHaveLength(1);
    expect(relay.holdCalls[0]).toEqual({
      cdpUrl: "http://localhost:9222",
      x: 320, // 0.25 * 1280
      y: 600, // 0.75 * 800
      durationMs: 1500,
    });
    expect(relay.tapCalls).toHaveLength(0);
  });

  it("7. invalid fx/fy rejected, no dispatch", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 1.5, fy: 0.5 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_coordinates" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("8. unknown gesture kind rejected, no dispatch", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "slider", fx: 0.5, fy: 0.5 } as unknown as VisualGestureRelayGesture,
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_gesture" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("9. press_hold too short rejected, no dispatch", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "press_hold", fx: 0.5, fy: 0.5, duration_ms: 100 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_gesture" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("10. press_hold too long rejected, no dispatch", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "press_hold", fx: 0.5, fy: 0.5, duration_ms: HOLD_MAX_DURATION_MS + 1 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_gesture" });
    expect(relay.totalCalls()).toBe(0);
  });

  it("11. pointer relay failure -> pointer_dispatch_failed without leaking coords", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay({ ok: false, error: "cdp down" });

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
      readLiveViewport: matchingViewport,
    });

    expect(res).toEqual({ ok: false, reason: "pointer_dispatch_failed" });
    const raw = JSON.stringify(res);
    for (const banned of ["640", "400", "cssX", "cssY", "fx", "fy", "duration", "cdp down"]) {
      expect(raw).not.toContain(banned);
    }
    // Status must not advance to checking and no attempt is burned on failure.
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("awaiting_user_gesture");
    expect(after?.attempt_count).toBe(0);
  });

  it("12. success result contains no coords/duration/path/screenshot bytes", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "press_hold", fx: 0.5, fy: 0.5, duration_ms: 1000 },
      pointerRelay: relay,
      readLiveViewport: matchingViewport,
    });

    expect(res).toEqual({
      ok: true,
      capsule_id: capsule.capsule_id,
      status: "checking",
      gesture_relayed: true,
    });
    // Semantic field-name / token guard (raw string).
    const raw = JSON.stringify(res);
    for (const banned of [
      "png_base64",
      PNG,
      "fx",
      "fy",
      "cssX",
      "cssY",
      "duration",
      "path",
      "strategy",
      "viewport_css_width",
      "viewport_css_height",
    ]) {
      expect(raw).not.toContain(banned);
    }
    // Numeric coordinate/viewport guard (parsed values, not substrings).
    const numbers = collectNumbers(res);
    for (const n of FORBIDDEN_NUMERIC_VALUES) {
      expect(numbers).not.toContain(n);
    }
  });

  it("13. safe view after relay still contains no coords/gesture traces", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
      readLiveViewport: matchingViewport,
    });

    const view = getSafeVisualGestureCapsuleView(getVisualGestureCapsule(capsule.capsule_id)!);
    // Semantic field-name / token guard (raw string).
    const raw = JSON.stringify(view);
    for (const banned of [
      "viewport_css_width",
      "viewport_css_height",
      "cssX",
      "cssY",
      "gesture_trace",
      "png_base64",
      PNG,
    ]) {
      expect(raw).not.toContain(banned);
    }
    // Numeric coordinate/viewport guard (parsed values, not substrings).
    const numbers = collectNumbers(view);
    for (const n of FORBIDDEN_NUMERIC_VALUES) {
      expect(numbers).not.toContain(n);
    }
  });

  it("14. success sets status to checking, does not mark cleared, does not burn attempt", async () => {
    const capsule = seedCapsuleWithFrame();
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
      readLiveViewport: matchingViewport,
    });

    expect(res.ok).toBe(true);
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("checking");
    expect(after?.status).not.toBe("cleared");
    expect(after?.cleared_at).toBeUndefined();
    expect(after?.attempt_count).toBe(0);
  });

  it("15. manual_fallback refuses relay, no dispatch", async () => {
    const capsule = seedCapsuleWithFrame();
    // Exhaust attempts to drive the capsule into manual_fallback.
    for (let i = 0; i < MAX_GESTURE_ATTEMPTS; i++) {
      markGestureAttemptRejected(capsule.capsule_id);
    }
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("manual_fallback");
    const relay = makeFakeRelay();

    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://localhost:9222",
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
    });
    expect(res).toEqual({ ok: false, reason: "manual_fallback" });
    expect(relay.totalCalls()).toBe(0);
  });
});
