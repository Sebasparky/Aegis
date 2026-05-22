# LOCAL_RUNTIME_BROWSER_ENDPOINT.md

## Purpose

This document defines the architecture direction for how Aegis manages local browser runtimes for agent-driven tasks. It establishes which surface is primary, which is fallback, and where the boundary between agent control and Aegis control must lie.

Read this document before working on: `taskBrowserSessions`, `taskBrowserControl`, `agent-connectors`, `aegis-tool-server.mjs`, secret injection, or any feature that touches how agents acquire or use a browser.

## Canonical One-Liner

**Aegis provisions the trusted local browser runtime; the agent drives; Aegis handles sensitive handoffs.**

---

## The Core Distinction

Aegis has two possible postures toward browser automation. Only one is correct as the default.

**Wrong default — Aegis as browser controller:**
> The agent calls Aegis for navigate, observe, click, scroll, and page reading. Aegis is the browser automation layer.

This inverts the trust model. Aegis becomes a thin wrapper around Playwright rather than a trust layer. It bloats Aegis's attack surface, duplicates what agent tooling already does well, and pushes agents to depend on Aegis for every page interaction rather than only for sensitive handoffs.

**Correct default — Aegis as trusted runtime provisioner:**
> Aegis starts or reuses an isolated local Chromium instance for a connected agent. The agent's own browser tooling (e.g., Playwright MCP, Claude Code's `@playwright/mcp`) attaches to that browser through CDP or an adapter. The agent navigates, reads, clicks, scrolls, and summarizes normally. Aegis intervenes only at sensitive boundaries.

This is the architecture direction. Every new browser-related feature must be evaluated against this boundary.

---

## The Three Browser Modes

Three distinct modes exist. They have separate roles and must not be mixed or blurred.

| Mode | Name | Status | Who controls browsing | When to use |
|---|---|---|---|---|
| **Primary** | Local Runtime Browser Endpoint | Target architecture | Agent's own tooling | Agent needs a dedicated, isolated, Aegis-provisioned browser |
| **Fallback** | Controlled Browser Bridge | Compatibility mode — do not expand | Aegis navigate/observe/click tools | Agent cannot attach its own browser tooling |
| **Advanced** | External Browser Handoff | Supported for advanced agents | Agent's own tooling (pre-existing) | Agent already owns a browser; passes `external_cdp_url` for injections only |

### Mode 1: Local Runtime Browser Endpoint (Primary)

Aegis provisions an isolated ephemeral Chromium instance scoped to the agent's current delegation. The agent receives a browser endpoint (`cdp_url` or adapter config) through its connector setup or via `get_runtime_browser_endpoint`. The agent's own browser tooling attaches and drives the session.

Aegis's role in this mode:
- Launch and lifecycle-manage the Chrome process (ephemeral profile, no-save policy, port conflict resolution)
- Return the endpoint securely to the agent's tooling
- Monitor for sensitive action signals
- Own sensitive handoffs: credential injection, payment field fill, approval gates, receipts
- Revoke the session if the delegation collar is violated

The agent's role:
- Navigation, clicking, reading page content, form filling (non-sensitive), scrolling, summarization
- Deciding when the task is complete and closing the session

**Why this is primary:** The agent's own browser tooling is more capable and context-aware than Aegis's navigate/observe/click bridge. Routing all browsing through Aegis creates unnecessary latency, tool call overhead, and design pressure to expand Aegis's automation surface. Aegis's value is the trust layer, not the automation layer.

Existing implementation foundation: Task Browser Lifecycle v1, Ephemeral Agent Browser Session + No-Save Policy v1, Agent-Browser Secret Injection v1.

### Mode 2: Controlled Browser Bridge (Fallback — Compatibility Mode)

Aegis exposes navigate, observe, and click tools. The agent uses these tools when it cannot attach its own browser tooling. This mode exists for compatibility with agents that have no native browser capabilities.

**This mode must not be expanded into the primary browser automation product.** Do not add new browsing capabilities (scroll, form fill, page summarization, element inspection, screenshot analysis) to this surface unless a specific compatibility requirement demands it. Do not position this surface as the recommended integration path for new agents.

