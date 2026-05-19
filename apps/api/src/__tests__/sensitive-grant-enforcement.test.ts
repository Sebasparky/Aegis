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

// Mock KMS audit — we don't want real audit side effects.
vi.mock("../lib/kmsAudit.js", () => ({
  recordKmsAuditEvent: vi.fn(),
}));

// Mock CDP injection so tests don't need a real browser. cdpMock.success controls the outcome.
const cdpMock = { success: true as boolean, error: undefined as string | undefined };
vi.mock("../runtime/secretInjection.js", () => ({
  executeSecretInjectionViaCDP: vi.fn().mockImplementation(() =>
    Promise.resolve(cdpMock.success ? { success: true } : { success: false, error: cdpMock.error ?? "CDP_FAIL" }),
  ),
}));

// Stub email/challenge resolvers used transitively by agentApiRoutes.
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
vi.mock("./website-agent-safety.js", () => ({ computeWebsiteAgentSafetyProfile: vi.fn() }), { virtual: true });
vi.mock("./website-aegis-policy.js", () => ({ getWebsiteAegisPolicyForDomain: vi.fn() }), { virtual: true });
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

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AgentDelegation, AegisVaultPass, CredentialUseAuthorization, SecretFieldInjection, SensitiveGrant } from "@aegis/types";
import {
  agentDelegations,
  aegisVaultPasses,
  collars,
  encryptedSecretVault,
  credentialUseAuthorizations,
  secretFieldInjections,
  sensitiveGrants,
  MOCK_USER_ID,
} from "../store/index.js";
import { agentApiRoutes } from "../routes/agent-api.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  agentDelegations.clear();
  aegisVaultPasses.clear();
  collars.clear();
  encryptedSecretVault.clear();
  credentialUseAuthorizations.clear();
  secretFieldInjections.clear();
  sensitiveGrants.clear();
  cdpMock.success = true;
  cdpMock.error = undefined;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DELEGATION_ID = "del_test_001";
const PASS_ID = "pass_test_001";
const DOMAIN = "github.com";
const AUTHORIZATION_ID = "auth_test_001";
const GRANT_ID = "sg_test_001";
const BEARER_TOKEN = "tok_test_001";

