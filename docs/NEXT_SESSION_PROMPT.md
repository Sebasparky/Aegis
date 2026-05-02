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
>
> **Also: do NOT rebuild Secret Vault / Pass Custody v1. It is complete. Do not re-implement `AegisVaultPass`, `devSecretVault`, `resolve-value` endpoint, or the `pass_field`/`secret_ref` value policy types.**
>
> **Also: do NOT rebuild KMS Abstraction v1. `encryptedSecretVault`, `LocalDevKmsProvider`, `EncryptedSecretBlob`, `getKmsProvider`, and async `seedDefaultData/loadStore/resetStoreForDemo` are complete. Do not re-implement the old plaintext `devSecretVault` storage. Use `encryptedSecretVault + kms.decryptSecret()` for all password resolution.**
>
> **Also: do NOT rebuild Supabase Persistence v1. `getVaultRepository()`, `getReceiptRepository()`, `AEGIS_PERSISTENCE_PROVIDER` feature flag, `lib/supabase.ts`, `lib/receiptHash.ts`, `docs/supabase/001_vault_and_receipts.sql`, and `seed-supabase-demo.mjs` are complete. Do not re-implement direct Map access in vault-passes.ts or receipts.ts.**
>
> **Also: do NOT rebuild credential session context binding v1. It is complete. Do not re-implement `target_url`/`url_match` on `CredentialUseSession`, `doesTabMatchCredentialSession` in the extension, or `session_context` in the fill-request API response.**
>
> **Also: do NOT rebuild Immutable + Signed Receipts v1. It is complete. Do not re-implement `receiptSigning.ts`, `generate-receipt-keypair.mjs`, `002_signed_immutable_receipts.sql`, `verifyReceipt`, or `GET /api/route-run-receipts/:receiptId/verify`.**

---

## Completed Increments (as of 2026-05-02)

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

### Secret Vault / Pass Custody v1
- `AegisVaultPass` — credential metadata type in `packages/types/src/index.ts`; separate from the existing `AegisPass` (agent auth token type)
- `aegisVaultPasses` — persisted in-memory Map in `apps/api/src/store/index.ts`; included in persistence
- `devSecretVault` — **deprecated**; replaced by `encryptedSecretVault + KmsProvider`. See KMS Abstraction v1 below.
- Demo vault pass seeded: `pass_vault_demo_login_001` (domain: localhost, username: demo_user, secret_ref: `devvault://demo-login-password`)
- Demo Login route steps now use `value_policy.type: "pass_field"` (username) and `"secret_ref"` (password) — raw credential removed from route
- `POST /api/route-runs/:runId/resolve-value` — extension-only endpoint; resolves pass field or secret during an approved running RouteRun; validates run state, domain match, approval, and execution mode; updates run with `credential_used`, `pass_ids_used`, `secret_values_revealed_to_agent`
- `replay.js` — `resolveFillValue` is now async; calls resolve-value API for pass/secret steps; toast shows "filled secure value" instead of the actual value; error message is redacted for secret fills
- Receipt includes `credential_used: true`, `pass_ids_used`, `secret_values_revealed_to_agent: false` when a pass was used
- Dev prototype only — not real Gmail/bank credential custody
- **Implemented 2026-05-01**
- Do not rebuild unless explicitly requested

### KMS Abstraction v1
- `apps/api/src/lib/kms.ts` — new module; `KmsProvider` interface, `KmsContext`, `EncryptedSecretBlob`, `getKmsProvider()` factory
- `local_dev` provider — AES-256-GCM, 96-bit random nonce, 128-bit GCM auth tag, AAD = `user_id|pass_id|domain|purpose`; key from `AEGIS_LOCAL_KMS_KEY_B64` (must be 32-byte base64); lazy key read (not at module load)
- `encryptedSecretVault: Map<string, EncryptedSecretBlob>` added to `store/index.ts`; persisted as `encryptedSecretVaultEntries` (ciphertext only — never plaintext)
- `devSecretVault` deprecated; no longer written to or read from in any route handler
- `seedDefaultData()`, `loadStore()`, `resetStoreForDemo()` are now async (return `Promise<void>`)
- `loadStore()` includes self-healing: if demo pass exists but encrypted secret is missing, encrypts it automatically (handles post-`seed:demo` startup without manual intervention)
- `vault-passes.ts` POST encrypts via `kms.encryptSecret()`; DELETE removes from `encryptedSecretVault`; `has_password` checks `encryptedSecretVault.has()`
- `route-runs.ts` and `credential-sessions.ts` resolve-value use `kms.decryptSecret()`; error codes: `SECRET_NOT_AVAILABLE` (blob missing), `SECRET_DECRYPT_FAILED` (wrong key or tampered data)
- Dotenv loaded at top of `apps/api/src/index.ts` from repo root `.env` before `loadStore()`
- To swap to cloud KMS: extend `KmsProviderName`, add a provider class, add a case in `getKmsProvider()`; vault APIs and resolve-value code unchanged
- **Implemented 2026-05-02**
- Do not rebuild unless explicitly requested

