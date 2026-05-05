# Challenge Relay

## Thesis

Aegis does not bypass security challenges. It coordinates approved handoff and temporary secret injection.

When a website requires email verification, SMS codes, TOTP, device verification, or similar security checks, Aegis pauses the agent, surfaces the challenge to the user in the Aegis UI, and — once approved — injects the code into the browser via CDP. The agent never sees the raw code.

---

## Product Boundary

| Actor | Owns |
|---|---|
| **Agent** | Navigation, clicking, form submission, reading page content, deciding what to do next, detecting that a challenge appeared |
| **Aegis** | Challenge detection/reporting, user approval gate, temporary secret custody, code injection via CDP, audit receipt, expiry/revocation |
| **User** | Approving the challenge relay, entering the code into Aegis UI (Phase 2), connecting email providers (Phase 3), completing challenges that require human presence (passkey, CAPTCHA) |

Aegis does NOT: navigate to challenge pages, click "Send code" buttons, choose which verification method to use, or read any page on behalf of the agent.

---

## Challenge Types

```ts
type ChallengeType =
  | "email_device_verification"   // GitHub, Google — code sent to email
  | "sms_code"                    // code sent to phone
  | "totp"                        // authenticator app (TOTP)
  | "passkey"                     // requires human presence — not relayable
  | "captcha"                     // requires human presence — not relayable
  | "device_verification"         // device trust prompt
  | "unknown";                    // unclassified; treat as requires human presence
```

Passkey, CAPTCHA, and `unknown` challenges cannot be relayed — they require direct user action in the browser.

---

## Phased Roadmap

### Phase 1 — Manual Challenge Handoff

The simplest form. No Aegis code custody.

1. Agent encounters a challenge page.
2. Agent calls `report_security_challenge` with `challenge_type`, `domain`, `session_id`.
3. Aegis creates a `SecurityChallenge` record with `status: "pending_user"`.
4. Agent calls `wait_for_security_challenge` and polls until terminal status.
5. Aegis UI notifies the user: "GitHub requires device verification. Please complete it in the browser."
6. User completes the challenge directly in the browser.
7. User marks challenge complete in Aegis UI.
8. Aegis sets status → `"user_completed"` and issues a handoff receipt.
9. Agent resumes.

No code is entered into Aegis. No injection occurs. Aegis records that the user took over.

---

### Phase 2 — Manual Challenge Code Injection ← **immediate implementation target**

User enters the code into Aegis. Aegis injects it via CDP. Agent never sees it.

1. Agent encounters a challenge page (e.g., "Enter the 6-digit code sent to your email").
2. Agent calls `report_security_challenge`.
3. Aegis creates a `SecurityChallenge` and shows an approval card in the Aegis UI.
4. User sees the card (see UI Language below) and enters the code into Aegis.
5. Aegis validates: code is non-empty, TTL not expired, domain matches injection target.
6. Aegis creates a `TemporaryChallengeSecret` — single-use, 5-minute TTL, domain-bound.
7. Aegis injects the code via CDP into the active browser field.
8. `raw_code_revealed_to_agent: false` — this is a TypeScript literal, not a variable.
9. Aegis sets challenge status → `"code_injected"` and issues an audit receipt.
10. Agent calls `wait_for_security_challenge`; receives terminal status and resumes.

The agent never sees the code. It only learns that the challenge was resolved.

---

### Phase 3 — Connected Email Challenge Resolver ← **local-dev Gmail resolver v1 — current implementation target**

User connects Gmail via env token. Aegis searches only recent GitHub verification emails for a live challenge, extracts the code, and injects it — all without exposing email body, subject, or raw code to the agent.

**v1 scope constraints:**
- Gmail only. GitHub device verification only (`github.com` domain, `email_device_verification` challenge type).
- Auth path: `GOOGLE_REFRESH_TOKEN` env var (manual token, local dev only). Full OAuth web redirect is a separate future milestone.
- Gmail API calls use `format=METADATA` + snippet only. Full body is never fetched in v1.
- Subject and snippet used internally for code extraction only — never returned to agent, never logged.
- `GOOGLE_REFRESH_TOKEN` read from `process.env` only — never stored in Maps, persistence, or API responses.
- `raw_code_revealed_to_agent: false` and `email_body_revealed_to_agent: false` are TypeScript literals on all agent-facing types and responses.
- Sender allowlist: `noreply@github.com`, `github-noreply@github.com`. Sender domain re-validated per-result.
- Search window: only emails received after `challenge.created_at`.
- Code memory-only in `resolutionCodes` Map — not in `store/index.ts`, not in persistence, never logged.
- Inject once. Code deleted immediately after injection attempt (success or failure).
- If code not found in subject/snippet across 5 results: return `not_found`, fall back to Manual Challenge Code Injection.

**This is local-dev Gmail resolver v1.** Production use requires a proper OAuth flow, encrypted refresh-token storage, revocation, user consent screens, and audit trail — deferred to a separate milestone.

**MCP tool flow:**
1. `report_security_challenge` — agent reports the challenge
2. `request_challenge_email_resolution` — agent requests Gmail resolution (creates resolution, status: `pending_approval`)
3. `wait_for_challenge_email_resolution` — agent polls; user approves in Aegis UI → sync Gmail search runs
4. `inject_challenge_email_code` — agent triggers injection once status is `code_found`
5. Agent clicks Verify/Continue in browser — Aegis does not submit forms

Pre-conditions and constraints are listed in the **Gmail/Email Connector Constraints** section below.

