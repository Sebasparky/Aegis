import { vi } from "vitest";

// Hoist before route imports to suppress disk writes.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock signing so tests don't require real EdDSA keys.
// buildSignedUserApprovalReceipt returns a complete UAR with a known test JWS.
// verifyStoredUserApprovalReceipt recomputes the hash so integrity checks still work.
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

  function hashUserApprovalReceipt(fields: Record<string, unknown>): string {
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
    },
  );

  const verifyStoredUserApprovalReceipt = vi.fn().mockImplementation(
    async (receipt: Record<string, unknown> & { verification: any; outcome: unknown; outcome_updated_at?: unknown }) => {
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
    },
  );

  return {
    hashUserApprovalReceipt,
    buildSignedUserApprovalReceipt,
    verifyStoredUserApprovalReceipt,
    signUserApprovalReceiptJws: vi.fn().mockResolvedValue({ jws: TEST_JWS, signing_key_id: TEST_KEY_ID }),
    verifyUserApprovalReceiptJws: vi.fn().mockResolvedValue({ valid: true }),
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { CredentialUseAuthorization, SecurityChallenge, SensitiveGrant, SensitiveGrantStatus } from "@aegis/types";
import {
  credentialUseAuthorizations,
  securityChallenges,
  sensitiveGrants,
  userApprovalReceipts,
  MOCK_USER_ID,
} from "../store/index.js";
import { secretFieldInjectionRoutes } from "../routes/secret-field-injections.js";
import { securityChallengeRoutes } from "../routes/security-challenges.js";
import { sensitiveGrantRoutes } from "../routes/sensitive-grants.js";
import { checkSensitiveGrant, ALWAYS_REQUIRES_FRESH_APPROVAL, buildSensitiveGrant } from "../lib/sensitiveGrants.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(secretFieldInjectionRoutes);
  await server.register(securityChallengeRoutes);
  await server.register(sensitiveGrantRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  credentialUseAuthorizations.clear();
  securityChallenges.clear();
  sensitiveGrants.clear();
  userApprovalReceipts.clear();
  vi.clearAllMocks();
});

// Use far-future dates so tests are never affected by wall-clock time.
const FAR_FUTURE = "2099-12-31T23:59:59.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const NOW = "2026-05-14T12:00:00.000Z";

