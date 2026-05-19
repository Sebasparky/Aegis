import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { seedTestData } from "./helpers.js";
import { agentConnectorRoutes } from "../routes/agent-connectors.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { delegationRoutes } from "../routes/delegations.js";
import { agentConnectors, agentDelegations, collars } from "../store/index.js";
import type { AgentConnector } from "@aegis/types";

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  server = Fastify({ logger: false });
  await server.register(delegationRoutes);
  await server.register(agentConnectorRoutes);
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  agentConnectors.clear();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(body: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: "/api/agent-connectors",
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

// ─── 1. claude_cowork + baseline ─────────────────────────────────────────────

describe("POST /api/agent-connectors — claude_cowork + baseline", () => {
  it("creates connector + delegation with no collar, returns MCP config and agent_token", async () => {
    const res = await post({
      display_name: "My Claude Cowork",
      platform: "claude_cowork",
      policy_mode: "baseline",
    });

    expect(res.statusCode).toBe(201);
    const { data } = res.json();

    // Connector shape
    const connector: AgentConnector = data.connector;
    expect(connector.connector_id).toMatch(/^conn_/);
    expect(connector.platform).toBe("claude_cowork");
    expect(connector.policy_mode).toBe("baseline");
    expect(connector.status).toBe("created");
    expect(connector.collar_id).toBeUndefined();

    // Delegation has no collar
    expect(data.delegation.default_collar_id).toBeUndefined();

    // Setup — MCP config returned
    expect(data.setup.connector_type).toBe("mcp_local");
    expect(data.setup.agent_token).toMatch(/^aegis_pass_/);
    expect(data.setup.shown_once).toBe(true);
    expect(data.setup.requires_local_path).toBe(true);
    expect(data.setup.mcp_config.mcpServers.antigen.env.AEGIS_AGENT_TOKEN).toBe(data.setup.agent_token);
    expect(data.setup.http_examples).toBeUndefined();
  });
});

// ─── 2. generic_mcp + collar ─────────────────────────────────────────────────

describe("POST /api/agent-connectors — generic_mcp + collar", () => {
  it("creates connector with collar, setup has MCP config", async () => {
    const collarId = "collar_demo_starter"; // seeded by seedTestData
    const collar = collars.get(collarId);
    expect(collar).toBeDefined();

    const res = await post({
      display_name: "My MCP Agent",
      platform: "generic_mcp",
      policy_mode: "collar",
      collar_id: collarId,
    });

    expect(res.statusCode).toBe(201);
    const { data } = res.json();

    expect(data.connector.policy_mode).toBe("collar");
    expect(data.connector.collar_id).toBe(collarId);
    expect(data.delegation.default_collar_id).toBe(collarId);
    expect(data.setup.connector_type).toBe("mcp_local");
    expect(data.setup.agent_token).toMatch(/^aegis_pass_/);
  });
});

// ─── 3. custom_http ──────────────────────────────────────────────────────────

describe("POST /api/agent-connectors — custom_http", () => {
  it("returns http_api setup with curl examples, no mcp_config", async () => {
    const res = await post({
      display_name: "My HTTP Agent",
      platform: "custom_http",
      policy_mode: "baseline",
    });

    expect(res.statusCode).toBe(201);
    const { data } = res.json();

    expect(data.setup.connector_type).toBe("http_api");
    expect(data.setup.agent_token).toMatch(/^aegis_pass_/);
    expect(data.setup.shown_once).toBe(true);
    expect(data.setup.http_examples.base_url).toBe("http://localhost:4000");
    expect(data.setup.http_examples.curl_identity).toContain(data.setup.agent_token);
    expect(data.setup.mcp_config).toBeUndefined();
  });
});

// ─── 4. Validation errors ────────────────────────────────────────────────────

describe("POST /api/agent-connectors — validation errors", () => {
  it("returns 404 for invalid collar_id", async () => {
    const res = await post({
      display_name: "Agent",
      platform: "generic_mcp",
      policy_mode: "collar",
      collar_id: "collar_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when policy_mode is collar but collar_id is missing", async () => {
    const res = await post({
      display_name: "Agent",
      platform: "claude_desktop",
      policy_mode: "collar",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid platform", async () => {
    const res = await post({
      display_name: "Agent",
      platform: "unknown_platform",
      policy_mode: "baseline",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for missing display_name", async () => {
    const res = await post({
      platform: "claude_desktop",
      policy_mode: "baseline",
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── 5. /me updates connector status ─────────────────────────────────────────

describe("GET /api/agent/v1/me — updates connector status", () => {
  it("sets connector.status to connected and sets last_seen_at", async () => {
    const created = await post({
      display_name: "Test Connector",
      platform: "claude_desktop",
      policy_mode: "baseline",
    });
    expect(created.statusCode).toBe(201);
    const { data } = created.json();
    const connectorId: string = data.connector.connector_id;
    const token: string = data.setup.agent_token;

    // Before /me: status is "created", no last_seen_at
    const before = agentConnectors.get(connectorId)!;
    expect(before.status).toBe("created");
    expect(before.last_seen_at).toBeUndefined();

    // Call /me
    const me = await server.inject({
      method: "GET",
      url: "/api/agent/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    // After /me: status is "connected", last_seen_at set
    const after = agentConnectors.get(connectorId)!;
    expect(after.status).toBe("connected");
    expect(after.last_seen_at).toBeTruthy();
  });
});

// ─── 6. List/get/status do not return agent_token ────────────────────────────

describe("GET endpoints — no agent_token returned", () => {
  it("GET /api/agent-connectors does not return agent_token", async () => {
    await post({ display_name: "C1", platform: "claude_desktop", policy_mode: "baseline" });

    const res = await server.inject({ method: "GET", url: "/api/agent-connectors" });
    expect(res.statusCode).toBe(200);
    const connectors: AgentConnector[] = res.json().data;
    expect(connectors.length).toBeGreaterThan(0);
    for (const c of connectors) {
      expect((c as any).agent_token).toBeUndefined();
      expect((c as any).setup).toBeUndefined();
    }
  });

  it("GET /api/agent-connectors/:id does not return agent_token", async () => {
    const created = await post({ display_name: "C2", platform: "generic_mcp", policy_mode: "baseline" });
    const connectorId = created.json().data.connector.connector_id;

    const res = await server.inject({ method: "GET", url: `/api/agent-connectors/${connectorId}` });
    expect(res.statusCode).toBe(200);
    const connector = res.json().data;
    expect((connector as any).agent_token).toBeUndefined();
  });

  it("GET /api/agent-connectors/:id/status does not return agent_token", async () => {
    const created = await post({ display_name: "C3", platform: "custom_http", policy_mode: "baseline" });
    const connectorId = created.json().data.connector.connector_id;

    const res = await server.inject({ method: "GET", url: `/api/agent-connectors/${connectorId}/status` });
    expect(res.statusCode).toBe(200);
    const status = res.json().data;
    expect(status.connector_id).toBe(connectorId);
    expect(status.status).toBe("created");
    expect((status as any).agent_token).toBeUndefined();
  });

  it("POST create returns agent_token but subsequent GET does not", async () => {
    const created = await post({ display_name: "TokenCheck", platform: "claude_cowork", policy_mode: "baseline" });
    expect(created.json().data.setup.agent_token).toMatch(/^aegis_pass_/);

    const connectorId = created.json().data.connector.connector_id;
    const get = await server.inject({ method: "GET", url: `/api/agent-connectors/${connectorId}` });
    expect((get.json().data as any).agent_token).toBeUndefined();
    expect((get.json().data as any).setup).toBeUndefined();
  });
});

// ─── 7. Existing POST /api/delegations unchanged ─────────────────────────────

describe("POST /api/delegations — regression guard", () => {
  it("still creates a delegation and returns delegation_token", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/delegations",
      headers: { "content-type": "application/json" },
      payload: { agent_name: "regression_agent" },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.delegation.id).toMatch(/^delg_/);
    expect(data.delegation_token).toMatch(/^aegis_pass_/);
  });

  it("regression: collar validation still works on POST /api/delegations", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/delegations",
      headers: { "content-type": "application/json" },
      payload: { agent_name: "bad_collar_agent", default_collar_id: "nonexistent_collar" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
