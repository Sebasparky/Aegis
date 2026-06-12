# NEXT_SESSION_PROMPT.md

Dispatch document for future Claude/Codex sessions on the Aegis project.  
Read this before starting any new session. Update it when the baseline changes.

---

## Antigen Runtime Flag Diagnostics v1 (2026-06-11)

Smoke runs kept losing time because `ANTIGEN_*` flags were set in the adapter/MCP shell
while the **API process** (`apps/api`, port 4000) ran without them — click verification,
surface resolution, and pointer fast mode silently looked inactive. To make the API
process's effective flags observable:

- **Startup log:** `apps/api` prints one sanitized line on boot, e.g.
  `[AntigenRuntimeFlags] click_verify=true active_surfaces=true surface_resolve=true logical_recovery=true pointer_timing=fast browser_trace=true timing_debug=true require_antigen_tools=false headless=false cdp_port_configured=true`
- **Diagnostic endpoint:** `GET /api/runtime/status` (dev/local only — **404 in production**)
  returns `{ ok, service, environment, pid, uptime_seconds, antigen: {...flags} }`.

```bash
# Confirm the flags the API process actually has:
curl -s http://localhost:4000/api/runtime/status | jq .
# Basic liveness:
curl -s http://localhost:4000/ | jq .
```

Allowlist-only by construction (`getAntigenRuntimeStatus()` in
`apps/api/src/runtime/antigenRuntimeFlags.ts`) — no `process.env` dump; `cdp_port_configured`
is a boolean, never the CDP URL; no secrets/tokens/cookies/vault/KMS. **Set Antigen flags in
the same shell that starts `apps/api`** — that was the source of the confusion.

