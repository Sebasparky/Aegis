/**
 * Simulates a third-party autonomous agent requesting an installed Aegis skill run.
 *
 * Usage:
 *   node apps/api/scripts/fake-agent-create-run.mjs
 *     → uses pass_demo_001 (agent_demo_001, skill_access_mode: "all" — succeeds)
 *
 *   AEGIS_AGENT_TOKEN=pass_demo_002 node apps/api/scripts/fake-agent-create-run.mjs
 *     → uses pass_demo_002 (agent_demo_restricted, skill_access_mode: "only", empty list — 403 SKILL_ACCESS_DENIED)
 *
 * Requires the Aegis API to be running on localhost:4000.
 * Requires the Wikipedia Search skill (skill_demo_wikipedia_001) to be installed.
 * Run `npm run seed:demo` first if the store is not set up.
 */

const API = "http://localhost:4000";
const SKILL_ID = "skill_demo_wikipedia_001";
const AEGIS_AGENT_TOKEN = process.env.AEGIS_AGENT_TOKEN ?? "pass_demo_001";

async function request(method, path, body, extraHeaders = {}) {
  const hasBody = body !== undefined;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

const authHeader = { "Authorization": `Bearer ${AEGIS_AGENT_TOKEN}` };

async function main() {
  console.log("=== Fake Agent — RouteRun Demo ===\n");
  console.log(`Using token: ${AEGIS_AGENT_TOKEN}\n`);

  // Step 1: Check what skills are available for wikipedia
  console.log("1. Querying installed skills for en.wikipedia.org...");
  const skillsRes = await request("GET", "/api/skills?domain=en.wikipedia.org&installed=true");
  if (!skillsRes.ok || skillsRes.data.length === 0) {
    console.error("No installed skills found for en.wikipedia.org.");
    console.error("Run `npm run seed:demo` and install the Wikipedia Search skill first.");
    process.exit(1);
  }
  const skill = skillsRes.data[0];
  console.log(`   Found: "${skill.name}" (${skill.skill_id})\n`);

  // Step 2: Create a run
  console.log(`2. Requesting RouteRun for skill "${skill.name}"...`);
  const createRes = await request(
    "POST",
    `/api/skills/${SKILL_ID}/runs`,
    { variables: { query: "Michigan" } },
    authHeader,
  );

  if (!createRes.ok) {
    console.error("Failed to create run:", createRes.error);
    process.exit(1);
  }
  const run = createRes.data.run ?? createRes.data;
  console.log(`   Created run: ${run.run_id}`);
  console.log(`   Status: ${run.status}`);
  console.log(`   Agent: ${run.agent_id ?? "none"}`);
  console.log(`   Delegation: ${run.delegation_id ?? "none"}`);
  console.log(`   Collar: ${run.collar_id ?? "none"}`);
  console.log(`   Domain: ${run.domain}`);
  console.log(`   Variables: ${JSON.stringify(run.variables)}\n`);

  if (run.status === "pending_approval") {
    console.log("   Run requires user approval before the extension can execute it.");
    console.log("   Approve it at http://localhost:3000/route-run-approvals, then re-run.\n");
    console.log("=== Done (awaiting approval) ===");
    return;
  }

  // Step 3: List pending runs for the domain
  console.log("3. Listing pending runs for en.wikipedia.org...");
  const listRes = await request("GET", "/api/route-runs?domain=en.wikipedia.org&status=pending");
  if (!listRes.ok) {
    console.error("Failed to list runs:", listRes.error);
    process.exit(1);
  }
  console.log(`   Found ${listRes.data.length} pending run(s):`);
  for (const r of listRes.data) {
    console.log(`   - ${r.run_id} | skill: ${r.skill_summary?.name ?? r.skill_id} | agent: ${r.agent_id ?? "none"}`);
  }
  console.log();

  // Step 4: Transition run to running (extension would normally do this)
  console.log(`4. Starting run ${run.run_id}...`);
  const startRes = await request("POST", `/api/route-runs/${run.run_id}/start`);
  if (!startRes.ok) {
    console.error("Failed to start run:", startRes.error);
    process.exit(1);
  }
  console.log(`   Status: ${startRes.data.status}\n`);

  // Step 5: Mark the run complete
  console.log(`5. Marking run ${run.run_id} as completed...`);
  const completeRes = await request("POST", `/api/route-runs/${run.run_id}/complete`);
  if (!completeRes.ok) {
    console.error("Failed to complete run:", completeRes.error);
    process.exit(1);
  }
  console.log(`   Status: ${completeRes.data.status}`);
  console.log(`   completed_at: ${completeRes.data.completed_at}\n`);

  // Step 6: Verify no pending runs remain
  console.log("6. Verifying no pending runs remain...");
  const finalRes = await request("GET", "/api/route-runs?domain=en.wikipedia.org&status=pending");
  console.log(`   Pending runs: ${finalRes.data?.length ?? "error"}\n`);

  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
