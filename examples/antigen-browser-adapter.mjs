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
    name: "browser_type",
    description: "Type text into editable element",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
        text: { type: "string", description: "Text to type into the element" },
        slowly: { type: "boolean", description: "Whether to type character-by-character. Useful for triggering auto-complete" },
        submit: { type: "boolean", description: "Whether to submit the form after typing. Equivalent to pressing Enter" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_fill",
    description: "Fill an input field with text",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        ref: { type: "string", description: "Exact target element reference from the page snapshot" },
        value: { type: "string", description: "Value to fill into the input field" },
      },
      required: ["value"],
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

  // Perform MCP init handshake with child BEFORE piping stdout.
  // This prevents the child's init response from being forwarded to Claude.
  await doChildInitHandshake();

  // Handshake complete — now safe to pipe child responses to Claude.
  child.stdout.pipe(process.stdout);
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

  // Emit a diagnostic for every message processed before runtime is ready.
  if (!runtimeInitDone) {
    process.stderr.write(
      `[antigen-browser@${ADAPTER_VERSION}] preinit_message` +
      ` method=${method ?? "unknown"}` +
      ` name=${name ?? "none"}` +
      ` action=${isBrowserToolCall ? "ensure_runtime" : "no_runtime"}\n`
    );
  }

  if (!isBrowserToolCall) {
    if (runtimeInitDone) {
      // Child is ready — pass non-browser messages through.
      child.stdin.write(line);
    } else {
      // Pre-init: handle with synthetic MCP responses, no side effects.
      handlePreInitMessage(msg);
    }
    return;
  }

  // ── Browser tools/call — init runtime if not yet done ─────────────────────
  await ensureRuntime();

  const toolName = name;

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

    if (!elementDescription && !selectorHint) {
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
      const reqBody = { browser_runtime_id, element_description: elementDescription };
      if (selectorHint) reqBody.selector_hint = selectorHint;

      const apiRes = await fetch(`${BASE}/api/agent/v1/runtime/browser-click`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(reqBody),
      });

      if (apiRes.ok) {
        const resBody                  = await apiRes.json().catch(() => ({}));
        const resPointerCount          = resBody?.data?.pointer_path_point_count;
        const resPointerStartSource    = resBody?.data?.pointer_start_source;
        const resPointerStatePersisted = resBody?.data?.pointer_state_persisted;
        process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] realistic_click_success\n`);
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
      writeSyntheticErrorResponse(
        "browser_click",
        requestId,
        errCode,
        `Antigen realistic browser_click failed (${errCode}).`,
      );
    } catch (_err) {
      process.stderr.write(`[antigen-browser@${ADAPTER_VERSION}] browser_click_error reason=INTERCEPT_ERROR\n`);
      writeSyntheticErrorResponse(
        "browser_click",
        requestId,
        "ANTIGEN_CLICK_INTERCEPT_ERROR",
        "Antigen realistic browser_click encountered a network error.",
      );
    }
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
      const reqBody = { browser_runtime_id, text: typeText, submit: typeSubmit };
      if (hasTarget) reqBody.element_description = typeElement;
      if (selectorHint) reqBody.selector_hint = selectorHint;

      const apiRes = await fetch(`${BASE}/api/agent/v1/runtime/browser-type`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(reqBody),
      });

      if (apiRes.ok) {
        const resBody      = await apiRes.json().catch(() => ({}));
        const resBucket              = resBody?.data?.char_count_bucket ?? bucket;
        const resFocused             = resBody?.data?.focused;
        const resSubmitted           = resBody?.data?.submitted;
        const resPointerCount        = resBody?.data?.pointer_path_point_count;
        const resPointerStartSource  = resBody?.data?.pointer_start_source;
        const resPointerStatePersisted = resBody?.data?.pointer_state_persisted;
        process.stderr.write(
          `[antigen-browser@${ADAPTER_VERSION}] realistic_type_success source=browser_type` +
          ` char_count_bucket=${resBucket} has_target=${hasTarget} submit=${typeSubmit}\n`
        );
        writeSyntheticResponse(
          requestId,
          buildSyntheticSuccessText("browser_type", {
            bucket: resBucket,
            focused: resFocused,
            submitted: resSubmitted,
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
      writeSyntheticErrorResponse(
        "browser_type",
        requestId,
        errCode,
        `Antigen realistic browser_type failed (${errCode}).`,
      );
    } catch (_err) {
      process.stderr.write(
        `[antigen-browser@${ADAPTER_VERSION}] browser_type_error reason=INTERCEPT_ERROR source=browser_type\n`
      );
      writeSyntheticErrorResponse(
        "browser_type",
        requestId,
        "ANTIGEN_TYPE_INTERCEPT_ERROR",
        "Antigen realistic browser_type encountered a network error.",
      );
    }
    return;
  }

  // All other browser tools (or interception disabled): forward to @playwright/mcp unchanged.
  child.stdin.write(line);
}
