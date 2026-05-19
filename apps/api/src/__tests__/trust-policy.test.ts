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

// Route-run approve now requires signed ActionAuthorizationReceipt before releasing authority.
// Mock signing so tests don't require real EdDSA keys.
vi.mock("../lib/actionAuthorizationSigning.js", () => ({
  hashActionAuthorization: vi.fn().mockReturnValue("mock_auth_hash"),
  signActionAuthorizationJws: vi.fn().mockResolvedValue("mock.authz.jws"),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestServer,
  seedTestData,
  installSkill,
  injectRun,
  IDS,
} from "./helpers.js";
import { agentDelegations, routeRuns, routeRunReceipts, installedSkills } from "../store/index.js";

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  server = await buildTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  routeRuns.clear();
  routeRunReceipts.clear();
  installedSkills.clear();
});

// ─── 1. Token auth ────────────────────────────────────────────────────────────

describe("Token auth — POST /api/skills/:skillId/runs", () => {
  it("returns 401 AUTH_REQUIRED when Authorization header is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns 401 INVALID_TOKEN for an unrecognized bearer token", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: "Bearer token_does_not_exist", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });

  it("returns 401 DELEGATION_REVOKED when the delegation is revoked", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    delegation.status = "revoked";
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    delegation.status = "active";
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_REVOKED");
  });

  it("returns 403 SKILL_NOT_INSTALLED when skill exists but is not installed", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SKILL_NOT_INSTALLED");
  });

  it("returns 404 SKILL_NOT_FOUND for an unknown skillId", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/skills/skill_unknown/runs",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SKILL_NOT_FOUND");
  });

  it("creates a pending run and derives agent_id / delegation_id / collar_id from token", async () => {
    installSkill(IDS.SKILL_WIKI);
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const run = body.data;
    expect(run.status).toBe("pending");
    expect(run.skill_id).toBe(IDS.SKILL_WIKI);
    expect(run.user_id).toBe(IDS.USER);
    expect(run.agent_id).toBe("agent_demo_001");
    expect(run.delegation_id).toBe(IDS.DELEGATION_ALL);
    expect(run.collar_id).toBe(IDS.COLLAR);
    expect(run.run_id).toMatch(/^run_/);
  });

  it("ignores agent_id in the request body — always uses token-derived value", async () => {
    installSkill(IDS.SKILL_WIKI);
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: { agent_id: "attacker_agent" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agent_id).toBe("agent_demo_001");
  });
});

// ─── 2. Token-scoped skill discovery ─────────────────────────────────────────

describe("GET /api/skills?installed=true — token-scoped discovery", () => {
  beforeEach(() => {
    installSkill(IDS.SKILL_WIKI);
    installSkill(IDS.SKILL_PURCHASE);
    installSkill(IDS.SKILL_BLOCKED);
  });

  it("returns all installed skills with no token (web UI path)", async () => {
    const res = await server.inject({ method: "GET", url: "/api/skills?installed=true" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(3);
    expect(body.data.every((s: Record<string, unknown>) => s.installed === true)).toBe(true);
  });

  it("mode=all delegation sees all installed skills", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/skills?installed=true",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(3);
  });

  it("mode=only with empty skill_ids sees no installed skills", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/skills?installed=true",
      headers: { authorization: `Bearer ${IDS.TOKEN_RESTRICTED}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it("mode=only with [SKILL_WIKI] sees only that skill", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_RESTRICTED)!;
    delegation.skill_access_skill_ids = [IDS.SKILL_WIKI];
    const res = await server.inject({
      method: "GET",
      url: "/api/skills?installed=true",
      headers: { authorization: `Bearer ${IDS.TOKEN_RESTRICTED}` },
    });
    delegation.skill_access_skill_ids = [];
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toHaveLength(1);
    expect(data[0].skill_id).toBe(IDS.SKILL_WIKI);
  });

  it("returns 401 INVALID_TOKEN for bad token on installed-skills query", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/skills?installed=true",
      headers: { authorization: "Bearer bad_token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });

  it("returns all marketplace skills with no token and no installed filter", async () => {
    const res = await server.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── 3. Skill-access policy ───────────────────────────────────────────────────

describe("Skill-access policy — POST /api/skills/:skillId/runs", () => {
  beforeEach(() => {
    installSkill(IDS.SKILL_WIKI);
    installSkill(IDS.SKILL_PURCHASE);
    installSkill(IDS.SKILL_BLOCKED);
  });

  it("mode=all allows any installed skill", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("pending");
  });

  it("mode=only with empty list returns 403 SKILL_ACCESS_DENIED", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_RESTRICTED}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SKILL_ACCESS_DENIED");
  });

  it("mode=only with matching skill_id allows that skill", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_RESTRICTED)!;
    delegation.skill_access_skill_ids = [IDS.SKILL_WIKI];
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_RESTRICTED}`, "content-type": "application/json" },
      payload: {},
    });
    delegation.skill_access_skill_ids = [];
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("pending");
  });

  it("mode=exclude blocks the listed skill with SKILL_ACCESS_DENIED", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    const origMode = delegation.skill_access_mode;
    const origIds = delegation.skill_access_skill_ids;
    delegation.skill_access_mode = "exclude";
    delegation.skill_access_skill_ids = [IDS.SKILL_WIKI];
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    delegation.skill_access_mode = origMode;
    delegation.skill_access_skill_ids = origIds;
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SKILL_ACCESS_DENIED");
  });

  it("mode=exclude allows skills not in the exclude list", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    const origMode = delegation.skill_access_mode;
    const origIds = delegation.skill_access_skill_ids;
    delegation.skill_access_mode = "exclude";
    delegation.skill_access_skill_ids = [IDS.SKILL_PURCHASE];
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    delegation.skill_access_mode = origMode;
    delegation.skill_access_skill_ids = origIds;
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("pending");
  });
});

