#!/usr/bin/env node
/**
 * external-agent-demo.mjs
 *
 * Demonstrates the Aegis External Agent Delegation API v1.
 * A third-party agent uses a delegated bearer token to discover skills,
 * check website safety, start a run, and retrieve receipts.
 *
 * Environment variables:
 *   AEGIS_API_BASE      - API base URL (default: http://localhost:4000)
 *   AEGIS_AGENT_TOKEN   - Bearer token from AgentDelegation.token_id (default: pass_demo_001)
 *   TASK_CATEGORY       - Task category for safety profile (default: travel_booking)
 *   SKILL_ID            - Skill to run (default: skill_demo_travel_booking_001)
 */

const API_BASE    = process.env.AEGIS_API_BASE    ?? "http://localhost:4000";
const TOKEN       = process.env.AEGIS_AGENT_TOKEN ?? "pass_demo_001";
const TASK_CAT    = process.env.TASK_CATEGORY     ?? "travel_booking";
const SKILL_ID    = process.env.SKILL_ID          ?? "skill_demo_travel_booking_001";

const authHeader  = { Authorization: `Bearer ${TOKEN}` };

async function request(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeader,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok && !json.ok) {
    const err = json.error ?? { code: "UNKNOWN", message: res.statusText };
    throw Object.assign(new Error(`${err.code}: ${err.message}`), { code: err.code, status: res.status });
  }
  return json;
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollRunStatus(runId, maxSeconds = 60) {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const { data: run } = await request("GET", `/api/agent/v1/runs/${runId}`);
    const terminal = ["completed", "failed", "blocked"];
    if (terminal.includes(run.status)) return run;
    if (run.status === "pending_approval") {
      process.stdout.write(".");
    } else {
      process.stdout.write("~");
    }
    await sleep(1000);
  }
  throw new Error(`Run ${runId} did not reach terminal status within ${maxSeconds}s.`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║        Aegis — External Agent Delegation API v1          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`API: ${API_BASE}  |  Skill: ${SKILL_ID}  |  Task: ${TASK_CAT}`);

  // ── 1. Identity ────────────────────────────────────────────────
  section("Step 1: Agent Identity  GET /api/agent/v1/me");
  const { data: identity } = await request("GET", "/api/agent/v1/me");
  console.log(`Agent name:      ${identity.agent_name}`);
  console.log(`Delegation ID:   ${identity.delegation_id}`);
  console.log(`User AegisID:    ${identity.user_aegis_id}`);
  console.log(`Status:          ${identity.delegation_status}`);
  console.log(`Skill access:    ${identity.token_scope.skill_access_mode}`);

  // ── 2. Skill Discovery ─────────────────────────────────────────
  section("Step 2: Skill Discovery  GET /api/agent/v1/skills");
  const { data: skillList } = await request("GET", "/api/agent/v1/skills");
  console.log(`Visible skills (${skillList.length}):`);
  for (const s of skillList) {
    const mode = s.execution_mode ? `[${s.execution_mode}]` : "";
    console.log(`  • ${s.name} (${s.skill_id}) ${mode}`);
    console.log(`    Domain: ${s.domain}  Risk: ${s.risk_level ?? "unknown"}  Trust: ${s.trust_tier ?? "unknown"}`);
  }

  const targetSkill = skillList.find((s) => s.skill_id === SKILL_ID);
  if (!targetSkill) {
    console.log(`\nSkill "${SKILL_ID}" is not in the visible skill list for this delegation.`);
    process.exit(1);
  }

  // ── 3. Website Safety Profile ──────────────────────────────────
  section(`Step 3: Website Safety  GET /api/agent/v1/websites/localhost/safety-profile?task_category=${TASK_CAT}`);
  const { data: profile } = await request("GET", `/api/agent/v1/websites/localhost/safety-profile?task_category=${TASK_CAT}`);
  console.log(`Recommendation:  ${profile.recommendation}`);
  console.log(`Safety status:   ${profile.agent_safety_status}`);
  console.log(`Confidence:      ${profile.confidence}`);
  if (profile.disqualifying_signals?.length) {
    console.log(`Disqualifying:   ${profile.disqualifying_signals.join(", ")}`);
  }
  if (profile.machine_readable_reasons?.length) {
    console.log(`Reasons:         ${profile.machine_readable_reasons.slice(0, 3).join("; ")}`);
  }

  // ── 4. Start Run ───────────────────────────────────────────────
  section("Step 4: Start Run  POST /api/agent/v1/runs");
  const { data: runResponse } = await request("POST", "/api/agent/v1/runs", { skill_id: SKILL_ID, variables: {} });
  const { run, approval_required, next_action, message } = runResponse;
  console.log(`Run ID:          ${run.run_id}`);
  console.log(`Status:          ${run.status}`);
  console.log(`Next action:     ${next_action}`);
  if (message) console.log(`Message:         ${message}`);

  // ── 5. Poll Status ─────────────────────────────────────────────
  section("Step 5: Poll Status  GET /api/agent/v1/runs/:runId");

  if (approval_required) {
    console.log("⟳ Waiting for user approval in the Aegis UI:");
    console.log("  → Open http://localhost:3000/route-run-approvals");
    console.log("  → Approve the pending run, then return here.");
    console.log("\nPolling every 1s (max 60s)...");
  } else {
    console.log("Polling for completion (max 60s)...");
  }

  console.log("");
  let finalRun;
  try {
    finalRun = await pollRunStatus(run.run_id, 60);
  } catch (err) {
    console.log(`\nTimeout: ${err.message}`);
    finalRun = run;
  }

  console.log(`\nFinal status: ${finalRun.status}`);
  if (finalRun.error) console.log(`Error:        ${finalRun.error}`);

  // ── 6. Receipts ────────────────────────────────────────────────
  section("Step 6: Receipts  GET /api/agent/v1/runs/:runId/receipts");
  const { data: receipts } = await request("GET", `/api/agent/v1/runs/${run.run_id}/receipts`);
  if (receipts.length === 0) {
    console.log("No receipts yet (run may still be pending).");
  }
  for (const r of receipts) {
    console.log(`Receipt: ${r.receipt_id}`);
    console.log(`  Status:   ${r.status}  Surface: ${r.execution_surface}`);
    if (r.credential_used) console.log(`  Credential used (secret not revealed to agent)`);
    if (r.authorization_context) {
      console.log(`  Authorization: ${r.authorization_context.authorization_id}`);
    }
    if (r.runtime_coverage_summary) {
      const c = r.runtime_coverage_summary;
      console.log(`  Coverage: ${c.covered_events}/${c.sensitive_events} sensitive events covered`);
    }
    if (r.capability_release_summary) {
      const cap = r.capability_release_summary;
      console.log(`  Capability releases: ${cap.releases_created} (secret revealed to agent: ${cap.raw_secret_revealed_to_agent})`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  section("Transcript Summary");
  console.log(`Agent:      ${identity.agent_name}  (${identity.delegation_id})`);
  console.log(`Skills:     ${skillList.length} visible`);
  console.log(`Safety:     ${profile.recommendation}  (${profile.confidence} confidence)`);
  console.log(`Run:        ${run.run_id}  → ${finalRun.status}`);
  console.log(`Receipts:   ${receipts.length}`);
  console.log(`\n✓ No secrets were returned to this agent script.`);
  console.log("─".repeat(60));
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
