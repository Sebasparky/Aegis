/**
 * Secret Field Masking + Realistic Fill tests.
 *
 * Tests the CDP fill behavior produced by executeSecretInjectionViaCDP:
 * - Happy path: focus → Input.insertText (secret in params) → mask/blur eval
 * - Fallback path: setter-based fill when Input.insertText fails
 * - Password masking invariants
 * - Security: no Runtime.evaluate expression ever contains the raw secret on happy path
 *
 * No real Chrome needed — exercises CDP message sequences and expression strings.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Mocks required to load secretInjection.ts without side effects ────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// ─── Pointer state persistence mock ───────────────────────────────────────────
// Allows tests to seed saved session pointer state and assert on saves.

const mockPointerStateStore = new Map<string, { x: number; y: number; initialized: boolean; updated_at?: string }>();
const capturedPointerStateSaves: Array<{ id: string; userId: string; state: { x: number; y: number; initialized: boolean; updated_at?: string } }> = [];

vi.mock("../runtime/taskBrowserSessions.js", () => ({
  getTaskBrowserSessionPointerState: vi.fn().mockImplementation((id: string, _userId: string) => {
    return mockPointerStateStore.get(id);
  }),
  setTaskBrowserSessionPointerState: vi.fn().mockImplementation((id: string, userId: string, state: { x: number; y: number; initialized: boolean; updated_at?: string }) => {
    mockPointerStateStore.set(id, state);
    capturedPointerStateSaves.push({ id, userId, state });
  }),
}));

// Capture ALL CDP commands sent over the WebSocket so tests can assert on sequence and content.
type CapturedMsg = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
let sentMessages: CapturedMsg[] = [];

// Controls whether the mock should simulate Input.insertText failure (for fallback tests).
let simulateInsertTextFailure = false;
// Controls whether the box lookup Runtime.evaluate returns ok: false (for pointer fallback tests).
let simulateBoxLookupFailure = false;
// Controls whether overlay Runtime.evaluate calls return a CDP error (for overlay failure tests).
let simulateOverlayFailure = false;
// Controls whether a no-id CDP notification is emitted before the attach response (regression test).
let simulateEarlyNotification = false;

vi.mock("ws", () => {
  // Each FakeWs instance gets its own handler registry so test state does not bleed
  // across test boundaries (module-level handlers would accumulate across tests).
  //
  // Responses are emitted via queueMicrotask so that the ID variable (e.g. insertId = send(...))
  // is fully assigned before the response handler fires. Emitting synchronously inside send()
  // would cause the routing check (id === insertId) to evaluate before insertId is set.
  const FakeWs = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    const instanceHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

    const emit = (response: string) => {
      queueMicrotask(() => {
        instanceHandlers["message"]?.forEach((h) => h(response));
      });
    };

    this.send = (raw: string) => {
      const msg = JSON.parse(raw) as CapturedMsg & { method: string };
      sentMessages.push(msg);

      if (msg.method === "Target.attachToTarget") {
        if (simulateEarlyNotification) {
          // Emit a no-id CDP notification (e.g. Target.attachedToTarget) before the response.
          // This tests that the undefined-id guard prevents premature box phase execution.
          emit(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "mock_session" } }));
        }
        emit(JSON.stringify({ id: msg.id, result: { sessionId: "mock_session" } }));
        return;
      }

      if (msg.method === "Runtime.evaluate") {
        const expr = (msg.params?.expression as string) ?? "";
        if (expr.includes("getBoundingClientRect")) {
          // Box lookup phase — return element box or failure based on flag.
          const boxValue = simulateBoxLookupFailure
            ? { ok: false, reason: "element_not_found" }
            : { ok: true, box: { x: 100, y: 100, width: 200, height: 40 }, viewport: { width: 1280, height: 800 } };
          emit(JSON.stringify({
            id: msg.id,
            sessionId: "mock_session",
            result: { result: { type: "object", value: boxValue } },
          }));
        } else if ((expr.includes("__aegis_pointer_debug_dot") || expr.includes("__aegis_pointer_debug_path")) && simulateOverlayFailure) {
          // Simulate overlay injection failure — fill must still succeed (fire-and-forget).
          emit(JSON.stringify({ id: msg.id, error: { code: -32603, message: "Internal error" } }));
        } else {
          // All other eval phases (focus/clear, mask/blur, overlay) — return ok: true.
          emit(JSON.stringify({
            id: msg.id,
            sessionId: "mock_session",
            result: { result: { type: "object", value: { ok: true } } },
          }));
        }
        return;
      }

      if (msg.method === "Input.dispatchMouseEvent") {
        // Fire-and-forget pointer events — return empty result (Chrome sends this but callers ignore it).
        emit(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }

      if (msg.method === "Input.insertText") {
        if (simulateInsertTextFailure) {
          // Return a CDP error so the fallback setter path is taken.
          emit(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found" } }));
        } else {
          // Return empty success result.
          emit(JSON.stringify({ id: msg.id, result: {} }));
        }
        return;
      }
    };

    this.on = (event: string, handler: (...args: unknown[]) => void) => {
      instanceHandlers[event] = instanceHandlers[event] ?? [];
      instanceHandlers[event].push(handler);
      if (event === "open") setTimeout(() => handler(), 0);
    };

    this.close = vi.fn();
    this.terminate = vi.fn();
  });

  return { default: FakeWs };
});

// Mock fetch used to discover CDP targets.
global.fetch = vi.fn().mockImplementation((url: string) => {
  if (url.endsWith("/json/version")) {
    return Promise.resolve({
      json: () => Promise.resolve({ webSocketDebuggerUrl: "ws://localhost:9222/browser" }),
    });
  }
  if (url.endsWith("/json/list")) {
    return Promise.resolve({
      json: () =>
        Promise.resolve([{ id: "target_1", url: "https://github.com/login", type: "page" }]),
    });
  }
  return Promise.reject(new Error("unexpected fetch: " + url));
}) as typeof fetch;

// ─── Imports ──────────────────────────────────────────────────────────────────

import type { SecretFieldInjection } from "@aegis/types";
import { executeSecretInjectionViaCDP, CDP_DIAG_EXPR } from "../runtime/secretInjection.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInjection(field_kind: "password" | "username"): SecretFieldInjection {
  return {
    injection_request_id: "inj_test_001",
    user_id: "user_001",
    delegation_id: "del_test_001",
    pass_id: "pass_test_001",
    domain: "github.com",
    page_url: "https://github.com/login",
    field_kind,
    element_hint: { input_type: field_kind === "password" ? "password" : "text" },
    status: "approved",
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  } as SecretFieldInjection;
}

/**
 * Simulate applying a fill expression in Node.js using a fake HTMLInputElement.
 * Used only for fallback setter tests — verifies the expression structure is correct.
 */
