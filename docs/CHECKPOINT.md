# CHECKPOINT.md

Read this first after a context reset. It summarizes the current Aegis implementation state so you do not need to reread every doc or rediscover the app from scratch.

---

## 1. Current Status

Aegis has a working local MVP demo. The core loop works end-to-end:

- Outside-agent simulator creates a protected browser session
- Agent navigates to the local mock checkout
- Agent attempts to click "Place Order"
- Aegis detects the purchase action
- Aegis pauses the click before execution
- Approval is created and surfaced in the UI
- User approves
- Aegis Runner fills fake checkout details from the mock vault
- No real payment is made
- No credentials are exposed to the outside agent
- Receipt is created
- Dashboard, Demo page, Runners, and Receipts all update

---

## 2. What Aegis Is

Aegis is **not** an agent builder.

Aegis is a trust and control layer around outside agents.

- Outside agents choose browser actions (browse, click, type).
- Aegis owns the protected browser runtime and enforces collars at sensitive boundaries.
- Normal browsing (search, compare, read) is allowed without interruption.
- Sensitive actions (purchase, login, form submit, identity disclosure) are paused, blocked, or handed off to Aegis Runner.
- Collars are customizable policy objects that define what is allowed, what requires approval, and what is blocked.
- Receipts record trust-relevant events — not full browsing surveillance.

Core lines:
- *Outside agents plan. Aegis executes sensitive steps.*
- *Agents can browse. Aegis decides when they can commit.*

---

## 3. Current Architecture

```
aegis/                          (Turbo/npm monorepo)
├── apps/
│   ├── api/                    Fastify API on port 4000
│   ├── web/                    Next.js frontend on port 3000
│   ├── mock-store/             Static local checkout site on port 3001
│   └── mcp-server/             MCP server — thin wrapper around Aegis HTTP API
└── packages/
    └── types/                  Shared TypeScript types
```

Key architecture notes:
- **In-memory store only** — all data is lost on API restart
- **Playwright-controlled Chromium** — each protected session gets an isolated browser context
- **Mock vault only** — fake card/address data, never real
- **Simulated runner only** — fills mock checkout fields, does not submit real payment
- **MCP server is a thin wrapper** — all collar enforcement still happens in apps/api; no secrets exposed; AEGIS_API_BASE_URL defaults to http://localhost:4000
- No Supabase, no auth, no real LLM agent

---

## 4. Important Running URLs

| Service | URL |
|---------|-----|
| Web app | http://localhost:3000 |
| Demo page | http://localhost:3000/demo |
| API | http://localhost:4000 |
| Mock store | http://localhost:3001 |
| Mock checkout | http://localhost:3001/checkout.html |
| AegisID page | http://localhost:3000/aegis-id |
| Website AegisID page | http://localhost:3000/website-aegis-id |
| Agent Verification page | http://localhost:3000/counterparty-agent |

---

## 5. Implemented Milestones

