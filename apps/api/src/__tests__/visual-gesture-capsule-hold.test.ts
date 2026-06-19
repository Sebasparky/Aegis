/**
 * Visual Gesture Capsule — LIVE guided press-and-hold unit suite (always-run, no
 * Chromium). Exercises the real visualGestureCapsuleHold.ts state machine through
 * its dependency-injection seam (a recording CDP client, a fake live-viewport
 * reader, a fake in-hold presence probe, and the real recheck helper driven by an
 * injected probe). Pins the product contract:
 *
 *   1. hold-start presses (mouseMoved → mousePressed) and holds — NO release yet.
 *   2. A wall already gone at start → challenge_gone, NO press, capsule cleared.
 *   3. A short release under the min threshold → too_short: no recheck, NO attempt
 *      burned, and the mouse is still released promptly.
 *   4. A user release dispatches mouseReleased promptly and runs the definitive
 *      recheck (no recorded duration is ever replayed).
 *   5. A 3s+ live hold logs the coarse "3s+" duration bucket (telemetry only).
 *   6. An in-hold cleared detection releases + marks cleared mid-hold.
 *   7. Heartbeat silence (fail-closed) releases the mouse.
 *   8. The max-duration ceiling releases the mouse; a still-present recheck burns
 *      attempts toward manual_fallback.
 *   9. No provider name / timing is hardcoded in the module.
 *  10. No result leaks fx/fy, mapped coords, dims, or cdp_url.
 *
 * The real-Chromium end-to-end proof lives in the gated real-session suite.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  startVgcHoldSession,
  heartbeatVgcHoldSession,
  endVgcHoldSession,
  cancelVgcHoldSession,
  hasLiveVgcHoldSession,
  clearVgcHoldSessionsForTests,
  probeHoldPresenceOnClient,
  VGC_HOLD_MAX_DURATION_MS,
  type VgcHoldPresence,
  type VgcHoldDeps,
} from "../runtime/visualGestureCapsuleHold.js";
import { recheckVisualGestureCapsule } from "../runtime/visualGestureCapsuleRecheck.js";
import {
  createVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  getVisualGestureCapsule,
  isTerminalVisualGestureStatus,
  clearVisualGestureCapsulesForTests,
  MAX_GESTURE_ATTEMPTS,
} from "../runtime/visualGestureCapsule.js";

const BASE = {
  human_verification_request_id: "hvr_hold_001",
  browser_session_id: "tbs_hold_001",
  domain: "example.com",
  page_url: "https://example.com/wall",
};
const PNG = "iVBORw0KGgoREDACTED==";
const VW = 1280;
const VH = 800;
const CDP = "http://localhost:9222";

function seedWithFrame() {
  const capsule = createVisualGestureCapsule(BASE);
  const stored = storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
    png_base64: PNG,
    viewport_css_width: VW,
    viewport_css_height: VH,
  });
  expect(stored.ok).toBe(true);
  return capsule;
}

/** A recording CDP page client: logs each dispatched mouse type + close(). */
function makeRecordingClient() {
  const order: string[] = [];
  const client = {
    send() {
      /* unused — the hold path uses call() */
    },
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

const matchingViewport = async () => ({ width: VW, height: VH });

/** Build a deps bundle: a fresh recording client + a sequenced in-hold probe. */
function makeDeps(opts: {
  presences?: VgcHoldPresence[]; // sequential probeOnClient verdicts (last repeats)
  readLiveViewport?: VgcHoldDeps["readLiveViewport"];
  recheck?: VgcHoldDeps["recheck"];
}): { deps: VgcHoldDeps; order: string[]; probeCalls: () => number } {
  const { client, order } = makeRecordingClient();
  const presences = opts.presences ?? ["present"];
  let i = 0;
  const probeOnClient = vi.fn(async () => {
    const v = presences[Math.min(i, presences.length - 1)];
    i += 1;
    return v;
  });
  const deps: VgcHoldDeps = {
    openCdpClient: (async () => ({ ok: true, client, target: { id: "T" } })) as unknown as VgcHoldDeps["openCdpClient"],
    readLiveViewport: opts.readLiveViewport ?? matchingViewport,
    probeOnClient,
    ...(opts.recheck ? { recheck: opts.recheck } : {}),
  };
  return { deps, order, probeCalls: () => probeOnClient.mock.calls.length };
}

/**
 * A recheck that runs the REAL capsule transitions against a fixed probe verdict.
 * Settle delays are disabled here (these tests run under fake timers and exercise
 * the hold mechanics, not the recheck settle — that is covered in the recheck suite).
 */
function recheckWithVerdict(presence: "present" | "absent" | "unknown"): VgcHoldDeps["recheck"] {
  return (args) =>
    recheckVisualGestureCapsule({
      ...args,
      settleMs: 0,
      retrySettleMs: 0,
      probe: async () => ({ ok: true, presence }),
    });
}

beforeEach(() => {
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
  vi.useFakeTimers();
});

afterEach(() => {
  clearVgcHoldSessionsForTests();
  clearVisualGestureCapsulesForTests();
  vi.useRealTimers();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  delete process.env.ANTIGEN_HV_DEBUG;
  vi.restoreAllMocks();
});

// ─── 1. start presses and holds (no release yet) ─────────────────────────────────

describe("startVgcHoldSession", () => {
  it("presses mouseMoved → mousePressed and reports holding — no release yet", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({ presences: ["present"] });
    const res = await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: true, hold_state: "holding" });
    expect(order).toEqual(["mouseMoved", "mousePressed"]);
    expect(hasLiveVgcHoldSession(capsule.capsule_id)).toBe(true);
  });

  it("flag off → flag_disabled, nothing opened or pressed", async () => {
    const capsule = seedWithFrame();
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    const { deps, order } = makeDeps({});
    const res = await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: false, reason: "flag_disabled" });
    expect(order).toEqual([]);
  });

  it("wall already gone at start → challenge_gone, NO press, capsule cleared", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({ presences: ["absent"] });
    const res = await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: true, hold_state: "challenge_gone" });
    expect(order).not.toContain("mousePressed");
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("cleared");
    expect(hasLiveVgcHoldSession(capsule.capsule_id)).toBe(false);
  });

  it("stale frame at start → viewport_drifted, NO press", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({ presences: ["present"], readLiveViewport: async () => null });
    const res = await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: false, reason: "viewport_drifted" });
    expect(order).not.toContain("mousePressed");
  });

  it("out-of-range point → invalid_coordinates, NO press", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({});
    const res = await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 1.5, fy: 0.5, deps });
    expect(res).toEqual({ ok: false, reason: "invalid_coordinates" });
    expect(order).toEqual([]);
  });
});

