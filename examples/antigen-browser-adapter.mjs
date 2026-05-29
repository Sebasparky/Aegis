#!/usr/bin/env node
/**
 * antigen-browser-adapter.mjs
 *
 * Resolves the Antigen local browser runtime CDP endpoint at startup, then
 * spawns @playwright/mcp with the correct --cdp-endpoint. MCP protocol
 * traffic on stdin/stdout is piped to/from the child process.
 *
 * In visible + realistic-input mode, intercepts browser_click and browser_fill
 * tool calls and routes them through the Aegis realistic-input API before
 * forwarding or responding. Any intercept failure falls back to @playwright/mcp.
 *
 * INVARIANTS:
 * - Never write non-JSON-RPC text to stdout — stdout is the MCP protocol stream.
 * - Never silently drop a JSON-RPC message. Parse failures and intercept failures
 *   always forward the original line to child.stdin.
 * - Never log text field values (browser_fill value). Diagnostics only to stderr.
 * - cdp_url is permitted for internal runtime use; never forward to agent output.
 *
 * Required env vars:
 *   AEGIS_API_BASE    — e.g. http://localhost:4000
 *   AEGIS_AGENT_TOKEN — delegation token from connector setup
 *
 * Optional env vars (same flags as the server):
 *   ANTIGEN_BROWSER_HEADLESS   — set to "false" to enable visible mode interception
 *   ANTIGEN_INPUT_REALISM      — "fast"/"disabled"/"false" disables interception
 *
 * Manual test:
 *   node examples/antigen-browser-adapter.mjs
 *   (should keep running when AEGIS_API_BASE and AEGIS_AGENT_TOKEN are valid)
 */

import { spawn } from "node:child_process";

const BASE = process.env.AEGIS_API_BASE;
const TOKEN = process.env.AEGIS_AGENT_TOKEN;

function fatal(msg) {
  process.stderr.write(`[antigen-browser] ERROR: ${msg}\n`);
  process.exit(1);
}

if (!TOKEN) fatal("AEGIS_AGENT_TOKEN is not set. Set it in the antigen-browser MCP server env.");
if (!BASE) fatal("AEGIS_API_BASE is not set. Set it in the antigen-browser MCP server env.");

