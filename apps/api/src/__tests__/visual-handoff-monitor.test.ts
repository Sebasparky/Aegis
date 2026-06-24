/**
 * Visual HV Handoff Monitor — model-driven live status + completion suite
 * (always-run, no Chromium). Exercises the real visualHandoffMonitor.ts loop and
 * the hold/recheck demotions through injected seams (a fake model classifier, a
 * fake cdp resolver, a fake release hook, and fake timers). Pins the corrected
 * architecture: the VISUAL MODEL is the primary live signal + sole completion
 * authority while a VGC is active; the DOM is auxiliary/debug and can NEVER
 * complete a visual/opaque capsule by itself.
 *
 *   1. advanceStableClear is the pure state machine (clear streak / reset rules).
 *   2. Monitor polls after mint and STOPS on terminal (completed/cancelled).
 *   3. No monitor before mint; no monitor when the flag is off (byte-identical).
 *   4. wall_present → still_active, never completes.
 *   5. uncertain / unavailable → keep waiting, never completes.
 *   6. 2 consecutive confident clears → completed (+ markCleared + release hook).
 *   7. A clear streak is reset by an intervening wall_present (no premature done).
 *   8. No overlapping model calls (in-flight discipline).
 *   9. DOM false-absent cannot complete a visual capsule under the flag (recheck).
 *  10. hold-start model gate: wall_present presses; confident clear does NOT press
 *      (deferred_clear); uncertain presses. No `challenge_gone_at_start` complete.
 *  11. No unsafe fields leak in published handoff updates.
 *  12. Flag-off byte-identical: legacy challenge_gone + DOM recheck `cleared`.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  advanceStableClear,
  verdictFromModelResult,
  startVisualHandoffMonitor,
  stopVisualHandoffMonitor,
  hasActiveVisualHandoffMonitor,
  clearVisualHandoffMonitorsForTests,
  advanceReleaseReady,
  selectReleaseReadyCrop,
  holdAnchorCropBox,
  cropCandidateCountBucket,
  VGC_STABLE_CLEAR_CONSECUTIVE,
  VGC_RELEASE_READY_CONSECUTIVE,
  FULL_RATIO_THRESHOLD,
  type VisualHandoffMonitorDeps,
} from "../runtime/visualHandoffMonitor.js";
import { cropPng } from "../runtime/screenshotRedaction.js";
import { WHOLE_CROP_BAND } from "../runtime/visualReleaseReadyWholeCrop.js";
import { PNG as PngImage } from "pngjs";
import {
  createVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  getVisualGestureCapsule,
  cancelVisualGestureCapsule,
  transitionVisualGestureCapsule,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";
import {
  startVgcHoldSession,
  clearVgcHoldSessionsForTests,
  type VgcHoldDeps,
} from "../runtime/visualGestureCapsuleHold.js";
import { recheckVisualGestureCapsule } from "../runtime/visualGestureCapsuleRecheck.js";
import {
  getLatestHvHandoffUpdate,
  publishHvHandoffUpdate,
  clearHvHandoffUpdatesForTests,
} from "../runtime/humanVerificationHandoff.js";
import type { VgcHoldModelResult } from "../runtime/visualGestureCapsuleHoldClassifier.js";

const BASE = {
  human_verification_request_id: "hvr_mon_001",
  browser_session_id: "tbs_mon_001",
  domain: "example.com",
  page_url: "https://example.com/wall",
};
const CDP = "http://localhost:9222";
const PNG = "iVBORw0KGgoREDACTED==";
const VW = 1280;
const VH = 800;

function r(verdict: VgcHoldModelResult["verdict"], available = true): VgcHoldModelResult {
  return { available, verdict, model_label: "page_level_hv_wall", model_confidence: 0.9 };
}
const UNAVAILABLE: VgcHoldModelResult = { available: false, verdict: "uncertain" };

/** A sequenced model classifier that also tracks max concurrency (in-flight). */
function makeModel(seq: VgcHoldModelResult[]) {
  let i = 0;
  let active = 0;
  let maxActive = 0;
  const fn = vi.fn(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    const out = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return out;
  });
  return { fn, maxActive: () => maxActive, calls: () => fn.mock.calls.length };
}

function seedCapsule() {
  const capsule = createVisualGestureCapsule(BASE);
  storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
    png_base64: PNG,
    viewport_css_width: VW,
    viewport_css_height: VH,
  });
  return capsule;
}

