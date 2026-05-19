import { vi } from "vitest";

// Must be hoisted before route imports to suppress disk writes.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer, seedTestData, IDS } from "./helpers.js";
import { agentDelegations, passes } from "../store/index.js";
import { validatePassToken } from "../services/passValidator.js";
import type { PassWithToken } from "../store/index.js";

// ─── Server (for requireAgentToken tests through route-runs.ts) ──────────────

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  server = await buildTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  // Reset delegation state modified by tests
  const del = agentDelegations.get(IDS.DELEGATION_ALL);
  if (del) {
    del.status = "active";
    del.expires_at = undefined;
    del.updated_at = "2026-05-01T00:00:00.000Z";
  }
  passes.clear();
});

// ─── requireAgentToken — via POST /api/skills/:skillId/runs (route-runs.ts) ──

describe("requireAgentToken — delegation expiry enforcement", () => {
  it("succeeds for active delegation with no expires_at", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    // Auth passes; skill not installed → 403 SKILL_NOT_INSTALLED
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SKILL_NOT_INSTALLED");
  });

  it("succeeds for active delegation with expires_at in the future", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    delegation.expires_at = new Date(Date.now() + 3_600_000).toISOString();

    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SKILL_NOT_INSTALLED");
  });

  it("returns 401 DELEGATION_EXPIRED when expires_at is in the past", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    delegation.expires_at = new Date(Date.now() - 1_000).toISOString();

    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_EXPIRED");
  });

  it("returns 401 DELEGATION_EXPIRED when status is already 'expired'", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    delegation.status = "expired";

    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_EXPIRED");
  });

  it("lazily updates delegation.status to 'expired' on time-based expiry", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    delegation.expires_at = new Date(Date.now() - 1_000).toISOString();

    await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });

    // Delegation status must be lazily written to "expired"
    const updated = agentDelegations.get(IDS.DELEGATION_ALL)!;
    expect(updated.status).toBe("expired");
  });

  it("returns 401 DELEGATION_REVOKED when delegation is revoked", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    delegation.status = "revoked";

    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_REVOKED");
  });

  it("returns 401 INVALID_TOKEN for an unknown token", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: "Bearer totally_unknown_token", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });
});

// ─── validatePassToken — delegation check (unit-level) ───────────────────────

const PASS_ID = "pass_test_vp_001";
const RAW_TOKEN = "aegis_pass_test_vp_secret";
const DELEGATION_ID = "delg_test_vp_001";

function seedPass() {
  const pass: PassWithToken = {
    id: PASS_ID,
    token: RAW_TOKEN,
    user_id: "user_001",
    agent_name: "TestAgent",
    status: "active",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
  };
  passes.set(PASS_ID, pass);
  return pass;
}

function seedDelegation(overrides: Partial<{ status: string; expires_at: string }> = {}) {
  const del = {
    id: DELEGATION_ID,
    user_id: "user_001",
    user_aegis_id: "aid_user_001",
    agent_name: "TestAgent",
    channel: "api" as const,
    status: (overrides.status ?? "active") as "active" | "revoked" | "expired",
    token_id: PASS_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(overrides.expires_at ? { expires_at: overrides.expires_at } : {}),
  };
  agentDelegations.set(DELEGATION_ID, del as any);
  return del;
}

describe("validatePassToken — delegation expiry enforcement", () => {
  beforeEach(() => {
    passes.clear();
    // Remove test delegation if present
    agentDelegations.delete(DELEGATION_ID);
  });

  it("succeeds with active pass and active delegation", () => {
    seedPass();
    seedDelegation();
    const result = validatePassToken(RAW_TOKEN);
    expect(result.ok).toBe(true);
  });

  it("sets last_used_at on the pass when both are valid", () => {
    seedPass();
    seedDelegation();
    validatePassToken(RAW_TOKEN);
    expect((passes.get(PASS_ID) as any).last_used_at).toBeDefined();
  });

  it("returns DELEGATION_NOT_FOUND when no delegation is linked to the pass", () => {
    seedPass();
    // No delegation seeded
    const result = validatePassToken(RAW_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DELEGATION_NOT_FOUND");
  });

  it("does not set last_used_at when delegation is missing", () => {
    seedPass();
    validatePassToken(RAW_TOKEN);
    expect((passes.get(PASS_ID) as any).last_used_at).toBeUndefined();
  });

  it("returns DELEGATION_REVOKED when delegation status is revoked", () => {
    seedPass();
    seedDelegation({ status: "revoked" });
    const result = validatePassToken(RAW_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DELEGATION_REVOKED");
  });

  it("returns DELEGATION_EXPIRED when delegation status is already expired", () => {
    seedPass();
    seedDelegation({ status: "expired" });
    const result = validatePassToken(RAW_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DELEGATION_EXPIRED");
  });

  it("returns DELEGATION_EXPIRED when delegation expires_at is in the past", () => {
    seedPass();
    seedDelegation({ expires_at: new Date(Date.now() - 1_000).toISOString() });
    const result = validatePassToken(RAW_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DELEGATION_EXPIRED");
  });

  it("lazily updates delegation.status to 'expired' on time-based expiry", () => {
    seedPass();
    seedDelegation({ expires_at: new Date(Date.now() - 1_000).toISOString() });
    validatePassToken(RAW_TOKEN);
    expect(agentDelegations.get(DELEGATION_ID)!.status).toBe("expired");
  });

  it("does not set last_used_at when delegation is expired", () => {
    seedPass();
    seedDelegation({ status: "expired" });
    validatePassToken(RAW_TOKEN);
    expect((passes.get(PASS_ID) as any).last_used_at).toBeUndefined();
  });
});
