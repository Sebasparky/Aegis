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
  geometryObstructionStrength,
  classifyReleasePresence,
  VGC_RECHECK_SETTLE_MS,
  VGC_RECHECK_RETRY_SETTLE_MS,
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

/**
 * Recheck with the post-release settle delays disabled, so the existing
 * behavioral assertions run instantly. Settle-timing is covered separately with
 * an injected sleep spy. Args spread last so a case can re-enable a delay.
 */
function recheck(args: Parameters<typeof recheckVisualGestureCapsule>[0]) {
  return recheckVisualGestureCapsule({ settleMs: 0, retrySettleMs: 0, ...args });
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
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "flag_disabled" });
    expect(probe.mock).not.toHaveBeenCalled();
  });

  it("missing capsule → not_found, probe not called", async () => {
    enable();
    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheck({ capsuleId: "vgc_nope", cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(probe.mock).not.toHaveBeenCalled();
  });

  it("terminal capsule → terminal, probe not called", async () => {
    enable();
    const capsule = createVisualGestureCapsule(BASE);
    cancelVisualGestureCapsule(capsule.capsule_id); // terminal (cancelled)

    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

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
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "invalid_state" });
    expect(probe.mock).not.toHaveBeenCalled();
  });

  it("checking + probe absent → marks cleared", async () => {
    enable();
    const capsule = seedCheckingCapsule();

    const probe = probeReturning({ ok: true, presence: "absent" });
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

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
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

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

    const first = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });
    expect(first).toMatchObject({ ok: true, status: "rejected_retryable", attempt_count: 1 });

    // rejected_retryable is an allowed recheck state — a second positive probe
    // exhausts the attempt budget and falls back to manual_fallback.
    const second = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });
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
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

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
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({ ok: false, reason: "probe_failed" });
    const stored = getVisualGestureCapsule(capsule.capsule_id);
    expect(stored?.status).toBe("checking");
    expect(stored?.attempt_count).toBe(0);
  });

  it("awaiting_user_gesture is an allowed recheck state", async () => {
    enable();
    const capsule = createVisualGestureCapsule(BASE); // status: awaiting_user_gesture
    const probe = probeReturning({ ok: true, presence: "absent" });

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });
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
    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

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

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe: leaky });
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

  // ── Post-release settle + weak-geometry retry ──────────────────────────────

  /** A probe returning a different verdict on each successive call. */
  function probeSequence(
    ...verdicts: Awaited<ReturnType<VisualGestureCapsulePresenceProbe>>[]
  ): VisualGestureCapsulePresenceProbe & { mock: ReturnType<typeof vi.fn> } {
    const mock = vi.fn();
    for (const v of verdicts) mock.mockResolvedValueOnce(v);
    return Object.assign(((args: any) => mock(args)) as VisualGestureCapsulePresenceProbe, { mock });
  }

  it("strong geometry only (hv absent) → still_present, attempt burned, no retry", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const probe = probeReturning({ ok: true, presence: "present", hv_present: false, geo_strength: "strong" });

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toMatchObject({ ok: true, outcome: "still_present", status: "rejected_retryable", attempt_count: 1 });
    expect(probe.mock).toHaveBeenCalledTimes(1); // strong is decisive — no retry
  });

  it("weak geometry-only false positive after release → retries, then clears, NO attempt burned", async () => {
    // The QA bug: a lone pointer interceptor on the now-healthy page reads weak on
    // both probes. After the retry settle it must clear, not burn an attempt.
    enable();
    const capsule = seedCheckingCapsule();
    const probe = probeSequence(
      { ok: true, presence: "present", hv_present: false, geo_strength: "weak" },
      { ok: true, presence: "present", hv_present: false, geo_strength: "weak" },
    );

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toEqual({
      ok: true,
      capsule_id: capsule.capsule_id,
      outcome: "cleared",
      status: "cleared",
      attempt_count: 0,
    });
    expect(probe.mock).toHaveBeenCalledTimes(2); // first weak → one retry
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("cleared");
  });

  it("weak geometry then STRONG on retry → still_present (real wall confirmed)", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const probe = probeSequence(
      { ok: true, presence: "present", hv_present: false, geo_strength: "weak" },
      { ok: true, presence: "present", hv_present: false, geo_strength: "strong" },
    );

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toMatchObject({ ok: true, outcome: "still_present", status: "rejected_retryable", attempt_count: 1 });
    expect(probe.mock).toHaveBeenCalledTimes(2);
  });

  it("weak geometry then HV present on retry → still_present", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const probe = probeSequence(
      { ok: true, presence: "present", hv_present: false, geo_strength: "weak" },
      { ok: true, presence: "present", hv_present: true, geo_strength: "none" },
    );

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toMatchObject({ ok: true, outcome: "still_present", attempt_count: 1 });
  });

  it("weak geometry then absent on retry → cleared", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const probe = probeSequence(
      { ok: true, presence: "present", hv_present: false, geo_strength: "weak" },
      { ok: true, presence: "absent", hv_present: false, geo_strength: "none" },
    );

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toMatchObject({ ok: true, outcome: "cleared", status: "cleared", attempt_count: 0 });
  });

  it("weak geometry then probe failure on retry → unknown, no burn, no clear", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const probe = probeSequence(
      { ok: true, presence: "present", hv_present: false, geo_strength: "weak" },
      { ok: false, reason: "probe_connect_failed" },
    );

    const res = await recheck({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe });

    expect(res).toMatchObject({ ok: true, outcome: "unknown", status: "checking", attempt_count: 0 });
    const stored = getVisualGestureCapsule(capsule.capsule_id);
    expect(stored?.status).toBe("checking");
    expect(stored?.attempt_count).toBe(0);
  });

  it("awaits the settle before the first probe; only weak readings pay the retry settle", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const probe = probeSequence(
      { ok: true, presence: "present", hv_present: false, geo_strength: "weak" },
      { ok: true, presence: "present", hv_present: false, geo_strength: "strong" },
    );

    // No settleMs/retrySettleMs override → exercises the real defaults via the spy.
    await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe, sleep });

    expect(sleep).toHaveBeenNthCalledWith(1, VGC_RECHECK_SETTLE_MS);
    expect(sleep).toHaveBeenNthCalledWith(2, VGC_RECHECK_RETRY_SETTLE_MS);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("clearly-absent first probe takes the fast path: one settle, no retry", async () => {
    enable();
    const capsule = seedCheckingCapsule();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const probe = probeReturning({ ok: true, presence: "absent", hv_present: false, geo_strength: "none" });

    const res = await recheckVisualGestureCapsule({ capsuleId: capsule.capsule_id, cdpUrl: CDP, probe, sleep });

    expect(res).toMatchObject({ ok: true, outcome: "cleared" });
    expect(probe.mock).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1); // settle only — no retry settle
    expect(sleep).toHaveBeenNthCalledWith(1, VGC_RECHECK_SETTLE_MS);
  });
});