function deps(model: ReturnType<typeof makeModel>, releaseHold?: (id: string) => void): VisualHandoffMonitorDeps {
  return {
    classifyModel: model.fn,
    resolveCdpUrl: () => CDP,
    ...(releaseHold ? { releaseHold } : {}),
    intervalMs: 500,
  };
}

describe("advanceStableClear — pure stable-clear state machine", () => {
  it("first clear arms checking; the Nth consecutive clear completes", () => {
    expect(VGC_STABLE_CLEAR_CONSECUTIVE).toBe(2);
    const a1 = advanceStableClear(0, "looks_clear");
    expect(a1).toEqual({ consecutiveClear: 1, action: "checking" });
    const a2 = advanceStableClear(a1.consecutiveClear, "looks_clear");
    expect(a2).toEqual({ consecutiveClear: 2, action: "complete" });
  });

  it("wall_present resets the streak and reports still_active", () => {
    expect(advanceStableClear(1, "wall_present")).toEqual({ consecutiveClear: 0, action: "still_active" });
  });

  it("uncertain / unavailable reset the streak and keep waiting (never complete)", () => {
    expect(advanceStableClear(1, "uncertain")).toEqual({ consecutiveClear: 0, action: "wait" });
    expect(advanceStableClear(1, "unavailable")).toEqual({ consecutiveClear: 0, action: "wait" });
  });

  it("verdictFromModelResult maps an unavailable result to 'unavailable'", () => {
    expect(verdictFromModelResult(UNAVAILABLE)).toBe("unavailable");
    expect(verdictFromModelResult(r("wall_present"))).toBe("wall_present");
    expect(verdictFromModelResult(r("looks_clear"))).toBe("looks_clear");
    expect(verdictFromModelResult(r("uncertain"))).toBe("uncertain");
  });
});

describe("visualHandoffMonitor — model-driven lifecycle loop", () => {
  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED = "true";
    process.env.ANTIGEN_HV_VISUAL_HANDOFF = "true";
    vi.useFakeTimers();
    clearVisualHandoffMonitorsForTests();
    clearVisualGestureCapsulesForTests();
    clearHvHandoffUpdatesForTests();
    clearVgcHoldSessionsForTests();
  });
  afterEach(() => {
    clearVisualHandoffMonitorsForTests();
    clearVgcHoldSessionsForTests();
    vi.useRealTimers();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
    delete process.env.ANTIGEN_HV_VISUAL_HANDOFF;
  });

  it("does NOT start when the flag is off (byte-identical), and starts on mint when on", () => {
    delete process.env.ANTIGEN_HV_VISUAL_HANDOFF;
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m));
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(false);

    process.env.ANTIGEN_HV_VISUAL_HANDOFF = "true";
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m));
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(true);
  });

  it("does not poll the model before the first tick fires (no monitor ⇒ no calls)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    // No monitor started yet → nothing polls.
    await vi.advanceTimersByTimeAsync(2000);
    expect(m.calls()).toBe(0);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m));
    expect(m.calls()).toBe(0); // still nothing until a tick at +500ms
  });

  it("wall_present keeps still_active and never completes", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const release = vi.fn();
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m, release));
    await vi.advanceTimersByTimeAsync(2000); // ~4 ticks
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("still_active");
    expect(u?.agent_should_wait).toBe(true);
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    expect(release).not.toHaveBeenCalled();
    expect(m.maxActive()).toBe(1); // never overlapping
  });

  it("uncertain / unavailable keep waiting and never complete", async () => {
    const c = seedCapsule();
    const m = makeModel([UNAVAILABLE, r("uncertain"), UNAVAILABLE]);
    const release = vi.fn();
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m, release));
    await vi.advanceTimersByTimeAsync(2000);
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    expect(release).not.toHaveBeenCalled();
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    // No `completed` was ever published.
    expect(u?.phase).not.toBe("completed");
  });

  it("2 consecutive confident clears → completed (markCleared + release hook + stop)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("looks_clear"), r("looks_clear")]);
    const release = vi.fn();
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m, release));

    await vi.advanceTimersByTimeAsync(500); // tick 1 → checking
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("looks_complete_checking");
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");

    await vi.advanceTimersByTimeAsync(500); // tick 2 → complete
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("completed");
    expect(u?.agent_should_wait).toBe(false);
    expect(u?.presence_source).toBe("model");
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("cleared");
    expect(release).toHaveBeenCalledWith(c.capsule_id);
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(false);

    // No further polling after completion.
    const before = m.calls();
    await vi.advanceTimersByTimeAsync(2000);
    expect(m.calls()).toBe(before);
  });

  it("a single clear does NOT complete; an intervening wall_present resets the streak", async () => {
    const c = seedCapsule();
    const m = makeModel([r("looks_clear"), r("wall_present"), r("looks_clear")]);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m));
    await vi.advanceTimersByTimeAsync(1500); // 3 ticks: clear, wall, clear
    // After clear→wall→clear the streak is only 1, so NOT cleared.
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
  });

  it("stops polling once the capsule is terminal (cancelled)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m));
    await vi.advanceTimersByTimeAsync(500);
    expect(m.calls()).toBeGreaterThan(0);
    cancelVisualGestureCapsule(c.capsule_id);
    await vi.advanceTimersByTimeAsync(500); // next tick self-stops on terminal
    const after = m.calls();
    await vi.advanceTimersByTimeAsync(2000);
    expect(m.calls()).toBe(after);
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(false);
  });

  it("stopVisualHandoffMonitor halts the loop immediately", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m));
    stopVisualHandoffMonitor(c.capsule_id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(m.calls()).toBe(0);
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(false);
  });

  it("published updates carry only safe fields (no cdp_url / coords / bytes / paths)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, deps(m));
    await vi.advanceTimersByTimeAsync(500);
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id)!;
    const keys = Object.keys(u);
    for (const banned of ["cdp_url", "cdpUrl", "x", "y", "fx", "fy", "point", "png_base64", "frame_path", "viewport_css_width"]) {
      expect(keys).not.toContain(banned);
    }
    expect(JSON.stringify(u)).not.toContain(CDP);
    expect(u.raw_surface_revealed_to_agent).toBe(false);
  });
});

