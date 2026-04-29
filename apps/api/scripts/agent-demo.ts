/**
 * Aegis Milestone 4 Demo Script
 *
 * Demonstrates a protected browser session: create pass → create session →
 * navigate to mock checkout → read the page → close.
 *
 * Prerequisites:
 *   - API running on http://localhost:4000  (npm run dev -w apps/api)
 *   - Mock store running on http://localhost:3001  (npm run dev -w apps/mock-store)
 *
 * Run: npx tsx scripts/agent-demo.ts
 */

const API = "http://localhost:4000";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as any;
  if (!json.ok) throw new Error(`${path} failed: ${JSON.stringify(json.error)}`);
  return json.data as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  const json = await res.json() as any;
  if (!json.ok) throw new Error(`GET ${path} failed: ${JSON.stringify(json.error)}`);
  return json.data as T;
}

async function main() {
  // 1. Get the starter collar
  const collars = await get<{ id: string; name: string }[]>("/api/collars");
  if (!collars.length) throw new Error("No collars found. Is the API seeded?");
  const collarId = collars[0].id;
  console.log(`Using collar: ${collars[0].name} (${collarId})`);

  // 2. Create a pass
  const pass = await post<{ token: string; id: string }>("/api/passes", {
    agent_name: "Demo Agent",
    purpose: "Test protected session via Milestone 4 demo",
    default_collar_id: collarId,
    expires_in_minutes: 30,
  });
  console.log(`Created pass: ${pass.id}`);

  // 3. Create a protected session (launches Playwright/Chromium)
  const session = await post<{ session_id: string; status: string }>("/api/agent/create-session", {
    agent_pass_token: pass.token,
    purpose: "Navigate mock checkout",
    mode: "headless",
  });
  const sessionId = session.session_id;
  console.log(`Created session: ${sessionId} (${session.status})`);

  // 4. Navigate to the mock checkout page
  const nav = await post<{ current_url: string; decision: string }>(
    `/api/agent/session/${sessionId}/navigate`,
    { agent_pass_token: pass.token, url: "http://localhost:3001/checkout.html" }
  );
  console.log(`Navigated to: ${nav.current_url}  decision=${nav.decision}`);

  // 5. Read the page
  const page = await post<{ title: string; current_url: string; text_preview: string }>(
    `/api/agent/session/${sessionId}/read-page`,
    { agent_pass_token: pass.token }
  );
  console.log(`\n--- Page ---`);
  console.log(`Title:   ${page.title}`);
  console.log(`URL:     ${page.current_url}`);
  console.log(`Preview:\n${page.text_preview}\n`);

  // 6. Close the session
  const closed = await post<{ session_id: string; status: string }>(
    `/api/agent/session/${sessionId}/close`,
    { agent_pass_token: pass.token }
  );
  console.log(`Session closed: ${closed.status}`);
}

main().catch((err) => {
  console.error("Demo failed:", err.message);
  process.exit(1);
});
