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

// Mock the signing module so tests don't require real EdDSA keys.
// Hash is re-implemented deterministically; JWS is a known test sentinel.
vi.mock("../lib/websiteViolationReceiptSigning.js", async () => {
  const { createHash } = await import("crypto");

  function sortedReplacer(_k: string, v: unknown): unknown {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return v;
  }

  function hashWebsiteViolationReceipt(fields: Record<string, unknown>): string {
    const stable = JSON.stringify({ receipt_json: fields }, sortedReplacer);
    return createHash("sha256").update(stable, "utf8").digest("hex");
  }

  const TEST_JWS = "mock.wvr.jws.payload";
  const TEST_KEY_ID = "test-key-001";

  const buildSignedWebsiteViolationReceipt = vi.fn().mockImplementation(
    async (fields: Record<string, unknown>) => {
      const hash = hashWebsiteViolationReceipt(fields);
      return {
        ...fields,
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

  const verifyStoredWebsiteViolationReceipt = vi.fn().mockImplementation(
    async (receipt: Record<string, unknown> & { verification: any }) => {
      const { verification, ...hashableFields } = receipt;
      const recomputed_hash = hashWebsiteViolationReceipt(hashableFields as Record<string, unknown>);
      const hash_valid = recomputed_hash === verification.canonical_payload_hash;

      const jws_missing = !verification.jws_present || !verification.jws;
      const signature_valid = !jws_missing && hash_valid && verification.jws === TEST_JWS;

      return {
        receipt_id: (receipt as any).receipt_id,
        valid: hash_valid && signature_valid,
        hash_valid,
        signature_valid,
        recomputed_hash,
        stored_hash: verification.canonical_payload_hash,
        ...(jws_missing ? { error: "SIGNING_KEY_UNAVAILABLE" } : {}),
        ...(!jws_missing && !signature_valid && hash_valid ? { error: "VERIFY_FAILED" } : {}),
      };
    }
  );

  return {
    hashWebsiteViolationReceipt,
    buildSignedWebsiteViolationReceipt,
    verifyStoredWebsiteViolationReceipt,
    signWebsiteViolationReceiptJws: vi.fn().mockResolvedValue({ jws: TEST_JWS, signing_key_id: TEST_KEY_ID }),
    verifyWebsiteViolationReceiptJws: vi.fn().mockResolvedValue({ valid: true }),
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { WebsiteTrustProfile, WebsiteViolationReceipt } from "@aegis/types";
import { websiteTrustProfiles, websiteViolationReceipts } from "../store/index.js";
import { websiteViolationReceiptRoutes } from "../routes/website-violation-receipts.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(websiteViolationReceiptRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  websiteTrustProfiles.clear();
  websiteViolationReceipts.clear();
  seedTestProfile();
});

// ─── Test data ────────────────────────────────────────────────────────────────

const TEST_PROFILE_ID = "wtp_test_001";
const TEST_PROFILE_HASH = "abc123profilehash";

function seedTestProfile(overrides: Partial<WebsiteTrustProfile> = {}): WebsiteTrustProfile {
  const profile: WebsiteTrustProfile = {
    profile_id: TEST_PROFILE_ID,
    website_aegis_id: "website_test_001",
    domain: "test.local",
    company_name: "Test Corp",
    verification_status: "verified",
    verified_at: "2026-05-14T00:00:00.000Z",
    profile_version: "1",
    status: "active",
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:00.000Z",
    agent_policy: {
      allowed_agent_actions: ["browse", "login"],
      prohibited_agent_actions: [],
      sensitive_actions_require_aegis_approval: true,
      credential_handling_policy: "aegis_only",
      payment_action_policy: "approval_required",
      data_usage_policy: "session_only",
      prompt_injection_commitment: "strict",
      agent_safe_interaction_commitment: "strict",
    },
    safety_promises: [
      {
        promise_id: "site_will_not_prompt_inject_agents",
        title: "No Prompt Injection",
        description: "Will not embed instructions to manipulate agents.",
        severity_if_violated: "critical",
        committed: true,
      },
      {
        promise_id: "site_will_not_disguise_sensitive_actions",
        title: "No Disguised Sensitive Actions",
        description: "Will not hide sensitive actions.",
        severity_if_violated: "high",
        committed: true,
      },
      {
        promise_id: "site_will_expose_clear_sensitive_action_metadata",
        title: "Clear Sensitive Action Metadata",
        description: "Will expose machine-readable metadata for sensitive actions.",
        severity_if_violated: "medium",
        committed: false,
      },
    ],
    violation_count: 0,
    profile_hash: TEST_PROFILE_HASH,
    jws_present: true,
    ...overrides,
  };
  websiteTrustProfiles.set(profile.profile_id, profile);
  return profile;
}

const VALID_BODY = {
  website_profile_id: TEST_PROFILE_ID,
  violation_type: "prompt_injection_detected" as const,
  violated_promise_id: "site_will_not_prompt_inject_agents",
  redacted_evidence_summary: "Page contained text resembling agent instruction override.",
  detection_source: "heuristic" as const,
  decision: "blocked" as const,
  followup_required: false,
};

// ─── 1. Create ────────────────────────────────────────────────────────────────

describe("POST /api/website-violation-receipts", () => {
  it("creates a receipt for active profile + committed promise", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    const r: WebsiteViolationReceipt = body.data;
    expect(r.receipt_id).toMatch(/^wvr_/);
    expect(r.receipt_type).toBe("website_violation");
    expect(r.schema_version).toBe("1.0");
    expect(r.domain).toBe("test.local");
    expect(r.website_profile_id).toBe(TEST_PROFILE_ID);
    expect(r.violation_type).toBe("prompt_injection_detected");
    expect(r.violated_promise_id).toBe("site_will_not_prompt_inject_agents");
    expect(r.violated_promise_title).toBe("No Prompt Injection");
    expect(r.severity).toBe("critical");
    expect(r.decision).toBe("blocked");
  });

  it("receipt references profile_hash from the active profile", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const r: WebsiteViolationReceipt = res.json().data;
    expect(r.profile_hash).toBe(TEST_PROFILE_HASH);
  });

  it("receipt has all three privacy literals as false", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: VALID_BODY,
    });
    const r: WebsiteViolationReceipt = res.json().data;
    expect(r.raw_secrets_in_receipt).toBe(false);
    expect(r.raw_credentials_in_receipt).toBe(false);
    expect(r.raw_page_content_in_receipt).toBe(false);
  });

  it("receipt is signed — verification.jws_present is true", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: VALID_BODY,
    });
    const r: WebsiteViolationReceipt = res.json().data;
    expect(r.verification.jws_present).toBe(true);
    expect(r.verification.signing_alg).toBe("EdDSA");
    expect(r.verification.canonical_payload_hash).toBeDefined();
  });

  it("can resolve profile by domain if website_profile_id not given", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: { ...VALID_BODY, website_profile_id: undefined, domain: "test.local" },
    });
    expect(res.statusCode).toBe(201);
    const r: WebsiteViolationReceipt = res.json().data;
    expect(r.website_profile_id).toBe(TEST_PROFILE_ID);
  });

  it("strips query string from target_url_or_origin", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: {
        ...VALID_BODY,
        target_url_or_origin: "https://test.local/page?token=abc123&secret=xyz",
      },
    });
    expect(res.statusCode).toBe(201);
    const r: WebsiteViolationReceipt = res.json().data;
    expect(r.target_url_or_origin).toBe("https://test.local/page");
    expect(r.target_url_or_origin).not.toContain("token");
    expect(r.target_url_or_origin).not.toContain("secret");
  });

  it("returns 404 WEBSITE_PROFILE_NOT_FOUND for unknown profile_id", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: { ...VALID_BODY, website_profile_id: "wtp_nonexistent" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("WEBSITE_PROFILE_NOT_FOUND");
  });

  it("returns 404 WEBSITE_PROFILE_NOT_FOUND when domain has no active profile", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: { ...VALID_BODY, website_profile_id: undefined, domain: "unknown.local" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("WEBSITE_PROFILE_NOT_FOUND");
  });

  it("returns 422 PROFILE_NOT_ACTIVE for revoked profile", async () => {
    seedTestProfile({ profile_id: "wtp_revoked_001", status: "revoked" });
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: { ...VALID_BODY, website_profile_id: "wtp_revoked_001" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROFILE_NOT_ACTIVE");
  });

  it("returns 404 PROMISE_NOT_FOUND for unknown promise_id", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: { ...VALID_BODY, violated_promise_id: "nonexistent_promise_id" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("PROMISE_NOT_FOUND");
  });

  it("returns 422 PROMISE_NOT_COMMITTED for uncommitted promise", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: {
        ...VALID_BODY,
        violated_promise_id: "site_will_expose_clear_sensitive_action_metadata",
        violation_type: "unclear_sensitive_action_metadata",
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROMISE_NOT_COMMITTED");
  });
});

