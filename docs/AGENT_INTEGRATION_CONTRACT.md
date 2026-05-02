# Aegis Agent Integration Contract v1

> **Status: Development / Demo Only.** This API runs on a local development server. It is not a production service. Token values, skill IDs, and run IDs shown here are demo fixtures.

---

## Purpose

Aegis lets third-party autonomous agents request trusted execution of user-installed skills without receiving raw credentials or direct browser-control privileges.

An agent holds a **Delegation Token** bound to a user's active delegation. It can discover the skills that delegation permits, request a run against an installed skill, poll until the run reaches a terminal state, and read the audit receipt. At no point does the agent receive a Playwright handle, a raw browser context, or any credential stored by the user.

---

## Agent Autonomy Model

Agents remain fully autonomous above Aegis — using their own tools for reading pages, searching, summarizing, planning, and reasoning. Aegis is not a general browsing layer.

Aegis is invoked selectively when the agent needs one of two things:

**Agent-runnable skills (`execution_mode: "agent_runnable"`):** Aegis has a verified, Aegis-tested route recipe for a routine workflow (browsing, searching, reading). The agent calls `get_agent_runnable_workflow` to retrieve the step-by-step recipe and executes it in its own browser session. The agent keeps full browser control. No extension handoff. No RouteRun. Aegis contributes tested locators and variable bindings so the agent does not need to re-plan from scratch.

**Aegis-controlled skills (`execution_mode: "aegis_controlled"`):** The workflow involves credentials, payments, personal data, approvals, or sensitive side effects. The agent calls `request_skill_run`, and Aegis takes custody of the execution — via the Chrome extension, collar enforcement, and the approval flow. The agent waits for a receipt.

---

## Routine vs Sensitive Workflows

Every skill returned by `discover_installed_skills` carries two fields that tell the agent how to act:

| Field | Values | Meaning |
|---|---|---|
| `execution_mode` | `"agent_runnable"` | Aegis has a verified route recipe for this workflow. Call `get_agent_runnable_workflow(skill_id)` to retrieve the steps and execute them in the agent's own browser session. The agent stays in control — no extension handoff, no RouteRun. |
| `execution_mode` | `"aegis_controlled"` | The workflow is sensitive. The agent **must** use `request_skill_run` — Aegis takes execution custody, handles credential injection and collar enforcement, and produces an audit receipt. |
| `sensitivity_level` | `"routine"` | Browsing, searching, reading — no secrets, no side effects, no approval required. Agent can execute in its own browser. |
| `sensitivity_level` | `"sensitive"` | Credentials, payments, personal data disclosure, public posting, form submission, account changes, or any action requiring an audit trail. Aegis must execute. |

**Decision rule:** check `execution_mode` first.
- `agent_runnable` → call `get_agent_runnable_workflow`, then execute the recipe with your browser tools.
- `aegis_controlled` → call `request_skill_run`; do not attempt to replicate the workflow yourself.

### Demo skill reference

| Skill | Domain | `execution_mode` | `sensitivity_level` |
|---|---|---|---|
| Wikipedia Search | `en.wikipedia.org` | `agent_runnable` | `routine` |
| Demo Purchase Skill | `test.aegis.local` | `aegis_controlled` | `sensitive` |
| Demo Blocked Skill | `test.aegis.local` | `aegis_controlled` | `sensitive` |
| Demo Login | `localhost:3000` | `aegis_controlled` | `sensitive` |

---

## Core Model

| Concept | What it is |
|---|---|
| **Delegation Token** | Bearer token bound to an active `AgentDelegation`. Identifies the agent and determines which skills it can access and under what collar. |
| **Skill** | A reusable installed workflow capability (e.g. "Wikipedia Search"). Has a domain, required variables, required permissions, and a trust tier. |
| **RouteRun** | One execution request for a skill. Created by the agent, executed by the Aegis Chrome extension on behalf of the user. |
| **Receipt** | Immutable audit record written when a run completes or fails. Contains the skill name, route trust tier, allowed reason, and execution surface. |
| **Collar** | The permission boundary attached to the delegation. The Aegis API enforces collar policy before creating any run. |
| **Approval Gate** | For sensitive permissions, the collar may require explicit user approval before the extension executes a run. |

---

## Agent Boundary

### Agents may

