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
 *   AEGIS_AGENT_TOKEN   Bearer delegation token — the delegation_token returned by
 *                       POST /api/delegations (i.e. pass.token, not the pass ID).
 *                       Demo default: pass_demo_001 (id === token for demo passes).
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

async function getAgentIdentity() {
  let res;
  try {
    res = await request("GET", "/api/agent/v1/me");
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get agent identity." };
  }
  const d = res.data;
  return {
    agent_name: d.agent_name,
    delegation_id: d.delegation_id,
    platform: d.agent_platform ?? null,
    policy_mode: d.policy_mode ?? null,
    collar_active: d.collar_active,
    baseline_policy_active: d.baseline_policy_active ?? false,
    execution_blocked: d.execution_blocked,
    delegation_status: d.delegation_status,
    token_scope: d.token_scope ?? null,
  };
}

async function listAvailableSkills({ domain } = {}) {
  const path = domain
    ? `/api/agent/v1/skills?domain=${encodeURIComponent(domain)}`
    : "/api/agent/v1/skills";
  let res;
  try {
    res = await request("GET", path);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to fetch skills." };
  }
  return {
    skills: res.data.map((s) => ({
      skill_id: s.skill_id,
      name: s.name,
      summary: s.summary ?? null,
      domain: s.domain,
      risk_level: s.risk_level ?? null,
      execution_mode: s.execution_mode ?? null,
      sensitivity_level: s.sensitivity_level ?? null,
    })),
  };
}

async function startControlledBrowserSession({ delegation_id, debug_visible = false } = {}) {
  return startTaskBrowserSession({ delegation_id, debug_visible });
}

async function discoverInstalledSkills({ domain }) {
  const res = await request(
    "GET",
    `/api/agent/v1/skills?domain=${encodeURIComponent(domain)}`
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
  return {
    skills,
    ...(skills.length === 0
      ? {
          credential_session_available: true,
          guidance:
            "No Aegis-controlled skills found for this domain. " +
            "For normal username/password login, no skill is needed — use request_secret_field_injection (primary path): " +
            "navigate to the login page in your Playwright browser, then call request_secret_field_injection for username and password fields. " +
            "One user approval covers both fields. The agent submits the form itself. " +
            "Routes/skills are for high-risk workflows with exact verified action sequences (payments, banking, account deletion) — not for normal login. " +
            "DO NOT use request_authenticated_session_login for normal login when you have a Playwright browser (it is secondary/experimental, for isolated Aegis-controlled browser sessions only). " +
            "DO NOT use start_credential_session — that targets the Aegis Chrome extension on the user's tab and is incompatible with agent-controlled Playwright browsers.",
        }
      : {}),
  };
}

async function getAgentRunnableWorkflow({ skill_id }) {
  // Resolve skill via agent-scoped skills endpoint (respects delegation policy)
  const skillsRes = await request("GET", `/api/agent/v1/skills`);
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
      message: `Skill "${skill_id}" was not found among installed or private-route skills visible to this delegation.`,
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
    guidance: `Execute these steps in your own browser session on ${skill.domain}. Navigate to the domain first if not already there. For each step, use the preferred_locator; fall back to fallback_locators in order if the preferred one is not found. For steps with a variable_binding, substitute the corresponding value from the variables you supply at runtime. Workflow: call request_skill_run to create a run, then start_skill_run before executing, then complete_skill_run (success) or fail_skill_run (failure) after — this closes the audit receipt loop. Do NOT use start_playwright_route_run for agent_runnable skills; that tool is for aegis_controlled runs only.`,
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

function scoreSkills(skills, taskLower) {
  let best = null;
  let bestScore = -1;
  for (const skill of skills) {
    const haystack = `${skill.name} ${skill.summary ?? ""}`.toLowerCase();
    const words = haystack.split(/\W+/).filter((w) => w.length > 2);
    let score = 0;
    for (const word of words) {
      if (taskLower.includes(word)) score++;
    }
    if (score > bestScore) { bestScore = score; best = skill; }
  }
  return bestScore > 0 ? best : null;
}

async function startPlaywrightRouteRun({ run_id } = {}) {
  if (!run_id) return { error: "MISSING_RUN_ID", message: "run_id is required." };
  const res = await request("POST", `/api/runtime/route-runs/${encodeURIComponent(run_id)}/playwright/start`);
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to start Playwright run.",
    };
  }
  return {
    runtime_session_id: res.data?.runtime_session_id,
    run_id: res.data?.run_id,
    status: res.data?.status,
    execution_surface: res.data?.execution_surface,
    completed_at: res.data?.completed_at ?? null,
    error: res.data?.error ?? null,
    runtime_events_count: (res.data?.runtime_events ?? []).length,
  };
}

async function planAegisAction({ task, domain, credential_hint } = {}) {
  const taskLower = (task ?? "").toLowerCase();

  // Resolve domain from arg or task keywords
  let resolvedDomain = domain ?? null;
  if (!resolvedDomain) {
    if (taskLower.includes("demo") || taskLower.includes("localhost")) {
      resolvedDomain = "localhost:3000";
    } else if (taskLower.includes("wikipedia")) {
      resolvedDomain = "en.wikipedia.org";
    }
  }

  const skillsPath = resolvedDomain
    ? `/api/skills?domain=${encodeURIComponent(resolvedDomain)}&installed=true`
    : `/api/skills?installed=true`;

  let skillsRes;
  try {
    skillsRes = await request("GET", skillsPath);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!skillsRes.ok) {
    return {
      error: skillsRes.error?.code ?? "UNKNOWN_ERROR",
      message: skillsRes.error?.message ?? "Failed to fetch installed skills.",
    };
  }

  const skills = skillsRes.data ?? [];
  const matchedSkill = skills.length > 0 ? scoreSkills(skills, taskLower) : null;

  const SENSITIVE_KEYWORDS = ["buy", "purchase", "payment", "transfer", "delete"];
  const taskIsSensitive = SENSITIVE_KEYWORDS.some((kw) => taskLower.includes(kw));
  const LOGIN_SIGNALS = ["log in", "login", "sign in", "signin", "log into", "sign into"];
  const taskIsLogin = LOGIN_SIGNALS.some((kw) => taskLower.includes(kw));

  if (!matchedSkill) {
    // No pre-recorded route — for login tasks, use Agent-Browser Secret Injection (primary path)
    if (taskIsLogin) {
      return {
        recommended_path: "agent_browser_secret_injection",
        explanation:
          "No pre-recorded Aegis skill needed for normal username/password login. " +
          "Use your own Playwright browser for all navigation, clicking, and reading. " +
          "Use Aegis only to inject the protected credential fields (username, password) via CDP. " +
          "The agent navigates to the login page, chooses username/password (not OAuth), then calls " +
          "request_secret_field_injection to have Aegis fill each field. One user approval covers both " +
          "username and password for the login attempt. After both fields are filled, the agent clicks Submit itself.",
        next_tool: "request_secret_field_injection",
        workflow: [
          "0. [Path selection] If you already have @playwright/mcp or another browser tool: SKIP start_task_browser_session — you own the browser. Note the CDP port your browser is running on (e.g. 9222) and pass it as external_cdp_url in steps 4 and 7. If you have NO browser tool: call start_task_browser_session. If reused_existing=true, session is already active. If requires_browser_reconnect=true, reconnect your adapter using the returned cdp_url before navigating.",
          "1. Navigate to the login page in your Playwright browser.",
          "2. Choose username/password path (not OAuth — Aegis cannot fill OAuth flows).",
          "3. Call list_vault_passes to find the pass_id for the credential provider domain. Each pass has a domain field (e.g. 'github.com') — select the pass whose domain matches the login page you navigated to, not the originating site. If Supabase redirected you to github.com for OAuth login, find the GitHub credential (domain='github.com'), not a Supabase credential.",
          "4. Call request_secret_field_injection({ domain, field_kind: 'username', page_url, reason, external_cdp_url? }). If you own the browser (External Browser Handoff path), pass external_cdp_url (e.g. 'http://localhost:9222'). If you used start_task_browser_session, pass browser_session_id instead. Do not pass both.",
          "5. If status='pending_approval': tell the user to approve in Aegis UI, then call wait_for_credential_authorization({ authorization_id }) — do NOT ask user to type 'done'.",
          "6. When wait_for_credential_authorization returns status='approved': call execute_secret_field_injection with the injection_request_id.",
          "7. Call request_secret_field_injection again for field_kind: 'password' with the same external_cdp_url or browser_session_id (auto-attached to same authorization, no second approval needed if already approved).",
          "8. Call execute_secret_field_injection for the password injection.",
          "9. Click Submit / Sign In yourself in your Playwright browser.",
          "9a. If a security verification challenge appears after Submit (device verification email, 2FA, TOTP): call report_security_challenge({ domain, page_url, challenge_type, browser_session_id }) — always include the browser_session_id from step 0. Without it, Aegis injects into the wrong browser port and fails. Then call wait_for_security_challenge, and either inject_security_challenge_code (manual) or request_challenge_email_resolution → wait_for_challenge_email_resolution → inject_challenge_email_code (Gmail). After injection, click Verify yourself.",
          "10. Continue using your browser for the rest of the task. Use your own tools (@playwright/mcp) to navigate, read, and summarize pages — Aegis does not observe or read page content on the External Browser Handoff path. Only call close_task_browser_session if you used an Aegis-managed session (step 0 bridge path), and only after the full task is complete.",
          "11. [GitHub repo listing and similar dynamic lists] After login, navigate to the target page yourself. Verify dynamic content: check displayed count, scroll to load all visible items, inspect pagination links. Do not claim 'all repos' or 'all items' unless you verified count and pagination. If uncertain, report exactly what you can see: 'I can see X items on the current page.' Aegis does not read or summarize content — you own the reading step.",
        ],
        note: "DO NOT use request_authenticated_session_login for normal login when you have a Playwright browser — that tool performs the ENTIRE login in a separate Aegis-controlled browser and is secondary/experimental. DO NOT use start_credential_session — that targets the Aegis Chrome extension on the user's tab, incompatible with agent Playwright browsers.",
        suggested_domain: resolvedDomain ?? null,
      };
    }
    if (taskIsSensitive) {
      return {
        recommended_path: "no_match",
        explanation:
          "No matching Aegis workflow found. This task appears sensitive — check the Aegis Skill Library for a verified workflow before proceeding with agent tools.",
        safety_note:
          "Sensitive actions (payments, purchases, data deletion) should go through Aegis-verified workflows when available.",
      };
    }
    return {
      recommended_path: "normal_agent_tools",
      explanation:
        "No installed Aegis workflow matched this task. Use your normal agent tools. Note: if this task involves sensitive credentials, payments, or account changes, those actions should be handled through Aegis workflows.",
    };
  }

  if (matchedSkill.execution_mode === "agent_runnable") {
    return {
      recommended_path: "agent_runnable_recipe",
      matched_skill: { skill_id: matchedSkill.skill_id, name: matchedSkill.name, domain: matchedSkill.domain },
      next_tool: "get_agent_runnable_workflow",
      suggested_request: { skill_id: matchedSkill.skill_id },
      explanation:
        "This is a routine workflow. Aegis will provide the tested route recipe for you to execute in your own browser session.",
    };
  }

  // aegis_controlled branch (also default for unknown execution_mode)
  const CREDENTIAL_SIGNALS = ["credential", "my account", "my password", "using my", "log in as"];
  const needsCredential = !!credential_hint || CREDENTIAL_SIGNALS.some((kw) => taskLower.includes(kw));

  if (!needsCredential) {
    return {
      recommended_path: "aegis_controlled_run",
      matched_skill: { skill_id: matchedSkill.skill_id, name: matchedSkill.name, domain: matchedSkill.domain },
      next_tool: "request_skill_run",
      suggested_request: { skill_id: matchedSkill.skill_id, variables: {} },
      post_approval_next_tool: "start_playwright_route_run",
      post_approval_note: "Aegis will auto-start the Playwright runtime immediately after the user approves. Poll get_route_run_status — the run should transition from pending to running and then completed without any manual step. If the run remains pending, call start_playwright_route_run as a fallback.",
      explanation:
        "This is a sensitive workflow requiring Aegis control. Call request_skill_run to create the run. If approval is required, direct the user to /route-run-approvals and poll until status is no longer pending_approval. Then call start_playwright_route_run — do not rely on the Chrome extension or ask the user to open a tab.",
    };
  }

  let passesRes;
  try {
    passesRes = await request("GET", "/api/vault-passes");
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!passesRes.ok) {
    return {
      error: passesRes.error?.code ?? "UNKNOWN_ERROR",
      message: passesRes.error?.message ?? "Failed to fetch vault passes.",
    };
  }

  let candidates = passesRes.data ?? [];
  if (matchedSkill.domain) {
    candidates = candidates.filter((p) => p.domain === matchedSkill.domain);
  }
  if (credential_hint) {
    const hint = credential_hint.toLowerCase();
    candidates = candidates.filter(
      (p) =>
        p.label.toLowerCase().includes(hint) ||
        (p.username && p.username.toLowerCase().includes(hint))
    );
  }

  const passMetadata = (p) => ({ pass_id: p.pass_id, label: p.label, username: p.username ?? null });

  if (candidates.length === 0) {
    return {
      recommended_path: "aegis_controlled_run",
      matched_skill: { skill_id: matchedSkill.skill_id, name: matchedSkill.name, domain: matchedSkill.domain },
      credential_resolution: "not_found",
      next_tool: "request_skill_run",
      suggested_request: { skill_id: matchedSkill.skill_id, variables: {} },
      post_approval_next_tool: "start_playwright_route_run",
      post_approval_note: "After approval, call start_playwright_route_run with the run_id. Aegis opens the page and executes in its own Chromium session. Do not ask the user to manually open the target page.",
      explanation: credential_hint
        ? `No vault pass matching "${credential_hint}" was found for domain "${matchedSkill.domain}". Call request_skill_run without pass_overrides to use the route default, or call list_vault_passes to browse available passes.`
        : `No vault passes found for domain "${matchedSkill.domain}". Call request_skill_run without pass_overrides to use the route default.`,
    };
  }

  if (candidates.length > 1) {
    return {
      recommended_path: "aegis_controlled_run",
      matched_skill: { skill_id: matchedSkill.skill_id, name: matchedSkill.name, domain: matchedSkill.domain },
      credential_resolution: "needs_clarification",
      needs_clarification: true,
      candidates: candidates.map(passMetadata),
      post_approval_next_tool: "start_playwright_route_run",
      post_approval_note: "After clarifying the credential and approving the run, call start_playwright_route_run with the run_id.",
      explanation:
        "Multiple vault credentials matched. Ask the user which one to use, then re-call plan_aegis_action with a more specific credential_hint, or call request_skill_run directly with the chosen pass_id in pass_overrides.",
    };
  }

  const matched_pass = candidates[0];
  return {
    recommended_path: "aegis_controlled_run",
    matched_skill: { skill_id: matchedSkill.skill_id, name: matchedSkill.name, domain: matchedSkill.domain },
    matched_pass: passMetadata(matched_pass),
    next_tool: "request_skill_run",
    suggested_request: {
      skill_id: matchedSkill.skill_id,
      variables: {},
      pass_overrides: { login_password: matched_pass.pass_id },
    },
    post_approval_next_tool: "start_playwright_route_run",
    post_approval_note: "After the user approves the pending run (if approval is required), call start_playwright_route_run with the run_id returned by request_skill_run. Aegis opens the target page and executes the workflow in its own Chromium session — credentials resolved from the KMS vault. Do not ask the user to manually open the target page.",
    explanation:
      "This is a sensitive workflow requiring Aegis control. Your selected credential will be resolved server-side by the Aegis Playwright runtime — no passwords are exposed to the agent.",
  };
}

async function assessSensitiveRequirements({ task, domain } = {}) {
  if (!task) return { error: "VALIDATION_ERROR", message: "task is required." };

  const taskLower = task.toLowerCase();

  const LOGIN_SIGNALS    = ["log in", "login", "sign in", "signin", "log into", "sign into", "authenticate"];
  const PAYMENT_SIGNALS  = ["buy", "purchase", "pay", "checkout", "order", "payment", "credit card", "billing", "subscribe", "subscription"];
  const SIGNUP_SIGNALS   = ["sign up", "signup", "create account", "register", "create a new account", "open an account"];
  const IDENTITY_SIGNALS = ["verify identity", "identity verification", "id verification", "ssn", "social security", "kyc", "know your customer", "biometric"];

  const taskIsLogin    = LOGIN_SIGNALS.some((kw)    => taskLower.includes(kw));
  const taskIsPayment  = PAYMENT_SIGNALS.some((kw)  => taskLower.includes(kw));
  const taskIsSignup   = SIGNUP_SIGNALS.some((kw)   => taskLower.includes(kw));
  const taskIsIdentity = IDENTITY_SIGNALS.some((kw) => taskLower.includes(kw));

  let resolvedDomain = domain ?? null;
  if (!resolvedDomain) {
    if (taskLower.includes("demo") || taskLower.includes("localhost")) {
      resolvedDomain = "localhost:3000";
    } else if (taskLower.includes("wikipedia")) {
      resolvedDomain = "en.wikipedia.org";
    }
  }

  const skillsPath = resolvedDomain
    ? `/api/skills?domain=${encodeURIComponent(resolvedDomain)}&installed=true`
    : `/api/skills?installed=true`;

  let skills = [];
  try {
    const skillsRes = await request("GET", skillsPath);
    if (skillsRes.ok) skills = skillsRes.data ?? [];
  } catch (_) {}

  const matchedSkill = skills.length > 0 ? scoreSkills(skills, taskLower) : null;
  const availableAegisRoutes = matchedSkill
    ? [{ skill_id: matchedSkill.skill_id, name: matchedSkill.name, domain: matchedSkill.domain, execution_mode: matchedSkill.execution_mode, note: "Advisory only — the agent may choose to use this route; it is not required." }]
    : [];

  if (taskIsIdentity) {
    return {
      recommended_mode: "requires_user_presence",
      possible_sensitive_requirements: ["identity_document", "biometric_check", "government_id"],
      unsupported_reason:
        "Identity verification tasks require direct user presence and cannot be delegated to an agent in v1. " +
        "Aegis does not handle government IDs, biometric checks, or KYC flows.",
      ...(availableAegisRoutes.length > 0 && { available_aegis_routes: availableAegisRoutes }),
      must_not_do: [
        "submit or transmit government-issued document numbers on behalf of the user",
        "attempt to pass a biometric or liveness check",
        "proceed past an identity verification gate without explicit user confirmation",
      ],
    };
  }

  if (taskIsSignup) {
    return {
      recommended_mode: "requires_explicit_approval",
      possible_sensitive_requirements: ["new_account_creation", "terms_acceptance", "email_verification"],
      unsupported_reason:
        "Account signup creates a new persistent identity for the user. " +
        "Signup Credential Custody is not yet implemented in v1 — Aegis cannot safely manage credentials created during signup. " +
        "The user must perform account creation themselves or an approved signup workflow must exist.",
      ...(availableAegisRoutes.length > 0 && { available_aegis_routes: availableAegisRoutes }),
      must_not_do: [
        "create an account without explicit user approval",
        "accept terms of service on behalf of the user without review",
        "generate or store account credentials for newly created accounts",
        "treat signup as equivalent to login",
      ],
    };
  }

  if (taskIsPayment) {
    return {
      recommended_mode: "requires_aegis_sensitive_workflow",
      possible_sensitive_requirements: ["payment_method", "billing_address", "order_confirmation", "sensitive_action_receipt"],
      explanation:
        "Payment and purchase tasks are high-risk irreversible actions. " +
        "Aegis must execute these through a verified Aegis Rail (request_skill_run + start_playwright_route_run) " +
        "with collar-enforced spending limits and a signed receipt. " +
        "The agent must not attempt payment workflows without a verified route.",
      ...(availableAegisRoutes.length > 0
        ? { available_aegis_routes: availableAegisRoutes, next_step: "A matching Aegis skill was found. The agent may use request_skill_run with the skill_id, then start_playwright_route_run after approval." }
        : { next_step: "No matching Aegis skill found for this task. Check the Aegis Skill Library before proceeding." }),
      user_approval_points: ["payment method use", "order confirmation", "spending limit step-up if required"],
      must_not_do: [
        "attempt to complete a purchase without a verified Aegis Rail",
        "enter or relay payment card numbers, CVVs, or billing data",
        "click order confirmation controls without Aegis route authorization",
        "treat payment as a simple form fill",
      ],
    };
  }

  if (taskIsLogin) {
    return {
      recommended_mode: "agent_owned_task_with_aegis_interventions",
      possible_sensitive_requirements: ["login_credential", "verification_challenge", "ephemeral_browser_session", "sensitive_action_receipt"],
      recommended_aegis_interventions: [
        {
          when: "before browser-based authenticated work",
          tool: "start_task_browser_session",
          reason: "creates an ephemeral browser profile with password saving and autofill disabled; destroyed on close",
        },
        {
          when: "when a username field is encountered on the login page",
          tool: "request_secret_field_injection",
          params: { field_kind: "username" },
          reason: "Aegis fills the username from vault metadata via CDP; agent does not receive the raw value",
        },
        {
          when: "when a password field is encountered on the login page",
          tool: "request_secret_field_injection",
          params: { field_kind: "password" },
          reason: "Aegis fills the password from KMS-encrypted vault via CDP; agent does not receive the raw value",
        },
        {
          when: "if a security verification challenge appears after form submit (email code, SMS, TOTP, device verification)",
          tool: "report_security_challenge",
          paths: [
            {
              when: "email-based challenge on a supported provider domain",
              tools: ["request_challenge_email_resolution", "wait_for_challenge_email_resolution", "inject_challenge_email_code"],
              reason: "Connected Email Challenge Resolver automatically fetches and injects the verification code; no user action needed after approval",
            },
            {
              when: "unsupported domain or automatic resolution fails",
              tools: ["wait_for_security_challenge", "inject_security_challenge_code"],
              reason: "Manual Challenge Relay — user enters the code in Aegis UI; agent never receives the raw code",
            },
          ],
          reason: "challenge relay without exposing raw verification codes to the agent or chat",
        },
        {
          when: "when task is fully complete or has terminally failed",
          tool: "close_task_browser_session",
          reason: "destroys ephemeral profile and all cookies; required to prevent session persistence",
        },
      ],
      ...(availableAegisRoutes.length > 0 && { available_aegis_routes: availableAegisRoutes }),
      agent_owned_steps: [
        "navigate to the login page",
        "identify and select the username/password path",
        "click Next, Sign In, Submit, or equivalent form controls",
        "read page content and verify login success",
        "continue with the post-login task (navigate, read, summarize, etc.)",
        "decide whether to use an available Aegis route if one is listed",
      ],
      credential_injection_note:
        "For OAuth flows: Aegis should not inject credentials into a requesting site simply because it initiated an OAuth flow. " +
        "If the browser is redirected to the actual provider-owned login domain, Aegis may inject the provider credential there under normal credential custody rules. " +
        "The injection domain must always match the provider's domain — not the originating site.",
      user_approval_points: [
        "credential use (one approval covers both username and password for the login attempt)",
        "email challenge resolution if a verification email is sent (Connected Email Challenge Resolver)",
        "manual challenge code relay if automatic email resolution fails or domain is not supported",
      ],
      browser_mode_guidance: {
        if_agent_has_own_browser_tooling: {
          path: "external_browser_handoff",
          description:
            "You own the browser. Use @playwright/mcp (or equivalent) for all navigation, clicking, and page reading. " +
            "Pass external_cdp_url (e.g. 'http://localhost:9222') to request_secret_field_injection — Aegis fills only the " +
            "protected credential fields. Do NOT call start_task_browser_session — you already have a browser.",
          skip_tools: ["start_task_browser_session", "navigate_task_browser_session", "observe_task_browser_session", "click_task_browser_session"],
        },
        if_agent_has_no_browser_tooling: {
          path: "controlled_browser_bridge",
          description:
            "Aegis owns the browser. Call start_task_browser_session first, then use the bridge navigate/observe/click " +
            "endpoints for page interaction. Pass browser_session_id (not external_cdp_url) to request_secret_field_injection.",
        },
      },
      must_not_do: [
        "ask the user to paste verification codes into chat — use report_security_challenge instead",
        "request raw credentials from the user",
        "reuse the browser session after close_task_browser_session — start a fresh session",
        "treat payment, signup, or identity verification encountered during login as a simple continuation",
        "inject credentials into a requesting site's domain just because it initiated an OAuth redirect",
        "use start_credential_session or fill_credential_field — those target the Chrome extension, not an agent Playwright browser",
        "use request_authenticated_session_login unless the agent has no Playwright browser of its own",
        "pass both external_cdp_url and browser_session_id to request_secret_field_injection — they are mutually exclusive",
      ],
    };
  }

  return {
    recommended_mode: "agent_owned_task_with_aegis_interventions",
    possible_sensitive_requirements: [],
    recommended_aegis_interventions: [
      {
        when: "if an authenticated browser session is needed for the task",
        tool: "start_task_browser_session",
        reason: "ephemeral browser custody for any authenticated web task",
      },
      {
        when: "if a login form or credential-protected page is unexpectedly encountered",
        tool: "assess_sensitive_requirements",
        params: { task: "log into <domain>" },
        reason: "re-assess with login-specific signals to get the correct intervention list",
      },
      {
        when: "when task is complete or terminally failed",
        tool: "close_task_browser_session",
        reason: "destroy ephemeral profile",
      },
    ],
    ...(availableAegisRoutes.length > 0 && { available_aegis_routes: availableAegisRoutes }),
    agent_owned_steps: [
      "navigate pages using browser tools",
      "read and summarize content",
      "click non-sensitive controls",
      "reason and plan next steps",
    ],
    must_not_do: [
      "pass raw credentials, tokens, or secrets through chat",
      "perform payment or financial actions without first calling assess_sensitive_requirements",
    ],
  };
}