// ─── 4. Collar policy ─────────────────────────────────────────────────────────

describe("Collar policy — POST /api/skills/:skillId/runs", () => {
  beforeEach(() => {
    installSkill(IDS.SKILL_WIKI);
    installSkill(IDS.SKILL_PURCHASE);
    installSkill(IDS.SKILL_BLOCKED);
  });

  it("browse permission creates a pending run", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe("pending");
    expect(data.approval_required_permissions).toBeUndefined();
  });

  it("purchase permission creates a pending_approval run", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_PURCHASE}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.run.status).toBe("pending_approval");
    expect(body.data.approval_required).toBe(true);
    expect(body.data.approval_required_permissions).toContain("purchase");
    expect(body.data.run.run_id).toMatch(/^run_/);
  });

  it("identity_disclosure permission returns 403 COLLAR_BLOCKED", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_BLOCKED}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("COLLAR_BLOCKED");
    expect(body.error.details).toContain("identity_disclosure");
  });

  it("no collar_id on delegation is blocked with 403 COLLAR_REQUIRED", async () => {
    installSkill(IDS.SKILL_BLOCKED);
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_BLOCKED}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("COLLAR_REQUIRED");
  });
});

// ─── 5. No-collar agent behavior ─────────────────────────────────────────────

describe("No-collar agent — connected but no rule set", () => {
  beforeEach(() => {
    installSkill(IDS.SKILL_WIKI);
    installSkill(IDS.SKILL_PURCHASE);
    installSkill(IDS.SKILL_BLOCKED);
  });

  it("GET /api/agent/v1/me returns 200 with no collar_id", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.agent_id).toBe("agent_demo_no_collar");
    expect(body.data.default_collar_id).toBeUndefined();
  });

  it("GET /api/agent/v1/skills returns 200", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/skills",
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("POST /api/skills/:skillId/runs returns 403 COLLAR_REQUIRED", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("COLLAR_REQUIRED");
    expect(body.error.message).toContain("no rule set");
  });

  it("POST /api/agent/v1/runs returns 403 COLLAR_REQUIRED", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runs",
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: { skill_id: IDS.SKILL_WIKI },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("COLLAR_REQUIRED");
    expect(body.error.message).toContain("no rule set");
  });

  it("POST /api/agent/v1/injections returns 403 COLLAR_REQUIRED", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections",
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: {
        domain: "github.com",
        field_kind: "username",
        page_url: "https://github.com/login",
        reason: "Login to GitHub",
      },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("COLLAR_REQUIRED");
  });

  it("POST /api/agent/v1/injections/:id/execute returns 403 COLLAR_REQUIRED", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/injections/inj_nonexistent/execute",
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("COLLAR_REQUIRED");
  });
});

// ─── 6. Active-collar agent regression ───────────────────────────────────────

