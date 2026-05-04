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

Cloud KMS Provider v1 is **complete** — implemented 2026-05-03. `KmsProviderName` now includes `"cloud_kms_stub"`. `CloudKmsStubProvider` (`apps/api/src/lib/cloudKmsStubProvider.ts`) throws `CLOUD_KMS_NOT_IMPLEMENTED` on any encrypt/decrypt — never falls back to `local_dev`. `KmsAuditEvent` and `KmsOperationType` added to `packages/types/src/index.ts`. `apps/api/src/lib/kmsAudit.ts` records every KMS operation (metadata only, `raw_secret_exposed: false` always). `vault-passes.ts` records `encrypt_secret` events. `secretResolution.ts` records `resolve_secret_for_runtime` events. `GET /api/kms-audit-events` (dev/internal only). To add a real cloud KMS: extend `KmsProviderName`, add a provider class, add a case in `getKmsProvider()`.

Route-to-Pass Binding v1 is **complete** — implemented 2026-05-01. `RoutePassBinding` type + `routePassBindings` map (persisted). `/api/route-pass-bindings` GET/POST/DELETE. `resolve-value` checks binding before route-step default. "Credential Assignments" UI on `/passes` page.

Secret Vault UI v1 is **complete** — implemented 2026-05-01. `/passes` page has a "Credential Vault" section for creating and listing `login_password` bundles. API at `/api/vault-passes` (GET/POST/DELETE). Password never returned after creation. `has_password: false` if encrypted blob absent (pass created before KMS migration — re-enter password). Dev/MVP warning displayed.

Natural-language credential selection v1 is **complete** — implemented 2026-05-01. `pass_overrides?: Record<string, string>` added to `RouteRun` type (key = purpose, value = pass_id). Validated at run creation time (purpose supported, pass exists, user owns it, kind matches, domain matches, `encryptedSecretVault.has(pass.secret_ref)`). `resolve-value` precedence updated: (1) `run.pass_overrides["login_password"]`, (2) `RoutePassBinding`, (3) route step default. MCP `list_vault_passes` tool added (GET /api/vault-passes + client-side filter by domain/kind/query; returns metadata only, never passwords). `request_skill_run` MCP tool updated to accept and forward `pass_overrides`. Agents can now select a user-named credential without opening the Passes UI.

Controlled tab launch for approved runs is **complete** — implemented 2026-05-01. `start_url?: string` added to `AegisRoute` type and seed for `route_demo_login_001` (`http://localhost:3000/demo-login`). `start_url` included in `route_summary` from GET /api/route-runs. Extension `background.js` has new `maybeAutoLaunchApprovedRun()` function called on every alarm poll (after `maybeAutoRunForTab`): finds exactly one approved pending run with a `start_url`; if a matching tab exists uses it; otherwise opens a new tab, calls `waitForTabToMatchRoute` (polls 300ms up to 5s), then executes. `markAutoStarted` is called before `chrome.tabs.create` so `onUpdated` cannot double-execute. Approval is still required; `pending_approval` runs are never touched.

Immutable + Signed Receipts v1 is **complete** — implemented 2026-05-02. `receipt_hash` covers `{ previous_receipt_hash, receipt_json }` (SHA-256 chain). `receipt_jws` is an EdDSA/Ed25519 CompactSign JWS over metadata only (no secrets). Supabase receipts use INSERT; append-only DB trigger blocks UPDATE/DELETE. Verify endpoint: `GET /api/route-run-receipts/:receiptId/verify`.

Playwright Runtime v1 is **complete** — implemented 2026-05-02. Agents can execute approved controlled runs via `POST /api/runtime/route-runs/:runId/playwright/start` or MCP tool `start_playwright_route_run`. Aegis launches an isolated headless Chromium session, resolves credentials via KMS vault, instruments sensitive events, and emits signed receipts with `execution_surface: "aegis_playwright"`. No user-opened tab required.