describe("geometryObstructionStrength (signal-strength reduction)", () => {
  it("any strong signal → strong", () => {
    expect(geometryObstructionStrength({ denial_text_seen: true })).toBe("strong");
    expect(geometryObstructionStrength({ viewport_scrim_seen: true })).toBe("strong");
    expect(geometryObstructionStrength({ large_centered_overlay_seen: true })).toBe("strong");
    expect(geometryObstructionStrength({ visible_inaccessible_iframe_seen: true })).toBe("strong");
    expect(geometryObstructionStrength({ near_zero_interactive: true })).toBe("strong");
  });

  it("pointer interceptor alone → weak", () => {
    expect(geometryObstructionStrength({ pointer_interceptor_seen: true })).toBe("weak");
    // ...but a strong signal alongside it dominates.
    expect(
      geometryObstructionStrength({ pointer_interceptor_seen: true, large_centered_overlay_seen: true }),
    ).toBe("strong");
    expect(
      geometryObstructionStrength({ pointer_interceptor_seen: true, near_zero_interactive: true }),
    ).toBe("strong");
  });

  it("all signals false → none", () => {
    expect(
      geometryObstructionStrength({
        denial_text_seen: false,
        viewport_scrim_seen: false,
        large_centered_overlay_seen: false,
        visible_inaccessible_iframe_seen: false,
        near_zero_interactive: false,
        pointer_interceptor_seen: false,
      }),
    ).toBe("none");
  });

  it("unparseable / no recognizable boolean field → undefined", () => {
    expect(geometryObstructionStrength(null)).toBeUndefined();
    expect(geometryObstructionStrength("nope")).toBeUndefined();
    expect(geometryObstructionStrength({})).toBeUndefined();
    expect(geometryObstructionStrength({ repeated_stale: true })).toBeUndefined();
  });
});

describe("classifyReleasePresence (HV + geometry-strength decision)", () => {
  it("structural HV present → present (regardless of geometry)", () => {
    expect(classifyReleasePresence(true, "none")).toBe("present");
    expect(classifyReleasePresence(true, "weak")).toBe("present");
    expect(classifyReleasePresence(true, undefined)).toBe("present");
  });

  it("strong geometry → present", () => {
    expect(classifyReleasePresence(false, "strong")).toBe("present");
    expect(classifyReleasePresence(undefined, "strong")).toBe("present");
  });

  it("weak geometry only → weak_ambiguous", () => {
    expect(classifyReleasePresence(false, "weak")).toBe("weak_ambiguous");
    expect(classifyReleasePresence(undefined, "weak")).toBe("weak_ambiguous");
  });

  it("hv absent or no geometry obstruction → absent", () => {
    expect(classifyReleasePresence(false, "none")).toBe("absent");
    expect(classifyReleasePresence(false, undefined)).toBe("absent");
    expect(classifyReleasePresence(undefined, "none")).toBe("absent");
  });

  it("neither verdict usable → unknown", () => {
    expect(classifyReleasePresence(undefined, undefined)).toBe("unknown");
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
