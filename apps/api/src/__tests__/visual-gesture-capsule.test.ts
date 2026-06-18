import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

import {
  isVisualGestureCapsuleEnabled,
  createVisualGestureCapsule,
  getVisualGestureCapsule,
  listActiveVisualGestureCapsules,
  transitionVisualGestureCapsule,
  markGestureAttemptRejected,
  markGestureCapsuleCleared,
  cancelVisualGestureCapsule,
  expireVisualGestureCapsules,
  getSafeVisualGestureCapsuleView,
  mapNormalizedImagePointToViewport,
  clearVisualGestureCapsulesForTests,
  isTerminalVisualGestureStatus,
  storeVisualGestureCapsuleScreenshotFrame,
  getVisualGestureCapsuleScreenshotFrame,
  clearVisualGestureCapsuleScreenshotFrame,
  recaptureVisualGestureCapsuleScreenshotFrame,
  VISUAL_GESTURE_CAPSULE_TTL_MS,
  VISUAL_GESTURE_SCREENSHOT_FRAME_TTL_MS,
  MAX_GESTURE_ATTEMPTS,
} from "../runtime/visualGestureCapsule.js";

const BASE = {
  human_verification_request_id: "hvr_test_001",
  browser_session_id: "tbs_test_001",
  domain: "example.com",
  page_url: "https://example.com/checkout",
};

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  vi.useRealTimers();
});

describe("isVisualGestureCapsuleEnabled (flag)", () => {
  it("defaults to false when the env var is unset", () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    expect(isVisualGestureCapsuleEnabled()).toBe(false);
  });

  it("is true only for the literal 'true'", () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    expect(isVisualGestureCapsuleEnabled()).toBe(true);
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "1";
    expect(isVisualGestureCapsuleEnabled()).toBe(false);
  });
});

describe("createVisualGestureCapsule", () => {
  it("initializes the expected foundation fields", () => {
    const c = createVisualGestureCapsule(BASE);
    expect(c.status).toBe("awaiting_user_gesture");
    expect(c.supported_gestures).toEqual(["tap", "press_hold"]);
    expect(c.max_attempts).toBe(2);
    expect(MAX_GESTURE_ATTEMPTS).toBe(2);
    expect(c.attempt_count).toBe(0);
    expect(c.user_presence_required).toBe(true);
    expect(c.purchase_authorized).toBe(false);
    expect(c.raw_gesture_revealed_to_agent).toBe(false);
    expect(c.screenshot_revealed_to_agent).toBe(false);
    expect(c.capsule_id).toMatch(/^vgc_/);
    expect(c.human_verification_request_id).toBe(BASE.human_verification_request_id);
    expect(c.browser_session_id).toBe(BASE.browser_session_id);
    expect(c.domain).toBe(BASE.domain);
    // expires_at is TTL after created_at.
    const delta =
      new Date(c.expires_at).getTime() - new Date(c.created_at).getTime();
    expect(delta).toBe(VISUAL_GESTURE_CAPSULE_TTL_MS);
  });

  it("stores no screenshot bytes in the record (M1A foundation)", () => {
    const c = createVisualGestureCapsule(BASE);
    const json = JSON.stringify(c);
    expect(json).not.toContain("screenshot_bytes");
    expect(json).not.toContain("base64");
    expect(json).not.toContain("data:image");
  });
});

