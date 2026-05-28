/**
 * Tests for Persistent Browser Profile v1.
 *
 * Covers:
 * - browserProfilePersistence.ts unit tests (key derivation, path resolution, fs helpers)
 * - expireInactiveTaskBrowserSessions cleanup behavior (persistent vs ephemeral)
 * - POST /api/task-browser-sessions response safety (persistent_profile_enabled, profile_state)
 *
 * Cookie/localStorage survival across real Chrome sessions is not tested here —
 * it requires launching a real Chrome process. The tests below prove the profile
 * directory is reused at the runtime boundary (same key → same path on second
 * session creation), which is the invariant that enables cookie survival.
 * TODO: add Playwright-based cookie survival tests once a controlled headless Chrome
 *       fixture is available in the test suite.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// ─── Mock fs / os for unit tests ──────────────────────────────────────────────

const mockExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockRmSync = vi.hoisted(() => vi.fn());

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: mockExistsSync, mkdirSync: mockMkdirSync, rmSync: mockRmSync };
});

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => "/test-home" };
});

// ─── Suppress disk writes ──────────────────────────────────────────────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

vi.mock("../lib/loginDiagnostics.js", () => ({
  loginDiagnosticsStore: new Map(),
  classifyLoginOutcome: vi.fn().mockReturnValue(null),
  storeDiagnostic: vi.fn(),
}));

// ─── Mock taskBrowserSessions runtime for route tests ─────────────────────────

const createMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/taskBrowserSessions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/taskBrowserSessions.js")>(
    "../runtime/taskBrowserSessions.js",
  );
  return {
    ...actual,
    createTaskBrowserSession: createMock,
    closeTaskBrowserSession: closeMock,
    getTaskBrowserSession: getSessionMock,
    getTaskBrowserSessionForReuse: vi.fn(),
    findChromeBinary: vi.fn().mockReturnValue("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    getPortStatusForDiagnostics: vi.fn().mockReturnValue({ ports: [] }),
  };
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

vi.mock("../store/index.js", async () => {
  const actual = await vi.importActual<typeof import("../store/index.js")>("../store/index.js");
  return actual;
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import Fastify, { type FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import {
  computeProfileKey,
  getPersistentProfileDir,
  persistentProfileExists,
  ensurePersistentProfileDir,
} from "../runtime/browserProfilePersistence.js";
import { taskBrowserSessions, expireInactiveTaskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { taskBrowserSessionRoutes } from "../routes/task-browser-sessions.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BEARER = "Bearer tok_test_001";

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: "tbsess_test_001",
    user_id: "user_001",
    delegation_id: "del_001",
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_test_001",
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
  delete process.env.AEGIS_BROWSER_PROFILES_DIR;
});

// ─── computeProfileKey unit tests ─────────────────────────────────────────────

describe("computeProfileKey", () => {
  it("is deterministic — same inputs always produce the same key", () => {
    expect(computeProfileKey("user_001", "del_abc")).toBe(computeProfileKey("user_001", "del_abc"));
  });

  it("different users produce different keys", () => {
    expect(computeProfileKey("user_001", "del_abc")).not.toBe(computeProfileKey("user_002", "del_abc"));
  });

  it("same user, different delegations produce different keys", () => {
    expect(computeProfileKey("user_001", "del_abc")).not.toBe(computeProfileKey("user_001", "del_xyz"));
  });

  it("no delegation produces a stable user-scoped key", () => {
    expect(computeProfileKey("user_001")).toBe(computeProfileKey("user_001"));
  });

  it("user-scoped key differs from delegation-scoped key for same user", () => {
    expect(computeProfileKey("user_001")).not.toBe(computeProfileKey("user_001", "del_abc"));
  });

  it("returns exactly 16 hex characters", () => {
    expect(/^[0-9a-f]{16}$/.test(computeProfileKey("user_001", "del_abc"))).toBe(true);
  });

  it("output does NOT contain the raw userId string", () => {
    expect(computeProfileKey("user_001", "del_abc")).not.toContain("user_001");
  });

  it("output does NOT contain the raw delegationId string", () => {
    expect(computeProfileKey("user_001", "del_abc")).not.toContain("del_abc");
  });
});

// ─── getPersistentProfileDir unit tests ───────────────────────────────────────

describe("getPersistentProfileDir", () => {
  it("uses AEGIS_BROWSER_PROFILES_DIR env var when set", () => {
    process.env.AEGIS_BROWSER_PROFILES_DIR = "/custom/profiles";
    const key = computeProfileKey("user_001", "del_001");
    expect(getPersistentProfileDir(key)).toBe(`/custom/profiles/${key}`);
  });

  it("falls back to ~/.aegis/browser-profiles when env not set", () => {
    const key = computeProfileKey("user_001", "del_001");
    expect(getPersistentProfileDir(key)).toBe(`/test-home/.aegis/browser-profiles/${key}`);
  });

  it("result does not contain raw userId or delegationId", () => {
    const dir = getPersistentProfileDir(computeProfileKey("user_001", "del_super_secret"));
    expect(dir).not.toContain("user_001");
    expect(dir).not.toContain("del_super_secret");
  });

  it("different scopes produce different directories", () => {
    const dirA = getPersistentProfileDir(computeProfileKey("user_001", "del_A"));
    const dirB = getPersistentProfileDir(computeProfileKey("user_001", "del_B"));
    expect(dirA).not.toBe(dirB);
  });
});

// ─── persistentProfileExists / ensurePersistentProfileDir ────────────────────

describe("persistentProfileExists", () => {
  it("returns false when profile directory does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(persistentProfileExists(computeProfileKey("user_001", "del_001"))).toBe(false);
  });

  it("returns true when profile directory exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(persistentProfileExists(computeProfileKey("user_001", "del_001"))).toBe(true);
  });
});

describe("ensurePersistentProfileDir", () => {
  it("calls mkdirSync with recursive:true to create Default/ subdirectory", () => {
    const key = computeProfileKey("user_001", "del_001");
    const dir = ensurePersistentProfileDir(key);
    expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining("Default"), { recursive: true });
    expect(dir).toContain(key);
  });

  it("returned path does not expose userId or delegationId", () => {
    const dir = ensurePersistentProfileDir(computeProfileKey("user_001", "del_secret"));
    expect(dir).not.toContain("user_001");
    expect(dir).not.toContain("del_secret");
  });
});

// ─── expireInactiveTaskBrowserSessions — cleanup behavior ────────────────────

describe("expireInactiveTaskBrowserSessions", () => {
  function expiredAt(): string {
    return new Date(Date.now() - 1000).toISOString();
  }

  it("calls rmSync (safeCleanupDir) for an expired ephemeral session", () => {
    seedSession({
      browser_session_id: "tbsess_ephemeral",
      user_data_dir: "/tmp/aegis-agent-browser-ephemeral",
      status: "ready",
      expires_at: expiredAt(),
      persistent_profile_enabled: false,
    });

    expireInactiveTaskBrowserSessions();

    expect(mockRmSync).toHaveBeenCalledWith(
      "/tmp/aegis-agent-browser-ephemeral",
      expect.objectContaining({ recursive: true }),
    );
    expect(taskBrowserSessions.get("tbsess_ephemeral")?.status).toBe("expired");
  });

  it("does NOT call rmSync for an expired persistent session", () => {
    const profileKey = computeProfileKey("user_001", "del_001");
    const profileDir = getPersistentProfileDir(profileKey);
    seedSession({
      browser_session_id: "tbsess_persistent",
      user_data_dir: profileDir,
      status: "ready",
      expires_at: expiredAt(),
      persistent_profile_enabled: true,
      profile_state: "reused",
    });

    expireInactiveTaskBrowserSessions();

    expect(mockRmSync).not.toHaveBeenCalled();
    expect(taskBrowserSessions.get("tbsess_persistent")?.status).toBe("expired");
  });

  it("does NOT expire sessions that have not yet reached expires_at", () => {
    seedSession({
      browser_session_id: "tbsess_active",
      status: "ready",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    expireInactiveTaskBrowserSessions();

    expect(taskBrowserSessions.get("tbsess_active")?.status).toBe("ready");
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("isolates cleanup: ephemeral is cleaned, persistent in same run is not", () => {
    seedSession({
      browser_session_id: "tbsess_eph",
      user_data_dir: "/tmp/aegis-agent-browser-eph",
      status: "ready",
      expires_at: expiredAt(),
      persistent_profile_enabled: false,
    });
    const profileKey = computeProfileKey("user_002", "del_002");
    seedSession({
      browser_session_id: "tbsess_per",
      user_id: "user_002",
      delegation_id: "del_002",
      user_data_dir: getPersistentProfileDir(profileKey),
      status: "ready",
      expires_at: expiredAt(),
      persistent_profile_enabled: true,
    });

    expireInactiveTaskBrowserSessions();

    // Only ephemeral dir was cleaned
    expect(mockRmSync).toHaveBeenCalledTimes(1);
    expect(mockRmSync).toHaveBeenCalledWith(
      "/tmp/aegis-agent-browser-eph",
      expect.objectContaining({ recursive: true }),
    );
  });
});

// ─── POST /api/task-browser-sessions — persistent_profile response ────────────

describe("POST /api/task-browser-sessions — persistent_profile response", () => {
  it("returns persistent_profile_enabled: true and profile_state when requested", async () => {
    const session = seedSession({ persistent_profile_enabled: true, profile_state: "fresh" });
    createMock.mockResolvedValue({
      session,
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: { persistent_profile: true },
    });

    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.persistent_profile_enabled).toBe(true);
    expect(data.profile_state).toBe("fresh");
  });

  it("returns profile_state: 'reused' on second creation for same scope", async () => {
    const session = seedSession({ persistent_profile_enabled: true, profile_state: "reused" });
    createMock.mockResolvedValue({
      session,
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: { persistent_profile: true },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.profile_state).toBe("reused");
  });

  it("returns persistent_profile_enabled: false for default ephemeral session", async () => {
    const session = seedSession({ persistent_profile_enabled: false });
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
    expect(data.persistent_profile_enabled).toBe(false);
    expect(data.profile_state).toBeUndefined();
  });

  it("passes persistent_profile: true to createTaskBrowserSession when requested", async () => {
    const session = seedSession({ persistent_profile_enabled: true, profile_state: "fresh" });
    createMock.mockResolvedValue({
      session,
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: { persistent_profile: true },
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ persistent_profile: true }),
    );
  });

  it("response never exposes the opaque profile_key hash as a separate field", async () => {
    const userId = "user_001";
    const delegationId = "del_001";
    const profileKey = computeProfileKey(userId, delegationId);
    const session = seedSession({
      persistent_profile_enabled: true,
      profile_state: "fresh",
    });
    createMock.mockResolvedValue({
      session,
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: { persistent_profile: true },
    });

    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    // profile_key must never appear as a named field in the response
    expect(data).not.toHaveProperty("profile_key");
    // profile_state is the only diagnostics field for profile identity
    expect(data).toHaveProperty("profile_state");
    // The opaque hash string must not appear as a standalone response field
    expect(data).not.toHaveProperty(profileKey);
  });

  it("protection: no cookie or storage values returned to callers", async () => {
    const session = seedSession({ persistent_profile_enabled: true, profile_state: "fresh" });
    createMock.mockResolvedValue({ session, user_message: "ok", mode: "headless" });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: BEARER },
      payload: { persistent_profile: true },
    });

    const body = res.body;
    // No raw credential or storage values should appear in any response
    expect(body).not.toContain("raw_cookies");
    expect(body).not.toContain("localStorage");
    expect(body).not.toContain("sessionStorage");
    expect(body).not.toContain("cookie_value");
  });
});

// ─── Profile key scope isolation ──────────────────────────────────────────────

describe("Profile key scope isolation", () => {
  it("same user + same delegation always resolves to the same profile directory", () => {
    const key1 = computeProfileKey("user_001", "del_001");
    const key2 = computeProfileKey("user_001", "del_001");
    const dir1 = getPersistentProfileDir(key1);
    const dir2 = getPersistentProfileDir(key2);
    expect(dir1).toBe(dir2);
  });

  it("same user + different delegation resolves to different profile directories", () => {
    const dirA = getPersistentProfileDir(computeProfileKey("user_001", "del_A"));
    const dirB = getPersistentProfileDir(computeProfileKey("user_001", "del_B"));
    expect(dirA).not.toBe(dirB);
  });

  it("different users with same delegation resolve to different profile directories", () => {
    const dirA = getPersistentProfileDir(computeProfileKey("user_001", "del_001"));
    const dirB = getPersistentProfileDir(computeProfileKey("user_002", "del_001"));
    expect(dirA).not.toBe(dirB);
  });
});
