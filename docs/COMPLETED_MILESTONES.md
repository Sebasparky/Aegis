# Aegis — Completed Milestones Archive

This file archives the implementation history removed from CLAUDE.md for size reasons.
All items below are complete and protected under the do-not-rebuild list in CLAUDE.md.

## Core Guard Loop (demo at http://localhost:3000/demo)
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

## Aegis Rails (working — http://localhost:3000/rails)
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

## Background Auto-Run (Reliable, Opt-In) — validated 2026-05-01
- Extension background service worker watches active tab for low-risk `status=pending` RouteRuns
- Fill values set atomically via native HTMLInputElement setter and verified before proceeding
- Wikipedia search submit uses `findBestSearchInput` + `form.requestSubmit()`
- `background.js` verifies final tab URL/title before marking a run `completed`
- Validated: Wisconsin → `rrreceipt_d9a6ca5ae205`, Alan Turing → `rrreceipt_8f11681c5ab1`

## External Agent Integration / MCP Tool Server — validated 2026-05-01
- `examples/aegis-tool-server.mjs` exposes `discover_installed_skills`, `request_skill_run`, `get_route_run_status`, `get_route_run_receipt` as MCP tools
- First successful end-to-end test: Claude Code discovered Wikipedia Search, requested RouteRun for query Wisconsin, user started run via extension, polled to completion, read receipt `rrreceipt_20b593b94de7`
- Connect via: `claude mcp add aegis -- node /path/to/aegis-tool-server.mjs`

## Agent-Runnable Workflow Recipe Path — validated 2026-05-01
- `execution_mode="agent_runnable"` skills return a route recipe via `get_agent_runnable_workflow`
- Agent executes the recipe in its own browser session; no RouteRun, no extension handoff
- Wikipedia Search demonstrated end-to-end (Claude Code + Playwright)

## Controlled Sensitive Execution Path — validated 2026-05-01
- `execution_mode="aegis_controlled"` skills refuse `get_agent_runnable_workflow` with `NOT_AGENT_RUNNABLE`
- Runs requiring sensitive permissions create `pending_approval`
- Extension auto-runs only on matching route context (domain + `url_match`)
- Demo Login validated at `/demo-login/success` (receipt `rrreceipt_d5614360e907`, run `run_054ca6e8022b`)
- Demo Login uses fake seeded credentials only — real credential custody is not implemented

## Secret Vault / Pass Custody v1 — implemented 2026-05-01
- `AegisVaultPass` holds credential metadata
- Demo Login route steps use `pass_field`/`secret_ref` value policy types (raw password removed from route)
- `POST /api/route-runs/:runId/resolve-value` resolves credentials only during approved running RouteRuns
- Receipts record `credential_used`, `pass_ids_used`, `secret_values_revealed_to_agent: false`

## Secret Vault UI v1 — implemented 2026-05-01
- `/passes` page has a "Credential Vault" section for creating and listing `login_password` bundles
- API at `/api/vault-passes` (GET/POST/DELETE). Password never returned after creation
- `has_password: false` if encrypted blob absent (pass created before KMS migration — re-enter password)

## Natural-Language Credential Selection v1 — implemented 2026-05-01
- `pass_overrides?: Record<string, string>` added to `RouteRun` type
- `list_vault_passes` MCP tool added; `request_skill_run` updated to accept `pass_overrides`
- Agents can select a user-named credential without opening the Passes UI

## Controlled Tab Launch — implemented 2026-05-01
- `start_url?: string` added to `AegisRoute` type and seed for `route_demo_login_001`
- Extension `background.js` has `maybeAutoLaunchApprovedRun()` function

## Route-to-Pass Binding v1 — implemented 2026-05-01
- `RoutePassBinding` type + `routePassBindings` map (persisted)
- `/api/route-pass-bindings` GET/POST/DELETE
- "Credential Assignments" UI on `/passes` page

## KMS Abstraction v1 — implemented 2026-05-02
- `apps/api/src/lib/kms.ts` defines `KmsProvider` interface (`local_dev` provider uses AES-256-GCM)
- `encryptedSecretVault` replaces `devSecretVault` (deprecated)
- `seedDefaultData/loadStore/resetStoreForDemo` are now async

## Immutable + Signed Receipts v1 — implemented 2026-05-02
- `receipt_hash` covers `{ previous_receipt_hash, receipt_json }` (SHA-256 chain)
- `receipt_jws` is an EdDSA/Ed25519 CompactSign JWS over metadata only
- Supabase receipts use INSERT; append-only DB trigger blocks UPDATE/DELETE
- Verify endpoint: `GET /api/route-run-receipts/:receiptId/verify`

## Playwright Runtime v1 — implemented 2026-05-02
- Agents execute approved controlled runs via `POST /api/runtime/route-runs/:runId/playwright/start` or MCP tool `start_playwright_route_run`
- Aegis launches isolated headless Chromium, resolves credentials via KMS vault, emits signed receipts with `execution_surface: "aegis_playwright"`

## Sensitive Workflow Detection v1 — implemented 2026-05-02
- Events classified as `covered_by_aegis`, `not_covered_by_aegis`, or `unknown` using coverage windows
- Metadata only — no field values stored
- `coverage_summary` attached to session and receipt
- Events accessible at `GET /api/runtime/sessions/:id/events`

## Delegation Passport v1 — implemented 2026-05-02
- Agents create and verify a signed Delegation Passport documenting human subject, agent subject, collar-backed action limits, KMS custody model, Aegis coverage boundary, and receipt-backed evidence
- MCP tools: `create_delegation_passport`, `verify_delegation_passport`