Sensitive Workflow Detection v1 is **complete** — implemented 2026-05-02. Aegis Playwright runtime instruments every session for sensitive field interactions, button clicks, and form submissions. Events classified as `covered_by_aegis`, `not_covered_by_aegis`, or `unknown` using coverage windows around Aegis-controlled actions. Metadata only — no field values stored. `coverage_summary` attached to session and receipt. Events accessible at `GET /api/runtime/sessions/:id/events`.

**`aegis_playwright` is the primary controlled execution surface for autonomous agents.** `chrome_extension` is retained as an optional local/debug/recording companion. Future autonomous-agent features should target `aegis_playwright` first.

Delegation Passport v1 is **complete** — implemented 2026-05-02. Agents can create and verify a signed Delegation Passport documenting human subject, agent subject, collar-backed action limits, KMS custody model, Aegis coverage boundary, and receipt-backed evidence. MCP tools `create_delegation_passport` and `verify_delegation_passport` are available. The passport does NOT claim the agent has no out-of-band secrets — it attests only to Aegis-covered delegation boundaries.

Website Assertion / Handshake v1 is **complete** — implemented 2026-05-03. `POST /api/website-assertions` creates a signed `WebsiteTrustAssertion` combining trust profile + optional passport into a compact machine-readable recommendation (allow / allow_with_approval / step_up_required / deny) with EdDSA JWS signature. `GET /api/website-assertions/:id/verify` recomputes hash, verifies JWS, cross-checks payload, checks expiry. MCP tools `create_website_trust_assertion` and `verify_website_trust_assertion` expose this to agents. No unsigned fallback.

Real Payment / Travel Mock Route v1 is **complete** — implemented 2026-05-03. Demo travel booking route at `/demo-travel` and `/demo-travel/success`. `PaymentMethodCapability` Map holds metadata only (no PAN, no CVV). `payment_method_available` is now a live Map lookup (`paymentMethods`). Travel booking authorization receipts carry `action_type: "travel_booking"`, `max_amount_usd: 500`, `currency: "USD"`, `allowed_payment_instrument_types: ["demo_card"]`. Trust profile for `travel_booking` advances from `capable_but_unproven` → `proven_limited` after first successful run. Website assertion: `step_up_required` before run → `allow_with_approval` after. Travel history does NOT count toward `payment` trust. `safe_literal` value policies now supported in Playwright runtime.

Coverage Violation Blocking v1 is **complete** — implemented 2026-05-03. `RuntimeIntervention` type added. `runtimeInterventions` Map + `createRuntimeIntervention` in `aegisRuntime.ts`. Playwright runtime checks for `not_covered_by_aegis` events after collecting page events; if found, creates interventions, marks run `failed` with `VIOLATION_BLOCKED` error, creates signed failed receipt with `runtime_interventions[]`, leaves authorization `active`. Delegation trust profile now scans all delegation auth receipts (not just fulfilled) for uncovered events. Violation demo: `skill_demo_travel_violation_001` / `route_demo_travel_violation_001` at `/demo-travel?violation=1`.

Capability Release Gate v1 is **complete** — implemented 2026-05-03. Sensitive event coverage is now provenance-based, not timing-based. `RuntimeCapabilityRelease` type tracks that Aegis explicitly released a capability (`login_credential`, `payment_method`, `identity_profile`) for a run. `requiredCapabilityForEvent()` determines the required capability per event; events with a required capability are `covered_by_aegis` only when a matching active release exists — timing windows are not consulted for those events. `unknown_sensitive` high/critical events are also not covered by timing alone. `login_credential` releases created on `secret_ref` fills only. `payment_method` releases created only for payment-intent click steps if the user has a payment method in `paymentMethods` Map. Receipts include `runtime_capability_releases` and `capability_release_summary` (metadata only). New intervention type: `blocked_sensitive_action_without_capability_release`. Violation demo correctly fails because the hidden credential submit at page load has no `login_credential` release.

