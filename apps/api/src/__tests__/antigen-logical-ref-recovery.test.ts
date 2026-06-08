/**
 * Antigen Same-Page Logical-Ref Recovery — pure unit tests + endpoint wiring.
 *
 * Recovery is env-gated (ANTIGEN_LOGICAL_REF_RECOVERY) and DEFAULT-OFF. The first
 * endpoint test proves default-off preserves the current strict ANTIGEN_REF_STALE
 * fail-closed behavior; only after that do the recovery-success tests run.
 *
 * All fixtures are GENERIC dynamic-grid style (no site-specific URLs/labels).
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// ─── Pure unit tests (no server, no CDP) ─────────────────────────────────────

import {
  classifyLogicalRecoveryEligibility,
  pickLogicalRecoveryMatch,
  scoreLogicalRecoveryConfidence,
  sanitizeStaleReason,
  buildLogicalRecoverySearchExpr,
  isLogicalRefRecoveryEnabled,
  type RawLiveCandidate,
  type LogicalRecoverySearchValue,
} from "../runtime/antigenLogicalRecovery.js";
import type { AntigenKnownBoxRevalidationExpected } from "../runtime/antigenKnownBoxRevalidation.js";

function liveCandidate(overrides: Partial<RawLiveCandidate> = {}): RawLiveCandidate {
  return {
    tag: "a",
    type: null,
    role: null,
    content_editable: false,
    id: null,
    href: "/p/item-123?ref=grid",
    disabled: false,
    aria_disabled: false,
    read_only: false,
    name: "Standing desk",
    visible: true,
    box: { x: 100, y: 200, width: 120, height: 40 },
    ...overrides,
  };
}

function searchOk(candidates: RawLiveCandidate[], vw = 1280, vh = 800): LogicalRecoverySearchValue {
  return { vw, vh, status: "ok", candidates };
}

const LINK_EXPECTED: AntigenKnownBoxRevalidationExpected = {
  tag: "a",
  kind: "link",
  role: "link",
  name: "Standing desk",
  normalized_name: "standing desk",
  href_path: "/p/item-123",
};

const CART_EXPECTED: AntigenKnownBoxRevalidationExpected = {
  tag: "button",
  kind: "button",
  role: "button",
  name: "Add to cart",
  normalized_name: "add to cart",
  href_path: null,
};

describe("classifyLogicalRecoveryEligibility — default-deny by safety class", () => {
  it("allows a navigation link with an href_path (low_risk_navigation)", () => {
    const r = classifyLogicalRecoveryEligibility(LINK_EXPECTED, "click");
    expect(r.eligible).toBe(true);
    expect(r.risk_class).toBe("low_risk_navigation");
  });

  it("allows an add-to-cart-style button (low_risk_listing_interaction)", () => {
    for (const n of ["add to cart", "add to bag", "add to basket", "view", "show more", "load more", "next"]) {
      const r = classifyLogicalRecoveryEligibility({ ...CART_EXPECTED, normalized_name: n }, "click");
      expect(r.eligible, n).toBe(true);
      expect(r.risk_class).toBe("low_risk_listing_interaction");
    }
  });

  it("refuses sensitive-commit buttons (ineligible_sensitive)", () => {
    for (const n of [
      "checkout", "place order", "buy now", "pay", "pay now", "continue to payment",
      "complete purchase", "confirm order", "sign in", "log in", "sign out",
      "delete", "remove", "subscribe", "authorize", "approve",
    ]) {
      const r = classifyLogicalRecoveryEligibility({ ...CART_EXPECTED, normalized_name: n }, "click");
      expect(r.eligible, n).toBe(false);
      expect(r.risk_class, n).toBe("ineligible_sensitive");
    }
  });

  it("refuses unclassified targets (fail closed)", () => {
    const r = classifyLogicalRecoveryEligibility({ ...CART_EXPECTED, normalized_name: "configure options" }, "click");
    expect(r.eligible).toBe(false);
    expect(r.risk_class).toBe("ineligible_unclassified");
  });

  it("a link without an href_path is not eligible (cannot anchor identity)", () => {
    const r = classifyLogicalRecoveryEligibility({ ...LINK_EXPECTED, href_path: null }, "click");
    expect(r.eligible).toBe(false);
  });

  it("type recovery is deferred — typeable targets are never eligible", () => {
    expect(classifyLogicalRecoveryEligibility({ kind: "input", normalized_name: "search" }, "type").eligible).toBe(false);
    const pw = classifyLogicalRecoveryEligibility({ kind: "input", normalized_name: "password" }, "type");
    expect(pw.eligible).toBe(false);
    expect(pw.risk_class).toBe("ineligible_sensitive");
  });

  it("scroll action is not eligible for logical recovery", () => {
    expect(classifyLogicalRecoveryEligibility(LINK_EXPECTED, "scroll").eligible).toBe(false);
  });
});

describe("scoreLogicalRecoveryConfidence — graded, conservative, no context", () => {
  it("strong: exact href_path match anchors a link target", () => {
    expect(scoreLogicalRecoveryConfidence(liveCandidate(), LINK_EXPECTED)).toBe("strong");
  });

  it("name_exact: exact normalized name with no href anchor (listing button)", () => {
    const cart = liveCandidate({ tag: "button", href: null, name: "Add to cart", role: "button" });
    expect(scoreLogicalRecoveryConfidence(cart, CART_EXPECTED)).toBe("name_exact");
  });

  it("weak: compatible only via a substring name match (no href, not exact)", () => {
    const cart = liveCandidate({ tag: "button", href: null, name: "Add to cart — Standing desk", role: "button" });
    expect(scoreLogicalRecoveryConfidence(cart, CART_EXPECTED)).toBe("weak");
  });

  it("incompatible: identity mismatch (changed href / changed name / changed kind)", () => {
    expect(scoreLogicalRecoveryConfidence(liveCandidate({ href: "/p/item-999" }), LINK_EXPECTED)).toBe("incompatible");
    const renamed = liveCandidate({ tag: "button", href: null, name: "Remove from cart", role: "button" });
    expect(scoreLogicalRecoveryConfidence(renamed, CART_EXPECTED)).toBe("incompatible");
  });
});

describe("pickLogicalRecoveryMatch — risk-aware acceptance + uniqueness + viewport", () => {
  it("recovers the box of a single equivalent re-rendered link (strong via href)", () => {
    const moved = liveCandidate({ box: { x: 300, y: 500, width: 120, height: 40 } });
    const pick = pickLogicalRecoveryMatch(searchOk([moved]), LINK_EXPECTED, "low_risk_navigation");
    expect(pick.status).toBe("recovered");
    if (pick.status === "recovered") expect(pick.box).toEqual({ x: 300, y: 500, width: 120, height: 40 });
  });

  it("refuses when two equivalent elements match (ambiguous)", () => {
    const a = liveCandidate({ box: { x: 100, y: 200, width: 120, height: 40 } });
    const b = liveCandidate({ box: { x: 100, y: 600, width: 120, height: 40 } });
    expect(pickLogicalRecoveryMatch(searchOk([a, b]), LINK_EXPECTED, "low_risk_navigation").status).toBe("ambiguous");
  });

  it("refuses when href_path changed (not_found)", () => {
    const changed = liveCandidate({ href: "/p/item-999" });
    expect(pickLogicalRecoveryMatch(searchOk([changed]), LINK_EXPECTED, "low_risk_navigation").status).toBe("not_found");
  });

  it("refuses when accessible name changed for a button target (not_found)", () => {
    const btn = liveCandidate({ tag: "button", href: null, name: "Remove from cart", role: "button" });
    expect(pickLogicalRecoveryMatch(searchOk([btn]), CART_EXPECTED, "low_risk_listing_interaction").status).toBe("not_found");
  });

  it("recovers a unique EXACT-name add-to-cart button among unrelated controls (listing)", () => {
    const cart = liveCandidate({ tag: "button", href: null, name: "Add to cart", role: "button", box: { x: 50, y: 60, width: 100, height: 36 } });
    const unrelated = liveCandidate({ tag: "button", href: null, name: "Sort by price", role: "button" });
    const pick = pickLogicalRecoveryMatch(searchOk([unrelated, cart]), CART_EXPECTED, "low_risk_listing_interaction");
    expect(pick.status).toBe("recovered");
    if (pick.status === "recovered") expect(pick.box).toEqual({ x: 50, y: 60, width: 100, height: 36 });
  });

  it("TIGHTENED: a unique substring-only listing match fails closed (weak → not_found)", () => {
    const cart = liveCandidate({ tag: "button", href: null, name: "Add to cart — Standing desk", role: "button" });
    expect(pickLogicalRecoveryMatch(searchOk([cart]), CART_EXPECTED, "low_risk_listing_interaction").status).toBe("not_found");
  });

  it("name_exact is NOT accepted for a non-listing (navigation) risk class — fail closed", () => {
    // A unique exact-name button-style match, but the target is classed as
    // navigation: name_exact only recovers for listing interactions.
    const btn = liveCandidate({ tag: "button", href: null, name: "Add to cart", role: "button" });
    expect(pickLogicalRecoveryMatch(searchOk([btn]), CART_EXPECTED, "low_risk_navigation").status).toBe("not_found");
  });

  it("returns out_of_viewport when the unique strong match is offscreen", () => {
    const offscreen = liveCandidate({ box: { x: 100, y: 5000, width: 120, height: 40 } });
    expect(pickLogicalRecoveryMatch(searchOk([offscreen], 1280, 800), LINK_EXPECTED, "low_risk_navigation").status).toBe("out_of_viewport");
  });

  it("returns not_found on a page-side search error", () => {
    expect(pickLogicalRecoveryMatch({ vw: 1280, vh: 800, status: "error" }, LINK_EXPECTED, "low_risk_navigation").status).toBe("not_found");
  });
});

describe("sanitizeStaleReason — agent-safe vocabulary, no internals", () => {
  it("maps point/identity mismatches to a coarse safe signal", () => {
    expect(sanitizeStaleReason("NAME_MISMATCH")).toEqual({ stale_reason: "target_replaced", stability_hint: "target_replaced_resnapshot" });
    expect(sanitizeStaleReason("HREF_PATH_MISMATCH").stale_reason).toBe("target_replaced");
    expect(sanitizeStaleReason("NO_ELEMENT_AT_POINT").stale_reason).toBe("page_re_rendering");
    expect(sanitizeStaleReason("LIVE_ELEMENT_NOT_VISIBLE").stale_reason).toBe("element_not_visible");
    expect(sanitizeStaleReason("BOX_OUT_OF_VIEWPORT").stale_reason).toBe("out_of_viewport");
    expect(sanitizeStaleReason(undefined).stale_reason).toBe("target_replaced");
  });
});

describe("buildLogicalRecoverySearchExpr — safe, read-only IIFE", () => {
  it("is a self-contained IIFE that queries interactive elements and never clicks/mutates", () => {
    const expr = buildLogicalRecoverySearchExpr();
    expect(expr.startsWith("(function(){")).toBe(true);
    expect(expr).toContain("a[href],button,input,textarea,select");
    expect(expr).toContain("querySelectorAll");
    // No mutating/click operations in the search expression.
    expect(expr).not.toContain(".click(");
    expect(expr).not.toContain("dispatchEvent");
  });
});

describe("isLogicalRefRecoveryEnabled — env gated, default off", () => {
  it("is off unless ANTIGEN_LOGICAL_REF_RECOVERY === 'true'", () => {
    const prev = process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
    delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
    expect(isLogicalRefRecoveryEnabled()).toBe(false);
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "1";
    expect(isLogicalRefRecoveryEnabled()).toBe(false);
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    expect(isLogicalRefRecoveryEnabled()).toBe(true);
    if (prev === undefined) delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
    else process.env.ANTIGEN_LOGICAL_REF_RECOVERY = prev;
  });
});

// ─── Endpoint wiring tests (mock the click runtime + the recovery CDP search) ──

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

const clickKnownBoxMock = vi.hoisted(() => vi.fn());
const recoverBoxMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return { ...actual, realisticClickKnownBox: clickKnownBoxMock };
});

// Partial-mock recovery: keep the real classify/sanitize/enabled + enum Sets
// (browserRunTrace depends on them), override only the CDP search.
vi.mock("../runtime/antigenLogicalRecovery.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenLogicalRecovery.js")>(
    "../runtime/antigenLogicalRecovery.js",
  );
  return { ...actual, recoverAntigenRefBox: recoverBoxMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { createAntigenSnapshotRecord, clearAntigenSnapshotStoreForTests } from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";

const BEARER = "Bearer tok_rec_001";
const DELEGATION_ID = "del_rec_001";
// Must match the agent-api MOCK_USER_ID constant ("user_001") — auth filters
// passes/delegations by that user id.
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_rec_001";
const CLICK_URL = "/api/agent/v1/runtime/browser-click";
const PAGE_URL = "https://grid.example.test/search?q=desk";

function seedSession(): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-rec",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: PAGE_URL,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  taskBrowserSessions.set(session.browser_session_id, session);
  return session;
}

/** Generic add-to-cart-style button candidate (eligible for recovery). */
function cartCandidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "button",
    kind: "button",
    role: "button",
    name: "Add to cart",
    normalized_name: "add to cart",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 100, y: 200, width: 120, height: 40 },
    ...overrides,
  };
}