// ─── 2. Verify ────────────────────────────────────────────────────────────────

describe("GET /api/website-violation-receipts/:receiptId/verify", () => {
  async function createReceipt(): Promise<WebsiteViolationReceipt> {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: VALID_BODY,
    });
    return res.json().data;
  }

  it("returns valid=true for untampered receipt", async () => {
    const r = await createReceipt();
    const res = await server.inject({
      method: "GET",
      url: `/api/website-violation-receipts/${r.receipt_id}/verify`,
    });
    expect(res.statusCode).toBe(200);
    const v = res.json().data;
    expect(v.valid).toBe(true);
    expect(v.hash_valid).toBe(true);
    expect(v.signature_valid).toBe(true);
  });

  it("detects tampering with violation_type", async () => {
    const r = await createReceipt();
    const stored = websiteViolationReceipts.get(r.receipt_id)!;
    (stored as any).violation_type = "collar_policy_override_attempt";
    const res = await server.inject({
      method: "GET",
      url: `/api/website-violation-receipts/${r.receipt_id}/verify`,
    });
    const v = res.json().data;
    expect(v.valid).toBe(false);
    expect(v.hash_valid).toBe(false);
  });

  it("detects tampering with severity", async () => {
    const r = await createReceipt();
    const stored = websiteViolationReceipts.get(r.receipt_id)!;
    (stored as any).severity = "low";
    const res = await server.inject({
      method: "GET",
      url: `/api/website-violation-receipts/${r.receipt_id}/verify`,
    });
    const v = res.json().data;
    expect(v.valid).toBe(false);
    expect(v.hash_valid).toBe(false);
  });

  it("detects tampering with decision", async () => {
    const r = await createReceipt();
    const stored = websiteViolationReceipts.get(r.receipt_id)!;
    (stored as any).decision = "warned";
    const res = await server.inject({
      method: "GET",
      url: `/api/website-violation-receipts/${r.receipt_id}/verify`,
    });
    const v = res.json().data;
    expect(v.valid).toBe(false);
    expect(v.hash_valid).toBe(false);
  });

  it("detects tampering with profile_hash field", async () => {
    const r = await createReceipt();
    const stored = websiteViolationReceipts.get(r.receipt_id)!;
    (stored as any).profile_hash = "tampered_profile_hash";
    const res = await server.inject({
      method: "GET",
      url: `/api/website-violation-receipts/${r.receipt_id}/verify`,
    });
    const v = res.json().data;
    expect(v.valid).toBe(false);
    expect(v.hash_valid).toBe(false);
  });

  it("returns SIGNING_KEY_UNAVAILABLE when jws_present is false", async () => {
    const r = await createReceipt();
    const stored = websiteViolationReceipts.get(r.receipt_id)!;
    (stored.verification as any).jws_present = false;
    (stored.verification as any).jws = "";
    const res = await server.inject({
      method: "GET",
      url: `/api/website-violation-receipts/${r.receipt_id}/verify`,
    });
    const v = res.json().data;
    expect(v.valid).toBe(false);
    expect(v.error).toBe("SIGNING_KEY_UNAVAILABLE");
  });

  it("returns 404 for nonexistent receipt_id", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/website-violation-receipts/wvr_nonexistent/verify",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("RECEIPT_NOT_FOUND");
  });
});

