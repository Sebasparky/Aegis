# Aegis MCP Server

A thin stdio MCP server that wraps the Aegis agent HTTP endpoints as MCP tools.

Outside agents (Claude Desktop, Claude Code, or any MCP client) can drive a
protected Aegis browser session without writing custom HTTP glue.

---

## What this does

Exposes 8 MCP tools that map 1:1 to the existing Aegis API endpoints:

| MCP Tool | Aegis Endpoint |
|---|---|
| `aegis_create_session` | `POST /api/agent/create-session` |
| `aegis_navigate` | `POST /api/agent/session/:id/navigate` |
| `aegis_read_page` | `POST /api/agent/session/:id/read-page` |
| `aegis_click` | `POST /api/agent/session/:id/click` |
| `aegis_type` | `POST /api/agent/session/:id/type` |
| `aegis_screenshot` | `POST /api/agent/session/:id/screenshot` |
| `aegis_request_capability` | `POST /api/agent/session/:id/request-capability` |
| `aegis_close_session` | `POST /api/agent/session/:id/close` |

All collar enforcement, policy decisions, and runner execution stay inside the
Aegis API. This server is a transparent HTTP proxy — it adds no logic.

---

## Prerequisites

- Node.js 18+ (native fetch required)
- Aegis API running on port 4000 (`npm run dev` from the repo root)
- A valid Aegis Pass token (create one on the dashboard)

---

## Install

```bash
cd apps/mcp-server
npm install
```

---

## Run (development)

```bash
npx tsx src/index.ts
```

The server reads from stdin and writes to stdout (stdio MCP transport).
It does not bind a network port.

---

## Run (production)

```bash
npm run build          # compiles TypeScript → dist/
node dist/index.js
```

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AEGIS_API_BASE_URL` | `http://localhost:4000` | Where the Aegis API is running |

---

## Claude Desktop config

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`
(Mac) or the equivalent on your OS:

**Built version:**
```json
{
  "mcpServers": {
    "aegis": {
      "command": "node",
      "args": ["/absolute/path/to/aegis/apps/mcp-server/dist/index.js"],
      "env": {
        "AEGIS_API_BASE_URL": "http://localhost:4000"
      }
    }
  }
}
```

**Development version (no build step):**
```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/aegis/apps/mcp-server/src/index.ts"],
      "env": {
        "AEGIS_API_BASE_URL": "http://localhost:4000"
      }
    }
  }
}
```

Replace `/absolute/path/to/aegis` with the actual path on your machine.

---

## Security warning — pass tokens

The `agent_pass_token` is the credential that authorizes actions inside a
protected session. In this MVP it is passed in plain text in the tool input.

- Never commit a real pass token to version control.
- Never share pass tokens in screenshots, logs, or chat.
- Treat a pass token like a password.

Production Aegis will add token rotation and scoped permissions. This MVP
uses static tokens seeded at API startup.

---

## Example tool flow

```
1. aegis_create_session
   → { session_id: "sess_abc", collar_id: "col_default", status: "active", ... }

2. aegis_navigate
   → { decision: "allow", current_url: "http://localhost:3001/checkout.html" }

3. aegis_read_page
   → { title: "Checkout — Mock Store", text_preview: "Place your order. Total: $99.99 ..." }

4. aegis_click  (target_type: "text", target_value: "Place Order")
   → "Approval required. Stop and wait for user approval. Do not retry or bypass."
     { decision: "approval_required", approval_request_id: "appr_xyz", ... }

5. ← STOP. Tell the user what is pending. Do not retry the click.

6. User approves on the Aegis dashboard (http://localhost:3000)

7. Aegis Runner fills the mock vault data internally.
   Agent receives a receipt — no card numbers, CVV, or passwords exposed.

8. aegis_close_session
   → { status: "closed" }
```

---

## Response semantics

| Aegis decision | MCP tool response |
|---|---|
| `allow` | JSON response only |
| `approval_required` | Prefixed: "Approval required. Stop and wait..." |
| `block` | Prefixed: "Blocked by collar policy. Do not bypass." |
| Receipt + runner | Prefixed: "Aegis Runner handled the sensitive step..." |

---

## Known limitations (MVP)

- Pass token is static and in plain text — no expiry rotation
- In-memory API — all sessions and passes reset on API restart
- Mock vault only — no real card numbers or credentials anywhere
- Mock store only — sensitive detection tuned for `localhost:3001/checkout.html`
- No real payment — runner fills form fields but does not submit
- No auth — all API requests are treated as the seeded demo user
- Screenshot tool returns base64 PNG — large responses may need truncation in some MCP clients
