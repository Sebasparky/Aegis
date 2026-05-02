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
  const skills = res.data.map((s) => ({
    skill_id: s.skill_id,
    name: s.name,
    summary: s.summary,
    domain: s.domain,
    risk_level: s.risk_level,
    trust_tier: s.trust_tier,
    required_permissions: s.required_permissions,
    execution_mode: s.execution_mode ?? null,
    sensitivity_level: s.sensitivity_level ?? null,
  }));
  return { skills };
}

async function getAgentRunnableWorkflow({ skill_id }) {
  // Resolve skill via installed skills (respects delegation policy)
  const skillsRes = await request("GET", `/api/skills?installed=true`);
  if (!skillsRes.ok) {
    return {
      error: skillsRes.error?.code ?? "UNKNOWN_ERROR",
      message: skillsRes.error?.message ?? "Failed to fetch installed skills.",
    };
  }

  const skill = skillsRes.data.find((s) => s.skill_id === skill_id);
  if (!skill) {
    return {
      error: "SKILL_NOT_FOUND",
      message: `Skill "${skill_id}" was not found among installed skills visible to this delegation.`,
    };
  }

  if (skill.execution_mode !== "agent_runnable") {
    return {
      error: "NOT_AGENT_RUNNABLE",
      message: `"${skill.name}" has execution_mode="${skill.execution_mode ?? "aegis_controlled"}". This workflow must be executed by Aegis, not by the agent. Call request_skill_run instead.`,
      execution_mode: skill.execution_mode ?? "aegis_controlled",
      sensitivity_level: skill.sensitivity_level ?? null,
    };
  }

  // Fetch the route recipe — this endpoint requires no auth
  let routeRes;
  try {
    const raw = await fetch(`${API_BASE}/api/routes/${skill.route_id}`);
    routeRes = await raw.json();
  } catch (err) {
    return { error: "NETWORK_ERROR", message: `Failed to fetch route: ${err.message}` };
  }

  if (!routeRes.ok) {
    return {
      error: routeRes.error?.code ?? "ROUTE_NOT_FOUND",
      message: routeRes.error?.message ?? `Route "${skill.route_id}" not found.`,
    };
  }

  const route = routeRes.data;

  return {
    skill_id: skill.skill_id,
    skill_name: skill.name,
    domain: skill.domain,
    execution_mode: "agent_runnable",
    sensitivity_level: skill.sensitivity_level ?? "routine",
    route_id: route.route_id,
    workflow_name: route.workflow_name,
    workflow_description: route.workflow_description,
    trust_tier: route.trust_tier,
    variables: route.variables ?? [],
    steps: route.steps ?? [],
    guidance: `Execute these steps in your own browser session on ${skill.domain}. Navigate to the domain first if not already there. For each step, use the preferred_locator; fall back to fallback_locators in order if the preferred one is not found. For steps with a variable_binding, substitute the corresponding value from the variables you supply at runtime. Do not request a RouteRun for this workflow — execute it directly with your browser tools.`,
  };
}

async function listVaultPasses({ domain, kind, query } = {}) {
  let res;
  try {
    res = await request("GET", "/api/vault-passes");
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to fetch vault passes." };

  let passes = res.data;
  if (domain) passes = passes.filter((p) => p.domain === domain);
  if (kind) passes = passes.filter((p) => p.kind === kind);
  if (query) {
    const q = query.toLowerCase();
    passes = passes.filter((p) =>
      p.label.toLowerCase().includes(q) ||
      (p.username && p.username.toLowerCase().includes(q)) ||
      p.domain.toLowerCase().includes(q)
    );
  }
  return {
    passes: passes.map((p) => ({
      pass_id: p.pass_id,
      label: p.label,
      kind: p.kind,
      domain: p.domain,
      username: p.username ?? null,
      has_password: p.has_password,
    })),
  };
}

async function requestSkillRun({ skill_id, variables = {}, pass_overrides }) {
  const body = { variables };
  if (pass_overrides && Object.keys(pass_overrides).length > 0) body.pass_overrides = pass_overrides;
  const res = await request("POST", `/api/skills/${skill_id}/runs`, body);
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
      "Discover which Aegis-installed skills (verified workflow routes) are available to this delegated agent on a given domain. Each skill includes execution_mode and sensitivity_level. execution_mode='agent_runnable' means Aegis has a verified route recipe the agent can fetch with get_agent_runnable_workflow and execute in its own browser session — no extension handoff, no RouteRun. execution_mode='aegis_controlled' means the workflow is sensitive (credentials, payments, personal data, form submission, account changes) and execution must be delegated to Aegis via request_skill_run. Use this first to understand which Aegis-governed paths exist and how to invoke them.",
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
    name: "get_agent_runnable_workflow",
    description:
      "Retrieve the step-by-step route recipe for an agent-runnable skill so the agent can execute it in its own browser session. Returns skill metadata, route steps with locators, variable definitions, and execution guidance. Only works for skills with execution_mode='agent_runnable'. For aegis_controlled skills this tool returns an error — use request_skill_run instead.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "The skill_id from discover_installed_skills. Must be an agent_runnable skill.",
        },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "list_vault_passes",
    description:
      "List Aegis vault credential metadata available to this delegated user. Returns labels, usernames, domains, kinds, and pass_ids only — never passwords or secret values. Use this when the user names a credential ('use my Test Login account', 'use the staging credentials') so you can identify the correct pass_id and supply it in pass_overrides when calling request_skill_run. Optionally filter by domain, kind, or a free-text query matching label/username/domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Filter to passes for a specific domain, e.g. 'localhost'." },
        kind: { type: "string", description: "Filter to a credential kind. Only 'login_password' is supported in v1." },
        query: { type: "string", description: "Free-text search across label, username, and domain (case-insensitive substring)." },
      },
      required: [],
    },
  },
  {
    name: "request_skill_run",
    description:
      "Request Aegis to execute an installed skill (a verified workflow route) on behalf of this agent. Use this only for aegis_controlled / sensitive skills — credentials, payments, personal data, form submission, account changes, or any action requiring an audit trail and Aegis custody. For agent_runnable skills, call get_agent_runnable_workflow instead to get the route recipe and execute it in your own browser session. Returns a run_id and initial status. If approval_required is true, the run is gated by human approval — direct the user to the approval UI and poll get_route_run_status until status changes. Execution is controlled by Aegis, never by the agent directly. If the user named a specific credential, call list_vault_passes first to find the pass_id, then supply it in pass_overrides.",
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
        pass_overrides: {
          type: "object",
          description:
            "Optional per-run credential override. Key = purpose (only \"login_password\" in v1), value = pass_id from list_vault_passes. Example: { \"login_password\": \"pass_vault_abc123\" }. Use when the user specifies a credential by name. Omit to fall back to persistent route binding or route default.",
          additionalProperties: { type: "string" },
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
    case "get_agent_runnable_workflow":
      result = await getAgentRunnableWorkflow(a);
      break;
    case "list_vault_passes":
      result = await listVaultPasses(a);
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
