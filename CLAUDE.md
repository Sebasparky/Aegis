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

### 2. Delegation and Permissions (Collars)

Users explicitly grant agents scoped authority through **Collars** — customizable, signed, revocable policy objects that define what the agent can do, on which sites, for how long, with what spending limits, what requires approval, and what is forbidden.

Use "collar" in code. Use "scoped permissions" or "delegation" in product copy.

### 3. Verified Workflow Routes — Aegis Rails

Agents should not improvise inside sensitive workflows when a verified route exists. A route is not a markdown file — it is a structured, inspectable, permission-scoped, versioned, reviewed, and enforceable execution path. Routes are taught once by a human, compiled from semantic telemetry, verified, and published to the route registry.

See `docs/AEGIS_RAILS.md` for the full technical spec.

### 4. Runtime Guardrails — Aegis Guard

Aegis Guard is the runtime monitoring and enforcement layer:
- `SensitiveActionDetector` — rule-based classification of browser actions
- `PolicyService` — collar + route enforcement against detected actions
- Approval inbox — human-in-the-loop gates
- Session pause, block, and revocation

Sensitive actions Aegis Guard must catch: transfer money / payment / purchase, submit order, accept terms, grant OAuth permissions, delete data, send external messages, change account settings, add payment method, connect external account, identity disclosure.

### 5. Accountability and Audit Trail

Aegis records what authority was granted, what route was followed, what actions were taken, what approvals happened, and what was blocked. **Receipts** capture trust-relevant events, not everything.

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
- **Prefer real-world testing with guardrails over localhost-only demo safety.** Authenticated sessions, observation dry runs, and trust profiles should be validated against real sites where practical.

## Current Implementation State

See `docs/NEXT_SESSION_PROMPT.md` for full implementation history and current working state.

Key surfaces: Core guard loop (`/demo`), Aegis Rails (`/rails`), Playwright runtime (`aegis_playwright` is primary), External Agent API (`/api/agent/v1`), MCP Tool Server (`examples/aegis-tool-server.mjs`). Seed with `npm run seed:demo`.

`aegis_playwright` is the primary controlled execution surface for autonomous agents. Chrome extension is retained as an optional local/debug/recording companion.

## Candidate Next Milestones

1. **Real-Web Authenticated Session Testing** — validate against GitHub test accounts; challenge detection already implemented
2. **Website Policy Risk Scanner v1** — crawl-lite that detects sensitive form fields and buttons on declared path prefixes
3. **Agent-safe screenshot redaction v1** — redacted screenshots with sensitive regions blurred/masked
4. **Production KMS Provider v1** — swap `LocalDevKmsProvider` for a real cloud KMS (AWS KMS, GCP KMS, or HashiCorp Vault)
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

## Login and Secret Injection Rules

