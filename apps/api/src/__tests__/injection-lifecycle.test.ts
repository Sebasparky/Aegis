import { vi } from "vitest";

// Suppress disk writes.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock KMS — password resolution returns a deterministic value.
vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn().mockResolvedValue({
      provider: "local_dev",
      version: 1,
      algorithm: "aes-256-gcm",
      nonce_b64: "mock-nonce",
      ciphertext_b64: "mock-cipher",
      tag_b64: "mock-tag",
      aad_b64: "mock-aad",
      created_at: new Date().toISOString(),
    }),
    decryptSecret: vi.fn().mockResolvedValue("test-password-123"),
  })),
}));

vi.mock("../lib/kmsAudit.js", () => ({
  recordKmsAuditEvent: vi.fn(),
}));

// CDP mock — success/failure controlled per-test via cdpMock flag.
const cdpMock = { success: true as boolean, error: undefined as string | undefined };
vi.mock("../runtime/secretInjection.js", () => ({
  executeSecretInjectionViaCDP: vi.fn().mockImplementation(() =>
    Promise.resolve(cdpMock.success ? { success: true } : { success: false, error: cdpMock.error ?? "CDP_FAIL" }),
  ),
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
      provider: "local_dev",
      version: 1,
      algorithm: "aes-256-gcm",
      nonce_b64: "mock-nonce",
      ciphertext_b64: "mock-cipher",
      tag_b64: "mock-tag",
      aad_b64: "mock-aad",
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

// Mock signing so approve endpoint works without real EdDSA keys.
vi.mock("../lib/userApprovalReceiptSigning.js", async () => {
  const { createHash } = await import("crypto");

  function sortedReplacer(_k: string, v: unknown): unknown {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  }

  const TEST_JWS = "mock.jws.payload";
  const TEST_KEY_ID = "test-key-001";

  const buildSignedUserApprovalReceipt = vi.fn().mockImplementation(
    async (fields: Record<string, unknown>) => {
      const hash = createHash("sha256")
        .update(JSON.stringify({ receipt_json: fields }, sortedReplacer), "utf8")
        .digest("hex");
      return {
        ...fields,
        outcome: "pending",
        raw_secrets_in_receipt: false,
        raw_credentials_in_receipt: false,
        verification: {
          canonical_payload_hash: hash,
          jws: TEST_JWS,
          jws_present: true,
          signing_alg: "EdDSA",
          signed_at: new Date().toISOString(),
          signing_key_id: TEST_KEY_ID,
        },
      };
    },
  );

  return {
    buildSignedUserApprovalReceipt,
    verifyStoredUserApprovalReceipt: vi.fn().mockResolvedValue({ valid: true }),
    signUserApprovalReceiptJws: vi.fn().mockResolvedValue({ jws: TEST_JWS, signing_key_id: TEST_KEY_ID }),
    verifyUserApprovalReceiptJws: vi.fn().mockResolvedValue({ valid: true }),
    hashUserApprovalReceipt: vi.fn(),
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AgentDelegation, AegisVaultPass, CredentialUseAuthorization, SecretFieldInjection, SensitiveGrant } from "@aegis/types";
import {
  agentDelegations,
  aegisVaultPasses,
  collars,
  passes,
  encryptedSecretVault,
  credentialUseAuthorizations,
  secretFieldInjections,
  sensitiveGrants,
  userApprovalReceipts,
  MOCK_USER_ID,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { secretFieldInjectionRoutes } from "../routes/secret-field-injections.js";
import { buildSensitiveGrant } from "../lib/sensitiveGrants.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(secretFieldInjectionRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  agentDelegations.clear();
  aegisVaultPasses.clear();
  collars.clear();
  passes.clear();
  encryptedSecretVault.clear();
  credentialUseAuthorizations.clear();
  secretFieldInjections.clear();
  sensitiveGrants.clear();
  userApprovalReceipts.clear();
  cdpMock.success = true;
  cdpMock.error = undefined;
  vi.clearAllMocks();
});

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const DELEGATION_ID = "del_lc_001";
const PASS_ID = "pass_lc_001";
const DOMAIN = "github.com";
const AUTHORIZATION_ID = "auth_lc_001";
const GRANT_ID = "sg_lc_001";
const BEARER_TOKEN = "tok_lc_001";
const FAR_FUTURE = "2099-12-31T23:59:59.000Z";
const PAST_APPROVED = new Date(Date.now() - 31_000).toISOString(); // 31 seconds ago

function seedDelegation() {
  collars.set("col_lc", {
    id: "col_lc",
    user_id: MOCK_USER_ID,
    name: "Lifecycle Collar",
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

  passes.set(BEARER_TOKEN, {
    id: BEARER_TOKEN, token: BEARER_TOKEN, user_id: MOCK_USER_ID,
    agent_name: "LifecycleAgent", default_collar_id: "col_lc",
    status: "active", expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
  } as PassWithToken);

  const delegation: AgentDelegation = {
    id: DELEGATION_ID,
    agent_name: "LifecycleAgent",
    token_id: BEARER_TOKEN,
    default_collar_id: "col_lc",
    user_id: MOCK_USER_ID,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    status: "active",
  } as AgentDelegation;
  agentDelegations.set(DELEGATION_ID, delegation);
  return delegation;
}

function seedPass() {
  const pass: AegisVaultPass = {
    pass_id: PASS_ID,
    user_id: MOCK_USER_ID,
    domain: DOMAIN,
    username: "testuser",
    pass_label: "GitHub · testuser",
    pass_type: "login_password",
    secret_ref: "secret_lc_001",
    created_at: new Date().toISOString(),
  } as AegisVaultPass;
  aegisVaultPasses.set(PASS_ID, pass);
  encryptedSecretVault.set("secret_lc_001", {
    provider: "local_dev",
    version: 1,
    algorithm: "aes-256-gcm",
    nonce_b64: "mock-nonce",
    ciphertext_b64: "mock-cipher",
    tag_b64: "mock-tag",
    aad_b64: "mock-aad",
    created_at: new Date().toISOString(),
  } as any);
  return pass;
}

function seedAuth(overrides: Partial<CredentialUseAuthorization> = {}) {
  const auth: CredentialUseAuthorization = {
    authorization_id: AUTHORIZATION_ID,
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
    use_counts: { username: 0, password: 0 },
    used_field_kinds: [],
    created_at: new Date().toISOString(),
    expires_at: FAR_FUTURE,
    approved_at: new Date().toISOString(),
    ...overrides,
  };
  credentialUseAuthorizations.set(AUTHORIZATION_ID, auth);
  return auth;
}

function seedInjection(fieldKind: "username" | "password", overrides: Partial<SecretFieldInjection> = {}) {
  const inj: SecretFieldInjection = {
    injection_request_id: `inj_lc_${fieldKind}`,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    domain: DOMAIN,
    field_kind: fieldKind,
    pass_id: PASS_ID,
    page_url: `https://${DOMAIN}/login`,
    reason: "login",
    status: "approved",
    authorization_id: AUTHORIZATION_ID,
    raw_value_revealed_to_agent: false,
    created_at: new Date().toISOString(),
    expires_at: FAR_FUTURE,
    approved_at: new Date().toISOString(),
    ...overrides,
  };
  secretFieldInjections.set(inj.injection_request_id, inj);
  return inj;
}

function seedGrant(overrides: Partial<SensitiveGrant> = {}) {
  const grant = buildSensitiveGrant({
    grant_id: GRANT_ID,
    grant_type: "credential_injection",
    scope: {
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: DOMAIN,
      pass_id: PASS_ID,
      authorization_id: AUTHORIZATION_ID,
    },
    expires_at: FAR_FUTURE,
    linked_uar_id: "uar_lc_001",
    created_at: new Date().toISOString(),
    ...overrides,
  });
  sensitiveGrants.set(grant.grant_id, grant);
  return grant;
}

// ─── 1. executing_at timestamp ────────────────────────────────────────────────

describe("executing_at timestamp", () => {
  it("is absent on a newly-created approved injection before execute", () => {
    const inj = seedInjection("username");
    expect(inj.executing_at).toBeUndefined();
  });

  it("is set after successful execute", async () => {
    seedDelegation();
    seedPass();
    seedAuth();
    const inj = seedInjection("username");
    seedGrant();

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const stored = secretFieldInjections.get(inj.injection_request_id);
    expect(stored?.executing_at).toBeDefined();
    expect(new Date(stored!.executing_at!).getTime()).toBeGreaterThan(0);
  });

  it("is set even when CDP fill fails (injection transitioned through executing)", async () => {
    cdpMock.success = false;
    cdpMock.error = "CDP_TEST_FAIL";
    seedDelegation();
    seedPass();
    seedAuth();
    const inj = seedInjection("username");
    seedGrant();

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(500);
    const stored = secretFieldInjections.get(inj.injection_request_id);
    expect(stored?.executing_at).toBeDefined();
    expect(stored?.status).toBe("failed");
  });

  it("does not overwrite executing_at if already set", async () => {
    seedDelegation();
    seedPass();
    seedAuth();
    const originalExecutingAt = new Date(Date.now() - 5000).toISOString();
    const inj = seedInjection("username", { executing_at: originalExecutingAt });
    seedGrant();

    await server.inject({
      method: "POST",
      url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
      payload: {},
    });

    const stored = secretFieldInjections.get(inj.injection_request_id);
    expect(stored?.executing_at).toBe(originalExecutingAt);
  });
});

// ─── 2. Lifecycle log lines ───────────────────────────────────────────────────

describe("lifecycle log lines", () => {
  it("logs [InjectionLifecycle] injection_executing when execute is called", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      seedDelegation();
      seedPass();
      seedAuth();
      const inj = seedInjection("username");
      seedGrant();

      await server.inject({
        method: "POST",
        url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });

      const hit = spy.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("[InjectionLifecycle] injection_executing"));
      expect(hit).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs [InjectionLifecycle] injection_filled on successful CDP fill", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      seedDelegation();
      seedPass();
      seedAuth();
      const inj = seedInjection("username");
      seedGrant();

      await server.inject({
        method: "POST",
        url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });

      const hit = spy.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("[InjectionLifecycle] injection_filled"));
      expect(hit).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs [InjectionLifecycle] injection_failed on CDP fill failure", async () => {
    cdpMock.success = false;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      seedDelegation();
      seedPass();
      seedAuth();
      const inj = seedInjection("username");
      seedGrant();

      await server.inject({
        method: "POST",
        url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });

      const hit = spy.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("[InjectionLifecycle] injection_failed"));
      expect(hit).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs [AuthLifecycle] auth_approved when internal approve endpoint called", async () => {
    const auth = seedAuth({ status: "pending_approval", approved_at: undefined });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await server.inject({
        method: "POST",
        url: `/api/internal/credential-authorizations/${auth.authorization_id}/approve`,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      const hit = spy.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("[AuthLifecycle] auth_approved"));
      expect(hit).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs [AuthLifecycle] auth_fulfilled when both fields are filled", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      seedDelegation();
      seedPass();
      // Seed auth with username already used so the second fill triggers fulfillment
      seedAuth({ use_counts: { username: 1, password: 0 }, used_field_kinds: ["username"] });
      const inj = seedInjection("password");
      seedGrant();

      await server.inject({
        method: "POST",
        url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });

      const hit = spy.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("[AuthLifecycle] auth_fulfilled"));
      expect(hit).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("lifecycle logs never include pass_id", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      seedDelegation();
      seedPass();
      seedAuth();
      const inj = seedInjection("username");
      seedGrant();

      await server.inject({
        method: "POST",
        url: `/api/agent/v1/injections/${inj.injection_request_id}/execute`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
        payload: {},
      });

      const lifecycleLogs = spy.mock.calls.filter(([msg]) =>
        typeof msg === "string" && (msg.includes("[InjectionLifecycle]") || msg.includes("[AuthLifecycle]")),
      );
      expect(lifecycleLogs.length).toBeGreaterThan(0);
      for (const call of lifecycleLogs) {
        expect(JSON.stringify(call)).not.toContain(PASS_ID);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── 3. GET /api/internal/injection-lifecycle/:id ─────────────────────────────

describe("GET /api/internal/injection-lifecycle/:injectionId", () => {
  it("returns 404 for an unknown injection id", async () => {
    const res = await server.inject({ method: "GET", url: "/api/internal/injection-lifecycle/inj_unknown" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns lifecycle_stage 'pending_user_approval' for status pending_approval", async () => {
    seedAuth({ status: "pending_approval", approved_at: undefined });
    const inj = seedInjection("username", { status: "pending_approval", approved_at: undefined });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifecycle_stage).toBe("pending_user_approval");
  });

  it("returns lifecycle_stage 'ready_for_agent_execute' for status approved", async () => {
    seedAuth();
    const inj = seedInjection("username");

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifecycle_stage).toBe("ready_for_agent_execute");
  });

  it("returns lifecycle_stage 'executing' for status executing", async () => {
    seedAuth();
    const inj = seedInjection("username", { status: "executing", executing_at: new Date().toISOString() });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifecycle_stage).toBe("executing");
  });

  it("returns lifecycle_stage 'filled' for status filled", async () => {
    seedAuth();
    const inj = seedInjection("username", { status: "filled", filled_at: new Date().toISOString() });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifecycle_stage).toBe("filled");
  });

  it("returns lifecycle_stage 'failed' for status failed", async () => {
    seedAuth();
    const inj = seedInjection("username", { status: "failed", error: "CDP_FAIL" });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifecycle_stage).toBe("failed");
  });

  it("returns lifecycle_stage 'denied' for status denied", async () => {
    seedAuth();
    const inj = seedInjection("username", { status: "denied" });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifecycle_stage).toBe("denied");
  });

  it("returns lifecycle_stage 'expired_stale' for status expired", async () => {
    seedAuth();
    const inj = seedInjection("username", { status: "expired" });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifecycle_stage).toBe("expired_stale");
  });

  it("includes auth_summary when authorization_id is present", async () => {
    seedAuth();
    const inj = seedInjection("username");

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const { data } = res.json();
    expect(data.auth_summary).not.toBeNull();
    expect(data.auth_summary.authorization_id).toBe(AUTHORIZATION_ID);
    expect(data.auth_summary.status).toBe("approved");
    expect(Array.isArray(data.auth_summary.used_field_kinds)).toBe(true);
    expect(typeof data.auth_summary.remaining_uses).toBe("object");
    expect(data.auth_summary.expires_at).toBeDefined();
  });

  it("auth_summary does not include pass_id or pass_label", async () => {
    seedAuth();
    const inj = seedInjection("username");

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const authSummary = JSON.stringify(res.json().data.auth_summary);
    expect(authSummary).not.toContain("pass_id");
    expect(authSummary).not.toContain("pass_label");
    expect(authSummary).not.toContain("pass_username");
  });

  it("response never includes pass_id at top level", async () => {
    seedAuth();
    const inj = seedInjection("username");

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const body = JSON.stringify(res.json().data);
    expect(body).not.toContain(PASS_ID);
  });

  it("response never includes element_hint or browser_session_id", async () => {
    seedAuth();
    const inj = seedInjection("username", {
      element_hint: { label: "Username", selector_hint: "#user-input" },
      browser_session_id: "bs_secret_001",
    });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const body = JSON.stringify(res.json().data);
    expect(body).not.toContain("element_hint");
    expect(body).not.toContain("selector_hint");
    expect(body).not.toContain("browser_session_id");
  });

  it("elapsed.created_to_approved_ms is null for pending_approval injection", async () => {
    seedAuth({ status: "pending_approval", approved_at: undefined });
    const inj = seedInjection("username", { status: "pending_approval", approved_at: undefined });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.json().data.elapsed.created_to_approved_ms).toBeNull();
  });

  it("elapsed.created_to_approved_ms is a positive integer when approved_at is set", async () => {
    seedAuth();
    const createdAt = new Date(Date.now() - 5000).toISOString();
    const approvedAt = new Date(Date.now() - 2000).toISOString();
    const inj = seedInjection("username", { created_at: createdAt, approved_at: approvedAt });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const ms = res.json().data.elapsed.created_to_approved_ms;
    expect(ms).toBeGreaterThan(0);
    expect(Number.isInteger(ms)).toBe(true);
  });

  it("elapsed.approved_to_executing_ms is null when executing_at is absent", async () => {
    seedAuth();
    const inj = seedInjection("username", { status: "approved" });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.json().data.elapsed.approved_to_executing_ms).toBeNull();
  });

  it("elapsed.approved_to_executing_ms is correct when executing_at is set", async () => {
    seedAuth();
    const approvedAt = new Date(Date.now() - 4000).toISOString();
    const executingAt = new Date(Date.now() - 1000).toISOString();
    const inj = seedInjection("username", {
      status: "executing",
      approved_at: approvedAt,
      executing_at: executingAt,
    });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const ms = res.json().data.elapsed.approved_to_executing_ms;
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThan(5000);
  });

  it("elapsed.executing_to_filled_ms is correct when both executing_at and filled_at are set", async () => {
    seedAuth();
    const executingAt = new Date(Date.now() - 3000).toISOString();
    const filledAt = new Date(Date.now() - 1000).toISOString();
    const inj = seedInjection("username", {
      status: "filled",
      executing_at: executingAt,
      filled_at: filledAt,
    });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const ms = res.json().data.elapsed.executing_to_filled_ms;
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(4000);
  });

  it("elapsed.total_elapsed_ms is always present and positive", async () => {
    seedAuth();
    const inj = seedInjection("username");

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const ms = res.json().data.elapsed.total_elapsed_ms;
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(typeof ms).toBe("number");
  });
});

// ─── 4. Stale detection ───────────────────────────────────────────────────────

describe("stale detection", () => {
  it("is_stale false for a recently approved injection", async () => {
    seedAuth();
    const inj = seedInjection("username", { approved_at: new Date().toISOString() });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.json().data.stale.is_stale).toBe(false);
  });

  it("is_stale true and correct stale_reason when approved for over 30s without executing_at", async () => {
    seedAuth();
    const inj = seedInjection("username", { approved_at: PAST_APPROVED });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const stale = res.json().data.stale;
    expect(stale.is_stale).toBe(true);
    expect(stale.stale_reason).toBe("approved_but_not_executing_for_over_30s");
  });

  it("is_stale true when executing for over 60s without filled_at", async () => {
    seedAuth();
    const staleExecutingAt = new Date(Date.now() - 61_000).toISOString();
    const inj = seedInjection("username", {
      status: "executing",
      executing_at: staleExecutingAt,
    });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const stale = res.json().data.stale;
    expect(stale.is_stale).toBe(true);
    expect(stale.stale_reason).toBe("executing_but_not_filled_for_over_60s");
  });

  it("is_stale true for pending_approval expiring within 60s", async () => {
    seedAuth({ status: "pending_approval", approved_at: undefined });
    const soonExpires = new Date(Date.now() + 30_000).toISOString();
    const inj = seedInjection("username", {
      status: "pending_approval",
      approved_at: undefined,
      expires_at: soonExpires,
    });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const stale = res.json().data.stale;
    expect(stale.is_stale).toBe(true);
    expect(stale.stale_reason).toBe("pending_approval_expiring_within_60s");
  });

  it("is_stale false for a filled injection regardless of age", async () => {
    seedAuth();
    const ancientFilled = new Date(Date.now() - 3_600_000).toISOString();
    const inj = seedInjection("username", {
      status: "filled",
      approved_at: ancientFilled,
      executing_at: ancientFilled,
      filled_at: ancientFilled,
    });

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    expect(res.json().data.stale.is_stale).toBe(false);
  });

  it("expires_in_ms is null for terminal statuses (filled, denied, failed, expired)", async () => {
    for (const status of ["filled", "denied", "failed", "expired"] as const) {
      secretFieldInjections.clear();
      const inj: SecretFieldInjection = {
        injection_request_id: `inj_terminal_${status}`,
        user_id: MOCK_USER_ID,
        delegation_id: DELEGATION_ID,
        domain: DOMAIN,
        field_kind: "username",
        pass_id: PASS_ID,
        page_url: `https://${DOMAIN}/login`,
        reason: "login",
        status,
        authorization_id: AUTHORIZATION_ID,
        raw_value_revealed_to_agent: false,
        created_at: new Date().toISOString(),
        expires_at: FAR_FUTURE,
      };
      secretFieldInjections.set(inj.injection_request_id, inj);

      const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.stale.expires_in_ms).toBeNull();
    }
  });

  it("expires_in_ms is a positive number for non-terminal statuses", async () => {
    seedAuth();
    const inj = seedInjection("username");

    const res = await server.inject({ method: "GET", url: `/api/internal/injection-lifecycle/${inj.injection_request_id}` });
    const expiresInMs = res.json().data.stale.expires_in_ms;
    expect(expiresInMs).toBeGreaterThan(0);
  });
});

// ─── 5. GET /api/internal/injections list — executing_at field ────────────────

describe("GET /api/internal/injections list — executing_at field", () => {
  const EXECUTING_AT = "2026-05-28T17:13:22.950Z";
  const FILLED_AT = "2026-05-28T17:13:23.372Z";

  it("includes executing_at for filled injections", async () => {
    seedInjection("password", {
      status: "filled",
      executing_at: EXECUTING_AT,
      filled_at: FILLED_AT,
    });

    const res = await server.inject({ method: "GET", url: "/api/internal/injections?status=filled" });
    expect(res.statusCode).toBe(200);
    const item = res.json().data[0];
    expect(item.executing_at).toBe(EXECUTING_AT);
  });

  it("redactions still hold — no pass_id, raw value false, no browser_session_id", async () => {
    seedInjection("username", {
      status: "filled",
      executing_at: EXECUTING_AT,
      filled_at: FILLED_AT,
    });

    const res = await server.inject({ method: "GET", url: "/api/internal/injections?status=filled" });
    const item = res.json().data[0];
    expect(item.pass_id).toBeUndefined();
    expect(item.raw_value_revealed_to_agent).toBe(false);
    expect(item.browser_session_id).toBeUndefined();
  });
});
