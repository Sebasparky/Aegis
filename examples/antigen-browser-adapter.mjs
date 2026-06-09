#!/usr/bin/env node
/**
 * antigen-browser-adapter.mjs
 *
 * Lazily resolves the Antigen local browser runtime CDP endpoint on the first
 * browser MCP tool call, then spawns @playwright/mcp with the correct
 * --cdp-endpoint. MCP protocol traffic on stdin/stdout is piped to/from the
 * child process.
 *
 * In visible + realistic-input mode, intercepts browser_click, browser_fill,
 * and browser_type tool calls and routes them through the Aegis realistic-input
 * API. browser_click and browser_fill fall back to @playwright/mcp on failure.
 * browser_type is adapter-owned: any failure returns a clean MCP error response
 * and is never forwarded to @playwright/mcp (@playwright/mcp requires a "target"
 * field that our schema does not advertise; forwarding always Zod-errors).
 *
 * INVARIANTS:
 * - Never write non-JSON-RPC text to stdout — stdout is the MCP protocol stream.
 * - Never silently drop a JSON-RPC message. Parse failures and non-browser_type
 *   intercept failures forward the original line to child.stdin (if child exists).
 * - browser_type is NEVER forwarded to child.stdin — it is adapter-owned.
 * - Never log text field values (browser_fill value, browser_type text).
 *   Diagnostics only to stderr.
 * - cdp_url is permitted for internal runtime use; never forward to agent output.
 * - Browser runtime is initialized lazily on the first browser tools/call —
 *   no browser session, @playwright/mcp process, or Chrome is created at startup
 *   or in response to initialize / tools/list / notifications/initialized.
 * - Pre-init MCP handshake (initialize, tools/list, resources/list, prompts/list,
 *   ping) is handled by the adapter itself with synthetic responses.
 * - Child MCP handshake is performed internally before piping child.stdout to
 *   process.stdout; the child's init response is never forwarded to Claude.
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
import { looksLikeSelector, charCountBucket, clipRuntimeId, buildSyntheticSuccessText, buildAntigenSnapshotText, deriveNavHintsFromSnapshot, classifyNavigationDiscipline, navigationBlockMessage, sanitizeHostPath } from "./lib/adapter-helpers.mjs";

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
const HEADLESS_ENV = (process.env.ANTIGEN_BROWSER_HEADLESS ?? "true").toLowerCase();
const REALISM_ENV  = (process.env.ANTIGEN_INPUT_REALISM ?? "").toLowerCase();
const VISIBLE_REALISM_REQUESTED =
  HEADLESS_ENV === "false" &&
  !["fast", "disabled", "false"].includes(REALISM_ENV);

// Unambiguous identity banner. If you are running Antigen QA and DO NOT see this
// line in your MCP server's stderr, the agent is talking to raw @playwright/mcp,
// not the Antigen adapter — fix your MCP config (see docs/dev/antigen-qa-mcp.md).
// Sanitized: no token, CDP URL, profile path, or payload.
process.stderr.write(
  `[antigen-browser@${ADAPTER_VERSION}] ANTIGEN BROWSER ADAPTER ACTIVE` +
  ` — this is the Antigen adapter, NOT raw @playwright/mcp.` +
  ` Browser tool calls are mediated by Antigen before reaching the child Playwright process.\n`
);

process.stderr.write(
  `[antigen-browser@${ADAPTER_VERSION}] adapter loaded` +
  ` headless=${HEADLESS_ENV} realism=${REALISM_ENV || "(default)"}` +
  ` interception_will_be=${VISIBLE_REALISM_REQUESTED ? "ENABLED_pending_runtime" : "DISABLED"}\n`
);

// Sanitized QA flag diagnostics — no token, CDP URL, profile path, payloads,
// URLs, query strings, cookies, storage, or secrets. (antigenHardModeEnabled /
// realisticNavRequired are hoisted function declarations defined below.)
process.stderr.write(
  `[antigen-browser@${ADAPTER_VERSION}] qa_flags` +
  ` require_realistic_navigation=${realisticNavRequired()}` +
  ` require_antigen_tools=${antigenHardModeEnabled()}` +
  ` browser_trace=${process.env.ANTIGEN_BROWSER_TRACE === "true"}\n`
);

// ─── Fail-closed QA-env startup guard ─────────────────────────────────────────
// This adapter is the Antigen browser-realism QA surface. Its hard-mode logic
// (navigation discipline, antigen_snapshot ownership, pointer-realism, trace
// dispositions) only runs when the QA env flags are set. The recurring failure is
// a CACHED, app-level DIRECT launch (`node examples/antigen-browser-adapter.mjs`)
// with NONE of those flags — the adapter would otherwise load weak tools and still
// report "tools loaded", silently wasting QA runs.
//
// Default behavior: fail closed BEFORE serving any tools when the required QA env
// is missing. Set ANTIGEN_ADAPTER_REQUIRE_QA_ENV=false to opt out (non-QA / local
// dev / weak-mode tests must set this explicitly). Only the literal string "false"
// disables the guard. The message is sanitized — no token, CDP URL, path, payload.
const REQUIRE_QA_ENV = process.env.ANTIGEN_ADAPTER_REQUIRE_QA_ENV !== "false";
if (REQUIRE_QA_ENV) {
  const missing = [];
  if (!BASE) missing.push("AEGIS_API_BASE");
  if (!TOKEN) missing.push("AEGIS_AGENT_TOKEN");
  if (process.env.ANTIGEN_BROWSER_TRACE !== "true") missing.push("ANTIGEN_BROWSER_TRACE");
  if (process.env.ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS !== "true") missing.push("ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS");
  if (process.env.ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION !== "true") missing.push("ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION");
  if (REALISM_ENV !== "realistic") missing.push("ANTIGEN_INPUT_REALISM");

  // Headless is warning-only: visible mode is preferred for overlay QA, but many
  // tests run headless intentionally. Do not fail on this one.
  if (HEADLESS_ENV !== "false") {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] WARN: ANTIGEN_BROWSER_HEADLESS is not "false"` +
      ` — running headless; pointer-overlay QA needs visible mode.\n`
    );
  }

  if (missing.length > 0) {
    const v = ADAPTER_VERSION;
    process.stderr.write(
      `[antigen-browser@${v}] FATAL: Antigen QA adapter launched without required QA env.\n` +
      `[antigen-browser@${v}] Missing/invalid: ${missing.join(", ")}\n` +
      `[antigen-browser@${v}] This usually means Claude is launching a cached DIRECT command:\n` +
      `[antigen-browser@${v}]   node examples/antigen-browser-adapter.mjs\n` +
      `[antigen-browser@${v}] instead of the QA wrapper:\n` +
      `[antigen-browser@${v}]   scripts/run-antigen-browser-adapter-qa.sh\n` +
      `[antigen-browser@${v}] Set ANTIGEN_ADAPTER_REQUIRE_QA_ENV=false to allow weak/default mode (non-QA only).\n`
    );
    // Exit before any tool is served so the agent cannot report "tools loaded".
    process.exit(1);
  }
}

// ─── Startup token self-check (non-blocking) ──────────────────────────────────
// Resolve AEGIS_AGENT_TOKEN against the API and print the agent it maps to, so a human can
// confirm this adapter and the aegis MCP server resolve to the SAME delegation. A mismatch is
// the root cause of profile-fill INVALID_TOKEN / TASK_BROWSER_SESSION_FORBIDDEN during checkout.
// Sanitized: logs only the token id (the demo pass id already in MCP config) plus agent_name /
// delegation_id. Fire-and-forget so it never blocks the stdio loop.
fetch(`${BASE}/api/agent/v1/me`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  .then(async (res) => {
    if (res.status === 401) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] TOKEN-WARN: AEGIS_AGENT_TOKEN='${TOKEN}' does not resolve to ` +
        `a delegation (401 from /api/agent/v1/me). Seed demo data and reload the API.\n`
      );
      return;
    }
    const body = await res.json().catch(() => ({}));
    const id = body?.data ?? body;
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] token_self_check ok token='${TOKEN}' ` +
      `agent='${id?.agent_name ?? "?"}' delegation='${id?.delegation_id ?? "?"}'. ` +
      `This MUST match the aegis MCP server's delegation.\n`
    );
  })
  .catch((err) => {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] token_self_check skipped — API unreachable (${err.message}).\n`
    );
  });

// ─── Static browser tool list (served without spawning a child) ───────────────
// Schemas approximate @playwright/mcp@latest. The child validates actual args;
// these schemas exist so Claude generates correct tool calls before runtime init.
const STATIC_BROWSER_TOOLS = [
  {
    name: "browser_snapshot",
    description: "Capture accessibility snapshot of the current page, this is better than screenshot",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "antigen_snapshot",
    description:
      "Take an Antigen-owned DOM snapshot of the current browser page. Returns safe semantic " +
      "elements with Antigen refs (ag_*) that Antigen can later resolve. Does not expose " +
      "coordinates, boxes, cookies, storage, raw DOM, or secrets.",
    inputSchema: {
      type: "object",
      properties: {
        max_candidates: {
          type: "number",
          description:
            "Maximum number of visible interactive candidates to return. Defaults to 200. " +
            "Backend clamps to a safe bound.",
        },
        viewport_only: {
          type: "boolean",
          description:
            "Whether to include only elements intersecting the current viewport. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to navigate to" } },
      required: ["url"],
    },
  },
  {
    name: "browser_navigate_back",
    description: "Go back to the previous page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click left mouse button on an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description for action logging" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
      },
    },
  },
  {
    name: "browser_scroll_to_ref",
    description:
      "Scroll an Antigen ag_* ref near the current viewport so you can take a fresh antigen_snapshot before clicking. Use this to recover from ANTIGEN_REF_OUT_OF_VIEWPORT on an offscreen ref. Does not click and does not expose coordinates. After it succeeds, take a new antigen_snapshot and click the fresh in-viewport ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Antigen ref such as ag_47 from antigen_snapshot." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "APPEND keystrokes into a field (human-style typing). Use ONLY for search boxes, keyboard shortcuts, and natural typing where appending is intended — NOT for filling form fields with a known value. browser_type does not clear the field first, so typing into a prefilled field DUPLICATES its content. To set a form field (contact/address/checkout) to an exact value, use browser_fill / browser_set_value instead.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
        text: { type: "string", description: "Text to type (appended) into the element" },
        slowly: { type: "boolean", description: "Whether to type character-by-character. Useful for triggering auto-complete" },
        submit: { type: "boolean", description: "Whether to submit the form after typing. Equivalent to pressing Enter" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_fill",
    description:
      "Set a form field to an EXACT value (replaces existing content; does NOT append). Idempotent: if the field already equals the value it is left unchanged (changed=false). Use this for contact/address/checkout/profile fields where the final value is known. Before filling, inspect the snapshot's `value` for the ref and SKIP fields already correct. After filling, the response includes `actual_value`, `changed`, and `verified` — confirm `verified` before proceeding. Sensitive fields (password/card/CVV/identity) are refused here — use the Aegis credential injection path instead. Requires an ag_* ref from the latest antigen_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference (ag_*) from the page snapshot" },
        value: { type: "string", description: "Exact final value the field should hold" },
      },
      required: ["value"],
    },
  },
  {
    name: "browser_set_value",
    description:
      "Set a form field to an EXACT value (alias of browser_fill — exact replacement, not append). Idempotent and verified: clears the field, sets the requested value via the native setter (React/Vue-safe), reads back, and returns `actual_value`/`changed`/`verified`. Use for known form values; skip fields the snapshot shows are already correct. Sensitive fields are refused. Requires an ag_* ref.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference (ag_*) from the page snapshot" },
        value: { type: "string", description: "Exact final value the field should hold" },
        select_by_label: { type: "boolean", description: "For <select>: match the option by its visible text instead of its value" },
      },
      required: ["value"],
    },
  },
  {
    name: "browser_clear",
    description:
      "Clear a form field to empty (exact replacement with \"\"). Idempotent — an already-empty field is left unchanged. Requires an ag_* ref from the latest antigen_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference (ag_*) from the page snapshot" },
      },
    },
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Name of the key to press, e.g. 'ArrowLeft', 'Enter', 'Tab'" },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_hover",
    description: "Hover mouse over an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
      },
    },
  },
  {
    name: "browser_drag",
    description: "Drag and drop an element to another location",
    inputSchema: {
      type: "object",
      properties: {
        startElement: { type: "string", description: "Human-readable source element description" },
        startRef: { type: "string", description: "Exact source element reference from the page snapshot" },
        endElement: { type: "string", description: "Human-readable target element description" },
        endRef: { type: "string", description: "Exact target element reference from the page snapshot" },
      },
    },
  },
  {
    name: "browser_drop",
    description: "Drop data or files onto an element",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable target element description" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
      },
    },
  },
  {
    name: "browser_select_option",
    description: "Select an option in a dropdown list",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
        values: {
          type: "array",
          items: { type: "string" },
          description: "Values to select in the dropdown",
        },
      },
      required: ["values"],
    },
  },
  {
    name: "browser_fill_form",
    description: "Fill out multiple form fields at once",
    inputSchema: {
      type: "object",
      properties: {
        formData: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "Element reference from snapshot" },
              value: { type: "string", description: "Value to fill" },
            },
          },
          description: "Array of field references and their values",
        },
      },
      required: ["formData"],
    },
  },
  {
    name: "browser_handle_dialog",
    description: "Handle a dialog box (alert, confirm, prompt)",
    inputSchema: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "Whether to accept the dialog" },
        promptText: { type: "string", description: "Text to enter in prompt dialog" },
      },
      required: ["accept"],
    },
  },
  {
    name: "browser_take_screenshot",
    description: "Take a screenshot of the current page",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description (for element screenshot)" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
      },
    },
  },
  {
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in the browser context",
    inputSchema: {
      type: "object",
      properties: {
        function: { type: "string", description: "A JavaScript function body to evaluate" },
      },
      required: ["function"],
    },
  },
  {
    name: "browser_console_messages",
    description: "Get browser console messages from the current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_network_requests",
    description: "Get all network requests made since page load",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_network_request",
    description: "Make an HTTP network request from the browser context",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL for the request" },
        method: { type: "string", description: "HTTP method (GET, POST, etc.)" },
        headers: { type: "object", description: "Request headers" },
        body: { type: "string", description: "Request body" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait for an element or text to appear on the page",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to wait for on the page" },
        textGone: { type: "string", description: "Text to wait until it disappears" },
        time: { type: "number", description: "Time to wait in milliseconds" },
      },
    },
  },
  {
    name: "browser_resize",
    description: "Resize the browser viewport",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", description: "New viewport width in pixels" },
        height: { type: "number", description: "New viewport height in pixels" },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "browser_tabs",
    description: "List or manage browser tabs",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_close",
    description: "Close the page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_run_code_unsafe",
    description: "Execute JavaScript code in the browser context (unsafe — use with caution)",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to execute" },
      },
      required: ["code"],
    },
  },
  {
    name: "browser_file_upload",
    description: "Upload files to a file input element",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to upload",
        },
      },
      required: ["paths"],
    },
  },
];

// ─── Lazy runtime state ────────────────────────────────────────────────────────
let child = null;
let browser_runtime_id = null;
let INTERCEPTION_ENABLED = false; // set after successful lazy init
let _initPromise = null;
let runtimeInitDone = false; // true after child handshake + stdout piped

// ─── Navigation discipline state (Antigen Browser Realism v1) ─────────────────
// The last current URL we successfully navigated to (used to tell same-site
// deeplinks from cross-site research jumps), plus a compact, safe set of nav
// hints derived from the most recent antigen_snapshot. Hints go stale quickly
// (mirrors the backend snapshot TTL) so a navigation is never blocked on the
// basis of a stale page map.
let currentUrl = null;
let lastNavHints = null;
let lastNavHintsAt = 0;
const NAV_HINTS_TTL_MS = 90000; // mirrors backend ANTIGEN_SNAPSHOT_TTL_MS (~90s)

// ─── Pending navigation registry ──────────────────────────────────────────────
// Tracks in-flight browser_navigate calls by requestId so handleChildLine can
// resolve the waiting handler instead of forwarding directly to stdout.
// Each entry: { url: string, resolve: (result: { line: string, parsed: object }) => void }
const pendingNavigations = new Map();

// browser_navigate child-response safety net. @playwright/mcp always eventually
// responds — with a success OR its own navigation error — so this only fires if the
// child process is genuinely hung or dead. It MUST sit well above the child's own
// navigation timeout (it is not a page-load timer). Env-overridable so tests can
// exercise the never-responds path quickly.
const NAVIGATE_CHILD_TIMEOUT_MS =
  Number(process.env.ANTIGEN_NAVIGATE_CHILD_TIMEOUT_MS) || 120000;

// Request ids whose browser_navigate already received a synthetic
// NAVIGATE_CHILD_TIMEOUT response. A late child response for one of these ids is
// dropped (not re-forwarded) so the adapter never emits a duplicate response.
const navigateTimedOutIds = new Set();

async function ensureRuntime() {
  if (!_initPromise) {
    _initPromise = _doInitRuntime().catch((err) => {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] FATAL: ${err.message}\n`);
      process.exit(1);
    });
  }
  return _initPromise;
}

// Performs the MCP initialize handshake with the child process.
// Sends initialize, discards the child's response (we already responded to Claude),
// sends notifications/initialized, then resolves. stdout is NOT piped yet —
// the caller sets up the pipe after this resolves.
async function doChildInitHandshake() {
  return new Promise((resolve, reject) => {
    const INIT_ID = "__antigen_init__";
    let lineBuf = "";
    let timer = null;

    function onData(chunk) {
      lineBuf += chunk.toString();
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const responseLine = lineBuf.slice(0, idx + 1);
        lineBuf = lineBuf.slice(idx + 1);
        let parsed;
        try { parsed = JSON.parse(responseLine.trim()); } catch { continue; }
        if (parsed?.id === INIT_ID) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          // Child responded to init — now send notifications/initialized and resolve
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
          );
          resolve();
          return;
        }
      }
    }

    child.stdout.on("data", onData);

    timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("Child MCP init handshake timed out after 5s"));
    }, 5000);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: INIT_ID,
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "antigen-browser-adapter", version: ADAPTER_VERSION },
        },
      }) + "\n"
    );
  });
}

async function _doInitRuntime() {
  // Propagate the operator's visibility intent to the launch decision. The
  // headed/headless choice is made server-side in createTaskBrowserSession; the
  // adapter's ANTIGEN_BROWSER_HEADLESS env only governs adapter-side realism. Send
  // mode:"visible" so a fresh launch is headed even if the API process was started
  // without ANTIGEN_BROWSER_HEADLESS=false. (API env remains a valid fallback.)
  const headedRequested = HEADLESS_ENV === "false";
  let res;
  try {
    res = await fetch(`${BASE}/api/agent/v1/runtime/browser-endpoint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(headedRequested ? { mode: "visible" } : {}),
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

  // Auditable headed-intent line. The adapter cannot observe the server-side launch
  // mode directly, but it can state what it requested and what it is binding to.
  // Metadata only — no cookies, storage, page values, or secrets.
  process.stderr.write(
    `[antigen-browser@${ADAPTER_VERSION}] headed_intent=${headedRequested ? "visible" : "headless"}` +
    ` cdp_url=${cdp_url} browser_runtime_id=${browser_runtime_id} reused_existing=${!!reused_existing}\n`
  );
  process.stderr.write(
    headedRequested
      ? `[antigen-browser@${ADAPTER_VERSION}] expected to be VISIBLE/headed — a Chrome window should be on screen.` +
        ` If none appears, a stale headless session may have been reused (kill Chrome on 9222 and restart).\n`
      : `[antigen-browser@${ADAPTER_VERSION}] expected to be HEADLESS — no Chrome window will appear (set ANTIGEN_BROWSER_HEADLESS=false for visible QA).\n`
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

  // Perform MCP init handshake with child BEFORE piping stdout.
  // This prevents the child's init response from being forwarded to Claude.
  await doChildInitHandshake();

  // Handshake complete — now safe to forward child responses to Claude.
  // Use a manual line buffer instead of pipe so browser_navigate can intercept
  // its own response before it reaches Cowork.
  let _childStdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    _childStdoutBuf += chunk.toString();
    let idx;
    while ((idx = _childStdoutBuf.indexOf("\n")) !== -1) {
      const line = _childStdoutBuf.slice(0, idx + 1);
      _childStdoutBuf = _childStdoutBuf.slice(idx + 1);
      handleChildLine(line);
    }
  });
  runtimeInitDone = true;

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

// ─── Pre-init message handlers (no child, no API call) ────────────────────────
// Handles the MCP startup protocol so @playwright/mcp is never spawned until
// an actual browser tools/call arrives.

function writePreInitResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function handlePreInitMessage(msg) {
  const { method, id } = msg;

  if (method === "initialize") {
    writePreInitResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "antigen-browser-adapter", version: ADAPTER_VERSION },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // Notification — no response expected.
    return;
  }

  if (method === "tools/list") {
    writePreInitResponse(id, { tools: STATIC_BROWSER_TOOLS });
    return;
  }

  if (method === "resources/list") {
    writePreInitResponse(id, { resources: [] });
    return;
  }

  if (method === "prompts/list") {
    writePreInitResponse(id, { prompts: [] });
    return;
  }

  if (method === "ping") {
    writePreInitResponse(id, {});
    return;
  }

  // Unknown pre-init message — log and do not respond.
  process.stderr.write(
    `[antigen-browser@${ADAPTER_VERSION}] preinit_message` +
    ` method=${method ?? "unknown"} name=none action=no_runtime\n`
  );
}

// ─── MCP protocol routing ─────────────────────────────────────────────────────
// stdin is line-buffered through a sequential processing queue.
// ensureRuntime() is called ONLY for browser tools/call messages.
// All other pre-init traffic is handled with synthetic responses.

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
  processingQueue.then(() => {
    if (child) child.stdin.end();
  });
});

/**
 * Routes a single line from child.stdout.
 *
 * If the line is a JSON-RPC response whose id is in pendingNavigations, the
 * waiting browser_navigate handler is resolved and this function returns without
 * writing to stdout (the handler owns forwarding). All other lines go to stdout.
 * Malformed non-navigation lines are forwarded as-is to preserve existing behavior.
 */
function handleChildLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.id !== undefined && pendingNavigations.has(parsed.id)) {
      const pending = pendingNavigations.get(parsed.id);
      pendingNavigations.delete(parsed.id);
      pending.resolve({ line, parsed });
      return; // browser_navigate handler owns forwarding — do not write to stdout here
    }
    if (parsed?.id !== undefined && navigateTimedOutIds.has(parsed.id)) {
      // browser_navigate already returned NAVIGATE_CHILD_TIMEOUT for this id.
      // Drop the late child response so we never emit a duplicate response.
      navigateTimedOutIds.delete(parsed.id);
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] navigation_late_child_response_dropped id=${parsed.id}\n`
      );
      return;
    }
  } catch {}
  process.stdout.write(line.endsWith("\n") ? line : line + "\n");
}

// ─── Runtime-session continuity recovery ──────────────────────────────────────
// The backend task-browser session store is in-memory; an API restart wipes it
// while this long-lived adapter keeps a cached browser_runtime_id. Every Antigen
// runtime call then 404s with SESSION_NOT_FOUND. These helpers make that a loud,
// recoverable condition instead of a silent gap: one re-init + one retry, then a
// clear agent-facing error. Recovery is scoped to SESSION_NOT_FOUND only —
// transient network/timeout errors and other API error codes are left untouched.
// NOTE: re-init refreshes only the backend session + browser_runtime_id. It does
// NOT respawn the @playwright/mcp child (the child binds a cdp_url at spawn);
// full child reconciliation is a deeper, separately-scoped concern.

/** Stable, agent-facing message for an unrecoverable stale runtime session. */
function sessionNotFoundMessage(toolName) {
  return (
    `Antigen ${toolName} failed: the browser runtime session was not found and ` +
    `could not be recovered after one re-init. Reinitialize the browser runtime ` +
    `(call get_runtime_browser_endpoint for a fresh browser_runtime_id) and retry.`
  );
}

/**
 * Forces a fresh browser-endpoint fetch to recover a lost backend session and
 * refreshes the module-level browser_runtime_id in place. Returns the fresh
 * browser_runtime_id string on success, or null on failure. Callers must use the
 * returned id for the retry body — never a locally captured stale id. The module
 * mutation is kept so any module-level reader also sees the fresh id. Never calls
 * process.exit — unlike first init, a failed recovery must surface a loud
 * agent-facing error rather than kill the adapter.
 */
async function reinitRuntimeSession() {
  try {
    const res = await fetch(`${BASE}/api/agent/v1/runtime/browser-endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const eb = await res.json().catch(() => ({}));
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] runtime_reinit_failed code=${eb?.error?.code ?? res.status}\n`
      );
      return null;
    }
    const data = (await res.json().catch(() => ({})))?.data ?? {};
    if (typeof data.browser_runtime_id === "string" && data.browser_runtime_id) {
      browser_runtime_id = data.browser_runtime_id;
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] runtime_reinit_ok reused_existing=${data.reused_existing === true}\n`
      );
      return browser_runtime_id;
    }
    process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] runtime_reinit_failed code=NO_RUNTIME_ID\n`);
    return null;
  } catch (_err) {
    process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] runtime_reinit_failed reason=NETWORK_ERROR\n`);
    return null;
  }
}

