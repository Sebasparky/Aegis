/**
 * Profile Memory Request v1 — Missing-value prompt loop tests.
 *
 * Verifies:
 * - POST /api/agent/v1/profile-field-fills: missing values → pending_user (not 422)
 * - Response contains profile_memory_request_id and missing_fields
 * - Response never contains raw profile values
 * - Class 1 fields still rejected before missing-value check
 * - GET /api/internal/profile-memory-requests: returns pending requests, metadata only
 * - POST /api/internal/profile-memory-requests/:id/submit: encrypts and stores values
 * - Submit marks request completed
 * - Submit never returns raw values
 * - After submit, profile-field-fill succeeds (values now in memory)
 * - Expired request returns 410 on submit
 * - Submit with missing required field returns 422
 * - Cancel sets status cancelled
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
    decryptSecret: vi.fn().mockResolvedValue("mock-resolved-value-never-returned"),
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
import type { AgentDelegation } from "@aegis/types";
import {
  agentDelegations,
  collars,
  passes,
  encryptedSecretVault,
  profileFieldFillRequests,
  privateProfileMemory,
  profileMemoryRequests,
  MOCK_USER_ID,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { profileFieldFillRoutes } from "../routes/profile-field-fills.js";
import { profileMemoryRequestRoutes } from "../routes/profile-memory-requests.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(profileFieldFillRoutes);
  await server.register(profileMemoryRequestRoutes);
  await server.ready();
});

afterAll(async () => { await server.close(); });

beforeEach(() => {
  agentDelegations.clear();
  collars.clear();
  passes.clear();
  encryptedSecretVault.clear();
  profileFieldFillRequests.clear();
  privateProfileMemory.clear();
  profileMemoryRequests.clear();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const BEARER_TOKEN = "test-agent-token-pmr";
const DELEGATION_ID = "delg_test_pmr";
const COLLAR_ID = "collar_test_pmr";
const PASS_ID = "pass_test_pmr";
const TEST_DOMAIN = "www.ikea.com";
const TEST_PAGE_URL = "https://www.ikea.com/checkout/";

function seedDelegation() {
  collars.set(COLLAR_ID, {
    id: COLLAR_ID,
    user_id: MOCK_USER_ID,
    name: "Test Collar PMR",
    description: "Test collar for profile memory request tests",
    allowed_actions: ["fill_profile_field"],
    approval_required_actions: [],
    blocked_actions: [],
    spending_limits: { max_per_transaction: 0, max_with_approval: 0, currency: "USD" },
    created_at: NOW,
    updated_at: NOW,
  });

  const delegation: AgentDelegation = {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    agent_name: "TestAgentPMR",
    token_id: PASS_ID,
    default_collar_id: COLLAR_ID,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  agentDelegations.set(DELEGATION_ID, delegation);

  const pass: PassWithToken = {
    id: PASS_ID,
    user_id: MOCK_USER_ID,
    token: BEARER_TOKEN,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  passes.set(PASS_ID, pass);
}

function seedProfileMemory(fields: string[]) {
  for (const kind of fields) {
    const memory_id = `ppm_${kind}_pmr`;
    encryptedSecretVault.set(memory_id, mockEncryptedBlob);
    privateProfileMemory.set(memory_id, {
      memory_id,
      user_id: MOCK_USER_ID,
      field_kind: kind as any,
      value_ref: `ppvault://${memory_id}/value`,
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
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/agent/v1/profile-field-fills — missing values → pending_user", () => {
  it("returns 200 pending_user when profile values are missing", async () => {
    seedDelegation();
    // No profile memory seeded

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: [{ key: "email" }, { key: "first_name" }],
        reason: "Checkout contact form",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("pending_user");
    expect(body.data.profile_memory_request_id).toMatch(/^pmreq_/);
    expect(body.data.missing_fields).toContain("email");
    expect(body.data.missing_fields).toContain("first_name");
    expect(body.data.next_action).toBeDefined();
  });

  it("response never contains raw profile values", async () => {
    seedDelegation();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: [{ key: "email" }],
        reason: "Test",
      },
    });

    const body = JSON.parse(res.payload);
    const bodyStr = JSON.stringify(body);
    // No raw values, KMS material, or value_refs
    expect(bodyStr).not.toContain("ppvault://");
    expect(bodyStr).not.toContain("mock-resolved-value-never-returned");
    expect(body.data.raw_profile_value_revealed_to_agent).toBe(false);
  });

  it("only includes truly missing fields in missing_fields", async () => {
    seedDelegation();
    seedProfileMemory(["email"]); // email present, first_name absent

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: [{ key: "email" }, { key: "first_name" }],
        reason: "Test",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.status).toBe("pending_user");
    expect(body.data.missing_fields).toContain("first_name");
    expect(body.data.missing_fields).not.toContain("email");
  });

  it("stores a ProfileMemoryRequest in the map", async () => {
    seedDelegation();

    await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: [{ key: "email" }],
        reason: "Test",
      },
    });

    expect(profileMemoryRequests.size).toBe(1);
    const [req] = Array.from(profileMemoryRequests.values());
    expect(req.status).toBe("pending_user");
    expect(req.domain).toBe(TEST_DOMAIN);
    expect(req.raw_profile_value_revealed_to_agent).toBe(false);
  });

  it("Class 1 fields still rejected before missing-value check", async () => {
    seedDelegation();

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: [{ key: "card_number" }],
        reason: "Test",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("CLASS_1_OUT_OF_SCOPE");
    expect(profileMemoryRequests.size).toBe(0); // No request created
  });

  it("succeeds normally when all values are present (no pending_user)", async () => {
    seedDelegation();
    seedProfileMemory(["email", "first_name"]);

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: [{ key: "email" }, { key: "first_name" }],
        reason: "Test",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.status).toBe("pending");
    expect(body.data.fill_request_id).toMatch(/^pffr_/);
    expect(profileMemoryRequests.size).toBe(0); // No memory request created
  });
});

describe("GET /api/internal/profile-memory-requests", () => {
  it("returns pending_user requests with metadata only", async () => {
    const reqId = "pmreq_test_list_001";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email", "phone"],
      reason: "Checkout form",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const res = await server.inject({ method: "GET", url: "/api/internal/profile-memory-requests?status=pending_user" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].request_id).toBe(reqId);
    expect(body.data[0].missing_fields).toContain("email");
    expect(body.data[0].raw_profile_value_revealed_to_agent).toBe(false);
    // Must not contain raw values or value_refs
    expect(JSON.stringify(body)).not.toContain("ppvault://");
  });

  it("lazy-expires past-expiry requests", async () => {
    const reqId = "pmreq_expired_001";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email"],
      reason: "Old request",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
    });

    await server.inject({ method: "GET", url: "/api/internal/profile-memory-requests" });
    expect(profileMemoryRequests.get(reqId)?.status).toBe("expired");
  });
});

describe("POST /api/internal/profile-memory-requests/:id/submit", () => {
  function createPendingRequest(reqId: string) {
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email", "first_name"],
      reason: "Checkout form",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  }

  it("stores encrypted values and marks request completed", async () => {
    const reqId = "pmreq_submit_001";
    createPendingRequest(reqId);

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { email: "user@example.com", first_name: "Jane" }, save_for_future: true },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("completed");
    expect(body.fields_stored).toContain("email");
    expect(body.fields_stored).toContain("first_name");
    expect(profileMemoryRequests.get(reqId)?.status).toBe("completed");
  });

  it("creates PrivateProfileMemoryItems for each submitted field", async () => {
    const reqId = "pmreq_submit_002";
    createPendingRequest(reqId);

    await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { email: "user@example.com", first_name: "Jane" }, save_for_future: true },
    });

    const emailItem = Array.from(privateProfileMemory.values()).find(m => m.field_kind === "email");
    const nameItem = Array.from(privateProfileMemory.values()).find(m => m.field_kind === "first_name");
    expect(emailItem).toBeDefined();
    expect(nameItem).toBeDefined();
    expect(emailItem?.user_id).toBe(MOCK_USER_ID);
    expect(emailItem?.provenance.source).toBe("user_provided");
  });

  it("never returns submitted raw values in response", async () => {
    const reqId = "pmreq_submit_003";
    createPendingRequest(reqId);

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { email: "secret@example.com", first_name: "SecretName" }, save_for_future: true },
    });

    const bodyStr = res.payload;
    expect(bodyStr).not.toContain("secret@example.com");
    expect(bodyStr).not.toContain("SecretName");
    const body = JSON.parse(bodyStr);
    expect(body.raw_profile_value_revealed_to_agent).toBe(false);
  });

  it("submit region 'VA' → response never contains 'VA', agent GET returns completed with no raw values", async () => {
    seedDelegation();
    // Create a pending request for a missing region field
    const reqId = "pmreq_submit_region_va";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["region"],
      reason: "Checkout shipping form",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    // User submits the region value in the approvals UI
    const submitRes = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { region: "VA" }, save_for_future: true },
    });

    expect(submitRes.statusCode).toBe(200);
    // Submit response must never contain the raw region value
    expect(submitRes.payload).not.toContain('"VA"');
    expect(submitRes.payload).not.toContain("VA");
    const submitBody = JSON.parse(submitRes.payload);
    expect(submitBody.ok).toBe(true);
    expect(submitBody.status).toBe("completed");
    expect(submitBody.raw_profile_value_revealed_to_agent).toBe(false);

    // Agent polls GET — should now see completed (wait_for_profile_memory_request behavior)
    const pollRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/profile-memory-requests/${reqId}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(pollRes.statusCode).toBe(200);
    // Agent GET response must never contain the raw region value
    expect(pollRes.payload).not.toContain('"VA"');
    expect(pollRes.payload).not.toContain("VA");
    const pollBody = JSON.parse(pollRes.payload);
    expect(pollBody.data.status).toBe("completed");
    expect(pollBody.data.completed_at).toBeDefined();
    expect(pollBody.data.raw_profile_value_revealed_to_agent).toBe(false);
    expect(pollBody.data.next_action).toMatch(/retry request_profile_field_fill/i);
  });

  it("after submit, profile-field-fill creates a fill_request_id", async () => {
    seedDelegation();
    const reqId = "pmreq_submit_004";
    createPendingRequest(reqId);

    // Submit values
    await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { email: "user@example.com", first_name: "Jane" }, save_for_future: true },
    });

    // Retry profile field fill — should now succeed
    const fillRes = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      payload: {
        domain: TEST_DOMAIN,
        page_url: TEST_PAGE_URL,
        requested_fields: [{ key: "email" }, { key: "first_name" }],
        reason: "Checkout form",
      },
    });

    expect(fillRes.statusCode).toBe(200);
    const fillBody = JSON.parse(fillRes.payload);
    expect(fillBody.data.fill_request_id).toMatch(/^pffr_/);
    expect(fillBody.data.status).toBe("pending");
  });

  it("returns 404 for unknown request id", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/profile-memory-requests/pmreq_unknown/submit",
      payload: { values: { email: "x@x.com" }, save_for_future: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 for already-completed request", async () => {
    const reqId = "pmreq_submit_done";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email"],
      reason: "Test",
      status: "completed",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      completed_at: NOW,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { email: "x@x.com" }, save_for_future: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 410 for expired request", async () => {
    const reqId = "pmreq_submit_expired";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email"],
      reason: "Test",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { email: "x@x.com" }, save_for_future: true },
    });
    expect(res.statusCode).toBe(410);
    expect(profileMemoryRequests.get(reqId)?.status).toBe("expired");
  });

  it("returns 422 when a required missing field is absent from values", async () => {
    const reqId = "pmreq_submit_incomplete";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email", "first_name"],
      reason: "Test",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    // Only submitting email, not first_name
    const res = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/submit`,
      payload: { values: { email: "x@x.com" }, save_for_future: true },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("INCOMPLETE_VALUES");
  });
});

describe("POST /api/internal/profile-memory-requests/:id/cancel", () => {
  it("sets status to cancelled", async () => {
    const reqId = "pmreq_cancel_001";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email"],
      reason: "Test",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/cancel`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("cancelled");
    expect(profileMemoryRequests.get(reqId)?.status).toBe("cancelled");
  });

  it("returns 409 when cancelling a non-pending request", async () => {
    const reqId = "pmreq_cancel_002";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["email"],
      reason: "Test",
      status: "completed",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/internal/profile-memory-requests/${reqId}/cancel`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("GET /api/agent/v1/profile-memory-requests/:id", () => {
  function createRequest(reqId: string, status: string = "pending_user", extra: Record<string, unknown> = {}) {
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["postal_code"],
      reason: "Checkout form",
      status: status as "pending_user" | "completed" | "expired" | "cancelled",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      ...extra,
    });
  }

  it("returns pending_user status with metadata", async () => {
    seedDelegation();
    const reqId = "pmreq_get_001";
    createRequest(reqId);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/profile-memory-requests/${reqId}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.data.profile_memory_request_id).toBe(reqId);
    expect(body.data.status).toBe("pending_user");
    expect(body.data.domain).toBe(TEST_DOMAIN);
    expect(body.data.missing_fields).toContain("postal_code");
    expect(body.data.raw_profile_value_revealed_to_agent).toBe(false);
    expect(body.data.next_action).toBeDefined();
  });

  it("returns completed status after submit", async () => {
    seedDelegation();
    const reqId = "pmreq_get_completed";
    const completedAt = new Date().toISOString();
    createRequest(reqId, "completed", { completed_at: completedAt });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/profile-memory-requests/${reqId}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.status).toBe("completed");
    expect(body.data.completed_at).toBeDefined();
    expect(body.data.next_action).toMatch(/retry request_profile_field_fill/i);
  });

  it("never returns raw profile values even after completion", async () => {
    seedDelegation();
    const reqId = "pmreq_get_no_raw";
    createRequest(reqId, "completed");

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/profile-memory-requests/${reqId}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    const bodyStr = res.payload;
    expect(bodyStr).not.toContain("ppvault://");
    expect(bodyStr).not.toContain("90210");
    expect(bodyStr).not.toContain("secret_ref");
    const body = JSON.parse(bodyStr);
    expect(body.data.raw_profile_value_revealed_to_agent).toBe(false);
  });

  it("lazy-expires a past-due pending_user request", async () => {
    seedDelegation();
    const reqId = "pmreq_get_lazy_expire";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["postal_code"],
      reason: "Test",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/profile-memory-requests/${reqId}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.status).toBe("expired");
    expect(profileMemoryRequests.get(reqId)?.status).toBe("expired");
  });

  it("returns 404 for unknown request id", async () => {
    seedDelegation();

    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/profile-memory-requests/pmreq_not_real",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when delegation does not own the request", async () => {
    seedDelegation();
    const reqId = "pmreq_get_wrong_delg";
    profileMemoryRequests.set(reqId, {
      request_id: reqId,
      user_id: MOCK_USER_ID,
      delegation_id: "delg_other_agent",
      domain: TEST_DOMAIN,
      page_url: TEST_PAGE_URL,
      missing_fields: ["postal_code"],
      reason: "Other agent",
      status: "pending_user",
      raw_profile_value_revealed_to_agent: false,
      created_at: NOW,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/profile-memory-requests/${reqId}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 without auth token", async () => {
    const reqId = "pmreq_get_noauth";
    createRequest(reqId);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/profile-memory-requests/${reqId}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
