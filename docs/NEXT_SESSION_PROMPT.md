# NEXT_SESSION_PROMPT.md

Copy-paste prompts for future Claude/Codex sessions on the Aegis project.

---

## 1. Default Startup Prompt (v2 — current)

Use this at the start of any Aegis coding session.

```
Read CLAUDE.md first. Then read docs/CHECKPOINT.md before making any changes.

Then inspect only the files relevant to the requested task — do not read the entire codebase.

Aegis is the trust and workflow layer for delegated AI action. It has five pillars:
1. AegisID — verifiable identity
2. Delegation and Permissions (Collars) — scoped, revocable authority
3. Verified Workflow Routes (Aegis Rails) — declarative, enforceable execution paths
4. Runtime Guardrails (Aegis Guard) — detector + policy + approval layer
5. Accountability and Audit Trail — receipts and trust history

Rules for this session:
- Preserve the working /demo flow (http://localhost:3000/demo). If a change could break the two-button demo, test it first.
- Do not broad refactor. The demo loop is fragile to architectural changes.
- Do not introduce real secrets, real card numbers, real credentials, or real payment submission anywhere.
- Keep Runner deterministic — it executes one approved step and stops. It is not an autonomous agent.
- Keep Aegis separate from the outside agent — Aegis owns the browser runtime and enforces collars; outside agents call Aegis endpoints and never access the browser directly.
- Keep Aegis Guard components separate: sensitiveDetector.ts, PolicyService (evaluate.ts), and ApprovalService are distinct — do not merge them.
- Do not add Supabase, MCP, real auth, or real LLM API calls unless that milestone is explicitly requested.
- Routes are declarative objects — never allow arbitrary executable code in route steps.
- Screenshots are not the primary data source — prefer accessibility tree and DOM metadata.
```

---

## 2. Next Task: Aegis Rails — Semantic Recorder Prototype

Use this prompt to implement the first Aegis Rails milestone. The architecture has three layers:
browser extension (teaching), Playwright (verification), action API (execution). This session
implements the backend types, compiler, and a web-based demo recorder as a stand-in for the
extension. Read docs/RAILS_ARCHITECTURE.md before starting.

```
Read CLAUDE.md and docs/CHECKPOINT.md first.
Then read docs/AEGIS_RAILS.md and docs/RAILS_ARCHITECTURE.md before writing any code.

Task: Build the Aegis Rails semantic recorder prototype.

Architecture context (critical — do not skip):
- Layer 1 is the browser extension (teaching surface). We build a web-based demo recorder as a
  stand-in for now. The real extension comes later.
- Layer 2 is Playwright (verification surface). Not the recording surface.
- Layer 3 is the Aegis action API (execution surface). Agents never get unrestricted browser control.
- Route steps use RouteLocator objects (role/label/placeholder/testid/css/xpath/coordinates) —
  not raw CSS strings as the primary format.
- Every input step has a ValuePolicy. Sensitive fields must produce sensitive_redacted or
  runtime_variable — never store raw typed values.

Step 1 — Update route types
In packages/types/src/index.ts, add:
- RouteLocator interface (type, role, name, value, x, y)
- ElementTarget interface (preferred_locator, fallback_locators, confidence, frame_path,
  shadow_root_warning)
- ValuePolicy interface (type, name, value, store_value)
- Update RouteStep: replace value?: string with value_policy?: ValuePolicy; add intent: string;
  update target to use the new ElementTarget
- Add all other AegisRoute fields: route_id, version, domain, workflow_name, creator_aegis_id,
  trust_tier, required_permissions, allowed_actions, forbidden_actions, approval_gates, steps,
  confidence_threshold
See docs/AEGIS_RAILS.md for the full TypeScript schema.
Do not add routes to the existing collar, session, or pass stores — routes are their own entity.

Step 2 — Route store
Add a simple routes store to apps/api/src/store/index.ts alongside the existing stores.
Support: create, get by id, list (filterable by domain and trust_tier), update, delete.
Persist to the same JSON file used by other stores.

Step 3 — Semantic recording endpoint
Create POST /api/routes/record in apps/api/src/routes/routes.ts.
This endpoint accepts a semantic recording payload — an ordered list of browser events where
each event includes:
  { type: 'click'|'fill'|'navigate'|'select'|'submit', url: string, locators: RouteLocator[],
    raw_value?: string, element_type?: string, autocomplete?: string, label_text?: string }
The compiler must:
- Extract the ordered step list
- For each step, set preferred_locator = locators[0], fallback_locators = locators[1..]
- Infer action type from event type
- Classify value_policy for fill/select steps:
    - raw_value typed into type=password or autocomplete=cc-* → sensitive_redacted
    - raw_value typed into type=email → runtime_variable
    - field label contains 'password', 'card', 'CVV', 'SSN' → sensitive_redacted
    - otherwise → safe_literal (store verbatim) or runtime_variable (no value)
- Set trust_tier = 'unverified_draft'
- Do not store raw_value for sensitive_redacted or runtime_variable steps
Keep the compiler deterministic and rule-based. No AI classification in MVP.
Validate that no route step contains executable code (no script tags, no eval patterns).

Step 4 — Route CRUD endpoints
Create GET /api/routes, GET /api/routes/:id, DELETE /api/routes/:id.
GET /api/routes accepts optional query params: domain, trust_tier.

Step 5 — Route registry query endpoint
Create POST /api/routes/query.
Input: { domain, intent, required_permissions, min_trust_tier }.
Output: { route | null, matched: boolean, reason: string }.
For MVP, match by domain exact match and return the highest-trust route.
Add a comment: "Routes cannot override collar restrictions. Collar enforcement happens at the
action API layer, not here."

Step 6 — Action API skeleton (stub only)
Create POST /api/action/request in apps/api/src/routes/action.ts.
Input: { agent_id, session_id, route_id, requested_action: { type, step_id, target_locator } }.
For now, stub the response: validate that the session and route exist, then return
{ decision: 'allow', reason: 'stub — route and session validated', audit_event_id: null }.
This endpoint will be wired to real route+collar enforcement in a later session.
Do not implement real browser execution here.

Step 7 — Routes frontend page
Create apps/web/src/app/rails/page.tsx.
Show: list of saved routes with workflow_name, domain, trust_tier, step count, created_at.
Add a "New Recording" button that opens a modal with:
  - A description of what Aegis Rails are
  - A JSON paste area for submitting a demo recording payload to POST /api/routes/record
  - On success, show the compiled route ID and step count
Add a route detail view: steps list (action, intent, preferred_locator type, value_policy type),
required_permissions, allowed_actions, forbidden_actions, trust_tier.

Constraints:
- Do not modify any existing API routes.
- Do not touch apps/web/src/app/demo/page.tsx.
- Do not allow executable code in route steps — validate and reject at compile time.
- Do not store raw typed values for sensitive_redacted or runtime_variable steps.
- Do not use raw CSS strings or XPath as the primary locator in compiled steps.
- Do not use screenshots as the primary data format.
- Preserve the working /demo flow end-to-end.

Key files to read before starting:
- CLAUDE.md
- docs/CHECKPOINT.md
- docs/AEGIS_RAILS.md
- docs/RAILS_ARCHITECTURE.md
- packages/types/src/index.ts
- apps/api/src/store/index.ts
- apps/api/src/routes/ (read existing routes as a pattern reference)
```

