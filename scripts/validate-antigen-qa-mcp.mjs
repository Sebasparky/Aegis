#!/usr/bin/env node
/**
 * validate-antigen-qa-mcp.mjs — DEV/QA ONLY. No production behavior.
 *
 * Inspects .mcp.json and .claude/settings.json and reports whether the agent is
 * configured to route browser tools through the Antigen adapter
 * (examples/antigen-browser-adapter.mjs) rather than raw @playwright/mcp.
 *
 * It catches the exact misconfiguration that makes Antigen hard mode silently
 * not run:
 *   1. A raw `playwright` MCP server registered directly against @playwright/mcp,
 *      bypassing the adapter.
 *   2. mcp__playwright__browser_navigate / browser_snapshot (or a wildcard)
 *      pre-allowlisted in .claude/settings.json, which lets the agent attach raw
 *      Playwright to the same Chrome.
 *
 * Exit code: 0 = PASS (warnings allowed), 1 = FAIL.
 *
 * Usage:
 *   node scripts/validate-antigen-qa-mcp.mjs
 *   node scripts/validate-antigen-qa-mcp.mjs --mcp ./.mcp.json --settings ./.claude/settings.json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const MCP_PATH = resolve(argValue("--mcp") ?? join(REPO_ROOT, ".mcp.json"));
const SETTINGS_PATH = resolve(argValue("--settings") ?? join(REPO_ROOT, ".claude", "settings.json"));

const ADAPTER_MARKER = "antigen-browser-adapter.mjs";
const WRAPPER_MARKER = "run-antigen-browser-adapter-qa.sh";
const PLAYWRIGHT_MCP_MARKER = "@playwright/mcp";
const RAW_PW_NAV = "mcp__playwright__browser_navigate";
const RAW_PW_SNAPSHOT = "mcp__playwright__browser_snapshot";

// QA env flags the adapter's fail-closed guard requires for a direct-node launch.
// The wrapper script (run-antigen-browser-adapter-qa.sh) exports these itself, so a
// wrapper-form server does not need them spelled out in the MCP config.
const REQUIRED_QA_ENV = {
  ANTIGEN_BROWSER_TRACE: "true",
  ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS: "true",
  ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION: "true",
  ANTIGEN_INPUT_REALISM: "realistic",
};

// Collect env values a server provides, from both the `env` object and any inline
// `export FLAG='value'` / `FLAG=value` occurrences in args (the `bash -lc` form).
function collectServerEnv(server) {
  const env = {};
  if (server?.env && typeof server.env === "object") {
    for (const [k, v] of Object.entries(server.env)) env[k] = String(v);
  }
  const args = Array.isArray(server?.args) ? server.args : [];
  const text = [server?.command, ...args].filter((s) => typeof s === "string").join(" ");
  // Match FLAG=value, optionally prefixed by `export ` and quoted.
  const re = /(?:export\s+)?([A-Z_][A-Z0-9_]*)=(?:'([^']*)'|"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    if (env[key] === undefined) env[key] = val;
  }
  return env;
}

const findings = []; // { level: "pass"|"warn"|"fail", msg }
const pass = (msg) => findings.push({ level: "pass", msg });
const warn = (msg) => findings.push({ level: "warn", msg });
const fail = (msg) => findings.push({ level: "fail", msg });

function readJson(path) {
  if (!existsSync(path)) return { exists: false, json: null };
  try {
    return { exists: true, json: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { exists: true, json: null, error: err.message };
  }
}

function serverUsesMarker(server, marker) {
  const args = Array.isArray(server?.args) ? server.args : [];
  const haystack = [server?.command, ...args].filter((s) => typeof s === "string");
  return haystack.some((s) => s.includes(marker));
}

// ── .mcp.json ────────────────────────────────────────────────────────────────
const mcp = readJson(MCP_PATH);
if (!mcp.exists) {
  fail(`.mcp.json not found at ${MCP_PATH}. The Antigen adapter MCP server is not configured.`);
} else if (!mcp.json) {
  fail(`.mcp.json could not be parsed (${mcp.error}).`);
} else {
  const servers = mcp.json.mcpServers ?? {};
  let adapterConfigured = false;
  let rawPlaywrightServers = [];

  for (const [name, server] of Object.entries(servers)) {
    const usesWrapper = serverUsesMarker(server, WRAPPER_MARKER);
    const usesDirectAdapter = serverUsesMarker(server, ADAPTER_MARKER);

    if (usesWrapper) {
      // Preferred form: the wrapper script is the single source of QA env and keeps
      // the adapter's fail-closed guard ON. No need to inspect env here.
      adapterConfigured = true;
      pass(`Antigen adapter MCP server "${name}" routes through the QA wrapper script (${WRAPPER_MARKER}) — preferred.`);
      continue;
    }

    if (usesDirectAdapter) {
      // Direct-node launch: the adapter fails closed unless the full QA env is set.
      // The MCP config must therefore supply every required flag, or the live adapter
      // will FATAL at startup.
      adapterConfigured = true;
      const env = collectServerEnv(server);
      const missing = Object.entries(REQUIRED_QA_ENV)
        .filter(([k, v]) => env[k] !== v)
        .map(([k]) => k);
      if (missing.length === 0) {
        pass(`Antigen adapter MCP server "${name}" uses a direct node launch with the full QA env. (The wrapper script ${WRAPPER_MARKER} is the safer form.)`);
      } else {
        fail(
          `Antigen adapter MCP server "${name}" uses a direct node launch but is missing required QA env: ${missing.join(", ")}. ` +
          `The adapter will FATAL at startup (fail-closed). Add the missing flags, or switch to the wrapper script ${WRAPPER_MARKER}.`,
        );
      }
      continue;
    }

    // A non-adapter server that references @playwright/mcp directly is a raw
    // Playwright bypass: it attaches its own CDP connection to the same Chrome.
    if (serverUsesMarker(server, PLAYWRIGHT_MCP_MARKER)) {
      rawPlaywrightServers.push(name);
    }
  }

  if (!adapterConfigured) {
    fail(`No MCP server routes through the Antigen adapter (${WRAPPER_MARKER} or ${ADAPTER_MARKER}). Browser tools will not be mediated by Antigen.`);
  }

  if (rawPlaywrightServers.length > 0) {
    fail(
      `Raw Playwright MCP server(s) registered directly: ${rawPlaywrightServers.join(", ")}. ` +
      `This bypasses the Antigen adapter and attaches raw Playwright to the same Chrome. ` +
      `Remove these during Antigen QA hard mode.`,
    );
  } else {
    pass("No raw @playwright/mcp server is registered directly (only the adapter may spawn it internally).");
  }
}

// ── .claude/settings.json ──────────────────────────────────────────────────────
const settings = readJson(SETTINGS_PATH);
if (!settings.exists) {
  warn(`.claude/settings.json not found at ${SETTINGS_PATH} — no pre-allowlist to check.`);
} else if (!settings.json) {
  fail(`.claude/settings.json could not be parsed (${settings.error}).`);
} else {
  const allow = settings.json?.permissions?.allow ?? [];
  const allowList = Array.isArray(allow) ? allow : [];
  const offenders = allowList.filter(
    (entry) =>
      entry === RAW_PW_NAV ||
      entry === RAW_PW_SNAPSHOT ||
      entry === "mcp__playwright__*" ||
      (typeof entry === "string" && entry.startsWith("mcp__playwright__")),
  );
  if (offenders.length > 0) {
    fail(
      `Raw Playwright tools are pre-allowlisted in .claude/settings.json: ${offenders.join(", ")}. ` +
      `Pre-allowlisting mcp__playwright__browser_navigate / browser_snapshot lets the agent bypass ` +
      `the Antigen adapter. Remove these entries during Antigen QA hard mode.`,
    );
  } else {
    pass("No raw mcp__playwright__* tools are pre-allowlisted in .claude/settings.json.");
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
const ICON = { pass: "✅ PASS", warn: "⚠️  WARN", fail: "❌ FAIL" };
console.log("Antigen QA MCP routing validation (dev-only)\n");
console.log(`  .mcp.json:              ${MCP_PATH}`);
console.log(`  .claude/settings.json:  ${SETTINGS_PATH}\n`);
for (const f of findings) console.log(`  ${ICON[f.level]}  ${f.msg}`);

console.log(
  "\n  NOTE: This validator only inspects the project config files above. It cannot see Claude's\n" +
  "        LIVE MCP launch (which may be a cached, app-level command). After any config change,\n" +
  "        confirm in the antigen-browser server's live stderr that you see either the wrapper\n" +
  "        command or `qa_flags ... require_realistic_navigation=true require_antigen_tools=true\n" +
  "        browser_trace=true`. The adapter's own fail-closed guard (FATAL without QA env) is the\n" +
  "        real backstop — a weak cached launch now errors instead of serving weak tools.",
);

const failed = findings.some((f) => f.level === "fail");
console.log("");
if (failed) {
  console.log("RESULT: ❌ FAIL — the agent can bypass the Antigen adapter. See docs/dev/antigen-qa-mcp.md.");
  process.exit(1);
}
console.log("RESULT: ✅ PASS — browser tools route through the Antigen adapter.");
process.exit(0);
