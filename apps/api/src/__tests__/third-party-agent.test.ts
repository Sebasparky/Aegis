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
  return {
    ...actual,
    createTaskBrowserSession: vi.fn(),
    getTaskBrowserSessionForReuse: vi.fn(),
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { seedTestData, installSkill, IDS } from "./helpers.js";
import { skillRoutes } from "../routes/skills.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { delegationRoutes } from "../routes/delegations.js";
import { routeRunRoutes } from "../routes/route-runs.js";
import { taskBrowserSessionRoutes } from "../routes/task-browser-sessions.js";
import {
  agentDelegations,
  collars,
  passes,
  installedSkills,
  MOCK_USER_ID,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import type { AgentDelegation, Collar } from "@aegis/types";
import { createTaskBrowserSession, getTaskBrowserSessionForReuse } from "../runtime/taskBrowserSessions.js";

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
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
  installedSkills.clear();
});

// ─── Helper: create a delegation + pass via the API ──────────────────────────

async function createDelegation(body: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: "/api/delegations",
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

// ─── 1. Full create → authenticate cycle ─────────────────────────────────────

describe("POST /api/delegations → delegation_token → GET /api/agent/v1/me", () => {
  it("creates a delegation and the returned token authenticates /me", async () => {
    const created = await createDelegation({ agent_name: "test_third_party" });
    expect(created.statusCode).toBe(200);
    const { data } = created.json();
    const token: string = data.delegation_token;
    expect(token).toBeTruthy();

    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    const { data: identity } = me.json();
    expect(identity.delegation_id).toBe(data.delegation.id);
    expect(identity.agent_name).toBe("test_third_party");
  });

  it("delegation_token is pass.token and is not stored in delegation.token_id", async () => {
    const created = await createDelegation({ agent_name: "token_contract_check" });
    const { data } = created.json();
    const token: string = data.delegation_token;
    const delegation: AgentDelegation = data.delegation;

    // token_id must be the pass ID, not the raw bearer token
    expect(delegation.token_id).not.toBe(token);

    // The pass must exist in the store with the raw token as pass.token
    const pass = Array.from(passes.values()).find((p) => p.token === token);
    expect(pass).toBeDefined();
    expect(pass!.id).toBe(delegation.token_id);
  });
});

// ─── 2. /me identity fields ───────────────────────────────────────────────────

describe("GET /api/agent/v1/me identity contract", () => {
  it("returns correct delegation_id, agent_name, and delegation_status", async () => {
    const created = await createDelegation({ agent_name: "identity_test_agent" });
    const token: string = created.json().data.delegation_token;

    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    const { data } = me.json();
    expect(data.agent_name).toBe("identity_test_agent");
    expect(data.delegation_status).toBe("active");
    expect(data.delegation_id).toBeTruthy();
  });

  it("returns collar_active: false, execution_blocked: false, baseline_policy_active: true when no collar", async () => {
    const created = await createDelegation({ agent_name: "no_collar_agent" });
    const token: string = created.json().data.delegation_token;

    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    const { data } = me.json();
    expect(data.collar_active).toBe(false);
    expect(data.execution_blocked).toBe(false);
    expect(data.baseline_policy_active).toBe(true);
    expect(data.policy_mode).toBe("baseline");
    expect(data.collar_spending_limits).toBeUndefined();
  });

  it("returns collar_active: true, execution_blocked: false, policy_mode: collar, and spending_limits when collar active", async () => {
    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}` },
    });
    expect(me.statusCode).toBe(200);
    const { data } = me.json();
    expect(data.collar_active).toBe(true);
    expect(data.execution_blocked).toBe(false);
    expect(data.baseline_policy_active).toBeUndefined();
    expect(data.policy_mode).toBe("collar");
    expect(data.collar_spending_limits).toBeDefined();
    expect(typeof data.collar_spending_limits.max_without_approval).toBe("number");
    expect(typeof data.collar_spending_limits.max_with_approval).toBe("number");
  });

  it("returns expires_at when delegation was created with an expiry", async () => {
    const created = await createDelegation({ agent_name: "expiry_agent", expires_in_minutes: 60 });
    const token: string = created.json().data.delegation_token;

    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    const { data } = me.json();
    expect(data.expires_at).toBeTruthy();
  });
});

// ─── 3. Seeded Shopping Collar agent ──────────────────────────────────────────

describe("Seeded Shopping Collar delegation (tok_demo_shopping_001)", () => {
  beforeAll(() => {
    // Seed the shopping collar and delegation into the test store, mirroring persistence.ts
    const NOW = "2026-05-19T00:00:00.000Z";
    const EXPIRY = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    if (!collars.has("collar_shopping_001")) {
      collars.set("collar_shopping_001", {
        id: "collar_shopping_001",
        user_id: MOCK_USER_ID,
        name: "Shopping Agent Collar",
        description: "Scoped collar for agents that browse and purchase on behalf of users.",
        purpose: "Allow agents to search, compare, and request purchase approvals.",
        status: "active",
        allowed_actions: ["browse", "search", "read", "compare", "add_to_cart"] as any,
        approval_required_actions: ["purchase", "payment", "login", "submit_form"] as any,
        blocked_actions: ["identity_disclosure", "subscription", "delete_account",
          "financial_data_disclosure", "government_id_upload"] as any,
        spending_limits: { max_without_approval: 0, max_with_approval: 250, subscriptions_allowed: false },
        counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: true },
        session_limits: { max_duration_minutes: 120, max_active_sessions: 2 },
        created_at: NOW,
        updated_at: NOW,
      } as Collar);
    }
    if (!passes.has("pass_demo_shopping_001")) {
      passes.set("pass_demo_shopping_001", {
        id: "pass_demo_shopping_001", token: "tok_demo_shopping_001", user_id: MOCK_USER_ID,
        agent_name: "demo_shopping_agent", default_collar_id: "collar_shopping_001",
        status: "active", expires_at: EXPIRY, created_at: NOW,
      } as PassWithToken);
    }
    if (!agentDelegations.has("delg_demo_shopping_001")) {
      agentDelegations.set("delg_demo_shopping_001", {
        id: "delg_demo_shopping_001", user_id: MOCK_USER_ID, user_aegis_id: "aid_user_001",
        agent_name: "demo_shopping_agent", agent_platform: "api", channel: "api",
        default_collar_id: "collar_shopping_001", status: "active",
        token_id: "pass_demo_shopping_001", skill_access_mode: "all", skill_access_skill_ids: [],
        created_at: NOW, updated_at: NOW,
      } as AgentDelegation);
    }
  });

  it("GET /api/agent/v1/me returns collar_active: true and correct spending limits", async () => {
    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: "Bearer tok_demo_shopping_001" },
    });
    expect(me.statusCode).toBe(200);
    const { data } = me.json();
    expect(data.collar_active).toBe(true);
    expect(data.execution_blocked).toBe(false);
    expect(data.collar_spending_limits.max_with_approval).toBe(250);
    expect(data.collar_spending_limits.max_without_approval).toBe(0);
  });

  it("GET /api/agent/v1/me contains no reference to any specific external agent platform", async () => {
    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: "Bearer tok_demo_shopping_001" },
    });
    const body = me.payload;
    expect(body.toLowerCase()).not.toContain("openclaw");
  });
});

// ─── 4. Auth failure cases ────────────────────────────────────────────────────

describe("Auth failure cases on /api/agent/v1/me", () => {
  it("returns 401 AUTH_REQUIRED when no Authorization header", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agent/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("AUTH_REQUIRED");
  });

  it("returns 401 INVALID_TOKEN for an unknown bearer token", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: "Bearer completely_unknown_token_xyz" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });

  it("returns 401 DELEGATION_REVOKED when delegation is revoked", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    delegation.status = "revoked";
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}` },
    });
    delegation.status = "active";
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_REVOKED");
  });

  it("returns 401 DELEGATION_EXPIRED when delegation is expired", async () => {
    const delegation = agentDelegations.get(IDS.DELEGATION_ALL)!;
    const originalStatus = delegation.status;
    const originalExpiry = delegation.expires_at;
    delegation.status = "expired";
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}` },
    });
    delegation.status = originalStatus;
    delegation.expires_at = originalExpiry;
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("DELEGATION_EXPIRED");
  });
});

// ─── 5. /skills execution_available and domain filter ─────────────────────────

describe("GET /api/agent/v1/skills — execution_available and domain filter", () => {
  beforeEach(() => {
    installSkill(IDS.SKILL_WIKI);
    installSkill(IDS.SKILL_PURCHASE);
    installSkill(IDS.SKILL_BLOCKED);
  });

  it("returns execution_available based on baseline policy when no collar", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/skills",
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}` },
    });
    expect(res.statusCode).toBe(200);
    const skills: any[] = res.json().data;
    expect(skills.length).toBeGreaterThan(0);
    const wiki = skills.find((s: any) => s.skill_id === IDS.SKILL_WIKI);
    const blocked = skills.find((s: any) => s.skill_id === IDS.SKILL_BLOCKED);
    // browse is in baseline allowed_actions
    if (wiki) expect(wiki.execution_available).toBe(true);
    // identity_disclosure is in baseline blocked_actions
    if (blocked) expect(blocked.execution_available).toBe(false);
  });

  it("returns execution_available: true for allowed skills when collar active", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/skills",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}` },
    });
    expect(res.statusCode).toBe(200);
    const skills: any[] = res.json().data;
    const wiki = skills.find((s) => s.skill_id === IDS.SKILL_WIKI);
    expect(wiki).toBeDefined();
    expect(wiki.execution_available).toBe(true); // browse is in allowed_actions
  });

  it("returns execution_available: false for blocked skills when collar active", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/agent/v1/skills",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}` },
    });
    const skills: any[] = res.json().data;
    const blocked = skills.find((s) => s.skill_id === IDS.SKILL_BLOCKED);
    if (blocked) {
      // identity_disclosure is in blocked_actions of the test collar
      expect(blocked.execution_available).toBe(false);
    }
  });

  it("filters by ?domain= parameter", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/skills?domain=en.wikipedia.org`,
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}` },
    });
    expect(res.statusCode).toBe(200);
    const skills: any[] = res.json().data;
    for (const s of skills) {
      expect(s.domain).toBe("en.wikipedia.org");
    }
  });
});

