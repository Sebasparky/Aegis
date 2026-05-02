# Aegis — AI Session Guide

## One-Line Thesis

Aegis is the trust and workflow layer for delegated AI action.

## What Aegis Is

Agents are becoming capable enough to act across the web, but the web does not yet know how to trust them. Today, agents improvise on websites built for humans, wasting context, increasing failure rates, and creating liability ambiguity.

Aegis gives agents identity, scoped permissions, verified workflow routes, runtime guardrails, and auditability. It is not an agent builder. It is the layer users and businesses attach to agents before those agents act on their behalf.

Two useful metaphors:

- **Google Maps for AI agents.** Aegis does not replace websites. It makes websites navigable for agents through verified routes, scoped permissions, and trust signals.
- **ID badges for AI workers.** Agents are becoming workers. Aegis gives them identity, access rules, verified workflows, supervision, and accountability.

## What Aegis Is Not

- Not a password manager
- Not an agent builder
- Not a surveillance dashboard
- Not a generic browser automation tool
- Not a prompt-only safety system
- Not a markdown skill-file marketplace
- Not a platform for running arbitrary code from strangers inside user accounts
- Not a claim that agents will never fail or that liability is removed

## The 5 Product Pillars

### 1. AegisID

Every agent, route creator, business, and delegated actor can have a verifiable identity.

- Who is this agent?
- Who created it?
- Who is it acting for?
- Is it verified?
- What is its trust history?

### 2. Delegation and Permissions (Collars)

Users explicitly grant agents scoped authority through **Collars** — customizable, signed, revocable policy objects.

A collar answers:
- What can this agent do?
- On which sites?
- For how long?
- With what spending or action limits?
- What requires approval?
- What is forbidden?
- Can this be revoked?

Use "collar" in code. Use "scoped permissions" or "delegation" in product copy.

### 3. Verified Workflow Routes — Aegis Rails

Agents should not improvise inside sensitive workflows when a verified route exists.

Aegis Rails let humans, businesses, and verified creators publish reusable workflow routes that agents can discover and follow.

A route is not a markdown file. A route is not arbitrary executable code. A route is a structured, inspectable, permission-scoped, versioned, reviewed, and enforceable execution path.

Route lifecycle:
1. **Teach** — A human demonstrates a workflow once
2. **Record** — Aegis captures semantic browser telemetry (accessibility tree, DOM metadata, browser events, network events)
3. **Compile** — Aegis produces a declarative route object from the recording
4. **Verify** — The route is reviewed, tested, and assigned a trust tier
5. **Publish or save privately** — Route goes to registry or stays local
6. **Discover** — An agent queries the registry for a verified route matching its task
7. **Execute with guardrails** — Aegis Guard enforces the route during execution
8. **Audit** — Receipts record what was followed, what was blocked, what was approved

See `docs/AEGIS_RAILS.md` for the full technical spec.

### 4. Runtime Guardrails — Aegis Guard

Aegis Guard is the umbrella name for the runtime monitoring and enforcement layer. It covers:

- `SensitiveActionDetector` — rule-based classification of browser actions
- `PolicyService` — collar + route enforcement against detected actions
- Approval inbox — human-in-the-loop gates
- Session pause, block, and revocation

Sensitive actions Aegis Guard must catch:
- Transfer money / payment / purchase
- Submit order
- Accept terms
- Grant OAuth permissions
- Delete data
- Send external messages
- Change account settings
- Add payment method
- Connect external account
- Identity disclosure

### 5. Accountability and Audit Trail

Aegis records what authority was granted, what route was followed, what actions were taken, what approvals happened, and what was blocked. This creates a trust and liability trail for users, agents, and websites.

**Receipts** capture trust-relevant events, not everything.

## Architecture Principles

