# Antigen QA MCP Routing — Dev/QA Runbook

**Dev/QA only.** Nothing here changes production behavior, browser click/snapshot/navigation logic, approvals, receipts, scoring, credential policy, or checkout confirmation. It only ensures the agent's **browser tool calls are routed through the Antigen adapter** instead of raw Playwright.

> For the **full end-to-end manual browser QA recipe** (required env, API start, seeding,
> runtime-endpoint verification, the IKEA add-to-bag flow, expected markers, troubleshooting,
> and the next QA milestone), see [`antigen-browser-qa.md`](./antigen-browser-qa.md). This
> doc focuses on **MCP routing/config** — making sure the agent attaches to the Antigen
> adapter, not raw `@playwright/mcp`.

## The problem this fixes

Antigen's hard-mode browser logic (navigation discipline, `antigen_snapshot`, pointer-realism clicks, `browser_run_trace` disposition events) runs **inside the Antigen browser adapter** (`examples/antigen-browser-adapter.mjs`). The API-side flags below are necessary but **not sufficient on their own**:

```
ANTIGEN_BROWSER_TRACE=true
ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS=true
ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION=true
ANTIGEN_INPUT_REALISM=realistic
ANTIGEN_BROWSER_HEADLESS=false
ANTIGEN_POINTER_DEBUG_OVERLAY=true
ANTIGEN_CDP_DIAGNOSTICS=true
```

`browser_navigate`, `browser_snapshot`, `browser_click`, etc. are handled by **the MCP server process the agent attaches to**, not by `apps/api`. If the agent attaches to **raw `@playwright/mcp`**, it connects its own CDP session directly to the same Chrome and Antigen never sees the browser tool calls. Symptom: the run trace contains only `navigation_state` events and **zero** `browser_navigation_disposition`, `antigen_snapshot`, `browser_click`, `browser_type`, or `browser_scroll_to_ref` events; no `navigate_preflight` stderr lines; no pointer overlay.

### Root cause in this repo

`.mcp.json` registers raw Playwright directly:

```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222"] } } }
```

and `.claude/settings.json` pre-allowlists `mcp__playwright__browser_snapshot` and `mcp__playwright__browser_navigate`. Both let the agent bypass the Antigen adapter.

> ⚠️ **Do not enable raw `mcp__playwright__*` tools during Antigen QA hard mode.** A registered raw `playwright` server, or a pre-allowlisted `mcp__playwright__browser_navigate` / `browser_snapshot`, defeats Antigen routing even with every API-side flag set.

## Correct QA MCP config

Use the Antigen adapter as the browser surface. The adapter resolves the CDP endpoint dynamically at startup (calls `POST /api/agent/v1/runtime/browser-endpoint`) and spawns `@playwright/mcp` internally with the right `--cdp-endpoint` — **you do not pass a CDP port.**

A copy-pasteable sample lives at [`examples/mcp/antigen-qa.mcp.json`](../../examples/mcp/antigen-qa.mcp.json):

```json
{
  "mcpServers": {
    "antigen": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/examples/aegis-tool-server.mjs"],
      "env": {
        "AEGIS_API_BASE": "http://localhost:4000",
        "AEGIS_AGENT_TOKEN": "<delegation-token>"
      }
    },
    "antigen-browser": {
      "command": "<ABSOLUTE_PATH_TO_REPO>/scripts/run-antigen-browser-adapter-qa.sh",
      "args": []
    }
  }
}
```

The wrapper script is the **canonical source of the QA env vars** — it exports every QA flag (plus `ANTIGEN_ADAPTER_REQUIRE_QA_ENV=true`), so the adapter can never be launched with a partial env — and it is convenient for terminal/manual runs.

