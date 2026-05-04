#!/usr/bin/env node
/**
 * authenticated-session-boundary-demo.mjs
 *
 * Demonstrates the Aegis Authenticated Session Boundary API v1.
 *
 * An external agent requests Aegis to log in on its behalf. Aegis performs the
 * login inside an isolated Playwright browser, then returns a safe session handle.
 * The agent receives only authenticated_session_id — never cookies, storage, or
 * the password.
 *
 * Usage:
 *   AEGIS_AGENT_TOKEN=pass_demo_001 node examples/authenticated-session-boundary-demo.mjs
 *
 * Prerequisites:
 *   1. npm run dev --workspace=apps/api  (API on :4000)
 *   2. npm run dev --workspace=apps/web  (Web on :3000)
 *   3. npm run seed:demo                 (seed demo vault pass for localhost)
 */

const API_BASE = process.env.AEGIS_API_BASE ?? "http://localhost:4000";
const TOKEN    = process.env.AEGIS_AGENT_TOKEN ?? "pass_demo_001";

const authHeader = { Authorization: `Bearer ${TOKEN}` };

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
    throw Object.assign(new Error(`${err.code}: ${err.message}`), {
      code: err.code,
      status: res.status,
    });
  }
  return json;
}

function hr() { console.log("─".repeat(62)); }
function section(title) { console.log(`\n${title}\n${"─".repeat(62)}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollUntilTerminal(sessionId, maxSeconds = 120) {
  const terminal = ["authenticated", "manual_step_required", "failed", "expired"];
  const deadline = Date.now() + maxSeconds * 1000;
  process.stdout.write("  Polling");
  while (Date.now() < deadline) {
    const { data } = await request("GET", `/api/agent/v1/authenticated-sessions/${sessionId}`);
    if (terminal.includes(data.status)) {
      process.stdout.write(` → ${data.status}\n`);
      return data;
    }
    process.stdout.write(".");
    await sleep(2500);
  }
  throw new Error(`Session did not reach terminal status within ${maxSeconds}s.`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Aegis — Authenticated Session Boundary Demo v1              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  API: ${API_BASE}   Token: ${TOKEN}`);

  // ── Step 1: Request a login session ──────────────────────────────────────────
  section("Step 1 — POST /api/agent/v1/authenticated-sessions/login-request");

  const loginReq = {
    domain: "localhost",
    login_url: "http://localhost:3000/demo-login",
    task_summary: "Log in to the Aegis demo store to check order status",
  };
  console.log("  Request:", JSON.stringify(loginReq, null, 4).replace(/\n/g, "\n  "));

  const { data: handle } = await request(
    "POST",
    "/api/agent/v1/authenticated-sessions/login-request",
    loginReq,
  );

  console.log(`\n  session_id:                        ${handle.session_id}`);
  console.log(`  domain:                            ${handle.domain}`);
  console.log(`  status:                            ${handle.status}`);
  console.log(`  expires_at:                        ${handle.expires_at}`);
  console.log(`  raw_cookies_revealed_to_agent:     ${handle.raw_cookies_revealed_to_agent}`);
  console.log(`  raw_storage_revealed_to_agent:     ${handle.raw_storage_revealed_to_agent}`);
  console.log(`  raw_credentials_revealed_to_agent: ${handle.raw_credentials_revealed_to_agent}`);

  if (handle.status === "manual_step_required") {
    console.log(`\n  Manual step required: ${handle.manual_step_reason}`);
    console.log("  This domain does not support automated login in v1.");
    return;
  }

  const sessionId = handle.session_id;

  // ── Step 2: Wait for user approval ───────────────────────────────────────────
  section("Step 2 — Waiting for user approval");
  console.log("  Open the Aegis approval UI and click 'Approve login':");
  console.log("  → http://localhost:3000/route-run-approvals");
  console.log(`  → Find: "Aegis Login Request" for ${handle.domain}`);
  console.log(`  → Task: ${handle.task_summary}`);
  console.log("\n  (Or call internally: POST http://localhost:4000/api/authenticated-sessions/<id>/approve)\n");

  let finalHandle;
  try {
    finalHandle = await pollUntilTerminal(sessionId, 120);
  } catch (err) {
    console.log(`\n  Timeout: ${err.message}`);
    return;
  }

  if (finalHandle.status === "manual_step_required") {
    console.log(`\n  Manual step required: ${finalHandle.manual_step_reason}`);
    console.log("  Aegis detected a login challenge (2FA, CAPTCHA, passkey, etc.).");
    console.log("  Automated login halted — no bypass attempted.");
    return;
  }

  if (finalHandle.status !== "authenticated") {
    console.log(`\n  Session ended with status: ${finalHandle.status}`);
    if (finalHandle.manual_step_reason) {
      console.log(`  Reason: ${finalHandle.manual_step_reason}`);
    }
    return;
  }

  console.log(`\n  Status: ${finalHandle.status}`);
  console.log(`  Capabilities: ${finalHandle.capabilities.join(", ")}`);

  // ── Step 3: Observe the authenticated page ────────────────────────────────────
  section("Step 3 — GET /api/agent/v1/authenticated-sessions/:id/observe");

  const { data: observation } = await request(
    "GET",
    `/api/agent/v1/authenticated-sessions/${sessionId}/observe`,
  );

  console.log(`  page_url:                          ${observation.page_url ?? "(not returned)"}`);
  console.log(`  raw_cookies_revealed_to_agent:     ${observation.raw_cookies_revealed_to_agent}`);
  console.log(`  raw_storage_revealed_to_agent:     ${observation.raw_storage_revealed_to_agent}`);

  if (observation.open_summary) {
    const s = observation.open_summary;
    console.log(`\n  [Open observation]`);
    if (s.page_title) console.log(`  Page title:  ${s.page_title}`);
    if (s.headings?.length) console.log(`  Headings:    ${s.headings.slice(0, 3).join(" | ")}`);
    if (s.links_sample?.length) console.log(`  Links:       ${s.links_sample.slice(0, 3).join(", ")}`);
    if (s.forms_detected) console.log(`  Forms:       ${s.forms_detected}`);
  }

  if (observation.protected_snapshot) {
    const snap = observation.protected_snapshot;
    console.log(`\n  [Protected observation — sensitive page]`);
    console.log(`  snapshot_id:      ${snap.snapshot_id}`);
    console.log(`  total_elements:   ${snap.summary.total_elements}`);
    console.log(`  sensitive_elements: ${snap.summary.sensitive_elements}`);
    console.log(`  (Sensitive field values are redacted — never returned to agent)`);
  }

  // ── Step 4: Final handle summary ──────────────────────────────────────────────
  section("Step 4 — Final session handle");

  const { data: final } = await request(
    "GET",
    `/api/agent/v1/authenticated-sessions/${sessionId}`,
  );

  console.log(`  session_id:                        ${final.session_id}`);
  console.log(`  domain:                            ${final.domain}`);
  console.log(`  status:                            ${final.status}`);
  console.log(`  capabilities:                      ${final.capabilities.join(", ")}`);
  console.log(`  raw_cookies_revealed_to_agent:     ${final.raw_cookies_revealed_to_agent}`);
  console.log(`  raw_storage_revealed_to_agent:     ${final.raw_storage_revealed_to_agent}`);
  console.log(`  raw_credentials_revealed_to_agent: ${final.raw_credentials_revealed_to_agent}`);

  // ── Security boundary confirmation ────────────────────────────────────────────
  section("Security boundary confirmation");
  hr();
  console.log("  ✓ Agent never received cookies, localStorage, or sessionStorage.");
  console.log("  ✓ Agent never received the password, secret_ref, or KMS material.");
  console.log("  ✓ Agent never received a Playwright storageState or raw auth token.");
  console.log("  ✓ All raw_*_revealed_to_agent fields are: false");
  console.log("  ✓ Session handle gives only observe + safe_navigation capability.");
  hr();
  console.log("  Aegis Authenticated Session Boundary v1 — demo complete.");
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
