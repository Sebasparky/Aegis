#!/usr/bin/env node
/**
 * antigen-browser-adapter.mjs
 *
 * Lazily resolves the Antigen local browser runtime CDP endpoint on the first
 * MCP tool call, then spawns @playwright/mcp with the correct --cdp-endpoint.
 * MCP protocol traffic on stdin/stdout is piped to/from the child process.
 *
 * In visible + realistic-input mode, intercepts browser_click, browser_fill,
 * and browser_type tool calls and routes them through the Aegis realistic-input
 * API. Any intercept failure falls back to @playwright/mcp unchanged.
 *
 * INVARIANTS:
 * - Never write non-JSON-RPC text to stdout — stdout is the MCP protocol stream.
 * - Never silently drop a JSON-RPC message. Parse failures and intercept failures
 *   always forward the original line to child.stdin.
 * - Never log text field values (browser_fill value, browser_type text).
 *   Diagnostics only to stderr.
 * - cdp_url is permitted for internal runtime use; never forward to agent output.
 * - Browser runtime is initialized lazily on the first tool call — no browser
 *   session or Chrome process is created at adapter startup.
 *
 * Required env vars:
 *   AEGIS_API_BASE    — e.g. http://localhost:4000
 *   AEGIS_AGENT_TOKEN — delegation token from connector setup
 *
 * Optional env vars:
 *   ANTIGEN_BROWSER_HEADLESS   — set to "false" to enable visible mode interception
 *   ANTIGEN_INPUT_REALISM      — "fast"/"disabled"/"false" disables interception
 */

import { spawn } from "node:child_process";
import { looksLikeSelector, charCountBucket, buildSyntheticSuccessText } from "./lib/adapter-helpers.mjs";

export const ADAPTER_VERSION = "2026-05-29";

const BASE = process.env.AEGIS_API_BASE;
const TOKEN = process.env.AEGIS_AGENT_TOKEN;

function fatal(msg) {
  process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] ERROR: ${msg}\n`);
  process.exit(1);
}

if (!TOKEN) fatal("AEGIS_AGENT_TOKEN is not set. Set it in the antigen-browser MCP server env.");
if (!BASE) fatal("AEGIS_API_BASE is not set. Set it in the antigen-browser MCP server env.");

// ─── Interception gate (env-only portion, known at startup) ───────────────────
// browser_runtime_id is not yet known — that requires the lazy API call.
// VISIBLE_REALISM_REQUESTED captures the env-side conditions only.
const HEADLESS_ENV = (process.env.ANTIGEN_BROWSER_HEADLESS ?? "true").toLowerCase();
const REALISM_ENV  = (process.env.ANTIGEN_INPUT_REALISM ?? "").toLowerCase();
const VISIBLE_REALISM_REQUESTED =
  HEADLESS_ENV === "false" &&
  !["fast", "disabled", "false"].includes(REALISM_ENV);

process.stderr.write(
  `[antigen-browser@${ADAPTER_VERSION}] adapter loaded` +
  ` headless=${HEADLESS_ENV} realism=${REALISM_ENV || "(default)"}` +
  ` interception_will_be=${VISIBLE_REALISM_REQUESTED ? "ENABLED_pending_runtime" : "DISABLED"}\n`
);

// ─── Lazy runtime state ────────────────────────────────────────────────────────
let child = null;
let browser_runtime_id = null;
let INTERCEPTION_ENABLED = false; // set after successful lazy init
let _initPromise = null;

async function ensureRuntime() {
  if (!_initPromise) {
    _initPromise = _doInitRuntime().catch((err) => {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] FATAL: ${err.message}\n`);
      process.exit(1);
    });
  }
  return _initPromise;
}