/** Wait for non-blocking grant creation promises to settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 50));

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function seedAuth(overrides: Partial<CredentialUseAuthorization> = {}): CredentialUseAuthorization {
  const auth: CredentialUseAuthorization = {
    authorization_id: "auth_test_001",
    user_id: MOCK_USER_ID,
    delegation_id: "delg_test_001",
    domain: "github.com",
    pass_id: "vp_test_001",
    pass_label: "GitHub · testuser",
    pass_username: "testuser",
    allowed_field_kinds: ["username", "password"],
    max_uses_per_field: { username: 1, password: 1 },
    purpose: "login",
    status: "pending_approval",
    raw_values_revealed_to_agent: false,
    persistence_allowed: false,
    browser_storage_allowed: false,
    website_save_allowed: false,
    created_at: NOW,
    expires_at: FAR_FUTURE,
    used_field_kinds: [],
    use_counts: { username: 0, password: 0 },
    ...overrides,
  };
  credentialUseAuthorizations.set(auth.authorization_id, auth);
  return auth;
}

function seedChallenge(overrides: Partial<SecurityChallenge> = {}): SecurityChallenge {
  const ch: SecurityChallenge = {
    challenge_id: "ch_test_001",
    user_id: MOCK_USER_ID,
    delegation_id: "delg_test_001",
    domain: "github.com",
    page_url: "https://github.com/sessions/two-factor",
    challenge_type: "email_device_verification",
    status: "pending_user",
    masked_destination: "***@example.com",
    instructions: "Enter the code sent to your email.",
    raw_code_revealed_to_agent: false,
    created_at: NOW,
    expires_at: FAR_FUTURE,
    ...overrides,
  };
  securityChallenges.set(ch.challenge_id, ch);
  return ch;
}

// ─── 1. credential_injection grant creation ───────────────────────────────────

describe("credential authorization approval → UAR + SensitiveGrant", () => {
  it("creates a grant and UAR when authorization is approved", async () => {
    seedAuth();
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/credential-authorizations/auth_test_001/approve",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await settle();

    expect(sensitiveGrants.size).toBe(1);
    expect(userApprovalReceipts.size).toBe(1);

    const grant = Array.from(sensitiveGrants.values())[0];
    expect(grant.grant_type).toBe("credential_injection");
    expect(grant.status).toBe("active");
    expect(grant.scope.user_id).toBe(MOCK_USER_ID);
    expect(grant.scope.delegation_id).toBe("delg_test_001");
    expect(grant.scope.domain).toBe("github.com");
    expect(grant.scope.authorization_id).toBe("auth_test_001");
  });

  it("grant links to the created UserApprovalReceipt", async () => {
    seedAuth();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const grant = Array.from(sensitiveGrants.values())[0];
    const uar = Array.from(userApprovalReceipts.values())[0];
    expect(grant.linked_uar_id).toBe(uar.receipt_id);
  });

  it("UAR has approval_source=credential_authorization and decision=approved", async () => {
    seedAuth();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const uar = Array.from(userApprovalReceipts.values())[0];
    expect(uar.approval_source).toBe("credential_authorization");
    expect(uar.decision).toBe("approved");
    expect(uar.action_type).toBe("login");
    expect(uar.target_domain).toBe("github.com");
    expect(uar.raw_secrets_in_receipt).toBe(false);
    expect(uar.raw_credentials_in_receipt).toBe(false);
  });

  it("grant scope.pass_id is stored internally (vault ID, not a raw secret)", async () => {
    seedAuth();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const grant = Array.from(sensitiveGrants.values())[0];
    // Internal grant stores pass_id so enforcement can scope lookups — it is a vault ID, not a raw secret
    expect(grant.scope.pass_id).toBe("vp_test_001");
    // Privacy literals must be false
    expect(grant.secret_exposed_to_agent).toBe(false);
    expect(grant.raw_credentials_in_grant).toBe(false);
  });

  it("approval endpoint still returns 200 when grant creation fails (non-blocking)", async () => {
    const { buildSignedUserApprovalReceipt } = await import("../lib/userApprovalReceiptSigning.js");
    (buildSignedUserApprovalReceipt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Signing key unavailable"),
    );

    seedAuth();
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/credential-authorizations/auth_test_001/approve",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await settle();

    // No grant created when UAR fails (invariant: grant must link to a valid UAR)
    expect(sensitiveGrants.size).toBe(0);
  });

  it("deny path creates no grant and no UAR", async () => {
    seedAuth();
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/credential-authorizations/auth_test_001/deny",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await settle();

    expect(sensitiveGrants.size).toBe(0);
    expect(userApprovalReceipts.size).toBe(0);
  });

  it("expired authorization returns 400 and creates no grant", async () => {
    seedAuth({ expires_at: PAST });
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/credential-authorizations/auth_test_001/approve",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await settle();
    expect(sensitiveGrants.size).toBe(0);
  });

  it("already-approved authorization cannot be approved again (no duplicate grant)", async () => {
    seedAuth({ status: "approved" });
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/credential-authorizations/auth_test_001/approve",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await settle();
    expect(sensitiveGrants.size).toBe(0);
  });
});

// ─── 2. challenge_resolution grant creation ───────────────────────────────────

describe("challenge code submission → UAR + SensitiveGrant", () => {
  it("creates a grant and UAR when code is submitted", async () => {
    seedChallenge();
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/security-challenges/ch_test_001/submit-code",
      headers: { "content-type": "application/json" },
      payload: { code: "847261" },
    });
    expect(res.statusCode).toBe(200);
    await settle();

    expect(sensitiveGrants.size).toBe(1);
    expect(userApprovalReceipts.size).toBe(1);

    const grant = Array.from(sensitiveGrants.values())[0];
    expect(grant.grant_type).toBe("challenge_resolution");
    expect(grant.status).toBe("active");
    expect(grant.scope.challenge_id).toBe("ch_test_001");
    expect(grant.scope.domain).toBe("github.com");
    expect(grant.scope.user_id).toBe(MOCK_USER_ID);
  });

  it("UAR has approval_source=challenge_code_submission and decision=approved", async () => {
    seedChallenge();
    await server.inject({
      method: "POST",
      url: "/api/internal/security-challenges/ch_test_001/submit-code",
      headers: { "content-type": "application/json" },
      payload: { code: "847261" },
    });
    await settle();

    const uar = Array.from(userApprovalReceipts.values())[0];
    expect(uar.approval_source).toBe("challenge_code_submission");
    expect(uar.decision).toBe("approved");
    expect(uar.target_domain).toBe("github.com");
    expect(uar.raw_secrets_in_receipt).toBe(false);
    expect(uar.raw_credentials_in_receipt).toBe(false);
  });

  it("grant never stores the raw challenge code", async () => {
    seedChallenge();
    await server.inject({
      method: "POST",
      url: "/api/internal/security-challenges/ch_test_001/submit-code",
      headers: { "content-type": "application/json" },
      payload: { code: "847261" },
    });
    await settle();

    const grant = Array.from(sensitiveGrants.values())[0];
    const grantJson = JSON.stringify(grant);
    expect(grantJson).not.toContain("847261");
    expect(grant.raw_credentials_in_grant).toBe(false);
    expect(grant.secret_exposed_to_agent).toBe(false);
  });

  it("grant expires_at is capped at 5 minutes (matching codeExpiresAt)", async () => {
    // Challenge with a far-future expires_at — grant should still be capped at ~5 min
    const tenMinFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    seedChallenge({ expires_at: tenMinFuture });

    const before = Date.now();
    await server.inject({
      method: "POST",
      url: "/api/internal/security-challenges/ch_test_001/submit-code",
      headers: { "content-type": "application/json" },
      payload: { code: "847261" },
    });
    await settle();
    const after = Date.now();

    const grant = Array.from(sensitiveGrants.values())[0];
    const grantExpiry = new Date(grant.expires_at).getTime();
    const maxExpiry = after + 5 * 60 * 1000;
    const minExpiry = before + 4 * 60 * 1000; // at least 4 min from now
    expect(grantExpiry).toBeLessThanOrEqual(maxExpiry);
    expect(grantExpiry).toBeGreaterThan(minExpiry);
  });

  it("invalid challenge status returns 400 and creates no grant", async () => {
    seedChallenge({ status: "code_submitted" });
    const res = await server.inject({
      method: "POST",
      url: "/api/internal/security-challenges/ch_test_001/submit-code",
      headers: { "content-type": "application/json" },
      payload: { code: "847261" },
    });
    expect(res.statusCode).toBe(400);
    await settle();
    expect(sensitiveGrants.size).toBe(0);
  });
});

// ─── 3. checkSensitiveGrant unit tests ───────────────────────────────────────

describe("checkSensitiveGrant", () => {
  function makeGrant(overrides: Partial<SensitiveGrant> = {}): SensitiveGrant {
    const base = buildSensitiveGrant({
      grant_id: "sg_test_001",
      grant_type: "credential_injection",
      scope: {
        user_id: MOCK_USER_ID,
        delegation_id: "delg_test_001",
        domain: "github.com",
        pass_id: "vp_test_001",
        authorization_id: "auth_test_001",
      },
      expires_at: FAR_FUTURE,
      linked_uar_id: "uar_test_001",
    });
    // Spread overrides after construction so status/scope overrides apply correctly
    return { ...base, ...overrides };
  }

  it("returns valid:true for an active, in-scope grant", () => {
    const grant = makeGrant();
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
      pass_id: "vp_test_001",
    });
    expect(result.valid).toBe(true);
    expect(result.grant?.grant_id).toBe("sg_test_001");
  });

  it("returns expired when expires_at is in the past", () => {
    const grant = makeGrant({ expires_at: PAST });
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("returns consumed for a consumed grant", () => {
    const grant = makeGrant({ status: "consumed" as SensitiveGrantStatus });
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("consumed");
  });

  it("returns revoked for a revoked grant", () => {
    const grant = makeGrant({ status: "revoked" as SensitiveGrantStatus });
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("revoked");
  });

  it("returns no_grant for wrong domain", () => {
    const grant = makeGrant();
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "gitlab.com",
      grant_type: "credential_injection",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no_grant");
  });

  it("task_id scoping: rejects grant when task_ids do not match", () => {
    const grant = makeGrant({ scope: { ...makeGrant().scope, task_id: "task_a" } });
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
      task_id: "task_b",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no_grant");
  });

  it("task_id scoping: accepts grant when task_ids match", () => {
    const grant = makeGrant({ scope: { ...makeGrant().scope, task_id: "task_a" } });
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
      task_id: "task_a",
    });
    expect(result.valid).toBe(true);
  });

  it("unscoped query (no task_id in input) accepts task-scoped grant", () => {
    const grant = makeGrant({ scope: { ...makeGrant().scope, task_id: "task_a" } });
    const map = new Map([["sg_test_001", grant]]);
    const result = checkSensitiveGrant(map, {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
      // no task_id — broader scope check accepts task-scoped grants
    });
    expect(result.valid).toBe(true);
  });

  it("returns no_grant for empty map", () => {
    const result = checkSensitiveGrant(new Map(), {
      user_id: MOCK_USER_ID,
      delegation_id: "delg_test_001",
      domain: "github.com",
      grant_type: "credential_injection",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no_grant");
  });
});

// ─── 4. API endpoints ─────────────────────────────────────────────────────────

describe("GET /api/sensitive-grants", () => {
  it("returns empty array when no grants exist", async () => {
    const res = await server.inject({ method: "GET", url: "/api/sensitive-grants" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("filters by grant_type", async () => {
    seedAuth();
    seedChallenge();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await server.inject({ method: "POST", url: "/api/internal/security-challenges/ch_test_001/submit-code", headers: { "content-type": "application/json" }, payload: { code: "847261" } });
    await settle();

    const res = await server.inject({ method: "GET", url: "/api/sensitive-grants?grant_type=credential_injection" });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBe(1);
    expect(body.data[0].grant_type).toBe("credential_injection");
  });

  it("response does not include scope.pass_id", async () => {
    seedAuth();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const res = await server.inject({ method: "GET", url: "/api/sensitive-grants" });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBe(1);
    expect(body.data[0].scope).not.toHaveProperty("pass_id");
  });
});

describe("GET /api/sensitive-grants/:grantId", () => {
  it("returns grant without pass_id", async () => {
    seedAuth();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const grant = Array.from(sensitiveGrants.values())[0];
    const res = await server.inject({ method: "GET", url: `/api/sensitive-grants/${grant.grant_id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.grant_id).toBe(grant.grant_id);
    expect(body.data.scope).not.toHaveProperty("pass_id");
  });

  it("returns 404 for unknown grant ID", async () => {
    const res = await server.inject({ method: "GET", url: "/api/sensitive-grants/sg_unknown" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/sensitive-grants/:grantId/verify", () => {
  it("returns uar_valid:true and scope_consistent:true for an intact grant chain", async () => {
    seedAuth();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const grant = Array.from(sensitiveGrants.values())[0];
    const res = await server.inject({ method: "GET", url: `/api/sensitive-grants/${grant.grant_id}/verify` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.uar_valid).toBe(true);
    expect(body.data.scope_consistent).toBe(true);
    expect(body.data.grant_status).toBe("active");
  });

  it("returns uar_valid:false when linked UAR is missing", async () => {
    const orphanGrant = buildSensitiveGrant({
      grant_id: "sg_orphan",
      grant_type: "credential_injection",
      scope: { user_id: MOCK_USER_ID, delegation_id: "d", domain: "x.com" },
      expires_at: FAR_FUTURE,
      linked_uar_id: "uar_does_not_exist",
    });
    sensitiveGrants.set("sg_orphan", orphanGrant);

    const res = await server.inject({ method: "GET", url: "/api/sensitive-grants/sg_orphan/verify" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.uar_valid).toBe(false);
    expect(body.data.scope_consistent).toBe(false);
  });
});

describe("POST /api/sensitive-grants/:grantId/revoke", () => {
  it("revokes an active grant", async () => {
    seedAuth();
    await server.inject({ method: "POST", url: "/api/internal/credential-authorizations/auth_test_001/approve", headers: { "content-type": "application/json" }, payload: {} });
    await settle();

    const grant = Array.from(sensitiveGrants.values())[0];
    const res = await server.inject({
      method: "POST",
      url: `/api/sensitive-grants/${grant.grant_id}/revoke`,
      headers: { "content-type": "application/json" },
      payload: { reason: "Test revocation" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe("revoked");

    const updated = sensitiveGrants.get(grant.grant_id)!;
    expect(updated.status).toBe("revoked");
    expect(updated.revoked_at).toBeDefined();
    expect(updated.revoke_reason).toBe("Test revocation");
  });

  it("cannot revoke an already-revoked grant", async () => {
    const revokedGrant: SensitiveGrant = {
      ...buildSensitiveGrant({
        grant_id: "sg_revoked",
        grant_type: "credential_injection",
        scope: { user_id: MOCK_USER_ID, delegation_id: "d", domain: "x.com" },
        expires_at: FAR_FUTURE,
        linked_uar_id: "uar_test",
      }),
      status: "revoked" as SensitiveGrantStatus,
    };
    sensitiveGrants.set("sg_revoked", revokedGrant);

    const res = await server.inject({
      method: "POST",
      url: "/api/sensitive-grants/sg_revoked/revoke",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot revoke an expired grant", async () => {
    const expiredGrant: SensitiveGrant = {
      ...buildSensitiveGrant({
        grant_id: "sg_expired",
        grant_type: "credential_injection",
        scope: { user_id: MOCK_USER_ID, delegation_id: "d", domain: "x.com" },
        expires_at: PAST,
        linked_uar_id: "uar_test",
      }),
      status: "expired" as SensitiveGrantStatus,
    };
    sensitiveGrants.set("sg_expired", expiredGrant);

    const res = await server.inject({
      method: "POST",
      url: "/api/sensitive-grants/sg_expired/revoke",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── 5. ALWAYS_REQUIRES_FRESH_APPROVAL constant ───────────────────────────────

describe("ALWAYS_REQUIRES_FRESH_APPROVAL", () => {
  it("includes high-liability actions that must never get a reusable grant", () => {
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("government_id_upload")).toBe(true);
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("delete_account")).toBe(true);
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("oauth_authorize")).toBe(true);
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("medical_data_disclosure")).toBe(true);
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("financial_data_disclosure")).toBe(true);
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("save_credential")).toBe(true);
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("enable_persistence")).toBe(true);
  });

  it("does NOT include login (credential_injection grants are the correct path for login)", () => {
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("login")).toBe(false);
  });

  it("does NOT include browse or search (low-risk actions never need grants)", () => {
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("browse")).toBe(false);
    expect(ALWAYS_REQUIRES_FRESH_APPROVAL.has("search")).toBe(false);
  });
});

// ─── 6. Privacy literal verification ─────────────────────────────────────────

describe("Privacy literals on SensitiveGrant", () => {
  it("buildSensitiveGrant always sets secret_exposed_to_agent and raw_credentials_in_grant to false", () => {
    const grant = buildSensitiveGrant({
      grant_id: "sg_privacy_test",
      grant_type: "credential_injection",
      scope: { user_id: MOCK_USER_ID, delegation_id: "d", domain: "x.com" },
      expires_at: FAR_FUTURE,
      linked_uar_id: "uar_test",
    });
    expect(grant.secret_exposed_to_agent).toBe(false);
    expect(grant.raw_credentials_in_grant).toBe(false);
    // Verify these are not truthy in any way
    expect(grant.secret_exposed_to_agent).not.toBeTruthy();
    expect(grant.raw_credentials_in_grant).not.toBeTruthy();
  });
});
