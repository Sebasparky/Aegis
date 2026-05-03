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

**Aegis-controlled skills (`execution_mode: "aegis_controlled"`):** The workflow involves credentials, payments, personal data, approvals, or sensitive side effects. The agent calls `request_skill_run`, and Aegis takes custody of the execution — via a controlled execution surface, collar enforcement, and the approval flow. The agent waits for a receipt.

---

## Aegis Execution Surfaces

When Aegis executes a controlled run, it uses one of two execution surfaces. The receipt records which surface was used via `execution_surface`.

### `aegis_playwright` — Primary Autonomous-Agent Surface

| Property | Value |
|---|---|
| Who starts it | Agent or API caller — `POST /api/runtime/route-runs/:runId/playwright/start` |
| Browser | Isolated headless Chromium launched by Aegis |
| User action required | None — no tab to open, no extension to activate |
| Credentials | Resolved inside Aegis runtime via KMS vault; never exposed to agent |
| Receipt | `execution_surface: "aegis_playwright"`, signed EdDSA JWS, chained hash |
| Best for | Autonomous agents, API-driven pipelines, headless environments |

**This is the recommended execution surface for autonomous agent workflows.** Agents do not need the Chrome extension running. Aegis manages the full browser lifecycle.

### `chrome_extension` — Optional Local/Browser Companion

| Property | Value |
|---|---|
| Who starts it | Extension background service worker (auto-run) or user clicking "Start Run" |
| Browser | User's Chrome profile with extension installed |
| User action required | Active tab must match route domain + `url_match`; extension must be running |
| Credentials | Resolved via extension `resolve-value` endpoint (never returned to agent) |
| Receipt | `execution_surface: "chrome_extension"`, same signing pipeline |
| Best for | Local interactive demos, workflow recording, user-visible session monitoring |

The Chrome extension is retained as a local debugging companion and workflow recording surface. It is not the recommended default for autonomous agent workflows — agents should use the Playwright runtime so they do not depend on the user's browser state.

### Recommended Agent Flow for `aegis_controlled` Skills

1. **Discover / plan** — `plan_aegis_action` returns `post_approval_next_tool: "start_playwright_route_run"` for controlled skills.
2. **Create run** — `request_skill_run` (or `POST /api/skills/:skillId/runs`) → `run_id`.
3. **Handle approval** — if `status=pending_approval`, direct user to `/route-run-approvals`. **Aegis automatically starts the Playwright runtime immediately after the user approves.** Poll `get_route_run_status` — the run should transition from `pending_approval` → `pending` → `running` → `completed` without any agent action.
4. **Poll to completion** — poll every ~3s until the run reaches a terminal state. The run is auto-started by Aegis; **do not ask the user to open a browser tab and do not call `start_playwright_route_run` unless the run remains `pending` after approval** (fallback for edge cases only).
5. **Fallback** — if the run does not transition to `running` within ~15s of approval, call `start_playwright_route_run` as a manual trigger.
6. **Verify** — `get_route_run_receipt` → confirm `execution_surface: "aegis_playwright"`, `signature_valid: true`.

### Architecture Note

Future Aegis features — delegation passports, action authorization receipts, liability proof — should target the Playwright runtime first. The Chrome extension can follow as a companion surface. No new autonomous-agent feature should require a user-opened browser tab as a prerequisite.

**Agents never receive raw credentials in either surface.** The Chrome extension resolves secrets via the extension-only `resolve-value` endpoint. The Playwright runtime resolves secrets internally via the KMS vault. Both surfaces set `secret_values_revealed_to_agent: false` on the receipt.

---

## Sensitive Workflow Detection v1

The Aegis Playwright runtime instruments every controlled browser session for sensitive workflow events. This runs automatically — agents and callers do not configure it.

### What is detected

| Event type | Trigger |
|---|---|
| `sensitive_field_focus` | A sensitive input (password, payment, identity, financial) received focus |
| `sensitive_field_input` | A value was entered in a sensitive input |
| `sensitive_button_click` | A button with sensitive text (pay, transfer, sign in, delete account, …) was clicked |
| `sensitive_form_submit` | A form containing a sensitive field was submitted |

