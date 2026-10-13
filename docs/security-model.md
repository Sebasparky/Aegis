# Security model: what is enforced, where, and what is not

This page describes the security boundaries that exist in the code today. It is deliberately narrower than the product vision in `SECURITY_MODEL.md`. Every claim here points at the file that enforces it.

## 1. The trust boundary is the loopback interface

Aegis is a local research prototype. Its internal routes (`/api/*`, `/api/internal/*`, `/api/dev/*`) and its web UI have **no network authentication**; every request acts as one mock user. The only thing that keeps those routes private is that the API listens on a loopback address.

That assumption is enforced in code, not left as advice:

- The API binds `127.0.0.1:4000` by default (`apps/api/src/lib/apiBindHost.ts`, used by `apps/api/src/index.ts`).
- `AEGIS_API_BIND_HOST` may select `::1` (IPv6 loopback) or `localhost`. Fastify 4 binds `localhost` on both loopback families when the OS provides both. The startup banner prints the addresses actually bound.
- Any other value (`0.0.0.0`, `::`, a LAN address, a hostname) makes the API refuse to start with `UNSAFE_API_BIND_HOST`. There is no override flag and no authenticated exposure mode; adding one would require real user authentication first.
- The web dev server and the mock store are pinned to `127.0.0.1` in their `dev` scripts.
- The agent-side CDP browser uses Chrome's default remote-debugging address, which is loopback. Agent-supplied `external_cdp_url` values are restricted to loopback hosts and ports 1024 to 65535 (`apps/api/src/routes/agent-api.ts`).
- The only server-side fetch of a caller-influenced URL is the `.well-known` policy lookup, hard-gated to localhost (`apps/api/src/routes/website-aegis-policy.ts`).

IPv4 versus IPv6: binding `127.0.0.1` does not answer `http://[::1]:4000`. Browsers and Node 20 clients try both families when connecting to `localhost`, so the default works for the UI and the example scripts. Use `AEGIS_API_BIND_HOST=localhost` if a local client can only reach IPv6 loopback.

If you need to reach the API from another machine, put it behind a reverse proxy or VPN that authenticates callers, and keep the bind on loopback. Do not change the policy module.

## 2. External agents authenticate with a bearer pass

The public contract is `/api/agent/v1`. Every request carries `Authorization: Bearer <pass token>`. The server resolves the pass by token, then the delegation by the pass ID, and never trusts identity from the request body (`requireAgentToken` in `apps/api/src/routes/agent-api.ts`). Revoked and expired passes are refused.

The seeded demo tokens (`pass_demo_001`, `pass_demo_002`) are public knowledge. That is acceptable only because the API is loopback-bound.

The token is never written to any log. The MCP tool server and the browser adapter print that authentication is configured and which delegation it resolved to, never the token or any prefix, hash, or encoding of it. Tests spawn both processes with a canary token and assert it appears nowhere on stdout, stderr, or in JSON-RPC error text (`examples/antigen-browser-adapter.test.mjs`, `examples/aegis-tool-server.test.mjs`).

## 3. Scoped authority

A collar is a revocable policy object (it is not cryptographically signed) attached to a delegation. Policy evaluation runs in a fixed order: collar status, session state, spending limits, counterparty rules, block list, counterparty step-up, approval list (`apps/api/src/policies/evaluate.ts`). When a workspace is involved, the effective permission is the intersection of the workspace collar and the agent's collar; the stricter side wins, and an action absent from either is blocked (`apps/api/src/lib/workspaceDomain.ts`).

## 4. Approval gates and where they fail closed

Sensitive actions pause into an approval inbox. Whether release requires a signed record depends on the path:

| Approval endpoint | Signed record created | Fails closed if signing fails |
|---|---|---|
| `POST /api/approvals/:id/approve` (guard loop, `/demo`) | User-approval receipt | Yes (`routes/approvals.ts`) |
| `POST /api/route-runs/:id/approve` | Action authorization (hashed, JWS-signed) | Yes (`routes/route-runs.ts`) |
| `POST /api/internal/credential-authorizations/:id/approve` (primary login path) | User-approval receipt | Yes (`routes/secret-field-injections.ts`) |
| `POST /api/internal/payment-card-fill-authorizations/:id/approve` | User-approval receipt | Yes (`routes/payment-card-fills.ts`) |
| `POST /api/internal/purchase-confirmation-authorizations/:id/approve` | User-approval receipt | Yes (`routes/purchase-confirmations.ts`) |
| `POST /api/internal/security-challenges/:id/submit-code` | User-approval receipt, created asynchronously | No: the code is accepted first; a signing failure only skips the grant |
| `POST /api/internal/injections/:id/approve` (standalone injection, no authorization) | None | No |
| `POST /api/authenticated-sessions/:id/approve` (experimental) | None | No |
| `POST /api/credential-sessions/:id/approve` (extension path) | None | No |
| `POST /api/internal/account-creation-requests/:id/approve` | None (`TODO(v2)`) | No |
| `POST /api/internal/challenge-email-resolutions/:id/approve` | None | No |

On the fail-closed paths, a signing failure returns `APPROVAL_RECEIPT_SIGNING_FAILED` and nothing proceeds. The unsigned development flag does not bypass this. Every path, signed or not, still requires a user action in the Aegis UI.

