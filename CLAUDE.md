# Aegis — AI Session Guide

## One-Line Thesis

Aegis is the trust and workflow layer for delegated AI action.

## What Aegis Is

Agents are becoming capable enough to act across the web, but the web does not yet know how to trust them. Today, agents improvise on websites built for humans, wasting context, increasing failure rates, and creating liability ambiguity.

Aegis gives agents identity, scoped permissions, verified workflow routes, runtime guardrails, and auditability. It is not an agent builder. It is the layer users and businesses attach to agents before those agents act on their behalf.

- **Google Maps for AI agents.** Aegis makes websites navigable for agents through verified routes, scoped permissions, and trust signals.
- **ID badges for AI workers.** Aegis gives agents identity, access rules, verified workflows, supervision, and accountability.

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

### 2. Delegation and Permissions (Collars)
Users explicitly grant agents scoped authority through **Collars** — customizable, signed, revocable policy objects that define what the agent can do, on which sites, for how long, with what spending limits, what requires approval, and what is forbidden. Use "collar" in code. Use "scoped permissions" or "delegation" in product copy.

### 3. Verified Workflow Routes — Aegis Rails
Agents should not improvise inside sensitive workflows when a verified route exists. A route is not a markdown file — it is a structured, inspectable, permission-scoped, versioned, reviewed, and enforceable execution path. See `docs/AEGIS_RAILS.md`.

### 4. Runtime Guardrails — Aegis Guard
`SensitiveActionDetector` (rule-based classification) + `PolicyService` (collar + route enforcement) + approval inbox (human-in-the-loop) + session pause/block/revocation. Sensitive actions to catch: transfer/payment/purchase, submit order, accept terms, grant OAuth, delete data, send messages, change settings, add payment method, connect external account, identity disclosure.

### 5. Accountability and Audit Trail
Aegis records authority granted, route followed, actions taken, approvals, and blocks. **Receipts** capture trust-relevant events, not everything.

## Architecture Principles

- **Agent autonomy above, Aegis enforcement below.** Agents use their own tools for browsing, reading, and reasoning. Aegis is invoked only for trust-sensitive execution: verified workflow routes, credentialed actions, approval gates, and audit receipts.
- **Enforcement outside the model.** Collar and route enforcement happens through tools, tokens, browser sessions, and approval flows — not prompts.
- **Control the action boundary, not every thought.** Only interrupt at sensitive commitments.
- **Treat outside agents as untrusted.** Validate pass, collar, session, and action at every step.
- **Declarative routes only.** No arbitrary marketplace code execution inside user accounts.
- **Store structure, not private data.** Prefer accessibility tree and DOM metadata over full screenshots. Never store raw passwords, card numbers, or full identity documents.
- **Prefer local processing.** Minimize data sent off-device for route compilation and enforcement.
- **Sensitive workflows default to approval.** When uncertain, prefer `approval_required` over silent allow.
- **Browser extension teaches, Playwright verifies, action API executes.** These three surfaces have separate roles and must not be mixed. Agents never receive a Playwright handle or unrestricted browser context.
- **Prefer real-world testing with guardrails over localhost-only demo safety.**

## Current Implementation State

See `docs/NEXT_SESSION_PROMPT.md` for full implementation history and current working state.

Key surfaces: Core guard loop (`/demo`), Aegis Rails (`/rails`), Playwright runtime (`aegis_playwright` is primary), External Agent API (`/api/agent/v1`), MCP Tool Server (`examples/aegis-tool-server.mjs`), Aegis Workspaces (`/api/agent/v1/workspaces/`). Seed with `npm run seed:demo`.

`aegis_playwright` is the primary controlled execution surface for autonomous agents. Chrome extension is retained as an optional local/debug/recording companion.

Workspaces are the shared, permissioned coordination layer for multiple collar-bearing delegations. Agents coordinate through manifests, tasks, artifacts, collars, readiness queues, and audit events. See `docs/WORKSPACE_TRIAL_RUNBOOK.md` for trials and runbook.

## Candidate Next Milestones