---

## 3. Next Task: Agent Bridge UI

Copy-paste this prompt to implement the Agent Bridge UI milestone.

```
Read docs/CHECKPOINT.md first.

Task: Build the Agent Bridge UI.

Step 1 — API manifest endpoint
Create GET /api/agent/tools in apps/api/src/routes/agent.ts.
Return a JSON manifest listing all available agent endpoints with their method, path, required body fields, and a one-line description.
Do not implement MCP. Do not call a real LLM. Do not touch any existing POST endpoints.

Step 2 — Agent Bridge frontend page
Create apps/web/src/app/agent-bridge/page.tsx.
The page should show:
1. A brief explanation of what Aegis Agent Bridge is (agents call HTTP endpoints; Aegis enforces collars).
2. The list of available tools fetched from GET /api/agent/tools.
3. A copy-pasteable system prompt for a real outside agent (use the prompt from docs/AGENT_BRIDGE.md section 6 verbatim).
4. Example API call snippets for the most important endpoints (create-session, navigate, click, close).

Constraints:
- Do not implement MCP.
- Do not implement real LLM integration.
- Do not touch apps/web/src/app/demo/page.tsx or any existing API routes.
- Do not store or log any secrets.
- Preserve the working /demo flow end-to-end.

Key files to read before starting:
- docs/CHECKPOINT.md
- docs/AGENT_BRIDGE.md
- apps/api/src/routes/agent.ts
- apps/web/src/app/demo/page.tsx (read only — understand the pattern, do not modify)
```

---

## 4. Future Task: MCP Wrapper

Do not implement this now. Use this prompt when MCP is explicitly requested.

```
Read docs/CHECKPOINT.md first.

Task: Wrap Aegis browser actions as MCP tools.

Create an MCP server that exposes the 8 Aegis agent endpoints as MCP tools:
create-session, navigate, read-page, click, type, screenshot, request-capability, close.

Constraints:
- Preserve all existing security semantics: collars, approval_required, block.
- Do not bypass collar enforcement in any MCP tool handler.
- Do not expose vault values, card numbers, CVVs, passwords, or addresses in any MCP tool response.
- Stop and surface approval_required to the MCP client — do not auto-approve.
- Do not modify existing API routes.
- Do not touch the working /demo flow.
- Do not add real LLM calls or real payment submission.
```

---

## 5. Future Task: Persistence

Do not implement this now. Use this prompt when persistence is explicitly requested.

```
Read docs/CHECKPOINT.md first.

Task: Move the in-memory store to local persistence or Supabase.

The current in-memory store is in apps/api/src/store/index.ts.
It holds: collars, passes, sessions, approvals, receipts, runners.

Constraints:
- Preserve all existing flows — all existing API routes must behave identically.
- Do not change any product behavior or API response shapes.
- Do not store raw secrets, card numbers, CVVs, passwords, or addresses.
- Do not add auth before persistence is complete.
- Do not modify apps/web (frontend) unless a frontend data-fetch change is strictly required.
- Preserve the working /demo flow end-to-end.

If using Supabase: create migrations for each entity. Seed the default collar and demo user on first run.
If using SQLite: use a local file. Do not commit the database file to git.
```