**Update (2026-06-11, post-IKEA-payment-smoke):** the live smoke hit this exact failure
mode again — `post_fill_state` was absent from both fill execute responses because
`ANTIGEN_FILL_STATE` was never set on the API process (the wiring itself was complete and
correct; happy-path tests now pin it in `payment-card-fill.test.ts` /
`profile-field-fill.test.ts`, the adapter pass-through in `withPostFillSummary`, and
`runtime-status.test.ts` asserts `fill_state` reporting). **Step 0 — `curl -s
localhost:4000/api/runtime/status | jq .antigen` with captured output — is now a mandatory
hard gate before any smoke is recorded as operator-verified.** The QA doc's API start
snippet and env table now include `ANTIGEN_FILL_STATE`, `ANTIGEN_ACTIVE_SURFACES`,
`ANTIGEN_CLICK_VERIFY`, `ANTIGEN_SURFACE_RESOLVE`, `ANTIGEN_LOGICAL_REF_RECOVERY` as
API-side rows. Same smoke's second defect — cardholder_name `CDP evaluate (focus):
TypeError: Illegal invocation` — was a non-fillable floating-label resolution handed to the
protected fill primitive; fixed by the fail-closed tag gate + tag-aware native setter in
`protectedRealisticFill.ts` and the hardened `buildRefSelectorExpr` (label association,
bounded ancestor walk, point containment, null fail-closed) in `paymentCardFill.ts`; proven
in a real-Chromium integration test (`payment-card-fill-browser.integration.test.ts`,
floating-label fixture). See `docs/dev/antigen-browser-qa.md` → "Next QA milestone —
focused payment-stage smoke" for the re-verification recipe and the 4/4 redaction metric.

---

## Email OTP Delivery v1 Completed (2026-05-25)

Resend delivery is implemented and working for email ownership verification.

- Verified sending domain: `verify.antigenlabs.ai`
- Sender: `Antigen <noreply@verify.antigenlabs.ai>`
- Env vars: `EMAIL_DELIVERY_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM="Antigen <noreply@verify.antigenlabs.ai>"`
- `email_otp` is the real provider used by `/verify` for email ownership verification.
- `local_email` remains the dev console fallback (used when `EMAIL_DELIVERY_PROVIDER` is not `resend`).
- `mock_email` is the test/mock provider; returns a card immediately without sending any email.
- `VerificationCard` stores `email_domain` only — full email addresses must never be persisted in cards or returned to the frontend or agents.
- Raw OTP is never persisted and never returned in any API response; only a SHA-256 hash is stored temporarily for session validation. After verification completes, neither the full email nor the OTP hash is retained.
- Abuse controls: 3 sends per 15-minute window, 60-second resend cooldown, 5 failed code attempts per session.
- Google OAuth and inbound email receiving are not implemented in v1.
- Do not rebuild `email_otp` or `local_email` providers unless explicitly requested.
- Next UX work: resend code button, countdown timer, change email link, success state, clearer explanation of what email-domain verification proves and what agents can see.

---

## Two-Approval Payment Smoke Test Checkpoint (2026-05-25)

Full end-to-end smoke test passed with these IDs: card fill auth `pca_9d6b8da0b503`, purchase confirmation auth `pconf_7e523579327b`, purchase handoff `pchoff_8c03eace9499`.

**Critical invariant confirmed:** Always bind payment handoffs to the active runtime `browser_session_id` from `get_runtime_browser_endpoint`.

- Missing `browser_session_id` on `request_payment_card_fill` was the initial failure cause — CDP targeted the wrong port and returned `element not found` even with correct selectors.
- Fix: call `get_runtime_browser_endpoint`, pass `browser_runtime_id` as `browser_session_id` in `request_payment_card_fill`, `request_purchase_confirmation`, and (if needed) `execute_purchase_confirmation_handoff`.
- `purchase_not_authorized: true` on all card fill responses — verified.
- `raw_values_revealed_to_agent: false` throughout — verified.
- Card fills stayed on `/stripe-checkout`; purchase confirmation navigated to `/stripe-confirmation` only after separate user approval — verified.

See `docs/PAYMENT_CARD_STEP_HANDOFF.md` for updated smoke test instructions and the new **Runtime Binding Requirement** section.

---

## Verification System v1 Direction (2026-05-23)

Architecture designed in `docs/VERIFICATION_ARCHITECTURE.md`. No implementation yet — types, routes, and UI are all pending. First increment is types + store Maps + signing helpers. The design is provider-agnostic: Antigen orchestrates verification via a `VerificationProvider` interface; v1 uses mock providers only (email via existing challenge relay, student, gov ID stubs). Core types: `VerificationCard` (signed EdDSA JWS, same pattern as `DelegationPassport`), `VerifiedClaim` (normalized — no raw documents), `DisclosureReceipt` (immutable audit of what was shared and to whom). Scoped disclosure uses the existing approval inbox. `raw_document_revealed_to_agent: false` is a literal on all agent-facing responses. Completed gov ID / email verification updates `DelegationPassport.human_subject.identity_level`. Sensitive Evidence Vault (encrypted raw document custody) is post-launch and out of scope for v1.

---

## Skills / Rails Checkpoint (2026-05-23)

Full audit in `docs/SKILLS_RAILS_AUDIT.md`. Most of the Skills/Rails/Marketplace system is a working prototype:

- Route recording, compilation, verification, 6-tier trust hierarchy ✓
- Marketplace review queue → skill publication → install/uninstall ✓
- `aegis_controlled` RouteRun lifecycle (create → approve → Playwright → receipt) ✓
- Approval inbox, spending limits, step-up flow ✓
- MCP tools: `discover_installed_skills`, `get_agent_runnable_workflow`, `request_skill_run`, `get_route_run_status`, `get_route_run_receipt`, `start_playwright_route_run` ✓
- UI pages: /rails, /marketplace, /skill-library, /marketplace-review, /route-run-approvals ✓

**Identified gap:** `agent_runnable` skill runs are orphaned. The run lifecycle endpoints (`start`, `complete`, `fail`) exist in `route-runs.ts` but have no MCP wrappers. Agent can discover a skill and get the recipe but cannot close the receipt loop. `aegis_controlled` flows work; `agent_runnable` flows do not generate receipts.

**Recommended next milestone: Agent-Runnable Skill Run Lifecycle v1**

Add three MCP tools:
- `start_skill_run({ run_id })` → transitions `pending → running`
- `complete_skill_run({ run_id, browser_session_id? })` → transitions `running → completed`, generates receipt
- `fail_skill_run({ run_id, error, browser_session_id? })` → transitions `running → failed`, generates receipt

Add `task_browser_session_id?: string` to `RouteRun` and `RouteRunReceipt` types.

Files: `aegis-tool-server.mjs`, `routes/route-runs.ts`, `store/index.ts`, `packages/types/src/index.ts`.

Do not rebuild: route recording, route verification, skills marketplace, existing MCP tools, approval flow, Playwright runtime, payment methods, credential step handoff, or local runtime browser endpoint.

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
> **Also: do NOT rebuild Real Website Observation Dry Run v1. `runObservationDryRun`, `observationDryRun.ts`, `agentSafeObservation.ts` (shared helpers), `POST /api/agent/v1/observation-dry-runs`, and `examples/real-website-observation-dry-run.mjs` are complete. Do not add clicks, typing, form submit, credential fill, KMS decrypt, or route execution to observation dry runs. Do not escalate to protected_observation globally — only on task intent, URL patterns, or DOM signals. Do not rebuild the shared helper extraction unless explicitly requested.**
>
> **Also: do NOT rebuild Cloud KMS Provider v1. `CloudKmsStubProvider`, `kmsAudit.ts`, `kms-audit.ts` route, and KMS audit logging in `vault-passes.ts`/`secretResolution.ts` are complete. Do not remove `cloud_kms_stub` from `KmsProviderName`. Do not expose plaintext, ciphertext, nonce, key material, or secret_ref in `KmsAuditEvent` responses.**
>
> **Also: do NOT rebuild Supabase Persistence v1. `getVaultRepository()`, `getReceiptRepository()`, `AEGIS_PERSISTENCE_PROVIDER` feature flag, `lib/supabase.ts`, `lib/receiptHash.ts`, `docs/supabase/001_vault_and_receipts.sql`, and `seed-supabase-demo.mjs` are complete. Do not re-implement direct Map access in vault-passes.ts or receipts.ts.**
>
> **Also: do NOT rebuild credential session context binding v1. It is complete. Do not re-implement `target_url`/`url_match` on `CredentialUseSession`, `doesTabMatchCredentialSession` in the extension, or `session_context` in the fill-request API response.**
>
> **Also: do NOT rebuild Immutable + Signed Receipts v1. It is complete. Do not re-implement `receiptSigning.ts`, `generate-receipt-keypair.mjs`, `002_signed_immutable_receipts.sql`, `verifyReceipt`, or `GET /api/route-run-receipts/:receiptId/verify`.**
>
> **Also: do NOT rebuild Playwright Runtime v1. It is complete. Do not re-implement `aegisRuntime.ts`, `playwrightRuntime.ts`, `secretResolution.ts`, `runtime-sessions.ts`, `executeRouteRunWithPlaywright`, `start_playwright_route_run` MCP tool, or `AegisExecutionSurface`. Do not assume a user-opened browser tab is required for autonomous agent flows — use `POST /api/runtime/route-runs/:runId/playwright/start` instead.**
>
> **Also: do NOT rebuild Execution Surface Recenter v1. It is complete. Do not rewrite MCP tool descriptions, `plan_aegis_action` post-approval fields, README Execution Surfaces section, or contract architecture note to be extension-first. `aegis_playwright` is the primary autonomous-agent execution surface. Chrome extension is optional local/debug/recording companion.**
>
> **Also: do NOT rebuild Sensitive Workflow Detection v1. It is complete. Do not re-implement `RuntimeEvent`, `RuntimeEventType`, `RuntimeEventSensitivity`, `RuntimeCoverageStatus`, `RuntimeCoverageSummary`, `runtimeEvents` Map, `getCoverageSummary`, coverage window logic in `playwrightRuntime.ts`, or `GET /api/runtime/sessions/:id/events`. Detection is metadata-only — never store field values.**
>
> **Also: do NOT rebuild Auto-start Playwright Runs v1. It is complete. Do not re-implement `claimed_execution_surface` on `RouteRun`, the fire-and-forget Playwright auto-start in the approval endpoint, or the `isEligibleForBackgroundAutoRun` guard for `claimed_execution_surface` in the extension. Approval of an `aegis_controlled` run automatically triggers Playwright — do not instruct the agent to call `start_playwright_route_run` after approval unless the run remains pending (fallback only).**
>
> **Also: do NOT rebuild Delegation Passport v1. It is complete. Do not re-implement `DelegationPassport` type, `delegationPassportSigning.ts`, `delegation-passports.ts` routes, `delegationPassports` Map, MCP tools `create_delegation_passport`/`verify_delegation_passport`, or passport persistence. Do not claim a valid passport proves the agent has no out-of-band secrets — it proves only that Aegis-covered sensitive actions were constrained by user approval, KMS credential custody, the Aegis Playwright controlled runtime, and signed receipts.**
>
> **Also: do NOT rebuild Action Authorization Receipt v1. It is complete. Do not re-implement `ActionAuthorizationReceipt` type, `actionAuthorizationSigning.ts`, `action-authorizations.ts` routes, `actionAuthorizations` Map, or the authorization creation in the approve endpoint. `authorization_hash` excludes `status` and `fulfillment` by design — fulfilled and active authorizations both have valid hashes. Do not revoke a fulfilled authorization. Failed executions leave authorization `active`. No raw secrets, passwords, or private keys in authorization receipts.**
>
> **Also: do NOT rebuild Real Payment / Travel Mock Route v1. It is complete. Do not re-implement `PaymentMethodCapability` type, `paymentMethods` Map, `pay_method_demo_001` seed, `route_demo_travel_booking_001`, `skill_demo_travel_booking_001`, `ins_skill_travel_001`, `safe_literal` support in Playwright runtime, or `travel_booking` deriveActionType/deriveRiskTier logic. Do not add raw card numbers, CVV, or PAN. `payment_method_available` now uses a live Map lookup — do not revert to hardcoded `false`.**
>
> **Also: do NOT rebuild Spending Limit Step-Up v1. It is complete. Do not re-implement `SpendingLimitStepUp` type, `spendingLimitStepUps` Map, `POST /api/route-runs/:runId/spending-step-up` endpoint, `buildRunApprovalContext` helper, `ApprovalManifest.purchase_amount`/`constraint_warnings`/`approval_blocked`/`spending_step_up` fields, or the over-limit / step-up UI in `/route-run-approvals`. Do not expose step-up to external agents via `/api/agent/v1`. Do not mutate the collar when a step-up is approved — `spendingLimitStepUps` is the one-time override only. Approval receipt `constraints.max_amount_usd` must use `spendingLimitStepUps.get(runId)?.approved_limit_usd ?? collar max ?? 500`. Approval UI must block normal approve when `manifest.approval_blocked === true`.**
>
> **Also: do NOT rebuild Task Browser Lifecycle v1. It is complete. Do not re-implement `TaskBrowserSession` type, `taskBrowserSessions` Map, `taskBrowserProcesses` private Map, `createTaskBrowserSession`, `getTaskBrowserSession`, `closeTaskBrowserSession`, `expireInactiveTaskBrowserSessions`, `POST /api/task-browser-sessions`, or the three MCP tools (`start_task_browser_session`, `get_task_browser_session`, `close_task_browser_session`). Port 9222 conflict handling is autonomous (see Autonomous Browser Conflict Handling v1). Sessions are always ephemeral. `taskBrowserProcesses` is private — never expose PIDs. MCP tool responses omit `user_data_dir`. Do not close sessions immediately after login — close after full task completion.**

> **Also: do NOT rebuild Autonomous Browser Conflict Handling v1. It is complete. Do not re-implement `findSessionByPort`, `isCdpAlive`, `waitForPortFree`, `findAvailablePort`, `launchChrome`, or `CreateTaskBrowserResult`. The four-case port conflict resolution logic in `createTaskBrowserSession` is correct. `NO_PORTS_AVAILABLE` (503) is the only port error code. `PORT_IN_USE` (409) is no longer thrown — do not re-introduce it. `reused_existing`, `port_auto_selected`, `requires_browser_reconnect`, `user_message` are route/MCP-layer metadata only — do not add them to `TaskBrowserSession` type.**

> **Also: do NOT rebuild Sensitive Action Receipt Timeline v1 or its polish. Both are complete. Do not re-implement `SensitiveActionTimelineItem`, `SensitiveActionEventType`, `GET /api/internal/sensitive-receipts/recent`, `sensitiveReceiptsRouter`, `listSensitiveReceiptTimeline`, or the `/sensitive-receipts` page. Events are derived at query time from existing Maps — no write-time hooks, event emitters, or new persistence. The endpoint supports `since` (default "24h") and `event_group` filters applied after derivation. Agent-provided `reason` strings are sanitized via `sanitizeReceiptText` before inclusion. Nav labels are "Route Receipts" and "Sensitive Timeline". Never include `pass_id`, `secret_ref`, `authorization_hash`, `authorization_jws`, `user_data_dir`, `cdp_url`, raw codes, email body/subject, cookies, or storage in the response. `pass_label` is display metadata only.**

> **Also: do NOT rebuild Credential Provider Model v1. It is complete. Do not re-implement `CredentialProviderDefinition`, `CredentialProviderMatch`, `normalizeLoginDomain`, `findCredentialProviderByDomain`, `getCredentialDisplayLabel`, or `getInjectionSafetyCopy`. The registry lives in `apps/api/src/lib/credentialProviders.ts` and `apps/web/src/lib/credentialProviders.ts` (duplicated with a TODO to move to a shared package). `findCredentialProviderByDomain` is display-only — it does NOT authorize injection on any domain. Injection domain validation remains in the CDP fill endpoint. Do not remove the three-domain model from `docs/CREDENTIAL_PROVIDER_MODEL.md`.**

> **Also: do NOT rebuild Password Import / Migration v1. It is complete. Do not re-implement `parseCredentialCsv`, `ParsedCredential`, `CsvParseResult` in `apps/web/src/lib/csvImport.ts`, `importVaultPasses` in `apps/web/src/lib/api.ts`, the `/vault-import` page, or `POST /api/internal/vault-passes/import`. The bulk import endpoint uses the same `createAndStoreVaultPass` helper as the single POST endpoint — do not create a second vault write path. CSV is parsed client-side; raw CSV is never sent to the API. Passwords are never returned in import responses. Duplicate detection compares normalized domain + lowercase username against existing vault passes. Max 200 credentials per import request.**

> **Also: do NOT rebuild Sensitive Requirement Assessment v1. It is complete. Do not re-implement `assessSensitiveRequirements`, the `assess_sensitive_requirements` MCP tool schema, or the switch case in `examples/aegis-tool-server.mjs`. Agent autonomy boundary is defined in `docs/AGENT_INTEGRATION_CONTRACT.md` and `CLAUDE.md`. `plan_aegis_action` behavior and semantics are unchanged — its description was updated with a disambiguation note only.**

> **Also: do NOT rebuild Signed User Approval Receipts v1. It is complete. Do not re-implement `UserApprovalReceipt` type, `userApprovalReceiptSigning.ts`, `user-approval-receipts.ts` routes, `userApprovalReceipts` Map, or the non-blocking receipt creation in the approve/deny/reject handlers. Workspace audit events are operational records and are NOT user approval receipts — do not conflate them. Future receipt types (credential_injected, sensitive_action_blocked, etc.) follow the same pattern but are a separate increment.**

> **Also: do NOT rebuild Website AegisID Trust Promises v1. It is complete. Do not re-implement `WebsiteTrustProfile` type, `websiteTrustProfileSigning.ts`, `website-trust-profiles.ts` routes, `websiteTrustProfiles` Map, `STANDARD_SAFETY_PROMISES`, the two seed profiles (`wtp_demo_localhost_001`, `wtp_demo_example_store_001`), `GET /api/agent/v1/website-trust/:domain`, or the two MCP tools (`get_website_trust_profile`, `verify_website_trust_profile`). This is the website/company-side declared promise snapshot. `WebsiteTrustProfile.profile_hash` is the stable reference violation receipts use. `PATCH /status` does not re-sign — original hash is preserved as the historical signed record. Agent endpoint excludes `profile_jws`, `accountability_contact`, and `suspension_reason`. Unsigned profiles verify as invalid with `SIGNING_KEY_UNAVAILABLE` — unsigned profiles must never appear valid.**

> **Also: do NOT rebuild Website Violation Receipts v1. It is complete. Do not re-implement `WebsiteViolationReceipt` type (in `packages/types/src/index.ts`), `websiteViolationReceiptSigning.ts`, `website-violation-receipts.ts` routes, `websiteViolationReceipts` Map, or the three MCP tools (`list_website_violation_receipts`, `verify_website_violation_receipt`, `create_demo_website_violation_receipt`). Receipts are generated only for committed safety promise violations on active profiles — not for every page view or browser event. `profile_hash` from the active `WebsiteTrustProfile` is snapshotted into every receipt at creation time. `violation_count` on `WebsiteTrustProfile` is inside `profile_hash` and must NOT be mutated post-creation — compute violation counts dynamically from the `websiteViolationReceipts` Map. Three privacy literals (`raw_secrets_in_receipt`, `raw_credentials_in_receipt`, `raw_page_content_in_receipt`) are always `false`. POST is the manual/demo creation path — no live browser detection hooks in v1. `website-agent-safety.ts` `computeWebsiteAgentSafetyProfile()` counts `websiteViolationReceipts` for the domain and adds critical violations as a disqualifying signal.**

> **Also: do NOT rebuild Aegis Workspaces v0 or Workspace Effective Permissions v1. Both are complete. Do not re-implement `AegisWorkspace`, `WorkspaceTask`, `WorkspaceArtifact`, `requireWorkspaceAccess`, `checkWorkspacePermission`, `emitWorkspaceAudit`, the seven workspace `ActionType` values, or any of the six agent-facing workspace endpoints. Do not add Supabase persistence, MCP tools, UI, or a workspace invite flow for workspaces unless explicitly requested. `approval_required` workspace actions currently return `WORKSPACE_PERMISSION_REQUIRES_APPROVAL` (403) — there is no workspace CRUD approval inbox in v1.**

> **Also: do NOT rebuild Workspace MCP Tools v1. It is complete. Do not re-implement `getWorkspaceManifest`, `claimWorkspaceTask`, `completeWorkspaceTask`, `listWorkspaceArtifacts`, `readWorkspaceArtifact`, or `createWorkspaceArtifact` in `examples/aegis-tool-server.mjs`. All six tools wrap the existing `/api/agent/v1/workspaces/*` endpoints — no new API endpoints were required. `AEGIS_AGENT_TOKEN` must be the bearer token value (e.g. `pass_demo_001`), not the delegation ID.**

> **Also: do NOT rebuild Workspace UI v1. It is complete. Do not re-implement `apps/web/src/app/workspaces/page.tsx` (workspace list), `apps/web/src/app/workspaces/[id]/page.tsx` (workspace detail — task board, artifact panel, participants panel), or the owner-facing routes in `apps/api/src/routes/workspaces.ts`. File artifact upload and download are NOT yet implemented — that is Workspace Artifact Uploads v1.**

> **Also: do NOT rebuild Security Challenge Expiry / Stale Approval Cleanup v1. It is complete. Do not re-implement lazy expiry in `GET /api/internal/security-challenges` (marks pending_user/code_submitted challenges expired, filters terminal statuses by default, supports `?include_terminal=true`), lazy expiry in `GET /api/internal/challenge-email-resolutions` (marks non-terminal resolutions expired when their linked challenge has expired), the `isExpired` setTimeout in `PendingChallengeCard`, the expired card early return, the auto-refresh `useEffect` on `challenges.length`, or the `isEmailTypeChallenge` generalization. Gmail button copy reads "Aegis only searches for this live verification request after you approve." Gmail resolution remains user-initiated (click = approval). Do not remove `TERMINAL_STATUSES` set from `security-challenges.ts`.**

> **Also: do NOT rebuild Payment Card Fill Handoff v1 or Purchase Confirmation Handoff v1. Both are complete. Do not re-implement `paymentCardFill.ts`, `purchaseConfirmationHandoff.ts`, `purchaseConfirmationRoutes`, `purchaseConfirmationAuthorizations` Map, `purchaseConfirmationHandoffs` Map, the three agent API endpoints (`POST /api/agent/v1/purchase-confirmations`, `GET /:id`, `POST /:id/execute`), the three internal endpoints (`GET/POST /api/internal/purchase-confirmation-authorizations`), the three MCP tools (`request_purchase_confirmation`, `wait_for_purchase_confirmation_authorization`, `execute_purchase_confirmation_handoff`), or `PurchaseConfirmationApprovalCard` in the approvals UI. Core invariants: `PaymentCardFillAuthorization` NEVER authorizes purchase submission. `execute` with a `pca_...` ID returns `403 CARD_FILL_AUTH_NOT_SUFFICIENT`. `purchase_action_authorized` starts `false`; only set `true` on approve. `manual_step_required` outcome never marks `fulfilled`. `safeDisconnect()` only, never `browser.close()`. "checkout" is NOT in the v1 allowlist. Approve is idempotent: already-approved returns 200. `raw_values_revealed_to_agent: false` is a TypeScript literal on all authorization and handoff records. Both events (`purchase_confirmation_submitted`, `purchase_confirmation_failed`) appear under `event_group=payment` in the sensitive receipt timeline. 25 new tests cover all boundary cases; 830 total tests pass.**

> **Also: do NOT rebuild the Local Runtime Browser Endpoint, antigen-browser adapter, or Credential Step Handoff v1. All are complete. `POST /api/agent/v1/runtime/browser-endpoint` provisions or reuses an ephemeral runtime browser for a delegation. `examples/antigen-browser-adapter.mjs` resolves the dynamic CDP port at startup and spawns `@playwright/mcp` — no static port config required. `execute_credential_step_handoff` is the preferred tool for password login submit: it fills the protected field and clicks the approved submit button atomically inside a single CDP session before returning control to the agent. Proven for `password_submit` step type in a real GitHub login smoke test (tbsess_751b7d77e99e, csh_20e4559a9c3e, status: navigated). JS masking is defense-in-depth only — not the primary security boundary. Credential Step Handoff v1 covers login credential submit; it is not the approval model for payments, purchases, or other sensitive actions.**

---

## Completed Increments (as of 2026-05-03)

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

### Sensitive Workflow Detection v1
- `RuntimeEventType` (`sensitive_field_focus` | `sensitive_field_input` | `sensitive_button_click` | `sensitive_form_submit`)
- `RuntimeEventSensitivity` (`credential` | `payment` | `identity` | `financial` | `destructive` | `account_change` | `unknown_sensitive`)
- `RuntimeCoverageStatus` (`covered_by_aegis` | `not_covered_by_aegis` | `unknown`)
- `RuntimeEvent` interface with `event_id`, `runtime_session_id`, `run_id`, `user_id`, `domain`, `page_url`, `event_type`, `sensitivity`, `coverage_status`, `severity`, `element_hint`, `reason`, `created_at`
- `RuntimeCoverageSummary` type exported from `packages/types/src/index.ts`; also exported from `aegisRuntime.ts`; added as optional `runtime_coverage_summary?` field on `RouteRunReceipt`
- `runtimeEvents: Map<string, RuntimeEvent>` in `aegisRuntime.ts` — ephemeral, indexed by `event_id`
- `getCoverageSummary(runtimeSessionId)` — scans `runtimeEvents` Map, returns aggregated summary
- Page instrumentation script in `playwrightRuntime.ts`: listens for `focusin`/`input`/`click`/`submit`; classifies by field type/autocomplete/name/id and button text; never reads `.value`; uses `window.__aegisRuntimeEvents`
- `CoverageWindow` mechanism: coverage windows opened around each Aegis-controlled fill/click; `convertPageEvents` compares event timestamps to window open/close times to assign `coverage_status`
- Severity mapping: `payment`/`financial`/`identity`/`destructive` → critical; `credential` → high; `account_change` → high; `unknown_sensitive` → warning
- Events stored in `runtimeEvents` Map and `session.runtime_events`; `session.coverage_summary` computed after collection
- `receipt.runtime_coverage_summary` set before `createReceipt` call
- `GET /api/runtime/sessions/:runtimeSessionId/events` — returns metadata-only events filtered by session
- `docs/AGENT_INTEGRATION_CONTRACT.md` updated with "Sensitive Workflow Detection v1" section
- **Implemented 2026-05-02**
- Do not rebuild unless explicitly requested

### Execution Surface Recenter v1
- `aegis_playwright` is now the primary autonomous-agent controlled execution surface; `chrome_extension` demoted to optional local/debug/recording companion
- MCP tool `request_skill_run` description updated: creates run but does not execute; agents should call `start_playwright_route_run` after approval
- MCP tool `start_playwright_route_run` description updated: marked as preferred autonomous-agent surface; no user tab required; extension not involved
- MCP tool `plan_aegis_action` description updated: now mentions `post_approval_next_tool: "start_playwright_route_run"` for controlled flows
- `planAegisAction` function in `aegis-tool-server.mjs`: all `aegis_controlled_run` return paths now include `post_approval_next_tool: "start_playwright_route_run"` and `post_approval_note` with explicit instruction not to ask user to open a tab
- `examples/README.md` updated: new "Execution Surfaces" table, "Recommended autonomous-agent flow" steps, tools table updated, Limitations section updated
- `docs/AGENT_INTEGRATION_CONTRACT.md` updated: Execution Surfaces section rewritten with surface-by-surface breakdown, recommended agent flow, and architecture note (future features target Playwright first)
- `CLAUDE.md` updated: session rules + implementation state updated to reflect Playwright as primary surface
- **Implemented 2026-05-02**
- Do not rebuild unless explicitly requested

### Auto-start Playwright Runs v1
- `claimed_execution_surface?: AegisExecutionSurface` added to `RouteRun` in `packages/types/src/index.ts` — set to `"aegis_playwright"` when approval auto-triggers Playwright; prevents extension from racing on the same run
- Approval endpoint (`POST /api/route-runs/:runId/approve`) in `route-runs.ts` auto-starts Playwright via fire-and-forget when `route.execution_mode === "aegis_controlled" && route.start_url` — uses dynamic `import("../runtime/playwrightRuntime.js")` to avoid circular dependency
- Extension `isEligibleForBackgroundAutoRun` in `background.js` skips runs where `claimed_execution_surface === "aegis_playwright"` — extension never races against an auto-started Playwright session
- Manual `POST /api/runtime/route-runs/:runId/playwright/start` remains as fallback — handles `claimed_execution_surface` gracefully (returns existing session if present)
- MCP tool `post_approval_note` updated in `examples/aegis-tool-server.mjs`: all 4 `aegis_controlled_run` return paths now say "Aegis will auto-start the Playwright runtime immediately after the user approves. Poll get_route_run_status — the run should transition without any manual step. If the run remains pending, call start_playwright_route_run as a fallback."
- `docs/AGENT_INTEGRATION_CONTRACT.md` Recommended Agent Flow updated: step 3 explains auto-start, step 4 is poll-to-completion, step 5 is fallback, step 6 is verify
- Status Lifecycle table updated to show Playwright runtime as driver of `pending → running` and `running → completed/failed`
- **Implemented 2026-05-02**
- Do not rebuild unless explicitly requested

### Playwright Runtime v1
- `apps/api/src/runtime/aegisRuntime.ts` — `RuntimeSession`, `RuntimeEvent` types; ephemeral `runtimeSessions` Map (not persisted — receipts are the durable audit record)
- `apps/api/src/runtime/playwrightRuntime.ts` — `executeRouteRunWithPlaywright(runId)`: launches headless Chromium, navigates to `route.start_url`, executes route steps, resolves credentials via KMS vault, instruments sensitive events, emits signed receipt with `execution_surface: "aegis_playwright"`, marks run completed
- `apps/api/src/lib/secretResolution.ts` — `resolveRouteStepValue(run, step)` extracted from `resolve-value` endpoint; handles pass_overrides → binding → step default → vault → KMS decrypt precedence; never logs plaintext
- `POST /api/runtime/route-runs/:runId/playwright/start` — start approved run in Playwright runtime; 409 APPROVAL_REQUIRED if pending_approval; synchronous v1 (awaits completion before responding)
- `GET /api/runtime/sessions` / `GET /api/runtime/sessions/:runtimeSessionId` — list/read runtime sessions
- MCP tool `start_playwright_route_run` in `examples/aegis-tool-server.mjs` — agents call this to execute without a user tab
- `AegisExecutionSurface` type added to `packages/types/src/index.ts`; `RouteRunReceipt.execution_surface` changed from `"chrome_extension"` literal to `AegisExecutionSurface` union
- `buildReceipt` in `route-runs.ts` now accepts optional `executionSurface` param (defaults to `"chrome_extension"` — extension path unchanged)
- Chrome extension path fully preserved; both surfaces coexist
- Sensitive event instrumentation: page init script detects password fields, sensitive button clicks, form submits; stores metadata only (no field values) in `session.runtime_events`
- `docs/AGENT_INTEGRATION_CONTRACT.md` updated with "Aegis Execution Surfaces" section
- **Implemented 2026-05-02**
- Do not rebuild unless explicitly requested

### Delegation Passport v1
- `DelegationPassport` interface added to `packages/types/src/index.ts` — covers `human_subject`, `agent_subject`, `delegation`, `capability_attestations`, `secret_custody`, `aegis_coverage_boundary`, `evidence_summary`, `verification`
- `apps/api/src/lib/delegationPassportSigning.ts` — `hashDelegationPassport` (SHA-256 of stable sorted JSON excluding verification), `signDelegationPassportJws` (EdDSA/Ed25519 via `AEGIS_RECEIPT_JWS_PRIVATE_JWK`), `verifyDelegationPassportJws`; reuses receipt signing keys for v1 (TODO: split into dedicated passport keypair)
- `delegationPassports: Map<string, DelegationPassport>` added to `apps/api/src/store/index.ts`; persisted in `aegis-store.json` as `delegationPassports`; cleared on `resetStoreForDemo`
- `apps/api/src/routes/delegation-passports.ts` — `POST /api/delegation-passports`, `GET /api/delegation-passports/:passportId`, `GET /api/delegation-passports/:passportId/status`, `GET /api/delegation-passports/:passportId/verify`, `POST /api/delegation-passports/:passportId/revoke`
- Evidence summary built from `getReceiptRepository().listReceipts()` + `verifyReceipt()` per receipt — counts only valid verified receipts; includes `verified_receipts`, `verified_sensitive_receipts`, `credential_uses`, `covered_sensitive_events`, `uncovered_sensitive_events`, `secrets_revealed_to_agents`, `recent_receipt_ids` (last 5)
- Capability attestations from `getVaultRepository().listVaultPasses()` — `login_credentials_available`, `credential_domains`, `max_transaction_amount_usd` from collar spending limits
- MCP tools `create_delegation_passport` and `verify_delegation_passport` added to `examples/aegis-tool-server.mjs`
- `agent_id` in JWS payload is `delegation.agent_name` (temporary fallback — TODO: add stable `agent_id` to `AgentDelegation`)
- `aegis_coverage_boundary.aegis_does_not_prove_agent_has_no_out_of_band_secrets: true` — must remain in the passport; do not remove or weaken this field
- Passport contains no raw secrets, passwords, secret_refs, ciphertext, or private keys — only aggregate counts, capability booleans, domains, and receipt IDs
- **Implemented 2026-05-02**
- Do not rebuild unless explicitly requested

### Action Authorization Receipt v1
- `ActionAuthorizationReceipt` interface added to `packages/types/src/index.ts` — covers `action`, `constraints`, `approval`, `custody`, `fulfillment`, `verification`
- `apps/api/src/lib/actionAuthorizationSigning.ts` — `hashActionAuthorization` (SHA-256 excluding `status`, `fulfillment`, `verification`), `signActionAuthorizationJws` (EdDSA/Ed25519), `verifyActionAuthorizationJws`; requires `AEGIS_RECEIPT_JWS_PRIVATE_JWK` (no unsigned-dev-mode fallback)
- `actionAuthorizations: Map<string, ActionAuthorizationReceipt>` added to store; persisted as `actionAuthorizations`; cleared on `resetStoreForDemo`
- `apps/api/src/routes/action-authorizations.ts` — `GET /api/action-authorizations`, `GET /api/action-authorizations/:id`, `GET /api/action-authorizations/:id/verify`, `POST /api/action-authorizations/:id/revoke`
- Authorization created in approve endpoint before Playwright fire-and-forget; `run.authorization_id`/`run.authorization_hash` set on `RouteRun`
- `playwrightRuntime.ts`: `authorization_context` attached to both success and failure receipts; authorization marked `fulfilled` after `createReceipt` on success path only
- `RouteRunReceipt` has new optional `authorization_context` field linking receipt back to authorization
- `RouteRun` has new optional `authorization_id`/`authorization_hash` fields
- Verify semantics: `valid = hash_valid && signature_valid && !revoked && !expired`; fulfilled authorizations remain `valid`; `revoke` fails with 409 if already fulfilled
- Authorization creation failure in approve endpoint is non-blocking (logs error, run proceeds)
- No raw secrets, passwords, secret_refs, or private keys in authorization receipts or API responses
- **Implemented 2026-05-02**
- Do not rebuild unless explicitly requested

### Signed User Approval Receipts v1
**Receipts are liability-grade signed records for trust-boundary decisions, not surveillance logs. Aegis does not record every agent action. Only user approve/deny clicks create receipts.**
- `UserApprovalReceipt`, `UserApprovalJwsPayload`, `UserApprovalReceiptVerificationResult` types added to `packages/types/src/index.ts` after `ActionAuthorizationReceipt`
- `apps/api/src/lib/userApprovalReceiptSigning.ts` — `hashUserApprovalReceipt` (SHA-256 of sorted-key JSON excluding `outcome`, `outcome_updated_at`, `verification`), `signUserApprovalReceiptJws` (EdDSA, `AEGIS_RECEIPT_JWS_PRIVATE_JWK`), `verifyUserApprovalReceiptJws`, `buildSignedUserApprovalReceipt`, `verifyStoredUserApprovalReceipt`
- `userApprovalReceipts: Map<string, UserApprovalReceipt>` added to `apps/api/src/store/index.ts`; persisted as `userApprovalReceipts`; cleared on `resetStoreForDemo`
- `apps/api/src/routes/user-approval-receipts.ts` — `GET /api/user-approval-receipts` (list; omits JWS; supports `?decision=` and `?source=` filters), `GET /api/user-approval-receipts/:receiptId` (full receipt with JWS), `GET /api/user-approval-receipts/:receiptId/verify`
- Wired (non-blocking) into `POST /api/approvals/:id/approve` and `POST /api/approvals/:id/deny` (`approval_source: "approval_request"`)
- Wired (non-blocking) into `POST /api/route-runs/:runId/reject` (`approval_source: "route_run_rejection"`) — this path previously had no signed receipt
- Route-run approval (`POST /api/route-runs/:runId/approve`) is **not** wired — that path already creates a comprehensive `ActionAuthorizationReceipt`; `UserApprovalReceipt` would be redundant there
- `jws_present: false` + `jws: ""` signals an unsigned receipt (key unavailable); verify endpoint returns `valid: false, error: "SIGNING_KEY_UNAVAILABLE"` — unsigned receipts never look valid
- All decision fields are included in the canonical hash: `decision`, `decided_at`, `user_id`, `approval_id`, `approval_source`, delegation/agent context, `action_type`, `requested_action_summary`, `target_domain`, `scope_shown`, `evidence_summary`
- `outcome` and `outcome_updated_at` are mutable and excluded from the hash so outcome tracking never breaks the signature
- `raw_secrets_in_receipt: false` and `raw_credentials_in_receipt: false` are TypeScript literal types — never set through variables
- No raw passwords, secrets, 2FA codes, session tokens, or encrypted blobs in receipt fields
- 22 automated tests in `apps/api/src/__tests__/user-approval-receipts.test.ts` — approve, deny, reject, list, detail, verify untampered, verify tampered (decision/domain), SIGNING_KEY_UNAVAILABLE
- **Workspace audit events are operational coordination records and are separate from liability receipts**
- **Future receipt types** (credential_injected, secret_released, sensitive_action_blocked, collar_violation) share the same pattern but are not part of this increment
- **Implemented 2026-05-14**
- Do not rebuild unless explicitly requested

### Website AegisID Trust Profiles v1
**Completed 2026-05-14.** Signed website/company-side declared promise snapshots for delegated-agent trust.
- `WebsiteTrustProfile`, `WebsiteSafetyPromise`, `WebsiteAgentPolicyDeclaration`, `WebsiteTrustProfileJwsPayload`, `WebsiteTrustProfileVerificationResult` types in `packages/types/src/index.ts`
- `apps/api/src/lib/websiteTrustProfileSigning.ts` — `STANDARD_SAFETY_PROMISES`, `hashWebsiteTrustProfile`, `buildSignedWebsiteTrustProfile`, `verifyStoredWebsiteTrustProfile`
- `websiteTrustProfiles: Map<string, WebsiteTrustProfile>` in store; two seed profiles (`wtp_demo_localhost_001`, `wtp_demo_example_store_001`)
- `apps/api/src/routes/website-trust-profiles.ts` — POST (create+sign), GET list, by-domain, detail, verify, PATCH /status
- `GET /api/agent/v1/website-trust/:domain` — agent-safe lookup; committed promises only; excludes `profile_jws`/`accountability_contact`/`suspension_reason`
- 2 MCP tools: `get_website_trust_profile`, `verify_website_trust_profile`
- `violation_count` is inside `profile_hash` — cannot be mutated post-creation without breaking the signed snapshot
- Do not rebuild unless explicitly requested

### Website Violation Receipts v1
**Completed 2026-05-14.** Signed proof that a website's observed behavior violated a committed safety promise. The website/company liability counterpart to `UserApprovalReceipt`.
- `WebsiteViolationReceipt`, `WebsiteViolationReceiptJwsPayload`, `WebsiteViolationReceiptVerificationResult`, `WebsiteViolationType`, `WebsiteViolationDecision`, `WebsiteViolationDetectionSource` types in `packages/types/src/index.ts`
- `apps/api/src/lib/websiteViolationReceiptSigning.ts` — `hashWebsiteViolationReceipt` (SHA-256 of sorted-key JSON excluding `verification`), `signWebsiteViolationReceiptJws` (EdDSA, `aegis-website-violation+jws`), `buildSignedWebsiteViolationReceipt` (non-throwing), `verifyStoredWebsiteViolationReceipt`
- `websiteViolationReceipts: Map<string, WebsiteViolationReceipt>` added to `apps/api/src/store/index.ts`; persisted and cleared on reset
- `apps/api/src/routes/website-violation-receipts.ts` — `POST /api/website-violation-receipts` (create; validates active profile + committed promise), `GET` (list; filters: domain, violation_type, severity, decision), `GET /:receiptId`, `GET /:receiptId/verify`
- Profile snapshot fields (`verification_status_at_violation`, `profile_hash`, `profile_version`, `company_name`, `website_aegis_id`) are copied from the live `WebsiteTrustProfile` at creation time — they anchor the promise that was active when the violation occurred
- `violation_count` on `WebsiteTrustProfile` must NOT be mutated — it is inside `profile_hash`; compute violation counts dynamically from the `websiteViolationReceipts` Map
- `target_url_or_origin` query strings are stripped at receipt creation (origin+path only)
- 3 privacy literals: `raw_secrets_in_receipt: false`, `raw_credentials_in_receipt: false`, `raw_page_content_in_receipt: false`
- v1 promise validation: active profile required (`WEBSITE_PROFILE_NOT_FOUND`), committed promise required (`PROMISE_NOT_FOUND`, `PROMISE_NOT_COMMITTED`), revoked/superseded profile rejected (`PROFILE_NOT_ACTIVE`)
- `apps/api/src/routes/website-agent-safety.ts` `computeWebsiteAgentSafetyProfile()` now scans `websiteViolationReceipts` for the domain and adds `failedViolationReceipts` count; critical violations add a disqualifying signal
- 3 MCP tools: `list_website_violation_receipts`, `verify_website_violation_receipt`, `create_demo_website_violation_receipt` (clearly marked demo/internal)
- No live browser detection hooks in v1 — POST is manual/demo creation path
- 26 automated tests in `apps/api/src/__tests__/website-violation-receipts.test.ts`
- Do not rebuild unless explicitly requested

### Verification Foundation v1
**Completed 2026-05-23.** Types, store maps, persistence, and EdDSA signing helpers for VerificationCards and DisclosureReceipts. No routes, UI, mock providers, or disclosure API yet.

- `VerificationType`, `AssuranceLevel`, `DisclosurePolicy`, `VerificationProviderSession`, `VerifiedClaimValue`, `VerifiedClaim`, `VerificationCard`, `DisclosureReceipt`, `TrustSignalDisclosureRecord` added to `packages/types/src/index.ts`
- `VerificationProviderSession.provider_session_id` is optional — provider may not return an ID until `initiate()` succeeds
- `VerifiedClaimValue` fields (e.g. `government_id.country_code`, `government_id.id_type`) are Tier 2 claim details — never auto-disclosed as Tier 1 trust signals; no raw SSNs, DOB, legal name, address, biometrics, or document numbers stored
- `provider_reference_id` on `VerifiedClaim` is internal only — must never appear in agent or website responses
- `VerificationCard.limitations.raw_document_revealed_to_agent: false` and `raw_document_revealed_to_website: false` are TypeScript literal types
- `VerificationCard.revocation_status` is intentionally excluded from canonical hash — revocation does not invalidate the signed claim content
- `apps/api/src/lib/verificationCardSigning.ts` — `hashVerificationCard` (SHA-256 of sorted JSON, excludes `verification` + `revocation_status`), `signVerificationCardJws` (EdDSA, `aegis-verification-card+jws`), `buildSignedVerificationCard` (non-throwing), `verifyStoredVerificationCard` (hash + JWS cross-check)
- `verificationProviderSessions`, `verificationCards`, `disclosureReceipts`, `trustSignalDisclosureRecords` Maps added to `apps/api/src/store/index.ts`
- `verificationCards`, `disclosureReceipts`, `trustSignalDisclosureRecords` wired into `persistStore`/`loadStore`; `verificationProviderSessions` intentionally not persisted (ephemeral)
- Tests: `apps/api/src/__tests__/verification-card-signing.test.ts` — hash stability, revocation hash invariant, mutation detection, signing dev-mode (no key), privacy literal assertions, forbidden-field scanning
- Do not rebuild unless explicitly requested. Next: mock provider + card issuance, then `/verify` UI, then scoped disclosure API.

### Verification Mock Provider + Card Issuance v1
**Completed 2026-05-23.** Mock verification provider sessions and signed VerificationCard issuance. No real providers, no UI, no disclosure API, no trust-signal API.

- `VerificationProvider` interface and `ProviderClaimResult` type in `apps/api/src/lib/verificationProviders.ts`
- Three mock providers: `mock_email` (email_ownership, assurance: provider_verified, stores email_domain only), `mock_student` (student_status, assurance: provider_verified, default institution: University of Michigan), `mock_gov_id` (government_id, assurance: document_verified, stores country_code + id_type as Tier 2 metadata only — never raw ID, DOB, legal name, SSN, biometric, or document number)
- `apps/api/src/routes/verifications.ts` — 8 routes under `/api/verifications/`: `GET /types`, `POST /sessions`, `GET /sessions/:sessionId`, `POST /sessions/:sessionId/complete`, `GET /cards`, `GET /cards/:cardId`, `GET /cards/:cardId/verify`, `POST /cards/:cardId/revoke`
- `sessionMockInputs: Map<string, unknown>` — module-level ephemeral side-map; stores mock_input from session creation; deleted after complete; never persisted
- `toVerificationCardSummary` / `toVerificationCardDetail` — safe views that omit `provider_reference_id` from claims and `provider_session_id` from session responses
- `schedulePersist()` called only after card mutations (complete, revoke) — not after session creation
- `verificationProviderSessions` remain ephemeral and are not persisted; `verificationCards` are persisted
- `disclosureReceipts` and `trustSignalDisclosureRecords` are untouched by this increment
- country_code and id_type on government_id claims are Tier 2 user-facing card details only — they do not feed into Tier 1 trust-signal disclosure
- 25 tests in `apps/api/src/__tests__/verification-routes.test.ts` — covers happy paths, error states (expired/completed session), privacy invariants (no forbidden raw field keys, no provider_reference_id/provider_session_id in responses), persistence invariants (schedulePersist not called on session create), and disclosureReceipts unchanged invariant
- Do not rebuild unless explicitly requested. Next: `/verify` UI, then scoped claim disclosure API, then trust-signal API.

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

Background Auto-Run (Reliable, Opt-In) is **complete** — validated 2026-05-01.

External Agent Integration Hardening is **complete** — validated via the Aegis MCP Tool Server on 2026-05-01.

Agent-runnable workflow recipe path is **complete** — validated 2026-05-01.

Aegis-controlled sensitive execution path (via extension) is **complete** — validated 2026-05-01.

**Playwright Runtime v1 is complete** — implemented 2026-05-02. Agents can now execute approved controlled runs without a user-opened browser tab. See "Playwright Runtime v1" in Completed Increments below.

**Execution Surface Recenter v1 is complete** — implemented 2026-05-02. `aegis_playwright` is now the primary autonomous-agent execution surface in all MCP tool guidance, docs, and planning tools. Chrome extension is framed as optional local/debug/recording companion. See "Execution Surface Recenter v1" in Completed Increments.

**Sensitive Workflow Detection v1 is complete** — implemented 2026-05-02. Aegis Playwright runtime now instruments sessions for sensitive field interactions, button clicks, and form submissions with coverage classification. See "Sensitive Workflow Detection v1" in Completed Increments.

**Auto-start Playwright Runs v1 is complete** — implemented 2026-05-02. Approval of an `aegis_controlled` run now automatically triggers the Playwright runtime via fire-and-forget. The extension skips claimed runs. Manual `start_playwright_route_run` remains as a fallback. See "Auto-start Playwright Runs v1" in Completed Increments.

**Delegation Passport v1 is complete** — implemented 2026-05-02. Agents can now create and verify a cryptographically signed Delegation Passport that documents: human subject, agent subject, collar-backed action limits, capability attestations, KMS custody model, Aegis coverage boundary, and receipt-backed evidence. The passport does NOT prove the agent has no out-of-band secrets. See "Delegation Passport v1" in Completed Increments.

**Action Authorization Receipt v1 is complete** — implemented 2026-05-02. A signed proof is created at approval time before Playwright execution begins. After successful execution, the authorization is marked `fulfilled` and linked to the execution receipt via `authorization_context`. `authorization_hash` excludes `status` and `fulfillment` so the cryptographic proof stays valid throughout the lifecycle. See "Action Authorization Receipt v1" in Completed Increments.

**Delegation Trust Profile v1 is complete** — implemented 2026-05-03. `GET /api/delegation-trust/profile?delegation_id=&task_category=` generates a machine-readable trust profile scoped to a specific task category. Trust is based on fulfilled Aegis authorizations, verified signed receipts, sensitive workflow coverage stats, and KMS custody attestation — NOT generic success count. Low-risk browsing/search tasks do not improve high-risk trust categories. Payment categories cap at `proven_limited` (payment capability now live via `paymentMethods` Map). MCP tool `get_delegation_trust_profile` exposes this to agents. Do not rebuild unless explicitly requested.

**Website Assertion / Handshake v1 is complete** — implemented 2026-05-03. `POST /api/website-assertions` creates a signed `WebsiteTrustAssertion` combining the Delegation Trust Profile and optional Delegation Passport into a compact machine-readable recommendation (allow / allow_with_approval / step_up_required / deny) with EdDSA JWS signature and hash chain. `GET /api/website-assertions/:id/verify` recomputes hash, verifies JWS, cross-checks payload fields, and checks expiry. MCP tools `create_website_trust_assertion` and `verify_website_trust_assertion` expose this to agents. Assertions require real signing keys — no unsigned fallback. Do not rebuild unless explicitly requested.

**Real Payment / Travel Mock Route v1 is complete** — implemented 2026-05-03. `skill_demo_travel_booking_001` / `route_demo_travel_booking_001` books a mock Detroit → New York flight at `/demo-travel` using `PaymentMethodCapability` (tokenized metadata, no raw card data). `payment_method_available` is now a live Map lookup. `deriveActionType` returns `travel_booking` when permissions include it; authorization receipt carries `max_amount_usd`, `currency: "USD"`, `allowed_payment_instrument_types: ["demo_card"]`. Playwright runtime now handles `safe_literal` steps natively. Trust profile for `travel_booking` advances to `proven_limited` after one successful run; website assertion advances to `allow_with_approval`. No real money processed. Do not rebuild unless explicitly requested.

**Coverage Violation Blocking v1 is complete** — implemented 2026-05-03. Uncovered high/critical-severity sensitive events now block Playwright runs before a completed receipt is issued. `RuntimeIntervention` type tracks each blocked event (metadata only — no field values). Blocked runs receive a signed failed receipt with `runtime_interventions[]` and `runtime_coverage_summary.uncovered_events > 0`. Authorization stays `active` (not fulfilled). Delegation trust profile now scans ALL delegation auth receipts (not just fulfilled) for uncovered events, so violation runs register `trust_status: "caution"`. Violation demo: `skill_demo_travel_violation_001` starts at `/demo-travel?violation=1` which fires an uncovered credential form submit before the Aegis coverage window opens. Do not rebuild unless explicitly requested.

**Capability Release Gate v1 is complete** — implemented 2026-05-03. Coverage of sensitive runtime events is now provenance-based rather than timing-based. `RuntimeCapabilityRelease` records that Aegis explicitly released a sensitive capability (`login_credential`, `payment_method`, `identity_profile`) for a specific run. `convertPageEvents()` uses `requiredCapabilityForEvent()` to determine required capability type per event; if a capability is required and no matching release exists, the event is `not_covered_by_aegis` regardless of timing windows. Timing windows remain as a fallback only for events with no required capability type (excluding `unknown_sensitive` high/critical events, which are also not covered by timing alone). `login_credential` releases created on `secret_ref` fills only (not `pass_field`/username). `payment_method` releases created only for payment-intent click steps (button name contains Pay/Book/Purchase/etc.) in payment/travel routes, only when the user has a payment method in the `paymentMethods` Map. `capability_ref` is always an opaque ID (pass_id or payment_method_id) — never a secret value. Violation receipts carry `runtime_capability_releases` and `capability_release_summary`. New intervention type: `blocked_sensitive_action_without_capability_release`. Do not rebuild unless explicitly requested.

**Sensitive Workflow Observation Mode v1 is complete** — implemented 2026-05-03. Aegis Playwright runtime now tracks a `RuntimeObservationModeState` per session, starting in `open_observation` and escalating to `protected_observation` when sensitivity signals are detected (route permissions, URL patterns, DOM patterns). An agent-safe observation snapshot is built after `page.goto()` and after each click step — stored in `runtimeObservationSnapshots` Map (ephemeral). Sensitive field values are always omitted (`value_redacted: true`); only `filled: boolean` is exposed. Sensitive elements carry `required_capability` and `allowed_actions: ["read", "request_fill"|"request_click"]`. Two new API endpoints: `GET /api/runtime-sessions/:sessionId/observation` and `GET /api/runtime-sessions/:sessionId/observation-mode`. Two new MCP tools: `get_runtime_observation` and `get_runtime_observation_mode`. All three receipt paths (success, violation, failure) include `observation_mode_summary`. Capability Release Gate v1 is unchanged — observation mode controls what agents see; capability releases control what sensitive actions proceed. Do not rebuild unless explicitly requested.

**Website Agent-Safety Profile v1 is complete** — implemented 2026-05-03. `GET /api/website-agent-safety/profile?domain=&task_category=` returns a `WebsiteAgentSafetyProfile` evaluated from Aegis-observed signals: known routes, verified receipts, runtime coverage violations, interventions, and observation mode. Recommendation (`allow_with_approval` / `step_up_required` / `deny`) is determined deterministically — negative evidence (violation receipts, uncovered events) overrides positive (clean receipts). Does not perform live crawling, does not verify business identity, does not require signing keys. MCP tool `get_website_agent_safety_profile` exposes this to agents. No secrets in responses — aggregate only. Do not rebuild unless explicitly requested.

**Website .well-known Aegis Policy v1 is complete** — implemented 2026-05-03. Demo policy served at `http://localhost:3000/.well-known/aegis-policy.json` (and `/well-known/aegis-policy.json` alias). `WebsiteAegisPolicy` type declares `agent_access`, `verification_level`, `supported_workflows`, `required_assertions`, `limitations`. API endpoints: `GET /api/website-aegis-policy?domain=`, `GET /api/website-aegis-policy/validate?domain=`, `GET /api/website-aegis-policy/compatibility?domain=&task_category=`. Only `localhost` fetch is enabled in v1; non-localhost returns `POLICY_NOT_AVAILABLE`. `computeWebsiteAgentSafetyProfile` now fetches and consumes the policy: `policy_source: "well_known"` in legibility; `well_known_policy_present` and capability constraints enriched in `task_fit`; machine-readable reasons include policy-declared workflow support. Policy alone does NOT upgrade recommendation — clean receipt evidence is still required for `allow_with_approval`. Invalid policy adds `invalid_website_policy` disqualifying signal (`step_up_required`, not `deny`). Three new MCP tools: `get_website_aegis_policy`, `validate_website_aegis_policy`, `check_website_policy_compatibility`. No JWS signing, no business verification, no live internet crawl. Do not rebuild unless explicitly requested.

**Cloud KMS Provider v1 is complete** — implemented 2026-05-03. `KmsProviderName` now includes `"cloud_kms_stub"` (in addition to `"local_dev"`). `CloudKmsStubProvider` throws `CLOUD_KMS_NOT_IMPLEMENTED` on any encrypt/decrypt — it does not fall back to `local_dev`. KMS audit events (`KmsAuditEvent`, `KmsOperationType`) added to `packages/types`. `apps/api/src/lib/kmsAudit.ts` records every encrypt/decrypt operation with metadata only (`raw_secret_exposed: false` always). `vault-passes.ts` records `encrypt_secret` audit events. `secretResolution.ts` records `resolve_secret_for_runtime` audit events. `GET /api/kms-audit-events` exposes the in-memory audit log (dev/internal only — resets on restart). No raw secrets, plaintext, ciphertext, nonces, or key material in any audit event. Capability Release Gate and Observation Mode are unchanged. Do not rebuild unless explicitly requested.

**External Agent Delegation API v1 is complete** — implemented 2026-05-03. Clean public namespace at `/api/agent/v1` for third-party agents using a delegated bearer token. Token is matched against `AgentDelegation.token_id`; server derives all identity fields (agent, delegation, collar) — never trusted from request body. Endpoints: `GET /api/agent/v1/me` (identity), `GET /api/agent/v1/skills` (policy-filtered skill discovery), `POST /api/agent/v1/runs` (create delegated run), `GET /api/agent/v1/runs/:runId` (poll status), `GET /api/agent/v1/runs/:runId/receipts` (safe receipt summaries), `GET /api/agent/v1/websites/:domain/safety-profile` (domain safety), `GET /api/agent/v1/websites/:domain/policy` (well-known policy). Receipt summaries exclude `pass_ids_used`, `runtime_capability_releases`, `variables`, and internal IDs. User approval stays in the Aegis UI; external agents cannot self-approve. Demo script: `examples/external-agent-demo.mjs`. Types added to `packages/types`: `ExternalAgentIdentity`, `ExternalAgentSkillSummary`, `ExternalAgentRunSummary`. Do not rebuild unless explicitly requested.

**Agent Approval Context Panel v1 is complete** — implemented 2026-05-03. `/route-run-approvals` redesigned into a premium approval decision surface. New backend endpoint `GET /api/route-runs/:runId/approval-context` assembles an `ApprovalManifest` server-side: safe_literal route step values (passenger, cities, departure date), real collar spending limits (`collar.spending_limits.max_with_approval` — never hardcoded), payment method metadata (label + last4 — no PAN/CVV), capabilities to release, custody guarantees, and runtime guarantees. UI shows polished cards: agent identity, risk pill, manifest details section, spending guardrails section, Aegis protections section, after-approval section, approve/reject actions, and a collapsible technical details drawer. For travel_booking manifests: title/subtitle from route metadata, fare labeled "Fare (demo)" as a demo constant, max approved amount from real collar data. For login manifests: login type shown without credentials. Existing approve/reject API calls are unchanged. `ApprovalManifest`, `ApprovalManifestLineItem`, `RunApprovalContext` types added to `packages/types`. Do not rebuild unless explicitly requested.

**Spending Limit Step-Up v1 is complete** — implemented 2026-05-04. Over-limit detection added to the travel booking approval flow. `SpendingLimitStepUp` type added to `packages/types`; `spendingLimitStepUps: Map<string, SpendingLimitStepUp>` added to the store and persisted. Manifest assembly extracted into module-level `buildRunApprovalContext()` helper reused by both GET and the new step-up POST endpoint. `ApprovalManifest` extended with `purchase_amount`, `constraint_warnings`, `approval_blocked`, `approval_block_reason`, `spending_step_up`. When fare ($248) exceeds the collar's `max_with_approval` ($100), the manifest sets `approval_blocked: true` and `spending_step_up.status: "not_requested"`. UI shows an amber over-limit warning banner, disables the approve button, and shows "Request higher limit". User clicks → inline confirm panel → "Approve one-time limit" → `POST /api/route-runs/:runId/spending-step-up` stores the override (never mutates collar) → returns updated context with `spending_step_up.status: "approved"`. UI then shows a green "One-time limit approved" banner, still displays the original collar default, and re-enables the approve button. Approve endpoint uses `spendingLimitStepUps.get(runId)?.approved_limit_usd ?? collar max ?? 500` for `ActionAuthorizationReceipt.constraints.max_amount_usd`. Step-up endpoint not exposed via `/api/agent/v1`. Reject always available. Do not rebuild unless explicitly requested.

**Real Website Observation Dry Run v1 is complete** — implemented 2026-05-04. Agents can request an observe-only inspection of any URL before deciding whether to commit to a route run. `POST /api/agent/v1/observation-dry-runs` navigates to the URL in an isolated headless Chromium session, detects sensitive surfaces (task intent, URL patterns, DOM signals), and returns a structured `ObservationDryRunResult`. Starts in `open_observation` and only escalates to `protected_observation` when sensitivity signals are found — non-sensitive pages return a minimal open summary only, not a full DOM dump. Protected mode builds a redacted `AgentSafeObservationSnapshot` with sensitive fields carrying `value_redacted: true` and `required_capability`. The endpoint is strictly observe-only: no clicks, no typing, no form submit, no credential fill, no capability release, no KMS decrypt, no route execution, no screenshots. Shared observation helpers extracted into `apps/api/src/runtime/agentSafeObservation.ts` (`scanPageForSensitivitySignals`, `buildAgentSafeObservationSnapshot`, `buildMinimalOpenObservation`, `SENSITIVE_URL_PATTERNS`, `isSensitiveTaskCategory`, `urlLooksSensitive`). `playwrightRuntime.ts` route execution behavior is unchanged. Example: `examples/real-website-observation-dry-run.mjs`. Types: `ObservationDryRunResult`, `ObservationDryRunOpenSummary`, `ObservationDryRunSensitiveSurface`, `ObservationDryRunStatus`, `ObservationDryRunRecommendation`. Do not rebuild unless explicitly requested.

**Authenticated Session Boundary v1 is complete** — implemented 2026-05-04. Agents can request Aegis to perform a login on their behalf without ever receiving credentials, cookies, storage, or session tokens. Flow: agent calls `POST /api/agent/v1/authenticated-sessions/login-request` → session created with `status: pending_approval` → user approves in `/route-run-approvals` → Aegis logs in via isolated headless Playwright → agent polls to `authenticated` → agent calls observe/navigate endpoints. All three `raw_cookies_revealed_to_agent`, `raw_storage_revealed_to_agent`, `raw_credentials_revealed_to_agent` fields are `false` literal on every response. Real-web login requests are supported for test accounts — the code uses generic selectors and stops immediately on any security challenge (2FA, CAPTCHA, passkey, device verification, bot detection) — no bypass. Treat as experimental for real sites; missing vault credential or selector failure results in `status: "failed"` safely. KMS credential resolution uses existing `local_dev` provider and `purpose: "login_password"`. KMS audit event recorded with `run_id: "authsession:<sessionId>"`. Post-login navigation is same-domain `page.goto` only — no form submit, no POST, no clicking, no credential fill after login. Approval UI at `/route-run-approvals` shows a "Login session requests" section explicitly stating all 4 custody guarantees. New endpoints: `GET/POST /api/authenticated-sessions` (internal UI), `POST /api/agent/v1/authenticated-sessions/login-request`, `GET /api/agent/v1/authenticated-sessions/:id`, `GET /api/agent/v1/authenticated-sessions/:id/observe`, `POST /api/agent/v1/authenticated-sessions/:id/navigate`. Demo: `examples/authenticated-session-boundary-demo.mjs`. Do not rebuild unless explicitly requested.

**Agent-Browser Secret Injection v1 + One-Approval Credential Use Authorization + Real GitHub Test — complete (2026-05-04).**

Agents use their own Playwright browser for navigation, clicking, reading, and form submission. Aegis fills only the protected credential fields (username, password) via CDP. One user approval covers both fields per login attempt. Authorization becomes `fulfilled` after both fields are used once — replay blocked with `AUTHORIZATION_FULFILLED`. Tested successfully against real GitHub with private repo (`NordaTestUser/Test-Repo`). See `docs/REAL_GITHUB_SECRET_INJECTION_TEST.md` for full checkpoint.

Key invariants:
- `request_secret_field_injection` is the PRIMARY login path for agent-controlled browsers.
- `request_authenticated_session_login` is SECONDARY/EXPERIMENTAL — for isolated Aegis-controlled browser sessions only.
- `raw_value_revealed_to_agent: false` and `raw_values_revealed_to_agent: false` are TypeScript literal `false`.
- `CredentialUseAuthorization.max_uses_per_field = { username: 1, password: 1 }` by default.
- Do not rebuild unless explicitly requested.

**Current working state:**
- Primary login path: `request_secret_field_injection` (agent-browser CDP injection)
- Authenticated Session Boundary: secondary/experimental — retained, do not remove
- `plan_aegis_action` for login tasks now recommends `agent_browser_secret_injection` / `request_secret_field_injection`
- `discover_installed_skills` guidance updated: no skill needed for normal login, use `request_secret_field_injection`

**Approval Wakeup/Polling v1 — complete (2026-05-04).**

After `request_secret_field_injection` returns `pending_approval`, agents no longer ask the user to type "done". Instead: agent tells user to approve in Aegis UI, then calls `wait_for_credential_authorization({ authorization_id })` — polls `GET /api/agent/v1/credential-authorizations/:id` and returns automatically when approved/denied/expired/timeout. Agent continues without user text input. New endpoint and MCP tool added. Do not rebuild unless explicitly requested.

**Task Browser Lifecycle v1 — complete (2026-05-04).**

Aegis now manages ephemeral Chrome browser session lifecycle. Agents no longer need to manually run `npm run chrome:agent`. Flow: agent calls `start_task_browser_session` (MCP tool or `POST /api/task-browser-sessions`) → Aegis launches Chrome with a fresh `/tmp/aegis-agent-browser-<id>` profile and CDP on port 9222 → agent uses Playwright MCP tools for navigation/clicking → Aegis uses CDP for secret injection (unchanged) → agent calls `close_task_browser_session` when task is complete → Chrome killed, profile deleted.

Key implementation:
- `packages/types/src/index.ts`: `TaskBrowserSession` type, `TaskBrowserSessionStatus`
- `apps/api/src/runtime/taskBrowserSessions.ts`: `taskBrowserSessions` Map, `taskBrowserProcesses` private Map, `createTaskBrowserSession`, `getTaskBrowserSession`, `closeTaskBrowserSession`, `expireInactiveTaskBrowserSessions`
- `apps/api/src/routes/task-browser-sessions.ts`: `POST /api/task-browser-sessions`, `GET /api/task-browser-sessions`, `GET /api/task-browser-sessions/:id`, `POST /api/task-browser-sessions/:id/close`
- `examples/aegis-tool-server.mjs`: `start_task_browser_session`, `get_task_browser_session`, `close_task_browser_session` MCP tools
- `plan_aegis_action` login workflow updated with step 0 (start_task_browser_session if no browser running) and step 10 (close after task complete)

Key invariants (all in CLAUDE.md):
- Sessions always ephemeral — `ephemeral: true` literal, never persistent paths via API
- Port 9222 fixed in v1 — `PORT_IN_USE` (409) with actionable message on conflict
- `taskBrowserProcesses` Map private — PIDs never exposed to agents or API callers
- MCP tool responses omit `user_data_dir` (local path) — return only `cdp_url`, `ephemeral`, `expires_at`, `cleanup_complete`
- Do NOT close after login — keep session open until task is fully complete
- Chrome `exit` event marks orphaned sessions `"failed"` and cleans up
- Do not rebuild unless explicitly requested.

**Verification steps:**
1. Start Aegis API: `npm run dev` in `apps/api`
2. `curl -X POST http://localhost:4000/api/task-browser-sessions` → `{ ok: true, data: { status: "ready", cdp_url: "http://localhost:9222", ... } }`
3. Chrome opens — `curl http://localhost:9222/json/version` responds
4. Run GitHub login with Playwright MCP + `request_secret_field_injection` (unchanged from prior test)
5. `curl -X POST http://localhost:4000/api/task-browser-sessions/<id>/close` → `{ ok: true, data: { status: "closed", cleanup_complete: true } }`
6. `lsof -i :9222` returns nothing — Chrome gone
7. `/tmp/aegis-agent-browser-<id>` deleted
8. Call `start_task_browser_session` again → new clean session (no GitHub login state)
9. Port conflict test: with Chrome running, second POST → `{ ok: true, data: { reused_existing: true, ... } }` (reuses active session)

**Autonomous Browser Conflict Handling + Repo Reading Guidance v1 — complete (2026-05-05).**

`createTaskBrowserSession` now autonomously resolves port 9222 conflicts in four cases — no user is ever asked to manage ports or kill Chrome:
- Case A (tracked ready session, CDP alive): return existing session; `reused_existing: true`; no new Chrome spawned
- Case B (tracked stale session — expired/failed): SIGTERM + recycle; fresh session on 9222 if freed, else 9223–9230
- Case C (unknown process on 9222): server-log only; fresh session on 9223–9230; `port_auto_selected: true`, `requires_browser_reconnect: true`
- Case D (no ports 9222–9230 available): `NO_PORTS_AVAILABLE` HTTP 503; agent-safe message only

New helpers in `taskBrowserSessions.ts`: `isCdpAlive`, `waitForPortFree`, `findAvailablePort`, `findSessionByPort`, `launchChrome` (extracted from `createTaskBrowserSession`).
New exported type: `CreateTaskBrowserResult` (route/MCP metadata layer only — not on `TaskBrowserSession`).
Route: HTTP 200 on reuse, 201 on create, 503 on `NO_PORTS_AVAILABLE`. `PORT_IN_USE` (409) no longer thrown.
MCP `start_task_browser_session`: reads `reused_existing`/`port_auto_selected`/`requires_browser_reconnect`; conditional `next_action` (no port numbers, lsof, or shell instructions in user-facing text); tool description updated.
`planAegisAction` step 0 updated for `requires_browser_reconnect`. Step 11 added: repo-reading verification guidance (check count, scroll, check pagination; no "all repos" claim without verification; agent owns reading).
`CLAUDE.md` Task Browser Lifecycle invariants updated. Do not rebuild.

**Verification:**
1. Start API. `POST /api/task-browser-sessions` → 201, `status: "ready"`, Chrome opens.
2. `POST /api/task-browser-sessions` again → 200, `reused_existing: true`, same `browser_session_id`, one Chrome process.
3. `node -e "require('net').createServer().listen(9222)"` to bind 9222 with unknown process; `POST /api/task-browser-sessions` → 201, `port_auto_selected: true`, `requires_browser_reconnect: true`, `cdp_url: "http://localhost:9223"` (or next free). Server console: "Port 9222 occupied by unknown process".
4. No `lsof`, no port numbers in prose, no shell commands in any `next_action` or `user_message`.
5. `plan_aegis_action` with `"log into GitHub and summarize my repos"` → step 0 mentions `requires_browser_reconnect`; step 11 present with repo verification guidance.

**Credential Provider Model v1 — complete (2026-05-05).**

Provider/account-first UX layer on top of the existing domain-bound security model. Users see "GitHub · Sebasparky" labels instead of raw domains in approval and vault UI; domain binding remains the security primitive.

Key additions:
- `CredentialProviderDefinition`, `CredentialProviderMatch` types in `packages/types/src/index.ts`
- `apps/api/src/lib/credentialProviders.ts` + `apps/web/src/lib/credentialProviders.ts` — 13-provider registry (GitHub, Google, Microsoft, Apple, Supabase, Vercel, AWS, Stripe, Slack, Discord, Notion, Linear, Figma) + helpers
- `normalizeLoginDomain(input)` — strips protocol/path/port/www; `findCredentialProviderByDomain(domainOrUrl)` — display-only lookup (does NOT authorize injection); `getCredentialDisplayLabel(pass)` — `"GitHub · username"` format; `getInjectionSafetyCopy(opts)` — three-domain clarification text
- `/route-run-approvals`: `PendingInjectionCard` shows provider badge + injection safety copy; `PendingCredAuthCard` shows provider badge, `"GitHub · pass_label"` in account section, and `"Allow use of GitHub · pass_label"` button
- `/passes`: vault pass list shows provider badge (e.g. "GitHub") next to label
- `examples/aegis-tool-server.mjs`: `list_vault_passes` description updated with credential provider domain guidance; `request_secret_field_injection` and `plan_aegis_action` step 3 updated with provider-domain matching rules and OAuth cross-domain example
- `docs/CREDENTIAL_PROVIDER_MODEL.md` — three-domain model, OAuth example (Supabase→GitHub), non-goals, future work

Key invariants (see CLAUDE.md):
- `findCredentialProviderByDomain` is display-only — never used to authorize or validate injection
- Injection domain validation remains in the CDP fill endpoint (pass.domain check)
- `is_custom: true` for unrecognized domains — display as `"domain · username"` fallback
- Registry is intentionally small — do not add entries without product need
- Both registry files have a TODO to move to `@aegis/credential-providers` when a shared package is created

Do not rebuild unless explicitly requested.

**Dynamic CDP Targeting for Challenge Injection v1 — complete (2026-05-07).**

`executeChallengeInjectionViaCDP` now resolves the CDP URL dynamically from the task browser session when `challenge.browser_session_id` is set, rather than always using static `AEGIS_PLAYWRIGHT_CDP_URL`. If a session ID is present, it looks up `taskBrowserSessions.get(browser_session_id)` and uses `session.cdp_url` — which reflects the actual port (9222, 9223, etc.). Falls back to `AEGIS_PLAYWRIGHT_CDP_URL` only for legacy challenges with no session ID. Updated error messages: `BROWSER_SESSION_NOT_READY` (session expired/not found) and `CDP_NOT_CONFIGURED` (no session and no env var). `report_security_challenge` MCP tool description updated to require `browser_session_id` when using a task browser session. `plan_aegis_action` workflow step 9a added for challenge detection flow. Do not rebuild.

**Connected Email Challenge Resolver v1.1 — complete (2026-05-07).**

Two-phase Gmail search with restricted body-fetch fallback. Phase 1: metadata scan (subject + snippet extraction). Phase 2: `format=FULL` body fetch for the best candidate only if Phase 1 fails (at most 2 body fetches, body capped at 20,000 chars, immediately discarded). Provider architecture generalized via `VERIFICATION_EMAIL_POLICIES` registry — GitHub is the only provider in v1.1; future providers (Google, Microsoft, etc.) can be added without rewriting the resolver. `extraction_source` ("subject_snippet" | "body_text") is safe metadata on `ChallengeEmailResolution`. Domain check uses `isEmailChallengeSupported(domain)` from registry (replaces hardcoded "github.com" check in both route files). Body text is function-local — never stored, logged, or returned. Manual fallback retained on `not_found`. Do not rebuild.

**Aegis Workspaces v0 + Workspace Effective Permissions v1 — complete (2026-05-11).**

Backend-only multi-agent coordination layer. Multiple delegated agents can share tasks and artifacts within a permissioned workspace.

Data model (all in `packages/types/src/index.ts`):
- `AegisWorkspace` — named context with a workspace collar and participant delegation list
- `WorkspaceTask` — claimable work unit; `open → in_progress → completed / cancelled`
- `WorkspaceArtifact` — text output (max 50 KB); kinds `text`, `json`, `csv`, `markdown`

Access model:
- Three guards in order: workspace active → workspace collar active → delegation is a participant
- Effective permission = intersection of workspace collar and `delegation.default_collar_id` collar; stricter wins
- Seven new `ActionType` values: `workspace_read`, `workspace_task_list`, `workspace_task_claim`, `workspace_task_complete`, `workspace_artifact_create`, `workspace_artifact_list`, `workspace_artifact_read`
- Strict opt-in: absent from both `allowed_actions` and `approval_required_actions` = hard block
- `approval_required` from either collar → 403 `WORKSPACE_PERMISSION_REQUIRES_APPROVAL` (no approval inbox in v1)
- PATCH /tasks/:taskId validates `action` ("claim" or "complete") before the permission check — `INVALID_ACTION` always returns 400

Agent API endpoints (all under `/api/agent/v1/workspaces/`):
- `GET /:id` — workspace metadata; never exposes `owner_user_id`
- `GET /:id/tasks` — task list (open + mine by default; optional `?status=` filter)
- `PATCH /:id/tasks/:taskId` — claim or complete a task; claim is idempotent if already mine
- `POST /:id/artifacts` — create artifact; content never returned in POST response
- `GET /:id/artifacts` — list artifact metadata (no content)
- `GET /:id/artifacts/:artifactId` — read artifact with content

User-facing endpoints: `POST /api/workspaces`, `GET /api/workspaces`

Key files:
- `apps/api/src/lib/workspaceDomain.ts` — `requireWorkspaceAccess`, `checkWorkspacePermission`, `emitWorkspaceAudit`
- `apps/api/src/routes/agent-api.ts` — six workspace handlers
- `apps/api/src/routes/workspaces.ts` — user-facing CRUD
- `apps/api/src/__tests__/workspace-coordination.test.ts` — 35 passing tests

Not yet built: Supabase persistence, MCP tools, UI, workspace invite flow, workspace CRUD approval inbox.

Do not rebuild unless explicitly requested.

**Real-Agent Workspace Trial Setup — complete (2026-05-11).**

Minimal setup to hand two real Claude agents bearer tokens and observe actual integration behavior.

Key additions:
- `collar_demo_starter.allowed_actions` in `seed-demo-data.mjs` now includes all seven workspace action types — workspace ops were previously hard-blocked after `npm run seed:demo`
- `ws_coord_trial_001` workspace seeded with `delg_demo_001` (Agent A) and `delg_demo_restricted` (Agent B) as participants; two open tasks (`task_coord_001`, `task_coord_002`)
- Workspace maps (`aegisWorkspaces`, `workspaceTasks`, `workspaceArtifacts`, `workspaceAuditEvents`) wired into `persistStore()`, `loadStore()`, and `resetStoreForDemo()` in `persistence.ts` — artifacts survive server restart
- `STARTER_COLLAR.id` fixed to `"collar_demo_starter"` (was `randomUUID()`) in `seedDefaultData()` — workspace collar reference resolves on fresh-start path
- Both demo delegations (`delg_demo_001`, `delg_demo_restricted`) now seeded in `seedDefaultData()` — workspace participant checks resolve on fresh-start path
- `docs/WORKSPACE_TRIAL_RUNBOOK.md` — runbook with 7 curl examples, Agent A and Agent B system prompts, 12-item observation checklist, and observed-roadblocks table

Trial flow: `npm run seed:demo` → `npm run dev` → hand tokens → observe. Agent A: `pass_demo_001`. Agent B: `pass_demo_002`. Workspace: `ws_coord_trial_001`.

Do not rebuild these seed/persistence additions unless explicitly requested.

**Collar-Routing Trial — passed (2026-05-11).**

Sequential real-agent trial with two differentiated collar delegations. Research-collared delegation (pass_demo_001 / collar_research_001) completed task_coord_001 and created `aegis-pillars-summary.md`. Review-collared delegation (pass_demo_002 / collar_review_001) completed task_coord_002 after task_coord_001 and the artifact existed. Open task task_coord_003 was claimable by either delegation. No duplicate completion. Collar-based eligibility and artifact-gated readiness worked correctly end-to-end. See `docs/WORKSPACE_TRIAL_RUNBOOK.md` Trial 2.

**Concurrent Real-Agent Trial — passed (2026-05-11/12).**

Two real Claude agents ran concurrently against `ws_coord_trial_001`. Research delegation claimed task_coord_001 and created the artifact. Review delegation saw task_coord_002 blocked, claimed task_coord_003 while waiting, created `workspace-usage-analysis.md`, then refreshed and completed task_coord_002 after unblocking. Research delegation saw task_coord_003 in_progress by another, received `TASK_ALREADY_CLAIMED`, refreshed and stopped correctly. Final state: all tasks completed, correct delegations, no duplicate work, all artifacts created. See `docs/WORKSPACE_TRIAL_RUNBOOK.md` Trial 3.

Observed friction addressed in next increment: agents used `content_type` instead of `kind` on artifact POST; no machine-readable recovery hint on 409 errors.

**Workspace Manifest Operations Schema + 409 Recovery Hints — complete (2026-05-12).**

Manifest polish increment based on concurrent trial observations.

Changes:
- `GET /manifest` operations stubs now include `body_schema` for write operations:
  - PATCH /tasks/{taskId}: `{ action: '"claim" | "complete"' }`
  - POST /artifacts: `{ name: "string (required)", kind: '"text"|"json"|"csv"|"markdown" (required)', content: "string (required, max 50KB)", task_id: "string (optional)" }`
- `TASK_ALREADY_CLAIMED` (409) now includes `error.recovery_hint: "refresh_manifest"`
- `TASK_NOT_READY` (409) now includes `error.recovery_hint: "refresh_manifest"`
- `docs/WORKSPACE_TRIAL_RUNBOOK.md` updated with explicit `kind` field guidance and `--data-binary @artifact.json` curl pattern for large markdown artifacts

Verification: 114 workspace tests passing, typecheck clean.

Do not rebuild unless explicitly requested.

**Workspace UI v1 — complete (2026-05-12).**

Owner-facing web pages for workspace monitoring and control.

Pages added:
- `/workspaces` (`apps/web/src/app/workspaces/page.tsx`) — workspace list with task counts and status badges
- `/workspaces/:id` (`apps/web/src/app/workspaces/[id]/page.tsx`) — workspace detail: task board (grouped by readiness), artifact panel (list + content viewer + create form), participants panel (delegations with collar IDs)

Owner-facing API in `apps/api/src/routes/workspaces.ts`:
- `POST /api/workspaces` — create workspace
- `GET /api/workspaces` — list workspaces for owner
- `GET/POST /api/workspaces/:id/tasks` — list and create tasks
- `PATCH /api/workspaces/:id/tasks/:taskId` — update task status
- `GET/POST /api/workspaces/:id/artifacts` — list metadata and create text/json/csv/markdown artifacts
- `GET /api/workspaces/:id/artifacts/:artifactId` — read artifact with content

Not included: file uploads, approval inbox, workspace invite, MCP exposure. File artifacts are Workspace Artifact Uploads v1.

Do not rebuild unless explicitly requested.

**Workspace MCP Tools v1 — complete (2026-05-12).**

Six workspace MCP tools added to `examples/aegis-tool-server.mjs` exposing the existing workspace HTTP API natively to Claude Code agents. No backend or API changes were required.

Tools added:
- `get_workspace_manifest` — orientation manifest; call first; refresh on TASK_ALREADY_CLAIMED / TASK_NOT_READY
- `claim_workspace_task` — set task in_progress; returns 409 with recovery_hint on contention
- `complete_workspace_task` — mark task completed after required artifacts are created
- `list_workspace_artifacts` — metadata only; use read_workspace_artifact for content
- `read_workspace_artifact` — fetch artifact content by ID
- `create_workspace_artifact` — POST artifact with `{ name, kind, content, task_id? }`; use `kind` not `content_type`

MCP-only trial using bearer tokens pass_demo_001 and pass_demo_002 validated both collar-routed work and open-task work through MCP tools. The research-collared delegation completed task_coord_001 and created aegis-pillars-summary.md. The review-collared delegation completed task_coord_002 after the dependency artifact existed. The open task task_coord_003 was completed through the MCP tool flow. Final state: open 0, in_progress 0, completed 3. No raw curl needed.

Key invariant: `AEGIS_AGENT_TOKEN` must be set to the bearer token value (e.g. `pass_demo_001` or `pass_demo_002`) — not the delegation ID. The tool server uses this for all workspace calls.

Do not rebuild unless explicitly requested.

**Local Runtime Browser Endpoint + antigen-browser Adapter + Credential Step Handoff v1 — complete (2026-05-22).**

Full architecture for agent-controlled local browser sessions with Aegis-owned sensitive micro-steps.

Key additions:
- `POST /api/agent/v1/runtime/browser-endpoint` (`apps/api/src/routes/agent-api.ts` or `task-browser-sessions.ts`) — provisions or reuses an ephemeral runtime browser session for the requesting delegation; returns `browser_runtime_id`, `cdp_url`, `status`, `ephemeral: true`
- `examples/antigen-browser-adapter.mjs` — resolves the dynamic CDP port at startup via the browser-endpoint API, then spawns `@playwright/mcp --cdp-endpoint <cdp_url>`; no static port config; no platform restart required when Chrome selects an alternate port
- `apps/api/src/routes/agent-connectors.ts` — `buildSetup()` returns two MCP server entries: `antigen` (trust tools) and `antigen-browser` (adapter script); `browser_runtime_guidance` field explains each server's role
- `execute_credential_step_handoff` MCP tool — atomic fill + click approved submit button + await navigation; step types: `username_next`, `password_submit`; returns `status` (`navigated`, `challenge_detected`, `failed`), `post_handoff_url`; agent does not regain control until after page navigation
- JS-layer value shadow applied after CDP fill — defense-in-depth only, not a browser-engine boundary; the primary security protection is the atomic handoff (form navigates away before agent resumes)
- Password masking from `browser_snapshot`: `Object.defineProperty` shadow makes `element.value` return `""` to Playwright/aria serializers while native form submission is unaffected

GitHub end-to-end smoke test (2026-05-22):
- `tbsess_751b7d77e99e` — runtime browser session
- `credauth_6cc95b34f918` — credential-use authorization
- `csh_20e4559a9c3e` — handoff; status `navigated`; post-handoff URL `https://github.com/`; page title "GitHub"
- No raw credential value exposed to agent; no `browser_snapshot` between fill and submit
- `NordaTestUser` — 1 private repo (`Test-Repo`) read post-login; login succeeded without 2FA/passkey/email challenge

Architecture confirmed: Antigen provisions runtime → `antigen-browser` drives ordinary browsing → Antigen executes sensitive micro-step → `antigen-browser` resumes.

Credential Step Handoff v1 covers login credential submit only. Payments, purchases, account deletion, and public posting require separate approval models (Payment/Card Step Handoff v1 is the next candidate).

Do not rebuild unless explicitly requested. See `docs/LOCAL_RUNTIME_BROWSER_ENDPOINT.md` for full architecture and the "Proven End-to-End Smoke Test" and "Credential Step Handoff" sections.

**Candidate next milestones:**

1. **Payment/Card Step Handoff v1** — atomic card-field fill and purchase confirmation as separate approvals; card fill approval is distinct from final pay/subscribe approval; requires a new `execute_payment_step_handoff` primitive (not an extension of `execute_credential_step_handoff`)
2. **Workspace Artifact Uploads v1** — add file artifact support (PDF, images, Word docs); owner upload form; agent metadata list and download via collar-checked endpoint; local filesystem storage under `.aegis-artifacts/`
2. **Task-scoped sensitive grants** — per-task autonomy configuration (e.g. "this task may login without additional approval"); deferred until trial feedback indicates need
3. **Stale task claim leases** — heartbeat + automatic reclaim for abandoned `in_progress` tasks; deferred until trial demonstrates the problem
4. **Production KMS Provider v1** — real cloud KMS integration (AWS KMS, GCP KMS, or HashiCorp Vault) replacing `cloud_kms_stub`
5. **External Agent OAuth/App Registration v1** — durable agent identity beyond single-token delegations

Constraints for any of the above:
- Agents never receive a Playwright handle or browser context
- Collar restrictions always win
- Sensitive steps go through the existing Runner / approval flow
- Do not break the existing `/demo` flow
- Use real Claude-agent trials for workspace feature validation; avoid fake external agent scripts unless explicitly requested

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