// ─── 3. List ──────────────────────────────────────────────────────────────────

describe("GET /api/website-violation-receipts", () => {
  async function createReceipt(overrides: Record<string, unknown> = {}): Promise<WebsiteViolationReceipt> {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: { ...VALID_BODY, ...overrides },
    });
    return res.json().data;
  }

  it("returns all receipts when no filters applied", async () => {
    await createReceipt();
    await createReceipt();
    const res = await server.inject({ method: "GET", url: "/api/website-violation-receipts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.data).toHaveLength(2);
  });

  it("filters by domain", async () => {
    await createReceipt();
    // Create a second profile on a different domain
    seedTestProfile({ profile_id: "wtp_other_001", domain: "other.local" });
    await createReceipt({ website_profile_id: "wtp_other_001", domain: undefined });
    const res = await server.inject({
      method: "GET",
      url: "/api/website-violation-receipts?domain=test.local",
    });
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.data[0].domain).toBe("test.local");
  });

  it("filters by severity=critical", async () => {
    await createReceipt(); // critical (prompt injection)
    await createReceipt({
      violated_promise_id: "site_will_not_disguise_sensitive_actions",
      violation_type: "disguised_sensitive_action",
    }); // high
    const res = await server.inject({
      method: "GET",
      url: "/api/website-violation-receipts?severity=critical",
    });
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.data[0].severity).toBe("critical");
  });

  it("filters by violation_type", async () => {
    await createReceipt(); // prompt_injection_detected
    await createReceipt({
      violated_promise_id: "site_will_not_disguise_sensitive_actions",
      violation_type: "disguised_sensitive_action",
    });
    const res = await server.inject({
      method: "GET",
      url: "/api/website-violation-receipts?violation_type=prompt_injection_detected",
    });
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.data[0].violation_type).toBe("prompt_injection_detected");
  });

  it("filters by decision", async () => {
    await createReceipt(); // blocked
    await createReceipt({ decision: "recorded_only" });
    const res = await server.inject({
      method: "GET",
      url: "/api/website-violation-receipts?decision=recorded_only",
    });
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.data[0].decision).toBe("recorded_only");
  });
});

