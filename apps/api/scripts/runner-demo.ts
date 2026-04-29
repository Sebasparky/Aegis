/**
 * Aegis Milestone 6 Demo — Simulated Runner
 *
 * Demonstrates the full approval → runner flow:
 *   create pass → create session → navigate to checkout
 *   → click "Place Order" → approval_required
 *   → approve approval → runner created + executed
 *   → print runner result + latest receipt
 *
 * Prerequisites:
 *   - API running on http://localhost:4000   (npm run dev -w apps/api)
 *   - Mock store running on http://localhost:3001  (npm run dev -w apps/mock-store)
 *
 * Run: npx tsx scripts/runner-demo.ts
 */

const API = "http://localhost:4000";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!json.ok) throw new Error(`${path} failed: ${JSON.stringify(json.error)}`);
  return json.data as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  const json = (await res.json()) as any;
  if (!json.ok) throw new Error(`GET ${path} failed: ${JSON.stringify(json.error)}`);
  return json.data as T;
}

async function main() {
  // 1. Get starter collar
  const collars = await get<{ id: string; name: string }[]>("/api/collars");
  if (!collars.length) throw new Error("No collars found. Is the API seeded?");
  const collarId = collars[0].id;
  console.log(`Using collar: ${collars[0].name} (${collarId})`);

  // 2. Create pass
  const pass = await post<{ token: string; id: string }>("/api/passes", {
    agent_name: "Runner Demo Agent",
    purpose: "Test runner flow — Milestone 6",
    default_collar_id: collarId,
    expires_in_minutes: 30,
  });
  console.log(`Created pass: ${pass.id}`);

  // 3. Create session
  const session = await post<{ session_id: string; status: string }>(
    "/api/agent/create-session",
    { agent_pass_token: pass.token, purpose: "Runner demo", mode: "headless" }
  );
  const sessionId = session.session_id;
  console.log(`Created session: ${sessionId} (${session.status})`);

  // 4. Navigate to checkout
  const nav = await post<{ current_url: string; decision: string }>(
    `/api/agent/session/${sessionId}/navigate`,
    { agent_pass_token: pass.token, url: "http://localhost:3001/checkout.html" }
  );
  console.log(`Navigated to: ${nav.current_url}  decision=${nav.decision}`);

  // 5. Click "Place Order" — expect approval_required
  console.log('\nClicking "Place Order"...');
  const clickResult = await post<{
    decision: string;
    executed: boolean;
    approval_request_id?: string;
    detected_action_type?: string;
    risk_level?: string;
    reason?: string;
  }>(`/api/agent/session/${sessionId}/click`, {
    agent_pass_token: pass.token,
    target: { type: "text", value: "Place Order" },
  });

  console.log(`\n--- Click result ---`);
  console.log(`decision:             ${clickResult.decision}`);
  console.log(`executed:             ${clickResult.executed}`);
  console.log(`detected_action_type: ${clickResult.detected_action_type ?? "n/a"}`);
  console.log(`risk_level:           ${clickResult.risk_level ?? "n/a"}`);
  if (clickResult.approval_request_id) {
    console.log(`approval_request_id:  ${clickResult.approval_request_id}`);
  }

  if (clickResult.decision !== "approval_required" || !clickResult.approval_request_id) {
    console.log("\nExpected approval_required but got a different decision. Stopping.");
    return;
  }

  const approvalId = clickResult.approval_request_id;

  // 6. Approve the request — Aegis creates and executes a runner
  console.log(`\nApproving approval ${approvalId}...`);
  const approveResult = await post<{
    id: string;
    status: string;
    receipt_id: string;
    runner_task_id: string;
  }>(`/api/approvals/${approvalId}/approve`, {
    note: "Approved once for demo purposes",
  });

  console.log(`\n--- Approval result ---`);
  console.log(`status:         ${approveResult.status}`);
  console.log(`receipt_id:     ${approveResult.receipt_id}`);
  console.log(`runner_task_id: ${approveResult.runner_task_id}`);

  // 7. Fetch runner task result
  const runnerTask = await get<{
    id: string;
    task_type: string;
    status: string;
    domain?: string;
    result?: string;
    constraints: Record<string, unknown>;
    created_at: string;
    completed_at?: string;
  }>(`/api/runners/${approveResult.runner_task_id}`);

  console.log(`\n--- Runner Task ---`);
  console.log(`id:           ${runnerTask.id}`);
  console.log(`task_type:    ${runnerTask.task_type}`);
  console.log(`status:       ${runnerTask.status}`);
  console.log(`domain:       ${runnerTask.domain ?? "n/a"}`);
  console.log(`constraints:  ${JSON.stringify(runnerTask.constraints)}`);
  console.log(`result:       ${runnerTask.result ?? "n/a"}`);
  console.log(`created_at:   ${runnerTask.created_at}`);
  console.log(`completed_at: ${runnerTask.completed_at ?? "n/a"}`);

  // 8. Print latest receipt
  const receipts = await get<{
    id: string;
    action_type: string;
    decision: string;
    domain?: string;
    reason?: string;
    outcome: string;
    sensitive_data_shared_with_agent: boolean;
    runner_task_id?: string;
    created_at: string;
  }[]>("/api/receipts");

  const latest = receipts.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (latest) {
    console.log(`\n--- Latest Receipt ---`);
    console.log(`id:                              ${latest.id}`);
    console.log(`action_type:                     ${latest.action_type}`);
    console.log(`decision:                        ${latest.decision}`);
    console.log(`domain:                          ${latest.domain ?? "n/a"}`);
    console.log(`outcome:                         ${latest.outcome}`);
    console.log(`sensitive_data_shared_with_agent: ${latest.sensitive_data_shared_with_agent}`);
    console.log(`runner_task_id:                  ${latest.runner_task_id ?? "n/a"}`);
    console.log(`reason:                          ${latest.reason ?? "n/a"}`);
  }

  console.log("\nDone. Outside agents plan. Aegis executes sensitive steps.");
}

main().catch((err) => {
  console.error("Demo failed:", err.message);
  process.exit(1);
});