/**
 * Emits a single stderr continuity diagnostic after a SESSION_NOT_FOUND re-init,
 * proving the retry uses the fresh runtime id rather than the stale captured one.
 * Logs only CLIPPED ids — never cdp_url, paths, or request payloads.
 */
function logRuntimeRetry(tool, oldId, freshId) {
  const retryUsesFresh = freshId != null && freshId !== oldId;
  process.stderr.write(
    `[antigen-browser@${ADAPTER_VERSION}] runtime_retry tool=${tool}` +
    ` reason=SESSION_NOT_FOUND old_runtime_id=${clipRuntimeId(oldId)}` +
    ` new_runtime_id=${clipRuntimeId(freshId)} retry_uses_fresh_runtime_id=${retryUsesFresh}\n`
  );
}

// ─── Tool-surface disposition diagnostics + QA hard mode (dev-only) ────────────
// Make tool-surface routing VISIBLE: which surface handled each browser tool call
// (antigen_adapter backend vs the child @playwright/mcp) and how it resolved. This
// exists because a trace can record navigation while sensitive snapshots/clicks are
// driven through an untraced child/raw Playwright surface on the same browser.
//
// QA hard mode (ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS=true) makes Antigen-owned
// actions FAIL LOUDLY rather than silently fall through to the untraced child.
// When unset, behavior is identical except for these best-effort diagnostics.
//
// noteToolDisposition NEVER changes a tool result and never throws. It always
// writes a sanitized stderr line; it additionally POSTs to the internal
// browser-run-trace disposition route only when ANTIGEN_BROWSER_TRACE=true and a
// browser_runtime_id exists. It logs/posts ONLY: tool name, enum surface, enum
// disposition, short result/error codes, and a CLIPPED runtime id — never cdp_url,
// child args, profile paths, raw payloads, raw URLs/text, refs-with-geometry, or
// any secret.

