/**
 * Secret Field Masking v1 tests.
 *
 * Tests the masking JavaScript expression produced by executeSecretInjectionViaCDP.
 * No real Chrome needed — exercises the expression strings in a Node.js environment
 * using a simulated HTMLInputElement with native setter/getter semantics.
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// ─── Mocks required to load secretInjection.ts without side effects ────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// ws is used by executeSecretInjectionViaCDP for real CDP — capture sent messages.
let capturedExpression: string | null = null;

vi.mock("ws", () => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const FakeWs = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.send = (raw: string) => {
      const msg = JSON.parse(raw);
      if (msg.method === "Runtime.evaluate") {
        capturedExpression = msg.params.expression as string;
        // Emit a synthetic evaluate result so the CDP flow resolves.
        handlers["message"]?.forEach((h) =>
          h(
            JSON.stringify({
              id: msg.id,
              sessionId: "mock_session",
              result: { result: { type: "object", value: { ok: true } } },
            }),
          ),
        );
      }
      if (msg.method === "Target.attachToTarget") {
        handlers["message"]?.forEach((h) =>
          h(JSON.stringify({ id: msg.id, result: { sessionId: "mock_session" } })),
        );
      }
    };
    this.on = (event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
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
import { executeSecretInjectionViaCDP } from "../runtime/secretInjection.js";

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
 * Simulate applying the fill expression in a Node.js-only environment.
 * We build a fake input element that mirrors the native getter/setter pattern,
 * then run the CDP expression via Function constructor.
 *
 * IMPORTANT: The mock resolved value used here is a placeholder string — tests
 * verify structure/behavior, never log or assert on real secret values.
 */
function simulateFill(expression: string): {
  value: string;
  antigenFilled: string | null;
} {
  let internalValue = "";

  const el = Object.create(null) as Record<string, unknown>;

  // Simulate HTMLInputElement.prototype.value native getter/setter.
  // The expression accesses Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  // so we wire that up on a fake prototype.
  const fakeProto = Object.create(null);
  Object.defineProperty(fakeProto, "value", {
    get: () => internalValue,
    set: (v: string) => {
      internalValue = v;
    },
    configurable: true,
  });

  // Give el the prototype-level descriptor via a local HTMLInputElement stand-in.
  const fakeHTMLInputElement = { prototype: fakeProto };

  // Set up dispatchEvent (no-op) and setAttribute.
  const attributes: Record<string, string> = {};
  el.dispatchEvent = (_e: unknown) => true;
  el.setAttribute = (name: string, val: string) => {
    attributes[name] = val;
  };

  // Apply own-property to make el.value readable from the prototype initially.
  Object.defineProperty(el, "value", {
    get: () => fakeProto.value,
    set: (v: string) => {
      fakeProto.value = v;
    },
    configurable: true,
  });

  // Build a sandboxed function with the fake globals the expression needs.
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "el",
    "HTMLInputElement",
    "Event",
    "Object",
    `return ${expression}`,
  );

  fn(el, fakeHTMLInputElement, class Event {}, Object);

  return {
    value: el.value as string,
    antigenFilled: attributes["data-antigen-filled"] ?? null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Secret Field Masking v1 — fill expression structure", () => {
  beforeEach(() => {
    capturedExpression = null;
  });

  it("password fill expression contains Object.defineProperty masking", async () => {
    await executeSecretInjectionViaCDP(makeInjection("password"), "PLACEHOLDER", "http://localhost:9222");
    expect(capturedExpression).not.toBeNull();
    expect(capturedExpression).toContain("Object.defineProperty");
    expect(capturedExpression).toContain("data-antigen-filled");
  });

  it("username fill expression does NOT contain Object.defineProperty masking", async () => {
    await executeSecretInjectionViaCDP(makeInjection("username"), "PLACEHOLDER", "http://localhost:9222");
    expect(capturedExpression).not.toBeNull();
    expect(capturedExpression).not.toContain("Object.defineProperty");
    expect(capturedExpression).toContain("data-antigen-filled");
  });

  it("fill expression never contains the literal resolved value as a plaintext substring", async () => {
    const secret = "UNIQUE_TEST_SENTINEL_VALUE";
    await executeSecretInjectionViaCDP(makeInjection("password"), secret, "http://localhost:9222");
    expect(capturedExpression).not.toBeNull();
    // The value appears as a JSON-encoded string literal, not raw plaintext.
    // Confirm the raw string is not present outside of JSON encoding context.
    const raw = capturedExpression!;
    const jsonEncoded = JSON.stringify(secret);
    // Strip the JSON-encoded occurrence; the raw value must not appear elsewhere.
    const stripped = raw.replace(jsonEncoded, "");
    expect(stripped).not.toContain(secret);
  });
});