describe("advanceReleaseReady — pure full-bar streak machine", () => {
  const band = { y_center: 0.7, x0: 0.1, x1: 0.9 };
  const full = { found: true, fill_ratio: 0.95, band };
  const partial = { found: true, fill_ratio: 0.5, band };
  const notFound = { found: false };

  it("threshold is 2 and FULL_RATIO_THRESHOLD is 0.92", () => {
    expect(VGC_RELEASE_READY_CONSECUTIVE).toBe(2);
    expect(FULL_RATIO_THRESHOLD).toBe(0.92);
  });

  it("a single full frame does NOT fire", () => {
    const a = advanceReleaseReady(0, undefined, full);
    expect(a).toEqual({ consecutiveFull: 1, lastBand: band, fire: false });
  });

  it("two consecutive overlapping full frames fire", () => {
    const a1 = advanceReleaseReady(0, undefined, full);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, full);
    expect(a2.fire).toBe(true);
    expect(a2.consecutiveFull).toBe(2);
  });

  it("a below-threshold (filling) frame resets the streak but keeps the band reference", () => {
    expect(advanceReleaseReady(1, band, partial)).toEqual({ consecutiveFull: 0, lastBand: band, fire: false });
  });

  it("a band jump between full frames resets the streak (no fire)", () => {
    const moved = { found: true, fill_ratio: 0.95, band: { y_center: 0.2, x0: 0.1, x1: 0.9 } };
    const a = advanceReleaseReady(1, band, moved);
    expect(a.fire).toBe(false);
    expect(a.consecutiveFull).toBe(1);
  });

  it("a not-found frame resets the streak and clears the reference", () => {
    expect(advanceReleaseReady(1, band, notFound)).toEqual({ consecutiveFull: 0, lastBand: undefined, fire: false });
  });
});

