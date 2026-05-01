/**
 * Aegis Tool Server — MCP stdio adapter
 *
 * Exposes Aegis skill execution as standard MCP tools so any agent runtime
 * (Claude Desktop, Claude Code, or any MCP-compatible client) can discover
 * and invoke Aegis capabilities without Aegis-specific client code.
 *
 * The agent receives tools from the environment. It does not need to know
 * about Aegis internals. Aegis stays the trust and execution layer beneath.
 *
 * Transport: stdio (JSON-RPC over stdin/stdout). No network port.
 *
 * Usage:
 *   node examples/aegis-tool-server.mjs
 *
 * Environment variables:
 *   AEGIS_API_BASE      API base URL            (default: http://localhost:4000)
 *   AEGIS_AGENT_TOKEN   Bearer delegation token  (default: pass_demo_001)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const API_BASE = process.env.AEGIS_API_BASE    ?? "http://localhost:4000";
const TOKEN    = process.env.AEGIS_AGENT_TOKEN ?? "pass_demo_001";

const APPROVAL_UI = "http://localhost:3000/route-run-approvals";

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function request(method, path, body) {
  const url = `${API_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${TOKEN}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(
      `Network error calling ${method} ${url}: ${err.message}\nIs the API running on ${API_BASE}?`
    );
  }
  return res.json();
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function discoverInstalledSkills({ domain }) {
  const res = await request(
    "GET",
    `/api/skills?domain=${encodeURIComponent(domain)}&installed=true`
  );
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Skill discovery failed.",
      skills: [],
    };
  }
  return { skills: res.data };
}

async function requestSkillRun({ skill_id, variables = {} }) {
  const res = await request("POST", `/api/skills/${skill_id}/runs`, { variables });
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to request skill run.",
    };
  }

  const run              = res.data.run ?? res.data;
  const approvalRequired = res.data.approval_required === true;
  const approvalPerms    = res.data.approval_required_permissions ?? [];

  return {
    run_id: run.run_id,
    status: run.status,
    domain: run.domain,
    delegation_id: run.delegation_id,
    collar_id: run.collar_id,
    approval_required: approvalRequired,
    approval_required_permissions: approvalPerms,
    next_action: approvalRequired
      ? `This run requires human approval before execution begins. Direct the user to ${APPROVAL_UI} to approve, then poll get_route_run_status until status changes from "pending_approval".`
      : `Run is pending. Execution is Aegis-controlled — the user must open ${run.domain ?? "the target domain"} in Chrome and click Start Run in the Aegis extension popup. Poll get_route_run_status until status is "completed", "failed", or "blocked".`,
  };
}

async function getRouteRunStatus({ run_id }) {
  const res = await request("GET", "/api/route-runs");
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to fetch runs.",
    };
  }

  const run = res.data.find((r) => r.run_id === run_id);
  if (!run) {
    return { error: "NOT_FOUND", message: `Run ${run_id} was not found.` };
  }

  const terminal = ["completed", "failed", "blocked"].includes(run.status);

  return {
    run_id: run.run_id,
    status: run.status,
    domain: run.domain,
    skill_name: run.skill_summary?.name ?? null,
    route_trust_tier: run.route_summary?.trust_tier ?? null,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    error: run.error ?? null,
    terminal,
    next_action: terminal
      ? run.status === "completed"
        ? "Run completed. Call get_route_run_receipt to retrieve the audit record."
        : `Run ended with status "${run.status}"${run.error ? `: ${run.error}` : "."}`
      : "Not yet terminal. Poll again in a few seconds.",
  };
}

async function getRouteRunReceipt({ run_id }) {
  let res;
  try {
    res = await request("GET", "/api/route-run-receipts");
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }

  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to fetch receipts.",
    };
  }

  const receipt = res.data.find((r) => r.run_id === run_id);
  if (!receipt) {
    return {
      receipt: null,
      message:
        "No receipt found for this run. Receipts are only generated after a run reaches 'completed' or 'failed' status.",
    };
  }

  return { receipt };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "discover_installed_skills",
    description:
      "Discover which Aegis-installed skills (verified workflow routes) are available to this delegated agent on a given domain. Returns a list of skills the agent can request to execute. Call this first to find what Aegis can do on a target domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to discover skills for, e.g. 'en.wikipedia.org'.",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "request_skill_run",
    description:
      "Request Aegis to execute an installed skill (a verified workflow route) on behalf of this agent. Returns a run_id and initial status. If approval_required is true, the run is gated by human approval — direct the user to the approval UI and poll get_route_run_status until status changes. Execution is always controlled by Aegis, never by the agent directly.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "The skill_id from discover_installed_skills.",
        },
        variables: {
          type: "object",
          description:
            "Runtime variables required by the skill (e.g. { \"query\": \"Michigan\" } for a search skill). Check skill metadata for required variable names.",
          additionalProperties: true,
        },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "get_route_run_status",
    description:
      "Check the current status of a skill run. Poll until status is terminal. Terminal statuses: 'completed' (success), 'failed' (execution error), 'blocked' (collar policy rejection). Non-terminal: 'pending' (waiting for extension), 'pending_approval' (waiting for human), 'running' (extension executing).",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The run_id returned by request_skill_run.",
        },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_route_run_receipt",
    description:
      "Retrieve the audit receipt for a completed or failed skill run. Records what was executed, under what trust tier, and why it was allowed. Only available after terminal status of 'completed' or 'failed'. Returns null if no receipt exists yet.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The run_id to retrieve the receipt for.",
        },
      },
      required: ["run_id"],
    },
  },
];

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "aegis-tool-server", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args ?? {};

  let result;

  switch (name) {
    case "discover_installed_skills":
      result = await discoverInstalledSkills(a);
      break;
    case "request_skill_run":
      result = await requestSkillRun(a);
      break;
    case "get_route_run_status":
      result = await getRouteRunStatus(a);
      break;
    case "get_route_run_receipt":
      result = await getRouteRunReceipt(a);
      break;
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[aegis-tool-server] Running. API: ${API_BASE} | Token: ${TOKEN}`);