Candidate next milestones:
1. **Website .well-known Aegis policy v1** — structured endpoint websites publish to describe their Aegis agent policy
2. **Cloud KMS Provider v1** — swap `LocalDevKmsProvider` for a real cloud KMS (AWS KMS, GCP KMS, or HashiCorp Vault)

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
- Do not rebuild Cloud KMS Provider v1 (`CloudKmsStubProvider`, `kmsAudit.ts`, `kms-audit.ts` route, KMS audit logging in `vault-passes.ts`/`secretResolution.ts`) unless explicitly requested
- `cloud_kms_stub` always throws `CLOUD_KMS_NOT_IMPLEMENTED` — it does not fall back to `local_dev`; do not add silent fallback behavior
- `local_dev` KMS provider is demo-only — do not describe it as production-grade KMS
- Do not expose plaintext passwords, ciphertext, nonces, auth tags, key material, secret_ref values, or encrypted blob IDs in `KmsAuditEvent` or in `GET /api/kms-audit-events` responses — `KmsAuditEvent.raw_secret_exposed: false` is a literal type and must always remain `false`
- `GET /api/kms-audit-events` is an internal dev endpoint — audit events are in-memory only (reset on restart); do not frame it as a production public API
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
- Do not assume user has a browser tab open for autonomous-agent flows — the Chrome extension is an optional local/debug/recording companion, not the primary execution architecture; use `POST /api/runtime/route-runs/:runId/playwright/start` (or MCP tool `start_playwright_route_run`) for controlled runs; do not instruct agents to manually open target pages when `aegis_playwright` is available
- Do not instruct users or agents to manually call `start_playwright_route_run` after approval unless auto-start has failed or the run remains `pending` unexpectedly; approval of an `aegis_controlled` run automatically triggers Playwright execution via fire-and-forget in the approval handler
- Do not rebuild Auto-start Playwright Runs v1 (`claimed_execution_surface` on `RouteRun`, fire-and-forget dynamic import of `executeRouteRunWithPlaywright` in the approval endpoint, `isEligibleForBackgroundAutoRun` extension guard for `claimed_execution_surface`) unless explicitly requested
- Do not rebuild Playwright Runtime v1 (`aegisRuntime.ts`, `playwrightRuntime.ts`, `secretResolution.ts`, `runtime-sessions.ts`, `executeRouteRunWithPlaywright`, `start_playwright_route_run`) unless explicitly requested; `execution_surface: "aegis_playwright"` receipts are signed and verified through the same pipeline as extension receipts
- Do not rebuild Execution Surface Recenter v1 (MCP tool descriptions, `plan_aegis_action` post_approval fields, README Execution Surfaces section, contract architecture note) unless explicitly requested
- New sensitive workflow features (delegation passports, action authorization receipts) should target `aegis_playwright` first; Chrome extension support can follow as a companion surface — do not design new autonomous-agent features around requiring an active browser tab
- Do not rebuild Sensitive Workflow Detection v1 (`RuntimeEvent`, `RuntimeEventType`, `RuntimeEventSensitivity`, `RuntimeCoverageStatus`, `RuntimeCoverageSummary`, `runtimeEvents` Map, `getCoverageSummary`, `CoverageWindow`, coverage window logic in `playwrightRuntime.ts`, `GET /api/runtime/sessions/:id/events`) unless explicitly requested
- Sensitive event detection is Playwright-first and metadata-only — do not store raw field values, passwords, card numbers, CVVs, or any secret in runtime events; `element_hint` is structural metadata only (tag, type, name/id/autocomplete/placeholder — never value)
- Do not claim Aegis runtime event detection proves no out-of-band secrets exist; it proves whether a sensitive event inside the Aegis session was covered by an Aegis-controlled action
- Do not rebuild Delegation Passport v1 (`DelegationPassport` type, `delegationPassportSigning.ts`, `delegation-passports.ts` routes, `delegationPassports` Map, `create_delegation_passport`/`verify_delegation_passport` MCP tools, passport persistence) unless explicitly requested
- Do not claim a Delegation Passport proves the agent has no out-of-band secrets — it attests only to Aegis-covered capability release and controlled runtime behavior; `aegis_coverage_boundary.aegis_does_not_prove_agent_has_no_out_of_band_secrets: true` must remain in every passport
- Do not put raw secrets, passwords, payment card data, secret_refs, ciphertext, or private keys in a Delegation Passport — only aggregate counts, capability booleans, domains, and receipt IDs
- Future website handshake features should consume `passport_jws` from the Delegation Passport — do not build a website handshake without first creating and verifying a passport
- Action Authorization Receipt v1 is **complete** — do not rebuild `ActionAuthorizationReceipt` type, `actionAuthorizationSigning.ts`, `action-authorizations.ts` routes, `actionAuthorizations` Map, the authorization creation in the approve endpoint, or `authorization_context` on `RouteRunReceipt` unless explicitly requested
- `authorization_hash` intentionally excludes `status` and `fulfillment` — this is correct; fulfilled and active authorizations both have valid hashes; do not change the hashing strategy
- Failed executions leave authorization `status: "active"` — do not mark it fulfilled on failure; the action did not complete
- Do not revoke a fulfilled authorization — the action already ran; revoke only applies to `active` authorizations
- `authorization_context` on `RouteRunReceipt` links an execution receipt back to the authorization that permitted it — populate in both success and failure receipt paths
- Action authorization signing requires `AEGIS_RECEIPT_JWS_PRIVATE_JWK` — no unsigned-dev-mode fallback; authorization creation failure in the approve endpoint is non-blocking (logs error, approval proceeds)
- Delegation Trust Profile v1 is **complete** — do not rebuild `DelegationTrustProfile` type, `DelegationTrustTaskCategory`, `DelegationTrustStatus`, `delegation-trust.ts` routes, or `get_delegation_trust_profile` MCP tool unless explicitly requested
- Do not implement generic success-count reputation — trust must be based on sensitive Aegis-covered evidence: fulfilled authorizations, verified signed receipts, covered sensitive workflow events, and KMS custody attestation
- Low-risk browsing, search, or weather tasks do not improve trust for high-risk task categories (login, payment, financial_action, etc.) — trust is task-category-specific
- Payment/travel/financial categories (`purchase`, `payment`, `travel_booking`, `financial_action`) can never reach `trusted_for_category` in v1 — maximum is `proven_limited`; do not change this ceiling unless explicitly requested
- Trust profile is advisory, not a guarantee — every profile carries `not_a_guarantee: true`, `out_of_band_secret_use_not_covered: true`, `based_only_on_aegis_observed_events: true`; do not remove these fields or weaken the limitations block
- Do not include raw receipt JSON, secret_ref values, passwords, private keys, or decrypted credential values in a trust profile response — only aggregate counts, capability booleans, domains, and receipt IDs
- Website Assertion / Handshake v1 is **complete** — do not rebuild `WebsiteTrustAssertion` type, `websiteAssertionSigning.ts`, `website-assertions.ts` routes, `websiteTrustAssertions` Map, `create_website_trust_assertion`, or `verify_website_trust_assertion` MCP tools unless explicitly requested
- `computeDelegationTrustProfile` is now an exported async function in `delegation-trust.ts` — the delegation-trust GET handler calls it; website-assertions.ts calls it too; do not re-inline the logic into the GET handler
- Website assertions require `AEGIS_RECEIPT_JWS_PRIVATE_JWK` — no unsigned-dev-mode fallback; missing keys → 500 `SIGNING_NOT_CONFIGURED`; `verification.assertion_jws` is always a real compact JWS string
- Do not include raw receipt JSON, raw action authorization JSON, secret_ref, devvault:// references, demo_pass values, or private keys in any `WebsiteTrustAssertion` response — aggregate only
- Website Trust Assertions carry no stronger guarantees than Delegation Passports — they summarize Aegis-observed evidence and do not prove the agent has no out-of-band secrets; `limitations.not_a_guarantee: true` must remain in every assertion
- Real Payment / Travel Mock Route v1 is **complete** — do not rebuild `PaymentMethodCapability` type, `paymentMethods` Map, `route_demo_travel_booking_001`, `skill_demo_travel_booking_001`, `safe_literal` Playwright runtime support, or the `/demo-travel` pages unless explicitly requested
- Demo travel route exists at `/demo-travel` (booking form) and `/demo-travel/success` (confirmation); `payment_method_available` is now a live check against the `paymentMethods` Map — not hardcoded `false`
- Do not add raw card numbers, CVV, PAN, or any payment secret to `PaymentMethodCapability` — it is metadata only (`last4`, `label`, `network`, `billing_country`, `capability_ref`)
- Do not claim real payment processing — the travel booking flow is a mock workflow; no real money is processed, no real payment gateway is called
- Travel booking evidence is category-specific — fulfilled `travel_booking` authorizations count toward `travel_booking` trust only; they do NOT improve `payment`, `purchase`, or `financial_action` trust
- `safe_literal` and `enum_selection` value policies in Playwright runtime use `vp.value` directly — no KMS resolution; `pass_field`/`secret_ref` still go through `resolveRouteStepValue`
- Coverage Violation Blocking v1 is **complete** — do not rebuild `RuntimeIntervention`, `RuntimeInterventionType`, `runtimeInterventions` Map, `createRuntimeIntervention`, `mapEventToInterventionType`, violation check in `playwrightRuntime.ts`, or `allLinkedValidReceipts` in `delegation-trust.ts` unless explicitly requested
- Do not mark uncovered sensitive events as covered globally — `not_covered_by_aegis` events must only become `covered_by_aegis` if a coverage window was genuinely opened for them by an Aegis route step
- Do not fulfill authorizations on violation runs — `ActionAuthorizationReceipt.status` must stay `"active"` when `VIOLATION_BLOCKED` error occurs; only the successful completion path calls `status: "fulfilled"`
- Violation receipts are signed and hash-valid, `status: "failed"` — they count as negative evidence via `uncovered_events` in `allLinkedValidReceipts`; they do not count as positive category experience
- Do not claim Aegis blocks every possible sensitive action — Coverage Violation Blocking v1 applies only to observable in-Playwright events; out-of-band attacks, OS-level keyloggers, and other browser processes are not covered
- Violation demo route `route_demo_travel_violation_001` uses `start_url: "http://localhost:3000/demo-travel?violation=1"` which fires an uncovered credential form submit at page load before any coverage window opens; do not change the `?violation=1` flag meaning unless explicitly requested
- Capability Release Gate v1 is **complete** — do not rebuild `RuntimeCapabilityRelease`, `RuntimeCapabilityType`, `runtimeCapabilityReleases` Map, `createRuntimeCapabilityRelease`, `findMatchingCapabilityRelease`, `getRuntimeCapabilityReleasesForRun`, `requiredCapabilityForEvent`, `buildCapabilityReleaseSummary`, `PAYMENT_ACTION_TYPES`, `PAYMENT_INTENT_KEYWORDS`, `isPaymentIntentClick`, capability-first coverage decision in `convertPageEvents`, capability release creation in the fill/click branches of `executeRouteRunWithPlaywright`, or `runtime_capability_releases`/`capability_release_summary` on receipts unless explicitly requested
- Timing windows MUST NOT grant `covered_by_aegis` when `requiredCapabilityForEvent` returns a capability type — the release is the only allow condition for those events; timing windows remain as a fallback only for events with no required capability type
- `unknown_sensitive` high/critical events are not covered by timing windows even when no capability type is required — they are classified as `not_covered_by_aegis` conservatively
- `login_credential` release is created only for `secret_ref` fills (the password), not for `pass_field` fills (the username) — username is not a secret capability
- `payment_method` release is created only for payment-intent click steps (button name matches Pay/Book/Purchase/Submit Payment/Place Order/Confirm Payment/Confirm Booking) in payment/travel routes, and only if a payment method exists for the user in `paymentMethods` Map — if no payment method exists, no release is created and any payment submit fails as `not_covered_by_aegis`
- `capability_ref` for `login_credential` = `resolved.pass_id` (the vault pass ID, e.g., `vp_demo_login_001`) — never `secret_ref`, never the encrypted blob ID, never the decrypted password; for `payment_method` = `payment_method_id` from the `paymentMethods` Map (e.g., `pay_method_demo_001`) — never PAN, CVV, or any payment secret
- `raw_secret_revealed_to_agent: false` on `RuntimeCapabilityRelease` is a TypeScript literal type — always write it as the literal `false`, never through a variable
- Do not fulfill authorizations on missing-capability violations — `ActionAuthorizationReceipt.status` must stay `"active"` when a run fails due to missing capability release
- Do not include raw secrets, passwords, PAN, CVV, private keys, fingerprints, encrypted blobs, or decrypted values in any `RuntimeCapabilityRelease` or `capability_release_summary`
- Sensitive Workflow Observation Mode v1 is **complete** — do not rebuild `RuntimeObservationMode`, `RuntimeObservationActivationReason`, `RuntimeObservationModeState`, `AgentSafeElementKind`, `AgentSafeObservationElement`, `AgentSafeObservationSnapshot`, `runtimeObservationSnapshots` Map, `initialObservationModeState`, `activateProtectedObservationMode`, `getObservationModeState`, `storeObservationSnapshot`, `getLatestObservationSnapshot`, `scanPageForSensitivitySignals`, `buildAgentSafeObservationSnapshot`, `SENSITIVE_PERMISSIONS`, `SENSITIVE_URL_PATTERNS`, `runtime-observations.ts` routes, `get_runtime_observation`/`get_runtime_observation_mode` MCP tools, or `observation_mode_summary` on receipts unless explicitly requested
- Do not activate `protected_observation` globally — it must be triggered only by concrete sensitivity signals (route permissions, URL patterns, or DOM patterns); do not apply it by default to all sessions
- `AgentSafeObservationSnapshot` never contains raw passwords, card numbers, CVV, PAN, SSN, passport data, `secret_ref` values, `devvault://` references, private keys, ciphertext, or fingerprints — sensitive fields always have `value_redacted: true` with `value` omitted; `filled` is a boolean only
- Do not expose raw `.value` from password or sensitive input fields in `page.evaluate()` snapshot code — only `.value.length > 0` boolean for `filled` detection; the actual value must never appear in the returned object
- `page.evaluate()` callbacks in `playwrightRuntime.ts` must use raw JS string IIFEs (not TypeScript arrow functions) — the Node.js tsconfig does not include DOM lib; DOM-only types cause compile errors; match the pattern of `INSTRUMENTATION_SCRIPT` and `scanPageForSensitivitySignals`
- Observation mode does not weaken Capability Release Gate v1 — observation mode controls what agents SEE in snapshots; capability releases control what sensitive actions can PROCEED
- Sensitive fields and buttons have `allowed_actions: ["read", "request_fill"]` or `["read", "request_click"]` — they must go through Aegis route steps; agents cannot directly fill or click sensitive elements
- `observation_mode_summary` on receipts is metadata only — it records what mode was active when the run executed; it does not include snapshots, raw DOM, or field values
- Website Agent-Safety Profile v1 is **complete** — do not rebuild `WebsiteVerificationLevel`, `WebsiteAgentSafetyStatus`, `WebsiteAgentSafetyProfile` types, `website-agent-safety.ts` routes, `computeWebsiteAgentSafetyProfile`, or `get_website_agent_safety_profile` MCP tool unless explicitly requested
- `WebsiteAgentSafetyProfile` is domain-scoped and advisory — it does not claim business verification; `limitations.not_business_verified: true` is always set in v1; do not add signing or JWS to this profile unless explicitly requested
- `computeWebsiteAgentSafetyProfile` uses `getReceiptRepository().listReceipts(MOCK_USER_ID)` filtered by `receipt.domain` — this is a domain-wide query (not delegation-scoped); `MOCK_USER_ID` is correct for v1
- Negative evidence overrides positive in `WebsiteAgentSafetyProfile` — if both clean and violation receipts exist, result is `step_up_required`; do not change this precedence unless explicitly requested
- `secret_exposure_events` in `WebsiteAgentSafetyProfile` uses `r.secret_values_revealed_to_agent` truthiness check from receipts only — not from intervention types; `blocked_sensitive_action_without_capability_release` means Aegis blocked a missing-capability attempt, not that a secret was exposed
- Do not include raw receipt JSON, `secret_ref` values, credential values, `devvault://` references, or private keys in any `WebsiteAgentSafetyProfile` response — aggregate only

