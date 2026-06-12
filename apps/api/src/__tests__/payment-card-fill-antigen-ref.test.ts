/**
 * Antigen-ref bridge for protected payment-card fill — unit tests.
 *
 * The IKEA payment page renders two TOP-LEVEL DOM fields (expiry MM/YY, cardholder)
 * that the snapshot locates but the legacy selector fallbacks could not (CDP_FILL_FAILED
 * / element_not_found). The fix lets the agent pass the opaque `ag_*` snapshot ref it
 * already holds; Aegis resolves it server-side to the snapshot's stored element and
 * derives an id/box-based selector — without ever exposing the id, box, coordinates,
 * or CDP expression to the agent.
 *
 * Coverage:
 *   1. isAntigenRef accepts only opaque `ag_<n>` tokens (never selectors).
 *   2. buildRefSelectorExpr prefers getElementById(id); falls back to elementFromPoint
 *      at the box center + closest('input,select,textarea'); never embeds a raw value.
 *   3. executePaymentCardFillViaCDP with a resolvable antigen_ref fills via the ref-built
 *      selector (NOT the field fallback selectors), for a top-level field.
 *   4. Fall-through: expiry_combined whose OPPWA iframe path is not_applicable still uses
 *      the antigen_ref on the parent page.
 *   5. Fail closed (no fill dispatched, no leak) on stale / no_snapshot / ref_not_found
 *      and on a malformed ref.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

const refMock = vi.hoisted(() => ({
  // Default: a resolvable element record carrying an id + box (internal only).
  resolution: {
    status: "ok",
    element: {
      id: "cardholder-input",
      box: { x: 100, y: 220, width: 240, height: 40 },
    },
    snapshot_url: "https://www.ikea.com/pay",
    snapshot_id: "snap_1",
  } as Record<string, unknown>,
}));

vi.mock("../runtime/antigenSnapshotStore.js", () => ({
  resolveAntigenRefForSession: vi.fn(() => refMock.resolution),
}));

// Capture the selectorExpr handed to the protected primitive; never run a real fill.
const fillSpy = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("../runtime/protectedRealisticFill.js", () => ({
  executeProtectedRealisticFill: vi.fn((params: Record<string, unknown>) => {
    fillSpy.calls.push(params);
    return Promise.resolve({ success: true, field_shape: "input" });
  }),
}));

// OPPWA iframe path: not_applicable so card-eligible fields fall through to the parent page.
vi.mock("../runtime/paymentIframeFill.js", () => ({
  fillOppwaIframeField: vi.fn(() => Promise.resolve({ status: "not_applicable" })),
}));

import {
  executePaymentCardFillViaCDP,
  buildRefSelectorExpr,
  isAntigenRef,
} from "../runtime/paymentCardFill.js";
import { resolveAntigenRefForSession } from "../runtime/antigenSnapshotStore.js";
import { executeProtectedRealisticFill } from "../runtime/protectedRealisticFill.js";
import type { PaymentCardFillRequest, PaymentCardField } from "@aegis/types";

const CDP_BASE = "http://localhost:9222";
const DOMAIN = "ikea.com";
const PAGE_URL = "https://www.ikea.com/pay";
const SESSION_ID = "tbsess_test";
const USER_ID = "user_demo_001";
const CARDHOLDER_VALUE = "Demo Cardholder";

function stubCdpFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/json/version")) {
        return Promise.resolve({ json: () => Promise.resolve({ webSocketDebuggerUrl: "ws://localhost:9222/browser" }) });
      }
      if (url.endsWith("/json/list")) {
        return Promise.resolve({ json: () => Promise.resolve([{ id: "page-1", url: PAGE_URL, type: "page" }]) });
      }
      return Promise.resolve({ json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch,
  );
}

function fillRequest(field: PaymentCardField, antigen_ref: string): PaymentCardFillRequest {
  return {
    fill_request_id: "pcfr_test_1",
    authorization_id: "pca_test_1",
    user_id: USER_ID,
    delegation_id: "del_test_1",
    domain: DOMAIN,
    payment_method_id: "pm_test_1",
    field,
    page_url: PAGE_URL,
    element_hint: { antigen_ref },
    reason: "fill at checkout",
    status: "approved",
    browser_session_id: SESSION_ID,
    raw_values_revealed_to_agent: false,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fillSpy.calls = [];
  vi.unstubAllGlobals();
  refMock.resolution = {
    status: "ok",
    element: { id: "cardholder-input", box: { x: 100, y: 220, width: 240, height: 40 } },
    snapshot_url: PAGE_URL,
    snapshot_id: "snap_1",
  };
});

// ─── 1. isAntigenRef ──────────────────────────────────────────────────────────

describe("isAntigenRef", () => {
  it("accepts opaque ag_<n> tokens", () => {
    expect(isAntigenRef("ag_1")).toBe(true);
    expect(isAntigenRef("ag_42")).toBe(true);
  });
  it("rejects selectors and malformed tokens", () => {
    for (const bad of ["ag_", "ag_x", "AG_1", "ag-1", "input[name=card]", "#cardholder", ".wpwl-control", "../etc", "ag_1; drop", ""]) {
      expect(isAntigenRef(bad)).toBe(false);
    }
  });
});

// ─── 2. buildRefSelectorExpr ──────────────────────────────────────────────────

describe("buildRefSelectorExpr", () => {
  it("prefers getElementById when the snapshot captured an id — and walks a non-fillable id-hit", () => {
    const expr = buildRefSelectorExpr({ id: "card-holder", box: { x: 10, y: 20, width: 100, height: 30 } } as never);
    expect(expr).toContain('document.getElementById("card-holder")');
    expect(expr).toContain("document.elementFromPoint(cx, cy)"); // box-center fallback still present
    // The id-hit goes through resolve() — a wrapper id no longer returns raw.
    expect(expr).toContain("var r1 = resolve(byId)");
  });

  it("uses elementFromPoint at the box center when no id is present", () => {
    const expr = buildRefSelectorExpr({ id: null, box: { x: 100, y: 200, width: 240, height: 40 } } as never);
    // center = (100 + 120, 200 + 20) = (220, 220)
    expect(expr).toContain("var cx = 220, cy = 220");
    expect(expr).toContain("document.elementFromPoint(cx, cy)");
    expect(expr).toContain("var byId = null");
  });

  it("never embeds a raw value (record carries no value)", () => {
    const expr = buildRefSelectorExpr({ id: "x", box: { x: 0, y: 0, width: 10, height: 10 } } as never);
    expect(expr).not.toMatch(/4242|cvv|password|cardholder value/i);
  });

  it("fails closed: resolves to null when nothing fillable is found (no raw element tail)", () => {
    const expr = buildRefSelectorExpr({ id: null, box: { x: 0, y: 0, width: 10, height: 10 } } as never);
    // The old bug: `return el;` handed a label/span/div to the fill primitive,
    // whose HTMLInputElement-prototype setter call then threw "Illegal invocation".
    expect(expr).not.toMatch(/return el;/);
    expect(expr).toContain("return el ? resolve(el) : null");
    expect(expr).toContain("return null");
  });

  it("walks floating-label markup: label association + bounded ancestor walk + 150px cap", () => {
    const expr = buildRefSelectorExpr({ id: null, box: { x: 0, y: 0, width: 10, height: 10 } } as never);
    expect(expr).toContain("closest('label')");
    expect(expr).toContain("htmlFor");
    expect(expr).toContain("lab.control");
    expect(expr).toContain("depth <= 3");
    expect(expr).toContain("150 * 150");
    expect(expr).toContain("containsPoint");
  });

  it("restricts candidates to the snapshot-recorded tag when it is fillable", () => {
    const inputExpr = buildRefSelectorExpr({ id: null, tag: "input", box: { x: 0, y: 0, width: 10, height: 10 } } as never);
    expect(inputExpr).toContain(`var SEL = "input"`);
    const selectExpr = buildRefSelectorExpr({ id: null, tag: "select", box: { x: 0, y: 0, width: 10, height: 10 } } as never);
    expect(selectExpr).toContain(`var SEL = "select"`);
    // Unknown/unfillable recorded tag → all three accepted.
    const otherExpr = buildRefSelectorExpr({ id: null, tag: "div", box: { x: 0, y: 0, width: 10, height: 10 } } as never);
    expect(otherExpr).toContain(`var SEL = "input,select,textarea"`);
  });
});

// ─── 3 & 4. executePaymentCardFillViaCDP uses the ref-built selector ──────────

describe("executePaymentCardFillViaCDP — antigen_ref bridge", () => {
  it("fills a top-level cardholder field via the ref-built selector (not fallback selectors)", async () => {
    stubCdpFetch();
    const result = await executePaymentCardFillViaCDP(fillRequest("cardholder_name", "ag_7"), CARDHOLDER_VALUE, CDP_BASE);

    expect(result.success).toBe(true);
    expect(resolveAntigenRefForSession).toHaveBeenCalledWith(SESSION_ID, USER_ID, "ag_7");
    expect(executeProtectedRealisticFill).toHaveBeenCalledTimes(1);

    const passed = fillSpy.calls[0];
    const selectorExpr = String(passed.selectorExpr);
    // Ref-built selector — NOT the wpwl/autocomplete/name fallback list.
    expect(selectorExpr).toContain('document.getElementById("cardholder-input")');
    expect(selectorExpr).toContain("document.elementFromPoint(");
    expect(selectorExpr).not.toContain(".wpwl-control");
    expect(selectorExpr).not.toContain('autocomplete="cc-name"');
    // visualMask must stay on for cardholder so screenshot redaction reaches 4/4.
    expect(passed.visualMask).toBe(true);
    expect(passed.maskDomValue).toBe(true);
  });

  it("falls through OPPWA not_applicable and still uses antigen_ref for top-level expiry", async () => {
    stubCdpFetch();
    refMock.resolution = {
      status: "ok",
      element: { id: null, box: { x: 100, y: 200, width: 240, height: 40 } },
      snapshot_url: PAGE_URL,
      snapshot_id: "snap_1",
    };
    const result = await executePaymentCardFillViaCDP(fillRequest("expiry_combined", "ag_9"), "12/29", CDP_BASE);

    expect(result.success).toBe(true);
    const selectorExpr = String(fillSpy.calls[0].selectorExpr);
    expect(selectorExpr).toContain("var cx = 220, cy = 220");
    expect(selectorExpr).toContain("document.elementFromPoint(cx, cy)");
    expect(selectorExpr).not.toContain(".wpwl-control-expiry");
  });
});

// ─── 5. Fail closed, no leak ──────────────────────────────────────────────────

describe("executePaymentCardFillViaCDP — antigen_ref fail-closed", () => {
  it.each(["no_snapshot", "expired", "ref_not_found"])(
    "fails closed without dispatching a fill when resolution is %s",
    async (status) => {
      stubCdpFetch();
      refMock.resolution = { status } as Record<string, unknown>;
      const result = await executePaymentCardFillViaCDP(fillRequest("cardholder_name", "ag_3"), CARDHOLDER_VALUE, CDP_BASE);

      expect(result.success).toBe(false);
      expect(result.error).toBe("ANTIGEN_REF_STALE");
      expect(executeProtectedRealisticFill).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed ref without resolving or filling", async () => {
    stubCdpFetch();
    const result = await executePaymentCardFillViaCDP(fillRequest("cardholder_name", "input[name=card]" as string), CARDHOLDER_VALUE, CDP_BASE);

    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_ANTIGEN_REF");
    expect(resolveAntigenRefForSession).not.toHaveBeenCalled();
    expect(executeProtectedRealisticFill).not.toHaveBeenCalled();
  });

  it("never leaks id/box/coordinates in the failure result", async () => {
    stubCdpFetch();
    refMock.resolution = { status: "expired" } as Record<string, unknown>;
    const result = await executePaymentCardFillViaCDP(fillRequest("cardholder_name", "ag_3"), CARDHOLDER_VALUE, CDP_BASE);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("cardholder-input");
    expect(serialized).not.toContain("elementFromPoint");
    expect(serialized).not.toMatch(/box|getElementById|\b220\b/);
  });
});
