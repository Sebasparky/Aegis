# NEXT_SESSION_PROMPT.md

Dispatch document for future Claude/Codex sessions on the Aegis project.  
Read this before starting any new session. Update it when the baseline changes.

---

## ⚠️ DO NOT Rebuild Completed Increments

The items below are **fully implemented and committed**. Do not re-implement, re-plan, or recreate any of them.

> **Specifically: do NOT rerun or recreate the Agent Delegation Skill-Access Policy plan. It is complete. Do not treat "skill-access policy" or "delegation API" as a pending task.**
>
> **Also: do NOT re-implement Delegation Token Auth. Bearer token enforcement on `POST /api/skills/:skillId/runs` is complete. `agent_id` is resolved server-side from the token — do not accept it from the request body.**
>
> **Also: do NOT rebuild popup auto-run, background auto-run, replay fill reliability, or Wikipedia outcome verification. All are complete. Do not re-plan, re-implement, or recreate any part of the extension auto-run or replay reliability work.**
>
> **Also: do NOT rebuild the agent-runnable recipe path or the controlled sensitive login path. Both are complete. Do not re-plan or re-implement `get_agent_runnable_workflow`, `NOT_AGENT_RUNNABLE` refusal, or the Demo Login approval/auto-run flow.**

---

## Completed Increments (as of 2026-05-01)

Everything below is implemented and working.

### Core guard flow
- Collar + Pass creation, scoped permissions, revocation
- Protected browser sessions via Playwright/Chromium
- SensitiveActionDetector — classifies browser actions at the boundary
- PolicyService — collar enforcement (allow / block / approval_required)
- Approval inbox with approve/deny
- Aegis Runner — executes approved steps without exposing raw secrets
- Receipts and reputation events
- Working demo at `/demo`

### Aegis Rails
- Route types in `packages/types/src/index.ts`: `AegisRoute`, `RouteStep`, `RouteLocator`, `ElementTarget`, `ValuePolicy`
- Route store with JSON persistence in `apps/api/.data/aegis-store.json`
- Route compiler at `apps/api/src/services/routeCompiler.ts`
- API endpoints: `GET/POST /api/routes`, `GET/DELETE /api/routes/:id`, `POST /api/routes/record`, `POST /api/routes/query`, `PATCH /api/routes/:id`, `POST /api/routes/:id/verify`, `POST /api/routes/:id/submit-review`, `POST /api/routes/:id/review`
- Trust tier ladder: `unverified_draft` → `community` → `aegis_scanned` → `aegis_reviewed` → `run_verified` → `business_official`
- Playwright-based route verification at `apps/api/src/services/routeVerifier.ts`
- Parameterized variables with runtime binding (`variable_binding` on step, `variables[]` on route)
- Sensitive value redaction in the compiler (`sensitive_redacted`, `runtime_variable`, `safe_literal`, `enum_selection`)

### Recorded Skills workspace (`/rails`)
- SkillCard per route with capability badges (Local demo, Wikipedia, Visual replay, Parameterized, Sensitive values protected)
- Two-status row: Private use (always ready) / Marketplace (conditional)
- PreviewPanel with Route Health checklist, step list, locator quality indicators
- Local visual replay via Playwright (opens `localhost:3001`, steps execute live)
- External visual replay via Chrome extension `replay.js` (opens Wikipedia, steps execute live)
- Inline Verify button — runs Playwright, promotes tier to `aegis_scanned`, updates card in place
- Submit for Review button — enabled only after verification; sets `marketplace_status: pending_review`

### Marketplace review (`/marketplace-review`)
- Lists all routes with `marketplace_status: pending_review`
- ReviewCard: trust tier, domain, step count, risk, submitted time, key signals
- Approve / Reject with optional note; removes card on decision
- Approved routes show green "Approved" status on `/rails` cards

### Chrome extension (`apps/extension/`)
- Manifest V3, `activeTab` + `scripting` + `storage` permissions
- Popup UI: Start/Stop Recording, live event log with FILL/CLICK/NAVIGATE/SELECT/SUBMIT badges
- Content script captures semantic events using accessibility tree (role, label, placeholder)
- Sensitive field detection in content script — strips values before any IPC
- Background service worker buffers events, POSTs `RecordingPayload` to `localhost:4000/api/routes/record`
- Copy JSON button, Submit to Aegis button with result feedback
- Preview Route section: enter a route ID, Start Preview triggers `replay.js` Playwright replay