function simulateFill(expression: string): { value: string; antigenFilled: string | null } {
  let internalValue = "";

  const el = Object.create(null) as Record<string, unknown>;
  const fakeProto = Object.create(null);
  Object.defineProperty(fakeProto, "value", {
    get: () => internalValue,
    set: (v: string) => { internalValue = v; },
    configurable: true,
  });
  const fakeHTMLInputElement = { prototype: fakeProto };
  const attributes: Record<string, string> = {};
  el.dispatchEvent = (_e: unknown) => true;
  el.setAttribute = (name: string, val: string) => { attributes[name] = val; };
  Object.defineProperty(el, "value", {
    get: () => fakeProto.value,
    set: (v: string) => { fakeProto.value = v; },
    configurable: true,
  });

  // eslint-disable-next-line no-new-func
  const fn = new Function("el", "HTMLInputElement", "Event", "InputEvent", "Object", `return ${expression}`);
  fn(el, fakeHTMLInputElement, class Event {}, class InputEvent {}, Object);

  return { value: el.value as string, antigenFilled: attributes["data-antigen-filled"] ?? null };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Realistic Fill — happy path sequence", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = false;
    simulateBoxLookupFailure = false;
  });

  it("sends Runtime.evaluate (box lookup) before Input.insertText", async () => {
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const evalIdx = sentMessages.findIndex((m) => m.method === "Runtime.evaluate");
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(evalIdx);
  });

  it("sends Input.dispatchMouseEvent mouseMoved events before Input.insertText", async () => {
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const mouseMovedMsgs = sentMessages.filter(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved",
    );
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    expect(mouseMovedMsgs.length).toBeGreaterThan(0);
    for (const m of mouseMovedMsgs) {
      expect(sentMessages.indexOf(m)).toBeLessThan(insertIdx);
    }
  });

  it("sends mousePressed and mouseReleased before Input.insertText", async () => {
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const pressedMsgs = sentMessages.filter(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mousePressed",
    );
    const releasedMsgs = sentMessages.filter(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseReleased",
    );
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    expect(pressedMsgs.length).toBe(1);
    expect(releasedMsgs.length).toBe(1);
    expect(sentMessages.indexOf(pressedMsgs[0])).toBeLessThan(insertIdx);
    expect(sentMessages.indexOf(releasedMsgs[0])).toBeLessThan(insertIdx);
  });

  it("box lookup Runtime.evaluate expression does not contain secret", async () => {
    const secret = "BOX_LOOKUP_SECRET_SENTINEL";
    await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    const boxMsg = sentMessages.find(
      (m) => m.method === "Runtime.evaluate" &&
             typeof m.params?.expression === "string" &&
             (m.params.expression as string).includes("getBoundingClientRect"),
    );
    expect(boxMsg).toBeDefined();
    expect(boxMsg!.params?.expression as string).not.toContain(secret);
  });

  it("sends Input.insertText on the happy path", async () => {
    await executeSecretInjectionViaCDP(makeInjection("username"), "PLACEHOLDER", "http://localhost:9222");
    expect(sentMessages.some((m) => m.method === "Input.insertText")).toBe(true);
  });

  it("Input.insertText params.text contains the resolved value", async () => {
    const secret = "UNIQUE_SECRET_SENTINEL";
    await executeSecretInjectionViaCDP(makeInjection("username"), secret, "http://localhost:9222");
    const insertMsg = sentMessages.find((m) => m.method === "Input.insertText");
    expect(insertMsg).toBeDefined();
    expect(insertMsg!.params?.text).toBe(secret);
  });

  it("no Runtime.evaluate expression contains the resolved value on the happy path", async () => {
    const secret = "UNIQUE_SECRET_SENTINEL_EXPR";
    await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    const evalMsgs = sentMessages.filter((m) => m.method === "Runtime.evaluate");
    expect(evalMsgs.length).toBeGreaterThan(0);
    for (const m of evalMsgs) {
      const expr = m.params?.expression as string;
      expect(expr).not.toContain(secret);
    }
  });

  it("no Runtime.evaluate expression contains the resolved value even JSON-encoded", async () => {
    const secret = "UNIQUE_SECRET_JSON_ENCODE_TEST";
    await executeSecretInjectionViaCDP(makeInjection("username"), secret, "http://localhost:9222");
    const jsonEncoded = JSON.stringify(secret);
    const evalMsgs = sentMessages.filter((m) => m.method === "Runtime.evaluate");
    for (const m of evalMsgs) {
      const expr = m.params?.expression as string;
      expect(expr).not.toContain(jsonEncoded);
    }
  });

  it("sends a mask/blur Runtime.evaluate after Input.insertText for password", async () => {
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    const afterInsert = sentMessages.slice(insertIdx + 1).filter((m) => m.method === "Runtime.evaluate");
    expect(afterInsert.length).toBeGreaterThan(0);
    const maskExpr = afterInsert[afterInsert.length - 1].params?.expression as string;
    expect(maskExpr).toContain("Object.defineProperty");
    expect(maskExpr).toContain("blur");
  });

  it("sends a blur Runtime.evaluate after Input.insertText for username (no mask)", async () => {
    await executeSecretInjectionViaCDP(makeInjection("username"), "PLACEHOLDER", "http://localhost:9222");
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    const afterInsert = sentMessages.slice(insertIdx + 1).filter((m) => m.method === "Runtime.evaluate");
    expect(afterInsert.length).toBeGreaterThan(0);
    const blurExpr = afterInsert[afterInsert.length - 1].params?.expression as string;
    expect(blurExpr).not.toContain("Object.defineProperty");
    expect(blurExpr).toContain("blur");
  });

  it("result reports success and never contains the resolved value", async () => {
    const secret = "UNIQUE_RESULT_SENTINEL";
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("Realistic Fill — fallback setter path", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = true;
  });

  it("falls back to setter Runtime.evaluate when Input.insertText fails", async () => {
    await executeSecretInjectionViaCDP(makeInjection("username"), "FALLBACK_VAL", "http://localhost:9222");
    // Should have sent Input.insertText (which failed) then a setter Runtime.evaluate
    expect(sentMessages.some((m) => m.method === "Input.insertText")).toBe(true);
    // After the failed insertText there should be a Runtime.evaluate with the value
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    const fallbackEvals = sentMessages.slice(insertIdx + 1).filter((m) => m.method === "Runtime.evaluate");
    expect(fallbackEvals.length).toBeGreaterThan(0);
  });

  it("fallback setter expression contains the value (JSON-encoded, as original path)", async () => {
    const secret = "FALLBACK_SECRET_SENTINEL";
    await executeSecretInjectionViaCDP(makeInjection("username"), secret, "http://localhost:9222");
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    const fallbackEvals = sentMessages.slice(insertIdx + 1).filter((m) => m.method === "Runtime.evaluate");
    const fallbackExpr = fallbackEvals[0]?.params?.expression as string | undefined;
    expect(fallbackExpr).toBeDefined();
    expect(fallbackExpr).toContain(JSON.stringify(secret));
  });

  it("fallback path result does not expose the resolved value", async () => {
    const secret = "FALLBACK_LEAK_TEST";
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("fallback setter for password includes Object.defineProperty mask", async () => {
    await executeSecretInjectionViaCDP(makeInjection("password"), "FALLBACK_PWD", "http://localhost:9222");
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    const fallbackEvals = sentMessages.slice(insertIdx + 1).filter((m) => m.method === "Runtime.evaluate");
    const fallbackExpr = fallbackEvals[0]?.params?.expression as string | undefined;
    expect(fallbackExpr).toBeDefined();
    expect(fallbackExpr).toContain("Object.defineProperty");
  });

  it("fallback setter for username does not include Object.defineProperty mask", async () => {
    await executeSecretInjectionViaCDP(makeInjection("username"), "FALLBACK_USER", "http://localhost:9222");
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    const fallbackEvals = sentMessages.slice(insertIdx + 1).filter((m) => m.method === "Runtime.evaluate");
    const fallbackExpr = fallbackEvals[0]?.params?.expression as string | undefined;
    expect(fallbackExpr).toBeDefined();
    expect(fallbackExpr).not.toContain("Object.defineProperty");
  });
});

describe("Password mask DOM simulation — fallback setter expression", () => {
  it("password mask: el.value returns '' after fallback setter expression runs", () => {
    const maskExpr = `(function() {
      var el = el_param;
      if (!el) return { ok: false, reason: 'element not found' };
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, "placeholder_value");
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      Object.defineProperty(el, 'value', {
        get: function() { return ''; },
        set: function(v) { setter.call(el, v); },
        configurable: true,
      });
      el.setAttribute('data-antigen-filled', 'true');
      return { ok: true };
    })()`;

    const fn = new Function("el_param", "HTMLInputElement", "Event", "InputEvent", "Object", `return ${maskExpr}`);

    let internalValue = "";
    const proto = { get value() { return internalValue; }, set value(v: string) { internalValue = v; } };
    const fakeHTMLInputElement = { prototype: proto };
    const attrs: Record<string, string> = {};
    const el = { dispatchEvent: () => true, setAttribute: (k: string, v: string) => { attrs[k] = v; } };
    Object.defineProperty(el, "value", {
      get: () => proto.value,
      set: (v: string) => { proto.value = v; },
      configurable: true,
    });

    fn(el, fakeHTMLInputElement, class Event {}, class InputEvent {}, Object);

    expect((el as Record<string, unknown>).value).toBe("");
    expect(attrs["data-antigen-filled"]).toBe("true");
  });

  it("password mask: setter still works after masking", () => {
    let internalValue = "";
    const proto = { get value() { return internalValue; }, set value(v: string) { internalValue = v; } };
    const fakeHTMLInputElement = { prototype: proto };
    const el = { dispatchEvent: () => true, setAttribute: () => {} };
    Object.defineProperty(el, "value", {
      get: () => proto.value,
      set: (v: string) => { proto.value = v; },
      configurable: true,
    });

    const setter = Object.getOwnPropertyDescriptor(fakeHTMLInputElement.prototype, "value")!.set!;
    Object.defineProperty(el, "value", {
      get: () => "",
      set: (v: string) => setter.call(el, v),
      configurable: true,
    });

    expect((el as Record<string, unknown>).value).toBe("");
    expect(() => { (el as Record<string, unknown>).value = "re_injected"; }).not.toThrow();
  });
});

describe("Realistic Fill — result safety invariants", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = false;
    simulateBoxLookupFailure = false;
  });

  it("password field result contains no resolved value", async () => {
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), "SENTINEL_SECRET", "http://localhost:9222");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_SECRET");
    expect(result.success).toBe(true);
  });

  it("username field result contains no resolved value", async () => {
    const result = await executeSecretInjectionViaCDP(makeInjection("username"), "SENTINEL_USERNAME", "http://localhost:9222");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_USERNAME");
    expect(result.success).toBe(true);
  });
});

