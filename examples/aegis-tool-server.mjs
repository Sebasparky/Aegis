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
            "No Aegis-controlled skills found for this domain. For generic login tasks (no pre-recorded route needed), use start_credential_session for field-level credential delegation: the agent navigates freely; Aegis fills credentials without exposing them.",
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
    // No pre-recorded route, but task involves login + user named a credential → recommend field-level credential session
    if (taskIsLogin && (credential_hint || taskLower.includes("credential") || taskLower.includes("using my"))) {
      const isLocalDemo = resolvedDomain === "localhost" || resolvedDomain?.startsWith("localhost");
      return {
        recommended_path: "credential_session",
        explanation:
          "No pre-recorded Aegis skill was found for this login task. Use start_credential_session for field-level credential delegation: the agent navigates the login flow freely, and Aegis fills credentials when needed without exposing secrets.",
        next_tool: "start_credential_session",
        note: "Call list_vault_passes first to find the pass_id for the named credential, then call start_credential_session with { pass_id, domain, allowed_fields: [\"username\", \"password\"], target_url } where target_url is the exact login page URL. Providing target_url prevents Aegis from filling credentials on the wrong same-domain page.",
        suggested_domain: resolvedDomain ?? null,
        ...(isLocalDemo ? { suggested_target_url: "http://localhost:3000/demo-login" } : {}),
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