describe("getSafeVisualGestureCapsuleView", () => {
  it("includes only allowlisted fields and the literal safety booleans", () => {
    const c = createVisualGestureCapsule({
      ...BASE,
      viewport_css_width: 1280,
      viewport_css_height: 800,
    });
    const view = getSafeVisualGestureCapsuleView(c);

    // No frame stored → screenshot_available is present (false); the two
    // screenshot timestamps are omitted until a live frame exists.
    expect(Object.keys(view).sort()).toEqual(
      [
        "attempt_count",
        "capsule_id",
        "domain",
        "expires_at",
        "max_attempts",
        "page_url",
        "purchase_authorized",
        "raw_gesture_revealed_to_agent",
        "screenshot_available",
        "screenshot_revealed_to_agent",
        "status",
        "supported_gestures",
        "user_presence_required",
      ].sort(),
    );
    expect(view.screenshot_available).toBe(false);
    expect(view.user_presence_required).toBe(true);
    expect(view.raw_gesture_revealed_to_agent).toBe(false);
    expect(view.screenshot_revealed_to_agent).toBe(false);
    expect(view.purchase_authorized).toBe(false);
  });

  it("excludes screenshot bytes, coordinates, fractions, viewport dims, and traces", () => {
    const c = createVisualGestureCapsule({
      ...BASE,
      viewport_css_width: 1280,
      viewport_css_height: 800,
    });
    c.screenshot_captured_at = new Date().toISOString();
    const raw = JSON.stringify(getSafeVisualGestureCapsuleView(c));

    for (const banned of [
      "viewport_css_width",
      "viewport_css_height",
      "screenshot_captured_at",
      "screenshot_bytes",
      "data:image",
      "cssX",
      "cssY",
      "gesture_trace",
      "control_box",
      "coordinates",
      "1280",
      "800",
    ]) {
      expect(raw).not.toContain(banned);
    }
    // The only "screenshot" tokens allowed are the safety flag + the non-byte
    // availability/timestamp metadata; "gesture" only as the safety flag / list.
    expect(raw).not.toMatch(
      /"screenshot_(?!revealed_to_agent|available|captured_at|expires_at)/,
    );
    expect(raw).not.toMatch(/"(raw_)?gesture(?!_revealed_to_agent|s")/);
  });
});

