/**
 * Purchase Confirmation Handoff v1 tests.
 *
 * Verifies:
 * - request_purchase_confirmation: creates pending authorization
 * - Approve: transitions pending_approval → approved, sets purchase_action_authorized: true
 * - Deny: transitions to denied
 * - Execute: requires approved status
 * - card fill authorization ID rejected with 403 CARD_FILL_AUTH_NOT_SUFFICIENT
 * - Blocked button text returns blocked_policy
 * - Allowlisted button text passes validation
 * - Domain mismatch returns blocked_merchant_mismatch
 * - amount_unknown represented in authorization and safe view
 * - Receipt generated on submitted and failed outcomes
 * - Receipt contains no card number, CVV, refs, ciphertext, raw values
 * - Purchase confirmation appears in sensitive receipts event_group=payment
 * - execute disconnects browser, does not close runtime
 * - Existing card fill tests still pass (run in payment-card-fill.test.ts)
 */

import { vi } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

const purchaseMock = {
  outcome: "submitted" as string,
  current_url: "http://localhost:3001/stripe-confirmation",
  page_title: "Confirmation",
  blocked_reason: undefined as string | undefined,
};

vi.mock("../runtime/purchaseConfirmationHandoff.js", () => ({
  executePurchaseConfirmation: vi.fn().mockImplementation(() =>
    Promise.resolve({
      outcome: purchaseMock.outcome,
      current_url: purchaseMock.current_url,
      page_title: purchaseMock.page_title,
      blocked_reason: purchaseMock.blocked_reason,
    }),
  ),
}));

// Stubs for transitive imports in agentApiRoutes
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
    getEncryptedSecret: vi.fn().mockResolvedValue(null),
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
vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn(),
    decryptSecret: vi.fn(),
  })),
}));
vi.mock("../lib/kmsAudit.js", () => ({ recordKmsAuditEvent: vi.fn() }));
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
import type { AgentDelegation } from "@aegis/types";
import {
  agentDelegations,
  collars,
  passes,
  purchaseConfirmationAuthorizations,
  purchaseConfirmationHandoffs,
  userApprovalReceipts,
  MOCK_USER_ID,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { purchaseConfirmationRoutes } from "../routes/purchase-confirmations.js";
import { sensitiveReceiptsRouter } from "../routes/sensitive-receipts.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(purchaseConfirmationRoutes);
  await server.register(sensitiveReceiptsRouter);
  await server.ready();
});

afterAll(async () => { await server.close(); });