External agents cannot approve anything through `/api/agent/v1`; approval happens only in the Aegis UI.

## 5. Credential handling: protocol-level secrecy, not process isolation

This is the boundary most likely to be overstated, so here is exactly what holds.

What is enforced:

- Passwords are AES-256-GCM encrypted at rest behind a KMS abstraction (`apps/api/src/lib/kms.ts`). The cloud provider is a stub that always throws; the local provider is development-grade.
- On user approval, Aegis decrypts server-side and injects the value into the agent's browser over the Chrome DevTools Protocol using `Input.insertText`, or per-key CDP input events for some field kinds (`apps/api/src/runtime/secretInjection.ts`). The injection endpoint returns status metadata only.
- No Aegis API response, Aegis MCP tool result, receipt, Antigen snapshot, or trace carries the plaintext. Tools the adapter forwards to `@playwright/mcp` (`browser_snapshot`, `browser_evaluate`, `browser_run_code_unsafe`) read the live page and are not covered by this guarantee. The agent-facing types mark `raw_value_revealed_to_agent: false` as a literal type (`packages/types/src/index.ts`).
- Generic form-fill refuses credential, identity, and payment fields with `SENSITIVE_FIELD_REQUIRES_INJECTION`; only the approval-gated injection path can write them.
- One approval covers one login attempt: username once, password once, then the authorization is fulfilled and cannot be reused.
- Snapshot values for sensitive fields are redacted at three layers (page script, server sanitizer, external view).

What is not enforced, and must not be claimed:

- **Browser-process isolation.** The agent's own Playwright channel attaches to the same Chrome instance Aegis injects into. After an approved injection, the agent could read the resulting page or DOM state through its own tools. Aegis withholds plaintext from the tool protocol and gates release behind approval; it does not seal the browser from the agent.
- **Execution-time domain re-check.** Domain validation happens when the injection is requested. At execution time, target selection falls back to the first non-blank page if no tab matches the domain. This is a known gap and is listed as open work.

The accurate sentence is: Aegis injects credentials without returning plaintext through the agent tool protocol, and only after explicit user approval.

## 6. Human-verification walls stop the agent

CAPTCHA, press-and-hold, and cross-origin verification iframes are detected and returned as `409 HUMAN_VERIFICATION_REQUIRED`. When the wall is opaque to DOM probing, a Visual Gesture Capsule relays a real user gesture from the Aegis UI. Nothing in the codebase solves, automates, or bypasses a verification challenge, 2FA, or passkey prompt, and nothing will be added that does.

Email, SMS, and TOTP codes follow the same rule: the user enters the code in the Aegis UI, it is injected once, held only in memory, and never returned to the agent (`apps/api/src/runtime/challengeInjection.ts`).

## 7. Ephemeral agent browser

Each task launches Chrome with a fresh temporary profile. Password saving, autofill, card saving, and sync are disabled through the Preferences file and launch flags, and the profile is deleted on exit (`apps/api/src/runtime/taskBrowserSessions.ts`, `apps/api/scripts/start-aegis-debug-chrome.mjs`). After injection Aegis disconnects from CDP rather than closing the browser, so the agent's session survives.

## 8. Receipts

Receipts differ by type, and the guarantees should not be generalized:

- **User-approval receipts** are hashed and signed with EdDSA. Which approval paths create them, and which fail closed, is listed in section 4 (`apps/api/src/lib/userApprovalReceiptSigning.ts`, `apps/api/src/routes/approvals.ts`). They are not chained to earlier receipts.
- **Action authorizations** (route-run approvals) are hashed and signed with EdDSA (`apps/api/src/lib/actionAuthorizationSigning.ts`). They are not chained.
- **Route-run receipts** are hashed over the previous receipt for the same user and signed with EdDSA (`apps/api/src/lib/receiptHash.ts`, `apps/api/src/lib/receiptSigning.ts`, `apps/api/src/repositories/receiptRepository.ts`). In the default local mode, signing is best-effort, and the chain metadata is held in memory and lost on restart. Under the Supabase provider, the hash and signature are stored with the row.
- **The general session receipt** shown by the `/demo` guard loop is a plain record with no hash or signature. The signed artifact for that flow is the user-approval receipt.

 The signing key is read only inside the API process. Optional Postgres storage is append-only through a trigger that rejects updates and deletes (`docs/supabase/002_signed_immutable_receipts.sql`). Receipts carry pass IDs, never tokens, secrets, card data, cookies, or storage state.

## 9. Payment surface

Card-field fill and the final purchase click are real capabilities. They are gated by two separate user approvals and, in the mock demos, use a seeded test card. Aegis does not make payment impossible; it makes it impossible to pay without a human approving that specific step. No real payment has been submitted by this codebase.

## 10. Known limitations

- No user authentication; one mock user.
- KMS is a local development provider. Persistence is a local JSON file by default.
- Credential secrecy is protocol-level (see section 5).
- Domain is validated at injection request time, not re-validated at execution time.
- Human-verification detection has been validated against synthetic fixtures and one live press-and-hold wall; it is a stop condition, not a guarantee of detection.
- The system-Chrome launch path looks for Chrome at macOS paths; the bundled-Chromium path is portable.
- No continuous integration has run the test suite.