Existing tools in this mode are retained as-is and labelled "compatibility mode" in documentation and connector setup guidance.

### Mode 3: External Browser Handoff (Advanced)

The agent already owns and controls a browser session (e.g., Claude Code using `@playwright/mcp`). The agent passes `external_cdp_url` to Aegis when a sensitive handoff is needed. Aegis connects to the existing browser via CDP, performs the injection or sensitive action, then disconnects. The agent retains full browser control before and after the handoff.

This mode is already implemented for `request_secret_field_injection`. Do not close or navigate the external browser — Aegis's CDP connection is for injection only.

---

## Ownership Boundary

The boundary between agent-owned and Aegis-owned must be enforced in code, in tools, and in documentation. When in doubt, err toward Aegis-owned for sensitive fields and agent-owned for everything else.

| Action | Owner | Notes |
|---|---|---|
| Navigation (goto, back, forward) | Agent | Agent's browser tooling |
| Page reading / DOM observation | Agent | Agent's browser tooling |
| Clicking non-sensitive elements | Agent | Agent's browser tooling |
| Scrolling | Agent | Agent's browser tooling |
| Form filling — non-sensitive fields | Agent | Agent's browser tooling |
| Credential field fill (username, password) | **Aegis** | CDP injection via KMS-resolved secret |
| Payment / card field fill | **Aegis** | CDP injection, approval-gated |
| Sensitive action approval (purchase, delete, submit) | **Aegis** | Approval gate + receipt |
| Account change confirmation | **Aegis** | Approval gate + receipt |
| Challenge code injection (2FA, email code) | **Aegis** | Challenge relay, CDP inject |
| Secret release / capability gate | **Aegis** | Capability release gate |
| Browser session lifecycle (launch, close) | **Aegis** | Ephemeral profile, no-save policy |
| Audit receipts | **Aegis** | Signed, append-only |

---

## Desired UX

The user should not think about browser sessions. The correct UX sequence:

1. User connects an agent (installs connector, sets delegation collar).
2. Aegis automatically prepares the local runtime — no "Start browser" button required.
3. Agent receives the runtime endpoint through its connector config or `get_runtime_browser_endpoint`.
4. Agent runs the task. User sees nothing unless intervention is needed.
5. User only sees:
   - Runtime connected / healthy status indicator
   - Approval prompts (credential injection, payment, sensitive action)
   - Challenge / recovery cards (2FA, account verification)
   - Receipts after sensitive actions complete
   - Failure cards with clear next actions if something goes wrong

Requiring the user to manually click "Start local browser," copy a CDP URL, or manage port conflicts is an implementation detail leaking into the product. Those mechanics must be hidden behind `get_runtime_browser_endpoint` and the connector setup flow.

---

## API and Tool Direction

### New: `get_runtime_browser_endpoint`

This is the missing primitive that makes Local Runtime Browser Endpoint the default path.

```
get_runtime_browser_endpoint(delegation_id)
→ {
    browser_runtime_id: string,
    cdp_url: string,         // for direct CDP attachment
    adapter_config?: object, // for Playwright MCP or similar
    status: "ready" | "starting" | "unavailable",
    ephemeral: true,
    port_auto_selected?: boolean
  }
```

Behavior:
- If a ready runtime already exists for this delegation, return it (reuse, do not launch duplicate).
- If no runtime exists, launch one (ephemeral profile, no-save policy, port conflict resolution per Task Browser Lifecycle v1 rules).
- Never return `user_data_dir`, PIDs, or process handles.
- `browser_runtime_id` is the stable reference for subsequent injection and approval calls.

This tool replaces the workflow where agents call `start_task_browser_session` manually. Agents that call `get_runtime_browser_endpoint` should not need to call `start_task_browser_session` separately.

### Updated: `request_secret_field_injection`

Already implemented. Evolution required:

- Accept `browser_runtime_id` (from `get_runtime_browser_endpoint`) as an alternative to `external_cdp_url` and legacy `browser_session_id`.
- Internal resolution: `browser_runtime_id` → `cdp_url` via runtime registry (same mechanism as `taskBrowserSessions`).
- Do not change existing `browser_session_id` path — that remains valid for compatibility.