- Discover installed skills visible to their delegation token
- Fetch the route recipe for an agent-runnable skill and execute it in their own browser session
- Request a RouteRun against an aegis_controlled skill (with variables)
- Poll run status until it reaches a terminal state
- Read the receipt after a run completes or fails

### Agents may not

- Call browser click, type, navigate, or screenshot APIs directly
- Bypass collar policy — the server enforces it unconditionally
- Execute or transition a `pending_approval` run — only the user can approve it
- Supply `agent_id`, `delegation_id`, or `collar_id` in request bodies — the server derives all three from the token

---

## Authentication

All agent-facing API calls require:

```
Authorization: Bearer <delegation_token>
```

**Demo tokens:**

| Token | Resolves to | Skill access |
|---|---|---|
| `pass_demo_001` | `agent_demo_001` / `delg_demo_001` | All installed skills |
| `pass_demo_002` | `agent_demo_restricted` / `delg_demo_restricted` | None (`only` policy, empty list) |

**Error responses for bad auth:**

```json
// Missing token → 401
{ "ok": false, "error": { "code": "AUTH_REQUIRED", "message": "Authorization header required" } }

// Invalid or expired token → 401
{ "ok": false, "error": { "code": "INVALID_TOKEN", "message": "Invalid or inactive delegation token" } }
```

---

## API Flow

### Step 1 — Discover usable installed skills

```
GET /api/skills?domain=<domain>&installed=true
Authorization: Bearer <token>
```

The server filters to skills installed by the user whose delegation the token resolves to. Skills excluded by the delegation's skill-access policy are omitted.

**Response (skills found):**

```json
{
  "ok": true,
  "data": [
    {
      "skill_id": "skill_wikipedia_search",
      "name": "Wikipedia Search",
      "summary": "Search Wikipedia and navigate to an article",
      "domain": "en.wikipedia.org",
      "installed": true,
      "trust_tier": "aegis_scanned",
      "required_permissions": ["navigate", "read_page"],
      "risk_level": "low"
    }
  ]
}
```

**Response (no accessible skills):**

```json
{ "ok": true, "data": [] }
```

An empty array means either no skills are installed for this domain or the delegation policy excludes all of them. Treat empty discovery as a terminal condition — do not proceed to create a run.

---

### Step 1b — (Agent-runnable) Fetch the route recipe and execute in your own browser

If `execution_mode` is `"agent_runnable"`, retrieve the route recipe instead of creating a RouteRun:

```
GET /api/routes/:routeId
```

No auth required. `routeId` is the `route_id` from Step 1's skill object.

**Response:**

```json
{
  "ok": true,
  "data": {
    "route_id": "route_demo_wikipedia_001",
    "workflow_name": "Wikipedia Search",
    "domain": "en.wikipedia.org",
    "trust_tier": "aegis_scanned",
    "variables": [
      { "name": "query", "label": "Search query", "type": "text", "default_value": "Michigan" }
    ],
    "steps": [
      {
        "order": 1,
        "action": "fill",
        "intent": "search_wikipedia",
        "target": {
          "preferred_locator": { "type": "label", "name": "Search Wikipedia" },
          "fallback_locators": [
            { "type": "placeholder", "value": "Search Wikipedia" },
            { "type": "css", "value": "[name=\"search\"]" }
          ]
        },
        "variable_binding": "query"
      },
      {
        "order": 2,
        "action": "click",
        "intent": "search",
        "target": {
          "preferred_locator": { "type": "label", "name": "Search" },
          "fallback_locators": [{ "type": "role", "role": "button", "name": "Search" }]
        }
      }
    ]
  }
}
```

Execute each step in order in your own browser session. Use `preferred_locator` first; try `fallback_locators` in order if needed. For steps with `variable_binding`, substitute the runtime value the user supplied. No RouteRun, no extension, no receipt — the agent is in control.

**Error: called on an `aegis_controlled` skill**

```json
{
  "ok": false,
  "error": {
    "code": "NOT_AGENT_RUNNABLE",
    "message": "This skill requires Aegis-controlled execution. Use request_skill_run instead."
  }
}
```

If you receive `NOT_AGENT_RUNNABLE`, the skill's `execution_mode` is `aegis_controlled`. Do not attempt to replicate the workflow yourself. Call `request_skill_run` (Step 2).

---

### Step 2 — (Aegis-controlled) Request a RouteRun

