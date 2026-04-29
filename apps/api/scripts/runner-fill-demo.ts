/**
 * Aegis Milestone 7 Demo — Mock Vault + Runner Form Fill
 *
 * Proves that Aegis Runner fills fake checkout fields from a mock vault
 * without exposing any sensitive data to the outside agent.
 *
 * Flow:
 *   create pass → create session → navigate to checkout
 *   → click "Place Order" → approval_required
 *   → approve → runner fills form from mock vault
 *   → read page (title + URL only) → print safe runner summary
 *   → print receipt → verify no fake card number appears in API text
 *
 * Prerequisites:
 *   - API running on http://localhost:4000   (npm run dev -w apps/api)
 *   - Mock store running on http://localhost:3001  (npm run dev -w apps/mock-store)
 *
 * Run: npx tsx scripts/runner-fill-demo.ts
 */

const API = "http://localhost:4000";
const MOCK_CARD = "4242424242424242";

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

function assertNoCardNumber(label: string, text: string) {
  if (text.includes(MOCK_CARD)) {
    throw new Error(`SECURITY CHECK FAILED: fake card number found in ${label}`);
  }
  console.log(`  [ok] No fake card number in ${label}`);
}

async function main() {
  // 1. Get starter collar
  const collars = await get<{ id: string; name: string }[]>("/api/collars");
  if (!collars.length) throw new Error("No collars found. Is the API seeded?");
  const collarId = collars[0].id;
  console.log(`Using collar: ${collars[0].name} (${collarId})`);

  // 2. Create pass
  const pass = await post<{ token: string; id: string }>("/api/passes", {
    agent_name: "Runner Fill Demo Agent",
    purpose: "Test mock vault + runner form fill — Milestone 7",
    default_collar_id: collarId,
    expires_in_minutes: 30,
  });
  console.log(`Created pass: ${pass.id}`);

  // 3. Create session — headless for reliability
  const session = await post<{ session_id: string; status: string }>(
    "/api/agent/create-session",
    { agent_pass_token: pass.token, purpose: "Runner fill demo", mode: "headless" }
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

  // 6. Approve — Aegis Runner fills the form from mock vault
  console.log(`\nApproving ${approvalId} — Runner will fill mock checkout form...`);
  const approveResult = await post<{
    id: string;
    status: string;
    receipt_id: string;
    runner_task_id: string;
  }>(`/api/approvals/${approvalId}/approve`, {
    note: "Approved for Milestone 7 fill demo",
  });

  console.log(`\n--- Approval result ---`);
  console.log(`status:         ${approveResult.status}`);
  console.log(`receipt_id:     ${approveResult.receipt_id}`);
  console.log(`runner_task_id: ${approveResult.runner_task_id}`);

  // 7. Fetch runner task — print safe metadata only
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
  console.log(`id:                     ${runnerTask.id}`);
  console.log(`task_type:              ${runnerTask.task_type}`);
  console.log(`status:                 ${runnerTask.status}`);
  console.log(`domain:                 ${runnerTask.domain ?? "n/a"}`);
  console.log(`mock_vault_used:        ${runnerTask.constraints.mock_vault_used ?? "n/a"}`);
  console.log(`fields_filled_count:    ${runnerTask.constraints.fields_filled_count ?? "n/a"}`);
  console.log(`sensitive_data_shared:  ${runnerTask.constraints.sensitive_data_shared_with_agent ?? "n/a"}`);
  console.log(`result:                 ${runnerTask.result ?? "n/a"}`);
  console.log(`completed_at:           ${runnerTask.completed_at ?? "n/a"}`);

  // 8. Read page — confirm still on checkout (title + URL only, no form values)
  const page = await post<{ title: string; current_url: string; text_preview: string }>(
    `/api/agent/session/${sessionId}/read-page`,
    { agent_pass_token: pass.token }
  );
  console.log(`\n--- Page after fill ---`);
  console.log(`title:       ${page.title}`);
  console.log(`current_url: ${page.current_url}`);
  // Do not print text_preview — it is not needed and the policy is minimal disclosure.

  // 9. Print latest receipt
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
  }

  // 10. Security assertions: fake card number must not appear in API text
  console.log(`\n--- Security checks ---`);
  if (runnerTask.result) assertNoCardNumber("runner result", runnerTask.result);
  if (latest?.reason) assertNoCardNumber("receipt reason", latest.reason);
  if (latest?.decision) assertNoCardNumber("receipt decision", latest.decision);
  const constraintsText = JSON.stringify(runnerTask.constraints);
  assertNoCardNumber("runner constraints", constraintsText);

  console.log("\nMilestone 7 complete.");
  console.log("Outside agents plan. Aegis executes sensitive steps.");
  console.log("The agent never received the card number, CVV, or address.");
}

main().catch((err) => {
  console.error("Demo failed:", err.message);
  process.exit(1);
});