describe("visualHandoffMonitor — release_ready (full-bar) sub-state", () => {
  const FULL = { found: true as const, fill_ratio: 0.95, band: { y_center: 0.7, x0: 0.1, x1: 0.9 } };

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED = "true";
    process.env.ANTIGEN_HV_VISUAL_HANDOFF = "true";
    process.env.ANTIGEN_HV_RELEASE_READY = "true";
    vi.useFakeTimers();
    clearVisualHandoffMonitorsForTests();
    clearVisualGestureCapsulesForTests();
    clearHvHandoffUpdatesForTests();
    clearVgcHoldSessionsForTests();
  });
  afterEach(() => {
    clearVisualHandoffMonitorsForTests();
    clearVgcHoldSessionsForTests();
    vi.useRealTimers();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
    delete process.env.ANTIGEN_HV_VISUAL_HANDOFF;
    delete process.env.ANTIGEN_HV_RELEASE_READY;
  });

  function rrDeps(
    model: ReturnType<typeof makeModel>,
    probe: VisualHandoffMonitorDeps["releaseReadyProbe"],
    holdActive: boolean,
  ): VisualHandoffMonitorDeps {
    return {
      classifyModel: model.fn,
      resolveCdpUrl: () => CDP,
      intervalMs: 500,
      releaseReadyProbe: probe,
      activeHoldProbe: () => holdActive,
      releaseProbeIntervalMs: 0, // probe every still_active tick (deterministic)
    };
  }

  it("wall_present + active hold + 2 stable full frames → release_ready (agent still waits)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500); // ≥2 still_active ticks → 2 full reads
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("release_ready");
    expect(u?.agent_should_wait).toBe(true);
    expect(u?.requires_user_attention).toBe(true);
    // Non-terminal: the capsule is NOT cleared and the loop keeps running.
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(true);
  });

  it("a single full frame does not fire (stays still_active)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(500); // exactly one tick → one full read
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
  });

  it("full bar but NO active hold → never probes, stays still_active", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, false));
    await vi.advanceTimersByTimeAsync(1500);
    expect(probe).not.toHaveBeenCalled();
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
  });

  it("a not-found probe keeps still_active (fail closed)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => ({ found: false as const }));
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
  });

  it("sticky: release_ready stays put across later wall_present ticks while the hold is active", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]); // always a wall
    // Fire release_ready (2 stable full frames), then the probe stops finding a full bar.
    let calls = 0;
    const probe = vi.fn(async () => (++calls <= 2 ? FULL : ({ found: false as const })));
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1000); // 2 ticks → 2 full reads → release_ready
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("release_ready");
    // Subsequent wall_present ticks: probe no longer fires, but the hold is still active →
    // sticky keeps release_ready (no still_active downgrade).
    await vi.advanceTimersByTimeAsync(1000); // 2 more ticks, probe returns found:false
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("release_ready");
    expect(u?.agent_should_wait).toBe(true);
    expect(u?.requires_user_attention).toBe(true);
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(true);
  });

  it("sticky survives another publisher clobbering the ring to still_active mid-hold", async () => {
    // Live regression: after release_ready, the hold's in-hold model advisory publishes
    // still_active into the SAME handoff ring (clobbering its latest) while the hold is still
    // live (no hold_ended). The monitor must keep release_ready — its sticky memory is private,
    // not read back from the ring.
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]); // always a wall
    let calls = 0;
    // Probe fires 2 stable full frames → release_ready, then the crop no longer reads a full bar
    // (e.g. crop switched off the hold anchor) → found:false, so only the sticky pin can hold it.
    const probe = vi.fn(async () => (++calls <= 2 ? FULL : ({ found: false as const })));
    let holdLive = true;
    startVisualHandoffMonitor(
      { capsuleId: c.capsule_id, cdpUrl: CDP },
      { ...rrDeps(m, probe, true), activeHoldProbe: () => holdLive },
    );
    await vi.advanceTimersByTimeAsync(1000); // 2 ticks → release_ready
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("release_ready");

    // Another publisher (the hold's in-hold advisory) clobbers the ring to still_active.
    publishHvHandoffUpdate({
      browser_session_id: BASE.browser_session_id,
      source: "visual_gesture_capsule",
      phase: "still_active",
    });
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");

    // Next wall_present ticks: probe returns found:false, but the hold is still live (no
    // hold_ended) → the monitor re-pins release_ready (the old ring-read guard downgraded here).
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("release_ready");

    // Durable hold ends (hold_ended) → sticky lifts → still_active is allowed again.
    holdLive = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
  });

  it("after the hold ends, a wall_present tick returns to still_active (sticky lifts)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    let calls = 0;
    const probe = vi.fn(async () => (++calls <= 2 ? FULL : ({ found: false as const })));
    let holdLive = true;
    startVisualHandoffMonitor(
      { capsuleId: c.capsule_id, cdpUrl: CDP },
      { ...rrDeps(m, probe, true), activeHoldProbe: () => holdLive },
    );
    await vi.advanceTimersByTimeAsync(1000); // → release_ready while holding
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("release_ready");
    holdLive = false; // user released the hold
    await vi.advanceTimersByTimeAsync(500); // next wall_present tick: no active hold → no sticky
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
  });

  it("looks_clear wins: a stable clear completes even after a release_ready", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present"), r("wall_present"), r("looks_clear"), r("looks_clear")]);
    const probe = vi.fn(async () => FULL);
    const release = vi.fn();
    startVisualHandoffMonitor(
      { capsuleId: c.capsule_id, cdpUrl: CDP },
      { ...rrDeps(m, probe, true), releaseHold: release },
    );
    await vi.advanceTimersByTimeAsync(2500);
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("completed");
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("cleared");
    expect(release).toHaveBeenCalledWith(c.capsule_id);
  });

  it("wall gone (no wall_present tick) → completed via clear path, probe never runs", async () => {
    const c = seedCapsule();
    const m = makeModel([r("looks_clear"), r("looks_clear")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("completed");
    expect(probe).not.toHaveBeenCalled();
  });

  it("flag OFF → byte-identical still_active; the probe is never invoked", async () => {
    delete process.env.ANTIGEN_HV_RELEASE_READY;
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(probe).not.toHaveBeenCalled();
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
  });

  it("a release_ready update carries only safe fields (no coords / bytes / ratio)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500);
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id)!;
    expect(u.phase).toBe("release_ready");
    for (const banned of ["fill_ratio", "band", "x0", "x1", "y_center", "png_base64", "cdp_url", "point"]) {
      expect(Object.keys(u)).not.toContain(banned);
    }
    expect(JSON.stringify(u)).not.toContain(CDP);
    expect(u.raw_surface_revealed_to_agent).toBe(false);
  });

  // ── uncertain verdict during an active hold (the live B&BW conservative-ambiguous
  //    case): the model stays `uncertain` while the wall is visibly present, so the
  //    detector must run here too — not only on `wall_present`. ───────────────────────
  it("uncertain + active hold + 2 stable full frames → release_ready (non-terminal)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("uncertain")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500); // ≥2 uncertain ticks → 2 full reads
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("release_ready");
    expect(u?.agent_should_wait).toBe(true);
    expect(u?.requires_user_attention).toBe(true);
    // Strictly non-terminal: NOT cleared, loop still running.
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(true);
  });

  it("uncertain + active hold + no reliable bar → no release_ready (keeps waiting)", async () => {
    const c = seedCapsule();
    const m = makeModel([r("uncertain")]);
    const probe = vi.fn(async () => ({ found: false as const }));
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(probe).toHaveBeenCalled(); // it DID run on uncertain…
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).not.toBe("release_ready"); // …but never published a nudge
    expect(u?.phase).not.toBe("completed");
  });

  it("wall_present then uncertain (same full band) shares the streak and fires on the 2nd frame", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present"), r("uncertain")]);
    const probe = vi.fn(async () => FULL); // same band both reads → overlap stable
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(500); // tick 1: wall_present → full streak 1, still_active
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
    await vi.advanceTimersByTimeAsync(500); // tick 2: uncertain → full streak 2 → release_ready
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("release_ready");
  });

  it("uncertain + active hold + full bar but NO active hold → never probes", async () => {
    const c = seedCapsule();
    const m = makeModel([r("uncertain")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, false));
    await vi.advanceTimersByTimeAsync(1500);
    expect(probe).not.toHaveBeenCalled();
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).not.toBe("release_ready");
  });

  it("looks_clear + full bar → completion path wins; the probe never runs", async () => {
    const c = seedCapsule();
    const m = makeModel([r("looks_clear"), r("looks_clear")]);
    const probe = vi.fn(async () => FULL);
    const release = vi.fn();
    startVisualHandoffMonitor(
      { capsuleId: c.capsule_id, cdpUrl: CDP },
      { ...rrDeps(m, probe, true), releaseHold: release },
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(probe).not.toHaveBeenCalled(); // verdict gate: looks_clear never probes
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("completed");
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("cleared");
    expect(release).toHaveBeenCalledWith(c.capsule_id);
  });

  it("flag OFF + uncertain → byte-identical: probe never runs, no release_ready", async () => {
    delete process.env.ANTIGEN_HV_RELEASE_READY;
    const c = seedCapsule();
    const m = makeModel([r("uncertain")]);
    const probe = vi.fn(async () => FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(probe).not.toHaveBeenCalled();
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).not.toBe("release_ready");
  });

  // ── Whole-crop active-hold fallback shape (the temporal "Release now" read) ─────
  // The fallback returns a full estimate carrying the CONSTANT WHOLE_CROP_BAND. It must
  // flow through the unchanged streak machine exactly like a bar/ring read: fire
  // `release_ready` (non-terminal) after 2 stable frames, and never probe with no hold.
  const WHOLE_CROP_FULL = { found: true as const, fill_ratio: 1, band: WHOLE_CROP_BAND };

  it("no active hold → never probes (whole-crop fallback unreachable), stays still_active", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => WHOLE_CROP_FULL);
    startVisualHandoffMonitor({ capsuleId: c.capsule_id, cdpUrl: CDP }, rrDeps(m, probe, false));
    await vi.advanceTimersByTimeAsync(1500);
    // skip_no_active_hold short-circuits before any capture/detect/fallback.
    expect(probe).not.toHaveBeenCalled();
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).toBe("still_active");
  });

  it("whole-crop full (2 stable frames) → release_ready, agent still waits, NOT completed", async () => {
    const c = seedCapsule();
    const m = makeModel([r("wall_present")]);
    const probe = vi.fn(async () => WHOLE_CROP_FULL);
    const release = vi.fn();
    startVisualHandoffMonitor(
      { capsuleId: c.capsule_id, cdpUrl: CDP },
      { ...rrDeps(m, probe, true), releaseHold: release },
    );
    await vi.advanceTimersByTimeAsync(1500); // ≥2 still_active ticks → 2 full reads
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("release_ready");
    expect(u?.agent_should_wait).toBe(true);
    expect(u?.requires_user_attention).toBe(true);
    // Strictly non-terminal: the firing never completes, clears, or releases the hold.
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    expect(release).not.toHaveBeenCalled();
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(true);
  });
});