- **Agent-Browser Secret Injection v1 is the primary path** for normal username/password login in agent-controlled browsers (e.g. Claude Code with `@playwright/mcp`).
- Agent owns: navigation, clicking "Next"/"Sign In"/"Submit", form submission, login method selection (GitHub username/password, not OAuth), and reading page content.
- Aegis owns: protected value custody, approval gates, CDP injection, KMS resolution, and audit.
- Aegis does NOT choose OAuth vs username/password, does NOT click submit, does NOT read or summarize pages for the agent.
- One credential-use approval covers one login attempt only — username once, password once.
- Credential-use authorizations are same-domain, same-pass, same-delegation, short-lived (5 min), and one-use-per-field. After both allowed fields are filled, authorization becomes `fulfilled` and cannot be reused.
- Default max use counts: `{ username: 1, password: 1 }`. Replay is blocked with `AUTHORIZATION_FULFILLED`.
- `request_authenticated_session_login` is secondary/experimental — use only when the agent has no browser or explicitly requests an isolated Aegis-controlled browser.
- `start_credential_session` / `fill_credential_field` are extension/user-tab targeted and must not be used with Claude/Playwright agent browser flows.
- Routes/skills are for high-risk workflows where the exact action sequence matters: payments, banking, stock trades, account deletion, irreversible submissions.
- After `request_secret_field_injection` returns `pending_approval`, agents must call `wait_for_credential_authorization` with the returned `authorization_id` — do NOT ask the user to type "done" or "approved". The user acts in the Aegis UI; the agent waits via tool polling.
- `wait_for_credential_authorization` polls `GET /api/agent/v1/credential-authorizations/:id` and returns when status is terminal (`approved`, `denied`, `expired`, `fulfilled`, `revoked`) or timeout.
- Agent-facing credential authorization status endpoint (`GET /api/agent/v1/credential-authorizations/:id`) returns safe metadata only — no `pass_id`, no raw values, no KMS material, no cookies, no storage.
- Do not rebuild Approval Wakeup/Polling v1 unless explicitly requested.


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
- `AEGIS_RECEIPT_JWS_PRIVATE_JWK` must remain in `apps/api` env only — never in any API response, log line, or front-end import
- `receipt_jws` payload covers only metadata (receipt_id, receipt_hash, previous_receipt_hash, issuer, issued_at) — no secrets
- `GET /api/internal/sensitive-receipts/recent` is the Sensitive Action Receipt Timeline endpoint — read-only aggregate derived at query time from existing Maps. Supports `since` ("24h" default, "today", "7d", "all") and `event_group` ("all", "browser", "credential", "challenge", "email") filters applied after derivation. Never include `pass_id`, `secret_ref`, `authorization_hash`, `authorization_jws`, `user_data_dir`, `cdp_url`, raw codes, email body/subject, cookies, or storage in the response. `pass_label` is display metadata only. Agent-provided free-text (e.g. `reason` on SecretFieldInjection) must be sanitized via `sanitizeReceiptText` before inclusion — never include unsanitized agent strings.

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
- Do not activate `protected_observation` globally — triggered only by route permissions, URL patterns, or DOM patterns
- `AgentSafeObservationSnapshot` must never contain raw field values — `filled` is a boolean only (`.value.length > 0`); sensitive fields always have `value_redacted: true`
- `page.evaluate()` callbacks in `playwrightRuntime.ts` must use raw JS string IIFEs (not TypeScript arrow functions) — the Node.js tsconfig does not include DOM lib
- Observation mode does not weaken Capability Release Gate — it controls what agents SEE; capability releases control what sensitive actions can PROCEED
- Sensitive fields and buttons have `allowed_actions: ["read", "request_fill"]` or `["read", "request_click"]` — must go through Aegis route steps
- Do not use observation dry run output as a substitute for a proper Aegis-verified route

**Authenticated session boundary invariants:**

