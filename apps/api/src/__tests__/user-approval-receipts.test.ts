import { vi } from "vitest";

// Must be hoisted before any route imports to prevent import.meta.url errors
// and suppress disk writes during tests.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock the signing module entirely so tests don't require real EdDSA keys.
// The hash function is re-implemented deterministically; JWS is a known test sentinel.
// verifyStoredUserApprovalReceipt recomputes the hash so tamper tests still work.
vi.mock("../lib/userApprovalReceiptSigning.js", async () => {
  const { createHash } = await import("crypto");

  function sortedReplacer(_k: string, v: unknown): unknown {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return v;
  }

  function hashUserApprovalReceipt(
    fields: Record<string, unknown>
  ): string {
    const stable = JSON.stringify({ receipt_json: fields }, sortedReplacer);
    return createHash("sha256").update(stable, "utf8").digest("hex");
  }

  const TEST_JWS = "mock.jws.payload";
  const TEST_KEY_ID = "test-key-001";

  const buildSignedUserApprovalReceipt = vi.fn().mockImplementation(
    async (fields: Record<string, unknown>) => {
      const hash = hashUserApprovalReceipt(fields);
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
    }
  );

  const verifyStoredUserApprovalReceipt = vi.fn().mockImplementation(
    async (receipt: Record<string, unknown> & { verification: any; outcome: unknown; outcome_updated_at?: unknown }) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { verification, outcome, outcome_updated_at, ...hashableFields } = receipt;
      const recomputed_hash = hashUserApprovalReceipt(hashableFields as Record<string, unknown>);
      const hash_valid = recomputed_hash === (verification as any).canonical_payload_hash;

      const jws_missing = !(verification as any).jws_present || !(verification as any).jws;
      const signature_valid = !jws_missing && hash_valid && (verification as any).jws === TEST_JWS;

      return {
        receipt_id: (receipt as any).receipt_id,
        valid: hash_valid && signature_valid,
        hash_valid,
        signature_valid,
        recomputed_hash,
        stored_hash: (verification as any).canonical_payload_hash,
        ...(jws_missing ? { error: "SIGNING_KEY_UNAVAILABLE" } : {}),
        ...(!jws_missing && !signature_valid && hash_valid ? { error: "VERIFY_FAILED" } : {}),
      };
    }
  );

  return {
    hashUserApprovalReceipt,
    buildSignedUserApprovalReceipt,
    verifyStoredUserApprovalReceipt,
    signUserApprovalReceiptJws: vi.fn().mockResolvedValue({ jws: TEST_JWS, signing_key_id: TEST_KEY_ID }),
    verifyUserApprovalReceiptJws: vi.fn().mockResolvedValue({ valid: true }),
  };
});