describe("recheckVisualGestureCapsule — DOM false-absent cannot complete under flag", () => {
  const absentProbe = async () => ({
    ok: true as const,
    presence: "absent" as const,
    hv_present: false,
    geo_present: false,
    geo_strength: "none" as const,
  });

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED = "true";
    clearVisualGestureCapsulesForTests();
    clearHvHandoffUpdatesForTests();
  });
  afterEach(() => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
    delete process.env.ANTIGEN_HV_VISUAL_HANDOFF;
  });

  it("flag ON: a DOM 'absent' is demoted to unknown — capsule is NOT cleared", async () => {
    process.env.ANTIGEN_HV_VISUAL_HANDOFF = "true";
    const c = seedCapsule();
    transitionVisualGestureCapsule(c.capsule_id, "checking");
    const res = await recheckVisualGestureCapsule({
      capsuleId: c.capsule_id,
      cdpUrl: CDP,
      probe: absentProbe,
      settleMs: 0,
      retrySettleMs: 0,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("unknown");
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    expect(getLatestHvHandoffUpdate(BASE.browser_session_id)?.phase).not.toBe("completed");
  });

  it("flag OFF: byte-identical — a DOM 'absent' still clears the capsule", async () => {
    delete process.env.ANTIGEN_HV_VISUAL_HANDOFF;
    const c = seedCapsule();
    transitionVisualGestureCapsule(c.capsule_id, "checking");
    const res = await recheckVisualGestureCapsule({
      capsuleId: c.capsule_id,
      cdpUrl: CDP,
      probe: absentProbe,
      settleMs: 0,
      retrySettleMs: 0,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("cleared");
    expect(getVisualGestureCapsule(c.capsule_id)?.status).toBe("cleared");
  });
});

describe("startVgcHoldSession — visual model gates the press", () => {
  function makeRecordingClient() {
    const order: string[] = [];
    const client = {
      send() {},
      async call(method: string, params: Record<string, unknown>) {
        if (method === "Input.dispatchMouseEvent") order.push(String(params.type));
        return {};
      },
      async evaluate() {
        return {};
      },
      close() {
        order.push("close");
      },
    };
    return { client, order };
  }

  function holdDeps(model: VgcHoldModelResult): { deps: VgcHoldDeps; order: string[] } {
    const { client, order } = makeRecordingClient();
    const deps: VgcHoldDeps = {
      openCdpClient: (async () => ({ ok: true, client, target: { id: "T" } })) as unknown as VgcHoldDeps["openCdpClient"],
      readLiveViewport: async () => ({ width: VW, height: VH }),
      classifyModel: async () => model,
    };
    return { deps, order };
  }

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED = "true";
    process.env.ANTIGEN_HV_VISUAL_HANDOFF = "true";
    clearVisualHandoffMonitorsForTests();
    clearVisualGestureCapsulesForTests();
    clearHvHandoffUpdatesForTests();
    clearVgcHoldSessionsForTests();
  });
  afterEach(() => {
    clearVisualHandoffMonitorsForTests();
    clearVgcHoldSessionsForTests();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
    delete process.env.ANTIGEN_HV_VISUAL_HANDOFF;
  });

  it("wall_present → relays the user press (status holding, monitor running)", async () => {
    const c = seedCapsule();
    const { deps, order } = holdDeps(r("wall_present"));
    const res = await startVgcHoldSession({ capsuleId: c.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: true, hold_state: "holding" });
    expect(order).toContain("mousePressed");
    expect(hasActiveVisualHandoffMonitor(c.capsule_id)).toBe(true);
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("still_active");
    expect(u?.agent_should_wait).toBe(true);
  });

  it("confidently clear → does NOT press; returns deferred_clear (no challenge_gone complete)", async () => {
    const c = seedCapsule();
    const { deps, order } = holdDeps(r("looks_clear"));
    const res = await startVgcHoldSession({ capsuleId: c.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: true, hold_state: "deferred_clear" });
    expect(order).not.toContain("mousePressed");
    // The capsule is NOT completed from the gate — completion needs a stable clear.
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
    const u = getLatestHvHandoffUpdate(BASE.browser_session_id);
    expect(u?.phase).toBe("looks_complete_checking");
    expect(u?.agent_should_wait).toBe(true);
  });

  it("uncertain → proceeds with the user press (never completes from the gate)", async () => {
    const c = seedCapsule();
    const { deps, order } = holdDeps(UNAVAILABLE);
    const res = await startVgcHoldSession({ capsuleId: c.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: true, hold_state: "holding" });
    expect(order).toContain("mousePressed");
    expect(getVisualGestureCapsule(c.capsule_id)?.status).not.toBe("cleared");
  });
});