// ─── 3/4. release: too-short vs sufficient ───────────────────────────────────────

describe("endVgcHoldSession release behavior", () => {
  it("short release under the min threshold → too_short: no recheck, no attempt burned, mouse released", async () => {
    const capsule = seedWithFrame();
    const recheck = vi.fn();
    const { deps, order } = makeDeps({ presences: ["present"], recheck: recheck as unknown as VgcHoldDeps["recheck"] });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });

    // Release immediately — held ≈ 0ms (< 300ms threshold).
    const end = await endVgcHoldSession(capsule.capsule_id);
    expect(end).toEqual({ ok: true, hold_state: "too_short" });
    expect(recheck).not.toHaveBeenCalled();
    expect(order).toContain("mouseReleased");
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.attempt_count).toBe(0);
    expect(after?.status).toBe("awaiting_user_gesture");
    expect(hasLiveVgcHoldSession(capsule.capsule_id)).toBe(false);
  });

  it("sufficient hold + cleared recheck → cleared; mouseReleased dispatched promptly", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({ presences: ["present"], recheck: recheckWithVerdict("absent") });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });

    // Advance only the wall clock (no timers fire) so the hold reads ≥ min.
    vi.setSystemTime(new Date(Date.now() + 3100));
    const end = await endVgcHoldSession(capsule.capsule_id);
    expect(end).toEqual({ ok: true, hold_state: "cleared" });
    expect(order).toContain("mouseReleased");
    // No replay after release: exactly one press, and it precedes the release —
    // the recorded-duration replay path (single-shot relay) is never taken here.
    expect(order.filter((o) => o === "mousePressed")).toHaveLength(1);
    expect(order.lastIndexOf("mousePressed")).toBeLessThan(order.indexOf("mouseReleased"));
    expect(order.lastIndexOf("mousePressed")).toBeGreaterThan(-1);
    expect(isTerminalVisualGestureStatus(getVisualGestureCapsule(capsule.capsule_id)!.status)).toBe(true);
  });

  it("a 3s+ hold logs the coarse '3s+' duration bucket (telemetry only)", async () => {
    process.env.ANTIGEN_HV_DEBUG = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const capsule = seedWithFrame();
    const { deps } = makeDeps({ presences: ["present"], recheck: recheckWithVerdict("present") });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });

    vi.setSystemTime(new Date(Date.now() + 3100));
    const end = await endVgcHoldSession(capsule.capsule_id);
    expect(end.hold_state).toBe("still_present");
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("hold_duration_bucket=3s+"))).toBe(true);
  });
});

