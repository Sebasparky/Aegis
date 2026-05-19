import { vi } from "vitest";

// Suppress disk writes.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock taskBrowserControl — we don't want real CDP connections in tests.
const controlMock = {
  navigateError: null as null | { code: string; message: string },
  observeError: null as null | { code: string; message: string },
  clickError: null as null | { code: string; message: string },
};
const MOCK_SNAPSHOT = {
  page_title: "Test Page",
  headings: ["Welcome"],
  links_sample: [],
  buttons_sample: ["Submit"],
  forms_detected: 1,
};
vi.mock("../runtime/taskBrowserControl.js", () => ({
  connectAndNavigate: vi.fn().mockImplementation(() => {
    if (controlMock.navigateError) {
      const e = new Error(controlMock.navigateError.message) as Error & { code: string };
      e.code = controlMock.navigateError.code;
      return Promise.reject(e);
    }
    return Promise.resolve({ current_url: "https://example.com/after-nav", snapshot: MOCK_SNAPSHOT });
  }),
  connectAndObserve: vi.fn().mockImplementation(() => {
    if (controlMock.observeError) {
      const e = new Error(controlMock.observeError.message) as Error & { code: string };
      e.code = controlMock.observeError.code;
      return Promise.reject(e);
    }
    return Promise.resolve({ current_url: "https://example.com/current", snapshot: MOCK_SNAPSHOT });
  }),
  connectAndClick: vi.fn().mockImplementation(() => {
    if (controlMock.clickError) {
      const e = new Error(controlMock.clickError.message) as Error & { code: string };
      e.code = controlMock.clickError.code;
      return Promise.reject(e);
    }
    return Promise.resolve({ current_url: "https://example.com/after-click", snapshot: MOCK_SNAPSHOT });
  }),
}));

// Mock CDP injection.
const cdpMock = { success: true as boolean };
vi.mock("../runtime/secretInjection.js", () => ({
  executeSecretInjectionViaCDP: vi.fn().mockImplementation(() =>
    Promise.resolve(cdpMock.success ? { success: true } : { success: false, error: "CDP_FAIL" }),
  ),
}));

// Mock KMS — no real key material.
vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn().mockResolvedValue({
      provider: "local_dev", version: 1, algorithm: "aes-256-gcm",
      nonce_b64: "n", ciphertext_b64: "c", tag_b64: "t", aad_b64: "a",
      created_at: new Date().toISOString(),
    }),
    decryptSecret: vi.fn().mockResolvedValue("mock-password"),
  })),
}));
vi.mock("../lib/kmsAudit.js", () => ({ recordKmsAuditEvent: vi.fn() }));