describe("Active-collar agent regression — behavior unchanged", () => {
  beforeEach(() => {
    installSkill(IDS.SKILL_WIKI);
    installSkill(IDS.SKILL_PURCHASE);
    installSkill(IDS.SKILL_BLOCKED);
  });

  it("POST /api/skills/:skillId/runs with allowed permission → pending", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("pending");
  });

  it("POST /api/skills/:skillId/runs with approval_required permission → pending_approval", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_PURCHASE}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.approval_required).toBe(true);
    expect(body.data.run.status).toBe("pending_approval");
  });

  it("POST /api/skills/:skillId/runs with blocked permission → 403 COLLAR_BLOCKED", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_BLOCKED}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("COLLAR_BLOCKED");
  });

  it("POST /api/agent/v1/runs with active collar and allowed skill → pending run", async () => {
    // SKILL_WIKI requires "browse" which is in allowed_actions; skill must be installed
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runs",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: { skill_id: IDS.SKILL_WIKI },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.run.status).toBe("pending");
    expect(body.data.approval_required).toBe(false);
  });
});

// ─── 5. RouteRun state machine ────────────────────────────────────────────────

describe("RouteRun state machine", () => {
  it("pending →start→ running", async () => {
    injectRun("run_sm_001", "pending");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_001/start" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe("running");
    expect(data.started_at).toBeDefined();
  });

  it("pending_approval →start→ 409 INVALID_STATE", async () => {
    injectRun("run_sm_002", "pending_approval");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_002/start" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVALID_STATE");
  });

  it("running →start→ 409 INVALID_STATE", async () => {
    injectRun("run_sm_003", "running");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_003/start" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVALID_STATE");
  });

  it("running →complete→ completed", async () => {
    injectRun("run_sm_004", "running");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_004/complete" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe("completed");
    expect(data.completed_at).toBeDefined();
  });

  it("pending →complete→ 409 INVALID_STATE", async () => {
    injectRun("run_sm_005", "pending");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_005/complete" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVALID_STATE");
  });

  it("completed →complete→ 409 ALREADY_TERMINAL", async () => {
    injectRun("run_sm_006", "completed");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_006/complete" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ALREADY_TERMINAL");
  });

  it("running →fail→ failed with error message", async () => {
    injectRun("run_sm_007", "running");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_sm_007/fail",
      headers: { "content-type": "application/json" },
      payload: { error: "Navigation timeout" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe("failed");
    expect(data.error).toBe("Navigation timeout");
  });

  it("failed →fail→ 409 ALREADY_TERMINAL", async () => {
    injectRun("run_sm_008", "failed");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_sm_008/fail",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ALREADY_TERMINAL");
  });

  it("blocked →fail→ 409 ALREADY_TERMINAL", async () => {
    injectRun("run_sm_009", "blocked");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_sm_009/fail",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ALREADY_TERMINAL");
  });

  it("pending_approval →approve→ pending", async () => {
    injectRun("run_sm_010", "pending_approval");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_010/approve" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("pending");
  });

  it("pending →approve→ 400 INVALID_STATE", async () => {
    injectRun("run_sm_011", "pending");
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_sm_011/approve" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_STATE");
  });

  it("pending_approval →reject→ blocked with reason", async () => {
    injectRun("run_sm_012", "pending_approval");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_sm_012/reject",
      headers: { "content-type": "application/json" },
      payload: { reason: "User denied" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe("blocked");
    expect(data.error).toBe("User denied");
  });

  it("running →reject→ 400 INVALID_STATE", async () => {
    injectRun("run_sm_013", "running");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_sm_013/reject",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_STATE");
  });

  it("unknown run ID returns 404 NOT_FOUND", async () => {
    const res = await server.inject({ method: "POST", url: "/api/route-runs/run_unknown/start" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

// ─── 6. Receipts ──────────────────────────────────────────────────────────────

describe("Receipts — created on complete/fail, no duplicates", () => {
  it("complete creates a receipt with status=completed", async () => {
    injectRun("run_rcpt_001", "running");
    await server.inject({ method: "POST", url: "/api/route-runs/run_rcpt_001/complete" });

    const allReceipts = Array.from(routeRunReceipts.values());
    expect(allReceipts).toHaveLength(1);
    const receipt = allReceipts[0];
    expect(receipt.run_id).toBe("run_rcpt_001");
    expect(receipt.status).toBe("completed");
    expect(receipt.receipt_id).toMatch(/^rrreceipt_/);
    expect(receipt.skill_id).toBe(IDS.SKILL_WIKI);
    expect(receipt.user_id).toBe(IDS.USER);
    expect(receipt.execution_surface).toBe("chrome_extension");
    expect(receipt.completed_at).toBeDefined();
  });

  it("fail creates a receipt with status=failed and error field", async () => {
    injectRun("run_rcpt_002", "running");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_rcpt_002/fail",
      headers: { "content-type": "application/json" },
      payload: { error: "Locator not found" },
    });

    const allReceipts = Array.from(routeRunReceipts.values());
    expect(allReceipts).toHaveLength(1);
    const receipt = allReceipts[0];
    expect(receipt.status).toBe("failed");
    expect(receipt.error).toBe("Locator not found");
  });

  it("calling complete twice does not create a duplicate receipt", async () => {
    injectRun("run_rcpt_003", "running");
    await server.inject({ method: "POST", url: "/api/route-runs/run_rcpt_003/complete" });
    await server.inject({ method: "POST", url: "/api/route-runs/run_rcpt_003/complete" });

    const forThisRun = Array.from(routeRunReceipts.values()).filter(
      (r) => r.run_id === "run_rcpt_003"
    );
    expect(forThisRun).toHaveLength(1);
  });

  it("GET /api/route-run-receipts lists completed receipts", async () => {
    injectRun("run_rcpt_004", "running");
    await server.inject({ method: "POST", url: "/api/route-runs/run_rcpt_004/complete" });

    const res = await server.inject({ method: "GET", url: "/api/route-run-receipts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const runIds = body.data.map((r: Record<string, unknown>) => r.run_id);
    expect(runIds).toContain("run_rcpt_004");
  });

  it("GET /api/route-run-receipts/:receiptId returns single receipt", async () => {
    injectRun("run_rcpt_005", "running");
    await server.inject({ method: "POST", url: "/api/route-runs/run_rcpt_005/complete" });

    const receiptId = Array.from(routeRunReceipts.values())[0].receipt_id;
    const res = await server.inject({ method: "GET", url: `/api/route-run-receipts/${receiptId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.receipt_id).toBe(receiptId);
  });

  it("approve and reject transitions do not create receipts", async () => {
    injectRun("run_rcpt_006", "pending_approval");
    await server.inject({ method: "POST", url: "/api/route-runs/run_rcpt_006/approve" });

    injectRun("run_rcpt_007", "pending_approval");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_rcpt_007/reject",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(routeRunReceipts.size).toBe(0);
  });
});

// ─── 7. Full lifecycle happy paths ────────────────────────────────────────────

describe("Full RouteRun lifecycle", () => {
  it("allowed skill: create → start → complete → receipt", async () => {
    installSkill(IDS.SKILL_WIKI);

    const createRes = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(createRes.statusCode).toBe(200);
    const runId: string = createRes.json().data.run_id;

    const startRes = await server.inject({ method: "POST", url: `/api/route-runs/${runId}/start` });
    expect(startRes.json().data.status).toBe("running");

    const completeRes = await server.inject({ method: "POST", url: `/api/route-runs/${runId}/complete` });
    expect(completeRes.json().data.status).toBe("completed");

    const receipts = Array.from(routeRunReceipts.values());
    expect(receipts).toHaveLength(1);
    expect(receipts[0].run_id).toBe(runId);
    expect(receipts[0].status).toBe("completed");
  });

  it("approval-gated skill: create → approve → start → complete → receipt", async () => {
    installSkill(IDS.SKILL_PURCHASE);

    const createRes = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_PURCHASE}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(createRes.statusCode).toBe(200);
    const body = createRes.json();
    expect(body.data.run.status).toBe("pending_approval");
    const runId: string = body.data.run.run_id;

    const approveRes = await server.inject({ method: "POST", url: `/api/route-runs/${runId}/approve` });
    expect(approveRes.json().data.status).toBe("pending");

    const startRes = await server.inject({ method: "POST", url: `/api/route-runs/${runId}/start` });
    expect(startRes.json().data.status).toBe("running");

    const completeRes = await server.inject({ method: "POST", url: `/api/route-runs/${runId}/complete` });
    expect(completeRes.json().data.status).toBe("completed");

    expect(routeRunReceipts.size).toBe(1);
  });
});
