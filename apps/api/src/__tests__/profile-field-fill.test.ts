/**
 * Private Profile Memory v1 — Profile Field Fill Handoff tests.
 *
 * Verifies:
 * - POST /api/agent/v1/profile-field-fills: validation, domain mismatch, Class 1 rejection, VALUE_NOT_FOUND
 * - POST /api/agent/v1/profile-field-fills/:id/execute: fills fields, status checks
 * - Response invariants: raw_profile_value_revealed_to_agent: false on every field and root
 * - No raw profile values (address, phone, email, name) in any response
 * - No KMS blobs, CDP URL, cookies, storage, card values, passwords, pass IDs in any response
 * - Profile fill does not authorize purchase
 * - Class 1 fields (card_number, password, ssn, etc.) are rejected
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

// Mock profileFieldFill runtime — default: return filled entries with masked summaries
const profileFillMock = {
  success: true as boolean,
  error: undefined as string | undefined,
};
vi.mock("../runtime/profileFieldFill.js", () => ({
  executeProfileFieldFillViaCDP: vi.fn().mockImplementation(
    (_fillRequest: unknown, resolvedValues: Map<string, string>) => {
      const entries = Array.from(resolvedValues.keys()).map((key) => ({
        key,
        field_filled: profileFillMock.success,
        status: profileFillMock.success ? "filled" : "failed",
        ...(profileFillMock.success ? { masked_summary: `${key[0]}***` } : {}),
        raw_profile_value_revealed_to_agent: false as const,
        ...(profileFillMock.error ? { error: profileFillMock.error } : {}),
      }));
      return Promise.resolve(entries);
    },
  ),
  validateProfileFillSelector: vi.fn().mockImplementation((sel: string) => {
    const blocked = /\b(button|submit|form)\b|\[type\s*=\s*["']?submit|\[role\s*=\s*["']?button|a\[href/i;
    return blocked.test(sel)
      ? { valid: false, reason: `Selector "${sel}" targets a prohibited element.` }
      : { valid: true };
  }),
}));

// Stubs for transitive imports
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
import { getKmsProvider } from "../lib/kms.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(profileFieldFillRoutes);
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
  profileFillMock.success = true;
  profileFillMock.error = undefined;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const BEARER_TOKEN = "test-agent-token-001";
const DELEGATION_ID = "delg_test_001";
const COLLAR_ID = "collar_test_001";
const PASS_ID = "pass_test_001";

function seedDelegation() {
  collars.set(COLLAR_ID, {
    id: COLLAR_ID,
    user_id: MOCK_USER_ID,
    name: "Test Collar",
    description: "Test collar for profile fill tests",
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
    agent_name: "TestAgent",
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

function seedProfileMemory(fields: string[] = ["first_name", "email", "shipping_address_line1"]) {
  for (const kind of fields) {
    const memory_id = `ppm_${kind}_001`;
    encryptedSecretVault.set(memory_id, mockEncryptedBlob);
    privateProfileMemory.set(memory_id, {
      memory_id,
      user_id: MOCK_USER_ID,
      field_kind: kind as Parameters<typeof privateProfileMemory.set>[1]["field_kind"],
      value_ref: `ppvault://${memory_id}/value`,
      data_class: 2,
      sensitivity: "private",
      default_disclosure_mode: "fill_only",
      agent_visible_allowed: false,
      provenance: { source: "seeded", domain_at_creation: "test.local" },
      created_at: NOW,
      updated_at: NOW,
      user_editable: true,
      uses: [],
    });
  }
}

const authHeader = () => ({ authorization: `Bearer ${BEARER_TOKEN}` });

async function agentPost(url: string, payload: unknown) {
  const res = await server.inject({
    method: "POST",
    url,
    headers: { ...authHeader(), "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  return { statusCode: res.statusCode, body: res.json() };
}

function assertNoRawProfileData(body: unknown) {
  const str = JSON.stringify(body);
  // Raw profile values — never in any response
  expect(str).not.toContain("Ann Arbor");
  expect(str).not.toContain("123 Main St");
  expect(str).not.toContain("48104");
  expect(str).not.toContain("15551234567");
  expect(str).not.toContain("alex@aegisdemo");
  expect(str).not.toContain("mock-resolved-value-never-returned");
  // KMS/credential material
  expect(str).not.toContain("mock-ciphertext-b64");
  expect(str).not.toContain("mock-nonce-b64");
  expect(str).not.toContain("mock-aad-b64");
  expect(str).not.toContain("secret_ref");
  expect(str).not.toContain("devvault://");
  expect(str).not.toContain("ppvault://");
  // CDP/session internals
  expect(str).not.toContain("localhost:9222");
  expect(str).not.toContain("cdp_url");
  expect(str).not.toContain("user_data_dir");
  // Card/payment material
  expect(str).not.toContain("card_number");
  expect(str).not.toContain("cvv");
  // Purchase authorization
  expect(str).not.toContain("purchase_authorized");
  expect(str).not.toContain("pconf_");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/agent/v1/profile-field-fills", () => {
  it("1. valid token → 200 with fill_request_id and raw_profile_value flags", async () => {
    seedDelegation();
    seedProfileMemory(["first_name"]);

    const { statusCode, body } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [{ key: "first_name", label: "First name" }],
      reason: "Filling checkout form",
    });

    expect(statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.fill_request_id).toMatch(/^pffr_/);
    expect(body.data.status).toBe("pending");
    expect(body.data.raw_profile_value_revealed_to_agent).toBe(false);
    expect(body.data.raw_profile_values_revealed_to_agent).toBe(false);
  });

  it("2. missing auth header → 401", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/profile-field-fills",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        domain: "test.local",
        page_url: "https://test.local/checkout",
        requested_fields: [{ key: "first_name" }],
        reason: "test",
      }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("5. field not in memory → 200 pending_user with profile_memory_request_id", async () => {
    seedDelegation();
    // Seed only first_name, request email too
    seedProfileMemory(["first_name"]);

    const { statusCode, body } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [
        { key: "first_name" },
        { key: "email" },
      ],
      reason: "Filling checkout form",
    });

    expect(statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("pending_user");
    expect(body.data.profile_memory_request_id).toMatch(/^pmreq_/);
    expect(body.data.missing_fields).toContain("email");
    expect(body.data.missing_fields).not.toContain("first_name");
    expect(body.data.raw_profile_value_revealed_to_agent).toBe(false);
  });

  it("6. domain mismatch → 400 DOMAIN_MISMATCH", async () => {
    seedDelegation();
    seedProfileMemory(["first_name"]);

    const { statusCode, body } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "ikea.com",
      page_url: "https://checkout.other.com/cart",
      requested_fields: [{ key: "first_name" }],
      reason: "test",
    });

    expect(statusCode).toBe(400);
    expect(body.error.code).toBe("DOMAIN_MISMATCH");
  });

  it("7a. Class 1 field card_number → 400 CLASS_1_OUT_OF_SCOPE", async () => {
    seedDelegation();

    const { statusCode, body } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [{ key: "card_number" }],
      reason: "test",
    });

    expect(statusCode).toBe(400);
    expect(body.error.code).toBe("CLASS_1_OUT_OF_SCOPE");
  });

  it("7b. Class 1 field password → 400 CLASS_1_OUT_OF_SCOPE", async () => {
    seedDelegation();

    const { statusCode, body } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [{ key: "password" }],
      reason: "test",
    });

    expect(statusCode).toBe(400);
    expect(body.error.code).toBe("CLASS_1_OUT_OF_SCOPE");
  });

  it("7c. Class 1 fields ssn, pin, bank_account, routing_number, one_time_code → 400", async () => {
    seedDelegation();
    for (const key of ["ssn", "pin", "bank_account", "routing_number", "one_time_code"]) {
      const { statusCode, body } = await agentPost("/api/agent/v1/profile-field-fills", {
        domain: "checkout.test.local",
        page_url: "https://checkout.test.local/cart",
        requested_fields: [{ key }],
        reason: "test",
      });
      expect(statusCode).toBe(400);
      expect(body.error.code).toBe("CLASS_1_OUT_OF_SCOPE");
    }
  });
});

describe("POST /api/agent/v1/profile-field-fills/:id/execute", () => {
  it("3 + 10. execute → filled entries, all_filled: true, raw_profile_values flag on root", async () => {
    seedDelegation();
    seedProfileMemory(["first_name", "email", "shipping_address_line1"]);

    const { body: reqBody } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [
        { key: "first_name" },
        { key: "email" },
        { key: "shipping_address_line1" },
      ],
      reason: "Filling IKEA checkout",
    });
    const fillRequestId = reqBody.data.fill_request_id;

    const { statusCode, body } = await agentPost(
      `/api/agent/v1/profile-field-fills/${fillRequestId}/execute`,
      {},
    );

    expect(statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.all_filled).toBe(true);
    expect(body.data.filled_fields).toHaveLength(3);
    expect(body.data.filled_fields.every((f: { field_filled: boolean }) => f.field_filled)).toBe(true);

    // 10. root raw_profile_values flag (plural)
    expect(body.data.raw_profile_values_revealed_to_agent).toBe(false);
    // raw_profile_value on root (singular)
    expect(body.data.raw_profile_value_revealed_to_agent).toBe(false);
    // Per-field flag
    for (const entry of body.data.filled_fields) {
      expect(entry.raw_profile_value_revealed_to_agent).toBe(false);
    }
  });

  it("4. response contains no raw profile values or sensitive material", async () => {
    seedDelegation();
    seedProfileMemory(["first_name", "email", "shipping_address_line1"]);

    const { body: reqBody } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [{ key: "first_name" }, { key: "email" }, { key: "shipping_address_line1" }],
      reason: "test",
    });
    const { body: execBody } = await agentPost(
      `/api/agent/v1/profile-field-fills/${reqBody.data.fill_request_id}/execute`,
      {},
    );

    assertNoRawProfileData(execBody);
  });

  it("8. unknown fill_request_id → 404", async () => {
    seedDelegation();

    const { statusCode, body } = await agentPost(
      "/api/agent/v1/profile-field-fills/pffr_nonexistent/execute",
      {},
    );

    expect(statusCode).toBe(404);
    expect(body.error.code).toBe("FILL_REQUEST_NOT_FOUND");
  });

  it("9. execute with different delegation → 403", async () => {
    seedDelegation();
    seedProfileMemory(["first_name"]);

    // Create the fill request under the seeded delegation
    const { body: reqBody } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [{ key: "first_name" }],
      reason: "test",
    });
    const fillRequestId = reqBody.data.fill_request_id;

    // Register a different delegation with a different token
    const altPassId = "pass_alt_001";
    const altDelegId = "delg_alt_001";
    passes.set(altPassId, {
      id: altPassId,
      user_id: MOCK_USER_ID,
      token: "alt-token-999",
      status: "active",
      created_at: NOW,
      updated_at: NOW,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    agentDelegations.set(altDelegId, {
      id: altDelegId,
      user_id: MOCK_USER_ID,
      agent_name: "AltAgent",
      token_id: altPassId,
      default_collar_id: COLLAR_ID,
      status: "active",
      created_at: NOW,
      updated_at: NOW,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/profile-field-fills/${fillRequestId}/execute`,
      headers: { authorization: "Bearer alt-token-999", "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(403);
  });

  it("11. response contains no purchase-intent signals", async () => {
    seedDelegation();
    seedProfileMemory(["first_name"]);

    const { body: reqBody } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "checkout.test.local",
      page_url: "https://checkout.test.local/cart",
      requested_fields: [{ key: "first_name" }],
      reason: "test",
    });
    const { body: execBody } = await agentPost(
      `/api/agent/v1/profile-field-fills/${reqBody.data.fill_request_id}/execute`,
      {},
    );

    const str = JSON.stringify(execBody);
    expect(str).not.toContain("purchase_authorized");
    expect(str).not.toContain("purchase_action_authorized");
    expect(str).not.toContain("pconf_");
  });
});

describe("GET /api/internal/profile-memory/items", () => {
  it("returns metadata without value_ref or raw values", async () => {
    seedProfileMemory(["first_name", "email"]);

    const res = await server.inject({
      method: "GET",
      url: "/api/internal/profile-memory/items",
    });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(2);

    const str = JSON.stringify(body);
    // value_ref must never appear in internal listing
    expect(str).not.toContain("ppvault://");
    expect(str).not.toContain("value_ref");
    // Raw values never returned
    expect(str).not.toContain("mock-ciphertext-b64");
  });
});

describe("KMS decrypt context — uses item.provenance.domain_at_creation", () => {
  it("decrypts with the stored domain_at_creation, not hardcoded aegisdemo.local", async () => {
    seedDelegation();

    // Seed a memory item whose provenance says it was created at ikea.com
    const memory_id = "ppm_postal_code_kms_test";
    encryptedSecretVault.set(memory_id, mockEncryptedBlob);
    privateProfileMemory.set(memory_id, {
      memory_id,
      user_id: MOCK_USER_ID,
      field_kind: "postal_code",
      value_ref: `ppvault://${memory_id}/value`,
      data_class: 2,
      sensitivity: "private",
      default_disclosure_mode: "fill_only",
      agent_visible_allowed: false,
      provenance: { source: "user_provided", domain_at_creation: "www.ikea.com" },
      created_at: NOW,
      updated_at: NOW,
      user_editable: true,
      uses: [],
    });

    // Use a stable spy so we can inspect the context
    const stableDecrypt = vi.fn().mockResolvedValue("90210");
    vi.mocked(getKmsProvider).mockReturnValueOnce({
      provider: "local_dev",
      encryptSecret: vi.fn().mockResolvedValue(mockEncryptedBlob),
      decryptSecret: stableDecrypt,
    });

    const { body: reqBody } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "www.ikea.com",
      page_url: "https://www.ikea.com/checkout/",
      requested_fields: [{ key: "postal_code" }],
      reason: "IKEA checkout form",
    });

    expect(reqBody.data.fill_request_id).toMatch(/^pffr_/);

    await agentPost(`/api/agent/v1/profile-field-fills/${reqBody.data.fill_request_id}/execute`, {});

    // decrypt must have been called with domain_at_creation, not "aegisdemo.local"
    expect(stableDecrypt).toHaveBeenCalledWith(
      mockEncryptedBlob,
      expect.objectContaining({ domain: "www.ikea.com" }),
    );
    expect(stableDecrypt).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ domain: "aegisdemo.local" }),
    );
  });

  it("seeded demo items decrypt with aegisdemo.local (provenance is preserved)", async () => {
    seedDelegation();

    // Seed a memory item with aegisdemo.local provenance (matches seed data)
    const memory_id = "ppm_email_kms_demo";
    encryptedSecretVault.set(memory_id, mockEncryptedBlob);
    privateProfileMemory.set(memory_id, {
      memory_id,
      user_id: MOCK_USER_ID,
      field_kind: "email",
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

    const stableDecrypt = vi.fn().mockResolvedValue("alex@aegisdemo.local");
    vi.mocked(getKmsProvider).mockReturnValueOnce({
      provider: "local_dev",
      encryptSecret: vi.fn().mockResolvedValue(mockEncryptedBlob),
      decryptSecret: stableDecrypt,
    });

    const { body: reqBody } = await agentPost("/api/agent/v1/profile-field-fills", {
      domain: "aegisdemo.local",
      page_url: "https://aegisdemo.local/checkout/",
      requested_fields: [{ key: "email" }],
      reason: "Demo checkout",
    });

    await agentPost(`/api/agent/v1/profile-field-fills/${reqBody.data.fill_request_id}/execute`, {});

    expect(stableDecrypt).toHaveBeenCalledWith(
      mockEncryptedBlob,
      expect.objectContaining({ domain: "aegisdemo.local" }),
    );
  });
});
