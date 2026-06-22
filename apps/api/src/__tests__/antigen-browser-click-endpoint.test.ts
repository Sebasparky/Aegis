/**
 * POST /api/agent/v1/runtime/browser-click — Antigen exact-ref (ag_*) tests.
 *
 * Harness mirrors antigen-browser-snapshot-endpoint.test.ts:
 * - persistence is a no-op mock,
 * - the task browser runtime is the REAL in-memory Map (we seed sessions),
 * - the snapshot STORE is real (we seed snapshots via createAntigenSnapshotRecord),
 * - the realistic pointer click runtime is mocked (no real browser/CDP), so we
 *   assert the ag_* path resolves the exact stored box and invokes
 *   realisticClickKnownBox — never the description path, never a DOM/Playwright click.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock only the realistic click runtime — the snapshot store stays real.
const clickKnownBoxMock = vi.hoisted(() => vi.fn());
const clickByDescriptionMock = vi.hoisted(() => vi.fn());
// Banner injection is mocked so we can assert the explicit-flag gate without real CDP.
const navBannerMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return {
    ...actual,
    realisticClickKnownBox: clickKnownBoxMock,
    realisticClickByDescription: clickByDescriptionMock,
    injectNavigationMediationBannerViaCDP: navBannerMock,
  };
});

// Mock ONLY recoverAntigenRefBox (CDP-backed) so the verify-retry path can be
// driven deterministically. classifyLogicalRecoveryEligibility /
// isLogicalRefRecoveryEnabled stay real (the latter is driven by env).
const recoverBoxMock = vi.hoisted(() => vi.fn());
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
import {
  createAntigenSnapshotRecord,
  clearAntigenSnapshotStoreForTests,
} from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";
import {
  createVisualGestureCapsule,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";

const BEARER = "Bearer tok_click_001";
const DELEGATION_ID = "del_click_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_click_001";
const URL = "/api/agent/v1/runtime/browser-click";
const CATEGORY_URL = "https://www.ikea.com/us/en/cat/workspace-desks-chairs-fu004/";

function makeSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_click_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: "https://www.ikea.com/us/en/",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  };
}

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session = makeSession(overrides);
  taskBrowserSessions.set(session.browser_session_id, session);
  return session;
}

function candidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "button",
    kind: "button",
    role: "button",
    name: "Ok",
    normalized_name: "ok",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 100, y: 200, width: 80, height: 40 },
    ...overrides,
  };
}

/** Seed an active snapshot for SESSION_ID/MOCK_USER_ID with the given candidates. */
function seedSnapshot(candidates: AntigenSnapshotCandidate[], now?: Date) {
  return createAntigenSnapshotRecord({
    browser_session_id: SESSION_ID,
    browser_runtime_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    url: "https://www.ikea.com/us/en/",
    title: null,
    candidates,
    now,
  });
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_click_001", {
    id: "pass_click_001",
    token: "tok_click_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestClickAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestClickAgent",
    channel: "api",
    status: "active",
    token_id: "pass_click_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_click_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  clickKnownBoxMock.mockResolvedValue({
    success: true,
    pointer_start_source: "session",
    pointer_path_point_count: 7,
    pointer_state_persisted: true,
    current_url: CATEGORY_URL,
  });
  // Benign default for the CDP-backed recovery (overridden per-test). Without a
  // resolved value the stale-recovery + verify-retry paths would crash on
  // `recovery.status`. "not_found" exercises the fail-closed branch.
  recoverBoxMock.mockReset();
  recoverBoxMock.mockResolvedValue({ status: "not_found" });
});