### Skill and Skill Library
- `Skill` and `InstalledSkill` models implemented
- Marketplace page (`/marketplace`) — shows only approved routes; users browse and install
- Skill Library page (`/skill-library`) — user's personally installed skills; distinct from `/rails`
- `POST /api/skills/:routeId/install` / `DELETE /api/skills/:routeId/install`
- `GET /api/skills?domain=...` — returns installed skills matching the current domain (used by agents at runtime)
- Extension runtime surfacing of installed skills by domain

### RouteRun API
- `POST /api/skills/:routeId/run` — agent-initiated execution of an installed skill
- Run receipts and audit trail per execution
- Extension pending-run pickup: extension polls for `status=pending` runs and executes them
- `agent_id` required on all route run requests

### Agent Delegation and Collar Enforcement
- Delegation skill-access policy: `all / exclude / only`
- `PATCH /api/delegations/:id/skill-access` — update an existing delegation's skill access policy
- Collar enforcement for RouteRuns:
  - Allowed permissions → run becomes `status: pending`
  - Blocked or unknown permissions → returns `COLLAR_BLOCKED`

### Approval-Gated RouteRuns
- Approval-required permissions → run created with `status: pending_approval`
- `POST /api/route-runs/:id/approve` → run transitions to `status: pending` (extension can now pick it up)
- `POST /api/route-runs/:id/reject` → run transitions to `status: blocked`
- Extension only polls for and executes `status: pending` runs (never sees `pending_approval` directly)

### Route Run Approvals UI (`/route-run-approvals`)
- `GET /api/route-runs?status=pending_approval` — fetch all runs awaiting user approval
- Displays: skill name, run ID, agent ID, domain, delegation ID, collar ID, created timestamp, approval-required permissions, variables
- Approve button → `POST /api/route-runs/:id/approve` → run moves to `pending`, picked up by extension
- Reject button → `POST /api/route-runs/:id/reject` → run becomes `blocked`
- Approved/rejected runs are removed from the list immediately on success

### Delegation Token Auth (Agent API Authentication v1)
- `POST /api/skills/:skillId/runs` requires `Authorization: Bearer <token>`
- Token is `AgentDelegation.token_id`; missing token → `AUTH_REQUIRED`; invalid token → `INVALID_TOKEN`
- `agent_id`, `delegation_id`, `collar_id` derived from token-resolved delegation (never trusted from request body)
- `pass_demo_001` resolves to `delg_demo_001 / agent_demo_001`
- `pass_demo_002` resolves to `delg_demo_restricted / agent_demo_restricted`
- `fake-agent-create-run.mjs` updated: reads `AEGIS_AGENT_TOKEN` env var, sends `Authorization` header
- Existing skill-access policy, collar enforcement, approval gates, lifecycle hardening, extension pickup, and receipts still work

### Agent Integration Contract
- `docs/AGENT_INTEGRATION_CONTRACT.md` — canonical agent-facing API reference
- Covers: authentication, skill discovery, run creation, all response variants (pending / pending_approval / blocked / error codes), polling, receipt lookup, status lifecycle diagram, curl examples for all three paths (happy / approval-required / denied), executable harness reference, and security notes

### Aegis MCP Tool Server (External Agent Integration via MCP)
- `examples/aegis-tool-server.mjs` — MCP server exposing Aegis agent APIs as MCP tools
- Tools: `discover_installed_skills`, `request_skill_run`, `get_route_run_status`, `get_route_run_receipt`
- Connect via: `claude mcp add aegis -- node /Users/sebastianchacon/Desktop/aegis/examples/aegis-tool-server.mjs`
- **First successful end-to-end test (2026-05-01):**
  - Claude Code discovered Wikipedia Search via `discover_installed_skills`
  - Requested RouteRun for query `Wisconsin` via `request_skill_run`
  - User clicked Start Run in the Aegis extension
  - Claude Code polled with `get_route_run_status` until `completed`
  - Read receipt `rrreceipt_20b593b94de7` via `get_route_run_receipt`
- Proves the full external-agent flow: third-party agent runtime → MCP tool discovery → Aegis HTTP contract → delegated token → policy enforcement → extension execution → receipt
- Do not rebuild this server unless explicitly requested

