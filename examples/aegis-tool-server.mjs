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
          "0. If no Playwright browser is running or the CDP connection is unavailable: call start_task_browser_session. If the response includes reused_existing=true, the session is already active — no reconnect needed. If requires_browser_reconnect=true, use the returned cdp_url with your browser adapter before navigating.",
          "1. Navigate to the login page in your Playwright browser.",
          "2. Choose username/password path (not OAuth — Aegis cannot fill OAuth flows).",
          "3. Call list_vault_passes to find the pass_id for the domain (optional if only one credential exists).",
          "4. Call request_secret_field_injection({ domain, field_kind: 'username', page_url, reason }).",
          "5. If status='pending_approval': tell the user to approve in Aegis UI, then call wait_for_credential_authorization({ authorization_id }) — do NOT ask user to type 'done'.",
          "6. When wait_for_credential_authorization returns status='approved': call execute_secret_field_injection with the injection_request_id.",
          "7. Call request_secret_field_injection again for field_kind: 'password' (auto-attached to same authorization, no second approval needed if already approved).",
          "8. Call execute_secret_field_injection for the password injection.",
          "9. Click Submit / Sign In yourself in your Playwright browser.",
          "10. Continue using the browser for the rest of the task. Only call close_task_browser_session after the full task is complete — closing destroys cookies and session data.",
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