```
POST /api/skills/:skillId/runs
Authorization: Bearer <token>
Content-Type: application/json

{ "variables": { "query": "Michigan" } }
```

Do not include `agent_id`, `delegation_id`, or `collar_id` in the body. The server derives these from the token.

**Response: run created, pending extension pickup**

```json
{
  "ok": true,
  "data": {
    "run_id": "run_abc123",
    "skill_id": "skill_wikipedia_search",
    "status": "pending",
    "domain": "en.wikipedia.org",
    "variables": { "query": "Michigan" },
    "agent_id": "agent_demo_001",
    "delegation_id": "delg_demo_001",
    "collar_id": "collar_demo_001",
    "created_at": "2026-05-01T12:00:00Z"
  }
}
```

**Response: run created but requires user approval**

```json
{
  "ok": true,
  "data": {
    "run": {
      "run_id": "run_abc456",
      "status": "pending_approval",
      ...
    },
    "approval_required": true,
    "approval_required_permissions": ["purchase", "submit_order"],
    "message": "This run requires user approval before execution."
  }
}
```

**Error responses:**

```json
// Agent's delegation does not permit this skill → 403
{ "ok": false, "error": { "code": "SKILL_ACCESS_DENIED", "message": "..." } }

// Collar does not allow the skill's required permissions → 403
{ "ok": false, "error": { "code": "COLLAR_BLOCKED", "message": "..." } }

// Skill is not installed by this user → 403
{ "ok": false, "error": { "code": "SKILL_NOT_INSTALLED", "message": "..." } }

// Required variables not supplied → 400
{ "ok": false, "error": { "code": "MISSING_VARIABLES", "message": "Missing: query" } }

// Domain not supported → 400
{ "ok": false, "error": { "code": "DOMAIN_NOT_SUPPORTED", "message": "..." } }
```

---

### Step 3 — Handle the initial response

| Initial status | What to do |
|---|---|
| `pending` | Poll for status changes (Step 4) |
| `pending_approval` | Notify the user that approval is required. Link them to `/route-run-approvals` in the Aegis dashboard. Continue polling — after the user approves, status transitions to `pending`. |
| `SKILL_ACCESS_DENIED` / `COLLAR_BLOCKED` / other error codes | Stop. Report the error to the user. Do not retry without resolving the policy conflict. |

---

### Step 4 — Poll run status

```
GET /api/route-runs
Authorization: Bearer <token>
```

The endpoint returns all runs. Filter client-side by `run_id` from Step 2.

Poll every ~3 seconds. Stop when status is a terminal value.

**Terminal statuses:** `completed`, `failed`, `blocked`

**Response shape:**

```json
{
  "ok": true,
  "data": [
    {
      "run_id": "run_abc123",
      "status": "running",
      "started_at": "2026-05-01T12:00:05Z",
      ...
    }
  ]
}
```

---

### Step 5 — Read the receipt

```
GET /api/route-run-receipts
Authorization: Bearer <token>
```

Filter by `run_id`. Receipts are created only for `completed` and `failed` runs. A `blocked` run has no receipt.

```
GET /api/route-run-receipts/:receiptId
Authorization: Bearer <token>
```

**Receipt shape:**

```json
{
  "receipt_id": "rcpt_xyz789",
  "run_id": "run_abc123",
  "skill_id": "skill_wikipedia_search",
  "skill_name": "Wikipedia Search",
  "route_name": "Wikipedia Search Route",
  "route_trust_tier": "aegis_scanned",
  "domain": "en.wikipedia.org",
  "status": "completed",
  "agent_id": "agent_demo_001",
  "execution_surface": "chrome_extension",
  "allowed_reason": "collar_allowed",
  "variables": { "query": "Michigan" },
  "created_at": "2026-05-01T12:00:00Z",
  "completed_at": "2026-05-01T12:00:15Z"
}
```

---

## Request/Response Examples

### Happy path (curl)

```bash
TOKEN="pass_demo_001"
BASE="http://localhost:4000"

# 1. Discover skills
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/skills?domain=en.wikipedia.org&installed=true" | jq .

# 2. Create a run
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"variables": {"query": "Michigan"}}' \
  "$BASE/api/skills/skill_wikipedia_search/runs" | jq .

# 3. Poll status (repeat until terminal)
RUN_ID="run_abc123"
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/route-runs" | jq ".data[] | select(.run_id == \"$RUN_ID\")"

# 4. Read receipt (after completed)
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/route-run-receipts" | jq ".data[] | select(.run_id == \"$RUN_ID\")"
```