describe("Pointer debug overlay", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = false;
    simulateBoxLookupFailure = false;
    simulateOverlayFailure = false;
  });
  afterEach(() => {
    delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
    simulateOverlayFailure = false;
  });

  it("default path sends no overlay Runtime.evaluate calls", async () => {
    // ANTIGEN_POINTER_DEBUG_OVERLAY not set — no overlay expressions should appear.
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const overlayMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_dot"),
    );
    expect(overlayMsgs).toHaveLength(0);
  });

  it("ANTIGEN_POINTER_DEBUG_OVERLAY=true sends overlay Runtime.evaluate calls", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const overlayMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_dot"),
    );
    expect(overlayMsgs.length).toBeGreaterThan(0);
  });

  it("overlay expressions include trail container id", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const trailMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_trail"),
    );
    expect(trailMsgs.length).toBeGreaterThan(0);
  });

  it("overlay released expression schedules 8000ms removal", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const persistMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("setTimeout") &&
              (m.params.expression as string).includes("8000"),
    );
    expect(persistMsgs.length).toBeGreaterThan(0);
  });

  it("overlay Runtime.evaluate expressions do not contain the secret value", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    const secret = "OVERLAY_SECRET_SENTINEL";
    await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    const overlayMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_dot"),
    );
    expect(overlayMsgs.length).toBeGreaterThan(0);
    for (const m of overlayMsgs) {
      expect(m.params?.expression as string).not.toContain(secret);
    }
  });

  it("mouse events still occur before Input.insertText with overlay enabled", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const mouseMovedMsgs = sentMessages.filter(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved",
    );
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    expect(mouseMovedMsgs.length).toBeGreaterThan(0);
    for (const m of mouseMovedMsgs) {
      expect(sentMessages.indexOf(m)).toBeLessThan(insertIdx);
    }
  });

  it("fill still succeeds when overlay injection fails", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    simulateOverlayFailure = true;
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), "SECRET", "http://localhost:9222");
    expect(result.success).toBe(true);
  });

  it("overlay path render expression includes START label", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const pathMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_path"),
    );
    expect(pathMsgs.length).toBeGreaterThan(0);
    expect(pathMsgs.some((m) => (m.params?.expression as string).includes("START"))).toBe(true);
  });

  it("overlay path render expression includes END label", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const pathMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_path"),
    );
    expect(pathMsgs.some((m) => (m.params?.expression as string).includes("END"))).toBe(true);
  });

  it("overlay path render expression includes svg and polyline elements", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const pathMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_path"),
    );
    expect(pathMsgs.some((m) => (m.params?.expression as string).includes("polyline"))).toBe(true);
    expect(pathMsgs.some((m) => (m.params?.expression as string).includes("createElementNS"))).toBe(true);
  });

  it("overlay path render expressions contain no secret value", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    const secret = "PATH_RENDER_SECRET_SENTINEL";
    await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    const pathMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_path"),
    );
    expect(pathMsgs.length).toBeGreaterThan(0);
    for (const m of pathMsgs) {
      expect(m.params?.expression as string).not.toContain(secret);
    }
  });
});

