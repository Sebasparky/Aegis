/**
 * Visual Gesture Capsule — gesture-relay HARDENING unit suite (always-run, no
 * Chromium). Guards the exact production bug that left live press-and-hold walls
 * stuck at manual_fallback:
 *
 *   The old relay dispatched pointer events via fire-and-forget `client.send()`
 *   and then immediately `client.close()`d the WebSocket, so the final
 *   `mouseReleased` could be dropped before Chromium ingested it — no pointerup,
 *   wall never cleared, attempts exhausted, manual_fallback.
 *
 * These tests pin the fixed contract with injected fakes (a recording CDP client,
 * a fake live-viewport reader, a fake pointer relay, a fake presence probe):
 *   1. dispatch order is mouseMoved → mousePressed → (hold) → mouseReleased
 *   2. mouseReleased is AWAITED; the default relay closes ONLY after it resolves
 *   3. press_hold holds for ~durationMs; tap uses the short dwell
 *   4. fail-closed: the button is never left stuck down
 *   5. viewport-drift / unreadable-viewport → viewport_drifted, NO dispatch,
 *      capsule stays active, no attempt burned
 *   6. failed dispatch → pointer_dispatch_failed, capsule stays active
 *   7. recheck marks terminal `cleared` ONLY on an absent probe; present burns
 *      attempts to manual_fallback (non-terminal, agent stays blocked)
 *   8. no forbidden coords / dims / deltas leak in any result
 *
 * The real-Chromium end-to-end proof (a real press-hold actually clearing a real
 * wall) lives in the gated visual-gesture-capsule-real-session suite.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Override ONLY openCdpPageClient so the default relay can be driven against a
// recording fake client; every other humanPresenceRelay export stays real.
vi.mock("../runtime/humanPresenceRelay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/humanPresenceRelay.js")>();
  return { ...actual, openCdpPageClient: vi.fn() };
});

import { openCdpPageClient } from "../runtime/humanPresenceRelay.js";
import {
  relayVisualGestureCapsuleGesture,
  dispatchVisualGesturePointerViaClient,
  defaultVisualGesturePointerRelay,
  isViewportDrifted,
  TAP_DWELL_MS,
  type VisualGesturePointerRelay,
} from "../runtime/visualGestureCapsuleRelay.js";
import {
  recheckVisualGestureCapsule,
  type VisualGestureCapsulePresenceProbe,
} from "../runtime/visualGestureCapsuleRecheck.js";
import {
  createVisualGestureCapsule,
  getVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  listActiveVisualGestureCapsules,
  isTerminalVisualGestureStatus,
  clearVisualGestureCapsulesForTests,
  MAX_GESTURE_ATTEMPTS,
} from "../runtime/visualGestureCapsule.js";

const mockedOpen = vi.mocked(openCdpPageClient);

const BASE = {
  human_verification_request_id: "hvr_harden_001",
  browser_session_id: "tbs_harden_001",
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

const matchingViewport = async () => ({ width: VW, height: VH });

/** A recording CDP client: logs each dispatched mouse event type plus close(). */
function makeRecordingClient(opts?: {
  throwOn?: "mouseMoved" | "mousePressed" | "mouseReleased";
  deferRelease?: boolean;
}) {
  const order: string[] = [];
  let releaseGate: (() => void) | undefined;
  const client = {
    async call(method: string, params: Record<string, unknown>) {
      const type = params.type as string;
      order.push(type);
      if (opts?.throwOn === type) throw new Error(`boom-${type}`);
      if (type === "mouseReleased" && opts?.deferRelease) {
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
      }
      return {};
    },
    close() {
      order.push("close");
    },
  };
  return { client, order, openRelease: () => releaseGate?.() };
}

const recordingSleep = (log: number[]) => async (ms: number) => {
  log.push(ms);
};

interface FakeRelay extends VisualGesturePointerRelay {
  calls: number;
}
function makeFakeRelay(result: { ok: true } | { ok: false; error?: string } = { ok: true }): FakeRelay {
  const relay: FakeRelay = {
    calls: 0,
    async tapAtPoint() {
      relay.calls += 1;
      return result;
    },
    async pressHoldAtPoint() {
      relay.calls += 1;
      return result;
    },
  };
  return relay;
}

beforeEach(() => {
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
  mockedOpen.mockReset();
});

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
});

// ─── 1–4. dispatch primitive: order, awaited release, hold timing, fail-closed ──

