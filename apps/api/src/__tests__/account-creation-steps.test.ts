/**
 * Account Creation v2 — Stepwise Sensitive-Field Handoff tests.
 *
 * Verifies:
 * 1.  account_email step with saved default → resolved, profile_fill_request_id, no raw email.
 * 2.  account_email step missing → pending_user, no crash, no raw email.
 * 3.  password step → generates and stores, returns pass_id, no raw password, safe flag literal false.
 * 4.  password step idempotency → reuses existing vault_pass_id, no duplicate generation.
 * 5.  email_otp step → creates SecurityChallenge, returns email_verification_request_id, no OTP.
 * 6.  domain mismatch → 422 DOMAIN_MISMATCH.
 * 7.  completion with password → access_method inferred as login_password.
 * 8.  completion email verified but no password → access_method passwordless_email_otp.
 * 9.  unsupported step kind → safe UNSUPPORTED_ACCOUNT_CREATION_STEP result.
 * 10. safe flags on all response shapes: all raw_*_revealed_to_agent are literal false.
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
    getEncryptedSecret: vi.fn().mockResolvedValue(mockEncryptedBlob),
    createVaultPass: vi.fn().mockResolvedValue(undefined),
    storeVaultPass: vi.fn(),
    storeEncryptedSecret: vi.fn(),
  })),
}));
vi.mock("../routes/website-agent-safety.js", () => ({ computeWebsiteAgentSafetyProfile: vi.fn() }));
vi.mock("../routes/website-aegis-policy.js", () => ({ getWebsiteAegisPolicyForDomain: vi.fn() }));
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
vi.mock("../runtime/taskBrowserControl.js", () => ({
  connectAndNavigate: vi.fn(),
  connectAndObserve: vi.fn(),
  connectAndClick: vi.fn(),
}));
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
import type { AgentDelegation, AccountCreationRequest } from "@aegis/types";
import {
  agentDelegations,
  collars,
  passes,
  aegisVaultPasses,
  encryptedSecretVault,
  privateProfileMemory,
  accountCreationRequests,
  accountCreationStepRequests,
  profileFieldFillRequests,
  securityChallenges,
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
  accountCreationStepRequests.clear();
  profileFieldFillRequests.clear();
  securityChallenges.clear();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const BEARER_TOKEN = "test-agent-token-acrstep";
const DELEGATION_ID = "delg_test_acrstep";
const COLLAR_ID = "collar_test_acrstep";
const PASS_ID = "pass_test_acrstep";
const TEST_DOMAIN = "ikea.com";
const TEST_PAGE_URL = "https://www.ikea.com/us/en/profile/signup/";

function seedDelegation() {
  collars.set(COLLAR_ID, {
    id: COLLAR_ID,
    user_id: MOCK_USER_ID,
    name: "Test Collar ACRSTEP",
    description: "Test collar for account creation step tests",
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
    user_aegis_id: "aegisid_test_acrstep",
    agent_name: "TestAgentACRSTEP",
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
    agent_name: "TestAgentACRSTEP",
    token: BEARER_TOKEN,
    status: "active",
    created_at: NOW,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  passes.set(PASS_ID, pass);
}

function seedApprovedAccountCreationRequest(options: { vault_pass_id?: string; email_verified?: boolean } = {}): AccountCreationRequest {
  const requestId = newId("acreq");
  const acr: AccountCreationRequest = {
    request_id: requestId,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    domain: TEST_DOMAIN,
    signup_url: TEST_PAGE_URL,
    reason: "Checkout requires account",
    wall_type: "signup",
    status: options.vault_pass_id ? "credential_generated" : "approved",
    raw_password_revealed_to_agent: false,
    otp_revealed_to_agent: false,
    vault_pass_id: options.vault_pass_id,
    email_verified: options.email_verified,
    created_at: NOW,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  accountCreationRequests.set(requestId, acr);
  return acr;
}

function seedAccountCreationEmailMemory() {
  const memId = "ppm_acremail_test";
  encryptedSecretVault.set(memId, {
    provider: "local_dev" as const,
    version: 1 as const,
    algorithm: "aes-256-gcm" as const,
    nonce_b64: "n", ciphertext_b64: "c", tag_b64: "t", aad_b64: "a",
    created_at: NOW,
  });
  privateProfileMemory.set(memId, {
    memory_id: memId,
    user_id: MOCK_USER_ID,
    field_kind: "account_creation_email",
    value_ref: `ppvault://${memId}/value`,
    data_class: 2,
    sensitivity: "private",
    default_disclosure_mode: "fill_only",
    agent_visible_allowed: false,
    provenance: { source: "user_provided", domain_at_creation: "aegis.preferences" },
    created_at: NOW,
    updated_at: NOW,
    user_editable: true,
    uses: [],
  });
  return memId;
}

function agentHeaders() {
  return { authorization: `Bearer ${BEARER_TOKEN}` };
}

function assertStepSafeFlags(body: string) {
  const data = JSON.parse(body).data;
  expect(data.raw_email_revealed_to_agent).toBe(false);
  expect(data.raw_username_revealed_to_agent).toBe(false);
  expect(data.raw_password_revealed_to_agent).toBe(false);
  expect(data.otp_revealed_to_agent).toBe(false);
  // Raw values must never appear anywhere in any response
  expect(body).not.toMatch(/password.*[A-Za-z0-9]{16}/);
  expect(body).not.toContain("vault_pass_id");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/agent/v1/account-creation-steps — account_email with saved default", () => {
  it("returns resolved with profile_fill_request_id; creates ProfileFieldFillRequest; no raw email", async () => {
    seedDelegation();
    seedAccountCreationEmailMemory();
    const acr = seedApprovedAccountCreationRequest();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["account_email"],
        reason: "Signup page is asking for email",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("resolved");
    expect(body.data.next_action).toBe("execute_profile_field_fill");
    expect(body.data.profile_fill_request_id).toBeTruthy();
    expect(body.data.profile_fill_request_id).toMatch(/^pffr_/);
    expect(body.data.resolved_fields).toContain("account_email");

    // ProfileFieldFillRequest created with account_creation_email key
    expect(profileFieldFillRequests.size).toBe(1);
    const pffr = Array.from(profileFieldFillRequests.values())[0];
    expect(pffr.requested_fields[0].key).toBe("account_creation_email");
    expect(pffr.status).toBe("pending");

    assertStepSafeFlags(res.body);
  });
});

describe("POST /api/agent/v1/account-creation-steps — account_email no default", () => {
  it("returns pending_user when no account_creation_email preference exists; no crash", async () => {
    seedDelegation();
    // No email memory seeded
    const acr = seedApprovedAccountCreationRequest();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["account_email"],
        reason: "Signup page is asking for email",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("pending_user");
    expect(body.data.next_action).toBe("wait_for_user");
    expect(body.data.profile_fill_request_id).toBeUndefined();
    // No ProfileFieldFillRequest created
    expect(profileFieldFillRequests.size).toBe(0);

    assertStepSafeFlags(res.body);
  });
});

describe("POST /api/agent/v1/account-creation-steps — password step", () => {
  it("generates and stores password, returns pass_id only, raw_password_revealed_to_agent is false", async () => {
    seedDelegation();
    const acr = seedApprovedAccountCreationRequest();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["password"],
        reason: "Signup page is asking for a password",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("resolved");
    expect(body.data.next_action).toBe("request_secret_field_injection");
    expect(body.data.pass_id).toBeTruthy();
    expect(typeof body.data.pass_id).toBe("string");

    // No raw password anywhere in response
    assertStepSafeFlags(res.body);

    // AccountCreationRequest now has vault_pass_id set
    const updatedAcr = accountCreationRequests.get(acr.request_id)!;
    expect(updatedAcr.vault_pass_id).toBeTruthy();
    expect(updatedAcr.credential_material_created).toBe(true);
    expect(updatedAcr.status).toBe("credential_generated");
  });
});

describe("POST /api/agent/v1/account-creation-steps — password step idempotency", () => {
  it("reuses existing vault_pass_id; does not generate a second credential", async () => {
    seedDelegation();
    const existingPassId = "pass_existing_vault_001";
    const acr = seedApprovedAccountCreationRequest({ vault_pass_id: existingPassId });

    // Seed the existing vault pass
    aegisVaultPasses.set(existingPassId, {
      pass_id: existingPassId,
      user_id: MOCK_USER_ID,
      label: `${TEST_DOMAIN} (auto-created)`,
      kind: "login_password",
      domain: TEST_DOMAIN,
      username: "test@ikea.com",
      secret_ref: `devvault://${existingPassId}/password`,
      created_at: NOW,
      updated_at: NOW,
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["password"],
        reason: "Signup page is asking for a password (retry)",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.pass_id).toBe(existingPassId);

    // Vault should still have only 1 pass — no duplicate generated
    expect(aegisVaultPasses.size).toBe(1);

    assertStepSafeFlags(res.body);
  });
});

describe("POST /api/agent/v1/account-creation-steps — email_otp step", () => {
  it("creates SecurityChallenge; returns email_verification_request_id; otp_revealed_to_agent is false", async () => {
    seedDelegation();
    const acr = seedApprovedAccountCreationRequest();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["email_otp"],
        reason: "Signup page sent a verification code",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("pending_external");
    expect(body.data.next_action).toBe("wait_for_email_otp");
    expect(body.data.email_verification_request_id).toBeTruthy();
    expect(body.data.email_verification_request_id).toMatch(/^chlg_/);

    // SecurityChallenge created with correct type
    expect(securityChallenges.size).toBe(1);
    const challenge = Array.from(securityChallenges.values())[0];
    expect(challenge.challenge_type).toBe("email_device_verification");
    expect(challenge.domain).toBe(TEST_DOMAIN);
    expect(challenge.raw_code_revealed_to_agent).toBe(false);

    // No OTP code anywhere in response
    expect(body.data.otp_revealed_to_agent).toBe(false);
    assertStepSafeFlags(res.body);
  });
});

describe("POST /api/agent/v1/account-creation-steps — domain mismatch", () => {
  it("rejects step request when page_url hostname does not match domain", async () => {
    seedDelegation();
    const acr = seedApprovedAccountCreationRequest();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: "https://evil.com/signup",
        requested_fields: ["account_email"],
        reason: "Testing domain mismatch",
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DOMAIN_MISMATCH");
    // No step request created
    expect(accountCreationStepRequests.size).toBe(0);
  });
});

describe("POST /api/agent/v1/account-access-resolutions/:id/complete — access_method login_password", () => {
  it("infers login_password when vault_pass_id exists", async () => {
    seedDelegation();
    const passId = "pass_vault_complete_test";
    const acr = seedApprovedAccountCreationRequest({ vault_pass_id: passId });

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/account-access-resolutions/${acr.request_id}/complete`,
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { outcome: "authenticated" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("completed");
    expect(body.data.access_method).toBe("login_password");
    expect(body.data.raw_password_revealed_to_agent).toBe(false);
    expect(body.data.otp_revealed_to_agent).toBe(false);
  });
});

describe("POST /api/agent/v1/account-access-resolutions/:id/complete — access_method passwordless_email_otp", () => {
  it("infers passwordless_email_otp when email_verified is true but no vault_pass_id", async () => {
    seedDelegation();
    const acr = seedApprovedAccountCreationRequest({ email_verified: true });
    // Force status to credential_generated manually (no vault pass, but we'll tweak status)
    acr.status = "credential_generated";
    accountCreationRequests.set(acr.request_id, acr);

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/account-access-resolutions/${acr.request_id}/complete`,
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: { outcome: "authenticated" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("completed");
    expect(body.data.access_method).toBe("passwordless_email_otp");
  });
});

describe("POST /api/agent/v1/account-creation-steps — unsupported step kind", () => {
  it("returns failed with UNSUPPORTED_ACCOUNT_CREATION_STEP for unknown/magic_link steps", async () => {
    seedDelegation();
    const acr = seedApprovedAccountCreationRequest();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["magic_link"],
        reason: "Testing unsupported step",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("failed");
    expect(body.data.next_action).toBe("retry");
    expect(body.data.error).toContain("UNSUPPORTED_ACCOUNT_CREATION_STEP");

    assertStepSafeFlags(res.body);
  });
});

describe("Safe flags — all response shapes", () => {
  it("all four raw_*_revealed_to_agent flags are literal false on every step response shape", async () => {
    seedDelegation();
    seedAccountCreationEmailMemory();
    const acr = seedApprovedAccountCreationRequest();

    // Test email resolved path
    const emailRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["account_email"],
        reason: "Checking safe flags on email step",
      },
    });
    const emailData = emailRes.json().data;
    expect(emailData.raw_email_revealed_to_agent).toBe(false);
    expect(emailData.raw_username_revealed_to_agent).toBe(false);
    expect(emailData.raw_password_revealed_to_agent).toBe(false);
    expect(emailData.otp_revealed_to_agent).toBe(false);

    // Test password step path
    const acr2 = seedApprovedAccountCreationRequest();
    const pwdRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr2.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["password"],
        reason: "Checking safe flags on password step",
      },
    });
    const pwdData = pwdRes.json().data;
    expect(pwdData.raw_email_revealed_to_agent).toBe(false);
    expect(pwdData.raw_username_revealed_to_agent).toBe(false);
    expect(pwdData.raw_password_revealed_to_agent).toBe(false);
    expect(pwdData.otp_revealed_to_agent).toBe(false);
    // pass_id is safe metadata; no raw generated password value (only the pass_id identifier)
    expect(pwdData).not.toHaveProperty("password");
    expect(pwdData).not.toHaveProperty("generated_password");

    // Test OTP step path
    const acr3 = seedApprovedAccountCreationRequest();
    const otpRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr3.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["email_otp"],
        reason: "Checking safe flags on otp step",
      },
    });
    const otpData = otpRes.json().data;
    expect(otpData.raw_email_revealed_to_agent).toBe(false);
    expect(otpData.raw_username_revealed_to_agent).toBe(false);
    expect(otpData.raw_password_revealed_to_agent).toBe(false);
    expect(otpData.otp_revealed_to_agent).toBe(false);

    // Test unsupported step path
    const acr4 = seedApprovedAccountCreationRequest();
    const unsupRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/account-creation-steps",
      headers: { ...agentHeaders(), "content-type": "application/json" },
      payload: {
        account_creation_request_id: acr4.request_id,
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: ["unknown"],
        reason: "Checking safe flags on unsupported step",
      },
    });
    const unsupData = unsupRes.json().data;
    expect(unsupData.raw_email_revealed_to_agent).toBe(false);
    expect(unsupData.raw_username_revealed_to_agent).toBe(false);
    expect(unsupData.raw_password_revealed_to_agent).toBe(false);
    expect(unsupData.otp_revealed_to_agent).toBe(false);
  });
});