### Coverage classification

Each event is classified as one of:

| Status | Meaning |
|---|---|
| `covered_by_aegis` | The event occurred inside an Aegis-controlled action window — Aegis initiated the fill or click, resolving secrets from the KMS vault under route authorization |
| `not_covered_by_aegis` | A high/critical sensitive event occurred outside any Aegis-controlled window — may indicate out-of-band interaction |
| `unknown` | A low-severity sensitive event whose coverage could not be determined |

### What is never stored

Event metadata is recorded — never field values, passwords, card numbers, CVVs, identity numbers, or any secret. `element_hint` contains safe structural metadata only (tag name, input type, name/id/autocomplete attribute, placeholder — never value).

### Coverage summary

After execution, the runtime session carries a `coverage_summary`:

```json
{
  "sensitive_events": 3,
  "covered_events": 3,
  "uncovered_events": 0,
  "unknown_events": 0,
  "highest_severity": "high",
  "sensitivities": ["credential"]
}
```

The receipt includes `runtime_coverage_summary` when execution used `aegis_playwright`.

### How to access events

```
GET /api/runtime/sessions/:runtimeSessionId/events
```

Returns the metadata-only event list for the session.

### What this does and does not prove

**Does prove:** Whether a sensitive event inside the Aegis Playwright runtime session was covered by an Aegis-authorized action (route step execution, KMS credential release).

**Does not prove:** That the agent has no out-of-band browser sessions, OS-level keyloggers, or other means of obtaining secrets. Detection is scoped to the controlled Playwright session.

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
| `pending` → `running` | **Aegis Playwright runtime** — triggered automatically after user approval for `aegis_controlled` skills (primary path for autonomous agents); OR Aegis Chrome extension — automatically when background auto-run is enabled and exactly one low-risk pending run exists for the active tab domain, or manually via the popup Start Run button |
| `running` → `completed` | Aegis Playwright runtime (after headless Chromium execution completes); OR Aegis Chrome extension, after verifying the final browser outcome matches the expected result |
| `running` → `failed` | Aegis Playwright runtime (on navigation error, locator failure, credential resolution failure); OR Aegis Chrome extension (on replay error, fill verification failure, or outcome mismatch) |

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

## Supabase Persistence v1

Vault passes, encrypted secrets, and route run receipts can be durably persisted in Supabase by setting `AEGIS_PERSISTENCE_PROVIDER=supabase` in the API environment.

### What is stored in Supabase

| Table | Contents |
|---|---|
| `aegis_vault_passes` | Vault pass metadata (pass_id, label, domain, username, kind, secret_ref). No passwords. |
| `aegis_encrypted_secrets` | KMS-encrypted blobs (nonce_b64, ciphertext_b64, tag_b64). No plaintext column exists. |
| `aegis_receipts` | Immutable route run audit records with `receipt_json` (full object) + `receipt_hash` (SHA-256). |

### Security boundaries

- Supabase stores **ciphertext only**. Decryption happens inside `apps/api` via the KMS layer.
- The `SUPABASE_SERVICE_ROLE_KEY` is backend-only. It must never be exposed to `apps/web` or `apps/extension`.
- Row-Level Security is enabled on all three tables with deny-by-default (no anon policies). The service role bypasses RLS.
- `secret_values_revealed_to_agent: false` is enforced in every receipt regardless of persistence mode.

### Local mode (default)

`AEGIS_PERSISTENCE_PROVIDER=local` (the default) uses the existing in-memory Maps + JSON file store. No Supabase interaction occurs.

### Dual-write bridge (temporary)

When Supabase mode is active, vault pass and secret writes go to both Supabase and the local in-memory Maps. This is a temporary bridge so non-migrated routes continue to work. The long-term path is full repository-backed access; the dual-write will be removed in a future session.

### Seed script