// ─── 6. in-hold cleared detection ────────────────────────────────────────────────

describe("in-hold cleared detection", () => {
  it("a mid-hold absent probe releases + marks the capsule cleared; heartbeat then reports cleared", async () => {
    const capsule = seedWithFrame();
    // pre-start probe → present (so it presses); first in-hold probe → absent.
    const { deps, order } = makeDeps({ presences: ["present", "absent"] });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });

    // First in-hold probe is armed at max(min, interval) = 1000ms.
    await vi.advanceTimersByTimeAsync(1000);

    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("cleared");
    expect(order).toContain("mouseReleased");
    expect(hasLiveVgcHoldSession(capsule.capsule_id)).toBe(false);
    expect(heartbeatVgcHoldSession(capsule.capsule_id)).toEqual({ hold_state: "cleared" });
  });
});

// ─── 7. fail-closed ───────────────────────────────────────────────────────────────

describe("fail-closed heartbeat silence", () => {
  it("releases the mouse after the fail-closed window; heartbeat reports released_fail_closed", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({ presences: ["present"] });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });

    // No heartbeats → after ~1.2s the fail-closed timer releases the hold.
    await vi.advanceTimersByTimeAsync(1300);
    expect(order).toContain("mouseReleased");
    expect(hasLiveVgcHoldSession(capsule.capsule_id)).toBe(false);
    expect(heartbeatVgcHoldSession(capsule.capsule_id)).toEqual({ hold_state: "released_fail_closed" });
  });
});

// ─── 8. max-duration ceiling + manual_fallback ───────────────────────────────────

describe("max-duration ceiling", () => {
  it("releases the mouse at the ceiling even while heartbeats keep arriving", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({ presences: ["present"] });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });

    // Keep the hold alive with heartbeats up to the ceiling; the max timer (not
    // re-armed by heartbeats) fires regardless.
    for (let t = 0; t < VGC_HOLD_MAX_DURATION_MS; t += 1000) {
      heartbeatVgcHoldSession(capsule.capsule_id);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(order).toContain("mouseReleased");
    expect(hasLiveVgcHoldSession(capsule.capsule_id)).toBe(false);
  });

  it("repeated still-present hold-ends drive the capsule to manual_fallback", async () => {
    const capsule = seedWithFrame();
    for (let attempt = 0; attempt < MAX_GESTURE_ATTEMPTS; attempt++) {
      const { deps } = makeDeps({ presences: ["present"], recheck: recheckWithVerdict("present") });
      await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
      vi.setSystemTime(new Date(Date.now() + 400));
      const end = await endVgcHoldSession(capsule.capsule_id);
      expect(end.hold_state).toBe("still_present");
    }
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("manual_fallback");
    expect(after?.attempt_count).toBe(MAX_GESTURE_ATTEMPTS);
    // manual_fallback is non-terminal → the agent-side guard keeps the agent blocked.
    expect(isTerminalVisualGestureStatus(after!.status)).toBe(false);
  });
});