// Stub transitive runtime dependencies.
vi.mock("../runtime/challengeInjection.js", () => ({
  challengeCodes: new Map(),
  executeChallengeInjectionViaCDP: vi.fn(),
}));
vi.mock("../runtime/emailChallengeResolver.js", () => ({
  resolutionCodes: new Map(),
  searchGmailForChallengeCode: vi.fn(),
  isEmailChallengeSupported: vi.fn().mockReturnValue(false),
}));
vi.mock("../runtime/authenticatedSessions.js", () => ({
  createAuthenticatedSession: vi.fn(),
  getAuthenticatedSessionHandle: vi.fn(),
  observeAuthenticatedSession: vi.fn(),
  navigateAuthenticatedSession: vi.fn(),
}));
vi.mock("../repositories/receiptRepository.js", () => ({
  getReceiptRepository: vi.fn(() => ({ createReceipt: vi.fn(), listReceipts: vi.fn().mockResolvedValue([]) })),
}));
vi.mock("../repositories/vaultRepository.js", () => ({
  getVaultRepository: vi.fn(() => ({
    getVaultPass: vi.fn().mockResolvedValue(null),
    getEncryptedSecret: vi.fn().mockResolvedValue({
      provider: "local_dev", version: 1, algorithm: "aes-256-gcm",
      nonce_b64: "n", ciphertext_b64: "c", tag_b64: "t", aad_b64: "a",
      created_at: new Date().toISOString(),
    }),
    storeVaultPass: vi.fn(),
    storeEncryptedSecret: vi.fn(),
  })),
}));
vi.mock("../lib/workspaceDomain.js", () => ({
  requireWorkspaceAccess: vi.fn(),
  checkWorkspacePermission: vi.fn(),
  emitWorkspaceAudit: vi.fn(),
  buildEffectivePermissionsMap: vi.fn(),
  checkTaskEligibility: vi.fn(),
  enrichTaskForManifest: vi.fn(),
  buildWorkQueue: vi.fn(),
  computeTaskReadiness: vi.fn(),
  buildWorkspaceArtifactNames: vi.fn(),
}));
vi.mock("../lib/delegationTrust.js", () => ({ computeDelegationTrustProfile: vi.fn() }));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AgentDelegation, AegisVaultPass, TaskBrowserSession } from "@aegis/types";
import {
  agentDelegations,
  aegisVaultPasses,
  collars,
  passes,
  secretFieldInjections,
  credentialUseAuthorizations,
  sensitiveGrants,
  MOCK_USER_ID,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { executeSecretInjectionViaCDP } from "../runtime/secretInjection.js";
import { connectAndNavigate, connectAndObserve, connectAndClick } from "../runtime/taskBrowserControl.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});
afterAll(async () => server.close());

beforeEach(() => {
  agentDelegations.clear();
  aegisVaultPasses.clear();
  collars.clear();
  passes.clear();
  secretFieldInjections.clear();
  credentialUseAuthorizations.clear();
  sensitiveGrants.clear();
  taskBrowserSessions.clear();
  cdpMock.success = true;
  controlMock.navigateError = null;
  controlMock.observeError = null;
  controlMock.clickError = null;
  vi.clearAllMocks();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DELEGATION_ID = "del_bridge_001";
const OTHER_DELEGATION_ID = "del_bridge_other";
const BEARER_TOKEN = "tok_bridge_001";
const OTHER_BEARER_TOKEN = "tok_bridge_other";
const SESSION_ID = "tbs_bridge_001";
const PASS_ID = "vp_bridge_001";
const DOMAIN = "github.com";

function seedCollar(collarId = "col_bridge") {
  collars.set(collarId, {
    id: collarId,
    user_id: MOCK_USER_ID,
    name: "Bridge Test Collar",
    status: "active",
    allowed_actions: ["login", "credential_fill"],
    approval_required_actions: [],
    blocked_actions: [],
    spending_limits: { max_without_approval: 0, max_with_approval: 0, subscriptions_allowed: false },
    counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: false },
    session_limits: { max_duration_minutes: 60, max_active_sessions: 1 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as any);
  return collarId;
}

function seedDelegation(id = DELEGATION_ID, token = BEARER_TOKEN) {
  const collarId = seedCollar(`col_${id}`);
  passes.set(token, {
    id: token, token, user_id: MOCK_USER_ID,
    agent_name: "BridgeAgent", default_collar_id: collarId,
    status: "active", expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
  } as PassWithToken);
  const delegation: AgentDelegation = {
    id, agent_name: "BridgeAgent", token_id: token,
    default_collar_id: collarId, user_id: MOCK_USER_ID,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    status: "active",
  } as AgentDelegation;
  agentDelegations.set(id, delegation);
  return delegation;
}

function seedReadySession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/test-session",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  };
  taskBrowserSessions.set(SESSION_ID, session);
  return session;
}

function seedVaultPass() {
  const pass: AegisVaultPass = {
    pass_id: PASS_ID,
    user_id: MOCK_USER_ID,
    domain: DOMAIN,
    username: "testuser",
    pass_label: "GitHub · testuser",
    pass_type: "login_password",
    secret_ref: "secret_001",
    created_at: new Date().toISOString(),
  } as unknown as AegisVaultPass;
  aegisVaultPasses.set(PASS_ID, pass);
  return pass;
}

// ─── Auth guards ──────────────────────────────────────────────────────────────

describe("auth guards — all three bridge endpoints", () => {
  it("navigate returns 401 without token", async () => {
    const res = await server.inject({ method: "POST", url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`, payload: { url: "https://example.com" } });
    expect(res.statusCode).toBe(401);
  });

  it("observe returns 401 without token", async () => {
    const res = await server.inject({ method: "GET", url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/observe` });
    expect(res.statusCode).toBe(401);
  });

  it("click returns 401 without token", async () => {
    const res = await server.inject({ method: "POST", url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`, payload: { selector: "button" } });
    expect(res.statusCode).toBe(401);
  });

  it("navigate returns 404 when session doesn't exist for this user", async () => {
    seedDelegation();
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/nonexistent/navigate`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { url: "https://example.com" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("navigate returns 403 when session belongs to a different delegation", async () => {
    seedDelegation();
    seedDelegation(OTHER_DELEGATION_ID, OTHER_BEARER_TOKEN);
    seedReadySession({ delegation_id: OTHER_DELEGATION_ID });
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { url: "https://example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("observe returns 403 when session belongs to a different delegation", async () => {
    seedDelegation();
    seedDelegation(OTHER_DELEGATION_ID, OTHER_BEARER_TOKEN);
    seedReadySession({ delegation_id: OTHER_DELEGATION_ID });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/observe`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("click returns 403 when session belongs to a different delegation", async () => {
    seedDelegation();
    seedDelegation(OTHER_DELEGATION_ID, OTHER_BEARER_TOKEN);
    seedReadySession({ delegation_id: OTHER_DELEGATION_ID });
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { selector: "button" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Status guard ─────────────────────────────────────────────────────────────

describe("status guard — session must be ready", () => {
  it.each(["closed", "starting", "expired", "failed"] as const)(
    "navigate returns 400 SESSION_NOT_READY when status=%s",
    async (status) => {
      seedDelegation();
      seedReadySession({ status });
      const res = await server.inject({
        method: "POST",
        url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { url: "https://example.com" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("SESSION_NOT_READY");
    },
  );

  it("navigate succeeds when status is ready", async () => {
    seedDelegation();
    seedReadySession();
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { url: "https://example.com" },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Navigate URL validation ──────────────────────────────────────────────────

describe("POST /api/agent/v1/task-browser-sessions/:id/navigate — URL validation", () => {
  beforeEach(() => {
    seedDelegation();
    seedReadySession();
  });

  it("missing url returns 400 MISSING_URL", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_URL");
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>"])(
    "rejects non-http/https URL: %s",
    async (url) => {
      const res = await server.inject({
        method: "POST",
        url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        payload: { url },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_PROTOCOL");
    },
  );

  it("accepts http:// URL", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { url: "http://example.com/path" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts https:// URL and returns safe snapshot", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { url: "https://github.com/login" },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.browser_session_id).toBe(SESSION_ID);
    expect(data.current_url).toBeTruthy();
    expect(data.snapshot).toMatchObject({ headings: expect.any(Array) });
    expect(data.raw_cookies_revealed_to_agent).toBe(false);
    expect(data.raw_storage_revealed_to_agent).toBe(false);
  });
});

// ─── Observe happy path ───────────────────────────────────────────────────────

describe("GET /api/agent/v1/task-browser-sessions/:id/observe", () => {
  it("returns safe snapshot of current page", async () => {
    seedDelegation();
    seedReadySession();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/observe`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.browser_session_id).toBe(SESSION_ID);
    expect(data.current_url).toBeTruthy();
    expect(data.snapshot).toBeTruthy();
    expect(data.raw_cookies_revealed_to_agent).toBe(false);
    expect(data.raw_storage_revealed_to_agent).toBe(false);
    expect(vi.mocked(connectAndObserve)).toHaveBeenCalledWith("http://localhost:9222");
  });
});

// ─── Snapshot safety assertions ───────────────────────────────────────────────

describe("snapshot safety — no sensitive fields in any bridge response", () => {
  const FORBIDDEN_KEYS = ["password", "cookie", "session_storage", "local_storage", "raw_value", "secret_ref"];

  async function getNavigateBody() {
    seedDelegation();
    seedReadySession();
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { url: "https://example.com" },
    });
    return JSON.stringify(res.json());
  }

  async function getObserveBody() {
    seedDelegation();
    seedReadySession();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/observe`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    return JSON.stringify(res.json());
  }

  async function getClickBody() {
    seedDelegation();
    seedReadySession();
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { selector: "button[type=submit]" },
    });
    return JSON.stringify(res.json());
  }

  for (const key of FORBIDDEN_KEYS) {
    it(`navigate response does not contain key "${key}"`, async () => {
      const body = await getNavigateBody();
      expect(body).not.toContain(`"${key}":`);
    });
    it(`observe response does not contain key "${key}"`, async () => {
      const body = await getObserveBody();
      expect(body).not.toContain(`"${key}":`);
    });
    it(`click response does not contain key "${key}"`, async () => {
      const body = await getClickBody();
      expect(body).not.toContain(`"${key}":`);
    });
  }
});

// ─── Click validation ─────────────────────────────────────────────────────────

describe("POST /api/agent/v1/task-browser-sessions/:id/click", () => {
  beforeEach(() => {
    seedDelegation();
    seedReadySession();
  });

  it("returns 400 MISSING_SELECTOR when selector is absent", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_SELECTOR");
  });

  it("returns 400 MISSING_SELECTOR when selector is empty string", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { selector: "  " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_SELECTOR");
  });

  it("returns 422 when SELECTOR_NOT_FOUND", async () => {
    controlMock.clickError = { code: "SELECTOR_NOT_FOUND", message: "Timeout 5000ms exceeded." };
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { selector: "button.does-not-exist" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("SELECTOR_NOT_FOUND");
  });

  it("returns 503 when CDP_CONNECT_FAILED", async () => {
    controlMock.clickError = { code: "CDP_CONNECT_FAILED", message: "connect ECONNREFUSED" };
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { selector: "button" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns clicked=true and safe snapshot on success", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { selector: "button[type=submit]", description: "Sign in button" },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.clicked).toBe(true);
    expect(data.browser_session_id).toBe(SESSION_ID);
    expect(data.raw_cookies_revealed_to_agent).toBe(false);
    expect(data.raw_storage_revealed_to_agent).toBe(false);
    expect(vi.mocked(connectAndClick)).toHaveBeenCalledWith("http://localhost:9222", "button[type=submit]");
  });
});

// ─── browser_session_id in injection creation ─────────────────────────────────

describe("POST /api/agent/v1/injections — browser_session_id validation", () => {
  const BASE_BODY = {
    domain: DOMAIN,
    field_kind: "username",
    page_url: `https://${DOMAIN}/login`,
    reason: "Fill GitHub username",
  };

  it("returns 404 when browser_session_id doesn't exist", async () => {
    seedDelegation();
    seedVaultPass();
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { ...BASE_BODY, browser_session_id: "tbs_nonexistent" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("TASK_BROWSER_SESSION_NOT_FOUND");
  });

  it("returns 403 when browser_session_id belongs to a different delegation", async () => {
    seedDelegation();
    seedDelegation(OTHER_DELEGATION_ID, OTHER_BEARER_TOKEN);
    seedVaultPass();
    seedReadySession({ delegation_id: OTHER_DELEGATION_ID });
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { ...BASE_BODY, browser_session_id: SESSION_ID },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TASK_BROWSER_SESSION_FORBIDDEN");
  });

  it("returns 400 when browser_session_id session is closed", async () => {
    seedDelegation();
    seedVaultPass();
    seedReadySession({ status: "closed" });
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { ...BASE_BODY, browser_session_id: SESSION_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("TASK_BROWSER_SESSION_NOT_READY");
  });

  it("stores browser_session_id on injection record when valid", async () => {
    seedDelegation();
    seedVaultPass();
    seedReadySession();
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: { ...BASE_BODY, browser_session_id: SESSION_ID },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.injection_request_id).toBeTruthy();
    expect(data.raw_value_revealed_to_agent).toBe(false);
    // browser_session_id is internal — not in agent-facing response
    // but it must be stored on the injection record
    const stored = secretFieldInjections.get(data.injection_request_id);
    expect(stored?.browser_session_id).toBe(SESSION_ID);
  });

  it("injection without browser_session_id works and stored record has no browser_session_id", async () => {
    seedDelegation();
    seedVaultPass();
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: BASE_BODY,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const stored = secretFieldInjections.get(data.injection_request_id);
    expect(stored?.browser_session_id).toBeUndefined();
  });
});

// ─── CDP URL resolution in injection execute ──────────────────────────────────

describe("POST /api/agent/v1/injections/:id/execute — CDP URL resolution", () => {
  function seedApprovedInjection(overrides: Partial<{ browser_session_id: string }> = {}) {
    const authId = "auth_bridge_001";
    const grantId = "sg_bridge_001";
    const injId = "inj_bridge_001";

    credentialUseAuthorizations.set(authId, {
      authorization_id: authId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: DOMAIN,
      pass_id: PASS_ID,
      pass_label: "GitHub · testuser",
      pass_username: "testuser",
      allowed_field_kinds: ["username", "password"],
      max_uses_per_field: { username: 1, password: 1 },
      purpose: "login",
      status: "approved",
      raw_values_revealed_to_agent: false,
      persistence_allowed: false,
      browser_storage_allowed: false,
      website_save_allowed: false,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      approved_at: new Date().toISOString(),
      used_field_kinds: [],
      use_counts: { username: 0, password: 0 },
    } as any);

    sensitiveGrants.set(grantId, {
      grant_id: grantId,
      grant_type: "credential_injection",
      schema_version: "1.0",
      issuer: "aegis",
      scope: {
        user_id: MOCK_USER_ID,
        delegation_id: DELEGATION_ID,
        domain: DOMAIN,
        pass_id: PASS_ID,
        authorization_id: authId,
      },
      linked_uar_id: authId,
      status: "active",
      secret_exposed_to_agent: false,
      raw_credentials_in_grant: false,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    } as any);

    const injection = {
      injection_request_id: injId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: DOMAIN,
      field_kind: "username" as const,
      pass_id: PASS_ID,
      page_url: `https://${DOMAIN}/login`,
      reason: "test",
      status: "approved" as const,
      authorization_id: authId,
      raw_value_revealed_to_agent: false as const,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      ...overrides,
    };
    secretFieldInjections.set(injId, injection as any);
    return injId;
  }

  it("injection without browser_session_id calls executeSecretInjectionViaCDP with undefined cdpUrlOverride (env fallback)", async () => {
    seedDelegation();
    seedVaultPass();
    const injId = seedApprovedInjection();

    await server.inject({
      method: "POST",
      url: `/api/agent/v1/injections/${injId}/execute`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(vi.mocked(executeSecretInjectionViaCDP)).toHaveBeenCalledWith(
      expect.objectContaining({ injection_request_id: injId }),
      expect.any(String),
      undefined,
    );
  });

  it("injection with valid browser_session_id calls executeSecretInjectionViaCDP with session's cdp_url", async () => {
    seedDelegation();
    seedVaultPass();
    seedReadySession();
    const injId = seedApprovedInjection({ browser_session_id: SESSION_ID });

    await server.inject({
      method: "POST",
      url: `/api/agent/v1/injections/${injId}/execute`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(vi.mocked(executeSecretInjectionViaCDP)).toHaveBeenCalledWith(
      expect.objectContaining({ injection_request_id: injId }),
      expect.any(String),
      "http://localhost:9222",
    );
  });

  it("injection with expired browser_session_id at execute time falls back gracefully (undefined override)", async () => {
    seedDelegation();
    seedVaultPass();
    seedReadySession({ status: "expired" });
    const injId = seedApprovedInjection({ browser_session_id: SESSION_ID });

    await server.inject({
      method: "POST",
      url: `/api/agent/v1/injections/${injId}/execute`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    // Session is expired so cdpUrl falls back to undefined (env var path)
    expect(vi.mocked(executeSecretInjectionViaCDP)).toHaveBeenCalledWith(
      expect.objectContaining({ injection_request_id: injId }),
      expect.any(String),
      undefined,
    );
  });

  it("raw_value_revealed_to_agent remains false in response", async () => {
    seedDelegation();
    seedVaultPass();
    const injId = seedApprovedInjection();
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/injections/${injId}/execute`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("mock-password");
    expect(bodyStr).not.toContain("test-password");
    expect(body.data?.raw_value_revealed_to_agent).toBe(false);
  });
});