1. **Typing Speed / Input Realism v1** — field-kind-aware input realism layer for sensitive-field handoff; CDP key events preferred over direct assignment; secret-safe diagnostics; lifecycle-compatible with `executing_at`/`filled_at`; not bot evasion. See `docs/TYPING_INPUT_REALISM.md`.
2. **Workspace MCP tools** — expose manifest, task claim/complete, artifact create/read as MCP tools
3. **Workspace UI / monitoring surface** — task list, artifact viewer, participant status for workspace owners
4. **Production KMS Provider v1** — swap `LocalDevKmsProvider` for a real cloud KMS
5. **External Agent OAuth/App Registration v1** — durable agent identity beyond single-token delegations

See `docs/NEXT_SESSION_PROMPT.md` for the full completed increment list.
See `docs/RAILS_ARCHITECTURE.md` for the full technical architecture.

## Session Rules for Every AI Coding Session

Before making any changes:

- Read `docs/NEXT_SESSION_PROMPT.md` to understand current working state and recommended next steps
- Read `docs/RAILS_ARCHITECTURE.md` when working on Aegis Rails recording, verification, or execution
- Inspect only files relevant to the requested task
- Do not broad-refactor; the /demo flow is fragile to architectural changes
- Do not introduce real secrets, real card numbers, or real payment submission
- Do not add Supabase to routes/skills/delegations/sessions/reputation unless explicitly requested (`AEGIS_PERSISTENCE_PROVIDER=supabase` enables durable storage for vault passes, encrypted secrets, and receipts)
- Do not add real auth or real LLM API calls unless explicitly requested
- Keep Aegis Guard (detector, policy, approval) separate from browser automation
- Keep domain logic separate from UI
- Preserve all existing service boundaries: CollarService, PassService, BrowserSessionService, SensitiveActionDetector, PolicyService, ApprovalService, RunnerService, ReceiptService, ReputationService

**Global secret-safety rule:** API responses, receipts, audit events, trust profiles, safety profiles, observations, passports, assertions, manifests, and capability releases must never contain raw passwords, `secret_ref` values, `devvault://` references, plaintext credentials, encrypted blobs, KMS envelopes, ciphertext, private keys, PAN, CVV, card numbers, or Playwright storageState. Always aggregate-only: counts, IDs, booleans, domains.

**Do-not-rebuild list** — do not rebuild any of the following unless explicitly requested:

- Popup auto-run, background auto-run, replay fill reliability, Wikipedia outcome verification
- Agent-runnable recipe path; controlled sensitive login path
- Secret Vault v1 and Secret Vault UI v1
- KMS Abstraction v1; Cloud KMS Provider v1
- Supabase Persistence v1
- Route-to-Pass Binding v1; natural-language credential selection v1; controlled tab launch
- Credential session context binding v1
- Immutable + Signed Receipts v1
- Playwright Runtime v1; Auto-start Playwright Runs v1; Execution Surface Recenter v1
- Sensitive Workflow Detection v1
- Delegation Passport v1
- Action Authorization Receipt v1
- Delegation Trust Profile v1
- Website Assertion / Handshake v1
- Real Payment / Travel Mock Route v1
- Coverage Violation Blocking v1
- Capability Release Gate v1
- Sensitive Workflow Observation Mode v1
- Website Agent-Safety Profile v1
- Website .well-known Aegis Policy v1
- External Agent Delegation API v1
- Agent Approval Context Panel v1; Spending Limit Step-Up v1
- Real Website Observation Dry Run v1
- Authenticated Session Boundary v1
- Agent-Browser Secret Injection v1
- One-Approval Credential Use Authorization
- Ephemeral Agent Browser Session + No-Save Policy v1
- Task Browser Lifecycle v1
- Sensitive Action Receipt Timeline v1
- Password Import / Migration v1
- Sensitive Requirement Assessment v1
- Aegis Workspaces v0; Workspace Effective Permissions v1
- Workspace Manifest + 409 Recovery Hints v1
- Collar-Routing Trial seed; Concurrent Real-Agent Trial

## Login and Secret Injection Rules

