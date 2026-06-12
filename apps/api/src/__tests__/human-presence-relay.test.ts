/**
 * Human Presence Relay v1 — hold state machine unit tests (fake CDP client +
 * fake timers).
 *
 * Proves the core safety properties of the live relay:
 *  - the press exists only while heartbeats arrive: 1.3s of silence dispatches
 *    EXACTLY ONE mouseReleased (fail-closed) and closes the connection,
 *  - a heartbeat re-arms the fail-closed timer,
 *  - hold-end after fail-closed is idempotent (no second release),
 *  - the user-release path releases BEFORE the post-release probe runs,
 *  - the max-duration ceiling force-releases a never-ending hold,
 *  - there is NO auto-solve path: nothing here synthesizes a press; every
 *    release is caused by a user event, silence, or the ceiling.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  registerHoldSession,
  heartbeatHoldSession,
  endHoldSession,
  cancelHoldSession,
  hasLiveHoldSession,
  clearHoldSessionsForTests,
  HOLD_FAIL_CLOSED_MS,
  HOLD_MAX_DURATION_MS,
  type CdpPageClient,
} from "../runtime/humanPresenceRelay.js";

const REQUEST_ID = "hvr_test_001";
const POINT = { x: 320, y: 240 };

interface FakeClient extends CdpPageClient {
  events: Array<{ method: string; params: Record<string, unknown> }>;
  closed: boolean;
  probeResults: unknown[];
}

function makeFakeClient(probeResults: unknown[] = [{ present: false, vw: 1280, vh: 800 }]): FakeClient {
  const client: FakeClient = {
    events: [],
    closed: false,
    probeResults: [...probeResults],
    send(method, params = {}) {
      client.events.push({ method, params });
    },
    async call() {
      return undefined;
    },
    async evaluate() {
      return client.probeResults.length > 1 ? client.probeResults.shift() : client.probeResults[0];
    },
    close() {
      client.closed = true;
    },
  };
  return client;
}

function releases(client: FakeClient) {
  return client.events.filter(
    (e) => e.method === "Input.dispatchMouseEvent" && (e.params as { type?: string }).type === "mouseReleased",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearHoldSessionsForTests();
  vi.useRealTimers();
});

describe("Human Presence Relay — hold state machine", () => {
  it("fail-closes after heartbeat silence: exactly one mouseReleased, hold dead", () => {
    const client = makeFakeClient();
    const autoRelease = vi.fn();
    registerHoldSession({ request_id: REQUEST_ID, client, point: POINT, onAutoRelease: autoRelease });
    expect(hasLiveHoldSession(REQUEST_ID)).toBe(true);

    // 1.3s of silence — past the 1.2s fail-closed window.
    vi.advanceTimersByTime(HOLD_FAIL_CLOSED_MS + 100);

    expect(releases(client)).toHaveLength(1);
    expect(autoRelease).toHaveBeenCalledExactlyOnceWith("fail_closed");
    expect(hasLiveHoldSession(REQUEST_ID)).toBe(false);

    // More time passes — still exactly one release (idempotent).
    vi.advanceTimersByTime(5_000);
    expect(releases(client)).toHaveLength(1);
  });

  it("heartbeats re-arm the fail-closed timer; the hold survives while they keep arriving", () => {
    const client = makeFakeClient();
    registerHoldSession({ request_id: REQUEST_ID, client, point: POINT });

    // 10 heartbeats at 300ms — 3s total, far past the 1.2s silence window.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(300);
      const { holding } = heartbeatHoldSession(REQUEST_ID);
      expect(holding).toBe(true);
    }
    expect(releases(client)).toHaveLength(0);
    expect(hasLiveHoldSession(REQUEST_ID)).toBe(true);

    // Heartbeats stop → fail-closed fires once.
    vi.advanceTimersByTime(HOLD_FAIL_CLOSED_MS + 100);
    expect(releases(client)).toHaveLength(1);
    expect(heartbeatHoldSession(REQUEST_ID).holding).toBe(false);
  });

  it("user release: releases in the browser BEFORE the post-release probe, then closes", async () => {
    const order: string[] = [];
    const client = makeFakeClient();
    const origSend = client.send.bind(client);
    client.send = (m, p = {}) => {
      if (m === "Input.dispatchMouseEvent" && (p as { type?: string }).type === "mouseReleased") order.push("release");
      origSend(m, p);
    };
    client.evaluate = async () => {
      order.push("probe");
      return { present: false, vw: 1280, vh: 800 };
    };

    registerHoldSession({ request_id: REQUEST_ID, client, point: POINT });
    vi.advanceTimersByTime(600);
    heartbeatHoldSession(REQUEST_ID);

    const endPromise = endHoldSession(REQUEST_ID);
    await vi.advanceTimersByTimeAsync(1_000); // post-release settle delay
    const result = await endPromise;

    expect(order).toEqual(["release", "probe"]);
    expect(result.hold_state).toBe("released");
    expect(result.challenge_present).toBe(false);
    expect(client.closed).toBe(true);
    expect(hasLiveHoldSession(REQUEST_ID)).toBe(false);
  });

  it("hold-end after fail-closed is idempotent: reports released_fail_closed, no second release", async () => {
    const client = makeFakeClient([{ present: true, vw: 1280, vh: 800 }]);
    registerHoldSession({ request_id: REQUEST_ID, client, point: POINT });

    vi.advanceTimersByTime(HOLD_FAIL_CLOSED_MS + 100);
    expect(releases(client)).toHaveLength(1);

    const endPromise = endHoldSession(REQUEST_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await endPromise;

    expect(result.hold_state).toBe("released_fail_closed");
    expect(result.challenge_present).toBe(true);
    expect(releases(client)).toHaveLength(1); // still exactly one
  });

  it("max-duration ceiling force-releases a never-ending heartbeat stream", () => {
    const client = makeFakeClient();
    const autoRelease = vi.fn();
    registerHoldSession({ request_id: REQUEST_ID, client, point: POINT, onAutoRelease: autoRelease });

    // Heartbeats forever — but the hard ceiling still fires.
    const beats = Math.ceil(HOLD_MAX_DURATION_MS / 300) + 2;
    for (let i = 0; i < beats; i++) {
      vi.advanceTimersByTime(300);
      heartbeatHoldSession(REQUEST_ID);
    }
    expect(releases(client)).toHaveLength(1);
    expect(autoRelease).toHaveBeenCalledExactlyOnceWith("max_duration");
  });

  it("cancel releases fail-closed and disposes the session", () => {
    const client = makeFakeClient();
    registerHoldSession({ request_id: REQUEST_ID, client, point: POINT });

    cancelHoldSession(REQUEST_ID);
    expect(releases(client)).toHaveLength(1);
    expect(client.closed).toBe(true);
    expect(hasLiveHoldSession(REQUEST_ID)).toBe(false);
    expect(endHoldSession(REQUEST_ID)).resolves.toEqual({ hold_state: "no_hold" });
  });

  it("no auto-solve path: registering a hold dispatches nothing by itself", () => {
    // The press is dispatched by startHoldSession only after a LIVE user
    // hold-start event; the state machine itself never synthesizes input.
    const client = makeFakeClient();
    registerHoldSession({ request_id: REQUEST_ID, client, point: POINT });
    expect(client.events).toHaveLength(0);
    cancelHoldSession(REQUEST_ID); // single release on cancel only
    expect(client.events).toHaveLength(1);
  });
});
