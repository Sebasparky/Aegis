/**
 * Active Surfaces v1 (ANTIGEN_ACTIVE_SURFACES, default-off) — pure builder tests
 * + snapshot endpoint wiring.
 *
 * The IKEA-style scenario under test: after add-to-bag, a blocking dialog
 * ("GLIMMA was added to your shopping bag") offers a stable primary action
 * ("Go to shopping bag") while the background header bag link churns. The
 * snapshot must surface the dialog as the dominant active surface, classify and
 * recommend its safe actions, and annotate background refs as likely blocked —
 * and with the flag OFF the response must be byte-identical to today (no new
 * fields, no annotations).
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock the CDP extraction transports — the store stays real (same harness as
// antigen-browser-snapshot-endpoint.test.ts).
const extractMock = vi.hoisted(() => vi.fn());
const pageMetaMock = vi.hoisted(() => vi.fn());
const bundleMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  bundleMock.mockImplementation(async (params: Record<string, unknown>) => {
    const candidates = await extractMock(params);
    let pageMeta: unknown;
    try {
      pageMeta = await pageMetaMock(params);
    } catch {
      pageMeta = undefined;
    }
    return { candidates, ...(pageMeta !== undefined ? { pageMeta } : {}) };
  });
  return {
    ...actual,
    extractAntigenSnapshotCandidatesViaCDP: extractMock,
    extractAntigenPageMetaViaCDP: pageMetaMock,
    extractAntigenSnapshotBundleViaCDP: bundleMock,
  };
});

const liveUrlMock = vi.hoisted(() => vi.fn());
const resolveTargetMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, readLiveCdpPageUrl: liveUrlMock, resolveSnapshotCdpTarget: resolveTargetMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate, AntigenOverlayInfo } from "../runtime/antigenSnapshotRuntime.js";
import type { AntigenSnapshotElementRecord } from "../runtime/antigenSnapshotStore.js";
import {
  buildActiveSurfaces,
  isActiveSurfacesEnabled,
} from "../runtime/antigenSnapshotPageMap.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { clearAntigenSnapshotStoreForTests } from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";

// ─── Pure fixtures ───────────────────────────────────────────────────────────

const PANEL_TITLE = "GLIMMA was added to your shopping bag";

const PANEL_OVERLAY: AntigenOverlayInfo = {
  overlay_type: "dialog",
  blocking: true,
  modal_title: PANEL_TITLE,
};

let refCounter = 0;
function record(overrides: Partial<AntigenSnapshotElementRecord> = {}): AntigenSnapshotElementRecord {
  refCounter += 1;
  return {
    snapshot_id: "snap_test",
    ref: `ag_${refCounter}`,
    browser_session_id: "tbsess_surf_001",
    browser_runtime_id: "tbsess_surf_001",
    user_id: "user_001",
    tag: "button",
    kind: "button",
    role: "button",
    name: "Button",
    normalized_name: "button",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 100, y: 100, width: 120, height: 40 },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 90_000).toISOString(),
    ...overrides,
  };
}

/** The IKEA add-to-bag scenario: blocking panel + churning background header. */
function ikeaRecords() {
  refCounter = 0;
  const headerBag = record({
    tag: "a",
    kind: "link",
    role: "link",
    name: "Shopping bag, 1 items",
    normalized_name: "shopping bag 1 items",
    href: "/us/en/shoppingcart/",
    href_path: "/us/en/shoppingcart/",
  }); // ag_1 — background, no overlay
  const goToBag = record({
    tag: "a",
    kind: "link",
    role: "link",
    name: "Go to shopping bag",
    normalized_name: "go to shopping bag",
    href: "/us/en/shoppingcart/",
    href_path: "/us/en/shoppingcart/",
    overlay: { ...PANEL_OVERLAY },
  }); // ag_2 — panel primary
  const continueShopping = record({
    name: "Continue shopping",
    normalized_name: "continue shopping",
    overlay: { ...PANEL_OVERLAY },
  }); // ag_3 — panel dismiss-by-name
  const closeX = record({
    name: "Close",
    normalized_name: "close",
    overlay: { ...PANEL_OVERLAY, is_dismiss: true },
  }); // ag_4 — panel structural dismiss
  const toastView = record({
    name: "View",
    normalized_name: "view",
    overlay: { overlay_type: "toast", blocking: false, modal_title: "Added to cart" },
  }); // ag_5 — toast member
  const bgSearch = record({
    tag: "input",
    kind: "input",
    role: "searchbox",
    name: "Search",
    normalized_name: "search",
    typeable: true,
    clickable: false,
    overlay: { overlay_type: "overlay", blocking: false, background: true, bg_hidden: true },
  }); // ag_6 — background-behind-modal marker
  return { headerBag, goToBag, continueShopping, closeX, toastView, bgSearch };
}