function antigenHardModeEnabled() {
  return process.env.ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS === "true";
}

// QA-only navigation-discipline hard mode. Separate from REQUIRE_ANTIGEN_TOOLS:
// that flag governs tool ownership (no raw browser_snapshot); this one governs
// whether the agent may shortcut around visible refs with direct browser_navigate.
function realisticNavRequired() {
  return process.env.ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION === "true";
}

// Record a navigation-discipline disposition (Antigen Browser Realism v1). Like
// noteToolDisposition this NEVER changes a tool result and never throws: it
// always writes a sanitized stderr line, and additionally POSTs to the internal
// navigation-disposition route only when ANTIGEN_BROWSER_TRACE=true and a
// runtime id exists. Posts ONLY: tool name, enum disposition, short reason
// string, and host+path-reduced before/after URLs (the backend route strips
// query strings) — never raw query params, coordinates, or secrets.
async function noteNavigationDisposition({ disposition, reason, category, urlBefore, urlAfter }) {
  // Always print the disposition line — this is the unconditional record that the
  // navigate branch reached the disposition call, independent of trace/runtime.
  process.stderr.write(
    `[antigen-browser@${ADAPTER_VERSION}] navigation_disposition` +
    ` disposition=${disposition} reason=${reason ?? "none"} category=${category ?? "none"}` +
    ` runtime_id=${clipRuntimeId(browser_runtime_id)}\n`
  );
  // Skip-reason guards are explicit and ordered so a missing
  // browser_navigation_disposition event in the trace is always explained in
  // stderr. Runtime-id check FIRST (independent of the trace flag) so the
  // no_runtime_id case is visible even when trace is off; trace-flag check next
  // (the most likely live cause — the adapter process not seeing the flag while
  // the API server records navigation_state regardless).
  if (typeof browser_runtime_id !== "string" || browser_runtime_id.length === 0) {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] disposition_post_skipped reason=no_runtime_id\n`
    );
    return;
  }
  if (process.env.ANTIGEN_BROWSER_TRACE !== "true") {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] disposition_post_skipped reason=trace_disabled\n`
    );
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 500);
  try {
    await fetch(
      `${BASE}/api/internal/browser-run-trace/${encodeURIComponent(browser_runtime_id)}/navigation-disposition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          tool: "browser_navigate",
          navigation_disposition: disposition,
          navigation_reason: reason,
          url_before: urlBefore ?? undefined,
          url_after: urlAfter ?? undefined,
        }),
        signal: controller.signal,
      },
    );
  } catch {
    // Best-effort diagnostics — never disrupt the tool path.
  } finally {
    clearTimeout(timeoutId);
  }
}

function logToolDisposition({ tool, surface, disposition, resultCode, errorCode }) {
  process.stderr.write(
    `[antigen-browser@${ADAPTER_VERSION}] tool_disposition` +
    ` tool=${tool} surface=${surface} disposition=${disposition}` +
    ` result=${resultCode ?? "none"} error=${errorCode ?? "none"}` +
    ` runtime_id=${clipRuntimeId(browser_runtime_id)}\n`
  );
}

async function recordToolDisposition({ tool, surface, disposition, resultCode, errorCode }) {
  // Backend recording is gated by the same dev flag as the trace store, and needs
  // a runtime id to key the event. Bounded by a short abort so a slow/hung backend
  // can never stall the tool path.
  if (process.env.ANTIGEN_BROWSER_TRACE !== "true") return;
  if (typeof browser_runtime_id !== "string" || browser_runtime_id.length === 0) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 500);
  try {
    await fetch(
      `${BASE}/api/internal/browser-run-trace/${encodeURIComponent(browser_runtime_id)}/disposition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          tool,
          tool_surface: surface,
          disposition,
          result_code: resultCode,
          error_code: errorCode,
        }),
        signal: controller.signal,
      },
    );
  } catch {
    // Best-effort diagnostics — never disrupt the tool path.
  } finally {
    clearTimeout(timeoutId);
  }
}

async function noteToolDisposition(args) {
  logToolDisposition(args);
  await recordToolDisposition(args).catch(() => {});
}

/**
 * True only for a 404 whose error code is SESSION_NOT_FOUND (reads a clone).
 *
 * Deliberately narrow: only SESSION_NOT_FOUND drives the one-shot reinit+retry in
 * antigenRuntimePost. The ref-consuming endpoints (browser_click/type/scroll) return
 * RUNTIME_SESSION_CHANGED (409) when the runtime changed under a stale ag_* ref —
 * that is agent-recoverable but must NOT be auto-retried here, because retrying with
 * the same stale ref would either fail again or act on the wrong element. Correct
 * recovery for RUNTIME_SESSION_CHANGED is: reinitialize the runtime if needed, take a
 * fresh antigen_snapshot, then act on the new refs. Do not add it to this matcher.
 */
async function isSessionNotFound(apiRes) {
  if (apiRes.status !== 404) return false;
  const eb = await apiRes.clone().json().catch(() => ({}));
  return eb?.error?.code === "SESSION_NOT_FOUND";
}

/**
 * POSTs to an Antigen runtime endpoint. The helper OWNS injecting
 * browser_runtime_id at send time, so callers pass a body WITHOUT the id and can
 * never accidentally capture a stale one. On a 404 SESSION_NOT_FOUND, forces
 * exactly one runtime re-init and retries the call once using the FRESH id
 * returned by reinitRuntimeSession() (never the stale id from the first attempt).
 * Returns the final Response — a persistent SESSION_NOT_FOUND comes back as a 404
 * the caller surfaces loudly, and the retry's 404 is what produces the backend
 * browser_tool_rejected trace event. Adapter-owned tools must NOT fall through to
 * the @playwright/mcp child on this failure.
 *
 * @param {string} path
 * @param {object} bodyWithoutRuntimeId  body fields excluding browser_runtime_id
 * @param {{ tool?: string }} [options]  tool name for the continuity diagnostic
 */