```bash
node apps/api/scripts/seed-supabase-demo.mjs
```

Upserts the demo vault pass and encrypted secret (for `pass_vault_demo_login_001`) into Supabase. Safe to re-run.

---

## Immutable + Signed Receipts v1

Receipts are tamper-evident audit objects. Each receipt row in `aegis_receipts` includes a hash chain link and an EdDSA/Ed25519 JWS signature.

### Receipt hash

```
receipt_hash = SHA-256(stable_sorted_json({ previous_receipt_hash, receipt_json }))
```

`previous_receipt_hash` is the `receipt_hash` of the most recently created receipt for the same `user_id` (null for the first receipt). This links each receipt into a chain: mutating any field changes the hash, breaking the chain.

`receipt_hash` and `receipt_jws` are Supabase row metadata — they are **not** fields on the `RouteRunReceipt` type.

### JWS signature

`receipt_jws` is a CompactSign EdDSA/Ed25519 JWS with:

- Protected header: `{ alg: "EdDSA", typ: "aegis-receipt+jws" }`
- Payload:
  ```json
  {
    "typ": "aegis.receipt.v1",
    "receipt_id": "...",
    "receipt_hash": "...",
    "previous_receipt_hash": "..." | null,
    "issuer": "...",
    "issued_at": "..."
  }
  ```

The JWS payload contains **no secrets** — no passwords, no credential values, no private keys.

### Verify endpoint

```
GET /api/route-run-receipts/:receiptId/verify
```

Returns:

```json
{
  "ok": true,
  "data": {
    "receipt_id": "...",
    "valid": true,
    "hash_valid": true,
    "signature_valid": true,
    "chain_previous_exists": true,
    "receipt_hash": "...",
    "recomputed_hash": "...",
    "previous_receipt_hash": "..." | null,
    "jws_payload": { "typ": "aegis.receipt.v1", ... }
  }
}
```

`valid = hash_valid && signature_valid && (chain_previous_exists if applicable)`.

Returns 404 if the receipt does not exist.

### Append-only enforcement

A PostgreSQL `BEFORE` trigger on `aegis_receipts` raises an exception for UPDATE and DELETE. This applies to all clients including the service role. Receipts can only be created, never mutated or deleted. To truncate in dev: drop the trigger, truncate, re-run `002_signed_immutable_receipts.sql`.

### Key setup

```bash
node apps/api/scripts/generate-receipt-keypair.mjs
# or
npm run generate:receipt-keypair --workspace=apps/api
```

Prints two lines; paste into `.env`:

```
AEGIS_RECEIPT_ISSUER=aegis-dev
AEGIS_RECEIPT_JWS_PRIVATE_JWK='{"kty":"OKP","crv":"Ed25519","d":"...","x":"..."}'
AEGIS_RECEIPT_JWS_PUBLIC_JWK='{"kty":"OKP","crv":"Ed25519","x":"..."}'
```

`AEGIS_RECEIPT_JWS_PRIVATE_JWK` must never be exposed outside `apps/api`.

### Local dev mode

In local mode (`AEGIS_PERSISTENCE_PROVIDER=local`), signing is best-effort: all signing errors are swallowed and `receipt_jws` is null. `valid` is `hash_valid` only when unsigned. This allows local development and tests to run without keys configured.

For Supabase mode with no keys: set `AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV=true` to allow unsigned inserts (not recommended for production). The verify endpoint will return `signature_valid: false, error: "NO_JWS"` for unsigned receipts.

### This is not blockchain

Receipts are portable signed audit evidence — no distributed ledger, no consensus, no token. The chain and signature are verifiable by any party with the Aegis public key.

---

## Delegation Passport v1

A **Delegation Passport** is a signed document an agent can carry to prove it operates under Aegis-controlled delegation. It is created by the user (or on behalf of the user via their delegation token) and signed by the Aegis server using EdDSA/Ed25519.

### What the passport proves