- Authenticated session boundary supports real-web login for test accounts — attempted after user approval using generic selectors + challenge detection. Experimental for real sites; stop on 2FA, CAPTCHA, passkey, device verification, bot detection, or any security check — no bypass, no retry
- External agents cannot self-approve authenticated session requests — approval is always user-controlled via `/route-run-approvals`
- Authenticated session handles must never expose cookies, localStorage, sessionStorage, request headers, Set-Cookie values, auth tokens, Playwright storageState, passwords, `secret_ref` values, pass_id in raw form, KMS envelopes, or ciphertext — only the safe handle and safe observation snapshots are returned
- All three `raw_cookies_revealed_to_agent`, `raw_storage_revealed_to_agent`, `raw_credentials_revealed_to_agent` are TypeScript literal `false` — never set to `true`
- Post-login navigation is same-domain `page.goto` only — no form submission, no POST actions, no destructive actions, no credential fill after login; `CROSS_DOMAIN_NAVIGATION_BLOCKED` on any cross-domain URL
- `resolveAuthSessionCredential` uses `local_dev` KMS provider and `purpose: "login_password"` — do not change the KMS context purpose field; KMS audit event uses `run_id: "authsession:<sessionId>"`
- `authenticatedSessionHandles` + `authenticatedSessionRecords` Maps are in-memory only — Playwright refs are not serializable; sessions are ephemeral
- The "Login session requests" section in `/route-run-approvals` must always display all 4 custody guarantees: Aegis uses the credential, agent does not see the password, agent does not receive cookies or storage, agent receives only an `authenticated_session_id` handle
- `executeLoginForAuthenticatedSession` must require positive authentication evidence before setting `status: "authenticated"` — never infer authenticated from form submit alone; form submit with no challenge is not sufficient
- `AuthenticatedSessionLoginDiagnostics` on `AuthenticatedSessionHandle.login_diagnostics` is metadata-only: booleans and URLs, never credential values, passwords, secret_ref, pass_id, KMS material, ciphertext, or cookies; `username_present`/`password_present` are booleans (non-empty check only, never the values); `failure_evidence` is safe UI text from alert/flash/banner elements — never from input values, hidden fields, or credential fields
- `verifyAuthenticatedSession` checks: login URL presence (immediate fail), failed-login DOM text (immediate fail), visible password field / login form (negative signal), "Sign in" in primary nav (negative signal), account menu / username visible (positive signals); for `github.com`: also checks `/settings/profile` redirect via `page.request.fetch` (shares browser cookies, no page navigation); any negative without positive → `manual_step_required`
- `observeAuthenticatedSession` allows both `authenticated` and `manual_step_required` status when a browser record exists; for other statuses (failed, expired, pending_approval, login_in_progress) it returns a minimal response rather than throwing; `manual_step_reason` is included in observe results when set — never contains passwords, credentials, or secrets
- `navigateAuthenticatedSession` remains restricted to `authenticated` status only — `manual_step_required` cannot navigate
- For login walls and credential-gated browsing in agent-controlled Playwright browsers, agents must use `request_secret_field_injection` — not `start_credential_session`, not `request_authenticated_session_login`. The agent navigates and submits; Aegis fills only the protected fields.
- `request_authenticated_session_login` is experimental and secondary — for isolated Aegis-controlled browser sessions where the agent cannot navigate the login itself. Do not use it as the default login path.
- `start_credential_session` / `fill_credential_field` are extension/user-tab targeted — they target the Aegis Chrome extension on the user's active tab, not an agent-controlled Playwright browser (e.g. Claude's own browser). Do not route agent login tasks to these tools
- Routes/skills are for complex or high-risk workflows where exact action sequence matters (payment, banking, stock trades, account deletion) — not for normal login

**Agent-Browser Secret Injection invariants:**

- `request_secret_field_injection` is the PRIMARY injection path for username/password fields in agent-controlled Playwright browsers (e.g. Claude Code with `@playwright/mcp`)
- Agent owns: navigation, clicking "Next"/"Sign In"/"Submit", form submission, choosing username/password vs. OAuth — Aegis does NOT do any of these
- Aegis owns (via CDP injection): only the protected field values — username from vault metadata, password from KMS-encrypted secret
- `SecretFieldInjection.raw_value_revealed_to_agent: false` is a TypeScript literal type — always write as the literal `false`, never through a variable
- CDP fill endpoint `POST /api/agent/v1/injections/:id/execute` never returns the resolved value — only status metadata
- Domain validation: `new URL(injection.page_url).hostname` must match `injection.domain` — no cross-domain injection; clear error: "Aegis will not inject github.com credentials into accounts.google.com."
- Status machine: `pending_approval → approved → executing → filled`; `denied` and `failed` are terminal; `expired` on API restart or after 5-minute TTL
- Injection expires after 5 minutes — browser context or field may have changed; agent must request a new injection
- `AEGIS_PLAYWRIGHT_CDP_URL` is required for CDP fill — missing it returns a clear `CDP_FILL_FAILED` error, not a silent fallback
- `executeSecretInjectionViaCDP` uses `(browser as any).disconnect()` — not `browser.close()`. `disconnect()` drops the WebSocket without issuing a `Browser.close` CDP command, preserving the agent's browser session and open tabs. `browser.close()` would terminate the agent's session and must never be used here.
- Password injection always requires approval in v1; username injection is approved by default only if the collar's `approval_required_actions` does not include `"login"`
- Never include `pass_id` in agent-facing injection responses — expose only `pass_label`, `injection_request_id`, and status metadata

**Challenge Relay invariants (Manual Challenge Code Injection v1 implemented):**