describe("POST /api/agent/v1/runtime/browser-click — Antigen ag_* path", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await server.inject({ method: "POST", url: URL, payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" } });
    expect(res.statusCode).toBe(401);
  });

  it("resolves a valid ag_* ref to its exact box and clicks via the realistic pointer runtime", async () => {
    seedSession();
    seedSnapshot([
      candidate({ name: "Shopping bag", box: { x: 10, y: 20, width: 30, height: 40 } }),
      candidate({ name: "Ok", box: { x: 100, y: 200, width: 80, height: 40 } }),
    ]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_2", element: "Ok" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("realistic_pointer_click");
    expect(body.data.pointer_start_source).toBe("session");
    expect(body.data.pointer_path_point_count).toBe(7);
    expect(body.data.pointer_state_persisted).toBe(true);

    // The realistic known-box path was used (NOT description matching).
    expect(clickByDescriptionMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(clickKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      box: { x: 100, y: 200, width: 80, height: 40 },
      sessionId: SESSION_ID,
      userId: MOCK_USER_ID,
    }));
  });

  it("passes snapshot metadata as `expected` for Phase 4B revalidation", async () => {
    seedSession();
    seedSnapshot([
      candidate({
        tag: "a", kind: "link", role: "link", name: "Desks & desk chairs",
        normalized_name: "desks & desk chairs", href_path: "/us/en/cat/workspace-desks-chairs-fu004/",
        box: { x: 100, y: 200, width: 80, height: 40 },
      }),
    ]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });

    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      expected: {
        tag: "a", kind: "link", role: "link", name: "Desks & desk chairs",
        normalized_name: "desks & desk chairs", href_path: "/us/en/cat/workspace-desks-chairs-fu004/",
      },
    }));
  });

  it("maps a runtime ANTIGEN_REF_STALE result to a 422 ANTIGEN_REF_STALE error", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE" });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_STALE");
    expect(body.error.message).toContain("antigen_snapshot");
    // session.current_url must not be refreshed on a stale (failed) click.
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe("https://www.ikea.com/us/en/");
  });

  it("the ANTIGEN_REF_STALE response leaks no internals", async () => {
    seedSession();
    seedSnapshot([candidate({ box: { x: 100, y: 200, width: 80, height: 40 } })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE" });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    const raw = JSON.stringify(res.json());
    for (const f of ["\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "cdp_url", "user_data_dir", "9222", "localhost"]) {
      expect(raw).not.toContain(f);
    }
  });

  it("maps a runtime ANTIGEN_REF_OUT_OF_VIEWPORT result to a 422 ANTIGEN_REF_OUT_OF_VIEWPORT error", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_OUT_OF_VIEWPORT" });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_OUT_OF_VIEWPORT");
    expect(body.error.message).toContain("viewport");
    expect(body.error.message).toContain("antigen_snapshot");
    expect(body.error.message.toLowerCase()).toContain("scroll");
    // session.current_url must not be refreshed on an out-of-viewport (failed) click.
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe("https://www.ikea.com/us/en/");
  });

  it("the ANTIGEN_REF_OUT_OF_VIEWPORT response leaks no internals", async () => {
    seedSession();
    seedSnapshot([candidate({ box: { x: 100, y: 200, width: 80, height: 40 } })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_OUT_OF_VIEWPORT" });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    const raw = JSON.stringify(res.json());
    for (const f of ["\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "cdp_url", "user_data_dir", "9222", "localhost"]) {
      expect(raw).not.toContain(f);
    }
  });

  it("refreshes session.current_url from the click result after a successful ag_* click", async () => {
    seedSession(); // seeded current_url is the homepage
    seedSnapshot([candidate({ name: "Desks & desk chairs", box: { x: 100, y: 200, width: 80, height: 40 } })]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });

    expect(res.statusCode).toBe(200);
    // Session current_url is updated to the post-click navigation target...
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe(CATEGORY_URL);
    // ...but the URL is never surfaced in the click response.
    expect(JSON.stringify(res.json())).not.toContain("ikea.com");
  });

  it("leaves session.current_url unchanged when the click result has no current_url", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true,
      pointer_start_source: "session",
      pointer_path_point_count: 7,
      pointer_state_persisted: true,
      // no current_url — simulates a click whose URL read failed or did not navigate
    });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });

    expect(res.statusCode).toBe(200); // click still succeeds
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe("https://www.ikea.com/us/en/");
  });

  it("returns 422 ANTIGEN_REF_NOT_FOUND for a missing ref in the active snapshot", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_99", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_FOUND when no snapshot exists for the session", async () => {
    seedSession();
    // No snapshot seeded.
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_EXPIRED when the snapshot is past its TTL", async () => {
    seedSession();
    // Seed a snapshot created past the 90s wall-clock TTL so it is already expired.
    seedSnapshot([candidate()], new Date(Date.now() - 120_000));
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_EXPIRED");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("still resolves a ref ~15s into the snapshot (within the 90s TTL)", async () => {
    seedSession();
    // 15s old: previously past the 10s TTL, now within the 90s budget so ordinary
    // agent reasoning between snapshot and click does not expire the ref.
    seedSnapshot([candidate()], new Date(Date.now() - 15_000));
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("passes the snapshot URL as expectedUrl for the live-URL guard", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(clickKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedUrl: "https://www.ikea.com/us/en/",
    }));
  });

  it("maps a runtime ANTIGEN_REF_PAGE_CHANGED result to a 422 with re-snapshot guidance", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_PAGE_CHANGED" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_PAGE_CHANGED");
    expect(res.json().error.message.toLowerCase()).toContain("antigen_snapshot");
    // A page-change (failed) click must not refresh session.current_url.
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe("https://www.ikea.com/us/en/");
  });

  it("returns 422 ANTIGEN_REF_NOT_CLICKABLE for a disabled element", async () => {
    seedSession();
    seedSnapshot([candidate({ enabled: false })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_CLICKABLE");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_CLICKABLE for a non-clickable element", async () => {
    seedSession();
    seedSnapshot([candidate({ clickable: false })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_CLICKABLE");
  });

  it("returns 422 ANTIGEN_REF_NOT_CLICKABLE for a zero-area box", async () => {
    seedSession();
    seedSnapshot([candidate({ box: { x: 5, y: 5, width: 0, height: 40 } })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_CLICKABLE");
  });

  it("returns 422 ANTIGEN_REF_INVALID for a malformed ag_ ref", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_abc", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_INVALID");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("does not resolve a ref seeded under a different session", async () => {
    seedSession();
    // Snapshot belongs to a DIFFERENT session.
    createAntigenSnapshotRecord({
      browser_session_id: "tbsess_other",
      browser_runtime_id: "tbsess_other",
      user_id: MOCK_USER_ID,
      url: null, title: null,
      candidates: [candidate()],
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
  });

  it("never leaks box/coordinates/internals in the response", async () => {
    seedSession();
    seedSnapshot([candidate({ box: { x: 100, y: 200, width: 80, height: 40 } })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    const raw = JSON.stringify(res.json());
    const FORBIDDEN = [
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"",
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref",
      "storageState", "9222", "localhost",
    ];
    for (const f of FORBIDDEN) {
      expect(raw).not.toContain(f);
    }
  });
});

describe("POST /api/agent/v1/runtime/browser-click — non-ag behavior unchanged", () => {
  it("uses the description path (not the ag_* path) for a non-ag click", async () => {
    seedSession();
    clickByDescriptionMock.mockResolvedValueOnce({
      success: true,
      pointer_start_source: "viewport_center",
      pointer_path_point_count: 5,
      pointer_state_persisted: true,
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, element_description: "Add to bag" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mode).toBe("realistic_pointer_click");
    expect(clickByDescriptionMock).toHaveBeenCalledTimes(1);
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("refreshes session.current_url after a successful description-path click", async () => {
    seedSession();
    clickByDescriptionMock.mockResolvedValueOnce({
      success: true,
      pointer_start_source: "viewport_center",
      pointer_path_point_count: 5,
      pointer_state_persisted: true,
      current_url: CATEGORY_URL,
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, element_description: "Desks & desk chairs" },
    });
    expect(res.statusCode).toBe(200);
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe(CATEGORY_URL);
    expect(JSON.stringify(res.json())).not.toContain("ikea.com");
  });

  it("still requires element_description for the non-ag path", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_FIELD");
    expect(clickByDescriptionMock).not.toHaveBeenCalled();
  });

  it("ignores a Playwright-style ref (e221) and falls through to the description path", async () => {
    seedSession();
    clickByDescriptionMock.mockResolvedValueOnce({ success: true, pointer_start_source: "session", pointer_path_point_count: 4, pointer_state_persisted: true });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "e221", element_description: "Ok" },
    });
    expect(res.statusCode).toBe(200);
    expect(clickByDescriptionMock).toHaveBeenCalledTimes(1);
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 404 SESSION_NOT_FOUND for an unknown runtime id on the ag_* path", async () => {
    seedSnapshot([candidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: "unknown_id", ref: "ag_1", element: "Ok" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("fails closed with RUNTIME_SESSION_CHANGED when the runtime was relaunched (stale id + ready replacement)", async () => {
    seedSnapshot([candidate()]);
    seedSession({ status: "closed" });
    seedSession({ browser_session_id: "tbsess_click_relaunched", status: "ready" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });
    // The stale ag_* ref must not be carried across runtimes.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("RUNTIME_SESSION_CHANGED");
  });
});

describe("POST /api/agent/v1/runtime/browser-click — capability-state gate", () => {
  it("does NOT dispatch the pointer for a final-commit target (Place order) and routes to the handoff", async () => {
    seedSession();
    seedSnapshot([candidate({ name: "Place order", normalized_name: "place order" })]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Place order" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("blocked_by_antigen_platform");
    expect(body.data.dispatched).toBe(false);
    expect(body.data.action_intent).toBe("final_commit");
    expect(body.data.recommended_handoff).toBe("request_purchase_confirmation");
    // The pointer was never dispatched — no realistic click of any kind.
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
    expect(clickByDescriptionMock).not.toHaveBeenCalled();
    // Response carries no element name / href / box — enum + canned reason only.
    expect(JSON.stringify(body.data)).not.toContain("Place order");
  });

  it("STILL dispatches the pointer for a reversible checkout transition (Continue to checkout)", async () => {
    seedSession();
    seedSnapshot([candidate({ name: "Continue to checkout", normalized_name: "continue to checkout" })]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Continue to checkout" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.mode).toBe("realistic_pointer_click");
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("blocks publish_send and routes to sensitive_workflow_required without dispatching", async () => {
    seedSession();
    seedSnapshot([candidate({ name: "Publish", normalized_name: "publish" })]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Publish" },
    });

    const body = res.json();
    expect(body.data.mode).toBe("blocked_by_antigen_platform");
    expect(body.data.action_intent).toBe("publish_send");
    expect(body.data.recommended_handoff).toBe("sensitive_workflow_required");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/v1/runtime/browser-click — TTL-expiry recovery", () => {
  const EXPIRED = () => new Date(Date.now() - 120_000); // past the 90s TTL
  // A low-risk navigation link (classifies as `navigation`, gate allows).
  const navLink = () =>
    candidate({
      tag: "a", kind: "link", role: "link", name: "Desks & desk chairs",
      normalized_name: "desks & desk chairs", href_path: "/us/en/cat/workspace-desks-chairs-fu004/",
      box: { x: 100, y: 200, width: 80, height: 40 },
    });

  afterEach(() => {
    delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
  });

  it("flag OFF: an expired ref hard-fails ANTIGEN_REF_EXPIRED with no dispatch (strict default)", async () => {
    delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
    seedSession();
    seedSnapshot([navLink()], EXPIRED());
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_EXPIRED");
    expect(res.json().error.ttl_recovery_state).toBeUndefined();
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("flag ON: an expired low-risk ref is re-validated, dispatched, and reports ttl_expired_recovered", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([navLink()], EXPIRED());
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.mode).toBe("realistic_pointer_click");
    expect(body.data.ttl_recovery_state).toBe("ttl_expired_recovered");
    // The full safety stack ran: Phase 4B `expected` was passed to the known-box path.
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(clickKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      expected: expect.objectContaining({ name: "Desks & desk chairs" }),
    }));
  });

  it("flag ON: an expired ref on a CHANGED page fails closed with page_changed", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([navLink()], EXPIRED());
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_PAGE_CHANGED" });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_PAGE_CHANGED");
    expect(body.error.ttl_recovery_state).toBe("page_changed");
  });

  it("flag ON: an expired ref that fails Phase 4B fails closed with semantic_mismatch", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([navLink()], EXPIRED());
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE" });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_STALE");
    expect(body.error.ttl_recovery_state).toBe("semantic_mismatch");
  });

  it("flag ON: an expired ref on a FINAL-COMMIT target fails closed with sensitive_requires_fresh_ref (no dispatch)", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([candidate({ name: "Place order", normalized_name: "place order" })], EXPIRED());
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Place order" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_EXPIRED");
    expect(body.error.ttl_recovery_state).toBe("sensitive_requires_fresh_ref");
    // Never dispatched and never routed to a handoff from stale metadata.
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/v1/runtime/browser-click — post-click verification (ANTIGEN_CLICK_VERIFY)", () => {
  // A low-risk navigation link (classifies as `navigation`, gate allows).
  const navLink = () =>
    candidate({
      tag: "a", kind: "link", role: "link", name: "Desks & desk chairs",
      normalized_name: "desks & desk chairs", href_path: "/us/en/cat/workspace-desks-chairs-fu004/",
      box: { x: 100, y: 200, width: 80, height: 40 },
    });
  // A low-risk cart-mutation button — eligible for logical-recovery re-find.
  const addToCart = () =>
    candidate({
      tag: "button", kind: "button", role: "button", name: "Add to cart",
      normalized_name: "add to cart", box: { x: 100, y: 200, width: 80, height: 40 },
    });

  function verification(overrides: Record<string, unknown> = {}) {
    return {
      click_dispatched: true,
      intent_verified: true,
      verification_signal: "url_changed",
      outcome: "CLICK_VERIFIED",
      recommended_next_step: "none",
      overlay_before_present: false,
      overlay_before_blocking: false,
      overlay_after_present: false,
      overlay_after_blocking: false,
      overlay_before_type: null,
      overlay_after_type: null,
      url_changed: true,
      verify_ms: 12,
      settle_polls: 1,
      ...overrides,
    };
  }

  afterEach(() => {
    delete process.env.ANTIGEN_CLICK_VERIFY;
    delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
  });

  it("flag OFF: response is byte-compatible with today and no verify option is passed", async () => {
    seedSession();
    seedSnapshot([navLink()]);
    // Default beforeEach mock returns success WITHOUT a verification object.
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    // No verification keys leak into the response when the flag is off.
    expect(data).not.toHaveProperty("click_dispatched");
    expect(data).not.toHaveProperty("intent_verified");
    expect(data).not.toHaveProperty("verification_signal");
    expect(data).not.toHaveProperty("outcome");
    expect(data).not.toHaveProperty("recommended_next_step");
    // The runtime was invoked WITHOUT a verify option (no probing path).
    const callArg = clickKnownBoxMock.mock.calls[0][0];
    expect(callArg.verify).toBeUndefined();
  });

  it("flag ON, verified: surfaces intent_verified + signal + outcome and passes verify option", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    seedSession();
    seedSnapshot([navLink()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_start_source: "session", pointer_state_persisted: true,
      current_url: CATEGORY_URL, verification: verification(),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Desks & desk chairs" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.click_dispatched).toBe(true);
    expect(data.intent_verified).toBe(true);
    expect(data.verification_signal).toBe("url_changed");
    expect(data.outcome).toBe("CLICK_VERIFIED");
    expect(data.recommended_next_step).toBe("none");
    expect(data).not.toHaveProperty("retried_once");
    // verify option threaded into the runtime.
    expect(clickKnownBoxMock.mock.calls[0][0].verify).toEqual(
      expect.objectContaining({ enabled: true, editableTarget: false, targetWasBehindBlockingModal: false }),
    );
    // A verified click never retries.
    expect(recoverBoxMock).not.toHaveBeenCalled();
  });

  it("flag ON + recovery ON: a no-effect low-risk click retries once on a unique re-found target", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([addToCart()]);
    // First dispatch: no effect. Retry dispatch: verified (cart changed).
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/",
      verification: verification({ intent_verified: false, verification_signal: "no_effect", outcome: "CLICK_DISPATCHED_NO_EFFECT", recommended_next_step: "try_alternate_ref", url_changed: false }),
    });
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/",
      verification: verification({ verification_signal: "cart_changed", url_changed: false }),
    });
    recoverBoxMock.mockResolvedValueOnce({ status: "recovered", box: { x: 100, y: 200, width: 80, height: 40 } });

    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Add to cart" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(2);
    expect(recoverBoxMock).toHaveBeenCalledTimes(1);
    expect(data.retried_once).toBe(true);
    expect(data.intent_verified).toBe(true);
    expect(data.verification_signal).toBe("cart_changed");
    expect(data.outcome).toBe("CLICK_VERIFIED");
  });

  it("flag ON: CLICK_INTENT_UNVERIFIED never triggers a retry", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([addToCart()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/",
      verification: verification({ intent_verified: false, verification_signal: "no_effect", outcome: "CLICK_INTENT_UNVERIFIED", recommended_next_step: "refresh_snapshot", url_changed: false }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Add to cart" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(recoverBoxMock).not.toHaveBeenCalled();
    expect(data.outcome).toBe("CLICK_INTENT_UNVERIFIED");
    expect(data.recommended_next_step).toBe("refresh_snapshot");
    expect(data).not.toHaveProperty("retried_once");
  });

  it("flag ON: a click behind a blocking modal (background marker) never retries", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    // Background-behind-modal marker on the snapshot element drives the trap guard.
    seedSnapshot([
      candidate({
        tag: "a", kind: "link", role: "link", name: "Browse catalog", normalized_name: "browse catalog",
        href_path: "/us/en/cat/", box: { x: 100, y: 200, width: 80, height: 40 },
        overlay: { overlay_type: "overlay", blocking: false, background: true },
      }),
    ]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/",
      verification: verification({ intent_verified: false, verification_signal: "no_effect", outcome: "CLICK_DISPATCHED_NO_EFFECT", recommended_next_step: "refresh_snapshot", url_changed: false }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Browse catalog" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(recoverBoxMock).not.toHaveBeenCalled();
    expect(data.intent_verified).toBe(false);
    // verify option carried the modal-trap context from the snapshot metadata.
    expect(clickKnownBoxMock.mock.calls[0][0].verify.targetWasBehindBlockingModal).toBe(true);
  });

  it("flag ON: a FINAL-COMMIT target is blocked pre-dispatch — verification/retry never run", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([candidate({ name: "Place order", normalized_name: "place order" })]);
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Place order" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mode).toBe("blocked_by_antigen_platform");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
    expect(recoverBoxMock).not.toHaveBeenCalled();
  });

  it("flag ON, description path: surfaces verification fields and never retries", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    clickByDescriptionMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: CATEGORY_URL,
      verification: verification({ verification_signal: "modal_opened", url_changed: false, overlay_after_present: true, overlay_after_blocking: true, overlay_after_type: "dialog" }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, element_description: "Continue" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.intent_verified).toBe(true);
    expect(data.verification_signal).toBe("modal_opened");
    expect(data.outcome).toBe("CLICK_VERIFIED");
    expect(data).not.toHaveProperty("retried_once");
    expect(recoverBoxMock).not.toHaveBeenCalled();
    expect(clickByDescriptionMock.mock.calls[0][0].verify).toEqual(
      expect.objectContaining({ enabled: true }),
    );
  });
});

describe("POST /api/agent/v1/runtime/browser-click — post_click_state (generalized realization summary)", () => {
  // "Continue to checkout" classifies as checkout_transition (reversible, allowed).
  const checkoutButton = () =>
    candidate({
      tag: "button", kind: "button", role: "button", name: "Continue to checkout",
      normalized_name: "continue to checkout", box: { x: 100, y: 200, width: 80, height: 40 },
    });
  const navLink = () =>
    candidate({
      tag: "a", kind: "link", role: "link", name: "Shopping bag",
      normalized_name: "shopping bag", href_path: "/us/en/cart/",
      box: { x: 100, y: 200, width: 80, height: 40 },
    });

  function verification(overrides: Record<string, unknown> = {}) {
    return {
      click_dispatched: true,
      intent_verified: true,
      verification_signal: "url_changed",
      outcome: "CLICK_VERIFIED",
      recommended_next_step: "none",
      overlay_before_present: false,
      overlay_before_blocking: false,
      overlay_after_present: false,
      overlay_after_blocking: false,
      overlay_before_type: null,
      overlay_after_type: null,
      url_changed: true,
      verify_ms: 480,
      settle_polls: 3,
      ...overrides,
    };
  }

  const guestModalInternal = () => ({
    before_url: "https://www.ikea.com/us/en/",
    after_url: "https://www.ikea.com/us/en/",
    before_title: "Shopping bag",
    after_title: "Shopping bag",
    ready_state: "complete",
    main_content_changed: true,
    after_overlay: {
      present: true,
      blocking: true,
      overlay_type: "dialog",
      title_hash: "ch01",
      title: "Choose how to check out",
      actions: [
        { name: "Continue as guest", kind: "button", dismiss: false },
        { name: "Log in", kind: "button", dismiss: false },
        { name: "Close", kind: "button", dismiss: true },
      ],
    },
  });

  afterEach(() => {
    delete process.env.ANTIGEN_CLICK_VERIFY;
    delete process.env.ANTIGEN_ACTIVE_SURFACES;
  });

  it("checkout click that opens the guest modal: post_click_state carries surface + action names (no extra snapshot needed)", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_ACTIVE_SURFACES = "true";
    seedSession();
    seedSnapshot([checkoutButton()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/",
      verification: verification({
        verification_signal: "modal_opened", url_changed: false,
        overlay_after_present: true, overlay_after_blocking: true, overlay_after_type: "dialog",
        post_click_internal: guestModalInternal(),
      }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Continue to checkout" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    // Bounded timing telemetry now agent-visible.
    expect(data.verify_ms).toBe(480);
    expect(data.settle_polls).toBe(3);
    // Realization summary: the modal is already here — no retry, no blind snapshot.
    expect(data.post_click_state).toBeDefined();
    expect(data.post_click_state.change).toBe("modal_opened");
    expect(data.post_click_state.next).toBe("refs_require_fresh_snapshot");
    expect(data.post_click_state.surface.overlay_type).toBe("dialog");
    expect(data.post_click_state.surface.overlay_blocking).toBe(true);
    expect(data.post_click_state.surface.title).toBe("Choose how to check out");
    const names = data.post_click_state.surface.surface_actions.map((a: { name: string }) => a.name);
    expect(names).toContain("Continue as guest");
    expect(names).toContain("Close");
    // Names only — never refs/boxes/hrefs inside surface actions.
    for (const a of data.post_click_state.surface.surface_actions) {
      expect(Object.keys(a).sort()).toEqual(
        expect.arrayContaining(["classification", "name"]),
      );
      expect(a).not.toHaveProperty("ref");
      expect(a).not.toHaveProperty("box");
      expect(a).not.toHaveProperty("href");
    }
    // The raw internal carrier never leaks.
    expect(res.body).not.toContain("post_click_internal");
    expect(res.body).not.toContain("title_hash");
    // checkout_transition selected the extended settle schedule via the verify option.
    expect(clickKnownBoxMock.mock.calls[0][0].verify).toEqual(
      expect.objectContaining({ checkoutTransitionIntent: true, collectSurfaceDetail: true }),
    );
  });

  it("navigation click: sanitized paths only — query strings/fragments never leak", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_ACTIVE_SURFACES = "true";
    seedSession();
    seedSnapshot([navLink()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true,
      current_url: "https://www.ikea.com/us/en/checkout?session=tok_secret#step1",
      verification: verification({
        post_click_internal: {
          before_url: "https://www.ikea.com/us/en/cart/",
          after_url: "https://www.ikea.com/us/en/checkout?session=tok_secret#step1",
          before_title: "Shopping bag",
          after_title: "Checkout",
          ready_state: "complete",
          main_content_changed: true,
        },
      }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Shopping bag" },
    });
    expect(res.statusCode).toBe(200);
    const state = res.json().data.post_click_state;
    expect(state.change).toBe("navigation");
    expect(state.old_url_path).toBe("/us/en/cart/");
    expect(state.new_url_path).toBe("/us/en/checkout");
    expect(state.old_title).toBe("Shopping bag");
    expect(state.new_title).toBe("Checkout");
    expect(state.document_ready_state).toBe("complete");
    expect(res.body).not.toContain("tok_secret");
    expect(res.body).not.toContain("session=");
  });

  it("still-loading navigation reports wait_for_load_then_snapshot", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    seedSession();
    seedSnapshot([navLink()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/checkout",
      verification: verification({
        post_click_internal: {
          before_url: "https://www.ikea.com/us/en/cart/",
          after_url: "https://www.ikea.com/us/en/checkout",
          before_title: "Shopping bag",
          after_title: null,
          ready_state: "interactive",
          main_content_changed: true,
        },
      }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Shopping bag" },
    });
    const state = res.json().data.post_click_state;
    expect(state.change).toBe("still_loading");
    expect(state.recommended_next_step).toBe("wait_for_load_then_snapshot");
  });

  it("CLICK_VERIFY without ACTIVE_SURFACES: surface present, surface_actions omitted", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    seedSession();
    seedSnapshot([checkoutButton()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/",
      verification: verification({
        verification_signal: "modal_opened", url_changed: false,
        overlay_after_present: true, overlay_after_blocking: true, overlay_after_type: "dialog",
        post_click_internal: guestModalInternal(),
      }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Continue to checkout" },
    });
    const state = res.json().data.post_click_state;
    expect(state.surface.title).toBe("Choose how to check out");
    expect(state.surface).not.toHaveProperty("surface_actions");
    expect(clickKnownBoxMock.mock.calls[0][0].verify).toEqual(
      expect.objectContaining({ collectSurfaceDetail: false }),
    );
  });

  it("flags OFF: no post_click_state / verify_ms / settle_polls anywhere in the response", async () => {
    seedSession();
    seedSnapshot([checkoutButton()]);
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Continue to checkout" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).not.toHaveProperty("post_click_state");
    expect(data).not.toHaveProperty("verify_ms");
    expect(data).not.toHaveProperty("settle_polls");
    expect(res.body).not.toContain("post_click_internal");
    expect(clickKnownBoxMock.mock.calls[0][0].verify).toBeUndefined();
  });

  it("description path: post_click_state surfaces with the same sanitization", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_ACTIVE_SURFACES = "true";
    seedSession();
    clickByDescriptionMock.mockResolvedValueOnce({
      success: true, pointer_state_persisted: true, current_url: "https://www.ikea.com/us/en/",
      verification: verification({
        verification_signal: "modal_opened", url_changed: false,
        overlay_after_present: true, overlay_after_blocking: true, overlay_after_type: "dialog",
        post_click_internal: guestModalInternal(),
      }),
    });
    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, element_description: "Continue to checkout" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.post_click_state.change).toBe("modal_opened");
    expect(data.post_click_state.surface.title).toBe("Choose how to check out");
    expect(data.verify_ms).toBe(480);
    expect(res.body).not.toContain("post_click_internal");
    expect(clickByDescriptionMock.mock.calls[0][0].verify).toEqual(
      expect.objectContaining({ checkoutTransitionIntent: true, collectSurfaceDetail: true }),
    );
  });
});

// Follow-up 1 (runtime DOM footprint audit): pointer debug overlays and the nav-mediation
// banner are EXPLICIT-OPT-IN only — they must not be injected just because the session is
// visible/headed. resolveOverlayEnabled now requires ANTIGEN_POINTER_DEBUG_OVERLAY=true.
// The overlay decision is observable via the debugOverlay arg passed to the (mocked) click
// runtime; the banner decision is observable via the (mocked) banner injector.
describe("overlay/banner are explicit-flag-only (Follow-up 1)", () => {
  const NAV_URL = "/api/agent/v1/runtime/browser-navigation-state";

  beforeEach(() => {
    navBannerMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
  });

  it("visible session + flag unset → debugOverlay:false (no overlay injected)", async () => {
    delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
    seedSession({ mode: "visible" });
    seedSnapshot([candidate()]);

    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({ debugOverlay: false }));
  });

  it("visible session + flag=true → debugOverlay:true (overlay injected)", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    seedSession({ mode: "visible" });
    seedSnapshot([candidate()]);

    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({ debugOverlay: true }));
  });

  it("headless session + flag unset → debugOverlay:false (default stays off)", async () => {
    delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
    seedSession({ mode: "headless" });
    seedSnapshot([candidate()]);

    const res = await server.inject({
      method: "POST", url: URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({ debugOverlay: false }));
  });

  it("nav banner: visible session + flag unset → banner NOT injected", async () => {
    delete process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
    seedSession({ mode: "visible" });

    const res = await server.inject({
      method: "POST", url: NAV_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://www.ikea.com/us/en/", action: "navigation_proxy" },
    });

    expect(res.statusCode).toBe(200);
    expect(navBannerMock).not.toHaveBeenCalled();
  });

  it("nav banner: flag=true → banner injected", async () => {
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY = "true";
    seedSession({ mode: "visible" });

    const res = await server.inject({
      method: "POST", url: NAV_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://www.ikea.com/us/en/", action: "navigation_proxy" },
    });

    expect(res.statusCode).toBe(200);
    expect(navBannerMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Active Visual Gesture Capsule guard (action + navigation-state) ──────────
// A pending VGC must fail closed BEFORE ref resolution (click) and BEFORE the
// navigation-state success response — while preserving nav-state bookkeeping.
describe("active VGC guard on browser-click / browser-navigation-state", () => {
  const NAV_URL = "/api/agent/v1/runtime/browser-navigation-state";
  const prevFlag = process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    clearVisualGestureCapsulesForTests();
  });

  afterEach(() => {
    clearVisualGestureCapsulesForTests();
    if (prevFlag === undefined) delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    else process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = prevFlag;
  });

  it("browser-click fails closed with HUMAN_VERIFICATION_REQUIRED before resolving the ref", async () => {
    // Same-origin live page so the reuse guard blocks (cross-origin staleness is
    // covered separately in human-verification-preflight-ordering).
    seedSession({ current_url: "https://www.bathandbodyworks.com/cart" });
    seedSnapshot([candidate({ name: "Ok", box: { x: 1, y: 2, width: 3, height: 4 } })]);
    createVisualGestureCapsule({
      human_verification_request_id: "hvreq_click_vgc_001",
      browser_session_id: SESSION_ID,
      domain: "www.bathandbodyworks.com",
    });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Ok" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.visual_gesture_capsule.available).toBe(true);
    // The ref was never resolved → the realistic click runtime was never invoked.
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
    expect(clickByDescriptionMock).not.toHaveBeenCalled();
  });

  it("browser-navigation-state fails closed but preserves internal bookkeeping (current_url)", async () => {
    seedSession();
    createVisualGestureCapsule({
      human_verification_request_id: "hvreq_nav_vgc_001",
      browser_session_id: SESSION_ID,
      domain: "www.bathandbodyworks.com",
    });

    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://www.bathandbodyworks.com/checkout", action: "navigation_proxy" },
    });

    // Agent-facing response is the stop signal, not a normal nav-state success.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().data).toBeUndefined();
    // Internal bookkeeping still ran before the fail-closed return.
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe(
      "https://www.bathandbodyworks.com/checkout",
    );
  });
});