---

### Approval-required path

This path triggers when the skill requires permissions that the collar marks `approval_required`.

```bash
# 1. Create a run — response includes approval_required: true
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"variables": {"amount": "50"}}' \
  "$BASE/api/skills/skill_purchase/runs" | jq .

# Expected: { "run": { "status": "pending_approval", ... }, "approval_required": true }

# 2. User approves via /route-run-approvals in the Aegis dashboard
#    Or via the API:
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/route-runs/$RUN_ID/approve" | jq .

# 3. Status transitions to "pending" — resume polling
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/route-runs" | jq ".data[] | select(.run_id == \"$RUN_ID\") | .status"
```

---

### Denied path (restricted delegation)

```bash
# Using restricted token — skill discovery returns empty array
curl -s -H "Authorization: Bearer pass_demo_002" \
  "$BASE/api/skills?domain=en.wikipedia.org&installed=true" | jq .
# { "ok": true, "data": [] }

# Attempting a run with restricted token → SKILL_ACCESS_DENIED
curl -s -X POST \
  -H "Authorization: Bearer pass_demo_002" \
  -H "Content-Type: application/json" \
  -d '{"variables": {"query": "Michigan"}}' \
  "$BASE/api/skills/skill_wikipedia_search/runs"
# { "ok": false, "error": { "code": "SKILL_ACCESS_DENIED", ... } }
```

---

## Status Lifecycle

```
                  ┌─────────────────────────────────────────────┐
                  │                                             │
 POST /runs ──▶ pending_approval ──(user approve)──▶ pending ──(extension)──▶ running ──▶ completed
                  │                                    │                         │
                  │                                    │                         └──────▶ failed
                  └──(user reject)──▶ blocked          └──(collar recheck block)──▶ blocked
```

**Terminal states** (no further transitions): `completed`, `failed`, `blocked`

**Who drives each transition:**

| Transition | Driven by |
|---|---|
| `pending_approval` → `pending` | User (via `/route-run-approvals` UI or `POST .../approve`) |
| `pending_approval` → `blocked` | User (reject) |
| `pending` → `running` | Aegis Chrome extension — automatically when background auto-run is enabled and exactly one low-risk pending run exists for the active tab domain, or manually via the popup Start Run button |
| `running` → `completed` | Aegis Chrome extension, after verifying the final browser outcome matches the expected result |
| `running` → `failed` | Aegis Chrome extension (on replay error, fill verification failure, or outcome mismatch) |

An agent only observes status changes — it never drives them.

**Background auto-run conditions (all must be true for automatic execution):**

- User has enabled the auto-run toggle in the extension popup (opt-in, off by default)
- The active tab domain matches the run's domain
- The active tab URL matches the run's `url_match` pattern (if set on the route) — domain alone is not sufficient for routes that specify a URL context; a `url_match: "/demo-login"` route will not execute on `/route-run-approvals`
- The run has `risk_level === "low"`
- Exactly one eligible pending run exists for that domain (multiple eligible runs require manual choice)
- The run is not `pending_approval` (those require explicit user approval first)

---

## Executable Reference

`apps/api/scripts/fake-agent-create-run.mjs` is an executable agent harness that demonstrates the full flow above.

```bash
node apps/api/scripts/fake-agent-create-run.mjs
```

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `AEGIS_API_BASE` | `http://localhost:4000` | Base URL of the Aegis API |
| `AEGIS_AGENT_TOKEN` | `pass_demo_001` | Delegation token sent as Bearer |
| `AEGIS_DOMAIN` | `en.wikipedia.org` | Domain to discover skills for |
| `AEGIS_SKILL_ID` | *(first found)* | Pin to a specific skill ID |
| `AEGIS_QUERY` | `Michigan` | Value passed as `variables.query` |
| `AEGIS_POLL` | `true` | Whether to poll until terminal state |
| `AEGIS_TIMEOUT_MS` | `60000` | Polling timeout in milliseconds |
| `AEGIS_AUTO_START` | `false` | Simulate extension locally (smoke test only — not real browser execution) |

**Demo scenarios:**