- Which verified human user the agent is acting for
- Which delegation and collar governs the agent's authority
- What actions are allowed, blocked, and require approval
- That Aegis holds the user's credentials — the agent never receives raw passwords, payment data, or identity documents
- That sensitive covered actions require: Aegis authorization and capability release, the Aegis Playwright controlled runtime, sensitive workflow detection, and a signed receipt
- What capability attestations are available (credential domains, transaction limits)
- Receipt-backed evidence: number of verified receipts, credential uses, covered/uncovered sensitive events

### What the passport does NOT prove

- **The agent has no out-of-band secrets.** Aegis controls only the execution of actions that go through Aegis workflows. The passport cannot and does not claim the agent is incapable of accessing secrets via other means.
- That every browser action was Aegis-covered. Only actions that went through `request_skill_run` and the Aegis Playwright runtime are covered.
- That Aegis removes all liability or risk. Sensitive actions still require user approval.

The field `aegis_coverage_boundary.aegis_does_not_prove_agent_has_no_out_of_band_secrets: true` is present in every passport and must never be removed.

### API endpoints

**Create a passport:**
```
POST /api/delegation-passports
Authorization: Bearer <delegation-token>
Content-Type: application/json

{ "delegation_id": "delg_demo_001", "expires_in_minutes": 60 }
```

**Read a passport:**
```
GET /api/delegation-passports/:passportId
```

**Check status:**
```
GET /api/delegation-passports/:passportId/status

Response: { passport_id, status, expires_at, active, revoked }
```

**Verify hash + JWS:**
```
GET /api/delegation-passports/:passportId/verify

Response: {
  valid, hash_valid, signature_valid,
  active, expired, revoked,
  passport_hash, recomputed_hash,
  jws_payload: { typ, passport_id, passport_hash, issuer, issued_at, expires_at, user_aegis_id, agent_id, delegation_id, collar_id }
}
```

**Revoke a passport:**
```
POST /api/delegation-passports/:passportId/revoke
```

### MCP tools

`create_delegation_passport(delegation_id, expires_in_minutes?)` — creates and returns a signed passport.

`verify_delegation_passport(passport_id)` — verifies hash, JWS signature, expiry, and revocation. Returns `valid`, `hash_valid`, `signature_valid`, and the JWS payload.

### Verification semantics

1. The passport hash is SHA-256 of the full passport JSON with keys sorted and the `verification` block excluded.
2. The JWS payload covers: `typ`, `passport_id`, `passport_hash`, `issuer`, `issued_at`, `expires_at`, `user_aegis_id`, `agent_id`, `delegation_id`, `collar_id` — no secrets.
3. Verification recomputes the hash, verifies the EdDSA signature, cross-checks JWS payload fields, and checks expiry and revocation status.
4. `valid: true` means all of the above passed. It does NOT mean the agent has no out-of-band secrets.

### Liability framing

The passport makes the accountability boundary explicit:

- **Inside the boundary:** Any sensitive action that went through `request_skill_run`, user approval, the Aegis Playwright runtime, and received a signed receipt is provably Aegis-controlled. The receipt is the binding audit record.
- **Outside the boundary:** Actions the agent took without Aegis (direct browsing, API calls, any tool not routed through Aegis) are NOT covered. The passport cannot speak to those.

The passport is evidence of constrained, auditable authority — not a claim of perfect agent safety.

### What the passport does not contain

The passport contains no raw secrets, passwords, payment card numbers, secret_refs, ciphertext blobs, or private keys. Only aggregate counts, capability booleans, domains, and receipt IDs.

---

## Delegation Trust Profile v1

A machine-readable trust summary that answers: *Has this delegation proven safe Aegis-covered behavior for a specific task category?*

Trust is task-specific and evidence-based. Generic success counts are not trust signals. Low-risk browsing, weather queries, or Wikipedia searches do not improve trust for login, payment, or account-change categories.

### Trust is task-specific

Each profile is scoped to a single `task_category`. The same delegation may be `proven_limited` for `login` and `unproven` for `payment`. Evaluate per task.

### Evidence sources

