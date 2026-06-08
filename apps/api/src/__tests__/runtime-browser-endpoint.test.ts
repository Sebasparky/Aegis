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
const closeMock = vi.hoisted(() => vi.fn());
const findReadyByDelegationMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/taskBrowserSessions.js", async () => {
  // Spread all real implementations so getTaskBrowserSession, setTaskBrowserSessionCurrentUrl,
  // getTaskBrowserSessionPointerState, and setTaskBrowserSessionPointerState work against the
  // real in-memory Map. Only override functions that need controlled behavior in tests.
  const actual = await vi.importActual<typeof import("../runtime/taskBrowserSessions.js")>(
    "../runtime/taskBrowserSessions.js",
  );
  return {
    ...actual,
    createTaskBrowserSession: createMock,
    closeTaskBrowserSession: closeMock,
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
import { agentApiRoutes, computeNavigationProxyPointerState } from "../routes/agent-api.js";
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
  closeMock.mockResolvedValue({});
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

  it("does NOT silently reuse a headless runtime when visible is requested — relaunches", async () => {
    const existingHeadless = makeFreshSession({ browser_session_id: "tbsess_headless", mode: "headless" });
    findReadyByDelegationMock.mockReturnValueOnce(existingHeadless);
    const fresh = makeFreshSession({ browser_session_id: "tbsess_visible", mode: "visible" });
    createMock.mockResolvedValueOnce({ session: fresh, user_message: "ok", mode: "visible" });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
      payload: { mode: "visible" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    // The headless runtime was closed and a visible one provisioned — not reused.
    expect(closeMock).toHaveBeenCalledWith("tbsess_headless", MOCK_USER_ID);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ debug_visible: true }));
    expect(body.data.reused_existing).toBe(false);
    expect(body.data.effective_mode).toBe("visible");
    expect(body.data.requested_mode).toBe("visible");
    expect(body.data.browser_runtime_id).toBe("tbsess_visible");
  });

  it("closes the stale runtime BEFORE provisioning the replacement (binding cleared first)", async () => {
    findReadyByDelegationMock.mockReturnValueOnce(makeFreshSession({ browser_session_id: "tbsess_headless", mode: "headless" }));
    createMock.mockResolvedValueOnce({ session: makeFreshSession({ mode: "visible" }), user_message: "ok", mode: "visible" });

    await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
      payload: { mode: "visible" },
    });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(closeMock.mock.invocationCallOrder[0]).toBeLessThan(createMock.mock.invocationCallOrder[0]);
  });

  it("MAY reuse when the requested mode matches the existing runtime's mode", async () => {
    findReadyByDelegationMock.mockReturnValueOnce(makeFreshSession({ mode: "headless" }));

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
      payload: { mode: "headless" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.reused_existing).toBe(true);
    expect(body.data.effective_mode).toBe("headless");
    expect(body.data.requested_mode).toBe("headless");
    expect(closeMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("an absent mode ({}, e.g. adapter reinit) never flips an existing visible session to headless", async () => {
    findReadyByDelegationMock.mockReturnValueOnce(makeFreshSession({ mode: "visible" }));

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
      // No mode field — "no preference", must reuse whatever exists.
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.reused_existing).toBe(true);
    expect(body.data.effective_mode).toBe("visible");
    expect(body.data.requested_mode).toBeUndefined();
    expect(closeMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("exposes effective mode + readiness metadata on a freshly provisioned runtime", async () => {
    const session = makeFreshSession({ mode: "visible" });
    createMock.mockResolvedValueOnce({ session, user_message: "ok", mode: "visible" });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: { authorization: BEARER },
      payload: { mode: "visible" },
    });

    const body = res.json();
    expect(body.data.effective_mode).toBe("visible");
    expect(body.data.requested_mode).toBe("visible");
    expect(body.data.session_ready).toBe(true);
    expect(body.data.browser_session_id).toBe("tbsess_rbe_001");
    expect(body.data.reused_existing).toBe(false);
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

// ─── POST /api/agent/v1/runtime/browser-navigation-state ─────────────────────

describe("POST /api/agent/v1/runtime/browser-navigation-state", () => {
  const NAV_URL = "/api/agent/v1/runtime/browser-navigation-state";
  const SESSION_ID = "tbsess_rbe_001";

  function seedSession(overrides: Partial<TaskBrowserSession> = {}) {
    const session = makeFreshSession(overrides);
    taskBrowserSessions.set(session.browser_session_id, session);
    return session;
  }

  it("returns 401 without a bearer token", async () => {
    const res = await server.inject({ method: "POST", url: NAV_URL });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 MISSING_FIELD when browser_runtime_id is absent", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { url: "https://example.com", action: "navigation_proxy" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_FIELD");
  });

  it("returns 400 MISSING_FIELD when url is absent", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "navigation_proxy" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_FIELD");
  });

  it("returns 400 INVALID_FIELD when action is not navigation_proxy", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://example.com", action: "other" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_FIELD");
  });

  it("returns 404 SESSION_NOT_FOUND for unknown browser_runtime_id", async () => {
    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: "unknown_id", url: "https://example.com", action: "navigation_proxy" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("persists pointer state and returns safe metadata — first call uses viewport_center", async () => {
    seedSession(); // no prior pointer_state
    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://www.ikea.com/us/en/", action: "navigation_proxy" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.pointer_state_persisted).toBe(true);
    expect(body.data.pointer_start_source).toBe("viewport_center");
    expect(body.data.pointer_action).toBe("navigation_proxy");
  });

  it("returns pointer_start_source=session when session already has initialized pointer state", async () => {
    const session = seedSession();
    // Pre-seed an initialized pointer state
    session.pointer_state = { x: 300, y: 250, initialized: true, updated_at: new Date().toISOString() };
    taskBrowserSessions.set(session.browser_session_id, session);

    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://www.ikea.com/us/en/", action: "navigation_proxy" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.pointer_start_source).toBe("session");
  });

  it("response never contains x, y, cdp_url, user_data_dir, pass_id, secret_ref, password, or coordinates", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://example.com", action: "navigation_proxy" },
    });
    const raw = JSON.stringify(res.json());
    const FORBIDDEN = ["cdp_url", "user_data_dir", "pass_id", "secret_ref", "password", "\"x\":", "\"y\":"];
    for (const f of FORBIDDEN) {
      expect(raw).not.toContain(f);
    }
  });

  it("updates current_url on the session after navigation", async () => {
    const session = seedSession();
    const targetUrl = "https://www.ikea.com/us/en/search/?q=desk+lamp";

    await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: targetUrl, action: "navigation_proxy" },
    });

    const updated = taskBrowserSessions.get(session.browser_session_id);
    expect(updated?.current_url).toBe(targetUrl);
  });

  it("persists pointer state as initialized after navigation", async () => {
    const session = seedSession();

    await server.inject({
      method: "POST", url: NAV_URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, url: "https://example.com", action: "navigation_proxy" },
    });

    const updated = taskBrowserSessions.get(session.browser_session_id);
    expect(updated?.pointer_state?.initialized).toBe(true);
    expect(updated?.pointer_state?.updated_at).toBeDefined();
  });
});

