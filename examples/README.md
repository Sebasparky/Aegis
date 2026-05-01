# Aegis External Agent Examples

These examples show how a third-party agent integrates with Aegis using only public HTTP APIs. No internal Aegis modules are imported. Copy any example and run it from outside the monorepo.

## `external-agent-http-client.mjs`

A complete agent client: discovers installed skills, requests a RouteRun, waits for the Aegis extension (and optionally the approval UI) to drive execution, then reads the audit receipt.

### Prerequisites

- Node.js 18+ (uses built-in `fetch`)
- Aegis API running: `npm run dev` from the repo root (API on port 4000, web on port 3000)
- Aegis Chrome extension installed and logged in

### Setup

**1. Seed demo data:**
```sh
npm run seed:demo
```

**2. Install the Wikipedia Search skill:**
```sh
curl -X POST http://localhost:4000/api/skills/skill_demo_wikipedia_001/install \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Run

```sh
node examples/external-agent-http-client.mjs
```

The script prints a run ID and waits. Execution is driven by the Aegis Chrome extension:

- **With background auto-run enabled (recommended):** ensure `en.wikipedia.org` is your active tab and the auto-run toggle is on in the extension popup. The run executes automatically without further interaction.
- **Manually:** open `en.wikipedia.org` in Chrome, click the Aegis extension popup, and press **Start Run**.

The script prints the final status and receipt once the run reaches a terminal state. `completed` means the browser outcome was verified — the tab landed on the correct Wikipedia article or search results page.

### Expected output (happy path)

```
=== Aegis External Agent HTTP Client (HTTP-only, no internal imports) ===

[1] Authenticating via delegation token (pass_demo_001)
[2] Discovering installed skills for "en.wikipedia.org"...
[3] Selected skill: Wikipedia Search (skill_demo_wikipedia_001)

[4] Requesting RouteRun  variables: { query: "Michigan" }
[5] Run created:
    Run ID:     run_...
    Status:     pending
    Domain:     en.wikipedia.org
    Delegation: del_... | Collar: col_...

[6] Waiting for Aegis-controlled execution.
    With auto-run enabled: activate the en.wikipedia.org tab — the run starts automatically.
    Without auto-run: open en.wikipedia.org in Chrome, click the extension popup, press "Start Run".

[7] Polling for completion (timeout: 60s, interval: 3s)...
    [8s] Status: running
    [12s] Status: completed ✓

[8] Receipt:
    Receipt ID:       rct_...
    allowed_reason:   collar_allowed
    route_trust_tier: aegis_scanned

=== Done: completed ===
```

### Restricted token (skill-access denied)

```sh
AEGIS_AGENT_TOKEN=pass_demo_002 node examples/external-agent-http-client.mjs
```

`pass_demo_002` maps to a delegation with an empty `only` skill-access list. The script exits with an error immediately after skill discovery.

### Override variables

```sh
AEGIS_QUERY="Alan Turing" AEGIS_TIMEOUT_MS=120000 node examples/external-agent-http-client.mjs
```

| Variable | Default | Description |
|---|---|---|
| `AEGIS_API_BASE` | `http://localhost:4000` | API base URL |
| `AEGIS_AGENT_TOKEN` | `pass_demo_001` | Bearer delegation token |
| `AEGIS_DOMAIN` | `en.wikipedia.org` | Target domain |
| `AEGIS_SKILL_ID` | _(first skill found)_ | Pin a specific skill ID |
| `AEGIS_QUERY` | `Michigan` | Route variable: search query |
| `AEGIS_TIMEOUT_MS` | `60000` | Poll timeout (ms) |
| `AEGIS_POLL_INTERVAL_MS` | `3000` | Poll interval (ms) |

### Approval-gated run

If the collar requires approval for a permission used by the skill, the script prints the approval URL and keeps polling. Open `http://localhost:3000/route-run-approvals`, approve the run, then trigger extension execution as normal.

---

## `aegis-tool-server.mjs` — MCP Tool Server

An MCP stdio server that wraps Aegis skill execution as standard tools. Connect any MCP-compatible agent runtime (Claude Desktop, Claude Code, or any MCP client) and it can discover and invoke Aegis capabilities without Aegis-specific client code baked in.

The agent receives tools from the environment. It does not need to know about Aegis. Aegis remains the trust and execution layer beneath.

