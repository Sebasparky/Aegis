import { describe, it, expect, afterEach, beforeEach } from "vitest";

import {
  createVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  mapNormalizedImagePointToViewport,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";
import {
  relayVisualGestureCapsuleGesture,
  isFrameStale,
  targetPointBucket,
  screenshotScaleBucket,
  readPngWidthPx,
  type VisualGesturePointerRelay,
} from "../runtime/visualGestureCapsuleRelay.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE = {
  human_verification_request_id: "hvr_map_001",
  browser_session_id: "tbs_map_001",
  domain: "example.com",
  page_url: "https://example.com/wall",
};

// A real, minimal 1×1 PNG — its IHDR width is exactly 1. Used to prove the
// header-only width reader works on actual PNG bytes.
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// The redaction placeholder used elsewhere in the suite — NOT a full PNG, so the
// width reader must fail closed (undefined) rather than misread junk.
const REDACTED_PLACEHOLDER = "iVBORw0KGgoREDACTED==";

/**
 * Replicate the frontend's `normalizePointInRect` math (apps/web): the fraction of
 * a client point within the displayed image's bounding rect. Kept local because
 * apps/web has no test runner; this is the exact `(x-left)/width` formula the UI
 * uses, so the round-trip below validates the real cross-tier contract.
 */
function normalizeLikeFrontend(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { fx: number; fy: number } {
  return {
    fx: (clientX - rect.left) / rect.width,
    fy: (clientY - rect.top) / rect.height,
  };
}

beforeEach(() => {
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
});

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
});

// ─── Round-trip: displayed-fraction → viewport, scale/offset invariant ───────

describe("coordinate round-trip (frontend normalize → backend map)", () => {
  const VW = 1280;
  const VH = 800;

  // The true point the user means, expressed as a viewport fraction. The button
  // can be anywhere; the round-trip must recover its viewport CSS position no
  // matter how the screenshot is displayed.
  const cases: Array<{ name: string; ffx: number; ffy: number }> = [
    { name: "centered button", ffx: 0.5, ffy: 0.5 },
    { name: "lower-right button", ffx: 0.72, ffy: 0.81 },
    { name: "upper-left button", ffx: 0.18, ffy: 0.22 },
  ];

  // How the screenshot is laid out in the page: scaled down by `scale` and offset
  // by (left, top) — i.e. scaled AND centered/letterboxed inside some container.
  const layouts: Array<{ name: string; scale: number; left: number; top: number }> = [
    { name: "1:1 at origin", scale: 1, left: 0, top: 0 },
    { name: "downscaled 0.5, centered", scale: 0.5, left: 80, top: 100 },
    { name: "downscaled 0.37, offset", scale: 0.37, left: 12.5, top: 240 },
  ];

  for (const c of cases) {
    for (const l of layouts) {
      it(`recovers the ${c.name} viewport point when ${l.name}`, () => {
        // The displayed image's bounding rect (CSS px in the page).
        const rect = {
          left: l.left,
          top: l.top,
          width: VW * l.scale,
          height: VH * l.scale,
        };
        // The user clicks the button at its displayed location.
        const clientX = rect.left + c.ffx * rect.width;
        const clientY = rect.top + c.ffy * rect.height;

        // Frontend normalizes against the displayed rect, backend maps to viewport.
        const { fx, fy } = normalizeLikeFrontend(clientX, clientY, rect);
        const mapped = mapNormalizedImagePointToViewport({
          fx,
          fy,
          viewportCssWidth: VW,
          viewportCssHeight: VH,
        });

        // It must land on the true viewport CSS position of the button — the
        // display scale and container offset cancel out entirely.
        expect(mapped.cssX).toBeCloseTo(c.ffx * VW, 6);
        expect(mapped.cssY).toBeCloseTo(c.ffy * VH, 6);
      });
    }
  }

  it("maps the image center to the viewport center regardless of downscale", () => {
    const at1x = mapNormalizedImagePointToViewport({
      fx: 0.5,
      fy: 0.5,
      viewportCssWidth: VW,
      viewportCssHeight: VH,
    });
    // Normalizing a center click on a 0.25-scaled image still yields fx=fy=0.5.
    const rect = { left: 300, top: 50, width: VW * 0.25, height: VH * 0.25 };
    const { fx, fy } = normalizeLikeFrontend(
      rect.left + 0.5 * rect.width,
      rect.top + 0.5 * rect.height,
      rect,
    );
    expect(fx).toBeCloseTo(0.5, 9);
    expect(fy).toBeCloseTo(0.5, 9);
    expect(at1x).toEqual({ cssX: VW / 2, cssY: VH / 2 });
  });
});

