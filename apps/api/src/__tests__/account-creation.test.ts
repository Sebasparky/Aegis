/**
 * Account Access Resolution v1 tests.
 *
 * Verifies:
 * 1.  Vault lookup hit: credential_available response when vault pass exists for domain.
 * 2.  No credential creates pending_user request.
 * 3.  Domain mismatch guard: page_url hostname must match domain.
 * 4.  Lazy expiry: expired requests return status "expired" at GET time.
 * 5.  Approve generates credential and stores in vault; vault_pass_id never in response.
 * 6.  After approval, agent polling returns pass_id (safe metadata).
 * 7.  Deny transitions to denied.
 * 8.  Complete handoff: authenticated and signup_failed outcomes.
 * 9.  Safe flags present in all responses: raw_password_revealed_to_agent: false, otp_revealed_to_agent: false.
 * 10. Internal list never exposes vault_pass_id or resolved email.
 */

import { vi } from "vitest";

// ─── Mocks (hoisted before all imports) ───────────────────────────────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

const mockEncryptedBlob = {
  provider: "local_dev" as const,
  version: 1 as const,
  algorithm: "aes-256-gcm" as const,
  nonce_b64: "mock-nonce-b64",
  ciphertext_b64: "mock-ciphertext-b64",
  tag_b64: "mock-tag-b64",
  aad_b64: "mock-aad-b64",
  created_at: new Date().toISOString(),
};

vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn().mockResolvedValue(mockEncryptedBlob),
    decryptSecret: vi.fn().mockResolvedValue("test-user@example.com"),
  })),
}));

vi.mock("../lib/kmsAudit.js", () => ({ recordKmsAuditEvent: vi.fn() }));