| Signal | Weight |
|--------|--------|
| Fulfilled `ActionAuthorizationReceipt` for the category | Positive |
| Verified signed execution receipt linked to that authorization | Positive |
| Covered sensitive events (`runtime_coverage_summary.covered_events`) | Positive |
| Uncovered sensitive events | Negative — status → `caution` |
| Secret exposure events | Negative — status → `risky` |
| Missing capability (no credential, no payment method) | Gates — blocks `trusted_for_category` |

### Trust statuses

| Status | Meaning |
|--------|---------|
| `trusted_for_category` | ≥3 fulfilled authorizations, clean coverage, capability confirmed. V1: not reachable for payment categories. |
| `proven_limited` | ≥1 fulfilled authorization, clean coverage. Some positive history. |
| `capable_but_unproven` | Capability exists (e.g. vault credential present) but no Aegis-covered execution history yet. |
| `unproven` | No capability and no history for this category. |
| `caution` | Uncovered sensitive events detected in execution history — extra approval recommended. |
| `risky` | Secret exposure events detected — do not proceed with sensitive tasks. |
| `suspended` | Delegation is not active (revoked or expired). |

### Capability requirements per category (v1)

| Category | Required capability | Available in v1? |
|----------|--------------------|--------------------|
| `login`, `credential_fill` | Login credential in vault | Yes — if any `login_password` vault pass exists |
| `purchase`, `payment`, `travel_booking`, `financial_action` | Payment method | No — always `false` in v1 |
| `identity_disclosure` | Identity profile | No — always `false` in v1 |
| `account_change`, `destructive_action`, `message_send` | None | Yes |

### API

```
GET /api/delegation-trust/profile?delegation_id=delg_demo_001&task_category=login

Response: {
  "ok": true,
  "data": {
    "profile_id": "dtp_...",
    "generated_at": "2026-05-03T...",
    "delegation_id": "delg_demo_001",
    "user_aegis_id": "aegis_user_001",
    "agent_id": "claude-code-demo",
    "requested_task_category": "login",
    "trust_status": "proven_limited",
    "confidence": "medium",
    "capability_summary": {
      "login_credentials_available": true,
      "payment_method_available": false,
      "identity_profile_available": false,
      "credential_domains": ["localhost"],
      "capable_for_requested_task": true,
      "missing_capabilities": []
    },
    "coverage_summary": {
      "verified_execution_receipts": 1,
      "verified_authorizations": 1,
      "covered_sensitive_events": 2,
      "uncovered_sensitive_events": 0,
      "secret_exposure_events": 0,
      "aegis_playwright_executions": 1
    },
    "category_experience": {
      "category": "login",
      "fulfilled_authorizations": 1,
      "verified_execution_receipts": 1,
      "recent_successful_receipt_ids": ["rrreceipt_..."]
    },
    "disqualifying_signals": [],
    "machine_readable_reasons": [
      "delegation status: active",
      "1 fulfilled authorization(s) found for category 'login'",
      "1 verified execution receipt(s) linked to this delegation",
      "coverage clean: no uncovered sensitive events or secret exposures",
      "login credential available in vault"
    ],
    "limitations": {
      "not_a_guarantee": true,
      "out_of_band_secret_use_not_covered": true,
      "based_only_on_aegis_observed_events": true
    }
  }
}
```

Payment category example (always `unproven` in v1):
```
GET /api/delegation-trust/profile?delegation_id=delg_demo_001&task_category=payment

Response trust_status: "unproven"
capability_summary.payment_method_available: false
capable_for_requested_task: false
disqualifying_signals: ["payment_capability_unavailable_v1"]
```

### MCP tool

`get_delegation_trust_profile(delegation_id, task_category)` — returns the full trust profile with an `interpretation` field summarizing the result in plain English.

### Relationship to Delegation Passport and Website Handshake