async function startTaskBrowserSession({ delegation_id } = {}) {
  const body = {};
  if (delegation_id) body.delegation_id = delegation_id;
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
    cdp_url: s.cdp_url,
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

// ─── Authenticated Session Boundary handlers ─────────────────────────────────

async function requestAuthenticatedSessionLogin({ domain, login_url, task_summary, pass_id }) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!login_url) return { error: "VALIDATION_ERROR", message: "login_url is required." };
  if (!task_summary) return { error: "VALIDATION_ERROR", message: "task_summary is required." };
  const body = { domain, login_url, task_summary };
  if (pass_id) body.pass_id = pass_id;
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
  return {
    session_id: handle.session_id,
    domain: handle.domain,
    login_url: handle.login_url,
    task_summary: handle.task_summary,
    status: handle.status,
    capabilities: handle.capabilities,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    raw_credentials_revealed_to_agent: false,
    created_at: handle.created_at,
    expires_at: handle.expires_at,
    next_action: `Session created with status="${handle.status}". Direct the user to ${APPROVAL_UI} to approve the login request under "Login session requests". After approval, Aegis performs the login in an isolated Playwright session. Poll get_authenticated_session until status is "authenticated" or "manual_step_required".`,
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

async function requestSecretFieldInjection({ domain, pass_id, field_kind, page_url, element_hint, reason } = {}) {
  if (!domain) return { error: "VALIDATION_ERROR", message: "domain is required." };
  if (!field_kind || !["username", "password"].includes(field_kind)) {
    return { error: "VALIDATION_ERROR", message: "field_kind must be 'username' or 'password'." };
  }
  if (!page_url) return { error: "VALIDATION_ERROR", message: "page_url is required." };
  if (!reason) return { error: "VALIDATION_ERROR", message: "reason is required." };

  const body = { domain, field_kind, page_url, reason };
  if (pass_id) body.pass_id = pass_id;
  if (element_hint && Object.keys(element_hint).length > 0) body.element_hint = element_hint;

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
  return {
    injection_request_id: data.injection_request_id,
    status: data.status,
    field_kind: data.field_kind,
    domain: data.domain,
    filled_at: data.filled_at ?? null,
    raw_value_revealed_to_agent: false,
    note: data.note ?? "Aegis injected the field value directly via CDP. The raw credential was never returned to the agent.",
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
    name: "create_delegation_passport",
    description:
      "Create a signed Aegis Delegation Passport for a given delegation. The passport is a cryptographically signed document that proves: which verified user the agent is acting for, which collar governs it, what actions are allowed/blocked/require approval, that Aegis holds user secrets and the agent does NOT receive raw credentials or payment data, that sensitive covered actions require Aegis authorization + controlled runtime + sensitive workflow detection + signed receipts, and receipt-backed evidence from past runs. The passport does NOT prove the agent has no out-of-band secrets — it claims only that Aegis-covered actions were constrained by user approval, KMS credential custody, and the Aegis Playwright controlled runtime. Present the passport_jws to counterparties as a verifiable Aegis delegation claim.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: {
          type: "string",
          description: "The delegation_id to issue a passport for (e.g. 'delg_demo_001').",
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
      "Analyze a task description and return a structured execution plan without executing anything. Matches installed skills and recommends: get_agent_runnable_workflow (routine agent-executable workflows), request_skill_run + start_playwright_route_run (Aegis-controlled sensitive workflows), or normal agent tools. For aegis_controlled skills, the response includes post_approval_next_tool='start_playwright_route_run' — after the run is created with request_skill_run and approved (if required), call start_playwright_route_run to execute via the Aegis Playwright runtime. Optionally resolves a vault credential by hint and includes a ready-to-use suggested_request. Call this first when you have a task description but haven't yet identified the skill or execution path.",
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
    name: "get_delegation_trust_profile",
    description:
      "Generate a task-specific Aegis trust profile for a delegation based on signed authorizations, signed execution receipts, sensitive workflow coverage, and custody evidence. Returns trust_status (unproven, capable_but_unproven, proven_limited, trusted_for_category, caution, risky, suspended), confidence level, capability summary, coverage stats, and category-specific execution history. This is not a guarantee and does not cover out-of-band secret use. Use this to assess whether a delegation has proven safe behavior for a specific task before proceeding.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: {
          type: "string",
          description: "The delegation ID to evaluate (e.g. 'delg_demo_001').",
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
          description: "The delegation ID to issue the assertion for (e.g. 'delg_demo_001').",
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
    name: "start_task_browser_session",
    description:
      "Create an ephemeral Chrome browser session for agent-controlled navigation.\n\n" +
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
    name: "request_authenticated_session_login",
    description:
      "SECONDARY/EXPERIMENTAL — Do not use for normal login when the agent has a Playwright browser. " +
      "Primary path for login fields is request_secret_field_injection: agent navigates its own browser, Aegis fills only the protected fields via CDP.\n\n" +
      "Use request_authenticated_session_login ONLY when: (1) the agent has no browser of its own, " +
      "(2) the user explicitly asks Aegis to perform an isolated login, or (3) the task description says to use an authenticated session handle.\n\n" +
      "What it does: Aegis performs the ENTIRE login workflow in an isolated headless Playwright session using a KMS-vaulted credential. " +
      "The agent receives only an authenticated_session_id handle — never the password, cookies, localStorage, sessionStorage, storageState, Set-Cookie headers, auth tokens, secret_ref values, pass_id, KMS envelopes, or ciphertext. " +
      "After calling, direct the user to /route-run-approvals. Poll get_authenticated_session until status is 'authenticated' or 'manual_step_required'. " +
      "If status becomes 'manual_step_required', stop immediately — Aegis does not bypass 2FA, CAPTCHA, passkey, or device verification.",
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
      "Requires AEGIS_PLAYWRIGHT_CDP_URL to be configured on the Aegis API server and the Playwright MCP " +
      "server to be started with --cdp-port matching that URL. " +
      "Only call this after: (1) the injection status is 'approved', AND (2) the agent has navigated to the page " +
      "containing the target field. After the field is filled, the agent must continue: click Next, Sign In, " +
      "or submit the form itself. Aegis does not submit forms.",
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
    name: "report_security_challenge",
    description:
      "Report a security challenge detected in the browser (email/SMS device verification, TOTP, etc.) to Aegis. " +
      "Call this when the page shows a verification code prompt — GitHub device verification, Google 2-step, etc. " +
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
          description: "Optional. The task browser session ID if one is active.",
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
    case "create_delegation_passport":
      result = await createDelegationPassport(a);
      break;
    case "verify_delegation_passport":
      result = await verifyDelegationPassport(a);
      break;
    case "plan_aegis_action":
      result = await planAegisAction(a);
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
    case "start_task_browser_session":
      result = await startTaskBrowserSession(a);
      break;
    case "get_task_browser_session":
      result = await getTaskBrowserSession(a);
      break;
    case "close_task_browser_session":
      result = await closeTaskBrowserSession(a);
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
    case "wait_for_credential_authorization":
      result = await waitForCredentialAuthorization(a);
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