let res;
try {
  res = await fetch(`${BASE}/api/agent/v1/runtime/browser-endpoint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({}),
  });
} catch (err) {
  fatal(`Could not reach Antigen API at ${BASE}. Is the Aegis server running? (${err.message})`);
}

if (res.status === 401) fatal("AEGIS_AGENT_TOKEN is invalid, expired, or revoked. Reconnect the agent connector to get a fresh token.");

let body;
try {
  body = await res.json();
} catch {
  fatal(`Unexpected response from Antigen API (status ${res.status}).`);
}

if (!res.ok) {
  const code = body?.error?.code ?? "UNKNOWN_ERROR";
  const msg = body?.error?.message ?? "Failed to initialize browser runtime.";
  if (code === "NO_PORTS_AVAILABLE") fatal("All CDP ports are occupied. Close open Aegis browser sessions and retry.");
  if (code === "CHROME_NOT_FOUND") fatal("Chrome is not installed or not on PATH. Install Google Chrome and retry.");
  fatal(`${code}: ${msg}`);
}

const { cdp_url, browser_runtime_id, runtime_mode, reused_existing } = body.data;
const sessionLabel = reused_existing ? "existing session" : "new session";
process.stderr.write(`[antigen-browser] Runtime ready (${runtime_mode ?? "local_runtime_endpoint"}, ${sessionLabel}, id=${browser_runtime_id}) — attaching @playwright/mcp to ${cdp_url}\n`);

// ─── Interception gate ────────────────────────────────────────────────────────
// All three conditions must be true for interception to activate:
//   1. Visible mode  — ANTIGEN_BROWSER_HEADLESS=false
//   2. Realism not disabled — ANTIGEN_INPUT_REALISM is not fast/disabled/false
//   3. browser_runtime_id was received from startup response
const HEADLESS_ENV = (process.env.ANTIGEN_BROWSER_HEADLESS ?? "true").toLowerCase();
const REALISM_ENV  = (process.env.ANTIGEN_INPUT_REALISM ?? "").toLowerCase();
const INTERCEPTION_ENABLED =
  HEADLESS_ENV === "false" &&
  !["fast", "disabled", "false"].includes(REALISM_ENV) &&
  !!browser_runtime_id;

if (INTERCEPTION_ENABLED) {
  process.stderr.write("[antigen-browser] Realistic-input interception ENABLED (browser_click → realistic pointer, browser_fill/browser_type → per-char typing)\n");
} else {
  process.stderr.write("[antigen-browser] Realistic-input interception DISABLED — all MCP traffic passed through to @playwright/mcp\n");
}

/**
 * Returns true if the string looks like a CSS / ARIA selector rather than a
 * snapshot element reference. Snapshot refs are short alphanumeric strings like
 * "e5" or "a12". Real selectors contain CSS syntax characters.
 * Only selector-like strings are forwarded as selector_hint to the Aegis API.
 */
function looksLikeSelector(s) {
  return typeof s === "string" && s.length > 0 && /[\[.#>:=('"*~+]/.test(s);
}

/**
 * Maps text length to a coarse bucket for diagnostic logging.
 * Never logs the raw length or text value.
 */
function charCountBucket(len) {
  if (len <= 4) return "1-4";
  if (len <= 8) return "5-8";
  if (len <= 16) return "9-16";
  return "17+";
}

// ─── Spawn @playwright/mcp ────────────────────────────────────────────────────
const child = spawn(
  "npx",
  ["--yes", "@playwright/mcp@latest", "--cdp-endpoint", cdp_url],
  { stdio: ["pipe", "pipe", "pipe"] },
);

// Forward child stderr to parent stderr so errors are visible without polluting stdout.
child.stderr.pipe(process.stderr);

// Forward termination signals to the child so it can shut down cleanly.
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("error", (err) => {
  process.stderr.write(`[antigen-browser] Failed to spawn @playwright/mcp: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

// ─── MCP protocol routing ─────────────────────────────────────────────────────
// child.stdout → process.stdout is always a direct pipe.
// stdin routing depends on INTERCEPTION_ENABLED.
child.stdout.pipe(process.stdout);

if (!INTERCEPTION_ENABLED) {
  // Transparent passthrough: pipe stdin directly to child.
  process.stdin.pipe(child.stdin);
} else {
  // Line-buffered interceptor: parse each JSON-RPC message before forwarding.
  // Any parse failure or intercept failure forwards the original bytes unchanged.
  let lineBuffer = "";

  process.stdin.on("data", (chunk) => {
    lineBuffer += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newlineIdx + 1); // preserve trailing newline
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      handleLine(line);
    }
  });

  process.stdin.on("end", () => {
    // Flush any remaining partial line (should not occur in well-formed MCP streams).
    if (lineBuffer.length > 0) {
      child.stdin.write(lineBuffer);
      lineBuffer = "";
    }
    child.stdin.end();
  });
}

/**
 * Writes a synthetic MCP tools/call success response to stdout.
 * ONLY called after a successful Aegis API interception.
 * Never called on failure — failure always falls through to child.stdin.
 */
function writeSyntheticResponse(requestId, text) {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    result: { content: [{ type: "text", text }] },
  });
  process.stdout.write(response + "\n");
}

/**
 * Routes a single JSON-RPC line.
 * Intercepts browser_click and browser_fill in visible+realistic mode.
 * Falls back to forwarding to child.stdin on any failure.
 * Never silently drops a line.
 */
