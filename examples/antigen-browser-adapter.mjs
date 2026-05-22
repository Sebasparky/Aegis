#!/usr/bin/env node
/**
 * antigen-browser-adapter.mjs
 *
 * Resolves the Antigen local browser runtime CDP endpoint at startup, then
 * spawns @playwright/mcp with the correct --cdp-endpoint. MCP protocol
 * traffic on stdin/stdout is piped transparently to/from the child process.
 * This process owns stdin/stdout and must not write to stdout itself.
 *
 * Required env vars:
 *   AEGIS_API_BASE    — e.g. http://localhost:4000
 *   AEGIS_AGENT_TOKEN — delegation token from connector setup
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

const child = spawn(
  "npx",
  ["--yes", "@playwright/mcp@latest", "--cdp-endpoint", cdp_url],
  { stdio: ["pipe", "pipe", "pipe"] },
);

// Pipe MCP protocol streams: parent stdin → child stdin, child stdout → parent stdout
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);

// Forward child stderr to parent stderr so errors are visible without polluting stdout
child.stderr.pipe(process.stderr);

// Forward termination signals to the child so it can shut down cleanly
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("error", (err) => {
  process.stderr.write(`[antigen-browser] Failed to spawn @playwright/mcp: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
