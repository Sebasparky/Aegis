import type { FastifyInstance } from "fastify";
import type { AgentConnector, AgentConnectorPlatform, ConnectorPolicyMode } from "@aegis/types";
import { agentConnectors, agentDelegations, collars, MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { createDelegationWithPass } from "../lib/createDelegationWithPass.js";
import { revokeDelegationById } from "../lib/revokeDelegation.js";

const VALID_PLATFORMS: AgentConnectorPlatform[] = [
  "claude_cowork",
  "claude_desktop",
  "generic_mcp",
  "custom_http",
];

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

function buildSetup(
  platform: AgentConnectorPlatform,
  token: string
) {
  const isMcp = platform !== "custom_http";

  if (isMcp) {
    return {
      connector_type: "mcp_local" as const,
      agent_token: token,
      shown_once: true as const,
      requires_local_path: true as const,
      path_placeholder: "<ABSOLUTE_PATH_TO_REPO>",
      mcp_config: {
        mcpServers: {
          antigen: {
            command: "node",
            args: ["<ABSOLUTE_PATH_TO_REPO>/examples/aegis-tool-server.mjs"],
            env: {
              AEGIS_API_BASE: "http://localhost:4000",
              AEGIS_AGENT_TOKEN: token,
            },
          },
          "antigen-browser": {
            command: "node",
            args: ["<ABSOLUTE_PATH_TO_REPO>/examples/antigen-browser-adapter.mjs"],
            env: {
              AEGIS_API_BASE: "http://localhost:4000",
              AEGIS_AGENT_TOKEN: token,
            },
          },
        },
      },
      browser_runtime_guidance: {
        antigen_role: "Trust tools — credential injection, approvals, sensitive action gates, receipts.",
        "antigen-browser_role": "Browser adapter — resolves the Antigen local runtime CDP port at startup and attaches @playwright/mcp automatically.",
        first_run: "Call get_runtime_browser_endpoint once at task start. The antigen-browser adapter resolves the browser port automatically — no manual config needed.",
        adapter_note: "The antigen-browser adapter calls the Antigen API at startup to get the real CDP port. Works even when the runtime launches on an alternate port.",
        compatibility_note: "Agents without local process support use navigate_task_browser_session / observe_task_browser_session / click_element_in_task_browser_session (compatibility mode only).",
      },
      instructions: [
        "Copy the mcp_config block into your Claude Desktop config.json or Cursor MCP settings.",
        "Replace <ABSOLUTE_PATH_TO_REPO> with the absolute path to your Aegis repository root.",
        "Save the AEGIS_AGENT_TOKEN now — it will not be shown again.",
        "Restart your agent platform after saving the config.",
        "On first run, call get_runtime_browser_endpoint to initialize the Antigen local browser runtime. The antigen-browser adapter connects automatically.",
        "This is a local development setup. A hosted one-click connector is planned for a future release.",
      ],
    };
  }

  return {
    connector_type: "http_api" as const,
    agent_token: token,
    shown_once: true as const,
    http_examples: {
      base_url: "http://localhost:4000",
      auth_header: `Authorization: Bearer ${token}`,
      curl_identity: `curl -H 'Authorization: Bearer ${token}' http://localhost:4000/api/agent/v1/me`,
      curl_skills: `curl -H 'Authorization: Bearer ${token}' http://localhost:4000/api/agent/v1/skills`,
    },
    instructions: [
      "Use the agent_token as a Bearer token in all requests to /api/agent/v1/*.",
      "Call GET /api/agent/v1/me first to verify the connection.",
      "Save the token now — it will not be shown again.",
      "Baseline Aegis safety policy is active. Sensitive actions will require user approval in the Aegis UI.",
    ],
  };
}

export async function agentConnectorRoutes(server: FastifyInstance) {
  // POST /api/agent-connectors
  server.post<{
    Body: {
      display_name: string;
      platform: AgentConnectorPlatform;
      policy_mode: ConnectorPolicyMode;
      collar_id?: string;
    };
  }>("/api/agent-connectors", async (req, reply) => {
    const { display_name, platform, policy_mode, collar_id } = req.body ?? {};

    if (!display_name || typeof display_name !== "string" || !display_name.trim()) {
      return sendError(reply, 400, "VALIDATION_ERROR", "display_name is required.");
    }
    if (!VALID_PLATFORMS.includes(platform)) {
      return sendError(reply, 400, "VALIDATION_ERROR", `platform must be one of: ${VALID_PLATFORMS.join(", ")}.`);
    }
    if (policy_mode !== "baseline" && policy_mode !== "collar") {
      return sendError(reply, 400, "VALIDATION_ERROR", 'policy_mode must be "baseline" or "collar".');
    }
    if (policy_mode === "collar" && !collar_id) {
      return sendError(reply, 400, "VALIDATION_ERROR", 'collar_id is required when policy_mode is "collar".');
    }

    let resolved_collar_id: string | undefined;
    if (policy_mode === "collar" && collar_id) {
      const collar = collars.get(collar_id);
      if (!collar) {
        return sendError(reply, 404, "NOT_FOUND", "Collar not found.");
      }
      if (collar.user_id !== MOCK_USER_ID || collar.status !== "active") {
        return sendError(reply, 400, "COLLAR_INACTIVE", "Collar is not active.");
      }
      resolved_collar_id = collar.id;
    }

    const { delegation, token } = createDelegationWithPass({
      agent_name: display_name.trim(),
      agent_platform: platform,
      channel: "api",
      default_collar_id: resolved_collar_id,
    });

    const now = new Date().toISOString();
    const connector: AgentConnector = {
      connector_id: newId("conn"),
      user_id: MOCK_USER_ID,
      delegation_id: delegation.id,
      platform,
      display_name: display_name.trim(),
      policy_mode,
      ...(resolved_collar_id ? { collar_id: resolved_collar_id } : {}),
      status: "created",
      created_at: now,
      updated_at: now,
    };
    agentConnectors.set(connector.connector_id, connector);
    schedulePersist();

    return reply.status(201).send({
      ok: true,
      data: {
        connector,
        delegation,
        setup: buildSetup(platform, token),
      },
    });
  });

  // GET /api/agent-connectors
  server.get("/api/agent-connectors", async () => {
    const result = Array.from(agentConnectors.values())
      .filter((c) => c.user_id === MOCK_USER_ID)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { ok: true, data: result };
  });

  // GET /api/agent-connectors/:connectorId
  server.get<{ Params: { connectorId: string } }>(
    "/api/agent-connectors/:connectorId",
    async (req, reply) => {
      const connector = agentConnectors.get(req.params.connectorId);
      if (!connector || connector.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Connector not found.");
      }
      return { ok: true, data: connector };
    }
  );

  // GET /api/agent-connectors/:connectorId/status
  server.get<{ Params: { connectorId: string } }>(
    "/api/agent-connectors/:connectorId/status",
    async (req, reply) => {
      const connector = agentConnectors.get(req.params.connectorId);
      if (!connector || connector.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Connector not found.");
      }
      const delegation = agentDelegations.get(connector.delegation_id);
      return {
        ok: true,
        data: {
          connector_id: connector.connector_id,
          display_name: connector.display_name,
          status: connector.status,
          ...(connector.last_seen_at ? { last_seen_at: connector.last_seen_at } : {}),
          delegation_id: connector.delegation_id,
          delegation_status: delegation?.status ?? "unknown",
        },
      };
    }
  );

  // POST /api/agent-connectors/:connectorId/revoke
  server.post<{ Params: { connectorId: string } }>(
    "/api/agent-connectors/:connectorId/revoke",
    async (req, reply) => {
      const connector = agentConnectors.get(req.params.connectorId);
      if (!connector || connector.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Connector not found.");
      }
      if (connector.status === "revoked") {
        return sendError(reply, 400, "INVALID_STATE", "Connector is already revoked.");
      }

      const result = revokeDelegationById(connector.delegation_id);

      const now = new Date().toISOString();
      connector.status = "revoked";
      connector.updated_at = now;
      schedulePersist();

      return {
        ok: true,
        data: {
          connector_id: connector.connector_id,
          status: "revoked",
          delegation_revoked: result.ok,
        },
      };
    }
  );
}