// Mock runner service to avoid side effects on approval
vi.mock("../services/runnerService.js", () => ({
  createRunnerTaskFromApproval: vi.fn().mockReturnValue({ id: "runner_test_001" }),
  executeRunnerTask: vi.fn().mockResolvedValue({ id: "runner_test_001" }),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ApprovalRequest, UserApprovalReceipt } from "@aegis/types";
import { approvals, sessions, userApprovalReceipts, MOCK_USER_ID } from "../store/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { routeRunRoutes } from "../routes/route-runs.js";
import { userApprovalReceiptRoutes } from "../routes/user-approval-receipts.js";
import { seedTestData, injectRun, IDS } from "./helpers.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  server = Fastify({ logger: false });
  await server.register(approvalRoutes);
  await server.register(routeRunRoutes);
  await server.register(userApprovalReceiptRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  approvals.clear();
  sessions.clear();
  userApprovalReceipts.clear();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOW = "2026-05-14T12:00:00.000Z";

function seedApproval(id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const req: ApprovalRequest = {
    id,
    user_id: MOCK_USER_ID,
    session_id: "sess_test_001",
    collar_id: IDS.COLLAR,
    action_type: "purchase",
    risk_level: "high",
    domain: "shop.example.local",
    summary: "Purchase item for $49.99",
    reason: "Agent wants to complete checkout",
    context: { cart_total: 49.99, item_count: 2 },
    status: "pending",
    created_at: NOW,
    ...overrides,
  };
  approvals.set(id, req);
  return req;
}

/** Wait for non-blocking promises in the approve/deny/reject handlers. */
const settle = () => new Promise<void>((r) => setTimeout(r, 50));

// ─── 1. ApprovalRequest approve ───────────────────────────────────────────────

describe("ApprovalRequest approve → UserApprovalReceipt", () => {
  it("creates a receipt with decision=approved", async () => {
    seedApproval("appr_001");
    const res = await server.inject({ method: "POST", url: "/api/approvals/appr_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    expect(res.statusCode).toBe(200);
    await settle();

    const all = Array.from(userApprovalReceipts.values());
    expect(all.length).toBe(1);
    const r = all[0];

    expect(r.decision).toBe("approved");
    expect(r.approval_source).toBe("approval_request");
    expect(r.approval_id).toBe("appr_001");
    expect(r.user_id).toBe(MOCK_USER_ID);
    expect(r.action_type).toBe("purchase");
    expect(r.target_domain).toBe("shop.example.local");
    expect(r.receipt_type).toBe("user_approval");
    expect(r.schema_version).toBe("1.0");
    expect(r.issuer).toBe("aegis");
    expect(r.decision_source).toBe("user_click");
    expect(r.receipt_id).toMatch(/^uar_/);
  });

  it("receipt does not contain raw secrets or credential values", async () => {
    seedApproval("appr_002");
    await server.inject({ method: "POST", url: "/api/approvals/appr_002/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    const json = JSON.stringify(r);

    expect(json).not.toContain("devvault://");
    expect(json).not.toContain("secret_ref");
    expect(json).not.toContain('"password"');
    expect(r.raw_secrets_in_receipt).toBe(false);
    expect(r.raw_credentials_in_receipt).toBe(false);
  });

  it("receipt includes scope_shown from the collar", async () => {
    seedApproval("appr_003");
    await server.inject({ method: "POST", url: "/api/approvals/appr_003/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    expect(r.scope_shown).toBeDefined();
    expect(r.scope_shown?.collar_name).toBe("Research & Action Starter");
    expect(Array.isArray(r.scope_shown?.approval_required_actions)).toBe(true);
  });

  it("receipt verification fields are set (hash, jws, jws_present)", async () => {
    seedApproval("appr_004");
    await server.inject({ method: "POST", url: "/api/approvals/appr_004/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    expect(r.verification.canonical_payload_hash).toBeTruthy();
    expect(r.verification.jws).toBe("mock.jws.payload");
    expect(r.verification.jws_present).toBe(true);
    expect(r.verification.signing_alg).toBe("EdDSA");
  });
});

// ─── 2. ApprovalRequest deny ──────────────────────────────────────────────────

describe("ApprovalRequest deny → UserApprovalReceipt", () => {
  it("creates a receipt with decision=denied", async () => {
    seedApproval("deny_001");
    const res = await server.inject({ method: "POST", url: "/api/approvals/deny_001/deny", headers: { "content-type": "application/json" }, payload: {} });
    expect(res.statusCode).toBe(200);
    await settle();

    const all = Array.from(userApprovalReceipts.values());
    expect(all.length).toBe(1);
    const r = all[0];

    expect(r.decision).toBe("denied");
    expect(r.approval_source).toBe("approval_request");
    expect(r.approval_id).toBe("deny_001");
    expect(r.receipt_type).toBe("user_approval");
    expect(r.decision_source).toBe("user_click");
  });

  it("deny receipt does not contain raw secrets", async () => {
    seedApproval("deny_002");
    await server.inject({ method: "POST", url: "/api/approvals/deny_002/deny", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    const json = JSON.stringify(r);
    expect(json).not.toContain("devvault://");
    expect(json).not.toContain("secret_ref");
    expect(r.raw_secrets_in_receipt).toBe(false);
    expect(r.raw_credentials_in_receipt).toBe(false);
  });
});

// ─── 3. Route-run rejection ───────────────────────────────────────────────────

describe("Route-run rejection → UserApprovalReceipt", () => {
  it("creates a denied receipt with source=route_run_rejection", async () => {
    injectRun("run_rej_001", "pending_approval", {
      delegation_id: IDS.DELEGATION_ALL,
      collar_id: IDS.COLLAR,
      domain: "travel.example.local",
      approval_required_permissions: ["travel_booking"],
    });

    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_rej_001/reject", headers: { "content-type": "application/json" }, payload: {} });
    expect(res.statusCode).toBe(200);
    await settle();

    const all = Array.from(userApprovalReceipts.values());
    expect(all.length).toBe(1);
    const r = all[0];

    expect(r.decision).toBe("denied");
    expect(r.approval_source).toBe("route_run_rejection");
    expect(r.route_run_id).toBe("run_rej_001");
    expect(r.target_domain).toBe("travel.example.local");
    expect(r.agent_name).toBe("agent_demo_001");
    expect(r.delegation_id).toBe(IDS.DELEGATION_ALL);
    expect(r.raw_secrets_in_receipt).toBe(false);
    expect(r.raw_credentials_in_receipt).toBe(false);
  });
});

// ─── 4. GET /api/user-approval-receipts (list) ───────────────────────────────

describe("GET /api/user-approval-receipts", () => {
  it("returns empty array when no receipts exist", async () => {
    const res = await server.inject({ method: "GET", url: "/api/user-approval-receipts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("lists receipts and omits jws string but includes jws_present", async () => {
    seedApproval("list_001");
    await server.inject({ method: "POST", url: "/api/approvals/list_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const res = await server.inject({ method: "GET", url: "/api/user-approval-receipts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(1);

    const item = body.data[0];
    // List endpoint omits jws to keep payload small
    expect(item.verification.jws).toBeUndefined();
    expect(item.verification.jws_present).toBe(true);
    expect(item.verification.canonical_payload_hash).toBeTruthy();
  });

  it("filters by ?decision=denied", async () => {
    seedApproval("filter_001");
    seedApproval("filter_002");

    await server.inject({ method: "POST", url: "/api/approvals/filter_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await server.inject({ method: "POST", url: "/api/approvals/filter_002/deny", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const res = await server.inject({ method: "GET", url: "/api/user-approval-receipts?decision=denied" });
    const body = res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].decision).toBe("denied");
  });

  it("filters by ?source=approval_request", async () => {
    seedApproval("source_001");
    await server.inject({ method: "POST", url: "/api/approvals/source_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    injectRun("run_src_001", "pending_approval", { domain: "x.local" });
    await server.inject({ method: "POST", url: "/api/route-runs/run_src_001/reject", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const res = await server.inject({ method: "GET", url: "/api/user-approval-receipts?source=approval_request" });
    const body = res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].approval_source).toBe("approval_request");
  });
});

// ─── 5. GET /api/user-approval-receipts/:receiptId ───────────────────────────

describe("GET /api/user-approval-receipts/:receiptId", () => {
  it("returns full receipt including jws", async () => {
    seedApproval("detail_001");
    await server.inject({ method: "POST", url: "/api/approvals/detail_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    const res = await server.inject({ method: "GET", url: `/api/user-approval-receipts/${r.receipt_id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.verification.jws).toBe("mock.jws.payload");
    expect(body.data.decision).toBe("approved");
  });

  it("returns 404 for unknown receipt", async () => {
    const res = await server.inject({ method: "GET", url: "/api/user-approval-receipts/uar_does_not_exist" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 6. GET /api/user-approval-receipts/:receiptId/verify ────────────────────

describe("GET /api/user-approval-receipts/:receiptId/verify", () => {
  it("returns valid=true for an untampered receipt", async () => {
    seedApproval("verify_001");
    await server.inject({ method: "POST", url: "/api/approvals/verify_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    const res = await server.inject({ method: "GET", url: `/api/user-approval-receipts/${r.receipt_id}/verify` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.hash_valid).toBe(true);
    expect(body.data.signature_valid).toBe(true);
    expect(body.data.valid).toBe(true);
  });

  it("returns valid=false with hash_valid=false after mutating the decision field", async () => {
    seedApproval("tamper_001");
    await server.inject({ method: "POST", url: "/api/approvals/tamper_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    // Tamper: change decision from "approved" to "denied"
    (r as any).decision = "denied";
    userApprovalReceipts.set(r.receipt_id, r);

    const res = await server.inject({ method: "GET", url: `/api/user-approval-receipts/${r.receipt_id}/verify` });
    const body = res.json();
    expect(body.data.hash_valid).toBe(false);
    expect(body.data.valid).toBe(false);
  });

  it("returns valid=false with hash_valid=false after mutating a signed field (target_domain)", async () => {
    seedApproval("tamper_002");
    await server.inject({ method: "POST", url: "/api/approvals/tamper_002/deny", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const r = Array.from(userApprovalReceipts.values())[0];
    // Tamper: change target_domain (a signed field that doesn't affect ownership checks)
    (r as any).target_domain = "attacker.example.com";
    userApprovalReceipts.set(r.receipt_id, r);

    const res = await server.inject({ method: "GET", url: `/api/user-approval-receipts/${r.receipt_id}/verify` });
    const body = res.json();
    expect(body.data.hash_valid).toBe(false);
    expect(body.data.valid).toBe(false);
  });

  it("returns valid=false with error=SIGNING_KEY_UNAVAILABLE for an unsigned receipt", async () => {
    // Directly seed an unsigned receipt (simulates the case where signing key was not configured)
    const unsignedReceipt: UserApprovalReceipt = {
      receipt_id: "uar_unsigned_test",
      receipt_type: "user_approval",
      schema_version: "1.0",
      issuer: "aegis",
      created_at: NOW,
      user_id: MOCK_USER_ID,
      approval_id: "appr_unsigned",
      approval_source: "approval_request",
      decision: "approved",
      decided_at: NOW,
      decision_source: "user_click",
      outcome: "pending",
      raw_secrets_in_receipt: false,
      raw_credentials_in_receipt: false,
      verification: {
        canonical_payload_hash: "abc123",
        jws: "",
        jws_present: false,
        signing_alg: "EdDSA",
        signed_at: NOW,
      },
    };
    userApprovalReceipts.set(unsignedReceipt.receipt_id, unsignedReceipt);

    const res = await server.inject({ method: "GET", url: `/api/user-approval-receipts/${unsignedReceipt.receipt_id}/verify` });
    const body = res.json();
    expect(body.data.valid).toBe(false);
    expect(body.data.signature_valid).toBe(false);
    expect(body.data.error).toBe("SIGNING_KEY_UNAVAILABLE");
  });
});