### Background Auto-Run (Reliable, Opt-In)
- Extension background service worker (`apps/extension/background.js`) watches the active tab for `status=pending` RouteRuns on the matching domain
- Auto-run is **opt-in**: controlled by the `aegisAutoRunAllowed` toggle in the extension popup; disabled by default
- Executes exactly one eligible low-risk (`risk_level === "low"`) pending run when conditions are met; does nothing if zero or multiple eligible runs exist
- Approval-required runs (`pending_approval`) are never auto-run — they remain invisible to the extension until user-approved
- Fill values are set atomically via native `HTMLInputElement.prototype` setter; fill value is verified against the expected value before the next step proceeds
- Wikipedia search submit uses `findBestSearchInput` to locate the form's actual search field and `form.requestSubmit()` to ensure the correct field value is submitted
- `background.js` independently verifies final tab URL/title after navigation (navigation-based routes destroy the content script before `replay_done` can be sent; a `setTimeout` watcher in background resolves this)
- `aegisRunCtx_<run_id>` in session storage acts as a mutex: the first handler to claim it (watcher or `replay_done`) wins; subsequent handlers skip to prevent double-complete
- Bad outcomes (wrong URL/title, empty search, fill mismatch) produce `failed` runs with descriptive errors instead of incorrect `completed` receipts
- **Validated 2026-05-01:**
  - `Wisconsin` → `run_2eecfe56dd5d` completed → `rrreceipt_d9a6ca5ae205`
  - `Alan Turing` → `run_2c68416c0364` completed → `rrreceipt_8f11681c5ab1`
- The user/agent must still navigate to or activate the matching domain tab in the current prototype
- Do not rebuild popup auto-run, background auto-run, replay fill reliability, or Wikipedia outcome verification unless explicitly requested

### Agent-Runnable Workflow Recipe Path
- `execution_mode: "agent_runnable"` skills expose a route recipe via `GET /api/routes/:routeId`
- MCP tool `get_agent_runnable_workflow(skill_id)` fetches the recipe and returns it to the agent
- Agent executes the recipe steps (fill, click, navigate) in its own browser session — no RouteRun, no extension handoff, no receipt
- `aegis_controlled` skills return `{ ok: false, error: { code: "NOT_AGENT_RUNNABLE" } }` when `get_agent_runnable_workflow` is called — agent must use `request_skill_run` instead
- Wikipedia Search demonstrated end-to-end: Claude Code discovered skill, fetched recipe, executed via Playwright, reached search results page
- **Validated 2026-05-01**
- Do not rebuild unless explicitly requested

### Controlled Sensitive Execution Path (Demo Login)
- Demo Login skill: `execution_mode: "aegis_controlled"`, `sensitivity_level: "sensitive"`, domain `localhost:3000`, `url_match: "/demo-login"`
- `get_agent_runnable_workflow` refuses with `NOT_AGENT_RUNNABLE` (correct — agent must not handle credentials directly)
- `request_skill_run` creates `status: pending_approval` (login permission is approval-required in the collar)
- User approves in `/route-run-approvals` UI → status transitions to `pending`
- Extension auto-runs the approved run only when the active tab matches domain AND `url_match` (`/demo-login`) — prevents execution on wrong localhost pages (e.g., `/route-run-approvals`)
- Run completed at `/demo-login/success`; receipt `rrreceipt_d5614360e907`, run `run_054ca6e8022b`
- Demo Login uses fake seeded credentials — real credential custody/pass vault is NOT implemented
- **Validated 2026-05-01**
- Do not rebuild unless explicitly requested

### Demo tooling
- `npm run seed:demo` — resets store to 4 clean routes, backs up old store
- `docs/DEMO_WALKTHROUGH.md` — 5–7 minute presenter script

---

## Start Here (session startup prompt)

Use this at the top of every new Aegis session:

```
Read CLAUDE.md first. Then read docs/NEXT_SESSION_PROMPT.md.

Aegis is the trust and workflow layer for delegated AI action. The five pillars are:
1. AegisID — verifiable identity
2. Delegation and Permissions (Collars) — scoped, revocable authority
3. Verified Workflow Routes (Aegis Rails) — declarative, enforceable execution paths
4. Runtime Guardrails (Aegis Guard) — detector + policy + approval layer
5. Accountability and Audit Trail — receipts and trust history

Session rules:
- Read docs/NEXT_SESSION_PROMPT.md before writing any code. The current baseline is described there.
- Preserve the working /demo flow. Test any change that touches the collar, pass, session, or approval path.
- Do not broad-refactor. The demo loop is fragile to architectural changes.
- Do not re-implement anything listed in the "Completed Increments" section of NEXT_SESSION_PROMPT.md.
- Do not introduce real secrets, credentials, card numbers, or payment submission.
- Routes are declarative objects — no executable code in route steps, ever.
- Agents remain autonomous above Aegis. Aegis tools are invoked only for trusted installed workflows, credentialed actions, approval gates, or audit receipts — not for general browsing, reading, or research.
- Screenshots are not the primary data source — prefer accessibility tree and DOM metadata.
- Keep Aegis Guard components separate: sensitiveDetector.ts, evaluate.ts, ApprovalService.
- Do not add Supabase, real auth, or real LLM calls unless explicitly requested.
```

