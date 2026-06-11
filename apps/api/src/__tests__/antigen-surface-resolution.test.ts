/**
 * Antigen Surface-Scoped Live Resolution (ANTIGEN_SURFACE_RESOLVE, default-off)
 * — pure unit tests.
 *
 * The matcher under test re-resolves a stale surface-member ref by SEMANTIC
 * identity (overlay type + accessible title → unique unoccluded compatible
 * action). All fixtures are generic panel/dialog style. Endpoint wiring is
 * covered in antigen-surface-resolution-endpoint.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  isSurfaceResolveEnabled,
  isSurfaceResolutionEligible,
  checkSurfaceLiveIntent,
  pickSurfaceActionMatch,
  buildSurfaceActionSearchExpr,
  type RawSurfaceCandidate,
  type SurfaceActionSearchValue,
  type SurfaceIdentity,
} from "../runtime/antigenSurfaceResolution.js";
import type { AntigenKnownBoxRevalidationExpected } from "../runtime/antigenKnownBoxRevalidation.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PANEL: SurfaceIdentity = {
  overlay_type: "dialog",
  modal_title: "GLIMMA was added to your shopping bag",
};

const GO_TO_BAG_EXPECTED: AntigenKnownBoxRevalidationExpected = {
  tag: "a",
  kind: "link",
  role: "link",
  name: "Go to shopping bag",
  normalized_name: "go to shopping bag",
  href_path: "/us/en/shoppingcart/",
};

function surfaceCandidate(overrides: Partial<RawSurfaceCandidate> = {}): RawSurfaceCandidate {
  return {
    tag: "a",
    type: null,
    role: "link",
    content_editable: false,
    id: null,
    href: "/us/en/shoppingcart/",
    disabled: false,
    aria_disabled: false,
    read_only: false,
    name: "Go to shopping bag",
    visible: true,
    box: { x: 850, y: 860, width: 220, height: 44 },
    surface: { type: "dialog", title: "GLIMMA was added to your shopping bag", blocking: true },
    hit_match: true,
    ...overrides,
  };
}

function searchOk(candidates: RawSurfaceCandidate[], vw = 1280, vh = 1000): SurfaceActionSearchValue {
  return { vw, vh, status: "ok", candidates };
}

// ─── Flag ────────────────────────────────────────────────────────────────────

describe("isSurfaceResolveEnabled — strict opt-in", () => {
  afterEach(() => {
    delete process.env.ANTIGEN_SURFACE_RESOLVE;
  });

  it("is off by default and for any non-'true' value", () => {
    delete process.env.ANTIGEN_SURFACE_RESOLVE;
    expect(isSurfaceResolveEnabled()).toBe(false);
    process.env.ANTIGEN_SURFACE_RESOLVE = "1";
    expect(isSurfaceResolveEnabled()).toBe(false);
  });

  it("is on only for the literal 'true'", () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    expect(isSurfaceResolveEnabled()).toBe(true);
  });
});

// ─── Eligibility (default-deny) ──────────────────────────────────────────────

describe("isSurfaceResolutionEligible — low-risk intents only, denylist wins", () => {
  it("allows low-risk reversible intents for non-denylisted names", () => {
    expect(isSurfaceResolutionEligible(GO_TO_BAG_EXPECTED, "navigation")).toBe(true);
    expect(
      isSurfaceResolutionEligible(
        { kind: "button", normalized_name: "add to bag", href_path: null },
        "cart_mutation",
      ),
    ).toBe(true);
    // Unlike page-wide recovery there is no name allowlist: an unlisted but
    // low-risk panel action ("continue as guest") is eligible in surface scope.
    expect(
      isSurfaceResolutionEligible(
        { kind: "button", normalized_name: "continue as guest", href_path: null },
        "navigation",
      ),
    ).toBe(true);
  });

  it("refuses any non-low-risk intent regardless of name", () => {
    for (const intent of ["final_commit", "publish_send", "account_security_change", "high_liability_submit", "protected_fill", "uncertain"]) {
      expect(isSurfaceResolutionEligible(GO_TO_BAG_EXPECTED, intent)).toBe(false);
    }
  });

  it("refuses sensitive-commit denylisted names even with a low-risk intent", () => {
    for (const n of ["remove from bag", "checkout", "continue to payment", "sign in", "delete", "accept", "send"]) {
      expect(
        isSurfaceResolutionEligible({ kind: "button", normalized_name: n, href_path: null }, "cart_mutation"),
      ).toBe(false);
    }
  });
});

// ─── Live intent re-check ────────────────────────────────────────────────────

describe("checkSurfaceLiveIntent — defense-in-depth drift guard", () => {
  it("accepts a live navigation link", () => {
    const r = checkSurfaceLiveIntent(
      { name: "Go to shopping bag", kind: "link", href_path: "/us/en/shoppingcart/" },
      {},
    );
    expect(r.ok).toBe(true);
    expect(r.live_intent).toBe("navigation");
  });

  it("refuses a live element that re-classifies as final_commit", () => {
    const r = checkSurfaceLiveIntent({ name: "Pay now", kind: "button", href_path: null }, {});
    expect(r.ok).toBe(false);
    expect(r.live_intent).toBe("final_commit");
  });
});

// ─── Surface + action matching ───────────────────────────────────────────────

describe("pickSurfaceActionMatch — surface identity", () => {
  it("resolves the unique action inside the matching surface", () => {
    const pick = pickSurfaceActionMatch(searchOk([surfaceCandidate()]), GO_TO_BAG_EXPECTED, PANEL);
    expect(pick.status).toBe("resolved");
    if (pick.status === "resolved") {
      expect(pick.box).toEqual({ x: 850, y: 860, width: 220, height: 44 });
      expect(pick.live).toEqual({ name: "Go to shopping bag", kind: "link", href_path: "/us/en/shoppingcart/" });
    }
  });

  it("surface_gone when no live overlay of the expected type exists (panel dismissed)", () => {
    const toastOnly = surfaceCandidate({ surface: { type: "toast", title: "Added", blocking: false } });
    expect(pickSurfaceActionMatch(searchOk([toastOnly]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("surface_gone");
    expect(pickSurfaceActionMatch(searchOk([]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("surface_gone");
  });

  it("singleton relaxation: a churned title still matches when exactly ONE surface of the type is live", () => {
    const churned = surfaceCandidate({
      surface: { type: "dialog", title: "2 items were added to your shopping bag", blocking: true },
    });
    expect(pickSurfaceActionMatch(searchOk([churned]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("resolved");
  });

  it("two same-type surfaces with non-matching titles → surface_ambiguous (no singleton relaxation)", () => {
    const a = surfaceCandidate({ surface: { type: "dialog", title: "Something else entirely", blocking: true } });
    const b = surfaceCandidate({
      name: "Other action",
      surface: { type: "dialog", title: "A third unrelated dialog", blocking: true },
    });
    expect(pickSurfaceActionMatch(searchOk([a, b]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("surface_ambiguous");
  });

  it("title-compatible match wins over an unrelated same-type peer", () => {
    const match = surfaceCandidate(); // exact title
    const other = surfaceCandidate({
      name: "Go to shopping bag",
      surface: { type: "dialog", title: "Newsletter signup", blocking: false },
      box: { x: 10, y: 10, width: 50, height: 20 },
    });
    const pick = pickSurfaceActionMatch(searchOk([match, other]), GO_TO_BAG_EXPECTED, PANEL);
    expect(pick.status).toBe("resolved");
    if (pick.status === "resolved") expect(pick.box.x).toBe(850);
  });

  it("two title-compatible same-type surfaces → surface_ambiguous", () => {
    const a = surfaceCandidate();
    const b = surfaceCandidate({
      surface: { type: "dialog", title: "GLIMMA was added to your shopping bag today", blocking: true },
    });
    expect(pickSurfaceActionMatch(searchOk([a, b]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("surface_ambiguous");
  });
});

describe("pickSurfaceActionMatch — action uniqueness + occlusion", () => {
  it("two compatible unoccluded duplicates → action_ambiguous (never guess)", () => {
    const a = surfaceCandidate();
    const b = surfaceCandidate({ box: { x: 850, y: 920, width: 220, height: 44 } });
    expect(pickSurfaceActionMatch(searchOk([a, b]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("action_ambiguous");
  });

  it("an occluded duplicate (hit_match=false) does not block the visible top-most one", () => {
    const occluded = surfaceCandidate({ hit_match: false, box: { x: 850, y: 920, width: 220, height: 44 } });
    const visible = surfaceCandidate();
    const pick = pickSurfaceActionMatch(searchOk([occluded, visible]), GO_TO_BAG_EXPECTED, PANEL);
    expect(pick.status).toBe("resolved");
    if (pick.status === "resolved") expect(pick.box.y).toBe(860);
  });

  it("no compatible action in the surface → action_not_found", () => {
    const different = surfaceCandidate({
      name: "Continue shopping",
      href: null,
      tag: "button",
      role: "button",
    });
    expect(pickSurfaceActionMatch(searchOk([different]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("action_not_found");
  });

  it("only-occluded or offscreen matches → action_not_found", () => {
    const occluded = surfaceCandidate({ hit_match: false });
    expect(pickSurfaceActionMatch(searchOk([occluded]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("action_not_found");
    const offscreen = surfaceCandidate({ box: { x: 5000, y: 860, width: 220, height: 44 } });
    expect(pickSurfaceActionMatch(searchOk([offscreen]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("action_not_found");
  });

  it("a changed href on the live action is incompatible (identity check holds)", () => {
    const swapped = surfaceCandidate({ href: "/us/en/some-other-page/" });
    expect(pickSurfaceActionMatch(searchOk([swapped]), GO_TO_BAG_EXPECTED, PANEL).status).toBe("action_not_found");
  });
});

// ─── IIFE secret-safety ──────────────────────────────────────────────────────

describe("buildSurfaceActionSearchExpr — page-side IIFE safety", () => {
  it("reads .value ONLY for submit/button/reset inputs (button label)", () => {
    const expr = buildSurfaceActionSearchExpr();
    // The only el.value access sits inside the button-type guard.
    const valueReads = expr.match(/el\.value/g) ?? [];
    expect(valueReads.length).toBeGreaterThan(0);
    expect(expr).toContain("type==='submit'||type==='button'||type==='reset'");
    const guardIndex = expr.indexOf("type==='submit'||type==='button'||type==='reset'");
    for (const m of expr.matchAll(/el\.value/g)) {
      // Every el.value access appears after the guard, inside its block.
      expect(m.index).toBeGreaterThan(guardIndex);
    }
  });

  it("skips hidden inputs and returns ONLY surface members (background excluded)", () => {
    const expr = buildSurfaceActionSearchExpr();
    expect(expr).toContain("type==='hidden'");
    expect(expr).toContain("ovl.background===true) continue");
    expect(expr).toContain("computeOverlay");
  });

  it("never serializes cookies, storage, or document HTML", () => {
    const expr = buildSurfaceActionSearchExpr();
    expect(expr).not.toContain("document.cookie");
    expect(expr).not.toContain("localStorage");
    expect(expr).not.toContain("sessionStorage");
    expect(expr).not.toContain("outerHTML");
    expect(expr).not.toContain("innerHTML");
  });
});