// ─── cancel ───────────────────────────────────────────────────────────────────────

describe("cancelVgcHoldSession", () => {
  it("releases the mouse and drops the session", async () => {
    const capsule = seedWithFrame();
    const { deps, order } = makeDeps({ presences: ["present"] });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    await cancelVgcHoldSession(capsule.capsule_id);
    expect(order).toContain("mouseReleased");
    expect(hasLiveVgcHoldSession(capsule.capsule_id)).toBe(false);
  });
});

// ─── 9/10. no provider logic, no geometry leak ───────────────────────────────────

describe("safety invariants", () => {
  it("hardcodes no provider name or timing brand in the module source", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../runtime/visualGestureCapsuleHold.ts", import.meta.url)),
      "utf8",
    ).toLowerCase();
    for (const banned of ["perimeterx", "hcaptcha", "recaptcha", "datadome", "cloudflare", "akamai", "kasada", "funcaptcha"]) {
      expect(src).not.toContain(banned);
    }
  });

  it("no hold result leaks fx/fy, mapped coords, dims, or cdp_url", async () => {
    const capsule = seedWithFrame();
    const { deps } = makeDeps({ presences: ["present"], recheck: recheckWithVerdict("present") });
    const start = await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    const beat = heartbeatVgcHoldSession(capsule.capsule_id);
    vi.setSystemTime(new Date(Date.now() + 400));
    const end = await endVgcHoldSession(capsule.capsule_id);
    const raw = JSON.stringify({ start, beat, end });
    for (const banned of ["cssX", "cssY", '"fx"', '"fy"', "1280", "800", "640", "400", "localhost:9222", "cdp_url", "point"]) {
      expect(raw).not.toContain(banned);
    }
  });
});

describe("probeHoldPresenceOnClient (in-hold / pre-press clear discipline)", () => {
  // The function runs the HV probe first, then the geometry probe, on a single
  // already-open client. This fake replays the HV verdict on the first evaluate
  // and the geometry verdict on the second (or throws to simulate a geo failure).
  function probeClient(hv: unknown, geo: unknown | "throw") {
    let call = 0;
    return {
      async evaluate() {
        const idx = call++;
        if (idx === 0) return hv;
        if (geo === "throw") throw new Error("geometry probe boom");
        return geo;
      },
    };
  }
  const NO_OBSTRUCTION = {
    denial_text_seen: false,
    viewport_scrim_seen: false,
    large_centered_overlay_seen: false,
    visible_inaccessible_iframe_seen: false,
    near_zero_interactive: false,
    pointer_interceptor_seen: false,
  };

  it("CONFIDENT healthy reading (HV absent + no obstruction) → absent (release/clear)", async () => {
    const res = await probeHoldPresenceOnClient(probeClient({ present: false }, NO_OBSTRUCTION));
    expect(res).toBe("absent");
  });

  it("lone pointer interceptor (weak) → unknown (keep holding, never auto-clears)", async () => {
    const res = await probeHoldPresenceOnClient(
      probeClient({ present: false }, { ...NO_OBSTRUCTION, pointer_interceptor_seen: true }),
    );
    expect(res).toBe("unknown");
  });

  it("HV absent but geometry probe failed → unknown (a half-read never clears)", async () => {
    const res = await probeHoldPresenceOnClient(probeClient({ present: false }, "throw"));
    expect(res).toBe("unknown");
  });

  it("structural HV present → present (keep holding)", async () => {
    const res = await probeHoldPresenceOnClient(probeClient({ present: true }, NO_OBSTRUCTION));
    expect(res).toBe("present");
  });

  it("strong geometry obstruction → present (keep holding)", async () => {
    const res = await probeHoldPresenceOnClient(
      probeClient({ present: false }, { ...NO_OBSTRUCTION, large_centered_overlay_seen: true }),
    );
    expect(res).toBe("present");
  });
});