- **Agent autonomy above, Aegis enforcement below.** Agents use their own tools for browsing, reading, and reasoning. Aegis is invoked only for trust-sensitive execution: verified workflow routes, credentialed actions, approval gates, and audit receipts.
- **Enforcement outside the model.** Collar and route enforcement happens through tools, tokens, browser sessions, and approval flows — not prompts.
- **Control the action boundary, not every thought.** Only interrupt at sensitive commitments.
- **Treat outside agents as untrusted.** Validate pass, collar, session, and action at every step.
- **Declarative routes only.** No arbitrary marketplace code execution inside user accounts.
- **Store structure, not private data.** Prefer accessibility tree and DOM metadata over full screenshots. Never store raw passwords, card numbers, or full identity documents.
- **Prefer local processing.** Minimize data sent off-device for route compilation and enforcement.
- **Sensitive workflows default to approval.** When uncertain, prefer `approval_required` over silent allow.
- **Browser extension teaches, Playwright verifies, action API executes.** These three surfaces have separate roles in Aegis Rails and must not be mixed. The browser extension is the human teaching surface. Playwright is the verification and regression-testing runtime. The Aegis action API mediates all agent actions during route execution — agents never receive a Playwright handle or unrestricted browser context.

## Current Implementation State

### Core guard loop (working demo at `http://localhost:3000/demo`)
1. User creates a Collar + Aegis Pass
2. Outside agent requests a protected browser session
3. Aegis launches an isolated Playwright/Chromium context
4. Agent browses freely
5. Aegis Guard detects a sensitive action boundary
6. Policy engine evaluates against the collar
7. Allow, block, or `approval_required`
8. User approves or denies in the approval inbox
9. Aegis Runner executes the sensitive step (no raw secrets exposed)
10. Receipt is created; reputation events update

### Aegis Rails (working — `http://localhost:3000/rails`)
- Route types, compiler, verifier, and store are implemented
- Chrome extension records workflows on external websites (Wikipedia demonstrated)
- Playwright verifies recorded routes; passing verification promotes trust tier to `aegis_scanned`
- Visual replay works for both local (mock bank) and external (Wikipedia) routes
- Parameterized variables allow runtime binding per route execution
- Private skill vs marketplace skill model is implemented
- Submit for Review, Marketplace Review queue, approve/reject flow are implemented
- `npm run seed:demo` resets to a clean 4-route demo state
- Demo walkthrough: `docs/DEMO_WALKTHROUGH.md`
- Skill and InstalledSkill models; Marketplace page (`/marketplace`); Skill Library page (`/skill-library`)
- Extension runtime surfacing of installed skills by domain
- RouteRun API: agent requests route execution via installed skill; receipts/audit trail recorded per run
- Extension pending-run pickup and execution
- Agent delegation skill-access policy: `all / exclude / only`; `PATCH /api/delegations/:id/skill-access`; `agent_id` required on route run requests
- Collar enforcement for RouteRuns: allowed permissions create pending runs; blocked/unknown return `COLLAR_BLOCKED`
- Approval-gated RouteRuns: approval-required permissions create `pending_approval` runs; approve/reject API; extension only sees `status=pending`
- Route Run Approvals page (`/route-run-approvals`): UI for approving/rejecting `pending_approval` runs
- Delegation token auth (v1): `POST /api/skills/:skillId/runs` requires `Authorization: Bearer <token>`; token is `AgentDelegation.token_id`; missing token → `AUTH_REQUIRED`; invalid token → `INVALID_TOKEN`; `agent_id`, `delegation_id`, `collar_id` derived from resolved delegation (never trusted from request body); `fake-agent-create-run.mjs` uses `AEGIS_AGENT_TOKEN` env var
- Aegis MCP Tool Server: `examples/aegis-tool-server.mjs` exposes `discover_installed_skills`, `request_skill_run`, `get_route_run_status`, `get_route_run_receipt` as MCP tools; connect via `claude mcp add aegis -- node /path/to/aegis-tool-server.mjs`; first successful end-to-end test completed 2026-05-01 (Claude Code discovered Wikipedia Search, requested RouteRun for query Wisconsin, user started run via extension, Claude Code polled to completion, read receipt `rrreceipt_20b593b94de7`); do not rebuild unless explicitly requested
- Background auto-run (reliable, opt-in): extension background service worker watches the active tab for low-risk `status=pending` RouteRuns; executes one eligible run automatically without opening the popup; fill values set atomically via native HTMLInputElement setter and verified before proceeding; Wikipedia search submit uses `findBestSearchInput` + `form.requestSubmit()` to ensure the submitted form field holds `variables.query`; `background.js` verifies final tab URL/title before marking a run `completed` (navigation-based routes cannot send `replay_done` — the watcher resolves this); bad outcomes fail instead of producing incorrect completed receipts; validated 2026-05-01 (Wisconsin → `rrreceipt_d9a6ca5ae205`, Alan Turing → `rrreceipt_8f11681c5ab1`); do not rebuild popup auto-run, background auto-run, replay fill reliability, or Wikipedia outcome verification unless explicitly requested
- Agent-runnable workflow recipe path (complete, validated 2026-05-01): `execution_mode="agent_runnable"` skills return a route recipe via `get_agent_runnable_workflow`; agent executes the recipe in its own browser session; no RouteRun, no extension handoff; Wikipedia Search demonstrated end-to-end (Claude Code + Playwright); do not rebuild unless explicitly requested
- Controlled sensitive execution path (complete, validated 2026-05-01): `execution_mode="aegis_controlled"` skills refuse `get_agent_runnable_workflow` with `NOT_AGENT_RUNNABLE`; agent calls `request_skill_run`; runs requiring sensitive permissions create `pending_approval`; user approves in `/route-run-approvals`; extension auto-runs only on matching route context (domain + `url_match`); Demo Login validated at `/demo-login/success` (receipt `rrreceipt_d5614360e907`, run `run_054ca6e8022b`); Demo Login uses fake seeded credentials only — real credential custody is not implemented; do not rebuild unless explicitly requested