// ─── Pure builder tests ──────────────────────────────────────────────────────

describe("isActiveSurfacesEnabled — strict opt-in", () => {
  afterEach(() => {
    delete process.env.ANTIGEN_ACTIVE_SURFACES;
  });

  it("is off by default and for any non-'true' value", () => {
    delete process.env.ANTIGEN_ACTIVE_SURFACES;
    expect(isActiveSurfacesEnabled()).toBe(false);
    process.env.ANTIGEN_ACTIVE_SURFACES = "1";
    expect(isActiveSurfacesEnabled()).toBe(false);
  });

  it("is on only for the literal 'true'", () => {
    process.env.ANTIGEN_ACTIVE_SURFACES = "true";
    expect(isActiveSurfacesEnabled()).toBe(true);
  });
});

describe("buildActiveSurfaces — IKEA-style add-to-bag panel", () => {
  it("surfaces the blocking panel as the dominant surface with its title", () => {
    const r = ikeaRecords();
    const out = buildActiveSurfaces(Object.values(r));
    expect(out.surfaces.length).toBe(2); // dialog + toast (background marker is not a surface)
    const panel = out.surfaces[0];
    expect(panel.surface_id).toBe("surf_1");
    expect(panel.surface_type).toBe("dialog");
    expect(panel.blocking).toBe(true);
    expect(panel.title).toBe(PANEL_TITLE);
    expect(panel.dismissible).toBe(true);
    expect(out.blocking_active).toBe(true);
  });

  it("classifies the panel's actions: unique non-dismiss is primary; closers are dismiss", () => {
    const r = ikeaRecords();
    const out = buildActiveSurfaces(Object.values(r));
    const panel = out.surfaces[0];
    const byRef = new Map(panel.actions.map((a) => [a.ref, a]));
    expect(byRef.get(r.goToBag.ref)?.classification).toBe("primary");
    expect(byRef.get(r.goToBag.ref)?.action_intent).toBe("navigation");
    expect(byRef.get(r.goToBag.ref)?.requires_handoff).toBeUndefined();
    expect(byRef.get(r.continueShopping.ref)?.classification).toBe("dismiss");
    expect(byRef.get(r.closeX.ref)?.classification).toBe("dismiss");
  });

  it("recommends the panel primary first, then dismisses — never the toast", () => {
    const r = ikeaRecords();
    const out = buildActiveSurfaces(Object.values(r));
    expect(out.recommended_actions.length).toBeGreaterThanOrEqual(1);
    expect(out.recommended_actions[0]).toMatchObject({
      ref: r.goToBag.ref,
      surface_id: "surf_1",
      classification: "primary",
      reason: "active_surface_primary_action",
    });
    const recRefs = out.recommended_actions.map((a) => a.ref);
    expect(recRefs).toContain(r.continueShopping.ref);
    expect(recRefs).toContain(r.closeX.ref);
    expect(recRefs).not.toContain(r.toastView.ref);
    // Recommendations come from ONE surface only.
    expect(new Set(out.recommended_actions.map((a) => a.surface_id))).toEqual(new Set(["surf_1"]));
  });

  it("marks background refs (header link, bg-hidden field) likely blocked — never panel members", () => {
    const r = ikeaRecords();
    const out = buildActiveSurfaces(Object.values(r));
    expect(out.likely_blocked_refs).toContain(r.headerBag.ref);
    expect(out.likely_blocked_refs).toContain(r.bgSearch.ref);
    expect(out.likely_blocked_refs).not.toContain(r.goToBag.ref);
    expect(out.likely_blocked_refs).not.toContain(r.closeX.ref);
  });

  it("emits no likely_blocked refs when no blocking surface is active", () => {
    refCounter = 0;
    const toastOnly = [
      record({ name: "View", normalized_name: "view", overlay: { overlay_type: "toast", blocking: false } }),
      record({ tag: "a", kind: "link", name: "Home", normalized_name: "home", href: "/", href_path: "/" }),
    ];
    const out = buildActiveSurfaces(toastOnly);
    expect(out.blocking_active).toBe(false);
    expect(out.likely_blocked_refs).toEqual([]);
  });
});

