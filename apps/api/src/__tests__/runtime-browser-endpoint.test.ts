import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

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

// ─── Mock task browser runtime ────────────────────────────────────────────────

const createMock = vi.hoisted(() => vi.fn());
const findReadyByDelegationMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/taskBrowserSessions.js", async () => {
  const { taskBrowserSessions } = await vi.importActual<typeof import("../runtime/taskBrowserSessions.js")>(
    "../runtime/taskBrowserSessions.js",
  );
  return {
    taskBrowserSessions,
    createTaskBrowserSession: createMock,
    closeTaskBrowserSession: vi.fn(),
    getTaskBrowserSession: vi.fn(),
    getTaskBrowserSessionForReuse: vi.fn(),
    findReadySessionByDelegationId: findReadyByDelegationMock,
    findChromeBinary: vi.fn().mockReturnValue("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    expireInactiveTaskBrowserSessions: vi.fn(),
    ALL_CDP_PORTS: [9222, 9223, 9224, 9225, 9226],
    getPortStatusForDiagnostics: vi.fn().mockReturnValue({ ports: [] }),
  };
});

vi.mock("../runtime/taskBrowserControl.js", () => ({
  connectAndNavigate: vi.fn(),
  connectAndObserve: vi.fn(),
  connectAndClick: vi.fn(),
}));

vi.mock("../runtime/secretInjection.js", () => ({
  executeSecretInjectionViaCDP: vi.fn(),
}));

vi.mock("../runtime/authenticatedSessions.js", () => ({
  createAuthenticatedSession: vi.fn(),
  getAuthenticatedSessionHandle: vi.fn(),
  observeAuthenticatedSession: vi.fn(),
  navigateAuthenticatedSession: vi.fn(),
}));

vi.mock("../runtime/observationDryRun.js", () => ({
  runObservationDryRun: vi.fn(),
}));

vi.mock("../runtime/challengeInjection.js", () => ({
  challengeCodes: new Map(),
  executeChallengeInjectionViaCDP: vi.fn(),
}));

vi.mock("../runtime/emailChallengeResolver.js", () => ({
  resolutionCodes: new Map(),
  searchGmailForChallengeCode: vi.fn(),
  isEmailChallengeSupported: vi.fn().mockReturnValue(false),
}));

vi.mock("../repositories/vaultRepository.js", () => ({
  getVaultRepository: vi.fn().mockReturnValue({
    getPass: vi.fn(),
    listPasses: vi.fn().mockResolvedValue([]),
    createPass: vi.fn(),
    updatePass: vi.fn(),
  }),
}));