function seedSnapshot(candidates: AntigenSnapshotCandidate[]) {
  return createAntigenSnapshotRecord({
    browser_session_id: SESSION_ID,
    browser_runtime_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    url: PAGE_URL,
    title: null,
    candidates,
  });
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_rec_001", {
    id: "pass_rec_001", token: "tok_rec_001", user_id: MOCK_USER_ID,
    agent_name: "RecAgent", status: "active", expires_at: expiry, created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID, user_id: MOCK_USER_ID, user_aegis_id: "aegisid_rec",
    agent_name: "RecAgent", channel: "api", status: "active", token_id: "pass_rec_001",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as any);

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_rec_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
});

async function clickAg1() {
  return server.inject({
    method: "POST", url: CLICK_URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Add to cart" },
  });
}

describe("browser-click recovery wiring", () => {
  it("DEFAULT-OFF: a stale click is NOT recovered and returns 422 ANTIGEN_REF_STALE (recovery_state disabled)", async () => {
    // Flag unset (default). Even an eligible target must not trigger recovery.
    seedSession();
    seedSnapshot([cartCandidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NAME_MISMATCH" });

    const res = await clickAg1();

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_STALE");
    expect(body.error.recovery_state).toBe("disabled");
    expect(recoverBoxMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("ENABLED + eligible + unique match: recovers and clicks the proposed box (recovery_state recovered)", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([cartCandidate({ box: { x: 100, y: 200, width: 120, height: 40 } })]);
    clickKnownBoxMock
      .mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NO_ELEMENT_AT_POINT" })
      .mockResolvedValueOnce({ success: true, current_url: PAGE_URL });
    recoverBoxMock.mockResolvedValueOnce({ status: "recovered", box: { x: 300, y: 520, width: 120, height: 40 } });

    const res = await clickAg1();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.recovery_state).toBe("recovered");
    expect(body.data.recovered_from_stale_reason).toBe("page_re_rendering");
    // Re-click used the recovered box, not the stored one.
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(2);
    expect(clickKnownBoxMock.mock.calls[1][0].box).toEqual({ x: 300, y: 520, width: 120, height: 40 });
    // No boxes/coords/cdp_url leaked.
    const raw = JSON.stringify(body);
    for (const f of ["\"box\"", "\"x\":", "\"width\"", "cdp_url", "9222", "localhost"]) {
      expect(raw).not.toContain(f);
    }
  });

  it("ENABLED but ineligible (sensitive target): skips recovery (recovery_state skipped_ineligible)", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([cartCandidate({ name: "Checkout", normalized_name: "checkout" })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NAME_MISMATCH" });

    const res = await clickAg1();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.recovery_state).toBe("skipped_ineligible");
    expect(recoverBoxMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("ENABLED + ambiguous match: refuses (recovery_state failed_ambiguous, still 422)", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([cartCandidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NAME_MISMATCH" });
    recoverBoxMock.mockResolvedValueOnce({ status: "ambiguous" });

    const res = await clickAg1();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.recovery_state).toBe("failed_ambiguous");
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1); // no re-click on refusal
  });

  it("ENABLED + no match: fail-closed (recovery_state failed_not_found)", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([cartCandidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "HREF_PATH_MISMATCH" });
    recoverBoxMock.mockResolvedValueOnce({ status: "not_found" });

    const res = await clickAg1();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.recovery_state).toBe("failed_not_found");
  });

  it("ENABLED + recovered box still fails Phase 4B on re-click: failed_revalidation", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([cartCandidate()]);
    clickKnownBoxMock
      .mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NAME_MISMATCH" })
      .mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NAME_MISMATCH" });
    recoverBoxMock.mockResolvedValueOnce({ status: "recovered", box: { x: 10, y: 20, width: 30, height: 40 } });

    const res = await clickAg1();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.recovery_state).toBe("failed_revalidation");
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(2);
  });

  it("ENABLED + page changed during recovery: failed_page_changed", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([cartCandidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NAME_MISMATCH" });
    recoverBoxMock.mockResolvedValueOnce({ status: "page_changed" });

    const res = await clickAg1();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.recovery_state).toBe("failed_page_changed");
  });

  it("recovery is never attempted for a true page change (ANTIGEN_REF_PAGE_CHANGED)", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([cartCandidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_PAGE_CHANGED" });

    const res = await clickAg1();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_PAGE_CHANGED");
    expect(recoverBoxMock).not.toHaveBeenCalled();
  });
});
