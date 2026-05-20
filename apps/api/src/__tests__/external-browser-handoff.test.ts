import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Suppress disk writes.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock taskBrowserControl — no real CDP connections.
const MOCK_SNAPSHOT = vi.hoisted(() => ({ page_title: "Test Page", headings: [], links_sample: [], buttons_sample: [], forms_detected: 0 }));
vi.mock("../runtime/taskBrowserControl.js", () => ({
  connectAndNavigate: vi.fn().mockResolvedValue({ current_url: "https://github.com/login", snapshot: MOCK_SNAPSHOT }),
  connectAndObserve:  vi.fn().mockResolvedValue({ current_url: "https://github.com/login", snapshot: MOCK_SNAPSHOT }),
  connectAndClick:    vi.fn().mockResolvedValue({ current_url: "https://github.com/", snapshot: MOCK_SNAPSHOT }),
}));

// Mock CDP injection — controllable success/failure.
const cdpMock = { success: true as boolean, capturedCdpUrl: undefined as string | undefined };
vi.mock("../runtime/secretInjection.js", () => ({
  executeSecretInjectionViaCDP: vi.fn().mockImplementation((_inj: unknown, _val: string, cdpOverride?: string) => {
    cdpMock.capturedCdpUrl = cdpOverride;
    return Promise.resolve(cdpMock.success ? { success: true } : { success: false, error: "CDP_FAIL" });
  }),
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

// Stub transitive runtime deps.
vi.mock("../runtime/challengeInjection.js", () => ({
  challengeCodes: new Map(), executeChallengeInjectionViaCDP: vi.fn(),
}));
vi.mock("../runtime/emailChallengeResolver.js", () => ({
  resolutionCodes: new Map(), searchGmailForChallengeCode: vi.fn(), isEmailChallengeSupported: vi.fn().mockReturnValue(false),
}));
vi.mock("../runtime/authenticatedSessions.js", () => ({
  createAuthenticatedSession: vi.fn(), getAuthenticatedSessionHandle: vi.fn(),
  observeAuthenticatedSession: vi.fn(), navigateAuthenticatedSession: vi.fn(),
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
    storeVaultPass: vi.fn(), storeEncryptedSecret: vi.fn(),
  })),
}));
vi.mock("../lib/workspaceDomain.js", () => ({
  requireWorkspaceAccess: vi.fn(), checkWorkspacePermission: vi.fn(), emitWorkspaceAudit: vi.fn(),
  buildEffectivePermissionsMap: vi.fn(), checkTaskEligibility: vi.fn(), enrichTaskForManifest: vi.fn(),
  buildWorkQueue: vi.fn(), computeTaskReadiness: vi.fn(), buildWorkspaceArtifactNames: vi.fn(),
}));
vi.mock("../lib/delegationTrust.js", () => ({ computeDelegationTrustProfile: vi.fn() }));
vi.mock("../lib/loginDiagnostics.js", () => ({
  loginDiagnosticsStore: new Map(), classifyLoginOutcome: vi.fn().mockReturnValue(null), storeDiagnostic: vi.fn(),
}));
vi.mock("../store/index.js", async () => {
  const actual = await vi.importActual<typeof import("../store/index.js")>("../store/index.js");
  return actual;
});
vi.mock("../routes/agent-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/agent-api.js")>();
  return {
    ...actual,
    requireAgentToken: vi.fn().mockImplementation(async (req: any, reply: any) => {
      if (!req.headers?.authorization) {
        reply.status(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing token" } });
        return undefined;
      }
      return null; // overridden per-test via vi.mocked(requireAgentToken).mockResolvedValueOnce
    }),
  };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AgentDelegation, AegisVaultPass, TaskBrowserSession } from "@aegis/types";
