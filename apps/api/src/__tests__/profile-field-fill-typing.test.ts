/**
 * Profile field fill — realistic typing contract (self-driving CDP WebSocket mock).
 *
 * Proves that protected PROFILE text fields now enter their value the way a human would —
 * pointer move → focus/clear → ONE CDP key event per character (the shared `typeCharsViaCDP`
 * engine the protected-card primitive uses) → verify → change/blur — instead of a single bulk
 * `Input.insertText`. SELECT fields keep the existing native-setter + selectedIndex commit with
 * NO typing. The raw value never crosses the wire contiguously, nor appears in the returned
 * entries.
 *
 * The mock is phase-aware: the profile state machine sends a fixed sequence of distinct
 * Runtime.evaluate expressions (enumerate → iframe/shape → box → focus/clear → typing-verify →
 * change/blur, or a single select-commit eval). Each is recognized by a stable token. CDP
 * `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` are fire-and-forget (no response). No
 * real browser or CDP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProfileFieldFillRequest, ProfileFieldKind } from "@aegis/types";

const WS_URL = "ws://localhost:9222/browser";
const CDP_BASE = "http://localhost:9222";

// ─── Phase-aware self-driving CDP WebSocket mock ─────────────────────────────

const mockState = vi.hoisted(() => ({
  allSentMessages: [] as string[],
  // Candidate descriptors returned by the enumeration eval (structural metadata only).
  candidates: [] as unknown[],
  // Element shape returned by the iframe/shape check.
  iframeResult: { ok: true, tagName: "INPUT" } as unknown,
  boxResult: {
    ok: true,
    box: { x: 100, y: 200, width: 220, height: 40 },
    viewport: { width: 1280, height: 800 },
  } as unknown,
  focusResult: { ok: true } as unknown,
  // Post-typing verification (el.value.length > 0).
  verifyResult: { ok: true, reason: "value_present" } as unknown,
  selectResult: { ok: true, verified: true } as unknown,
  blurResult: { ok: true } as unknown,
  fallbackResult: { ok: true } as unknown,
  insertTextError: false,
  reset() {
    this.allSentMessages = [];
    this.candidates = [];
    this.iframeResult = { ok: true, tagName: "INPUT" };
    this.boxResult = {
      ok: true,
      box: { x: 100, y: 200, width: 220, height: 40 },
      viewport: { width: 1280, height: 800 },
    };
    this.focusResult = { ok: true };
    this.verifyResult = { ok: true, reason: "value_present" };
    this.selectResult = { ok: true, verified: true };
    this.blurResult = { ok: true };
    this.fallbackResult = { ok: true };
    this.insertTextError = false;
  },
}));

vi.mock("ws", () => {
  const state = mockState;

  function evalValueFor(expr: string): unknown {
    // Enumeration — return the candidate descriptors so TS-side resolution can pick one.
    if (expr.includes("querySelectorAll('input, select, textarea')")) return state.candidates;
    // SELECT commit eval (carries the state/country maps + select_option_not_found token).
    if (expr.includes("select_option_not_found")) return state.selectResult;
    // Iframe/shape guard returns the element tagName.
    if (expr.includes("IFRAME_NOT_SUPPORTED")) return state.iframeResult;
    if (expr.includes("getBoundingClientRect")) return state.boxResult;
    if (expr.includes("deleteContentBackward")) return state.focusResult;
    if (expr.includes("value_present")) return state.verifyResult;
    // Native-setter fallback embeds an `input` event + data-antigen-filled.
    if (expr.includes("data-antigen-filled") && expr.includes("new Event('input'")) return state.fallbackResult;
    // change/blur (no input event).
    if (expr.includes("data-antigen-filled")) return state.blurResult;
    return { ok: true };
  }

  class MockWs {
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    constructor(_url: string) {
      setImmediate(() => this._fire("open"));
    }
    on(event: string, fn: (...a: unknown[]) => void) {
      const arr = this.handlers.get(event) ?? [];
      arr.push(fn);
      this.handlers.set(event, arr);
    }
    send(rawData: string) {
      state.allSentMessages.push(rawData);
      let msg: { id: number; method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(rawData);
      } catch {
        return;
      }

      if (msg.method === "Target.attachToTarget") {
        setImmediate(() =>
          this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { sessionId: "mock-session" } }))),
        );
        return;
      }
      if (msg.method === "Input.insertText") {
        const reply = state.insertTextError
          ? { id: msg.id, error: { code: -32000, message: "insertText unsupported" } }
          : { id: msg.id, result: {} };
        setImmediate(() => this._fire("message", Buffer.from(JSON.stringify(reply))));
        return;
      }
      if (msg.method === "Runtime.evaluate") {
        const expr = typeof msg.params?.expression === "string" ? msg.params.expression : "";
        const value = evalValueFor(expr);
        setImmediate(() =>
          this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { result: { type: "object", value } } }))),
        );
        return;
      }
      // Input.dispatchMouseEvent / Input.dispatchKeyEvent are fire-and-forget — no response.
    }
    close() {}
    terminate() {}
    _fire(event: string, ...args: unknown[]) {
      (this.handlers.get(event) ?? []).forEach((fn) => fn(...args));
    }
  }
  return { default: MockWs };
});

vi.mock("../runtime/taskBrowserSessions.js", () => ({
  getTaskBrowserSessionPointerState: () => undefined,
  setTaskBrowserSessionPointerState: () => {},
}));

import { executeProfileFieldFillViaCDP } from "../runtime/profileFieldFill.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inputCandidate(over: Record<string, unknown> = {}): unknown {
  return {
    fill_id: "agfill_0",
    tag: "input",
    type: "text",
    name: "first_name",
    id: "first_name",
    autocomplete: "given-name",
    placeholder: "",
    label_text: "first name",
    aria_label: "",
    section_text: "",
    maxlength: null,
    pattern: "",
    ...over,
  };
}

function selectCandidate(over: Record<string, unknown> = {}): unknown {
  return {
    fill_id: "agfill_0",
    tag: "select",
    type: "select-one",
    name: "state",
    id: "state",
    autocomplete: "address-level1",
    placeholder: "",
    label_text: "state",
    aria_label: "",
    section_text: "",
    maxlength: null,
    pattern: "",
    ...over,
  };
}

function makeRequest(key: ProfileFieldKind, label: string): ProfileFieldFillRequest {
  return {
    fill_request_id: "pffr_typing_test",
    user_id: "user_demo_001",
    delegation_id: "del_demo_001",
    domain: "shop.test",
    page_url: "https://shop.test/checkout",
    requested_fields: [{ key, label }],
    reason: "typing unit test",
    status: "executing",
    raw_profile_value_revealed_to_agent: false,
    raw_profile_values_revealed_to_agent: false,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  };
}

function sentMessages(): Array<{ method?: string; params?: Record<string, unknown> }> {
  return mockState.allSentMessages.map((m) => {
    try {
      return JSON.parse(m);
    } catch {
      return {};
    }
  });
}
function methodCalls(method: string) {
  return sentMessages().filter((m) => m.method === method);
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/json/version")) {
        return { json: async () => ({ webSocketDebuggerUrl: WS_URL }) } as unknown as Response;
      }
      if (url.endsWith("/json/list")) {
        return {
          json: async () => [{ id: "target-1", url: "https://shop.test/checkout", type: "page" }],
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

beforeEach(() => {
  mockState.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
  vi.stubEnv("ANTIGEN_BROWSER_SLOW_MO_MS", "0");
  vi.stubEnv("ANTIGEN_POINTER_DEBUG_OVERLAY", "");
  stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── 1. Happy INPUT: one key event per character, no bulk insert / setter ─────

describe("profile fill — realistic typing for text fields", () => {
  it("types one CDP key event per character and does NOT call Input.insertText or a native setter", async () => {
    vi.useFakeTimers();
    mockState.candidates = [inputCandidate()];
    const VALUE = "Adalovelace"; // 11 chars

    const p = executeProfileFieldFillViaCDP(makeRequest("first_name", "First name"), new Map([["first_name", VALUE]]), CDP_BASE);
    await vi.runAllTimersAsync();
    const entries = await p;

    expect(entries[0].status).toBe("filled");

    // Exactly one key event per character — the realistic typing path.
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(VALUE.length);
    expect(methodCalls("Input.dispatchKeyEvent").every((m) => m.params?.type === "char")).toBe(true);

    // No bulk insert, and no JSON-embedded native-setter fallback expression.
    expect(methodCalls("Input.insertText")).toHaveLength(0);
    const setterFallbackSent = methodCalls("Runtime.evaluate").some(
      (m) =>
        typeof m.params?.expression === "string" &&
        (m.params.expression as string).includes("new Event('input'") &&
        (m.params.expression as string).includes("data-antigen-filled"),
    );
    expect(setterFallbackSent).toBe(false);
  });

  it("never sends the contiguous raw value over the wire or in the returned entries", async () => {
    vi.useFakeTimers();
    mockState.candidates = [inputCandidate()];
    const VALUE = "Adalovelace";

    const p = executeProfileFieldFillViaCDP(makeRequest("first_name", "First name"), new Map([["first_name", VALUE]]), CDP_BASE);
    await vi.runAllTimersAsync();
    const entries = await p;

    expect(JSON.stringify(mockState.allSentMessages)).not.toContain(VALUE);
    expect(JSON.stringify(entries)).not.toContain(VALUE);
    expect(entries[0].raw_profile_value_revealed_to_agent).toBe(false);
  });

  // ─── 2. SELECT: native commit, zero typing ─────────────────────────────────

  it("commits a SELECT option with NO key events (state/country path unchanged)", async () => {
    vi.useFakeTimers();
    mockState.candidates = [selectCandidate()];
    mockState.iframeResult = { ok: true, tagName: "SELECT" };

    const p = executeProfileFieldFillViaCDP(makeRequest("region", "State"), new Map([["region", "MI"]]), CDP_BASE);
    await vi.runAllTimersAsync();
    const entries = await p;

    expect(entries[0].status).toBe("filled");
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(0);
    expect(methodCalls("Input.insertText")).toHaveLength(0);
  });

  // ─── 3. Kill switch: ANTIGEN_INPUT_REALISM=fast preserves bulk insert ───────

  it("ANTIGEN_INPUT_REALISM=fast falls back to bulk Input.insertText with zero key events", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "fast");
    mockState.candidates = [inputCandidate()];

    const p = executeProfileFieldFillViaCDP(makeRequest("first_name", "First name"), new Map([["first_name", "Ada"]]), CDP_BASE);
    await vi.runAllTimersAsync();
    const entries = await p;

    expect(entries[0].status).toBe("filled");
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(0);
    expect(methodCalls("Input.insertText")).toHaveLength(1);
  });

  // ─── 4. Verify fallback: empty-after-typing → Input.insertText ─────────────

  it("falls back to Input.insertText when the field is empty after key events", async () => {
    vi.useFakeTimers();
    mockState.candidates = [inputCandidate()];
    mockState.verifyResult = { ok: false, reason: "empty_after_typing" };

    const p = executeProfileFieldFillViaCDP(makeRequest("first_name", "First name"), new Map([["first_name", "Ada"]]), CDP_BASE);
    await vi.runAllTimersAsync();
    const entries = await p;

    expect(entries[0].status).toBe("filled");
    // Key events were attempted, then a single bulk insert recovered the fill.
    expect(methodCalls("Input.dispatchKeyEvent").length).toBeGreaterThan(0);
    expect(methodCalls("Input.insertText")).toHaveLength(1);
  });
});
