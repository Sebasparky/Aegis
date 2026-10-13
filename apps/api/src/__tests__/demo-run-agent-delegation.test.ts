/**
 * Regression: /demo "Run Agent Demo" failed with
 *   "No active delegation is linked to this pass." (DELEGATION_NOT_FOUND)
 *
 * Root cause: the demo page minted its agent token with the legacy
 * POST /api/passes, which creates a bare pass with no AgentDelegation. Since
 * 99f04bb, validatePassToken fails closed unless an active delegation is linked
 * to the pass (delegation.token_id === pass.id), so create-session rejected it.
 *
 * Fix: the demo creates its pass through POST /api/delegations
 * (createDelegationWithPass), which links pass + delegation atomically.
 * Authorization is unchanged — an unlinked pass is still rejected.
 */
import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// No real Chromium: the protected-session launch is not what this test covers.
vi.mock("../browser/browserManager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser/browserManager.js")>();
  return { ...actual, createBrowserSession: vi.fn().mockResolvedValue(undefined) };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { seedTestData, resetStore } from "./helpers.js";
import { collarRoutes } from "../routes/collars.js";
import { passRoutes } from "../routes/passes.js";
import { delegationRoutes } from "../routes/delegations.js";
import { agentRoutes } from "../routes/agent.js";
import { agentDelegations, passes } from "../store/index.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(collarRoutes);
  await server.register(passRoutes);
  await server.register(delegationRoutes);
  await server.register(agentRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetStore();
  seedTestData();
});

async function firstCollarId(): Promise<string> {
  const res = await server.inject({ method: "GET", url: "/api/collars" });
  expect(res.statusCode).toBe(200);
  const collars = res.json().data as Array<{ id: string; status: string }>;
  expect(collars.length).toBeGreaterThan(0);
  return collars[0].id;
}

function createSession(token: string) {
  return server.inject({
    method: "POST",
    url: "/api/agent/create-session",
    payload: { agent_pass_token: token, purpose: "Antigen Demo", mode: "headless" },
  });
}

describe("/demo Run Agent Demo — pass/delegation linkage", () => {
  it("demo flow: a pass created via POST /api/delegations is linked and can start a session", async () => {
    const collarId = await firstCollarId();
    const res = await server.inject({
      method: "POST",
      url: "/api/delegations",
      payload: { agent_name: "Demo Agent", channel: "api", default_collar_id: collarId, expires_in_minutes: 30 },
    });
    expect(res.statusCode).toBe(200);
    const { delegation, delegation_token } = res.json().data;
    expect(typeof delegation_token).toBe("string");
    expect(delegation.status).toBe("active");

    // Linkage invariant the validator relies on.
    const pass = Array.from(passes.values()).find((p) => p.token === delegation_token);
    expect(pass).toBeDefined();
    expect(agentDelegations.get(delegation.id)?.token_id).toBe(pass!.id);
    expect(pass!.default_collar_id).toBe(collarId);

    const sess = await createSession(delegation_token);
    expect(sess.statusCode).toBe(200);
    expect(sess.json().data.session_id).toMatch(/^sess_/);
    expect(sess.json().data.collar_id).toBe(collarId);
  });

  it("authorization preserved: a bare POST /api/passes pass (no delegation) is still rejected", async () => {
    const collarId = await firstCollarId();
    const res = await server.inject({
      method: "POST",
      url: "/api/passes",
      payload: { agent_name: "Demo Agent", default_collar_id: collarId, expires_in_minutes: 30 },
    });
    expect(res.statusCode).toBe(200);
    const token = res.json().data.token as string;

    const sess = await createSession(token);
    expect(sess.statusCode).toBe(401);
    expect(sess.json().error.code).toBe("DELEGATION_NOT_FOUND");
    // Never echo the token back.
    expect(sess.body).not.toContain(token);
  });

  it("a revoked demo delegation can no longer start a session", async () => {
    const collarId = await firstCollarId();
    const created = (await server.inject({
      method: "POST",
      url: "/api/delegations",
      payload: { agent_name: "Demo Agent", channel: "api", default_collar_id: collarId, expires_in_minutes: 30 },
    })).json().data;
    const rev = await server.inject({
      method: "POST",
      url: `/api/delegations/${created.delegation.id}/revoke`,
      payload: {},
    });
    expect(rev.statusCode).toBe(200);
    const sess = await createSession(created.delegation_token);
    expect(sess.statusCode).toBe(401);
  });

  it("the /demo page mints its agent token via createDelegation, not the unlinked createPass", () => {
    const page = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/src/app/demo/page.tsx"),
      "utf-8",
    );
    expect(page).toMatch(/\bcreateDelegation\(/);
    expect(page).not.toMatch(/\bcreatePass\(/);
  });
});