import {
  agentDelegations, aegisVaultPasses, collars, passes,
  secretFieldInjections, credentialUseAuthorizations, sensitiveGrants, MOCK_USER_ID,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { requireAgentToken } from "../routes/agent-api.js";
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
  cdpMock.capturedCdpUrl = undefined;
  vi.clearAllMocks();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DELEGATION_ID = "del_handoff_001";
const BEARER_TOKEN   = "tok_handoff_001";
const SESSION_ID     = "tbs_handoff_001";
const PASS_ID        = "vp_handoff_001";
const DOMAIN         = "github.com";
const PAGE_URL       = "https://github.com/login";

function seedCollar(id = "col_handoff") {
  collars.set(id, {
    id, user_id: MOCK_USER_ID, name: "Handoff Test Collar", status: "active",
    allowed_actions: ["login", "credential_fill"],
    approval_required_actions: [], blocked_actions: [],
    spending_limits: { max_without_approval: 0, max_with_approval: 0, subscriptions_allowed: false },
    counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: false },
    session_limits: { max_duration_minutes: 60, max_active_sessions: 1 },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as any);
  return id;
}

function seedDelegation(id = DELEGATION_ID, token = BEARER_TOKEN) {
  const collarId = seedCollar(`col_${id}`);
  passes.set(token, {
    id: token, token, user_id: MOCK_USER_ID,
    agent_name: "HandoffAgent", default_collar_id: collarId,
    status: "active", expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
  } as PassWithToken);
  const delegation: AgentDelegation = {
    id, agent_name: "HandoffAgent", token_id: token,
    default_collar_id: collarId, user_id: MOCK_USER_ID,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    status: "active",
  } as AgentDelegation;
  agentDelegations.set(id, delegation);
  return delegation;
}

function seedReadySession(): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID, user_id: MOCK_USER_ID, delegation_id: DELEGATION_ID,
    status: "ready", cdp_url: "http://localhost:9225", cdp_port: 9225,
    user_data_dir: "/tmp/test-handoff", ephemeral: true, mode: "headless",
    debug_visible: false, created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  taskBrowserSessions.set(SESSION_ID, session);
  return session;
}

function seedVaultPass() {
  const vp: AegisVaultPass = {
    pass_id: PASS_ID, user_id: MOCK_USER_ID, domain: DOMAIN,
    username: "testuser", pass_label: "GitHub · testuser",
    pass_type: "login_password", secret_ref: "secret_001",
    created_at: new Date().toISOString(),
  } as unknown as AegisVaultPass;
  aegisVaultPasses.set(PASS_ID, vp);
  return vp;
}

function mockDelegation(delegation = seedDelegation()) {
  vi.mocked(requireAgentToken).mockResolvedValueOnce(delegation);
}

function injectPost(url: string, payload: unknown, token = BEARER_TOKEN) {
  return server.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
}

// ─── external_cdp_url validation in injection create ─────────────────────────

describe("POST /api/agent/v1/injections — external_cdp_url validation", () => {
  const baseBody = { domain: DOMAIN, field_kind: "username", page_url: PAGE_URL, reason: "login" };

  it("accepts http://localhost:<port>", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "http://localhost:9222" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // injection record should have external_cdp_url stored
    const inj = Array.from(secretFieldInjections.values()).at(-1)!;
    expect(inj.external_cdp_url).toBe("http://localhost:9222");
  });

  it("accepts http://127.0.0.1:<port>", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "http://127.0.0.1:9223" });
    expect(res.statusCode).toBe(200);
  });

  it("accepts http://[::1]:<port>", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "http://[::1]:9224" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects when both external_cdp_url and browser_session_id are provided", async () => {
    seedVaultPass();
    seedReadySession();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", {
      ...baseBody,
      external_cdp_url: "http://localhost:9222",
      browser_session_id: SESSION_ID,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("rejects https protocol with INVALID_CDP_PROTOCOL", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "https://localhost:9222" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CDP_PROTOCOL");
  });

  it("rejects non-http protocol (ws://) with INVALID_CDP_PROTOCOL", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "ws://localhost:9222" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CDP_PROTOCOL");
  });

  it("rejects remote IP with EXTERNAL_CDP_LOCALHOST_ONLY", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "http://192.168.1.10:9222" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("EXTERNAL_CDP_LOCALHOST_ONLY");
  });

  it("rejects domain hostname with EXTERNAL_CDP_LOCALHOST_ONLY", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "http://example.com:9222" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("EXTERNAL_CDP_LOCALHOST_ONLY");
  });

  it("rejects missing port with INVALID_CDP_PORT", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "http://localhost" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CDP_PORT");
  });

  it("rejects out-of-range port 80 with INVALID_CDP_PORT", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    // port 80 is below 1024
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "http://localhost:80" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CDP_PORT");
  });

  it("rejects unparseable URL with INVALID_CDP_URL", async () => {
    seedVaultPass();
    const del = seedDelegation();
    mockDelegation(del);
    const res = await injectPost("/api/agent/v1/injections", { ...baseBody, external_cdp_url: "not-a-url" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CDP_URL");
  });
});

// ─── CDP URL resolution priority in execute endpoint ─────────────────────────