function seedDelegation() {
  // Seed an active collar so requireActiveCollar passes for injection tests
  collars.set("col_test", {
    id: "col_test",
    user_id: MOCK_USER_ID,
    name: "Test Collar",
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

  const delegation: AgentDelegation = {
    id: DELEGATION_ID,
    agent_name: "TestAgent",
    token_id: BEARER_TOKEN,
    default_collar_id: "col_test",
    user_id: MOCK_USER_ID,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    status: "active",
  } as AgentDelegation;
  agentDelegations.set(BEARER_TOKEN, delegation);
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
    secret_ref: "secret_test_001",
    created_at: new Date().toISOString(),
  } as AegisVaultPass;
  aegisVaultPasses.set(PASS_ID, pass);
  encryptedSecretVault.set("secret_test_001", {
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

function seedAuth(opts: { fieldKinds?: Array<"username" | "password"> } = {}) {
  const fieldKinds = opts.fieldKinds ?? ["username", "password"];
  const auth: CredentialUseAuthorization = {
    authorization_id: AUTHORIZATION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    domain: DOMAIN,
    pass_id: PASS_ID,
    pass_label: "GitHub · testuser",
    pass_username: "testuser",
    allowed_field_kinds: fieldKinds,
    max_uses_per_field: Object.fromEntries(fieldKinds.map((k) => [k, 1])) as { username?: number; password?: number },
    purpose: "login",
    status: "approved",
    raw_values_revealed_to_agent: false,
    persistence_allowed: false,
    browser_storage_allowed: false,
    website_save_allowed: false,
    use_counts: { username: 0, password: 0 },
    used_field_kinds: [],
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    approved_at: new Date().toISOString(),
  };
  credentialUseAuthorizations.set(AUTHORIZATION_ID, auth);
  return auth;
}

function seedInjection(fieldKind: "username" | "password", injectionId = `inj_${fieldKind}_001`) {
  const injection: SecretFieldInjection = {
    injection_request_id: injectionId,
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
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    approved_at: new Date().toISOString(),
  };
  secretFieldInjections.set(injectionId, injection);
  return injection;
}

function seedGrant(overrides: Partial<SensitiveGrant> = {}): SensitiveGrant {
  const grant: SensitiveGrant = {
    grant_id: GRANT_ID,
    grant_type: "credential_injection",
    schema_version: "1.0",
    issuer: "aegis",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    scope: {
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: DOMAIN,
      pass_id: PASS_ID,
      authorization_id: AUTHORIZATION_ID,
    },
    linked_uar_id: "uar_test_001",
    status: "active",
    secret_exposed_to_agent: false,
    raw_credentials_in_grant: false,
    ...overrides,
  };
  sensitiveGrants.set(grant.grant_id, grant);
  return grant;
}

function executeInjection(injectionId: string) {
  return server.inject({
    method: "POST",
    url: `/api/agent/v1/injections/${injectionId}/execute`,
    headers: { authorization: `Bearer ${BEARER_TOKEN}` },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SensitiveGrant enforcement at injection execute", () => {
  describe("multi-field authorization — grant lifecycle", () => {
    it("succeeds on username fill and leaves grant active (auth not yet fulfilled)", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["username", "password"] });
      seedInjection("username");
      const grant = seedGrant();

      const res = await executeInjection("inj_username_001");
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe("filled");

      // Grant must remain active — password not yet filled
      expect(grant.status).toBe("active");
      expect(grant.consumed_at).toBeUndefined();

      // Auth must NOT be fulfilled yet
      const auth = credentialUseAuthorizations.get(AUTHORIZATION_ID)!;
      expect(auth.status).toBe("approved");
    });

    it("consumes grant after password fill completes the authorization", async () => {
      seedDelegation();
      seedPass();
      const auth = seedAuth({ fieldKinds: ["username", "password"] });
      const grant = seedGrant();

      // Simulate username already filled: bump use_counts so only password remains
      auth.use_counts.username = 1;
      auth.used_field_kinds = ["username"];
      credentialUseAuthorizations.set(AUTHORIZATION_ID, auth);

      seedInjection("password");

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe("filled");

      // Auth must now be fulfilled
      const updatedAuth = credentialUseAuthorizations.get(AUTHORIZATION_ID)!;
      expect(updatedAuth.status).toBe("fulfilled");

      // Grant must be consumed
      expect(grant.status).toBe("consumed");
      expect(typeof grant.consumed_at).toBe("string");
    });

    it("returns SENSITIVE_GRANT_CONSUMED if grant is already consumed", async () => {
      seedDelegation();
      seedPass();
      const auth = seedAuth({ fieldKinds: ["username", "password"] });
      auth.use_counts.username = 1;
      auth.used_field_kinds = ["username"];
      credentialUseAuthorizations.set(AUTHORIZATION_ID, auth);

      seedGrant({ status: "consumed", consumed_at: new Date().toISOString() });
      seedInjection("password");

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SENSITIVE_GRANT_CONSUMED");
    });
  });

  describe("single-field authorization", () => {
    it("consumes grant immediately after the sole authorized field is filled", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["password"] });
      seedInjection("password");
      const grant = seedGrant();

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(200);

      const updatedAuth = credentialUseAuthorizations.get(AUTHORIZATION_ID)!;
      expect(updatedAuth.status).toBe("fulfilled");
      expect(grant.status).toBe("consumed");
      expect(typeof grant.consumed_at).toBe("string");
    });
  });

  describe("missing or invalid grant", () => {
    it("returns SENSITIVE_GRANT_REQUIRED when no grant exists", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["password"] });
      seedInjection("password");
      // No grant seeded

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("SENSITIVE_GRANT_REQUIRED");
    });

    it("returns SENSITIVE_GRANT_REQUIRED when grant has a different authorization_id", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["password"] });
      seedInjection("password");
      // Grant for a different authorization — same pass/domain/delegation, different auth
      seedGrant({ scope: {
        user_id: MOCK_USER_ID,
        delegation_id: DELEGATION_ID,
        domain: DOMAIN,
        pass_id: PASS_ID,
        authorization_id: "auth_OTHER_999",
      }});

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("SENSITIVE_GRANT_REQUIRED");
    });
  });

  describe("invalid grant statuses", () => {
    it("returns SENSITIVE_GRANT_EXPIRED for an expired grant", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["password"] });
      seedInjection("password");
      seedGrant({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("SENSITIVE_GRANT_EXPIRED");
    });

    it("returns SENSITIVE_GRANT_REVOKED for a revoked grant", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["password"] });
      seedInjection("password");
      seedGrant({ status: "revoked", revoked_at: new Date().toISOString() });

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("SENSITIVE_GRANT_REVOKED");
    });
  });

  describe("CDP failure — grant not consumed", () => {
    it("does not consume the grant when CDP fill fails", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["password"] });
      seedInjection("password");
      const grant = seedGrant();

      cdpMock.success = false;
      cdpMock.error = "Browser unreachable";

      const res = await executeInjection("inj_password_001");
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("CDP_FILL_FAILED");

      // Grant must remain active — secret was never delivered
      expect(grant.status).toBe("active");
      expect(grant.consumed_at).toBeUndefined();
    });
  });

  describe("error responses contain no secrets", () => {
    it("SENSITIVE_GRANT_CONSUMED response does not expose pass_id or secret_ref", async () => {
      seedDelegation();
      seedPass();
      seedAuth({ fieldKinds: ["password"] });
      seedInjection("password");
      seedGrant({ status: "consumed", consumed_at: new Date().toISOString() });

      const res = await executeInjection("inj_password_001");
      const body = res.json();
      expect(JSON.stringify(body)).not.toContain(PASS_ID);
      expect(JSON.stringify(body)).not.toContain("secret_test_001");
      expect(JSON.stringify(body)).not.toContain("test-password-123");
    });
  });
});