### Route-to-Pass Binding v1
- `RoutePassBinding` type in `packages/types/src/index.ts`
- `routePassBindings` Map in `apps/api/src/store/index.ts`; key `${user_id}:${route_id}:login_password` for upsert; persisted in `aegis-store.json`
- `GET /api/route-pass-bindings[?route_id=]` — list bindings; `POST` — upsert binding (validates pass ownership, kind, domain match); `DELETE` — remove binding (restores route default)
- `resolve-value` checks binding first: `routePassBindings.get(user_id:route_id:login_password)`, uses `binding.pass_id` if present, falls back to `vp.pass_id` from route step
- Receipt `pass_ids_used` reflects whichever pass was actually used (bound or default)
- API client: `listRoutePassBindings`, `setRoutePassBinding`, `clearRoutePassBinding` in `apps/web/src/lib/api.ts`
- "Credential Assignments" section on `/passes` page: shows all `aegis_controlled` routes, per-route dropdown of domain-matching `login_password` passes, Save button; disabled when not dirty; clears binding on `— route default —` selection
- Do not rebuild unless explicitly requested

### Secret Vault UI v1
- Passes page (`/passes`) extended with a "Credential Vault" section for managing `login_password` credential bundles
- `GET /api/vault-passes` — lists `AegisVaultPass` metadata; never returns password; includes `has_password: true/false`
- `POST /api/vault-passes` — creates `AegisVaultPass` + encrypts secret into `encryptedSecretVault` via KMS; validates label/domain/username/password; returns metadata only
- `DELETE /api/vault-passes/:passId` — removes pass metadata and encrypted blob from `encryptedSecretVault`
- Route: `apps/api/src/routes/vault-passes.ts`; registered in `apps/api/src/index.ts`
- API client: `listVaultPasses`, `createVaultPass`, `deleteVaultPass` in `apps/web/src/lib/api.ts`
- `login_password` means username + password bundle; username may be shown; password is masked as `••••••••` and never returned after creation
- Seeded demo pass (`pass_vault_demo_login_001`) shows "seeded demo" badge in the UI
- `has_password: false` shown when the encrypted blob is absent (e.g., pass created before KMS migration — re-enter password)
- Dev-only warning prominently shown; not production-grade encryption; no real credentials
- Do not rebuild unless explicitly requested

### Natural-Language Credential Selection v1
- `pass_overrides?: Record<string, string>` added to `RouteRun` interface in `packages/types/src/index.ts`; key = purpose (`"login_password"`), value = pass_id
- Validated at POST `/api/skills/:skillId/runs` before run is created: purpose supported, pass exists, user owns it, `pass.kind === purpose`, `pass.domain === route.domain`, `encryptedSecretVault.has(pass.secret_ref)`; returns `400 INVALID_PASS_OVERRIDE` on failure
- Stored on both `pending` and `pending_approval` run objects
- `resolve-value` precedence updated: (1) `run.pass_overrides?.["login_password"]`, (2) `RoutePassBinding`, (3) route step `vp.pass_id`
- Receipt `pass_ids_used` reflects the actual pass used (override, binding, or default)
- MCP tool `list_vault_passes` in `examples/aegis-tool-server.mjs`: `GET /api/vault-passes` + client-side filter by `domain`/`kind`/`query`; returns `pass_id`, `label`, `kind`, `domain`, `username`, `has_password` only — never passwords
- `request_skill_run` MCP tool updated to accept and forward `pass_overrides` to the API
- Persistent route-pass bindings remain intact; per-run override is additive and non-destructive
- Do not rebuild unless explicitly requested

### Controlled Tab Launch for Approved Runs
- `start_url?: string` added to `AegisRoute` type in `packages/types/src/index.ts`
- `route_demo_login_001` seeded with `start_url: "http://localhost:3000/demo-login"` in `apps/api/scripts/seed-demo-data.mjs`
- `start_url` included in `route_summary` from GET `/api/route-runs` (route-runs.ts)
- `waitForTabToMatchRoute(tabId, route, timeoutMs)` — polls 300ms intervals up to timeoutMs (5s default) for tab to reach `complete` status and pass `doesTabMatchRoute`
- `maybeAutoLaunchApprovedRun()` — called on every alarm poll after `maybeAutoRunForTab`; finds exactly one approved pending run with a `start_url`; uses an existing matching tab if found, otherwise creates a new tab at `start_url`; calls `markAutoStarted` BEFORE `chrome.tabs.create` to prevent `onUpdated` double-execution; only acts on `pending` runs with `approved_at` — never touches `pending_approval` runs
- Safety invariants preserved: exactly-one guard, `aegisAutoStartedRunIds` dedup, url_match enforcement, `pending_approval` untouched, secrets resolve only after `running` status