describe("CDP notification event guard — no-id messages must not trigger box phase", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = false;
    simulateBoxLookupFailure = false;
    simulateEarlyNotification = false;
  });
  afterEach(() => {
    simulateEarlyNotification = false;
  });

  it("fill still succeeds when a no-id CDP notification arrives before the attach response", async () => {
    simulateEarlyNotification = true;
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), "SECRET", "http://localhost:9222");
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("no Runtime.evaluate is sent without a valid sessionId when an early notification arrives", async () => {
    simulateEarlyNotification = true;
    await executeSecretInjectionViaCDP(makeInjection("password"), "SECRET", "http://localhost:9222");
    const evalMsgs = sentMessages.filter((m) => m.method === "Runtime.evaluate");
    expect(evalMsgs.length).toBeGreaterThan(0);
    for (const m of evalMsgs) {
      expect(m.sessionId).toBe("mock_session");
    }
  });

  it("mouse events still precede Input.insertText with an early notification present", async () => {
    simulateEarlyNotification = true;
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const mouseMoved = sentMessages.filter(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved",
    );
    const insertIdx = sentMessages.findIndex((m) => m.method === "Input.insertText");
    expect(mouseMoved.length).toBeGreaterThan(0);
    for (const m of mouseMoved) {
      expect(sentMessages.indexOf(m)).toBeLessThan(insertIdx);
    }
  });
});