- **Delegation Passport**: proves *what authority was granted* — capability attestations, collar limits, KMS custody model, and aggregate evidence counts. Created once per session.
- **Delegation Trust Profile**: proves *whether that authority was exercised safely* for a specific task category. Generated on demand, reflects current history.
- **Website Handshake (not yet implemented)**: a website will consume `passport_jws` from the Delegation Passport and optionally request a trust profile as part of accepting an agent session. Both inputs together establish both the delegation boundary and its execution history.

### Limitations

Every trust profile includes:
```json
{
  "not_a_guarantee": true,
  "out_of_band_secret_use_not_covered": true,
  "based_only_on_aegis_observed_events": true
}
```

The profile attests only to Aegis-observed behavior. It cannot detect out-of-band secret use or actions the agent took outside the Aegis controlled runtime.

---

## Website Trust Assertion / Handshake v1

A **Website Trust Assertion** is a compact, signed, machine-readable document a website can request before admitting an agent for a specific task. It synthesizes the Delegation Passport and Trust Profile into a single cryptographically signed recommendation without exposing secrets.

### What It Proves (and Does Not Prove)

A Website Trust Assertion attests to:
- The user, agent, and delegation identity
- The active trust status for the requested task category
- Capability availability (login credential, payment method)
- Aegis-covered execution history (verified receipts, fulfilled authorizations)
- The assertion was issued by Aegis and has not been tampered with

It does **not** prove:
- The agent has no out-of-band secrets
- The agent will behave safely in all circumstances
- The user or business has been KYC-verified
- The website domain has been independently verified (v1 uses `domain_observed`)

### Relation to Delegation Passport and Trust Profile

| Object | Purpose | Audience |
|---|---|---|
| **Delegation Passport** | What authority was granted — capability attestations, collar limits, KMS custody | Agent + API consumers |
| **Delegation Trust Profile** | Whether that authority was exercised safely for a task category — evidence-based | Agent + API consumers |
| **Website Trust Assertion** | Compact signed summary combining both — machine-readable recommendation for websites | Websites |

### API Endpoints

#### `POST /api/website-assertions` — Create an assertion

**Request body:**
```json
{
  "delegation_id": "delg_demo_001",
  "task_category": "login",
  "requesting_domain": "localhost",
  "requesting_origin": "http://localhost:3000",
  "passport_id": "pp_abc123",
  "human_readable_summary": "Agent wants to log in to localhost demo",
  "expires_in_minutes": 30
}
```

`delegation_id`, `task_category`, and `requesting_domain` are required. `passport_id`, `requesting_origin`, `human_readable_summary`, and `expires_in_minutes` are optional.

**Response (login, proven_limited history):**
```json
{
  "ok": true,
  "data": {
    "assertion_id": "wta_abc123def456",
    "issuer": "aegis.dev",
    "issued_at": "2026-05-03T12:00:00.000Z",
    "expires_at": "2026-05-03T12:30:00.000Z",
    "requesting_website": {
      "domain": "localhost",
      "verification_level": "dev_localhost"
    },
    "subject": {
      "user_aegis_id": "aid_user_001",
      "agent_id": "Demo Agent",
      "delegation_id": "delg_demo_001",
      "passport_id": "pp_abc123",
      "passport_hash": "..."
    },
    "requested_task": {
      "category": "login",
      "domain": "localhost"
    },
    "decision": {
      "recommendation": "allow_with_approval",
      "trust_status": "proven_limited",
      "confidence": "medium",
      "reasons": ["1 fulfilled authorization(s) found for category 'login'", "login credential available in vault"],
      "disqualifying_signals": []
    },
    "capability_summary": { "login_credentials_available": true, "payment_method_available": false, ... },
    "coverage_summary": { "verified_execution_receipts": 1, ... },
    "limitations": { "not_a_guarantee": true, "out_of_band_secret_use_not_covered": true, "based_only_on_aegis_observed_events": true },
    "verification": {
      "assertion_hash": "sha256hex...",
      "assertion_jws": "eyJhbGciOiJFZERTQS..."
    }
  }
}
```

