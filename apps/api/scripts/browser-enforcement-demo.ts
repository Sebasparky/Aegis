/**
 * Aegis Milestone 5 Demo — Browser Enforcement
 *
 * Demonstrates collar enforcement on a real browser click:
 *   create pass → create session → navigate → click "Place Order"
 *   → Aegis detects purchase → collar says approval_required
 *   → click is NOT executed → approval appears in inbox
 *
 * Prerequisites:
 *   - API running on http://localhost:4000   (npm run dev -w apps/api)
 *   - Mock store running on http://localhost:3001  (npm run dev -w apps/mock-store)
 *
 * Run: npx tsx scripts/browser-enforcement-demo.ts
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
    agent_name: "Enforcement Demo Agent",
    purpose: "Test click enforcement — Milestone 5",
    default_collar_id: collarId,
    expires_in_minutes: 30,
  });
  console.log(`Created pass: ${pass.id}`);

  // 3. Create session
  const session = await post<{ session_id: string; status: string }>(
    "/api/agent/create-session",
    { agent_pass_token: pass.token, purpose: "Enforcement demo", mode: "headless" }
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
    detected_action_type?: string;
    risk_level?: string;
    reason?: string;
    approval_request_id?: string;
    receipt_id?: string;
  }>(`/api/agent/session/${sessionId}/click`, {
    agent_pass_token: pass.token,
    target: { type: "text", value: "Place Order" },
  });

  console.log("\n--- Click result ---");
  console.log(`decision:              ${clickResult.decision}`);
  console.log(`executed:              ${clickResult.executed}`);
  console.log(`detected_action_type:  ${clickResult.detected_action_type ?? "n/a"}`);
  console.log(`risk_level:            ${clickResult.risk_level ?? "n/a"}`);
  console.log(`reason:                ${clickResult.reason ?? "n/a"}`);
  if (clickResult.approval_request_id) {
    console.log(`approval_request_id:   ${clickResult.approval_request_id}`);
  }
  if (clickResult.receipt_id) {
    console.log(`receipt_id:            ${clickResult.receipt_id}`);
  }

  // 6. Fetch latest pending approval
  console.log("\n--- Pending approvals ---");
  const allApprovals = await get<{ id: string; action_type: string; status: string; summary: string; risk_level: string }[]>(
    "/api/approvals"
  );
  const pending = allApprovals.filter((a) => a.status === "pending");
  if (pending.length === 0) {
    console.log("(none)");
  } else {
    const latest = pending[pending.length - 1];
    console.log(`id:          ${latest.id}`);
    console.log(`action_type: ${latest.action_type}`);
    console.log(`risk_level:  ${latest.risk_level}`);
    console.log(`status:      ${latest.status}`);
    console.log(`summary:     ${latest.summary}`);
  }

  console.log("\nDone. Session is now waiting_for_approval.");
  console.log("Visit http://localhost:3000/approvals to approve or deny.");
}

main().catch((err) => {
  console.error("Demo failed:", err.message);
  process.exit(1);
});