vi.mock("../repositories/receiptRepository.js", () => ({
  getReceiptRepository: vi.fn().mockReturnValue({
    createReceipt: vi.fn(),
    getReceipt: vi.fn(),
    listReceipts: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn().mockReturnValue({ decryptSecret: vi.fn() }),
}));

vi.mock("../lib/kmsAudit.js", () => ({
  recordKmsAuditEvent: vi.fn(),
}));

vi.mock("../lib/collarPolicy.js", () => ({
  resolveEffectiveCollar: vi.fn().mockResolvedValue({ collar: null, source: "none" }),
}));

vi.mock("../lib/sensitiveGrants.js", () => ({
  checkSensitiveGrant: vi.fn(),
}));

vi.mock("../lib/workspaceDomain.js", () => ({
  requireWorkspaceAccess: vi.fn(),
  checkWorkspacePermission: vi.fn(),
  emitWorkspaceAudit: vi.fn(),
  buildEffectivePermissionsMap: vi.fn().mockReturnValue(new Map()),
  checkTaskEligibility: vi.fn(),
  enrichTaskForManifest: vi.fn(),
  buildWorkQueue: vi.fn().mockReturnValue([]),
  computeTaskReadiness: vi.fn(),
  buildWorkspaceArtifactNames: vi.fn().mockReturnValue([]),
}));

vi.mock("../routes/website-agent-safety.js", () => ({
  computeWebsiteAgentSafetyProfile: vi.fn(),
}));

vi.mock("../routes/website-aegis-policy.js", () => ({
  getWebsiteAegisPolicyForDomain: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BEARER = "Bearer tok_runtime_001";
const DELEGATION_ID = "del_runtime_001";
// Must match MOCK_USER_ID from store/index.ts — requireAgentToken filters by this value.
const MOCK_USER_ID = "user_001";

function makeFreshSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: "tbsess_rbe_001",
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_rbe_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  };
}

let server: FastifyInstance;

beforeAll(async () => {
  // Seed a delegation + pass so requireAgentToken resolves.
  // user_id must match MOCK_USER_ID ("user_001") — requireAgentToken filters on this value.
  // expires_at must be a future date — null would be parsed as epoch and fail the expiry check.
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_runtime_001", {
    id: "pass_runtime_001",
    token: "tok_runtime_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestRuntimeAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestRuntimeAgent",
    channel: "api",
    status: "active",
    token_id: "pass_runtime_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_runtime_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  vi.clearAllMocks();
  findReadyByDelegationMock.mockReturnValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/agent/v1/runtime/browser-endpoint", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await server.inject({ method: "POST", url: "/api/agent/v1/runtime/browser-endpoint" });
    expect(res.statusCode).toBe(401);
  });

  it("provisions a new session and returns browser_runtime_id and cdp_url", async () => {
    const session = makeFreshSession();
    createMock.mockResolvedValueOnce({
      session,
      reused_existing: undefined,
      port_auto_selected: undefined,
      requires_browser_reconnect: undefined,
      user_message: "Started.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.browser_runtime_id).toBe("tbsess_rbe_001");
    expect(body.data.cdp_url).toBe("http://localhost:9222");
    expect(body.data.status).toBe("ready");
    expect(body.data.runtime_mode).toBe("local_runtime_endpoint");
    expect(body.data.ephemeral).toBe(true);
    expect(body.data.reused_existing).toBe(false);
    expect(body.data.port_auto_selected).toBe(false);
    expect(body.data.expires_at).toBeDefined();
  });

  it("never exposes user_data_dir, PIDs, or raw credentials in the response", async () => {
    const session = makeFreshSession();
    createMock.mockResolvedValueOnce({ session, user_message: "ok", mode: "headless" });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain("user_data_dir");
    expect(JSON.stringify(body)).not.toContain("password");
    expect(JSON.stringify(body)).not.toContain("secret_ref");
  });

  it("enforces protection literals in every response", async () => {
    const session = makeFreshSession();
    createMock.mockResolvedValueOnce({ session, user_message: "ok", mode: "headless" });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    const body = res.json();
    expect(body.data.protection.raw_cookies_revealed_to_agent).toBe(false);
    expect(body.data.protection.raw_storage_revealed_to_agent).toBe(false);
  });

  it("reuses an existing ready session (reused_existing=true, status 200)", async () => {
    const existing = makeFreshSession();
    findReadyByDelegationMock.mockReturnValueOnce(existing);

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.reused_existing).toBe(true);
    expect(body.data.browser_runtime_id).toBe("tbsess_rbe_001");
    // createTaskBrowserSession must not have been called
    expect(createMock).not.toHaveBeenCalled();
  });

  it("sets port_auto_selected=true when Chrome lands on an alternate port", async () => {
    const session = makeFreshSession({ browser_session_id: "tbsess_alt", cdp_url: "http://localhost:9223", cdp_port: 9223 });
    createMock.mockResolvedValueOnce({
      session,
      port_auto_selected: true,
      requires_browser_reconnect: true,
      user_message: "Alt port.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.port_auto_selected).toBe(true);
    expect(body.data.cdp_url).toBe("http://localhost:9223");
  });

  it("returns 503 NO_PORTS_AVAILABLE when all ports are exhausted", async () => {
    const err = Object.assign(new Error("All ports occupied."), { code: "NO_PORTS_AVAILABLE" });
    createMock.mockRejectedValueOnce(err);

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe("NO_PORTS_AVAILABLE");
  });

  it("returns 503 CHROME_NOT_FOUND when Chrome is not installed", async () => {
    const err = Object.assign(new Error("Chrome not found."), { code: "CHROME_NOT_FOUND" });
    createMock.mockRejectedValueOnce(err);

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe("CHROME_NOT_FOUND");
  });

  it("creates session with runtime_mode: local_runtime_endpoint", async () => {
    const session = makeFreshSession();
    createMock.mockResolvedValueOnce({ session, user_message: "ok", mode: "headless" });

    await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtime_mode: "local_runtime_endpoint" }),
    );
  });
});
