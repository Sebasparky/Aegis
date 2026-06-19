/**
 * Visual Gesture Capsule M1G — recheck helper tests.
 *
 * Proves recheckVisualGestureCapsule:
 *  - short-circuits on the flag BEFORE any probe runs,
 *  - refuses missing / terminal / invalid-state capsules without probing,
 *  - marks cleared ONLY on a positive `absent` probe,
 *  - burns an attempt ONLY on a positive `present` probe (rejected_retryable →
 *    manual_fallback across the attempt limit),
 *  - leaves attempts and status untouched on `unknown` and on probe failure,
 *  - never surfaces screenshot bytes, coordinates, durations, or provider details.
 *
 * Probes are injected; no real CDP / live browser is ever used.
 */

import { vi, describe, it, expect, afterEach } from "vitest";

import {
  createVisualGestureCapsule,
  getVisualGestureCapsule,
  transitionVisualGestureCapsule,
  markGestureAttemptRejected,
  cancelVisualGestureCapsule,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";
import {
  recheckVisualGestureCapsule,
  combineRecheckPresence,
  geometryObstructionPresent,
  type VisualGestureCapsulePresenceProbe,
} from "../runtime/visualGestureCapsuleRecheck.js";

const BASE = {
  human_verification_request_id: "hvr_recheck_001",
  browser_session_id: "tbs_recheck_001",
  domain: "example.com",
  page_url: "https://example.com/checkout",
};

const CDP = "http://localhost:9222";

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  vi.restoreAllMocks();
});

function enable() {
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
}

/** Seed an active capsule already moved to `checking` (the post-relay state). */
function seedCheckingCapsule() {
  const capsule = createVisualGestureCapsule(BASE);
  const t = transitionVisualGestureCapsule(capsule.capsule_id, "checking");
  expect(t.ok).toBe(true);
  return capsule;
}

/** A probe that records its calls and returns a fixed verdict. */
function probeReturning(
  verdict: Awaited<ReturnType<VisualGestureCapsulePresenceProbe>>,
): VisualGestureCapsulePresenceProbe & { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockResolvedValue(verdict);
  return Object.assign(((args: any) => mock(args)) as VisualGestureCapsulePresenceProbe, { mock });
}

describe("recheckVisualGestureCapsule", () => {
  it("flag disabled → flag_disabled, probe not called", async () => {
    // Seed while enabled, then disable so a record exists but the flag is off.
    enable();
    const capsule = seedCheckingCapsule();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;

    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "flag_disabled" });
    expect(probe.mock).not.toHaveBeenCalled();
  });

  it("missing capsule → not_found, probe not called", async () => {
    enable();
    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheckVisualGestureCapsule({ capsuleId: "vgc_nope", cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(probe.mock).not.toHaveBeenCalled();
  });

  it("terminal capsule → terminal, probe not called", async () => {
    enable();
    const capsule = createVisualGestureCapsule(BASE);
    cancelVisualGestureCapsule(capsule.capsule_id); // terminal (cancelled)

    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "terminal" });
    expect(probe.mock).not.toHaveBeenCalled();
  });

  it("manual_fallback → invalid_state, probe not called", async () => {
    enable();
    const capsule = createVisualGestureCapsule(BASE);
    // Burn both attempts to reach manual_fallback (max_attempts = 2).
    markGestureAttemptRejected(capsule.capsule_id);
    markGestureAttemptRejected(capsule.capsule_id);
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("manual_fallback");

    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "invalid_state" });
    expect(probe.mock).not.toHaveBeenCalled();
  });

  it("checking + probe absent → marks cleared", async () => {
    enable();
    const capsule = seedCheckingCapsule();

    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "cleared",
      status: "cleared",
      attempt_count: 0,
    });
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("cleared");
    expect(probe.mock).toHaveBeenCalledTimes(1);
  });

  it("checking + probe present → burns attempt, rejected_retryable on first failure", async () => {
    enable();
    const capsule = seedCheckingCapsule();

    const probe = probeReturning({ ok: true, presence: "present" });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "still_present",
      status: "rejected_retryable",
      attempt_count: 1,
    });
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("rejected_retryable");
  });

  it("second present after prior rejection → manual_fallback, attempt_count increments", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const probe = probeReturning({ ok: true, presence: "present" });

    const first = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });
    expect(first).toMatchObject({ ok: true, status: "rejected_retryable", attempt_count: 1 });

    // rejected_retryable is an allowed recheck state — a second positive probe
    // exhausts the attempt budget and falls back to manual_fallback.
    const second = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });
    expect(second).toEqual({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "still_present",
      status: "manual_fallback",
      attempt_count: 2,
    });
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("manual_fallback");
  });

  it("probe unknown → outcome unknown, no attempt burn, not cleared, status unchanged", async () => {
    enable();
    const capsule = seedCheckingCapsule();

    const probe = probeReturning({ ok: true, presence: "unknown" });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "unknown",
      status: "checking",
      attempt_count: 0,
    });
    const stored = getVisualGestureCapsule(capsule.capsule_id);
    expect(stored?.status).toBe("checking");
    expect(stored?.attempt_count).toBe(0);
  });

  it("probe failure → probe_failed, no attempt burn, no status change", async () => {
    enable();
    const capsule = seedCheckingCapsule();

    const probe = probeReturning({ ok: false, reason: "probe_connect_failed" });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "probe_failed" });
    const stored = getVisualGestureCapsule(capsule.capsule_id);
    expect(stored?.status).toBe("checking");
    expect(stored?.attempt_count).toBe(0);
  });

  it("awaiting_user_gesture is an allowed recheck state", async () => {
    enable();
    const capsule = createVisualGestureCapsule(BASE); // status: awaiting_user_gesture
    const probe = probeReturning({ ok: true, presence: "absent" });

    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });
    expect(res).toMatchObject({ ok: true, outcome: "cleared", status: "cleared" });
    expect(probe.mock).toHaveBeenCalledTimes(1);
  });

  it("geometry wall still present (structural absent) → still_present, NOT cleared", async () => {
    // Regression for the false-clear bug: a capsule minted by the GEOMETRY detector
    // must not be cleared just because the structural/text HV probe reports absent.
    // The default probe unions both detectors; here the union resolves to present.
    enable();
    const capsule = seedCheckingCapsule();

    const probe = probeReturning({
      ok: true,
      presence: "present",
      hv_present: false,
      geo_present: true,
    });
    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toMatchObject({ ok: true, outcome: "still_present", status: "rejected_retryable" });
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).not.toBe("cleared");
  });

  it("result contains no screenshot bytes, coordinates, durations, or provider details", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    // A probe that (incorrectly) tries to leak geometry/provider data — the helper
    // must consume only its presence verdict, so none of it can reach the result.
    const leaky: VisualGestureCapsulePresenceProbe = async () => ({
      ok: true,
      presence: "present",
      reason: "control_box cssX cssY duration_ms perimeterx postMessage token",
    });

    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe: leaky });
    const serialized = JSON.stringify(res);
    for (const token of [
      "png_base64",
      "fx",
      "fy",
      "cssX",
      "cssY",
      "control_box",
      "duration_ms",
      "viewport_css_width",
      "viewport_css_height",
      "perimeterx",
      "postMessage",
      "token",
      "path",
      "strategy",
      CDP,
    ]) {
      expect(serialized).not.toContain(token);
    }
  });
});

