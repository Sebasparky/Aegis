/**
 * Payment Card Fill Handoff v1 tests.
 *
 * Verifies:
 * - request_payment_card_fill: validation, domain mismatch, dangerous selectors, inactive payment method
 * - Multiple fields link to the same authorization
 * - Approve/deny flow via internal endpoints
 * - Execute: status checks, SensitiveGrant enforcement, KMS-only for card_number/cvv
 * - Response invariants: no card_number_ref, cvv_ref, payment_method_id, ciphertext, raw values
 * - raw_values_revealed_to_agent: false and purchase_not_authorized: true in all responses
 * - Sensitive receipt timeline event after fill
 * - Purchase confirmation endpoints are NOT implemented
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

const cdpMock = { success: true as boolean, error: undefined as string | undefined };
vi.mock("../runtime/paymentCardFill.js", () => ({
  executePaymentCardFillViaCDP: vi.fn().mockImplementation(() =>
    Promise.resolve(cdpMock.success ? { success: true } : { success: false, error: cdpMock.error ?? "CDP_FAIL" }),
  ),
  validateCardFillSelector: vi.fn().mockImplementation((sel: string) => {
    const blocked = /\b(button|submit|form)\b|\[type\s*=\s*["']?submit|\[role\s*=\s*["']?button|a\[href/i;
    return blocked.test(sel)
      ? { valid: false, reason: `Selector "${sel}" targets a prohibited element.` }
      : { valid: true };
  }),
  isAntigenRef: vi.fn().mockImplementation((ref: string) => /^ag_\d+$/.test(ref)),
}));

// Stubs for transitive imports in agentApiRoutes
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
vi.mock("../runtime/taskBrowserSessions.js", () => ({
  getTaskBrowserSessionForReuse: vi.fn().mockReturnValue(null),
  getTaskBrowserSession: vi.fn().mockReturnValue(null),
  createTaskBrowserSession: vi.fn(),
  findReadySessionByDelegationId: vi.fn().mockReturnValue(null),
  taskBrowserSessions: new Map(),
}));
vi.mock("../runtime/taskBrowserControl.js", () => ({ connectAndNavigate: vi.fn(), connectAndObserve: vi.fn(), connectAndClick: vi.fn() }));
vi.mock("../lib/userApprovalReceiptSigning.js", () => ({
  buildSignedUserApprovalReceipt: vi.fn().mockImplementation(async (fields) => ({
    ...fields,
    verification: { canonical_payload_hash: "h", jws: "j", jws_present: true, signature_valid: true, signed_at: new Date().toISOString() },
  })),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AgentDelegation, PaymentMethod, SensitiveGrant, PaymentCardFillAuthorization } from "@aegis/types";
import {
  agentDelegations,
  collars,
  passes,
  paymentMethods,
  encryptedSecretVault,
  paymentCardFillAuthorizations,
  paymentCardFillRequests,
  paymentCardFillHandoffs,
  sensitiveGrants,
  userApprovalReceipts,
  MOCK_USER_ID,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { paymentCardFillRoutes } from "../routes/payment-card-fills.js";
import { sensitiveReceiptsRouter } from "../routes/sensitive-receipts.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(paymentCardFillRoutes);
  await server.register(sensitiveReceiptsRouter);
  await server.ready();
});

afterAll(async () => { await server.close(); });

beforeEach(() => {
  agentDelegations.clear();
  collars.clear();
  passes.clear();
  paymentMethods.clear();
  encryptedSecretVault.clear();
  paymentCardFillAuthorizations.clear();
  paymentCardFillRequests.clear();
  paymentCardFillHandoffs.clear();
  sensitiveGrants.clear();
  userApprovalReceipts.clear();
  cdpMock.success = true;
  cdpMock.error = undefined;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DELEGATION_ID = "del_card_test_001";
const PM_ID = "pm_card_test_001";
const DOMAIN = "checkout.example.com";
const BEARER_TOKEN = "tok_card_test_001";

function seedDelegation(overrides: Partial<AgentDelegation> = {}) {
  collars.set("col_card_test", {
    id: "col_card_test",
    user_id: MOCK_USER_ID,
    name: "Card Fill Test Collar",
    status: "active",
    allowed_actions: ["payment", "purchase"],
    approval_required_actions: [],
    blocked_actions: [],
    spending_limits: { max_without_approval: 0, max_with_approval: 500, subscriptions_allowed: false },
    counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: false },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as any);

  const passRecord = {
    id: "pass_card_test",
    pass_id: "pass_card_test",
    user_id: MOCK_USER_ID,
    label: "Card Test Pass",
    domain: "checkout.example.com",
    token: BEARER_TOKEN,
    status: "active",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    delegation_id: DELEGATION_ID,
    collar_id: "col_card_test",
    created_at: new Date().toISOString(),
  };
  passes.set(passRecord.id, passRecord as any);

  const delegation: AgentDelegation = {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    agent_name: "TestAgent",
    collar_id: "col_card_test",
    token_id: "pass_card_test",
    status: "active",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  } as any;
  agentDelegations.set(DELEGATION_ID, delegation);
}

function seedPaymentMethod(overrides: Partial<PaymentMethod> = {}): PaymentMethod {
  const pm: PaymentMethod = {
    payment_method_id: PM_ID,
    user_id: MOCK_USER_ID,
    label: "Visa Test Card",
    cardholder_name: "Jane Test",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2027,
    billing_zip: "12345",
    billing_country: "US",
    is_default: true,
    status: "active",
    card_number_ref: `devvault://${PM_ID}/card_number`,
    cvv_ref: `devvault://${PM_ID}/cvv`,
    capability_ref: PM_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  paymentMethods.set(pm.payment_method_id, pm);
  return pm;
}

const AUTH_HEADER = { authorization: `Bearer ${BEARER_TOKEN}` };

function agentPost(url: string, payload: unknown) {
  return server.inject({ method: "POST", url, payload, headers: AUTH_HEADER });
}
function agentGet(url: string) {
  return server.inject({ method: "GET", url, headers: AUTH_HEADER });
}

function assertNoRawCardData(body: unknown) {
  const str = JSON.stringify(body);
  expect(str).not.toContain("card_number_ref");
  expect(str).not.toContain("cvv_ref");
  expect(str).not.toContain("payment_method_id");
  expect(str).not.toContain("mock-ciphertext-b64");
  expect(str).not.toContain("mock-nonce-b64");
  expect(str).not.toContain("mock-resolved-value-never-returned");
}

// ─── Tests: POST /api/agent/v1/payment-card-fills ─────────────────────────────

describe("POST /api/agent/v1/payment-card-fills — validation", () => {
  it("rejects missing domain", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", { field: "card_number", page_url: "https://checkout.example.com/pay", reason: "fill card" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects missing field", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", { domain: DOMAIN, page_url: "https://checkout.example.com/pay", reason: "fill card" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid field value", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", { domain: DOMAIN, field: "secret_number", page_url: "https://checkout.example.com/pay", reason: "fill card" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects domain mismatch with page_url", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: "https://evil.example.org/pay",
      reason: "fill card",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("DOMAIN_MISMATCH");
  });

  it("rejects dangerous selector targeting button", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill",
      element_hint: { selector_hint: "button[type=submit]" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("DANGEROUS_SELECTOR");
  });

  it("rejects dangerous selector targeting form", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill",
      element_hint: { selector_hint: "form#payment" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("DANGEROUS_SELECTOR");
  });

  it("accepts valid input field selector", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill card number",
      element_hint: { selector_hint: "input#card-number" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("rejects a malformed antigen_ref (not an ag_<n> token)", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "cardholder_name",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill cardholder",
      element_hint: { antigen_ref: "input[name=card]" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ANTIGEN_REF");
  });

  it("accepts and persists a well-formed antigen_ref on the fill request", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "cardholder_name",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill cardholder",
      element_hint: { antigen_ref: "ag_12" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const stored = paymentCardFillRequests.get(res.json().data.fill_request_id);
    expect(stored?.element_hint?.antigen_ref).toBe("ag_12");
  });

  it("returns 404 for nonexistent payment_method_id", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill card",
      payment_method_id: "pm_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("PAYMENT_METHOD_NOT_FOUND");
  });

  it("returns 400 for archived payment method", async () => {
    seedDelegation();
    seedPaymentMethod({ status: "archived" });
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill card",
      payment_method_id: PM_ID,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("PAYMENT_METHOD_NOT_ACTIVE");
  });

  it("returns 404 when no default payment method exists and none specified", async () => {
    seedDelegation();
    // No payment method seeded
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill card",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("PAYMENT_METHOD_NOT_FOUND");
  });
});

describe("POST /api/agent/v1/payment-card-fills — happy path", () => {
  it("creates fill request and authorization with pending_approval status", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN,
      field: "card_number",
      page_url: `https://${DOMAIN}/pay`,
      reason: "fill card number at checkout",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("pending_approval");
    expect(body.data.fill_request_id).toMatch(/^pcfr_/);
    expect(body.data.authorization_id).toMatch(/^pca_/);
    expect(body.data.field).toBe("card_number");
    expect(body.data.raw_values_revealed_to_agent).toBe(false);
    expect(body.data.purchase_not_authorized).toBe(true);
    expect(body.data.payment_method_label).toBeDefined();
    expect(body.data.last4).toBe("4242");
    assertNoRawCardData(body);
  });

  it("note always states fill does not authorize purchase", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "cvv",
      page_url: `https://${DOMAIN}/pay`, reason: "fill cvv",
    });
    const body = res.json();
    expect(body.data.note).toContain("does NOT authorize a purchase");
  });

  it("multiple fields link to same authorization_id", async () => {
    seedDelegation();
    seedPaymentMethod();

    const res1 = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill card number",
    });
    const res2 = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "cvv",
      page_url: `https://${DOMAIN}/pay`, reason: "fill cvv",
    });
    const body1 = res1.json();
    const body2 = res2.json();
    expect(body1.data.authorization_id).toBe(body2.data.authorization_id);
    expect(body1.data.fill_request_id).not.toBe(body2.data.fill_request_id);
  });
});

// ─── Tests: Internal approval endpoints ───────────────────────────────────────

describe("GET /api/internal/payment-card-fill-authorizations", () => {
  it("lists pending authorizations — no payment_method_id in response", async () => {
    seedDelegation();
    seedPaymentMethod();
    await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });

    const res = await server.inject({ method: "GET", url: "/api/internal/payment-card-fill-authorizations?status=pending_approval" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    const auth = body.data[0];
    expect(auth).not.toHaveProperty("payment_method_id");
    expect(auth).not.toHaveProperty("card_number_ref");
    expect(auth).not.toHaveProperty("cvv_ref");
    expect(auth.raw_values_revealed_to_agent).toBe(false);
    expect(auth.purchase_not_authorized).toBe(true);
    assertNoRawCardData(body);
  });
});

describe("POST /api/internal/payment-card-fill-authorizations/:id/approve", () => {
  it("transitions authorization to approved and creates SensitiveGrant", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { authorization_id } = createRes.json().data;

    const approveRes = await server.inject({
      method: "POST",
      url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve`,
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();
    expect(approveBody.data.status).toBe("approved");
    expect(approveBody.data.raw_values_revealed_to_agent).toBe(false);
    expect(approveBody.data.purchase_not_authorized).toBe(true);

    // SensitiveGrant should exist with payment_card_fill type
    const grants = Array.from(sensitiveGrants.values());
    expect(grants.length).toBeGreaterThan(0);
    expect(grants[0].grant_type).toBe("payment_card_fill");
    expect(grants[0].scope.payment_method_id).toBe(PM_ID);
    expect(grants[0].scope.authorization_id).toBe(authorization_id);
  });

  it("promotes linked pending fill requests to approved", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { authorization_id, fill_request_id } = createRes.json().data;

    await server.inject({
      method: "POST",
      url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve`,
    });

    const req = paymentCardFillRequests.get(fill_request_id);
    expect(req?.status).toBe("approved");
  });

  it("rejects approve on nonexistent authorization", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/payment-card-fill-authorizations/pca_nonexistent/approve",
    });
    expect(res.statusCode).toBe(404);
  });

  it("is idempotent — re-approving an already-approved authorization returns 200", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { authorization_id } = createRes.json().data;

    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });
    const res2 = await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    expect(res2.statusCode).toBe(200);
    const body = res2.json();
    expect(body.data.status).toBe("approved");
    expect(body.data.raw_values_revealed_to_agent).toBe(false);
    expect(body.data.purchase_not_authorized).toBe(true);
    assertNoRawCardData(body);
  });
});

describe("POST /api/internal/payment-card-fill-authorizations/:id/deny", () => {
  it("denies authorization and cascades to fill requests", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { authorization_id, fill_request_id } = createRes.json().data;

    const denyRes = await server.inject({
      method: "POST",
      url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/deny`,
    });
    expect(denyRes.statusCode).toBe(200);
    expect(denyRes.json().data.status).toBe("denied");

    const req = paymentCardFillRequests.get(fill_request_id);
    expect(req?.status).toBe("denied");
  });
});

// ─── Tests: GET /api/agent/v1/payment-card-fills/:id ──────────────────────────

describe("GET /api/agent/v1/payment-card-fills/:id", () => {
  it("returns fill request status", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id } = createRes.json().data;

    const res = await agentGet(`/api/agent/v1/payment-card-fills/${fill_request_id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe("pending_approval");
    expect(body.data.raw_values_revealed_to_agent).toBe(false);
    expect(body.data.purchase_not_authorized).toBe(true);
    assertNoRawCardData(body);
  });

  it("lazily promotes to approved when authorization is approved", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;

    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    const res = await agentGet(`/api/agent/v1/payment-card-fills/${fill_request_id}`);
    expect(res.json().data.status).toBe("approved");
  });
});

// ─── Tests: POST /api/agent/v1/payment-card-fills/:id/execute ─────────────────

describe("POST /api/agent/v1/payment-card-fills/:id/execute", () => {
  it("rejects execute on pending_approval status", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id } = createRes.json().data;

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("FILL_NOT_APPROVED");
  });

  it("rejects execute on denied status", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;

    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/deny` });

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("FILL_NOT_APPROVED");
  });

  it("rejects execute without a valid SensitiveGrant", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;

    // Approve via internal endpoint
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    // Manually delete the grant
    sensitiveGrants.clear();

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SENSITIVE_GRANT_REQUIRED");
  });

  it("executes card_number fill — calls KMS decrypt, no raw values in response", async () => {
    const { recordKmsAuditEvent } = await import("../lib/kmsAudit.js");
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill card number",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe("filled");
    expect(body.data.raw_values_revealed_to_agent).toBe(false);
    expect(body.data.purchase_not_authorized).toBe(true);
    expect(body.data.field).toBe("card_number");
    expect(body.data.note).toContain("does NOT authorize a purchase");
    assertNoRawCardData(body);
    // KMS audit recorded
    expect(recordKmsAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("ANTIGEN_FILL_STATE off (default) → execute response carries NO post_fill_state key", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "expiry_combined",
      page_url: `https://${DOMAIN}/pay`, reason: "fill expiry",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(200);
    expect("post_fill_state" in res.json().data).toBe(false);
  });

  it("ANTIGEN_FILL_STATE on + unreachable CDP → fill result unchanged, post_fill_state degrades to unknown", async () => {
    seedDelegation();
    seedPaymentMethod();
    const prevFlag = process.env.ANTIGEN_FILL_STATE;
    const prevCdp = process.env.AEGIS_PLAYWRIGHT_CDP_URL;
    process.env.ANTIGEN_FILL_STATE = "true";
    // Unreachable on purpose: the probe must fail closed without affecting the fill.
    process.env.AEGIS_PLAYWRIGHT_CDP_URL = "http://127.0.0.1:1";
    try {
      const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
        domain: DOMAIN, field: "expiry_combined",
        page_url: `https://${DOMAIN}/pay`, reason: "fill expiry",
      });
      const { fill_request_id, authorization_id } = createRes.json().data;
      await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

      const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Fill success reporting is untouched by the probe failure.
      expect(body.data.status).toBe("filled");
      expect(body.data.raw_values_revealed_to_agent).toBe(false);
      expect(body.data.purchase_not_authorized).toBe(true);

      // The summary is present, honest, and leak-free.
      const pfs = body.data.post_fill_state;
      expect(pfs).toBeDefined();
      expect(pfs.outcome).toBe("unknown");
      expect(pfs.filled_count).toBe(1);
      expect(pfs.failed_count).toBe(0);
      expect(pfs.raw_values_revealed_to_agent).toBe(false);
      expect(pfs.next).toBe("refs_require_fresh_snapshot");
      assertNoRawCardData(body);
    } finally {
      if (prevFlag === undefined) delete process.env.ANTIGEN_FILL_STATE;
      else process.env.ANTIGEN_FILL_STATE = prevFlag;
      if (prevCdp === undefined) delete process.env.AEGIS_PLAYWRIGHT_CDP_URL;
      else process.env.AEGIS_PLAYWRIGHT_CDP_URL = prevCdp;
    }
  });

  it("executes cvv fill — calls KMS decrypt", async () => {
    const { recordKmsAuditEvent } = await import("../lib/kmsAudit.js");
    (recordKmsAuditEvent as any).mockClear();
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "cvv",
      page_url: `https://${DOMAIN}/pay`, reason: "fill cvv",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("filled");
    expect(recordKmsAuditEvent).toHaveBeenCalled();
  });

  it("executes expiry_combined — does NOT call KMS decrypt", async () => {
    const { recordKmsAuditEvent } = await import("../lib/kmsAudit.js");
    (recordKmsAuditEvent as any).mockClear();
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "expiry_combined",
      page_url: `https://${DOMAIN}/pay`, reason: "fill expiry",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("filled");
    // KMS decrypt NOT called for non-secret fields
    expect(recordKmsAuditEvent).not.toHaveBeenCalled();
  });

  it("executes cardholder_name — does NOT call KMS decrypt", async () => {
    const { recordKmsAuditEvent } = await import("../lib/kmsAudit.js");
    (recordKmsAuditEvent as any).mockClear();
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "cardholder_name",
      page_url: `https://${DOMAIN}/pay`, reason: "fill name",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("filled");
    expect(recordKmsAuditEvent).not.toHaveBeenCalled();
  });

  it("records PaymentCardFillHandoffRecord after successful fill", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });
    await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});

    const records = Array.from(paymentCardFillHandoffs.values());
    expect(records).toHaveLength(1);
    expect(records[0].raw_values_revealed_to_agent).toBe(false);
    expect(records[0].purchase_not_authorized).toBe(true);
    expect(records[0].outcome).toBe("filled");
    expect(records[0].field).toBe("card_number");
    expect(records[0].last4).toBe("4242");
    // No payment_method_id in handoff record
    expect(records[0]).not.toHaveProperty("card_number_ref");
    expect(records[0]).not.toHaveProperty("cvv_ref");
  });

  it("returns 500 and records failed handoff when CDP fails", async () => {
    cdpMock.success = false;
    cdpMock.error = "CDP_FAIL_TEST";
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });

    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("CDP_FILL_FAILED");

    const records = Array.from(paymentCardFillHandoffs.values());
    expect(records[0].outcome).toBe("failed");
    expect(records[0].raw_values_revealed_to_agent).toBe(false);
    expect(records[0].purchase_not_authorized).toBe(true);
  });
});

// ─── Tests: raw_values_revealed_to_agent and purchase_not_authorized invariants ─

describe("Response invariants", () => {
  it("raw_values_revealed_to_agent: false in create response", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    expect(res.json().data.raw_values_revealed_to_agent).toBe(false);
  });

  it("purchase_not_authorized: true in create response", async () => {
    seedDelegation();
    seedPaymentMethod();
    const res = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    expect(res.json().data.purchase_not_authorized).toBe(true);
  });

  it("raw_values_revealed_to_agent: false in execute response", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "expiry_combined",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });
    const res = await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});
    expect(res.json().data.raw_values_revealed_to_agent).toBe(false);
    expect(res.json().data.purchase_not_authorized).toBe(true);
  });

  it("internal approval list contains raw_values_revealed_to_agent: false and purchase_not_authorized: true", async () => {
    seedDelegation();
    seedPaymentMethod();
    await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "card_number",
      page_url: `https://${DOMAIN}/pay`, reason: "fill",
    });
    const res = await server.inject({ method: "GET", url: "/api/internal/payment-card-fill-authorizations?status=pending_approval" });
    const auth = res.json().data[0];
    expect(auth.raw_values_revealed_to_agent).toBe(false);
    expect(auth.purchase_not_authorized).toBe(true);
  });
});

// ─── Tests: Sensitive receipt timeline ────────────────────────────────────────

describe("Sensitive receipt timeline — payment_card_fill_executed", () => {
  it("shows payment_card_fill_executed event after successful fill", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "billing_zip",
      page_url: `https://${DOMAIN}/pay`, reason: "fill zip",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });
    await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});

    const res = await server.inject({ method: "GET", url: "/api/internal/sensitive-receipts/recent?since=all" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const paymentEvents = body.items.filter((i: any) => i.event_type === "payment_card_fill_executed");
    expect(paymentEvents).toHaveLength(1);

    const event = paymentEvents[0];
    expect(event.metadata.raw_values_revealed_to_agent).toBe(false);
    expect(event.metadata.purchase_not_authorized).toBe(true);
    expect(event.metadata.field).toBe("billing_zip");
    expect(event.metadata.last4).toBe("4242");
    // No raw card data in event
    assertNoRawCardData(event);
  });

  it("event group filter 'payment' includes payment_card_fill_executed", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "cardholder_name",
      page_url: `https://${DOMAIN}/pay`, reason: "fill name",
    });
    const { fill_request_id, authorization_id } = createRes.json().data;
    await server.inject({ method: "POST", url: `/api/internal/payment-card-fill-authorizations/${authorization_id}/approve` });
    await agentPost(`/api/agent/v1/payment-card-fills/${fill_request_id}/execute`, {});

    const res = await server.inject({ method: "GET", url: "/api/internal/sensitive-receipts/recent?since=all&event_group=payment" });
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: any) => i.event_type === "payment_card_fill_executed")).toBe(true);
  });
});

// ─── Tests: Card fill authorization cannot execute purchase ───────────────────

describe("Card fill authorization cannot authorize purchase execution", () => {
  it("POST .../execute with pca_... ID returns 403 CARD_FILL_AUTH_NOT_SUFFICIENT", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations/pca_fake_auth/execute", {});
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("CARD_FILL_AUTH_NOT_SUFFICIENT");
  });

  it("GET /api/agent/v1/purchase-confirmations/pconf_fake returns 404 for unknown ID", async () => {
    seedDelegation();
    const res = await agentGet("/api/agent/v1/purchase-confirmations/pconf_fake_unknown");
    expect(res.statusCode).toBe(404);
  });

  it("purchase_not_authorized: true is on all card fill responses", async () => {
    seedDelegation();
    seedPaymentMethod();
    const createRes = await agentPost("/api/agent/v1/payment-card-fills", {
      domain: DOMAIN, field: "cardholder_name",
      page_url: `https://${DOMAIN}/checkout`, reason: "test",
    });
    const body = JSON.parse(createRes.payload);
    expect(body.data.purchase_not_authorized).toBe(true);
  });
});

// ─── Tests: Redacted screenshot endpoint fails closed ─────────────────────────
// browser_take_screenshot routes here so protected card values rendered on the page
// are never returned to the agent. Without an Aegis-mediated runtime there is no
// native fallback — the endpoint fails closed.

describe("POST /api/agent/v1/runtime/browser-screenshot — fail closed", () => {
  it("requires browser_runtime_id (400 MISSING_FIELD)", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/runtime/browser-screenshot", {});
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("MISSING_FIELD");
  });

  it("fails closed with SCREENSHOT_REQUIRES_ANTIGEN_RUNTIME when no ready runtime exists", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/runtime/browser-screenshot", {
      browser_runtime_id: "tbsess_does_not_exist",
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe("SCREENSHOT_REQUIRES_ANTIGEN_RUNTIME");
    // No image, and never an unredacted base64 payload.
    expect(JSON.stringify(body)).not.toContain("image_base64");
  });

  it("rejects an unauthenticated request", async () => {
    seedDelegation();
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-screenshot",
      payload: { browser_runtime_id: "tbsess_x" },
    });
    expect(res.statusCode).toBe(401);
  });
});