vi.mock("../runtime/profileFieldFill.js", () => ({
  executeProfileFieldFillViaCDP: vi.fn().mockResolvedValue([]),
  validateProfileFillSelector: vi.fn().mockReturnValue({ valid: true }),
}));
vi.mock("../runtime/paymentCardFill.js", () => ({
  executePaymentCardFillViaCDP: vi.fn(),
  validateCardFillSelector: vi.fn().mockReturnValue({ valid: true }),
}));
vi.mock("../runtime/secretInjection.js", () => ({ executeSecretInjectionViaCDP: vi.fn() }));
vi.mock("../runtime/challengeInjection.js", () => ({ challengeCodes: new Map(), executeChallengeInjectionViaCDP: vi.fn() }));
vi.mock("../runtime/emailChallengeResolver.js", () => ({ resolutionCodes: new Map(), searchGmailForChallengeCode: vi.fn(), isEmailChallengeSupported: vi.fn().mockReturnValue(false) }));
vi.mock("../runtime/authenticatedSessions.js", () => ({ createAuthenticatedSession: vi.fn(), getAuthenticatedSessionHandle: vi.fn(), observeAuthenticatedSession: vi.fn(), navigateAuthenticatedSession: vi.fn() }));
vi.mock("../repositories/receiptRepository.js", () => ({ getReceiptRepository: vi.fn(() => ({ createReceipt: vi.fn(), listReceipts: vi.fn().mockResolvedValue([]) })) }));
vi.mock("../repositories/vaultRepository.js", () => ({
  getVaultRepository: vi.fn(() => ({
    getVaultPass: vi.fn().mockResolvedValue(null),
    getEncryptedSecret: vi.fn().mockResolvedValue(mockEncryptedBlob),
    createVaultPass: vi.fn().mockResolvedValue(undefined),
    storeVaultPass: vi.fn(),
    storeEncryptedSecret: vi.fn(),
  })),
}));
vi.mock("../routes/website-agent-safety.js", () => ({ computeWebsiteAgentSafetyProfile: vi.fn() }));
vi.mock("../routes/website-aegis-policy.js", () => ({ getWebsiteAegisPolicyForDomain: vi.fn() }));
vi.mock("../lib/workspaceDomain.js", () => ({
  requireWorkspaceAccess: vi.fn(), checkWorkspacePermission: vi.fn(), emitWorkspaceAudit: vi.fn(),
  buildEffectivePermissionsMap: vi.fn(), checkTaskEligibility: vi.fn(), enrichTaskForManifest: vi.fn(),
  buildWorkQueue: vi.fn(), computeTaskReadiness: vi.fn(), buildWorkspaceArtifactNames: vi.fn(),
}));
vi.mock("../lib/delegationTrust.js", () => ({ computeDelegationTrustProfile: vi.fn() }));
vi.mock("../lib/loginDiagnostics.js", () => ({ classifyLoginOutcome: vi.fn(), storeDiagnostic: vi.fn() }));
vi.mock("../runtime/credentialStepHandoff.js", () => ({ performSubmitAndWait: vi.fn(), SUBMIT_BLOCKLIST: new Set() }));
vi.mock("../runtime/observationDryRun.js", () => ({ runObservationDryRun: vi.fn() }));
vi.mock("../runtime/purchaseConfirmationHandoff.js", () => ({ executePurchaseConfirmation: vi.fn() }));
vi.mock("../runtime/taskBrowserSessions.js", () => ({
  getTaskBrowserSessionForReuse: vi.fn().mockReturnValue(null),
  getTaskBrowserSession: vi.fn().mockReturnValue(null),
  createTaskBrowserSession: vi.fn(),
  findReadySessionByDelegationId: vi.fn().mockReturnValue(null),
  taskBrowserSessions: new Map(),
}));
vi.mock("../runtime/taskBrowserControl.js", () => ({ connectAndNavigate: vi.fn(), connectAndObserve: vi.fn(), connectAndClick: vi.fn() }));
vi.mock("../lib/userApprovalReceiptSigning.js", () => ({
  buildSignedUserApprovalReceipt: vi.fn().mockImplementation(async (fields: unknown) => ({
    ...(fields as object),
    verification: { canonical_payload_hash: "h", jws: "j", jws_present: true, signature_valid: true, signed_at: new Date().toISOString() },
  })),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AgentDelegation, AegisVaultPass, AccountCreationRequest } from "@aegis/types";
import {
  agentDelegations,
  collars,
  passes,
  aegisVaultPasses,
  encryptedSecretVault,
  privateProfileMemory,
  accountCreationRequests,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { accountCreationRoutes } from "../routes/account-creation.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(accountCreationRoutes);
  await server.ready();
});

afterAll(async () => { await server.close(); });

beforeEach(() => {
  agentDelegations.clear();
  collars.clear();
  passes.clear();
  aegisVaultPasses.clear();
  encryptedSecretVault.clear();
  privateProfileMemory.clear();
  accountCreationRequests.clear();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const BEARER_TOKEN = "test-agent-token-acr";
const DELEGATION_ID = "delg_test_acr";
const COLLAR_ID = "collar_test_acr";
const PASS_ID = "pass_test_acr";
const TEST_DOMAIN = "ikea.com";
const TEST_PAGE_URL = "https://www.ikea.com/us/en/profile/login/";

function seedDelegation() {
  collars.set(COLLAR_ID, {
    id: COLLAR_ID,
    user_id: MOCK_USER_ID,
    name: "Test Collar ACR",
    description: "Test collar for account creation request tests",
    status: "active",
    allowed_actions: ["browse", "login"],
    approval_required_actions: ["create_account"],
    blocked_actions: [],
    spending_limits: { max_without_approval: 0, max_with_approval: 0, subscriptions_allowed: false },
    counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: false },
    session_limits: { max_duration_minutes: 60, max_active_sessions: 5 },
    created_at: NOW,
    updated_at: NOW,
  });

  const delegation: AgentDelegation = {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test_acr",
    agent_name: "TestAgentACR",
    token_id: PASS_ID,
    default_collar_id: COLLAR_ID,
    channel: "api",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  agentDelegations.set(DELEGATION_ID, delegation);

  const pass: PassWithToken = {
    id: PASS_ID,
    user_id: MOCK_USER_ID,
    agent_name: "TestAgentACR",
    token: BEARER_TOKEN,
    status: "active",
    created_at: NOW,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  passes.set(PASS_ID, pass);
}

function seedVaultPass(domain: string): AegisVaultPass {
  const passId = newId("pass_vault");
  const vaultPass: AegisVaultPass = {
    pass_id: passId,
    user_id: MOCK_USER_ID,
    label: `${domain} credential`,
    kind: "login_password",
    domain,
    username: "testuser@example.com",
    secret_ref: `devvault://${passId}/password`,
    created_at: NOW,
    updated_at: NOW,
  };
  aegisVaultPasses.set(passId, vaultPass);
  encryptedSecretVault.set(passId, mockEncryptedBlob);
  return vaultPass;
}

function seedPrimaryEmailMemory() {
  const memId = "ppm_email_acr_test";
  encryptedSecretVault.set(memId, mockEncryptedBlob);
  privateProfileMemory.set(memId, {
    memory_id: memId,
    user_id: MOCK_USER_ID,
    field_kind: "email",
    value_ref: `ppvault://${memId}/value`,
    data_class: 2,
    sensitivity: "private",
    default_disclosure_mode: "fill_only",
    agent_visible_allowed: false,
    provenance: { source: "seeded", domain_at_creation: "aegisdemo.local" },
    created_at: NOW,
    updated_at: NOW,
    user_editable: true,
    uses: [],
  });
}

function agentHeaders() {
  return { authorization: `Bearer ${BEARER_TOKEN}` };
}

function assertSafeFlags(body: string) {
  const parsed = JSON.parse(body);
  const data = parsed.data ?? parsed;
  // The raw password must never appear anywhere in any response.
  expect(body).not.toContain("generatedPassword");
  // Safe flag assertions on the response data.
  if ("raw_password_revealed_to_agent" in data) {
    expect(data.raw_password_revealed_to_agent).toBe(false);
  }
  if ("otp_revealed_to_agent" in data) {
    expect(data.otp_revealed_to_agent).toBe(false);
  }
  expect(body).not.toContain("vault_pass_id");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/agent/v1/account-access-resolutions — vault lookup hit", () => {
  it("returns credential_available when vault pass exists for domain; no AccountCreationRequest created", async () => {
    seedDelegation();
    seedVaultPass(TEST_DOMAIN);

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Checkout requires login" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.resolution).toBe("credential_available");
    expect(body.data.pass_id).toBeTruthy();
    expect(body.data.raw_password_revealed_to_agent).toBe(false);
    expect(body.data.otp_revealed_to_agent).toBe(false);
    expect(body.data.next_action).toBe("request_secret_field_injection");
    // No account creation request should have been created.
    expect(accountCreationRequests.size).toBe(0);
    assertSafeFlags(res.body);
  });
});

describe("POST /api/agent/v1/account-access-resolutions — no credential creates pending_user request", () => {
  it("returns pending_user and creates an AccountCreationRequest when no vault pass exists", async () => {
    seedDelegation();
    // No vault pass for this domain.

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "IKEA checkout requires login", wall_type: "login" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.resolution).toBe("pending_user");
    expect(body.data.account_creation_request_id).toMatch(/^acreq_/);
    expect(body.data.raw_password_revealed_to_agent).toBe(false);
    expect(body.data.otp_revealed_to_agent).toBe(false);
    expect(body.data.expires_at).toBeTruthy();
    expect(accountCreationRequests.size).toBe(1);

    const stored = accountCreationRequests.get(body.data.account_creation_request_id)!;
    expect(stored.status).toBe("pending_user");
    expect(stored.domain).toBe(TEST_DOMAIN);
    // vault_pass_id must not be set yet.
    expect(stored.vault_pass_id).toBeUndefined();
    assertSafeFlags(res.body);
  });
});

describe("POST /api/agent/v1/account-access-resolutions — domain mismatch guard", () => {
  it("returns 400 DOMAIN_MISMATCH when page_url hostname differs from domain", async () => {
    seedDelegation();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        domain: "ikea.com",
        page_url: "https://evil.com/fake-ikea-login",
        reason: "Test mismatch",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DOMAIN_MISMATCH");
    expect(accountCreationRequests.size).toBe(0);
  });

  it("accepts a subdomain of the normalized domain", async () => {
    seedDelegation();
    seedVaultPass(TEST_DOMAIN);

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        domain: "ikea.com",
        page_url: "https://www.ikea.com/us/en/profile/login/",
        reason: "Subdomain test",
      },
    });

    // www.ikea.com is a subdomain of ikea.com — should succeed.
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/agent/v1/account-access-resolutions/:id — lazy expiry", () => {
  it("returns expired status for a request past its TTL", async () => {
    seedDelegation();

    const requestId = newId("acreq");
    const expiredRequest: AccountCreationRequest = {
      request_id: requestId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      signup_url: TEST_PAGE_URL,
      reason: "Test expiry",
      wall_type: "login",
      status: "pending_user",
      raw_password_revealed_to_agent: false,
      otp_revealed_to_agent: false,
      created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // already expired
    };
    accountCreationRequests.set(requestId, expiredRequest);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/account-access-resolutions/${requestId}`,
      headers: agentHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe("expired");
    // Verify the store was updated too.
    expect(accountCreationRequests.get(requestId)!.status).toBe("expired");
    assertSafeFlags(res.body);
  });
});

describe("POST /api/internal/account-creation-requests/:id/approve — credential generation", () => {
  it("stores credential in vault; vault_pass_id never returned; status becomes credential_generated", async () => {
    seedDelegation();
    seedPrimaryEmailMemory();

    // First create the request via the agent endpoint.
    const createRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Checkout test" },
    });
    expect(createRes.statusCode).toBe(200);
    const requestId = createRes.json().data.account_creation_request_id;

    const priorVaultSize = aegisVaultPasses.size;

    const approveRes = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });

    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();
    expect(approveBody.ok).toBe(true);
    expect(approveBody.data.status).toBe("credential_generated");

    // vault_pass_id must never appear in the response.
    expect(approveRes.body).not.toContain("vault_pass_id");
    // Raw password must never appear.
    assertSafeFlags(approveRes.body);

    // Confirm the internal record has vault_pass_id set (internal only).
    // The repository mock resolves successfully, so createAndStoreVaultPass returned ok:true.
    const stored = accountCreationRequests.get(requestId)!;
    expect(stored.vault_pass_id).toBeTruthy();
    expect(stored.vault_pass_id).toMatch(/^pass_vault_/);
  });

  it("returns 422 ACCOUNT_EMAIL_REQUIRED when no email memory exists and no inline email provided", async () => {
    seedDelegation();
    // No profile memory seeded.

    const createRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "No email test" },
    });
    const requestId = createRes.json().data.account_creation_request_id;

    const approveRes = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });

    expect(approveRes.statusCode).toBe(422);
    expect(approveRes.json().error.code).toBe("ACCOUNT_EMAIL_REQUIRED");
    // Vault must not have grown.
    expect(aegisVaultPasses.size).toBe(0);
  });
});

describe("GET /api/agent/v1/account-access-resolutions/:id — pass_id returned after approval", () => {
  it("returns pass_id when status is credential_generated; vault_pass_id absent", async () => {
    seedDelegation();
    seedPrimaryEmailMemory();

    const createRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Poll test" },
    });
    const requestId = createRes.json().data.account_creation_request_id;

    await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });

    const pollRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/account-access-resolutions/${requestId}`,
      headers: agentHeaders(),
    });

    expect(pollRes.statusCode).toBe(200);
    const body = pollRes.json();
    expect(body.data.status).toBe("credential_generated");
    expect(body.data.pass_id).toMatch(/^pass_vault_/);
    expect(body.data.next_action).toContain("request_secret_field_injection");
    // vault_pass_id must not appear.
    expect(pollRes.body).not.toContain("vault_pass_id");
    assertSafeFlags(pollRes.body);
  });
});