// ─── computeNavigationProxyPointerState unit tests ────────────────────────────

describe("computeNavigationProxyPointerState helper", () => {
  const VW = 1280;

  it("no existing state → pointer_start_source=viewport_center, x/y in safe upper-page bounds", () => {
    const result = computeNavigationProxyPointerState({
      url: "https://www.ikea.com/us/en/",
      sessionId: "sess_test_001",
      viewportWidth: VW,
    });
    expect(result.pointer_start_source).toBe("viewport_center");
    expect(result.x).toBeGreaterThanOrEqual(80);
    expect(result.x).toBeLessThanOrEqual(VW - 80);
    expect(result.y).toBeGreaterThanOrEqual(70);
    expect(result.y).toBeLessThanOrEqual(220);
  });

  it("existing initialized state → pointer_start_source=session, x/y in safe upper-page bounds", () => {
    const result = computeNavigationProxyPointerState({
      existingPointerState: { x: 300, y: 250, initialized: true },
      url: "https://www.ikea.com/us/en/",
      sessionId: "sess_test_001",
      viewportWidth: VW,
    });
    expect(result.pointer_start_source).toBe("session");
    expect(result.x).toBeGreaterThanOrEqual(80);
    expect(result.x).toBeLessThanOrEqual(VW - 80);
    expect(result.y).toBeGreaterThanOrEqual(70);
    expect(result.y).toBeLessThanOrEqual(220);
  });

  it("same url + sessionId produces identical x, y on repeated calls (deterministic)", () => {
    const params = { url: "https://github.com/login", sessionId: "sess_stable_001", viewportWidth: VW };
    const r1 = computeNavigationProxyPointerState(params);
    const r2 = computeNavigationProxyPointerState(params);
    expect(r1.x).toBe(r2.x);
    expect(r1.y).toBe(r2.y);
  });

  it("different urls with same session produce different x or y", () => {
    // Two URLs chosen to verify hash-based zone selection varies.
    const rIkea = computeNavigationProxyPointerState({ url: "https://www.ikea.com/us/en/", sessionId: "sess_diff_001", viewportWidth: VW });
    const rGithub = computeNavigationProxyPointerState({ url: "https://github.com/login", sessionId: "sess_diff_001", viewportWidth: VW });
    expect(rIkea.x !== rGithub.x || rIkea.y !== rGithub.y).toBe(true);
  });

  it("y is always in the upper-page range regardless of viewport height", () => {
    const result = computeNavigationProxyPointerState({ url: "https://example.com/path/to/page", sessionId: "sess_y_001", viewportWidth: 1024 });
    expect(result.y).toBeGreaterThanOrEqual(70);
    expect(result.y).toBeLessThanOrEqual(220);
  });

  it("x is clamped within safe margins for the given viewport width", () => {
    const result = computeNavigationProxyPointerState({ url: "https://example.com/", sessionId: "sess_clamp_001", viewportWidth: 800 });
    expect(result.x).toBeGreaterThanOrEqual(80);
    expect(result.x).toBeLessThanOrEqual(800 - 80);
  });
});
