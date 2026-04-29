# AGENT_BRIDGE.md

How an outside agent calls Aegis today.

---

## 1. What Agent Bridge Means

Aegis is not the agent.

The outside agent decides what to do — browse a site, compare products, fill a form. Aegis owns the protected browser runtime and enforces collars at sensitive boundaries. Normal browsing passes through without interruption. Sensitive actions (purchases, logins, identity disclosure) are paused, blocked, or handed off to Aegis Runner before anything reaches the outside world.

Core lines:
- Outside agents plan. Aegis executes sensitive steps.
- Agents can browse. Aegis decides when they can commit.
- Agents are disposable. Trust is not.

---

## 2. Current Agent Flow

```
1. User creates an Aegis Pass (with an attached collar)
2. Outside agent receives the pass token
3. Agent calls POST /api/agent/create-session
4. Agent calls navigate / read-page / click / type through Aegis
5. Aegis allows safe browser actions immediately
6. Aegis detects a sensitive action → pauses the session
7. User sees the pending approval and approves or denies
8. On approve → Aegis Runner fills sensitive form fields from the vault
9. Agent receives a safe receipt — never raw secrets
10. Agent continues or closes the session
```

The agent never touches the vault. The agent never sees card numbers, passwords, CVVs, or identity documents. Receipts are the only artifact returned.

---

## 3. Agent Rules

The outside agent must:

- Use Aegis browser endpoints instead of raw browser access
- Never ask the user for passwords, card numbers, CVVs, addresses, or identity documents
- Stop and tell the user when Aegis returns `approval_required`
- Never attempt to bypass a `block` response
- Retry or continue only after Aegis returns a safe `allow` or `completed_by_runner` status
- Treat receipts as the source of truth for sensitive actions

---

## 4. Available Agent Endpoints

All requests are `POST`. All requests require `agent_pass_token` in the body.

---

### POST /api/agent/create-session

**Purpose:** Open a protected Playwright browser session under an Aegis Pass.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123",
  "purpose": "Buy running shoes on nike.com",
  "mode": "headless"
}
```

| Field | Required | Notes |
|---|---|---|
| `agent_pass_token` | yes | Token from the Aegis Pass |
| `purpose` | no | Human-readable reason for the session |
| `requested_collar_id` | no | Override the pass default collar |
| `mode` | no | `"headless"` (default) or `"visible"` |

**Success response:**

```json
{
  "ok": true,
  "data": {
    "session_id": "sess_xyz",
    "collar_id": "col_abc",
    "status": "active",
    "mode": "headless",
    "expires_at": "2026-04-26T14:00:00Z",
    "allowed_actions": ["browse", "read"],
    "approval_required_actions": ["purchase"],
    "blocked_actions": []
  }
}
```

---

### POST /api/agent/session/:sessionId/navigate

**Purpose:** Navigate the protected browser to a URL.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123",
  "url": "https://localhost:3001/checkout.html"
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "session_id": "sess_xyz",
    "current_url": "http://localhost:3001/checkout.html",
    "decision": "allow"
  }
}
```

Navigate always returns `allow` — URL navigation is not a sensitive action.

---

### POST /api/agent/session/:sessionId/read-page

**Purpose:** Return the page title and a text preview of the current page.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123"
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "session_id": "sess_xyz",
    "current_url": "http://localhost:3001/checkout.html",
    "title": "Checkout — Mock Store",
    "text_preview": "Place your order. Total: $99.99 ..."
  }
}
```

---

### POST /api/agent/session/:sessionId/click

**Purpose:** Click a browser element. Aegis inspects the element, detects if the action is sensitive, evaluates the collar, and either executes the click, pauses for approval, or blocks.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123",
  "target": {
    "type": "text",
    "value": "Place Order"
  }
}
```

`target.type` is `"text"` (match by visible text) or `"selector"` (CSS selector).

**Possible responses:**

Safe click — executed immediately:
```json
{
  "ok": true,
  "data": { "decision": "allow", "executed": true, "sensitive": false }
}
```

Sensitive click — collar allows:
```json
{
  "ok": true,
  "data": {
    "decision": "allow",
    "executed": true,
    "sensitive": true,
    "detected_action_type": "purchase",
    "risk_level": "medium",
    "reason": "Action is in allowed_actions for this collar.",
    "receipt_id": "rec_abc"
  }
}
```

Sensitive click — approval required:
```json
{
  "ok": true,
  "data": {
    "decision": "approval_required",
    "executed": false,
    "sensitive": true,
    "detected_action_type": "purchase",
    "risk_level": "high",
    "reason": "Action requires user approval.",
    "approval_request_id": "appr_xyz"
  }
}
```

Sensitive click — blocked:
```json
{
  "ok": true,
  "data": {
    "decision": "block",
    "executed": false,
    "sensitive": true,
    "detected_action_type": "purchase",
    "risk_level": "critical",
    "reason": "Action is blocked by collar policy.",
    "receipt_id": "rec_abc"
  }
}
```

