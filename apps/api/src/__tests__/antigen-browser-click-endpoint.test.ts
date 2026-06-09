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