// ─── 6. No-collar agent — baseline safety policy (regression guard updated) ───

describe("No-collar agent — baseline policy replaces COLLAR_REQUIRED", () => {
  it("POST /api/skills/:skillId/runs with browse skill → pending run (baseline allows)", async () => {
    installSkill(IDS.SKILL_WIKI);
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_WIKI}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("pending");
  });

  it("POST /api/agent/v1/runs with browse skill → pending run (baseline allows)", async () => {
    installSkill(IDS.SKILL_WIKI);
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runs",
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: { skill_id: IDS.SKILL_WIKI },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.run.status).toBe("pending");
  });

  it("POST /api/skills/:skillId/runs with identity_disclosure skill → 403 COLLAR_BLOCKED (baseline blocks)", async () => {
    installSkill(IDS.SKILL_BLOCKED);
    const res = await server.inject({
      method: "POST",
      url: `/api/skills/${IDS.SKILL_BLOCKED}/runs`,
      headers: { authorization: `Bearer ${IDS.TOKEN_NO_COLLAR}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("COLLAR_BLOCKED");
  });
});

// ─── 7. Task browser session headless mode ────────────────────────────────────

describe("POST /api/task-browser-sessions — headless mode", () => {
  const mockSession = (debug_visible: boolean) => ({
    browser_session_id: "tbsess_test_001",
    user_id: MOCK_USER_ID,
    delegation_id: IDS.DELEGATION_ALL,
    status: "ready" as const,
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_test_001",
    ephemeral: true as true,
    mode: debug_visible ? ("visible" as const) : ("headless" as const),
    debug_visible,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });

  beforeEach(() => {
    vi.mocked(createTaskBrowserSession).mockReset();
  });

  it("returns mode: 'headless' when no body is sent", async () => {
    vi.mocked(createTaskBrowserSession).mockResolvedValueOnce({
      session: mockSession(false),
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.mode).toBe("headless");
    expect(data.debug_visible).toBe(false);
    expect(vi.mocked(createTaskBrowserSession).mock.calls[0][0]).toMatchObject({ debug_visible: false });
  });

  it("returns mode: 'headless' when debug_visible is absent from body", async () => {
    vi.mocked(createTaskBrowserSession).mockResolvedValueOnce({
      session: mockSession(false),
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: { delegation_id: "some_id" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.mode).toBe("headless");
    expect(vi.mocked(createTaskBrowserSession).mock.calls[0][0]).toMatchObject({ debug_visible: false });
  });

  it("returns mode: 'visible' and passes debug_visible: true to runtime when requested", async () => {
    vi.mocked(createTaskBrowserSession).mockResolvedValueOnce({
      session: mockSession(true),
      user_message: "Started a fresh Antigen task browser session.",
      mode: "visible",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: { debug_visible: true },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.mode).toBe("visible");
    expect(data.debug_visible).toBe(true);
    expect(vi.mocked(createTaskBrowserSession).mock.calls[0][0]).toMatchObject({ debug_visible: true });
  });

  it("auth is still required — 401 without a valid token", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(vi.mocked(createTaskBrowserSession)).not.toHaveBeenCalled();
  });

  it("mode field appears in response alongside browser_session_id and status", async () => {
    vi.mocked(createTaskBrowserSession).mockResolvedValueOnce({
      session: mockSession(false),
      user_message: "Started a fresh Antigen task browser session.",
      mode: "headless",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/task-browser-sessions",
      headers: { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" },
      payload: {},
    });
    const { data } = res.json();
    expect(data.browser_session_id).toBeTruthy();
    expect(data.status).toBe("ready");
    expect(data.mode).toBe("headless");
  });
});

// ─── Authenticated Session login-request — browser_session_id reuse ───────────

describe("POST /api/agent/v1/authenticated-sessions/login-request — browser_session_id", () => {
  const AUTH = { authorization: `Bearer ${IDS.TOKEN_ALL}`, "content-type": "application/json" };
  const BASE_BODY = {
    domain: "github.com",
    login_url: "https://github.com/login",
    task_summary: "Log in to GitHub",
  };

  beforeEach(() => {
    vi.mocked(getTaskBrowserSessionForReuse).mockReset();
  });

  it("without browser_session_id — creates handle with no task_browser_session_id (fresh behavior preserved)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/authenticated-sessions/login-request",
      headers: AUTH,
      payload: BASE_BODY,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.session_id).toMatch(/^authsess_/);
    expect(data.status).toBe("pending_approval");
    expect(data.task_browser_session_id).toBeUndefined();
    expect(vi.mocked(getTaskBrowserSessionForReuse)).not.toHaveBeenCalled();
  });

  it("with valid browser_session_id — creates handle with task_browser_session_id set", async () => {
    vi.mocked(getTaskBrowserSessionForReuse).mockReturnValueOnce({
      browser_session_id: "tbsess_abc123",
      cdp_url: "http://localhost:9222",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/authenticated-sessions/login-request",
      headers: AUTH,
      payload: { ...BASE_BODY, browser_session_id: "tbsess_abc123" },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.session_id).toMatch(/^authsess_/);
    expect(data.status).toBe("pending_approval");
    expect(data.task_browser_session_id).toBe("tbsess_abc123");
    expect(vi.mocked(getTaskBrowserSessionForReuse)).toHaveBeenCalledWith("tbsess_abc123", IDS.USER);
  });

  it("with browser_session_id not available (not ready / wrong user) — returns 400 TASK_BROWSER_SESSION_NOT_AVAILABLE", async () => {
    vi.mocked(getTaskBrowserSessionForReuse).mockReturnValueOnce(undefined);

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/authenticated-sessions/login-request",
      headers: AUTH,
      payload: { ...BASE_BODY, browser_session_id: "tbsess_nonexistent" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("TASK_BROWSER_SESSION_NOT_AVAILABLE");
  });

  it("with browser_session_id as non-string — returns 400 INVALID_BROWSER_SESSION_ID", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/authenticated-sessions/login-request",
      headers: AUTH,
      payload: { ...BASE_BODY, browser_session_id: 12345 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("INVALID_BROWSER_SESSION_ID");
    expect(vi.mocked(getTaskBrowserSessionForReuse)).not.toHaveBeenCalled();
  });

  it("existing required-field validation is preserved — missing domain returns 400 MISSING_DOMAIN", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/authenticated-sessions/login-request",
      headers: AUTH,
      payload: { login_url: "https://github.com/login", task_summary: "test" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_DOMAIN");
  });

  it("auth is required — 401 without a valid token", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/authenticated-sessions/login-request",
      headers: { "content-type": "application/json" },
      payload: BASE_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});
