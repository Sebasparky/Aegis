/**
 * POST /api/agent/v1/runtime/browser-scroll-to-ref — Antigen scroll recovery tests.
 *
 * Harness mirrors antigen-browser-click-endpoint.test.ts:
 * - persistence is a no-op mock,
 * - the task browser runtime is the REAL in-memory Map (we seed sessions),
 * - the snapshot STORE is real (we seed snapshots via createAntigenSnapshotRecord),
 * - the runtime scroll helper (scrollKnownBoxIntoView) is mocked (no real browser/CDP).
 *
 * The endpoint resolves an ag_* ref to its internal document-space box and scrolls
 * it near the viewport — it NEVER clicks, never auto-refreshes the snapshot, and
 * never returns coordinates/box/cdp_url.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock only the scroll runtime — the snapshot store stays real.
const scrollKnownBoxMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return {
    ...actual,
    scrollKnownBoxIntoView: scrollKnownBoxMock,
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

const BEARER = "Bearer tok_scroll_001";
const DELEGATION_ID = "del_scroll_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_scroll_001";
const URL = "/api/agent/v1/runtime/browser-scroll-to-ref";

function makeSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_scroll_001",
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
    name: "Add to bag",
    normalized_name: "add to bag",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    // Offscreen full-page box: viewport y is past the fold; doc_y carries the
    // document-space position (viewport y + scroll offset at snapshot time).
    box: { x: 100, y: 1800, width: 120, height: 44, doc_x: 100, doc_y: 1800 },
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
  passes.set("pass_scroll_001", {
    id: "pass_scroll_001",
    token: "tok_scroll_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestScrollAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestScrollAgent",
    channel: "api",
    status: "active",
    token_id: "pass_scroll_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_scroll_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  scrollKnownBoxMock.mockResolvedValue({ success: true });
});

describe("POST /api/agent/v1/runtime/browser-scroll-to-ref", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await server.inject({ method: "POST", url: URL, payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" } });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 SESSION_NOT_FOUND for an unknown runtime id", async () => {
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: "tbsess_missing", ref: "ag_1" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns 400 SESSION_NOT_READY when the session is not ready", async () => {
    seedSession({ status: "starting" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SESSION_NOT_READY");
  });

  it("resolves a valid ag_* ref and calls scrollKnownBoxIntoView with the internal box", async () => {
    seedSession();
    seedSnapshot([
      candidate({ name: "Shopping bag", box: { x: 10, y: 20, width: 30, height: 40, doc_x: 10, doc_y: 20 } }),
      candidate({ name: "Add to bag", box: { x: 100, y: 1800, width: 120, height: 44, doc_x: 100, doc_y: 1800 } }),
    ]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_2" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("scroll_to_ref");
    expect(body.data.hint).toBe("take_new_snapshot");

    expect(scrollKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(scrollKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      cdpUrl: "http://localhost:9222",
      box: { width: 120, height: 44, doc_y: 1800 },
      sessionId: SESSION_ID,
      userId: MOCK_USER_ID,
    }));
  });

  it("returns 422 ANTIGEN_REF_INVALID for a malformed ref", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "not-a-ref" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_INVALID");
    expect(scrollKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_FOUND when the ref is absent / no snapshot", async () => {
    seedSession();
    seedSnapshot([candidate()]); // only ag_1 exists
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_99" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
    expect(scrollKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_EXPIRED for a stale snapshot", async () => {
    seedSession();
    // Snapshot created 1 hour ago → expired (TTL is 10s).
    seedSnapshot([candidate()], new Date(Date.now() - 60 * 60_000));
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_EXPIRED");
    expect(scrollKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_SCROLLABLE for a zero-size box", async () => {
    seedSession();
    seedSnapshot([candidate({ box: { x: 0, y: 0, width: 0, height: 0, doc_x: 0, doc_y: 0 } })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_SCROLLABLE");
    expect(scrollKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_SCROLLABLE when document geometry is missing", async () => {
    seedSession();
    // Box without doc_x/doc_y (e.g. an older snapshot shape).
    seedSnapshot([candidate({ box: { x: 100, y: 1800, width: 120, height: 44 } as any })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_SCROLLABLE");
    expect(scrollKnownBoxMock).not.toHaveBeenCalled();
  });

  it("maps a runtime failure to 422 ANTIGEN_SCROLL_FAILED", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    scrollKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_SCROLL_FAILED: WS_ERROR" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_SCROLL_FAILED");
  });

  it("never clicks: realisticClickKnownBox is not part of this path", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(200);
    // The success response carries no geometry, cdp, or pointer metadata.
    const raw = res.payload;
    for (const forbidden of [
      '"box"', '"doc_x"', '"doc_y"', '"x"', '"y"', '"width"', '"height"',
      "cdp_url", "user_data_dir", "secret", "pointer_path_point_count",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
