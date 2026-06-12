/**
 * Protected Realistic Fill — unit tests (self-driving CDP WebSocket mock).
 *
 * Proves that the shared protected-fill primitive enters a sensitive value through
 * a REALISTIC browser-interaction path (pointer move → click/focus → per-character
 * key events → input/change/blur) rather than an invisible DOM `value` mutation,
 * while never leaking the raw value into the result object, logs, or (on the happy
 * typing path) the CDP wire.
 *
 * The mock is phase-aware: the primitive sends a sequence of distinct Runtime.evaluate
 * expressions (iframe guard → box → focus/clear → typing-verify → mask/blur, or a
 * single select-commit eval). The mock recognizes each by a stable token in the
 * expression and returns the matching `{ ok, ... }` shape. No real browser or CDP.
 *
 * Coverage:
 *   1. Happy INPUT fill dispatches pointer events AND per-character key events,
 *      then masks (for sensitive fields) — NOT a bare setter, NO insertText.
 *   2. Raw value never appears in the result, logs, or the CDP wire (typing path).
 *   3. Mask getter installed for sensitive fields; absent for non-sensitive.
 *   4. SELECT branch commits an option with NO typing and NO pointer events.
 *   5. Fail closed: IFRAME_NOT_SUPPORTED and element_not_found.
 *   6. Verify-fallback: empty-after-typing → Input.insertText → native setter.
 *   7. No Enter / submit key is ever dispatched (final Pay cannot be triggered).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Phase-aware self-driving CDP WebSocket mock ─────────────────────────────

const mockState = vi.hoisted(() => ({
  allSentMessages: [] as string[],
  // Per-phase canned eval responses (the `value` of result.result.value).
  iframeResult: { ok: true, tagName: "INPUT" } as unknown,
  boxResult: { ok: true, box: { x: 100, y: 200, width: 220, height: 40 }, viewport: { width: 1280, height: 800 } } as unknown,
  focusResult: { ok: true, focused: true } as unknown,
  verifyResult: { ok: true, reason: "value_present" } as unknown,
  selectResult: { ok: true, verified: true } as unknown,
  maskResult: { ok: true } as unknown,
  fallbackResult: { ok: true } as unknown,
  // When true, Input.insertText responds with an error (drives the setter fallback).
  insertTextError: false,
  reset() {
    this.allSentMessages = [];
    this.iframeResult = { ok: true, tagName: "INPUT" };
    this.boxResult = { ok: true, box: { x: 100, y: 200, width: 220, height: 40 }, viewport: { width: 1280, height: 800 } };
    this.focusResult = { ok: true, focused: true };
    this.verifyResult = { ok: true, reason: "value_present" };
    this.selectResult = { ok: true, verified: true };
    this.maskResult = { ok: true };
    this.fallbackResult = { ok: true };
    this.insertTextError = false;
  },
}));

vi.mock("ws", () => {
  const state = mockState;

  function evalValueFor(expr: string): unknown {
    if (expr.includes("IFRAME_NOT_SUPPORTED") && expr.includes("tagName")) return state.iframeResult;
    if (expr.includes("getBoundingClientRect")) return state.boxResult;
    if (expr.includes("deleteContentBackward")) return state.focusResult;
    if (expr.includes("empty_after_typing")) return state.verifyResult;
    if (expr.includes("select_option_not_found")) return state.selectResult;
    // setter fallback embeds an `input` event + data-antigen-filled; mask/blur does not.
    if (expr.includes("data-antigen-filled") && expr.includes("new Event('input'")) return state.fallbackResult;
    if (expr.includes("data-antigen-filled")) return state.maskResult;
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
      try { msg = JSON.parse(rawData); } catch { return; }

      if (msg.method === "Target.attachToTarget") {
        setImmediate(() => this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { sessionId: "mock-session" } }))));
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
        setImmediate(() => this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { result: { value } } }))));
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

import { executeProtectedRealisticFill } from "../runtime/protectedRealisticFill.js";

const WS_URL = "ws://localhost:9222/browser";
const SELECTOR = `document.querySelector('input[name="cardnumber"]')`;
const CARD = "4242111122223333";

function sentMessages(): Array<{ method?: string; params?: Record<string, unknown> }> {
  return mockState.allSentMessages
    .map((m) => { try { return JSON.parse(m); } catch { return {}; } });
}
function methodCalls(method: string) {
  return sentMessages().filter((m) => m.method === method);
}
function evalExprs(): string[] {
  return methodCalls("Runtime.evaluate")
    .map((m) => (typeof m.params?.expression === "string" ? (m.params.expression as string) : ""));
}

function baseParams(overrides: Partial<Parameters<typeof executeProtectedRealisticFill>[0]> = {}) {
  return {
    browserWsUrl: WS_URL,
    pageTargetId: "target-1",
    selectorExpr: SELECTOR,
    value: CARD,
    maskDomValue: true,
    typingProfile: "password" as const,
    requestId: "pcfr_test_1",
    domain: "shop.test",
    fieldLabel: "card_number",
    ...overrides,
  };
}

beforeEach(() => {
  mockState.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
  vi.stubEnv("ANTIGEN_BROWSER_SLOW_MO_MS", "0");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ─── 1. Happy INPUT: realistic pointer + per-character typing ─────────────────

describe("executeProtectedRealisticFill — INPUT realistic path", () => {
  it("dispatches pointer events AND one key event per character (not a bare setter)", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    expect(result.field_shape).toBe("input");

    // Realistic pointer: at least the moves + press + release were dispatched.
    const mouse = methodCalls("Input.dispatchMouseEvent");
    expect(mouse.length).toBeGreaterThan(2);
    expect(mouse.some((m) => m.params?.type === "mousePressed")).toBe(true);
    expect(mouse.some((m) => m.params?.type === "mouseReleased")).toBe(true);

    // Realistic typing: exactly one char key event per character of the value.
    const keys = methodCalls("Input.dispatchKeyEvent");
    expect(keys).toHaveLength(CARD.length);
    for (const k of keys) expect(k.params?.type).toBe("char");

    // NOT the invisible-injection path: no insertText, no native-setter fallback eval.
    expect(methodCalls("Input.insertText")).toHaveLength(0);
    expect(evalExprs().some((e) => e.includes(`setter.call(el, ${JSON.stringify(CARD)})`))).toBe(false);
  });

  it("never leaks the raw value into the result, the CDP wire, or logs (typing path)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    // Result object carries only masked booleans/enums — no value, no raw_value, no text.
    expect(JSON.stringify(result)).not.toContain(CARD);
    for (const key of ["value", "raw_value", "text", "secret_ref", "pass_id"]) {
      expect(Object.keys(result)).not.toContain(key);
      if (result.realism) expect(Object.keys(result.realism)).not.toContain(key);
    }
    // On the realistic typing path the contiguous value never crosses the wire
    // (characters go out one-at-a-time as separate key events).
    expect(JSON.stringify(mockState.allSentMessages)).not.toContain(CARD);
    // No console log echoes the value.
    for (const call of logSpy.mock.calls) expect(JSON.stringify(call)).not.toContain(CARD);
  });

  it("installs the DOM value mask for sensitive fields (maskDomValue: true)", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ maskDomValue: true }));
    await vi.runAllTimersAsync();
    await p;
    const maskBlurExpr = evalExprs().find((e) => e.includes("data-antigen-filled") && !e.includes("new Event('input'"));
    expect(maskBlurExpr).toBeDefined();
    expect(maskBlurExpr!).toContain("Object.defineProperty(el, 'value'");
  });

  it("installs the DOM value mask for protected non-PAN INPUT fields (cardholder_name, expiry)", async () => {
    // Cardholder name and a text-input expiry are part of the agent-opaque card bundle:
    // maskDomValue is true even though they are not KMS secrets, so element.value reads
    // empty while the native setter keeps the real submittable value.
    for (const f of [
      { value: "Jane Cardholder", fieldLabel: "cardholder_name" },
      { value: "12/29", fieldLabel: "expiry_combined" },
    ]) {
      mockState.reset();
      vi.useFakeTimers();
      const p = executeProtectedRealisticFill(baseParams({ maskDomValue: true, ...f }));
      await vi.runAllTimersAsync();
      await p;
      const maskBlurExpr = evalExprs().find((e) => e.includes("data-antigen-filled") && !e.includes("new Event('input'"));
      expect(maskBlurExpr, f.fieldLabel).toBeDefined();
      expect(maskBlurExpr!, f.fieldLabel).toContain("Object.defineProperty(el, 'value'");
      vi.useRealTimers();
    }
  });

  it("does NOT install the DOM value mask for non-sensitive fields (maskDomValue: false)", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ maskDomValue: false, value: "12345", fieldLabel: "billing_zip" }));
    await vi.runAllTimersAsync();
    await p;
    const maskBlurExpr = evalExprs().find((e) => e.includes("data-antigen-filled") && !e.includes("new Event('input'"));
    expect(maskBlurExpr).toBeDefined();
    expect(maskBlurExpr!).not.toContain("Object.defineProperty(el, 'value'");
  });

  it("never dispatches an Enter / submit key (final Pay cannot be triggered)", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    await p;
    for (const k of methodCalls("Input.dispatchKeyEvent")) {
      const text = (k.params?.text as string) ?? "";
      expect(text).not.toBe("\r");
      expect(text).not.toBe("\n");
      expect(k.params?.windowsVirtualKeyCode).not.toBe(13);
    }
    // No submit/click expression was evaluated.
    expect(evalExprs().some((e) => /requestSubmit|\.submit\(|\.click\(/.test(e))).toBe(false);
  });
});

// ─── 1b. Visual mask (vision-channel protection) + overlay tri-state ─────────

describe("executeProtectedRealisticFill — visual mask (vision channel)", () => {
  function maskBlurExprOf(): string | undefined {
    // The mask/blur eval marks data-antigen-filled and does NOT dispatch an input
    // event (that distinguishes it from the setter-fallback eval).
    return evalExprs().find((e) => e.includes("data-antigen-filled") && !e.includes("new Event('input'"));
  }

  it("applies text-security + data-antigen-masked when visualMask is true (INPUT)", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ visualMask: true }));
    await vi.runAllTimersAsync();
    await p;
    const expr = maskBlurExprOf();
    expect(expr).toBeDefined();
    expect(expr!).toContain("-webkit-text-security");
    expect(expr!).toContain("data-antigen-masked");
    // The visual mask never embeds the raw value.
    expect(expr!).not.toContain(CARD);
  });

  it("does NOT visually mask when visualMask is unset (default)", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ visualMask: false }));
    await vi.runAllTimersAsync();
    await p;
    const expr = maskBlurExprOf();
    expect(expr).toBeDefined();
    expect(expr!).not.toContain("-webkit-text-security");
    expect(expr!).not.toContain("data-antigen-masked");
  });

  it("tags a SELECT (expiry) with data-antigen-masked when visualMask is true", async () => {
    mockState.iframeResult = { ok: true, tagName: "SELECT" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(
      baseParams({ value: "12", maskDomValue: false, visualMask: true, fieldLabel: "expiry_month" }),
    );
    await vi.runAllTimersAsync();
    await p;
    const selectExpr = evalExprs().find((e) => e.includes("select_option_not_found"));
    expect(selectExpr).toBeDefined();
    expect(selectExpr!).toContain("data-antigen-masked");
    expect(selectExpr!).toContain("color"); // transparent + text-shadow visual mask
  });
});

describe("executeProtectedRealisticFill — overlay tri-state honored on fill path", () => {
  function overlayInjected(): boolean {
    // The pointer overlay is injected via Runtime.evaluate of the dot-ensure IIFE.
    return evalExprs().some((e) => e.includes("__aegis_pointer_debug_dot"));
  }

  it("injects the pointer overlay when debugOverlay:true even with the env var unset", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ debugOverlay: true }));
    await vi.runAllTimersAsync();
    await p;
    expect(overlayInjected()).toBe(true);
  });

  it("does NOT inject the overlay when debugOverlay:false and the env var is unset", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ debugOverlay: false }));
    await vi.runAllTimersAsync();
    await p;
    expect(overlayInjected()).toBe(false);
  });

  it("falls back to the env var when debugOverlay is omitted", async () => {
    vi.stubEnv("ANTIGEN_POINTER_DEBUG_OVERLAY", "true");
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams()); // no debugOverlay param
    await vi.runAllTimersAsync();
    await p;
    expect(overlayInjected()).toBe(true);
  });
});

// ─── 2. SELECT branch: real option selection, no typing, no pointer ──────────

describe("executeProtectedRealisticFill — SELECT branch", () => {
  it("commits an option with no key events and no pointer events", async () => {
    mockState.iframeResult = { ok: true, tagName: "SELECT" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ value: "12", maskDomValue: false, fieldLabel: "expiry_month" }));
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    expect(result.field_shape).toBe("select");
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(0);
    expect(methodCalls("Input.dispatchMouseEvent")).toHaveLength(0);
    // The select commit eval ran; result carries no raw value.
    expect(evalExprs().some((e) => e.includes("select_option_not_found"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("raw_value");
  });

  it("installs the SELECT value-getter mask AFTER commit-verify when maskDomValue is true", async () => {
    // A protected expiry rendered as a <select> must also be agent-opaque: the value
    // getter is masked so element.value / browser_evaluate read empty, while native
    // submission still uses the selected option (selectedIndex).
    mockState.iframeResult = { ok: true, tagName: "SELECT" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(
      baseParams({ value: "12", maskDomValue: true, fieldLabel: "expiry_month" }),
    );
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.success).toBe(true);

    const selectExpr = evalExprs().find((e) => e.includes("select_option_not_found"));
    expect(selectExpr).toBeDefined();
    // Masks the SELECT instance value getter via the HTMLSelectElement prototype setter.
    expect(selectExpr!).toContain("HTMLSelectElement.prototype");
    expect(selectExpr!).toContain("Object.defineProperty(el, 'value'");
    // Ordering: the getter mask is installed strictly AFTER the commit verification
    // (which reads el.value) — otherwise the verify would see an empty value and fail.
    expect(selectExpr!.indexOf("select_commit_unverified")).toBeLessThan(
      selectExpr!.indexOf("Object.defineProperty(el, 'value'"),
    );
  });

  it("does NOT install the SELECT value-getter mask when maskDomValue is false", async () => {
    mockState.iframeResult = { ok: true, tagName: "SELECT" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(
      baseParams({ value: "12", maskDomValue: false, fieldLabel: "expiry_month" }),
    );
    await vi.runAllTimersAsync();
    await p;
    const selectExpr = evalExprs().find((e) => e.includes("select_option_not_found"));
    expect(selectExpr).toBeDefined();
    expect(selectExpr!).not.toContain("Object.defineProperty(el, 'value'");
  });
});

// ─── 3. Fail-closed cases ────────────────────────────────────────────────────

describe("executeProtectedRealisticFill — fail closed", () => {
  it("fails closed with IFRAME_NOT_SUPPORTED for a field inside an iframe", async () => {
    mockState.iframeResult = { ok: false, reason: "IFRAME_NOT_SUPPORTED" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(false);
    expect(result.error).toBe("IFRAME_NOT_SUPPORTED");
    // Nothing was typed or pointer-moved into an unsupported target.
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(0);
    expect(methodCalls("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("fails closed when the element is not found", async () => {
    mockState.iframeResult = { ok: false, reason: "element_not_found" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toBe("element_not_found");
  });

  it("fails closed with TARGET_NOT_FILLABLE when the resolved element is not a fillable control", async () => {
    // The live IKEA cardholder bug: a floating-label span/div resolved instead of
    // the input, and the HTMLInputElement-prototype setter call on it threw
    // "TypeError: Illegal invocation" mid-focus. Now the tag gate fails closed
    // BEFORE any focus/typing is attempted.
    mockState.iframeResult = { ok: true, tagName: "DIV" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams({ value: "Jane Cardholder", fieldLabel: "cardholder_name" }));
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(false);
    expect(result.error).toBe("TARGET_NOT_FILLABLE (DIV)");
    expect(result.error).not.toContain("Illegal invocation");
    // Structural metadata only — no coordinates, selector, or value in the error.
    expect(result.error).not.toMatch(/\d{2,}/);
    expect(result.error).not.toContain("Jane Cardholder");
    // The fill aborted before focus/typing: no focus/clear eval, no key events,
    // no insertText, no pointer events.
    expect(evalExprs().some((e) => e.includes("deleteContentBackward"))).toBe(false);
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(0);
    expect(methodCalls("Input.dispatchMouseEvent")).toHaveLength(0);
    expect(methodCalls("Input.insertText")).toHaveLength(0);
  });

  it("treats a TEXTAREA as a fillable input and uses the tag-aware native setter", async () => {
    mockState.iframeResult = { ok: true, tagName: "TEXTAREA" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    expect(result.field_shape).toBe("input");
    // The focus/clear expression picks the prototype by tagName — a TEXTAREA must
    // never receive the HTMLInputElement setter (that throws Illegal invocation).
    const focusExpr = evalExprs().find((e) => e.includes("deleteContentBackward"));
    expect(focusExpr).toBeDefined();
    expect(focusExpr!).toContain("HTMLTextAreaElement.prototype");
    expect(focusExpr!).toContain("el.tagName === 'TEXTAREA'");
  });
});

// ─── 3b. Focus robustness (cardholder Illegal-invocation regression) ─────────

describe("executeProtectedRealisticFill — focus robustness", () => {
  it("calls focus with the element as receiver, with a prototype-call fallback", async () => {
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    await p;
    const focusExpr = evalExprs().find((e) => e.includes("deleteContentBackward"));
    expect(focusExpr).toBeDefined();
    // Cascade: el.focus({preventScroll}) → HTMLElement.prototype.focus.call(el) →
    // focus/focusin events. Never a detached method reference.
    expect(focusExpr!).toContain("el.focus({ preventScroll: true })");
    expect(focusExpr!).toContain("HTMLElement.prototype.focus.call(el)");
    expect(focusExpr!).toContain("document.activeElement === el");
    expect(focusExpr!).not.toMatch(/var\s+\w+\s*=\s*el\.focus\b/);
    // Tag gate inside the same evaluation (defense-in-depth for inter-phase races).
    expect(focusExpr!).toContain("TARGET_NOT_FILLABLE");
  });

  it("does NOT type when focus could not be verified — element-targeted setter instead", async () => {
    // Typing (key events / insertText) delivers text to whatever IS focused; with
    // unverified focus the protected value could land in an arbitrary element.
    mockState.focusResult = { ok: true, focused: false };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(0);
    expect(methodCalls("Input.insertText")).toHaveLength(0);
    // The element-targeted setter fallback ran (value JSON-encoded inside the
    // expression only — same as the proven secret path).
    expect(evalExprs().some((e) => e.includes(`setter.call(el, ${JSON.stringify(CARD)})`))).toBe(true);
    expect(result.realism?.fallback_used).toBe(true);
    expect(result.realism?.fallback_reason).toBe("focus_unverified");
    expect(result.realism?.strategy).toBe("direct_assignment");
    // Value never reaches the agent-facing result.
    expect(JSON.stringify(result)).not.toContain(CARD);
  });

  it("keeps the typing path for legacy focus shapes without the focused field", async () => {
    mockState.focusResult = { ok: true };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.success).toBe(true);
    expect(methodCalls("Input.dispatchKeyEvent")).toHaveLength(CARD.length);
  });

  it("setter fallback verifies persistence through the native getter and reports value_not_persisted", async () => {
    mockState.verifyResult = { ok: false, reason: "empty_after_typing" };
    mockState.insertTextError = true;
    mockState.fallbackResult = { ok: false, reason: "value_not_persisted" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(false);
    expect(result.error).toBe("CDP fallback: value_not_persisted");
    // The fallback expression reads through the NATIVE getter (mask-immune) and
    // returns only a boolean-derived reason — never the value.
    const fbExpr = evalExprs().find((e) => e.includes("data-antigen-filled") && e.includes("new Event('input'"));
    expect(fbExpr).toBeDefined();
    expect(fbExpr!).toContain("value_not_persisted");
    expect(fbExpr!).toContain("nativeGetter.call(el)");
    expect(JSON.stringify(result)).not.toContain(CARD);
  });
});

// ─── 4. Verify-fallback chain (typing → insertText → native setter) ──────────

describe("executeProtectedRealisticFill — fallback chain", () => {
  it("falls back to Input.insertText when the field is empty after typing", async () => {
    mockState.verifyResult = { ok: false, reason: "empty_after_typing" };
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    expect(methodCalls("Input.insertText")).toHaveLength(1);
    expect(result.realism?.fallback_used).toBe(true);
    // Value still never appears in the result object.
    expect(JSON.stringify(result)).not.toContain(CARD);
  });

  it("falls back to the native setter when Input.insertText also fails", async () => {
    mockState.verifyResult = { ok: false, reason: "empty_after_typing" };
    mockState.insertTextError = true;
    vi.useFakeTimers();
    const p = executeProtectedRealisticFill(baseParams());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    // The setter fallback eval (which embeds the value) ran — last-resort only.
    expect(evalExprs().some((e) => e.includes(`setter.call(el, ${JSON.stringify(CARD)})`))).toBe(true);
    // ...but the value still never reaches the agent-facing result object.
    expect(JSON.stringify(result)).not.toContain(CARD);
  });
});