---

### POST /api/agent/session/:sessionId/type

**Purpose:** Type a value into a browser input. Same enforcement logic as click — Aegis inspects the field before allowing.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123",
  "target": {
    "type": "selector",
    "value": "#email"
  },
  "value": "user@example.com"
}
```

Typed values are never stored in receipts.

**Possible responses:** Same shapes as `/click`.

---

### POST /api/agent/session/:sessionId/screenshot

**Purpose:** Return a base64-encoded PNG of the current page.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123"
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "session_id": "sess_xyz",
    "screenshot_base64": "iVBORw0KGgoAAAANSUhEUgAA..."
  }
}
```

---

### POST /api/agent/session/:sessionId/request-capability

**Purpose:** Explicitly ask Aegis whether a named action is permitted before attempting it. Useful when the agent wants to check collar policy without triggering a real browser action.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123",
  "action_type": "purchase",
  "domain": "nike.com",
  "context": {
    "summary": "Agent wants to place a $99 order on nike.com"
  }
}
```

**Possible responses:**

```json
{
  "ok": true,
  "data": {
    "decision": "allow",
    "reason": "purchase is in allowed_actions.",
    "risk_level": "medium",
    "receipt_id": "rec_abc"
  }
}
```

```json
{
  "ok": true,
  "data": {
    "decision": "approval_required",
    "reason": "purchase requires user approval under this collar.",
    "risk_level": "high",
    "approval_request_id": "appr_xyz"
  }
}
```

```json
{
  "ok": true,
  "data": {
    "decision": "block",
    "reason": "purchase is in blocked_actions.",
    "risk_level": "critical",
    "receipt_id": "rec_abc"
  }
}
```

---

### POST /api/agent/session/:sessionId/close

**Purpose:** Close the protected browser session and its Playwright context.

**Body:**

```json
{
  "agent_pass_token": "pass_abc123"
}
```

**Response:**

```json
{
  "ok": true,
  "data": { "session_id": "sess_xyz", "status": "closed" }
}
```

---

## 5. Response Semantics

| Value | Meaning | Agent should |
|---|---|---|
| `allow` | Action is safe and was executed | Continue |
| `approval_required` | Session is paused; user must decide | Stop and tell the user. Wait. Do not retry the action. |
| `block` | Collar policy blocked the action | Stop. Do not bypass. Inform the user. |
| `completed_by_runner` | Aegis Runner executed the sensitive step internally | Continue — receipt is the record |
| `sensitive_data_shared_with_agent: false` | Always false. Vault values are never returned. | Trust the receipt. Never ask for raw secrets. |

When `approval_required` is returned the session status changes to `waiting_for_approval`. The agent cannot send further capability requests until the user approves or denies. After approval, Aegis Runner executes the sensitive step and the session returns to `active`.

---

## 6. Copy-Paste Prompt for a Real Outside Agent

Paste this into the system prompt of Claude, ChatGPT, or any agent that will use Aegis:

```
You are acting through Aegis, a trust and control layer for browser automation.

Rules:
- Use only Aegis browser endpoints: create-session, navigate, read-page, click, type, screenshot, request-capability, close.
- Do not access the browser directly.
- Normal browsing (search, compare, read) is allowed without interruption.
- Sensitive actions (purchase, login, form submit, identity disclosure) go through Aegis enforcement.
- Never ask the user for passwords, card numbers, CVV, addresses, or identity documents. Aegis handles these.
- If Aegis returns { "decision": "approval_required" }: stop immediately, tell the user what action is pending, and wait. Do not retry the action.
- If Aegis returns { "decision": "block" }: stop. Do not attempt to bypass the block.
- After the user approves, Aegis Runner will execute the sensitive step. You will receive a receipt confirming the outcome.
- Treat receipts as the source of truth for sensitive actions.
- The agent_pass_token was provided to you at session start. Include it in every request body.
```

---

## 7. Current Limitations

- No MCP server yet — agent must call HTTP endpoints directly
- No real LLM integration — demo uses a simulated agent script
- Pass token is MVP only — no expiry rotation, no scoped permissions beyond the collar
- Mock vault only — fake card and address data; no real credentials anywhere
- Local mock store only — sensitive detection is tuned for `localhost:3001/checkout.html`
- No real payment — runner fills form fields but does not submit
- No real auth — all API requests are treated as the seeded demo user
- In-memory store — all sessions, passes, and receipts reset on API restart

---

## 8. Recommended Next Implementation

In order:

1. **`GET /api/agent/tools` manifest** — machine-readable list of available endpoints and their schemas, so agents can discover capabilities without reading this doc
2. **Agent Bridge UI page** — a `/agent-bridge` page in the web app showing this flow visually, with the copy-paste prompt and live endpoint examples
3. **MCP server wrapper** — wrap the 8 agent endpoints as MCP tools so Claude Desktop and other MCP clients can call them natively
4. **Connect a real outside agent** — point a real Claude or ChatGPT session at the MCP server and run the demo loop end-to-end
