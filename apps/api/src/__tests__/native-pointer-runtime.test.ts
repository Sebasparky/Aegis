/**
 * Native Pointer Runtime v1 — unit tests.
 *
 * Pure unit tests: no real browser, no real CDP connection, no persistence layer.
 * sleep and sendCdp are injected mocks so tests run without real-time delays.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pickTargetPoint,
  generatePointerPath,
  dispatchPointerMovePath,
  clickAtPoint,
  clickBoxWithPointer,
  makePointerRuntimeState,
} from "../runtime/nativePointerRuntime.js";
import type { ElementBox } from "../runtime/nativePointerRuntime.js";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const BOX: ElementBox = { x: 100, y: 200, width: 80, height: 40 };
const START = { x: 0, y: 0 };
const END = { x: 200, y: 150 };

// Mocked sleep never actually waits
const mockSleep = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  mockSleep.mockClear();
});

// ─── pickTargetPoint ─────────────────────────────────────────────────────────

describe("pickTargetPoint", () => {
  it("returns a point inside the box bounds", () => {
    // Run several times to catch edge-case randoms
    for (let i = 0; i < 20; i++) {
      const pt = pickTargetPoint(BOX);
      expect(pt.x).toBeGreaterThanOrEqual(BOX.x);
      expect(pt.x).toBeLessThanOrEqual(BOX.x + BOX.width);
      expect(pt.y).toBeGreaterThanOrEqual(BOX.y);
      expect(pt.y).toBeLessThanOrEqual(BOX.y + BOX.height);
    }
  });

  it("does not always return the exact center", () => {
    const center = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 };

    // random = 0.3 → x offset = 0.30 + 0.3*0.40 = 0.42 of width, not 0.5
    const pt03 = pickTargetPoint(BOX, { random: () => 0.3 });
    expect(pt03.x).not.toBeCloseTo(center.x, 1);

    // random = 0.7 → x offset = 0.30 + 0.7*0.40 = 0.58 of width
    const pt07 = pickTargetPoint(BOX, { random: () => 0.7 });

    // The two points must differ
    expect(pt03.x).not.toBeCloseTo(pt07.x, 1);
  });
});

// ─── generatePointerPath ─────────────────────────────────────────────────────

describe("generatePointerPath", () => {
  it("first point equals start exactly", () => {
    const path = generatePointerPath(START, END, { random: () => 0.5 });
    expect(path[0].x).toBe(START.x);
    expect(path[0].y).toBe(START.y);
  });

  it("last point equals end exactly", () => {
    const path = generatePointerPath(START, END, { random: () => 0.5 });
    const last = path[path.length - 1];
    expect(last.x).toBe(END.x);
    expect(last.y).toBe(END.y);
  });

  it("first point has delay_ms of 0", () => {
    const path = generatePointerPath(START, END, { random: () => 0.4 });
    expect(path[0].delay_ms).toBe(0);
  });

  it("all delay_ms values are non-negative (cumulative time is monotonically non-decreasing)", () => {
    const path = generatePointerPath(START, END, { random: () => 0.4 });
    for (const pt of path) {
      expect(pt.delay_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("careful mode has substantially more total delay than fast mode", () => {
    const fastPath    = generatePointerPath(START, END, { mode: "fast",    random: () => 0.5 });
    const carefulPath = generatePointerPath(START, END, { mode: "careful", random: () => 0.5 });
    const fastTotal    = fastPath.reduce((s, pt) => s + pt.delay_ms, 0);
    const carefulTotal = carefulPath.reduce((s, pt) => s + pt.delay_ms, 0);
    expect(carefulTotal).toBeGreaterThan(fastTotal);
  });

  it("is deterministic with a fixed random source", () => {
    const rng = () => 0.42;
    const path1 = generatePointerPath(START, END, { random: rng });
    const path2 = generatePointerPath(START, END, { random: rng });
    expect(path1).toEqual(path2);
  });

  it("produces more points for careful mode than for fast mode", () => {
    const fastPath    = generatePointerPath(START, END, { mode: "fast",    random: () => 0.5 });
    const carefulPath = generatePointerPath(START, END, { mode: "careful", random: () => 0.5 });
    expect(carefulPath.length).toBeGreaterThan(fastPath.length);
  });
});

// ─── dispatchPointerMovePath ──────────────────────────────────────────────────

describe("dispatchPointerMovePath", () => {
  it("sends one mouseMoved event per path point", async () => {
    const sendCdp = vi.fn();
    const path = [
      { x: 0,   y: 0,  delay_ms: 0  },
      { x: 50,  y: 25, delay_ms: 10 },
      { x: 100, y: 50, delay_ms: 10 },
    ];
    await dispatchPointerMovePath(sendCdp, path, mockSleep);
    expect(sendCdp).toHaveBeenCalledTimes(3);
  });

  it("every sent event has type mouseMoved", async () => {
    const sendCdp = vi.fn();
    const path = [
      { x: 0, y: 0, delay_ms: 0 },
      { x: 50, y: 50, delay_ms: 5 },
    ];
    await dispatchPointerMovePath(sendCdp, path, mockSleep);
    for (const [method, params] of sendCdp.mock.calls) {
      expect(method).toBe("Input.dispatchMouseEvent");
      expect((params as Record<string, unknown>).type).toBe("mouseMoved");
    }
  });

  it("never sends mousePressed or mouseReleased", async () => {
    const sendCdp = vi.fn();
    const path = generatePointerPath(START, END, { mode: "fast", random: () => 0.5 });
    await dispatchPointerMovePath(sendCdp, path, mockSleep);
    const types = sendCdp.mock.calls.map(([, p]) => (p as Record<string, unknown>).type);
    expect(types).not.toContain("mousePressed");
    expect(types).not.toContain("mouseReleased");
  });

  it("does not call Runtime.evaluate", async () => {
    const sendCdp = vi.fn();
    const path = [{ x: 0, y: 0, delay_ms: 0 }, { x: 10, y: 10, delay_ms: 5 }];
    await dispatchPointerMovePath(sendCdp, path, mockSleep);
    const methods = sendCdp.mock.calls.map(([m]) => m);
    expect(methods).not.toContain("Runtime.evaluate");
  });
});

// ─── clickAtPoint ─────────────────────────────────────────────────────────────

describe("clickAtPoint", () => {
  it("sends mousePressed before mouseReleased", async () => {
    const sendCdp = vi.fn();
    await clickAtPoint(sendCdp, { x: 100, y: 200 }, "native", mockSleep);
    const types = sendCdp.mock.calls.map(([, p]) => (p as Record<string, unknown>).type);
    const pressIdx   = types.indexOf("mousePressed");
    const releaseIdx = types.indexOf("mouseReleased");
    expect(pressIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(pressIdx);
  });

  it("uses left button for press and release", async () => {
    const sendCdp = vi.fn();
    await clickAtPoint(sendCdp, { x: 10, y: 10 }, "fast", mockSleep);
    for (const [, params] of sendCdp.mock.calls) {
      expect((params as Record<string, unknown>).button).toBe("left");
    }
  });

  it("does not call Runtime.evaluate", async () => {
    const sendCdp = vi.fn();
    await clickAtPoint(sendCdp, { x: 10, y: 10 }, "fast", mockSleep);
    const methods = sendCdp.mock.calls.map(([m]) => m);
    expect(methods).not.toContain("Runtime.evaluate");
  });
});

// ─── clickBoxWithPointer ──────────────────────────────────────────────────────

describe("clickBoxWithPointer", () => {
  it("updates state current_x and current_y to the clicked target point", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState({ current_x: 0, current_y: 0, interaction_mode: "fast" });

    await clickBoxWithPointer(state, BOX, sendCdp, mockSleep, { random: () => 0.5 });

    expect(state.current_x).not.toBe(0);
    expect(state.current_y).not.toBe(0);
    expect(state.current_x).toBeGreaterThanOrEqual(BOX.x);
    expect(state.current_x).toBeLessThanOrEqual(BOX.x + BOX.width);
    expect(state.current_y).toBeGreaterThanOrEqual(BOX.y);
    expect(state.current_y).toBeLessThanOrEqual(BOX.y + BOX.height);
  });

  it("sets last_action_at to a valid ISO timestamp", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState();
    await clickBoxWithPointer(state, BOX, sendCdp, mockSleep, { random: () => 0.4 });
    expect(state.last_action_at).toBeDefined();
    expect(isNaN(new Date(state.last_action_at!).getTime())).toBe(false);
  });

  it("dispatches all mouseMoved events before mousePressed", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState({ interaction_mode: "fast" });

    await clickBoxWithPointer(state, BOX, sendCdp, mockSleep, { random: () => 0.5 });

    const types = sendCdp.mock.calls.map(([, p]) => (p as Record<string, unknown>).type);
    const firstPressIdx = types.indexOf("mousePressed");
    const lastMovedIdx  = types.lastIndexOf("mouseMoved");

    // There must be at least one mouseMoved, and it must precede mousePressed
    expect(lastMovedIdx).toBeGreaterThanOrEqual(0);
    expect(firstPressIdx).toBeGreaterThan(lastMovedIdx);
  });

  it("never calls Runtime.evaluate", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState({ interaction_mode: "native" });
    await clickBoxWithPointer(state, BOX, sendCdp, mockSleep, { random: () => 0.3 });
    const methods = sendCdp.mock.calls.map(([m]) => m);
    expect(methods).not.toContain("Runtime.evaluate");
  });
});

// ─── makePointerRuntimeState ──────────────────────────────────────────────────

describe("makePointerRuntimeState", () => {
  it("returns sensible defaults", () => {
    const state = makePointerRuntimeState();
    expect(state.current_x).toBe(0);
    expect(state.current_y).toBe(0);
    expect(state.viewport_width).toBe(1280);
    expect(state.viewport_height).toBe(800);
    expect(state.interaction_mode).toBe("native");
    expect(state.last_action_at).toBeUndefined();
  });

  it("applies overrides", () => {
    const state = makePointerRuntimeState({ current_x: 42, interaction_mode: "careful" });
    expect(state.current_x).toBe(42);
    expect(state.interaction_mode).toBe("careful");
    expect(state.current_y).toBe(0); // default preserved
  });
});