async function createDelegationPassport({ delegation_id, expires_in_minutes } = {}) {
  if (!delegation_id) return { error: "VALIDATION_ERROR", message: "delegation_id is required." };
  const body = { delegation_id };
  if (expires_in_minutes != null) body.expires_in_minutes = expires_in_minutes;
  let res;
  try {
    res = await request("POST", "/api/delegation-passports", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to create delegation passport." };
  }
  const passport = res.data;
  return {
    passport_id: passport.passport_id,
    issuer: passport.issuer,
    issued_at: passport.issued_at,
    expires_at: passport.expires_at,
    status: passport.status,
    human_subject: passport.human_subject,
    agent_subject: passport.agent_subject,
    delegation: passport.delegation,
    capability_attestations: passport.capability_attestations,
    secret_custody: passport.secret_custody,
    aegis_coverage_boundary: passport.aegis_coverage_boundary,
    evidence_summary: passport.evidence_summary,
    verification: {
      passport_hash: passport.verification?.passport_hash,
      passport_jws: passport.verification?.passport_jws,
    },
    next_action: `Passport created. Call verify_delegation_passport with passport_id="${passport.passport_id}" to confirm integrity. Present passport_jws to counterparties as a signed Aegis delegation claim.`,
  };
}

async function verifyDelegationPassport({ passport_id } = {}) {
  if (!passport_id) return { error: "VALIDATION_ERROR", message: "passport_id is required." };
  let res;
  try {
    res = await request("GET", `/api/delegation-passports/${encodeURIComponent(passport_id)}/verify`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to verify delegation passport." };
  }
  const v = res.data;
  return {
    passport_id,
    valid: v.valid,
    hash_valid: v.hash_valid,
    signature_valid: v.signature_valid,
    active: v.active,
    expired: v.expired,
    revoked: v.revoked,
    passport_hash: v.passport_hash,
    recomputed_hash: v.recomputed_hash,
    jws_payload: v.jws_payload,
    error: v.error ?? null,
    interpretation: v.valid
      ? "Passport is valid and active. The named delegation is Aegis-controlled with the stated custody model, collar limits, and receipt evidence. This does NOT prove the agent has no out-of-band secrets."
      : `Passport is NOT valid: ${v.error ?? "unknown reason"}. Do not rely on this passport for delegation claims.`,
  };
}

async function getWebsiteAgentSafetyProfile({ domain, task_category } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!task_category) return { error: "VALIDATION_ERROR", message: "task_category is required." };
  let res;
  try {
    res = await request("GET", `/api/website-agent-safety/profile?domain=${encodeURIComponent(domain)}&task_category=${encodeURIComponent(task_category)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get website agent safety profile." };
  }
  const profile = res.data;
  return {
    profile_id: profile.profile_id,
    generated_at: profile.generated_at,
    domain: profile.domain,
    requested_task_category: profile.requested_task_category,
    website_verification_level: profile.website_verification_level,
    agent_safety_status: profile.agent_safety_status,
    recommendation: profile.recommendation,
    confidence: profile.confidence,
    capabilities: profile.capabilities,
    safety_signals: profile.safety_signals,
    task_fit: profile.task_fit,
    disqualifying_signals: profile.disqualifying_signals,
    limitations: profile.limitations,
    interpretation: interpretSafetyProfile(profile),
  };
}

function interpretSafetyProfile(profile) {
  const { recommendation, confidence, agent_safety_status, domain, requested_task_category, disqualifying_signals } = profile;
  const base = `Website '${domain}' agent safety for '${requested_task_category}': ${recommendation} (status: ${agent_safety_status}, confidence: ${confidence}).`;
  const note = {
    allow: "Aegis has sufficient evidence to allow direct agent interaction for this task.",
    allow_with_approval: `Agent may proceed with human approval. Aegis has verified route(s) and clean execution evidence for this task.`,
    step_up_required: `Human step-up confirmation required before agent interaction. ${disqualifying_signals.length ? "Signals: " + disqualifying_signals.join(", ") + "." : "No prior Aegis-covered execution evidence for this task."}`,
    deny: `Do not proceed. Disqualifying signals: ${disqualifying_signals.join(", ")}.`,
  }[recommendation] ?? "";
  const caveat = "This profile is advisory only — not a business verification, no live crawl performed, not a guarantee.";
  return `${base} ${note} ${caveat}`;
}

async function getWebsiteAegisPolicy({ domain } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  let res;
  try {
    res = await request("GET", `/api/website-aegis-policy?domain=${encodeURIComponent(domain)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error ?? "POLICY_NOT_AVAILABLE", message: res.message ?? "Policy not available for this domain." };
  }
  const { policy, validation } = res.data;
  return {
    domain: policy?.domain,
    version: policy?.version,
    agent_access: policy?.agent_access,
    verification_level: policy?.verification_level,
    policy_source: policy?.policy_source,
    supported_workflows: policy?.supported_workflows,
    required_assertions: policy?.required_assertions,
    limitations: policy?.limitations,
    validation: {
      valid: validation?.valid,
      warnings: validation?.warnings,
      errors: validation?.errors,
    },
  };
}

async function validateWebsiteAegisPolicy({ domain } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  let res;
  try {
    res = await request("GET", `/api/website-aegis-policy/validate?domain=${encodeURIComponent(domain)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error ?? "POLICY_NOT_AVAILABLE", message: res.message ?? "Policy not available for this domain." };
  }
  return res.data;
}

async function checkWebsitePolicyCompatibility({ domain, task_category } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!task_category) return { error: "VALIDATION_ERROR", message: "task_category is required." };
  let res;
  try {
    res = await request("GET", `/api/website-aegis-policy/compatibility?domain=${encodeURIComponent(domain)}&task_category=${encodeURIComponent(task_category)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error ?? "POLICY_NOT_AVAILABLE", message: res.message ?? "Policy not available for this domain." };
  }
  return res.data;
}

async function getDelegationTrustProfile({ delegation_id, task_category } = {}) {
  if (!delegation_id) return { error: "VALIDATION_ERROR", message: "delegation_id is required." };
  if (!task_category) return { error: "VALIDATION_ERROR", message: "task_category is required." };
  let res;
  try {
    res = await request("GET", `/api/delegation-trust/profile?delegation_id=${encodeURIComponent(delegation_id)}&task_category=${encodeURIComponent(task_category)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get delegation trust profile." };
  }
  const profile = res.data;
  return {
    ...profile,
    interpretation: interpretTrustProfile(profile),
  };
}

function interpretTrustProfile(profile) {
  const { trust_status, confidence, category_experience, limitations } = profile;
  const categoryStr = category_experience.category;
  const base = `Trust status for '${categoryStr}': ${trust_status} (confidence: ${confidence}).`;
  const caveat = "This profile is advisory only. It does not cover out-of-band secret use and is not a guarantee of safe behavior.";
  const statusNote = {
    trusted_for_category: `This delegation has proven safe Aegis-covered behavior for '${categoryStr}' with ${category_experience.fulfilled_authorizations} fulfilled authorization(s) and clean sensitive workflow coverage.`,
    proven_limited: `This delegation has some positive Aegis-covered history for '${categoryStr}' (${category_experience.fulfilled_authorizations} fulfilled authorization(s)), but not enough for full trust.`,
    capable_but_unproven: `Capability exists for '${categoryStr}' but no Aegis-covered execution history has been established yet.`,
    unproven: `No capability or execution history found for '${categoryStr}'. ${profile.disqualifying_signals.join(", ")}.`,
    caution: `Uncovered sensitive events detected in execution history — proceed with extra approval caution.`,
    risky: `Secret exposure events detected — this delegation should NOT be used for sensitive tasks without investigation.`,
    suspended: "Delegation is not active. No trust operations permitted.",
  }[trust_status] ?? "";
  return `${base} ${statusNote} ${caveat}`;
}

async function startCredentialSession({ pass_id, domain, allowed_fields, target_url }) {
  if (!pass_id) return { error: "VALIDATION_ERROR", message: "pass_id is required." };
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  const body = { pass_id, domain };
  if (allowed_fields?.length) body.allowed_fields = allowed_fields;
  if (target_url) body.target_url = target_url;
  let res;
  try {
    res = await request("POST", "/api/credential-sessions", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to start credential session." };
  }
  const session = res.data;
  return {
    session_id: session.session_id,
    status: session.status,
    domain: session.domain,
    allowed_fields: session.allowed_fields,
    approval_required: true,
    next_action: `Approval required. Direct the user to http://localhost:3000/route-run-approvals to approve the credential session under "Credential Session Requests", then poll get_credential_session_status until status is "active".`,
  };
}

async function fillCredentialField({ session_id, field }) {
  if (!session_id) return { error: "VALIDATION_ERROR", message: "session_id is required." };
  if (!field) return { error: "VALIDATION_ERROR", message: "field is required ('username' or 'password')." };
  let res;
  try {
    res = await request("POST", `/api/credential-sessions/${session_id}/fill`, { field });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to request credential fill." };
  }
  const data = res.data;
  return {
    request_id: data.request_id,
    session_id: data.session_id,
    field: data.field,
    status: data.status,
    message: data.message,
    next_action: `Fill request created. Ensure a tab matching the session domain is active and the Aegis extension is enabled. The extension fills the field automatically on the next poll cycle (~10s). Poll get_credential_session_status to confirm the field appears in fields_filled.`,
  };
}

async function getCredentialSessionStatus({ session_id }) {
  if (!session_id) return { error: "VALIDATION_ERROR", message: "session_id is required." };
  let res;
  try {
    res = await request("GET", `/api/credential-sessions/${session_id}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get credential session status." };
  }
  const session = res.data;
  return {
    session_id: session.session_id,
    status: session.status,
    domain: session.domain,
    allowed_fields: session.allowed_fields,
    fields_filled: (session.fields_filled ?? []).map((f) => ({ field: f.field, filled_at: f.filled_at })),
    expires_at: session.expires_at ?? null,
    terminal: session.terminal ?? false,
    next_action: session.next_action,
  };
}

async function createWebsiteTrustAssertion({ delegation_id, task_category, requesting_domain, requesting_origin, passport_id, human_readable_summary, expires_in_minutes } = {}) {
  if (!delegation_id) return { error: "VALIDATION_ERROR", message: "delegation_id is required." };
  if (!task_category) return { error: "VALIDATION_ERROR", message: "task_category is required." };
  if (!requesting_domain) return { error: "VALIDATION_ERROR", message: "requesting_domain is required." };
  const body = { delegation_id, task_category, requesting_domain };
  if (requesting_origin) body.requesting_origin = requesting_origin;
  if (passport_id) body.passport_id = passport_id;
  if (human_readable_summary) body.human_readable_summary = human_readable_summary;
  if (expires_in_minutes != null) body.expires_in_minutes = expires_in_minutes;
  let res;
  try {
    res = await request("POST", "/api/website-assertions", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to create website trust assertion." };
  }
  const a = res.data;
  return {
    assertion_id: a.assertion_id,
    issuer: a.issuer,
    issued_at: a.issued_at,
    expires_at: a.expires_at,
    requesting_website: a.requesting_website,
    subject: a.subject,
    requested_task: a.requested_task,
    decision: a.decision,
    verification: {
      assertion_hash: a.verification?.assertion_hash,
      assertion_jws: a.verification?.assertion_jws,
    },
    next_action: `Assertion created with recommendation="${a.decision?.recommendation}" and trust_status="${a.decision?.trust_status}". Call verify_website_trust_assertion with assertion_id="${a.assertion_id}" to confirm cryptographic integrity. Present assertion_jws to the requesting website as a signed Aegis trust claim.`,
  };
}

async function verifyWebsiteTrustAssertion({ assertion_id } = {}) {
  if (!assertion_id) return { error: "VALIDATION_ERROR", message: "assertion_id is required." };
  let res;
  try {
    res = await request("GET", `/api/website-assertions/${encodeURIComponent(assertion_id)}/verify`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to verify website trust assertion." };
  }
  const v = res.data;
  return {
    assertion_id,
    valid: v.valid,
    hash_valid: v.hash_valid,
    signature_valid: v.signature_valid,
    expired: v.expired,
    assertion_hash: v.assertion_hash,
    recomputed_hash: v.recomputed_hash,
    jws_payload: v.jws_payload,
    recommendation: v.recommendation,
    trust_status: v.trust_status,
    error: v.error ?? null,
    interpretation: v.valid
      ? `Assertion is valid and active. The recommendation "${v.recommendation}" and trust_status "${v.trust_status}" are cryptographically attested by Aegis.`
      : `Assertion is NOT valid: ${v.error ?? "unknown reason"}. Do not rely on this assertion for trust decisions.`,
  };
}

// ─── Website AegisID Trust Profile handlers ───────────────────────────────────

async function getWebsiteTrustProfile({ domain } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  let res;
  try {
    res = await request("GET", `/api/agent/v1/website-trust/${encodeURIComponent(domain)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get website trust profile." };
  }
  const data = res.data;
  if (!data.profile_found) {
    return {
      domain,
      profile_found: false,
      warning: data.warning,
      interpretation: `No active WebsiteTrustProfile is registered with Aegis for '${domain}'. This domain has not declared its agent commitments. Proceed with caution and require user approval for any sensitive actions.`,
    };
  }
  const verificationNote = data.verification_status === "verified"
    ? "Profile is Aegis-verified."
    : `Profile is '${data.verification_status}' — declarations have not been verified by Aegis.`;
  return {
    profile_found: true,
    profile_id: data.profile_id,
    domain: data.domain,
    company_name: data.company_name,
    verification_status: data.verification_status,
    status: data.status,
    profile_version: data.profile_version,
    agent_policy: data.agent_policy,
    committed_safety_promises: data.safety_promises,
    profile_hash: data.profile_hash,
    jws_present: data.jws_present,
    violation_count: data.violation_count,
    warning: data.warning ?? null,
    interpretation: `${verificationNote} ${data.safety_promises?.length ?? 0} committed safety promise(s) declared. This profile represents the website's declared commitments to agents — not a real-time guarantee of compliance. profile_hash='${data.profile_hash}' can be referenced in future violation receipts.`,
  };
}

async function verifyWebsiteTrustProfile({ profile_id } = {}) {
  if (!profile_id) return { error: "VALIDATION_ERROR", message: "profile_id is required." };
  let res;
  try {
    res = await request("GET", `/api/website-trust-profiles/${encodeURIComponent(profile_id)}/verify`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to verify website trust profile." };
  }
  const v = res.data;
  return {
    profile_id,
    valid: v.valid,
    hash_valid: v.hash_valid,
    signature_valid: v.signature_valid,
    recomputed_hash: v.recomputed_hash,
    stored_hash: v.stored_hash,
    jws_payload: v.jws_payload ?? null,
    error: v.error ?? null,
    interpretation: v.valid
      ? "Trust profile is cryptographically intact. The declared commitments have not been tampered with since Aegis signed this profile."
      : `Trust profile is NOT valid: ${v.error ?? "unknown reason"}. Do not rely on this profile for trust decisions.`,
  };
}

async function getRuntimeObservation({ session_id } = {}) {
  if (!session_id) return { error: "VALIDATION_ERROR", message: "session_id is required." };
  let res;
  try {
    res = await request("GET", `/api/runtime-sessions/${encodeURIComponent(session_id)}/observation`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get observation snapshot." };
  }
  return res.data;
}

async function getRuntimeObservationMode({ session_id } = {}) {
  if (!session_id) return { error: "VALIDATION_ERROR", message: "session_id is required." };
  let res;
  try {
    res = await request("GET", `/api/runtime-sessions/${encodeURIComponent(session_id)}/observation-mode`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get observation mode." };
  }
  return res.data;
}

// ─── Challenge Relay v1 handlers ─────────────────────────────────────────────

async function reportSecurityChallenge({ domain, page_url, challenge_type, masked_destination, browser_session_id, element_hint, instructions } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!page_url) return { error: "VALIDATION_ERROR", message: "page_url is required." };

  const body = { domain, page_url };
  if (challenge_type) body.challenge_type = challenge_type;
  if (masked_destination) body.masked_destination = masked_destination;
  if (browser_session_id) body.browser_session_id = browser_session_id;
  if (element_hint && Object.keys(element_hint).length > 0) body.element_hint = element_hint;
  if (instructions) body.instructions = instructions;

  let res;
  try {
    res = await request("POST", "/api/agent/v1/security-challenges", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to report security challenge." };
  }
  const data = res.data;
  return {
    challenge_id: data.challenge_id,
    status: data.status,
    challenge_type: data.challenge_type,
    domain: data.domain,
    masked_destination: data.masked_destination ?? null,
    expires_at: data.expires_at,
    raw_code_revealed_to_agent: false,
    next_action: data.next_action,
  };
}

async function waitForSecurityChallenge({ challenge_id, timeout_ms = 120_000, poll_interval_ms = 2000 } = {}) {
  if (!challenge_id) return { error: "VALIDATION_ERROR", message: "challenge_id is required." };

  const TERMINAL = new Set(["code_submitted", "code_injected", "user_completed", "cancelled", "expired", "failed"]);
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await request("GET", `/api/agent/v1/security-challenges/${encodeURIComponent(challenge_id)}`);
    } catch (err) {
      return { error: "NETWORK_ERROR", message: err.message };
    }
    if (!res.ok) {
      return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to poll challenge." };
    }
    const data = res.data;
    if (TERMINAL.has(data.status)) {
      return {
        challenge_id: data.challenge_id,
        status: data.status,
        challenge_type: data.challenge_type,
        domain: data.domain,
        raw_code_revealed_to_agent: false,
        next_action: data.next_action,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, poll_interval_ms));
  }

  return {
    status: "timeout",
    challenge_id,
    raw_code_revealed_to_agent: false,
    next_action: `User has not submitted the code within the timeout window. Tell the user the challenge is still waiting in the Aegis UI at ${APPROVAL_UI} under "Security challenges". You can call wait_for_security_challenge again with the same challenge_id.`,
  };
}

async function injectSecurityChallengeCode({ challenge_id } = {}) {
  if (!challenge_id) return { error: "VALIDATION_ERROR", message: "challenge_id is required." };

  let res;
  try {
    res = await request("POST", `/api/agent/v1/security-challenges/${encodeURIComponent(challenge_id)}/inject`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to inject code." };
  }
  const data = res.data;
  return {
    challenge_id: data.challenge_id,
    status: data.status,
    raw_code_revealed_to_agent: false,
    ...(data.error ? { error: data.error } : {}),
    next_action: data.next_action,
  };
}

// ─── Connected Email Challenge Resolver v1 handlers ──────────────────────────

async function requestChallengeEmailResolution({ challenge_id } = {}) {
  if (!challenge_id) return { error: "VALIDATION_ERROR", message: "challenge_id is required." };

  let res;
  try {
    res = await request("POST", `/api/agent/v1/security-challenges/${encodeURIComponent(challenge_id)}/email-resolution-request`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to request email resolution." };
  }
  const data = res.data;
  return {
    resolution_id: data.resolution_id,
    challenge_id: data.challenge_id,
    status: data.status,
    provider: data.provider,
    domain: data.domain,
    raw_code_revealed_to_agent: false,
    email_body_revealed_to_agent: false,
    next_action: data.next_action,
  };
}

async function waitForChallengeEmailResolution({ resolution_id, timeout_ms = 120_000, poll_interval_ms = 3000 } = {}) {
  if (!resolution_id) return { error: "VALIDATION_ERROR", message: "resolution_id is required." };

  const TERMINAL = new Set(["code_found", "not_found", "failed", "cancelled", "expired", "injected"]);
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await request("GET", `/api/agent/v1/challenge-email-resolutions/${encodeURIComponent(resolution_id)}`);
    } catch (err) {
      return { error: "NETWORK_ERROR", message: err.message };
    }
    if (!res.ok) {
      return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to poll email resolution." };
    }
    const data = res.data;
    if (TERMINAL.has(data.status)) {
      return {
        resolution_id: data.resolution_id,
        challenge_id: data.challenge_id,
        status: data.status,
        provider: data.provider,
        domain: data.domain,
        sender_domain: data.sender_domain ?? null,
        received_at: data.received_at ?? null,
        error: data.error ?? null,
        raw_code_revealed_to_agent: false,
        email_body_revealed_to_agent: false,
        next_action: data.next_action,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, poll_interval_ms));
  }

  return {
    status: "timeout",
    resolution_id,
    raw_code_revealed_to_agent: false,
    email_body_revealed_to_agent: false,
    next_action: `Approval has not arrived within the timeout window. Tell the user to approve the Gmail search in the Aegis UI at ${APPROVAL_UI} under "Security challenges". You can call wait_for_challenge_email_resolution again with the same resolution_id.`,
  };
}

async function injectChallengeEmailCode({ resolution_id } = {}) {
  if (!resolution_id) return { error: "VALIDATION_ERROR", message: "resolution_id is required." };

  let res;
  try {
    res = await request("POST", `/api/agent/v1/challenge-email-resolutions/${encodeURIComponent(resolution_id)}/inject`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to inject email code." };
  }
  const data = res.data;
  return {
    resolution_id: data.resolution_id,
    status: data.status,
    injected_at: data.injected_at ?? null,
    raw_code_revealed_to_agent: false,
    email_body_revealed_to_agent: false,
    ...(data.error ? { error: data.error } : {}),
    next_action: data.next_action,
  };
}

// ─── Task Browser Lifecycle handlers ─────────────────────────────────────────

async function getRuntimeBrowserEndpoint({ mode } = {}) {
  const body = {};
  if (mode === "visible") body.mode = "visible";
  let res;
  try {
    res = await request("POST", "/api/agent/v1/runtime/browser-endpoint", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    if (res.error?.code === "NO_PORTS_AVAILABLE") {
      return { error: "NO_PORTS_AVAILABLE", message: "Aegis could not provision a browser runtime. All ports are occupied. Close any open sessions and retry." };
    }
    if (res.error?.code === "CHROME_NOT_FOUND") {
      return { error: "CHROME_NOT_FOUND", message: "Chrome is not installed. Install Google Chrome or Chromium and retry." };
    }
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to initialize browser runtime." };
  }
  const d = res.data;
  const reused = d.reused_existing === true;
  const autoPort = d.port_auto_selected === true;

  const next_action = reused
    ? "Antigen local browser runtime is already active at " + d.cdp_url + ". " +
      "The antigen-browser MCP server should already be connected — use it for all navigation, reading, and clicking. " +
      "Call request_secret_field_injection (passing browser_runtime_id as browser_session_id) when a credential field is reached."
    : autoPort
      ? "Antigen local browser runtime started on an alternate port at " + d.cdp_url + " (port_auto_selected=true). " +
        "The antigen-browser adapter resolves the port automatically — no config update needed. " +
        "Use the antigen-browser MCP server for all navigation, reading, and clicking."
      : "Antigen local browser runtime is ready at " + d.cdp_url + ". " +
        "The antigen-browser MCP server (configured with --cdp-endpoint " + d.cdp_url + ") is now live — " +
        "use it for all navigation, reading, and clicking. " +
        "Call request_secret_field_injection (passing browser_runtime_id as browser_session_id) when a credential field is reached. " +
        "Do not close the runtime until the full task is complete.";

  return {
    browser_runtime_id: d.browser_runtime_id,
    cdp_url: d.cdp_url,
    status: d.status,
    runtime_mode: d.runtime_mode,
    ephemeral: d.ephemeral,
    reused_existing: reused,
    port_auto_selected: autoPort,
    expires_at: d.expires_at,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    next_action,
  };
}

async function startTaskBrowserSession({ delegation_id, debug_visible = false } = {}) {
  const body = {};
  if (delegation_id) body.delegation_id = delegation_id;
  body.debug_visible = debug_visible === true;
  let res;
  try {
    res = await request("POST", "/api/task-browser-sessions", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    if (res.error?.code === "NO_PORTS_AVAILABLE") {
      return { error: "NO_PORTS_AVAILABLE", message: "Aegis could not start a secure browser session. Please try again." };
    }
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to start task browser session." };
  }
  const s = res.data;
  const reused   = s.reused_existing === true;
  const autoPort = s.port_auto_selected === true;
  const reconnect = s.requires_browser_reconnect === true;

  let next_action;
  if (reused) {
    next_action =
      "The existing Aegis task browser session is active and ready. " +
      "Continue using your browser tools for navigation and clicking. " +
      "Call request_secret_field_injection when you reach a credential field. " +
      "Do not close the session until the full task is complete.";
  } else if (reconnect) {
    next_action =
      "A fresh Aegis task browser session has been started. " +
      "Use the returned cdp_url (" + s.cdp_url + ") with your browser adapter before navigating. " +
      "Then proceed with navigation and clicking as normal. Call request_secret_field_injection for credential fields. " +
      "Do not close the session until the full task is complete.";
  } else {
    next_action =
      "Chrome is running at " + s.cdp_url + ". " +
      "Use your browser tools for all navigation and clicking. " +
      "When you reach a username or password field, call request_secret_field_injection — Aegis fills it via CDP without revealing the value. " +
      "Keep the session open while you work. Call close_task_browser_session after the task is fully complete.";
  }

  return {
    browser_session_id: s.browser_session_id,
    status: s.status,
    mode: s.mode ?? "headless",
    debug_visible: s.debug_visible === true,
    cdp_url: s.cdp_url,
    cdp_port: s.cdp_port ?? null,
    ephemeral: s.ephemeral,
    expires_at: s.expires_at,
    cleanup_complete: s.cleanup_complete ?? false,
    reused_existing: reused,
    port_auto_selected: autoPort,
    requires_browser_reconnect: reconnect,
    user_message: s.user_message ?? null,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    next_action,
  };
}

async function getTaskBrowserSession({ browser_session_id } = {}) {
  if (!browser_session_id) return { error: "VALIDATION_ERROR", message: "browser_session_id is required." };
  let res;
  try {
    res = await request("GET", `/api/task-browser-sessions/${encodeURIComponent(browser_session_id)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get task browser session." };
  }
  const s = res.data;
  return {
    browser_session_id: s.browser_session_id,
    status: s.status,
    cdp_url: s.cdp_url,
    ephemeral: s.ephemeral,
    expires_at: s.expires_at,
    closed_at: s.closed_at,
    cleanup_complete: s.cleanup_complete,
    error: s.error,
  };
}

async function closeTaskBrowserSession({ browser_session_id } = {}) {
  if (!browser_session_id) return { error: "VALIDATION_ERROR", message: "browser_session_id is required." };
  let res;
  try {
    res = await request("POST", `/api/task-browser-sessions/${encodeURIComponent(browser_session_id)}/close`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to close task browser session." };
  }
  return {
    browser_session_id: res.data.browser_session_id,
    status: res.data.status,
    closed_at: res.data.closed_at,
    cleanup_complete: res.data.cleanup_complete,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    next_action:
      "Profile deleted — Chrome process killed and /tmp profile directory removed. " +
      "GitHub, any website logins, cookies, and session storage are gone. " +
      "For the next task that needs a browser, call start_task_browser_session to get a clean ephemeral session.",
  };
}

// ─── Controlled Browser Bridge v1 handlers ────────────────────────────────────
// For agents without their own browser runtime (e.g. Claude Cowork).

async function navigateTaskBrowserSession({ browser_session_id, url } = {}) {
  if (!browser_session_id) return { error: "VALIDATION_ERROR", message: "browser_session_id is required." };
  if (!url) return { error: "VALIDATION_ERROR", message: "url is required." };
  if (!/^https?:\/\//i.test(url)) {
    return { error: "INVALID_PROTOCOL", message: "Only http:// and https:// URLs are allowed." };
  }
  let res;
  try {
    res = await request("POST", `/api/agent/v1/task-browser-sessions/${encodeURIComponent(browser_session_id)}/navigate`, { url });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Navigation failed." };
  const d = res.data;
  return {
    browser_session_id: d.browser_session_id,
    current_url: d.current_url,
    snapshot: d.snapshot,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
  };
}

async function observeTaskBrowserSession({ browser_session_id } = {}) {
  if (!browser_session_id) return { error: "VALIDATION_ERROR", message: "browser_session_id is required." };
  let res;
  try {
    res = await request("GET", `/api/agent/v1/task-browser-sessions/${encodeURIComponent(browser_session_id)}/observe`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Observation failed." };
  const d = res.data;
  return {
    browser_session_id: d.browser_session_id,
    current_url: d.current_url,
    snapshot: d.snapshot,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
  };
}

async function clickElementInTaskBrowserSession({ browser_session_id, selector, description } = {}) {
  if (!browser_session_id) return { error: "VALIDATION_ERROR", message: "browser_session_id is required." };
  if (!selector) return { error: "VALIDATION_ERROR", message: "selector is required." };
  const body = { selector };
  if (description) body.description = description;
  let res;
  try {
    res = await request("POST", `/api/agent/v1/task-browser-sessions/${encodeURIComponent(browser_session_id)}/click`, body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Click failed." };
  const d = res.data;
  return {
    browser_session_id: d.browser_session_id,
    clicked: d.clicked,
    current_url: d.current_url,
    snapshot: d.snapshot,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
  };
}

// ─── Authenticated Session Boundary handlers ─────────────────────────────────

async function requestAuthenticatedSessionLogin({ domain, login_url, task_summary, pass_id, browser_session_id } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!login_url) return { error: "VALIDATION_ERROR", message: "login_url is required." };
  if (!task_summary) return { error: "VALIDATION_ERROR", message: "task_summary is required." };
  const body = { domain, login_url, task_summary };
  if (pass_id) body.pass_id = pass_id;
  if (browser_session_id) body.browser_session_id = browser_session_id;
  let res;
  try {
    res = await request("POST", "/api/agent/v1/authenticated-sessions/login-request", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to request authenticated session." };
  }
  const handle = res.data;
  const borrowed = !!handle.task_browser_session_id;
  return {
    session_id: handle.session_id,
    domain: handle.domain,
    login_url: handle.login_url,
    task_summary: handle.task_summary,
    status: handle.status,
    capabilities: handle.capabilities,
    task_browser_session_id: handle.task_browser_session_id ?? null,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    raw_credentials_revealed_to_agent: false,
    created_at: handle.created_at,
    expires_at: handle.expires_at,
    next_action: borrowed
      ? `Session created with status="${handle.status}" and bound to task browser session "${handle.task_browser_session_id}". Direct the user to ${APPROVAL_UI} to approve the login request under "Login session requests". After approval, Aegis performs the login in the existing task browser (not a fresh browser). If status becomes "manual_step_required" (passkey/2FA), the user can complete the challenge directly in the task browser window — the session stays open for user interaction. Poll get_authenticated_session until status is "authenticated".`
      : `Session created with status="${handle.status}". Direct the user to ${APPROVAL_UI} to approve the login request under "Login session requests". After approval, Aegis performs the login in an isolated Playwright session. Poll get_authenticated_session until status is "authenticated" or "manual_step_required".`,
  };
}

async function getAuthenticatedSession({ session_id }) {
  if (!session_id) return { error: "VALIDATION_ERROR", message: "session_id is required." };
  let res;
  try {
    res = await request("GET", `/api/agent/v1/authenticated-sessions/${encodeURIComponent(session_id)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get authenticated session." };
  }
  const handle = res.data;
  const terminal = ["authenticated", "manual_step_required", "failed", "expired"].includes(handle.status);
  return {
    session_id: handle.session_id,
    domain: handle.domain,
    status: handle.status,
    capabilities: handle.capabilities,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    raw_credentials_revealed_to_agent: false,
    manual_step_reason: handle.manual_step_reason ?? null,
    expires_at: handle.expires_at,
    terminal,
    next_action: handle.status === "authenticated"
      ? "Login succeeded. Call observe_authenticated_session to inspect the current page, or navigate_authenticated_session to move to another same-domain URL."
      : handle.status === "manual_step_required"
      ? `Login blocked: ${handle.manual_step_reason ?? "security challenge detected"}. Stop — do not retry. Inform the user that manual intervention is required. Aegis does not bypass 2FA, CAPTCHA, passkey, or device verification.`
      : handle.status === "failed"
      ? `Login failed: ${handle.manual_step_reason ?? "unknown error"}. Do not retry automatically.`
      : handle.status === "pending_approval"
      ? `Awaiting user approval at ${APPROVAL_UI} under "Login session requests". Poll again after the user approves.`
      : handle.status === "login_in_progress"
      ? "Aegis is performing login. Poll again in a few seconds."
      : `Session status is "${handle.status}". No further agent action available.`,
  };
}

async function observeAuthenticatedSession({ session_id }) {
  if (!session_id) return { error: "VALIDATION_ERROR", message: "session_id is required." };
  let res;
  try {
    res = await request("GET", `/api/agent/v1/authenticated-sessions/${encodeURIComponent(session_id)}/observe`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to observe authenticated session." };
  }
  const result = res.data;
  return {
    session_id: result.session_id,
    status: result.status,
    page_url: result.page_url ?? null,
    open_summary: result.open_summary ?? null,
    protected_snapshot: result.protected_snapshot ?? null,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    note: "Aegis never returns cookies, storage, session tokens, passwords, secret_ref values, pass_id, KMS material, ciphertext, or storageState. Sensitive field values are always redacted.",
  };
}

async function navigateAuthenticatedSession({ session_id, url }) {
  if (!session_id) return { error: "VALIDATION_ERROR", message: "session_id is required." };
  if (!url) return { error: "VALIDATION_ERROR", message: "url is required." };
  let res;
  try {
    res = await request("POST", `/api/agent/v1/authenticated-sessions/${encodeURIComponent(session_id)}/navigate`, { url });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to navigate authenticated session." };
  }
  const result = res.data;
  return {
    session_id: result.session_id,
    status: result.status,
    page_url: result.page_url ?? null,
    open_summary: result.open_summary ?? null,
    protected_snapshot: result.protected_snapshot ?? null,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    note: "Same-domain navigation only. Aegis blocks cross-domain navigation. Sensitive field values are always redacted.",
  };
}

// ─── Agent-Browser Secret Injection v1 handlers ──────────────────────────────

async function requestSecretFieldInjection({ domain, pass_id, field_kind, page_url, element_hint, reason, browser_session_id, external_cdp_url } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!field_kind || !["username", "password"].includes(field_kind)) {
    return { error: "VALIDATION_ERROR", message: "field_kind must be 'username' or 'password'." };
  }
  if (!page_url) return { error: "VALIDATION_ERROR", message: "page_url is required." };
  if (!reason) return { error: "VALIDATION_ERROR", message: "reason is required." };
  if (browser_session_id && external_cdp_url) {
    return { error: "VALIDATION_ERROR", message: "browser_session_id and external_cdp_url are mutually exclusive. Use browser_session_id for Aegis-provisioned browsers; use external_cdp_url when you own the browser." };
  }

  const body = { domain, field_kind, page_url, reason };
  if (pass_id) body.pass_id = pass_id;
  if (element_hint && Object.keys(element_hint).length > 0) body.element_hint = element_hint;
  if (browser_session_id) body.browser_session_id = browser_session_id;
  if (external_cdp_url) body.external_cdp_url = external_cdp_url;

  let res;
  try {
    res = await request("POST", "/api/agent/v1/injections", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to request injection.",
    };
  }
  const data = res.data;
  return {
    injection_request_id: data.injection_request_id,
    authorization_id: data.authorization_id ?? null,
    status: data.status,
    domain: data.domain,
    field_kind: data.field_kind,
    pass_label: data.pass_label ?? null,
    raw_value_revealed_to_agent: false,
    expires_at: data.expires_at,
    authorization_covers: data.authorization_covers ?? null,
    remaining_uses: data.remaining_uses ?? null,
    next_action: data.status === "approved"
      ? `Injection pre-approved (covered by existing authorization). Call execute_secret_field_injection with injection_request_id="${data.injection_request_id}".`
      : `Tell the user to approve at ${APPROVAL_UI} under "Login credential requests". Then call wait_for_credential_authorization with authorization_id="${data.authorization_id}" — it returns automatically when approved. Do NOT ask the user to type "done".`,
  };
}

async function getSecretInjectionStatus({ injection_request_id } = {}) {
  if (!injection_request_id) return { error: "VALIDATION_ERROR", message: "injection_request_id is required." };
  let res;
  try {
    res = await request("GET", `/api/agent/v1/injections/${encodeURIComponent(injection_request_id)}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to get injection status." };
  }
  return res.data;
}

async function executeSecretFieldInjection({ injection_request_id } = {}) {
  if (!injection_request_id) return { error: "VALIDATION_ERROR", message: "injection_request_id is required." };
  let res;
  try {
    res = await request("POST", `/api/agent/v1/injections/${encodeURIComponent(injection_request_id)}/execute`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "CDP fill failed.",
    };
  }
  const data = res.data;
  // IMPORTANT: Only metadata is returned. The raw credential value is NEVER in this response.
  // For password fields, Aegis also masks el.value in the browser after injection so that
  // aria snapshots return '' for the field. This is a JS-layer mitigation, not a
  // browser-engine security boundary.
  const fieldKind = data.field_kind;
  const nextAction = fieldKind === "password"
    ? "Password field filled. Do not read or snapshot the filled field — proceed directly to the next step (e.g. click Sign in / Next). If you need to confirm the page state, call browser_snapshot only after navigating away from the login form."
    : "Field filled. Continue your workflow — navigate, click submit, etc.";
  return {
    injection_request_id: data.injection_request_id,
    status: data.status,
    field_kind: fieldKind,
    domain: data.domain,
    filled_at: data.filled_at ?? null,
    raw_value_revealed_to_agent: false,
    next_action: nextAction,
    note: data.note ?? "Aegis injected the field value directly via CDP. The raw credential was never returned to the agent.",
  };
}

async function executeCredentialStepHandoff({
  injection_request_id,
  step_kind,
  submit,
  reason,
} = {}) {
  if (!injection_request_id) return { error: "VALIDATION_ERROR", message: "injection_request_id is required." };
  if (!step_kind) return { error: "VALIDATION_ERROR", message: "step_kind is required." };
  if (!reason) return { error: "VALIDATION_ERROR", message: "reason is required." };

  let res;
  try {
    res = await request("POST", "/api/agent/v1/credential-step-handoff", {
      injection_request_id,
      step_kind,
      submit: submit ?? {},
      reason,
    });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }

  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Credential step handoff failed.",
    };
  }

  const data = res.data;
  const status = data.status;

  let next_action_guidance;
  if (status === "navigated") {
    next_action_guidance =
      "Page navigated after submit. Check current_url and page_title to determine if login succeeded. " +
      "If you see a dashboard or home page, login is complete. If the URL is still a login page, read the page content.";
  } else if (status === "challenge_detected") {
    next_action_guidance =
      `A ${data.challenge_kind ?? "verification"} challenge was detected. ` +
      "Call report_security_challenge with the current page URL and browser_session_id. " +
      "Do NOT ask the user to paste the code into chat — direct them to the Aegis UI.";
  } else if (status === "invalid_credentials") {
    next_action_guidance =
      "Invalid credentials detected. The vault password may be incorrect or outdated. " +
      "Stop the login attempt and report to the user. Do not retry automatically.";
  } else if (status === "blocked_policy") {
    next_action_guidance =
      "Submit blocked by Aegis policy. " + (data.blocked_reason ?? "The button was not recognized as a login-type action.");
  } else if (status === "submit_failed") {
    next_action_guidance =
      "The submit button could not be clicked. The field was NOT filled. " +
      "Provide a more specific selector_hint or button_text and retry, or check the browser state.";
  } else if (status === "step_completed") {
    next_action_guidance = "Step completed. No navigation detected. Read the current page to determine next step.";
  } else {
    next_action_guidance = "Unknown page state after submit. Read the current page to determine next step.";
  }

  return {
    handoff_id: data.handoff_id,
    status,
    step_kind: data.step_kind,
    domain: data.domain,
    completed_at: data.completed_at,
    raw_value_revealed_to_agent: false,
    ...(data.current_url ? { current_url: data.current_url } : {}),
    ...(data.page_title ? { page_title: data.page_title } : {}),
    ...(data.challenge_kind ? { challenge_kind: data.challenge_kind } : {}),
    ...(data.signals_detected?.length ? { signals_detected: data.signals_detected } : {}),
    ...(data.blocked_reason ? { blocked_reason: data.blocked_reason } : {}),
    next_action_guidance,
  };
}

async function waitForCredentialAuthorization({
  authorization_id,
  timeout_ms = 120000,
  poll_interval_ms = 1000,
} = {}) {
  if (!authorization_id) return { error: "VALIDATION_ERROR", message: "authorization_id is required." };

  const TERMINAL = new Set(["approved", "denied", "expired", "fulfilled", "revoked"]);
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await request("GET", `/api/agent/v1/credential-authorizations/${encodeURIComponent(authorization_id)}`);
    } catch (err) {
      return { error: "NETWORK_ERROR", message: err.message };
    }
    if (!res.ok) {
      return {
        error: res.error?.code ?? "UNKNOWN_ERROR",
        message: res.error?.message ?? "Failed to poll credential authorization.",
      };
    }

    const data = res.data;
    if (TERMINAL.has(data.status)) {
      let next_action;
      if (data.status === "approved") {
        next_action =
          "Authorization approved. Call execute_secret_field_injection with the injection_request_id from request_secret_field_injection to fill the field. Then request and execute the password field injection (no second approval needed — same authorization covers both).";
      } else {
        next_action = `Authorization ${data.status}. Stop this credential flow and report the outcome to the user. Do not retry without user direction.`;
      }
      return {
        authorization_id: data.authorization_id,
        status: data.status,
        domain: data.domain,
        pass_label: data.pass_label,
        raw_values_revealed_to_agent: false,
        ...(data.approved_at ? { approved_at: data.approved_at } : {}),
        ...(data.fulfilled_at ? { fulfilled_at: data.fulfilled_at } : {}),
        next_action,
      };
    }

    // Not yet terminal — wait before next poll
    await new Promise((resolve) => setTimeout(resolve, poll_interval_ms));
  }

  return {
    status: "timeout",
    authorization_id,
    raw_values_revealed_to_agent: false,
    next_action:
      "Approval has not arrived within the timeout window. Ask the user whether they want to continue waiting, cancel, or retry the login. You can call wait_for_credential_authorization again with the same authorization_id.",
  };
}

// ─── Payment Card Fill Handoff v1 handlers ────────────────────────────────────

async function requestPaymentCardFill({
  domain, payment_method_id, field, page_url, element_hint, reason,
  browser_session_id, external_cdp_url,
} = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!field) return { error: "VALIDATION_ERROR", message: "field is required." };
  if (!page_url) return { error: "VALIDATION_ERROR", message: "page_url is required." };
  if (!reason) return { error: "VALIDATION_ERROR", message: "reason is required." };

  const body = { domain, field, page_url, reason };
  if (payment_method_id) body.payment_method_id = payment_method_id;
  if (element_hint) body.element_hint = element_hint;
  if (browser_session_id) body.browser_session_id = browser_session_id;
  if (external_cdp_url) body.external_cdp_url = external_cdp_url;

  let res;
  try {
    res = await request("POST", "/api/agent/v1/payment-card-fills", body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to create card fill request." };
  }
  return res.data;
}

async function waitForPaymentCardFillAuthorization({
  authorization_id,
  timeout_ms = 300000,
  poll_interval_ms = 3000,
} = {}) {
  if (!authorization_id) return { error: "VALIDATION_ERROR", message: "authorization_id is required." };

  const TERMINAL = new Set(["approved", "denied", "expired", "fulfilled", "revoked"]);
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    let res;
    try {
      // Poll via the internal list endpoint — filter by ID
      res = await request("GET", `/api/internal/payment-card-fill-authorizations?status=approved`);
    } catch (err) {
      return { error: "NETWORK_ERROR", message: err.message };
    }

    // Also check if it now appears as non-pending by fetching a fill request linked to it
    // Simpler: poll the agent-facing fill request status via a fill_request linked to auth
    // The cleanest poll is to check the agent-facing status via any fill_request from this auth.
    // We'll use a separate internal poll below.
    break; // Exit the approval poll loop — handled below
  }

  // Poll approach: check internal endpoint for the authorization status
  const deadline2 = Date.now() + timeout_ms;
  while (Date.now() < deadline2) {
    let res;
    try {
      res = await request("GET", `/api/internal/payment-card-fill-authorizations`);
    } catch (err) {
      return { error: "NETWORK_ERROR", message: err.message };
    }
    if (!res.ok) {
      return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to poll card fill authorization." };
    }

    const auth = res.data?.find((a) => a.authorization_id === authorization_id);
    if (!auth) {
      return { error: "NOT_FOUND", message: `Authorization ${authorization_id} not found.` };
    }

    if (TERMINAL.has(auth.status)) {
      let next_action;
      if (auth.status === "approved") {
        next_action = "Authorization approved. Call execute_payment_card_fill_handoff for each fill_request_id to fill the card fields.";
      } else {
        next_action = `Authorization ${auth.status}. Do not attempt card fill. Report outcome to the user.`;
      }
      return {
        authorization_id: auth.authorization_id,
        status: auth.status,
        domain: auth.domain,
        payment_method_label: auth.payment_method_label,
        last4: auth.last4,
        raw_values_revealed_to_agent: false,
        purchase_not_authorized: true,
        ...(auth.approved_at ? { approved_at: auth.approved_at } : {}),
        next_action,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, poll_interval_ms));
  }

  return {
    status: "timeout",
    authorization_id,
    raw_values_revealed_to_agent: false,
    purchase_not_authorized: true,
    next_action: "Approval has not arrived within the timeout window. Ask the user whether to continue waiting or cancel.",
  };
}

async function executePaymentCardFillHandoff({ fill_request_id } = {}) {
  if (!fill_request_id) return { error: "VALIDATION_ERROR", message: "fill_request_id is required." };

  let res;
  try {
    res = await request("POST", `/api/agent/v1/payment-card-fills/${encodeURIComponent(fill_request_id)}/execute`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Card fill execution failed." };
  }
  return res.data;
}

// ─── Purchase Confirmation handlers ──────────────────────────────────────────

async function requestPurchaseConfirmation({
  domain, page_url, merchant, amount, currency, amount_unknown,
  item_summary, payment_method_label, payment_method_last4,
  button_text, button_selector_hint, card_fill_authorization_id, reason,
} = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!page_url) return { error: "VALIDATION_ERROR", message: "page_url is required." };
  if (!merchant) return { error: "VALIDATION_ERROR", message: "merchant is required." };
  if (!item_summary) return { error: "VALIDATION_ERROR", message: "item_summary is required." };
  if (!payment_method_label) return { error: "VALIDATION_ERROR", message: "payment_method_label is required." };
  if (!payment_method_last4) return { error: "VALIDATION_ERROR", message: "payment_method_last4 is required." };
  if (!button_text) return { error: "VALIDATION_ERROR", message: "button_text is required." };
  if (!reason) return { error: "VALIDATION_ERROR", message: "reason is required." };

  let res;
  try {
    res = await request("POST", "/api/agent/v1/purchase-confirmations", {
      domain, page_url, merchant, amount, currency, amount_unknown,
      item_summary, payment_method_label, payment_method_last4,
      button_text, button_selector_hint, card_fill_authorization_id, reason,
    });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to create purchase confirmation request." };
  }
  return res.data;
}

async function waitForPurchaseConfirmationAuthorization({
  purchase_confirmation_id,
  timeout_ms = 300000,
  poll_interval_ms = 3000,
} = {}) {
  if (!purchase_confirmation_id) return { error: "VALIDATION_ERROR", message: "purchase_confirmation_id is required." };

  const TERMINAL = new Set(["approved", "denied", "expired", "revoked", "fulfilled"]);
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await request("GET", `/api/agent/v1/purchase-confirmations/${encodeURIComponent(purchase_confirmation_id)}`);
    } catch (err) {
      return { error: "NETWORK_ERROR", message: err.message };
    }
    if (!res.ok) {
      return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to poll purchase confirmation authorization." };
    }
    const data = res.data;
    if (TERMINAL.has(data.status)) return data;
    await new Promise((r) => setTimeout(r, poll_interval_ms));
  }
  return { error: "TIMEOUT", message: "Timed out waiting for purchase confirmation authorization." };
}

async function waitForProfileMemoryRequest({
  profile_memory_request_id,
  timeout_ms = 600000,
  poll_interval_ms = 3000,
} = {}) {
  if (!profile_memory_request_id) return { error: "VALIDATION_ERROR", message: "profile_memory_request_id is required." };

  const TERMINAL = new Set(["completed", "expired", "cancelled"]);
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await request("GET", `/api/agent/v1/profile-memory-requests/${encodeURIComponent(profile_memory_request_id)}`);
    } catch (err) {
      return { error: "NETWORK_ERROR", message: err.message };
    }
    if (!res.ok) {
      return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to poll profile memory request." };
    }
    const data = res.data;
    if (TERMINAL.has(data.status)) return data;
    await new Promise((r) => setTimeout(r, poll_interval_ms));
  }

  // Final check: capture a user submit that landed at the deadline boundary
  try {
    const finalRes = await request("GET", `/api/agent/v1/profile-memory-requests/${encodeURIComponent(profile_memory_request_id)}`);
    if (finalRes.ok && TERMINAL.has(finalRes.data.status)) return finalRes.data;
  } catch { /* best effort */ }

  return {
    error: "TIMEOUT",
    message: "Timed out waiting for profile memory request completion. If the user just submitted values, retry request_profile_field_fill directly.",
  };
}

async function executePurchaseConfirmationHandoff({
  purchase_confirmation_id, browser_session_id, external_cdp_url,
} = {}) {
  if (!purchase_confirmation_id) return { error: "VALIDATION_ERROR", message: "purchase_confirmation_id is required." };

  let res;
  try {
    res = await request("POST", `/api/agent/v1/purchase-confirmations/${encodeURIComponent(purchase_confirmation_id)}/execute`, {
      ...(browser_session_id ? { browser_session_id } : {}),
      ...(external_cdp_url ? { external_cdp_url } : {}),
    });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Purchase confirmation handoff failed." };
  }
  return res.data;
}

// ─── Profile Field Fill v1 handlers ──────────────────────────────────────────

async function requestProfileFieldFill({ domain, page_url, requested_fields, reason, browser_session_id } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!page_url) return { error: "VALIDATION_ERROR", message: "page_url is required." };
  if (!Array.isArray(requested_fields) || requested_fields.length === 0) {
    return { error: "VALIDATION_ERROR", message: "requested_fields is required and must be a non-empty array." };
  }
  if (!reason) return { error: "VALIDATION_ERROR", message: "reason is required." };

  let res;
  try {
    res = await request("POST", "/api/agent/v1/profile-field-fills", {
      domain,
      page_url,
      requested_fields,
      reason,
      ...(browser_session_id ? { browser_session_id } : {}),
    });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to create profile field fill request.", ...(res.error?.missing_fields ? { missing_fields: res.error.missing_fields } : {}) };
  }
  return res.data;
}

async function executeProfileFieldFill({ fill_request_id, browser_session_id, external_cdp_url } = {}) {
  if (!fill_request_id) return { error: "VALIDATION_ERROR", message: "fill_request_id is required." };

  let res;
  try {
    res = await request("POST", `/api/agent/v1/profile-field-fills/${encodeURIComponent(fill_request_id)}/execute`, {
      ...(browser_session_id ? { browser_session_id } : {}),
      ...(external_cdp_url ? { external_cdp_url } : {}),
    });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Profile field fill execution failed." };
  }
  return res.data;
}

// ─── Workspace handlers ───────────────────────────────────────────────────────

async function getWorkspaceManifest({ workspace_id } = {}) {
  if (!workspace_id) return { error: "VALIDATION_ERROR", message: "workspace_id is required." };
  const res = await request("GET", `/api/agent/v1/workspaces/${encodeURIComponent(workspace_id)}/manifest`);
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to get workspace manifest.",
    };
  }
  return res.data;
}

async function claimWorkspaceTask({ workspace_id, task_id } = {}) {
  if (!workspace_id) return { error: "VALIDATION_ERROR", message: "workspace_id is required." };
  if (!task_id) return { error: "VALIDATION_ERROR", message: "task_id is required." };
  const res = await request(
    "PATCH",
    `/api/agent/v1/workspaces/${encodeURIComponent(workspace_id)}/tasks/${encodeURIComponent(task_id)}`,
    { action: "claim" },
  );
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to claim task.",
      ...(res.error?.recovery_hint !== undefined ? { recovery_hint: res.error.recovery_hint } : {}),
      ...(res.error?.blocker_reasons !== undefined ? { blocker_reasons: res.error.blocker_reasons } : {}),
    };
  }
  return res.data;
}

async function completeWorkspaceTask({ workspace_id, task_id } = {}) {
  if (!workspace_id) return { error: "VALIDATION_ERROR", message: "workspace_id is required." };
  if (!task_id) return { error: "VALIDATION_ERROR", message: "task_id is required." };
  const res = await request(
    "PATCH",
    `/api/agent/v1/workspaces/${encodeURIComponent(workspace_id)}/tasks/${encodeURIComponent(task_id)}`,
    { action: "complete" },
  );
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to complete task.",
    };
  }
  return res.data;
}

async function listWorkspaceArtifacts({ workspace_id } = {}) {
  if (!workspace_id) return { error: "VALIDATION_ERROR", message: "workspace_id is required." };
  const res = await request("GET", `/api/agent/v1/workspaces/${encodeURIComponent(workspace_id)}/artifacts`);
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to list workspace artifacts.",
    };
  }
  return { artifacts: res.data };
}

async function readWorkspaceArtifact({ workspace_id, artifact_id } = {}) {
  if (!workspace_id) return { error: "VALIDATION_ERROR", message: "workspace_id is required." };
  if (!artifact_id) return { error: "VALIDATION_ERROR", message: "artifact_id is required." };
  const res = await request(
    "GET",
    `/api/agent/v1/workspaces/${encodeURIComponent(workspace_id)}/artifacts/${encodeURIComponent(artifact_id)}`,
  );
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to read artifact.",
    };
  }
  return res.data;
}

const ARTIFACT_MAX_BYTES = 50 * 1024;
const VALID_ARTIFACT_KINDS = ["text", "json", "csv", "markdown"];

async function createWorkspaceArtifact({ workspace_id, name, kind, content, task_id } = {}) {
  if (!workspace_id) return { error: "VALIDATION_ERROR", message: "workspace_id is required." };
  if (!name || typeof name !== "string" || !name.trim())
    return { error: "VALIDATION_ERROR", message: "name is required." };
  if (!kind || !VALID_ARTIFACT_KINDS.includes(kind))
    return { error: "VALIDATION_ERROR", message: `kind must be one of: ${VALID_ARTIFACT_KINDS.join(", ")}.` };
  if (typeof content !== "string" || content.length === 0)
    return { error: "VALIDATION_ERROR", message: "content is required." };
  if (Buffer.byteLength(content, "utf8") > ARTIFACT_MAX_BYTES)
    return { error: "VALIDATION_ERROR", message: `content exceeds the 50 KB limit (${ARTIFACT_MAX_BYTES} bytes UTF-8).` };
  const body = { name: name.trim(), kind, content };
  if (task_id) body.task_id = task_id;
  const res = await request(
    "POST",
    `/api/agent/v1/workspaces/${encodeURIComponent(workspace_id)}/artifacts`,
    body,
  );
  if (!res.ok) {
    return {
      error: res.error?.code ?? "UNKNOWN_ERROR",
      message: res.error?.message ?? "Failed to create artifact.",
    };
  }
  return res.data;
}

// ─── Agent-Runnable Skill Run Lifecycle handlers ──────────────────────────────

async function startSkillRun({ run_id } = {}) {
  if (!run_id) return { error: "VALIDATION_ERROR", message: "run_id is required." };
  let res;
  try {
    res = await request("POST", `/api/route-runs/${encodeURIComponent(run_id)}/start`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to start skill run." };
  }
  const run = res.data;
  return {
    run_id: run.run_id,
    status: run.status,
    skill_id: run.skill_id,
    domain: run.domain,
    started_at: run.started_at ?? null,
    next_action:
      "Run is now running. Execute the workflow steps using your own browser/runtime tools. " +
      "When finished, call complete_skill_run (on success) or fail_skill_run (on failure) " +
      "to close the audit receipt loop. Do not leave runs in running status.",
  };
}

async function completeSkillRun({ run_id, browser_session_id, summary } = {}) {
  if (!run_id) return { error: "VALIDATION_ERROR", message: "run_id is required." };
  const body = {};
  if (browser_session_id) body.browser_session_id = browser_session_id;
  if (summary) body.summary = summary;
  let res;
  try {
    res = await request("POST", `/api/route-runs/${encodeURIComponent(run_id)}/complete`, body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to complete skill run." };
  }
  const run = res.data;
  return {
    run_id: run.run_id,
    status: run.status,
    domain: run.domain,
    completed_at: run.completed_at ?? null,
    ...(run.task_browser_session_id ? { task_browser_session_id: run.task_browser_session_id } : {}),
    next_action:
      "Run completed. A signed RouteRunReceipt has been generated. " +
      "Call get_route_run_receipt to retrieve the audit record.",
  };
}

async function failSkillRun({ run_id, error, browser_session_id } = {}) {
  if (!run_id) return { error: "VALIDATION_ERROR", message: "run_id is required." };
  if (!error) return { error: "VALIDATION_ERROR", message: "error is required." };
  const body = { error };
  if (browser_session_id) body.browser_session_id = browser_session_id;
  let res;
  try {
    res = await request("POST", `/api/route-runs/${encodeURIComponent(run_id)}/fail`, body);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to fail skill run." };
  }
  const run = res.data;
  return {
    run_id: run.run_id,
    status: run.status,
    domain: run.domain,
    error: run.error ?? null,
    completed_at: run.completed_at ?? null,
    next_action:
      "Run marked as failed. A signed RouteRunReceipt has been generated with status 'failed'. " +
      "Call get_route_run_receipt to retrieve the audit record.",
  };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_agent_identity",
    description:
      "Start here. Returns the identity of the connected agent delegation — agent name, delegation ID, platform, policy mode (collar or baseline), collar status, and whether execution is blocked. " +
      "Call this first to confirm your Aegis connection is active and to discover your delegation_id, collar, and effective permissions. " +
      "No parameters required — uses the configured agent token automatically.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_available_skills",
    description:
      "List all skills (verified workflow routes) installed and visible to this delegation. " +
      "Returns skill IDs, names, domains, risk levels, and execution modes. " +
      "Call this to discover which Aegis-governed workflows are available before starting a task. " +
      "Optionally filter by domain. " +
      "execution_mode='agent_runnable' means the agent can fetch and execute the recipe itself via get_agent_runnable_workflow. " +
      "execution_mode='aegis_controlled' means the workflow is sensitive and must be delegated to Aegis via request_skill_run.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Optional. Filter to skills for a specific domain, e.g. 'github.com'.",
        },
      },
      required: [],
    },
  },
  {
    name: "start_controlled_browser_session",
    description:
      "Start an Aegis-managed ephemeral Chrome browser session for agent-controlled navigation. " +
      "Sessions are headless by default — Chrome runs in the background with no visible window. " +
      "The agent uses its own Playwright tools (via @playwright/mcp) for ALL navigation, clicking, and reading — " +
      "Aegis does NOT navigate or click on the agent's behalf. " +
      "Aegis uses the session ONLY to inject protected credential fields via CDP when request_secret_field_injection is called. " +
      "Starting this session does NOT itself authorize any sensitive actions — user approval is required separately for credential injection. " +
      "If a session is already active it will be reused (reused_existing=true). " +
      "Call close_task_browser_session only after the full task is complete. " +
      "Do NOT pass debug_visible: true unless the user has explicitly asked to see the browser window for debugging.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: {
          type: "string",
          description: "Optional. Delegation ID to associate with this browser session. Use the delegation_id from get_agent_identity.",
        },
        debug_visible: {
          type: "boolean",
          description: "Optional. Default false. Set to true ONLY when the user explicitly requests a visible browser window for local debugging. Do not set this for normal task execution — sessions should always be headless.",
        },
      },
      required: [],
    },
  },
  {
    name: "discover_installed_skills",
    description:
      "Discover which Aegis-installed skills (verified workflow routes) are available to this delegated agent on a given domain. Each skill includes execution_mode and sensitivity_level. " +
      "execution_mode='agent_runnable': Aegis has a verified route recipe. Call request_skill_run to create a run, start_skill_run to begin it, then execute the steps in your own browser session (get_agent_runnable_workflow returns the recipe), then call complete_skill_run or fail_skill_run to close the audit receipt loop. " +
      "execution_mode='aegis_controlled': the workflow is sensitive (credentials, payments, personal data, account changes) and must be delegated to Aegis via request_skill_run + start_playwright_route_run. " +
      "Use this first to understand which Aegis-governed paths exist and how to invoke them.",
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
      "List Aegis vault credential metadata available to this delegated user. Returns labels, usernames, domains, kinds, and pass_ids only — never passwords or secret values. Use this when the user names a credential ('use my GitHub account', 'use the Vercel credentials') so you can identify the correct pass_id. Each pass has a domain field that identifies the credential provider's login domain (e.g. 'github.com', 'vercel.com') — match this against the current page hostname before requesting injection. Optionally filter by domain, kind, or a free-text query matching label/username/domain.",
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
      "Create an Aegis-controlled route run for a sensitive skill (credentials, payments, personal data, form submission, account changes, or any action requiring an audit trail). This tool creates and validates the run — it does NOT execute it. For agent_runnable skills, call get_agent_runnable_workflow instead. Returns a run_id and initial status. If status is pending_approval, direct the user to /route-run-approvals and poll get_route_run_status until status changes to pending. Once pending (approved), call start_playwright_route_run to execute the run in the Aegis Playwright runtime — do not rely on the Chrome extension or ask the user to open a browser tab. If the user named a specific credential, call list_vault_passes first to find the pass_id, then supply it in pass_overrides.",
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
  {
    name: "start_credential_session",
    description:
      "Start a field-level Aegis credential session for a named vault pass. Use this for generic login flows where no pre-recorded Aegis skill exists — the agent navigates the site freely and calls fill_credential_field when a username or password input is reached. Aegis fills the field via the extension without returning the secret to the agent. Always call list_vault_passes first to identify the correct pass_id. Requires user approval before any fills are allowed. Provide target_url if you know the exact login page URL — this prevents Aegis from filling on the wrong same-domain page.",
    inputSchema: {
      type: "object",
      properties: {
        pass_id: {
          type: "string",
          description: "The pass_id from list_vault_passes for the credential to use.",
        },
        domain: {
          type: "string",
          description: "The domain where fills will be performed, e.g. 'linkedin.com'. Must match the pass domain.",
        },
        allowed_fields: {
          type: "array",
          items: { type: "string", enum: ["username", "password"] },
          description: "Fields the agent may request fills for. Defaults to [\"username\", \"password\"] if omitted.",
        },
        target_url: {
          type: "string",
          description: "Optional. The exact login page URL for page-context binding, e.g. 'http://localhost:3000/demo-login' or 'https://www.linkedin.com/login'. If provided, Aegis will only fill fields when the active tab matches this URL/path — preventing fills on wrong same-domain pages like /feed or /checkpoint.",
        },
      },
      required: ["pass_id", "domain"],
    },
  },
  {
    name: "fill_credential_field",
    description:
      "Request Aegis to fill a specific credential field (username or password) on the currently active tab. The Aegis extension resolves the credential value and injects it into the matching input — the value is never returned to the agent. Requires an active credential session (status='active'). Call this once you are on the page with the target input visible. For multi-step login flows, call this separately for username and password as each page appears. Never call this for CAPTCHA, 2FA, or security challenge pages — stop and report manual intervention needed instead.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id from start_credential_session.",
        },
        field: {
          type: "string",
          enum: ["username", "password"],
          description: "The credential field to fill. 'username' fills email/username inputs; 'password' fills password inputs.",
        },
      },
      required: ["session_id", "field"],
    },
  },
  {
    name: "get_credential_session_status",
    description:
      "Check the status of a credential session and see which fields have been filled. Poll after fill_credential_field to confirm fill completion. Terminal statuses: 'completed' (all allowed fields filled), 'failed', 'expired' (10-minute window elapsed). Non-terminal: 'pending_approval' (waiting for user), 'active' (ready for fills).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id from start_credential_session.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "start_playwright_route_run",
    description:
      "Execute an approved Aegis-controlled route run using the Aegis Playwright runtime. This is the preferred execution surface for autonomous agents. Aegis opens an isolated headless Chromium session, navigates to the route start URL, resolves credentials from the KMS vault without exposing secrets to the agent, executes the route steps, instruments sensitive events, and emits a signed receipt with execution_surface='aegis_playwright'. The user does NOT need to have a browser tab open. Call this after request_skill_run returns a run in pending status (i.e., approved). Refuses runs that are still pending_approval — user must approve at /route-run-approvals first. The Chrome extension is not involved and does not need to be running.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The run_id returned by request_skill_run. Run must be in pending status (approved, not pending_approval).",
        },
      },
      required: ["run_id"],
    },
  },
  {
    name: "start_skill_run",
    description:
      "Transition an approved agent-runnable skill run from pending to running. " +
      "Call this after request_skill_run returns status='pending' (meaning the run is approved and ready). " +
      "This tool does NOT browse, click, type, scroll, fill forms, or inspect pages. " +
      "After calling this, execute the workflow yourself using your own browser/runtime tools (e.g. @playwright/mcp). " +
      "When the workflow is done, call complete_skill_run (success) or fail_skill_run (failure) " +
      "so the audit receipt loop closes. Leaving a run in 'running' status indefinitely is incorrect. " +
      "For aegis_controlled skills, use start_playwright_route_run instead — that tool runs the workflow inside the Aegis controlled runtime.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The run_id from request_skill_run. Run must be in 'pending' status.",
        },
      },
      required: ["run_id"],
    },
  },
  {
    name: "complete_skill_run",
    description:
      "Mark a running agent-runnable skill run as completed and generate a signed RouteRunReceipt. " +
      "Call this after the agent has successfully executed all workflow steps in its own browser session. " +
      "This tool does NOT browse, click, type, or inspect pages — it only records the outcome. " +
      "Use Aegis handoff tools (request_secret_field_injection, report_security_challenge, etc.) separately for sensitive credentials, payments, or challenge codes. " +
      "Always call complete_skill_run or fail_skill_run when the task finishes — the audit receipt loop does not close otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The run_id to complete. Run must be in 'running' status.",
        },
        browser_session_id: {
          type: "string",
          description: "Optional. The task browser session ID used during execution, for audit linkage. Must not expose CDP URL, cookies, or credentials — only the session ID.",
        },
        summary: {
          type: "string",
          description: "Optional. Brief agent-provided summary of what was accomplished (max 160 chars). Will be sanitized.",
        },
      },
      required: ["run_id"],
    },
  },
  {
    name: "fail_skill_run",
    description:
      "Mark a running agent-runnable skill run as failed and generate a signed RouteRunReceipt with status='failed'. " +
      "Call this when the workflow could not be completed — navigation error, unexpected page state, challenge not resolved, etc. " +
      "This tool does NOT browse, click, type, or inspect pages — it only records the failure outcome. " +
      "Always call complete_skill_run or fail_skill_run when the task finishes — the audit receipt loop does not close otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The run_id to fail. Run must be in 'running' status.",
        },
        error: {
          type: "string",
          description: "Brief description of what failed (max 160 chars). Will be sanitized. Required.",
        },
        browser_session_id: {
          type: "string",
          description: "Optional. The task browser session ID used during execution, for audit linkage.",
        },
      },
      required: ["run_id", "error"],
    },
  },
  {
    name: "create_delegation_passport",
    description:
      "Create a signed Aegis Delegation Passport for a given delegation. The passport is a cryptographically signed document that proves: which verified user the agent is acting for, which collar governs it, what actions are allowed/blocked/require approval, that Aegis holds user secrets and the agent does NOT receive raw credentials or payment data, that sensitive covered actions require Aegis authorization + controlled runtime + sensitive workflow detection + signed receipts, and receipt-backed evidence from past runs. The passport does NOT prove the agent has no out-of-band secrets — it claims only that Aegis-covered actions were constrained by user approval, KMS credential custody, and the Aegis Playwright controlled runtime. Present the passport_jws to counterparties as a verifiable Aegis delegation claim.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: {
          type: "string",
          description: "The delegation_id to issue a passport for. Use the delegation_id returned by get_agent_identity.",
        },
        expires_in_minutes: {
          type: "number",
          description: "Optional. How long the passport should be valid in minutes. Defaults to 60.",
        },
      },
      required: ["delegation_id"],
    },
  },
  {
    name: "verify_delegation_passport",
    description:
      "Verify the cryptographic integrity and active status of an Aegis Delegation Passport. Recomputes the passport hash, verifies the EdDSA JWS signature, cross-checks JWS payload fields, and checks expiry/revocation. A valid active result means the passport hash matches, the Aegis signing key authenticated the content, the passport has not expired, and the delegation has not been revoked. A valid passport attests to Aegis-covered delegation boundaries — it does NOT prove the agent has no out-of-band secrets or that every browser action went through Aegis.",
    inputSchema: {
      type: "object",
      properties: {
        passport_id: {
          type: "string",
          description: "The passport_id returned by create_delegation_passport.",
        },
      },
      required: ["passport_id"],
    },
  },
  {
    name: "plan_aegis_action",
    description:
      "Analyze a task description and return a structured execution plan without executing anything. Matches installed skills and recommends: get_agent_runnable_workflow (routine agent-executable workflows), request_skill_run + start_playwright_route_run (Aegis-controlled sensitive workflows), or normal agent tools. For aegis_controlled skills, the response includes post_approval_next_tool='start_playwright_route_run' — after the run is created with request_skill_run and approved (if required), call start_playwright_route_run to execute via the Aegis Playwright runtime. Optionally resolves a vault credential by hint and includes a ready-to-use suggested_request. Call this first when you have a task description but haven't yet identified the skill or execution path.\n\nUse plan_aegis_action when you need skill matching or credential resolution. For open-ended identification of which Aegis interventions a task may require (without skill matching or credential lookup), prefer assess_sensitive_requirements instead.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Natural language description of the task. Examples: 'log into the demo site', 'search Wikipedia for Wisconsin', 'summarize this page'.",
        },
        domain: {
          type: "string",
          description:
            "Optional. Target domain to restrict skill discovery (e.g. 'en.wikipedia.org', 'localhost:3000'). Inferred from task keywords if omitted.",
        },
        credential_hint: {
          type: "string",
          description:
            "Optional. Substring to match against vault pass labels or usernames (e.g. 'Demo Login Account', 'staging'). Used only when the matched skill is aegis_controlled.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "assess_sensitive_requirements",
    description:
      "Identify which Aegis interventions a task may require — without constructing a step-by-step workflow plan and without executing anything. " +
      "The agent remains fully autonomous for navigation, clicking, reading, and summarization. " +
      "Aegis is invoked selectively only for credential custody, challenge relay, browser session lifecycle, and sensitive action receipts.\n\n" +
      "Preferred over plan_aegis_action when the goal is open-ended intervention identification rather than skill-matching or credential resolution. " +
      "Use plan_aegis_action when you specifically need an installed skill matched or a ready-to-use suggested_request with credential resolution.\n\n" +
      "recommended_mode values:\n" +
      "  agent_owned_task_with_aegis_interventions — agent executes the task; call listed Aegis tools at the specified trigger points\n" +
      "  requires_aegis_sensitive_workflow — high-risk irreversible action (payment, purchase); use a verified Aegis Rail\n" +
      "  requires_explicit_approval — requires user approval before any agent action (signup, account creation)\n" +
      "  requires_user_presence — cannot be delegated to an agent (identity verification, biometrics, KYC)\n\n" +
      "available_aegis_routes is advisory — if present, a matching installed skill was found; whether to use it is the agent's decision.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Natural language description of the task. Examples: 'Log into my account and list my activity', 'Buy this item', 'Search for hotels in Paris'.",
        },
        domain: {
          type: "string",
          description:
            "Optional. Target domain to restrict installed skill discovery (e.g. 'example.com', 'localhost:3000'). Inferred from task keywords if omitted.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "get_delegation_trust_profile",
    description:
      "Generate a task-specific Aegis trust profile for a delegation based on signed authorizations, signed execution receipts, sensitive workflow coverage, and custody evidence. Returns trust_status (unproven, capable_but_unproven, proven_limited, trusted_for_category, caution, risky, suspended), confidence level, capability summary, coverage stats, and category-specific execution history. This is not a guarantee and does not cover out-of-band secret use. Use this to assess whether a delegation has proven safe behavior for a specific task before proceeding.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: {
          type: "string",
          description: "The delegation ID to evaluate. Use the delegation_id returned by get_agent_identity.",
        },
        task_category: {
          type: "string",
          enum: [
            "login", "credential_fill", "purchase", "payment", "travel_booking",
            "financial_action", "identity_disclosure", "account_change",
            "destructive_action", "message_send",
          ],
          description: "The task category to evaluate trust for.",
        },
      },
      required: ["delegation_id", "task_category"],
    },
  },
  {
    name: "create_website_trust_assertion",
    description:
      "Create a signed Aegis Website Trust Assertion for a delegation and task category. The assertion is a compact, machine-readable document websites can request before admitting an agent. It synthesizes the delegation trust profile and optional passport data into a cryptographically signed recommendation (allow, allow_with_approval, step_up_required, or deny) without exposing secrets. Present assertion_jws to the requesting website as a signed Aegis trust claim. No raw credentials, passwords, or secret_refs are included in any assertion.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: {
          type: "string",
          description: "The delegation ID to issue the assertion for. Use the delegation_id returned by get_agent_identity.",
        },
        task_category: {
          type: "string",
          enum: [
            "login", "credential_fill", "purchase", "payment", "travel_booking",
            "financial_action", "identity_disclosure", "account_change",
            "destructive_action", "message_send",
          ],
          description: "The task category the agent intends to perform.",
        },
        requesting_domain: {
          type: "string",
          description: "The domain of the requesting website, e.g. 'example.com' or 'localhost'.",
        },
        requesting_origin: {
          type: "string",
          description: "Optional. Full origin URL of the requesting website, e.g. 'https://example.com'.",
        },
        passport_id: {
          type: "string",
          description: "Optional. A valid Delegation Passport ID to cross-reference in the assertion subject.",
        },
        human_readable_summary: {
          type: "string",
          description: "Optional. Human-readable description of the intended task, e.g. 'Agent wants to log in to localhost demo'.",
        },
        expires_in_minutes: {
          type: "number",
          description: "Optional. How long the assertion should be valid in minutes. Defaults to 30.",
        },
      },
      required: ["delegation_id", "task_category", "requesting_domain"],
    },
  },
  {
    name: "verify_website_trust_assertion",
    description:
      "Verify the cryptographic integrity and active status of an Aegis Website Trust Assertion. Recomputes the assertion hash, verifies the EdDSA JWS signature, cross-checks JWS payload fields against stored values, and checks expiry. A valid result (valid=true) means: the hash matches, the Aegis signing key authenticated the assertion, all payload fields are consistent, and the assertion has not expired.",
    inputSchema: {
      type: "object",
      properties: {
        assertion_id: {
          type: "string",
          description: "The assertion_id returned by create_website_trust_assertion.",
        },
      },
      required: ["assertion_id"],
    },
  },
  {
    name: "get_runtime_observation",
    description:
      "Get the latest agent-safe observation snapshot for an Aegis Playwright runtime session. Returns structured page metadata — element labels, placeholders, sensitivity classification, filled state, and allowed_actions — without exposing sensitive values. Sensitive fields (passwords, card numbers, credentials) always have value_redacted=true and their values are omitted. Sensitive action buttons (pay, book, change password, etc.) show allowed_actions=['read','request_click'] indicating they must go through Aegis route steps, not direct agent interaction. Use this to understand the current page state during or after a Playwright session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The runtime_session_id returned by start_playwright_route_run.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_runtime_observation_mode",
    description:
      "Check the current observation mode of an Aegis Playwright runtime session. Returns mode ('open_observation' or 'protected_observation'), when protected mode was activated, the reasons for activation (route permissions, URL patterns, DOM signals), and the specific signals that triggered it. Protected mode indicates the session is handling credentials, payment, identity, or other sensitive data.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The runtime_session_id returned by start_playwright_route_run.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_website_trust_profile",
    description:
      "Look up the Aegis-registered trust profile for a website domain. Returns the website's declared agent policy (allowed/prohibited actions, approval requirements, credential and payment handling commitments) and its signed safety promises. Distinct from get_website_agent_safety_profile (Aegis-computed evidence view) — this is what the website itself has declared and committed to Aegis. Only returns promises the site has committed to (committed=true). The profile_hash can be referenced in future WebsiteViolationReceipts if the site breaks its promises. Advisory only — represents declarations, not verified compliance.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to look up, e.g. 'localhost', 'example-store.local'.",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "verify_website_trust_profile",
    description:
      "Verify the cryptographic integrity of an Aegis website trust profile by recomputing its canonical hash and verifying the EdDSA JWS signature. A valid result (valid=true) confirms the profile's declared promises have not been tampered with since Aegis signed them. Returns hash_valid, signature_valid, the JWS payload, and an interpretation. Use after get_website_trust_profile when you need to confirm the profile's integrity before relying on its declared policies.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: {
          type: "string",
          description: "The profile_id from get_website_trust_profile (e.g. 'wtp_demo_localhost_001').",
        },
      },
      required: ["profile_id"],
    },
  },
  {
    name: "list_website_violation_receipts",
    description:
      "List signed Aegis website violation receipts. Violation receipts are generated only when a website's observed behavior violates a committed safety promise from its WebsiteTrustProfile — they are not general event logs. Each receipt includes the violated promise, severity, decision taken by Aegis, and a snapshot of the profile_hash at time of violation. Use to review the violation history for a domain before trusting it with agent actions. Optionally filter by domain, violation_type, severity, or decision.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Filter receipts for a specific domain (e.g. 'localhost', 'example.com').",
        },
        violation_type: {
          type: "string",
          enum: [
            "prompt_injection_detected",
            "secret_request_outside_approved_flow",
            "disguised_sensitive_action",
            "approval_boundary_violation",
            "unclear_sensitive_action_metadata",
            "agent_context_exfiltration_attempt",
            "collar_policy_override_attempt",
            "other",
          ],
          description: "Filter by violation type.",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Filter by severity.",
        },
        decision: {
          type: "string",
          enum: ["warned", "blocked", "escalated", "reputation_penalized", "recorded_only"],
          description: "Filter by Aegis decision.",
        },
      },
      required: [],
    },
  },
  {
    name: "verify_website_violation_receipt",
    description:
      "Cryptographically verify a website violation receipt by recomputing its canonical hash and verifying the EdDSA JWS signature. A valid result (valid=true) confirms the violation evidence has not been tampered with since Aegis created this receipt. Returns hash_valid, signature_valid, the JWS payload, and an interpretation. Use when you need to verify the integrity of a specific violation receipt before relying on it as trust evidence.",
    inputSchema: {
      type: "object",
      properties: {
        receipt_id: {
          type: "string",
          description: "The receipt_id of the violation receipt to verify (e.g. 'wvr_...').",
        },
      },
      required: ["receipt_id"],
    },
  },
  {
    name: "create_demo_website_violation_receipt",
    description:
      "DEMO/INTERNAL: Create a signed website violation receipt for a committed safety promise on an active WebsiteTrustProfile. This is a manual creation path for testing and demonstration purposes only — in production, violation receipts should only be generated from trusted Aegis detection evidence, not by agents directly. Requires an active WebsiteTrustProfile for the domain and a committed promise (committed: true). Returns the signed receipt with receipt_id and profile_hash snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        website_profile_id: {
          type: "string",
          description: "The profile_id of the active WebsiteTrustProfile (preferred over domain).",
        },
        domain: {
          type: "string",
          description: "The domain to find the active WebsiteTrustProfile for. Used if website_profile_id is not provided.",
        },
        violation_type: {
          type: "string",
          enum: [
            "prompt_injection_detected",
            "secret_request_outside_approved_flow",
            "disguised_sensitive_action",
            "approval_boundary_violation",
            "unclear_sensitive_action_metadata",
            "agent_context_exfiltration_attempt",
            "collar_policy_override_attempt",
            "other",
          ],
          description: "The type of trust boundary violation that was observed.",
        },
        violated_promise_id: {
          type: "string",
          description: "The promise_id from the profile's safety_promises that was violated (e.g. 'site_will_not_prompt_inject_agents'). Must be committed: true.",
        },
        redacted_evidence_summary: {
          type: "string",
          description: "A brief human-readable description of what was observed. Must not contain raw secrets, credentials, 2FA codes, passwords, page HTML, or raw browser traces.",
        },
        detection_source: {
          type: "string",
          enum: ["heuristic", "policy_check", "manual_report", "test_fixture", "other"],
          description: "How the violation was detected.",
        },
        decision: {
          type: "string",
          enum: ["warned", "blocked", "escalated", "reputation_penalized", "recorded_only"],
          description: "The action Aegis took in response.",
        },
        followup_required: {
          type: "boolean",
          description: "Whether this violation requires follow-up review.",
        },
        observed_at: {
          type: "string",
          description: "ISO 8601 timestamp when the violation was observed. Defaults to now.",
        },
        target_url_or_origin: {
          type: "string",
          description: "The URL or origin where the violation occurred. Query strings are stripped automatically.",
        },
        session_id: { type: "string", description: "Browser session ID if available." },
        route_run_id: { type: "string", description: "Route run ID if the violation occurred during a route run." },
        workspace_id: { type: "string", description: "Workspace ID if applicable." },
        task_id: { type: "string", description: "Task ID if applicable." },
        delegation_id: { type: "string", description: "Delegation ID if applicable." },
        agent_name: { type: "string", description: "Name of the agent involved." },
        agent_platform: { type: "string", description: "Platform of the agent involved." },
        evidence_hash: { type: "string", description: "Optional SHA-256 hash of external evidence." },
        detection_signals_count: { type: "number", description: "Number of detection signals that triggered." },
        blocked_action_type: { type: "string", description: "The specific action type that was blocked, if decision=blocked." },
        reputation_delta: { type: "number", description: "Reputation change applied, if decision=reputation_penalized." },
      },
      required: ["violation_type", "violated_promise_id", "redacted_evidence_summary", "detection_source", "decision"],
    },
  },
  {
    name: "get_website_agent_safety_profile",
    description:
      "Evaluate whether a website is safe for agent interaction for a specific task category. Returns a deterministic profile based on Aegis-observed signals: known routes, verified receipts, runtime coverage violations, interventions, and observation mode. Does not crawl the site live and does not verify business identity. Advisory only — not a guarantee. Use before requesting a skill run to understand the website's Aegis coverage posture for the task.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to evaluate (e.g. 'localhost', 'en.wikipedia.org', 'localhost:3000').",
        },
        task_category: {
          type: "string",
          enum: [
            "login", "credential_fill", "purchase", "payment", "travel_booking",
            "financial_action", "identity_disclosure", "account_change",
            "destructive_action", "message_send",
          ],
          description: "The task category the agent intends to perform on this website.",
        },
      },
      required: ["domain", "task_category"],
    },
  },
  {
    name: "get_website_aegis_policy",
    description:
      "Fetch and return the Aegis agent policy published by a website at its /.well-known/aegis-policy.json endpoint. The policy declares which agent workflows the site supports, what capabilities are required, what is prohibited, and what assertions agents must provide. Self-asserted in v1 — not business-verified and not signed. Use alongside get_website_agent_safety_profile to get both the site-declared contract and Aegis-observed evidence. Only localhost is supported in v1.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to fetch the Aegis policy for (e.g. 'localhost', 'localhost:3000').",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "validate_website_aegis_policy",
    description:
      "Fetch and validate the structural integrity of a website's Aegis policy. Returns validation result with errors (disqualifying) and warnings (non-disqualifying). Use to check whether a policy is well-formed before using it for compatibility or trust decisions. Only localhost is supported in v1.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain whose Aegis policy to validate.",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "check_website_policy_compatibility",
    description:
      "Check whether a website's declared Aegis policy is compatible with a specific task category. Returns whether the combination is compatible, the recommendation (allow/allow_with_approval/step_up_required/deny), required capabilities, required assertions the agent must provide, and the matching workflow IDs. Use before requesting a skill run to verify the website policy supports the intended task. Only localhost is supported in v1.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to check compatibility for.",
        },
        task_category: {
          type: "string",
          enum: [
            "login", "credential_fill", "purchase", "payment", "travel_booking",
            "financial_action", "identity_disclosure", "account_change",
            "destructive_action", "message_send",
          ],
          description: "The task category the agent intends to perform.",
        },
      },
      required: ["domain", "task_category"],
    },
  },
  {
    name: "get_runtime_browser_endpoint",
    description:
      "Initialize or retrieve the Aegis local browser runtime for this delegation. " +
      "Agent browser tooling (e.g. @playwright/mcp) should attach to the returned cdp_url for all ordinary browsing — " +
      "navigation, reading, clicking, and scrolling. Users should not manually manage this session.\n\n" +
      "Aegis handles only sensitive handoffs through the runtime: credential field injection, payment fields, " +
      "sensitive action approvals, challenge relay, and signed receipts. The agent drives everything else.\n\n" +
      "Call this once at task start. If a ready runtime already exists for this delegation it is returned immediately (reused_existing=true). " +
      "Otherwise Aegis provisions a fresh ephemeral Chrome session with no-save policy enforced. " +
      "When port_auto_selected=true, reconnect your browser adapter to the returned cdp_url before navigating.\n\n" +
      "Pass the returned browser_runtime_id as browser_session_id in:\n" +
      "- request_secret_field_injection (credential fields)\n" +
      "- request_payment_card_fill (each card field fill request)\n" +
      "- request_purchase_confirmation (the purchase authorization request)\n" +
      "- execute_purchase_confirmation_handoff (the button click)\n\n" +
      "Missing browser_session_id in any payment tool call causes Aegis to fall back to the static AEGIS_PLAYWRIGHT_CDP_URL env var. " +
      "If that port differs from the active runtime, CDP targets the wrong page and fails with 'element not found' even when selectors are correct.\n\n" +
      "Do NOT use navigate_task_browser_session / observe_task_browser_session / click_element_in_task_browser_session if your agent has @playwright/mcp — those are compatibility tools for agents with no browser tooling.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["headless", "visible"],
          description: "Optional. Default 'headless'. Set to 'visible' ONLY when the user explicitly requests a visible Chrome window for local debugging.",
        },
      },
      required: [],
    },
  },
  {
    name: "start_task_browser_session",
    description:
      "[COMPATIBILITY MODE — Use get_runtime_browser_endpoint instead unless you need low-level session lifecycle control.]\n\n" +
      "Create an ephemeral Chrome browser session for agent-controlled navigation. Sessions are headless by default — no visible Chrome window.\n\n" +
      "Aegis launches Chrome with --remote-debugging-port=9222 and a fresh /tmp profile " +
      "that has password saving, autofill, card saving, and sync disabled. " +
      "The agent uses Playwright browser tools (via @playwright/mcp --cdp-endpoint=http://localhost:9222) for all navigation, clicking, and reading. " +
      "Aegis uses the CDP connection ONLY for secret field injection (request_secret_field_injection) — " +
      "Aegis does NOT navigate, click, or read pages on behalf of the agent.\n\n" +
      "When to call this: when you need a browser for a task (e.g., log in to a website, navigate to fetch data) " +
      "and no task browser session is currently running. Check get_task_browser_session first if you think one may exist.\n\n" +
      "Do NOT close the session immediately after login — keep it open while you continue the task. " +
      "Call close_task_browser_session only after the full task is complete.\n\n" +
      "Aegis automatically handles port conflicts: if an active Aegis session is already running it is reused (reused_existing=true). " +
      "Stale sessions are recycled automatically. If the default port is taken by an unknown process, Aegis selects an available port " +
      "and returns port_auto_selected=true with requires_browser_reconnect=true — use the returned cdp_url with your browser adapter before navigating. " +
      "Returns NO_PORTS_AVAILABLE (503) only if no port in the 9222–9230 range is available or Chrome cannot launch.\n\n" +
      "LOCAL-DEV NOTE: When requires_browser_reconnect=true, the browser adapter must be pointed at the returned cdp_url. " +
      "In production, browser adapters should use dynamic session handles rather than static endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: {
          type: "string",
          description: "Optional delegation ID to associate with the browser session.",
        },
        debug_visible: {
          type: "boolean",
          description: "Optional. Default false. Set to true ONLY when the user explicitly requests a visible Chrome window for local debugging. Normal task execution must always be headless.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_task_browser_session",
    description:
      "Get the status and metadata of a task browser session. " +
      "Use to check if a session is 'ready' before using Playwright tools, or to see if a session already exists. " +
      "Does not return cookies, storage, credentials, or process details.",
    inputSchema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "The browser_session_id from start_task_browser_session.",
        },
      },
      required: ["browser_session_id"],
    },
  },
  {
    name: "close_task_browser_session",
    description:
      "Close an ephemeral task browser session and delete its profile. " +
      "Kills the Chrome process and removes the /tmp profile directory, deleting all cookies, localStorage, and session data. " +
      "Call this ONLY after the full task is complete — the agent still needs the browser to navigate and read after login. " +
      "Starting a new task browser session after close guarantees a clean, unauthenticated state.",
    inputSchema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "The browser_session_id to close.",
        },
      },
      required: ["browser_session_id"],
    },
  },
  {
    name: "navigate_task_browser_session",
    description:
      "[COMPATIBILITY MODE — Use only if your agent has no external browser tooling such as @playwright/mcp. " +
      "If you have browser tooling, use get_runtime_browser_endpoint and attach your tooling to the returned cdp_url instead.]\n\n" +
      "Navigate the active task browser session to a URL and return a safe page summary. " +
      "Use this when the agent does NOT have its own Playwright MCP browser runtime (e.g. Claude Cowork). " +
      "If the agent already has Playwright MCP, use that instead — this tool is a compatibility bridge only.\n\n" +
      "Only http:// and https:// URLs are accepted. file://, javascript:, and data: are blocked.\n\n" +
      "Returns: current_url and a safe snapshot (page_title, headings, links_sample, buttons_sample, forms_detected). " +
      "Never returns input values, cookies, session storage, credentials, or screenshots.\n\n" +
      "Typical flow: start_task_browser_session → navigate_task_browser_session → observe_task_browser_session " +
      "→ request_secret_field_injection (with browser_session_id) → click_element_in_task_browser_session → observe_task_browser_session\n\n" +
      "IMPORTANT: Credential fields (username, password) MUST go through request_secret_field_injection — never type credentials directly.",
    inputSchema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "The browser_session_id from start_task_browser_session.",
        },
        url: {
          type: "string",
          description: "The URL to navigate to. Must be http:// or https://.",
        },
      },
      required: ["browser_session_id", "url"],
    },
  },
  {
    name: "observe_task_browser_session",
    description:
      "[COMPATIBILITY MODE — Use only if your agent has no external browser tooling such as @playwright/mcp. " +
      "If you have browser tooling, use get_runtime_browser_endpoint and attach your tooling to the returned cdp_url instead.]\n\n" +
      "Observe the current page in the task browser session without navigating. " +
      "Use this when the agent does NOT have its own Playwright MCP browser runtime (e.g. Claude Cowork).\n\n" +
      "Returns a safe summary of the current page: page_title, headings, links_sample, buttons_sample, forms_detected. " +
      "Never returns input values, cookies, session storage, screenshots, credentials, or raw DOM.\n\n" +
      "Call this after navigate_task_browser_session or after click_element_in_task_browser_session to read updated page state.",
    inputSchema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "The browser_session_id from start_task_browser_session.",
        },
      },
      required: ["browser_session_id"],
    },
  },
  {
    name: "click_element_in_task_browser_session",
    description:
      "[COMPATIBILITY MODE — Use only if your agent has no external browser tooling such as @playwright/mcp. " +
      "If you have browser tooling, use get_runtime_browser_endpoint and attach your tooling to the returned cdp_url instead.]\n\n" +
      "Click an element in the task browser session by CSS selector and return a safe observation of the resulting page. " +
      "Use this when the agent does NOT have its own Playwright MCP browser runtime (e.g. Claude Cowork).\n\n" +
      "IMPORTANT: Do NOT use this to type text or fill credential fields. " +
      "Username and password fields MUST go through request_secret_field_injection — never click+type credentials. " +
      "Only use this for non-sensitive interactive elements: submit buttons, links, tabs, toggles, checkboxes.\n\n" +
      "Returns: clicked=true, current_url, and a safe page snapshot after the click. " +
      "Never returns input values, cookies, storage, or credentials.",
    inputSchema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "The browser_session_id from start_task_browser_session.",
        },
        selector: {
          type: "string",
          description: "A CSS selector identifying the element to click, e.g. 'button[type=submit]', 'a[href=\"/login\"]'.",
        },
        description: {
          type: "string",
          description: "Optional. Human-readable description of what is being clicked, e.g. 'Sign in button'. Used for audit context.",
        },
      },
      required: ["browser_session_id", "selector"],
    },
  },
  {
    name: "request_authenticated_session_login",
    description:
      "SECONDARY/EXPERIMENTAL — Do not use for normal login when the agent has a Playwright browser and is not hitting a passkey/trusted-device wall. " +
      "Primary path for login fields is request_secret_field_injection: agent navigates its own browser, Aegis fills only the protected fields via CDP.\n\n" +
      "Use request_authenticated_session_login WHEN:\n" +
      "  (1) The agent has no browser of its own.\n" +
      "  (2) The user explicitly asks Aegis to perform an isolated login.\n" +
      "  (3) The task requires an authenticated session handle for observe/navigate.\n" +
      "  (4) The site requires a passkey or trusted-device challenge — pass browser_session_id from start_task_browser_session so the user can complete the challenge in the visible task browser window.\n\n" +
      "TRUSTED BROWSER REUSE (browser_session_id): If the site blocks login from a fresh headless browser (e.g. GitHub passkey), pass the browser_session_id returned by start_task_browser_session. " +
      "Aegis will connect to that existing browser via CDP instead of launching a new one. " +
      "If a passkey or challenge appears, the user can complete it directly in the task browser window — the session stays open for interaction. " +
      "The task browser is NOT closed when the authenticated session ends (only Aegis's page is closed). " +
      "Recommended workflow: call start_task_browser_session first, then pass its browser_session_id here.\n\n" +
      "What it does: Aegis performs the ENTIRE login workflow using a KMS-vaulted credential. " +
      "The agent receives only an authenticated_session_id handle — never the password, cookies, localStorage, sessionStorage, storageState, Set-Cookie headers, auth tokens, secret_ref values, pass_id, KMS envelopes, or ciphertext. " +
      "After calling, direct the user to /route-run-approvals. Poll get_authenticated_session until status is 'authenticated' or 'manual_step_required'. " +
      "If status becomes 'manual_step_required' and you passed browser_session_id, tell the user to complete the challenge in the task browser window, then poll again.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to log into, e.g. 'github.com'. Must match the vault pass domain.",
        },
        login_url: {
          type: "string",
          description: "The full login page URL, e.g. 'https://github.com/login'. Must be http:// or https://.",
        },
        task_summary: {
          type: "string",
          description: "Short description of why the agent needs this session, shown to the user in the approval UI.",
        },
        pass_id: {
          type: "string",
          description: "Optional. The pass_id from list_vault_passes to use for login. If omitted, Aegis selects the first matching credential for the domain.",
        },
        browser_session_id: {
          type: "string",
          description: "Optional but recommended. The browser_session_id from start_task_browser_session. If provided, Aegis connects to that existing task browser via CDP instead of launching a fresh headless browser. Use this when the site requires a passkey or trusted-device check — the user can complete it in the visible task browser window. The task browser is NOT closed when the session ends.",
        },
      },
      required: ["domain", "login_url", "task_summary"],
    },
  },
  {
    name: "get_authenticated_session",
    description:
      "Poll the status of an Aegis authenticated session. Returns the session handle with status, capabilities, and expiry. Use this to wait for a pending_approval session to become authenticated after the user approves, or to check for manual_step_required (security challenge detected). Terminal statuses: 'authenticated' (login succeeded, observe/navigate now available), 'manual_step_required' (2FA/CAPTCHA/passkey detected — stop and inform user), 'failed' (login error), 'expired' (30-minute window elapsed). Non-terminal: 'pending_approval' (waiting for user), 'login_in_progress' (Aegis running). Aegis NEVER returns cookies, storage, passwords, secret_ref values, pass_id, KMS material, ciphertext, storageState, or auth tokens.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id returned by request_authenticated_session_login.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "observe_authenticated_session",
    description:
      "Get a safe observation snapshot of the current page in an authenticated Aegis browser session. Returns structured page metadata — headings, links, buttons, form structure, and (for sensitive pages) element-level sensitivity classification with allowed_actions. Sensitive field values are ALWAYS redacted (value_redacted: true). Aegis NEVER returns raw cookies, storage, session tokens, passwords, secret_ref values, pass_id, KMS material, ciphertext, or storageState. Session must be in 'authenticated' status. If the session is in 'manual_step_required', stop and do not call this tool.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id from request_authenticated_session_login.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "navigate_authenticated_session",
    description:
      "Navigate the authenticated Aegis browser session to a same-domain URL, then return a safe observation snapshot. Same-domain enforcement is strict — cross-domain navigation is blocked with CROSS_DOMAIN_NAVIGATION_BLOCKED. No form submission, POST actions, credential fill, or clicks are performed — navigation is page.goto only. Returns the same observation format as observe_authenticated_session. Session must be in 'authenticated' status with 'safe_navigation' capability. Aegis NEVER returns cookies, storage, passwords, secret_ref values, pass_id, KMS material, ciphertext, or storageState.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id from request_authenticated_session_login.",
        },
        url: {
          type: "string",
          description: "The URL to navigate to. Must be same-domain as the session's login domain. E.g. if domain is 'github.com', only URLs on github.com are allowed.",
        },
      },
      required: ["session_id", "url"],
    },
  },
  {
    name: "request_secret_field_injection",
    description:
      "Request Aegis to inject a stored credential (username or password) directly into a field " +
      "in your active Playwright browser via CDP — without returning the value to the agent. " +
      "IMPORTANT PRODUCT BOUNDARIES:\n" +
      "- This is the PRIMARY path for credential fields when using an agent-controlled Playwright browser (e.g., Claude Code).\n" +
      "- Do NOT use start_credential_session (targets the Aegis Chrome extension on a user tab — incompatible with agent Playwright browsers).\n" +
      "- Do NOT use request_authenticated_session_login (that tool performs the ENTIRE login in a separate Aegis-controlled browser — Aegis should not own the login workflow).\n" +
      "- Aegis does NOT click Submit, Next, or Sign In. The agent is responsible for all clicking and navigation.\n" +
      "- Aegis does NOT choose between OAuth and username/password. The agent must navigate to the username/password login path before calling this.\n" +
      "- Aegis does NOT log into the site for the agent. Aegis only fills the specific field you request.\n" +
      "- Routes/skills are for complex high-risk workflows (payments, banking, account deletion) — not for normal login.\n" +
      "- CREDENTIAL PROVIDER DOMAINS: Each vault pass is bound to a specific credential provider domain (e.g. a GitHub credential is valid only on github.com). Use the GitHub credential only when the active browser is on github.com — Aegis validates the domain before injecting and will reject cross-domain injection with a clear error. If a site uses OAuth (e.g. Supabase redirecting to github.com for login), navigate to the OAuth provider's login page first, then request injection against github.com, not the originating site.\n" +
      "ONE-APPROVAL FLOW: When you call this for a username field, Aegis creates one 'credential-use authorization' covering BOTH username and password for this login attempt. " +
      "The user approves once at /route-run-approvals under 'Login credential requests' — that single approval covers both fields. " +
      "You do NOT need to request a second approval for the password injection on the same login attempt.\n" +
      "After calling this tool: if status='approved', call execute_secret_field_injection immediately. " +
      "If status='pending_approval', direct the user to /route-run-approvals under 'Login credential requests', then call execute_secret_field_injection after approval. " +
      "For subsequent fields in the same login attempt, call request_secret_field_injection again — it will auto-attach to the same authorization (no second approval needed if already approved). " +
      "Call list_vault_passes first if you need to identify the correct pass_id for the domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain of the page where the field exists (e.g. 'github.com', 'localhost'). Must match the hostname of page_url and the vault pass domain.",
        },
        pass_id: {
          type: "string",
          description: "Optional. The pass_id from list_vault_passes. If omitted, Aegis uses the first matching credential for the domain.",
        },
        field_kind: {
          type: "string",
          enum: ["username", "password"],
          description: "'username' fills email/username inputs. 'password' fills password inputs. Password injection always requires user approval.",
        },
        page_url: {
          type: "string",
          description: "The full URL of the current page containing the field (e.g. 'https://github.com/login'). The hostname must match domain. Aegis rejects cross-domain injection requests with a clear error.",
        },
        element_hint: {
          type: "object",
          description: "Optional hints to identify the target field. Provide any of: label (visible label text), placeholder (input placeholder text), input_type (e.g. 'email', 'password'), or selector_hint (CSS selector). If omitted, Aegis infers a selector from field_kind.",
          properties: {
            label: { type: "string", description: "Visible label text for the input." },
            placeholder: { type: "string", description: "Placeholder text of the input." },
            input_type: { type: "string", description: "HTML input type, e.g. 'password', 'email', 'text'." },
            selector_hint: { type: "string", description: "CSS selector targeting the field, e.g. '#login_field', 'input[name=\"login\"]'." },
          },
        },
        reason: {
          type: "string",
          description: "Short explanation shown to the user in the approval UI. E.g. 'Filling GitHub username to log in to github.com/login'.",
        },
        browser_session_id: {
          type: "string",
          description: "Optional. The browser_session_id from start_task_browser_session, or the browser_runtime_id from get_runtime_browser_endpoint. Mutually exclusive with external_cdp_url. Use when the browser was provisioned by Aegis.",
        },
        external_cdp_url: {
          type: "string",
          description: "Optional. The CDP endpoint of a browser you already own (e.g. 'http://localhost:9222'). Use when you are using @playwright/mcp or another external browser tool and Aegis does not own the browser session. Mutually exclusive with browser_session_id. Must be http://localhost:<port>.",
        },
      },
      required: ["domain", "field_kind", "page_url", "reason"],
    },
  },
  {
    name: "get_secret_injection_status",
    description:
      "Poll the status of a secret field injection request created by request_secret_field_injection. " +
      "Use this to check whether the user has approved the injection at /route-run-approvals. " +
      "When status='approved', call execute_secret_field_injection. " +
      "Terminal statuses: 'filled', 'denied', 'failed', 'expired'.",
    inputSchema: {
      type: "object",
      properties: {
        injection_request_id: {
          type: "string",
          description: "The injection_request_id returned by request_secret_field_injection.",
        },
      },
      required: ["injection_request_id"],
    },
  },
  {
    name: "execute_secret_field_injection",
    description:
      "Execute an approved secret field injection — Aegis resolves the credential from the KMS vault " +
      "and injects it into the browser field via CDP. The raw credential value is NEVER returned to the agent. " +
      "For password fields, Aegis additionally masks el.value in the browser after injection so that " +
      "browser_snapshot and accessibility snapshots return an empty string for that field — " +
      "this is a JS-layer mitigation, not a browser-engine security boundary. " +
      "Requires AEGIS_PLAYWRIGHT_CDP_URL to be configured on the Aegis API server and the Playwright MCP " +
      "server to be started with --cdp-port matching that URL. " +
      "Only call this after: (1) the injection status is 'approved', AND (2) the agent has navigated to the page " +
      "containing the target field. After the field is filled, proceed directly to the next step — " +
      "do NOT snapshot the filled password field. Aegis does not submit forms.\n\n" +
      "STRONGLY PREFER execute_credential_step_handoff for login flows — it fills the field AND submits atomically, " +
      "so the password is never readable by the agent between fill and submit. " +
      "Do NOT use this tool + a separate browser_click for password login submit — " +
      "that two-step pattern leaves the filled password field exposed between calls.",
    inputSchema: {
      type: "object",
      properties: {
        injection_request_id: {
          type: "string",
          description: "The injection_request_id returned by request_secret_field_injection.",
        },
      },
      required: ["injection_request_id"],
    },
  },
  {
    name: "execute_credential_step_handoff",
    description:
      "Fill a credential field AND submit the login form in one atomic step — Aegis fills the field via CDP, " +
      "clicks the specified submit button, waits for the page to settle, then returns control with a safe outcome classification.\n\n" +
      "USE THIS instead of execute_secret_field_injection + manual browser_click for login flows. " +
      "The password field is never visible to the agent after handoff — control returns only after navigation or a challenge page appears.\n\n" +
      "FLOW:\n" +
      "1. request_secret_field_injection (username or password) → get injection_request_id + authorization_id\n" +
      "2. wait_for_credential_authorization (poll until approved)\n" +
      "3. execute_credential_step_handoff (fill + submit + wait)\n\n" +
      "STEP KINDS:\n" +
      "- username_next: fill username/email field, click Next/Continue, wait for password page\n" +
      "- password_submit: fill password field, click Sign in/Submit, wait for navigation or challenge\n\n" +
      "RESPONSE STATUSES:\n" +
      "- navigated: page URL changed (likely success or new step)\n" +
      "- challenge_detected: 2FA/CAPTCHA/email verification required → call report_security_challenge\n" +
      "- invalid_credentials: bad username/password detected\n" +
      "- step_completed: submit sent, page settled (no navigation detected)\n" +
      "- submit_failed: button not found or click failed\n" +
      "- manual_step_required: unknown page state\n" +
      "- blocked_policy: button text matched payment/destructive blocklist\n\n" +
      "BOUNDARIES:\n" +
      "- Agent still owns: all navigation, reading pages, choosing login method, clicking non-credential controls\n" +
      "- Aegis owns: the credential fill + one login-submit click + post-submit wait\n" +
      "- Payment, purchase, and account-deletion submits are hard-blocked by policy\n" +
      "- The raw credential value is NEVER returned to the agent\n\n" +
      "ANTI-PATTERNS — do not do these:\n" +
      "- Do NOT call browser_snapshot or any browser read tool between credential fill and submit. " +
      "This handoff performs fill and submit atomically — no snapshot step belongs between them.\n" +
      "- Do NOT use execute_secret_field_injection + a separate browser_click for password login submit. " +
      "That pattern leaves the filled password field readable by browser tools between the two calls.\n" +
      "- Do NOT use Antigen compatibility browser tools (navigate/observe/click) while antigen-browser is active — " +
      "use antigen-browser for all navigation, reading, and clicking outside of this handoff.",
    inputSchema: {
      type: "object",
      required: ["injection_request_id", "step_kind", "reason"],
      properties: {
        injection_request_id: {
          type: "string",
          description: "The injection_request_id returned by request_secret_field_injection. Must be in 'approved' status.",
        },
        step_kind: {
          type: "string",
          enum: ["username_next", "password_submit"],
          description: "Which login micro-step this covers. username_next: fill email/username + click Next. password_submit: fill password + click Sign in.",
        },
        submit: {
          type: "object",
          description: "Optional hints for locating the submit button. At least one of selector_hint or button_text is recommended.",
          properties: {
            selector_hint: {
              type: "string",
              description: "CSS selector for the submit button, e.g. 'button[type=\"submit\"]', '#login-submit'. Preferred over button_text.",
            },
            button_text: {
              type: "string",
              description: "Visible label of the submit button, e.g. 'Sign in', 'Next', 'Continue'. Only login-type text is allowed.",
            },
          },
        },
        reason: {
          type: "string",
          description: "One sentence explaining why this step is being executed, shown in the audit trail.",
        },
      },
    },
  },
  // ─── Payment Card Fill Handoff v1 ────────────────────────────────────────────
  {
    name: "request_payment_card_fill",
    description:
      "Request Aegis to fill a stored payment card field in the active browser via CDP — without returning raw card values to the agent.\n\n" +
      "CRITICAL PRODUCT BOUNDARY:\n" +
      "- This approval covers card FIELD FILL only.\n" +
      "- It does NOT authorize a purchase, charge, subscription, or any payment action.\n" +
      "- A separate purchase confirmation approval (request_purchase_confirmation) is required before any payment is submitted.\n" +
      "- The agent owns all navigation and form submission decisions. Antigen only fills the requested fields.\n\n" +
      "SECURITY:\n" +
      "- card_number and CVV are resolved server-side via KMS and injected via CDP. The agent never receives them.\n" +
      "- card_number and CVV fields are masked in the DOM after fill (agent cannot read them back).\n" +
      "- Non-secret fields (expiry, cardholder_name, billing_zip) are filled without KMS.\n\n" +
      "RUNTIME BINDING:\n" +
      "Always pass browser_session_id from get_runtime_browser_endpoint. Missing browser_session_id causes Aegis to fall back to the\n" +
      "static CDP env var — if that port does not match your active runtime, execute_payment_card_fill_handoff will fail with\n" +
      "'element not found' even when your selectors are correct. This is the most common cause of card fill failures.\n\n" +
      "FLOW:\n" +
      "0. Call get_runtime_browser_endpoint to get browser_runtime_id. Navigate to the checkout page in that runtime.\n" +
      "1. Call request_payment_card_fill for each field you need (card_number, cvv, expiry_combined, etc.).\n" +
      "   - Pass browser_session_id: browser_runtime_id on every call.\n" +
      "   - If status='approved': call execute_payment_card_fill_handoff immediately.\n" +
      "   - If status='pending_approval': tell the user to approve at /route-run-approvals under 'Payment card requests'.\n" +
      "     Then call wait_for_payment_card_fill_authorization with the returned authorization_id.\n" +
      "2. Once approved, call execute_payment_card_fill_handoff for each fill_request_id.\n" +
      "3. After all fields are filled, YOU decide whether to submit the form — Aegis does not submit for you.\n\n" +
      "FIELD NAMES: card_number, cvv, expiry_month, expiry_year, expiry_combined (MM/YY), cardholder_name, billing_zip\n\n" +
      "SELECTOR SAFETY: selector_hint must target the INPUT field only. Never use selectors for button, submit, form, a[href], or [role=button].\n\n" +
      "PAYMENT METHOD: omit payment_method_id to use the default payment method.",
    inputSchema: {
      type: "object",
      required: ["domain", "field", "page_url", "reason"],
      properties: {
        domain: {
          type: "string",
          description: "The checkout domain, e.g. 'checkout.example.com'. Must match the page_url hostname.",
        },
        payment_method_id: {
          type: "string",
          description: "Optional. Omit to use the user's default payment method.",
        },
        field: {
          type: "string",
          enum: ["card_number", "cvv", "expiry_month", "expiry_year", "expiry_combined", "cardholder_name", "billing_zip"],
          description: "Which card field to fill. card_number and cvv are KMS-protected — raw values are never returned.",
        },
        page_url: {
          type: "string",
          description: "Full URL of the checkout page, e.g. 'https://checkout.example.com/payment'.",
        },
        element_hint: {
          type: "object",
          description: "Optional hints to locate the input field. selector_hint must target only an input element.",
          properties: {
            label: { type: "string", description: "Visible label text for the input field." },
            placeholder: { type: "string", description: "Placeholder text of the input." },
            input_type: { type: "string", description: "The type attribute of the input, e.g. 'tel', 'text'." },
            selector_hint: {
              type: "string",
              description: "CSS selector for the INPUT field only. Must not target button, submit, form, or a[href] elements.",
            },
          },
        },
        reason: {
          type: "string",
          description: "One sentence explaining why this fill is needed, shown in the audit trail.",
        },
        browser_session_id: {
          type: "string",
          description: "Preferred: browser_runtime_id from get_runtime_browser_endpoint. Mutually exclusive with external_cdp_url. Missing this is the most common cause of CDP_FILL_FAILED.",
        },
        external_cdp_url: {
          type: "string",
          description: "CDP base URL for an agent-owned browser, e.g. 'http://localhost:9222'. Mutually exclusive with browser_session_id. Not recommended — use get_runtime_browser_endpoint instead.",
        },
      },
    },
  },
  {
    name: "wait_for_payment_card_fill_authorization",
    description:
      "Poll until the user approves or denies a pending payment card fill authorization.\n\n" +
      "Use after request_payment_card_fill returns status='pending_approval'.\n" +
      "Tell the user: \"Please approve the card fill request at /route-run-approvals under 'Payment card requests'.\"\n" +
      "Do NOT ask the user to confirm in chat.\n\n" +
      "Terminal statuses: approved, denied, expired, revoked, fulfilled.\n" +
      "On 'approved': call execute_payment_card_fill_handoff for each pending fill_request_id.\n" +
      "On 'denied' or 'expired': do not attempt card fill without a new user approval.",
    inputSchema: {
      type: "object",
      required: ["authorization_id"],
      properties: {
        authorization_id: {
          type: "string",
          description: "The authorization_id returned by request_payment_card_fill.",
        },
        timeout_ms: {
          type: "number",
          description: "Max polling duration in milliseconds. Default: 300000 (5 minutes).",
        },
        poll_interval_ms: {
          type: "number",
          description: "Polling interval in milliseconds. Default: 3000.",
        },
      },
    },
  },
  {
    name: "execute_payment_card_fill_handoff",
    description:
      "Execute an approved payment card fill — Aegis resolves the field value from KMS and injects it via CDP.\n\n" +
      "RUNTIME BINDING:\n" +
      "Aegis uses the browser_session_id stored on the fill request (passed at request_payment_card_fill time) to target the correct\n" +
      "runtime page. If browser_session_id was missing when the fill was requested, execute will fail with 'element not found'\n" +
      "even when selectors are correct. To fix: create a new fill request via request_payment_card_fill with browser_session_id\n" +
      "from get_runtime_browser_endpoint — do not re-execute the old fill request.\n\n" +
      "CRITICAL:\n" +
      "- Raw card values (card_number, CVV) are NEVER returned to the agent.\n" +
      "- card_number and CVV are masked in the DOM after fill.\n" +
      "- This call does NOT submit any form, click any button, or authorize any purchase.\n" +
      "- The agent owns all submission decisions after this call.\n\n" +
      "Call only after:\n" +
      "1. fill_request status is 'approved' (confirmed via request_payment_card_fill or wait_for_payment_card_fill_authorization)\n" +
      "2. The agent's browser is on the page containing the target field.\n\n" +
      "If the field is inside an iframe, this call will return a clear error (IFRAME_NOT_SUPPORTED). " +
      "Do not attempt workarounds — iframes require a future Aegis increment.\n\n" +
      "If the field cannot be found, this call fails safely. Never try to click Next/Submit/Continue to recover.",
    inputSchema: {
      type: "object",
      required: ["fill_request_id"],
      properties: {
        fill_request_id: {
          type: "string",
          description: "The fill_request_id returned by request_payment_card_fill.",
        },
      },
    },
  },
  // ─── Purchase Confirmation Handoff v1 ────────────────────────────────────────
  {
    name: "request_purchase_confirmation",
    description:
      "Request a separate user approval to submit a final payment action (clicking the Pay/Place Order button).\n\n" +
      "CRITICAL PRODUCT BOUNDARY:\n" +
      "- This is SEPARATE from request_payment_card_fill. Card fill does NOT authorize purchase submission.\n" +
      "- You MUST obtain a PurchaseConfirmationAuthorization (pconf_...) before any payment button is clicked.\n" +
      "- Do NOT pass a PaymentCardFillAuthorization ID (pca_...) to execute_purchase_confirmation_handoff — it will be rejected with 403.\n" +
      "- Never click the payment button yourself. Antigen clicks it only after the user approves this separate request.\n\n" +
      "RUNTIME BINDING:\n" +
      "Pass browser_session_id: browser_runtime_id from get_runtime_browser_endpoint. Aegis stores this on the authorization and uses it\n" +
      "at execute_purchase_confirmation_handoff time to locate the correct runtime page. Missing browser_session_id causes the button\n" +
      "click to fail with 'no page found for domain' or target the wrong browser entirely.\n\n" +
      "FLOW:\n" +
      "0. Call get_runtime_browser_endpoint to get browser_runtime_id (same session used for card fills).\n" +
      "1. Fill all card fields (via request_payment_card_fill + execute_payment_card_fill_handoff).\n" +
      "2. Call request_purchase_confirmation with payment details, exact button text, and browser_session_id: browser_runtime_id.\n" +
      "3. If status='pending_approval': tell the user to approve at /route-run-approvals under 'Purchase confirmations'.\n" +
      "   Then call wait_for_purchase_confirmation_authorization with the returned purchase_confirmation_id.\n" +
      "4. Once approved, call execute_purchase_confirmation_handoff.\n\n" +
      "SECURITY:\n" +
      "- Antigen clicks exactly one button after explicit user approval.\n" +
      "- No card values, CVV, refs, ciphertext, cookies, storage, or KMS material are returned.\n" +
      "- No 3DS, challenge solving, or multi-step checkout automation.",
    inputSchema: {
      type: "object",
      required: ["domain", "page_url", "merchant", "item_summary", "payment_method_label", "payment_method_last4", "button_text", "reason"],
      properties: {
        domain: {
          type: "string",
          description: "The checkout domain, e.g. 'localhost'. Must match the page_url hostname.",
        },
        page_url: {
          type: "string",
          description: "Full URL of the checkout page, e.g. 'http://localhost:3001/stripe-checkout'.",
        },
        merchant: {
          type: "string",
          description: "Merchant or store name shown to the user for approval, e.g. 'Mock Store'.",
        },
        amount: {
          type: "number",
          description: "Purchase amount as a number, e.g. 12.99. Omit if unknown.",
        },
        currency: {
          type: "string",
          description: "Currency code, e.g. 'USD'. Defaults to 'USD' if omitted.",
        },
        amount_unknown: {
          type: "boolean",
          description: "Set to true if you could not determine the amount. The UI will show a strong warning.",
        },
        item_summary: {
          type: "string",
          description: "Short description of what is being purchased, shown to the user for approval.",
        },
        payment_method_label: {
          type: "string",
          description: "Display label of the card being charged, e.g. 'Visa'.",
        },
        payment_method_last4: {
          type: "string",
          description: "Last 4 digits of the card being charged, e.g. '4242'.",
        },
        button_text: {
          type: "string",
          description: "Exact text of the button that will be clicked, e.g. 'Pay $12.99' or 'Place order'. Must be a final-action payment button.",
        },
        button_selector_hint: {
          type: "string",
          description: "Optional CSS selector to locate the button. Provide if the button text is ambiguous.",
        },
        card_fill_authorization_id: {
          type: "string",
          description: "Optional. The pca_... card fill authorization ID from request_payment_card_fill, for audit trail linkage only. Do NOT pass this as the authorization ID to execute.",
        },
        reason: {
          type: "string",
          description: "One sentence explaining why this purchase is being submitted, shown in the audit trail.",
        },
        browser_session_id: {
          type: "string",
          description: "Preferred: browser_runtime_id from get_runtime_browser_endpoint. Stored on the authorization and used by execute_purchase_confirmation_handoff to target the correct runtime page. Missing this is the most common cause of button-click failures.",
        },
      },
    },
  },
  {
    name: "wait_for_purchase_confirmation_authorization",
    description:
      "Poll until the user approves or denies a pending purchase confirmation authorization.\n\n" +
      "Use after request_purchase_confirmation returns status='pending_approval'.\n" +
      "Tell the user: \"Please approve the purchase confirmation at /route-run-approvals under 'Purchase confirmations'.\"\n" +
      "Do NOT ask the user to confirm in chat.\n\n" +
      "Terminal statuses: approved, denied, expired, revoked, fulfilled.\n" +
      "On 'approved': call execute_purchase_confirmation_handoff immediately.\n" +
      "On 'denied' or 'expired': do not submit payment without a new user approval.",
    inputSchema: {
      type: "object",
      required: ["purchase_confirmation_id"],
      properties: {
        purchase_confirmation_id: {
          type: "string",
          description: "The purchase_confirmation_id returned by request_purchase_confirmation.",
        },
        timeout_ms: {
          type: "number",
          description: "Max polling duration in milliseconds. Default: 300000 (5 minutes).",
        },
        poll_interval_ms: {
          type: "number",
          description: "Polling interval in milliseconds. Default: 3000.",
        },
      },
    },
  },
  {
    name: "wait_for_profile_memory_request",
    description:
      "Poll until the user fills all missing profile values for a pending profile memory request.\n\n" +
      "Call this immediately after request_profile_field_fill returns status: 'pending_user'.\n" +
      "Do NOT ask the user for values in chat — the user acts in Antigen's approvals page.\n\n" +
      "Terminal statuses: completed, expired, cancelled.\n" +
      "On 'completed': retry request_profile_field_fill with the same parameters.\n" +
      "On 'expired' or 'cancelled': report that profile fill could not be completed.\n\n" +
      "RAW PROFILE VALUES ARE NEVER RETURNED — response contains status and next_action only.",
    inputSchema: {
      type: "object",
      required: ["profile_memory_request_id"],
      properties: {
        profile_memory_request_id: {
          type: "string",
          description: "The profile_memory_request_id returned by request_profile_field_fill.",
        },
        timeout_ms: {
          type: "number",
          description: "Max polling duration in milliseconds. Default: 300000 (5 minutes).",
        },
        poll_interval_ms: {
          type: "number",
          description: "Polling interval in milliseconds. Default: 3000.",
        },
      },
    },
  },
  {
    name: "execute_purchase_confirmation_handoff",
    description:
      "Click the approved payment button — Antigen locates it, validates it against the policy allowlist/blocklist, clicks it once, and records a receipt.\n\n" +
      "RUNTIME BINDING:\n" +
      "Aegis uses the browser_session_id stored on the PurchaseConfirmationAuthorization (set at request_purchase_confirmation time)\n" +
      "to connect to the correct runtime page. You do NOT need to re-pass browser_session_id here — it is already stored.\n" +
      "If the authorization was created without browser_session_id, Aegis falls back to AEGIS_PLAYWRIGHT_CDP_URL;\n" +
      "if that port is wrong, this call will fail with 'no page found for domain'. Fix by re-requesting confirmation with browser_session_id.\n\n" +
      "CRITICAL:\n" +
      "- Only call after wait_for_purchase_confirmation_authorization returns status='approved'.\n" +
      "- Do NOT pass a pca_... (PaymentCardFillAuthorization) ID — it will be rejected with 403 CARD_FILL_AUTH_NOT_SUFFICIENT.\n" +
      "- Antigen clicks exactly one button. No form fill, no retries, no 3DS solving, no multi-step flows.\n" +
      "- Raw card values, CVV, card refs, ciphertext, cookies, storage, CDP URL, and KMS material are never returned.\n" +
      "- Antigen disconnects from the browser after the click — it does not close the runtime.\n\n" +
      "Outcome values:\n" +
      "- 'submitted': payment was submitted (page navigated to confirmation).\n" +
      "- 'failed': payment was declined or an error occurred.\n" +
      "- 'manual_step_required': button was clicked but no clear signal — verify in browser.\n" +
      "- 'blocked_policy': button text is on the destructive/non-payment blocklist.\n" +
      "- 'blocked_merchant_mismatch': current page domain does not match the approved domain.",
    inputSchema: {
      type: "object",
      required: ["purchase_confirmation_id"],
      properties: {
        purchase_confirmation_id: {
          type: "string",
          description: "The purchase_confirmation_id returned by request_purchase_confirmation (pconf_... prefix). Do NOT pass a pca_... card fill authorization ID.",
        },
        browser_session_id: {
          type: "string",
          description: "Optional override. Normally not needed — Aegis uses the browser_session_id stored on the authorization at request_purchase_confirmation time. Only pass here if you need to override the stored session.",
        },
        external_cdp_url: {
          type: "string",
          description: "CDP base URL for an agent-owned browser. Only needed if neither the authorization nor start_task_browser_session provided a session. Mutually exclusive with browser_session_id.",
        },
      },
    },
  },
  // ─── Private Profile Memory v1 ─────────────────────────────────────────────
  {
    name: "request_profile_field_fill",
    description:
      "Request Aegis to fill checkout contact and shipping fields (name, email, phone, address) " +
      "in the active browser via CDP — without the agent ever receiving raw values.\n\n" +
      "DO NOT ask the user in chat for checkout name, email, phone, or address. " +
      "Call this tool first. Antigen will ask the user if values are missing.\n\n" +
      "USE FOR: first_name, last_name, email, phone, shipping_address_line1, shipping_address_line2, " +
      "city, region, postal_code, country.\n\n" +
      "WHAT THIS IS NOT:\n" +
      "- Card number, CVV, expiry → use request_payment_card_fill\n" +
      "- Login credentials → use request_secret_field_injection\n" +
      "- Final order button → use request_purchase_confirmation\n\n" +
      "FLOW (values already stored):\n" +
      "1. Call request_profile_field_fill with all checkout fields at once (up to 10 per call).\n" +
      "2. Call execute_profile_field_fill with the returned fill_request_id.\n" +
      "3. Verify the fields are filled in the browser, then proceed. " +
      "You own all navigation and form submission decisions.\n\n" +
      "FLOW (values missing — status: pending_user):\n" +
      "1. Call request_profile_field_fill — if Antigen lacks values, it returns:\n" +
      "   { status: 'pending_user', profile_memory_request_id, missing_fields, next_action }\n" +
      "2. Immediately call wait_for_profile_memory_request with the returned profile_memory_request_id.\n" +
      "3. Do NOT ask the user for field values in chat. Do NOT wait for the user to say 'go'.\n" +
      "4. When wait returns status 'completed', call request_profile_field_fill again with the same parameters.\n" +
      "5. If wait returns 'expired' or 'cancelled', report that profile fill could not be completed.\n\n" +
      "RAW VALUES ARE NEVER RETURNED. Response includes masked summaries only.",
    inputSchema: {
      type: "object",
      required: ["domain", "page_url", "requested_fields", "reason"],
      properties: {
        domain: {
          type: "string",
          description: "The checkout domain, e.g. 'ikea.com'. Must match the page_url hostname.",
        },
        page_url: {
          type: "string",
          description: "Full URL of the page containing the form fields.",
        },
        requested_fields: {
          type: "array",
          description: "List of profile fields to fill. Up to 10 per call.",
          items: {
            type: "object",
            required: ["key"],
            properties: {
              key: {
                type: "string",
                enum: [
                  "first_name", "last_name", "email", "phone",
                  "shipping_address_line1", "shipping_address_line2",
                  "city", "region", "postal_code", "country",
                ],
                description: "Which profile field to fill.",
              },
              selector_hint: {
                type: "string",
                description: "CSS selector targeting only the INPUT element. Must not target button, submit, form, or a[href].",
              },
              label: {
                type: "string",
                description: "Visible label text of the field.",
              },
              placeholder: {
                type: "string",
                description: "Placeholder text of the input.",
              },
              reason: {
                type: "string",
                description: "Optional per-field reason.",
              },
            },
          },
        },
        reason: {
          type: "string",
          description: "One sentence explaining why these fields are being filled. Shown in the audit trail.",
        },
        browser_session_id: {
          type: "string",
          description: "browser_runtime_id from get_runtime_browser_endpoint or start_task_browser_session.",
        },
      },
    },
  },
  {
    name: "execute_profile_field_fill",
    description:
      "Execute a profile field fill — Antigen resolves values from encrypted vault and fills fields via CDP.\n\n" +
      "Call after request_profile_field_fill returns a fill_request_id.\n" +
      "Antigen fills all requested fields in a single CDP session.\n" +
      "RAW VALUES ARE NEVER RETURNED. Response contains masked summaries only.\n" +
      "DOM field values are left intact so checkout pages can read and submit them normally.\n" +
      "This does NOT submit any form or authorize any purchase.",
    inputSchema: {
      type: "object",
      required: ["fill_request_id"],
      properties: {
        fill_request_id: {
          type: "string",
          description: "The fill_request_id returned by request_profile_field_fill (pffr_... prefix).",
        },
        browser_session_id: {
          type: "string",
          description: "Optional override. Normally not needed — uses the session stored on the fill request.",
        },
        external_cdp_url: {
          type: "string",
          description: "CDP base URL override for agent-owned browsers.",
        },
      },
    },
  },
  {
    name: "report_security_challenge",
    description:
      "Report a security challenge detected in the browser (email/SMS device verification, TOTP, etc.) to Aegis. " +
      "Call this when the page shows a verification code prompt — GitHub device verification, Google 2-step, etc. " +
      "IMPORTANT: Always pass browser_session_id from start_task_browser_session when a task browser session is active. " +
      "Aegis uses browser_session_id to inject the code into the correct browser — without it, injection targets the wrong port and fails.\n" +
      "IMPORTANT PRODUCT BOUNDARIES:\n" +
      "- Do NOT ask the user to paste the code into chat — that is a security anti-pattern.\n" +
      "- Tell the user: \"A verification code was sent. Please enter it in the Aegis UI at /route-run-approvals under 'Security challenges'.\"\n" +
      "- Aegis does not bypass 2FA, CAPTCHA, passkeys, or device checks. Passkey and CAPTCHA challenges require direct user action in the browser.\n" +
      "- The agent never receives the raw code. Aegis injects it via CDP once the user submits it.\n" +
      "After calling this tool, call wait_for_security_challenge with the returned challenge_id.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain where the challenge appeared, e.g. 'github.com'.",
        },
        page_url: {
          type: "string",
          description: "The full URL of the page showing the challenge, e.g. 'https://github.com/sessions/verified-device'.",
        },
        challenge_type: {
          type: "string",
          enum: ["email_device_verification", "sms_code", "totp", "passkey", "captcha", "device_verification", "unknown"],
          description: "The type of challenge detected. Use 'unknown' if unsure.",
        },
        masked_destination: {
          type: "string",
          description: "Optional. Masked destination shown on screen, e.g. 'n*******@gmail.com' or '+1 *** *** **42'.",
        },
        browser_session_id: {
          type: "string",
          description: "The task browser session ID from start_task_browser_session. Required when using a task browser session — Aegis uses this to inject into the correct browser port. Omit only for legacy flows without a managed session.",
        },
        element_hint: {
          type: "object",
          description: "Optional hints to identify the target code input field. Provide selector_hint, label, placeholder, or input_type.",
          properties: {
            label: { type: "string" },
            placeholder: { type: "string" },
            input_type: { type: "string" },
            selector_hint: { type: "string" },
          },
        },
        instructions: {
          type: "string",
          description: "Optional. Human-readable description of the challenge shown to the user in the Aegis UI.",
        },
      },
      required: ["domain", "page_url"],
    },
  },
  {
    name: "wait_for_security_challenge",
    description:
      "Wait for the user to submit a verification code (or complete the challenge directly in the browser). " +
      "Call this after report_security_challenge — it polls until a terminal status arrives.\n\n" +
      "Terminal statuses:\n" +
      "- 'code_submitted': User entered the code in Aegis UI. Call inject_security_challenge_code immediately.\n" +
      "- 'code_injected': Code was already injected. Continue by clicking Verify/Continue in your browser.\n" +
      "- 'user_completed': User completed the challenge directly in the browser. Continue your workflow.\n" +
      "- 'cancelled': User cancelled. Do not retry without user direction.\n" +
      "- 'expired': Challenge window expired (5 min). Navigate back to the challenge page and call report_security_challenge again.\n" +
      "- 'failed': Injection failed on a previous attempt. Check the error field.\n" +
      "DO NOT ask the user to type 'done' or paste the code into chat — direct them to the Aegis UI.",
    inputSchema: {
      type: "object",
      properties: {
        challenge_id: {
          type: "string",
          description: "The challenge_id returned by report_security_challenge.",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum milliseconds to wait before returning a timeout result. Default: 120000 (2 minutes).",
        },
        poll_interval_ms: {
          type: "number",
          description: "Milliseconds between poll attempts. Default: 2000.",
        },
      },
      required: ["challenge_id"],
    },
  },
  {
    name: "inject_security_challenge_code",
    description:
      "Execute the challenge code injection — Aegis takes the code the user submitted in the Aegis UI " +
      "and injects it into the browser field via CDP. The raw code is never returned to the agent.\n\n" +
      "Only call this after wait_for_security_challenge returns status='code_submitted'.\n" +
      "After successful injection (status='code_injected'), the agent must click 'Verify', 'Continue', or 'Submit' " +
      "in its own Playwright browser — Aegis does not click for you.\n" +
      "Requires AEGIS_PLAYWRIGHT_CDP_URL to be configured and the browser to still be open on the challenge page.",
    inputSchema: {
      type: "object",
      properties: {
        challenge_id: {
          type: "string",
          description: "The challenge_id from report_security_challenge.",
        },
      },
      required: ["challenge_id"],
    },
  },
  {
    name: "request_challenge_email_resolution",
    description:
      "Request Gmail-based automatic resolution for a live GitHub device verification challenge. " +
      "Call this after report_security_challenge when challenge_type='email_device_verification' and domain='github.com'. " +
      "Creates a resolution record (status: 'pending_approval') and waits for user approval in the Aegis UI.\n\n" +
      "PRODUCT BOUNDARIES:\n" +
      "- v1 supports github.com email_device_verification challenges only.\n" +
      "- The agent never receives the code or any email body/subject contents.\n" +
      "- User must approve the Gmail search in the Aegis UI — approval is not automatic.\n" +
      "- After approval, Aegis searches Gmail (sender allowlist: noreply@github.com only), extracts the code, and holds it in memory.\n" +
      "- Call wait_for_challenge_email_resolution after this to poll until code_found or not_found.\n" +
      "- If not_found, fall back to wait_for_security_challenge (manual code entry by the user).",
    inputSchema: {
      type: "object",
      properties: {
        challenge_id: {
          type: "string",
          description: "The challenge_id returned by report_security_challenge.",
        },
      },
      required: ["challenge_id"],
    },
  },
  {
    name: "wait_for_challenge_email_resolution",
    description:
      "Wait for Aegis to complete a Gmail-based email resolution. " +
      "Call this after request_challenge_email_resolution — it polls until a terminal status arrives.\n\n" +
      "Terminal statuses:\n" +
      "- 'code_found': Aegis found the code in Gmail. Call inject_challenge_email_code immediately.\n" +
      "- 'not_found': No matching code found. Fall back to manual code entry via the Aegis UI (wait_for_security_challenge).\n" +
      "- 'failed': Gmail search failed (token issue, API error). Tell the user to enter the code manually.\n" +
      "- 'cancelled': Resolution was cancelled. User may enter code manually.\n" +
      "- 'expired': Resolution expired. Request a new resolution if the challenge is still active.\n" +
      "- 'injected': Code was already injected. Click Verify/Continue in your browser.\n\n" +
      "PRODUCT BOUNDARIES: Never returns the code. 'code_found' means Aegis has it in memory only. " +
      "Do NOT ask the user to paste the code into chat.",
    inputSchema: {
      type: "object",
      properties: {
        resolution_id: {
          type: "string",
          description: "The resolution_id returned by request_challenge_email_resolution.",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum milliseconds to wait before returning timeout. Default: 120000 (2 minutes).",
        },
        poll_interval_ms: {
          type: "number",
          description: "Milliseconds between poll attempts. Default: 3000.",
        },
      },
      required: ["resolution_id"],
    },
  },
  {
    name: "inject_challenge_email_code",
    description:
      "Inject the Gmail-retrieved verification code into the browser field via CDP. " +
      "Only call this after wait_for_challenge_email_resolution returns status='code_found'.\n\n" +
      "After successful injection (status='injected'), the agent must click 'Verify', 'Continue', or 'Submit' " +
      "in its own Playwright browser — Aegis does not click for you.\n\n" +
      "PRODUCT BOUNDARIES:\n" +
      "- The raw code is never returned to the agent.\n" +
      "- The email body, subject, and sender email are never returned.\n" +
      "- Requires AEGIS_PLAYWRIGHT_CDP_URL to be configured and the browser to still be on the challenge page.\n" +
      "- The code is deleted from Aegis memory immediately after this call (success or failure).",
    inputSchema: {
      type: "object",
      properties: {
        resolution_id: {
          type: "string",
          description: "The resolution_id from request_challenge_email_resolution.",
        },
      },
      required: ["resolution_id"],
    },
  },
  {
    name: "wait_for_credential_authorization",
    description:
      "Wait for the user to approve or deny a pending credential-use authorization. " +
      "Use this immediately after request_secret_field_injection returns status='pending_approval'. " +
      "Tell the user to approve in the Aegis UI (/route-run-approvals under 'Login credential requests'), " +
      "then call this tool — it polls until a decision arrives and returns automatically. " +
      "DO NOT ask the user to type 'done' or 'approved'. The user acts in the Aegis UI; the agent waits here.\n\n" +
      "Terminal statuses returned: 'approved' (proceed with execute_secret_field_injection), " +
      "'denied' / 'expired' / 'revoked' (stop and report to user), 'fulfilled' (all fields already used — start fresh). " +
      "If the tool returns status='timeout', ask the user whether to continue waiting or cancel, then call again with the same authorization_id.",
    inputSchema: {
      type: "object",
      properties: {
        authorization_id: {
          type: "string",
          description:
            "The authorization_id from the request_secret_field_injection response (inside authorization_covers context) or from the Aegis approval UI. " +
            "Note: request_secret_field_injection does not return authorization_id directly — call get_secret_injection_status on the injection_request_id and read the authorization_id from the linked authorization, or use the authorization_id shown in the Aegis UI.",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum milliseconds to wait before returning a timeout result. Default: 120000 (2 minutes).",
        },
        poll_interval_ms: {
          type: "number",
          description: "Milliseconds between poll attempts. Default: 1000 (1 second).",
        },
      },
      required: ["authorization_id"],
    },
  },

  // ─── Workspace tools ────────────────────────────────────────────────────────

  {
    name: "get_workspace_manifest",
    description:
      "Returns the full orientation manifest for an Aegis workspace. " +
      "Always call this first before any other workspace tool. " +
      "The manifest contains: effective_permissions (what actions this agent's collar allows), " +
      "recommended_work_queue (tasks sorted by readiness and priority, with blocker reasons), " +
      "artifact metadata, workflow_rules, and next_actions. " +
      "Use recommended_work_queue to find the next task to claim — it surfaces eligible, ready tasks first. " +
      "Re-call this tool whenever you receive TASK_ALREADY_CLAIMED or TASK_NOT_READY from claim_workspace_task.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "The workspace ID provided by the workspace owner.",
        },
      },
      required: ["workspace_id"],
    },
  },
  {
    name: "claim_workspace_task",
    description:
      "Claims a workspace task, setting its status to in_progress. " +
      "Before calling, check recommended_work_queue from get_workspace_manifest to confirm the task is ready and eligible for this agent. " +
      "On success, the task is yours — proceed with the work and create any required artifacts before calling complete_workspace_task.\n\n" +
      "Error handling:\n" +
      "- TASK_ALREADY_CLAIMED (409): another agent claimed the task. The response includes recovery_hint='refresh_manifest'. " +
      "Call get_workspace_manifest to see updated state and pick a different task.\n" +
      "- TASK_NOT_READY (409): the task has unmet dependencies or missing required artifacts. " +
      "The response includes recovery_hint='refresh_manifest' and blocker_reasons listing what is missing. " +
      "Call get_workspace_manifest to check progress.\n" +
      "- TASK_NOT_ELIGIBLE / TASK_NOT_ASSIGNED (403): your collar does not match this task's required_collar_id or assignment. " +
      "Pick a different task from recommended_work_queue.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "The workspace ID.",
        },
        task_id: {
          type: "string",
          description: "The task_id to claim. Get this from recommended_work_queue in get_workspace_manifest.",
        },
      },
      required: ["workspace_id", "task_id"],
    },
  },
  {
    name: "complete_workspace_task",
    description:
      "Marks a workspace task as completed. " +
      "Only call this after the work is done and any required artifacts have been created with create_workspace_artifact. " +
      "Only the delegation that claimed the task can complete it. " +
      "Completing a task may unblock other tasks that depend on it — call get_workspace_manifest after completion to see the updated work queue.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "The workspace ID.",
        },
        task_id: {
          type: "string",
          description: "The task_id to mark completed. Must be a task you have claimed (status in_progress).",
        },
      },
      required: ["workspace_id", "task_id"],
    },
  },
  {
    name: "list_workspace_artifacts",
    description:
      "Lists all artifacts in the workspace. Returns metadata only — artifact_id, name, kind, size_bytes, task_id, created_by_delegation_id, created_at. " +
      "For kind='file' artifacts (uploaded by the workspace owner), mime_type is also returned. " +
      "Content is not included for any artifact kind; use read_workspace_artifact to fetch text artifact content. " +
      "Use this to check whether a required artifact already exists before claiming a task that depends on it.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "The workspace ID.",
        },
      },
      required: ["workspace_id"],
    },
  },
  {
    name: "read_workspace_artifact",
    description:
      "Returns the full content of a workspace artifact. " +
      "For kind='text', 'json', 'csv', or 'markdown', the content string is returned. " +
      "For kind='file' (uploaded binary files), only metadata is returned — content is not available inline. " +
      "Get artifact_id from list_workspace_artifacts or from the artifacts array in get_workspace_manifest. " +
      "Use this to read work produced by other agents before building on it.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "The workspace ID.",
        },
        artifact_id: {
          type: "string",
          description: "The artifact_id from list_workspace_artifacts or the manifest artifacts array.",
        },
      },
      required: ["workspace_id", "artifact_id"],
    },
  },
  {
    name: "create_workspace_artifact",
    description:
      "Creates a text artifact in the workspace. " +
      "Pass content as a plain string — no shell quoting, no base64, no escaping required. " +
      "Supported kinds: text, json, csv, markdown. Content limit: 50 KB. " +
      "Optionally link the artifact to the task that produced it via task_id. " +
      "Create artifacts before calling complete_workspace_task when the task specifies required_artifact_names — " +
      "completing a task without its required artifact will not unblock downstream tasks. " +
      "Content is not returned in the response; use read_workspace_artifact to verify.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "The workspace ID.",
        },
        name: {
          type: "string",
          description: "Artifact filename, e.g. 'aegis-pillars-summary.md'. Must match the name expected by dependent tasks.",
        },
        kind: {
          type: "string",
          enum: ["text", "json", "csv", "markdown"],
          description: "Content type. Use 'markdown' for .md files, 'json' for structured data, 'csv' for tabular data, 'text' for plain text.",
        },
        content: {
          type: "string",
          description: "The full artifact content as a string. Maximum 50 KB (UTF-8 encoded).",
        },
        task_id: {
          type: "string",
          description: "Optional. The task_id this artifact was produced for.",
        },
      },
      required: ["workspace_id", "name", "kind", "content"],
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
    case "get_agent_identity":
      result = await getAgentIdentity();
      break;
    case "list_available_skills":
      result = await listAvailableSkills(a);
      break;
    case "start_controlled_browser_session":
      result = await startControlledBrowserSession(a);
      break;
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
    case "start_credential_session":
      result = await startCredentialSession(a);
      break;
    case "fill_credential_field":
      result = await fillCredentialField(a);
      break;
    case "get_credential_session_status":
      result = await getCredentialSessionStatus(a);
      break;
    case "start_playwright_route_run":
      result = await startPlaywrightRouteRun(a);
      break;
    case "start_skill_run":
      result = await startSkillRun(a);
      break;
    case "complete_skill_run":
      result = await completeSkillRun(a);
      break;
    case "fail_skill_run":
      result = await failSkillRun(a);
      break;
    case "create_delegation_passport":
      result = await createDelegationPassport(a);
      break;
    case "verify_delegation_passport":
      result = await verifyDelegationPassport(a);
      break;
    case "plan_aegis_action":
      result = await planAegisAction(a);
      break;
    case "assess_sensitive_requirements":
      result = await assessSensitiveRequirements(a);
      break;
    case "get_delegation_trust_profile":
      result = await getDelegationTrustProfile(a);
      break;
    case "create_website_trust_assertion":
      result = await createWebsiteTrustAssertion(a);
      break;
    case "verify_website_trust_assertion":
      result = await verifyWebsiteTrustAssertion(a);
      break;
    case "get_runtime_observation":
      result = await getRuntimeObservation(a);
      break;
    case "get_runtime_observation_mode":
      result = await getRuntimeObservationMode(a);
      break;
    case "get_website_trust_profile":
      result = await getWebsiteTrustProfile(a);
      break;
    case "verify_website_trust_profile":
      result = await verifyWebsiteTrustProfile(a);
      break;
    case "list_website_violation_receipts":
      result = await listWebsiteViolationReceipts(a);
      break;
    case "verify_website_violation_receipt":
      result = await verifyWebsiteViolationReceipt(a);
      break;
    case "create_demo_website_violation_receipt":
      result = await createDemoWebsiteViolationReceipt(a);
      break;
    case "get_website_agent_safety_profile":
      result = await getWebsiteAgentSafetyProfile(a);
      break;
    case "get_website_aegis_policy":
      result = await getWebsiteAegisPolicy(a);
      break;
    case "validate_website_aegis_policy":
      result = await validateWebsiteAegisPolicy(a);
      break;
    case "check_website_policy_compatibility":
      result = await checkWebsitePolicyCompatibility(a);
      break;
    case "get_runtime_browser_endpoint":
      result = await getRuntimeBrowserEndpoint(a);
      break;
    case "start_task_browser_session":
      result = await startTaskBrowserSession(a);
      break;
    case "get_task_browser_session":
      result = await getTaskBrowserSession(a);
      break;
    case "close_task_browser_session":
      result = await closeTaskBrowserSession(a);
      break;
    case "navigate_task_browser_session":
      result = await navigateTaskBrowserSession(a);
      break;
    case "observe_task_browser_session":
      result = await observeTaskBrowserSession(a);
      break;
    case "click_element_in_task_browser_session":
      result = await clickElementInTaskBrowserSession(a);
      break;
    case "request_authenticated_session_login":
      result = await requestAuthenticatedSessionLogin(a);
      break;
    case "get_authenticated_session":
      result = await getAuthenticatedSession(a);
      break;
    case "observe_authenticated_session":
      result = await observeAuthenticatedSession(a);
      break;
    case "navigate_authenticated_session":
      result = await navigateAuthenticatedSession(a);
      break;
    case "request_secret_field_injection":
      result = await requestSecretFieldInjection(a);
      break;
    case "get_secret_injection_status":
      result = await getSecretInjectionStatus(a);
      break;
    case "execute_secret_field_injection":
      result = await executeSecretFieldInjection(a);
      break;
    case "execute_credential_step_handoff":
      result = await executeCredentialStepHandoff(a);
      break;
    case "wait_for_credential_authorization":
      result = await waitForCredentialAuthorization(a);
      break;
    case "request_payment_card_fill":
      result = await requestPaymentCardFill(a);
      break;
    case "wait_for_payment_card_fill_authorization":
      result = await waitForPaymentCardFillAuthorization(a);
      break;
    case "execute_payment_card_fill_handoff":
      result = await executePaymentCardFillHandoff(a);
      break;
    case "request_purchase_confirmation":
      result = await requestPurchaseConfirmation(a);
      break;
    case "wait_for_purchase_confirmation_authorization":
      result = await waitForPurchaseConfirmationAuthorization(a);
      break;
    case "execute_purchase_confirmation_handoff":
      result = await executePurchaseConfirmationHandoff(a);
      break;
    case "wait_for_profile_memory_request":
      result = await waitForProfileMemoryRequest(a);
      break;
    case "request_profile_field_fill":
      result = await requestProfileFieldFill(a);
      break;
    case "execute_profile_field_fill":
      result = await executeProfileFieldFill(a);
      break;
    case "report_security_challenge":
      result = await reportSecurityChallenge(a);
      break;
    case "wait_for_security_challenge":
      result = await waitForSecurityChallenge(a);
      break;
    case "inject_security_challenge_code":
      result = await injectSecurityChallengeCode(a);
      break;
    case "request_challenge_email_resolution":
      result = await requestChallengeEmailResolution(a);
      break;
    case "wait_for_challenge_email_resolution":
      result = await waitForChallengeEmailResolution(a);
      break;
    case "inject_challenge_email_code":
      result = await injectChallengeEmailCode(a);
      break;
    case "get_workspace_manifest":
      result = await getWorkspaceManifest(a);
      break;
    case "claim_workspace_task":
      result = await claimWorkspaceTask(a);
      break;
    case "complete_workspace_task":
      result = await completeWorkspaceTask(a);
      break;
    case "list_workspace_artifacts":
      result = await listWorkspaceArtifacts(a);
      break;
    case "read_workspace_artifact":
      result = await readWorkspaceArtifact(a);
      break;
    case "create_workspace_artifact":
      result = await createWorkspaceArtifact(a);
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

// ─── Website Violation Receipt handlers ──────────────────────────────────────

async function listWebsiteViolationReceipts({ domain, violation_type, severity, decision } = {}) {
  const params = new URLSearchParams();
  if (domain) params.set("domain", domain);
  if (violation_type) params.set("violation_type", violation_type);
  if (severity) params.set("severity", severity);
  if (decision) params.set("decision", decision);
  const qs = params.toString();
  let res;
  try {
    res = await request("GET", `/api/website-violation-receipts${qs ? "?" + qs : ""}`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to list violation receipts." };
  }
  return {
    count: res.data.count,
    receipts: res.data.data,
    interpretation: res.data.count === 0
      ? "No website violation receipts found matching the specified filters."
      : `${res.data.count} violation receipt(s) found. These are signed records of committed safety promise violations — not general event logs.`,
  };
}

async function verifyWebsiteViolationReceipt({ receipt_id } = {}) {
  if (!receipt_id) return { error: "VALIDATION_ERROR", message: "receipt_id is required." };
  let res;
  try {
    res = await request("GET", `/api/website-violation-receipts/${encodeURIComponent(receipt_id)}/verify`);
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to verify violation receipt." };
  }
  const v = res.data;
  return {
    receipt_id,
    valid: v.valid,
    hash_valid: v.hash_valid,
    signature_valid: v.signature_valid,
    recomputed_hash: v.recomputed_hash,
    stored_hash: v.stored_hash,
    jws_payload: v.jws_payload ?? null,
    error: v.error ?? null,
    interpretation: v.valid
      ? "Violation receipt is cryptographically intact. The evidence has not been tampered with since Aegis signed this receipt."
      : `Violation receipt is NOT valid: ${v.error ?? "unknown reason"}. Do not rely on this receipt as trusted evidence.`,
  };
}

async function createDemoWebsiteViolationReceipt({
  website_profile_id,
  domain,
  violation_type,
  violated_promise_id,
  redacted_evidence_summary,
  detection_source,
  decision,
  followup_required,
  observed_at,
  target_url_or_origin,
  session_id,
  route_run_id,
  workspace_id,
  task_id,
  delegation_id,
  agent_name,
  agent_platform,
  evidence_hash,
  detection_signals_count,
  blocked_action_type,
  reputation_delta,
} = {}) {
  if (!violation_type) return { error: "VALIDATION_ERROR", message: "violation_type is required." };
  if (!violated_promise_id) return { error: "VALIDATION_ERROR", message: "violated_promise_id is required." };
  if (!redacted_evidence_summary) return { error: "VALIDATION_ERROR", message: "redacted_evidence_summary is required." };
  if (!detection_source) return { error: "VALIDATION_ERROR", message: "detection_source is required." };
  if (!decision) return { error: "VALIDATION_ERROR", message: "decision is required." };
  if (!website_profile_id && !domain) return { error: "VALIDATION_ERROR", message: "Either website_profile_id or domain is required." };

  let res;
  try {
    res = await request("POST", "/api/website-violation-receipts", {
      website_profile_id, domain, violation_type, violated_promise_id,
      redacted_evidence_summary, detection_source, decision,
      followup_required: followup_required ?? false,
      ...(observed_at !== undefined ? { observed_at } : {}),
      ...(target_url_or_origin !== undefined ? { target_url_or_origin } : {}),
      ...(session_id !== undefined ? { session_id } : {}),
      ...(route_run_id !== undefined ? { route_run_id } : {}),
      ...(workspace_id !== undefined ? { workspace_id } : {}),
      ...(task_id !== undefined ? { task_id } : {}),
      ...(delegation_id !== undefined ? { delegation_id } : {}),
      ...(agent_name !== undefined ? { agent_name } : {}),
      ...(agent_platform !== undefined ? { agent_platform } : {}),
      ...(evidence_hash !== undefined ? { evidence_hash } : {}),
      ...(detection_signals_count !== undefined ? { detection_signals_count } : {}),
      ...(blocked_action_type !== undefined ? { blocked_action_type } : {}),
      ...(reputation_delta !== undefined ? { reputation_delta } : {}),
    });
  } catch (err) {
    return { error: "NETWORK_ERROR", message: err.message };
  }
  if (!res.ok) {
    return { error: res.error?.code ?? "UNKNOWN_ERROR", message: res.error?.message ?? "Failed to create violation receipt." };
  }
  const r = res.data;
  return {
    receipt_id: r.receipt_id,
    domain: r.domain,
    violation_type: r.violation_type,
    violated_promise_id: r.violated_promise_id,
    violated_promise_title: r.violated_promise_title,
    severity: r.severity,
    decision: r.decision,
    profile_hash: r.profile_hash,
    jws_present: r.verification?.jws_present,
    created_at: r.created_at,
    interpretation: `Demo violation receipt created for domain '${r.domain}'. violation_type='${r.violation_type}', severity='${r.severity}', decision='${r.decision}'. profile_hash='${r.profile_hash}' anchors the promise snapshot. This is a demo/manual creation path — production violation receipts should only be generated from trusted detection evidence.`,
  };
}

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[aegis-tool-server] Running. API: ${API_BASE} | Token: ${TOKEN}`);