## Auto-Start Playwright Runs — implemented 2026-05-02
- Approval of an `aegis_controlled` run triggers Playwright execution via fire-and-forget
- `claimed_execution_surface` on `RouteRun` determines if extension sees the run

## Cloud KMS Provider v1 — implemented 2026-05-03
- `CloudKmsStubProvider` throws `CLOUD_KMS_NOT_IMPLEMENTED` on any encrypt/decrypt — never falls back
- `KmsAuditEvent` and `KmsOperationType` added to `packages/types/src/index.ts`
- `apps/api/src/lib/kmsAudit.ts` records every KMS operation (metadata only)

## Supabase Persistence v1 — implemented 2026-05-03
- `AEGIS_PERSISTENCE_PROVIDER=supabase` enables durable storage for vault passes, encrypted secrets, and receipts
- `getVaultRepository()` / `getReceiptRepository()` repository pattern

## Action Authorization Receipt v1 — implemented 2026-05-03
- `ActionAuthorizationReceipt` created in the approve endpoint
- `authorization_context` on `RouteRunReceipt` links execution receipt back to authorization
- `authorization_hash` covers everything except `status` and `fulfillment`

## Delegation Trust Profile v1 — implemented 2026-05-03
- `DelegationTrustProfile` type, task-specific trust status per category
- `GET /api/delegations/:id/trust-profile`, MCP tool `get_delegation_trust_profile`

## Website Assertion / Handshake v1 — implemented 2026-05-03
- `POST /api/website-assertions` creates a signed `WebsiteTrustAssertion` (allow / allow_with_approval / step_up_required / deny) with EdDSA JWS
- `GET /api/website-assertions/:id/verify` recomputes hash, verifies JWS

## Real Payment / Travel Mock Route v1 — implemented 2026-05-03
- Demo travel booking route at `/demo-travel` and `/demo-travel/success`
- `PaymentMethodCapability` Map holds metadata only (no PAN, no CVV)
- Travel booking authorization receipts carry `action_type: "travel_booking"`, `max_amount_usd: 500`

## Coverage Violation Blocking v1 — implemented 2026-05-03
- `RuntimeIntervention` type; `runtimeInterventions` Map
- Playwright runtime checks for `not_covered_by_aegis` events; marks run `failed` with `VIOLATION_BLOCKED`
- Signed failed receipt with `runtime_interventions[]`; authorization left `active`
- Violation demo: `skill_demo_travel_violation_001` / `route_demo_travel_violation_001` at `/demo-travel?violation=1`

## Capability Release Gate v1 — implemented 2026-05-03
- `RuntimeCapabilityRelease` type tracks explicit Aegis capability release per run
- `login_credential` releases created on `secret_ref` fills only
- `payment_method` releases created for payment-intent click steps only
- Receipts include `runtime_capability_releases` and `capability_release_summary` (metadata only)

## Sensitive Workflow Observation Mode v1 — implemented 2026-05-03
- `open_observation` mode returns minimal summary; `protected_observation` mode returns `AgentSafeObservationSnapshot`
- Escalation triggered only by concrete sensitivity signals
- `observation_mode_summary` on receipts

## Website Agent-Safety Profile v1 — implemented 2026-05-03
- `GET /api/website-agent-safety/:domain/profile`, MCP tool `get_website_agent_safety_profile`
- Domain-scoped advisory: negative evidence (violation receipts) overrides positive

## Website .well-known Aegis Policy v1 — implemented 2026-05-03
- `GET /.well-known/aegis-policy.json` on localhost served from `apps/api`
- `GET /api/website-aegis-policy/:domain`, validate, compatibility check
- MCP tools: `get_website_aegis_policy`, `validate_website_aegis_policy`, `check_website_policy_compatibility`

## External Agent Delegation API v1 — implemented 2026-05-03
- Public `/api/agent/v1` namespace
- Endpoints: `POST /runs`, `GET /runs/:runId`, `GET /runs/:runId/receipts`, `GET /skills`, `POST /observation-dry-runs`, `POST/GET /authenticated-sessions/*`
- `examples/external-agent-demo.mjs` is the reference demo

## Agent Approval Context Panel v1 — implemented 2026-05-03
- `GET /api/route-runs/:runId/approval-context` returns `ApprovalManifest` with safe_literal step values, collar data, payment method metadata
- Redesigned `/route-run-approvals` panel shows spend limits, step details, and constraint warnings

## Spending Limit Step-Up v1 — implemented 2026-05-03
- `POST /api/route-runs/:runId/spending-step-up` creates per-run spending override (does not mutate collar)
- UI blocks normal approve when `manifest.approval_blocked === true`

## Real Website Observation Dry Run v1 — implemented 2026-05-04
- `POST /api/agent/v1/observation-dry-runs` for observe-only inspection of any URL
- Open mode returns minimal summary; protected mode returns redacted `AgentSafeObservationSnapshot`
- Strictly no clicks, fills, form submission, KMS calls, or route execution
- `examples/real-website-observation-dry-run.mjs` is the reference demo

## Authenticated Session Boundary v1 — implemented 2026-05-04
- `POST /api/agent/v1/authenticated-sessions/login-request` → `pending_approval`
- User approves in `/route-run-approvals` → Aegis logs in via isolated headless Playwright
- Agent polls to `authenticated`, then observes/navigates via safe endpoints
- Agent never receives cookies, storage, Playwright storageState, or the password
- Challenge detection (2FA, CAPTCHA, passkey) → `manual_step_required` — no bypass
- Same-domain navigation only; KMS audit event recorded with `run_id: "authsession:<sessionId>"`
- `examples/authenticated-session-boundary-demo.mjs` is the reference demo