---

## Current Next Task

Background Auto-Run (Reliable, Opt-In) is **complete** — validated 2026-05-01. Low-risk pending RouteRuns execute automatically when the matching domain tab is active, with atomic fill verification and browser outcome verification before marking completed.

External Agent Integration Hardening is also **complete** — validated via the Aegis MCP Tool Server on 2026-05-01.

Agent-runnable workflow recipe path is **complete** — validated 2026-05-01. `execution_mode="agent_runnable"` skills surface a tested route recipe via `get_agent_runnable_workflow`; agents execute it in their own browser session without a RouteRun or extension handoff.

Aegis-controlled sensitive execution path is **complete** — validated 2026-05-01. `execution_mode="aegis_controlled"` skills refuse recipe access with `NOT_AGENT_RUNNABLE`; agents use `request_skill_run`; approval-gated runs require user sign-off before the extension auto-runs only on the matching route context (`url_match` enforced). Demo Login receipt `rrreceipt_d5614360e907` confirms the full path.

**Candidate next milestones:**

1. **Run lifecycle state machine + idempotency** — stricter state transitions, guard against double-approve/reject, idempotency keys on run creation, clear error responses for invalid state changes
2. **Capability/collar policy test coverage** — unit and integration tests for collar enforcement, skill-access policy (all / exclude / only), and approval gating logic

Constraints for any of the above:
- Agents never receive a Playwright handle or browser context
- Collar restrictions always win
- Sensitive steps go through the existing Runner / approval flow
- Do not break the existing `/demo` flow

---

## Validation Checklist

Run this after any change to confirm nothing regressed.

```bash
npm run seed:demo   # resets to 4 clean routes
npm run dev         # starts web (3000), mock bank (3001), API (4000)
```

Then confirm:

- [ ] `/demo` — two-button demo works end-to-end (create pass → start session → click Place Order → approve → receipt)
- [ ] `/rails` — shows exactly 4 routes: Demo Banking Workflow, Wikipedia Search, Account Statement Draft, Wikipedia Topic Lookup
- [ ] `/rails` — Demo Banking Workflow shows: Verified badge, Private use: Ready, Marketplace: Ready for review, Submit button enabled
- [ ] `/rails` — Wikipedia Search shows: Approved marketplace status
- [ ] `/rails` — Account Statement Draft shows: Draft badge, Marketplace: Needs verification
- [ ] `/rails` — Wikipedia Topic Lookup shows: Pending review status
- [ ] `/rails` → Preview Demo Banking Workflow → Replay on Local Demo — mock bank opens, steps execute
- [ ] `/rails` → Preview Wikipedia Search → Replay on Wikipedia — Wikipedia opens, search executes
- [ ] `/rails` → Verify Account Statement Draft — tier promotes to Verified, Route Health fills in
- [ ] `/rails` → Submit Account Statement Draft for Review — status updates to Pending review
- [ ] `/marketplace-review` — Wikipedia Topic Lookup (and newly submitted route) appear in review queue
- [ ] `/marketplace-review` → Approve Wikipedia Topic Lookup → card disappears, `/rails` card updates
- [ ] Extension → navigate to `en.wikipedia.org` → Start Recording → perform search → Stop → Submit to Aegis → new route appears in `/rails`
- [ ] `/route-run-approvals` — loads without error; shows empty state when no pending_approval runs exist
- [ ] Extension → enable auto-run toggle → navigate to `en.wikipedia.org` → create one low-risk pending run with `query=Wisconsin` → run completes automatically without opening popup → receipt created
- [ ] Extension → auto-run with multiple eligible runs → neither executes (manual choice required)
- [ ] Extension → approval-required run → does not auto-run (stays `pending_approval` until user approves)

---

## Future Tasks (deferred)

### MCP Tool Server

**Completed.** See `examples/aegis-tool-server.mjs` and the "Aegis MCP Tool Server" entry in Completed Increments above. Do not rebuild unless explicitly requested.

### Persistence (Supabase or SQLite)

Do not implement until explicitly requested.

```
Task: Move the in-memory store to persistent storage.

The current store is in apps/api/src/store/index.ts.
Entities: collars, passes, sessions, approvals, receipts, runners, routes, agentTasks, agentDelegations.

Constraints:
- All existing API routes must behave identically after migration.
- Do not store raw secrets, card numbers, CVVs, or passwords.
- Do not add auth before persistence is complete.
- Do not modify apps/web unless a frontend data-fetch change is strictly required.
- Preserve the /demo flow end-to-end.
- Seed the default collar, demo user, and 4 demo routes on first run (equivalent to npm run seed:demo).
```