// ─── Safe debug buckets ──────────────────────────────────────────────────────

describe("targetPointBucket", () => {
  it("buckets center / cardinal regions / edges", () => {
    expect(targetPointBucket(0.5, 0.5)).toBe("center");
    expect(targetPointBucket(0.55, 0.48)).toBe("center");
    expect(targetPointBucket(0.2, 0.5)).toBe("left");
    expect(targetPointBucket(0.8, 0.5)).toBe("right");
    expect(targetPointBucket(0.5, 0.2)).toBe("upper");
    expect(targetPointBucket(0.5, 0.8)).toBe("lower");
    expect(targetPointBucket(0.02, 0.5)).toBe("edge");
    expect(targetPointBucket(0.5, 0.98)).toBe("edge");
  });

  it("falls back to edge for out-of-range / non-finite input", () => {
    expect(targetPointBucket(1.5, 0.5)).toBe("edge");
    expect(targetPointBucket(Number.NaN, 0.5)).toBe("edge");
    expect(targetPointBucket(0.5, -0.1)).toBe("edge");
  });
});

describe("screenshotScaleBucket", () => {
  it("buckets the capture ratio coarsely", () => {
    expect(screenshotScaleBucket(1280, 1280)).toBe("1x");
    expect(screenshotScaleBucket(1300, 1280)).toBe("1x"); // within ±5%
    expect(screenshotScaleBucket(2560, 1280)).toBe("upscaled");
    expect(screenshotScaleBucket(640, 1280)).toBe("downscaled");
  });

  it("returns unknown for missing / invalid inputs", () => {
    expect(screenshotScaleBucket(undefined, 1280)).toBe("unknown");
    expect(screenshotScaleBucket(1280, undefined)).toBe("unknown");
    expect(screenshotScaleBucket(0, 1280)).toBe("unknown");
    expect(screenshotScaleBucket(1280, 0)).toBe("unknown");
  });
});

describe("readPngWidthPx", () => {
  it("reads the IHDR width from real PNG header bytes", () => {
    expect(readPngWidthPx(ONE_BY_ONE_PNG_BASE64)).toBe(1);
  });

  it("fails closed on non-PNG / short / empty input", () => {
    expect(readPngWidthPx(REDACTED_PLACEHOLDER)).toBeUndefined();
    expect(readPngWidthPx("")).toBeUndefined();
    expect(readPngWidthPx(undefined)).toBeUndefined();
    expect(readPngWidthPx("bm90IGEgcG5n")).toBeUndefined(); // "not a png"
  });
});

// ─── Frame staleness ─────────────────────────────────────────────────────────