---

### Phase 4 — Policy Memory *(future)*

User can allow specific domain/account combinations for automatic challenge relay on future attempts, without re-approval each time. Scoped per domain + challenge type + account.

---

## Security Invariants

These are enforcement rules, not guidelines.

- Aegis never bypasses 2FA, CAPTCHA, passkeys, or any human-presence security check.
- The agent never receives the raw verification code — `raw_code_revealed_to_agent: false` is a TypeScript literal on every `SecurityChallenge`, `TemporaryChallengeSecret`, and `ChallengeRelayAuthorization` object literal.
- Challenge codes are temporary secrets:
  - Single-use (consumed on first successful injection)
  - Short TTL (≤5 minutes from creation)
  - Domain-bound (injection target domain must match challenge domain)
  - Browser-session-bound (tied to the `session_id` of the originating task browser session)
  - Challenge-bound (one code per challenge record)
- No email body, subject, sender name, or inbox listing is ever returned to the agent.
- No broad inbox access — email resolver searches only in a narrow time window after `challenge.created_at`, from an allowlisted sender domain, matching the challenge domain.
- No code is stored after successful injection unless explicitly encrypted and scoped (not in v1).
- Every relay — whether handoff or injection — produces an audit receipt.
- Passkey and CAPTCHA challenges are surfaced to the user as requiring human presence; Aegis does not attempt injection or resolution.

---

## Agent Communication Rule

**Agents may say:**
> "A verification code was sent. Please complete it in Aegis."

**Agents must NOT say:**
> "Please send me the code."
> "Paste the code here."
> "What is the verification code?"

Asking users to relay codes into chat exposes secrets unnecessarily and is the exact anti-pattern Challenge Relay exists to prevent. Agents that cannot use Challenge Relay should surface a clear, specific error: "I encountered a security challenge (email_device_verification) on github.com that I cannot resolve autonomously. Please complete it in the Aegis UI."

---

## UI Language

### Phase 2 — Manual Code Injection (current target)

```
GitHub requires device verification.
Enter the code in Aegis. Aegis will inject it once into the browser.
The agent will not see the code.
[ ________ ]  [Inject Code]
```

Secondary text: "This code expires in 5 minutes. Aegis records this action."

### Phase 3 — Connected Email Resolver (v1 implemented)

```
Or: Find code automatically
[Find code in connected Gmail]

Safety: Aegis will not show the code or email contents to the agent.
```

Status messages shown after resolution:
- Searching: "Searching Gmail for recent GitHub verification email..."
- Found: "Code found — from github.com, received X seconds ago. Aegis will inject it when you proceed."
- Not found: "No code found in recent GitHub emails. Enter the code manually below."
- Failed: "Search failed: <error>. Enter the code manually below."
- Injected: "Code injected."

If Gmail is not connected: "Gmail resolver is not connected." (no OAuth setup instructions in the UI — setup is in local-dev docs only).

---

## Gmail/Email Connector Constraints (Phase 3 gate conditions)

Before the email resolver may be built, all of the following must hold:

- A live `SecurityChallenge` record must exist before any inbox search begins.
- Search window is limited: only emails received after `challenge.created_at`.
- Sender domain must match an allowlist (e.g., `github.com` → allow `noreply@github.com`).
- Service domain in the email must match the challenge domain.
- Code extraction only — the full email body, subject, sender name, and thread are never returned to any API caller or agent.
- User must explicitly approve Gmail access before first use per account.
- Aegis caches nothing after extraction (no email body storage, no code persistence post-injection).

---

## Future API Sketch

These types are illustrative. Do not implement until the corresponding phase is explicitly planned.

```ts
type SecurityChallenge = {
  challenge_id: string;
  challenge_type: ChallengeType;
  domain: string;
  session_id: string;           // task browser session or auth session
  injection_id?: string;        // set when code injection is approved
  status:
    | "pending_user"
    | "user_completed"          // Phase 1 terminal
    | "code_injected"           // Phase 2 terminal
    | "expired"
    | "failed";
  created_at: string;
  expires_at: string;
  raw_code_revealed_to_agent: false;
};

type TemporaryChallengeSecret = {
  secret_id: string;
  challenge_id: string;
  domain: string;
  single_use: true;
  used: boolean;
  expires_at: string;
  raw_value_revealed_to_agent: false;
};

type ChallengeRelayAuthorization = {
  authorization_id: string;
  challenge_id: string;
  authorized_by: "user";
  scope: "single_use";
  injection_allowed: boolean;
  email_resolver_allowed: boolean;  // Phase 3 only
  created_at: string;
  raw_code_revealed_to_agent: false;
};
```

MCP tool sketch (names only, parameters TBD at implementation time):
- `report_security_challenge` — agent signals a challenge was detected
- `wait_for_security_challenge` — agent polls for terminal status
- `get_security_challenge_status` — status check without blocking

Internal API (not agent-facing):
- `POST /api/agent/v1/challenges` — create challenge record
- `GET /api/agent/v1/challenges/:id` — status poll
- `POST /api/internal/challenges/:id/inject` — user-triggered code injection from Aegis UI

---

## Non-Goals

- No CAPTCHA solving.
- No bypassing passkeys or any human-presence check.
- No giving agents mailbox access — the email resolver is Aegis-internal only; the agent never queries email.
- No persistent challenge-code storage after use.
- No Aegis-controlled navigation — the agent continues to own all clicking, form submission, and page interaction.
- No SMS interception in v1 — SMS codes must be entered manually by the user.
