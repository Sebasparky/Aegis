import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

vi.mock("../runtime/taskBrowserSessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/taskBrowserSessions.js")>();
  return { ...actual, createTaskBrowserSession: vi.fn(), getTaskBrowserSessionForReuse: vi.fn() };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { seedTestData, installSkill, resetStore, IDS } from "./helpers.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { skillRoutes } from "../routes/skills.js";
import { routeRunRoutes } from "../routes/route-runs.js";
import { delegationRoutes } from "../routes/delegations.js";
import { taskBrowserSessionRoutes } from "../routes/task-browser-sessions.js";
import { routes, installedSkills, skills, routeRuns, passes, agentDelegations } from "../store/index.js";
import type { AegisRoute, AgentDelegation } from "@aegis/types";
import type { PassWithToken } from "../store/index.js";

// Bearer token for the "all" delegation (token_id === token === "pass_demo_001")
const AUTH_ALL = { authorization: `Bearer ${IDS.TOKEN_ALL}` };

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(delegationRoutes);
  await server.register(skillRoutes);
  await server.register(routeRunRoutes);
  await server.register(agentApiRoutes);
  await server.register(taskBrowserSessionRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetStore();
  seedTestData();
  installedSkills.clear(); // start every test with no installed skills
  routeRuns.clear();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getSkills(domain?: string) {
  const url = domain ? `/api/agent/v1/skills?domain=${encodeURIComponent(domain)}` : "/api/agent/v1/skills";
  const res = await server.inject({ method: "GET", url, headers: AUTH_ALL });
  expect(res.statusCode).toBe(200);
  return res.json().data as Array<Record<string, unknown>>;
}

async function requestSkillRun(skillId: string, variables: Record<string, string> = {}) {
  const res = await server.inject({
    method: "POST",
    url: `/api/skills/${encodeURIComponent(skillId)}/runs`,
    headers: { ...AUTH_ALL, "content-type": "application/json" },
    payload: { variables },
  });
  return res;
}

// ─── 1. Private verified route appears for the owning delegation ──────────────

describe("Private route discovery — ownership", () => {
  it("returns a verified private route owned by the calling user's delegation", async () => {
    // seedTestData seeds route_demo_wikipedia_001 with creator_aegis_id: "aid_user_001"
    // and trust_tier: "aegis_scanned" — no InstalledSkill record
    const skills = await getSkills();
    const wiki = skills.find((s) => s.skill_id === `private_route:${IDS.ROUTE_WIKI}`);
    expect(wiki).toBeDefined();
    expect(wiki!.source).toBe("private_route");
    expect(wiki!.private_use_ready).toBe(true);
    expect(wiki!.installed).toBe(false);
    expect(wiki!.domain).toBe("en.wikipedia.org");
    expect(wiki!.route_id).toBe(IDS.ROUTE_WIKI);
  });

  it("does NOT return a route whose creator_aegis_id belongs to a different user", async () => {
    // Add a route owned by a different aegis user
    const otherRoute: AegisRoute = {
      route_id: "route_other_user_001",
      version: "1.0.0",
      created_at: "2026-05-01T00:00:00.000Z",
      last_verified_at: "2026-05-01T00:00:00.000Z",
      creator_aegis_id: "aid_user_002", // different user
      trust_tier: "aegis_scanned",
      domain: "en.wikipedia.org",
      workflow_name: "Other User Route",
      workflow_description: "Not owned by user_001.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: [],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
    };
    routes.set(otherRoute.route_id, otherRoute);

    const result = await getSkills();
    const other = result.find((s) => s.route_id === "route_other_user_001");
    expect(other).toBeUndefined();
  });

  it("does NOT return an unverified_draft route even if owned by the user", async () => {
    const draftRoute: AegisRoute = {
      route_id: "route_draft_001",
      version: "1.0.0",
      created_at: "2026-05-01T00:00:00.000Z",
      last_verified_at: "2026-05-01T00:00:00.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "unverified_draft",
      domain: "en.wikipedia.org",
      workflow_name: "Draft Route",
      workflow_description: "Not yet verified.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: [],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
    };
    routes.set(draftRoute.route_id, draftRoute);

    const result = await getSkills();
    const draft = result.find((s) => s.route_id === "route_draft_001");
    expect(draft).toBeUndefined();
  });
});

// ─── 2. Domain filtering ──────────────────────────────────────────────────────

describe("Private route discovery — domain filtering", () => {
  it("returns Wikipedia private route when filtering by en.wikipedia.org (exact match)", async () => {
    const result = await getSkills("en.wikipedia.org");
    const wiki = result.find((s) => s.route_id === IDS.ROUTE_WIKI);
    expect(wiki).toBeDefined();
    expect(wiki!.source).toBe("private_route");
  });

  it("returns empty for wikipedia.org (no fuzzy subdomain matching in v1)", async () => {
    const result = await getSkills("wikipedia.org");
    const wiki = result.find((s) => s.route_id === IDS.ROUTE_WIKI);
    expect(wiki).toBeUndefined();
  });

  it("returns only skills matching the domain — other user-owned routes on different domains are excluded", async () => {
    const result = await getSkills("en.wikipedia.org");
    // route_demo_purchase_001 is on test.aegis.local — should not appear
    const purchase = result.find((s) => s.route_id === IDS.ROUTE_PURCHASE);
    expect(purchase).toBeUndefined();
  });
});

// ─── 3. No duplicate when route is both installed and private-use-ready ───────

describe("Deduplication — installed skill wins, private route not duplicated", () => {
  it("appears only once when the route has both an InstalledSkill record and qualifies as private-use-ready", async () => {
    // Install the Wikipedia skill — this creates an InstalledSkill for skill_demo_wikipedia_001
    installSkill(IDS.SKILL_WIKI);

    const result = await getSkills();
    const wikiEntries = result.filter(
      (s) => s.route_id === IDS.ROUTE_WIKI || s.skill_id === `private_route:${IDS.ROUTE_WIKI}`
    );
    expect(wikiEntries.length).toBe(1);
  });

  it("deduped entry has source: installed_skill when the skill is installed", async () => {
    installSkill(IDS.SKILL_WIKI);

    const result = await getSkills();
    const wiki = result.find((s) => s.route_id === IDS.ROUTE_WIKI);
    expect(wiki!.source).toBe("installed_skill");
    expect(wiki!.installed).toBe(true);
  });
});

// ─── 4. Source labelling ──────────────────────────────────────────────────────

describe("Source labels on skill discovery response", () => {
  it("private routes have source: private_route", async () => {
    const result = await getSkills();
    const wiki = result.find((s) => s.skill_id === `private_route:${IDS.ROUTE_WIKI}`);
    expect(wiki!.source).toBe("private_route");
    expect(wiki!.private_use_ready).toBe(true);
    expect(wiki!.installed).toBe(false);
  });

  it("installed marketplace skills have source: installed_skill and route_id set", async () => {
    installSkill(IDS.SKILL_WIKI);

    const result = await getSkills();
    const installed = result.find((s) => s.skill_id === IDS.SKILL_WIKI);
    expect(installed).toBeDefined();
    expect(installed!.source).toBe("installed_skill");
    expect(installed!.installed).toBe(true);
    expect(installed!.route_id).toBe(IDS.ROUTE_WIKI);
  });

  it("installed skills still work — source and route_id present alongside private routes", async () => {
    installSkill(IDS.SKILL_PURCHASE); // different route/domain

    const result = await getSkills();
    const purchase = result.find((s) => s.skill_id === IDS.SKILL_PURCHASE);
    expect(purchase).toBeDefined();
    expect(purchase!.source).toBe("installed_skill");
    expect(purchase!.route_id).toBe(IDS.ROUTE_PURCHASE);
  });
});

// ─── 5. request_skill_run with private_route: ID ─────────────────────────────

describe("POST /api/skills/:skillId/runs — private_route: ID", () => {
  it("creates a RouteRun against the exact route_id for a private_route skill id", async () => {
    const skillId = `private_route:${IDS.ROUTE_WIKI}`;
    const res = await requestSkillRun(skillId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const run = body.data.run ?? body.data;
    expect(run.route_id).toBe(IDS.ROUTE_WIKI);
    expect(run.domain).toBe("en.wikipedia.org");
    expect(run.skill_id).toBe(skillId);
    expect(run.status).toMatch(/^pending/);
  });

  it("returns 404 for a private_route: id with a non-existent route", async () => {
    const res = await requestSkillRun("private_route:route_does_not_exist");
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error?.code).toBe("ROUTE_NOT_FOUND");
  });

  it("returns 403 when the private route is owned by a different user", async () => {
    const otherRoute: AegisRoute = {
      route_id: "route_other_user_002",
      version: "1.0.0",
      created_at: "2026-05-01T00:00:00.000Z",
      last_verified_at: "2026-05-01T00:00:00.000Z",
      creator_aegis_id: "aid_user_002",
      trust_tier: "aegis_scanned",
      domain: "en.wikipedia.org",
      workflow_name: "Other User Route",
      workflow_description: "Not owned by user_001.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: [],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
    };
    routes.set(otherRoute.route_id, otherRoute);

    const res = await requestSkillRun(`private_route:${otherRoute.route_id}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe("ACCESS_DENIED");
  });

  it("returns 400 when the private route is unverified_draft", async () => {
    const draftRoute: AegisRoute = {
      route_id: "route_draft_002",
      version: "1.0.0",
      created_at: "2026-05-01T00:00:00.000Z",
      last_verified_at: "2026-05-01T00:00:00.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "unverified_draft",
      domain: "en.wikipedia.org",
      workflow_name: "Draft",
      workflow_description: "Draft.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: [],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
    };
    routes.set(draftRoute.route_id, draftRoute);

    const res = await requestSkillRun(`private_route:${draftRoute.route_id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe("ROUTE_NOT_VERIFIED");
  });

  it("existing installed-skill route runs still work via skill_id", async () => {
    installSkill(IDS.SKILL_WIKI);

    const res = await requestSkillRun(IDS.SKILL_WIKI);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const run = body.data.run ?? body.data;
    expect(run.route_id).toBe(IDS.ROUTE_WIKI);
    expect(run.skill_id).toBe(IDS.SKILL_WIKI);
  });
});

// ─── 6. Auth edge cases for POST /api/skills/:skillId/runs ───────────────────

describe("POST /api/skills/:skillId/runs — auth edge cases", () => {
  it("returns 401 AUTH_REQUIRED when Authorization header is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${encodeURIComponent(`private_route:${IDS.ROUTE_WIKI}`)}/runs`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error?.code).toBe("AUTH_REQUIRED");
  });

  it("returns 401 INVALID_TOKEN when the token is not in the passes table", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${encodeURIComponent(`private_route:${IDS.ROUTE_WIKI}`)}/runs`,
      headers: { authorization: "Bearer tok_does_not_exist", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error?.code).toBe("INVALID_TOKEN");
  });

  it("succeeds when pass.id differs from pass.token (non-coincidental two-step lookup)", async () => {
    // Insert a pass where the raw token string is distinct from the pass record ID.
    // This proves the fix resolves pass by token value, then delegation by pass.id —
    // not by matching the raw token directly against delegation.token_id.
    const NOW = new Date().toISOString();
    const PASS_ID = "pass_distinct_id_001";
    const BEARER_TOKEN = "tok_distinct_bearer_001";
    passes.set(PASS_ID, {
      id: PASS_ID,
      token: BEARER_TOKEN,
      user_id: IDS.USER,
      agent_name: "agent_distinct_001",
      default_collar_id: IDS.COLLAR,
      status: "active",
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      created_at: NOW,
    });
    agentDelegations.set("delg_distinct_001", {
      id: "delg_distinct_001",
      user_id: IDS.USER,
      user_aegis_id: "aid_user_001",
      agent_name: "agent_distinct_001",
      agent_platform: "api",
      channel: "api",
      default_collar_id: IDS.COLLAR,
      status: "active",
      token_id: PASS_ID, // references pass.id, not pass.token
      skill_access_mode: "all",
      skill_access_skill_ids: [],
      created_at: NOW,
      updated_at: NOW,
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${encodeURIComponent(`private_route:${IDS.ROUTE_WIKI}`)}/runs`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("resolves the same delegation as GET /api/agent/v1/me for the same token", async () => {
    const meRes = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: AUTH_ALL,
    });
    expect(meRes.statusCode).toBe(200);
    const meAgentId = meRes.json().data?.agent_id as string;

    const runRes = await server.inject({
      method: "POST",
      url: `/api/skills/${encodeURIComponent(`private_route:${IDS.ROUTE_WIKI}`)}/runs`,
      headers: { ...AUTH_ALL, "content-type": "application/json" },
      payload: {},
    });
    expect(runRes.statusCode).toBe(200);
    const run = runRes.json().data?.run ?? runRes.json().data;
    // The run is created for the same agent that /me resolves to.
    expect(run.agent_id).toBe(meAgentId);
  });
});