describe("isFrameStale", () => {
  const captured = {
    width: 1280,
    height: 800,
    scroll_x: 0,
    scroll_y: 120,
    layout_w: 1280,
    layout_h: 4000,
  };

  it("is not stale when the live page matches", () => {
    expect(
      isFrameStale({ width: 1280, height: 800, scrollX: 0, scrollY: 120, layoutW: 1280, layoutH: 4000 }, captured),
    ).toEqual({ stale: false });
  });

  it("tolerates sub-pixel rounding on all axes", () => {
    expect(
      isFrameStale(
        { width: 1280, height: 800, scrollX: 1, scrollY: 121, layoutW: 1281, layoutH: 4001 },
        captured,
      ),
    ).toEqual({ stale: false });
  });

  it("flags viewport size drift", () => {
    expect(isFrameStale({ width: 1000, height: 800, scrollX: 0, scrollY: 120 }, captured)).toEqual({
      stale: true,
      kind: "viewport",
    });
  });

  it("flags scroll drift", () => {
    expect(
      isFrameStale({ width: 1280, height: 800, scrollX: 0, scrollY: 600 }, captured),
    ).toEqual({ stale: true, kind: "scroll" });
  });

  it("flags layout reflow", () => {
    expect(
      isFrameStale(
        { width: 1280, height: 800, scrollX: 0, scrollY: 120, layoutW: 1280, layoutH: 2000 },
        captured,
      ),
    ).toEqual({ stale: true, kind: "layout" });
  });

  it("falls back to size-only when the frame lacks scroll/layout (legacy)", () => {
    const legacy = { width: 1280, height: 800 };
    // Live scroll differs wildly, but with no captured scroll there is nothing to
    // compare — size matches, so it is not considered stale.
    expect(isFrameStale({ width: 1280, height: 800, scrollX: 0, scrollY: 999 }, legacy)).toEqual({
      stale: false,
    });
  });
});

// ─── Relay refuses a scroll-drifted frame without dispatch or leak ───────────

describe("relayVisualGestureCapsuleGesture — scroll drift", () => {
  const FORBIDDEN_NUMERIC_VALUES = [1280, 800, 600, 640, 400, 120];

  function collectNumbers(value: unknown, out: number[] = []): number[] {
    if (typeof value === "number") out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
    else if (value && typeof value === "object")
      Object.values(value).forEach((v) => collectNumbers(v, out));
    return out;
  }

  function makeFakeRelay(): VisualGesturePointerRelay & { totalCalls(): number } {
    let calls = 0;
    return {
      totalCalls: () => calls,
      async tapAtPoint() {
        calls++;
        return { ok: true };
      },
      async pressHoldAtPoint() {
        calls++;
        return { ok: true };
      },
    };
  }

  it("refuses with scroll_drifted, dispatches nothing, and leaks no geometry", async () => {
    const capsule = createVisualGestureCapsule(BASE);
    const stored = storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
      png_base64: ONE_BY_ONE_PNG_BASE64,
      viewport_css_width: 1280,
      viewport_css_height: 800,
      scroll_x: 0,
      scroll_y: 120,
      layout_w: 1280,
      layout_h: 4000,
    });
    expect(stored.ok).toBe(true);

    const relay = makeFakeRelay();
    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://127.0.0.1:9222",
      gesture: { kind: "press_hold", fx: 0.5, fy: 0.5, duration_ms: 1500 },
      pointerRelay: relay,
      // Live viewport same size but scrolled far past tolerance.
      readLiveViewport: async () => ({
        width: 1280,
        height: 800,
        scrollX: 0,
        scrollY: 600,
        layoutW: 1280,
        layoutH: 4000,
      }),
    });

    expect(res).toEqual({ ok: false, reason: "scroll_drifted" });
    expect(relay.totalCalls()).toBe(0); // no dispatch

    // The result must not surface any viewport / scroll / coordinate magnitude.
    const numbers = collectNumbers(res);
    for (const n of FORBIDDEN_NUMERIC_VALUES) expect(numbers).not.toContain(n);
    const raw = JSON.stringify(res);
    for (const banned of ["scrollY", "scroll_y", "cssX", "cssY", "fx", "fy", "1280", "600"]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("does not burn an attempt on a scroll-drifted refusal", async () => {
    const capsule = createVisualGestureCapsule(BASE);
    storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
      png_base64: ONE_BY_ONE_PNG_BASE64,
      viewport_css_width: 1280,
      viewport_css_height: 800,
      scroll_x: 0,
      scroll_y: 0,
      layout_w: 1280,
      layout_h: 4000,
    });

    const before = capsule.attempt_count;
    await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: "http://127.0.0.1:9222",
      gesture: { kind: "tap", fx: 0.4, fy: 0.4 },
      pointerRelay: makeFakeRelay(),
      readLiveViewport: async () => ({ width: 1280, height: 800, scrollX: 0, scrollY: 500 }),
    });

    expect(capsule.attempt_count).toBe(before);
  });
});