async function _doInitRuntime() {
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
    throw new Error(`Could not reach Antigen API at ${BASE}. Is the Aegis server running? (${err.message})`);
  }

  if (res.status === 401) throw new Error("AEGIS_AGENT_TOKEN is invalid, expired, or revoked. Reconnect the agent connector to get a fresh token.");

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Unexpected response from Antigen API (status ${res.status}).`);
  }

  if (!res.ok) {
    const code = body?.error?.code ?? "UNKNOWN_ERROR";
    const msg  = body?.error?.message ?? "Failed to initialize browser runtime.";
    if (code === "NO_PORTS_AVAILABLE") throw new Error("All CDP ports are occupied. Close open Aegis browser sessions and retry.");
    if (code === "CHROME_NOT_FOUND")    throw new Error("Chrome is not installed or not on PATH. Install Google Chrome and retry.");
    throw new Error(`${code}: ${msg}`);
  }

  const { cdp_url, browser_runtime_id: runtimeId, runtime_mode, reused_existing } = body.data;
  browser_runtime_id = runtimeId;

  INTERCEPTION_ENABLED = VISIBLE_REALISM_REQUESTED && !!browser_runtime_id;

  const sessionLabel = reused_existing ? "existing session" : "new session";
  process.stderr.write(
    `[antigen-browser@${ADAPTER_VERSION}] Runtime ready` +
    ` (${runtime_mode ?? "local_runtime_endpoint"}, ${sessionLabel}, id=${browser_runtime_id})` +
    ` — attaching @playwright/mcp to ${cdp_url}\n`
  );

  if (INTERCEPTION_ENABLED) {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] Realistic-input interception ENABLED` +
      ` (browser_click → realistic pointer, browser_fill/browser_type → per-char typing)\n`
    );
  } else {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] Realistic-input interception DISABLED` +
      ` — all MCP traffic passed through to @playwright/mcp\n`
    );
  }

  child = spawn(
    "npx",
    ["--yes", "@playwright/mcp@latest", "--cdp-endpoint", cdp_url],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  child.stderr.pipe(process.stderr);
  child.stdout.pipe(process.stdout);

  process.on("SIGINT",  () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  child.on("error", (err) => {
    process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] Failed to spawn @playwright/mcp: ${err.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
}

// ─── MCP protocol routing ─────────────────────────────────────────────────────
// All stdin is line-buffered through a sequential processing queue so that
// ensureRuntime() can block the first line (and any concurrent lines) until
// the child process is ready. Lines are always processed in arrival order.

let lineBuffer = "";
let processingQueue = Promise.resolve();

function enqueueLine(line) {
  processingQueue = processingQueue
    .then(() => handleLine(line))
    .catch((err) => {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] unhandled line error: ${err.message}\n`);
    });
}

process.stdin.on("data", (chunk) => {
  lineBuffer += chunk.toString();
  let idx;
  while ((idx = lineBuffer.indexOf("\n")) !== -1) {
    const line = lineBuffer.slice(0, idx + 1);
    lineBuffer = lineBuffer.slice(idx + 1);
    enqueueLine(line);
  }
});

process.stdin.on("end", () => {
  if (lineBuffer.length > 0) {
    enqueueLine(lineBuffer);
    lineBuffer = "";
  }
  // End child.stdin after all queued lines are fully processed.
  processingQueue.then(() => {
    if (child) child.stdin.end();
  });
});

/**
 * Writes a synthetic MCP tools/call success response to stdout.
 * ONLY called after a successful Aegis API interception.
 * stdout is MCP protocol only — never write diagnostics here.
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
 * Calls ensureRuntime() on first invocation (lazy browser init).
 * Intercepts browser_click/browser_fill/browser_type in visible+realistic mode.
 * Falls back to forwarding to child.stdin on any failure.
 * Never silently drops a line.
 */