```bash
# Happy path — full agent flow, waits for extension to complete
AEGIS_AGENT_TOKEN=pass_demo_001 node apps/api/scripts/fake-agent-create-run.mjs

# Restricted token — discovers no skills, exits cleanly
AEGIS_AGENT_TOKEN=pass_demo_002 node apps/api/scripts/fake-agent-create-run.mjs

# Backend smoke test — auto-completes without extension (not real execution)
AEGIS_AUTO_START=true node apps/api/scripts/fake-agent-create-run.mjs
```

---

## Security Notes

- The token resolves `agent_id`, `delegation_id`, and `collar_id` server-side. Any values supplied in the request body for these fields are ignored.
- Collar policy is enforced at run creation time. A run that would violate the collar is rejected before any extension execution begins.
- The Aegis extension is the only surface that can transition a run from `pending` to `running`. An agent cannot trigger this directly.
- `pending_approval` runs are invisible to the extension until a user explicitly approves them. An agent cannot self-approve.
- Receipts are written by the server at run completion and are immutable. They are audit evidence, not legally binding records.
- No credential, password, card number, or sensitive field value stored by Aegis is ever returned to the agent.

---

## Secret Vault / Pass Custody v1 (KMS)

**Status:** Implemented. KMS Abstraction v1 complete — AES-256-GCM encrypted at rest via provider interface.

### KMS Provider Interface

The `KmsProvider` interface is the stable boundary. Swapping from `local_dev` to a cloud KMS provider (AWS KMS, GCP KMS, Azure Key Vault, HSM) requires only adding a provider class and updating `AEGIS_KMS_PROVIDER` in `.env`. All vault APIs and secret resolution code remain unchanged.

```
AEGIS_KMS_PROVIDER=local_dev           # temporary dev/MVP provider
AEGIS_LOCAL_KMS_KEY_B64=<base64 key>   # 32-byte (256-bit) AES key
```

The `local_dev` provider uses AES-256-GCM:
- 96-bit random nonce per encryption
- 128-bit GCM authentication tag
- AAD = `${user_id}|${pass_id}|${domain}|${purpose}` — tampered context fails GCM auth
- Key must decode to exactly 32 bytes; missing or wrong-size key throws a clear error

### Model

Credentials are split into two layers:

- **`AegisVaultPass`** — metadata object (pass_id, label, domain, username, secret_ref). Persisted to disk. Never contains the raw secret value.
- **`encryptedSecretVault`** — map keyed by `secret_ref` containing `EncryptedSecretBlob` (ciphertext, nonce, tag). Persisted to disk as `encryptedSecretVaultEntries`. Blobs are decrypted only at the extension injection point — never returned via any agent-facing endpoint.

Route steps reference credentials by ID using `value_policy.type`:
- `"pass_field"` — resolves a non-secret field (e.g. username) from the vault pass metadata.
- `"secret_ref"` — decrypts the secret value (e.g. password) from `encryptedSecretVault` via KMS. Requires `aegis_controlled` execution mode.

### Resolve-Value Endpoint

`POST /api/route-runs/:runId/resolve-value` — called by the Aegis extension during replay, never by agents.

**Validation:** run must be `running`; if `approval_required_permissions` is non-empty, `approved_at` must be set; pass domain must match route domain; `secret_ref` requires `aegis_controlled`.

**Response:**
```json
{ "ok": true, "data": { "value": "...", "value_source": "secret_ref", "pass_id": "pass_vault_demo_login_001", "redacted": true } }
```

**Errors:** `NOT_FOUND`, `INVALID_STATE`, `SECRET_NOT_ALLOWED`, `SECRET_NOT_AVAILABLE` (blob missing), `SECRET_DECRYPT_FAILED` (wrong key or tampered data), `NOT_PASS_STEP`.

### Receipt Metadata

When resolve-value is called, the run is updated with:
- `credential_used: true`
- `pass_ids_used: ["pass_vault_demo_login_001"]`
- `secret_values_revealed_to_agent: false`

These fields appear in the receipt. The secret value itself is never stored.

### What This Is Not

- Not production HSM/KMS. `local_dev` provider is a temporary AES-256-GCM bridge.
- Not real Gmail, bank, or OAuth credential custody.
- Demo Login uses fake seeded credentials only.
- Agents never receive secret values through MCP tools or any other agent-facing API.

---