### Existing task browser tools — label as compatibility

`start_task_browser_session`, `get_task_browser_session`, `close_task_browser_session` in `aegis-tool-server.mjs` are retained. They are the implementation layer underneath `get_runtime_browser_endpoint`. In documentation and connector guidance, label them:

> These tools are the implementation layer for the Local Runtime Browser Endpoint. Use `get_runtime_browser_endpoint` unless you need low-level session lifecycle control.

### Existing controlled browser bridge tools — label as fallback

Navigate, observe, click tools in `aegis-tool-server.mjs` and `taskBrowserControl` are retained as-is. In documentation and connector guidance, label them:

> Compatibility mode. Use these tools only if your agent cannot attach its own browser tooling. Do not use these as the primary browsing path for agents that have native browser capabilities.

### Connector MCP Config Shape

The Aegis connector returns **two MCP server entries**. Both are required for the full Local Runtime Browser Endpoint experience on platforms that support local MCP processes (Claude Desktop, Cursor, Claude Code):

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
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/examples/antigen-browser-adapter.mjs"],
      "env": {
        "AEGIS_API_BASE": "http://localhost:4000",
        "AEGIS_AGENT_TOKEN": "<delegation-token>"
      }
    }
  }
}
```

**`antigen`** — Trust tools. Credential injection, approvals, sensitive action gates, receipts, vault passes, runtime guardrails. All Aegis-owned operations go through this server.

**`antigen-browser`** — Browser adapter. At startup, `antigen-browser-adapter.mjs` calls `POST /api/agent/v1/runtime/browser-endpoint` to get the real CDP endpoint, then spawns `@playwright/mcp --cdp-endpoint <cdp_url>`. The agent uses this server for all ordinary browsing — navigation, reading, clicking, scrolling. Aegis does not see or control these operations.

**Port handling.** The adapter resolves the CDP port dynamically at startup. If Chrome launches on an alternate port (`port_auto_selected=true`), the adapter picks up the correct URL automatically — no config editing or platform restart is required.

**Platforms without local process support** (e.g., Claude in Chrome extension) receive the `antigen` MCP config only and use the Controlled Browser Bridge compatibility tools (`navigate_task_browser_session`, `observe_task_browser_session`, `click_element_in_task_browser_session`).

**CDP coexistence.** `@playwright/mcp` holds one CDP connection for agent browsing. When Aegis needs to inject a credential, it opens a second raw CDP WebSocket connection to the same Chrome instance. The two connections coexist without conflict. After injection, Aegis disconnects (`browser.disconnect()`, not `browser.close()`) — the agent's MCP session and all open tabs are preserved.

---

## Security Model

These constraints apply in all three browser modes.

**Secrets never reach the agent.** Raw passwords, card numbers, CVV, auth tokens, cookies, `secret_ref` values, KMS material, and `storageState` must never appear in tool responses, API responses, logs, or Playwright page content visible to the agent. CDP injection is the only path to the field — the agent never sees the resolved value.

**Aegis temporarily masks agent observation during sensitive handoff.** When Aegis is filling a credential or payment field via CDP, the agent must not be able to read back the injected value. Observation mode must not weaken this constraint.

**Sensitive handoff requires explicit approval.** Password injection always requires user approval. Payment/card injection always requires approval. Approval is one-time, same-domain, short-lived (5 min TTL), single-field-per-authorization.

**Agent regains full control after handoff.** Once the sensitive CDP operation is complete, the agent's browser tooling resumes normal operation. Aegis disconnects from CDP. The Aegis CDP connection uses `browser.disconnect()`, not `browser.close()` — the agent's session and tabs are preserved.

**Receipts are required for all sensitive handoffs.** Every credential fill, payment action, approval grant, and violation must produce a signed, append-only receipt. No sensitive action completes without a receipt entry.

**Ephemeral profiles enforce the no-save policy.** Chrome is launched with `--disable-save-password-bubble --password-store=basic --disable-sync --no-first-run --disable-default-apps`. `persistence_allowed: false`, `browser_storage_allowed: false`, `website_save_allowed: false` are TypeScript literal `false` values on `CredentialUseAuthorization` — these are not configurable at runtime.

---

## Anti-Goals

These are explicit non-directions. Do not build these.

- **Do not make Aegis the default page reader.** Agents have browser tooling. Routing all page reads through Aegis is unnecessary overhead.
- **Do not build a full browser automation competitor as the main path.** Aegis is a trust layer, not a browser automation product.
- **Do not require users to manage browser sessions manually.** No "Start browser" buttons. No CDP URL copying. No port selection.
- **Do not expose cookies, localStorage, passwords, card numbers, CVV, tokens, or raw vault values** in any tool response, API response, log, or observation snapshot.
- **Do not broaden collars to restrict normal browsing unnecessarily.** Collars govern sensitive actions. Agent-owned browsing of non-sensitive pages is not a sensitive action.
- **Do not expand the Controlled Browser Bridge** unless an explicit compatibility requirement demands it. It exists for agents with no browser tooling; it is not the product direction.
- **Do not add Playwright handles, CDP connections, or `storageState` to agent-facing responses** under any circumstances.
- **Do not require agents to call both `start_task_browser_session` and `get_runtime_browser_endpoint`.** One call should be enough.

---

## Roadmap

### Increment 1 — This Document (complete)

Define the three browser modes, the ownership boundary, and the target UX. No code changes.

### Increment 2 — Audit Current Code Against This Document

Review the following against the ownership boundary table and mode definitions:

- `apps/api/src/runtime/taskBrowserSessions.ts` — confirm no raw value exposure, PIDs private
- `apps/api/src/routes/task-browser-sessions.ts` — confirm HTTP routes are implementation-layer only
- `taskBrowserControl` — confirm labelled as compatibility mode in docs and tool descriptions
- `examples/aegis-tool-server.mjs` — update tool descriptions to reflect mode labels
- `apps/api/src/routes/agent-connectors.ts` — verify connector setup does not push agents toward Controlled Browser Bridge as primary path
- External `cdp_url` support in `request_secret_field_injection` — confirm `browser.disconnect()` is used, not `browser.close()`

Produce findings. Do not change code unless a clear invariant violation is found.

### Increment 3 — Implement `get_runtime_browser_endpoint`

New MCP tool and backing endpoint:

- `POST /api/agent/v1/runtime/browser-endpoint` — auto-create or reuse a task browser session for the requesting delegation
- Returns `browser_runtime_id`, `cdp_url`, `adapter_config`, `status`, `ephemeral: true`
- Reuse logic: existing ready session on correct port → reuse; stale → recycle; conflict → port_auto_selected path (same as Task Browser Lifecycle v1 Case B/C)
- Mark sessions created via this path as `runtime_mode: "local_runtime_endpoint"` for UI and audit distinction
- Expose as `get_runtime_browser_endpoint` in `aegis-tool-server.mjs`
- `request_secret_field_injection` accepts `browser_runtime_id` as an alternative to `browser_session_id` / `external_cdp_url`

### Increment 4 — Update Connector Setup (complete)

- `buildSetup()` in `agent-connectors.ts` returns two MCP server entries: `antigen` (trust tools) and `antigen-browser` (adapter script).
- `antigen-browser` uses `examples/antigen-browser-adapter.mjs` — resolves the real CDP port at startup by calling the API, then spawns `@playwright/mcp`. No static port hard-coding.
- `browser_runtime_guidance` field added to setup response: labels each server's role, adapter_note explains automatic port resolution.
- `connect-agent` UI displays both server entries and a legend explaining their roles.
- `get_runtime_browser_endpoint` `next_action` text updated to reference `antigen-browser` by name; port_auto_selected case no longer instructs users to edit config.
- See "Connector MCP Config Shape" section above for the canonical config.

### Increment 5 — Runtime Status UI

Surface on the Aegis UI (agent session view or connector panel):

- "Local runtime ready" / "Starting" / "No active runtime" status
- Active agent session count for the current delegation
- Pending approvals for this runtime
- Recent receipts
- Failure cards with next actions

**Do not** add a "Start browser" button as a required user step. The runtime status is informational. Provisioning is automatic.
