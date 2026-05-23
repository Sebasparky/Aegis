import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Suppress disk writes.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// ─── Mock taskBrowserSessions runtime ─────────────────────────────────────────

const createMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const getPortStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/taskBrowserSessions.js", async () => {
  const { taskBrowserSessions } = await vi.importActual<typeof import("../runtime/taskBrowserSessions.js")>(
    "../runtime/taskBrowserSessions.js",
  );
  return {
    taskBrowserSessions,
    createTaskBrowserSession: createMock,
    closeTaskBrowserSession: closeMock,
    getTaskBrowserSession: getSessionMock,
    getTaskBrowserSessionForReuse: vi.fn(),
    findChromeBinary: vi.fn().mockReturnValue("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    expireInactiveTaskBrowserSessions: vi.fn(),
    ALL_CDP_PORTS: [9222, 9223, 9224, 9225, 9226],
    getPortStatusForDiagnostics: getPortStatusMock,
  };
});

// Stub transitive deps required by agentApiRoutes and login diagnostics
vi.mock("../lib/loginDiagnostics.js", () => ({
  loginDiagnosticsStore: new Map(),
  classifyLoginOutcome: vi.fn().mockReturnValue(null),
  storeDiagnostic: vi.fn(),
}));
vi.mock("../store/index.js", async () => {
  const actual = await vi.importActual<typeof import("../store/index.js")>("../store/index.js");
  return actual;
});
vi.mock("../routes/agent-api.js", () => ({
  requireAgentToken: vi.fn().mockImplementation(async (req: any, reply: any) => {
    if (!req.headers?.authorization) {
      reply.status(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing token" } });
      return undefined;
    }
    return { id: "del_001", user_id: "user_001", agent_name: "TestAgent" };
  }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { taskBrowserSessionRoutes } from "../routes/task-browser-sessions.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(taskBrowserSessionRoutes);
  await server.ready();
});
afterAll(() => server.close());

beforeEach(() => {
  taskBrowserSessions.clear();
  vi.clearAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BEARER = "Bearer tok_test_001";

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: "tbs_test_001",
    user_id: "user_001",
    delegation_id: "del_001",
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/test-browser-001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  };
  taskBrowserSessions.set(session.browser_session_id, session);
  return session;
}

// ─── POST /api/task-browser-sessions — create ─────────────────────────────────

describe("POST /api/task-browser-sessions — create", () => {
  it("returns 201 on fresh session creation", async () => {
    const session = seedSession();
    createMock.mockResolvedValue({
      session,
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.browser_session_id).toBe("tbs_test_001");
    expect(data.status).toBe("ready");
  });

  it("returns 200 when an existing ready session is reused", async () => {
    const session = seedSession();
    createMock.mockResolvedValue({
      session,
      reused_existing: true,
      user_message: "Reusing the active Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.reused_existing).toBe(true);
  });

  it("returns 201 with port_auto_selected when an alternate port is used", async () => {
    const session = seedSession({ cdp_port: 9224, cdp_url: "http://localhost:9224" });
    createMock.mockResolvedValue({
      session,
      port_auto_selected: true,
      requires_browser_reconnect: true,
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.port_auto_selected).toBe(true);
    expect(data.requires_browser_reconnect).toBe(true);
  });

  it("returns 401 without auth token", async () => {
    const res = await server.inject({ method: "POST", url: "/api/task-browser-sessions", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

// ─── NO_PORTS_AVAILABLE — enriched 503 ───────────────────────────────────────

describe("POST /api/task-browser-sessions — NO_PORTS_AVAILABLE error", () => {
  it("returns 503 with code and message", async () => {
    const err = Object.assign(
      new Error("All ports 9222–9250 are occupied. Close any open task browser sessions and retry."),
      { code: "NO_PORTS_AVAILABLE" },
    );
    createMock.mockRejectedValue(err);

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe("NO_PORTS_AVAILABLE");
    expect(body.error.message).toContain("9222");
  });

  it("includes occupied_port_range and tracked_occupied_sessions when provided by runtime", async () => {
    const err = Object.assign(
      new Error("All ports 9222–9250 are occupied."),
      {
        code: "NO_PORTS_AVAILABLE",
        occupied_port_range: "9222–9250",
        tracked_occupied_sessions: [
          { session_id: "tbs_stale_001", status: "closed", port: 9222 },
          { session_id: "tbs_stale_002", status: "failed", port: 9223 },
        ],
      },
    );
    createMock.mockRejectedValue(err);

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.occupied_port_range).toBe("9222–9250");
    expect(body.error.tracked_occupied_sessions).toHaveLength(2);
    expect(body.error.tracked_occupied_sessions[0].session_id).toBe("tbs_stale_001");
  });

  it("tracked_occupied_sessions defaults to empty array when not in error", async () => {
    const err = Object.assign(new Error("All ports occupied."), { code: "NO_PORTS_AVAILABLE" });
    createMock.mockRejectedValue(err);

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.tracked_occupied_sessions).toEqual([]);
  });

  it("error body never contains PIDs, user_data_dir, or secret values", async () => {
    const err = Object.assign(
      new Error("All ports occupied."),
      {
        code: "NO_PORTS_AVAILABLE",
        tracked_occupied_sessions: [{ session_id: "tbs_001", status: "closed", port: 9222 }],
      },
    );
    createMock.mockRejectedValue(err);

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: {},
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("user_data_dir");
    expect(body).not.toContain("/tmp/");
    expect(body).not.toContain("password");
    expect(body).not.toContain("secret_ref");
  });
});

// ─── POST /api/task-browser-sessions/:id/close ───────────────────────────────

describe("POST /api/task-browser-sessions/:id/close", () => {
  it("returns closed session with cleanup_complete: true", async () => {
    seedSession();
    getSessionMock.mockReturnValue(taskBrowserSessions.get("tbs_test_001"));
    closeMock.mockResolvedValue({
      browser_session_id: "tbs_test_001",
      status: "closed",
      closed_at: new Date().toISOString(),
      cleanup_complete: true,
      user_id: "user_001",
      delegation_id: "del_001",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions/tbs_test_001/close",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.status).toBe("closed");
    expect(data.cleanup_complete).toBe(true);
    expect(data.browser_session_id).toBe("tbs_test_001");
  });

  it("returns cleanup_complete: false when port was still occupied at close time", async () => {
    seedSession();
    getSessionMock.mockReturnValue(taskBrowserSessions.get("tbs_test_001"));
    closeMock.mockResolvedValue({
      browser_session_id: "tbs_test_001",
      status: "closed",
      closed_at: new Date().toISOString(),
      cleanup_complete: false,
      error: "Browser session close was requested, but the debugging endpoint is still active.",
      user_id: "user_001",
      delegation_id: "del_001",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions/tbs_test_001/close",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.cleanup_complete).toBe(false);
    expect(data.error).toContain("debugging endpoint is still active");
  });

  it("returns 404 when session not found", async () => {
    getSessionMock.mockReturnValue(undefined);
    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions/nonexistent/close",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when session belongs to a different delegation", async () => {
    getSessionMock.mockReturnValue({ browser_session_id: "tbs_test_001", delegation_id: "del_other", user_id: "user_001" });
    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions/tbs_test_001/close",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("close response never exposes PIDs or user_data_dir", async () => {
    seedSession();
    getSessionMock.mockReturnValue(taskBrowserSessions.get("tbs_test_001"));
    closeMock.mockResolvedValue({
      browser_session_id: "tbs_test_001",
      status: "closed",
      closed_at: new Date().toISOString(),
      cleanup_complete: true,
      user_id: "user_001",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions/tbs_test_001/close",
      headers: { authorization: BEARER },
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("user_data_dir");
    expect(body).not.toContain("/tmp/");
  });
});

// ─── GET /api/internal/task-browser-port-status ──────────────────────────────

describe("GET /api/internal/task-browser-port-status", () => {
  it("returns port status with occupied/available counts", async () => {
    getPortStatusMock.mockResolvedValue({
      port_range: "9222–9250",
      occupied_count: 2,
      available_count: 27,
      ports: [
        { port: 9222, in_use: true, session_id: "tbs_001", session_status: "ready", has_tracked_process: true },
        { port: 9223, in_use: true, session_id: "tbs_002", session_status: "closed", has_tracked_process: false },
        { port: 9224, in_use: false, session_id: null, session_status: null, has_tracked_process: false },
      ],
      sessions: [
        { session_id: "tbs_001", status: "ready", port: 9222, mode: "visible", created_at: new Date().toISOString(), expires_at: new Date().toISOString(), has_tracked_process: true },
        { session_id: "tbs_002", status: "closed", port: 9223, mode: "headless", created_at: new Date().toISOString(), expires_at: new Date().toISOString(), cleanup_complete: false, has_tracked_process: false },
      ],
    });

    const res = await server.inject({ method: "GET", url: "/api/internal/task-browser-port-status" });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.port_range).toBe("9222–9250");
    expect(data.occupied_count).toBe(2);
    expect(data.available_count).toBe(27);
    expect(data.ports).toHaveLength(3);
    expect(data.sessions).toHaveLength(2);
  });

  it("response never includes user_data_dir, PIDs, or credentials", async () => {
    getPortStatusMock.mockResolvedValue({
      port_range: "9222–9250",
      occupied_count: 0,
      available_count: 29,
      ports: [],
      sessions: [],
    });

    const res = await server.inject({ method: "GET", url: "/api/internal/task-browser-port-status" });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("user_data_dir");
    expect(body).not.toContain("pid");
    expect(body).not.toContain("password");
    expect(body).not.toContain("secret_ref");
  });

  it("returns sessions with has_tracked_process flag for identifying zombie processes", async () => {
    getPortStatusMock.mockResolvedValue({
      port_range: "9222–9250",
      occupied_count: 1,
      available_count: 28,
      ports: [{ port: 9222, in_use: true, session_id: "tbs_zombie", session_status: "closed", has_tracked_process: true }],
      sessions: [{ session_id: "tbs_zombie", status: "closed", port: 9222, mode: "headless", created_at: new Date().toISOString(), expires_at: new Date().toISOString(), cleanup_complete: false, has_tracked_process: true }],
    });

    const res = await server.inject({ method: "GET", url: "/api/internal/task-browser-port-status" });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.sessions[0].has_tracked_process).toBe(true);
    expect(data.sessions[0].cleanup_complete).toBe(false);
  });
});