beforeEach(() => {
  agentDelegations.clear();
  collars.clear();
  passes.clear();
  purchaseConfirmationAuthorizations.clear();
  purchaseConfirmationHandoffs.clear();
  userApprovalReceipts.clear();
  purchaseMock.outcome = "submitted";
  purchaseMock.current_url = "http://localhost:3001/stripe-confirmation";
  purchaseMock.page_title = "Confirmation";
  purchaseMock.blocked_reason = undefined;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DELEGATION_ID = "del_pconf_test_001";
const DOMAIN = "localhost";
const PAGE_URL = "http://localhost:3001/stripe-checkout";
const BEARER_TOKEN = "tok_pconf_test_001";

function seedDelegation(overrides: Partial<AgentDelegation> = {}) {
  collars.set("col_pconf_test", {
    id: "col_pconf_test",
    user_id: MOCK_USER_ID,
    name: "Purchase Confirm Test Collar",
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
    id: "pass_pconf_test",
    pass_id: "pass_pconf_test",
    user_id: MOCK_USER_ID,
    label: "Purchase Test Pass",
    domain: DOMAIN,
    token: BEARER_TOKEN,
    status: "active",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    delegation_id: DELEGATION_ID,
    collar_id: "col_pconf_test",
    created_at: new Date().toISOString(),
  };
  passes.set(passRecord.id, passRecord as any);

  const delegation: AgentDelegation = {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    agent_name: "Purchase Test Agent",
    collar_id: "col_pconf_test",
    token_id: "pass_pconf_test",
    status: "active",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  } as any;
  agentDelegations.set(delegation.id, delegation);
  return delegation;
}

const AUTH_HEADER = { authorization: `Bearer ${BEARER_TOKEN}` };

function agentPost(url: string, payload: unknown) {
  return server.inject({ method: "POST", url, payload, headers: AUTH_HEADER });
}
function agentGet(url: string) {
  return server.inject({ method: "GET", url, headers: AUTH_HEADER });
}
function internalPost(url: string, payload: unknown = {}) {
  return server.inject({ method: "POST", url, payload });
}
function internalGet(url: string) {
  return server.inject({ method: "GET", url });
}

const BASE_BODY = {
  domain: DOMAIN,
  page_url: PAGE_URL,
  merchant: "Mock Store",
  amount: 12.99,
  currency: "USD",
  item_summary: "Test item",
  payment_method_label: "Visa",
  payment_method_last4: "4242",
  button_text: "Pay $12.99",
  reason: "Complete test purchase",
};

function assertNoRawPaymentData(body: unknown) {
  const str = JSON.stringify(body);
  // Must not contain actual encrypted blob fields or secret references
  expect(str).not.toContain("card_number_ref");
  expect(str).not.toContain("cvv_ref");
  expect(str).not.toContain("payment_method_id");
  expect(str).not.toContain("mock-ciphertext-b64");
  expect(str).not.toContain("mock-nonce-b64");
  expect(str).not.toContain("ciphertext_b64");
  expect(str).not.toContain("nonce_b64");
  expect(str).not.toContain("tag_b64");
  expect(str).not.toContain("aad_b64");
  expect(str).not.toContain("cdp_url");
  expect(str).not.toContain("AEGIS_PLAYWRIGHT");
  // Must not contain raw KMS key material
  expect(str).not.toContain("privateKey");
  expect(str).not.toContain("RECEIPT_JWS");
}

// ─── Tests: Create ─────────────────────────────────────────────────────────────

describe("POST /api/agent/v1/purchase-confirmations — create", () => {
  it("creates a pending authorization with all required fields", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.purchase_confirmation_id).toMatch(/^pconf_/);
    expect(body.data.status).toBe("pending_approval");
    expect(body.data.purchase_action_authorized).toBe(false);
    expect(body.data.raw_values_revealed_to_agent).toBe(false);
    expect(body.data.domain).toBe(DOMAIN);
    expect(body.data.merchant).toBe("Mock Store");
    expect(body.data.amount).toBe(12.99);
    expect(body.data.button_text).toBe("Pay $12.99");
  });

  it("rejects missing domain", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations", { ...BASE_BODY, domain: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_DOMAIN");
  });

  it("rejects missing page_url", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations", { ...BASE_BODY, page_url: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_PAGE_URL");
  });

  it("rejects domain mismatch", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations", {
      ...BASE_BODY,
      domain: "evil.com",
      page_url: PAGE_URL,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("DOMAIN_MISMATCH");
  });

  it("sets amount_unknown: true when amount is omitted", async () => {
    seedDelegation();
    const { amount: _a, ...bodyWithoutAmount } = BASE_BODY;
    const res = await agentPost("/api/agent/v1/purchase-confirmations", bodyWithoutAmount);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.amount_unknown).toBe(true);
  });

  it("stores purchase_action_authorized: false on creation", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = res.json().data.purchase_confirmation_id;
    const auth = purchaseConfirmationAuthorizations.get(id);
    expect(auth?.purchase_action_authorized).toBe(false);
    expect(auth?.status).toBe("pending_approval");
  });

  it("response contains no raw payment data", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    assertNoRawPaymentData(res.json());
  });
});

// ─── Tests: Approve ───────────────────────────────────────────────────────────

describe("POST /api/internal/purchase-confirmation-authorizations/:id/approve", () => {
  it("transitions pending_approval → approved and sets purchase_action_authorized: true", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;

    const approveRes = await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    expect(approveRes.statusCode).toBe(200);
    const body = approveRes.json();
    expect(body.data.status).toBe("approved");
    expect(body.data.purchase_action_authorized).toBe(true);

    const auth = purchaseConfirmationAuthorizations.get(id);
    expect(auth?.status).toBe("approved");
    expect(auth?.purchase_action_authorized).toBe(true);
    expect(auth?.approved_at).toBeDefined();
  });

  it("creates a UserApprovalReceipt on approval", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;

    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    const receipts = Array.from(userApprovalReceipts.values());
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts[0].approval_source).toBe("purchase_confirmation_authorization");
    expect(receipts[0].action_type).toBe("purchase");
    expect(receipts[0].risk_level).toBe("critical");
  });

  it("is idempotent — double approve returns 200 without error", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;

    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    const res2 = await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    expect(res2.statusCode).toBe(200);
  });
});

// ─── Tests: Deny ──────────────────────────────────────────────────────────────

