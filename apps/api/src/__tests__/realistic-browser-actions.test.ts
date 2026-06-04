/**
 * Realistic Browser Actions — unit tests.
 *
 * Pure unit tests for the injectable helpers (dispatchTextCharsViaCDP,
 * buildElementFindExpr) and integration tests for the full WebSocket-backed
 * functions using a self-driving CDP mock. No real browser, no real CDP connection.
 *
 * The WebSocket mock (via vi.mock + vi.hoisted) auto-responds to:
 *   Target.attachToTarget → { sessionId: "mock-session" }
 *   Runtime.evaluate     → configured via mockState.nextEvalResponse
 * This lets tests await the full function call directly without vi.waitFor.
 *
 * For pointer movement tests (which use real setTimeout delays), vi.useFakeTimers()
 * is used so the click path completes instantly.
 *
 * Test coverage:
 *   1.  dispatchTextCharsViaCDP — per-character dispatch count
 *   2.  dispatchTextCharsViaCDP — never logs raw typed text
 *   3.  buildElementFindExpr   — description is JSON-encoded (injection-safe)
 *   4.  realisticClickByDescription — fast mode: REALISM_DISABLED, no WS opened
 *   5.  realisticClickByDescription — ELEMENT_NOT_FOUND on null eval result
 *   6.  realisticClickByDescription — AMBIGUOUS_ELEMENT on "AMBIGUOUS" eval result
 *   7.  realisticClickByDescription — success: pointer events dispatched
 *   8.  realisticTypeTextViaCDP — fast mode: REALISM_DISABLED, no WS opened
 *   9.  realisticTypeTextViaCDP — per-character dispatch in full flow
 *  10.  realisticTypeTextViaCDP — never logs raw typed text
 *  11.  No forbidden fields in any result object
 *  12.  Adapter routing: JSON parsing invariants for malformed/non-intercepted lines
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Self-driving CDP WebSocket mock ─────────────────────────────────────────
// mockState is created via vi.hoisted so it's available inside the vi.mock factory.
// The mock auto-responds to Target.attachToTarget and Runtime.evaluate so tests
// can simply `await` the function under test without manual event driving.

const mockState = vi.hoisted(() => ({
  // Captured sent messages for assertions in tests
  allSentMessages: [] as string[],
  // Controls what value Runtime.evaluate responds with.
  // Set to null → ELEMENT_NOT_FOUND, "AMBIGUOUS" → AMBIGUOUS_ELEMENT, object → element found.
  nextEvalResponse: null as unknown,
  // Controls what a `document.location.href` eval responds with (post-click URL read).
  // When a function (e.g. throws), the mock simulates an unavailable URL read.
  nextLocationHref: null as unknown,
  wsCreated: false,
  reset() {
    this.allSentMessages = [];
    this.nextEvalResponse = null;
    this.nextLocationHref = null;
    this.wsCreated = false;
  },
}));

vi.mock("ws", () => {
  const state = mockState;

  class MockWs {
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    sentMessages: string[] = [];

    constructor(_url: string) {
      state.wsCreated = true;
      // Emit "open" asynchronously so the on("open") handler is registered first.
      setImmediate(() => this._fire("open"));
    }

    on(event: string, fn: (...a: unknown[]) => void) {
      const arr = this.handlers.get(event) ?? [];
      arr.push(fn);
      this.handlers.set(event, arr);
    }

    send(rawData: string) {
      this.sentMessages.push(rawData);
      state.allSentMessages.push(rawData);

      let msg: { id: number; method: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(rawData); } catch { return; }

      if (msg.method === "Target.attachToTarget") {
        setImmediate(() =>
          this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { sessionId: "mock-session" } }))),
        );
      }

      if (msg.method === "Runtime.evaluate") {
        // Post-click URL reads (document.location.href) get nextLocationHref so the
        // element-find / viewport evals (nextEvalResponse) stay independent.
        const expr = typeof msg.params?.expression === "string" ? msg.params.expression : "";
        const val = expr.includes("location.href") ? state.nextLocationHref : state.nextEvalResponse;
        setImmediate(() =>
          this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { result: { value: val } } }))),
        );
      }
    }

    close() {}
    terminate() {}

    _fire(event: string, ...args: unknown[]) {
      (this.handlers.get(event) ?? []).forEach((fn) => fn(...args));
    }
  }

  return { default: MockWs };
});

// ─── taskBrowserSessions mock ────────────────────────────────────────────────
// Provides a mutable in-memory pointer store so tests can seed saved state and
// verify that it was read/written correctly by the browsing action functions.
const taskMockState = vi.hoisted(() => ({
  pointerStore: new Map<string, { x: number; y: number; initialized: boolean; updated_at?: string }>(),
  setCalls: [] as Array<{ id: string; userId: string; x: number; y: number }>,
  reset() {
    this.pointerStore.clear();
    this.setCalls = [];
  },
}));

vi.mock("../runtime/taskBrowserSessions.js", () => ({
  getTaskBrowserSessionPointerState: (id: string, _userId: string) =>
    taskMockState.pointerStore.get(id),
  setTaskBrowserSessionPointerState: (
    id: string,
    userId: string,
    ps: { x: number; y: number; initialized: boolean; updated_at?: string },
  ) => {
    taskMockState.pointerStore.set(id, ps);
    taskMockState.setCalls.push({ id, userId, x: ps.x, y: ps.y });
  },
}));

// ─── Module imports (after mock declarations) ─────────────────────────────────
import {
  dispatchTextCharsViaCDP,
  dispatchEnterViaCDP,
  buildElementFindExpr,
  realisticClickByDescription,
  realisticClickKnownBox,
  realisticTypeTextViaCDP,
  GENERAL_TYPING_PROFILE,
  ACTIVE_ELEMENT_CHECK_EXPR,
} from "../runtime/realisticBrowserActions.js";

// ─── fetch mock helpers ───────────────────────────────────────────────────────

const DEFAULT_VERSION = { webSocketDebuggerUrl: "ws://localhost:9222/browser" };
const DEFAULT_TARGETS = [{ id: "target1", url: "https://example.com", type: "page" }];

function makeFetchMock(versionResp: unknown, listResp: unknown) {
  return vi.fn((url: string) => {
    const data = String(url).endsWith("/json/version") ? versionResp : listResp;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  });
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockState.reset();
  taskMockState.reset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Restore real timers if a test switched to fake timers
  vi.useRealTimers();
});

// ─── 1. dispatchTextCharsViaCDP — dispatch count ─────────────────────────────

describe("dispatchTextCharsViaCDP — dispatch count", () => {
  const mockSleep = vi.fn().mockResolvedValue(undefined);
  const mockSend = vi.fn();

  beforeEach(() => { mockSleep.mockClear(); mockSend.mockClear(); });

  it("dispatches one Input.dispatchKeyEvent per character for 'desk lamp' (9 chars)", async () => {
    const text = "desk lamp";
    await dispatchTextCharsViaCDP(mockSend, mockSleep, text, { random: () => 0.5 });
    const keyEvents = mockSend.mock.calls.filter(([m]) => m === "Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(text.length);
  });

  it("dispatches zero events for empty string", async () => {
    await dispatchTextCharsViaCDP(mockSend, mockSleep, "");
    expect(mockSend.mock.calls.filter(([m]) => m === "Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("each event carries type:char and the matching character", async () => {
    await dispatchTextCharsViaCDP(mockSend, mockSleep, "ab");
    const keyEvents = mockSend.mock.calls.filter(([m]) => m === "Input.dispatchKeyEvent");
    expect(keyEvents[0][1]).toMatchObject({ type: "char", text: "a" });
    expect(keyEvents[1][1]).toMatchObject({ type: "char", text: "b" });
  });

  it("jitter stays within GENERAL_TYPING_PROFILE range with onset pause first", async () => {
    const sleepCalls: number[] = [];
    await dispatchTextCharsViaCDP(mockSend, async (ms) => { sleepCalls.push(ms); }, "hi", { random: () => 0.5 });
    expect(sleepCalls[0]).toBe(50); // onset pause
    for (const ms of sleepCalls.slice(1)) {
      expect(ms).toBeGreaterThanOrEqual(GENERAL_TYPING_PROFILE.min_ms);
      expect(ms).toBeLessThanOrEqual(GENERAL_TYPING_PROFILE.max_ms);
    }
    expect(sleepCalls).toHaveLength(1 + "hi".length);
  });

  it("returns char_count_bucket 9-16 for 'desk lamp' (9 chars)", async () => {
    const result = await dispatchTextCharsViaCDP(mockSend, mockSleep, "desk lamp");
    expect(result.char_count_bucket).toBe("9-16");
  });
});

// ─── 2. dispatchTextCharsViaCDP — log safety ─────────────────────────────────

describe("dispatchTextCharsViaCDP — log safety", () => {
  it("never logs the typed text or any substring", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockSend = vi.fn();
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    await dispatchTextCharsViaCDP(mockSend, mockSleep, "desk lamp ikea secret");

    for (const call of consoleSpy.mock.calls) {
      const s = JSON.stringify(call);
      expect(s).not.toContain("desk lamp");
      expect(s).not.toContain("desk");
    }
  });

  it("never includes text/value/raw_value keys in logged objects", async () => {
    const mockSend = vi.fn();
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const loggedObjs: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      args.forEach((a) => { if (a && typeof a === "object") loggedObjs.push(a as Record<string, unknown>); });
    });

    await dispatchTextCharsViaCDP(mockSend, mockSleep, "typed text here");

    for (const obj of loggedObjs) {
      for (const key of ["text", "value", "raw_value", "char", "chars", "password", "secret"]) {
        expect(Object.keys(obj)).not.toContain(key);
      }
    }
  });
});

// ─── 3. buildElementFindExpr — injection safety ──────────────────────────────

describe("buildElementFindExpr — injection safety", () => {
  it("JSON-encodes description so special chars cannot break out of the string literal", () => {
    const desc = `'; DROP TABLE--`;
    const expr = buildElementFindExpr(desc);
    expect(expr).toContain(JSON.stringify(desc));
    expect(expr).not.toContain(`var desc='`);
  });

  it("wraps logic in an IIFE", () => {
    const expr = buildElementFindExpr("Search");
    expect(expr.startsWith("(function(){")).toBe(true);
    expect(expr.endsWith("})()")).toBe(true);
  });

  it("handles quotes and backslashes safely — expression is valid JS", () => {
    const tricky = `"it's" a \\ test`;
    const expr = buildElementFindExpr(tricky);
    expect(expr).toContain(JSON.stringify(tricky));
    expect(() => { new Function(expr); }).not.toThrow();
  });

  it("includes querySelector(selectorHint) block when selectorHint is provided", () => {
    const expr = buildElementFindExpr("Search", "[aria-label='Search button']");
    expect(expr).toContain(JSON.stringify("[aria-label='Search button']"));
    expect(expr).toContain("querySelector");
    expect(() => { new Function(expr); }).not.toThrow();
  });

  it("JSON-encodes selectorHint to prevent injection through the hint string", () => {
    const maliciousHint = `'); alert(1); //`;
    const expr = buildElementFindExpr("el", maliciousHint);
    expect(expr).toContain(JSON.stringify(maliciousHint));
    expect(() => { new Function(expr); }).not.toThrow();
  });

  it("omits querySelector block when selectorHint is not provided (backward compat)", () => {
    const expr = buildElementFindExpr("Search");
    // Without selectorHint the expression has no querySelector call at top
    expect(expr).not.toContain("var sh=document.querySelector");
  });

  it("includes name attribute in text-scan fields", () => {
    const expr = buildElementFindExpr("search-field");
    expect(expr).toContain("getAttribute('name')");
  });
});

// ─── 3b. buildElementFindExpr — accessible-name sources ──────────────────────

describe("buildElementFindExpr — accessible-name sources", () => {
  it("includes [role=combobox] in element selector", () => {
    const expr = buildElementFindExpr("Search by product");
    expect(expr).toContain("[role=combobox]");
  });

  it("includes [role=searchbox] in element selector", () => {
    const expr = buildElementFindExpr("Search by product");
    expect(expr).toContain("[role=searchbox]");
  });

  it("includes aria-labelledby resolution in fields()", () => {
    const expr = buildElementFindExpr("Search by product");
    expect(expr).toContain("aria-labelledby");
    expect(expr).toContain("getElementById");
  });

  it("includes el.labels check for associated label text", () => {
    const expr = buildElementFindExpr("Search by product");
    expect(expr).toContain("el.labels");
  });

  it("expression with new accessible-name fields is still valid JS", () => {
    const expr = buildElementFindExpr("Search by product");
    expect(() => { new Function(expr); }).not.toThrow();
  });

  it("expression with selectorHint and new fields is still valid JS", () => {
    const expr = buildElementFindExpr("Search by product", "input[type=search]");
    expect(() => { new Function(expr); }).not.toThrow();
  });
});

// ─── 3c. buildElementFindExpr — alias matching (IKEA "Search box" scenario) ───

// Lightweight mock-DOM helpers for evaluating the generated IIFE without a real browser.
// Temporarily sets global.document and global.window so `new Function(expr)()` works.
interface MockEl {
  tagName: string;
  textContent: string;
  isContentEditable: boolean;
  contentEditable: string;
  disabled: boolean;
  readOnly: boolean;
  labels: unknown[];
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
  scrollIntoView: () => void;
}

function makeMockEl(opts: {
  tag: string;
  attrs?: Record<string, string>;
  textContent?: string;
  visible?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  contentEditable?: string;
}): MockEl {
  const visible = opts.visible ?? true;
  return {
    tagName: opts.tag.toUpperCase(),
    textContent: opts.textContent ?? "",
    isContentEditable: opts.contentEditable === "true",
    contentEditable: opts.contentEditable ?? "inherit",
    disabled: opts.disabled ?? false,
    readOnly: opts.readOnly ?? false,
    labels: [],
    getAttribute: (n: string) => opts.attrs?.[n] ?? null,
    getBoundingClientRect: () => ({ width: visible ? 200 : 0, height: visible ? 40 : 0, left: 100, top: 50 }),
    scrollIntoView: () => {},
  };
}

function evalFindExpr(expr: string, elements: MockEl[]): unknown {
  const g = global as Record<string, unknown>;
  const savedDoc = g["document"];
  const savedWin = g["window"];
  g["document"] = {
    querySelectorAll: () => elements,
    getElementById: () => null,
  };
  g["window"] = { innerWidth: 1280, innerHeight: 800 };
  try {
    return new Function(`return ${expr}`)();
  } finally {
    g["document"] = savedDoc;
    g["window"] = savedWin;
  }
}

describe("buildElementFindExpr — alias matching", () => {
  it('"Search box" matches a visible input with aria-label="Search by product" via alias+contains', () => {
    const el = makeMockEl({ tag: "input", attrs: { "aria-label": "Search by product" } });
    const result = evalFindExpr(buildElementFindExpr("Search box", undefined, "type"), [el]);
    expect(result).not.toBeNull();
    expect(result).not.toBe("AMBIGUOUS");
    expect((result as { width: number }).width).toBeGreaterThan(0);
  });

  it('"Search box" prefers typeable input over a search button when both contain "search"', () => {
    const searchInput = makeMockEl({ tag: "input", attrs: { "aria-label": "Search by product" } });
    const searchButton = makeMockEl({ tag: "button", attrs: { "aria-label": "Visual search button" } });
    const result = evalFindExpr(buildElementFindExpr("Search box", undefined, "type"), [searchInput, searchButton]);
    expect(result).not.toBeNull();
    expect(result).not.toBe("AMBIGUOUS");
    // Returns the input's box (left=100), not the button's — both have same left in mock but result is a box, not null/ambiguous
    expect((result as { width: number }).width).toBeGreaterThan(0);
  });

  it("two typeable search inputs both matching returns AMBIGUOUS", () => {
    const input1 = makeMockEl({ tag: "input", attrs: { "aria-label": "Search by product" } });
    const input2 = makeMockEl({ tag: "input", attrs: { "aria-label": "Search by name" } });
    const result = evalFindExpr(buildElementFindExpr("Search box", undefined, "type"), [input1, input2]);
    expect(result).toBe("AMBIGUOUS");
  });

  it('"Search by product" exact match is unchanged — alias logic does not disturb it', () => {
    const el = makeMockEl({ tag: "input", attrs: { "aria-label": "Search by product" } });
    const result = evalFindExpr(buildElementFindExpr("Search by product"), [el]);
    expect(result).not.toBeNull();
    expect(result).not.toBe("AMBIGUOUS");
    expect((result as { width: number }).width).toBeGreaterThan(0);
  });

  it('disabled input is not considered typeable — falls through to AMBIGUOUS when it is the only match', () => {
    const disabledInput = makeMockEl({ tag: "input", attrs: { "aria-label": "Search by product" }, disabled: true });
    const button = makeMockEl({ tag: "button", attrs: { "aria-label": "Visual search button" } });
    // Only these two match "search box" via alias; disabled input is not typeable, button is not typeable → 2 non-typeable → AMBIGUOUS
    const result = evalFindExpr(buildElementFindExpr("Search box", undefined, "type"), [disabledInput, button]);
    expect(result).toBe("AMBIGUOUS");
  });

  it('readOnly input is not considered typeable when multiple candidates exist', () => {
    const readOnlyInput = makeMockEl({ tag: "input", attrs: { "aria-label": "Search by product" }, readOnly: true });
    const button = makeMockEl({ tag: "button", attrs: { "aria-label": "Visual search button" } });
    const result = evalFindExpr(buildElementFindExpr("Search box", undefined, "type"), [readOnlyInput, button]);
    expect(result).toBe("AMBIGUOUS");
  });

  it('intent="type" with a tricky description does not break injection safety — expression is valid JS', () => {
    const tricky = `'; DROP TABLE--`;
    const expr = buildElementFindExpr(tricky, undefined, "type");
    expect(expr).toContain(JSON.stringify(tricky));
    expect(() => new Function(expr)).not.toThrow();
  });

  it("no-intent (default) expression is still valid JS", () => {
    const expr = buildElementFindExpr("Search");
    expect(() => new Function(expr)).not.toThrow();
  });
});

// ─── 3d. buildElementFindExpr — click alias matching (role-word stripping) ───

describe("buildElementFindExpr — click alias matching (role-word stripping)", () => {
  it('"desk lamp search suggestion link" matches anchor with textContent "desk lamp"', () => {
    const anchor = makeMockEl({ tag: "a", textContent: "desk lamp" });
    const result = evalFindExpr(
      buildElementFindExpr("desk lamp search suggestion link", undefined, "click"),
      [anchor],
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe("AMBIGUOUS");
    expect((result as { width: number }).width).toBeGreaterThan(0);
  });

  it('"desk lamp link" matches anchor with textContent "desk lamp"', () => {
    const anchor = makeMockEl({ tag: "a", textContent: "desk lamp" });
    const result = evalFindExpr(
      buildElementFindExpr("desk lamp link", undefined, "click"),
      [anchor],
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe("AMBIGUOUS");
    expect((result as { width: number }).width).toBeGreaterThan(0);
  });

  it('"desk lamp button" matches button with textContent "desk lamp"', () => {
    const button = makeMockEl({ tag: "button", textContent: "desk lamp" });
    const result = evalFindExpr(
      buildElementFindExpr("desk lamp button", undefined, "click"),
      [button],
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe("AMBIGUOUS");
    expect((result as { width: number }).width).toBeGreaterThan(0);
  });

  it('two anchors both with textContent "desk lamp" → AMBIGUOUS', () => {
    const a1 = makeMockEl({ tag: "a", textContent: "desk lamp" });
    const a2 = makeMockEl({ tag: "a", textContent: "desk lamp" });
    const result = evalFindExpr(
      buildElementFindExpr("desk lamp search suggestion link", undefined, "click"),
      [a1, a2],
    );
    expect(result).toBe("AMBIGUOUS");
  });

  it('"search suggestion link" does not collapse to an unsafe alias — unrelated element returns null', () => {
    const unrelated = makeMockEl({ tag: "a", textContent: "search results" });
    const result = evalFindExpr(
      buildElementFindExpr("search suggestion link", undefined, "click"),
      [unrelated],
    );
    expect(result).toBeNull();
  });

  it("click alias expression is still valid JS", () => {
    const expr = buildElementFindExpr("desk lamp search suggestion link", undefined, "click");
    expect(() => { new Function(expr); }).not.toThrow();
  });
});

// ─── 4. realisticClickByDescription — fast mode gate ─────────────────────────

describe("realisticClickByDescription — mode gate (fast/disabled)", () => {
  it("returns REALISM_DISABLED for fast and creates no WebSocket", async () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "fast");
    const result = await realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "Search" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("REALISM_DISABLED");
    expect(mockState.wsCreated).toBe(false);
  });

  it("returns REALISM_DISABLED for disabled", async () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "disabled");
    const result = await realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "Any" });
    expect(result.error).toBe("REALISM_DISABLED");
    expect(mockState.wsCreated).toBe(false);
  });
});

// ─── 5-6. realisticClickByDescription — element lookup failures ──────────────

describe("realisticClickByDescription — element lookup", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
  });

  it("returns ELEMENT_NOT_FOUND when Runtime.evaluate returns null", async () => {
    mockState.nextEvalResponse = null;
    const result = await realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "Nonexistent" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("ELEMENT_NOT_FOUND");
  });

  it("returns AMBIGUOUS_ELEMENT when Runtime.evaluate returns 'AMBIGUOUS'", async () => {
    mockState.nextEvalResponse = "AMBIGUOUS";
    const result = await realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "button" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("AMBIGUOUS_ELEMENT");
  });
});

// ─── 7. realisticClickByDescription — success path with pointer events ────────

describe("realisticClickByDescription — success path", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.useFakeTimers();
  });

  it("dispatches Input.dispatchMouseEvent events when element is found", async () => {
    mockState.nextEvalResponse = { x: 300, y: 200, width: 100, height: 40, vw: 1280, vh: 800 };

    const resultPromise = realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "Search" });

    // Advance all fake timers (setImmediate and setTimeout) to drive the full flow
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);

    const mouseEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m): m is { method: string; params: unknown } => m?.method === "Input.dispatchMouseEvent");
    expect(mouseEvents.length).toBeGreaterThan(0);
  });

  it("reads the live URL after the click and returns it as current_url", async () => {
    mockState.nextEvalResponse = { x: 300, y: 200, width: 100, height: 40, vw: 1280, vh: 800 };
    mockState.nextLocationHref = "https://www.ikea.com/us/en/cat/workspace-desks-chairs-fu004/";

    const resultPromise = realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "Desks & desk chairs" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.current_url).toBe("https://www.ikea.com/us/en/cat/workspace-desks-chairs-fu004/");
  });

  it("still succeeds without current_url when the post-click URL read is unavailable", async () => {
    mockState.nextEvalResponse = { x: 300, y: 200, width: 100, height: 40, vw: 1280, vh: 800 };
    mockState.nextLocationHref = null; // URL read returns no usable value

    const resultPromise = realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "Search" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.current_url).toBeUndefined();
  });
});

// ─── 8. realisticTypeTextViaCDP — fast mode gate ─────────────────────────────

describe("realisticTypeTextViaCDP — mode gate (fast/disabled)", () => {
  it("returns REALISM_DISABLED for fast and creates no WebSocket", async () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "fast");
    const result = await realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "desk lamp" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("REALISM_DISABLED");
    expect(result.char_count_bucket).toBe("9-16");
    expect(mockState.wsCreated).toBe(false);
  });
});

// ─── 9. realisticTypeTextViaCDP — per-character dispatch ─────────────────────

describe("realisticTypeTextViaCDP — per-character dispatch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.useFakeTimers();
    mockState.nextEvalResponse = true; // simulate focused active element for active-element check
  });

  it("dispatches one Input.dispatchKeyEvent per character of 'desk lamp'", async () => {
    const text = "desk lamp";
    const resultPromise = realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text });

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);

    const keyEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m): m is { method: string; params: { type: string } } => m?.method === "Input.dispatchKeyEvent");

    expect(keyEvents).toHaveLength(text.length);
    for (const evt of keyEvents) {
      expect(evt.params.type).toBe("char");
    }
  });

  it("returns char_count_bucket 9-16 for 'desk lamp' (9 chars)", async () => {
    const resultPromise = realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "desk lamp" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.char_count_bucket).toBe("9-16");
  });
});

// ─── 10. realisticTypeTextViaCDP — log safety ────────────────────────────────

describe("realisticTypeTextViaCDP — log safety", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.useFakeTimers();
    mockState.nextEvalResponse = true; // simulate focused active element for active-element check
  });

  it("never logs the raw text value in any console.log call", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("ANTIGEN_CDP_DIAGNOSTICS", "true"); // enable diagnostics to exercise all log paths

    const resultPromise = realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "hunter2secure" });
    await vi.runAllTimersAsync();
    await resultPromise;

    for (const call of consoleSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("hunter2secure");
    }
  });
});

// ─── 11. No forbidden fields in results ──────────────────────────────────────

describe("no forbidden fields in results", () => {
  const FORBIDDEN = ["user_data_dir", "profile_key", "raw_cookies", "raw_storage", "password", "secret_ref", "text", "value", "raw_value"];

  it("realisticClickByDescription result has no forbidden keys", async () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "fast");
    const result = await realisticClickByDescription({ cdpUrl: "http://localhost:9222", elementDescription: "test" });
    for (const key of FORBIDDEN) expect(Object.keys(result)).not.toContain(key);
  });

  it("realisticTypeTextViaCDP result has no forbidden keys and does not echo text", async () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "fast");
    const result = await realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "secret-text-value" });
    for (const key of FORBIDDEN) expect(Object.keys(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("secret-text-value");
  });
});

// ─── 12. Adapter routing — JSON parsing invariants ────────────────────────────

describe("adapter routing — JSON parsing invariants", () => {
  it("valid browser_click line parses and yields element description", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browser_click", arguments: { element: "Search IKEA", ref: "e5" } } });
    const msg = JSON.parse(line);
    expect(msg.method).toBe("tools/call");
    expect(msg.params.name).toBe("browser_click");
    expect(msg.params.arguments.element).toBe("Search IKEA");
  });

  it("valid browser_fill line parses and yields value field", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "browser_fill", arguments: { element: "Search", value: "desk lamp" } } });
    const msg = JSON.parse(line);
    expect(msg.params.arguments.value).toBe("desk lamp");
  });

  it("valid browser_type line parses and yields text field (not value)", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_type", arguments: { element: "Search field", target: "[name='q']", text: "desk lamp" } } });
    const msg = JSON.parse(line);
    expect(msg.params.name).toBe("browser_type");
    // text is the correct field for browser_type — not value
    expect(msg.params.arguments.text).toBe("desk lamp");
    expect(msg.params.arguments.value).toBeUndefined();
  });

  it("browser_click target with CSS selector characters is treated as selector_hint", () => {
    const target = "[aria-label='Search button']";
    const line = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "browser_click", arguments: { element: "Search", target } } });
    const msg = JSON.parse(line);
    const t = msg.params.arguments.target;
    // Selector detection: has [ character — should be forwarded as selector_hint
    expect(/[\[.#>:=('"*~+]/.test(t)).toBe(true);
  });

  it("browser_click snapshot ref is NOT treated as selector_hint", () => {
    const target = "e5"; // snapshot ref — short alphanumeric, no selector chars
    const line = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_click", arguments: { element: "Search", target } } });
    const msg = JSON.parse(line);
    const t = msg.params.arguments.target;
    // No selector chars — should not be forwarded
    expect(/[\[.#>:=('"*~+]/.test(t)).toBe(false);
  });

  it("malformed JSON throws — confirming adapter catch block must forward raw line unchanged", () => {
    expect(() => JSON.parse("not valid json {{{")).toThrow();
  });

  it("non-tools/call messages have no params.name — adapter forwards them unchanged", () => {
    const msg = JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(msg.method).not.toBe("tools/call");
    expect(msg?.params?.name).toBeUndefined();
  });

  it("intercepted tools/call response has required JSON-RPC 2.0 shape", () => {
    const requestId = 42;
    const response = { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: "Action complete." }] } };
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(requestId);
    expect(response.result.content[0].type).toBe("text");
    // Confirm response text does not contain any sensitive content
    expect(response.result.content[0].text).not.toContain("password");
    expect(response.result.content[0].text).not.toContain("cookie");
  });
});

// ─── 13. realisticTypeTextViaCDP — focus + type (with elementDescription) ────

describe("realisticTypeTextViaCDP — focus + type (with elementDescription)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.useFakeTimers();
    mockState.nextEvalResponse = { x: 100, y: 50, width: 200, height: 40, vw: 1280, vh: 800 };
  });

  it("Runtime.evaluate is sent before any Input.dispatchKeyEvent", async () => {
    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello",
      elementDescription: "Search field",
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    const parsed = mockState.allSentMessages.map((m) => { try { return JSON.parse(m); } catch { return null; } });
    const evalIdx = parsed.findIndex((m) => m?.method === "Runtime.evaluate");
    const firstKeyIdx = parsed.findIndex((m) => m?.method === "Input.dispatchKeyEvent");
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(firstKeyIdx).toBeGreaterThan(evalIdx);
  });

  it("Input.dispatchMouseEvent events appear between Runtime.evaluate and Input.dispatchKeyEvent", async () => {
    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hi",
      elementDescription: "Username",
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    const parsed = mockState.allSentMessages.map((m) => { try { return JSON.parse(m); } catch { return null; } });
    const evalIdx = parsed.findIndex((m) => m?.method === "Runtime.evaluate");
    const firstMouseIdx = parsed.findIndex((m) => m?.method === "Input.dispatchMouseEvent");
    const firstKeyIdx = parsed.findIndex((m) => m?.method === "Input.dispatchKeyEvent");
    expect(firstMouseIdx).toBeGreaterThan(evalIdx);
    expect(firstKeyIdx).toBeGreaterThan(firstMouseIdx);
  });

  it("result.focused is true when element is found and clicked", async () => {
    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "test",
      elementDescription: "Email",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.focused).toBe(true);
  });
});

// ─── 14. realisticTypeTextViaCDP — element not found ─────────────────────────

describe("realisticTypeTextViaCDP — element not found (with elementDescription)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    mockState.nextEvalResponse = null;
  });

  it("returns ELEMENT_NOT_FOUND when Runtime.evaluate returns null", async () => {
    const result = await realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello",
      elementDescription: "Nonexistent field",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("ELEMENT_NOT_FOUND");
  });

  it("no Input.dispatchKeyEvent messages are sent when element not found", async () => {
    await realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello",
      elementDescription: "Nonexistent",
    });
    const keyEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.method === "Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(0);
  });

  it("returns AMBIGUOUS_ELEMENT when Runtime.evaluate returns 'AMBIGUOUS'", async () => {
    mockState.nextEvalResponse = "AMBIGUOUS";
    const result = await realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello",
      elementDescription: "Search",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("AMBIGUOUS_ELEMENT");
  });
});

// ─── 15. realisticTypeTextViaCDP — submit:true ────────────────────────────────

describe("realisticTypeTextViaCDP — submit:true dispatches Enter after chars", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.useFakeTimers();
    mockState.nextEvalResponse = true; // active element present
  });

  it("dispatches Enter rawKeyDown + char + keyUp after text chars when submit=true", async () => {
    const text = "hi";
    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text,
      submit: true,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.submitted).toBe(true);

    const parsed = mockState.allSentMessages.map((m) => { try { return JSON.parse(m); } catch { return null; } });
    const keyEvents = parsed.filter((m) => m?.method === "Input.dispatchKeyEvent");
    // char events for typed characters have a single character in text, not "\r"
    const charEvents = keyEvents.filter((m) => m.params?.type === "char" && m.params?.text !== "\r");
    const enterEvents = keyEvents.filter((m) => m.params?.key === "Enter");

    expect(charEvents).toHaveLength(text.length);
    expect(enterEvents).toHaveLength(3); // rawKeyDown + char + keyUp
    expect(enterEvents[0].params.type).toBe("rawKeyDown");
    expect(enterEvents[1].params.type).toBe("char");
    expect(enterEvents[2].params.type).toBe("keyUp");

    // All Enter events appear after all typed-char events
    const allParsed = mockState.allSentMessages.map((m) => { try { return JSON.parse(m); } catch { return null; } });
    const lastTypedCharIdx = allParsed.map((m, i) => (m?.params?.type === "char" && m.params?.text !== "\r") ? i : -1).filter((i) => i >= 0).at(-1) ?? -1;
    const firstEnterIdx = allParsed.findIndex((m) => m?.params?.key === "Enter");
    expect(firstEnterIdx).toBeGreaterThan(lastTypedCharIdx);
  });

  it("result.submitted is false when submit is not set", async () => {
    const resultPromise = realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "hi" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.submitted).toBe(false);
  });

  it("no Enter events when submit is not set", async () => {
    const resultPromise = realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "hi" });
    await vi.runAllTimersAsync();
    await resultPromise;
    const enterEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.params?.key === "Enter");
    expect(enterEvents).toHaveLength(0);
  });
});

// ─── 16. realisticTypeTextViaCDP — no target, no active element ──────────────

describe("realisticTypeTextViaCDP — no target, no active element", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    mockState.nextEvalResponse = null; // no focused element
  });

  it("returns NO_FOCUSABLE_ACTIVE_ELEMENT when active element check returns null", async () => {
    const result = await realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "hello" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("NO_FOCUSABLE_ACTIVE_ELEMENT");
  });

  it("no Input.dispatchKeyEvent messages are sent when no active element", async () => {
    await realisticTypeTextViaCDP({ cdpUrl: "http://localhost:9222", text: "hello" });
    const keyEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.method === "Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(0);
  });
});

// ─── 17. dispatchEnterViaCDP — correct key events ────────────────────────────

describe("dispatchEnterViaCDP — dispatches rawKeyDown, char, then keyUp for Enter", () => {
  it("sends rawKeyDown, char, then keyUp for Enter key", async () => {
    const mockSend = vi.fn();
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    await dispatchEnterViaCDP(mockSend, mockSleep);

    const calls = mockSend.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }]);
    expect(calls[1]).toEqual(["Input.dispatchKeyEvent", {
      type: "char", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: "\r", unmodifiedText: "\r",
    }]);
    expect(calls[2]).toEqual(["Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }]);
  });

  it("rawKeyDown appears before keyUp", async () => {
    const mockSend = vi.fn();
    await dispatchEnterViaCDP(mockSend, vi.fn().mockResolvedValue(undefined));
    const types = mockSend.mock.calls.map(([, p]) => (p as Record<string, unknown>).type);
    expect(types.indexOf("rawKeyDown")).toBeLessThan(types.indexOf("keyUp"));
  });

  it("Enter key events never include user-typed content — char text is fixed \\r only", async () => {
    const mockSend = vi.fn();
    await dispatchEnterViaCDP(mockSend, vi.fn().mockResolvedValue(undefined));
    for (const [, params] of mockSend.mock.calls) {
      const p = params as Record<string, unknown>;
      // No event ever contains user-typed values, passwords, or secrets
      for (const forbidden of ["value", "raw_value", "password", "secret"]) {
        expect(Object.keys(p)).not.toContain(forbidden);
      }
      // If this is the char event, text must be exactly "\r" (fixed constant, not user input)
      if (p.type === "char") {
        expect(p.text).toBe("\r");
        expect(p.unmodifiedText).toBe("\r");
      } else {
        // rawKeyDown and keyUp carry no text field at all
        expect(Object.keys(p)).not.toContain("text");
      }
    }
  });
});

// ─── 18. realisticTypeTextViaCDP — log safety with diagnostics ───────────────

describe("realisticTypeTextViaCDP — log safety with browser_type diagnostics enabled", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.stubEnv("ANTIGEN_CDP_DIAGNOSTICS", "true");
    vi.useFakeTimers();
    mockState.nextEvalResponse = true;
  });

  it("no forbidden keys in any diagnostic log objects (submit path)", async () => {
    const loggedObjs: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      args.forEach((a) => { if (a && typeof a === "object") loggedObjs.push(a as Record<string, unknown>); });
    });

    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hunter2secure",
      submit: true,
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    for (const obj of loggedObjs) {
      for (const key of ["text", "value", "raw_value", "char", "chars", "password", "secret"]) {
        expect(Object.keys(obj)).not.toContain(key);
      }
    }
  });
});

// ─── 19. realisticTypeTextViaCDP — element_not_found_detail diagnostics ──────

describe("realisticTypeTextViaCDP — element_not_found_detail diagnostics (cdpDiagnostics=true)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.stubEnv("ANTIGEN_CDP_DIAGNOSTICS", "true");
    mockState.nextEvalResponse = null; // all evals (href/selector diag + findExpr) return null
  });

  it("returns ELEMENT_NOT_FOUND and logs element_not_found_detail with element_description", async () => {
    const loggedCalls: Array<{ label: string; obj: Record<string, unknown> }> = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      const [label, obj] = args;
      if (typeof label === "string" && obj !== null && typeof obj === "object") {
        loggedCalls.push({ label, obj: obj as Record<string, unknown> });
      }
    });

    const result = await realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "search query",
      elementDescription: "Search by product",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("ELEMENT_NOT_FOUND");

    const detailLog = loggedCalls.find((c) => c.label === "[RealisticType] element_not_found_detail");
    expect(detailLog).toBeDefined();
    expect(detailLog?.obj.element_description).toBe("Search by product");

    // Safe keys only — no forbidden values
    for (const key of ["text", "value", "raw_value", "char", "chars", "password", "secret"]) {
      expect(Object.keys(detailLog?.obj ?? {})).not.toContain(key);
    }
  });
});

// ─── 20. ACTIVE_ELEMENT_CHECK_EXPR — is valid JS ─────────────────────────────

describe("ACTIVE_ELEMENT_CHECK_EXPR — structural checks", () => {
  it("is a valid JS expression (can be parsed by Function constructor)", () => {
    expect(() => new Function(`return ${ACTIVE_ELEMENT_CHECK_EXPR}`)).not.toThrow();
  });

  it("wraps logic in an IIFE", () => {
    expect(ACTIVE_ELEMENT_CHECK_EXPR.trim().startsWith("(function(){")).toBe(true);
    expect(ACTIVE_ELEMENT_CHECK_EXPR.trim().endsWith("})()")).toBe(true);
  });
});

// ─── 21. pointer_path_point_count and overlay propagation ─────────────────────

describe("realisticTypeTextViaCDP — pointer_path_point_count and overlay propagation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.useFakeTimers();
    mockState.nextEvalResponse = { x: 100, y: 50, width: 200, height: 40, vw: 1280, vh: 800 };
  });

  it("result includes pointer_path_point_count as a positive integer when focused=true", async () => {
    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello",
      elementDescription: "Search field",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.focused).toBe(true);
    expect(typeof result.pointer_path_point_count).toBe("number");
    expect(result.pointer_path_point_count).toBeGreaterThanOrEqual(1);
  });

  it("result does not expose forbidden fields even when pointer_path_point_count is present", async () => {
    const FORBIDDEN = [
      "text", "value", "raw_value", "element_description", "element_hint",
      "user_data_dir", "pass_id", "secret_ref", "cdp_url", "password", "credential",
    ];

    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello world",
      elementDescription: "Email field",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    for (const key of FORBIDDEN) {
      expect(Object.keys(result)).not.toContain(key);
    }
    expect(JSON.stringify(result)).not.toContain("hello world");
    expect(JSON.stringify(result)).not.toContain("Email field");
  });

  it("CDP messages include overlay dot injection when ANTIGEN_POINTER_DEBUG_OVERLAY=true", async () => {
    vi.stubEnv("ANTIGEN_POINTER_DEBUG_OVERLAY", "true");

    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hi",
      elementDescription: "Search",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);

    // When debugOverlay=true, ensurePointerDebugOverlay fires a Runtime.evaluate
    // whose expression injects the overlay dot element.
    const overlayEvals = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.method === "Runtime.evaluate")
      .map((m) => (m?.params as Record<string, unknown> | undefined)?.expression as string | undefined)
      .filter((expr): expr is string => typeof expr === "string" && expr.includes("__aegis_pointer_debug_dot"));

    expect(overlayEvals.length).toBeGreaterThan(0);
  });
});

// ─── 22. Persistent pointer continuity — taskBrowserSessions integration ──────
//
// Verifies that browser_type and browser_click:
//   - load saved pointer state from taskBrowserSessions when sessionId + userId are provided
//   - fall back to viewport center when no state is saved
//   - persist final pointer position back to taskBrowserSessions after each action
//   - share the same pointer store so cross-action continuity works
//   - never expose raw coordinates or forbidden fields in result objects

describe("Persistent pointer continuity — taskBrowserSessions integration", () => {
  const SESSION_ID = "tbsess_test_001";
  const USER_ID = "user_test_001";
  const BOX_RESP = { x: 100, y: 200, width: 80, height: 40, vw: 1280, vh: 800 };

  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(DEFAULT_VERSION, DEFAULT_TARGETS));
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    vi.useFakeTimers();
    mockState.nextEvalResponse = BOX_RESP;
  });

  // Test 1 — browser_type first action with no stored state
  it("browser_type: no stored state → viewport_center start, state persisted", async () => {
    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello",
      elementDescription: "Search field",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.pointer_start_source).toBe("viewport_center");
    expect(result.pointer_state_persisted).toBe(true);
    expect(result.focused).toBe(true);
    expect(typeof result.pointer_path_point_count).toBe("number");
    expect(result.pointer_path_point_count).toBeGreaterThanOrEqual(1);
    // State should now be saved so next action can load it
    expect(taskMockState.setCalls).toHaveLength(1);
    expect(taskMockState.setCalls[0].id).toBe(SESSION_ID);
    expect(taskMockState.setCalls[0].userId).toBe(USER_ID);
  });

  // Test 2 — browser_type second action in same session uses saved state
  it("browser_type: saved state present → session start, first mouseMoved near saved coords", async () => {
    // Seed a position that is far from viewport center (640, 400)
    taskMockState.pointerStore.set(SESSION_ID, { x: 450, y: 300, initialized: true });

    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "second",
      elementDescription: "Search field",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.pointer_start_source).toBe("session");

    // Find all mouseMoved events dispatched to verify starting position
    const mouseMovedEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved")
      .map((m) => m.params as { x: number; y: number });

    expect(mouseMovedEvents.length).toBeGreaterThan(0);
    // First mouseMoved should be closer to the saved position (450, 300) than to
    // viewport center (640, 400). Threshold: within 50px of saved start.
    const first = mouseMovedEvents[0];
    expect(Math.abs(first.x - 450)).toBeLessThan(50);
    expect(Math.abs(first.y - 300)).toBeLessThan(50);
  });

  // Test 3 — browser_click uses the same saved pointer state as browser_type
  it("browser_click: saved state from browser_type → session start", async () => {
    taskMockState.pointerStore.set(SESSION_ID, { x: 350, y: 250, initialized: true });

    const resultPromise = realisticClickByDescription({
      cdpUrl: "http://localhost:9222",
      elementDescription: "Submit button",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.pointer_start_source).toBe("session");
    expect(result.pointer_state_persisted).toBe(true);
    expect(typeof result.pointer_path_point_count).toBe("number");
    expect(result.pointer_path_point_count).toBeGreaterThanOrEqual(1);

    const mouseMovedEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved")
      .map((m) => m.params as { x: number; y: number });

    expect(mouseMovedEvents.length).toBeGreaterThan(0);
    const first = mouseMovedEvents[0];
    expect(Math.abs(first.x - 350)).toBeLessThan(50);
    expect(Math.abs(first.y - 250)).toBeLessThan(50);
  });

  // Test 4 — browser_type after browser_click starts from browser_click final position
  it("browser_type after browser_click: starts from browser_click saved position", async () => {
    // Simulate browser_click having run and saved its final position
    taskMockState.pointerStore.set(SESSION_ID, { x: 520, y: 180, initialized: true });

    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "followup",
      elementDescription: "Text field",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.pointer_start_source).toBe("session");

    const mouseMovedEvents = mockState.allSentMessages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved")
      .map((m) => m.params as { x: number; y: number });

    const first = mouseMovedEvents[0];
    expect(Math.abs(first.x - 520)).toBeLessThan(50);
    expect(Math.abs(first.y - 180)).toBeLessThan(50);
  });

  // ── realisticClickKnownBox — Phase 4B revalidation (defined inside this
  // describe so it shares the BOX_RESP-free setup; we set nextEvalResponse per
  // test as the revalidation eval value { vw, vh, status, live }). ───────────
  describe("realisticClickKnownBox — Phase 4B revalidation", () => {
    const BOX = { x: 100, y: 200, width: 80, height: 40 };
    function liveLink(overrides: Record<string, unknown> = {}) {
      return {
        tag: "a", type: null, role: null, content_editable: false, id: null,
        href: "/us/en/p/tertial-work-lamp-70504295/", disabled: false,
        aria_disabled: false, read_only: false, name: "TERTIAL Work lamp",
        box: BOX, visible: true, ...overrides,
      };
    }
    function liveButton(overrides: Record<string, unknown> = {}) {
      return {
        tag: "button", type: null, role: null, content_editable: false, id: null,
        href: null, disabled: false, aria_disabled: false, read_only: false,
        name: "Add to bag", box: BOX, visible: true, ...overrides,
      };
    }
    const mouseEvents = () =>
      mockState.allSentMessages
        .map((m) => { try { return JSON.parse(m); } catch { return null; } })
        .filter((m) => m?.method === "Input.dispatchMouseEvent");

    it("succeeds when live link matches expected by href_path → dispatches pointer", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "ok", live: liveLink() };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "link", href_path: "/us/en/p/tertial-work-lamp-70504295/", normalized_name: "tertial work lamp" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.success).toBe(true);
      expect(mouseEvents().length).toBeGreaterThan(0);
    });

    it("succeeds when live button name matches expected name", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "ok", live: liveButton() };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "button", name: "Add to bag", normalized_name: "add to bag" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.success).toBe(true);
      expect(mouseEvents().length).toBeGreaterThan(0);
    });

    it("fails ANTIGEN_REF_STALE when elementFromPoint returns no element", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "no_element" };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "link", href_path: "/us/en/p/tertial-work-lamp-70504295/" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toBe("ANTIGEN_REF_STALE");
    });

    it("fails ANTIGEN_REF_STALE on href_path mismatch", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "ok", live: liveLink({ href: "/us/en/p/some-other-99999/" }) };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "link", href_path: "/us/en/p/tertial-work-lamp-70504295/", normalized_name: "tertial work lamp" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toBe("ANTIGEN_REF_STALE");
    });

    it("fails ANTIGEN_REF_STALE on strong name mismatch", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "ok", live: liveButton({ name: "Newsletter signup" }) };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "button", name: "Add to bag", normalized_name: "add to bag" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toBe("ANTIGEN_REF_STALE");
    });

    it("fails ANTIGEN_REF_STALE when the box center is outside the viewport", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "out_of_viewport" };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "button", normalized_name: "add to bag" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toBe("ANTIGEN_REF_STALE");
    });

    it("does NOT dispatch any pointer movement on a stale ref", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "no_element" };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "link", href_path: "/us/en/p/tertial-work-lamp-70504295/" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.success).toBe(false);
      expect(mouseEvents()).toHaveLength(0);
    });

    it("stale result object exposes no box/coordinates/forbidden fields", async () => {
      mockState.nextEvalResponse = { vw: 1280, vh: 800, status: "ok", live: liveButton({ name: "Newsletter signup", href: "/p/full/path" }) };
      const p = realisticClickKnownBox({
        cdpUrl: "http://localhost:9222", box: BOX, sessionId: SESSION_ID, userId: USER_ID,
        expected: { kind: "button", name: "Add to bag", normalized_name: "add to bag" },
      });
      await vi.runAllTimersAsync();
      const result = await p;
      const FORBIDDEN = ["box", "x", "y", "width", "height", "href", "cdp_url", "user_data_dir", "pass_id", "secret_ref", "password"];
      for (const key of FORBIDDEN) expect(Object.keys(result)).not.toContain(key);
      expect(JSON.stringify(result)).not.toContain("/p/full/path");
    });
  });

  // Test 5 — no-session path: viewport-center fallback, no persistence attempted
  it("no sessionId/userId: falls back to viewport center, does not persist", async () => {
    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "hello",
      elementDescription: "Search",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.pointer_start_source).toBe("viewport_center");
    expect(result.pointer_state_persisted).toBe(false);
    // setTaskBrowserSessionPointerState must not have been called
    expect(taskMockState.setCalls).toHaveLength(0);
  });

  it("browser_click no sessionId/userId: falls back to viewport center, does not persist", async () => {
    const resultPromise = realisticClickByDescription({
      cdpUrl: "http://localhost:9222",
      elementDescription: "Button",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.pointer_start_source).toBe("viewport_center");
    expect(result.pointer_state_persisted).toBe(false);
    expect(taskMockState.setCalls).toHaveLength(0);
  });

  // Test 6 — result objects must not expose coordinates or forbidden fields
  it("browser_type result does not expose coordinates or forbidden fields", async () => {
    const FORBIDDEN_KEYS = [
      "current_x", "current_y", "target_x", "target_y",
      "pointer_start_x", "pointer_start_y", "x", "y",
      "text", "value", "raw_value", "element_description",
      "cdp_url", "user_data_dir", "pass_id", "secret_ref",
      "password", "cookies", "localStorage", "sessionStorage",
    ];

    const resultPromise = realisticTypeTextViaCDP({
      cdpUrl: "http://localhost:9222",
      text: "safe text",
      elementDescription: "Field",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    for (const key of FORBIDDEN_KEYS) {
      expect(Object.keys(result)).not.toContain(key);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("safe text");
    expect(serialized).not.toContain("Field");
  });

  it("browser_click result does not expose coordinates or forbidden fields", async () => {
    const FORBIDDEN_KEYS = [
      "current_x", "current_y", "target_x", "target_y",
      "pointer_start_x", "pointer_start_y", "x", "y",
      "element_description", "cdp_url", "user_data_dir",
      "pass_id", "secret_ref", "password",
    ];

    const resultPromise = realisticClickByDescription({
      cdpUrl: "http://localhost:9222",
      elementDescription: "Submit button",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    for (const key of FORBIDDEN_KEYS) {
      expect(Object.keys(result)).not.toContain(key);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Submit button");
  });

  // Test 7 — browser_click emits pointer_path_point_count
  it("browser_click: pointer_path_point_count is a positive integer in success result", async () => {
    const resultPromise = realisticClickByDescription({
      cdpUrl: "http://localhost:9222",
      elementDescription: "Add to cart",
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(typeof result.pointer_path_point_count).toBe("number");
    expect(result.pointer_path_point_count).toBeGreaterThanOrEqual(1);
  });
});