describe("dispatchVisualGesturePointerViaClient", () => {
  it("press_hold dispatches mouseMoved → mousePressed → (hold) → mouseReleased and holds for durationMs", async () => {
    const { client, order } = makeRecordingClient();
    const sleeps: number[] = [];
    const res = await dispatchVisualGesturePointerViaClient(
      client,
      { kind: "press_hold", x: 100, y: 200, durationMs: 800 },
      recordingSleep(sleeps),
    );
    expect(res).toEqual({ ok: true });
    expect(order).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(sleeps).toEqual([800]); // the hold, between press and release
  });

  it("tap dispatches the same sequence with the short tap dwell", async () => {
    const { client, order } = makeRecordingClient();
    const sleeps: number[] = [];
    const res = await dispatchVisualGesturePointerViaClient(
      client,
      { kind: "tap", x: 5, y: 6 },
      recordingSleep(sleeps),
    );
    expect(res).toEqual({ ok: true });
    expect(order).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(sleeps).toEqual([TAP_DWELL_MS]);
  });

  it("fail-closed: a throwing hold still releases the button exactly once", async () => {
    const { client, order } = makeRecordingClient();
    const throwingSleep = async () => {
      throw new Error("hold-interrupted");
    };
    const res = await dispatchVisualGesturePointerViaClient(
      client,
      { kind: "press_hold", x: 1, y: 2, durationMs: 1000 },
      throwingSleep,
    );
    expect(res.ok).toBe(false);
    // pressed, then finally releases (never left stuck down).
    expect(order).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("fail-closed: a throwing release is retried best-effort in finally", async () => {
    const { client, order } = makeRecordingClient({ throwOn: "mouseReleased" });
    const res = await dispatchVisualGesturePointerViaClient(client, { kind: "tap", x: 1, y: 2 });
    expect(res.ok).toBe(false);
    // one release in try (threw) + one best-effort release in finally.
    expect(order.filter((o) => o === "mouseReleased")).toHaveLength(2);
  });
});

// ─── 2. default relay: close happens ONLY after the awaited mouseReleased ────────

describe("defaultVisualGesturePointerRelay close ordering", () => {
  it("closes the client only after mouseReleased — and only after it resolves", async () => {
    const { client, order, openRelease } = makeRecordingClient({ deferRelease: true });
    mockedOpen.mockResolvedValue({ ok: true, client: client as any, target: { id: "T" } as any });

    const p = defaultVisualGesturePointerRelay.pressHoldAtPoint({
      cdpUrl: CDP,
      x: 10,
      y: 20,
      durationMs: 5,
    });
    // Let the microtasks up to the deferred release settle.
    await new Promise((r) => setTimeout(r, 20));

    // Release has been dispatched but is still awaiting its ack — close MUST NOT
    // have happened yet (the old bug closed here and dropped the release).
    expect(order).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(order).not.toContain("close");

    openRelease();
    const res = await p;
    expect(res).toEqual({ ok: true });
    // Close is now last, strictly after the release ack resolved.
    expect(order).toEqual(["mouseMoved", "mousePressed", "mouseReleased", "close"]);
  });
});

// ─── 5. viewport-drift guard ─────────────────────────────────────────────────────

describe("isViewportDrifted", () => {
  it("tolerates sub-tolerance rounding, flags real scroll/resize", () => {
    expect(isViewportDrifted({ width: VW, height: VH }, { width: VW, height: VH })).toBe(false);
    expect(isViewportDrifted({ width: VW + 1, height: VH }, { width: VW, height: VH })).toBe(false);
    expect(isViewportDrifted({ width: VW, height: VH - 200 }, { width: VW, height: VH })).toBe(true);
  });
});

describe("relayVisualGestureCapsuleGesture viewport-drift guard", () => {
  it("drift beyond tolerance → viewport_drifted, NO dispatch, capsule stays active, no attempt burned", async () => {
    const capsule = seedWithFrame();
    const relay = makeFakeRelay();
    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      gesture: { kind: "press_hold", fx: 0.5, fy: 0.5, duration_ms: 800 },
      pointerRelay: relay,
      readLiveViewport: async () => ({ width: VW - 300, height: VH }),
    });
    expect(res).toEqual({ ok: false, reason: "viewport_drifted" });
    expect(relay.calls).toBe(0);
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("awaiting_user_gesture");
    expect(after?.attempt_count).toBe(0);
  });

  it("unreadable live viewport → viewport_drifted, NO dispatch", async () => {
    const capsule = seedWithFrame();
    const relay = makeFakeRelay();
    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
      readLiveViewport: async () => null,
    });
    expect(res).toEqual({ ok: false, reason: "viewport_drifted" });
    expect(relay.calls).toBe(0);
  });

  it("within tolerance → dispatch proceeds to checking", async () => {
    const capsule = seedWithFrame();
    const relay = makeFakeRelay();
    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
      readLiveViewport: async () => ({ width: VW + 1, height: VH - 1 }),
    });
    expect(res.ok).toBe(true);
    expect(relay.calls).toBe(1);
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("checking");
  });

  it("viewport_drifted result leaks no dims / coords / deltas", async () => {
    const capsule = seedWithFrame();
    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: makeFakeRelay(),
      readLiveViewport: async () => ({ width: VW - 300, height: VH }),
    });
    // The stable reason code "viewport_drifted" is allowed; the live/captured
    // SIZES, the delta, and any mapped coords/fractions must never appear.
    const raw = JSON.stringify(res);
    for (const banned of [
      "_css_width",
      "_css_height",
      "cssX",
      "cssY",
      '"fx"',
      '"fy"',
      "delta",
      "1280",
      "800",
      "980",
    ]) {
      expect(raw).not.toContain(banned);
    }
  });
});