async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    // Malformed JSON — forward raw bytes unchanged. Never drop.
    child.stdin.write(line);
    return;
  }

  // Only intercept tools/call requests.
  if (msg?.method !== "tools/call" || !msg?.params?.name) {
    child.stdin.write(line);
    return;
  }

  const toolName = msg.params.name;

  // ── browser_click interception ───────────────────────────────────────────
  if (toolName === "browser_click") {
    const elementDescription = msg?.params?.arguments?.element ?? "";
    const requestId = msg.id;

    // Forward target as selector_hint only when it looks like a CSS/ARIA selector.
    // Snapshot refs ("e5", "a12") are short alphanumeric and are not forwarded.
    const targetArg = msg?.params?.arguments?.target ?? "";
    const selectorHint = looksLikeSelector(targetArg) ? targetArg : undefined;

    process.stderr.write(
      `[antigen-browser] realistic_click_attempt` +
      (selectorHint ? " hint=selector" : " hint=none") + "\n"
    );

    try {
      const reqBody = { browser_runtime_id, element_description: elementDescription };
      if (selectorHint) reqBody.selector_hint = selectorHint;

      const apiRes = await fetch(`${BASE}/api/agent/v1/runtime/browser-click`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(reqBody),
      });

      if (apiRes.ok) {
        process.stderr.write("[antigen-browser] realistic_click_success\n");
        writeSyntheticResponse(requestId, "Pointer moved and clicked.");
        return;
      }
      // Non-2xx (ELEMENT_NOT_FOUND, AMBIGUOUS, etc.) → fall through to @playwright/mcp.
      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? apiRes.status;
      process.stderr.write(`[antigen-browser] realistic_click_fallback reason=${errCode}\n`);
    } catch (err) {
      process.stderr.write(`[antigen-browser] realistic_click_fallback reason=INTERCEPT_ERROR(${err.message})\n`);
    }

    // Fallback: forward original message to @playwright/mcp.
    child.stdin.write(line);
    return;
  }

  // ── browser_fill interception ────────────────────────────────────────────
  if (toolName === "browser_fill") {
    const fillText = msg?.params?.arguments?.value ?? "";
    const requestId = msg.id;
    const bucket = charCountBucket(fillText.length);

    process.stderr.write(`[antigen-browser] realistic_type_attempt source=browser_fill char_count_bucket=${bucket}\n`);

    try {
      const apiRes = await fetch(`${BASE}/api/agent/v1/runtime/browser-type`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ browser_runtime_id, text: fillText }),
      });

      if (apiRes.ok) {
        const resBody = await apiRes.json().catch(() => ({}));
        const resBucket = resBody?.data?.char_count_bucket ?? bucket;
        process.stderr.write(`[antigen-browser] realistic_type_success source=browser_fill char_count_bucket=${resBucket}\n`);
        writeSyntheticResponse(requestId, "Text typed character by character.");
        return;
      }
      // Non-2xx → fall through to @playwright/mcp's browser_fill.
      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? apiRes.status;
      process.stderr.write(`[antigen-browser] realistic_type_fallback reason=${errCode} source=browser_fill\n`);
    } catch (err) {
      process.stderr.write(`[antigen-browser] realistic_type_fallback reason=INTERCEPT_ERROR source=browser_fill\n`);
    }

    // Fallback: forward original message to @playwright/mcp.
    child.stdin.write(line);
    return;
  }

  // ── browser_type interception ────────────────────────────────────────────
  // @playwright/mcp uses browser_type with arguments.text for typing into the
  // focused element (e.g. pressSequentially). We intercept it and route through
  // the same Aegis per-character CDP typing path used by browser_fill.
  if (toolName === "browser_type") {
    const typeText = msg?.params?.arguments?.text ?? "";
    const requestId = msg.id;
    const bucket = charCountBucket(typeText.length);

    process.stderr.write(`[antigen-browser] realistic_type_attempt source=browser_type char_count_bucket=${bucket}\n`);

    try {
      const apiRes = await fetch(`${BASE}/api/agent/v1/runtime/browser-type`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ browser_runtime_id, text: typeText }),
      });

      if (apiRes.ok) {
        const resBody = await apiRes.json().catch(() => ({}));
        const resBucket = resBody?.data?.char_count_bucket ?? bucket;
        process.stderr.write(`[antigen-browser] realistic_type_success source=browser_type char_count_bucket=${resBucket}\n`);
        writeSyntheticResponse(requestId, "Text typed character by character.");
        return;
      }
      // Non-2xx → fall through to @playwright/mcp's browser_type.
      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? apiRes.status;
      process.stderr.write(`[antigen-browser] realistic_type_fallback reason=${errCode} source=browser_type\n`);
    } catch (err) {
      process.stderr.write(`[antigen-browser] realistic_type_fallback reason=INTERCEPT_ERROR source=browser_type\n`);
    }

    // Fallback: forward original message to @playwright/mcp.
    child.stdin.write(line);
    return;
  }

  // All other tools: forward to @playwright/mcp unchanged.
  child.stdin.write(line);
}