- Agents must not ask users to paste verification codes (email/SMS/TOTP) into chat — call `report_security_challenge`, then `wait_for_security_challenge`, then `inject_security_challenge_code`
- Agents may say: "A verification code was sent. Please enter it in the Aegis UI." — agents must NOT say "Please send me the code" or "Paste the code here"
- `raw_code_revealed_to_agent: false` is a TypeScript literal on `SecurityChallenge` and all agent-facing responses — never set through a variable
- Challenge codes are memory-only in `challengeCodes` Map (runtime/challengeInjection.ts) — never persisted, never logged, deleted after injection or expiry
- Status machine: `pending_user → code_submitted → code_injected`; `cancelled`, `expired`, `failed` are terminal
- Code validation: trim, 4–10 chars, alphanumeric only — enforced in `/api/internal/security-challenges/:id/submit-code`
- Domain validation: injection target must match `challenge.domain` — enforced in agent-api.ts at challenge creation
- CDP injection deletes the code from `challengeCodes` immediately before injecting — regardless of success or failure; no retry with the same code
- On API restart, `pending_user` and `code_submitted` challenges become `expired` in persistence.ts loadStore
- Challenge injection must use `challenge.browser_session_id` → `taskBrowserSessions.get(id).cdp_url` when a session ID is present. Static `AEGIS_PLAYWRIGHT_CDP_URL` is a legacy fallback for challenges with no session ID. Agents must always pass `browser_session_id` from `start_task_browser_session` when calling `report_security_challenge` — without it, injection targets the wrong port.
- Connected Email Challenge Resolver v1.1 is implemented — two-phase Gmail search (metadata scan + restricted body fetch fallback). Do not re-implement.
- Verification email body fetch is allowed only inside Connected Email Challenge Resolver after user approval for a live `SecurityChallenge`. Body text is function-local only — never logged, never persisted, never returned to the agent or any API response.
- Body fetch applies only to the best (most recent valid) candidate — at most 2 body fetches total (`MAX_BODY_FETCHES = 2`), body capped at 20,000 characters.
- `extraction_source` ("subject_snippet" | "body_text") is safe metadata only — it describes which phase found the code, not the code or email content.
- Domain check uses `isEmailChallengeSupported(domain)` from `VERIFICATION_EMAIL_POLICIES` registry in `emailChallengeResolver.ts` — not a hardcoded "github.com" string.
- Aegis never bypasses 2FA, CAPTCHA, passkeys, or any human-presence security check
- No full email body or inbox listing is ever returned to the agent
- Every relay produces a status change record; see `docs/CHALLENGE_RELAY.md` for full phase roadmap
- Do not rebuild: Manual Challenge Code Injection v1
- Do not rebuild: Connected Email Challenge Resolver v1.1

**Ephemeral Agent Browser Session invariants:**

- Agent browser sessions are ephemeral by default — `npm run chrome:agent` creates a fresh `/tmp/aegis-agent-browser-<timestamp>` profile and deletes it on exit
- `npm run chrome:agent:dev` uses `~/.aegis-chrome-debug-dev` for local development; prints a visible WARNING; must never be used for real credential injection testing (session persists across browser restarts)
- The Chrome Preferences file written at launch disables password saving, autofill, card saving, and sync — these are the mechanism for the no-save policy, not just a guideline
- Chrome flags for all agent sessions: `--disable-save-password-bubble --password-store=basic --disable-sync --no-first-run --disable-default-apps`
- `persistence_allowed: false`, `browser_storage_allowed: false`, `website_save_allowed: false` on `CredentialUseAuthorization` are TypeScript literal `false` types — always write as the literal `false`, never through a variable; these fields appear in every `CredentialUseAuthorization` object literal
- These three no-save fields are internal policy metadata — do NOT include them in agent-facing API responses (the agent response at `GET /api/agent/v1/credential-authorizations/:id` uses an explicit field list, not a spread)
- `save_credential`, `save_payment_method`, and `enable_persistence` are high-risk `ActionType` values — Aegis Guard must detect and block them
- Detection for "save password", "remember me", "keep me signed in", "trust this device", "don't ask again", "one-click checkout" → `save_credential` high risk
- Detection for "save card", "save this card", "remember this card", "save payment method", "set as default payment" → `save_payment_method` high risk
- v1 detection uses `targetText` only — `TODO(v2)` comments in `sensitiveDetector.ts` note that checkbox labels and nearby DOM text must be inspected in a future pass; do not remove these TODOs
- Port conflict check is part of `start-aegis-debug-chrome.mjs` — the script exits with a clear error if port 9222 is already in use, preventing silent connection to an old persistent session
- Temp profile cleanup on exit is best-effort (`try/catch` around `rmSync`) — do not crash if cleanup fails
- Approval copy on the credential use card reads "Default Aegis agent browsers disable password/card saving" — not "Browser password saving is disabled", because the policy is launcher-dependent; do not change this wording to imply enforcement when the user may be using a manually launched persistent Chrome
- Do not rebuild: Ephemeral Agent Browser Session + No-Save Policy v1