### Credential Session Context Binding v1
- `target_url?: string` and `url_match?: { hostname, path_prefix? }` added to `CredentialUseSession` in `apps/api/src/store/index.ts`
- `POST /api/credential-sessions` accepts optional `target_url`; parses and validates hostname against `domain`; stores both `target_url` and derived `url_match`; returns `400 INVALID_TARGET_URL` or `400 TARGET_URL_DOMAIN_MISMATCH` on bad input
- `GET /api/credential-fill-requests` response now includes `session_context: { target_url, url_match }` per request — no secrets
- `doesTabMatchCredentialSession(tabUrl, fillReq)` helper in `apps/extension/background.js` checks hostname + optional path_prefix
- `maybeProcessCredentialFills` guards before `resolve-value`: if active tab doesn't match `url_match`, request stays pending for next alarm tick; secret is never resolved on wrong page
- MCP `start_credential_session` tool accepts `target_url`; `plan_aegis_action` notes `target_url` in `credential_session` path; suggests `"http://localhost:3000/demo-login"` for localhost tasks
- `docs/AGENT_INTEGRATION_CONTRACT.md` updated with "Credential Session Context Binding" section
- **Implemented 2026-05-02**
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

### Supabase Persistence v1 — vault passes, encrypted secrets, receipts

**Completed 2026-05-02.** `AEGIS_PERSISTENCE_PROVIDER=supabase` activates durable storage for:
- `aegis_vault_passes` — vault pass metadata
- `aegis_encrypted_secrets` — KMS-encrypted blobs (ciphertext only, no plaintext)
- `aegis_receipts` — route run receipts with `receipt_json` JSONB + `receipt_hash` SHA-256

Implementation:
- `apps/api/src/lib/persistenceProvider.ts` — feature flag
- `apps/api/src/lib/supabase.ts` — service-role admin client (apps/api only)
- `apps/api/src/lib/receiptHash.ts` — stable JSON SHA-256 fingerprint
- `apps/api/src/repositories/vaultRepository.ts` — interface + local + Supabase impls
- `apps/api/src/repositories/receiptRepository.ts` — interface + local + Supabase impls
- `docs/supabase/001_vault_and_receipts.sql` — schema migration (apply manually)
- `apps/api/scripts/seed-supabase-demo.mjs` — Supabase demo seed script

Supabase vault repository dual-writes to local Maps as a temporary bridge so non-migrated routes (credential-sessions.ts, route-runs.ts pass validation) continue working. Long-term: all vault/secret reads should migrate to repository-backed access.

Local mode (`AEGIS_PERSISTENCE_PROVIDER=local`, the default) is unchanged.

Do not rebuild unless explicitly requested.

### Immutable + Signed Receipts v1 — hash chain + JWS signatures

**Completed 2026-05-02.** Receipts are now tamper-evident and cryptographically signed.

- `receipt_hash` covers `{ previous_receipt_hash, receipt_json }` (SHA-256, stable sorted JSON)
- `previous_receipt_hash` links each receipt to the previous one for the same user
- `receipt_jws` is an EdDSA/Ed25519 CompactSign JWS over `{ typ, receipt_id, receipt_hash, previous_receipt_hash, issuer, issued_at }` — no secrets in the payload
- Supabase receipts use INSERT (not upsert) — append-only enforced by DB trigger
- Verify endpoint: `GET /api/route-run-receipts/:receiptId/verify`

Implementation:
- `apps/api/src/lib/receiptHash.ts` — updated to accept `previousReceiptHash`
- `apps/api/src/lib/receiptSigning.ts` — `signReceiptJws`, `verifyReceiptJws`, `UnsignedDevModeError`
- `apps/api/src/repositories/receiptRepository.ts` — `ReceiptVerificationResult`, `verifyReceipt`, hash chain + JWS in `createReceipt`
- `apps/api/src/routes/receipts.ts` — verify endpoint
- `docs/supabase/002_signed_immutable_receipts.sql` — columns + indexes + append-only triggers
- `apps/api/scripts/generate-receipt-keypair.mjs` — prints Ed25519 JWK pair to stdout

Key env vars:
- `AEGIS_RECEIPT_ISSUER` — defaults to `"aegis-dev"`
- `AEGIS_RECEIPT_JWS_PRIVATE_JWK` — EdDSA private key JWK (generate with `npm run generate:receipt-keypair`)
- `AEGIS_RECEIPT_JWS_PUBLIC_JWK` — EdDSA public key JWK
- `AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV=true` — allow unsigned receipts (Supabase mode dev opt-in; local mode always allows unsigned)

Local mode: signing is best-effort (all signing errors swallowed). `valid` is based on hash integrity only when unsigned.

Do not rebuild unless explicitly requested.

### Persistence — remaining routes (future)

The following are still in-memory only: route runs (active state), credential sessions, skills, delegations, routes, marketplace, reputation, users. Migrate to Supabase in a future session when explicitly requested.

Constraints:
- All existing API routes must behave identically after migration.
- Do not store raw secrets, card numbers, CVVs, or passwords.
- Do not add auth before persistence is complete.
- Preserve the /demo flow end-to-end.
