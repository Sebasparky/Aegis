/**
 * Payment Iframe Fill v1 — OPPWA / Worldline tests.
 *
 * Verifies:
 * - sanitizeIframeUrl: strips query and hash
 * - classifyPaymentIframe: OPPWA allowlist, field_kind detection, exclusion rules
 * - OPPWA_ERRORS: expected constant strings
 * - fillOppwaIframeField: CDP state machine, security invariants
 *   - status=not_applicable when no OPPWA targets
 *   - status=filled with raw_value_revealed_to_agent: false and purchase_not_authorized: true
 *   - status=failed with safe error codes (no raw card values in any return)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mocks (hoisted before all imports) ───────────────────────────────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// CDP WebSocket mock — mirrors the pattern in secret-field-masking.test.ts.
// A module-level control variable drives the scenario for each test group.
type WsScenario =
  | "no_oppwa_targets"
  | "card_number_found"
  | "cvv_found"
  | "attach_fails"
  | "input_not_found"
  | "ws_error";

let wsScenario: WsScenario = "card_number_found";

vi.mock("ws", () => {
  const FakeWs = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

    this.terminate = vi.fn();
    this.close = vi.fn();

    this.on = (event: string, h: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(h);
      if (event === "open") setTimeout(() => h(), 0);
      // For "ws_error" scenario, emit error after open
      if (event === "error" && wsScenario === "ws_error") {
        setTimeout(() => h(new Error("WebSocket connection refused")), 5);
      }
    };

    this.send = (raw: string) => {
      const msg = JSON.parse(raw) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };

      const emit = (payload: unknown) =>
        handlers["message"]?.forEach((h) => h(JSON.stringify(payload)));

      if (msg.method === "Target.getTargets") {
        if (wsScenario === "no_oppwa_targets") {
          // Only a page target — no OPPWA iframes
          emit({
            id: msg.id,
            result: {
              targetInfos: [
                { targetId: "t_page", type: "page", url: "https://www.ikea.com/checkout" },
              ],
            },
          });
        } else if (wsScenario === "card_number_found") {
          emit({
            id: msg.id,
            result: {
              targetInfos: [
                {
                  targetId: "t_oppwa_cn",
                  type: "iframe",
                  url: "https://eu-prod.oppwa.com/v1/pciIframe.html?entityId=abc&name=card.number",
                  title: "Card number *",
                },
                {
                  targetId: "t_oppwa_cvv",
                  type: "iframe",
                  url: "https://eu-prod.oppwa.com/v1/pciIframe.html?entityId=abc&name=card.cvv",
                  title: "Security Code CVV",
                },
              ],
            },
          });
        } else if (wsScenario === "cvv_found") {
          emit({
            id: msg.id,
            result: {
              targetInfos: [
                {
                  targetId: "t_oppwa_cn",
                  type: "iframe",
                  url: "https://eu-prod.oppwa.com/v1/pciIframe.html?name=card.number",
                  title: "Card number *",
                },
                {
                  targetId: "t_oppwa_cvv",
                  type: "iframe",
                  url: "https://eu-prod.oppwa.com/v1/pciIframe.html?name=card.cvv",
                  title: "Security Code CVV",
                },
              ],
            },
          });
        } else if (wsScenario === "attach_fails" || wsScenario === "input_not_found") {
          // Two OPPWA iframes present; attach outcome depends on next scenario
          emit({
            id: msg.id,
            result: {
              targetInfos: [
                {
                  targetId: "t_oppwa_cn",
                  type: "iframe",
                  url: "https://eu-prod.oppwa.com/v1/pciIframe.html?name=card.number",
                  title: "Card number *",
                },
                {
                  targetId: "t_oppwa_cvv",
                  type: "iframe",
                  url: "https://eu-prod.oppwa.com/v1/pciIframe.html?name=card.cvv",
                  title: "Security Code CVV",
                },
              ],
            },
          });
        }
      } else if (msg.method === "Target.attachToTarget") {
        if (wsScenario === "attach_fails") {
          emit({ id: msg.id, error: { message: "Target not found", code: -32000 } });
        } else {
          emit({ id: msg.id, result: { sessionId: "mock_iframe_session_42" } });
        }
      } else if (msg.method === "Runtime.evaluate") {
        if (wsScenario === "input_not_found") {
          emit({
            id: msg.id,
            sessionId: msg.sessionId,
            result: {
              result: { type: "object", value: { ok: false, reason: "OPPWA_INPUT_NOT_FOUND" } },
            },
          });
        } else {
          // Successful fill
          emit({
            id: msg.id,
            sessionId: msg.sessionId,
            result: {
              result: { type: "object", value: { ok: true } },
            },
          });
        }
      }
    };
  });

  return { default: FakeWs };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  sanitizeIframeUrl,
  classifyPaymentIframe,
  fillOppwaIframeField,
  OPPWA_ERRORS,
} from "../runtime/paymentIframeFill.js";

// ─── Tests: sanitizeIframeUrl ─────────────────────────────────────────────────

describe("sanitizeIframeUrl", () => {
  it("strips query params from a URL", () => {
    expect(sanitizeIframeUrl("https://eu-prod.oppwa.com/v1/pciIframe.html?entityId=abc&name=card.number"))
      .toBe("https://eu-prod.oppwa.com/v1/pciIframe.html");
  });

  it("strips hash from a URL", () => {
    expect(sanitizeIframeUrl("https://eu-prod.oppwa.com/v1/pciIframe.html#section"))
      .toBe("https://eu-prod.oppwa.com/v1/pciIframe.html");
  });

  it("strips both query and hash", () => {
    expect(sanitizeIframeUrl("https://eu-prod.oppwa.com/v1/pciIframe.html?x=1#y"))
      .toBe("https://eu-prod.oppwa.com/v1/pciIframe.html");
  });

  it("returns the original string when URL parsing fails", () => {
    const invalid = "not-a-url";
    expect(sanitizeIframeUrl(invalid)).toBe(invalid);
  });

  it("preserves a clean URL unchanged", () => {
    expect(sanitizeIframeUrl("https://eu-prod.oppwa.com/v1/pciIframe.html"))
      .toBe("https://eu-prod.oppwa.com/v1/pciIframe.html");
  });
});

// ─── Tests: classifyPaymentIframe ─────────────────────────────────────────────

describe("classifyPaymentIframe", () => {
  it("identifies OPPWA card_number via hostname + correct path + name=card.number (query stripped)", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html?entityId=xyz",
      name: "card.number",
    });
    expect(d.provider).toBe("oppwa");
    expect(d.field_kind).toBe("card_number");
    expect(d.hostname).toBe("eu-prod.oppwa.com");
  });

  it("identifies OPPWA card_number via class wpwl-control-cardNumber", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html",
      classes: ["wpwl-control", "wpwl-control-cardNumber"],
    });
    expect(d.provider).toBe("oppwa");
    expect(d.field_kind).toBe("card_number");
  });

  it("identifies OPPWA cvv via name=card.cvv", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html",
      name: "card.cvv",
    });
    expect(d.provider).toBe("oppwa");
    expect(d.field_kind).toBe("cvv");
  });

  it("identifies OPPWA cvv via class wpwl-control-cvv", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html",
      classes: ["wpwl-control", "wpwl-control-cvv"],
    });
    expect(d.provider).toBe("oppwa");
    expect(d.field_kind).toBe("cvv");
  });

  it("returns provider=unknown for name=internalRequest", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html",
      name: "internalRequest",
    });
    expect(d.provider).toBe("unknown");
    expect(d.field_kind).toBe("unknown");
  });

  it("returns provider=unknown for wpwl-target class", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html",
      classes: ["wpwl-target"],
    });
    expect(d.provider).toBe("unknown");
  });

  it("returns provider=unknown for pay.google.com", () => {
    const d = classifyPaymentIframe({
      origin: "https://pay.google.com/gp/p/ui/pay",
    });
    expect(d.provider).toBe("unknown");
    expect(d.field_kind).toBe("unknown");
  });

  it("returns provider=unknown when pathname is not /v1/pciIframe.html", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v2/otherFrame.html",
      name: "card.number",
    });
    expect(d.provider).toBe("unknown");
  });

  it("sanitizes the input URL before hostname check (strips query)", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html?injected=evil",
      name: "card.cvv",
    });
    // Sanitization should still yield correct hostname
    expect(d.hostname).toBe("eu-prod.oppwa.com");
    expect(d.provider).toBe("oppwa");
    expect(d.field_kind).toBe("cvv");
    // The sanitized origin must not contain the query string
    expect(d.origin).not.toContain("injected");
  });

  it("returns provider=unknown for an unrecognized OPPWA iframe (expiry widget)", () => {
    const d = classifyPaymentIframe({
      origin: "https://eu-prod.oppwa.com/v1/pciIframe.html",
      name: "card.expiry",
    });
    expect(d.provider).toBe("oppwa");
    expect(d.field_kind).toBe("unknown");
  });

  it("accepts subdomain staging.oppwa.com as OPPWA provider", () => {
    const d = classifyPaymentIframe({
      origin: "https://staging.oppwa.com/v1/pciIframe.html",
      name: "card.number",
    });
    expect(d.provider).toBe("oppwa");
    expect(d.field_kind).toBe("card_number");
  });
});

// ─── Tests: OPPWA_ERRORS constants ────────────────────────────────────────────

describe("OPPWA_ERRORS constants", () => {
  it("FRAME_NOT_FOUND", () => expect(OPPWA_ERRORS.FRAME_NOT_FOUND).toBe("OPPWA_FRAME_NOT_FOUND"));
  it("FRAME_ATTACH_FAILED", () => expect(OPPWA_ERRORS.FRAME_ATTACH_FAILED).toBe("OPPWA_FRAME_ATTACH_FAILED"));
  it("INPUT_NOT_FOUND", () => expect(OPPWA_ERRORS.INPUT_NOT_FOUND).toBe("OPPWA_INPUT_NOT_FOUND"));
  it("TYPING_FAILED", () => expect(OPPWA_ERRORS.TYPING_FAILED).toBe("OPPWA_TYPING_FAILED"));
  it("UNSUPPORTED_PROVIDER", () => expect(OPPWA_ERRORS.UNSUPPORTED_PROVIDER).toBe("UNSUPPORTED_PAYMENT_IFRAME_PROVIDER"));
});

// ─── Tests: fillOppwaIframeField — not_applicable ────────────────────────────

describe("fillOppwaIframeField — not_applicable (no OPPWA targets)", () => {
  beforeEach(() => { wsScenario = "no_oppwa_targets"; });

  it("returns status=not_applicable when CDP targets contain no OPPWA iframes", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    expect(result.status).toBe("not_applicable");
  });
});

// ─── Tests: fillOppwaIframeField — card_number fill ──────────────────────────

describe("fillOppwaIframeField — card_number fill", () => {
  beforeEach(() => { wsScenario = "card_number_found"; });

  it("returns status=filled", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    expect(result.status).toBe("filled");
  });

  it("result has raw_value_revealed_to_agent: false", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    if (result.status === "filled") {
      // TypeScript literal check
      const x: false = result.raw_value_revealed_to_agent;
      expect(x).toBe(false);
    } else {
      throw new Error("Expected status=filled");
    }
  });

  it("result has purchase_not_authorized: true", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    if (result.status === "filled") {
      const x: true = result.purchase_not_authorized;
      expect(x).toBe(true);
    } else {
      throw new Error("Expected status=filled");
    }
  });

  it("result has iframe_provider=oppwa", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    if (result.status === "filled") {
      expect(result.iframe_provider).toBe("oppwa");
    } else {
      throw new Error("Expected status=filled");
    }
  });

  it("result has iframe_origin=https://eu-prod.oppwa.com", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    if (result.status === "filled") {
      expect(result.iframe_origin).toBe("https://eu-prod.oppwa.com");
    } else {
      throw new Error("Expected status=filled");
    }
  });

  it("result has iframe_path=/v1/pciIframe.html", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    if (result.status === "filled") {
      expect(result.iframe_path).toBe("/v1/pciIframe.html");
    } else {
      throw new Error("Expected status=filled");
    }
  });

  it("result JSON does NOT contain raw resolvedValue (PAN leak check)", async () => {
    const pan = "4111111111111111";
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: pan,
    });
    expect(JSON.stringify(result)).not.toContain(pan);
  });
});

// ─── Tests: fillOppwaIframeField — cvv fill ───────────────────────────────────

describe("fillOppwaIframeField — cvv fill", () => {
  beforeEach(() => { wsScenario = "cvv_found"; });

  it("returns status=filled for cvv", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "cvv",
      resolvedValue: "123",
    });
    expect(result.status).toBe("filled");
  });

  it("cvv result has raw_value_revealed_to_agent: false", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "cvv",
      resolvedValue: "123",
    });
    if (result.status === "filled") {
      const x: false = result.raw_value_revealed_to_agent;
      expect(x).toBe(false);
    } else {
      throw new Error("Expected status=filled");
    }
  });

  it("cvv result has purchase_not_authorized: true", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "cvv",
      resolvedValue: "123",
    });
    if (result.status === "filled") {
      const x: true = result.purchase_not_authorized;
      expect(x).toBe(true);
    } else {
      throw new Error("Expected status=filled");
    }
  });

  it("cvv result JSON does NOT contain raw CVV value", async () => {
    const cvv = "987";
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "cvv",
      resolvedValue: cvv,
    });
    expect(JSON.stringify(result)).not.toContain(cvv);
  });
});

// ─── Tests: fillOppwaIframeField — failure cases ──────────────────────────────

describe("fillOppwaIframeField — OPPWA_FRAME_ATTACH_FAILED", () => {
  beforeEach(() => { wsScenario = "attach_fails"; });

  it("returns status=failed with error_code OPPWA_FRAME_ATTACH_FAILED", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error_code).toBe(OPPWA_ERRORS.FRAME_ATTACH_FAILED);
      expect(result.iframe_provider).toBe("oppwa");
      expect(result.raw_value_revealed_to_agent).toBe(false);
      expect(result.purchase_not_authorized).toBe(true);
    }
  });

  it("attach failure result JSON does not contain raw card value", async () => {
    const pan = "4111111111111111";
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: pan,
    });
    expect(JSON.stringify(result)).not.toContain(pan);
  });
});

describe("fillOppwaIframeField — OPPWA_INPUT_NOT_FOUND", () => {
  beforeEach(() => { wsScenario = "input_not_found"; });

  it("returns status=failed with error_code OPPWA_INPUT_NOT_FOUND", async () => {
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: "4111111111111111",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error_code).toBe(OPPWA_ERRORS.INPUT_NOT_FOUND);
      expect(result.raw_value_revealed_to_agent).toBe(false);
      expect(result.purchase_not_authorized).toBe(true);
    }
  });

  it("input not found result JSON does not contain raw card value", async () => {
    const pan = "5500005555555559";
    const result = await fillOppwaIframeField({
      browserWsUrl: "ws://localhost:9222/devtools/browser/fake",
      field_kind: "card_number",
      resolvedValue: pan,
    });
    expect(JSON.stringify(result)).not.toContain(pan);
  });
});