| Milestone | What was built |
|-----------|---------------|
| 1 | Turbo monorepo skeleton — apps/api, apps/web, apps/mock-store, packages/types |
| 2 | In-memory data models and full CRUD — collars, passes, sessions, approvals, receipts, runners |
| 3 | Policy engine, pass token validation, `/request-capability` endpoint |
| 4 | Playwright protected browser sessions — isolated Chromium context per session |
| 5 | Click/type enforcement and sensitive action detection on real browser elements |
| 6 | Simulated Aegis Runner — approval triggers runner creation and execution |
| 7 | Mock vault and Runner form fill — Runner fills fake checkout fields from vault without exposing values to outside agent |
| Demo polish | `/demo` page with two-step interactive demo, timeline, and "What this proves" panel |
| MCP wrapper v0 | `apps/mcp-server` — MCP server wrapping all 8 Aegis browser tools; **implemented and end-to-end validated** via MCP Inspector: tools/list returns all 8 tools; full session flow confirmed (aegis_create_session → aegis_navigate → aegis_read_page → aegis_click "Place Order" → approval_required → user approves in Aegis UI → runner completes with mock vault → receipt created → aegis_close_session returns status closed) |
| Local persistence v0 | `apps/api/src/store/persistence.ts` — JSON file persistence at `apps/api/.data/aegis-store.json`; collars, passes, receipts, runner tasks, reputation events, and approvals survive API restarts; browser sessions (active/waiting_for_approval) are marked `error` on restart since Playwright contexts do not survive; first startup seeds the default mock user and starter collar |
| Reputation v0 | `GET /api/aegis-id/me/trust-claims` endpoint; `/aegis-id` page with sidebar link; trust claims derived from receipts, runner tasks, approvals, and blocked actions; claims are category-specific and privacy-preserving — **not a generic public score**; `verified_human_backed` is demo/mock true; `purchase_history` becomes `demo_clean` after ≥1 runner-completed purchase and zero credential exposure incidents; **local/demo only** |
| Website/Business AegisID v0 | `GET /api/website-aegis-id/:domain/trust-claims` and `GET /api/website-aegis-id`; demo seeds for `localhost` / `example-store.local` (verified_demo_business) and `bad-store.local` (flagged); `successful_runner_transactions` derived from runner tasks; `blocked_or_disputed_actions` derived from blocked receipts; frontend page at `/website-aegis-id` with domain search and known identity list; **local/demo only — no real domain or business verification** |
| Counterparty Agent Verification v0 | `GET /api/counterparty/agent/:aegisId/trust-passport`; returns a privacy-preserving trust passport for an incoming agent-backed AegisID — trust_status, active policy summary, and recommended_business_action derived from receipts, runner tasks, approvals, and active collar; no raw history, pass tokens, or vault data exposed; frontend at `/counterparty-agent` with AegisID input, trust passport card, policy summary card, and recommended action badge; **local/demo only** |
| Agent Task v0 | `AgentTask` type and `AgentTaskStatus` added to `packages/types`; `agentTasks` Map added to store; tasks persist to `apps/api/.data/aegis-store.json` and survive restart; routes: `GET /api/tasks`, `GET /api/tasks/:taskId`, `POST /api/tasks` (auto-creates pass, returns `launch_token` once), `POST /api/tasks/:taskId/cancel`, `POST /api/tasks/:taskId/create-session` (validates token, launches browser, updates status to `in_progress` on success or `failed` on error); frontend at `/tasks` with create form, one-time token display with copy button, task list with constraints, and in-memory Create Session button; **launch_token shown once only — not stored in AgentTask; local/demo only** |
| Delegation Token / Agent Runtime v0 | `AgentDelegation`, `AgentDelegationStatus`, `AgentDelegationChannel` added to `packages/types`; `agentDelegations` Map added to store and persisted; routes: `GET /api/delegations`, `GET /api/delegations/:delegationId`, `POST /api/delegations` (creates underlying pass, returns `delegation_token` once), `POST /api/delegations/:delegationId/revoke` (revokes delegation + underlying pass — existing MCP tools stop working immediately); v0 uses normal pass tokens under the hood, no new agent endpoint needed; frontend at `/delegations` with create form (agent name, platform, channel, collar, expiry), one-time token display with copy-paste instructions, delegation list with revoke button; **token shown once only — not stored in AgentDelegation; local/demo only; no real Slack/OpenClaw integration** |
| Email OTP Delivery v1 | Real email verification via Resend from `noreply@verify.antigenlabs.ai` (`verify.antigenlabs.ai` verified sending domain). `email_otp` is the live provider; `local_email` is the dev console fallback; `mock_email` is the test/mock provider. `VerificationCard` stores `email_domain` only — full email address and raw OTP are never persisted or returned. Rate limits: 3 sends/15 min, 60 s cooldown, 5 failed attempts per session. Google OAuth and inbound email receiving are not in v1. |

---

## 6. Key Working Demo

Start all services:

```bash
npm run dev
```

Then open: **http://localhost:3000/demo**

Flow:
1. Click **"Run Agent Demo"** — creates pass, session, navigates to mock checkout, clicks Place Order, stops at `approval_required`. Shows `session_id` and `approval_request_id`.
2. Click **"Approve and Run Aegis Runner"** — approves the request, runner fills mock vault data. Shows `runner_task_id` and `receipt_id`.
3. Visit `/runners` and `/receipts` to confirm entries were created.

---

## 7. Key Scripts

Located in `apps/api/scripts/`. Run with `npx tsx scripts/<file>`.

| Script | Purpose |
|--------|---------|
| `agent-demo.ts` | Basic agent session flow |
| `browser-enforcement-demo.ts` | Browser click/type enforcement with collar policy |
| `runner-demo.ts` | Full approval → runner flow (most comprehensive) |
| `runner-fill-demo.ts` | Runner vault form-fill demo |

---

## 8. Critical Files