describe("POST /api/internal/account-creation-requests/:id/deny", () => {
  it("transitions request to denied; agent polling shows denied status", async () => {
    seedDelegation();

    const createRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Deny test" },
    });
    const requestId = createRes.json().data.account_creation_request_id;

    const denyRes = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/deny`,
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(denyRes.statusCode).toBe(200);
    expect(denyRes.json().data.status).toBe("denied");

    // Agent polling should also see denied.
    const pollRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/account-access-resolutions/${requestId}`,
      headers: agentHeaders(),
    });
    expect(pollRes.json().data.status).toBe("denied");
    expect(pollRes.json().data.next_action).toContain("Do not retry");
    assertSafeFlags(pollRes.body);

    // Vault must not have been created.
    expect(aegisVaultPasses.size).toBe(0);
  });
});

describe("POST /api/agent/v1/account-access-resolutions/:id/complete — handoff outcomes", () => {
  async function createAndApproveRequest() {
    seedPrimaryEmailMemory();
    const createRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Complete test" },
    });
    const requestId = createRes.json().data.account_creation_request_id;
    await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });
    return requestId;
  }

  it("sets status to completed when outcome is authenticated", async () => {
    seedDelegation();
    const requestId = await createAndApproveRequest();

    const completeRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/account-access-resolutions/${requestId}/complete`,
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { outcome: "authenticated" },
    });

    expect(completeRes.statusCode).toBe(200);
    const body = completeRes.json();
    expect(body.data.status).toBe("completed");
    expect(body.data.completed_at).toBeTruthy();
    expect(body.data.raw_password_revealed_to_agent).toBe(false);
    expect(body.data.otp_revealed_to_agent).toBe(false);
    assertSafeFlags(completeRes.body);
  });

  it("sets status to failed when outcome is signup_failed", async () => {
    seedDelegation();
    const requestId = await createAndApproveRequest();

    const completeRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/account-access-resolutions/${requestId}/complete`,
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { outcome: "signup_failed" },
    });

    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().data.status).toBe("failed");
    assertSafeFlags(completeRes.body);
  });

  it("returns 409 when trying to complete a request that is not credential_generated", async () => {
    seedDelegation();
    const createRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Bad complete test" },
    });
    const requestId = createRes.json().data.account_creation_request_id;

    const completeRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/account-access-resolutions/${requestId}/complete`,
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { outcome: "authenticated" },
    });

    expect(completeRes.statusCode).toBe(409);
    expect(completeRes.json().error.code).toBe("INVALID_STATE");
  });
});

describe("safe flags — present in all response shapes", () => {
  it("all agent-facing and internal endpoints include raw_password_revealed_to_agent: false", async () => {
    seedDelegation();
    seedPrimaryEmailMemory();

    // 1. Create request (credential_available path).
    seedVaultPass(TEST_DOMAIN);
    const availableRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Safe flag test" },
    });
    expect(availableRes.json().data.raw_password_revealed_to_agent).toBe(false);
    expect(availableRes.json().data.otp_revealed_to_agent).toBe(false);

    // Reset for pending_user path.
    aegisVaultPasses.clear();
    accountCreationRequests.clear();

    // 2. Create request (pending_user path).
    const pendingRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "Safe flag test 2" },
    });
    const requestId = pendingRes.json().data.account_creation_request_id;
    expect(pendingRes.json().data.raw_password_revealed_to_agent).toBe(false);

    // 3. Poll (GET).
    const pollRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/account-access-resolutions/${requestId}`,
      headers: agentHeaders(),
    });
    expect(pollRes.json().data.raw_password_revealed_to_agent).toBe(false);

    // 4. Approve.
    const approveRes = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });
    expect(approveRes.json().data.raw_password_revealed_to_agent).toBe(false);

    // 5. Complete.
    const completeRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/account-access-resolutions/${requestId}/complete`,
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { outcome: "authenticated" },
    });
    expect(completeRes.json().data.raw_password_revealed_to_agent).toBe(false);
    expect(completeRes.json().data.otp_revealed_to_agent).toBe(false);
  });
});

describe("email resolution — missing email / inline email / save-as-default", () => {
  async function createRequest(domain = TEST_DOMAIN) {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain, page_url: `https://www.${domain}/signup`, reason: "email resolution test" },
    });
    return res.json().data.account_creation_request_id as string;
  }

  it("T1: approve without saved email returns ACCOUNT_EMAIL_REQUIRED; no vault pass created", async () => {
    seedDelegation();
    const requestId = await createRequest();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ACCOUNT_EMAIL_REQUIRED");
    expect(aegisVaultPasses.size).toBe(0);
    // Request status must remain pending_user so the user can retry.
    expect(accountCreationRequests.get(requestId)!.status).toBe("pending_user");
  });

  it("T2: approve with inline email creates credential; response contains no email or password", async () => {
    seedDelegation();
    const requestId = await createRequest();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: {
        email_strategy: "primary_email",
        password_strategy: "aegis_generated",
        email: "inline@example.com",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe("credential_generated");
    expect(body.data.raw_password_revealed_to_agent).toBe(false);
    expect(body.data.otp_revealed_to_agent).toBe(false);
    expect(res.body).not.toContain("inline@example.com");
    expect(res.body).not.toContain("vault_pass_id");
    // Internal record must have vault_pass_id (repository mock creates it).
    expect(accountCreationRequests.get(requestId)!.vault_pass_id).toMatch(/^pass_vault_/);
  });

  it("T3: approve with inline email + save_as_default stores encrypted preference; subsequent list shows has_default_account_email: true", async () => {
    seedDelegation();
    const requestId = await createRequest();

    const approveRes = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: {
        email_strategy: "primary_email",
        password_strategy: "aegis_generated",
        email: "default@example.com",
        save_as_default_account_email: true,
      },
    });
    expect(approveRes.statusCode).toBe(200);

    // account_creation_email preference must be stored in profile memory.
    const preference = Array.from(privateProfileMemory.values()).find(
      m => m.user_id === MOCK_USER_ID && m.field_kind === "account_creation_email",
    );
    expect(preference).toBeTruthy();
    expect(preference!.provenance.domain_at_creation).toBe("aegis.preferences");
    // Raw email must not be stored anywhere — only the encrypted blob.
    expect(JSON.stringify(Array.from(privateProfileMemory.values()))).not.toContain("default@example.com");

    // Internal list must show has_default_account_email: true.
    const listRes = await server.inject({ method: "GET", url: "/api/internal/account-creation-requests" });
    const entries = listRes.json().data as { has_default_account_email?: boolean }[];
    expect(entries.some(e => e.has_default_account_email === true)).toBe(true);
  });

  it("T4: approve when email blob is missing returns ACCOUNT_EMAIL_DECRYPT_FAILED; no vault pass created", async () => {
    seedDelegation();
    // Seed a profile memory item but intentionally omit the encrypted blob.
    const memId = "ppm_email_no_blob";
    privateProfileMemory.set(memId, {
      memory_id: memId,
      user_id: MOCK_USER_ID,
      field_kind: "email",
      value_ref: `ppvault://${memId}/value`,
      data_class: 2,
      sensitivity: "private",
      default_disclosure_mode: "fill_only",
      agent_visible_allowed: false,
      provenance: { source: "seeded", domain_at_creation: "aegisdemo.local" },
      created_at: NOW,
      updated_at: NOW,
      user_editable: true,
      uses: [],
    });
    // Note: encryptedSecretVault.set NOT called — blob is missing.

    const requestId = await createRequest();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ACCOUNT_EMAIL_DECRYPT_FAILED");
    expect(aegisVaultPasses.size).toBe(0);
    // Request status must remain pending_user.
    expect(accountCreationRequests.get(requestId)!.status).toBe("pending_user");
  });

  it("T5: password not generated before email is resolved; vault unchanged on ACCOUNT_EMAIL_REQUIRED", async () => {
    seedDelegation();
    const vaultSizeBefore = aegisVaultPasses.size;
    const requestId = await createRequest();

    await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });

    // Vault must not have grown — no password should have been generated or stored.
    expect(aegisVaultPasses.size).toBe(vaultSizeBefore);
  });

  it("T6: save_as_default without provided email is a no-op; no preference stored", async () => {
    seedDelegation();
    const requestId = await createRequest();

    // No email in body, save_as_default: true but there's nothing to save.
    await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: {
        email_strategy: "primary_email",
        password_strategy: "aegis_generated",
        save_as_default_account_email: true,
        // email not provided
      },
    });

    // Should have returned ACCOUNT_EMAIL_REQUIRED; no preference stored.
    const preference = Array.from(privateProfileMemory.values()).find(
      m => m.field_kind === "account_creation_email",
    );
    expect(preference).toBeUndefined();
  });

  it("T7: raw_password_revealed_to_agent and otp_revealed_to_agent remain false after inline email approval", async () => {
    seedDelegation();
    const requestId = await createRequest();

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: {
        email_strategy: "primary_email",
        password_strategy: "aegis_generated",
        email: "safety@example.com",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.raw_password_revealed_to_agent).toBe(false);
    expect(body.otp_revealed_to_agent).toBe(false);
    expect(res.body).not.toContain("safety@example.com");
    assertSafeFlags(res.body);
  });
});

