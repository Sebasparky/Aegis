# NEXT_SESSION_PROMPT.md

Dispatch document for future Claude/Codex sessions on the Aegis project.  
Read this before starting any new session. Update it when the baseline changes.

---

## Current Baseline (as of 2026-04-30)

Everything below is implemented and working. Do not re-implement any of it.

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
- Do not re-implement anything listed in the "Current Baseline" section of NEXT_SESSION_PROMPT.md.
- Do not introduce real secrets, credentials, card numbers, or payment submission.
- Routes are declarative objects — no executable code in route steps, ever.
- Screenshots are not the primary data source — prefer accessibility tree and DOM metadata.
- Keep Aegis Guard components separate: sensitiveDetector.ts, evaluate.ts, ApprovalService.
- Do not add Supabase, real auth, or real LLM calls unless explicitly requested.
```

---

## Recommended Next Build Steps

Work through these in order. Do not skip ahead.

### 1. Polish demo UX
Fix any visible rough edges on `/rails` before adding new features. Common candidates:
- Card layout consistency when marketplace status label is long
- Preview panel scroll on small viewports
- Loading / error states on verify and submit actions
- Extension popup: confirm the event-count display is accurate on fast pages

### 2. Public Marketplace page (`/marketplace`)
Show only routes with `marketplace_status: approved`. This is the agent-facing discovery surface.
- Card design distinct from `/rails` (creator-facing) — this is the consumer view
- Show: workflow name, domain, trust tier badge, step count, risk level, verification date, short description
- "Copy Route ID" action so agents can reference it
- Filter by domain
- No editing or management controls — read-only

### 3. Install / Use Skill flow
Let a user install a marketplace-approved route so their agents can use it.
- "Install Skill" button on each marketplace card
- Installed routes appear in `/rails` with `source: marketplace` label and read-only badge
- Agent can query installed routes via `POST /api/routes/query` as usual
- Do not allow the user to edit an installed route — only fork (copy + save as private draft)

### 4. Trust evidence summary
Add a human-readable trust evidence block to the marketplace card and preview panel.
- Verified by: Aegis automated scan / Human review / Run history
- Locator quality summary (how many steps use semantic vs fragile locators)
- Last verified date and version
- Creator AegisID (linked to `/counterparty-agent` lookup if available)

### 5. Second external domain (GitHub public search)
Only after `/marketplace` and Install flow are solid.
- Target: `https://github.com/search` — no auth, no PII, stable ARIA, no payment path
- Record via extension, verify via Playwright, add to seed script as a second approved marketplace route
- Do not move to any third domain until the locator quality and verification pipeline are proven reliable at scale

### 6. Do not approach yet
These require a stronger safety model, business verification, and legal review before any prototype work:

| Category | Examples |
|---|---|
| Auth-gated sites | Gmail, LinkedIn, GitHub (logged in), any bank |
| Financial flows | Checkout, payment, subscription, transfer |
| Communication | Email sending, Slack, messaging apps |
| Medical / legal | Any portal with regulated PII |
| Identity | SSO, OAuth flows, government portals |

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

---

## Future Tasks (deferred)

### MCP Wrapper

Do not implement until explicitly requested.

```
Task: Wrap Aegis browser actions as MCP tools.

Create an MCP server that exposes the 8 Aegis agent endpoints as MCP tools:
create-session, navigate, read-page, click, type, screenshot, request-capability, close.

Constraints:
- Preserve all existing collar enforcement — no collar bypass in any MCP tool handler.
- Do not expose vault values, card numbers, CVVs, passwords, or addresses in any tool response.
- Surface approval_required to the MCP client — do not auto-approve.
- Do not modify existing API routes or the /demo flow.
```

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
