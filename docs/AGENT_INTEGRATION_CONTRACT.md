# Aegis Agent Integration Contract v1

> **Status: Development / Demo Only.** This API runs on a local development server. It is not a production service. Token values, skill IDs, and run IDs shown here are demo fixtures.

---

## Purpose

Aegis lets third-party autonomous agents request trusted execution of user-installed skills without receiving raw credentials or direct browser-control privileges.

An agent holds a **Delegation Token** bound to a user's active delegation. It can discover the skills that delegation permits, request a run against an installed skill, poll until the run reaches a terminal state, and read the audit receipt. At no point does the agent receive a Playwright handle, a raw browser context, or any credential stored by the user.

---

## Agent Autonomy Model

Aegis is not the agent's general browsing or research layer. Agents remain fully autonomous above Aegis — using their own tools for reading pages, searching, summarizing, planning, and reasoning.

Aegis is invoked selectively when the agent needs:
- A **trusted installed workflow** (verified route) on a domain
- A **credentialed or approval-gated action** the user has pre-authorized
- An **auditable execution path** with a receipt

For non-sensitive reading, searching, or summarization, agents should use their own tools. Aegis governs trust-sensitive execution below the agent — it does not replace the agent's autonomy above it.

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
- Request a RouteRun against an installed skill (with variables)
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

### Step 2 — Request a RouteRun

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

## What This Is Not

- This is not a browser automation SDK. Agents do not receive a browser handle.
- This is not an agent builder. Aegis executes workflows that users have installed and authorized.
- This is not production-ready. Token management, key rotation, rate limiting, and multi-user auth are not implemented.
- Routes are not arbitrary executable scripts. They are declarative, inspectable, versioned workflow objects reviewed before publication.
- This is not a general browsing or web research layer. For non-sensitive reading, searching, and summarization, agents should use their own tools.
