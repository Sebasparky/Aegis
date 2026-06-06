/**
 * validate-antigen-qa-mcp.test.mjs
 *
 * Tests for the dev/QA MCP routing validator (scripts/validate-antigen-qa-mcp.mjs).
 * The validator is a side-effecting CLI (console output + process.exit), so each
 * case writes a temp .mcp.json fixture and spawns the validator with
 * `--mcp <fixture> --settings <nonexistent>`, then asserts on exit code + stdout.
 *
 * Run with: node --test scripts/validate-antigen-qa-mcp.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATOR_PATH = join(__dirname, "validate-antigen-qa-mcp.mjs");

// Run the validator against a fixture object; returns { code, stdout }.
function runValidator(mcpObject) {
  const dir = mkdtempSync(join(tmpdir(), "antigen-qa-validate-"));
  const mcpPath = join(dir, ".mcp.json");
  const settingsPath = join(dir, "settings-does-not-exist.json");
  writeFileSync(mcpPath, JSON.stringify(mcpObject, null, 2));
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [VALIDATOR_PATH, "--mcp", mcpPath, "--settings", settingsPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", () => {});
    proc.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout });
    });
  });
}

const FULL_ENV = {
  AEGIS_API_BASE: "http://localhost:4000",
  AEGIS_AGENT_TOKEN: "tok",
  ANTIGEN_BROWSER_HEADLESS: "false",
  ANTIGEN_INPUT_REALISM: "realistic",
  ANTIGEN_BROWSER_TRACE: "true",
  ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS: "true",
  ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION: "true",
};

describe("validate-antigen-qa-mcp", () => {
  test("direct node adapter with NO env → FAIL (exit 1), names missing flags", async () => {
    const { code, stdout } = await runValidator({
      mcpServers: {
        "antigen-browser": {
          command: "node",
          args: ["/repo/examples/antigen-browser-adapter.mjs"],
        },
      },
    });
    assert.equal(code, 1, `expected FAIL exit 1; stdout:\n${stdout}`);
    assert.match(stdout, /missing required QA env/i, stdout);
    assert.match(stdout, /ANTIGEN_BROWSER_TRACE/, stdout);
  });

  test("wrapper-script form → PASS (exit 0), mentions preferred", async () => {
    const { code, stdout } = await runValidator({
      mcpServers: {
        "antigen-browser": {
          command: "/repo/scripts/run-antigen-browser-adapter-qa.sh",
          args: [],
        },
      },
    });
    assert.equal(code, 0, `expected PASS exit 0; stdout:\n${stdout}`);
    assert.match(stdout, /wrapper script/i, stdout);
    assert.match(stdout, /preferred/i, stdout);
  });

  test("direct node adapter with full env object → PASS (exit 0)", async () => {
    const { code, stdout } = await runValidator({
      mcpServers: {
        "antigen-browser": {
          command: "node",
          args: ["/repo/examples/antigen-browser-adapter.mjs"],
          env: FULL_ENV,
        },
      },
    });
    assert.equal(code, 0, `expected PASS exit 0; stdout:\n${stdout}`);
    assert.match(stdout, /direct node launch with the full QA env/i, stdout);
  });

  test("bash -lc inline-export form with full env → PASS (exit 0)", async () => {
    const inline =
      "export AEGIS_API_BASE='http://localhost:4000'; export AEGIS_AGENT_TOKEN='tok'; " +
      "export ANTIGEN_BROWSER_HEADLESS='false'; export ANTIGEN_INPUT_REALISM='realistic'; " +
      "export ANTIGEN_BROWSER_TRACE='true'; export ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS='true'; " +
      "export ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION='true'; " +
      "exec node /repo/examples/antigen-browser-adapter.mjs";
    const { code, stdout } = await runValidator({
      mcpServers: {
        "antigen-browser": { command: "/bin/bash", args: ["-lc", inline] },
      },
    });
    assert.equal(code, 0, `expected PASS exit 0; stdout:\n${stdout}`);
  });

  test("raw @playwright/mcp server → FAIL (exit 1)", async () => {
    const { code, stdout } = await runValidator({
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222"] },
      },
    });
    assert.equal(code, 1, `expected FAIL exit 1; stdout:\n${stdout}`);
  });
});