| File | Description |
|------|-------------|
| `apps/api/src/routes/agent.ts` | All outside-agent endpoints: `create-session`, `navigate`, `click`, `type`, `request-capability` |
| `apps/api/src/routes/approvals.ts` | Approve/deny approval requests; triggers runner creation on approve |
| `apps/api/src/services/passValidator.ts` | Validates pass tokens; resolves pass → collar |
| `apps/api/src/services/runnerService.ts` | Creates and executes runner tasks |
| `apps/api/src/services/mockVaultService.ts` | Returns fake card/address data for runner use; never exposes to outside agent |
| `apps/api/src/browser/browserManager.ts` | Manages Playwright browser contexts per session (create, get, close) |
| `apps/api/src/browser/sessionController.ts` | Per-session browser actions: navigate, click, type, screenshot, readPage |
| `apps/api/src/detection/sensitiveDetector.ts` | Rule-based detector that classifies browser actions as sensitive or safe |
| `apps/api/src/store/index.ts` | In-memory Maps for all data; seeded with default collar and user on startup |
| `apps/mcp-server/src/index.ts` | MCP server entry point; thin wrapper over Aegis HTTP API; exposes 8 tools |
| `apps/mcp-server/README.md` | MCP server setup and usage docs |
| `apps/api/src/routes/aegis-id.ts` | AegisID trust claims endpoint — derives category-specific claims from receipts, runner tasks, approvals, and blocked actions |
| `apps/web/src/app/aegis-id/page.tsx` | AegisID page — displays trust claims; linked from sidebar |
| `apps/web/src/app/demo/page.tsx` | Interactive demo page — two-button flow with timeline and explanation panel |
| `apps/web/src/app/page.tsx` | Dashboard — sessions, pending approvals, recent activity |
| `apps/web/src/app/runners/page.tsx` | Runners list — shows task type, status, constraints, result |
| `apps/web/src/app/receipts/page.tsx` | Receipts list — trust-relevant event log |
| `packages/types/src/index.ts` | All shared TypeScript interfaces and enums |

---

## 9. Current Limitations

- No real LLM agent — demo uses a simulated outside-agent flow via API calls
- No Supabase — data persists to a local JSON file (`apps/api/.data/aegis-store.json`) but is not replicated or cloud-backed
- No auth — all requests are treated as the seeded demo user
- No real vault — mock vault returns hardcoded fake data
- No real payments — runner fills form fields only; does not submit
- No real checkout submission
- No real website or business verification
- No production encryption
- Browser sensitive detection is rule-based and tuned for the mock checkout; real-world detection will need to be more robust
- Browser sessions do not survive API restart — any active/waiting_for_approval sessions are marked `error` on next startup; re-run the demo to create a new session

---

## 10. Security Notes

- **Mock vault data is fake only** — no real card numbers, CVVs, addresses, or passwords exist anywhere
- **Outside agent never receives vault values** — runner reads vault and fills form fields internally; values are not returned in API responses
- **Runner does not submit payment** — it fills the form but does not trigger real checkout submission
- **Never expose raw card/CVV/address/password** in API responses or UI — this constraint must be preserved in all future work
- Production would require: encrypted vault storage, tokenized payments, OAuth, virtual cards, or provider APIs (Stripe, etc.)

---

## 11. Product Lines To Preserve

These lines capture the product thesis and should not be contradicted by implementation decisions:

- Aegis is not the agent.
- Outside agents plan. Aegis executes sensitive steps.
- Agents can browse. Aegis decides when they can commit.
- Aegis lets agents use authority without possessing secrets.
- Collars are customizable policy objects.
- Receipts record trust-relevant events, not surveillance.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents are disposable. Trust is not.

---

## 12. Recommended Next Steps

In order of priority:

**A. Agent Bridge** — Document and/or add a UI page explaining how a real outside agent (ChatGPT, Claude, custom) would call Aegis endpoints. This is the most important missing piece for external demo credibility.

**B. Local persistence** — Add SQLite or Supabase now that the MCP wrapper is validated. Prevents data loss on restart.

**C. MCP server** ✓ Done — `apps/mcp-server` implemented and end-to-end validated via MCP Inspector.

**D. Basic auth** — Add simple auth only after persistence is in place. Do not add auth before persistence.

**E. Real encrypted vault** — Only after architecture is clear and auth exists. Do not add real secrets infrastructure to the current in-memory setup.

**F. UI polish** — Improve styling and UX only after the working demo flow is preserved and tested. Do not redesign the UI before the product logic is stable.

---

## 13. Instructions For Future Coding Agents

- **Read `docs/CHECKPOINT.md` first** before making any changes.
- Then inspect only the files relevant to the requested change — do not read the entire codebase on every session.
- Avoid broad refactors — the working demo loop is fragile to architectural changes.
- Keep domain logic separate from UI (API routes should not import frontend code).
- Keep sensitive detection (`sensitiveDetector.ts`) separate from policy evaluation (`evaluate.ts`).
- Keep Runner deterministic — it is not an autonomous agent; it executes one approved step and stops.
- **Preserve the working `/demo` flow** — if a change could break the two-button demo, test it first.
- Never introduce real secrets, real card numbers, or real payment submission into the demo.
- Do not add Supabase, real auth, or OpenAI/Claude API calls unless those milestones are explicitly requested.
