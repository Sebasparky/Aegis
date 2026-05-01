/**
 * Aegis External Agent — RouteRun Integration Harness
 *
 * Simulates a third-party agent using the Aegis delegation API.
 * Creates a RouteRun and waits for the Aegis browser extension (and user) to execute it.
 * Does NOT call /start or /complete directly — those are extension-only surfaces.
 *
 * Usage:
 *   node apps/api/scripts/fake-agent-create-run.mjs
 *
 * Environment variables:
 *   AEGIS_API_BASE      API base URL             (default: http://localhost:4000)
 *   AEGIS_AGENT_TOKEN   Bearer delegation token  (default: pass_demo_001)
 *   AEGIS_DOMAIN        Target domain            (default: en.wikipedia.org)
 *   AEGIS_SKILL_ID      Skill ID override        (default: first installed skill for domain)
 *   AEGIS_QUERY         Search query variable    (default: Michigan)
 *   AEGIS_POLL          Poll for completion      (default: true)
 *   AEGIS_TIMEOUT_MS    Poll timeout in ms       (default: 60000)
 *   AEGIS_AUTO_START    Simulate extension locally (default: false)
 *                       When true, calls /start + /complete directly as a backend smoke test.
 *                       Clearly labeled as simulated — not real browser execution.
 *
 * Demo tokens:
 *   pass_demo_001  → agent_demo_001, skill_access_mode: "all"    (succeeds)
 *   pass_demo_002  → agent_demo_restricted, skill_access_mode: "only", empty list (SKILL_ACCESS_DENIED)
 */

// ─── Config ────────────────────────────────────────────────────────────────

const API_BASE     = process.env.AEGIS_API_BASE    ?? "http://localhost:4000";
const TOKEN        = process.env.AEGIS_AGENT_TOKEN ?? "pass_demo_001";
const DOMAIN       = process.env.AEGIS_DOMAIN      ?? "en.wikipedia.org";
const SKILL_ID_ENV = process.env.AEGIS_SKILL_ID    ?? null;
const QUERY        = process.env.AEGIS_QUERY        ?? "Michigan";
const POLL         = (process.env.AEGIS_POLL        ?? "true") === "true";
const TIMEOUT_MS   = parseInt(process.env.AEGIS_TIMEOUT_MS ?? "60000", 10);
const AUTO_START   = (process.env.AEGIS_AUTO_START  ?? "false") === "true";