## Natural-Language Pass Selection (v1)

**Status:** Implemented.

Users can tell their agent "use my Test Login credential" without opening the Passes UI. Two MCP tools work together:

1. **`list_vault_passes`** — returns vault pass metadata (pass_id, label, username, domain, kind, has_password). Never returns passwords or `secret_ref`.
2. **`request_skill_run`** — now accepts an optional `pass_overrides` field: `Record<string, string>` where the key is the credential purpose (`"login_password"`) and the value is a `pass_id` from `list_vault_passes`.

### Resolution precedence at resolve-value time

When the Aegis extension resolves a credential during run execution:

1. `run.pass_overrides["login_password"]` — per-run override (highest priority)
2. `RoutePassBinding` for `user_id:route_id:login_password` — persistent UI-set binding
3. `step.value_policy.pass_id` — default baked into the route

### Typical agent flow

```
user: "log in using my Test Login credential"

agent calls: list_vault_passes({ query: "test login" })
→ returns: [{ pass_id: "pass_vault_abc", label: "Test Login", domain: "localhost", username: "test_user", has_password: true }]

agent calls: request_skill_run({
  skill_id: "skill_demo_login_001",
  pass_overrides: { "login_password": "pass_vault_abc" }
})
→ Aegis validates the override at run creation, creates the run with pass_overrides stored
→ Extension resolves credential using "Test Login" pass, not the route default
→ Receipt records: pass_ids_used: ["pass_vault_abc"]
```

### Validation at run creation

`pass_overrides` entries are validated before any run is created. The server returns `400 INVALID_PASS_OVERRIDE` if:
- The purpose key is not `"login_password"` (v1 only supports this purpose)
- The `pass_id` does not exist in the vault
- The pass belongs to a different user
- The pass `kind` does not match the purpose key
- The pass `domain` does not match the route's `domain`
- The pass has no encrypted secret in `encryptedSecretVault` (re-enter the password in the Passes UI — old plaintext secrets from pre-KMS store are not migrated)

### Security invariants

- `list_vault_passes` never exposes `secret_ref` or any secret value. Metadata only.
- `pass_overrides` is validated at creation time and stored on the run; secret resolution at the extension still checks ownership and domain as defense-in-depth.
- `secret_values_revealed_to_agent: false` on run receipts is unchanged.
- Persistent route-pass bindings are unaffected; per-run override is an additive, non-destructive path.

---

## Credential Session Context Binding (v1)

**Status:** Implemented.

Domain-only matching is insufficient for sites with multiple paths (e.g. `linkedin.com/login` vs `linkedin.com/feed`). When a credential session is created with `target_url`, Aegis binds fills to that specific page — the extension will not resolve any secret until the active tab matches.

### How it works

- **`target_url`** (optional) — the exact login page URL, e.g. `"http://localhost:3000/demo-login"` or `"https://www.linkedin.com/login"`.
- **`url_match`** — derived at session creation time; stored on the session. Shape: `{ hostname: string; path_prefix?: string }`.
  - If `target_url` is provided: `hostname` comes from the URL, `path_prefix` is the pathname (omitted if `/`).
  - If `target_url` is omitted: `hostname` is the bare domain (port stripped). No `path_prefix`.
- The Aegis extension checks `url_match` before calling `resolve-value`. If the active tab hostname and path don't match, the fill request remains `pending` — it is not marked failed and is not consumed.
- On the next extension alarm tick (~10s), if the correct page is now active, the fill proceeds normally.

### No LLM page analysis

Aegis uses deterministic URL checks only. The decision to fill is made by comparing `new URL(tab.url).hostname` and `.pathname` against stored `url_match` values — not by analyzing page content with a model. This keeps the guard layer fast and auditable.

### Agent flow

```
agent calls: start_credential_session({
  pass_id: "pass_vault_abc",
  domain: "localhost",
  allowed_fields: ["username", "password"],
  target_url: "http://localhost:3000/demo-login"   ← binds fills to /demo-login only
})

→ session created; user approves at /route-run-approvals
→ agent navigates to http://localhost:3000/demo-login
→ agent calls: fill_credential_field({ session_id, field: "username" })
→ extension sees active tab = /demo-login → url_match passes → fills username
→ extension sees active tab = /route-run-approvals → url_match fails → leaves pending
```

### Backward compatibility