## Next Near-Term Milestone

Background Auto-Run (Reliable, Opt-In) is **complete** — validated 2026-05-01. Low-risk pending RouteRuns execute automatically when the matching domain tab is active, with fill verification and outcome verification before marking completed.

External Agent Integration Hardening is also **complete** — validated via the Aegis MCP Tool Server on 2026-05-01. The full external-agent flow works: third-party agent runtime → MCP tool discovery → Aegis HTTP contract → delegated token → policy enforcement → extension execution → receipt.

Agent-runnable workflow recipe path is **complete** — validated 2026-05-01. `execution_mode="agent_runnable"` skills surface a tested route recipe via `get_agent_runnable_workflow`; agents execute it in their own browser session without a RouteRun or extension handoff.

Aegis-controlled sensitive execution path is **complete** — validated 2026-05-01. `execution_mode="aegis_controlled"` skills refuse recipe access; agents use `request_skill_run`; approval-gated runs require user sign-off before the extension auto-runs only on the matching route context (`url_match` enforced). Demo Login receipt `rrreceipt_d5614360e907` confirms the full path.

Secret Vault / Pass Custody v1 is **complete** — implemented 2026-05-01. `AegisVaultPass` holds credential metadata; Demo Login route steps use `pass_field`/`secret_ref` value policy types (raw password removed from route); `POST /api/route-runs/:runId/resolve-value` endpoint resolves credentials only during approved running RouteRuns; receipts record `credential_used`, `pass_ids_used`, `secret_values_revealed_to_agent: false`.

KMS Abstraction v1 is **complete** — implemented 2026-05-02. `apps/api/src/lib/kms.ts` defines `KmsProvider` interface (`local_dev` provider uses AES-256-GCM with env key). `encryptedSecretVault` replaces `devSecretVault` (deprecated). Secrets encrypted at rest; persisted as `encryptedSecretVaultEntries`. `seedDefaultData/loadStore/resetStoreForDemo` are now async. Self-healing encrypts demo secret on startup after `seed:demo`. `vault-passes.ts`, `route-runs.ts`, `credential-sessions.ts` use KMS. Dotenv loaded from repo root `.env` in `index.ts`. To swap to cloud KMS: extend `KmsProviderName`, add provider class, add case in `getKmsProvider()`.