describe("combineRecheckPresence (union decision)", () => {
  it("either detector present → present (fail-closed)", () => {
    expect(combineRecheckPresence(true, false)).toBe("present");
    expect(combineRecheckPresence(false, true)).toBe("present");
    expect(combineRecheckPresence(true, true)).toBe("present");
    expect(combineRecheckPresence(true, undefined)).toBe("present");
    expect(combineRecheckPresence(undefined, true)).toBe("present");
  });

  it("both parsed and both absent → absent (genuinely unblocked)", () => {
    expect(combineRecheckPresence(false, false)).toBe("absent");
  });

  it("one absent, the other unusable → absent (a usable absent verdict still clears)", () => {
    expect(combineRecheckPresence(false, undefined)).toBe("absent");
    expect(combineRecheckPresence(undefined, false)).toBe("absent");
  });

  it("neither usable → unknown (no clear, no burn)", () => {
    expect(combineRecheckPresence(undefined, undefined)).toBe("unknown");
  });
});

describe("geometryObstructionPresent (static-signal reduction)", () => {
  it("any static obstruction signal → true", () => {
    expect(geometryObstructionPresent({ large_centered_overlay_seen: true })).toBe(true);
    expect(geometryObstructionPresent({ viewport_scrim_seen: true })).toBe(true);
    expect(geometryObstructionPresent({ pointer_interceptor_seen: true })).toBe(true);
    expect(geometryObstructionPresent({ denial_text_seen: true })).toBe(true);
    expect(geometryObstructionPresent({ visible_inaccessible_iframe_seen: true })).toBe(true);
  });

  it("all static signals false → false", () => {
    expect(
      geometryObstructionPresent({
        large_centered_overlay_seen: false,
        viewport_scrim_seen: false,
        pointer_interceptor_seen: false,
        denial_text_seen: false,
        visible_inaccessible_iframe_seen: false,
      }),
    ).toBe(false);
  });

  it("repeated_stale is ignored — it is a runtime signal, not a page-state signal", () => {
    // repeated_stale alone (no static obstruction field) is not a usable verdict.
    expect(geometryObstructionPresent({ repeated_stale: true })).toBeUndefined();
    // repeated_stale must not flip an otherwise-absent page to present.
    expect(
      geometryObstructionPresent({ large_centered_overlay_seen: false, repeated_stale: true }),
    ).toBe(false);
  });

  it("unparseable / no recognizable boolean field → undefined", () => {
    expect(geometryObstructionPresent(null)).toBeUndefined();
    expect(geometryObstructionPresent("nope")).toBeUndefined();
    expect(geometryObstructionPresent({})).toBeUndefined();
    expect(geometryObstructionPresent({ large_centered_overlay_seen: "yes" })).toBeUndefined();
  });
});