async function antigenRuntimePost(path, bodyWithoutRuntimeId, options = {}) {
  const send = (rid) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...bodyWithoutRuntimeId, browser_runtime_id: rid }),
    });

  const oldId = browser_runtime_id;
  let apiRes = await send(oldId);
  if (await isSessionNotFound(apiRes)) {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] session_not_found path=${path} action=reinit_retry\n`
    );
    const freshId = await reinitRuntimeSession();
    logRuntimeRetry(options.tool ?? path, oldId, freshId);
    // Retry with the fresh id; never reuse the stale oldId. Fall back to the
    // module-level id only if reinit returned null (so the retry still 404s loudly
    // rather than throwing on an undefined id).
    apiRes = await send(freshId ?? browser_runtime_id);
  }
  return apiRes;
}

/**
 * Calls POST /api/agent/v1/runtime/browser-navigation-state to update current_url
 * and persist a navigation_proxy pointer state. Awaited with a 400ms timeout.
 * Returns a result object: { ok: true } on success; { ok: false, reason } otherwise.
 * SESSION_NOT_FOUND triggers exactly one re-init + retry; a persistent
 * SESSION_NOT_FOUND is reported so browser_navigate fails loudly instead of
 * reporting routine success. Transient TIMEOUT / NETWORK_ERROR and other API
 * errors stay soft (caller does not block navigation on them).
 */
async function updateNavigationPointerState(runtimeId, url) {
  const attempt = async (rid) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 400);
    try {
      const res = await fetch(`${BASE}/api/agent/v1/runtime/browser-navigation-state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ browser_runtime_id: rid, url, action: "navigation_proxy" }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const source = body?.data?.pointer_start_source ?? "unknown";
        process.stderr.write(
          `[antigen-browser@${ADAPTER_VERSION}] navigation_state_update` +
          ` ok=true pointer_start_source=${source}\n`
        );
        return { ok: true };
      }
      if (await isSessionNotFound(res)) {
        process.stderr.write(
          `[antigen-browser@${ADAPTER_VERSION}] navigation_state_update ok=false reason=SESSION_NOT_FOUND\n`
        );
        return { ok: false, reason: "SESSION_NOT_FOUND" };
      }
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] navigation_state_update ok=false code=${res.status}\n`
      );
      return { ok: false, reason: "API_ERROR" };
    } catch (_err) {
      clearTimeout(timeoutId);
      const reason = _err?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] navigation_state_update_error reason=${reason}\n`
      );
      return { ok: false, reason };
    }
  };

  let result = await attempt(runtimeId);
  if (result.reason === "SESSION_NOT_FOUND") {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] session_not_found path=/api/agent/v1/runtime/browser-navigation-state action=reinit_retry\n`
    );
    const freshId = await reinitRuntimeSession();
    logRuntimeRetry("browser_navigation_state", runtimeId, freshId);
    // Retry with the fresh id; never reuse the stale runtimeId parameter.
    result = await attempt(freshId ?? browser_runtime_id);
  }
  return result;
}

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
 * Writes a synthetic MCP tools/call error response to stdout.
 * stdout is MCP protocol only — never write diagnostics here.
 * Never includes: raw text values, cdp_url, cookies, storage, or selectors.
 */
function writeSyntheticErrorResponse(toolName, requestId, code, message) {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    result: {
      content: [{ type: "text", text: `Antigen ${toolName} unavailable: code=${code}; ${message}` }],
      isError: true,
    },
  });
  process.stdout.write(response + "\n");
}

/**
 * Shared handler for the EXACT-REPLACEMENT field tools: browser_fill,
 * browser_set_value, and browser_clear. All three route to the Antigen backend's
 * /browser-set-value endpoint (exact replace + read-back verify), NOT the append
 * /browser-type endpoint. Ref-only and Antigen-owned: there is intentionally NO
 * @playwright/mcp fallthrough — the native @playwright/mcp fill is an append path
 * and silently falling back to it is exactly the bug this replaces. Sensitive
 * fields are refused by the backend (SENSITIVE_FIELD_REQUIRES_INJECTION) and
 * routed to the credential injection path. The requested/actual value is never
 * logged (only a char-count bucket).
 */
async function handleExactSetValue(toolName, msg) {
  const requestId = msg.id;
  const args = msg?.params?.arguments ?? {};
  // browser_clear sets the empty string; fill/set_value take `value`.
  const value = toolName === "browser_clear" ? "" : (args.value ?? "");
  const ref = args.ref ?? "";
  const selectByLabel = args.select_by_label === true;
  const argKeys = Object.keys(args).join(",");
  const bucket = charCountBucket(String(value).length);

  process.stderr.write(
    `[antigen-browser@${ADAPTER_VERSION}] exact_set_value_attempt source=${toolName}` +
    ` arg_keys=${argKeys} char_count_bucket=${bucket}\n`,
  );

  try {
    const body = { value: String(value) };
    if (typeof ref === "string" && ref.length > 0) body.ref = ref;
    if (selectByLabel) body.select_by_label = true;
    const apiRes = await antigenRuntimePost(
      "/api/agent/v1/runtime/browser-set-value",
      body,
      { tool: toolName },
    );

    if (apiRes.ok) {
      const resBody = await apiRes.json().catch(() => ({}));
      const d = resBody?.data ?? {};
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] exact_set_value_success source=${toolName}` +
        ` changed=${d.changed} verified=${d.verified}\n`,
      );
      await noteToolDisposition({ tool: toolName, surface: "antigen_adapter", disposition: "antigen_backend", resultCode: "success" });
      writeSyntheticResponse(
        requestId,
        buildSyntheticSuccessText(toolName, {
          changed: d.changed,
          verified: d.verified,
          actualValue: typeof d.actual_value === "string" ? d.actual_value : undefined,
          elementKind: d.element_kind,
          version: ADAPTER_VERSION,
        }),
      );
      return;
    }

    const errBody = await apiRes.json().catch(() => ({}));
    const errCode = errBody?.error?.code ?? String(apiRes.status);
    const errMsg = errBody?.error?.message ?? `Antigen ${toolName} failed (${errCode}).`;
    process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] exact_set_value_error reason=${errCode} source=${toolName}\n`);
    await noteToolDisposition({ tool: toolName, surface: "antigen_adapter", disposition: "failed", errorCode: String(errCode) });
    // No @playwright/mcp fallthrough — exact replacement must stay Antigen-owned.
    writeSyntheticErrorResponse(
      toolName,
      requestId,
      errCode,
      errCode === "SESSION_NOT_FOUND" ? sessionNotFoundMessage(toolName) : errMsg,
    );
  } catch (_err) {
    process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] exact_set_value_error reason=INTERCEPT_ERROR source=${toolName}\n`);
    await noteToolDisposition({ tool: toolName, surface: "antigen_adapter", disposition: "failed", errorCode: "ANTIGEN_SET_VALUE_INTERCEPT_ERROR" });
    writeSyntheticErrorResponse(
      toolName,
      requestId,
      "ANTIGEN_SET_VALUE_INTERCEPT_ERROR",
      `Antigen ${toolName} encountered a network error.`,
    );
  }
}

/**
 * Routes a single JSON-RPC line.
 *
 * Gate: ensureRuntime() is called ONLY when method === "tools/call" and
 * params.name starts with "browser_". All other messages are handled locally
 * (pre-init) or forwarded to the child (post-init).
 *
 * Never silently drops a line that can be handled.
 */