const APPROVAL_UI       = "http://localhost:3000/route-run-approvals";
const POLL_INTERVAL_MS  = 3000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked"]);
const authHeader        = { Authorization: `Bearer ${TOKEN}` };

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, body, extraHeaders = {}) {
  const url = `${API_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
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

// ─── Core functions ────────────────────────────────────────────────────────

async function discoverSkill() {
  const res = await request("GET", `/api/skills?domain=${DOMAIN}&installed=true`, undefined, authHeader);

  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
    console.error(`[ERROR] No installed skills found for domain "${DOMAIN}".`);
    console.error("        Run `npm run seed:demo` and install the skill via the browser UI, then retry.");
    process.exit(1);
  }

  if (SKILL_ID_ENV) {
    const match = res.data.find((s) => s.skill_id === SKILL_ID_ENV);
    if (!match) {
      console.error(`[ERROR] Skill "${SKILL_ID_ENV}" is not installed for domain "${DOMAIN}".`);
      console.error(`        Installed skills: ${res.data.map((s) => s.skill_id).join(", ")}`);
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
    { variables: { query: QUERY } },
    authHeader
  );

  if (!res.ok) {
    const { code, message, details } = res.error ?? {};
    console.error(`[ERROR] ${code}: ${message}`);
    if (details) console.error(`        ${details}`);
    process.exit(1);
  }

  const run = res.data.run ?? res.data;

  if (run.status === "blocked") {
    console.error(`[BLOCKED] Run was blocked at creation: ${run.error ?? "no reason given"}`);
    process.exit(1);
  }

  return { run, isApprovalRequired: res.data.approval_required === true };
}

function printRunSummary(run) {
  console.log(`    Run ID:     ${run.run_id}`);
  console.log(`    Status:     ${run.status}`);
  console.log(`    Domain:     ${run.domain}`);
  console.log(`    Delegation: ${run.delegation_id ?? "none"} | Collar: ${run.collar_id ?? "none"}`);
  if (run.approval_required_permissions?.length) {
    console.log(`    Approval required for: ${run.approval_required_permissions.join(", ")}`);
  }
}

async function pollUntilTerminal(run) {
  const startMs = Date.now();
  let lastStatus = run.status;

  while (true) {
    await sleep(POLL_INTERVAL_MS);

    const elapsed = Date.now() - startMs;
    if (elapsed >= TIMEOUT_MS) {
      console.error(`\n[TIMEOUT] No terminal status after ${TIMEOUT_MS / 1000}s.`);
      console.error(
        "          The extension did not pick up the run. Open the extension popup and press Start Run."
      );
      process.exit(1);
    }

    const elapsedLabel = `${Math.round(elapsed / 1000)}s`;
    let res;
    try {
      res = await request("GET", "/api/route-runs", undefined, authHeader);
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
    res = await request("GET", "/api/route-run-receipts", undefined, authHeader);
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

async function autoStartMode(run) {
  console.log();
  console.log("--- SIMULATED EXECUTION (not real browser) ---");
  console.log("    AUTO_START=true: script is calling /start and /complete directly.");
  console.log("    In production, the browser extension performs these steps.");
  console.log();

  const startRes = await request("POST", `/api/route-runs/${run.run_id}/start`, undefined, authHeader);
  if (!startRes.ok) {
    console.error(`[ERROR] /start failed: ${startRes.error?.code}: ${startRes.error?.message}`);
    process.exit(1);
  }
  console.log(`    /start     → status: ${startRes.data.status}`);

  const completeRes = await request(
    "POST",
    `/api/route-runs/${run.run_id}/complete`,
    undefined,
    authHeader
  );
  if (!completeRes.ok) {
    console.error(`[ERROR] /complete failed: ${completeRes.error?.code}: ${completeRes.error?.message}`);
    process.exit(1);
  }
  console.log(`    /complete  → status: ${completeRes.data.status}`);
  console.log("--- END SIMULATED EXECUTION ---");
  console.log();

  return completeRes.data;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Aegis External Agent — RouteRun Demo ===");
  console.log();

  // [1] Auth
  console.log(`[1] Authenticating via Aegis delegation token (${TOKEN})`);

  // [2] Discover skills
  console.log(`[2] Discovering installed skills for ${DOMAIN}...`);
  const skill = await discoverSkill();

  // [3] Select skill
  console.log(`[3] Selected skill: ${skill.name} (${skill.skill_id})`);
  console.log();

  // [4] Create run
  console.log(`[4] Requesting RouteRun with variables: { query: "${QUERY}" }`);
  const { run, isApprovalRequired } = await createRun(skill);

  // [5] Run summary
  console.log("[5] Run created:");
  printRunSummary(run);
  console.log();

  // [6] Status guidance
  if (isApprovalRequired) {
    console.log("[6] Approval required.");
    console.log(`    Approve at: ${APPROVAL_UI}`);
    console.log("    Waiting for approval then extension execution...");
  } else {
    console.log("[6] Waiting for Aegis-controlled execution...");
    console.log(`    Open ${DOMAIN} in Chrome, click the extension popup, press "Start Run".`);
  }
  console.log();

  // [7] Drive to terminal
  let finalRun;

  if (AUTO_START) {
    finalRun = await autoStartMode(run);
  } else if (POLL) {
    console.log(`[7] Polling (timeout: ${TIMEOUT_MS / 1000}s)...`);
    finalRun = await pollUntilTerminal(run);
    console.log();
  } else {
    console.log("[7] Polling disabled. Check the extension and re-run with AEGIS_POLL=true to wait for completion.");
    return;
  }

  // [8] Receipt
  console.log("[8] Receipt:");
  await fetchReceipt(finalRun);
  console.log();

  // Exit
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
