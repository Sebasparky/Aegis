/**
 * Aegis External Agent — HTTP-Only Client Example
 *
 * Demonstrates a third-party agent integrating with Aegis using only public
 * HTTP APIs. No internal Aegis modules, no raw browser control, no auto-start.
 * The Aegis extension (and optionally the approval UI) drives execution.
 *
 * Usage:
 *   node examples/external-agent-http-client.mjs
 *
 * Environment variables:
 *   AEGIS_API_BASE         API base URL             (default: http://localhost:4000)
 *   AEGIS_AGENT_TOKEN      Bearer delegation token  (default: pass_demo_001)
 *   AEGIS_DOMAIN           Target domain            (default: en.wikipedia.org)
 *   AEGIS_SKILL_ID         Skill ID override        (default: first installed skill for domain)
 *   AEGIS_QUERY            Search query variable    (default: Michigan)
 *   AEGIS_TIMEOUT_MS       Poll timeout in ms       (default: 60000)
 *   AEGIS_POLL_INTERVAL_MS Poll interval in ms      (default: 3000)
 *
 * Demo tokens:
 *   pass_demo_001  → agent_demo_001, skill_access_mode: "all"    (succeeds)
 *   pass_demo_002  → agent_demo_restricted, skill_access_mode: "only", empty list (no skills visible)
 */

// ─── Config ────────────────────────────────────────────────────────────────

const API_BASE       = process.env.AEGIS_API_BASE         ?? "http://localhost:4000";
const TOKEN          = process.env.AEGIS_AGENT_TOKEN      ?? "pass_demo_001";
const DOMAIN         = process.env.AEGIS_DOMAIN           ?? "en.wikipedia.org";
const SKILL_ID_ENV   = process.env.AEGIS_SKILL_ID         ?? null;
const QUERY          = process.env.AEGIS_QUERY            ?? "Michigan";
const TIMEOUT_MS     = parseInt(process.env.AEGIS_TIMEOUT_MS     ?? "60000", 10);
const POLL_INTERVAL  = parseInt(process.env.AEGIS_POLL_INTERVAL_MS ?? "3000", 10);