// ─── 6. failed dispatch keeps the capsule active ─────────────────────────────────

describe("relayVisualGestureCapsuleGesture failed dispatch", () => {
  it("pointer relay failure → pointer_dispatch_failed, capsule stays active, no attempt burned", async () => {
    const capsule = seedWithFrame();
    const relay = makeFakeRelay({ ok: false, error: "cdp down" });
    const res = await relayVisualGestureCapsuleGesture({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      gesture: { kind: "tap", fx: 0.5, fy: 0.5 },
      pointerRelay: relay,
      readLiveViewport: matchingViewport,
    });
    expect(res).toEqual({ ok: false, reason: "pointer_dispatch_failed" });
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("awaiting_user_gesture");
    expect(after?.attempt_count).toBe(0);
    expect(isTerminalVisualGestureStatus(after!.status)).toBe(false);
  });
});

// ─── 7. recheck: terminal ONLY on absent; present burns to manual_fallback ───────

describe("recheckVisualGestureCapsule terminal-only-on-cleared", () => {
  const probeReturning = (
    r: { ok: true; presence: "present" | "absent" | "unknown" } | { ok: false; reason?: string },
  ): VisualGestureCapsulePresenceProbe => async () => r;

  it("absent → cleared (terminal) and removed from the active list", async () => {
    const capsule = seedWithFrame();
    const res = await recheckVisualGestureCapsule({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      probe: probeReturning({ ok: true, presence: "absent" }),
    });
    expect(res).toMatchObject({ ok: true, outcome: "cleared", status: "cleared" });
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(isTerminalVisualGestureStatus(after!.status)).toBe(true);
    expect(
      listActiveVisualGestureCapsules().find((c) => c.capsule_id === capsule.capsule_id),
    ).toBeUndefined();
  });

  it("present repeatedly → manual_fallback (non-terminal); capsule stays active, agent stays blocked", async () => {
    const capsule = seedWithFrame();
    const present = probeReturning({ ok: true, presence: "present" });
    for (let i = 0; i < MAX_GESTURE_ATTEMPTS; i++) {
      const r = await recheckVisualGestureCapsule({
        capsuleId: capsule.capsule_id,
        cdpUrl: CDP,
        probe: present,
      });
      expect(r).toMatchObject({ ok: true, outcome: "still_present" });
    }
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("manual_fallback");
    expect(after?.attempt_count).toBe(MAX_GESTURE_ATTEMPTS);
    // Non-terminal → still active → the agent-side guard keeps the agent blocked.
    expect(isTerminalVisualGestureStatus(after!.status)).toBe(false);
    expect(
      listActiveVisualGestureCapsules().find((c) => c.capsule_id === capsule.capsule_id),
    ).toBeDefined();
  });

  it("unknown probe → no change, no attempt burned, not cleared", async () => {
    const capsule = seedWithFrame();
    const res = await recheckVisualGestureCapsule({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      probe: probeReturning({ ok: true, presence: "unknown" }),
    });
    expect(res).toMatchObject({ ok: true, outcome: "unknown" });
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("awaiting_user_gesture");
    expect(after?.attempt_count).toBe(0);
  });

  it("probe failure → probe_failed, no change", async () => {
    const capsule = seedWithFrame();
    const res = await recheckVisualGestureCapsule({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      probe: probeReturning({ ok: false, reason: "probe_eval_failed" }),
    });
    expect(res).toEqual({ ok: false, reason: "probe_failed" });
    const after = getVisualGestureCapsule(capsule.capsule_id);
    expect(after?.status).toBe("awaiting_user_gesture");
    expect(after?.attempt_count).toBe(0);
  });
});