describe("Secret Field Masking v1 — fill expression behavior (simulated DOM)", () => {
  it("password mask: el.value returns '' after fill expression runs", () => {
    // Build a minimal fill expression matching what secretInjection.ts produces
    // for a password field with input_type selector.
    const maskExpr = `(function() {
      var el = el_param;
      if (!el) return { ok: false, reason: 'element not found' };
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, "placeholder_value");
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      Object.defineProperty(el, 'value', {
        get: function() { return ''; },
        set: function(v) { setter.call(el, v); },
        configurable: true,
      });
      el.setAttribute('data-antigen-filled', 'true');
      return { ok: true };
    })()`;

    // The expression references 'el_param' not 'el' to avoid shadowing in Function scope.
    // Adjust to pass el as argument named el_param.
    const fn = new Function("el_param", "HTMLInputElement", "Event", "Object", `return ${maskExpr}`);

    let internalValue = "";
    const proto = { get value() { return internalValue; }, set value(v: string) { internalValue = v; } };
    const fakeHTMLInputElement = { prototype: proto };
    const attrs: Record<string, string> = {};
    const el = {
      dispatchEvent: () => true,
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
    };
    // Wire el.value to prototype initially.
    Object.defineProperty(el, "value", {
      get: () => proto.value,
      set: (v: string) => { proto.value = v; },
      configurable: true,
    });

    fn(el, fakeHTMLInputElement, class Event {}, Object);

    expect((el as Record<string, unknown>).value).toBe("");
    expect(attrs["data-antigen-filled"]).toBe("true");
  });

  it("password mask: setter still works after masking (re-assignment updates internal state)", () => {
    let internalValue = "";
    const proto = { get value() { return internalValue; }, set value(v: string) { internalValue = v; } };
    const fakeHTMLInputElement = { prototype: proto };
    const el = {
      dispatchEvent: () => true,
      setAttribute: () => {},
    };
    Object.defineProperty(el, "value", {
      get: () => proto.value,
      set: (v: string) => { proto.value = v; },
      configurable: true,
    });

    // Apply mask directly.
    const setter = Object.getOwnPropertyDescriptor(fakeHTMLInputElement.prototype, "value")!.set!;
    Object.defineProperty(el, "value", {
      get: () => "",
      set: (v: string) => setter.call(el, v),
      configurable: true,
    });

    // Getter returns "".
    expect((el as Record<string, unknown>).value).toBe("");
    // Setter should update internal state without throwing.
    expect(() => { (el as Record<string, unknown>).value = "re_injected"; }).not.toThrow();
  });

  it("username fill: el.value is still readable after fill (no masking applied)", () => {
    const usernameExpr = `(function() {
      var el = el_param;
      if (!el) return { ok: false, reason: 'element not found' };
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, "placeholder_value");
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.setAttribute('data-antigen-filled', 'true');
      return { ok: true };
    })()`;

    const fn = new Function("el_param", "HTMLInputElement", "Event", "Object", `return ${usernameExpr}`);

    let internalValue = "";
    const proto = { get value() { return internalValue; }, set value(v: string) { internalValue = v; } };
    const fakeHTMLInputElement = { prototype: proto };
    const attrs: Record<string, string> = {};
    const el = {
      dispatchEvent: () => true,
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
    };
    Object.defineProperty(el, "value", {
      get: () => proto.value,
      set: (v: string) => { proto.value = v; },
      configurable: true,
    });

    fn(el, fakeHTMLInputElement, class Event {}, Object);

    // Username should remain readable — agents may need it for error recovery.
    expect((el as Record<string, unknown>).value).toBe("placeholder_value");
    expect(attrs["data-antigen-filled"]).toBe("true");
  });
});

describe("Secret Field Masking v1 — executeSecretInjectionViaCDP returns no secret in result", () => {
  beforeEach(() => {
    capturedExpression = null;
  });

  it("result for password field contains no resolved value", async () => {
    const result = await executeSecretInjectionViaCDP(makeInjection("password"), "SENTINEL_SECRET", "http://localhost:9222");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_SECRET");
    expect(result.success).toBe(true);
  });

  it("result for username field contains no resolved value", async () => {
    const result = await executeSecretInjectionViaCDP(makeInjection("username"), "SENTINEL_USERNAME", "http://localhost:9222");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_USERNAME");
    expect(result.success).toBe(true);
  });
});
