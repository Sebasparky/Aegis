/**
 * aegis-tool-server.test.mjs
 *
 * Startup hygiene for the Aegis MCP tool server: the bearer delegation token is sent only as
 * an Authorization header and must never appear on stdout, stderr, or in any startup line —
 * not as a prefix, suffix, hash, or encoding. Spawns the real server against a mock API.
 *
 * Run with: node --test examples/aegis-tool-server.test.mjs
 * Requires `npm ci` (the server imports @modelcontextprotocol/sdk).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "aegis-tool-server.mjs");

const TOKEN_CANARY = "canary_tok_5c1d9e8a7b3f2e4d60aa";
const PARTS = {
  raw: TOKEN_CANARY,
  prefix: TOKEN_CANARY.slice(0, 10),
  suffix: TOKEN_CANARY.slice(-10),
  base64: Buffer.from(TOKEN_CANARY).toString("base64"),
  hex: Buffer.from(TOKEN_CANARY).toString("hex"),
};

function assertNoTokenMaterial(label, text) {
  for (const [kind, needle] of Object.entries(PARTS)) {
    assert.ok(!text.includes(needle), `${label} contains token material (${kind}): ${text}`);
  }
}

function startMockApi(meStatus) {
  const server = createServer((req, res) => {
    if (req.url === "/api/agent/v1/me") {
      res.writeHead(meStatus, { "Content-Type": "application/json" });
      res.end(
        meStatus === 200
          ? JSON.stringify({ ok: true, data: { agent_name: "canary-agent", delegation_id: "deleg_canary_001", delegation_status: "active" } })
          : JSON.stringify({ ok: false, error: { code: "INVALID_TOKEN", message: "Token does not match any delegation." } }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }));
  });
  const ready = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, ready };
}

async function waitFor(getText, marker, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getText().includes(marker)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("Bearer token never logged at startup", () => {
  for (const [label, meStatus, marker] of [
    ["token resolves (200)", 200, "token_self_check ok"],
    ["token rejected (401)", 401, "FATAL-TOKEN"],
  ]) {
    test(`when ${label}: stdout and stderr contain no token material`, { timeout: 15000 }, async () => {
      const { server, ready } = startMockApi(meStatus);
      await ready;
      const { port } = server.address();

      const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: TOKEN_CANARY },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBuf = "";
      let stderrBuf = "";
      child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
      child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

      // The "Running." line is printed after the self-check and MCP transport connect.
      const running = await waitFor(() => stderrBuf, "Running.", 12000);
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
      server.close();

      assert.ok(running, `expected the Running line on stderr, got: ${stderrBuf}`);
      assert.ok(stderrBuf.includes(marker), `expected "${marker}" on stderr, got: ${stderrBuf}`);
      assert.ok(stderrBuf.includes("Auth: configured"), `Running line should state auth is configured: ${stderrBuf}`);
      assert.ok(!/Token: /.test(stderrBuf), `Running line must not carry a Token field: ${stderrBuf}`);
      assertNoTokenMaterial("stderr", stderrBuf);
      assertNoTokenMaterial("stdout", stdoutBuf);
    });
  }
});