describe("buildActiveSurfaces — safety boundaries", () => {
  it("a final-commit action inside a modal is listed with requires_handoff and never recommended", () => {
    refCounter = 0;
    const pay = record({
      name: "Pay $8.47",
      normalized_name: "pay $847",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Order review" },
    });
    const cancel = record({
      name: "Cancel",
      normalized_name: "cancel",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Order review" },
    });
    const out = buildActiveSurfaces([pay, cancel]);
    const actions = out.surfaces[0].actions;
    const payAction = actions.find((a) => a.ref === pay.ref)!;
    expect(payAction.action_intent).toBe("final_commit");
    expect(payAction.requires_handoff).toBe(true);
    const recRefs = out.recommended_actions.map((a) => a.ref);
    expect(recRefs).not.toContain(pay.ref);
    expect(recRefs).toContain(cancel.ref); // dismiss stays recommendable
  });

  it("duplicate non-dismiss peers produce NO primary (never guess between peers)", () => {
    refCounter = 0;
    const ovl: AntigenOverlayInfo = { overlay_type: "dialog", blocking: true, modal_title: "Pick one" };
    const a = record({ tag: "a", kind: "link", name: "Go to shopping bag", normalized_name: "go to shopping bag", href: "/cart", href_path: "/cart", overlay: { ...ovl } });
    const b = record({ tag: "a", kind: "link", name: "Go to shopping bag", normalized_name: "go to shopping bag", href: "/cart", href_path: "/cart", overlay: { ...ovl } });
    const out = buildActiveSurfaces([a, b]);
    const classifications = out.surfaces[0].actions.map((x) => x.classification);
    expect(classifications).not.toContain("primary");
    expect(out.recommended_actions.map((x) => x.ref)).not.toContain(a.ref);
    expect(out.recommended_actions.map((x) => x.ref)).not.toContain(b.ref);
  });

  it("cookie-consent groups are excluded from surfaces and from blocking_active", () => {
    refCounter = 0;
    const cookieAccept = record({
      name: "Accept all cookies",
      normalized_name: "accept all cookies",
      context: { section: "Cookie consent banner" },
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Cookie consent" },
    });
    const out = buildActiveSurfaces([cookieAccept]);
    expect(out.surfaces).toEqual([]);
    expect(out.blocking_active).toBe(false);
    expect(out.recommended_actions).toEqual([]);
  });

  it("chat widgets are listed as surfaces but never contribute recommendations", () => {
    refCounter = 0;
    const chat = record({
      name: "Start conversation",
      normalized_name: "start conversation",
      overlay: { overlay_type: "popover", blocking: false, modal_title: "Chat with us" },
    });
    const out = buildActiveSurfaces([chat]);
    expect(out.surfaces.length).toBe(1);
    expect(out.recommended_actions).toEqual([]);
  });

  it("never emits geometry, internal flags, or nearby_text in surfaces output", () => {
    const r = ikeaRecords();
    const out = buildActiveSurfaces(Object.values(r));
    const serialized = JSON.stringify({ surfaces: out.surfaces, recommended_actions: out.recommended_actions });
    expect(serialized).not.toContain('"box"');
    expect(serialized).not.toContain('"doc_x"');
    expect(serialized).not.toContain('"in_inert"');
    expect(serialized).not.toContain('"bg_hidden"');
    expect(serialized).not.toContain('"background"');
    expect(serialized).not.toContain('"nearby_text"');
  });
});

// ─── Endpoint wiring (flag-gated response fields + element annotation) ───────

const BEARER = "Bearer tok_surf_001";
const DELEGATION_ID = "del_surf_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_surf_001";
const URL = "/api/agent/v1/runtime/browser-snapshot";

function makeSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_surf_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: "https://www.ikea.com/us/en/p/glimma-50097995/",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  } as TaskBrowserSession;
}

function snapshotCandidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "button",
    kind: "button",
    role: "button",
    name: "Button",
    normalized_name: "button",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 100, y: 100, width: 120, height: 40 },
    ...overrides,
  };
}

/** Endpoint-shaped IKEA candidates (header link + blocking panel). */
const IKEA_CANDIDATES: AntigenSnapshotCandidate[] = [
  snapshotCandidate({
    tag: "a",
    kind: "link",
    role: "link",
    name: "Shopping bag, 1 items",
    normalized_name: "shopping bag 1 items",
    href: "/us/en/shoppingcart/",
    href_path: "/us/en/shoppingcart/",
  }),
  snapshotCandidate({
    tag: "a",
    kind: "link",
    role: "link",
    name: "Go to shopping bag",
    normalized_name: "go to shopping bag",
    href: "/us/en/shoppingcart/",
    href_path: "/us/en/shoppingcart/",
    overlay: { ...PANEL_OVERLAY },
  }),
  snapshotCandidate({
    name: "Continue shopping",
    normalized_name: "continue shopping",
    overlay: { ...PANEL_OVERLAY },
  }),
];

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_surf_001", {
    id: "pass_surf_001",
    token: "tok_surf_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestSurfaceAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestSurfaceAgent",
    channel: "api",
    status: "active",
    token_id: "pass_surf_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_surf_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  extractMock.mockResolvedValue(IKEA_CANDIDATES);
  pageMetaMock.mockResolvedValue(undefined);
  liveUrlMock.mockResolvedValue(null);
  resolveTargetMock.mockResolvedValue(null);
  delete process.env.ANTIGEN_ACTIVE_SURFACES;
});

afterEach(() => {
  delete process.env.ANTIGEN_ACTIVE_SURFACES;
});

async function takeSnapshot() {
  taskBrowserSessions.set(SESSION_ID, makeSession());
  const res = await server.inject({
    method: "POST",
    url: URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data;
}

describe("snapshot endpoint — Active Surfaces wiring", () => {
  it("flag OFF: no active_surfaces / recommended_actions / likely_blocked_by_overlay fields", async () => {
    const data = await takeSnapshot();
    expect(data.active_surfaces).toBeUndefined();
    expect(data.recommended_actions).toBeUndefined();
    for (const el of data.elements) {
      expect(el.likely_blocked_by_overlay).toBeUndefined();
    }
  });

  it("flag ON: surfaces the panel, recommends its primary, annotates the background header", async () => {
    process.env.ANTIGEN_ACTIVE_SURFACES = "true";
    const data = await takeSnapshot();

    expect(Array.isArray(data.active_surfaces)).toBe(true);
    expect(data.active_surfaces.length).toBe(1);
    const surface = data.active_surfaces[0];
    expect(surface.surface_type).toBe("dialog");
    expect(surface.blocking).toBe(true);
    expect(surface.title).toBe(PANEL_TITLE);

    expect(data.recommended_actions[0]).toMatchObject({
      ref: "ag_2",
      name: "Go to shopping bag",
      classification: "primary",
      reason: "active_surface_primary_action",
    });

    const header = data.elements.find((e: { ref: string }) => e.ref === "ag_1");
    const goToBag = data.elements.find((e: { ref: string }) => e.ref === "ag_2");
    expect(header.likely_blocked_by_overlay).toBe(true);
    expect(goToBag.likely_blocked_by_overlay).toBeUndefined();
  });

  it("flag ON: surfaces payload never carries boxes/coordinates or internal flags", async () => {
    process.env.ANTIGEN_ACTIVE_SURFACES = "true";
    const data = await takeSnapshot();
    const serialized = JSON.stringify({ s: data.active_surfaces, r: data.recommended_actions });
    expect(serialized).not.toContain('"box"');
    expect(serialized).not.toContain('"x"');
    expect(serialized).not.toContain('"in_inert"');
    expect(serialized).not.toContain('"bg_hidden"');
    expect(serialized).not.toContain("likely_blocked_refs");
  });
});
