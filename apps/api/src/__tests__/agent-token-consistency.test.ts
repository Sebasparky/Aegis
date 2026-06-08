/**
 * Checkout Profile Field Fill v1 — agent token consistency tests.
 *
 * Root cause of the IKEA checkout INVALID_TOKEN failure: the antigen-browser MCP server and the
 * aegis MCP server were configured with DIFFERENT delegation tokens, so profile-fill ran under a
 * different delegation than the one that owned the browser session.
 *
 * These tests pin the shared-auth contract: the SAME demo token (pass_demo_001) authenticates on
 * BOTH the runtime browser endpoint and the profile-field-fills endpoint, and invalid / revoked /
 * expired tokens fail closed identically on both. requireAgentToken is exercised, not weakened.
 */

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

const createMock = vi.hoisted(() => vi.fn());
const findReadyByDelegationMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/taskBrowserSessions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/taskBrowserSessions.js")>(
    "../runtime/taskBrowserSessions.js",
  );
  return {
    ...actual,
    createTaskBrowserSession: createMock,
    closeTaskBrowserSession: vi.fn(),
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

vi.mock("../runtime/secretInjection.js", () => ({ executeSecretInjectionViaCDP: vi.fn() }));

vi.mock("../runtime/authenticatedSessions.js", () => ({
  createAuthenticatedSession: vi.fn(),
  getAuthenticatedSessionHandle: vi.fn(),
  observeAuthenticatedSession: vi.fn(),
  navigateAuthenticatedSession: vi.fn(),
}));

vi.mock("../runtime/observationDryRun.js", () => ({ runObservationDryRun: vi.fn() }));

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

vi.mock("../lib/kmsAudit.js", () => ({ recordKmsAuditEvent: vi.fn() }));

vi.mock("../lib/collarPolicy.js", () => ({
  resolveEffectiveCollar: vi.fn().mockResolvedValue({ collar: null, source: "none" }),
}));

vi.mock("../lib/sensitiveGrants.js", () => ({ checkSensitiveGrant: vi.fn() }));

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

vi.mock("../routes/website-agent-safety.js", () => ({ computeWebsiteAgentSafetyProfile: vi.fn() }));
vi.mock("../routes/website-aegis-policy.js", () => ({ getWebsiteAegisPolicyForDomain: vi.fn() }));

// ─── Imports ──────────────────────────────────────────────────────────────────

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";

const MOCK_USER_ID = "user_001";
const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

// Seed keys are namespaced to this test to avoid clobbering other suites' shared-Map state.
function seedPassAndDelegation(opts: { passId: string; token: string; delegationId: string; status?: string; expires?: string }) {
  passes.set(opts.passId, {
    id: opts.passId,
    token: opts.token,
    user_id: MOCK_USER_ID,
    agent_name: "TokenConsistencyAgent",
    status: opts.status ?? "active",
    expires_at: opts.expires ?? FUTURE,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(opts.delegationId, {
    id: opts.delegationId,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TokenConsistencyAgent",
    channel: "api",
    status: opts.status === "revoked" ? "active" : "active",
    token_id: opts.passId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function makeSession(delegationId: string): TaskBrowserSession {
  return {
    browser_session_id: "tbsess_tokcon_001",
    user_id: MOCK_USER_ID,
    delegation_id: delegationId,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tokcon",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
}

const PASS_ID = "pass_tokcon_active";
const TOKEN = "tok_tokcon_active";
const DELEGATION_ID = "del_tokcon_active";

let server: FastifyInstance;

beforeAll(async () => {
  seedPassAndDelegation({ passId: PASS_ID, token: TOKEN, delegationId: DELEGATION_ID });
  seedPassAndDelegation({ passId: "pass_tokcon_revoked", token: "tok_tokcon_revoked", delegationId: "del_tokcon_revoked", status: "revoked" });
  seedPassAndDelegation({ passId: "pass_tokcon_expired", token: "tok_tokcon_expired", delegationId: "del_tokcon_expired", expires: PAST });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  for (const id of ["pass_tokcon_active", "pass_tokcon_revoked", "pass_tokcon_expired"]) passes.delete(id);
  for (const id of ["del_tokcon_active", "del_tokcon_revoked", "del_tokcon_expired"]) agentDelegations.delete(id);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  vi.clearAllMocks();
  findReadyByDelegationMock.mockReturnValue(undefined);
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const profileBody = {
  domain: "example.com",
  page_url: "https://example.com/checkout",
  reason: "checkout contact fields",
  requested_fields: [{ key: "email" }],
};

describe("token consistency — one delegation authenticates both Antigen surfaces", () => {
  it("the same token authenticates the runtime browser endpoint (201)", async () => {
    createMock.mockResolvedValueOnce({
      session: makeSession(DELEGATION_ID),
      user_message: "Started.",
      mode: "headless",
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: bearer(TOKEN),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.browser_runtime_id).toBe("tbsess_tokcon_001");
  });

  it("the same token authenticates profile-field-fills (not 401)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: bearer(TOKEN),
      payload: profileBody,
    });
    expect(res.statusCode).not.toBe(401);
    // No profile memory seeded → pending_user, which still proves auth passed.
    expect(res.json().data.status).toBe("pending_user");
  });

  it("the same token resolves a consistent identity on /me", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/me", headers: bearer(TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.delegation_id).toBe(DELEGATION_ID);
  });
});

describe("token consistency — invalid token fails closed identically on both surfaces", () => {
  it("runtime browser endpoint → 401 INVALID_TOKEN", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: bearer("tok_does_not_exist"),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });

  it("profile-field-fills → 401 INVALID_TOKEN", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: bearer("tok_does_not_exist"),
      payload: profileBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });

  it("missing bearer → 401 on profile-field-fills", async () => {
    const res = await server.inject({ method: "POST", url: "/api/agent/v1/profile-field-fills", payload: profileBody });
    expect(res.statusCode).toBe(401);
  });
});

describe("token consistency — revoked / expired behavior is unchanged", () => {
  it("revoked pass → 401 DELEGATION_REVOKED on profile-field-fills", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: bearer("tok_tokcon_revoked"),
      payload: profileBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_REVOKED");
  });

  it("expired pass → 401 DELEGATION_EXPIRED on profile-field-fills", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: bearer("tok_tokcon_expired"),
      payload: profileBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_EXPIRED");
  });

  it("revoked pass → 401 DELEGATION_REVOKED on runtime browser endpoint", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-endpoint",
      headers: bearer("tok_tokcon_revoked"),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_REVOKED");
  });
});