- **Agent-Browser Secret Injection v1 is the primary path** for normal username/password login in agent-controlled browsers (e.g. Claude Code with `@playwright/mcp`).
- Agent owns: navigation, clicking "Next"/"Sign In"/"Submit", form submission, login method selection (GitHub username/password, not OAuth), and reading page content.
- Aegis owns: protected value custody, approval gates, CDP injection, KMS resolution, and audit.
- One credential-use approval covers one login attempt only — username once, password once.
- Credential-use authorizations are same-domain, same-pass, same-delegation, short-lived (5 min), one-use-per-field. After both fields filled, authorization becomes `fulfilled` and cannot be reused.
- `request_authenticated_session_login` is secondary/experimental — use only when the agent has no browser or explicitly requests an isolated Aegis-controlled browser.
- `start_credential_session` / `fill_credential_field` are extension/user-tab targeted and must not be used with Claude/Playwright agent browser flows.
- Routes/skills are for high-risk workflows where the exact action sequence matters: payments, banking, stock trades, account deletion, irreversible submissions.
- After `request_secret_field_injection` returns `pending_approval`, agents must call `wait_for_credential_authorization` — do NOT ask the user to type "done". The user acts in the Aegis UI; the agent waits via tool polling.


**KMS / Secret Vault invariants:**