// ─── Release-ready crop selection (hold-anchor first) ─────────────────────────
//
// The live B&BW bug: the dominant blocking surface ≈ the whole viewport, so the
// single-shot validate rejected it as box_too_large and the detector was handed
// nothing → found:false forever. The fix prioritizes a tight crop, and the user's
// live HOLD ANCHOR is the strongest signal for where the press/hold control is.

/** A dominant surface that covers ~the whole viewport → rejected box_too_large. */
const OVERSIZED_DOMINANT = { box: { x: 0, y: 0, w: VW, h: VH }, viewport: { vw: VW, vh: VH } };
/** A valid, tight dominant surface (centered card). */
const TIGHT_DOMINANT = { box: { x: 480, y: 280, w: 320, h: 220 }, viewport: { vw: VW, vh: VH } };
/** A DOM inner-control box found inside the dominant surface. */
const INNER_CONTROL = { box: { x: 540, y: 340, w: 200, h: 120 }, viewport: { vw: VW, vh: VH } };
/** A live hold anchor at the viewport center. */
const HOLD_ANCHOR = { point: { x: VW / 2, y: VH / 2 }, viewport: { vw: VW, vh: VH } };

describe("selectReleaseReadyCrop — crop priority (hold-anchor first)", () => {
  it("dominant box_too_large + hold anchor → selects hold_anchor", () => {
    const { selection, dominantReason } = selectReleaseReadyCrop(OVERSIZED_DOMINANT, {
      holdAnchor: HOLD_ANCHOR,
    });
    expect(dominantReason).toBe("box_too_large");
    expect(selection).not.toBeNull();
    expect(selection?.source).toBe("hold_anchor");
  });

  it("dominant box_too_large + BOTH hold anchor and inner control → still hold_anchor (anchor wins)", () => {
    const { selection } = selectReleaseReadyCrop(OVERSIZED_DOMINANT, {
      holdAnchor: HOLD_ANCHOR,
      innerControl: INNER_CONTROL,
    });
    expect(selection?.source).toBe("hold_anchor");
  });

  it("dominant box_too_large + no hold anchor + inner control → selects inner_control", () => {
    const { selection } = selectReleaseReadyCrop(OVERSIZED_DOMINANT, {
      innerControl: INNER_CONTROL,
    });
    expect(selection?.source).toBe("inner_control");
  });

  it("dominant box_too_large + no hold anchor + no inner control → selects center_region", () => {
    const { selection } = selectReleaseReadyCrop(OVERSIZED_DOMINANT, {});
    expect(selection?.source).toBe("center_region");
    // The geometric fallback is a sub-region of the dominant box, never the full surface.
    expect(selection?.size_bucket).not.toBe("oversized");
  });

  it("valid (tight) dominant → selects dominant_surface (today's path, unchanged)", () => {
    const { selection, dominantReason } = selectReleaseReadyCrop(TIGHT_DOMINANT, {
      holdAnchor: HOLD_ANCHOR,
    });
    expect(dominantReason).toBe("ok");
    expect(selection?.source).toBe("dominant_surface");
  });

  it("dominant rejected for a NON-size reason (invalid geometry) → returns null (no fabricated crop)", () => {
    const bad = { box: { x: 10, y: 10, w: 0, h: 5 }, viewport: { vw: VW, vh: VH } };
    const { selection, dominantReason } = selectReleaseReadyCrop(bad, { holdAnchor: HOLD_ANCHOR });
    expect(dominantReason).toBe("invalid_dimensions");
    expect(selection).toBeNull();
  });

  it("the regression: oversized dominant must NOT yield null SOLELY because the outer box is too large", () => {
    // With ANY tighter candidate available (anchor here), a crop is produced.
    const { selection } = selectReleaseReadyCrop(OVERSIZED_DOMINANT, { holdAnchor: HOLD_ANCHOR });
    expect(selection).not.toBeNull();
  });

  it("the selection exposes ONLY safe enums (no raw coords leak beyond the rect itself)", () => {
    const { selection } = selectReleaseReadyCrop(OVERSIZED_DOMINANT, { holdAnchor: HOLD_ANCHOR });
    expect(selection).not.toBeNull();
    const sources = ["dominant_surface", "hold_anchor", "inner_control", "center_region"];
    expect(sources).toContain(selection!.source);
    expect(typeof selection!.size_bucket).toBe("string");
    // The chosen rect stays inside the viewport it is expressed in.
    expect(selection!.rect.x).toBeGreaterThanOrEqual(0);
    expect(selection!.rect.y).toBeGreaterThanOrEqual(0);
    expect(selection!.rect.x + selection!.rect.w).toBeLessThanOrEqual(selection!.viewport.vw);
    expect(selection!.rect.y + selection!.rect.h).toBeLessThanOrEqual(selection!.viewport.vh);
  });
});

