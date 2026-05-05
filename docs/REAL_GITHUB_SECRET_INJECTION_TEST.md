# Real GitHub Secret Injection Test

## Date

2026-05-04

## Goal

Validate Agent-Browser Secret Injection v1 on a real GitHub login. Confirm that the agent can log in using its own Playwright browser for all navigation and form submission while Aegis injects only the protected credential fields via CDP — and that no raw credentials, cookies, or session material ever appear in any tool result.

## Product Boundary Tested

| Actor | Owns |
|---|---|
| Agent (Claude + Playwright MCP) | Navigation, clicking, choosing username/password path, form submission, reading pages |
| Aegis | KMS credential resolution, approval gate, CDP injection of username/password, audit |

Aegis did NOT navigate, did NOT click "Sign in", did NOT choose between GitHub OAuth and username/password, did NOT submit the form, and did NOT read or summarize the resulting page.

## Setup

- Aegis API running with `AEGIS_KMS_PROVIDER=local_dev` and `AEGIS_PLAYWRIGHT_CDP_URL=http://localhost:9222`
- Aegis Web app at `http://localhost:3000`
- Claude Code with Aegis MCP tool server connected via bearer delegation token
- Playwright MCP (`@playwright/mcp@latest`) started with `--cdp-port 9222`
- Chrome launched with remote debugging on port 9222 using `npm run chrome:agent` (ephemeral profile — session data is deleted on exit). For local dev only: `npm run chrome:agent:dev` uses `~/.aegis-chrome-debug-dev` (persistent, NOT for real credential injection). **Before testing ephemeral behavior**, close any existing persistent Chrome profile and verify no prior GitHub session is active.
- GitHub vault pass for `github.com` added to Aegis vault (`NordaTestUser` / encrypted password)

## Flow

1. Agent opened `https://github.com/login` in its Playwright browser using `browser_navigate`.
2. Agent called `request_secret_field_injection({ domain: "github.com", field_kind: "username", page_url: "https://github.com/login", reason: "Filling GitHub username to log in" })`.
3. Response: `{ status: "pending_approval", raw_value_revealed_to_agent: false, authorization_covers: "username and password for this login attempt — one approval, one use each, 5-minute TTL" }`.
4. User approved the request once at `/route-run-approvals` under "Login credential requests" — one approval covering both username and password.
5. Agent called `execute_secret_field_injection({ injection_request_id })`. Aegis resolved the username from vault metadata and injected it into `#login_field` via CDP.
6. Agent called `request_secret_field_injection({ domain: "github.com", field_kind: "password", page_url: "https://github.com/login", reason: "Filling GitHub password to log in" })`. The request auto-attached to the existing approved authorization — no second approval prompt.
7. Agent called `execute_secret_field_injection` for the password. Aegis decrypted the password via KMS and injected it into `input[type="password"]` via CDP.
8. Agent clicked "Sign in" itself using `browser_click`.
9. Agent read the resulting page (repository list, profile nav) using its own Playwright tools.

## Result

- Login succeeded as `NordaTestUser`.
- Visible repository: `NordaTestUser/Test-Repo`
- Visibility: Private
- Description: A private repo created for testing purposes
- Agent was able to read private repo metadata directly in its own browser after login.

## Security Properties Confirmed

| Property | Result |
|---|---|
| `raw_value_revealed_to_agent` on username injection response | `false` |
| `raw_value_revealed_to_agent` on password injection response | `false` |
| `raw_values_revealed_to_agent` on credential-use authorization | `false` |
| Cookies returned to agent | None |
| storageState returned to agent | None |
| localStorage / sessionStorage returned | None |
| Auth tokens returned to agent | None |
| KMS material, secret_ref, ciphertext, private keys in any response | None |
| Authorization status after both fills | `fulfilled` |
| Third injection attempt (password replay) | Blocked — `AUTHORIZATION_FULFILLED` |
| `pass_id` in any agent-facing response | Never included |
| KMS audit event recorded | Yes, `raw_secret_exposed: false` |

## Lessons Learned

1. **Authenticated Session Boundary was the wrong default product boundary.** It made Aegis responsible for the full login workflow — choosing the login path, clicking "Next", submitting the form, verifying login success. That model is fragile, site-specific, and violates agent autonomy.

2. **Agent-Browser Secret Injection is the correct primary login path.** The agent owns navigation and form submission (which it already knows how to do). Aegis only fills the two fields that require protected values. The boundary is clean, composable, and works on any site with a standard username/password form.

3. **Agents should only call Aegis when they need protected values.** A login form is two protected fields. Everything else (page navigation, clicking, reading) is standard agent capability and should stay with the agent.

4. **One approval per login attempt is the right UX.** The user approves "Use GitHub login" once. Both fields fill without further interruption. After both are filled, the authorization is closed (fulfilled) and cannot be replayed.

## Regression Checklist

Run after any change to secret injection or credential-use authorization:

- [ ] `request_secret_field_injection` for username returns `status: "pending_approval"` or `"approved"` (never raw credential)
- [ ] `execute_secret_field_injection` fills field and returns `raw_value_revealed_to_agent: false` (never raw credential)
- [ ] `request_secret_field_injection` for password on same login attempt: auto-attaches to existing auth (no second approval if already approved)
- [ ] After both username and password filled: authorization `status` becomes `"fulfilled"`
- [ ] Third injection attempt on same authorization: rejected with `AUTHORIZATION_FULFILLED`
- [ ] Expired authorization (after 5 min or API restart): new injection request creates fresh authorization, new approval required
- [ ] Safety grep: `grep -n "resolvedValue" apps/api/src/routes/agent-api.ts` — must NOT appear in any `reply.send()` call
- [ ] `raw_value_revealed_to_agent: false` and `raw_values_revealed_to_agent: false` are literal `false` in types, not boolean