If `target_url` is omitted, the session uses hostname-only matching (previous behavior). No changes to sessions that don't supply `target_url`.

### Errors at session creation

| Code | Cause |
|---|---|
| `INVALID_TARGET_URL` | `target_url` is not a parseable URL |
| `TARGET_URL_DOMAIN_MISMATCH` | `target_url` hostname does not match `domain` |

---

## Planning Tool: `plan_aegis_action` (v1)

**Status:** Implemented.

`plan_aegis_action` is an advisory-only tool. It analyzes a task description, heuristically matches installed skills and vault credentials, and returns a structured recommendation — without executing anything, creating any runs, or calling any POST endpoint.

Call this first when the agent has a task description but has not yet identified which skill or credential to use.

### Inputs

| Field | Required | Description |
|---|---|---|
| `task` | Yes | Natural language description of the task |
| `domain` | No | Target domain to restrict skill discovery; inferred from task keywords if omitted |
| `credential_hint` | No | Substring to match against vault pass labels or usernames |

**Domain inference:** if `domain` is omitted, the tool infers from task keywords: "demo"/"localhost" → `localhost:3000`, "wikipedia" → `en.wikipedia.org`, otherwise fetches all installed skills.

### Recommended paths returned

| `recommended_path` | Meaning | Agent next step |
|---|---|---|
| `agent_runnable_recipe` | Matched skill is routine and agent-executable | Call `get_agent_runnable_workflow` with `suggested_request.skill_id` |
| `aegis_controlled_run` | Matched skill is sensitive; Aegis must execute | Call `request_skill_run` with `suggested_request` (includes `pass_overrides` if a credential was resolved) |
| `normal_agent_tools` | No matching skill; task is non-sensitive | Use normal agent tools |
| `no_match` | No matching skill; task contains sensitive keywords | Surface warning; check Aegis Skill Library before proceeding with agent tools |

### Credential resolution (aegis_controlled skills only)

Triggered when `credential_hint` is supplied or the task contains signals ("my account", "using my", "log in as", "my password", "credential"). The tool calls `GET /api/vault-passes`, filters by skill domain and hint substring, then:

- **1 match:** `suggested_request` includes `pass_overrides: { "login_password": "<pass_id>" }` — ready to pass directly to `request_skill_run`
- **Multiple matches:** `needs_clarification: true` with `candidates` array — agent should ask the user to clarify, then retry with a more specific `credential_hint`
- **0 matches:** `credential_resolution: "not_found"` — `suggested_request` omits `pass_overrides`; agent can call `list_vault_passes` to browse manually

### Security invariants

- No passwords, `secret_ref`, or raw secret values are ever returned. `matched_pass` and `candidates` contain only `pass_id`, `label`, and `username`.
- The tool never calls any POST endpoint and never creates or modifies any resource.
- `has_password` is also excluded from all responses — presence of a pass in the list already implies it has been configured.

### Example

```
plan_aegis_action({
  task: "Log into the demo site using my Demo Login Account credential",
  credential_hint: "Demo Login Account"
})

→ {
    "recommended_path": "aegis_controlled_run",
    "matched_skill": { "skill_id": "skill_demo_login_001", "name": "Demo Login", "domain": "localhost:3000" },
    "matched_pass": { "pass_id": "pass_vault_demo_login_001", "label": "Demo Login Account", "username": "demo_user" },
    "next_tool": "request_skill_run",
    "suggested_request": {
      "skill_id": "skill_demo_login_001",
      "variables": {},
      "pass_overrides": { "login_password": "pass_vault_demo_login_001" }
    },
    "explanation": "This is a sensitive workflow requiring Aegis control. Your selected credential will be resolved server-side — no passwords are exposed."
  }
```

---

## What This Is Not

- This is not a browser automation SDK. Agents do not receive a browser handle.
- This is not an agent builder. Aegis executes workflows that users have installed and authorized.
- This is not production-ready. Token management, key rotation, rate limiting, and multi-user auth are not implemented.
- Routes are not arbitrary executable scripts. They are declarative, inspectable, versioned workflow objects reviewed before publication.
- This is not a general browsing or web research layer. For non-sensitive reading, searching, and summarization, agents should use their own tools.
- This is not a credential custody or pass vault system. Demo Login uses fake seeded credentials for demo purposes only. Real credential injection is not implemented.