Route-to-Pass Binding v1 is **complete** — implemented 2026-05-01. `RoutePassBinding` type + `routePassBindings` map (persisted). `/api/route-pass-bindings` GET/POST/DELETE. `resolve-value` checks binding before route-step default. "Credential Assignments" UI on `/passes` page.

Secret Vault UI v1 is **complete** — implemented 2026-05-01. `/passes` page has a "Credential Vault" section for creating and listing `login_password` bundles. API at `/api/vault-passes` (GET/POST/DELETE). Password never returned after creation. `has_password: false` if encrypted blob absent (pass created before KMS migration — re-enter password). Dev/MVP warning displayed.

Natural-language credential selection v1 is **complete** — implemented 2026-05-01. `pass_overrides?: Record<string, string>` added to `RouteRun` type (key = purpose, value = pass_id). Validated at run creation time (purpose supported, pass exists, user owns it, kind matches, domain matches, `encryptedSecretVault.has(pass.secret_ref)`). `resolve-value` precedence updated: (1) `run.pass_overrides["login_password"]`, (2) `RoutePassBinding`, (3) route step default. MCP `list_vault_passes` tool added (GET /api/vault-passes + client-side filter by domain/kind/query; returns metadata only, never passwords). `request_skill_run` MCP tool updated to accept and forward `pass_overrides`. Agents can now select a user-named credential without opening the Passes UI.

Controlled tab launch for approved runs is **complete** — implemented 2026-05-01. `start_url?: string` added to `AegisRoute` type and seed for `route_demo_login_001` (`http://localhost:3000/demo-login`). `start_url` included in `route_summary` from GET /api/route-runs. Extension `background.js` has new `maybeAutoLaunchApprovedRun()` function called on every alarm poll (after `maybeAutoRunForTab`): finds exactly one approved pending run with a `start_url`; if a matching tab exists uses it; otherwise opens a new tab, calls `waitForTabToMatchRoute` (polls 300ms up to 5s), then executes. `markAutoStarted` is called before `chrome.tabs.create` so `onUpdated` cannot double-execute. Approval is still required; `pending_approval` runs are never touched.

Immutable + Signed Receipts v1 is **complete** — implemented 2026-05-02. `receipt_hash` covers `{ previous_receipt_hash, receipt_json }` (SHA-256 chain). `receipt_jws` is an EdDSA/Ed25519 CompactSign JWS over metadata only (no secrets). Supabase receipts use INSERT; append-only DB trigger blocks UPDATE/DELETE. Verify endpoint: `GET /api/route-run-receipts/:receiptId/verify`.

Candidate next milestones:
1. **Real cloud KMS provider** — AWS KMS / GCP KMS / Azure Key Vault (add provider to `lib/kms.ts`, change `AEGIS_KMS_PROVIDER`)
2. **Run lifecycle state machine + idempotency** — stricter state transitions, guard against duplicate approve/reject
3. **Capability/collar policy test coverage** — unit and integration tests for collar enforcement, skill-access policy, and approval gating
4. **Website/agent verification** — AegisID for agents; public key publication; receipt verification by third parties

See `docs/NEXT_SESSION_PROMPT.md` for the full completed increment list and recommended next steps.
See `docs/RAILS_ARCHITECTURE.md` for the full technical architecture.

## Session Rules for Every AI Coding Session

Before making any changes:

- Read `docs/NEXT_SESSION_PROMPT.md` to understand current working state and recommended next steps
- Read `docs/RAILS_ARCHITECTURE.md` when working on Aegis Rails recording, verification, or execution
- Inspect only files relevant to the requested task
- Do not broad-refactor; the /demo flow is fragile to architectural changes
- Do not introduce real secrets, real card numbers, or real payment submission
- Supabase Persistence v1 is **complete** — `AEGIS_PERSISTENCE_PROVIDER=supabase` enables durable storage for vault passes, encrypted secrets, and receipts. Do not add Supabase to routes/skills/delegations/sessions/reputation unless that milestone is explicitly requested
- Do not add real auth or real LLM API calls unless that milestone is explicitly requested
- Keep Aegis Guard (detector, policy, approval) separate from browser automation
- Keep domain logic separate from UI
- Preserve all existing service boundaries: CollarService, PassService, BrowserSessionService, SensitiveActionDetector, PolicyService, ApprovalService, RunnerService, ReceiptService, ReputationService
- Do not rebuild popup auto-run, background auto-run, replay fill reliability, or Wikipedia outcome verification unless explicitly requested
- Do not rebuild the agent-runnable recipe path or the controlled sensitive login path unless explicitly requested
- Do not rebuild Secret Vault v1 (`AegisVaultPass`, `resolve-value`, `pass_field`/`secret_ref`) unless explicitly requested
- Do not rebuild Secret Vault UI v1 (`/api/vault-passes`, `vault-passes.ts`, Credential Vault section in passes page) unless explicitly requested
- Do not rebuild KMS Abstraction v1 (`encryptedSecretVault`, `LocalDevKmsProvider`, `EncryptedSecretBlob`, `getKmsProvider`, async `seedDefaultData/loadStore/resetStoreForDemo`) unless explicitly requested
- Do not write to or read from `devSecretVault` — it is deprecated; use `encryptedSecretVault + kms.decryptSecret()` for all password resolution
- Do not rebuild Supabase Persistence v1 (`getVaultRepository`, `getReceiptRepository`, `docs/supabase/001_vault_and_receipts.sql`, `seed-supabase-demo.mjs`, `lib/supabase.ts`, `lib/receiptHash.ts`, `lib/persistenceProvider.ts`) unless explicitly requested
- Do not directly access `aegisVaultPasses`, `encryptedSecretVault`, or `routeRunReceipts` Maps in vault-passes.ts or receipts.ts — use `getVaultRepository()` / `getReceiptRepository()` instead
- The Supabase vault repository dual-writes to local Maps (temporary bridge for non-migrated routes). Long-term: all vault/secret reads should migrate to repository-backed access; dual-write will be removed once complete
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` outside `apps/api` — it must never be imported in `apps/web` or `apps/extension`
- `login_password` passes are a username + password bundle — username is metadata, password is encrypted in `encryptedSecretVault` and never returned after creation
- Do not rebuild Route-to-Pass Binding v1 (`RoutePassBinding`, `routePassBindings`, `/api/route-pass-bindings`, Credential Assignments UI) unless explicitly requested
- Do not rebuild natural-language credential selection v1 (`pass_overrides` on `RouteRun`, `list_vault_passes` MCP tool, `request_skill_run` `pass_overrides` forwarding, validation in POST /api/skills/:skillId/runs, resolve-value precedence) unless explicitly requested
- Do not rebuild controlled tab launch (`start_url` on `AegisRoute`, `maybeAutoLaunchApprovedRun`, `waitForTabToMatchRoute`, `start_url` in `route_summary`) unless explicitly requested
- `resolve-value` binding lookup key is `${user_id}:${route_id}:login_password` — binding overrides `vp.pass_id`; seeded pass is the fallback when no binding exists
- Do not treat `execution_mode: "agent_runnable"` as permission to skip Aegis — it means call `get_agent_runnable_workflow` to get the Aegis-tested route recipe, then execute it in the agent's own browser
- Do not run `aegis_controlled` routes based on domain alone — route context matching uses domain + optional `url_match`; a controlled route must not execute on the wrong page (e.g., `/route-run-approvals` instead of `/demo-login`)
- Do not rebuild credential session context binding v1 (`target_url`/`url_match` on `CredentialUseSession`, `doesTabMatchCredentialSession` extension helper, `session_context` in GET /api/credential-fill-requests response) unless explicitly requested
- Field-level credential fill is context-bound: domain-only matching is unsafe for multi-path sites; use `target_url` when creating a credential session to bind fills to a specific login page; extension leaves fill requests pending (not failed) when active tab doesn't match url_match
- Do not rebuild Immutable + Signed Receipts v1 (`receiptSigning.ts`, `generate-receipt-keypair.mjs`, `002_signed_immutable_receipts.sql`, `UnsignedDevModeError`, `verifyReceipt`, `GET /api/route-run-receipts/:receiptId/verify`) unless explicitly requested
- `receipt_hash` and `receipt_jws` are Supabase row metadata — they are NOT fields on `RouteRunReceipt` and must not be added to the type
- Supabase `createReceipt` uses INSERT (not upsert) — receipts are append-only; the DB trigger blocks UPDATE/DELETE; never bypass it
- Pass `previousReceiptHash` to `hashReceipt` in the Supabase path — calling it without the previous hash produces a broken chain

## Terminology — Always Use

| Term | Meaning |
|---|---|
| AegisID | Verifiable identity for users, agents, businesses, websites |
| Collar | Scoped permission object attached to an agent session |
| Aegis Pass | Credential given to an outside agent (not raw secrets) |
| Aegis Runner | Short-lived executor for sensitive steps |
| Aegis Guard | Runtime monitoring and enforcement layer |
| Aegis Rails | Verified workflow routes |
| Verified workflow route | Structured, inspectable, enforceable execution path |
| Route | The technical record: ordered steps, locators, value policies, trust tier, verification report |
| Skill | Product package around a route — name, summary, permissions, risk, approval gates, domain, trust evidence |
| Skill Library | A user's installed marketplace skills, available to their delegated agents |
| Route registry | Agent-readable index of verified routes |
| Scoped permissions | What a collar defines (use in product copy) |
| Delegation | User granting an agent authority under a collar |
| Audit trail | Receipts recording what was done, approved, and blocked |
| Trust layer | What Aegis is at the infrastructure level |
| Delegated AI action | The core use case Aegis enables |

## Terminology — Avoid or Downplay

| Term | Why to avoid |
|---|---|
| Password manager | Reduces Aegis to credential storage |
| Generic browser agent | We are the trust layer, not the agent |
| Agent marketplace | Implies trading agents, not routes |
| Prompt marketplace | Routes are structured objects, not prompts |
| Markdown skill file | Routes are not flat text files |
| Fully autonomous agent | We require human approval for irreversible actions |
| Train a model | We compile routes from demonstrations; no model training |
| Arbitrary script execution | Routes are declarative and inspectable |

## Security Principles

- Never imply Aegis stores raw passwords as its core value
- Never imply routes are arbitrary executable scripts from strangers
- Never imply agents should bypass user approval for financial, legal, medical, identity, or irreversible actions
- Sensitive workflows default to human approval
- Agents with Aegis can do more because they act inside trusted boundaries — not because limits are removed
- Prompt injection protection is a first-class concern for route recording and execution
- Version, review, and audit every published route
- Block or pause on low-confidence action classification

## Things Never to Do in This Codebase

- Store raw passwords, full card numbers, CVVs, or government IDs
- Allow the outside agent direct access to the Playwright browser context or CDP connection
- Give agents unrestricted browser control during route execution — all agent actions must go through the Aegis action API
- Auto-approve sensitive actions without user input
- Skip collar validation on any API route
- Upload arbitrary user-supplied code to execute inside a protected session
- Use screenshots as the primary data representation for routes (accessibility tree and semantic locators first)
- Store raw typed values from recording without a value policy classification — sensitive fields must produce `sensitive_redacted` or `runtime_variable`
- Use raw coordinates or XPath as the primary locator in compiled routes — prefer role, label, or placeholder locators
- Claim that Aegis removes all risk or guarantees agent safety
- Treat `execution_mode: "agent_runnable"` as "ignore Aegis" — agent_runnable means fetch and follow the Aegis route recipe, not bypass Aegis entirely
- Claim Demo Login demonstrates real credential custody — it uses fake seeded demo credentials; real credential custody/pass vault is not implemented
- Expose `AEGIS_RECEIPT_JWS_PRIVATE_JWK` in any API response, log line, or front-end import — it must remain in `apps/api` env only
- Include plaintext passwords, credential values, or secrets in `receipt_jws` payload — the JWS covers only metadata (receipt_id, receipt_hash, previous_receipt_hash, issuer, issued_at)

## Core Lines

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Browse freely. Commit safely.
- Platform IDs prove origin. AegisID proves trust.
- Aegis reputation is a history of how safely your agents act under verified delegation.