async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    // Malformed JSON — forward to child if ready, otherwise drop.
    if (child) {
      child.stdin.write(line);
    } else {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] preinit_malformed_json action=dropped\n`);
    }
    return;
  }

  const method = msg?.method;
  const name = msg?.params?.name;
  const isBrowserToolCall =
    method === "tools/call" &&
    typeof name === "string" &&
    name.startsWith("browser_");
  // antigen_snapshot is adapter-owned (not a browser_ tool and not a Playwright
  // tool). It still needs a browser runtime, so it routes through ensureRuntime()
  // and is handled locally — never forwarded to @playwright/mcp.
  const isAntigenSnapshot = method === "tools/call" && name === "antigen_snapshot";
  const needsRuntime = isBrowserToolCall || isAntigenSnapshot;

  // Emit a diagnostic for every message processed before runtime is ready.
  if (!runtimeInitDone) {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] preinit_message` +
      ` method=${method ?? "unknown"}` +
      ` name=${name ?? "none"}` +
      ` action=${needsRuntime ? "ensure_runtime" : "no_runtime"}\n`
    );
  }

  if (!needsRuntime) {
    if (runtimeInitDone) {
      // Child is ready — pass non-browser messages through.
      child.stdin.write(line);
    } else {
      // Pre-init: handle with synthetic MCP responses, no side effects.
      handlePreInitMessage(msg);
    }
    return;
  }

  // ── Adapter-owned / browser tools/call — init runtime if not yet done ──────
  await ensureRuntime();

  const toolName = name;

  // ── antigen_snapshot: adapter-owned — never forwarded to @playwright/mcp ────
  // Calls the Antigen backend snapshot endpoint and returns a readable, safe
  // ag_* ref listing. Allowlist-formatted: no coordinates, boxes, cdp_url,
  // cookies, storage, raw DOM, or secrets ever reach the agent.
  if (toolName === "antigen_snapshot") {
    const requestId = msg.id;
    const maxCandidates = msg?.params?.arguments?.max_candidates ?? 200;
    const viewportOnly = msg?.params?.arguments?.viewport_only !== false;

    if (!browser_runtime_id) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] antigen_snapshot_unavailable reason=no_runtime\n`
      );
      writeSyntheticErrorResponse(
        "antigen_snapshot",
        requestId,
        "ANTIGEN_REALISM_UNAVAILABLE",
        "Antigen snapshot requires a valid Aegis browser session.",
      );
      return;
    }

    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] antigen_snapshot_attempt` +
      ` max_candidates=${maxCandidates} viewport_only=${viewportOnly}\n`
    );

    try {
      const apiRes = await antigenRuntimePost(
        "/api/agent/v1/runtime/browser-snapshot",
        {
          action: "dom_snapshot",
          max_candidates: maxCandidates,
          viewport_only: viewportOnly,
        },
        { tool: "antigen_snapshot" },
      );

      if (apiRes.ok) {
        const resBody = await apiRes.json().catch(() => ({}));
        const data = resBody?.data ?? {};
        process.stderr.write(
          `[antigen-browser@${ADAPTER_VERSION}] antigen_snapshot_success` +
          ` element_count=${data?.element_count ?? 0}\n`
        );
        await noteToolDisposition({ tool: "antigen_snapshot", surface: "antigen_adapter", disposition: "antigen_backend", resultCode: "success" });
        // Adopt the runtime id this snapshot actually bound to. After a server-side
        // rebind (our cached id pointed at a closed/relaunched runtime) the snapshot
        // is captured against the delegation's current ready runtime; updating our
        // cached id keeps subsequent ref actions pointed at the live runtime instead
        // of re-triggering a rebind on every call. Metadata only — clipped ids.
        if (
          typeof data.browser_runtime_id === "string" &&
          data.browser_runtime_id &&
          data.browser_runtime_id !== browser_runtime_id
        ) {
          process.stderr.write(
            `[antigen-browser@${ADAPTER_VERSION}] runtime_rebound` +
            ` old_runtime_id=${clipRuntimeId(browser_runtime_id)}` +
            ` new_runtime_id=${clipRuntimeId(data.browser_runtime_id)} rebound=${data.rebound === true}\n`
          );
          browser_runtime_id = data.browser_runtime_id;
        }
        // Cache a compact, safe set of navigation hints so the next
        // browser_navigate can tell a shortcut deeplink from a legitimate jump.
        // Derivation reads allowlisted page-map fields only; never throws into
        // the tool path.
        try {
          lastNavHints = deriveNavHintsFromSnapshot(data);
          lastNavHintsAt = Date.now();
        } catch {
          lastNavHints = null;
        }
        writeSyntheticResponse(requestId, buildAntigenSnapshotText(data, ADAPTER_VERSION));
        return;
      }

      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? String(apiRes.status);
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] antigen_snapshot_error reason=${errCode}\n`
      );
      await noteToolDisposition({ tool: "antigen_snapshot", surface: "antigen_adapter", disposition: "failed", errorCode: String(errCode) });
      writeSyntheticErrorResponse(
        "antigen_snapshot",
        requestId,
        errCode,
        errCode === "SESSION_NOT_FOUND"
          ? sessionNotFoundMessage("antigen_snapshot")
          : `Antigen snapshot failed (${errCode}).`,
      );
    } catch (_err) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] antigen_snapshot_error reason=INTERCEPT_ERROR\n`
      );
      await noteToolDisposition({ tool: "antigen_snapshot", surface: "antigen_adapter", disposition: "failed", errorCode: "ANTIGEN_SNAPSHOT_INTERCEPT_ERROR" });
      writeSyntheticErrorResponse(
        "antigen_snapshot",
        requestId,
        "ANTIGEN_SNAPSHOT_INTERCEPT_ERROR",
        "Antigen snapshot encountered a network error.",
      );
    }
    return;
  }

  // ── browser_scroll_to_ref: adapter-owned — never forwarded to @playwright/mcp ─
  // Scrolls an offscreen ag_* ref near the viewport so the agent can take a fresh
  // antigen_snapshot before clicking. SCROLL ONLY: the backend never clicks and
  // never returns coordinates/box/cdp_url. Not gated on INTERCEPTION_ENABLED — a
  // programmatic scroll carries no pointer-realism concern. The adapter supplies
  // browser_runtime_id internally; the agent only passes a ref.
  if (toolName === "browser_scroll_to_ref") {
    const requestId = msg.id;
    const refArg = msg?.params?.arguments?.ref ?? "";

    if (!browser_runtime_id) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_scroll_to_ref_unavailable reason=no_runtime\n`
      );
      writeSyntheticErrorResponse(
        "browser_scroll_to_ref",
        requestId,
        "ANTIGEN_REALISM_UNAVAILABLE",
        "Antigen browser_scroll_to_ref requires a valid Aegis browser session.",
      );
      return;
    }

    if (typeof refArg !== "string" || !/^ag_\d+$/.test(refArg)) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_scroll_to_ref_error reason=ANTIGEN_REF_INVALID\n`
      );
      writeSyntheticErrorResponse(
        "browser_scroll_to_ref",
        requestId,
        "ANTIGEN_REF_INVALID",
        "Antigen browser_scroll_to_ref requires an Antigen ref such as ag_47 from antigen_snapshot.",
      );
      return;
    }

    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] browser_scroll_to_ref_attempt ref=${refArg}\n`
    );

    try {
      const apiRes = await antigenRuntimePost(
        "/api/agent/v1/runtime/browser-scroll-to-ref",
        { ref: refArg },
        { tool: "browser_scroll_to_ref" },
      );

      if (apiRes.ok) {
        process.stderr.write(
          `[antigen-browser@${ADAPTER_VERSION}] browser_scroll_to_ref_success ref=${refArg}\n`
        );
        await noteToolDisposition({ tool: "browser_scroll_to_ref", surface: "antigen_adapter", disposition: "antigen_backend", resultCode: "success" });
        writeSyntheticResponse(
          requestId,
          buildSyntheticSuccessText("browser_scroll_to_ref", { ref: refArg, version: ADAPTER_VERSION }),
        );
        return;
      }

      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? String(apiRes.status);
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_scroll_to_ref_error reason=${errCode}\n`
      );
      await noteToolDisposition({ tool: "browser_scroll_to_ref", surface: "antigen_adapter", disposition: "failed", errorCode: String(errCode) });
      const scrollErrMsg =
        errCode === "SESSION_NOT_FOUND"
          ? sessionNotFoundMessage("browser_scroll_to_ref")
          : errCode === "ANTIGEN_REF_NOT_FOUND"
          ? "Antigen browser_scroll_to_ref failed: the ag_* ref was not found in the latest snapshot. Take a fresh antigen_snapshot and retry."
          : errCode === "ANTIGEN_REF_EXPIRED"
          ? "Antigen browser_scroll_to_ref failed: the Antigen snapshot has expired. Take a fresh antigen_snapshot and retry."
          : errCode === "ANTIGEN_REF_NOT_SCROLLABLE"
          ? "Antigen browser_scroll_to_ref failed: the ag_* ref has no scrollable geometry. Take a fresh antigen_snapshot and retry."
          : errCode === "ANTIGEN_SCROLL_FAILED"
          ? "Antigen browser_scroll_to_ref failed: the page could not be scrolled. Take a fresh antigen_snapshot and retry."
          : `Antigen browser_scroll_to_ref failed (${errCode}).`;
      writeSyntheticErrorResponse("browser_scroll_to_ref", requestId, errCode, scrollErrMsg);
    } catch (_err) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_scroll_to_ref_error reason=INTERCEPT_ERROR\n`
      );
      await noteToolDisposition({ tool: "browser_scroll_to_ref", surface: "antigen_adapter", disposition: "failed", errorCode: "ANTIGEN_SCROLL_INTERCEPT_ERROR" });
      writeSyntheticErrorResponse(
        "browser_scroll_to_ref",
        requestId,
        "ANTIGEN_SCROLL_INTERCEPT_ERROR",
        "Antigen browser_scroll_to_ref encountered a network error.",
      );
    }
    return;
  }

  // ── browser_click: adapter-owned — never forwarded to @playwright/mcp ───────
  // @playwright/mcp's real schema requires a "target" field that our static
  // schema does not advertise. Forwarding browser_click always produces a Zod
  // validation error (path: ["target"]). The adapter is the sole handler:
  // realistic success or a clean MCP error. No fallthrough.
  if (toolName === "browser_click") {
    const argKeys    = Object.keys(msg?.params?.arguments ?? {}).join(",");
    const elementArg = msg?.params?.arguments?.element ?? "";
    const targetArg  = msg?.params?.arguments?.target ?? "";
    const refArg     = msg?.params?.arguments?.ref ?? "";
    const requestId  = msg.id;

    // element_description: prefer args.element, then args.target as plain text
    const elementDescription = elementArg || targetArg || "";
    // selector_hint: only when args.target or args.ref looks like a real CSS selector
    // snapshot refs like "e32" or "a2309" do not pass looksLikeSelector
    const selectorHint =
      looksLikeSelector(targetArg) ? targetArg :
      looksLikeSelector(refArg)    ? refArg :
      undefined;

    if (!INTERCEPTION_ENABLED) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_click_unavailable` +
        ` reason=interception_disabled arg_keys=${argKeys}\n`
      );
      writeSyntheticErrorResponse(
        "browser_click",
        requestId,
        "ANTIGEN_REALISM_UNAVAILABLE",
        "Antigen realistic browser_click requires ANTIGEN_BROWSER_HEADLESS=false and a valid Aegis browser session.",
      );
      return;
    }

    const hasAntigenRef = typeof refArg === "string" && /^ag_\d+$/.test(refArg);

    if (!elementDescription && !selectorHint && !hasAntigenRef) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_click_error` +
        ` reason=ANTIGEN_CLICK_TARGET_REQUIRED arg_keys=${argKeys}\n`
      );
      writeSyntheticErrorResponse(
        "browser_click",
        requestId,
        "ANTIGEN_CLICK_TARGET_REQUIRED",
        "Antigen realistic browser_click requires element, target, or a CSS selector hint.",
      );
      return;
    }

    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] realistic_click_attempt` +
      ` arg_keys=${argKeys}` +
      (selectorHint ? " hint=selector" : " hint=description") + "\n"
    );

    try {
      // Antigen exact-ref path: pass an ag_<n> ref straight through to the
      // backend, which resolves it against the latest snapshot and clicks the
      // stored box via the realistic pointer runtime. The adapter never resolves
      // the ref, never touches Playwright, and never receives coordinates.
      const clickBody = { element_description: elementDescription };
      if (selectorHint) clickBody.selector_hint = selectorHint;
      if (typeof refArg === "string" && /^ag_\d+$/.test(refArg)) clickBody.ref = refArg;

      const apiRes = await antigenRuntimePost(
        "/api/agent/v1/runtime/browser-click",
        clickBody,
        { tool: "browser_click" },
      );

      if (apiRes.ok) {
        const resBody                  = await apiRes.json().catch(() => ({}));
        // Capability-state gate: a 200 with mode=blocked_by_antigen_platform means
        // Antigen classified this as a final / irreversible / identity-committing
        // action and DID NOT dispatch the pointer. Surface it as an explicit error
        // so the agent never believes the click happened, and point at the handoff
        // that performs the action safely under Antigen custody.
        if (resBody?.data?.mode === "blocked_by_antigen_platform") {
          const intent  = resBody.data.action_intent ?? "sensitive_action";
          const handoff = resBody.data.recommended_handoff ?? "sensitive_workflow_required";
          process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] blocked_by_antigen_platform intent=${intent} handoff=${handoff}\n`);
          await noteToolDisposition({ tool: "browser_click", surface: "antigen_adapter", disposition: "blocked_by_antigen_platform", resultCode: intent });
          const directive = handoff === "sensitive_workflow_required"
            ? "It requires user approval through a verified Aegis sensitive workflow. Do not retry browser_click on this target."
            : `Call ${handoff} to perform this safely under Antigen custody. Do not retry browser_click on this target.`;
          writeSyntheticErrorResponse(
            "browser_click",
            requestId,
            "BLOCKED_BY_ANTIGEN_PLATFORM",
            `the pointer was NOT dispatched. This action is classified as '${intent}' (final/irreversible or identity-committing). ${directive}`,
          );
          return;
        }
        const resPointerCount          = resBody?.data?.pointer_path_point_count;
        const resPointerStartSource    = resBody?.data?.pointer_start_source;
        const resPointerStatePersisted = resBody?.data?.pointer_state_persisted;
        process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_click_success\n`);
        await noteToolDisposition({ tool: "browser_click", surface: "antigen_adapter", disposition: "antigen_backend", resultCode: "success" });
        writeSyntheticResponse(
          requestId,
          buildSyntheticSuccessText("browser_click", {
            hint: selectorHint ? "selector" : "description",
            pointerPathPointCount: resPointerCount,
            pointerStartSource: resPointerStartSource,
            pointerStatePersisted: resPointerStatePersisted,
            version: ADAPTER_VERSION,
          }),
        );
        return;
      }

      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? String(apiRes.status);
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] browser_click_error reason=${errCode}\n`);
      // browser_click is sole-handler (no @playwright/mcp fallthrough), so an
      // Antigen failure is already loud in any mode — record it as `failed`.
      await noteToolDisposition({ tool: "browser_click", surface: "antigen_adapter", disposition: "failed", errorCode: String(errCode) });
      // Phase 4B/4C: a stale ag_* ref means the page shifted since the snapshot;
      // an out-of-viewport ag_* ref means the stored target is offscreen. In both
      // cases tell the agent how to recover rather than reporting a generic
      // failure. Never surfaces coordinates or live DOM.
      const clickErrMsg = errCode === "SESSION_NOT_FOUND"
        ? sessionNotFoundMessage("browser_click")
        : errCode === "ANTIGEN_REF_PAGE_CHANGED"
        ? "Antigen realistic browser_click failed: the page navigated since this snapshot, so the ag_* ref is no longer valid. Take a new antigen_snapshot and retry."
        : errCode === "ANTIGEN_REF_OUT_OF_VIEWPORT"
        ? "Antigen realistic browser_click failed: the ag_* ref is outside the current viewport. Scroll the target into view, take a new antigen_snapshot, and retry."
        : errCode === "ANTIGEN_REF_STALE"
        ? "Antigen realistic browser_click failed: the ag_* ref is stale (the page changed since the snapshot). Take a new antigen_snapshot and retry."
        : `Antigen realistic browser_click failed (${errCode}).`;
      writeSyntheticErrorResponse(
        "browser_click",
        requestId,
        errCode,
        clickErrMsg,
      );
    } catch (_err) {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] browser_click_error reason=INTERCEPT_ERROR\n`);
      await noteToolDisposition({ tool: "browser_click", surface: "antigen_adapter", disposition: "failed", errorCode: "ANTIGEN_CLICK_INTERCEPT_ERROR" });
      writeSyntheticErrorResponse(
        "browser_click",
        requestId,
        "ANTIGEN_CLICK_INTERCEPT_ERROR",
        "Antigen realistic browser_click encountered a network error.",
      );
    }
    return;
  }

  // ── browser_fill / browser_set_value / browser_clear: EXACT replacement ─────
  // Adapter-owned exact-replacement field set. Routes to /browser-set-value (NOT
  // the append /browser-type path) and never falls through to @playwright/mcp:
  // its native fill appends, which is the corruption bug this replaces. When
  // interception is disabled there is no Aegis runtime, so surface a clear error.
  if (toolName === "browser_fill" || toolName === "browser_set_value" || toolName === "browser_clear") {
    if (!INTERCEPTION_ENABLED) {
      writeSyntheticErrorResponse(
        toolName,
        msg.id,
        "ANTIGEN_REALISM_UNAVAILABLE",
        `Antigen ${toolName} requires ANTIGEN_BROWSER_HEADLESS=false and a valid Aegis browser session.`,
      );
      return;
    }
    await handleExactSetValue(toolName, msg);
    return;
  }

  // ── browser_type: adapter-owned — never forwarded to @playwright/mcp ─────
  // @playwright/mcp's real schema requires a "target" field that our static
  // schema does not advertise. Forwarding browser_type to @playwright/mcp
  // always produces a Zod validation error (path: ["target"]). The adapter
  // is the sole handler: realistic success or a clear MCP error. No fallthrough.
  if (toolName === "browser_type") {
    const typeText    = msg?.params?.arguments?.text ?? "";
    const typeElement = msg?.params?.arguments?.element ?? "";
    const typeRef     = msg?.params?.arguments?.ref ?? "";
    const typeSubmit  = msg?.params?.arguments?.submit === true;
    const argKeys     = Object.keys(msg?.params?.arguments ?? {}).join(",");
    const requestId   = msg.id;
    const bucket      = charCountBucket(typeText.length);
    const hasTarget   = typeElement.length > 0;
    const selectorHint = looksLikeSelector(typeRef) ? typeRef : undefined;

    if (!INTERCEPTION_ENABLED) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_type_unavailable` +
        ` reason=interception_disabled arg_keys=${argKeys}\n`
      );
      writeSyntheticErrorResponse(
        "browser_type",
        requestId,
        "ANTIGEN_REALISM_UNAVAILABLE",
        "Antigen realistic browser_type requires ANTIGEN_BROWSER_HEADLESS=false and a valid Aegis browser session.",
      );
      return;
    }

    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] realistic_type_attempt source=browser_type` +
      ` arg_keys=${argKeys} char_count_bucket=${bucket}` +
      ` has_target=${hasTarget} submit=${typeSubmit}\n`
    );

    try {
      const typeBody = { text: typeText, submit: typeSubmit };
      if (hasTarget) typeBody.element_description = typeElement;
      if (selectorHint) typeBody.selector_hint = selectorHint;
      // Antigen exact-ref path: forward an ag_<n> ref straight through to the
      // backend, which resolves it against the latest snapshot and types into the
      // stored box via the realistic known-box typing runtime — mirroring
      // browser_click. The adapter never resolves the ref or touches Playwright.
      // Non-ag refs (CSS selectors) still route through selector_hint above.
      if (typeof typeRef === "string" && /^ag_\d+$/.test(typeRef)) typeBody.ref = typeRef;

      const apiRes = await antigenRuntimePost(
        "/api/agent/v1/runtime/browser-type",
        typeBody,
        { tool: "browser_type" },
      );

      if (apiRes.ok) {
        const resBody      = await apiRes.json().catch(() => ({}));
        const resBucket              = resBody?.data?.char_count_bucket ?? bucket;
        const resFocused             = resBody?.data?.focused;
        const resSubmitted           = resBody?.data?.submitted;
        const resSubmitMethod        = resBody?.data?.submit_method;
        const resPointerCount        = resBody?.data?.pointer_path_point_count;
        const resPointerStartSource  = resBody?.data?.pointer_start_source;
        const resPointerStatePersisted = resBody?.data?.pointer_state_persisted;
        process.stderr.write(
          `[antigen-browser@${ADAPTER_VERSION}] realistic_type_success source=browser_type` +
          ` char_count_bucket=${resBucket} has_target=${hasTarget} submit=${typeSubmit}\n`
        );
        await noteToolDisposition({ tool: "browser_type", surface: "antigen_adapter", disposition: "antigen_backend", resultCode: "success" });
        writeSyntheticResponse(
          requestId,
          buildSyntheticSuccessText("browser_type", {
            bucket: resBucket,
            focused: resFocused,
            submitted: resSubmitted,
            submitMethod: resSubmitMethod,
            pointerPathPointCount: resPointerCount,
            pointerStartSource: resPointerStartSource,
            pointerStatePersisted: resPointerStatePersisted,
            version: ADAPTER_VERSION,
          }),
        );
        return;
      }

      const errBody = await apiRes.json().catch(() => ({}));
      const errCode = errBody?.error?.code ?? String(apiRes.status);
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_type_error reason=${errCode} source=browser_type\n`
      );
      await noteToolDisposition({ tool: "browser_type", surface: "antigen_adapter", disposition: "failed", errorCode: String(errCode) });
      writeSyntheticErrorResponse(
        "browser_type",
        requestId,
        errCode,
        errCode === "SESSION_NOT_FOUND"
          ? sessionNotFoundMessage("browser_type")
          : `Antigen realistic browser_type failed (${errCode}).`,
      );
    } catch (_err) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_type_error reason=INTERCEPT_ERROR source=browser_type\n`
      );
      await noteToolDisposition({ tool: "browser_type", surface: "antigen_adapter", disposition: "failed", errorCode: "ANTIGEN_TYPE_INTERCEPT_ERROR" });
      writeSyntheticErrorResponse(
        "browser_type",
        requestId,
        "ANTIGEN_TYPE_INTERCEPT_ERROR",
        "Antigen realistic browser_type encountered a network error.",
      );
    }
    return;
  }

  // ── browser_navigate: Antigen owns pointer continuity ─────────────────────
  // Actual page load is delegated to @playwright/mcp. After the child responds
  // successfully, Antigen updates current_url and persists a navigation_proxy
  // pointer state so the next browser_type/browser_click starts from session state.
  // This is always-on for Antigen-managed sessions — session continuity, not evasion.
  if (toolName === "browser_navigate") {
    const navigateUrl = msg?.params?.arguments?.url ?? "";
    const requestId = msg.id;

    // Unconditional proof-of-entry — fires for EVERY browser_navigate before any
    // preflight, disposition, or child forward, regardless of trace flag / runtime
    // id. If a navigation appears in the trace as navigation_state but produces no
    // browser_navigation_disposition, this line (plus the later
    // disposition_post_skipped reason=…) explains where the disposition was lost.
    // Sanitized: clipped runtime id only — never the raw URL, query string, token,
    // or cdp_url.
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] browser_navigate_handler_entered` +
      ` request_id=${requestId}` +
      ` runtime_id=${browser_runtime_id ? clipRuntimeId(browser_runtime_id) : "none"}\n`
    );

    // ── Navigation discipline pre-flight (Antigen Browser Realism v1) ─────────
    // Decide BEFORE forwarding to the child whether this direct navigation is an
    // acceptable jump or a shortcut around visible refs. A blocked decision (only
    // possible in QA hard mode) must short-circuit here so the navigation can
    // NEVER reach child.stdin — a blocked shortcut cannot leak through the child.
    // Stale/missing snapshot hints are treated as no hints (never block on them).
    const navHintsFresh =
      lastNavHints && Date.now() - lastNavHintsAt <= NAV_HINTS_TTL_MS ? lastNavHints : null;
    const navDecision = classifyNavigationDiscipline({
      targetUrl: navigateUrl,
      currentUrl,
      isFirstNavigation: currentUrl === null,
      navHints: navHintsFresh,
      hardMode: realisticNavRequired(),
    });
    // Sanitized preflight diagnostics — proves the preflight ran for THIS
    // navigate before any child.stdin.write. Host+path only; never the raw URL,
    // query string, coordinates, cookies, storage, or secrets.
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] navigate_preflight` +
      ` target=${sanitizeHostPath(navigateUrl) || "none"}` +
      ` current=${sanitizeHostPath(currentUrl) || "none"}` +
      ` hard_mode=${realisticNavRequired()}` +
      ` fresh_nav_hints=${navHintsFresh !== null}` +
      ` decision=${navDecision.decision}` +
      ` disposition=${navDecision.disposition}` +
      ` reason=${navDecision.reason ?? "none"}` +
      ` category=${navDecision.category ?? "none"}` +
      ` will_forward_to_child=${navDecision.decision !== "block"}\n`
    );
    if (navDecision.decision === "block") {
      await noteNavigationDisposition({
        disposition: navDecision.disposition,
        reason: navDecision.reason,
        category: navDecision.category,
        urlBefore: currentUrl,
        urlAfter: navigateUrl,
      });
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_navigate_blocked reason=${navDecision.reason}\n`
      );
      writeSyntheticErrorResponse(
        "browser_navigate",
        requestId,
        "ANTIGEN_REALISTIC_NAVIGATION_REQUIRED",
        navigationBlockMessage(navDecision.category),
      );
      return;
    }
    // Allowed (clean or warned) — record the disposition for trace visibility,
    // then proceed with the normal forward-to-child flow unchanged.
    await noteNavigationDisposition({
      disposition: navDecision.disposition,
      reason: navDecision.reason,
      category: navDecision.category,
      urlBefore: currentUrl,
      urlAfter: navigateUrl,
    });

    // Register pending navigation — handleChildLine will resolve this when child responds.
    let resolveChildResponse;
    const childResponsePromise = new Promise((resolve) => {
      resolveChildResponse = resolve;
    });
    pendingNavigations.set(requestId, { url: navigateUrl, resolve: resolveChildResponse });

    // INVARIANT: noteNavigationDisposition (above) MUST run before this is the
    // ONLY child.stdin.write reachable for browser_navigate. The block path returns
    // before forwarding; this allow path forwards only after the disposition call.
    // Do not move this write above the disposition call or add another navigate
    // forward path. (Guarded by the ordering test in antigen-browser-adapter.test.mjs.)
    // Forward to @playwright/mcp for actual page load.
    child.stdin.write(line);

    // Wait for the child response, guarded by a generous safety-net timeout that
    // only fires if the child is genuinely hung/dead (see NAVIGATE_CHILD_TIMEOUT_MS).
    const CHILD_TIMEOUT_SENTINEL = Symbol("child_timeout");
    let childTimeoutId;
    const childTimeoutPromise = new Promise((resolve) => {
      childTimeoutId = setTimeout(() => resolve(CHILD_TIMEOUT_SENTINEL), NAVIGATE_CHILD_TIMEOUT_MS);
    });

    const childResult = await Promise.race([childResponsePromise, childTimeoutPromise]);
    clearTimeout(childTimeoutId);

    if (childResult === CHILD_TIMEOUT_SENTINEL) {
      // Child never responded within the safety-net window — clean up and surface an
      // error. Record the id so a late child response is dropped (no duplicate).
      pendingNavigations.delete(requestId);
      navigateTimedOutIds.add(requestId);
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] navigation_child_timeout id=${requestId}\n`
      );
      await noteToolDisposition({ tool: "browser_navigate", surface: "adapter_child_playwright", disposition: "failed", errorCode: "NAVIGATE_CHILD_TIMEOUT" });
      writeSyntheticErrorResponse(
        "browser_navigate",
        requestId,
        "NAVIGATE_CHILD_TIMEOUT",
        "Navigation response timed out.",
      );
      return;
    }

    const { line: childLine, parsed: childParsed } = childResult;
    const isError = childParsed?.result?.isError === true;

    // On successful navigation, update pointer state synchronously (short timeout).
    // This must complete before forwarding the response so Cowork's next action
    // sees pointer_start_source=session rather than viewport_center.
    if (!isError && browser_runtime_id) {
      const navState = await updateNavigationPointerState(browser_runtime_id, navigateUrl);
      if (navState && navState.ok === false && navState.reason === "SESSION_NOT_FOUND") {
        // Persistent stale runtime session after one re-init + retry. Fail loudly
        // instead of forwarding the child's routine success, so the agent learns the
        // Antigen runtime is not bound and must be reinitialized. (The retry's 404
        // produced the backend browser_tool_rejected trace event.)
        process.stderr.write(
          `[antigen-browser@${ADAPTER_VERSION}] browser_navigate_error reason=SESSION_NOT_FOUND id=${requestId}\n`
        );
        await noteToolDisposition({ tool: "browser_navigate", surface: "antigen_adapter", disposition: "failed", errorCode: "SESSION_NOT_FOUND" });
        writeSyntheticErrorResponse(
          "browser_navigate",
          requestId,
          "SESSION_NOT_FOUND",
          sessionNotFoundMessage("browser_navigate"),
        );
        return;
      }
    }

    // browser_navigate intentionally forwards the page load to @playwright/mcp and
    // mirrors nav-state to the Antigen backend (no Antigen-owned navigation route
    // yet), so this is `adapter_child_forwarded` even in QA hard mode — navigation
    // is not a sensitive ref/click action.
    await noteToolDisposition({ tool: "browser_navigate", surface: "adapter_child_playwright", disposition: "adapter_child_forwarded", resultCode: "forwarded" });
    // Track the page we are now on so the next navigation can distinguish a
    // same-site deeplink from a cross-site jump. Only on a non-error load — a
    // failed navigation did not change the current page.
    if (!isError) currentUrl = navigateUrl;
    // Forward the original child response to Cowork.
    process.stdout.write(childLine.endsWith("\n") ? childLine : childLine + "\n");
    return;
  }

  // ── browser_snapshot: NOT Antigen-owned — forwarded to @playwright/mcp ──────
  // The adapter does not own browser_snapshot; it forwards to the child, which
  // produces UNTRACED snapshots/refs on the same browser. That is the core
  // tool-surface bypass: a trace can look navigation-complete while the agent's
  // real snapshots happen off-trace. In QA hard mode we refuse to forward so the
  // agent must call antigen_snapshot (which is Antigen-owned and traced). In
  // default mode behavior is unchanged (forward) — we only record the disposition
  // so the bypass is visible in the trace.
  if (toolName === "browser_snapshot") {
    const requestId = msg.id;
    if (antigenHardModeEnabled()) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_snapshot_blocked reason=ANTIGEN_TOOL_REQUIRED\n`
      );
      await noteToolDisposition({ tool: "browser_snapshot", surface: "antigen_adapter", disposition: "blocked_by_antigen_required", errorCode: "ANTIGEN_TOOL_REQUIRED" });
      writeSyntheticErrorResponse(
        "browser_snapshot",
        requestId,
        "ANTIGEN_TOOL_REQUIRED",
        "browser_snapshot is not Antigen-owned in QA hard mode. Use antigen_snapshot so refs/actions are traceable.",
      );
      return;
    }
    await noteToolDisposition({ tool: "browser_snapshot", surface: "adapter_child_playwright", disposition: "adapter_child_forwarded", resultCode: "forwarded" });
    child.stdin.write(line);
    return;
  }

  // All other browser tools (or interception disabled): forward to @playwright/mcp unchanged.
  child.stdin.write(line);
}
