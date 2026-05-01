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

The script will print a run ID and wait. Open `en.wikipedia.org` in Chrome, click the Aegis extension popup, and press **Start Run**. The script prints the final status and receipt when execution completes.

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
    Open en.wikipedia.org in Chrome, click the extension popup, press "Start Run".

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
