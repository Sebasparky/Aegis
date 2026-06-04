/**
 * Antigen Known-Box Revalidation (Phase 4B) — pure unit tests.
 *
 * Covers the page-side IIFE builder (valid JS, injection-safe center encoding)
 * and the pure compatibility evaluator (ok / stale reasons). No browser, no CDP.
 */

import { describe, it, expect } from "vitest";
import {
  buildAntigenRevalidationExpr,
  evaluateKnownBoxRevalidation,
  type AntigenRevalidationEvalValue,
  type RawLiveElement,
} from "../runtime/antigenKnownBoxRevalidation.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function liveEl(overrides: Partial<RawLiveElement> = {}): RawLiveElement {
  return {
    tag: "a",
    type: null,
    role: null,
    content_editable: false,
    id: null,
    href: null,
    disabled: false,
    aria_disabled: false,
    read_only: false,
    name: "",
    box: { x: 100, y: 200, width: 80, height: 40 },
    visible: true,
    ...overrides,
  };
}

function okEval(live: RawLiveElement): AntigenRevalidationEvalValue {
  return { vw: 1280, vh: 800, status: "ok", live };
}

// ─── buildAntigenRevalidationExpr ──────────────────────────────────────────────

describe("buildAntigenRevalidationExpr", () => {
  it("wraps logic in an IIFE", () => {
    const expr = buildAntigenRevalidationExpr(640, 400);
    expect(expr.trim().startsWith("(function(){")).toBe(true);
    expect(expr.trim().endsWith("})()")).toBe(true);
  });

  it("is valid JS (parseable by the Function constructor)", () => {
    expect(() => new Function(`return ${buildAntigenRevalidationExpr(640, 400)}`)).not.toThrow();
  });

  it("JSON-encodes the center coordinates (injection-safe)", () => {
    const expr = buildAntigenRevalidationExpr(123.5, 456.25);
    expect(expr).toContain("var CX=123.5, CY=456.25;");
  });

  it("uses document.elementFromPoint and never element.click()", () => {
    const expr = buildAntigenRevalidationExpr(10, 20);
    expect(expr).toContain("document.elementFromPoint");
    expect(expr).not.toContain(".click(");
    expect(expr).not.toContain("dispatchEvent");
  });

  it("only reads .value for submit/button/reset inputs", () => {
    const expr = buildAntigenRevalidationExpr(10, 20);
    // The single el.value read is guarded by the submit/button/reset type check.
    expect(expr).toContain("type==='submit'||type==='button'||type==='reset'");
  });
});

// ─── evaluateKnownBoxRevalidation — ok paths ───────────────────────────────────

describe("evaluateKnownBoxRevalidation — ok", () => {
  it("ok when live link matches expected by href_path", () => {
    const ev = okEval(liveEl({ tag: "a", href: "/us/en/p/tertial-work-lamp-70504295/", name: "TERTIAL Work lamp" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "link", href_path: "/us/en/p/tertial-work-lamp-70504295/", normalized_name: "tertial work lamp" },
    });
    expect(result.status).toBe("ok");
  });

  it("ok when live button name matches expected name", () => {
    const ev = okEval(liveEl({ tag: "button", href: null, name: "Add to bag" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "button", name: "Add to bag", normalized_name: "add to bag" },
    });
    expect(result.status).toBe("ok");
  });

  it("ok when expected name is empty but kind matches (href absent)", () => {
    const ev = okEval(liveEl({ tag: "button", name: "" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "button", normalized_name: "" },
    });
    expect(result.status).toBe("ok");
  });

  it("ok on contains-match for short UI labels (live 'Add to bag' vs expected 'bag')", () => {
    const ev = okEval(liveEl({ tag: "button", name: "Add to bag" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "button", normalized_name: "bag" },
    });
    expect(result.status).toBe("ok");
  });
});

// ─── evaluateKnownBoxRevalidation — stale paths ────────────────────────────────

describe("evaluateKnownBoxRevalidation — stale", () => {
  it("BOX_OUT_OF_VIEWPORT when the center fell outside the viewport", () => {
    const result = evaluateKnownBoxRevalidation({
      eval: { vw: 1280, vh: 800, status: "out_of_viewport" },
      expected: { kind: "link" },
    });
    expect(result).toEqual({ status: "stale", reason: "BOX_OUT_OF_VIEWPORT" });
  });

  it("NO_ELEMENT_AT_POINT when elementFromPoint returned nothing", () => {
    const result = evaluateKnownBoxRevalidation({
      eval: { vw: 1280, vh: 800, status: "no_element" },
      expected: { kind: "link" },
    });
    expect(result).toEqual({ status: "stale", reason: "NO_ELEMENT_AT_POINT" });
  });

  it("LIVE_ELEMENT_NOT_VISIBLE when the live element is not visible", () => {
    const ev = okEval(liveEl({ tag: "button", name: "Add to bag", visible: false }));
    const result = evaluateKnownBoxRevalidation({ eval: ev, expected: { kind: "button", normalized_name: "add to bag" } });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reason).toBe("LIVE_ELEMENT_NOT_VISIBLE");
  });

  it("LIVE_ELEMENT_NOT_VISIBLE when the live element is disabled", () => {
    const ev = okEval(liveEl({ tag: "button", name: "Add to bag", disabled: true }));
    const result = evaluateKnownBoxRevalidation({ eval: ev, expected: { kind: "button", normalized_name: "add to bag" } });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reason).toBe("LIVE_ELEMENT_NOT_VISIBLE");
  });

  it("HREF_PATH_MISMATCH when expected href_path differs from live href_path", () => {
    const ev = okEval(liveEl({ tag: "a", href: "/us/en/p/some-other-product-99999/", name: "TERTIAL Work lamp" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "link", href_path: "/us/en/p/tertial-work-lamp-70504295/", normalized_name: "tertial work lamp" },
    });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reason).toBe("HREF_PATH_MISMATCH");
  });

  it("ROLE_KIND_MISMATCH when expected link but live is a button", () => {
    const ev = okEval(liveEl({ tag: "button", href: null, name: "Subscribe" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "link", normalized_name: "subscribe" },
    });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reason).toBe("ROLE_KIND_MISMATCH");
  });

  it("NAME_MISMATCH on strong name mismatch (same kind, no href)", () => {
    const ev = okEval(liveEl({ tag: "button", href: null, name: "Newsletter signup" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "button", normalized_name: "add to bag" },
    });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.reason).toBe("NAME_MISMATCH");
  });
});

// ─── Result hygiene ────────────────────────────────────────────────────────────

describe("evaluateKnownBoxRevalidation — result hygiene", () => {
  const FORBIDDEN = ["box", "x", "y", "width", "height", "href", "cdp_url", "user_data_dir", "secret_ref", "password", "cookies"];

  it("result/diagnostic carries no boxes, coordinates, full href, or secrets", () => {
    const ev = okEval(liveEl({ tag: "button", href: "/p/full/path", name: "Newsletter signup" }));
    const result = evaluateKnownBoxRevalidation({
      eval: ev,
      expected: { kind: "button", normalized_name: "add to bag", name: "Add to bag" },
    });
    const serialized = JSON.stringify(result);
    for (const key of FORBIDDEN) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    // Full href path must not appear in diagnostics.
    expect(serialized).not.toContain("/p/full/path");
  });
});