Website .well-known Aegis Policy v1 is **complete** — do not rebuild `WebsiteAegisPolicy`, `WebsiteAegisPolicyWorkflow`, `WebsiteAegisPolicyValidationResult`, `WebsitePolicyCompatibilityResult`, `WebsiteAegisAgentAccess` types, `website-aegis-policy.ts` routes, `validateWebsiteAegisPolicy`, `getWebsiteAegisPolicyForDomain`, or `get_website_aegis_policy`/`validate_website_aegis_policy`/`check_website_policy_compatibility` MCP tools unless explicitly requested
- Website Aegis Policy is self-asserted in v1 — do not treat it as business verification; `limitations.self_asserted_policy: true` and `limitations.not_a_guarantee: true` must always be present in any policy response
- Policy alone must not upgrade recommendation to `allow` or `allow_with_approval` in `WebsiteAgentSafetyProfile` — it enriches legibility, constraints, and machine-readable reasons only; observed clean receipt evidence is still required for `allow_with_approval`
- Invalid policy adds `invalid_website_policy` disqualifying signal and results in `step_up_required`, not `deny` — in v1, invalid policy is a caution signal, not proof of fraud or malicious intent
- Valid policy + no receipts → `step_up_required`; valid policy + violation receipts → `step_up_required`; valid policy + clean receipts → `allow_with_approval` (unchanged from pre-policy decision logic)
- Do not include raw secrets, pass IDs, card numbers, CVV, PAN, private keys, or `secret_ref` values in any `WebsiteAegisPolicy` response
- The localhost `.well-known` policy is demo-only — do not enable live internet fetching for non-localhost domains unless explicitly requested; non-localhost returns `POLICY_NOT_AVAILABLE` (404) in v1
- Import direction is one-way: `website-agent-safety.ts` imports from `website-aegis-policy.ts`; do not create a reverse import — that would be circular