// ─── 4. Get by ID ─────────────────────────────────────────────────────────────

describe("GET /api/website-violation-receipts/:receiptId", () => {
  it("returns the receipt by ID", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: VALID_BODY,
    });
    const r: WebsiteViolationReceipt = created.json().data;

    const res = await server.inject({
      method: "GET",
      url: `/api/website-violation-receipts/${r.receipt_id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.receipt_id).toBe(r.receipt_id);
  });

  it("returns 404 for unknown receipt_id", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/website-violation-receipts/wvr_unknown",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("RECEIPT_NOT_FOUND");
  });
});

// ─── 5. Privacy literals ─────────────────────────────────────────────────────

describe("Privacy literals", () => {
  it("receipt JSON never contains raw secrets indicator as true", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-violation-receipts",
      payload: VALID_BODY,
    });
    const r: WebsiteViolationReceipt = res.json().data;
    expect(r.raw_secrets_in_receipt).toBe(false);
    expect(r.raw_credentials_in_receipt).toBe(false);
    expect(r.raw_page_content_in_receipt).toBe(false);
    // Ensure these fields are actually present in the JSON (not just typed)
    const raw = JSON.parse(res.payload);
    expect(raw.data.raw_secrets_in_receipt).toBe(false);
    expect(raw.data.raw_credentials_in_receipt).toBe(false);
    expect(raw.data.raw_page_content_in_receipt).toBe(false);
  });
});