describe("mapNormalizedImagePointToViewport", () => {
  it("maps fx/fy to CSS viewport coordinates", () => {
    expect(
      mapNormalizedImagePointToViewport({
        fx: 0.5,
        fy: 0.25,
        viewportCssWidth: 1280,
        viewportCssHeight: 800,
      }),
    ).toEqual({ cssX: 640, cssY: 200 });

    expect(
      mapNormalizedImagePointToViewport({
        fx: 0,
        fy: 1,
        viewportCssWidth: 1000,
        viewportCssHeight: 500,
      }),
    ).toEqual({ cssX: 0, cssY: 500 });
  });

  it("ignores deviceScaleFactor — mapping depends only on CSS viewport size", () => {
    // The same fx/fy and CSS viewport yield the same CSS coords regardless of
    // the PNG's physical pixel size (viewport_css * deviceScaleFactor).
    const lo = mapNormalizedImagePointToViewport({
      fx: 0.3,
      fy: 0.7,
      viewportCssWidth: 1280,
      viewportCssHeight: 800,
    });
    const hi = mapNormalizedImagePointToViewport({
      fx: 0.3,
      fy: 0.7,
      viewportCssWidth: 1280, // CSS dims unchanged; a 2x or 3x DPR PNG is irrelevant
      viewportCssHeight: 800,
    });
    expect(lo).toEqual(hi);
    expect(lo).toEqual({ cssX: 384, cssY: 560 });
  });

  it("rejects out-of-range fractions and invalid viewport dims (reject policy)", () => {
    const v = { viewportCssWidth: 1280, viewportCssHeight: 800 };
    expect(() => mapNormalizedImagePointToViewport({ fx: -0.01, fy: 0.5, ...v })).toThrow(
      RangeError,
    );
    expect(() => mapNormalizedImagePointToViewport({ fx: 1.01, fy: 0.5, ...v })).toThrow(
      RangeError,
    );
    expect(() => mapNormalizedImagePointToViewport({ fx: 0.5, fy: 2, ...v })).toThrow(RangeError);
    expect(() => mapNormalizedImagePointToViewport({ fx: NaN, fy: 0.5, ...v })).toThrow(RangeError);
    expect(() =>
      mapNormalizedImagePointToViewport({ fx: 0.5, fy: 0.5, viewportCssWidth: 0, viewportCssHeight: 800 }),
    ).toThrow(RangeError);
    expect(() =>
      mapNormalizedImagePointToViewport({
        fx: 0.5,
        fy: 0.5,
        viewportCssWidth: 1280,
        viewportCssHeight: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe("attempt accounting", () => {
  it("rejected attempt 1 -> rejected_retryable (attempts remain)", () => {
    const c = createVisualGestureCapsule(BASE);
    const res = markGestureAttemptRejected(c.capsule_id);
    expect(res.ok).toBe(true);
    expect(res.capsule?.attempt_count).toBe(1);
    expect(res.capsule?.status).toBe("rejected_retryable");
    expect(isTerminalVisualGestureStatus("rejected_retryable")).toBe(false);
  });

  it("rejected attempt 2 -> manual_fallback (exhausted, non-terminal waiting state)", () => {
    const c = createVisualGestureCapsule(BASE);
    markGestureAttemptRejected(c.capsule_id);
    const res = markGestureAttemptRejected(c.capsule_id);
    expect(res.capsule?.attempt_count).toBe(2);
    expect(res.capsule?.status).toBe("manual_fallback");
    // manual_fallback is a waiting state — it can still resolve to cleared.
    expect(isTerminalVisualGestureStatus("manual_fallback")).toBe(false);
    const cleared = markGestureCapsuleCleared(c.capsule_id);
    expect(cleared.ok).toBe(true);
    expect(cleared.capsule?.status).toBe("cleared");
  });
});

describe("terminal states", () => {
  it("cleared is terminal — no transition out of it, cleared_at set", () => {
    const c = createVisualGestureCapsule(BASE);
    const cleared = markGestureCapsuleCleared(c.capsule_id);
    expect(cleared.capsule?.status).toBe("cleared");
    expect(cleared.capsule?.cleared_at).toBeTruthy();

    const blocked = transitionVisualGestureCapsule(c.capsule_id, "relaying");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("terminal");
    // A further rejected attempt is also a no-op.
    const reject = markGestureAttemptRejected(c.capsule_id);
    expect(reject.ok).toBe(false);
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("cleared");
  });

  it("cancel is terminal", () => {
    const c = createVisualGestureCapsule(BASE);
    const cancelled = cancelVisualGestureCapsule(c.capsule_id);
    expect(cancelled.capsule?.status).toBe("cancelled");
    const blocked = transitionVisualGestureCapsule(c.capsule_id, "relaying");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("terminal");
  });

  it("returns not_found for unknown capsule ids", () => {
    expect(transitionVisualGestureCapsule("vgc_missing", "relaying").reason).toBe("not_found");
    expect(markGestureAttemptRejected("vgc_missing").reason).toBe("not_found");
  });
});

describe("expiry and listActive", () => {
  it("marks a non-terminal capsule expired past its TTL", () => {
    vi.useFakeTimers();
    const c = createVisualGestureCapsule(BASE);
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("awaiting_user_gesture");

    vi.advanceTimersByTime(VISUAL_GESTURE_CAPSULE_TTL_MS + 1_000);
    expireVisualGestureCapsules();
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("expired");
    expect(isTerminalVisualGestureStatus("expired")).toBe(true);
  });

  it("does not resurrect a cleared capsule on expiry", () => {
    vi.useFakeTimers();
    const c = createVisualGestureCapsule(BASE);
    markGestureCapsuleCleared(c.capsule_id);
    vi.advanceTimersByTime(VISUAL_GESTURE_CAPSULE_TTL_MS + 1_000);
    expireVisualGestureCapsules();
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("cleared");
  });

  it("listActive excludes terminal and expired capsules", () => {
    vi.useFakeTimers();
    const active = createVisualGestureCapsule(BASE);
    const clearedC = createVisualGestureCapsule(BASE);
    const cancelledC = createVisualGestureCapsule(BASE);
    markGestureCapsuleCleared(clearedC.capsule_id);
    cancelVisualGestureCapsule(cancelledC.capsule_id);

    let ids = listActiveVisualGestureCapsules().map((c) => c.capsule_id);
    expect(ids).toEqual([active.capsule_id]);

    vi.advanceTimersByTime(VISUAL_GESTURE_CAPSULE_TTL_MS + 1_000);
    ids = listActiveVisualGestureCapsules().map((c) => c.capsule_id);
    expect(ids).toEqual([]); // the last active one has now expired
  });
});

describe("screenshot frame store (M1B)", () => {
  const FRAME = {
    png_base64: "iVBORw0KGgoREDACTED==", // stub bytes — store is byte-agnostic in M1B
    viewport_css_width: 1280,
    viewport_css_height: 800,
  };

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
  });

  it("stores a frame for an active capsule and returns it", () => {
    const c = createVisualGestureCapsule(BASE);
    const res = storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.frame.capsule_id).toBe(c.capsule_id);
    expect(res.frame.png_base64).toBe(FRAME.png_base64);
    expect(res.frame.mime_type).toBe("image/png");
    expect(res.frame.viewport_css_width).toBe(1280);
    expect(res.frame.viewport_css_height).toBe(800);
  });

  it("can retrieve a stored frame through the runtime helper", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    const frame = getVisualGestureCapsuleScreenshotFrame(c.capsule_id);
    expect(frame?.png_base64).toBe(FRAME.png_base64);
  });

  it("caps frame expiry at min(now + FRAME_TTL, capsule.expires_at)", () => {
    vi.useFakeTimers();
    const c = createVisualGestureCapsule(BASE);
    const res = storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    if (!res.ok) throw new Error("expected ok");
    const frameTtl =
      new Date(res.frame.expires_at).getTime() - new Date(res.frame.captured_at).getTime();
    // Frame TTL (45s) is far shorter than the capsule TTL (~3 min), so the
    // dedicated short window is the binding constraint here.
    expect(frameTtl).toBe(VISUAL_GESTURE_SCREENSHOT_FRAME_TTL_MS);
    expect(frameTtl).toBeLessThan(VISUAL_GESTURE_CAPSULE_TTL_MS);
  });

  it("updates capsule metadata and never puts bytes on the record", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    const stored = getVisualGestureCapsule(c.capsule_id);
    expect(stored?.viewport_css_width).toBe(1280);
    expect(stored?.viewport_css_height).toBe(800);
    expect(stored?.screenshot_captured_at).toBeTruthy();
    expect(stored?.screenshot_expires_at).toBeTruthy();
    const json = JSON.stringify(stored);
    expect(json).not.toContain(FRAME.png_base64);
    expect(json).not.toContain("png_base64");
    expect(json).not.toContain("base64");
    expect(json).not.toContain("data:image");
  });

  it("safe view exposes screenshot_available + timestamps but no bytes/dims", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    const view = getSafeVisualGestureCapsuleView(getVisualGestureCapsule(c.capsule_id)!);
    expect(view.screenshot_available).toBe(true);
    expect(view.screenshot_captured_at).toBeTruthy();
    expect(view.screenshot_expires_at).toBeTruthy();
    const raw = JSON.stringify(view);
    for (const banned of [
      FRAME.png_base64,
      "png_base64",
      "data:image",
      "viewport_css_width",
      "viewport_css_height",
      "1280",
      "800",
      "cssX",
      "cssY",
    ]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("recapture replaces the held frame (no append)", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    const next = { ...FRAME, png_base64: "iVBOR_SECOND_FRAME==" };
    const res = recaptureVisualGestureCapsuleScreenshotFrame(c.capsule_id, next);
    expect(res.ok).toBe(true);
    const frame = getVisualGestureCapsuleScreenshotFrame(c.capsule_id);
    expect(frame?.png_base64).toBe(next.png_base64); // old bytes gone, replaced
  });

  it("cancelling a capsule clears its screenshot frame", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    cancelVisualGestureCapsule(c.capsule_id);
    expect(getVisualGestureCapsuleScreenshotFrame(c.capsule_id)).toBeUndefined();
    const view = getSafeVisualGestureCapsuleView(getVisualGestureCapsule(c.capsule_id)!);
    expect(view.screenshot_available).toBe(false);
    expect(view.screenshot_captured_at).toBeUndefined();
  });

  it("clearing a capsule as cleared clears its screenshot frame", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    markGestureCapsuleCleared(c.capsule_id);
    expect(getVisualGestureCapsuleScreenshotFrame(c.capsule_id)).toBeUndefined();
  });

  it("clearVisualGestureCapsuleScreenshotFrame purges frame + metadata", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    clearVisualGestureCapsuleScreenshotFrame(c.capsule_id);
    expect(getVisualGestureCapsuleScreenshotFrame(c.capsule_id)).toBeUndefined();
    const stored = getVisualGestureCapsule(c.capsule_id);
    expect(stored?.screenshot_captured_at).toBeUndefined();
    expect(stored?.screenshot_expires_at).toBeUndefined();
  });

  it("frame expires on its own short TTL before the capsule expires", () => {
    vi.useFakeTimers();
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);

    vi.advanceTimersByTime(VISUAL_GESTURE_SCREENSHOT_FRAME_TTL_MS + 1_000);
    // Capsule itself is still live (~3 min TTL) but the frame has gone stale.
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("awaiting_user_gesture");
    expect(getVisualGestureCapsuleScreenshotFrame(c.capsule_id)).toBeUndefined();
    const view = getSafeVisualGestureCapsuleView(getVisualGestureCapsule(c.capsule_id)!);
    expect(view.screenshot_available).toBe(false);
    expect(view.screenshot_captured_at).toBeUndefined();
    expect(view.screenshot_expires_at).toBeUndefined();
  });

  it("capsule expiry clears the screenshot frame", () => {
    vi.useFakeTimers();
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    vi.advanceTimersByTime(VISUAL_GESTURE_CAPSULE_TTL_MS + 1_000);
    expireVisualGestureCapsules();
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("expired");
    expect(getVisualGestureCapsuleScreenshotFrame(c.capsule_id)).toBeUndefined();
  });

  it("clearVisualGestureCapsulesForTests clears frames", () => {
    const c = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    clearVisualGestureCapsulesForTests();
    expect(getVisualGestureCapsuleScreenshotFrame(c.capsule_id)).toBeUndefined();
  });

  it("refuses to store a frame for a missing capsule", () => {
    const res = storeVisualGestureCapsuleScreenshotFrame("vgc_missing", FRAME);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.reason).toBe("not_found");
  });

  it("refuses to store a frame for a terminal capsule", () => {
    const c = createVisualGestureCapsule(BASE);
    markGestureCapsuleCleared(c.capsule_id);
    const res = storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.reason).toBe("terminal");
  });

  it("refuses invalid frame input", () => {
    const c = createVisualGestureCapsule(BASE);
    const bad = storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, {
      ...FRAME,
      png_base64: "",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected refusal");
    expect(bad.reason).toBe("invalid_input");
    const badDims = storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, {
      ...FRAME,
      viewport_css_width: 0,
    });
    expect(badDims.ok).toBe(false);
  });

  it("flag-off: storage is a guarded no-op (flag_disabled, nothing stored)", () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    const c = createVisualGestureCapsule(BASE);
    const res = storeVisualGestureCapsuleScreenshotFrame(c.capsule_id, FRAME);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.reason).toBe("flag_disabled");
    expect(getVisualGestureCapsuleScreenshotFrame(c.capsule_id)).toBeUndefined();
    expect(getVisualGestureCapsule(c.capsule_id)?.screenshot_captured_at).toBeUndefined();
  });
});