> **macOS / Claude local MCP caveat.** Pointing the `antigen-browser` server's `command`
> directly at the `.sh` wrapper can fail under Claude's local MCP launcher with
> **"Operation not permitted."** In that case, use the **inline form** that runs the
> wrapper's exact exports through `/bin/bash -lc … exec node …adapter.mjs` (see
> [`antigen-browser-qa.md` → Launching the adapter](./antigen-browser-qa.md#4-launching-the-adapter-macos--claude-local-mcp)).
> A direct-node launch (`"command": "node", "args": [".../examples/antigen-browser-adapter.mjs"], "env": { ...all QA flags... }`) is also supported. The choice of launch shape (wrapper vs. inline-bash vs. direct-node) does not matter — **what matters is that the adapter starts with all required QA env present and the fail-closed guard on.** If anything is missing the adapter **fails closed** (see below).

### Adapter env reference

| Var | Required | Purpose |
|---|---|---|
| `AEGIS_API_BASE` | ✅ | API base, e.g. `http://localhost:4000`. Adapter exits if unset. |
| `AEGIS_AGENT_TOKEN` | ✅ | Delegation token from connector setup. Adapter exits if unset. |
| `ANTIGEN_BROWSER_HEADLESS` | QA | `false` to run visible and enable realistic-input interception. |
| `ANTIGEN_INPUT_REALISM` | QA | `realistic` to enable per-char typing / pointer realism. `fast`/`disabled`/`false` disables interception. |
| `ANTIGEN_BROWSER_TRACE` | QA | `true` so the adapter POSTs `tool_disposition` / `navigation_disposition` events to the run trace. |
| `ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS` | QA | `true` = hard mode: Antigen-owned actions fail loudly instead of falling through to the child; raw `browser_snapshot` is blocked. |
| `ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION` | QA | `true` = navigation-discipline hard mode (no shortcut deeplinks around visible refs). |
| `ANTIGEN_ADAPTER_REQUIRE_QA_ENV` | guard | Default **on**. When on, the adapter **fails closed** (FATAL, exit 1) before serving tools if any required QA flag is missing. Set to `false` only for non-QA / local weak-mode use. |

> The CDP endpoint is **not** an adapter env var — it is resolved at runtime. `ANTIGEN_POINTER_DEBUG_OVERLAY` and `ANTIGEN_CDP_DIAGNOSTICS` are **API-side** flags (set them on the `npm run dev` / API process), not adapter env.

### Fail-closed startup guard

The validation command and config files cannot see Claude's **live** MCP launch — Claude may run a cached, app-level command (`node examples/antigen-browser-adapter.mjs`) with none of the QA flags. To make that impossible to miss, the adapter **fails closed**: when `ANTIGEN_ADAPTER_REQUIRE_QA_ENV` is unset or any value other than `false`, it validates the required QA env at startup and, if anything is missing, writes a `FATAL` block to stderr and exits **before serving any tools** — so the agent can never report "tools loaded" on a weak adapter.

```
[antigen-browser@<VERSION>] FATAL: Antigen QA adapter launched without required QA env.
[antigen-browser@<VERSION>] Missing/invalid: ANTIGEN_BROWSER_TRACE, ANTIGEN_INPUT_REALISM, ...
[antigen-browser@<VERSION>] This usually means Claude is launching a cached DIRECT command:
[antigen-browser@<VERSION>]   node examples/antigen-browser-adapter.mjs
[antigen-browser@<VERSION>] instead of the QA wrapper:
[antigen-browser@<VERSION>]   scripts/run-antigen-browser-adapter-qa.sh
[antigen-browser@<VERSION>] Set ANTIGEN_ADAPTER_REQUIRE_QA_ENV=false to allow weak/default mode (non-QA only).
```

The wrapper at `scripts/run-antigen-browser-adapter-qa.sh` is the canonical source of every QA flag and the guard var. On macOS, if Claude's MCP launcher cannot execute the wrapper directly ("Operation not permitted"), inline the wrapper's exports via `/bin/bash -lc … exec node …adapter.mjs` instead (see [`antigen-browser-qa.md`](./antigen-browser-qa.md)). The direct-node form also works but must carry the full env block. Any launch shape is fine **as long as the full QA env is present** — otherwise the guard will FATAL. `ANTIGEN_BROWSER_HEADLESS` not being `false` is a warning, not a FATAL.

## Validation command

Catch the misconfiguration before you waste a QA run:

```sh
npm run qa:validate-mcp
# or, against specific files:
node scripts/validate-antigen-qa-mcp.mjs --mcp ./.mcp.json --settings ./.claude/settings.json
```

- **PASS** (exit 0): the Antigen adapter server is configured and no raw `@playwright/mcp` server / `mcp__playwright__*` allowlist entry is present.
- **FAIL** (exit 1): a raw `playwright` server is registered directly, or `mcp__playwright__browser_navigate` / `browser_snapshot` (or a `mcp__playwright__*` wildcard) is pre-allowlisted, or no adapter server is configured.

It is read-only and dev-only — it never edits your config.

## Manual QA runbook (Reddit → IKEA cart)

1. **Start the API with hard-mode env** (API-side flags include the pointer overlay and CDP diagnostics):
   ```sh
   ANTIGEN_BROWSER_TRACE=true \
   ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS=true \
   ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION=true \
   ANTIGEN_INPUT_REALISM=realistic \
   ANTIGEN_BROWSER_HEADLESS=false \
   ANTIGEN_POINTER_DEBUG_OVERLAY=true \
   ANTIGEN_CDP_DIAGNOSTICS=true \
   npm run dev
   ```
2. **Configure the agent to use the Antigen adapter MCP, not raw Playwright.** Apply the config from `examples/mcp/antigen-qa.mcp.json` — point `antigen-browser` at `scripts/run-antigen-browser-adapter-qa.sh` (substitute the absolute repo path; the wrapper carries the QA env, so no env block is needed). **On macOS**, if the wrapper cannot be executed directly by Claude's MCP launcher, use the inline `/bin/bash -lc … exec node …adapter.mjs` form instead — same exports (see [`antigen-browser-qa.md`](./antigen-browser-qa.md)). Ensure no raw `playwright` server is registered and no `mcp__playwright__*` tools are pre-allowlisted.
3. **Validate:** `npm run qa:validate-mcp` → must print `RESULT: ✅ PASS`.
4. **Restart the agent's MCP session** so it re-reads the MCP config and re-attaches to the adapter (config changes are not picked up live).
5. **Confirm the adapter is the surface — and that it did NOT fail closed.** In the `antigen-browser` MCP server's stderr you must see, at startup:
   - `ANTIGEN BROWSER ADAPTER ACTIVE — this is the Antigen adapter, NOT raw @playwright/mcp.`
   - `qa_flags require_realistic_navigation=true require_antigen_tools=true browser_trace=true`
   - and, on the first browser tool call, `navigate_preflight` lines.
   If instead you see the **`FATAL: Antigen QA adapter launched without required QA env`** block, Claude is launching a **cached direct command** with no QA env — point the MCP config at the wrapper script (or a full-env direct command) and restart the session. If you see neither the banner nor the FATAL block, the agent is on raw Playwright — fix the config and restart.
6. **Run the prompt:** drive the agent through the Reddit → IKEA cart task.
7. **Confirm the trace is no longer `navigation_state`-only.** Read the run trace (`GET /api/internal/browser-run-trace/<browser_runtime_id>`) and confirm it now contains `browser_navigation_disposition`, `antigen_snapshot`, `browser_click`, and `pointer_dispatch: true` events — not just `navigation_state`.

## Non-goals / guardrails

- Does **not** change browser click/snapshot/navigation behavior, approvals, receipts, scoring, credential policy, login/payment handling, or final checkout confirmation.
- Does **not** remove raw Playwright from the repo globally — `@playwright/mcp` is still spawned *internally* by the adapter.
- Does **not** edit your local `.mcp.json` or `.claude/settings.json` — apply the sample config yourself.
