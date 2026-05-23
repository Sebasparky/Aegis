# Skills and Rails Audit

Date: 2026-05-23  
Status: Audit complete. Next milestone identified. No code changes in this document.

---

## Product Role

Skills and Verified Workflow Routes (Rails) are one of the five core Aegis product pillars. They give agents reusable, trusted, auditable workflow patterns for sensitive web actions — without removing agent autonomy or replacing agent decision-making.

**What skills are:**
- Reusable workflows: structured, versioned, inspectable execution paths for specific web tasks
- Marketplace-discoverable: published, reviewed, and installable by users
- User-approved: installed by the user into their Skill Library; scoped to their collar permissions
- Optionally paired with Aegis-controlled execution for the most sensitive steps
- Auditable: every run produces a signed receipt

**What skills are not:**
- A full browser automation replacement for agent browsing
- A prompt or markdown file marketplace
- Arbitrary code executed inside user accounts
- A replacement for agent autonomy (agents plan and navigate; skills handle specific sensitive handoffs)

Skills integrate with the existing collar, pass, approval, and receipt infrastructure. They do not replace it.

---

## Current Capability Inventory

### Backend (apps/api)

| Component | File | Status |
|-----------|------|--------|
| Route recording & compilation | `routes/routes.ts` POST /record | Working prototype |
| Route verification (Playwright replay) | `routes/routes.ts` POST /:id/verify | Working prototype |
| 6-tier trust hierarchy | types, routes.ts, store | Working prototype |
| Marketplace review queue | `routes/routes.ts` POST /:id/review | Working prototype |
| Skill publication (auto on approval) | `routes/routes.ts` | Working prototype |
| Skill list & install/uninstall | `routes/skills.ts` | Working prototype |
| RouteRun create with collar enforcement | `routes/route-runs.ts` POST /runs | Working prototype |
| Approval-gated runs | `routes/route-runs.ts` | Working prototype |
| Signed RouteRunReceipts | `routes/route-runs.ts` buildReceipt() | Working prototype |
| ActionAuthorizationReceipt on approval | `routes/route-runs.ts` POST /:id/approve | Working prototype |
| Signed UserApprovalReceipt on reject | `routes/route-runs.ts` POST /:id/reject | Working prototype |
| Dual execution surfaces (chrome_extension, aegis_playwright) | `routes/route-runs.ts` | Working prototype |
| Auto-start Playwright runtime post-approval | `routes/route-runs.ts` POST /:id/approve | Working prototype |
| Spending limits + step-up flow | `routes/route-runs.ts` | Working prototype |
| Route-to-pass bindings | `routes/route-pass-bindings.ts` | Working prototype |
| Route variable schema | types, store | Partially wired |
| Route versioning (field present, no rollback UI) | store | Partially wired |
| `start` endpoint (pending → running) | `routes/route-runs.ts` POST /:id/start | **API only — no MCP wrapper** |
| `complete` endpoint (running → completed) | `routes/route-runs.ts` POST /:id/complete | **API only — no MCP wrapper** |
| `fail` endpoint (running → failed) | `routes/route-runs.ts` POST /:id/fail | **API only — no MCP wrapper** |
| Route analytics surface (run_count, success_rate) | store (fields present) | **Schema only — not surfaced** |
| Skill run history page | Not present | Gap |

### MCP Tool Server (examples/aegis-tool-server.mjs)

| Tool | Status |
|------|--------|
| `discover_installed_skills({ domain })` | Working prototype |
| `list_available_skills({ domain })` | Working prototype |
| `get_agent_runnable_workflow({ skill_id })` | Working prototype |
| `request_skill_run({ skill_id, variables, pass_overrides })` | Working prototype |
| `get_route_run_status({ run_id })` | Working prototype |
| `get_route_run_receipt({ run_id })` | Working prototype |
| `start_playwright_route_run({ run_id })` | Working prototype (aegis_controlled only) |
| `plan_aegis_action({ task, domain, credential_hint })` | Working prototype |
| `start_skill_run({ run_id })` | **Missing** |
| `complete_skill_run({ run_id, browser_session_id? })` | **Missing** |
| `fail_skill_run({ run_id, error, browser_session_id? })` | **Missing** |

### Web UI (apps/web)

| Page | Route | Status |
|------|-------|--------|
| Rails workspace | `/rails` | Working prototype |
| Marketplace browser | `/marketplace` | Working prototype |
| Skill Library | `/skill-library` | Working prototype |
| Marketplace review queue | `/marketplace-review` | Working prototype |
| Route run approvals (includes skills) | `/route-run-approvals` | Working prototype |

---

## Agent-Facing Tool Surface

An agent using the Aegis MCP tools can currently:

1. **Discover** what skills are installed for a domain (`discover_installed_skills`)
2. **Browse** marketplace skills without auth (`list_available_skills`)
3. **Get a workflow recipe** for `agent_runnable` skills (`get_agent_runnable_workflow`)
4. **Create a run** (request execution, create RouteRun record, trigger approval if needed) (`request_skill_run`)
5. **Poll run status** (`get_route_run_status`)
6. **Get the receipt** after the run reaches a terminal status (`get_route_run_receipt`)
7. **Start Playwright** after approval for `aegis_controlled` runs (`start_playwright_route_run`)
8. **Plan which Aegis tool to use** for a given task and domain (`plan_aegis_action`)

### The structural gap: agent_runnable runs

For `aegis_controlled` skills, the lifecycle closes automatically:
```
request_skill_run → pending_approval → user approves → Playwright auto-starts → complete → receipt ✓
```

For `agent_runnable` skills, the lifecycle is broken:
```
request_skill_run → pending        [run created]
get_agent_runnable_workflow         [recipe fetched]
[agent executes steps in browser]   [no MCP tool to register start]
                                    [no MCP tool to mark complete]
                                    [no MCP tool to mark failed]
run stays in 'pending' forever      [receipt never generated] ✗
```

The `POST /api/route-runs/:id/start`, `POST /api/route-runs/:id/complete`, and `POST /api/route-runs/:id/fail` endpoints exist in `route-runs.ts` but have no MCP wrappers. Without these, the agent has no way to close the receipt loop for `agent_runnable` flows.

---

## Functional vs Aspirational

### Fully functional (working end-to-end)
- Route recording from semantic browser events → compilation → trust tier assignment
- Route verification via Playwright replay
- Marketplace review queue and skill publication on approval
- Skill install/uninstall from marketplace
- `aegis_controlled` RouteRun lifecycle: create → approve → Playwright auto-start → complete → signed receipt
- All approval, spending limit, and step-up flows
- MCP tool surface for discovery and `aegis_controlled` execution
- All UI pages: /rails, /marketplace, /skill-library, /marketplace-review, /route-run-approvals

### Partially wired
- Route variables: schema defined, runtime binding in `get_agent_runnable_workflow` returns them, but agent-side substitution is manual
- `list_available_skills` MCP tool: works but has no auth scoping for delegation-gated skills
- Route versioning: `version` field present on `AegisRoute` but no version history or rollback logic

### Agent_runnable execution (broken end-to-end)
- Recipe retrieval works; run lifecycle completion does not
- See "Structural gap" section above

### API-only (no MCP tool)
- `POST /route-runs/:id/start` — endpoint exists, no MCP wrapper
- `POST /route-runs/:id/complete` — endpoint exists, no MCP wrapper
- `POST /route-runs/:id/fail` — endpoint exists, no MCP wrapper

### Schema-only (not surfaced)
- `run_count` and `success_rate` on `AegisRoute` — never incremented by run lifecycle
- `incident_count` on `AegisRoute` — never incremented

### Aspirational (not yet designed or planned)
- Route analytics dashboard
- Workflow composition (sub-routes, reusable sub-sequences)
- Conditional branching in route steps
- Route versioning with history and rollback
- Public marketplace business verification (beyond `aegis_reviewed` tier)
- Public skill publishing flow for external route creators

---

## Relationship to Local Runtime Browser and Sensitive Handoffs

Skills should NOT own arbitrary browsing. The division of responsibility is:

| Concern | Owner |
|---------|-------|
| Navigation, clicking, reading page content | Agent (own Playwright MCP / browser tools) |
| Username / password fill | Aegis (request_secret_field_injection) |
| Payment submit / purchase confirmation | Aegis Rail (aegis_controlled run, approved handoff) |
| High-sensitivity workflow execution | Aegis Rail (aegis_controlled, Playwright runtime) |
| Credential injection during agent_runnable skill | Aegis (request_secret_field_injection inside the skill steps) |
| Receipt generation | Aegis (after run completes or fails) |
| Session lifecycle | Aegis (start_task_browser_session / close_task_browser_session) |

For `agent_runnable` skills, the intended flow is:
1. Agent discovers skill via `discover_installed_skills`
2. Agent creates run via `request_skill_run` — collar enforcement checked
3. Agent starts a task browser session via `start_task_browser_session` (if not already active)
4. Agent calls `start_skill_run` (to be added) — run transitions `pending → running`
5. Agent follows the workflow recipe steps in its browser
6. For any login steps in the recipe: agent calls `request_secret_field_injection` for the protected field
7. Agent finishes the recipe and calls `complete_skill_run` (to be added) — run transitions `running → completed`, receipt generated
8. Agent can reference `browser_session_id` so the receipt links back to the session

The skill run is an audit record of the workflow context. It does not replace or reimplement injection, challenge relay, or browser session management.

---

## Gaps

### Critical gap: agent_runnable run lifecycle (blocks receipts)
The MCP surface is missing `start_skill_run`, `complete_skill_run`, and `fail_skill_run`. Without these, `agent_runnable` runs are orphaned — they never generate receipts. This is the only gap that breaks the end-to-end audit trail for the primary agent execution path.

