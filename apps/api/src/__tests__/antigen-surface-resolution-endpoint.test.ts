/**
 * POST /api/agent/v1/runtime/browser-click — surface-scoped live resolution
 * wiring (ANTIGEN_SURFACE_RESOLVE, default-off).
 *
 * Harness mirrors antigen-browser-click-endpoint.test.ts: the snapshot store is
 * real (seeded via createAntigenSnapshotRecord with overlay-bearing candidates),
 * the realistic click runtime is mocked, page-wide recovery
 * (recoverAntigenRefBox) is mocked so we can assert it is NEVER called for
 * surface members, and resolveSurfaceActionBox is mocked so resolution outcomes
 * are driven deterministically (its matching logic is covered by the pure tests
 * in antigen-surface-resolution.test.ts).
 *
 * The IKEA scenario: "Go to shopping bag" inside the blocking add-to-bag dialog
 * goes ANTIGEN_REF_STALE because the panel re-rendered. With the flag ON the
 * endpoint re-resolves it inside the live surface and re-clicks the fresh box —
 * one attempt, Phase 4B (inside the mocked click runtime) still the final gate.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

const clickKnownBoxMock = vi.hoisted(() => vi.fn());
const clickByDescriptionMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return {
    ...actual,
    realisticClickKnownBox: clickKnownBoxMock,
    realisticClickByDescription: clickByDescriptionMock,
  };
});

// Page-wide recovery mocked ONLY to assert it never runs for surface members.
const recoverBoxMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenLogicalRecovery.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenLogicalRecovery.js")>(
    "../runtime/antigenLogicalRecovery.js",
  );
  return { ...actual, recoverAntigenRefBox: recoverBoxMock };
});

// Surface resolution: mock ONLY the CDP-backed resolver; the flag check,
// eligibility classifier, and intent-drift guard stay real.
const resolveSurfaceMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSurfaceResolution.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSurfaceResolution.js")>(
    "../runtime/antigenSurfaceResolution.js",
  );
  return { ...actual, resolveSurfaceActionBox: resolveSurfaceMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate, AntigenOverlayInfo } from "../runtime/antigenSnapshotRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import {
  createAntigenSnapshotRecord,
  clearAntigenSnapshotStoreForTests,
} from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";

const BEARER = "Bearer tok_surfres_001";
const DELEGATION_ID = "del_surfres_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_surfres_001";
const URL = "/api/agent/v1/runtime/browser-click";
const PAGE_URL = "https://www.ikea.com/us/en/p/glimma-50097995/";

const PANEL_OVERLAY: AntigenOverlayInfo = {
  overlay_type: "dialog",
  blocking: true,
  modal_title: "GLIMMA was added to your shopping bag",
};

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_surfres_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: PAGE_URL,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  } as TaskBrowserSession;
  taskBrowserSessions.set(session.browser_session_id, session);
  return session;
}

function candidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "a",
    kind: "link",
    role: "link",
    name: "Go to shopping bag",
    normalized_name: "go to shopping bag",
    id: null,
    href: "/us/en/shoppingcart/",
    href_path: "/us/en/shoppingcart/",
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 850, y: 860, width: 220, height: 44 },
    overlay: { ...PANEL_OVERLAY },
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

const STALE_RESULT = { success: false, error: "ANTIGEN_REF_STALE", stale_reason: "NO_ELEMENT_AT_POINT" };
const SUCCESS_RESULT = { success: true, current_url: PAGE_URL, pointer_path_point_count: 27, pointer_state_persisted: true };
const FRESH_BOX = { x: 851, y: 905, width: 220, height: 44 };
const RESOLVED = {
  status: "resolved" as const,
  box: FRESH_BOX,
  live: { name: "Go to shopping bag", kind: "link", href_path: "/us/en/shoppingcart/" },
};

async function clickRef(ref: string) {
  return server.inject({
    method: "POST",
    url: URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, ref },
  });
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_surfres_001", {
    id: "pass_surfres_001",
    token: "tok_surfres_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestSurfaceResolveAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestSurfaceResolveAgent",
    channel: "api",
    status: "active",
    token_id: "pass_surfres_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_surfres_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  delete process.env.ANTIGEN_SURFACE_RESOLVE;
  delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
});

afterEach(() => {
  delete process.env.ANTIGEN_SURFACE_RESOLVE;
  delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
});

describe("browser-click surface resolution — flag OFF (byte-identical fail-closed)", () => {
  it("a stale surface-member ref fails with the legacy stale shape; resolver never called", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValue(STALE_RESULT);

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_STALE");
    expect(body.error.recovery_state).toBe("disabled");
    expect(body.error.surface_resolution_state).toBeUndefined();
    expect(resolveSurfaceMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });
});

describe("browser-click surface resolution — flag ON", () => {
  it("re-resolves a stale surface action inside its live surface and re-clicks the fresh box", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce(STALE_RESULT).mockResolvedValueOnce(SUCCESS_RESULT);
    resolveSurfaceMock.mockResolvedValue(RESOLVED);

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.surface_resolution_state).toBe("resolved");
    expect(data.recovered_from_stale_reason).toBe("page_re_rendering");

    // The resolver received the SEMANTIC surface identity (type + title).
    expect(resolveSurfaceMock).toHaveBeenCalledTimes(1);
    expect(resolveSurfaceMock.mock.calls[0][0].surface).toEqual({
      overlay_type: "dialog",
      modal_title: "GLIMMA was added to your shopping bag",
    });
    // The retry clicked the FRESH box through the unchanged trusted click path.
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(2);
    expect(clickKnownBoxMock.mock.calls[1][0].box).toEqual(FRESH_BOX);
    // Surface members never use page-wide recovery.
    expect(recoverBoxMock).not.toHaveBeenCalled();
  });

  it("never falls back to page-wide recovery for a surface member — even with the recovery flag on", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValue(STALE_RESULT);
    resolveSurfaceMock.mockResolvedValue({ status: "surface_gone" });

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_STALE");
    expect(body.error.surface_resolution_state).toBe("failed_surface_gone");
    // The gone-surface message tells the agent the panel closed.
    expect(body.error.message).toContain("no longer present");
    expect(recoverBoxMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("refuses denylisted names inside surfaces (skipped_ineligible, no resolution call)", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    seedSession();
    // "Remove from bag" classifies cart_mutation (low-risk intent) but hits the
    // sensitive-commit denylist ("remove") — surface resolution must refuse.
    seedSnapshot([
      candidate({
        tag: "button",
        kind: "button",
        role: "button",
        name: "Remove from bag",
        normalized_name: "remove from bag",
        href: null,
        href_path: null,
      }),
    ]);
    clickKnownBoxMock.mockResolvedValue(STALE_RESULT);

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.surface_resolution_state).toBe("skipped_ineligible");
    expect(resolveSurfaceMock).not.toHaveBeenCalled();
    expect(recoverBoxMock).not.toHaveBeenCalled();
  });

  it("fails closed on intent drift: a resolved live element that re-classifies as final never dispatches", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValue(STALE_RESULT);
    resolveSurfaceMock.mockResolvedValue({
      status: "resolved",
      box: FRESH_BOX,
      live: { name: "Pay now", kind: "button", href_path: null },
    });

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.surface_resolution_state).toBe("failed_intent_drift");
    // Only the original click attempt — the drifted target was never re-clicked.
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("ambiguous surfaces/actions fail closed with their distinct states", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValue(STALE_RESULT);

    for (const [status, expected] of [
      ["surface_ambiguous", "failed_surface_ambiguous"],
      ["action_ambiguous", "failed_action_ambiguous"],
      ["action_not_found", "failed_action_not_found"],
      ["page_changed", "failed_page_changed"],
      ["cdp_error", "failed_cdp"],
    ] as const) {
      resolveSurfaceMock.mockResolvedValue({ status });
      const res = await clickRef("ag_1");
      expect(res.statusCode).toBe(422);
      expect(res.json().error.surface_resolution_state).toBe(expected);
    }
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(5);
  });

  it("final actions inside a surface are blocked by the action gate BEFORE any click or resolution", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    seedSession();
    seedSnapshot([
      candidate({
        tag: "button",
        kind: "button",
        role: "button",
        name: "Pay $8.47",
        normalized_name: "pay $847",
        href: null,
        href_path: null,
      }),
    ]);

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.mode).toBe("blocked_by_antigen_platform");
    expect(data.dispatched).toBe(false);
    expect(data.action_intent).toBe("final_commit");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
    expect(resolveSurfaceMock).not.toHaveBeenCalled();
  });

  it("non-surface refs keep the unchanged page-wide path (resolver never called)", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    // Same link, but NOT an overlay member (the churning background header).
    seedSnapshot([
      candidate({
        name: "Shopping bag, 1 items",
        normalized_name: "shopping bag 1 items",
        overlay: undefined,
      }),
    ]);
    clickKnownBoxMock.mockResolvedValueOnce(STALE_RESULT).mockResolvedValueOnce(SUCCESS_RESULT);
    recoverBoxMock.mockResolvedValue({ status: "recovered", box: FRESH_BOX });

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.recovery_state).toBe("recovered");
    expect(data.surface_resolution_state).toBeUndefined();
    expect(resolveSurfaceMock).not.toHaveBeenCalled();
    expect(recoverBoxMock).toHaveBeenCalledTimes(1);
  });

  it("a successful first click never enters resolution (happy path untouched)", async () => {
    process.env.ANTIGEN_SURFACE_RESOLVE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValue(SUCCESS_RESULT);

    const res = await clickRef("ag_1");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.surface_resolution_state).toBeUndefined();
    expect(resolveSurfaceMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });
});