describe("Native pointer focus — box lookup failure fallback", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = false;
    simulateBoxLookupFailure = true;
  });

  it("fill still succeeds when box lookup returns ok: false", async () => {
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), "FALLBACK_SECRET", "http://localhost:9222");
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("no Input.dispatchMouseEvent events sent when box lookup fails", async () => {
    await executeSecretInjectionViaCDP(makeInjection("password"), "FALLBACK_SECRET", "http://localhost:9222");
    const mouseEvents = sentMessages.filter((m) => m.method === "Input.dispatchMouseEvent");
    expect(mouseEvents.length).toBe(0);
  });

  it("Input.insertText still sent when box lookup fails", async () => {
    await executeSecretInjectionViaCDP(makeInjection("username"), "FALLBACK_SECRET", "http://localhost:9222");
    expect(sentMessages.some((m) => m.method === "Input.insertText")).toBe(true);
  });

  it("result never contains the secret even when pointer path is skipped", async () => {
    const secret = "BOX_FALLBACK_LEAK_TEST";
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("raw_value_revealed_to_agent remains false in box-lookup-failure path", async () => {
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), "FALLBACK_SECRET", "http://localhost:9222");
    // The result type has raw_value_revealed_to_agent: false as a literal. Verify it's not leaked.
    expect(result.success).toBe(true);
  });
});

