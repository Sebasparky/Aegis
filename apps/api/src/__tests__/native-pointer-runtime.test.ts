/**
 * Native Pointer Runtime v1 — unit tests.
 *
 * Pure unit tests: no real browser, no real CDP connection, no persistence layer.
 * sleep and sendCdp are injected mocks so tests run without real-time delays.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pickTargetPoint,
  generatePointerPath,
  clampPathToViewport,
  dispatchPointerMovePath,
  clickAtPoint,
  clickBoxWithPointer,
  clickPointWithPointer,
  makePointerRuntimeState,
  resolvePointerTimingMode,
  renderVgcHoldOverlay,
} from "../runtime/nativePointerRuntime.js";
import type { ElementBox, TimedPoint } from "../runtime/nativePointerRuntime.js";
import {
  getMovementPoints,
  normalizePointerTrace,
  transformNormalizedTemplate,
  scorePointerTrace,
  selectPointerTraceTemplate,
} from "../runtime/pointerTraceTemplates.js";
import type { PointerTrace } from "../runtime/pointerTraceTemplates.js";
import {
  loadPointerTraces,
  resolveProfilePath,
  getLoadedPointerTraces,
} from "../runtime/pointerProfileLoader.js";

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
    const { path } = generatePointerPath(START, END, { random: () => 0.5 });
    expect(path[0].x).toBe(START.x);
    expect(path[0].y).toBe(START.y);
  });

  it("last point equals end exactly", () => {
    const { path } = generatePointerPath(START, END, { random: () => 0.5 });
    const last = path[path.length - 1];
    expect(last.x).toBe(END.x);
    expect(last.y).toBe(END.y);
  });

  it("first point has delay_ms of 0", () => {
    const { path } = generatePointerPath(START, END, { random: () => 0.4 });
    expect(path[0].delay_ms).toBe(0);
  });

  it("all delay_ms values are non-negative (cumulative time is monotonically non-decreasing)", () => {
    const { path } = generatePointerPath(START, END, { random: () => 0.4 });
    for (const pt of path) {
      expect(pt.delay_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("careful mode has substantially more total delay than fast mode", () => {
    const { path: fastPath }    = generatePointerPath(START, END, { mode: "fast",    random: () => 0.5 });
    const { path: carefulPath } = generatePointerPath(START, END, { mode: "careful", random: () => 0.5 });
    const fastTotal    = fastPath.reduce((s, pt) => s + pt.delay_ms, 0);
    const carefulTotal = carefulPath.reduce((s, pt) => s + pt.delay_ms, 0);
    expect(carefulTotal).toBeGreaterThan(fastTotal);
  });

  it("is deterministic with a fixed random source", () => {
    const rng = () => 0.42;
    const { path: path1 } = generatePointerPath(START, END, { random: rng });
    const { path: path2 } = generatePointerPath(START, END, { random: rng });
    expect(path1).toEqual(path2);
  });

  it("produces more points for careful mode than for fast mode", () => {
    const { path: fastPath }    = generatePointerPath(START, END, { mode: "fast",    random: () => 0.5 });
    const { path: carefulPath } = generatePointerPath(START, END, { mode: "careful", random: () => 0.5 });
    expect(carefulPath.length).toBeGreaterThan(fastPath.length);
  });
});

// ─── clampPathToViewport ─────────────────────────────────────────────────────

describe("clampPathToViewport", () => {
  const VIEWPORT = { width: 1280, height: 800 };
  const PAD = 8;

  it("leaves an already in-viewport path unchanged (endpoint preserved)", () => {
    const path: TimedPoint[] = [
      { x: 100, y: 100, delay_ms: 0 },
      { x: 400, y: 300, delay_ms: 10 },
      { x: 640, y: 400, delay_ms: 10 },
    ];
    const result = clampPathToViewport(path, VIEWPORT, PAD);
    expect(result).toEqual(path);
    // Endpoint is exact
    expect(result[result.length - 1]).toEqual({ x: 640, y: 400, delay_ms: 10 });
  });

  it("clamps negative intermediate points into [pad, dim-pad] while keeping a valid endpoint", () => {
    const path: TimedPoint[] = [
      { x: 640, y: 400, delay_ms: 0 },
      { x: -200, y: -756, delay_ms: 12 }, // overshoot above/left of viewport
      { x: 500, y: 250, delay_ms: 12 },   // valid endpoint
    ];
    const result = clampPathToViewport(path, VIEWPORT, PAD);
    for (const p of result) {
      expect(p.x).toBeGreaterThanOrEqual(PAD);
      expect(p.x).toBeLessThanOrEqual(VIEWPORT.width - PAD);
      expect(p.y).toBeGreaterThanOrEqual(PAD);
      expect(p.y).toBeLessThanOrEqual(VIEWPORT.height - PAD);
    }
    // Overshoot point pinned to the padded edge
    expect(result[1]).toEqual({ x: PAD, y: PAD, delay_ms: 12 });
    // Valid endpoint untouched
    expect(result[2]).toEqual({ x: 500, y: 250, delay_ms: 12 });
  });

  it("clamps points beyond the bottom/right edge", () => {
    const path: TimedPoint[] = [
      { x: 640, y: 400, delay_ms: 0 },
      { x: 5000, y: 1608, delay_ms: 10 },
    ];
    const result = clampPathToViewport(path, VIEWPORT, PAD);
    expect(result[1]).toEqual({ x: VIEWPORT.width - PAD, y: VIEWPORT.height - PAD, delay_ms: 10 });
  });

  it("preserves point count and delay_ms (timing/realism unchanged)", () => {
    const { path } = generatePointerPath(START, END, { mode: "native", random: () => 0.5 });
    const result = clampPathToViewport(path, VIEWPORT, PAD);
    expect(result.length).toBe(path.length);
    expect(result.map((p) => p.delay_ms)).toEqual(path.map((p) => p.delay_ms));
  });

  it("handles a degenerate viewport without NaN or crossed bounds", () => {
    const tiny = { width: 10, height: 10 }; // <= 2*pad
    const path: TimedPoint[] = [
      { x: -50, y: -50, delay_ms: 0 },
      { x: 999, y: 999, delay_ms: 5 },
    ];
    const result = clampPathToViewport(path, tiny, PAD);
    for (const p of result) {
      expect(Number.isNaN(p.x)).toBe(false);
      expect(Number.isNaN(p.y)).toBe(false);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(tiny.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(tiny.height);
    }
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
    const { path } = generatePointerPath(START, END, { mode: "fast", random: () => 0.5 });
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

  it("dispatches no mouse event outside the viewport even when the curve overshoots an edge", async () => {
    const sendCdp = vi.fn();
    // Start at the top edge, target a box hugging the top-right corner so a
    // perpendicular Bézier bias is likely to push intermediate points off-screen.
    const state = makePointerRuntimeState({
      current_x: 1260,
      current_y: 10,
      viewport_width: 1280,
      viewport_height: 800,
      interaction_mode: "native",
    });
    const edgeBox: ElementBox = { x: 1230, y: 4, width: 40, height: 20 };

    // random = 0 maximises the perpendicular bias sign/magnitude in the Bézier path.
    await clickBoxWithPointer(state, edgeBox, sendCdp, mockSleep, { random: () => 0 });

    const mouseEvents = sendCdp.mock.calls.filter(
      ([m]) => m === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents.length).toBeGreaterThan(0);
    for (const [, params] of mouseEvents) {
      const { x, y } = params as { x: number; y: number };
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1280);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(800);
    }
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

// ─── resolvePointerTimingMode (dev/QA fast pointer timing) ───────────────────

describe("resolvePointerTimingMode", () => {
  const PRIOR = process.env.ANTIGEN_POINTER_TIMING;
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.ANTIGEN_POINTER_TIMING;
    else process.env.ANTIGEN_POINTER_TIMING = PRIOR;
  });

  it("defaults to realistic when unset", () => {
    delete process.env.ANTIGEN_POINTER_TIMING;
    expect(resolvePointerTimingMode()).toBe("realistic");
  });

  it("maps fast -> native profile (case/whitespace-insensitive)", () => {
    process.env.ANTIGEN_POINTER_TIMING = "fast";
    expect(resolvePointerTimingMode()).toBe("native");
    process.env.ANTIGEN_POINTER_TIMING = "  FAST ";
    expect(resolvePointerTimingMode()).toBe("native");
  });

  it("returns realistic for explicit realistic and for unknown values", () => {
    process.env.ANTIGEN_POINTER_TIMING = "realistic";
    expect(resolvePointerTimingMode()).toBe("realistic");
    process.env.ANTIGEN_POINTER_TIMING = "warp_speed";
    expect(resolvePointerTimingMode()).toBe("realistic");
  });

  it("fast profile produces strictly less total animation delay than the default", () => {
    // The resolver only selects an animation profile (MODE_TIMING) — both are real,
    // fully-validated modes; fast simply shortens per-point/hover/click-gap delays.
    process.env.ANTIGEN_POINTER_TIMING = "fast";
    const fastMode = resolvePointerTimingMode();
    delete process.env.ANTIGEN_POINTER_TIMING;
    const defaultMode = resolvePointerTimingMode();

    const { path: fastPath } = generatePointerPath(START, END, { mode: fastMode, random: () => 0.5 });
    const { path: defPath } = generatePointerPath(START, END, { mode: defaultMode, random: () => 0.5 });
    const sum = (p: TimedPoint[]) => p.reduce((s, pt) => s + pt.delay_ms, 0);

    expect(fastMode).not.toBe(defaultMode);
    expect(sum(fastPath)).toBeLessThan(sum(defPath));
  });

  it("only returns valid interaction modes (no validation/path-shape side effects)", () => {
    // It is a pure env→mode mapping: it never returns a non-mode value, so it
    // cannot disable a guard or change what is clickable — only animation timing.
    for (const v of ["fast", "realistic", "", "nonsense", "Fast"]) {
      process.env.ANTIGEN_POINTER_TIMING = v;
      expect(["native", "realistic"]).toContain(resolvePointerTimingMode());
    }
  });
});

// ─── Pointer trace template helpers (v2) ─────────────────────────────────────

// Synthetic test traces — no real personal pointer data
function makeHorizontalTrace(overrides?: Partial<PointerTrace>): PointerTrace {
  return {
    trace_id: "test-trace-h",
    purpose: "button_click",
    start: { x: 0, y: 0 },
    end: { x: 100, y: 0 },
    viewport: { width: 1280, height: 800 },
    duration_ms: 200,
    distance_px: 100,
    direction_rad: 0,
    points: [
      { x: 0,   y: 0,  t_ms: 0,   event: "move" },
      { x: 33,  y: 2,  t_ms: 60,  event: "move" },
      { x: 67,  y: -1, t_ms: 140, event: "move" },
      { x: 100, y: 0,  t_ms: 200, event: "move" },
    ],
    ...overrides,
  };
}

describe("normalizePointerTrace", () => {
  it("first normalized point is (0,0) and last is (1,0)", () => {
    const trace = makeHorizontalTrace();
    const result = normalizePointerTrace(trace);
    expect(result).not.toBeNull();
    expect(result!.points[0].x).toBeCloseTo(0, 5);
    expect(result!.points[0].y).toBeCloseTo(0, 5);
    expect(result!.points[result!.points.length - 1].x).toBeCloseTo(1, 5);
    expect(result!.points[result!.points.length - 1].y).toBeCloseTo(0, 5);
  });

  it("excludes down/up/click/scroll events from movement templates", () => {
    const trace = makeHorizontalTrace({
      points: [
        { x: 0,   y: 0, t_ms: 0,   event: "down"  },
        { x: 0,   y: 0, t_ms: 5,   event: "move"  },
        { x: 50,  y: 0, t_ms: 100, event: "move"  },
        { x: 100, y: 0, t_ms: 200, event: "move"  },
        { x: 100, y: 0, t_ms: 210, event: "up"    },
        { x: 100, y: 0, t_ms: 215, event: "click" },
      ],
    });
    const movPts = getMovementPoints(trace);
    expect(movPts.length).toBe(3);
    const result = normalizePointerTrace(trace);
    expect(result).not.toBeNull();
    expect(result!.points.length).toBe(3);
  });

  it("subtracts initial t_ms so first normalized time is 0", () => {
    const trace = makeHorizontalTrace({
      points: [
        { x: 0,   y: 0, t_ms: 500, event: "move" },
        { x: 50,  y: 0, t_ms: 600, event: "move" },
        { x: 100, y: 0, t_ms: 700, event: "move" },
      ],
    });
    const result = normalizePointerTrace(trace);
    expect(result).not.toBeNull();
    expect(result!.points[0].t_ms).toBe(0);
    expect(result!.points[1].t_ms).toBeCloseTo(100);
    expect(result!.points[2].t_ms).toBeCloseTo(200);
  });

  it("returns null for traces with too few movement points", () => {
    const trace = makeHorizontalTrace({
      points: [{ x: 0, y: 0, t_ms: 0, event: "move" }],
    });
    expect(normalizePointerTrace(trace)).toBeNull();
  });

  it("returns null when movement distance is too small", () => {
    const trace = makeHorizontalTrace({
      points: [
        { x: 0, y: 0, t_ms: 0,  event: "move" },
        { x: 2, y: 0, t_ms: 50, event: "move" },
      ],
    });
    expect(normalizePointerTrace(trace)).toBeNull();
  });
});

describe("transformNormalizedTemplate", () => {
  function getNormalized() {
    const trace = makeHorizontalTrace();
    return normalizePointerTrace(trace)!;
  }

  it("first returned point equals runtime start exactly", () => {
    const normalized = getNormalized();
    const start = { x: 300, y: 400 };
    const end   = { x: 500, y: 600 };
    const result = transformNormalizedTemplate(normalized, start, end);
    expect(result[0].x).toBe(start.x);
    expect(result[0].y).toBe(start.y);
  });

  it("last returned point equals runtime end exactly", () => {
    const normalized = getNormalized();
    const start = { x: 300, y: 400 };
    const end   = { x: 500, y: 600 };
    const result = transformNormalizedTemplate(normalized, start, end);
    const last = result[result.length - 1];
    expect(last.x).toBe(end.x);
    expect(last.y).toBe(end.y);
  });

  it("all delay_ms values are non-negative", () => {
    const normalized = getNormalized();
    const result = transformNormalizedTemplate(normalized, { x: 0, y: 0 }, { x: 200, y: 150 });
    for (const pt of result) {
      expect(pt.delay_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("first point has delay_ms of 0", () => {
    const normalized = getNormalized();
    const result = transformNormalizedTemplate(normalized, START, END);
    expect(result[0].delay_ms).toBe(0);
  });
});

describe("selectPointerTraceTemplate", () => {
  it("prefers a trace with matching purpose over a mismatched purpose", () => {
    const matchingTrace = makeHorizontalTrace({ trace_id: "match", purpose: "button_click" });
    const mismatchTrace = makeHorizontalTrace({ trace_id: "other", purpose: "input_focus" });
    const request = {
      purpose: "button_click" as const,
      distance_px: 100,
      direction_rad: 0,
    };
    const selected = selectPointerTraceTemplate([mismatchTrace, matchingTrace], request);
    expect(selected?.trace_id).toBe("match");
  });

  it("avoids scroll traces when purpose is button_click", () => {
    const scrollTrace = makeHorizontalTrace({ trace_id: "scroll-one", purpose: "scroll" });
    const clickTrace  = makeHorizontalTrace({ trace_id: "click-one",  purpose: "button_click" });
    const request = { purpose: "button_click" as const, distance_px: 100, direction_rad: 0 };
    const selected = selectPointerTraceTemplate([scrollTrace, clickTrace], request);
    expect(selected?.trace_id).toBe("click-one");
  });

  it("avoids drag traces when purpose is input_focus", () => {
    const dragTrace  = makeHorizontalTrace({ trace_id: "drag-one",  purpose: "drag" });
    const focusTrace = makeHorizontalTrace({ trace_id: "focus-one", purpose: "input_focus" });
    const request = { purpose: "input_focus" as const, distance_px: 100, direction_rad: 0 };
    const selected = selectPointerTraceTemplate([dragTrace, focusTrace], request);
    expect(selected?.trace_id).toBe("focus-one");
  });

  it("returns null when all traces are unusable", () => {
    const scrollTrace = makeHorizontalTrace({ purpose: "scroll" });
    const request = { purpose: "button_click" as const, distance_px: 100, direction_rad: 0 };
    expect(selectPointerTraceTemplate([scrollTrace], request)).toBeNull();
  });

  it("returns null for empty traces array", () => {
    const request = { purpose: "button_click" as const, distance_px: 100, direction_rad: 0 };
    expect(selectPointerTraceTemplate([], request)).toBeNull();
  });

  it("breaks ties deterministically by trace_id", () => {
    const traceA = makeHorizontalTrace({ trace_id: "aaa", purpose: "button_click" });
    const traceB = makeHorizontalTrace({ trace_id: "bbb", purpose: "button_click" });
    const request = { purpose: "button_click" as const, distance_px: 100, direction_rad: 0 };
    const result1 = selectPointerTraceTemplate([traceA, traceB], request);
    const result2 = selectPointerTraceTemplate([traceB, traceA], request);
    expect(result1?.trace_id).toBe("aaa");
    expect(result2?.trace_id).toBe("aaa");
  });
});

describe("generatePointerPath — v2 template path", () => {
  it("uses template path and returns generator: template_trace when suitable traces are provided", () => {
    const trace = makeHorizontalTrace();
    // Trace has 4 movement points; native Bézier mode uses 12.
    // Template path preserves the recorded point count.
    const { path, generator } = generatePointerPath(START, END, {
      mode: "native",
      templateTraces: [trace],
      purpose: "button_click",
    });
    expect(generator).toBe("template_trace");
    expect(path.length).toBe(4);
    expect(path[0].x).toBe(START.x);
    expect(path[0].y).toBe(START.y);
    expect(path[path.length - 1].x).toBe(END.x);
    expect(path[path.length - 1].y).toBe(END.y);
  });

  it("falls back to Bézier and returns generator: bezier_fallback when templateTraces is empty", () => {
    // native mode Bézier uses 12 points; template path would use trace's point count
    const { path, generator } = generatePointerPath(START, END, {
      mode: "native",
      templateTraces: [],
      purpose: "button_click",
    });
    expect(generator).toBe("bezier_fallback");
    expect(path.length).toBe(12); // native mode_count
    expect(path[0].x).toBe(START.x);
    expect(path[path.length - 1].x).toBe(END.x);
  });

  it("falls back to Bézier when all template traces are unusable for the requested purpose", () => {
    const scrollTrace = makeHorizontalTrace({ purpose: "scroll" });
    const { path, generator } = generatePointerPath(START, END, {
      mode: "native",
      templateTraces: [scrollTrace],
      purpose: "button_click",
    });
    // Scroll trace is rejected for button_click; should fall back to 12-point Bézier
    expect(generator).toBe("bezier_fallback");
    expect(path.length).toBe(12);
  });

  it("existing callers without templateTraces still get Bézier path", () => {
    const { path, generator } = generatePointerPath(START, END, { mode: "fast", random: () => 0.5 });
    expect(generator).toBe("bezier_fallback");
    expect(path.length).toBe(5); // fast mode point_count
    expect(path[0].x).toBe(START.x);
    expect(path[path.length - 1].x).toBe(END.x);
  });
});

// ─── clickBoxWithPointer — template trace wiring ──────────────────────────────

describe("clickBoxWithPointer — template trace wiring", () => {
  it("uses template path when templateTraces are provided: mouseMoved count matches trace point count", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState({ current_x: 0, current_y: 0, interaction_mode: "native" });
    // makeHorizontalTrace has 4 movement points — native Bézier would produce 12.
    const trace = makeHorizontalTrace();

    await clickBoxWithPointer(state, BOX, sendCdp, mockSleep, {
      random: () => 0.5,
      templateTraces: [trace],
      purpose: "button_click",
    });

    const movedEvents = sendCdp.mock.calls.filter(
      ([, p]) => (p as Record<string, unknown>).type === "mouseMoved",
    );
    // Template has 4 movement points → 4 mouseMoved events (not the native 12)
    expect(movedEvents.length).toBe(4);
  });

  it("falls back to Bézier when no templateTraces are provided", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState({ current_x: 0, current_y: 0, interaction_mode: "native" });

    await clickBoxWithPointer(state, BOX, sendCdp, mockSleep, { random: () => 0.5 });

    const movedEvents = sendCdp.mock.calls.filter(
      ([, p]) => (p as Record<string, unknown>).type === "mouseMoved",
    );
    expect(movedEvents.length).toBe(12); // native mode Bézier
  });
});

// ─── clickPointWithPointer — template trace wiring ───────────────────────────

describe("clickPointWithPointer — template trace wiring", () => {
  it("uses template path when templateTraces are provided: mouseMoved count matches trace point count", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState({ current_x: 0, current_y: 0, interaction_mode: "native" });
    const trace = makeHorizontalTrace();
    const target = { x: 200, y: 150 };

    await clickPointWithPointer(state, target, sendCdp, mockSleep, {
      templateTraces: [trace],
      purpose: "button_click",
    });

    const movedEvents = sendCdp.mock.calls.filter(
      ([, p]) => (p as Record<string, unknown>).type === "mouseMoved",
    );
    // Template has 4 movement points → 4 mouseMoved events
    expect(movedEvents.length).toBe(4);
  });

  it("falls back to Bézier when no templateTraces are provided", async () => {
    const sendCdp = vi.fn();
    const state = makePointerRuntimeState({ current_x: 0, current_y: 0, interaction_mode: "native" });
    const target = { x: 200, y: 150 };

    await clickPointWithPointer(state, target, sendCdp, mockSleep);

    const movedEvents = sendCdp.mock.calls.filter(
      ([, p]) => (p as Record<string, unknown>).type === "mouseMoved",
    );
    expect(movedEvents.length).toBe(12); // native mode Bézier
  });
});

// ─── pointerProfileLoader ─────────────────────────────────────────────────────

describe("pointerProfileLoader", () => {
  const ORIG_ENV = process.env.ANTIGEN_POINTER_PROFILE_PATH;

  afterEach(() => {
    if (ORIG_ENV === undefined) {
      delete process.env.ANTIGEN_POINTER_PROFILE_PATH;
    } else {
      process.env.ANTIGEN_POINTER_PROFILE_PATH = ORIG_ENV;
    }
  });

  it("returns [] when env is empty string (disabled)", () => {
    process.env.ANTIGEN_POINTER_PROFILE_PATH = "";
    expect(loadPointerTraces()).toEqual([]);
  });

  it("returns [] when env is 'false' (disabled)", () => {
    process.env.ANTIGEN_POINTER_PROFILE_PATH = "false";
    expect(loadPointerTraces()).toEqual([]);
  });

  it("returns [] when explicit env path does not exist", () => {
    process.env.ANTIGEN_POINTER_PROFILE_PATH = "/tmp/__nonexistent_pointer_profile_aegis__.json";
    expect(loadPointerTraces()).toEqual([]);
  });

  it("resolves repo-root dev-artifacts profile from apps/api cwd", () => {
    delete process.env.ANTIGEN_POINTER_PROFILE_PATH;
    // When running from apps/api, the ../../ candidate resolves to repo root.
    const resolved = resolveProfilePath();
    expect(resolved).not.toBeNull();
    expect(resolved).toContain("dev-artifacts");
  });

  it("loads non-empty traces from repo-root when no env override", () => {
    delete process.env.ANTIGEN_POINTER_PROFILE_PATH;
    const traces = loadPointerTraces();
    expect(traces.length).toBeGreaterThan(0);
  });
});

// ─── generatePointerPath — input_focus purpose fallback ──────────────────────

describe("generatePointerPath — input_focus purpose fallback", () => {
  it("selects a button_click trace when purpose is input_focus and only button_click traces exist", () => {
    const buttonTrace = makeHorizontalTrace(); // purpose: "button_click"
    const { generator } = generatePointerPath(
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { templateTraces: [buttonTrace], purpose: "input_focus", random: () => 0.5 },
    );
    expect(generator).toBe("template_trace");
  });

  it("returns template_trace when both input_focus and button_click traces are present", () => {
    const buttonTrace = makeHorizontalTrace({ trace_id: "btn-1", purpose: "button_click" });
    const inputTrace = makeHorizontalTrace({ trace_id: "inp-1", purpose: "input_focus" });
    const { generator } = generatePointerPath(
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { templateTraces: [buttonTrace, inputTrace], purpose: "input_focus", random: () => 0.5 },
    );
    expect(generator).toBe("template_trace");
  });
});

// ─── generatePointerPath with real loaded profile ─────────────────────────────

describe("generatePointerPath with real loaded profile", () => {
  it("returns template_trace when calibrated profile is loaded", () => {
    const traces = getLoadedPointerTraces();
    if (traces.length === 0) return; // CI without local fixture — skip gracefully
    const { generator } = generatePointerPath(
      { x: 100, y: 100 },
      { x: 500, y: 300 },
      { templateTraces: traces, purpose: "button_click" },
    );
    expect(generator).toBe("template_trace");
  });
});

// ─── renderVgcHoldOverlay (dev-only VGC hold marker) ──────────────────────────

describe("renderVgcHoldOverlay", () => {
  const ORIGINAL_FLAG = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
    else process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = ORIGINAL_FLAG;
  });

  it("makes ZERO CDP calls when the flag is unset (byte-identical off)", () => {
    delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
    const call = vi.fn().mockResolvedValue(undefined);
    renderVgcHoldOverlay({ call }, 123, 456);
    expect(call).not.toHaveBeenCalled();
  });

  it("makes ZERO CDP calls when the flag is any value other than 'true'", () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "1";
    const call = vi.fn().mockResolvedValue(undefined);
    renderVgcHoldOverlay({ call }, 10, 20);
    expect(call).not.toHaveBeenCalled();
  });

  it("injects via Runtime.evaluate only — never dispatches a pointer event — when enabled", () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    const call = vi.fn().mockResolvedValue(undefined);
    renderVgcHoldOverlay({ call }, 321, 654);

    const methods = call.mock.calls.map(([m]) => m);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === "Runtime.evaluate")).toBe(true);
    // The hold path owns mousePressed/mouseReleased — the overlay must never touch input.
    expect(methods).not.toContain("Input.dispatchMouseEvent");
  });

  it("is fail-open: a rejected/throwing CDP client never throws to the caller", () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    const rejecting = vi.fn().mockRejectedValue(new Error("connection gone"));
    expect(() => renderVgcHoldOverlay({ call: rejecting }, 1, 2)).not.toThrow();
    const throwing = vi.fn().mockImplementation(() => { throw new Error("sync throw"); });
    expect(() => renderVgcHoldOverlay({ call: throwing }, 1, 2)).not.toThrow();
  });
});