### Operational gap: run analytics not incremented
`run_count`, `success_rate`, and `incident_count` on `AegisRoute` are never updated by the run lifecycle. These fields are in the schema but are stale from the seed value. Not critical for current use, but misleading if surfaced.

### UI gap: no skill run history page
There is no dedicated page for "which skills did agents run and what were the outcomes." Receipts exist on `/receipts` but are not filtered by skill context. Low priority.

### Schema gap: no task_browser_session_id linkage on RouteRun
`RouteRun` has no field to record which task browser session was active during an `agent_runnable` execution. Without it, receipts cannot link browser session events to skill runs. Addressed in the recommended next milestone.

---

## Recommended Next Milestone: Agent-Runnable Skill Run Lifecycle v1

### What and why

Add three MCP tools and a minor schema extension to close the receipt loop for `agent_runnable` skill runs. This is the narrowest possible change that fixes the only structural gap in the skills system.

`aegis_controlled` flows are fully functional. `agent_runnable` flows are the gap. This milestone makes both paths produce signed receipts.

### Scope

**New MCP tools (examples/aegis-tool-server.mjs):**

1. `start_skill_run({ run_id })`
   - Calls `POST /api/route-runs/:runId/start`
   - Transitions `pending → running`
   - Returns: `{ run_id, status: "running", domain, skill_name, started_at, next_step: "Follow the recipe steps. Call complete_skill_run or fail_skill_run when done." }`

2. `complete_skill_run({ run_id, browser_session_id?, summary? })`
   - Calls `POST /api/route-runs/:runId/complete` with optional `{ browser_session_id }`
   - Transitions `running → completed`
   - Generates signed RouteRunReceipt (existing buildReceipt() covers this)
   - Returns: `{ run_id, status: "completed", receipt_id }`

3. `fail_skill_run({ run_id, error, browser_session_id? })`
   - Calls `POST /api/route-runs/:runId/fail` with `{ error }` and optional `{ browser_session_id }`
   - Transitions `running → failed`
   - Returns: `{ run_id, status: "failed", error }`

**Schema extension (apps/api/src/store/index.ts and packages/types/src/index.ts):**

- Add `task_browser_session_id?: string` to `RouteRun` (optional; populated when agent provides it)
- Add `task_browser_session_id?: string` to `RouteRunReceipt` (echoed from run at receipt creation time)
- Does NOT expose `user_data_dir`, PIDs, CDP URL, cookies, or any session internals

**API endpoint updates (apps/api/src/routes/route-runs.ts):**

- `POST /api/route-runs/:runId/complete` — accept optional `{ browser_session_id: string }` in body; store on run
- `POST /api/route-runs/:runId/fail` — accept optional `{ browser_session_id: string }` in body; store on run

### Files to touch

- `examples/aegis-tool-server.mjs` — 3 new MCP tool definitions
- `apps/api/src/routes/route-runs.ts` — minor body param addition on complete + fail endpoints
- `apps/api/src/store/index.ts` — `task_browser_session_id?: string` on RouteRun and RouteRunReceipt
- `packages/types/src/index.ts` — same field on RouteRun and RouteRunReceipt

### Not touched

- Payment methods, payment card handoff
- Credential step handoff
- Local runtime browser endpoint
- Any existing MCP tool implementations
- Collar, pass, or approval service code
- Any UI pages

---

## Tests Needed

1. `request_skill_run` for an `agent_runnable` skill → run created in `pending`
2. `start_skill_run({ run_id })` → run transitions to `running`
3. `complete_skill_run({ run_id, browser_session_id: "tbsess_test_001" })` → run transitions to `completed`, receipt generated with `task_browser_session_id: "tbsess_test_001"`
4. `get_route_run_receipt({ run_id })` → returns signed receipt, `status: "completed"`, `task_browser_session_id` present
5. `fail_skill_run({ run_id, error: "step 3 failed: element not found" })` → run transitions to `failed`, receipt with `status: "failed"`
6. Existing `aegis_controlled` run lifecycle unchanged: approve → Playwright auto-start → complete → receipt
7. `start_skill_run` on `pending_approval` run → error (run must be `pending` first)
8. `complete_skill_run` on `pending` run (not started) → error (must be `running`)

---

## Anti-Goals

The following should NOT be done in the next milestone or in response to this audit:

- No marketplace payments or premium skill purchasing
- No public skill publishing flow for external creators
- No AI-generated skills or routes
- No workflow engine rewrite or conditional branching in routes
- No replacement of agent autonomy with fully scripted browsing
- No changes to payment methods, payment card handoff, credential step handoff, or local runtime browser
- No new approval inbox UI components
- No new Playwright runtime features
- No rewrite of `get_agent_runnable_workflow` or `request_skill_run` — they work
- No route analytics UI (run_count / success_rate surfacing) — separate milestone when needed
- No route versioning history or rollback UI
- No skill run history page — separate milestone when needed
