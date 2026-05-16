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
vi.mock("../lib/websiteTrustProfileSigning.js", async () => {
  const { createHash } = await import("crypto");

  function sortedReplacer(_k: string, v: unknown): unknown {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return v;
  }

  function hashWebsiteTrustProfile(
    fields: Record<string, unknown>
  ): string {
    const stable = JSON.stringify({ profile_json: fields }, sortedReplacer);
    return createHash("sha256").update(stable, "utf8").digest("hex");
  }

  const TEST_JWS = "mock.wtp.jws.payload";

  const buildSignedWebsiteTrustProfile = vi.fn().mockImplementation(
    async (fields: Record<string, unknown>) => {
      const hash = hashWebsiteTrustProfile(fields);
      return {
        ...fields,
        profile_hash: hash,
        profile_jws: TEST_JWS,
        jws_present: true,
      };
    }
  );

  const verifyStoredWebsiteTrustProfile = vi.fn().mockImplementation(
    async (profile: Record<string, unknown> & { profile_hash: string; profile_jws?: string; jws_present?: boolean }) => {
      const { profile_hash, profile_jws, jws_present, ...hashableFields } = profile;
      const recomputed_hash = hashWebsiteTrustProfile(hashableFields as Record<string, unknown>);
      const hash_valid = recomputed_hash === profile_hash;

      const jws_missing = !jws_present || !profile_jws;
      const signature_valid = !jws_missing && hash_valid && profile_jws === TEST_JWS;

      return {
        profile_id: (profile as any).profile_id,
        valid: hash_valid && signature_valid,
        hash_valid,
        signature_valid,
        recomputed_hash,
        stored_hash: profile_hash,
        ...(jws_missing ? { error: "SIGNING_KEY_UNAVAILABLE" } : {}),
        ...(!jws_missing && !signature_valid && hash_valid ? { error: "VERIFY_FAILED" } : {}),
      };
    }
  );

  const STANDARD_SAFETY_PROMISES = [
    { promise_id: "site_will_not_prompt_inject_agents", title: "No Prompt Injection", description: "Test.", severity_if_violated: "critical" },
    { promise_id: "site_will_not_request_secrets_outside_approved_flows", title: "Secrets Only in Approved Flows", description: "Test.", severity_if_violated: "critical" },
  ];

  return {
    hashWebsiteTrustProfile,
    buildSignedWebsiteTrustProfile,
    verifyStoredWebsiteTrustProfile,
    signWebsiteTrustProfileJws: vi.fn().mockResolvedValue({ jws: TEST_JWS }),
    verifyWebsiteTrustProfileJws: vi.fn().mockResolvedValue({ valid: true }),
    STANDARD_SAFETY_PROMISES,
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { WebsiteTrustProfile } from "@aegis/types";
import { websiteTrustProfiles, agentDelegations, collars } from "../store/index.js";
import { websiteTrustProfileRoutes } from "../routes/website-trust-profiles.js";
import { agentApiRoutes } from "../routes/agent-api.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

const AGENT_TOKEN = "pass_demo_001";

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(websiteTrustProfileRoutes);
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  websiteTrustProfiles.clear();
  agentDelegations.clear();
  collars.clear();

  // Seed a collar and delegation so agent endpoints can authenticate
  collars.set("collar_demo_starter", {
    id: "collar_demo_starter",
    user_id: "user_001",
    name: "Test Collar",
    description: "Test",
    purpose: "Test",
    status: "active",
    allowed_actions: ["browse", "search"],
    approval_required_actions: [],
    blocked_actions: [],
    spending_limits: { max_without_approval: 0, max_with_approval: 100, subscriptions_allowed: false },
    counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: false },
    session_limits: { max_duration_minutes: 60, max_active_sessions: 1 },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  agentDelegations.set("delg_test_001", {
    id: "delg_test_001",
    token_id: AGENT_TOKEN,
    user_id: "user_001",
    user_aegis_id: "aid_user_001",
    default_collar_id: "collar_demo_starter",
    agent_name: "TestAgent",
    agent_platform: "test",
    channel: "api",
    status: "active",
    skill_access_mode: "all",
    skill_access_skill_ids: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<WebsiteTrustProfile> = {}): WebsiteTrustProfile {
  return {
    profile_id: "wtp_test_001",
    website_aegis_id: "web_test",
    domain: "test.local",
    company_name: "Test Co",
    verification_status: "verified",
    profile_version: "1",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    agent_policy: {
      allowed_agent_actions: ["browse"],
      prohibited_agent_actions: [],
      sensitive_actions_require_aegis_approval: true,
      credential_handling_policy: "Via Antigen only.",
      payment_action_policy: "Approval required.",
      data_usage_policy: "Session only.",
      prompt_injection_commitment: "None embedded.",
      agent_safe_interaction_commitment: "Metadata exposed.",
    },
    safety_promises: [
      { promise_id: "site_will_not_prompt_inject_agents", title: "No Prompt Injection", description: "Test.", severity_if_violated: "critical", committed: true },
    ],
    violation_count: 0,
    profile_hash: "abc123",
    profile_jws: "mock.wtp.jws.payload",
    jws_present: true,
    ...overrides,
  };
}

const VALID_BODY = {
  website_aegis_id: "web_create_test",
  domain: "create.local",
  company_name: "Create Test Co",
  verification_status: "unverified",
  agent_policy: {
    allowed_agent_actions: ["browse"],
    prohibited_agent_actions: [],
    sensitive_actions_require_aegis_approval: false,
    credential_handling_policy: "None.",
    payment_action_policy: "None.",
    data_usage_policy: "None.",
    prompt_injection_commitment: "None.",
    agent_safe_interaction_commitment: "None.",
  },
  safety_promises: [],
};

// ─── 1. POST /api/website-trust-profiles ─────────────────────────────────────

describe("POST /api/website-trust-profiles", () => {
  it("creates a profile with correct defaults", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-trust-profiles",
      headers: { "content-type": "application/json" },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const { data } = JSON.parse(res.body);
    expect(data.profile_id).toMatch(/^wtp_/);
    expect(data.status).toBe("active");
    expect(data.violation_count).toBe(0);
    expect(data.domain).toBe("create.local");
    expect(data.profile_hash).toBeTruthy();
    expect(data.jws_present).toBe(true);
    expect(websiteTrustProfiles.has(data.profile_id)).toBe(true);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-trust-profiles",
      headers: { "content-type": "application/json" },
      payload: { domain: "test.local" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("normalizes domain to lowercase", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-trust-profiles",
      headers: { "content-type": "application/json" },
      payload: { ...VALID_BODY, domain: "UPPER.LOCAL" },
    });
    expect(res.statusCode).toBe(201);
    const { data } = JSON.parse(res.body);
    expect(data.domain).toBe("upper.local");
  });

  it("strips protocol from domain", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/website-trust-profiles",
      headers: { "content-type": "application/json" },
      payload: { ...VALID_BODY, domain: "https://stripped.local/path?q=1" },
    });
    expect(res.statusCode).toBe(201);
    const { data } = JSON.parse(res.body);
    expect(data.domain).toBe("stripped.local");
  });
});

// ─── 2. GET /api/website-trust-profiles ──────────────────────────────────────

describe("GET /api/website-trust-profiles", () => {
  it("returns all profiles", async () => {
    websiteTrustProfiles.set("wtp_a", makeProfile({ profile_id: "wtp_a", created_at: "2026-01-02T00:00:00.000Z" }));
    websiteTrustProfiles.set("wtp_b", makeProfile({ profile_id: "wtp_b", created_at: "2026-01-01T00:00:00.000Z" }));
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles" });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.length).toBe(2);
    // Sorted by created_at desc
    expect(data[0].profile_id).toBe("wtp_a");
  });

  it("returns empty list when no profiles exist", async () => {
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles" });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data).toEqual([]);
  });
});

// ─── 3. GET /api/website-trust-profiles/by-domain/:domain ───────────────────

describe("GET /api/website-trust-profiles/by-domain/:domain", () => {
  it("returns active profile for domain", async () => {
    websiteTrustProfiles.set("wtp_t", makeProfile({ profile_id: "wtp_t", domain: "find.local", status: "active" }));
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles/by-domain/find.local" });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.profile_id).toBe("wtp_t");
  });

  it("returns 404 for unknown domain", async () => {
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles/by-domain/unknown.local" });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("PROFILE_NOT_FOUND");
  });

  it("ignores revoked profiles", async () => {
    websiteTrustProfiles.set("wtp_rev", makeProfile({ profile_id: "wtp_rev", domain: "revoked.local", status: "revoked" }));
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles/by-domain/revoked.local" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 4. GET /api/website-trust-profiles/:profileId ───────────────────────────

describe("GET /api/website-trust-profiles/:profileId", () => {
  it("returns the profile", async () => {
    websiteTrustProfiles.set("wtp_x", makeProfile({ profile_id: "wtp_x" }));
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles/wtp_x" });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.profile_id).toBe("wtp_x");
  });

  it("returns 404 for unknown profile_id", async () => {
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles/wtp_does_not_exist" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 5. PATCH /api/website-trust-profiles/:profileId/status ─────────────────

describe("PATCH /api/website-trust-profiles/:profileId/status", () => {
  it("revokes an active profile", async () => {
    websiteTrustProfiles.set("wtp_rev", makeProfile({ profile_id: "wtp_rev" }));
    const res = await server.inject({
      method: "PATCH",
      url: "/api/website-trust-profiles/wtp_rev/status",
      headers: { "content-type": "application/json" },
      payload: { status: "revoked", suspension_reason: "Policy violation in testing." },
    });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.status).toBe("revoked");
    expect(data.suspension_reason).toBe("Policy violation in testing.");
  });

  it("preserves original profile_hash after revoke", async () => {
    const original = makeProfile({ profile_id: "wtp_hash_test", profile_hash: "original_hash_abc" });
    websiteTrustProfiles.set("wtp_hash_test", original);
    const res = await server.inject({
      method: "PATCH",
      url: "/api/website-trust-profiles/wtp_hash_test/status",
      headers: { "content-type": "application/json" },
      payload: { status: "revoked" },
    });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    // profile_hash must not change — it records what was declared
    expect(data.profile_hash).toBe("original_hash_abc");
  });

  it("rejects status change on already-revoked profile", async () => {
    websiteTrustProfiles.set("wtp_already", makeProfile({ profile_id: "wtp_already", status: "revoked" }));
    const res = await server.inject({
      method: "PATCH",
      url: "/api/website-trust-profiles/wtp_already/status",
      headers: { "content-type": "application/json" },
      payload: { status: "revoked" },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("rejects unknown status values", async () => {
    websiteTrustProfiles.set("wtp_bad", makeProfile({ profile_id: "wtp_bad" }));
    const res = await server.inject({
      method: "PATCH",
      url: "/api/website-trust-profiles/wtp_bad/status",
      headers: { "content-type": "application/json" },
      payload: { status: "active" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── 6. GET /api/website-trust-profiles/:profileId/verify ───────────────────

describe("GET /api/website-trust-profiles/:profileId/verify", () => {
  it("returns valid=true for a profile created via POST (hash is correctly computed)", async () => {
    // Create via POST so buildSignedWebsiteTrustProfile (mocked) computes the canonical hash
    const createRes = await server.inject({
      method: "POST",
      url: "/api/website-trust-profiles",
      headers: { "content-type": "application/json" },
      payload: { ...VALID_BODY, domain: "verifytest.local" },
    });
    expect(createRes.statusCode).toBe(201);
    const { data: created } = JSON.parse(createRes.body);

    const res = await server.inject({ method: "GET", url: `/api/website-trust-profiles/${created.profile_id}/verify` });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.valid).toBe(true);
    expect(data.hash_valid).toBe(true);
    expect(data.signature_valid).toBe(true);
  });

  it("returns hash_valid=false after tampering with a field", async () => {
    // Create a profile with a real hash, then tamper with a field
    const createRes = await server.inject({
      method: "POST",
      url: "/api/website-trust-profiles",
      headers: { "content-type": "application/json" },
      payload: { ...VALID_BODY, domain: "tamper.local" },
    });
    expect(createRes.statusCode).toBe(201);
    const { data: created } = JSON.parse(createRes.body);

    // Tamper: mutate company_name after the hash was computed
    const stored = websiteTrustProfiles.get(created.profile_id)!;
    websiteTrustProfiles.set(created.profile_id, { ...stored, company_name: "Tampered Name" });

    const res = await server.inject({ method: "GET", url: `/api/website-trust-profiles/${created.profile_id}/verify` });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.valid).toBe(false);
    expect(data.hash_valid).toBe(false);
  });

  it("returns SIGNING_KEY_UNAVAILABLE for an unsigned profile", async () => {
    // makeProfile with jws_present=false and a fixed hash (unsigned, so no JWS to validate)
    // The mock returns SIGNING_KEY_UNAVAILABLE when jws_present=false
    const unsigned = makeProfile({ profile_id: "wtp_unsigned", profile_jws: undefined, jws_present: false });
    // Use a fixed hash that matches the profile fields to make hash_valid=true but signature_valid=false
    // We don't need hash_valid=true here; the point is valid=false with SIGNING_KEY_UNAVAILABLE
    websiteTrustProfiles.set("wtp_unsigned", unsigned);
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles/wtp_unsigned/verify" });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.valid).toBe(false);
    expect(data.error).toBe("SIGNING_KEY_UNAVAILABLE");
  });

  it("returns 404 for unknown profile", async () => {
    const res = await server.inject({ method: "GET", url: "/api/website-trust-profiles/wtp_nope/verify" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 7. Agent endpoint: GET /api/agent/v1/website-trust/:domain ──────────────

describe("GET /api/agent/v1/website-trust/:domain", () => {
  const headers = { "authorization": `Bearer ${AGENT_TOKEN}` };

  it("returns profile_found=false for unknown domain", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/website-trust/unknown.local", headers });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.profile_found).toBe(false);
    expect(data.warning).toBeTruthy();
  });

  it("returns agent-safe profile for known domain", async () => {
    const profile = makeProfile({
      profile_id: "wtp_agent",
      domain: "agent.local",
      safety_promises: [
        { promise_id: "site_will_not_prompt_inject_agents", title: "No Prompt Injection", description: "Test.", severity_if_violated: "critical", committed: true },
        { promise_id: "site_will_not_request_secrets_outside_approved_flows", title: "Secrets", description: "Test.", severity_if_violated: "critical", committed: false },
      ],
      accountability_contact: "trust@agent.local",
      suspension_reason: "internal note",
    });
    websiteTrustProfiles.set("wtp_agent", profile);

    const res = await server.inject({ method: "GET", url: "/api/agent/v1/website-trust/agent.local", headers });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);

    expect(data.profile_found).toBe(true);
    expect(data.profile_id).toBe("wtp_agent");
    expect(data.domain).toBe("agent.local");
    expect(data.profile_hash).toBeTruthy();

    // Only committed promises are returned
    expect(data.safety_promises).toHaveLength(1);
    expect(data.safety_promises[0].committed).toBe(true);

    // Excluded fields must not appear
    expect(data).not.toHaveProperty("profile_jws");
    expect(data).not.toHaveProperty("accountability_contact");
    expect(data).not.toHaveProperty("suspension_reason");
  });

  it("includes warning for unverified profile", async () => {
    websiteTrustProfiles.set("wtp_unv", makeProfile({ profile_id: "wtp_unv", domain: "unverified.local", verification_status: "unverified" }));
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/website-trust/unverified.local", headers });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    expect(data.profile_found).toBe(true);
    expect(data.warning).toContain("unverified");
  });

  it("returns 401 without auth token", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/website-trust/test.local" });
    expect(res.statusCode).toBe(401);
  });
});

// ─── 8. Secret safety ────────────────────────────────────────────────────────

describe("Secret safety", () => {
  it("profile JSON does not contain secret-like values", () => {
    const profile = makeProfile();
    const json = JSON.stringify(profile);
    expect(json).not.toMatch(/devvault:\/\//);
    expect(json).not.toMatch(/secret_ref/);
    expect(json).not.toMatch(/cdp_url/);
    expect(json).not.toMatch(/storageState/);
  });
});