**Task Browser Lifecycle invariants:**

- Task Browser Lifecycle v1 is a local-dev lifecycle wrapper — it does not change secret injection semantics, does not make Aegis navigate or click, and does not introduce persistent sessions via the API
- Sessions are always ephemeral — `ephemeral: true` is a required literal on `TaskBrowserSession`; never use persistent paths (`~/.aegis-chrome-debug-dev`) via this API
- Port conflict handling is autonomous — `createTaskBrowserSession` resolves conflicts without user intervention:
  - Case A (tracked ready session on 9222, CDP alive): return existing session; `reused_existing: true`; do NOT spawn Chrome
  - Case B (tracked stale session — expired/failed): SIGTERM + 700ms wait; re-launch on 9222 if free, else try 9223–9230
  - Case C (unknown process on 9222): log "Port 9222 occupied by unknown process" to server console only; launch on 9223–9230; `port_auto_selected: true`, `requires_browser_reconnect: true`
  - Case D (no ports 9222–9230 available): throw `NO_PORTS_AVAILABLE`, HTTP 503
- `PORT_IN_USE` (409) is no longer thrown — do not re-introduce it
- Do NOT inject secrets into untracked / unknown-process browsers — Case C always launches a fresh Aegis-owned session
- `reused_existing`, `port_auto_selected`, `requires_browser_reconnect`, `user_message` are route/MCP-layer response metadata — NOT fields on `TaskBrowserSession` type; never add them to the type
- When `port_auto_selected: true`, `cdp_url` reflects the actual alternate port; MCP `next_action` instructs using the returned `cdp_url` with the browser adapter — no port numbers, `lsof`, or shell commands in user-facing messages
- `NO_PORTS_AVAILABLE` message is agent-safe: "Aegis could not start a secure browser session. Please try again." — technical port details go to `console.error` only
- Aegis must not tell normal users to manage CDP ports, kill Chrome, or run `lsof` — these must never appear in agent-facing `next_action` or `user_message` fields
- Production browser adapters should use dynamic session handles (returned `cdp_url`), not static localhost ports
- `user_data_dir` is always under `/tmp/aegis-agent-browser-<id>` — internal API may return it for local dev; MCP/agent-facing responses omit it (return only `cdp_url`, `ephemeral`, `expires_at`, `cleanup_complete`)
- `taskBrowserProcesses` Map is private — never expose PIDs, child process handles, or process state to agents or API callers
- Agent still uses Playwright MCP for all navigation and clicking; Aegis uses CDP only for secret injection (`request_secret_field_injection`)
- Do not close the session immediately after login — the agent needs the browser to continue the task; close only after full task completion
- After `close_task_browser_session`: `status = "closed"`, `cleanup_complete = true`, Chrome killed, profile dir deleted — do not reuse session IDs
- `closeTaskBrowserSession` cleanup is best-effort (`try/catch` around `rmSync`); set `cleanup_complete: true` even if dir was already gone
- The Chrome `exit` event handler marks orphaned sessions `"failed"` and attempts cleanup — prevents stale `"ready"` entries after unexpected Chrome crash
- `expireInactiveTaskBrowserSessions()` is called at API startup to clean up any sessions that expired while the server was down
- Do not add persistent-dev Chrome mode to this API — that mode is only available via `npm run chrome:agent:dev` directly
- `raw_cookies_revealed_to_agent: false` and `raw_storage_revealed_to_agent: false` must appear in all MCP tool responses that reference a task browser session
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
- Three-domain model (requesting_site / credential_provider_domain / current_injection_domain) is documented in `docs/CREDENTIAL_PROVIDER_MODEL.md` — do not remove or collapse this model
- Do not rebuild: Credential Provider Model v1

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
- `GET /api/internal/security-challenges` performs lazy expiry (marks `pending_user`/`code_submitted` challenges `expired` when `now > expires_at`) and filters terminal statuses by default (`expired`, `cancelled`, `code_injected`, `user_completed`, `failed`); `?include_terminal=true` is for debugging only
- `GET /api/internal/challenge-email-resolutions` performs lazy expiry for non-terminal resolutions (`pending_approval`, `searching`, `code_found`) when the linked security challenge has expired
- Challenge codes (`challengeCodes` Map) are deleted during lazy expiry in the list endpoint — same as on inject and restart
- `TERMINAL_STATUSES` set is defined at module scope in `security-challenges.ts` — do not redefine per-request
- `PendingChallengeCard` detects client-side expiry via `setTimeout` keyed to `challenge.expires_at`; shows a compact disabled "Expired" card with the message "This verification request expired. Start the login again to request a new code."
- The expired card early return in `PendingChallengeCard` runs before `renderEmailResolverSection` is called — expired challenges never show actionable email resolver buttons
- Auto-refresh on the approvals page polls `listSecurityChallenges()` every 8 seconds while `challenges.length > 0` — removes cards that have been injected, completed, or expired server-side on the next cycle
- `isEmailTypeChallenge` checks only `challenge.challenge_type === "email_device_verification"` — no hardcoded provider domain in the frontend; backend enforces domain support via `isEmailChallengeSupported`
- Gmail resolution remains user-initiated: "Find code in connected Gmail" button click = approval; Aegis does not search automatically; button copy reads "Aegis only searches for this live verification request after you approve"
- Do not rebuild: Security Challenge Expiry / Stale Approval Cleanup v1

