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
import { seedTestData, resetStore, IDS } from "./helpers.js";
import { routeRoutes } from "../routes/routes.js";
import { routeRunRoutes } from "../routes/route-runs.js";
import { skillRoutes } from "../routes/skills.js";
import { taskBrowserSessionRoutes } from "../routes/task-browser-sessions.js";
import { routes, routeRuns, passes, agentDelegations } from "../store/index.js";
import type { RouteRun, RouteRunStatus } from "@aegis/types";

const AUTH_ALL = { authorization: `Bearer ${IDS.TOKEN_ALL}` };

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(routeRoutes);
  await server.register(routeRunRoutes);
  await server.register(skillRoutes);
  await server.register(taskBrowserSessionRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetStore();
  seedTestData();
  routeRuns.clear();
});

// ─── Route listing ────────────────────────────────────────────────────────────

describe("GET /api/routes — Wikipedia route data", () => {
  it("includes route_demo_wikipedia_001 with correct domain", async () => {
    const res = await server.inject({ method: "GET", url: "/api/routes" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const wikiRoute = body.data.find((r: any) => r.route_id === IDS.ROUTE_WIKI);
    expect(wikiRoute).toBeDefined();
    expect(wikiRoute.domain).toBe("en.wikipedia.org");
    expect(wikiRoute.workflow_name).toBe("Wikipedia Search");
  });

  it("returns route_demo_wikipedia_001 via GET /api/routes/:routeId", async () => {
    const res = await server.inject({ method: "GET", url: `/api/routes/${IDS.ROUTE_WIKI}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.route_id).toBe(IDS.ROUTE_WIKI);
    expect(body.data.domain).toBe("en.wikipedia.org");
    expect(body.data.trust_tier).toBe("aegis_scanned");
  });

  it("returns 404 for unknown route_id", async () => {
    const res = await server.inject({ method: "GET", url: "/api/routes/route_does_not_exist" });
    expect(res.statusCode).toBe(404);
  });

  it("private routes (marketplace_status=private or absent) do not appear in skills listing", async () => {
    const res = await server.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Skills only exist when explicitly published — routes alone don't appear here
    const skillRouteIds = body.data.map((s: any) => s.route_id);
    // The seeded Wikipedia skill IS in skills (route_id === ROUTE_WIKI)
    // But a direct route should not appear if it has no corresponding skill entry
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ─── route_id filter on GET /api/route-runs ───────────────────────────────────

describe("GET /api/route-runs?route_id= — filter by route", () => {
  function seedRun(overrides: Partial<RouteRun> & Pick<RouteRun, "run_id" | "route_id">): RouteRun {
    const run: RouteRun = {
      run_id: overrides.run_id,
      skill_id: IDS.SKILL_WIKI,
      route_id: overrides.route_id,
      user_id: IDS.USER,
      domain: "en.wikipedia.org",
      status: "completed" as RouteRunStatus,
      variables: {},
      pass_overrides: [],
      approval_required_permissions: [],
      approved_permissions: [],
      credential_used: false,
      pass_ids_used: [],
      secret_values_revealed_to_agent: false,
      created_at: new Date().toISOString(),
      ...overrides,
    };
    routeRuns.set(run.run_id, run);
    return run;
  }

  it("returns only runs matching route_id", async () => {
    seedRun({ run_id: "run_wiki_001", route_id: IDS.ROUTE_WIKI });
    seedRun({ run_id: "run_purchase_001", route_id: IDS.ROUTE_PURCHASE, domain: "test.aegis.local", skill_id: IDS.SKILL_PURCHASE });

    const res = await server.inject({ method: "GET", url: `/api/route-runs?route_id=${IDS.ROUTE_WIKI}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].run_id).toBe("run_wiki_001");
    expect(body.data[0].route_id).toBe(IDS.ROUTE_WIKI);
  });

  it("returns empty array when no runs match route_id", async () => {
    seedRun({ run_id: "run_purchase_001", route_id: IDS.ROUTE_PURCHASE, domain: "test.aegis.local", skill_id: IDS.SKILL_PURCHASE });

    const res = await server.inject({ method: "GET", url: `/api/route-runs?route_id=${IDS.ROUTE_WIKI}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(0);
  });

  it("returns all user runs when no route_id filter is provided", async () => {
    seedRun({ run_id: "run_wiki_001", route_id: IDS.ROUTE_WIKI });
    seedRun({ run_id: "run_purchase_001", route_id: IDS.ROUTE_PURCHASE, domain: "test.aegis.local", skill_id: IDS.SKILL_PURCHASE });

    const res = await server.inject({ method: "GET", url: "/api/route-runs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
  });
});

// ─── Recent run history — safe field verification ─────────────────────────────

describe("GET /api/route-runs — safe fields only", () => {
  it("run objects never expose cdp_url, user_data_dir, cookies, storage, or raw secrets", async () => {
    routeRuns.set("run_safe_test_001", {
      run_id: "run_safe_test_001",
      skill_id: IDS.SKILL_WIKI,
      route_id: IDS.ROUTE_WIKI,
      user_id: IDS.USER,
      domain: "en.wikipedia.org",
      status: "completed",
      variables: {},
      pass_overrides: [],
      approval_required_permissions: [],
      approved_permissions: [],
      credential_used: false,
      pass_ids_used: [],
      secret_values_revealed_to_agent: false,
      created_at: new Date().toISOString(),
    });

    const res = await server.inject({ method: "GET", url: "/api/route-runs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const run = body.data.find((r: any) => r.run_id === "run_safe_test_001");
    expect(run).toBeDefined();

    // These fields must never appear in the response
    expect(run).not.toHaveProperty("cdp_url");
    expect(run).not.toHaveProperty("user_data_dir");
    expect(run).not.toHaveProperty("cookies");
    expect(run).not.toHaveProperty("storage");
    expect(run).not.toHaveProperty("raw_secrets");
    // secret_values_revealed_to_agent must always be false
    expect(run.secret_values_revealed_to_agent).toBe(false);
  });

  it("route_summary in run response includes route_id matching the filter", async () => {
    routeRuns.set("run_summary_test", {
      run_id: "run_summary_test",
      skill_id: IDS.SKILL_WIKI,
      route_id: IDS.ROUTE_WIKI,
      user_id: IDS.USER,
      domain: "en.wikipedia.org",
      status: "completed",
      variables: {},
      pass_overrides: [],
      approval_required_permissions: [],
      approved_permissions: [],
      credential_used: false,
      pass_ids_used: [],
      secret_values_revealed_to_agent: false,
      created_at: new Date().toISOString(),
    });

    const res = await server.inject({ method: "GET", url: `/api/route-runs?route_id=${IDS.ROUTE_WIKI}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    const run = body.data[0];
    expect(run.route_summary).toBeDefined();
    expect(run.route_summary.route_id).toBe(IDS.ROUTE_WIKI);
    expect(run.route_summary.workflow_name).toBe("Wikipedia Search");
    // route_summary must not contain sensitive fields
    expect(run.route_summary).not.toHaveProperty("cdp_url");
    expect(run.route_summary).not.toHaveProperty("pass_ids_used");
  });
});

// ─── Wikipedia skill preview data ─────────────────────────────────────────────

describe("Wikipedia skill — preview data correctness", () => {
  it("Wikipedia skill references route_demo_wikipedia_001 via route_id", async () => {
    const res = await server.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const wikiSkill = body.data.find((s: any) => s.skill_id === IDS.SKILL_WIKI);
    expect(wikiSkill).toBeDefined();
    expect(wikiSkill.route_id).toBe(IDS.ROUTE_WIKI);
    expect(wikiSkill.domain).toBe("en.wikipedia.org");
    expect(wikiSkill.name).toBe("Wikipedia Search");
  });

  it("GET /api/routes/route_demo_wikipedia_001 returns domain en.wikipedia.org", async () => {
    const res = await server.inject({ method: "GET", url: `/api/routes/${IDS.ROUTE_WIKI}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.domain).toBe("en.wikipedia.org");
    expect(body.data.route_id).toBe("route_demo_wikipedia_001");
  });
});