const APPROVAL_UI       = "http://localhost:3000/route-run-approvals";
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked"]);
const authHeader        = { Authorization: `Bearer ${TOKEN}` };

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, body) {
  const url = `${API_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeader,
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

// ─── Steps ────────────────────────────────────────────────────────────────

async function discoverSkill() {
  const res = await request("GET", `/api/skills?domain=${DOMAIN}&installed=true`);

  if (!res.ok || !Array.isArray(res.data)) {
    console.error(`[ERROR] Skill discovery failed: ${res.error?.code ?? "unknown"}: ${res.error?.message ?? ""}`);
    process.exit(1);
  }

  if (res.data.length === 0) {
    console.error(`[ERROR] No discoverable skills for token "${TOKEN}" on domain "${DOMAIN}".`);
    console.error("        The delegation's skill-access policy may deny all installed skills.");
    console.error("        Try a different token or install the skill, then retry.");
    process.exit(1);
  }

  if (SKILL_ID_ENV) {
    const match = res.data.find((s) => s.skill_id === SKILL_ID_ENV);
    if (!match) {
      console.error(`[ERROR] Skill "${SKILL_ID_ENV}" is not installed or visible for domain "${DOMAIN}".`);
      console.error(`        Visible skills: ${res.data.map((s) => s.skill_id).join(", ")}`);
      process.exit(1);
    }
    return match;
  }

  return res.data[0];
}

async function createRun(skill) {
  const res = await request(
    "POST",
    `/api/skills/${skill.skill_id}/runs`,
    { variables: { query: QUERY } }
  );

  if (!res.ok) {
    const { code, message, details } = res.error ?? {};
    console.error(`[ERROR] ${code}: ${message}`);
    if (details) console.error(`        ${details}`);
    process.exit(1);
  }

  const run = res.data.run ?? res.data;

  if (run.status === "blocked") {
    console.error(`[BLOCKED] Run blocked at creation: ${run.error ?? "no reason given"}`);
    process.exit(1);
  }

  return { run, isApprovalRequired: res.data.approval_required === true };
}

async function pollUntilTerminal(run) {
  const startMs = Date.now();
  let lastStatus = run.status;

  while (true) {
    await sleep(POLL_INTERVAL);

    const elapsed = Date.now() - startMs;
    if (elapsed >= TIMEOUT_MS) {
      console.error(`\n[TIMEOUT] No terminal status after ${TIMEOUT_MS / 1000}s.`);
      console.error("          Open the extension popup on the target domain and click Start Run.");
      process.exit(1);
    }

    const elapsedLabel = `${Math.round(elapsed / 1000)}s`;
    let res;
    try {
      res = await request("GET", "/api/route-runs");
    } catch (err) {
      console.warn(`    [${elapsedLabel}] Poll error: ${err.message} — retrying`);
      continue;
    }

    if (!res.ok) {
      console.warn(`    [${elapsedLabel}] Poll error: ${res.error?.message ?? "unknown"} — retrying`);
      continue;
    }

    const current = res.data.find((r) => r.run_id === run.run_id);
    if (!current) {
      console.warn(`    [${elapsedLabel}] Run not found in list — retrying`);
      continue;
    }

    if (current.status !== lastStatus) {
      const mark =
        current.status === "completed" ? " ✓"
        : current.status === "failed"  ? " ✗"
        : current.status === "blocked" ? " ✗ (blocked)"
        : "";
      console.log(`    [${elapsedLabel}] Status: ${current.status}${mark}`);
      lastStatus = current.status;
    }

    if (TERMINAL_STATUSES.has(current.status)) {
      return current;
    }
  }
}

async function fetchReceipt(run) {
  let res;
  try {
    res = await request("GET", "/api/route-run-receipts");
  } catch (err) {
    console.warn(`[WARN] Could not fetch receipts: ${err.message}`);
    return null;
  }

  if (!res.ok) {
    console.warn(`[WARN] Receipt fetch failed: ${res.error?.message ?? "unknown"}`);
    return null;
  }

  const receipt = res.data.find((r) => r.run_id === run.run_id);
  if (!receipt) {
    console.log("    No receipt found for this run.");
    return null;
  }

  console.log(`    Receipt ID:       ${receipt.receipt_id}`);
  console.log(`    allowed_reason:   ${receipt.allowed_reason}`);
  console.log(`    route_trust_tier: ${receipt.route_trust_tier}`);
  return receipt;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Aegis External Agent HTTP Client (HTTP-only, no internal imports) ===");
  console.log();

  console.log(`[1] Authenticating via delegation token (${TOKEN})`);

  console.log(`[2] Discovering installed skills for "${DOMAIN}"...`);
  const skill = await discoverSkill();

  console.log(`[3] Selected skill: ${skill.name} (${skill.skill_id})`);
  console.log();

  console.log(`[4] Requesting RouteRun  variables: { query: "${QUERY}" }`);
  const { run, isApprovalRequired } = await createRun(skill);

  console.log("[5] Run created:");
  console.log(`    Run ID:     ${run.run_id}`);
  console.log(`    Status:     ${run.status}`);
  console.log(`    Domain:     ${run.domain}`);
  console.log(`    Delegation: ${run.delegation_id ?? "none"} | Collar: ${run.collar_id ?? "none"}`);
  if (run.approval_required_permissions?.length) {
    console.log(`    Approval required for: ${run.approval_required_permissions.join(", ")}`);
  }
  console.log();

  if (isApprovalRequired) {
    console.log("[6] Approval required.");
    console.log(`    Approve at: ${APPROVAL_UI}`);
    console.log("    Polling continues — waiting for approval then extension execution...");
  } else {
    console.log("[6] Waiting for Aegis-controlled execution.");
    console.log(`    Open ${DOMAIN} in Chrome, click the extension popup, press "Start Run".`);
  }
  console.log();

  console.log(`[7] Polling for completion (timeout: ${TIMEOUT_MS / 1000}s, interval: ${POLL_INTERVAL / 1000}s)...`);
  const finalRun = await pollUntilTerminal(run);
  console.log();

  console.log("[8] Receipt:");
  await fetchReceipt(finalRun);
  console.log();

  if (finalRun.status === "completed") {
    console.log("=== Done: completed ===");
    process.exit(0);
  } else if (finalRun.status === "failed") {
    console.error(`=== Done: failed — ${finalRun.error ?? "no error detail"} ===`);
    process.exit(1);
  } else {
    console.error(`=== Done: blocked — ${finalRun.error ?? "no reason given"} ===`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err.message ?? err);
  process.exit(1);
});