describe("POST /api/agent/v1/injections/:id/execute — CDP URL priority", () => {
  function seedApprovedInjection(overrides: { browser_session_id?: string; external_cdp_url?: string } = {}) {
    const vp = seedVaultPass();
    const now = new Date();
    const auth = {
      authorization_id: "auth_exec_001",
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: DOMAIN,
      pass_id: PASS_ID,
      pass_label: vp.pass_label,
      pass_username: "testuser",
      allowed_field_kinds: ["username", "password"],
      max_uses_per_field: { username: 1, password: 1 },
      purpose: "login",
      status: "approved",
      raw_values_revealed_to_agent: false as const,
      persistence_allowed: false as const,
      browser_storage_allowed: false as const,
      website_save_allowed: false as const,
      approved_at: now.toISOString(),
      created_at: now.toISOString(),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      used_field_kinds: [] as string[],
      use_counts: { username: 0, password: 0 },
    } as any;
    credentialUseAuthorizations.set(auth.authorization_id, auth);

    const grant = {
      grant_id: "grant_exec_001",
      grant_type: "credential_injection",
      schema_version: "1.0",
      issuer: "aegis",
      scope: {
        user_id: MOCK_USER_ID,
        delegation_id: DELEGATION_ID,
        domain: DOMAIN,
        pass_id: PASS_ID,
        authorization_id: auth.authorization_id,
      },
      linked_uar_id: auth.authorization_id,
      status: "active",
      secret_exposed_to_agent: false,
      raw_credentials_in_grant: false,
      created_at: now.toISOString(),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    } as any;
    sensitiveGrants.set(grant.grant_id, grant);

    const inj = {
      injection_request_id: "inj_exec_001",
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: DOMAIN,
      field_kind: "username" as const,
      pass_id: PASS_ID,
      page_url: PAGE_URL,
      reason: "login",
      status: "approved" as const,
      authorization_id: auth.authorization_id,
      raw_value_revealed_to_agent: false as const,
      created_at: now.toISOString(),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      ...overrides,
    } as any;
    secretFieldInjections.set(inj.injection_request_id, inj);
    return inj;
  }

  it("uses external_cdp_url as cdpUrlOverride when browser_session_id is absent", async () => {
    seedDelegation();
    seedApprovedInjection({ external_cdp_url: "http://localhost:9222" });
    await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections/inj_exec_001/execute",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(vi.mocked(executeSecretInjectionViaCDP)).toHaveBeenCalled();
    expect(cdpMock.capturedCdpUrl).toBe("http://localhost:9222");
  });

  it("uses session cdp_url when browser_session_id is set (takes priority)", async () => {
    seedDelegation();
    seedReadySession(); // cdp_url = http://localhost:9225
    seedApprovedInjection({ browser_session_id: SESSION_ID });
    await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections/inj_exec_001/execute",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(cdpMock.capturedCdpUrl).toBe("http://localhost:9225");
  });

  it("falls through to undefined (env fallback) when neither browser_session_id nor external_cdp_url is set", async () => {
    seedDelegation();
    seedApprovedInjection();
    await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections/inj_exec_001/execute",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(cdpMock.capturedCdpUrl).toBeUndefined();
  });
});

// ─── Bridge mode label on navigate / observe / click ─────────────────────────

describe("Controlled Browser Bridge — agent_browser_mode label", () => {
  it("navigate response includes agent_browser_mode: 'controlled_browser_bridge'", async () => {
    const del = seedDelegation();
    mockDelegation(del);
    seedReadySession();
    vi.mocked(connectAndNavigate).mockResolvedValueOnce({ current_url: "https://github.com/", snapshot: MOCK_SNAPSHOT });
    const res = await injectPost(`/api/agent/v1/task-browser-sessions/${SESSION_ID}/navigate`, { url: "https://github.com/" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agent_browser_mode).toBe("controlled_browser_bridge");
  });

  it("observe response includes agent_browser_mode: 'controlled_browser_bridge'", async () => {
    const del = seedDelegation();
    mockDelegation(del);
    seedReadySession();
    vi.mocked(connectAndObserve).mockResolvedValueOnce({ current_url: "https://github.com/", snapshot: MOCK_SNAPSHOT });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/task-browser-sessions/${SESSION_ID}/observe`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agent_browser_mode).toBe("controlled_browser_bridge");
  });

  it("click response includes agent_browser_mode: 'controlled_browser_bridge'", async () => {
    const del = seedDelegation();
    mockDelegation(del);
    seedReadySession();
    vi.mocked(connectAndClick).mockResolvedValueOnce({ current_url: "https://github.com/", snapshot: MOCK_SNAPSHOT });
    const res = await injectPost(`/api/agent/v1/task-browser-sessions/${SESSION_ID}/click`, { selector: "button[type=submit]" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agent_browser_mode).toBe("controlled_browser_bridge");
  });
});
