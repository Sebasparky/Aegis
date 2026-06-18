/**
 * Visual Gesture Capsule — M1H opaque-HV creation orchestrator (unit).
 *
 * Covers the single backend trigger that mints a capsule for an opaque/page-level
 * human-verification wall. Capture is injected (no real CDP/browser). Asserts the
 * flag gate, capsule creation, capture-success/failure degradation, and that the
 * result leaks no bytes/coords/viewport/cdp/strategy.
 */

import { vi, describe, it, expect, afterEach } from "vitest";

import {
  isVisualGestureCapsuleEnabled,
  getVisualGestureCapsule,
  listActiveVisualGestureCapsules,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";
import type { CaptureVisualGestureCapsuleScreenshotFrameResult } from "../runtime/visualGestureCapsuleCapture.js";
import { createVisualGestureCapsuleForOpaqueHv } from "../runtime/visualGestureCapsuleOrchestrator.js";

const BASE = {
  humanVerificationRequestId: "hvr_test_orch_001",
  browserSessionId: "tbs_test_orch_001",
  domain: "example.com",
  cdpUrl: "http://localhost:9222",
  pageUrl: "https://example.com/checkout",
  delegationId: "del_orch_001",
  userId: "user_001",
  reason: "opaque_hv_no_control_box" as const,
};

/** A fake capture seam that records calls and returns a fixed result. */
function fakeCapture(result: CaptureVisualGestureCapsuleScreenshotFrameResult) {
  return vi.fn(async () => result);
}

const CAPTURE_OK: CaptureVisualGestureCapsuleScreenshotFrameResult = {
  ok: true,
  capsule_id: "ignored",
  screenshot_available: true,
  screenshot_captured_at: new Date().toISOString(),
  screenshot_expires_at: new Date(Date.now() + 45_000).toISOString(),
};

const CAPTURE_FAIL: CaptureVisualGestureCapsuleScreenshotFrameResult = {
  ok: false,
  reason: "capture_failed",
};

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
});

describe("createVisualGestureCapsuleForOpaqueHv", () => {
  it("(1) flag disabled → flag_disabled; no capsule created and capture never called", async () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    expect(isVisualGestureCapsuleEnabled()).toBe(false);
    const capture = fakeCapture(CAPTURE_OK);

    const res = await createVisualGestureCapsuleForOpaqueHv({ ...BASE, capture });

    expect(res).toEqual({ ok: false, reason: "flag_disabled" });
    expect(capture).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(2) missing required identity → not_needed; no capsule, no capture", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const capture = fakeCapture(CAPTURE_OK);

    const res = await createVisualGestureCapsuleForOpaqueHv({
      ...BASE,
      humanVerificationRequestId: "",
      capture,
    });

    expect(res).toEqual({ ok: false, reason: "not_needed" });
    expect(capture).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(3) flag on + capture ok → capsule created (awaiting_user_gesture) and screenshot_available true", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const capture = fakeCapture(CAPTURE_OK);

    const res = await createVisualGestureCapsuleForOpaqueHv({ ...BASE, capture });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.screenshot_available).toBe(true);
    expect(res.capsule.capsule_id).toMatch(/^vgc_/);
    expect(res.capsule.status).toBe("awaiting_user_gesture");
    expect(res.capsule.user_presence_required).toBe(true);
    expect(res.capsule.purchase_authorized).toBe(false);

    // Capture was called for THIS capsule with the cdpUrl seam (never surfaced).
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ capsuleId: res.capsule.capsule_id, cdpUrl: BASE.cdpUrl }),
    );

    // The capsule is really in the store and linked to the HV request.
    const stored = getVisualGestureCapsule(res.capsule.capsule_id);
    expect(stored).toBeDefined();
    expect(stored!.human_verification_request_id).toBe(BASE.humanVerificationRequestId);
  });

  it("(4) flag on + capture FAILS → capsule still alive, screenshot_available false (retryable via /recapture)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const capture = fakeCapture(CAPTURE_FAIL);

    const res = await createVisualGestureCapsuleForOpaqueHv({ ...BASE, capture });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.screenshot_available).toBe(false);
    // The capsule remains available — not torn down on a missing first frame.
    expect(getVisualGestureCapsule(res.capsule.capsule_id)).toBeDefined();
  });

  it("(4b) flag on + capture THROWS → degrades like a failed capture, no unhandled rejection", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const capture = vi.fn(async () => {
      throw new Error("cdp exploded");
    });

    const res = await createVisualGestureCapsuleForOpaqueHv({ ...BASE, capture });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.screenshot_available).toBe(false);
    expect(getVisualGestureCapsule(res.capsule.capsule_id)).toBeDefined();
  });

  it("(5) result leaks no bytes/coords/viewport/cdp/strategy", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const capture = fakeCapture(CAPTURE_OK);

    const res = await createVisualGestureCapsuleForOpaqueHv({ ...BASE, capture });

    const serialized = JSON.stringify(res);
    for (const forbidden of [
      "png_base64",
      "data:image",
      "viewport_css_width",
      "viewport_css_height",
      "cssX",
      "cssY",
      '"fx"',
      '"fy"',
      "cdp_url",
      "cdpUrl",
      "target_id",
      "expected_url",
      "strategy",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