**Sensitive Requirement Assessment invariants:**

- `assess_sensitive_requirements` returns an intervention assessment, not a step-by-step workflow plan — Aegis does not replace the agent planner
- Agent owns: navigation, clicking, reading, summarization, form submission, login method selection, and deciding when the task is complete
- Aegis owns: credential field values (CDP injection), user approval gates, challenge relay, browser session lifecycle (ephemeral profile), and signed sensitive action receipts
- `recommended_mode` values: `agent_owned_task_with_aegis_interventions` (login, browsing), `requires_aegis_sensitive_workflow` (payment/purchase/financial — must use a verified Aegis Rail), `requires_explicit_approval` (signup/account creation — stop and confirm), `requires_user_presence` (identity verification, biometrics, KYC — cannot delegate)
- `available_aegis_routes` is always advisory — presence indicates a matching installed skill was found; whether to use it is the agent's decision; it never overrides agent autonomy
- Payment/purchase/financial tasks returning `requires_aegis_sensitive_workflow` are a hard block, not a suggestion — the agent must not attempt these without a verified Aegis Rail
- `requires_explicit_approval` means stop and obtain explicit user confirmation before taking any action
- `requires_user_presence` tasks cannot be delegated — Aegis does not handle government IDs, biometrics, or KYC flows
- OAuth credential injection boundary: Aegis should not inject credentials into a requesting site simply because it initiated an OAuth flow — injection is permitted only on the actual provider-owned login domain; the injection domain must match the provider's domain, not the originating site
- Challenge relay has two paths: Connected Email Challenge Resolver (automatic, supported domains) and Manual Challenge Relay (fallback); `report_security_challenge` is the entry point for both paths
- `must_not_do` fields in assessment responses are hard constraints the agent must comply with
- When login appears unexpectedly mid-task, re-call `assess_sensitive_requirements` with the specific sub-task to get the correct intervention list
- `assess_sensitive_requirements` never calls any POST endpoint, never creates or modifies resources, and never returns raw passwords, `secret_ref` values, or KMS material
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