describe("cropCandidateCountBucket — safe count buckets", () => {
  it("buckets counts into 0 / 1 / 2_4 / 5_plus", () => {
    expect(cropCandidateCountBucket(0)).toBe("0");
    expect(cropCandidateCountBucket(-3)).toBe("0");
    expect(cropCandidateCountBucket(1)).toBe("1");
    expect(cropCandidateCountBucket(4)).toBe("2_4");
    expect(cropCandidateCountBucket(5)).toBe("5_plus");
    expect(cropCandidateCountBucket(NaN)).toBe("0");
  });
});

describe("hold-anchor crop maps correctly under an upscaled (HiDPI) screenshot", () => {
  function solidWhitePng(w: number, h: number): string {
    const png = new PngImage({ width: w, height: h });
    png.data.fill(255);
    return PngImage.sync.write(png).toString("base64");
  }

  it("a CSS-px hold-anchor rect crops the 2x-scaled region (coordinate spaces match)", () => {
    // The hold point is in CSS viewport px; the screenshot is captured at 2x (upscaled).
    const { selection } = selectReleaseReadyCrop(OVERSIZED_DOMINANT, { holdAnchor: HOLD_ANCHOR });
    expect(selection?.source).toBe("hold_anchor");
    const rect = selection!.rect;
    const vp = selection!.viewport;
    // Screenshot at deviceScaleFactor 2 → image is 2x the CSS viewport on each axis.
    const upscaled = solidWhitePng(vp.vw * 2, vp.vh * 2);
    const croppedB64 = cropPng(upscaled, rect, vp);
    const cropped = PngImage.sync.read(Buffer.from(croppedB64, "base64"));
    // cropPng scales the CSS rect by image/viewport ratio (=2): dims double, ±1 rounding.
    expect(Math.abs(cropped.width - rect.w * 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(cropped.height - rect.h * 2)).toBeLessThanOrEqual(2);
    // And it stays well under the full upscaled frame (a real sub-crop, not the whole modal).
    expect(cropped.width).toBeLessThan(vp.vw * 2);
    expect(cropped.height).toBeLessThan(vp.vh * 2);
  });

  it("holdAnchorCropBox centers on the press point and stays inside the viewport", () => {
    const box = holdAnchorCropBox({ x: VW / 2, y: VH / 2 }, { vw: VW, vh: VH });
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(VW);
    expect(box.y + box.h).toBeLessThanOrEqual(VH);
    // Centered on the point (within rounding).
    expect(Math.abs(box.x + box.w / 2 - VW / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.h / 2 - VH / 2)).toBeLessThanOrEqual(1);
  });
});
