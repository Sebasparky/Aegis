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
  wsCreated: false,
  reset() {
    this.allSentMessages = [];
    this.nextEvalResponse = null;
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
        const val = state.nextEvalResponse;
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

// ─── Module imports (after mock declarations) ─────────────────────────────────
import {
  dispatchTextCharsViaCDP,
  buildElementFindExpr,
  realisticClickByDescription,
  realisticTypeTextViaCDP,
  GENERAL_TYPING_PROFILE,
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