External Agent Delegation API v1 is **complete** — do not rebuild `agentApiRoutes`, `agent-api.ts`, or any `/api/agent/v1/*` endpoints unless explicitly requested
- `/api/agent/v1` is the stable public external-agent contract; internal routes (`/api/skills/:skillId/runs`, `/api/route-runs`, etc.) remain for the Aegis product UI
- External agents must not receive raw secrets, `secret_ref` values, KMS envelopes, ciphertext, private keys, raw payment data, or raw identity data via the v1 API
- Agent identity and delegation must come from bearer token lookup against `agentDelegations.token_id` — never from request body
- User approval must remain in the Aegis UI (`/route-run-approvals`); external agents cannot self-approve via `/api/agent/v1`
- `GET /api/agent/v1/runs/:runId/receipts` returns summaries only — excludes `pass_ids_used`, `runtime_capability_releases` (full list), `variables`, `allowed_reason`, `route_trust_tier`, `installed_skill_id`, and `user_id`
- `agent_id` in `ExternalAgentIdentity` is derived from `delegation.agent_name` in v1 — it is not a globally unique durable ID; do not present it as one in docs or product copy
- `jws_present` on receipt summaries reflects whether JWS is stored in Supabase row metadata; in-memory mode always returns `false`
- `examples/external-agent-demo.mjs` is the reference demo script for the v1 API — do not rebuild unless explicitly requested

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
