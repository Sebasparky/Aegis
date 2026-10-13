/**
 * Bearer token never echoed by the external-agent API.
 *
 * The delegation token is the agent's only credential. It must not appear in any
 * `/api/agent/v1` response body — success or failure — nor in any prefix, hash, or
 * encoding. Uses a canary pass whose id differs from its token so the id may appear
 * while the token must not. Companion to the adapter/tool-server stdout/stderr tests.
 */

import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer, seedTestData, IDS } from "./helpers.js";
import { agentDelegations, passes } from "../store/index.js";

const CANARY = "canary_tok_3e7a9d1c5b2f8e4d0066";
const MATERIAL = [
  CANARY,
  CANARY.slice(0, 10),
  CANARY.slice(-10),
  Buffer.from(CANARY).toString("base64"),
  Buffer.from(CANARY).toString("hex"),
];
const PASS_ID = "pass_canary_distinct_id";
const DELEGATION_ID = "deleg_canary_distinct_id";

function expectNoTokenMaterial(body: string): void {
  for (const needle of MATERIAL) expect(body).not.toContain(needle);
}

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  const NOW = "2026-05-01T00:00:00.000Z";
  const EXPIRY = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set(PASS_ID, {
    id: PASS_ID, token: CANARY, user_id: IDS.USER, agent_name: "agent_canary",
    default_collar_id: IDS.COLLAR, status: "active", expires_at: EXPIRY, created_at: NOW,
  });
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID, user_id: IDS.USER, user_aegis_id: "aid_user_001", agent_name: "agent_canary",
    agent_platform: "api", channel: "api", default_collar_id: IDS.COLLAR, status: "active",
    token_id: PASS_ID, skill_access_mode: "all", skill_access_skill_ids: [], created_at: NOW, updated_at: NOW,
  });
  server = await buildTestServer();
});

afterAll(async () => {
  await server.close();
});

describe("GET /api/agent/v1/me", () => {
  it("resolves the canary token and never echoes it", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/me", headers: { authorization: `Bearer ${CANARY}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("agent_canary");
    expectNoTokenMaterial(res.body);
    expectNoTokenMaterial(JSON.stringify(res.headers));
  });

  it("401 for an unknown token does not echo the presented token", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/me", headers: { authorization: `Bearer ${CANARY}_wrong` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
    expectNoTokenMaterial(res.body);
  });

  it("401 for a malformed header does not echo the header", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/me", headers: { authorization: `Basic ${CANARY}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("AUTH_REQUIRED");
    expectNoTokenMaterial(res.body);
  });

  it("401 for a revoked pass does not echo the token", async () => {
    const pass = passes.get(PASS_ID)!;
    pass.status = "revoked";
    try {
      const res = await server.inject({ method: "GET", url: "/api/agent/v1/me", headers: { authorization: `Bearer ${CANARY}` } });
      expect(res.statusCode).toBe(401);
      expectNoTokenMaterial(res.body);
    } finally {
      pass.status = "active";
    }
  });
});

describe("other agent endpoints", () => {
  it("skills listing never echoes the token", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/skills", headers: { authorization: `Bearer ${CANARY}` } });
    expect([200, 404]).toContain(res.statusCode);
    expectNoTokenMaterial(res.body);
  });

  it("a 404 for an unknown run never echoes the token", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/runs/run_does_not_exist", headers: { authorization: `Bearer ${CANARY}` } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expectNoTokenMaterial(res.body);
  });
});