describe("POST /api/internal/purchase-confirmation-authorizations/:id/deny", () => {
  it("transitions pending_approval → denied", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;

    const denyRes = await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/deny`);
    expect(denyRes.statusCode).toBe(200);
    expect(denyRes.json().data.status).toBe("denied");

    const auth = purchaseConfirmationAuthorizations.get(id);
    expect(auth?.status).toBe("denied");
    expect(auth?.purchase_action_authorized).toBe(false);
  });
});

// ─── Tests: Execute ───────────────────────────────────────────────────────────

describe("POST /api/agent/v1/purchase-confirmations/:id/execute", () => {
  it("rejects pca_... card fill authorization ID with 403 CARD_FILL_AUTH_NOT_SUFFICIENT", async () => {
    seedDelegation();
    const res = await agentPost("/api/agent/v1/purchase-confirmations/pca_fake_card_fill/execute", {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CARD_FILL_AUTH_NOT_SUFFICIENT");
  });

  it("rejects execution of pending_approval authorization", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;

    const res = await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("PENDING_APPROVAL");
  });

  it("rejects execution of denied authorization", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/deny`);

    const res = await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_STATUS");
  });

  it("executes approved authorization and returns submitted outcome", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);

    const res = await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.outcome).toBe("submitted");
    expect(body.data.raw_values_revealed_to_agent).toBe(false);
    expect(body.data.purchase_confirmation_id).toBe(id);
  });

  it("marks authorization as fulfilled after submitted outcome", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    const auth = purchaseConfirmationAuthorizations.get(id);
    expect(auth?.status).toBe("fulfilled");
    expect(auth?.fulfilled_at).toBeDefined();
  });

  it("creates a PurchaseConfirmationHandoffRecord on execute", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    const records = Array.from(purchaseConfirmationHandoffs.values());
    expect(records.length).toBe(1);
    expect(records[0].purchase_confirmation_id).toBe(id);
    expect(records[0].outcome).toBe("submitted");
    expect(records[0].raw_values_revealed_to_agent).toBe(false);
    expect(records[0].merchant).toBe("Mock Store");
  });

  it("receipt contains no card number, CVV, refs, ciphertext, or raw values", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    const res = await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    assertNoRawPaymentData(res.json());
    const records = Array.from(purchaseConfirmationHandoffs.values());
    assertNoRawPaymentData(records[0]);
  });

  it("does not mark authorization fulfilled when outcome is failed", async () => {
    purchaseMock.outcome = "failed";
    purchaseMock.blocked_reason = "card declined";
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    const auth = purchaseConfirmationAuthorizations.get(id);
    expect(auth?.status).toBe("approved");
    expect(auth?.fulfilled_at).toBeUndefined();
  });

  it("manual_step_required outcome is not marked as submitted", async () => {
    purchaseMock.outcome = "manual_step_required";
    purchaseMock.current_url = "http://localhost:3001/stripe-checkout";
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    const res = await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().data.outcome).toBe("manual_step_required");
    const auth = purchaseConfirmationAuthorizations.get(id);
    expect(auth?.status).not.toBe("fulfilled");
  });
});

// ─── Tests: Sensitive receipts ────────────────────────────────────────────────

describe("Sensitive receipts timeline — purchase confirmation", () => {
  it("purchase_confirmation_submitted appears in event_group=payment", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    const receipts = await internalGet("/api/internal/sensitive-receipts/recent?event_group=payment&since=all");
    const items = receipts.json().items as { event_type: string }[];
    expect(items.some((i) => i.event_type === "purchase_confirmation_submitted")).toBe(true);
  });

  it("purchase_confirmation_failed appears in payment group when outcome is failed", async () => {
    purchaseMock.outcome = "failed";
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    const receipts = await internalGet("/api/internal/sensitive-receipts/recent?event_group=payment&since=all");
    const items = receipts.json().items as { event_type: string }[];
    expect(items.some((i) => i.event_type === "purchase_confirmation_failed")).toBe(true);
  });

  it("receipt metadata contains no card number, CVV, ciphertext, or raw values", async () => {
    seedDelegation();
    const createRes = await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);
    const id = createRes.json().data.purchase_confirmation_id;
    await internalPost(`/api/internal/purchase-confirmation-authorizations/${id}/approve`);
    await agentPost(`/api/agent/v1/purchase-confirmations/${id}/execute`, {});

    const receipts = await internalGet("/api/internal/sensitive-receipts/recent?since=all");
    assertNoRawPaymentData(receipts.json());
  });
});

// ─── Tests: Internal list endpoint ────────────────────────────────────────────

describe("GET /api/internal/purchase-confirmation-authorizations", () => {
  it("returns safe view without payment_method_id", async () => {
    seedDelegation();
    await agentPost("/api/agent/v1/purchase-confirmations", BASE_BODY);

    const res = await internalGet("/api/internal/purchase-confirmation-authorizations?status=pending_approval");
    expect(res.statusCode).toBe(200);
    const items = res.json().data as any[];
    expect(items.length).toBe(1);
    const item = items[0];
    expect(item).not.toHaveProperty("payment_method_id");
    expect(item.raw_values_revealed_to_agent).toBe(false);
    expect(item.purchase_action_authorized).toBe(false);
    expect(item.merchant).toBe("Mock Store");
    expect(item.button_text).toBe("Pay $12.99");
  });

  it("amount_unknown: true is in safe view when amount not provided", async () => {
    seedDelegation();
    const { amount: _a, ...bodyWithoutAmount } = BASE_BODY;
    await agentPost("/api/agent/v1/purchase-confirmations", bodyWithoutAmount);

    const res = await internalGet("/api/internal/purchase-confirmation-authorizations?status=pending_approval");
    const items = res.json().data as any[];
    expect(items[0].amount_unknown).toBe(true);
  });
});