**Agent autonomy model:** Agents should use their own browsing, reading, searching, and reasoning tools for normal tasks. Aegis tools are invoked selectively — only when the agent needs a trusted installed workflow, a credentialed or approval-gated action, or an auditable execution receipt. Aegis does not replace the agent's general tools.

**Execution mode:** Each skill returned by `discover_installed_skills` includes `execution_mode` and `sensitivity_level`. If `execution_mode` is `"agent_runnable"`, Aegis has a verified route recipe the agent can fetch with `get_agent_runnable_workflow(skill_id)` and execute in its own browser session — no extension handoff, no RouteRun, agent stays in control. If `execution_mode` is `"aegis_controlled"`, the workflow is sensitive (credentials, payments, personal data, form submission, account changes) and the agent must call `request_skill_run` — Aegis takes execution custody and produces an audit receipt.

**Validated execution paths (2026-05-01):**
- `agent_runnable` path: Claude Code discovered Wikipedia Search, fetched the recipe via `get_agent_runnable_workflow`, executed it via Playwright in its own browser session. No RouteRun or extension handoff.
- `aegis_controlled` path: Claude Code encountered Demo Login (`execution_mode: "aegis_controlled"`), correctly received `NOT_AGENT_RUNNABLE` on recipe fetch, used `request_skill_run`, waited for user approval in `/route-run-approvals`, and received receipt `rrreceipt_d5614360e907` after the extension auto-ran the approved run at `/demo-login`.

### How it works

1. Agent runtime connects to the server via stdio
2. Agent calls `discover_installed_skills` to find what Aegis can do on a domain
3. Agent calls `request_skill_run` to ask Aegis to execute a workflow
4. Agent polls `get_route_run_status` until the run reaches a terminal state
5. Agent calls `get_route_run_receipt` to read the audit record

Execution is always controlled by Aegis — the agent never receives a browser handle or raw capability.

### Prerequisites

Same as `external-agent-http-client.mjs` above. No additional dependencies — `@modelcontextprotocol/sdk` is already installed in the monorepo.

### Run

```sh
node examples/aegis-tool-server.mjs
```

This is a **stdio server** — it does not listen on a port. Connect it via your agent runtime's MCP configuration.

### Claude Desktop configuration

```json
{
  "mcpServers": {
    "aegis": {
      "command": "node",
      "args": ["examples/aegis-tool-server.mjs"],
      "cwd": "/path/to/aegis",
      "env": {
        "AEGIS_AGENT_TOKEN": "pass_demo_001"
      }
    }
  }
}
```

### Claude Code configuration

```sh
claude mcp add aegis -- node /path/to/aegis/examples/aegis-tool-server.mjs
```

### Tools exposed

| Tool | Description |
|---|---|
| `discover_installed_skills` | Find skills available to this agent on a domain; includes `execution_mode` |
| `get_agent_runnable_workflow` | Fetch the route recipe for an `agent_runnable` skill to execute in your own browser; returns `NOT_AGENT_RUNNABLE` if the skill is `aegis_controlled` — call `request_skill_run` instead |
| `request_skill_run` | Ask Aegis to execute an `aegis_controlled` workflow (extension handoff) |
| `get_route_run_status` | Poll run status until terminal |
| `get_route_run_receipt` | Read the audit record after completion |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AEGIS_API_BASE` | `http://localhost:4000` | API base URL |
| `AEGIS_AGENT_TOKEN` | `pass_demo_001` | Bearer delegation token |

### Limitations

- Local and prototype-only. Not production-ready.
- Calls only public Aegis HTTP APIs. Does not import internal Aegis modules.
- Does not execute browser actions. Execution is driven by the Aegis Chrome extension after a run is requested — automatically via background auto-run (when enabled and conditions are met) or manually via the popup Start Run button.
- The user or agent must still navigate to or activate the matching domain tab in the current prototype.
- `get_agent_runnable_workflow` returns `NOT_AGENT_RUNNABLE` for `aegis_controlled` skills — the agent must call `request_skill_run` for those workflows, not attempt browser execution directly.
- Route context matching for `aegis_controlled` runs uses domain + optional `url_match`. The extension will not execute a controlled run on the wrong page (e.g., a run scoped to `/demo-login` will not fire on `/route-run-approvals`).
- Demo Login uses fake seeded credentials for demo purposes. Real credential custody is not implemented.
