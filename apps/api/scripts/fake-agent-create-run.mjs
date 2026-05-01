/**
 * Simulates a third-party autonomous agent requesting an installed Aegis skill run.
 *
 * Usage:
 *   node apps/api/scripts/fake-agent-create-run.mjs
 *     → uses agent_demo_001 (skill_access_mode: "all" — succeeds)
 *
 *   AGENT_ID=agent_demo_restricted node apps/api/scripts/fake-agent-create-run.mjs
 *     → uses agent_demo_restricted (skill_access_mode: "only", empty list — 403 SKILL_ACCESS_DENIED)
 *
 * Requires the Aegis API to be running on localhost:4000.
 * Requires the Wikipedia Search skill (skill_demo_wikipedia_001) to be installed.
 * Run `npm run seed:demo` first if the store is not set up.
 */

const API = "http://localhost:4000";
const SKILL_ID = "skill_demo_wikipedia_001";
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo_001";

async function request(method, path, body) {
  const hasBody = body !== undefined;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: hasBody ? { "Content-Type": "application/json" } : {},
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function main() {
  console.log("=== Fake Agent — RouteRun Demo ===\n");

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
  console.log(`2. Requesting RouteRun for skill "${skill.name}" as agent "${AGENT_ID}"...`);
  const createRes = await request("POST", `/api/skills/${SKILL_ID}/runs`, {
    agent_id: AGENT_ID,
    variables: { query: "Michigan" },
  });

  if (!createRes.ok) {
    console.error("Failed to create run:", createRes.error);
    process.exit(1);
  }
  const run = createRes.data;
  console.log(`   Created run: ${run.run_id}`);
  console.log(`   Status: ${run.status}`);
  console.log(`   Domain: ${run.domain}`);
  console.log(`   Variables: ${JSON.stringify(run.variables)}\n`);

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

  // Step 4: Mark the run complete
  console.log(`4. Marking run ${run.run_id} as completed...`);
  const completeRes = await request("POST", `/api/route-runs/${run.run_id}/complete`);
  if (!completeRes.ok) {
    console.error("Failed to complete run:", completeRes.error);
    process.exit(1);
  }
  console.log(`   Status: ${completeRes.data.status}`);
  console.log(`   completed_at: ${completeRes.data.completed_at}\n`);

  // Step 5: Verify no pending runs remain
  console.log("5. Verifying no pending runs remain...");
  const finalRes = await request("GET", "/api/route-runs?domain=en.wikipedia.org&status=pending");
  console.log(`   Pending runs: ${finalRes.data?.length ?? "error"}\n`);

  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