- `cloud_kms_stub` always throws `CLOUD_KMS_NOT_IMPLEMENTED` — never falls back to `local_dev`
- `local_dev` KMS provider is demo-only — do not describe it as production-grade
- `KmsAuditEvent.raw_secret_exposed: false` is a literal type — must always remain `false`; never expose plaintext passwords, ciphertext, nonces, auth tags, key material, or secret_ref values in audit events or `GET /api/kms-audit-events`
- `GET /api/kms-audit-events` is an internal dev endpoint — in-memory only; do not frame as a production public API
- Do not write to or read from `devSecretVault` — deprecated; use `encryptedSecretVault + kms.decryptSecret()` for all password resolution
- Do not directly access `aegisVaultPasses`, `encryptedSecretVault`, or `routeRunReceipts` Maps in vault-passes.ts or receipts.ts — use `getVaultRepository()` / `getReceiptRepository()` instead
- The Supabase vault repository dual-writes to local Maps (temporary bridge). Long-term: migrate all vault/secret reads to repository-backed access
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` outside `apps/api`
- `login_password` passes: username is metadata, password is encrypted and never returned after creation

**Route / Skill execution invariants:**

- `resolve-value` binding lookup key is `${user_id}:${route_id}:login_password` — binding overrides `vp.pass_id`; seeded pass is the fallback
- Do not treat `execution_mode: "agent_runnable"` as permission to skip Aegis — it means fetch and follow the Aegis-tested route recipe
- Do not run `aegis_controlled` routes based on domain alone — route context matching uses domain + optional `url_match`; a controlled route must not execute on the wrong page
- Field-level credential fill is context-bound: use `target_url` when creating a credential session to bind fills to a specific login page; extension leaves fill requests pending (not failed) when active tab doesn't match `url_match`
- Do not assume user has a browser tab open for autonomous-agent flows — use Playwright runtime; do not instruct agents to manually open target pages
- Approval of an `aegis_controlled` run automatically triggers Playwright execution fire-and-forget; do not instruct users to manually call `start_playwright_route_run` unless auto-start has failed

**Receipt / signing invariants:**

- `receipt_hash` and `receipt_jws` are Supabase row metadata — NOT fields on `RouteRunReceipt`; do not add to the type
- Supabase `createReceipt` uses INSERT (not upsert) — append-only; DB trigger blocks UPDATE/DELETE; never bypass
- Pass `previousReceiptHash` to `hashReceipt` in the Supabase path — omitting it produces a broken chain
- `AEGIS_RECEIPT_JWS_PRIVATE_JWK` must remain in `apps/api` env only — never in API responses, logs, or front-end imports
- `receipt_jws` payload covers only metadata (receipt_id, receipt_hash, previous_receipt_hash, issuer, issued_at) — no secrets
- `GET /api/internal/sensitive-receipts/recent` — read-only timeline from existing Maps; supports `since` ("24h" default, "today", "7d", "all") and `event_group` filters. Never include `pass_id`, `secret_ref`, `authorization_hash/jws`, `user_data_dir`, `cdp_url`, raw codes, email body/subject, cookies, or storage. `pass_label` is display metadata only. Agent-provided free-text must be sanitized via `sanitizeReceiptText` before inclusion.

**Sensitive event / coverage invariants:**

- Sensitive event detection is Playwright-first and metadata-only — `element_hint` is structural metadata only (tag, type, name/id/autocomplete/placeholder — never value)
- Do not claim Aegis runtime event detection proves no out-of-band secrets exist
- Timing windows MUST NOT grant `covered_by_aegis` when `requiredCapabilityForEvent` returns a capability type — the release is the only allow condition; timing windows are fallback-only for events with no required capability type
- `unknown_sensitive` high/critical events are not covered by timing windows — classified as `not_covered_by_aegis` conservatively
- `login_credential` release is created only for `secret_ref` fills (password), not for `pass_field` fills (username)
- `payment_method` release is created only for payment-intent click steps in payment/travel routes, and only if a payment method exists in `paymentMethods` Map
- `capability_ref` for `login_credential` = vault pass ID (never `secret_ref`, encrypted blob ID, or password); for `payment_method` = `payment_method_id` (never PAN, CVV, or any payment secret)
- `raw_secret_revealed_to_agent: false` on `RuntimeCapabilityRelease` is a TypeScript literal type — always write it as the literal `false`, never through a variable
- Do not mark uncovered sensitive events as covered globally — `not_covered_by_aegis` events become `covered_by_aegis` only if a coverage window was genuinely opened by an Aegis route step
- Do not fulfill authorizations on violation or missing-capability runs — `ActionAuthorizationReceipt.status` must stay `"active"` when a run fails
- Do not revoke a fulfilled authorization — the action already ran; revoke only applies to `active` authorizations
- Violation receipts are signed, hash-valid, `status: "failed"` — count as negative evidence; do not count as positive category experience

**Trust / reputation invariants:**

- Do not implement generic success-count reputation — trust must be based on Aegis-covered evidence: fulfilled authorizations, verified signed receipts, covered sensitive workflow events, KMS custody attestation
- Low-risk browsing/search tasks do not improve trust for high-risk categories (login, payment, financial_action, etc.) — trust is task-category-specific
- Payment/travel/financial categories (`purchase`, `payment`, `travel_booking`, `financial_action`) can never reach `trusted_for_category` in v1 — maximum is `proven_limited`
- Every trust/delegation/safety profile carries `not_a_guarantee: true`, `out_of_band_secret_use_not_covered: true`, `based_only_on_aegis_observed_events: true` — do not remove or weaken
- Do not claim a Delegation Passport proves the agent has no out-of-band secrets — `aegis_coverage_boundary.aegis_does_not_prove_agent_has_no_out_of_band_secrets: true` must remain in every passport
- Travel booking evidence is category-specific — does NOT improve `payment`, `purchase`, or `financial_action` trust

**Website policy / assertion invariants:**

- Website Aegis Policy is self-asserted in v1 — `limitations.self_asserted_policy: true` and `limitations.not_a_guarantee: true` must always be present
- Policy alone must not upgrade recommendation to `allow` or `allow_with_approval` — observed clean receipt evidence is still required
- Invalid policy → `step_up_required` (not `deny`) — it is a caution signal, not proof of fraud
- Valid policy + no receipts → `step_up_required`; valid policy + violation receipts → `step_up_required`; valid policy + clean receipts → `allow_with_approval`
- The localhost `.well-known` policy is demo-only — do not enable live internet fetching for non-localhost domains unless explicitly requested
- Import direction is one-way: `website-agent-safety.ts` imports from `website-aegis-policy.ts`; do not create a reverse import
- Negative evidence overrides positive in `WebsiteAgentSafetyProfile` — if both clean and violation receipts exist, result is `step_up_required`
- `WebsiteAgentSafetyProfile` is domain-scoped, advisory, not business-verified — do not add signing or JWS unless explicitly requested
- `computeDelegationTrustProfile` is an exported async function in `delegation-trust.ts` — do not re-inline into the GET handler
- Website assertions require `AEGIS_RECEIPT_JWS_PRIVATE_JWK` — no unsigned-dev-mode fallback; missing keys → 500 `SIGNING_NOT_CONFIGURED`

**External agent / approval invariants:**

- `/api/agent/v1` is the stable public external-agent contract; internal routes remain for the Aegis product UI
- Agent identity and delegation must come from bearer token lookup against `agentDelegations.token_id` — never from request body
- User approval must remain in the Aegis UI (`/route-run-approvals`); external agents cannot self-approve via `/api/agent/v1`
- `agent_id` in `ExternalAgentIdentity` is derived from `delegation.agent_name` in v1 — not a globally unique durable ID
- `GET /api/agent/v1/runs/:runId/receipts` returns summaries only — excludes `pass_ids_used`, full `runtime_capability_releases`, `variables`, `allowed_reason`, `route_trust_tier`, `installed_skill_id`, and `user_id`
- Approval UI must render real authorization/constraint data — spending limits come from `collar.spending_limits.max_with_approval`, never hardcoded
- Only `value_policy.type === "safe_literal"` step values may appear in an `ApprovalManifest` line item; `pass_field` and `secret_ref` steps must never be surfaced
- Approval UI must block normal approve when `manifest.approval_blocked === true`; Reject must always remain enabled
- Step-up must never mutate `collar.spending_limits` — only the per-run `spendingLimitStepUps` Map entry is updated
- External agents cannot request or self-approve spending step-ups

**Observation / dry run invariants:**

- Dry runs are strictly observe-only — do not add click, fill, type, form submit, credential fill, KMS decrypt, or route execution to `runObservationDryRun`
- Dry runs start in `open_observation`; escalate to `protected_observation` only on concrete sensitivity signals — do not escalate globally
- `AgentSafeObservationSnapshot` must never contain raw field values — `filled` is a boolean only (`.value.length > 0`); sensitive fields always have `value_redacted: true`
- `page.evaluate()` callbacks in `playwrightRuntime.ts` must use raw JS string IIFEs (not TypeScript arrow functions) — the Node.js tsconfig does not include DOM lib
- Observation mode does not weaken Capability Release Gate — it controls what agents SEE; capability releases control what sensitive actions can PROCEED
- Sensitive fields and buttons have `allowed_actions: ["read", "request_fill"]` or `["read", "request_click"]` — must go through Aegis route steps
- Do not use observation dry run output as a substitute for a proper Aegis-verified route

**Authenticated session boundary invariants:**

- Authenticated session boundary is **experimental/secondary** — primary login path for agent-controlled browsers is `request_secret_field_injection`
- External agents cannot self-approve authenticated session requests — approval is always user-controlled via `/route-run-approvals`
- Session handles must never expose cookies, localStorage, auth tokens, storageState, passwords, `secret_ref`, pass_id, or KMS material — only the safe handle and observation snapshots are returned
- All three `raw_cookies_revealed_to_agent`, `raw_storage_revealed_to_agent`, `raw_credentials_revealed_to_agent` are TypeScript literal `false` — never set to `true`
- Post-login navigation is same-domain `page.goto` only — no form submission, no POST actions; `CROSS_DOMAIN_NAVIGATION_BLOCKED` on any cross-domain URL
- `executeLoginForAuthenticatedSession` must require positive authentication evidence before setting `status: "authenticated"` — form submit alone without positive signals is not sufficient
- `navigateAuthenticatedSession` is restricted to `authenticated` status only — `manual_step_required` cannot navigate; Do not rebuild: Authenticated Session Boundary v1

**Agent-Browser Secret Injection invariants:**

- `request_secret_field_injection` is the PRIMARY injection path for username/password fields in agent-controlled Playwright browsers (e.g. Claude Code with `@playwright/mcp`)
- Agent owns: navigation, clicking "Next"/"Sign In"/"Submit", form submission, choosing username/password vs. OAuth — Aegis does NOT do any of these
- Aegis owns (via CDP injection): only the protected field values — username from vault metadata, password from KMS-encrypted secret
- `SecretFieldInjection.raw_value_revealed_to_agent: false` is a TypeScript literal type — always write as the literal `false`, never through a variable
- CDP fill endpoint `POST /api/agent/v1/injections/:id/execute` never returns the resolved value — only status metadata
- Domain validation: `new URL(injection.page_url).hostname` must match `injection.domain` — no cross-domain injection; clear error: "Aegis will not inject github.com credentials into accounts.google.com."
- Status machine: `pending_approval → approved → executing → filled`; `denied` and `failed` are terminal; `expired` on API restart or after 5-minute TTL
- `AEGIS_PLAYWRIGHT_CDP_URL` is required for CDP fill — missing it returns a clear `CDP_FILL_FAILED` error, not a silent fallback
- `executeSecretInjectionViaCDP` uses `(browser as any).disconnect()` — not `browser.close()`; `disconnect()` preserves the agent's browser session and open tabs.
- Password injection always requires approval in v1; username injection is approved by default only if the collar's `approval_required_actions` does not include `"login"`
- Never include `pass_id` in agent-facing injection responses — expose only `pass_label`, `injection_request_id`, and status metadata

**Challenge Relay invariants (Manual Challenge Code Injection v1 implemented):**

- Agents must not ask users to paste verification codes (email/SMS/TOTP) into chat — call `report_security_challenge`, then `wait_for_security_challenge`, then `inject_security_challenge_code`
- Agents may say: "A verification code was sent. Please enter it in the Aegis UI." — agents must NOT say "Please send me the code"
- `raw_code_revealed_to_agent: false` is a TypeScript literal on `SecurityChallenge` and all agent-facing responses — never set through a variable
- Challenge codes are memory-only in `challengeCodes` Map (runtime/challengeInjection.ts) — never persisted, never logged, deleted after injection or expiry
- Status machine: `pending_user → code_submitted → code_injected`; `cancelled`, `expired`, `failed` are terminal
- Code validation: trim, 4–10 chars, alphanumeric only — enforced in `/api/internal/security-challenges/:id/submit-code`
- Domain validation: injection target must match `challenge.domain` — enforced in agent-api.ts at challenge creation
- CDP injection deletes the code from `challengeCodes` immediately before injecting — regardless of success or failure; no retry with the same code
- On API restart, `pending_user` and `code_submitted` challenges become `expired` in persistence.ts loadStore
- Challenge injection uses `challenge.browser_session_id` → `taskBrowserSessions.get(id).cdp_url` when present; static `AEGIS_PLAYWRIGHT_CDP_URL` is a legacy fallback. Agents must always pass `browser_session_id` from `start_task_browser_session` — without it, injection targets the wrong port.
- Connected Email Challenge Resolver v1.1 is implemented — two-phase Gmail search (metadata scan + body fetch fallback). Do not re-implement.
- Aegis never bypasses 2FA, CAPTCHA, passkeys, or any human-presence security check; no full email body or inbox listing is ever returned to the agent
- Do not rebuild: Manual Challenge Code Injection v1; Connected Email Challenge Resolver v1.1

**Ephemeral Agent Browser Session invariants:**

- Agent browser sessions are ephemeral by default — `npm run chrome:agent` creates a fresh `/tmp/aegis-agent-browser-<timestamp>` profile and deletes it on exit
- `npm run chrome:agent:dev` uses `~/.aegis-chrome-debug-dev` for local development; prints a visible WARNING; must never be used for real credential injection testing
- The Chrome Preferences file written at launch disables password saving, autofill, card saving, and sync — these are the mechanism for the no-save policy, not just a guideline
- Chrome flags for all agent sessions: `--disable-save-password-bubble --password-store=basic --disable-sync --no-first-run --disable-default-apps`
- `persistence_allowed: false`, `browser_storage_allowed: false`, `website_save_allowed: false` on `CredentialUseAuthorization` are TypeScript literal `false` types — always write as the literal `false`, never through a variable; these fields appear in every `CredentialUseAuthorization` object literal
- These three no-save fields are internal policy metadata — do NOT include them in agent-facing API responses
- `save_credential`, `save_payment_method`, and `enable_persistence` are high-risk `ActionType` values — Aegis Guard must detect and block them
- v1 detection uses `targetText` only — `TODO(v2)` comments in `sensitiveDetector.ts` note that checkbox labels and nearby DOM text must be inspected in a future pass; do not remove these TODOs
- Port conflict check exits with a clear error if port 9222 is in use; temp profile cleanup on exit is best-effort; Do not rebuild: Ephemeral Agent Browser Session + No-Save Policy v1

**Task Browser Lifecycle invariants:**

- Sessions are always ephemeral — `ephemeral: true` is a required literal on `TaskBrowserSession`; never use persistent paths via this API
- Port conflicts are resolved autonomously: existing tracked ready session on 9222 is reused if CDP alive; stale sessions are relaunched; unknown process on 9222 → launch on 9223–9230 (`port_auto_selected: true`); no ports available → `NO_PORTS_AVAILABLE` 503
- `PORT_IN_USE` (409) is no longer thrown — do not re-introduce it
- Do NOT inject secrets into untracked / unknown-process browsers — Case C (unknown process on 9222) always launches a fresh Aegis-owned session on an alt port
- CDP is for secret injection only (`request_secret_field_injection`); agent uses Playwright MCP for all navigation and clicking; do not close the session immediately after login — close only after full task completion
- `raw_cookies_revealed_to_agent: false` and `raw_storage_revealed_to_agent: false` must appear in all MCP tool responses that reference a task browser session; `user_data_dir`, PIDs, and child process handles must never be exposed to agents or API callers
- Do not rebuild: Task Browser Lifecycle v1

**Miscellaneous invariants:**

- Do not claim real payment processing — the travel booking flow is a mock workflow; no real money is processed
- `safe_literal` and `enum_selection` value policies in Playwright runtime use `vp.value` directly — no KMS resolution; `pass_field`/`secret_ref` still go through `resolveRouteStepValue`
- `authorization_hash` intentionally excludes `status` and `fulfillment` — do not change the hashing strategy
- `authorization_context` on `RouteRunReceipt` links an execution receipt back to the authorization — populate in both success and failure paths
- Action authorization signing requires `AEGIS_RECEIPT_JWS_PRIVATE_JWK` — no unsigned-dev-mode fallback; creation failure in the approve endpoint is non-blocking
- Do not claim Demo Login demonstrates real credential custody — it uses fake seeded credentials
- Do not claim Aegis blocks every possible sensitive action — Coverage Violation Blocking v1 applies only to observable in-Playwright events
- `jws_present` on receipt summaries reflects Supabase row metadata; in-memory mode always returns `false`
- New sensitive workflow features should target `aegis_playwright` first; Chrome extension support can follow as a companion surface
- Future website handshake features should consume `passport_jws` from the Delegation Passport

**Credential Provider Model invariants:**

- Domain remains the security primitive — `findCredentialProviderByDomain` is a display-only lookup; it does NOT authorize or validate injection on any domain
- Injection domain validation remains in the CDP fill endpoint (`new URL(injection.page_url).hostname` must match `injection.domain`) — do not bypass or weaken this check
- User-facing copy should prefer `"GitHub · username"` over raw domain when a provider is known; fall back to `"domain · username"` for unrecognized domains (`is_custom: true`)
- `getInjectionSafetyCopy` is the canonical approval copy generator for credential injection cards — use it; do not hardcode provider names in UI components
- Provider registry is intentionally small (13 providers) — do not add entries without clear product need
- Registry is duplicated in `apps/api/src/lib/credentialProviders.ts` and `apps/web/src/lib/credentialProviders.ts` with a TODO to move to a shared package — do not create a dependency from api to web or vice versa for this module
- Aegis only injects credentials on the current `injection_domain` (which must match `pass.domain`) — `requesting_site` never becomes the injection target even if it matches a provider's display name
- Three-domain model (requesting_site / credential_provider_domain / injection_domain) is documented in `docs/CREDENTIAL_PROVIDER_MODEL.md` — do not collapse this model
- Do not rebuild: Credential Provider Model v1

**Workspace invariants:**

- Workspaces are the shared, permissioned coordination layer for collar-bearing delegations — coordinate via manifests, tasks, artifacts, and audit events. Not a chat system.
- Effective permission = intersection of workspace collar and delegation collar; stricter wins. Absent from both = hard block. `approval_required` from either → 403 `WORKSPACE_PERMISSION_REQUIRES_APPROVAL` (no approval inbox in v1).
- Task claiming is coordination-level, not user approval — claims are automatic if the agent is eligible and task is ready. Sensitive actions inside a task are governed separately by collars/approvals.
- Eligibility: `open` (any participant), `delegation` (specific), `collar` (specific `required_collar_id`). Readiness depends on status, dependency tasks, and required artifact names.
- Blocked tasks return `409 TASK_NOT_READY` with `blocker_reasons`; already claimed tasks return `409 TASK_ALREADY_CLAIMED`. Both include `error.recovery_hint: "refresh_manifest"`.
- Manifest is the agent orientation surface — `recommended_work_queue` (sorted: in_progress_mine → ready → blocked → not_eligible), `operations` with `body_schema`, `workflow_rules`, `effective_permissions`, `task_summary`. POST /artifacts `body_schema` requires `{ name, kind, content, task_id? }` — use `kind` not `content_type`; valid kind values: `text`, `json`, `csv`, `markdown`. Artifact content is never returned in create/list; use GET /artifacts/:id to read.
- `in_progress_other` entries in `recommended_work_queue` show `recommended_action: "wait"`, `reason: "This task is in progress by another agent."`, `blocker_reasons.claimed_by_other: true`.
- Agent A / Agent B are demo labels only — the real model is collar-specific delegations, open tasks, and artifact handoff.
- Do not rebuild workspace endpoints, manifest, eligibility, readiness queue, collar-routing seed, or runbook trials. See `docs/WORKSPACE_TRIAL_RUNBOOK.md` for runbook and trial results.

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
- Expose `AEGIS_RECEIPT_JWS_PRIVATE_JWK` in any API response, log line, or front-end import — it must remain in `apps/api` env only
- Include plaintext passwords, credential values, or secrets in `receipt_jws` payload — the JWS covers only metadata

**Security Challenge Expiry / Stale Approval Cleanup invariants:**

- Security challenge approvals are live tasks, not permanent records — expired, cancelled, injected, and completed challenges must not remain actionable in the UI
- `GET /api/internal/security-challenges` performs lazy expiry (marks `pending_user`/`code_submitted` challenges `expired` when `now > expires_at`) and filters terminal statuses by default; `?include_terminal=true` is for debugging only
- `GET /api/internal/challenge-email-resolutions` performs lazy expiry for non-terminal resolutions when the linked challenge has expired; `challengeCodes` Map entries are deleted during lazy expiry
- `TERMINAL_STATUSES` is defined at module scope in `security-challenges.ts` — do not redefine per-request
- Auto-refresh on the approvals page polls `listSecurityChallenges()` every 8 seconds while challenges exist; Gmail resolution is user-initiated — button copy reads "Aegis only searches for this live verification request after you approve"
- Do not rebuild: Security Challenge Expiry / Stale Approval Cleanup v1

**Sensitive Requirement Assessment invariants:**

- `assess_sensitive_requirements` returns an intervention assessment, not a step-by-step workflow plan — Aegis does not replace the agent planner
- Agent owns: navigation, clicking, reading, summarization, form submission, login method selection, and deciding when the task is complete
- Aegis owns: credential field values (CDP injection), user approval gates, challenge relay, browser session lifecycle (ephemeral profile), and signed sensitive action receipts
- `recommended_mode` values: `agent_owned_task_with_aegis_interventions` (login/browsing), `requires_aegis_sensitive_workflow` (payment/purchase/financial — must use a verified Rail), `requires_explicit_approval` (signup/account creation — stop and confirm), `requires_user_presence` (identity/biometrics/KYC — cannot delegate)
- Payment/purchase/financial tasks returning `requires_aegis_sensitive_workflow` are a hard block — the agent must not attempt these without a verified Aegis Rail
- `requires_user_presence` tasks cannot be delegated — Aegis does not handle government IDs, biometrics, or KYC flows
- OAuth credential injection boundary: injection is permitted only on the actual provider-owned login domain, not the OAuth-initiating site
- `must_not_do` fields in assessment responses are hard constraints the agent must comply with
- `assess_sensitive_requirements` never calls POST endpoints, never creates resources, and never returns passwords, `secret_ref` values, or KMS material
- Do not rebuild: Sensitive Requirement Assessment v1

## Core Lines

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Browse freely. Commit safely.
- Platform IDs prove origin. AegisID proves trust.
- Aegis reputation is a history of how safely your agents act under verified delegation.