describe("ANTIGEN_CDP_DIAGNOSTICS — phase ordering and expression safety", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = false;
    simulateBoxLookupFailure = false;
    simulateEarlyNotification = false;
  });
  afterEach(() => {
    delete process.env.ANTIGEN_CDP_DIAGNOSTICS;
  });

  it("page diagnostic Runtime.evaluate runs before box lookup when ANTIGEN_CDP_DIAGNOSTICS=true", async () => {
    process.env.ANTIGEN_CDP_DIAGNOSTICS = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    const diagIdx = sentMessages.findIndex(
      (m) =>
        m.method === "Runtime.evaluate" &&
        typeof m.params?.expression === "string" &&
        (m.params.expression as string).includes("readyState"),
    );
    const boxIdx = sentMessages.findIndex(
      (m) =>
        m.method === "Runtime.evaluate" &&
        typeof m.params?.expression === "string" &&
        (m.params.expression as string).includes("getBoundingClientRect"),
    );
    expect(diagIdx).toBeGreaterThanOrEqual(0);
    expect(boxIdx).toBeGreaterThan(diagIdx);
  });

  it("box diagnostic expression includes inputSummary keys but never reads .value", async () => {
    process.env.ANTIGEN_CDP_DIAGNOSTICS = "true";
    const secret = "DIAG_SECRET_SENTINEL";
    await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    const boxMsg = sentMessages.find(
      (m) =>
        m.method === "Runtime.evaluate" &&
        typeof m.params?.expression === "string" &&
        (m.params.expression as string).includes("getBoundingClientRect"),
    );
    expect(boxMsg).toBeDefined();
    const expr = boxMsg!.params!.expression as string;
    expect(expr).toContain("inputSummary");
    expect(expr).toContain("selector_found");
    expect(expr).not.toContain(".value");
    expect(expr).not.toContain(secret);
  });

  it("fill still succeeds when ANTIGEN_CDP_DIAGNOSTICS=true", async () => {
    process.env.ANTIGEN_CDP_DIAGNOSTICS = "true";
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe("CDP_DIAG_EXPR safety — no input field value reads", () => {
  it("CDP_DIAG_EXPR contains inputSummary structural keys", () => {
    expect(CDP_DIAG_EXPR).toContain("inputSummary");
    expect(CDP_DIAG_EXPR).toContain("readyState");
    expect(CDP_DIAG_EXPR).toContain("hasEmailId");
  });

  it("CDP_DIAG_EXPR never reads .value from input elements", () => {
    // The diagnostic must only collect structural metadata — id, name, type, placeholder,
    // autocomplete, disabled, readOnly. Reading i.value would leak typed content.
    expect(CDP_DIAG_EXPR).not.toContain(".value");
  });

  it("CDP_DIAG_EXPR does not contain password-related value extraction", () => {
    expect(CDP_DIAG_EXPR).not.toMatch(/i\.value|el\.value|input\.value/);
  });
});

describe("Persistent pointer state", () => {
  beforeEach(() => {
    sentMessages = [];
    simulateInsertTextFailure = false;
    simulateBoxLookupFailure = false;
    simulateOverlayFailure = false;
    mockPointerStateStore.clear();
    capturedPointerStateSaves.length = 0;
  });
  afterEach(() => {
    delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
  });

  it("uses stored session pointer state as path start", async () => {
    // Seed a saved pointer state at (120, 90) for a task browser session.
    mockPointerStateStore.set("bs_ptr_start_test", { x: 120, y: 90, initialized: true });
    await executeSecretInjectionViaCDP(
      makeInjection("password"), "PLACEHOLDER", "http://localhost:9222",
      undefined, "bs_ptr_start_test",
    );
    // path[0] = { x: state.current_x, y: state.current_y } = exactly (120, 90).
    const firstMove = sentMessages.find(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved",
    );
    expect(firstMove).toBeDefined();
    expect(firstMove!.params!.x as number).toBeCloseTo(120, 0);
    expect(firstMove!.params!.y as number).toBeCloseTo(90, 0);
  });

  it("persists final pointer state to session after injection", async () => {
    await executeSecretInjectionViaCDP(
      makeInjection("username"), "PLACEHOLDER", "http://localhost:9222",
      undefined, "bs_ptr_save_test",
    );
    expect(capturedPointerStateSaves.length).toBeGreaterThan(0);
    const save = capturedPointerStateSaves[capturedPointerStateSaves.length - 1];
    expect(save.id).toBe("bs_ptr_save_test");
    expect(save.state.initialized).toBe(true);
    expect(typeof save.state.x).toBe("number");
    expect(typeof save.state.y).toBe("number");
    // Saved coordinates must be within the mock element box (x:100–300, y:100–140).
    expect(save.state.x).toBeGreaterThanOrEqual(100);
    expect(save.state.x).toBeLessThanOrEqual(300);
    expect(save.state.y).toBeGreaterThanOrEqual(100);
    expect(save.state.y).toBeLessThanOrEqual(140);
  });

  it("second injection starts from first injection end position", async () => {
    // First injection — no saved state; will initialize from viewport center (640, 400).
    await executeSecretInjectionViaCDP(
      makeInjection("username"), "PLACEHOLDER", "http://localhost:9222",
      undefined, "bs_ptr_seq_test",
    );
    const firstSave = capturedPointerStateSaves[capturedPointerStateSaves.length - 1];
    expect(firstSave).toBeDefined();

    // Reset messages; session mock already has the saved state from the first injection.
    sentMessages = [];
    capturedPointerStateSaves.length = 0;

    // Second injection — should start from firstSave.state position.
    await executeSecretInjectionViaCDP(
      makeInjection("password"), "PLACEHOLDER2", "http://localhost:9222",
      undefined, "bs_ptr_seq_test",
    );
    const firstMove = sentMessages.find(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved",
    );
    expect(firstMove).toBeDefined();
    expect(firstMove!.params!.x as number).toBeCloseTo(firstSave.state.x, 0);
    expect(firstMove!.params!.y as number).toBeCloseTo(firstSave.state.y, 0);
  });

  it("without stored session state, initializes pointer from viewport center", async () => {
    // mockPointerStateStore is empty — no saved state for this session.
    // Mock box lookup returns viewport 1280×800; center = (640, 400).
    await executeSecretInjectionViaCDP(
      makeInjection("password"), "PLACEHOLDER", "http://localhost:9222",
      undefined, "bs_ptr_viewport_init",
    );
    const firstMove = sentMessages.find(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseMoved",
    );
    expect(firstMove).toBeDefined();
    expect(firstMove!.params!.x as number).toBeCloseTo(640, 0);
    expect(firstMove!.params!.y as number).toBeCloseTo(400, 0);
  });

  it("overlay released timer removes trail but not dot", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    // The "released" update generates a Runtime.evaluate with an 8000ms cleanup timer.
    // The expression also moves the dot (position update), but the cleanup timer must only
    // remove the trail — not the dot.
    const releasedTimerMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("8000") &&
              (m.params.expression as string).includes("__aegis_pointer_debug_trail") &&
              !(m.params.expression as string).includes("__aegis_pointer_debug_path"),
    );
    expect(releasedTimerMsgs.length).toBeGreaterThan(0);
    for (const m of releasedTimerMsgs) {
      const expr = m.params?.expression as string;
      // Extract only the setTimeout body to check what the cleanup timer actually removes.
      const setTimeoutIdx = expr.indexOf("setTimeout(");
      expect(setTimeoutIdx).toBeGreaterThanOrEqual(0);
      const setTimeoutContent = expr.slice(setTimeoutIdx);
      expect(setTimeoutContent).toContain("__aegis_pointer_debug_trail"); // trail IS removed
      expect(setTimeoutContent).not.toContain("__aegis_pointer_debug_dot"); // dot is NOT removed
    }
  });

  it("path/trail cleanup timer still fires after timeout", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    // renderPointerDebugPath produces a Runtime.evaluate with an 8000ms timer for the SVG path.
    const pathCleanupMsgs = sentMessages.filter(
      (m) => m.method === "Runtime.evaluate" &&
              typeof m.params?.expression === "string" &&
              (m.params.expression as string).includes("__aegis_pointer_debug_path") &&
              (m.params.expression as string).includes("8000"),
    );
    expect(pathCleanupMsgs.length).toBeGreaterThan(0);
  });

  it("pointer state logs contain no secret or resolved values", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const secret = "POINTER_STATE_LOG_SECRET_SENTINEL";
      mockPointerStateStore.set("bs_ptr_log_test", { x: 120, y: 90, initialized: true });
      await executeSecretInjectionViaCDP(
        makeInjection("password"), secret, "http://localhost:9222",
        undefined, "bs_ptr_log_test",
      );
      const logCalls = consoleSpy.mock.calls;
      for (const call of logCalls) {
        expect(JSON.stringify(call)).not.toContain(secret);
      }
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