describe("GET /api/internal/account-creation-requests — safe list view", () => {
  it("never exposes vault_pass_id or email_used; safe flags present on all entries", async () => {
    seedDelegation();
    seedPrimaryEmailMemory();

    // Create and approve a request so vault_pass_id is set internally.
    const createRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-access-resolutions",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { domain: TEST_DOMAIN, page_url: TEST_PAGE_URL, reason: "List test" },
    });
    const requestId = createRes.json().data.account_creation_request_id;

    await server.inject({
      method: "POST",
      url: `/api/internal/account-creation-requests/${requestId}/approve`,
      headers: { "content-type": "application/json" },
      payload: { email_strategy: "primary_email", password_strategy: "aegis_generated" },
    });

    // Confirm vault_pass_id IS set internally.
    expect(accountCreationRequests.get(requestId)!.vault_pass_id).toBeTruthy();

    // Internal list must not expose it.
    const listRes = await server.inject({
      method: "GET",
      url: "/api/internal/account-creation-requests",
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listRes.body).not.toContain("vault_pass_id");
    expect(listRes.body).not.toContain("email_used");

    for (const entry of listBody.data) {
      expect(entry.raw_password_revealed_to_agent).toBe(false);
      expect(entry.otp_revealed_to_agent).toBe(false);
    }
  });
});