async function handleLine(line) {
  await ensureRuntime();

  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    // Malformed JSON — forward raw bytes unchanged.
    child.stdin.write(line);
    return;
  }

  // Only intercept tools/call requests.
  if (msg?.method !== "tools/call" || !msg?.params?.name) {
    child.stdin.write(line);
    return;
  }

  const toolName = msg.params.name;

  // ── browser_click interception ────────────────────────────────────────────
  if (INTERCEPTION_ENABLED && toolName === "browser_click") {
    const argKeys          = Object.keys(msg?.params?.arguments ?? {}).join(",");
    const elementDescription = msg?.params?.arguments?.element ?? "";
    const requestId        = msg.id;
    const targetArg        = msg?.params?.arguments?.target ?? "";
    const selectorHint     = looksLikeSelector(targetArg) ? targetArg : undefined;

    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] realistic_click_attempt` +
      ` arg_keys=${argKeys}` +
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
        process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_click_success\n`);
        writeSyntheticResponse(
          requestId,
          buildSyntheticSuccessText("browser_click", {
            hint: selectorHint ? "selector" : "description",
            version: ADAPTER_VERSION,
          }),
        );
        return;
      }
      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? apiRes.status;
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_click_fallback reason=${errCode}\n`);
    } catch (err) {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_click_fallback reason=INTERCEPT_ERROR(${err.message})\n`);
    }

    child.stdin.write(line);
    return;
  }

  // ── browser_fill interception ──────────────────────────────────────────────
  if (INTERCEPTION_ENABLED && toolName === "browser_fill") {
    const fillText  = msg?.params?.arguments?.value ?? "";
    const argKeys   = Object.keys(msg?.params?.arguments ?? {}).join(",");
    const requestId = msg.id;
    const bucket    = charCountBucket(fillText.length);

    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] realistic_type_attempt source=browser_fill` +
      ` arg_keys=${argKeys} char_count_bucket=${bucket}\n`
    );

    try {
      const apiRes = await fetch(`${BASE}/api/agent/v1/runtime/browser-type`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ browser_runtime_id, text: fillText }),
      });

      if (apiRes.ok) {
        const resBody   = await apiRes.json().catch(() => ({}));
        const resBucket = resBody?.data?.char_count_bucket ?? bucket;
        process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_type_success source=browser_fill char_count_bucket=${resBucket}\n`);
        writeSyntheticResponse(
          requestId,
          buildSyntheticSuccessText("browser_fill", { bucket: resBucket, version: ADAPTER_VERSION }),
        );
        return;
      }
      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? apiRes.status;
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_type_fallback reason=${errCode} source=browser_fill\n`);
    } catch (err) {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_type_fallback reason=INTERCEPT_ERROR source=browser_fill\n`);
    }

    child.stdin.write(line);
    return;
  }

  // ── browser_type interception ──────────────────────────────────────────────
  // @playwright/mcp uses browser_type with arguments.text for pressSequentially.
  // We intercept and route through the same Aegis per-character CDP typing path.
  if (INTERCEPTION_ENABLED && toolName === "browser_type") {
    const typeText  = msg?.params?.arguments?.text ?? "";
    const argKeys   = Object.keys(msg?.params?.arguments ?? {}).join(",");
    const requestId = msg.id;
    const bucket    = charCountBucket(typeText.length);

    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] realistic_type_attempt source=browser_type` +
      ` arg_keys=${argKeys} char_count_bucket=${bucket}\n`
    );

    try {
      const apiRes = await fetch(`${BASE}/api/agent/v1/runtime/browser-type`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ browser_runtime_id, text: typeText }),
      });

      if (apiRes.ok) {
        const resBody   = await apiRes.json().catch(() => ({}));
        const resBucket = resBody?.data?.char_count_bucket ?? bucket;
        process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_type_success source=browser_type char_count_bucket=${resBucket}\n`);
        writeSyntheticResponse(
          requestId,
          buildSyntheticSuccessText("browser_type", { bucket: resBucket, version: ADAPTER_VERSION }),
        );
        return;
      }
      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? apiRes.status;
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_type_fallback reason=${errCode} source=browser_type\n`);
    } catch (err) {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_type_fallback reason=INTERCEPT_ERROR source=browser_type\n`);
    }

    child.stdin.write(line);
    return;
  }

  // All other tools (or interception disabled): forward to @playwright/mcp unchanged.
  child.stdin.write(line);
}