**Response (payment, no payment capability):**
```json
{
  "decision": {
    "recommendation": "deny",
    "trust_status": "unproven",
    "confidence": "low",
    "disqualifying_signals": ["payment_capability_unavailable_v1"]
  }
}
```

#### `GET /api/website-assertions/:assertionId` — Retrieve an assertion

Returns the stored assertion by ID.

#### `GET /api/website-assertions/:assertionId/verify` — Verify an assertion

Recomputes the hash, verifies the EdDSA JWS signature, cross-checks payload fields, and checks expiry.

**Response:**
```json
{
  "ok": true,
  "data": {
    "valid": true,
    "hash_valid": true,
    "signature_valid": true,
    "expired": false,
    "assertion_hash": "...",
    "recomputed_hash": "...",
    "jws_payload": { "typ": "aegis.website_assertion.v1", "recommendation": "allow_with_approval", ... },
    "recommendation": "allow_with_approval",
    "trust_status": "proven_limited",
    "error": null
  }
}
```

### Verification Level

The `requesting_website.verification_level` field indicates how much the requesting domain has been verified:

| Value | Meaning |
|---|---|
| `dev_localhost` | Request came from `localhost` — development only |
| `domain_observed` | Domain is recorded but not independently verified (v1 default) |
| `domain_verified` | Domain ownership verified (not yet implemented) |
| `business_verified` | Business identity verified (not yet implemented) |

### Decision Rules

| Condition | Recommendation |
|---|---|
| Delegation inactive / trust_status suspended or risky | `deny` |
| trust_status caution | `step_up_required` |
| Payment category + no payment capability + unproven | `deny` |
| Payment category + no payment capability | `step_up_required` |
| trust_status trusted_for_category | `allow` |
| trust_status proven_limited | `allow_with_approval` |
| trust_status unproven or capable_but_unproven | `step_up_required` |

### MCP Tools

**`create_website_trust_assertion`**

```json
{
  "delegation_id": "delg_demo_001",
  "task_category": "login",
  "requesting_domain": "localhost",
  "human_readable_summary": "Agent wants to log in to the demo site"
}
```

Returns `assertion_id`, `decision`, `subject`, `requesting_website`, `verification.assertion_jws`, and a `next_action` hint.

**`verify_website_trust_assertion`**

```json
{ "assertion_id": "wta_abc123def456" }
```

Returns `valid`, `hash_valid`, `signature_valid`, `expired`, `jws_payload`, `recommendation`, `trust_status`, and an `interpretation` string.

### Security

- Response is aggregate only: no raw receipt JSON, no raw action authorization JSON, no `secret_ref`, no `devvault://` references, no private keys.
- Website assertions require real signing keys (`AEGIS_RECEIPT_JWS_PRIVATE_JWK`). If keys are unavailable, creation returns 500 `SIGNING_NOT_CONFIGURED`. There is no unsigned fallback.
- JWS payload contains only: assertion_id, hash, identity fields, task_category, recommendation, trust_status — never secrets.

### Limitations

Every assertion carries:
```json
{
  "not_a_guarantee": true,
  "out_of_band_secret_use_not_covered": true,
  "based_only_on_aegis_observed_events": true
}
```

Assertions expire (default 30 minutes). The verify endpoint checks expiry and returns `expired: true` if the assertion is stale.

---

## What This Is Not

- This is not a browser automation SDK. Agents do not receive a browser handle.
- This is not an agent builder. Aegis executes workflows that users have installed and authorized.
- This is not production-ready. Token management, key rotation, rate limiting, and multi-user auth are not implemented.
- Routes are not arbitrary executable scripts. They are declarative, inspectable, versioned workflow objects reviewed before publication.
- This is not a general browsing or web research layer. For non-sensitive reading, searching, and summarization, agents should use their own tools.
- This is not a credential custody or pass vault system. Demo Login uses fake seeded credentials for demo purposes only. Real credential injection is not implemented.
- Delegation Passports do not prove the agent has no out-of-band secrets. They prove only Aegis-covered delegation boundaries.
