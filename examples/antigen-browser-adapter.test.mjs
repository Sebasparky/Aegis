/**
 * antigen-browser-adapter.test.mjs
 *
 * Tests for adapter-helpers and adapter startup/interception behavior.
 * Run with: node --test examples/antigen-browser-adapter.test.mjs
 *
 * Groups:
 *   A. looksLikeSelector — CSS strings → true; snapshot refs → false
 *   B. charCountBucket — boundary values for all four buckets
 *   C. buildSyntheticSuccessText — safe diagnostic content; no forbidden fields
 *   D. Adapter startup — no browser-endpoint call before first tool call (lazy init)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  looksLikeSelector,
  charCountBucket,
  clipRuntimeId,
  buildSyntheticSuccessText,
  buildPostClickStateText,
  buildPostFillStateText,
  withPostFillSummary,
  buildAntigenSnapshotText,
  deriveNavHintsFromSnapshot,
  classifyNavigationDiscipline,
  navigationBlockMessage,
  sanitizeHostPath,
} from "./lib/adapter-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = join(__dirname, "antigen-browser-adapter.mjs");

// The adapter fails closed (FATAL, exit 1) when launched without the full QA env.
// These tests intentionally spawn it in weak/default mode (no QA flags) to exercise
// interception/error paths, so opt out of the guard process-wide. Every existing
// spawn site spreads `...process.env`, so this inherits automatically. Group G
// (the guard tests) builds explicit env objects that do NOT inherit this opt-out.
process.env.ANTIGEN_ADAPTER_REQUIRE_QA_ENV = "false";

// ─── A. looksLikeSelector ─────────────────────────────────────────────────────

describe("A. looksLikeSelector", () => {
  test("CSS class selector → true", () => {
    assert.equal(looksLikeSelector(".search-box"), true);
  });

  test("CSS id selector → true", () => {
    assert.equal(looksLikeSelector("#submit-btn"), true);
  });

  test("attribute selector → true", () => {
    assert.equal(looksLikeSelector('[data-testid="login"]'), true);
  });

  test("role selector with colon → true", () => {
    assert.equal(looksLikeSelector('button:has-text("Buy")'), true);
  });

  test("snapshot ref e5 → false", () => {
    assert.equal(looksLikeSelector("e5"), false);
  });

  test("snapshot ref a12 → false", () => {
    assert.equal(looksLikeSelector("a12"), false);
  });

  test("plain word element description → false", () => {
    assert.equal(looksLikeSelector("Search button"), false);
  });

  test("empty string → false", () => {
    assert.equal(looksLikeSelector(""), false);
  });

  test("non-string → false", () => {
    assert.equal(looksLikeSelector(null), false);
    assert.equal(looksLikeSelector(undefined), false);
    assert.equal(looksLikeSelector(42), false);
  });
});

// ─── B. charCountBucket ───────────────────────────────────────────────────────

describe("B. charCountBucket", () => {
  test("len=1 → 1-4", () => assert.equal(charCountBucket(1), "1-4"));
  test("len=4 → 1-4", () => assert.equal(charCountBucket(4), "1-4"));
  test("len=5 → 5-8", () => assert.equal(charCountBucket(5), "5-8"));
  test("len=8 → 5-8", () => assert.equal(charCountBucket(8), "5-8"));
  test("len=9 → 9-16", () => assert.equal(charCountBucket(9), "9-16"));
  test("len=16 → 9-16", () => assert.equal(charCountBucket(16), "9-16"));
  test("len=17 → 17+", () => assert.equal(charCountBucket(17), "17+"));
  test("len=100 → 17+", () => assert.equal(charCountBucket(100), "17+"));
});

// ─── C. buildSyntheticSuccessText ─────────────────────────────────────────────

describe("C. buildSyntheticSuccessText", () => {
  const V = "2026-05-29";

  test("browser_type includes path=realistic_success", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "9-16", version: V });
    assert.ok(text.includes("path=realistic_success"), `missing path: ${text}`);
  });

  test("browser_type includes char_count_bucket", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "9-16", version: V });
    assert.ok(text.includes("char_count_bucket=9-16"), `missing bucket: ${text}`);
  });

  test("browser_fill includes path=realistic_success", () => {
    const text = buildSyntheticSuccessText("browser_fill", { bucket: "5-8", version: V });
    assert.ok(text.includes("path=realistic_success"), `missing path: ${text}`);
  });

  test("browser_fill includes char_count_bucket", () => {
    const text = buildSyntheticSuccessText("browser_fill", { bucket: "5-8", version: V });
    assert.ok(text.includes("char_count_bucket=5-8"), `missing bucket: ${text}`);
  });

  test("browser_click includes path=realistic_success", () => {
    const text = buildSyntheticSuccessText("browser_click", { hint: "selector", version: V });
    assert.ok(text.includes("path=realistic_success"), `missing path: ${text}`);
  });

  test("browser_click includes hint", () => {
    const text = buildSyntheticSuccessText("browser_click", { hint: "selector", version: V });
    assert.ok(text.includes("hint=selector"), `missing hint: ${text}`);
  });

  test("includes source=antigen-browser-adapter@VERSION", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "1-4", version: V });
    assert.ok(text.includes(`source=antigen-browser-adapter@${V}`), `missing source: ${text}`);
  });

  test("never includes raw text (no 'value' or 'text' keys in output)", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "17+", version: V });
    assert.ok(!text.includes('"text"'), `found raw text key: ${text}`);
    assert.ok(!text.includes('"value"'), `found raw value key: ${text}`);
  });

  test("browser_click without hint defaults to description", () => {
    const text = buildSyntheticSuccessText("browser_click", { version: V });
    assert.ok(text.includes("hint=description"), `expected description fallback: ${text}`);
  });
});

// ─── F. buildSyntheticSuccessText — browser_type focused/submitted fields ────

describe("F. buildSyntheticSuccessText — browser_type focused/submitted", () => {
  const V = "2026-05-29";

  test("browser_type with focused=true includes focused=true", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "9-16", focused: true, version: V });
    assert.ok(text.includes("focused=true"), `expected focused=true: ${text}`);
  });

  test("browser_type with submitted=true includes submitted=true", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "9-16", submitted: true, version: V });
    assert.ok(text.includes("submitted=true"), `expected submitted=true: ${text}`);
  });

  test("browser_type with focused=true submitted=true includes both", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "5-8", focused: true, submitted: true, version: V });
    assert.ok(text.includes("focused=true"), `expected focused=true: ${text}`);
    assert.ok(text.includes("submitted=true"), `expected submitted=true: ${text}`);
  });

  test("browser_type without focused/submitted does not add those fields", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "1-4", version: V });
    assert.ok(!text.includes("focused="), `unexpected focused= in: ${text}`);
    assert.ok(!text.includes("submitted="), `unexpected submitted= in: ${text}`);
  });

  test("browser_fill not affected by focused/submitted params", () => {
    const text = buildSyntheticSuccessText("browser_fill", { bucket: "5-8", focused: true, submitted: true, version: V });
    assert.ok(text.includes("char_count_bucket=5-8"), `missing bucket: ${text}`);
    assert.ok(!text.includes("focused="), `browser_fill should not include focused=: ${text}`);
    assert.ok(!text.includes("submitted="), `browser_fill should not include submitted=: ${text}`);
  });

  test("source field appears at the end of browser_type with focused/submitted", () => {
    const text = buildSyntheticSuccessText("browser_type", { bucket: "9-16", focused: true, submitted: true, version: V });
    assert.ok(text.includes(`source=antigen-browser-adapter@${V}`), `missing source: ${text}`);
    assert.ok(text.endsWith(`source=antigen-browser-adapter@${V}`), `source should be last: ${text}`);
  });
});

// ─── D. Adapter startup — lazy init (no browser-endpoint call before first tool call) ───

describe("D. Adapter lazy init", () => {
  test("adapter does not call browser-endpoint at startup before any tool call", { timeout: 5000 }, async () => {
    let callCount = 0;

    // Start a mock HTTP server that counts calls to browser-endpoint.
    const mockServer = createServer((req, res) => {
      if (req.url === "/api/agent/v1/runtime/browser-endpoint" && req.method === "POST") {
        callCount++;
      }
      // Return a valid response so the adapter doesn't crash if it ever does call.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: {
          cdp_url: "http://localhost:9999",
          browser_runtime_id: "test_runtime_001",
          runtime_mode: "local_runtime_endpoint",
          reused_existing: false,
        },
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const { port } = mockServer.address();

    // Spawn the adapter; it should start cleanly and await its first stdin line.
    const adapter = spawn(
      process.execPath,
      [ADAPTER_PATH],
      {
        env: {
          ...process.env,
          AEGIS_API_BASE: `http://127.0.0.1:${port}`,
          AEGIS_AGENT_TOKEN: "test_token",
          ANTIGEN_BROWSER_HEADLESS: "false",
          ANTIGEN_INPUT_REALISM: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stderrOutput = "";
    adapter.stderr.on("data", (d) => { stderrOutput += d.toString(); });

    // Wait 600ms — enough time for eager init to have fired if it were still present.
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(callCount, 0,
      `browser-endpoint was called ${callCount} times before any tool call — adapter must init lazily`);

    // Adapter stderr should show the "adapter loaded" line (startup diagnostic) but NOT "Runtime ready".
    assert.ok(stderrOutput.includes("adapter loaded"), `missing startup log: ${stderrOutput}`);
    assert.ok(!stderrOutput.includes("Runtime ready"), `unexpected Runtime ready before first tool call: ${stderrOutput}`);

    adapter.kill("SIGTERM");
    mockServer.close();
  });
});

// ─── E. Pre-init gate — MCP startup traffic must not trigger browser-endpoint ──
// These tests send real MCP messages and verify no side effects until a
// browser_ tools/call is received.

function spawnAdapterWithMockServer() {
  let callCount = 0;

  const mockServer = createServer((req, res) => {
    if (req.url === "/api/agent/v1/runtime/browser-endpoint" && req.method === "POST") {
      callCount++;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        cdp_url: "http://127.0.0.1:19999",
        browser_runtime_id: "test_runtime_001",
        runtime_mode: "local_runtime_endpoint",
        reused_existing: false,
      },
    }));
  });

  const serverReady = new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));

  return { mockServer, serverReady, getCallCount: () => callCount };
}

const MCP_INIT_MSG = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  },
}) + "\n";

describe("E. Pre-init gate", () => {
  test("sending initialize does not call browser-endpoint and receives valid response", { timeout: 5000 }, async () => {
    const { mockServer, serverReady, getCallCount } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(getCallCount(), 0, `browser-endpoint called ${getCallCount()} times after initialize`);

    const lines = stdoutBuf.split("\n").filter((l) => l.trim());
    assert.ok(lines.length > 0, "adapter should respond to initialize");
    const initResponse = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((m) => m?.id === 1);
    assert.ok(initResponse, "response should match id=1");
    assert.ok(initResponse.result?.serverInfo, "initialize response should include serverInfo");

    adapter.kill("SIGTERM");
    mockServer.close();
  });

  test("sending notifications/initialized does not call browser-endpoint", { timeout: 5000 }, async () => {
    const { mockServer, serverReady, getCallCount } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    adapter.stdin.write(MCP_INIT_MSG);
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(getCallCount(), 0, `browser-endpoint called ${getCallCount()} times after notifications/initialized`);

    adapter.kill("SIGTERM");
    mockServer.close();
  });

  test("sending tools/list does not call browser-endpoint and returns browser tools", { timeout: 5000 }, async () => {
    const { mockServer, serverReady, getCallCount } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(getCallCount(), 0, `browser-endpoint called ${getCallCount()} times after tools/list`);

    const lines = stdoutBuf.split("\n").filter((l) => l.trim());
    const toolsResponse = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((m) => m?.id === 2);
    assert.ok(toolsResponse, "adapter should respond to tools/list with id=2");
    assert.ok(Array.isArray(toolsResponse?.result?.tools), "result.tools should be an array");
    assert.ok(
      toolsResponse.result.tools.some((t) => t.name === "browser_snapshot"),
      "tools list should include browser_snapshot",
    );
    assert.ok(
      toolsResponse.result.tools.some((t) => t.name === "browser_navigate"),
      "tools list should include browser_navigate",
    );

    adapter.kill("SIGTERM");
    mockServer.close();
  });

  test("tools/call for non-browser tool does not call browser-endpoint", { timeout: 5000 }, async () => {
    const { mockServer, serverReady, getCallCount } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    adapter.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "aegis_get_identity", arguments: {} } }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(getCallCount(), 0, `browser-endpoint called ${getCallCount()} times for non-browser tool`);

    adapter.kill("SIGTERM");
    mockServer.close();
  });

  test("tools/call browser_snapshot triggers browser-endpoint exactly once", { timeout: 4000 }, async () => {
    const { mockServer, serverReady, getCallCount } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send init first (MCP protocol requirement), then the browser tool call.
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 100));
    adapter.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }) + "\n"
    );

    // Wait enough for the API call to complete (mock server is fast).
    // The child spawn + handshake may still be in progress — we only verify the API call.
    await new Promise((r) => setTimeout(r, 1000));

    assert.equal(getCallCount(), 1, `browser-endpoint should be called exactly once, got ${getCallCount()}`);

    adapter.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    mockServer.close();
  });

  test("stderr preinit_message diagnostic appears for tools/list", { timeout: 5000 }, async () => {
    const { mockServer, serverReady } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(
      stderrBuf.includes("preinit_message method=tools/list"),
      `expected preinit_message for tools/list in stderr: ${stderrBuf}`,
    );
    assert.ok(
      stderrBuf.includes("action=no_runtime"),
      `expected action=no_runtime in stderr: ${stderrBuf}`,
    );

    adapter.kill("SIGTERM");
    mockServer.close();
  });

  test("stderr preinit_message for browser_snapshot shows action=ensure_runtime", { timeout: 4000 }, async () => {
    const { mockServer, serverReady } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 50));
    adapter.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 1000));

    assert.ok(
      stderrBuf.includes("name=browser_snapshot") && stderrBuf.includes("action=ensure_runtime"),
      `expected preinit_message with ensure_runtime for browser_snapshot: ${stderrBuf}`,
    );

    adapter.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    mockServer.close();
  });

  test("stdout contains only valid JSON-RPC for pre-init messages (no diagnostic text)", { timeout: 5000 }, async () => {
    const { mockServer, serverReady } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/list", params: {} }) + "\n");

    await new Promise((r) => setTimeout(r, 400));

    const lines = stdoutBuf.split("\n").filter((l) => l.trim() !== "");
    assert.ok(lines.length > 0, "adapter should respond to pre-init messages");
    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch {
        assert.fail(`stdout line is not valid JSON: ${line}`);
      }
      assert.equal(parsed.jsonrpc, "2.0", `response should have jsonrpc: "2.0": ${line}`);
    }

    adapter.kill("SIGTERM");
    mockServer.close();
  });
});

// ─── H. pointer_path_point_count surfacing ────────────────────────────────────

describe("H. pointer_path_point_count surfacing", () => {
  const V = "2026-05-29";

  test("buildSyntheticSuccessText includes pointer_path_point_count for browser_type when provided", () => {
    const text = buildSyntheticSuccessText("browser_type", {
      bucket: "9-16", focused: true, submitted: true, pointerPathPointCount: 12, version: V,
    });
    assert.ok(text.includes("pointer_path_point_count=12"), `missing pointer_path_point_count: ${text}`);
    assert.ok(text.includes("focused=true"), `missing focused: ${text}`);
    assert.ok(text.includes("submitted=true"), `missing submitted: ${text}`);
    assert.ok(text.endsWith(`source=antigen-browser-adapter@${V}`), `source should be last: ${text}`);
  });

  test("buildSyntheticSuccessText includes pointer_start_source and pointer_state_persisted for browser_type", () => {
    const text = buildSyntheticSuccessText("browser_type", {
      bucket: "9-16", focused: true, submitted: false,
      pointerPathPointCount: 51, pointerStartSource: "session", pointerStatePersisted: true,
      version: V,
    });
    assert.ok(text.includes("pointer_path_point_count=51"), `missing pointer_path_point_count: ${text}`);
    assert.ok(text.includes("pointer_start_source=session"), `missing pointer_start_source: ${text}`);
    assert.ok(text.includes("pointer_state_persisted=true"), `missing pointer_state_persisted: ${text}`);
    assert.ok(text.endsWith(`source=antigen-browser-adapter@${V}`), `source should be last: ${text}`);
  });

  test("buildSyntheticSuccessText omits pointer_start_source and pointer_state_persisted for browser_type when absent", () => {
    const text = buildSyntheticSuccessText("browser_type", {
      bucket: "5-8", focused: true, submitted: false, pointerPathPointCount: 10, version: V,
    });
    assert.ok(!text.includes("pointer_start_source"), `unexpected pointer_start_source when absent: ${text}`);
    assert.ok(!text.includes("pointer_state_persisted"), `unexpected pointer_state_persisted when absent: ${text}`);
  });

  test("browser_type API success mock with pointer_path_point_count emits Cowork-visible text containing it", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 200,
      browserTypeBody: {
        ok: true,
        data: { char_count_bucket: "9-16", duration_ms: 130, focused: true, submitted: true, pointer_path_point_count: 8 },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 50, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search", ref: "e5", text: "desk lamp", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 50);
    assert.ok(resp, `expected response for id=50, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("pointer_path_point_count=8"), `expected pointer_path_point_count=8 in: ${text}`);
    assert.ok(text.includes("path=realistic_success"), `expected path=realistic_success in: ${text}`);
  });

  test("browser_type API success with pointer_start_source and pointer_state_persisted emits all three pointer fields", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 200,
      browserTypeBody: {
        ok: true,
        data: {
          char_count_bucket: "9-16", duration_ms: 130, focused: true, submitted: false,
          pointer_path_point_count: 51, pointer_start_source: "session", pointer_state_persisted: true,
        },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 54, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search", ref: "e5", text: "desk lamp", submit: false } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 54);
    assert.ok(resp, `expected response for id=54, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("pointer_path_point_count=51"), `missing pointer_path_point_count: ${text}`);
    assert.ok(text.includes("pointer_start_source=session"), `missing pointer_start_source: ${text}`);
    assert.ok(text.includes("pointer_state_persisted=true"), `missing pointer_state_persisted: ${text}`);
    assert.ok(text.includes("path=realistic_success"), `expected path=realistic_success in: ${text}`);
  });

  test("success text does not include raw typed text or forbidden fields", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 200,
      browserTypeBody: {
        ok: true,
        data: { char_count_bucket: "9-16", duration_ms: 130, focused: true, submitted: true, pointer_path_point_count: 5 },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 51, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search", ref: "e5", text: "secret_password_value", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    assert.ok(!stdoutBuf.includes("secret_password_value"), `raw typed text leaked to stdout`);
    assert.ok(!stdoutBuf.includes("password"), `forbidden field 'password' leaked to stdout`);
    assert.ok(!stdoutBuf.includes("secret_ref"), `forbidden field 'secret_ref' leaked to stdout`);
  });
});

// ─── I. submit_method surfacing ───────────────────────────────────────────────

describe("I. submit_method surfacing", () => {
  const V = "2026-05-29";

  test("buildSyntheticSuccessText includes submit_method=enter when provided", () => {
    const text = buildSyntheticSuccessText("browser_type", {
      bucket: "9-16", submitted: true, submitMethod: "enter", version: V,
    });
    assert.ok(text.includes("submit_method=enter"), `missing submit_method=enter: ${text}`);
    assert.ok(text.includes("submitted=true"), `missing submitted=true: ${text}`);
  });

  test("buildSyntheticSuccessText includes submit_method=button_fallback when provided", () => {
    const text = buildSyntheticSuccessText("browser_type", {
      bucket: "9-16", submitted: true, submitMethod: "button_fallback", version: V,
    });
    assert.ok(text.includes("submit_method=button_fallback"), `missing submit_method=button_fallback: ${text}`);
  });

  test("buildSyntheticSuccessText omits submit_method when not provided", () => {
    const text = buildSyntheticSuccessText("browser_type", {
      bucket: "9-16", submitted: true, version: V,
    });
    assert.ok(!text.includes("submit_method="), `unexpected submit_method in: ${text}`);
  });

  test("submit_method appears after submitted in the output string", () => {
    const text = buildSyntheticSuccessText("browser_type", {
      bucket: "9-16", submitted: true, submitMethod: "enter", version: V,
    });
    const subIdx = text.indexOf("submitted=");
    const smIdx = text.indexOf("submit_method=");
    assert.ok(smIdx > subIdx, `submit_method should appear after submitted: ${text}`);
  });

  test("browser_fill is not affected by submitMethod param", () => {
    const text = buildSyntheticSuccessText("browser_fill", {
      bucket: "5-8", submitMethod: "enter", version: V,
    });
    assert.ok(!text.includes("submit_method="), `browser_fill should not include submit_method: ${text}`);
  });

  test("adapter emits submit_method=enter in browser_type success text", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 200,
      browserTypeBody: {
        ok: true,
        data: { char_count_bucket: "9-16", duration_ms: 130, focused: true, submitted: true, submit_method: "enter" },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 60, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search box", text: "desk lamp", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 60);
    assert.ok(resp, `expected response for id=60, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("submit_method=enter"), `missing submit_method=enter: ${text}`);
    assert.ok(text.includes("submitted=true"), `missing submitted=true: ${text}`);
    assert.ok(text.includes("path=realistic_success"), `missing path=realistic_success: ${text}`);
  });

  test("adapter emits submit_method=button_fallback in browser_type success text", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 200,
      browserTypeBody: {
        ok: true,
        data: { char_count_bucket: "9-16", duration_ms: 200, focused: true, submitted: true, submit_method: "button_fallback" },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 61, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search box", text: "desk lamp", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 61);
    assert.ok(resp, `expected response for id=61, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("submit_method=button_fallback"), `missing submit_method=button_fallback: ${text}`);
    assert.ok(text.includes("submitted=true"), `missing submitted=true: ${text}`);
  });

  test("success text contains no forbidden fields regardless of submit_method", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 200,
      browserTypeBody: {
        ok: true,
        data: { char_count_bucket: "9-16", duration_ms: 130, focused: true, submitted: true, submit_method: "button_fallback" },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 62, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search box", text: "secret_value_xyz", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    assert.ok(!stdoutBuf.includes("secret_value_xyz"), `raw typed text leaked to stdout`);
    assert.ok(!stdoutBuf.includes("cdp_url"), `cdp_url leaked to stdout`);
    assert.ok(!stdoutBuf.includes("user_data_dir"), `user_data_dir leaked to stdout`);
    assert.ok(!stdoutBuf.includes("secret_ref"), `secret_ref leaked to stdout`);
  });
});

// ─── G. browser_type adapter-owned — no @playwright/mcp fallthrough ───────────
// browser_type is now fully owned by the adapter. When INTERCEPTION_ENABLED=false,
// or when the Aegis API returns non-200, or when the network fails, the adapter
// returns a clean MCP error response. It never forwards browser_type to child.stdin.
//
// Test infrastructure:
//   createFakeMcpBin() — creates a temp dir with a fake "npx" wrapper that runs
//     a minimal MCP stub (responds to initialize, stays alive). Prepend binPath to
//     PATH so the adapter finds the fake npx before the real one.
//   createMockApiServer(opts) — starts an HTTP server handling browser-endpoint
//     and optionally browser-type with configurable status/body/destroy.

// Inline MCP stub source — responds to initialize, ignores all other messages.
const FAKE_MCP_STUB_SRC = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line.trim());
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0" } }
      }) + "\\n");
    }
  } catch {}
});
process.stdin.resume();
`;

function createFakeMcpBin() {
  const tmpDir = mkdtempSync(join(tmpdir(), "antigen-mcp-"));
  const fakeMcpPath = join(tmpDir, "fake-mcp.mjs");
  writeFileSync(fakeMcpPath, FAKE_MCP_STUB_SRC, "utf8");

  // Shell wrapper named "npx" — adapter spawns "npx ..."; this fake intercepts it.
  const fakeNpxPath = join(tmpDir, "npx");
  writeFileSync(fakeNpxPath, `#!/bin/sh\nexec ${process.execPath} ${fakeMcpPath}\n`, "utf8");
  chmodSync(fakeNpxPath, 0o755);

  return {
    binPath: tmpDir,
    cleanup() { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} },
  };
}

async function createMockApiServer(opts = {}) {
  const {
    browserTypeStatus = 200, browserTypeBody = null, browserTypeDestroy = false,
    browserClickStatus = 200, browserClickBody = null, browserClickDestroy = false,
    browserSnapshotStatus = 200, browserSnapshotBody = null, browserSnapshotDestroy = false,
    browserSnapshotStatusSequence = null, browserSnapshotBodySequence = null,
    browserScrollStatus = 200, browserScrollBody = null, browserScrollDestroy = false,
    // Optional per-call sequences for browser-click (used by SESSION_NOT_FOUND
    // recovery tests). When provided, each request shifts the next status/body;
    // when exhausted (or null), falls back to the static browserClickStatus/Body.
    browserClickStatusSequence = null, browserClickBodySequence = null,
    // Optional per-call sequence of browser_runtime_id values for the
    // browser-endpoint handler (init, then re-init). Lets fresh-id continuity
    // tests distinguish a stale-id retry from a fresh-id retry. Falls back to the
    // static "test_runtime_001" when exhausted/null.
    browserEndpointIdSequence = null,
  } = opts;

  // Captured antigen_snapshot request bodies + their Authorization header,
  // so tests can assert what the adapter sent.
  const snapshotRequests = [];
  // Captured browser-click request bodies, so tests can assert ref pass-through.
  const clickRequests = [];
  // Captured browser-scroll-to-ref request bodies (Phase 5C).
  const scrollRequests = [];
  // Captured browser-type request bodies (runtime-id continuity assertions).
  const typeRequests = [];
  // Captured browser-endpoint request bodies (counts init + re-init calls).
  const endpointRequests = [];
  // Captured tool-surface disposition POSTs (dev-only diagnostics route).
  const dispositionRequests = [];

  const DEFAULT_SNAPSHOT_BODY = {
    ok: true,
    data: {
      snapshot_id: "snap_test123",
      url: "https://www.ikea.com/us/en/search/?q=desk%20lamp",
      title: null,
      expires_at: "2026-01-01T00:00:10.000Z",
      snapshot_ttl_ms: 10000,
      element_count: 2,
      elements: [
        {
          ref: "ag_1",
          kind: "link",
          role: "link",
          name: "TERTIAL, Work lamp, light blue",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
          hints: { href_path: "/us/en/p/tertial-work-lamp-light-blue-70504295/" },
        },
        {
          ref: "ag_2",
          kind: "button",
          role: "button",
          name: "Add to bag",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
        },
      ],
    },
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-snapshot") {
        if (browserSnapshotDestroy) { req.socket.destroy(); return; }
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        snapshotRequests.push({ body: parsed, authorization: req.headers["authorization"] });
        const seqSnapStatus = Array.isArray(browserSnapshotStatusSequence) && browserSnapshotStatusSequence.length
          ? browserSnapshotStatusSequence.shift() : null;
        const seqSnapBody = Array.isArray(browserSnapshotBodySequence) && browserSnapshotBodySequence.length
          ? browserSnapshotBodySequence.shift() : null;
        const responseBody = seqSnapBody ?? browserSnapshotBody ?? DEFAULT_SNAPSHOT_BODY;
        res.writeHead(seqSnapStatus ?? browserSnapshotStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-endpoint") {
        let parsedEndpoint = {};
        try { parsedEndpoint = JSON.parse(body); } catch {}
        endpointRequests.push(parsedEndpoint);
        const seqId = Array.isArray(browserEndpointIdSequence) && browserEndpointIdSequence.length
          ? browserEndpointIdSequence.shift() : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: {
            cdp_url: "http://127.0.0.1:19999",
            browser_runtime_id: seqId ?? "test_runtime_001",
            runtime_mode: "test_mode",
            reused_existing: false,
          },
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-type") {
        if (browserTypeDestroy) { req.socket.destroy(); return; }
        let parsedType = {};
        try { parsedType = JSON.parse(body); } catch {}
        typeRequests.push({ body: parsedType, authorization: req.headers["authorization"] });
        const responseBody = browserTypeBody ?? {
          ok: true,
          data: { char_count_bucket: "5-8", duration_ms: 120, focused: true, submitted: false },
        };
        res.writeHead(browserTypeStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-click") {
        if (browserClickDestroy) { req.socket.destroy(); return; }
        let parsedClick = {};
        try { parsedClick = JSON.parse(body); } catch {}
        clickRequests.push({ body: parsedClick, authorization: req.headers["authorization"] });
        const seqStatus = Array.isArray(browserClickStatusSequence) && browserClickStatusSequence.length
          ? browserClickStatusSequence.shift() : null;
        const seqBody = Array.isArray(browserClickBodySequence) && browserClickBodySequence.length
          ? browserClickBodySequence.shift() : null;
        const status = seqStatus ?? browserClickStatus;
        const responseBody = seqBody ?? browserClickBody ?? {
          ok: true,
          data: { mode: "realistic_pointer_click", pointer_path_point_count: 42, pointer_start_source: "session", pointer_state_persisted: true },
        };
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-scroll-to-ref") {
        if (browserScrollDestroy) { req.socket.destroy(); return; }
        let parsedScroll = {};
        try { parsedScroll = JSON.parse(body); } catch {}
        scrollRequests.push({ body: parsedScroll, authorization: req.headers["authorization"] });
        const responseBody = browserScrollBody ?? {
          ok: true,
          data: { mode: "scroll_to_ref", hint: "take_new_snapshot" },
        };
        res.writeHead(browserScrollStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }
      if (
        req.method === "POST" &&
        req.url.startsWith("/api/internal/browser-run-trace/") &&
        req.url.endsWith("/disposition")
      ) {
        let parsedDisp = {};
        try { parsedDisp = JSON.parse(body); } catch {}
        dispositionRequests.push({ url: req.url, body: parsedDisp, authorization: req.headers["authorization"] });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: server.address().port,
    getSnapshotRequests: () => snapshotRequests,
    getClickRequests: () => clickRequests,
    getScrollRequests: () => scrollRequests,
    getTypeRequests: () => typeRequests,
    getEndpointRequests: () => endpointRequests,
    getDispositionRequests: () => dispositionRequests,
  };
}

function parseMcpResponse(stdoutBuf, id) {
  const lines = stdoutBuf.split("\n").filter((l) => l.trim());
  return lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m?.id === id) ?? null;
}

describe("G. browser_type adapter-owned — no Playwright fallthrough", () => {

  test("INTERCEPTION_ENABLED=false: returns clean MCP error with ANTIGEN_REALISM_UNAVAILABLE", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",   // visible mode OFF → INTERCEPTION_ENABLED=false
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    // Send browser_type after a short delay — ensureRuntime fires on first browser call.
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 42, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search box", ref: "e32", text: "desk lamp", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 42);
    assert.ok(resp, `expected response for id=42, stdout was: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_REALISM_UNAVAILABLE"), `expected ANTIGEN_REALISM_UNAVAILABLE in: ${text}`);

    // No Zod target error
    assert.ok(!stdoutBuf.includes('"path":["target"]'), `Zod target error leaked to stdout`);
    assert.ok(!stdoutBuf.includes('"path": ["target"]'), `Zod target error leaked to stdout`);

    // No raw typed text
    assert.ok(!stdoutBuf.includes("desk lamp"), `raw text value leaked to stdout`);
  });

  test("INTERCEPTION_ENABLED=true, API 422: returns clean MCP error with error code", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 422,
      browserTypeBody: {
        ok: false,
        error: { code: "ELEMENT_NOT_FOUND", message: "Element not found." },
        data: { char_count_bucket: "5-8", duration_ms: 0 },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 43, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search box", ref: "e32", text: "desk lamp", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 43);
    assert.ok(resp, `expected response for id=43, stdout was: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ELEMENT_NOT_FOUND"), `expected ELEMENT_NOT_FOUND in: ${text}`);

    assert.ok(!stdoutBuf.includes('"path":["target"]'), `Zod target error leaked to stdout`);
    assert.ok(!stdoutBuf.includes("desk lamp"), `raw text value leaked to stdout`);
  });

  test("INTERCEPTION_ENABLED=true, network error: returns clean MCP error with ANTIGEN_TYPE_INTERCEPT_ERROR", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({ browserTypeDestroy: true });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 44, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search", ref: "e5", text: "table", submit: false } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 44);
    assert.ok(resp, `expected response for id=44, stdout was: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_TYPE_INTERCEPT_ERROR"), `expected ANTIGEN_TYPE_INTERCEPT_ERROR in: ${text}`);

    assert.ok(!stdoutBuf.includes('"path":["target"]'), `Zod target error leaked to stdout`);
    assert.ok(!stdoutBuf.includes("table"), `raw text value leaked to stdout`);
  });

  test("INTERCEPTION_ENABLED=true, API success: returns synthetic success text with no raw text", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserTypeStatus: 200,
      browserTypeBody: { ok: true, data: { char_count_bucket: "5-8", duration_ms: 150, focused: true, submitted: true } },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 45, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search", ref: "e5", text: "sofa chair", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 45);
    assert.ok(resp, `expected response for id=45, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success (no isError), got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("path=realistic_success"), `expected path=realistic_success in: ${text}`);
    assert.ok(text.includes("char_count_bucket=5-8"), `expected bucket in: ${text}`);
    assert.ok(text.includes("focused=true"), `expected focused=true in: ${text}`);
    assert.ok(text.includes("submitted=true"), `expected submitted=true in: ${text}`);
    assert.ok(!stdoutBuf.includes("sofa chair"), `raw text value leaked to stdout`);
  });
});

// ─── H. browser_click adapter-owned — no Playwright fallthrough ──────────────

describe("H. browser_click adapter-owned — no Playwright fallthrough", () => {

  test("INTERCEPTION_ENABLED=false: returns clean MCP error with ANTIGEN_REALISM_UNAVAILABLE", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",   // visible mode OFF → INTERCEPTION_ENABLED=false
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 50, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "desk lamp suggestion", ref: "e32" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 50);
    assert.ok(resp, `expected response for id=50, stdout was: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_REALISM_UNAVAILABLE"), `expected ANTIGEN_REALISM_UNAVAILABLE in: ${text}`);
    assert.ok(!text.includes("browser_type"), `browser_click error must not say browser_type: ${text}`);

    assert.ok(!stdoutBuf.includes('"path":["target"]'), `Zod target error leaked to stdout`);
    assert.ok(!stdoutBuf.includes('"path": ["target"]'), `Zod target error leaked to stdout`);
  });

  test("INTERCEPTION_ENABLED=true, API 422: returns clean MCP error with error code, no fallthrough", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserClickStatus: 422,
      browserClickBody: {
        ok: false,
        error: { code: "ELEMENT_NOT_FOUND", message: "Element not found." },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 51, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "desk lamp suggestion", ref: "e32" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 51);
    assert.ok(resp, `expected response for id=51, stdout was: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ELEMENT_NOT_FOUND"), `expected ELEMENT_NOT_FOUND in: ${text}`);
    assert.ok(!text.includes("browser_type"), `browser_click error must not say browser_type: ${text}`);

    assert.ok(!stdoutBuf.includes('"path":["target"]'), `Zod target error leaked to stdout`);
  });

  test("INTERCEPTION_ENABLED=true, API success: returns path=realistic_success and source", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserClickStatus: 200,
      browserClickBody: { ok: true, data: { mode: "realistic_pointer_click", pointer_path_point_count: 37, pointer_start_source: "viewport_center", pointer_state_persisted: false } },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 52, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "desk lamp suggestion", ref: "e32" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 52);
    assert.ok(resp, `expected response for id=52, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success (no isError), got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("path=realistic_success"), `expected path=realistic_success in: ${text}`);
    assert.ok(text.includes("source=antigen-browser-adapter"), `expected source in: ${text}`);
    assert.ok(!stdoutBuf.includes('"path":["target"]'), `Zod target error leaked to stdout`);
  });

  test("capability-state gate: blocked_by_antigen_platform surfaces isError and the handoff, NOT a success", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserClickStatus: 200,
      browserClickBody: {
        ok: true,
        data: {
          mode: "blocked_by_antigen_platform",
          dispatched: false,
          action_intent: "final_commit",
          recommended_handoff: "request_purchase_confirmation",
          reason: "This is a final purchase/payment commitment.",
        },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 53, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Place order", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 53);
    assert.ok(resp, `expected response for id=53, stdout was: ${stdoutBuf}`);
    // Must be an error — the agent must never be told the click succeeded.
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("BLOCKED_BY_ANTIGEN_PLATFORM"), `expected block code in: ${text}`);
    assert.ok(text.includes("request_purchase_confirmation"), `expected handoff in: ${text}`);
    assert.ok(!text.includes("realistic_success"), `must not report a successful click: ${text}`);
  });

  test("INTERCEPTION_ENABLED=true, API success with pointer metadata: output includes pointer fields", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer();  // default body has pointer_path_point_count=42, pointer_start_source=session

    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 53, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "desk lamp suggestion", ref: "e32" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 53);
    assert.ok(resp, `expected response for id=53, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("pointer_path_point_count=42"), `expected pointer_path_point_count=42 in: ${text}`);
    assert.ok(text.includes("pointer_start_source=session"), `expected pointer_start_source=session in: ${text}`);

    // No forbidden internals
    const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", "password", "secret", '"path":["target"]'];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
    }
  });

  test("INTERCEPTION_ENABLED=true, snapshot ref as target: treated as description not selector", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    // ref="e2309" is a snapshot ref — looksLikeSelector must reject it
    // No element provided — element_description falls back to target=""
    // target="e2309" is also not a selector, so element_description="e2309" from fallback
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 54, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "search suggestion item", ref: "e2309" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 54);
    assert.ok(resp, `expected response for id=54, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success (element provided), got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    // hint must be "description" because "e2309" is not a CSS selector
    assert.ok(text.includes("hint=description"), `expected hint=description (not selector) in: ${text}`);
  });
});

// ─── H2. browser_click Antigen ag_* ref pass-through (Phase 4A) ──────────────
//
// When browser_click is called with ref=ag_<n>, the adapter passes the ref
// straight through to the backend browser-click endpoint (which resolves it
// against the latest Antigen snapshot and clicks the stored box). The adapter
// never resolves the ref, never touches Playwright, never sees coordinates.
describe("H2. browser_click Antigen ag_* ref pass-through", () => {

  test("sends ref=ag_1 to the backend and surfaces realistic pointer metadata", { timeout: 7000 }, async () => {
    const { server, port, getClickRequests } = await createMockApiServer({
      browserClickBody: { ok: true, data: { mode: "realistic_pointer_click", pointer_path_point_count: 9, pointer_start_source: "session", pointer_state_persisted: true } },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 60, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Ok", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // Backend received the ag_ ref verbatim.
    const clicks = getClickRequests();
    assert.equal(clicks.length, 1, `expected one browser-click request, got ${clicks.length}`);
    assert.equal(clicks[0].body.ref, "ag_1", `expected ref=ag_1 forwarded, got: ${JSON.stringify(clicks[0].body)}`);

    const resp = parseMcpResponse(stdoutBuf, 60);
    assert.ok(resp, `expected response for id=60, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("path=realistic_success"), `expected path=realistic_success in: ${text}`);
    assert.ok(text.includes("pointer_path_point_count=9"), `expected pointer_path_point_count=9 in: ${text}`);
    assert.ok(text.includes("pointer_start_source=session"), `expected pointer_start_source=session in: ${text}`);
    assert.ok(text.includes("pointer_state_persisted=true"), `expected pointer_state_persisted=true in: ${text}`);
    assert.ok(text.includes("source=antigen-browser-adapter"), `expected source in: ${text}`);

    // No forbidden internals / coordinates in output.
    const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", "\"box\"", "snapshot_id", '"path":["target"]'];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
    }
  });

  test("ANTIGEN_REF_NOT_FOUND backend error returns a clean browser_click error (not browser_type)", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserClickStatus: 422,
      browserClickBody: { ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: "Antigen ref 'ag_99' was not found in the latest snapshot." } },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 61, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Ok", ref: "ag_99" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 61);
    assert.ok(resp, `expected response for id=61, stdout was: ${stdoutBuf}`);
    assert.ok(resp.result?.isError, `expected isError, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_REF_NOT_FOUND"), `expected ANTIGEN_REF_NOT_FOUND in: ${text}`);
    assert.ok(text.includes("browser_click"), `error must reference browser_click: ${text}`);
    assert.ok(!text.includes("browser_type"), `browser_click error must not say browser_type: ${text}`);
  });

  test("ANTIGEN_REF_STALE (Phase 4B) returns a clean error telling the agent to re-snapshot", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserClickStatus: 422,
      browserClickBody: { ok: false, error: { code: "ANTIGEN_REF_STALE", message: "Antigen ref is stale. Take a new antigen_snapshot and retry." } },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 62, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Ok", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 62);
    assert.ok(resp, `expected response for id=62, stdout was: ${stdoutBuf}`);
    assert.ok(resp.result?.isError, `expected isError, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_REF_STALE"), `expected ANTIGEN_REF_STALE in: ${text}`);
    assert.ok(text.includes("antigen_snapshot"), `error should tell agent to re-snapshot: ${text}`);
    assert.ok(text.includes("browser_click"), `error must reference browser_click: ${text}`);
    assert.ok(!text.includes("browser_type"), `browser_click error must not say browser_type: ${text}`);

    // No forbidden internals / coordinates in output.
    const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", "\"box\"", "cdp_url", "9222"];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
    }
  });

  test("ANTIGEN_REF_OUT_OF_VIEWPORT (Phase 4C) returns a clean error telling the agent to scroll + re-snapshot", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserClickStatus: 422,
      browserClickBody: { ok: false, error: { code: "ANTIGEN_REF_OUT_OF_VIEWPORT", message: "Antigen ref is outside the current viewport. Scroll the target into view, take a new antigen_snapshot, and retry." } },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 63, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Ok", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 63);
    assert.ok(resp, `expected response for id=63, stdout was: ${stdoutBuf}`);
    assert.ok(resp.result?.isError, `expected isError, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_REF_OUT_OF_VIEWPORT"), `expected ANTIGEN_REF_OUT_OF_VIEWPORT in: ${text}`);
    assert.ok(text.includes("antigen_snapshot"), `error should tell agent to re-snapshot: ${text}`);
    assert.ok(text.toLowerCase().includes("scroll"), `error should tell agent to scroll into view: ${text}`);
    assert.ok(text.includes("browser_click"), `error must reference browser_click: ${text}`);
    assert.ok(!text.includes("browser_type"), `browser_click error must not say browser_type: ${text}`);

    // No forbidden internals / coordinates in output.
    const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", "\"box\"", "cdp_url", "9222"];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
    }
  });
});

// ─── H3. browser_scroll_to_ref adapter tool (Phase 5C) ──────────────────────
//
// browser_scroll_to_ref is adapter-owned: it scrolls an offscreen ag_* ref near
// the viewport so the agent can take a fresh antigen_snapshot before clicking. It
// NEVER falls through to Playwright, never clicks, and never exposes coordinates.
describe("H3. browser_scroll_to_ref adapter tool", () => {

  test("tools/list includes browser_scroll_to_ref requiring ref, with no agent-supplied browser_runtime_id", { timeout: 5000 }, async () => {
    const { mockServer, serverReady } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 300));

    const toolsResponse = parseMcpResponse(stdoutBuf, 2);
    assert.ok(toolsResponse, `expected tools/list response, stdout: ${stdoutBuf}`);
    const tools = toolsResponse.result?.tools ?? [];
    const scroll = tools.find((t) => t.name === "browser_scroll_to_ref");
    assert.ok(scroll, "tools list should include browser_scroll_to_ref");
    const props = scroll.inputSchema?.properties ?? {};
    assert.ok("ref" in props, "schema should expose ref");
    assert.ok(Array.isArray(scroll.inputSchema?.required) && scroll.inputSchema.required.includes("ref"), "ref must be required");
    assert.ok(!("browser_runtime_id" in props), "agent-facing schema must NOT expose browser_runtime_id");

    adapter.kill("SIGTERM");
    mockServer.close();
  });

  test("success: POSTs { ref, browser_runtime_id } and returns scroll_to_ref_success guidance", { timeout: 7000 }, async () => {
    const { server, port, getScrollRequests } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",   // scroll is independent of interception
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 70, method: "tools/call",
      params: { name: "browser_scroll_to_ref", arguments: { ref: "ag_47" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // Backend received { ref, browser_runtime_id } — the latter supplied internally.
    const scrolls = getScrollRequests();
    assert.equal(scrolls.length, 1, `expected one browser-scroll-to-ref request, got ${scrolls.length}`);
    assert.equal(scrolls[0].body.ref, "ag_47", `expected ref=ag_47 forwarded, got: ${JSON.stringify(scrolls[0].body)}`);
    assert.ok(scrolls[0].body.browser_runtime_id, `adapter must supply browser_runtime_id internally: ${JSON.stringify(scrolls[0].body)}`);

    const resp = parseMcpResponse(stdoutBuf, 70);
    assert.ok(resp, `expected response for id=70, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("path=scroll_to_ref_success"), `expected path=scroll_to_ref_success in: ${text}`);
    assert.ok(text.includes("browser_scroll_to_ref"), `expected browser_scroll_to_ref in: ${text}`);
    assert.ok(text.includes("take_new_snapshot") || text.includes("take a new antigen_snapshot"), `expected re-snapshot guidance in: ${text}`);
    assert.ok(text.includes("source=antigen-browser-adapter"), `expected adapter source in: ${text}`);

    // No forbidden internals / coordinates in output.
    const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", "\"box\"", "doc_x", "doc_y", "cdp_url", "9222", "test_runtime_001"];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
    }
  });

  test("malformed ref returns a clean ANTIGEN_REF_INVALID without calling the backend", { timeout: 7000 }, async () => {
    const { server, port, getScrollRequests } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 71, method: "tools/call",
      params: { name: "browser_scroll_to_ref", arguments: { ref: "not-a-ref" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    assert.equal(getScrollRequests().length, 0, "malformed ref must not reach the backend");
    const resp = parseMcpResponse(stdoutBuf, 71);
    assert.ok(resp, `expected response for id=71, stdout was: ${stdoutBuf}`);
    assert.ok(resp.result?.isError, `expected isError, got: ${JSON.stringify(resp.result)}`);
    assert.ok((resp.result?.content?.[0]?.text ?? "").includes("ANTIGEN_REF_INVALID"), `expected ANTIGEN_REF_INVALID in: ${resp.result?.content?.[0]?.text}`);
  });

  // Each backend error code surfaces cleanly and tells the agent to re-snapshot.
  for (const { id, code, label } of [
    { id: 72, code: "ANTIGEN_REF_NOT_FOUND", label: "not found" },
    { id: 73, code: "ANTIGEN_REF_EXPIRED", label: "expired" },
    { id: 74, code: "ANTIGEN_REF_NOT_SCROLLABLE", label: "not scrollable" },
    { id: 75, code: "ANTIGEN_SCROLL_FAILED", label: "scroll failed" },
  ]) {
    test(`backend ${code} surfaces cleanly (${label})`, { timeout: 7000 }, async () => {
      const { server, port } = await createMockApiServer({
        browserScrollStatus: 422,
        browserScrollBody: { ok: false, error: { code, message: `Antigen browser_scroll_to_ref ${label}.` } },
      });
      const { binPath, cleanup } = createFakeMcpBin();

      const adapter = spawn(process.execPath, [ADAPTER_PATH], {
        env: {
          ...process.env,
          PATH: `${binPath}:${process.env.PATH ?? ""}`,
          AEGIS_API_BASE: `http://127.0.0.1:${port}`,
          AEGIS_AGENT_TOKEN: "test_token",
          ANTIGEN_BROWSER_HEADLESS: "true",
          ANTIGEN_INPUT_REALISM: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBuf = "";
      adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

      adapter.stdin.write(MCP_INIT_MSG);
      await new Promise((r) => setTimeout(r, 200));
      adapter.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "browser_scroll_to_ref", arguments: { ref: "ag_47" } },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 1500));

      adapter.kill("SIGTERM");
      server.close();
      cleanup();

      const resp = parseMcpResponse(stdoutBuf, id);
      assert.ok(resp, `expected response for id=${id}, stdout was: ${stdoutBuf}`);
      assert.ok(resp.result?.isError, `expected isError, got: ${JSON.stringify(resp.result)}`);
      const text = resp.result?.content?.[0]?.text ?? "";
      assert.ok(text.includes(code), `expected ${code} in: ${text}`);
      assert.ok(text.includes("browser_scroll_to_ref"), `error must reference browser_scroll_to_ref: ${text}`);

      const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", "\"box\"", "doc_x", "doc_y", "cdp_url", "9222"];
      for (const f of FORBIDDEN) {
        assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
      }
    });
  }

  test("does not hijack browser_click / browser_snapshot routing", { timeout: 7000 }, async () => {
    const { server, port, getClickRequests, getScrollRequests } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 76, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Ok", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // browser_click still reaches the click endpoint; the scroll endpoint is untouched.
    assert.equal(getClickRequests().length, 1, "browser_click must still call browser-click");
    assert.equal(getScrollRequests().length, 0, "browser_click must not call browser-scroll-to-ref");
  });
});

// ─── I. browser_navigate — navigation-aware pointer continuity ─────────────────
//
// browser_navigate forwards actual page load to @playwright/mcp (fake MCP stub),
// then calls POST /api/agent/v1/runtime/browser-navigation-state and waits for it
// to complete before forwarding the navigate response to Cowork.
//
// Infrastructure reuses createFakeMcpBin() and extends createMockApiServer to
// handle the navigation-state endpoint.

async function createNavMockApiServer(opts = {}) {
  const {
    navStateStatus = 200,
    navStateBody = null,
    navStateDelayMs = 0,
    browserTypeStatus = 200,
    browserTypeBody = null,
    // Optional per-call sequences for browser-navigation-state (SESSION_NOT_FOUND
    // recovery tests). Each request shifts the next status/body; falls back to the
    // static navStateStatus/Body when exhausted/null.
    navStateStatusSequence = null, navStateBodySequence = null,
    // Optional per-call sequence of browser_runtime_id values for the
    // browser-endpoint handler (init, then re-init) — fresh-id continuity tests.
    browserEndpointIdSequence = null,
  } = opts;

  const navRequests = [];
  const endpointRequests = [];
  const dispositionRequests = [];
  // True once at least one navigation-disposition POST has been received. The fake
  // child fires /__child_received_navigate when it gets the navigate line; we
  // snapshot this flag at that moment to prove the disposition POST landed first
  // (i.e. noteNavigationDisposition ran before child.stdin.write).
  let navigationDispositionSeen = false;
  const childNavigateMarkers = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      // Capture navigation-discipline disposition POSTs (Antigen Browser Realism v1).
      if (req.method === "POST" && typeof req.url === "string" && req.url.endsWith("/navigation-disposition")) {
        let parsedDisp = {};
        try { parsedDisp = JSON.parse(body); } catch {}
        dispositionRequests.push(parsedDisp);
        navigationDispositionSeen = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Ordering marker fired by the fake MCP child when it receives a navigate
      // line. Snapshot whether the disposition POST has already arrived.
      if (req.method === "POST" && req.url === "/__child_received_navigate") {
        childNavigateMarkers.push({ disposition_seen_at_child_receipt: navigationDispositionSeen });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-endpoint") {
        let parsedEndpoint = {};
        try { parsedEndpoint = JSON.parse(body); } catch {}
        endpointRequests.push(parsedEndpoint);
        const seqId = Array.isArray(browserEndpointIdSequence) && browserEndpointIdSequence.length
          ? browserEndpointIdSequence.shift() : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: {
            cdp_url: "http://127.0.0.1:19999",
            browser_runtime_id: seqId ?? "test_runtime_001",
            runtime_mode: "test_mode",
            reused_existing: false,
          },
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-navigation-state") {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        navRequests.push(parsed);
        const seqStatus = Array.isArray(navStateStatusSequence) && navStateStatusSequence.length
          ? navStateStatusSequence.shift() : null;
        const seqBody = Array.isArray(navStateBodySequence) && navStateBodySequence.length
          ? navStateBodySequence.shift() : null;
        const respond = () => {
          const responseBody = seqBody ?? navStateBody ?? {
            ok: true,
            data: { pointer_state_persisted: true, pointer_start_source: "session", pointer_action: "navigation_proxy" },
          };
          res.writeHead(seqStatus ?? navStateStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseBody));
        };
        if (navStateDelayMs > 0) {
          setTimeout(respond, navStateDelayMs);
        } else {
          respond();
        }
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-type") {
        const responseBody = browserTypeBody ?? {
          ok: true,
          data: { char_count_bucket: "9-16", duration_ms: 120, focused: true, submitted: false, pointer_start_source: "session", pointer_state_persisted: true },
        };
        res.writeHead(browserTypeStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: server.address().port,
    getNavRequests: () => navRequests,
    getEndpointRequests: () => endpointRequests,
    getDispositionRequests: () => dispositionRequests,
    getChildNavigateMarkers: () => childNavigateMarkers,
  };
}

// Fake MCP stub that responds to browser_navigate with a success result. When
// ANTIGEN_FAKE_MCP_MARKER_URL is set (inherited from the adapter's spawn env), it
// fires an ordering marker (POST to that URL) BEFORE writing the navigate response,
// so the ordering test can prove the adapter's disposition POST landed before the
// navigate line reached the child. Backward-compatible: with no marker URL set,
// behavior is identical to before.
const FAKE_MCP_NAVIGATE_STUB_SRC = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const markerUrl = process.env.ANTIGEN_FAKE_MCP_MARKER_URL;
function respondNavigate(id, url) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: "Navigated to " + (url ?? "unknown") }] }
  }) + "\\n");
}
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line.trim());
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp-nav", version: "0" } }
      }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params?.name === "browser_navigate") {
      const url = msg.params?.arguments?.url;
      if (markerUrl) {
        // Fire the ordering marker first; only respond once the marker POST is sent.
        fetch(markerUrl, { method: "POST" })
          .catch(() => {})
          .finally(() => respondNavigate(msg.id, url));
      } else {
        respondNavigate(msg.id, url);
      }
    }
  } catch {}
});
process.stdin.resume();
`;

function createNavigateFakeMcpBin() {
  const tmpDir = mkdtempSync(join(tmpdir(), "antigen-nav-mcp-"));
  const fakeMcpPath = join(tmpDir, "fake-mcp-nav.mjs");
  writeFileSync(fakeMcpPath, FAKE_MCP_NAVIGATE_STUB_SRC, "utf8");
  const fakeNpxPath = join(tmpDir, "npx");
  writeFileSync(fakeNpxPath, `#!/bin/sh\nexec ${process.execPath} ${fakeMcpPath}\n`, "utf8");
  chmodSync(fakeNpxPath, 0o755);
  return {
    binPath: tmpDir,
    cleanup() { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} },
  };
}

// Fake MCP stub that answers initialize immediately but delays its browser_navigate
// response. Used to exercise the late-child-response path: the adapter's safety-net
// timeout fires first, then the delayed child response must be dropped (no duplicate).
function createDelayedNavigateFakeMcpBin(delayMs) {
  const stubSrc = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line.trim());
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp-nav-delayed", version: "0" } }
      }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params?.name === "browser_navigate") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { content: [{ type: "text", text: "Navigated to " + (msg.params?.arguments?.url ?? "unknown") }] }
        }) + "\\n");
      }, ${Number(delayMs)});
    }
  } catch {}
});
process.stdin.resume();
`;
  const tmpDir = mkdtempSync(join(tmpdir(), "antigen-nav-delayed-mcp-"));
  const fakeMcpPath = join(tmpDir, "fake-mcp-nav-delayed.mjs");
  writeFileSync(fakeMcpPath, stubSrc, "utf8");
  const fakeNpxPath = join(tmpDir, "npx");
  writeFileSync(fakeNpxPath, `#!/bin/sh\nexec ${process.execPath} ${fakeMcpPath}\n`, "utf8");
  chmodSync(fakeNpxPath, 0o755);
  return {
    binPath: tmpDir,
    cleanup() { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} },
  };
}

// Count how many JSON-RPC lines in stdout carry the given id (duplicate detector).
function countMcpResponses(stdoutBuf, id) {
  return stdoutBuf
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m?.id === id).length;
}

describe("I. browser_navigate — navigation-aware pointer continuity", () => {

  test("browser_navigate forwards child response to Cowork after nav-state update", { timeout: 7000 }, async () => {
    const { server, port } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 70, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 70);
    assert.ok(resp, `expected response for id=70, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    // @playwright/mcp fake returns "Navigated to <url>"
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("Navigated to"), `expected navigate success text, got: ${text}`);
  });

  test("browser_navigate calls browser-navigation-state endpoint after child responds", { timeout: 7000 }, async () => {
    const { server, port, getNavRequests } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 71, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const navReqs = getNavRequests();
    assert.equal(navReqs.length, 1, `expected 1 nav-state call, got ${navReqs.length}`);
    assert.equal(navReqs[0].action, "navigation_proxy", `expected action=navigation_proxy`);
    assert.equal(navReqs[0].url, "https://www.ikea.com/us/en/", `expected url to match`);
    assert.ok(navReqs[0].browser_runtime_id, `expected browser_runtime_id to be set`);
  });

  test("browser_navigate waits for nav-state update before forwarding response (deterministic, not fire-and-forget)", { timeout: 7000 }, async () => {
    // Add a 150ms delay to the nav-state endpoint. Track when the navigate response
    // (id=72) specifically arrives in stdout — it must arrive after the delay completes.
    const { server, port } = await createNavMockApiServer({ navStateDelayMs: 150 });
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let navigateResponseArrivedAt = null;
    adapter.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      // Check if the navigate response (id=72) has arrived in this chunk
      if (navigateResponseArrivedAt === null) {
        const lines = stdoutBuf.split("\n");
        for (const l of lines) {
          try {
            const parsed = JSON.parse(l.trim());
            if (parsed?.id === 72) {
              navigateResponseArrivedAt = Date.now();
              break;
            }
          } catch {}
        }
      }
    });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    const navigateSentAt = Date.now();
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 72, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 72);
    assert.ok(resp, `expected response for id=72`);
    assert.ok(navigateResponseArrivedAt !== null, `expected navigate response to have arrived`);
    // The response must have arrived at least 130ms after navigate was sent
    // (the nav-state update adds 150ms of delay — proving it was awaited, not fire-and-forget).
    const elapsed = navigateResponseArrivedAt - navigateSentAt;
    assert.ok(elapsed >= 130, `expected response to take >=130ms (nav-state delay=150ms), got ${elapsed}ms`);
  });

  test("browser_navigate still succeeds when nav-state endpoint returns non-200", { timeout: 7000 }, async () => {
    const { server, port } = await createNavMockApiServer({
      navStateStatus: 500,
      navStateBody: { ok: false, error: { code: "INTERNAL_ERROR", message: "Test error" } },
    });
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 73, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // Navigation must still succeed despite nav-state failure
    const resp = parseMcpResponse(stdoutBuf, 73);
    assert.ok(resp, `expected response for id=73`);
    assert.ok(!resp.result?.isError, `expected navigation success despite nav-state error`);
    // Safe diagnostic must appear in stderr
    assert.ok(stderrBuf.includes("navigation_state_update"), `expected navigation_state_update in stderr`);
  });

  test("browser_navigate still succeeds when nav-state endpoint times out (>400ms)", { timeout: 10000 }, async () => {
    const { server, port } = await createNavMockApiServer({ navStateDelayMs: 600 }); // > 400ms timeout
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 74, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 3000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 74);
    assert.ok(resp, `expected response for id=74`);
    assert.ok(!resp.result?.isError, `expected navigation success despite nav-state timeout`);
    assert.ok(stderrBuf.includes("TIMEOUT"), `expected TIMEOUT in stderr, got: ${stderrBuf}`);
  });

  test("non-navigation child responses are forwarded normally after browser_navigate", { timeout: 7000 }, async () => {
    const { server, port } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));

    // First: navigate
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 75, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    // Then: browser_type (adapter-owned, goes through Aegis API)
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 76, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search box", text: "desk lamp", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // Both responses must be present
    const navResp = parseMcpResponse(stdoutBuf, 75);
    assert.ok(navResp, `expected navigate response for id=75`);
    const typeResp = parseMcpResponse(stdoutBuf, 76);
    assert.ok(typeResp, `expected browser_type response for id=76`);
  });

  test("after browser_navigate, browser_type response includes pointer_start_source=session", { timeout: 7000 }, async () => {
    const { server, port } = await createNavMockApiServer({
      browserTypeBody: {
        ok: true,
        data: { char_count_bucket: "9-16", duration_ms: 130, focused: true, submitted: true, submit_method: "enter", pointer_start_source: "session", pointer_state_persisted: true },
      },
    });
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 77, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 78, method: "tools/call",
      params: { name: "browser_type", arguments: { element: "Search box", text: "desk lamp", submit: true } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const typeResp = parseMcpResponse(stdoutBuf, 78);
    assert.ok(typeResp, `expected browser_type response for id=78`);
    assert.ok(!typeResp.result?.isError, `expected success`);
    const text = typeResp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("pointer_start_source=session"), `expected pointer_start_source=session, got: ${text}`);
    assert.ok(text.includes("pointer_state_persisted=true"), `expected pointer_state_persisted=true, got: ${text}`);
  });

  test("no forbidden internals appear in navigate stdout", { timeout: 7000 }, async () => {
    const { server, port } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 79, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", "password", "cdp_url", '"secret"'];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden field "${f}" leaked to stdout`);
    }
  });

  test("does NOT return NAVIGATE_CHILD_TIMEOUT when child responds normally (default safety-net timeout)", { timeout: 7000 }, async () => {
    // No ANTIGEN_NAVIGATE_CHILD_TIMEOUT_MS override → adapter uses its generous default.
    // A normal child response must forward immediately, never racing a false timeout.
    const { server, port } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 90, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 90);
    assert.ok(resp, `expected response for id=90, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("Navigated to"), `expected navigate success text, got: ${text}`);
    assert.ok(!stdoutBuf.includes("NAVIGATE_CHILD_TIMEOUT"), `must not emit NAVIGATE_CHILD_TIMEOUT for a normal response`);
    assert.equal(countMcpResponses(stdoutBuf, 90), 1, `expected exactly one response for id=90`);
  });

  test("child truly never responds → NAVIGATE_CHILD_TIMEOUT once, with cleanup diagnostic", { timeout: 7000 }, async () => {
    // FAKE_MCP_STUB_SRC (createFakeMcpBin) answers initialize but NEVER browser_navigate.
    // Short safety-net timeout so the never-responds path is exercised quickly.
    const { server, port } = await createNavMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
        ANTIGEN_NAVIGATE_CHILD_TIMEOUT_MS: "600",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 91, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1800));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 91);
    assert.ok(resp, `expected response for id=91, stdout was: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("NAVIGATE_CHILD_TIMEOUT"), `expected NAVIGATE_CHILD_TIMEOUT in: ${text}`);
    assert.equal(countMcpResponses(stdoutBuf, 91), 1, `expected exactly one response for id=91`);
    assert.ok(stderrBuf.includes("navigation_child_timeout"), `expected navigation_child_timeout diagnostic in stderr`);
  });

  test("late child response after synthetic timeout is dropped (no duplicate response)", { timeout: 8000 }, async () => {
    // Child replies to browser_navigate after 1200ms, but the safety-net timeout is 400ms.
    // The timeout response goes out first; the late child line must be dropped, not re-forwarded.
    const { server, port } = await createNavMockApiServer();
    const { binPath, cleanup } = createDelayedNavigateFakeMcpBin(1200);

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
        ANTIGEN_NAVIGATE_CHILD_TIMEOUT_MS: "400",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 92, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    // Wait past the child's 1200ms delay so the late response would have arrived.
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // Exactly one response for id=92, and it is the timeout error — the late line was dropped.
    assert.equal(countMcpResponses(stdoutBuf, 92), 1, `expected exactly one response for id=92 (no duplicate)`);
    const resp = parseMcpResponse(stdoutBuf, 92);
    assert.ok(resp, `expected response for id=92`);
    assert.equal(resp.result?.isError, true, `expected the single response to be the timeout error`);
    assert.ok((resp.result?.content?.[0]?.text ?? "").includes("NAVIGATE_CHILD_TIMEOUT"), `expected NAVIGATE_CHILD_TIMEOUT`);
    assert.ok(stderrBuf.includes("navigation_late_child_response_dropped"), `expected late-response-dropped diagnostic in stderr`);
    assert.ok(!stdoutBuf.includes("Navigated to"), `late child success text must not reach stdout`);
  });

  // ── Realistic-navigation hard mode: fresh snapshot required before deep nav ──
  // The fake MCP stub returns navigate success, so the first navigate sets the
  // adapter's currentUrl. A second same-site deep navigate with no fresh snapshot
  // must then be BLOCKED in hard mode — short-circuited before the child write and
  // before the browser-navigation-state call — and a disposition must be recorded
  // for BOTH the allowed first navigate and the blocked second navigate.

  test("8. hard mode: same-site deep navigate with no fresh snapshot is blocked before the child write", { timeout: 9000 }, async () => {
    const { server, port, getNavRequests, getDispositionRequests } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
        ANTIGEN_BROWSER_TRACE: "true",
        ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    // Navigate #1 — first navigation is always allowed; fake child returns success
    // so the adapter records currentUrl = the IKEA listing page.
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 200, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/cat/bookcases" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1800));
    // Navigate #2 — same-site product deeplink, no fresh snapshot → blocked in hard mode.
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 201, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // Navigate #1 succeeded and forwarded the child response.
    const r1 = parseMcpResponse(stdoutBuf, 200);
    assert.ok(r1 && !r1.result?.isError, `nav#1 should succeed: ${JSON.stringify(r1?.result)}`);

    // Navigate #2 was blocked with the synthetic realistic-navigation error — proof
    // it short-circuited before the child write (the fake child never saw it).
    const r2 = parseMcpResponse(stdoutBuf, 201);
    assert.ok(r2, `expected a response for nav#2 (id=201), stdout: ${stdoutBuf}`);
    assert.equal(r2.result?.isError, true, `nav#2 must be a synthetic error`);
    const r2text = r2.result?.content?.[0]?.text ?? "";
    assert.ok(r2text.includes("ANTIGEN_REALISTIC_NAVIGATION_REQUIRED"), `expected realistic-nav error code, got: ${r2text}`);
    assert.match(r2text, /antigen_snapshot first/, `block message should instruct antigen_snapshot first: ${r2text}`);

    // browser-navigation-state was called exactly once — only for the allowed nav#1.
    // The blocked nav#2 never reached the forward-to-child / nav-state path.
    assert.equal(getNavRequests().length, 1, `nav-state must be called once (nav#1 only), got ${getNavRequests().length}`);

    // A blocked disposition was recorded for nav#2.
    const blocked = getDispositionRequests().find((d) => d.navigation_disposition === "direct_navigation_blocked");
    assert.ok(blocked, `expected a blocked disposition POST, got: ${JSON.stringify(getDispositionRequests())}`);
    assert.equal(blocked.navigation_reason, "fresh_snapshot_required");

    // stderr preflight made the block visible with will_forward_to_child=false.
    assert.ok(stderrBuf.includes("navigate_preflight"), `expected navigate_preflight stderr line`);
    assert.ok(/decision=block[\s\S]*will_forward_to_child=false/.test(stderrBuf) ||
      stderrBuf.includes("will_forward_to_child=false"), `expected will_forward_to_child=false in preflight`);
  });

  test("9. hard mode: every adapter-handled navigate records a disposition (allowed + blocked)", { timeout: 9000 }, async () => {
    const { server, port, getDispositionRequests } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
        ANTIGEN_BROWSER_TRACE: "true",
        ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    adapter.stdout.on("data", () => {});
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 210, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/cat/bookcases" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1800));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 211, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const disps = getDispositionRequests();
    // Allowed first navigate posted a disposition...
    assert.ok(disps.some((d) => d.navigation_disposition === "direct_navigation_allowed"),
      `expected an allowed disposition POST, got: ${JSON.stringify(disps)}`);
    // ...and the blocked second navigate posted one too.
    assert.ok(disps.some((d) => d.navigation_disposition === "direct_navigation_blocked"),
      `expected a blocked disposition POST, got: ${JSON.stringify(disps)}`);
    // Two adapter-handled navigates → two disposition records.
    assert.equal(disps.length, 2, `expected exactly two disposition POSTs, got ${disps.length}`);
    // A preflight line was emitted per navigate.
    const preflightCount = (stderrBuf.match(/navigate_preflight/g) ?? []).length;
    assert.equal(preflightCount, 2, `expected two navigate_preflight stderr lines, got ${preflightCount}`);
  });

  // ── Requirement 5: the live browser_navigate branch emits the unconditional
  // handler-entry + preflight diagnostics AND attempts the navigation-disposition
  // POST on an ordinary (non-hard-mode) allowed navigation. This is the path the
  // live trace exercised when it showed navigation_state but zero disposition
  // events — it now must produce a disposition POST.
  test("10. live navigate branch emits handler-entered + preflight and attempts the navigation-disposition POST", { timeout: 7000 }, async () => {
    const { server, port, getDispositionRequests } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
        ANTIGEN_BROWSER_TRACE: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    adapter.stdout.on("data", () => {});
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 220, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1800));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    // Unconditional proof-of-entry + preflight diagnostics both fired for the navigate.
    assert.ok(stderrBuf.includes("browser_navigate_handler_entered"),
      `expected browser_navigate_handler_entered in stderr: ${stderrBuf}`);
    assert.match(stderrBuf, /browser_navigate_handler_entered request_id=220/,
      `expected handler-entered to carry the request id: ${stderrBuf}`);
    assert.ok(stderrBuf.includes("navigate_preflight"),
      `expected navigate_preflight in stderr: ${stderrBuf}`);

    // The navigation-disposition POST was attempted and landed at the backend.
    const disps = getDispositionRequests();
    assert.equal(disps.length, 1, `expected exactly one navigation-disposition POST, got ${disps.length}`);
    assert.equal(disps[0].tool, "browser_navigate", `disposition POST must be for browser_navigate`);
    assert.ok(typeof disps[0].navigation_disposition === "string" && disps[0].navigation_disposition.length > 0,
      `expected a navigation_disposition value, got: ${JSON.stringify(disps[0])}`);
  });

  // ── Requirement 4: a browser_navigate must never reach child.stdin.write
  // without noteNavigationDisposition running first. The fake child fires an
  // ordering marker (/__child_received_navigate) the instant it receives the
  // navigate line; the mock snapshots whether the disposition POST had already
  // arrived. Because the adapter awaits noteNavigationDisposition (which sends the
  // POST) before forwarding to the child, the snapshot must be true. This test
  // fails if that ordering is ever broken (e.g. the forward is moved earlier).
  test("11. browser_navigate cannot reach child.stdin.write before noteNavigationDisposition runs", { timeout: 7000 }, async () => {
    const { server, port, getChildNavigateMarkers } = await createNavMockApiServer();
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
        ANTIGEN_BROWSER_TRACE: "true",
        // Inherited by the spawned fake child; tells it to fire the ordering marker.
        ANTIGEN_FAKE_MCP_MARKER_URL: `http://127.0.0.1:${port}/__child_received_navigate`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    adapter.stdout.on("data", () => {});
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 230, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1800));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const markers = getChildNavigateMarkers();
    assert.equal(markers.length, 1, `expected the child to receive exactly one navigate, got ${markers.length}`);
    assert.equal(markers[0].disposition_seen_at_child_receipt, true,
      `browser_navigate reached child.stdin.write before the disposition POST was sent — ordering invariant broken`);
  });
});

// ─── J. buildAntigenSnapshotText — pure allowlist formatter ───────────────────

describe("J. buildAntigenSnapshotText — pure formatter", () => {
  const V = "2026-05-29";
  // Realistic Snapshot v2 response shape (page map + safe external elements).
  const SAMPLE = {
    snapshot_id: "snap_abc123",
    url: "https://www.ikea.com/us/en/search/?q=desk%20lamp",
    title: null,
    expires_at: "2026-01-01T00:00:10.000Z",
    element_count: 2,
    page_summary: {
      page_kind: "product_page",
      url_host: "www.ikea.com",
      url_path: "/us/en/search/",
      visible_heading: "Desk lamps",
    },
    current_scroll: { position: "top", more_above: false, more_below: true },
    primary_actions: [
      { ref: "ag_2", role: "button", name: "Add to bag", priority: "high", reason: "primary_purchase_action", action_hint: "browser_click", viewport_status: "visible", scroll_required: false },
    ],
    secondary_actions: [],
    navigation: [],
    forms: [
      { input_refs: ["ag_5"], submit_refs: ["ag_6"], action_hint: "browser_type_then_submit" },
    ],
    product_cards: [
      { title: "BILLY Bookcase white", price_text: "$59.99", add_ref: "ag_2", details_ref: "ag_1", refs: ["ag_1", "ag_2"] },
    ],
    warnings_or_modals: [
      { kind: "cookie_banner", message: "Cookie consent banner", dismiss_refs: ["ag_9"], action_hint: "browser_click" },
    ],
    action_hints: [
      { ref: "ag_1", action_hint: "browser_click" },
      { ref: "ag_2", action_hint: "browser_click" },
    ],
    elements: [
      {
        ref: "ag_1", kind: "link", role: "link", name: "TERTIAL, Work lamp, light blue",
        state: { visible: true, enabled: true, clickable: true, typeable: false },
        hints: { href_path: "/us/en/p/tertial-work-lamp-light-blue-70504295/" },
        viewport_status: "visible", scroll_required: false, stability_hint: "may_stale_after_navigation",
      },
      {
        ref: "ag_2", kind: "button", role: "button", name: "Add to bag",
        state: { visible: true, enabled: true, clickable: true, typeable: false },
        viewport_status: "visible", scroll_required: false, stability_hint: "fresh",
      },
    ],
  };

  test("header includes path, snapshot_id, element_count, source", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(text.includes("path=antigen_snapshot_success"), text);
    assert.ok(text.includes("snapshot_id=snap_abc123"), text);
    assert.ok(text.includes("element_count=2"), text);
    assert.ok(text.includes(`source=antigen-browser-adapter@${V}`), text);
  });

  test("renders Page summary (kind + heading), sanitized URL host+path, and expires", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(text.includes("Page: product_page — Desk lamps"), text);
    assert.ok(text.includes("URL: www.ikea.com/us/en/search/"), text);
    // Sanitized host+path only — the query string never appears.
    assert.ok(!text.includes("?q=desk"), text);
    assert.ok(text.includes("Expires: 2026-01-01T00:00:10.000Z"), text);
  });

  test("renders Scroll position qualitatively (no raw numbers)", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(text.includes("Scroll: top (more below)"), text);
  });

  test("renders Primary actions, Forms, Product cards, and Warnings sections", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(text.includes("Primary actions:"), text);
    assert.ok(text.includes("- ag_2 [button] Add to bag — use browser_click"), text);
    assert.ok(text.includes("Forms:"), text);
    assert.ok(text.includes("inputs ag_5"), text);
    assert.ok(text.includes("submit ag_6"), text);
    assert.ok(text.includes("Product cards:"), text);
    assert.ok(text.includes("BILLY Bookcase white $59.99"), text);
    assert.ok(text.includes("Warnings:"), text);
    assert.ok(text.includes("dismiss ref ag_9"), text);
  });

  test("omits page/url details and warnings when absent (generic fallback)", () => {
    const text = buildAntigenSnapshotText({ snapshot_id: "snap_x", element_count: 0, elements: [] }, V);
    assert.ok(text.includes("Page: generic"), text);
    assert.ok(!text.includes("URL:"), text);
    assert.ok(!text.includes("Expires:"), text);
    assert.ok(!text.includes("Warnings:"), text);
    assert.ok(!text.includes("Primary actions:"), text);
  });

  test("element lines include kind, name, ref, clickable, typeable", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(text.includes('- link "TERTIAL, Work lamp, light blue" [ref=ag_1] [clickable=true] [typeable=false]'), text);
    assert.ok(text.includes('- button "Add to bag" [ref=ag_2] [clickable=true] [typeable=false]'), text);
  });

  test("href_path appended only when present", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(text.includes("[href_path=/us/en/p/tertial-work-lamp-light-blue-70504295/]"), text);
    // ag_2 has no href_path — its line must not carry one
    const ag2Line = text.split("\n").find((l) => l.includes("[ref=ag_2]")) ?? "";
    assert.ok(!ag2Line.includes("href_path"), ag2Line);
  });

  test("empty elements → (no visible interactive elements found)", () => {
    const text = buildAntigenSnapshotText({ snapshot_id: "snap_e", element_count: 0, elements: [] }, V);
    assert.ok(text.includes("Elements:"), text);
    assert.ok(text.includes("(no visible interactive elements found)"), text);
  });

  test("ignores forbidden internal fields even if backend includes them", () => {
    const malicious = {
      snapshot_id: "snap_m", element_count: 1,
      cdp_url: "http://internal-cdp-endpoint",
      secret_ref: "sr_should_not_appear",
      user_data_dir: "/tmp/aegis-profile",
      elements: [
        {
          ref: "ag_1", kind: "link", role: "link", name: "Item",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
          box: { x: 10, y: 20, width: 30, height: 40 },
          center: { x: 25, y: 40 },
          hints: { href_path: "/p/item" },
        },
      ],
    };
    const text = buildAntigenSnapshotText(malicious, V);
    for (const f of ["cdp_url", "secret_ref", "user_data_dir", '"box"', "width", "height", "center"]) {
      assert.ok(!text.includes(f), `forbidden field "${f}" leaked: ${text}`);
    }
    // The safe fields still render
    assert.ok(text.includes("[ref=ag_1]"), text);
    assert.ok(text.includes("[href_path=/p/item]"), text);
  });

  test("context appended as combined section + label when present", () => {
    const data = {
      snapshot_id: "snap_ctx", element_count: 2,
      elements: [
        {
          ref: "ag_37", kind: "button", role: "button", name: "Add to bag",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
          context: { label: "SOLHETTA LED bulb E26 450 lumen", section: "Complete with" },
        },
        {
          ref: "ag_44", kind: "button", role: "button", name: "Add to bag",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
          context: { label: "TERTIAL Work lamp, dark gray $19.99" },
        },
      ],
    };
    const text = buildAntigenSnapshotText(data, V);
    assert.ok(
      text.includes('- button "Add to bag" [ref=ag_37] [clickable=true] [typeable=false] [context="Complete with SOLHETTA LED bulb E26 450 lumen"]'),
      text,
    );
    // section-less context renders the label alone
    assert.ok(
      text.includes('- button "Add to bag" [ref=ag_44] [clickable=true] [typeable=false] [context="TERTIAL Work lamp, dark gray $19.99"]'),
      text,
    );
  });

  test("elements without context format unchanged (no [context=...])", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    const ag2Line = text.split("\n").find((l) => l.includes("[ref=ag_2]")) ?? "";
    assert.ok(!ag2Line.includes("[context="), ag2Line);
  });

  test("context reads only label/section — backend nearby_text/extras never leak", () => {
    const data = {
      snapshot_id: "snap_ctx2", element_count: 1,
      elements: [
        {
          ref: "ag_1", kind: "button", role: "button", name: "Ok",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
          context: {
            section: "Cookie consent banner",
            nearby_text: "INTERNAL_ONLY_LEAK",
            secret_ref: "sr_leak",
          },
        },
      ],
    };
    const text = buildAntigenSnapshotText(data, V);
    assert.ok(text.includes('[context="Cookie consent banner"]'), text);
    for (const f of ["INTERNAL_ONLY_LEAK", "nearby_text", "secret_ref", "sr_leak"]) {
      assert.ok(!text.includes(f), `leaked "${f}": ${text}`);
    }
  });

  test("renders Active surfaces + Recommended actions when present (flag-on backend)", () => {
    const data = {
      snapshot_id: "snap_surf", element_count: 2,
      active_surfaces: [
        {
          surface_id: "surf_1", surface_type: "dialog", blocking: true, dismissible: true,
          title: "GLIMMA was added to your shopping bag",
          actions: [
            { ref: "ag_2", name: "Go to shopping bag", kind: "link", classification: "primary", action_intent: "navigation" },
            { ref: "ag_3", name: "Continue shopping", kind: "button", classification: "dismiss", action_intent: "navigation" },
            { ref: "ag_4", name: "Pay $8.47", kind: "button", classification: "secondary", action_intent: "final_commit", requires_handoff: true },
          ],
        },
      ],
      recommended_actions: [
        { ref: "ag_2", name: "Go to shopping bag", surface_id: "surf_1", classification: "primary", reason: "active_surface_primary_action" },
      ],
      elements: [
        {
          ref: "ag_1", kind: "link", role: "link", name: "Shopping bag, 1 items",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
          likely_blocked_by_overlay: true,
        },
        {
          ref: "ag_2", kind: "link", role: "link", name: "Go to shopping bag",
          state: { visible: true, enabled: true, clickable: true, typeable: false },
        },
      ],
    };
    const text = buildAntigenSnapshotText(data, V);
    assert.ok(text.includes("Active surfaces:"), text);
    assert.ok(text.includes('- surf_1: dialog (blocking) — "GLIMMA was added to your shopping bag"'), text);
    assert.ok(text.includes('primary "Go to shopping bag" [ref=ag_2]'), text);
    assert.ok(text.includes('dismiss "Continue shopping" [ref=ag_3]'), text);
    assert.ok(text.includes("[requires_handoff]"), text);
    assert.ok(text.includes("Recommended actions"), text);
    // Background header annotated; surface member is not.
    const ag1Line = text.split("\n").find((l) => l.includes("[ref=ag_1]")) ?? "";
    assert.ok(ag1Line.includes("[likely_blocked_by_overlay]"), ag1Line);
    const ag2Lines = text.split("\n").filter((l) => l.includes("[ref=ag_2]") && l.startsWith("- "));
    for (const l of ag2Lines) assert.ok(!l.includes("[likely_blocked_by_overlay]"), l);
  });

  test("omits Active surfaces / Recommended actions sections entirely when absent (flag off)", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(!text.includes("Active surfaces:"), text);
    assert.ok(!text.includes("Recommended actions"), text);
    assert.ok(!text.includes("likely_blocked_by_overlay"), text);
  });
});

// ─── K. antigen_snapshot adapter tool — adapter-owned, no Playwright fallthrough ─
//
// antigen_snapshot is additive and adapter-owned. It calls the Antigen backend
// snapshot endpoint and returns a readable, allowlist-formatted ag_* listing.
// It is never forwarded to @playwright/mcp. browser_snapshot is unaffected.

describe("K. antigen_snapshot adapter tool", () => {

  test("tools/list includes antigen_snapshot with max_candidates/viewport_only and no agent-supplied browser_runtime_id", { timeout: 5000 }, async () => {
    const { mockServer, serverReady } = spawnAdapterWithMockServer();
    await serverReady;
    const { port } = mockServer.address();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, AEGIS_API_BASE: `http://127.0.0.1:${port}`, AEGIS_AGENT_TOKEN: "test_token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 300));

    const toolsResponse = parseMcpResponse(stdoutBuf, 2);
    assert.ok(toolsResponse, `expected tools/list response, stdout: ${stdoutBuf}`);
    const tools = toolsResponse.result?.tools ?? [];
    const snap = tools.find((t) => t.name === "antigen_snapshot");
    assert.ok(snap, "tools list should include antigen_snapshot");
    const props = snap.inputSchema?.properties ?? {};
    assert.ok("max_candidates" in props, "schema should expose max_candidates");
    assert.ok("viewport_only" in props, "schema should expose viewport_only");
    assert.ok(!("browser_runtime_id" in props), "agent-facing schema must NOT expose browser_runtime_id");
    // browser_snapshot remains advertised (additive — not replaced)
    assert.ok(tools.some((t) => t.name === "browser_snapshot"), "browser_snapshot must remain in tools list");

    adapter.kill("SIGTERM");
    mockServer.close();
  });

  test("success: calls backend snapshot endpoint with defaults and Authorization header", { timeout: 7000 }, async () => {
    const { server, port, getSnapshotRequests } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",   // antigen_snapshot is independent of interception
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 80, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const reqs = getSnapshotRequests();
    assert.equal(reqs.length, 1, `expected exactly one snapshot backend call, got ${reqs.length}`);
    assert.equal(reqs[0].body.action, "dom_snapshot", "action should be dom_snapshot");
    assert.equal(reqs[0].body.max_candidates, 200, "default max_candidates should be 200");
    assert.equal(reqs[0].body.viewport_only, true, "default viewport_only should be true");
    assert.ok(reqs[0].body.browser_runtime_id, "adapter must supply browser_runtime_id internally");
    assert.equal(reqs[0].authorization, "Bearer test_token", "Authorization header should be present");
    // Lazy init: runtime was only created on this first call
    assert.ok(stderrBuf.includes("Runtime ready"), `expected lazy Runtime ready in stderr: ${stderrBuf}`);
  });

  test("success: returns readable text with snapshot_id, element_count, ag_* refs, href_path", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 81, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 81);
    assert.ok(resp, `expected response for id=81, stdout: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("path=antigen_snapshot_success"), text);
    assert.ok(text.includes("snapshot_id=snap_test123"), text);
    assert.ok(text.includes("element_count=2"), text);
    assert.ok(text.includes("source=antigen-browser-adapter"), text);
    assert.ok(text.includes('- link "TERTIAL, Work lamp, light blue" [ref=ag_1]'), text);
    assert.ok(text.includes('- button "Add to bag" [ref=ag_2]'), text);
    assert.ok(text.includes("[href_path=/us/en/p/tertial-work-lamp-light-blue-70504295/]"), text);
  });

  test("custom args (max_candidates=50, viewport_only=false) reach the backend", { timeout: 7000 }, async () => {
    const { server, port, getSnapshotRequests } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 82, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: { max_candidates: 50, viewport_only: false } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const reqs = getSnapshotRequests();
    assert.equal(reqs.length, 1, `expected one snapshot call, got ${reqs.length}`);
    assert.equal(reqs[0].body.max_candidates, 50, "max_candidates should pass through");
    assert.equal(reqs[0].body.viewport_only, false, "viewport_only=false should pass through");
  });

  test("empty snapshot formats cleanly", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserSnapshotBody: {
        ok: true,
        data: {
          snapshot_id: "snap_empty", url: "https://example.com", title: null,
          expires_at: "2026-01-01T00:00:10.000Z", snapshot_ttl_ms: 10000,
          element_count: 0, elements: [],
        },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 83, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 83);
    assert.ok(resp, `expected response for id=83, stdout: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("element_count=0"), text);
    assert.ok(text.includes("(no visible interactive elements found)"), text);
  });

  test("backend 422: clean synthetic error mentioning antigen_snapshot, no fallthrough", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserSnapshotStatus: 422,
      browserSnapshotBody: { ok: false, error: { code: "SNAPSHOT_EXTRACTION_FAILED", message: "Failed." } },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 84, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 84);
    assert.ok(resp, `expected response for id=84, stdout: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("SNAPSHOT_EXTRACTION_FAILED"), text);
    assert.ok(text.includes("antigen_snapshot"), `error must reference antigen_snapshot: ${text}`);
    assert.ok(!text.includes("browser_type"), `must not say browser_type: ${text}`);
    assert.ok(!text.includes("browser_click"), `must not say browser_click: ${text}`);
    assert.ok(!stdoutBuf.includes('"path":["target"]'), "no Zod target error");
  });

  test("network error: clean synthetic error with ANTIGEN_SNAPSHOT_INTERCEPT_ERROR, no fallthrough", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({ browserSnapshotDestroy: true });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 85, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 85);
    assert.ok(resp, `expected response for id=85, stdout: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true, `expected isError:true, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_SNAPSHOT_INTERCEPT_ERROR"), text);
    // No raw stack trace internals
    assert.ok(!stdoutBuf.includes("at Object."), "no stack frames in stdout");
    assert.ok(!stdoutBuf.includes("node:internal"), "no node internals in stdout");
  });

  test("success output contains no forbidden internals", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 86, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const FORBIDDEN = [
      "user_data_dir", "profile_key", ".aegis", "browser-profiles", "localStorage",
      "sessionStorage", "cdp_url", "pass_id", "secret_ref", "password",
      '"box"', '"x"', '"y"', '"width"', '"height"',
    ];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
    }
  });

  test("backend returning extra forbidden fields: adapter still omits them (allowlist)", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserSnapshotBody: {
        ok: true,
        data: {
          snapshot_id: "snap_evil",
          url: "https://example.com",
          title: null,
          expires_at: "2026-01-01T00:00:10.000Z",
          snapshot_ttl_ms: 10000,
          element_count: 1,
          cdp_url: "http://internal-cdp-endpoint",
          secret_ref: "sr_should_not_appear",
          user_data_dir: "/tmp/aegis-profile",
          elements: [
            {
              ref: "ag_1", kind: "link", role: "link", name: "Item",
              state: { visible: true, enabled: true, clickable: true, typeable: false },
              box: { x: 10, y: 20, width: 30, height: 40 },
              hints: { href_path: "/p/item" },
            },
          ],
        },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 87, method: "tools/call",
      params: { name: "antigen_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 87);
    assert.ok(resp, `expected response for id=87, stdout: ${stdoutBuf}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    // Safe fields render
    assert.ok(text.includes("[ref=ag_1]"), text);
    assert.ok(text.includes("[href_path=/p/item]"), text);
    // Forbidden backend extras must NOT appear anywhere in stdout
    for (const f of ["cdp_url", "secret_ref", "user_data_dir", '"box"', "width", "height"]) {
      assert.ok(!stdoutBuf.includes(f), `forbidden field "${f}" leaked to stdout`);
    }
  });

  test("regression: browser_snapshot is NOT hijacked — no snapshot backend call, no antigen success text", { timeout: 7000 }, async () => {
    const { server, port, getSnapshotRequests } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "true",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    // browser_snapshot must remain delegated to @playwright/mcp — the adapter must
    // not route it to the Antigen snapshot endpoint and must not emit antigen text.
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 88, method: "tools/call",
      params: { name: "browser_snapshot", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    assert.equal(getSnapshotRequests().length, 0, "browser_snapshot must NOT call the Antigen snapshot endpoint");
    assert.ok(!stdoutBuf.includes("antigen_snapshot_success"), "browser_snapshot must not produce antigen snapshot text");
  });
});

// ─── L. Runtime session continuity + SESSION_NOT_FOUND recovery ────────────────
//
// Backend task-browser sessions are in-memory; an API restart wipes them while
// this long-lived adapter keeps a cached browser_runtime_id, so every Antigen
// runtime call then 404s with SESSION_NOT_FOUND. These tests cover:
//   - id continuity: snapshot/scroll/click/type all send the same stored id
//   - recovery: a 404 that clears after one re-init resolves normally
//   - loud failure: a persistent 404 → exactly one re-init + retry, then a clear
//     agent-facing error (never a silent continue, never a child fallthrough)
//   - browser_navigate surfaces a persistent SESSION_NOT_FOUND instead of routine
//     success (transient TIMEOUT / non-200 stay soft — covered in group I)

const SNF_BODY = { ok: false, error: { code: "SESSION_NOT_FOUND", message: "Browser runtime session not found." } };

function spawnRealisticAdapter(port, binPath) {
  return spawn(process.execPath, [ADAPTER_PATH], {
    env: {
      ...process.env,
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
      AEGIS_API_BASE: `http://127.0.0.1:${port}`,
      AEGIS_AGENT_TOKEN: "test_token",
      ANTIGEN_BROWSER_HEADLESS: "false",
      ANTIGEN_INPUT_REALISM: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("L. Runtime session continuity + SESSION_NOT_FOUND recovery", () => {

  test("continuity: snapshot, scroll, and click all send the same browser_runtime_id", { timeout: 8000 }, async () => {
    const { server, port, getSnapshotRequests, getScrollRequests, getClickRequests } = await createMockApiServer();
    const { binPath, cleanup } = createFakeMcpBin();
    const adapter = spawnRealisticAdapter(port, binPath);

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 120, method: "tools/call", params: { name: "antigen_snapshot", arguments: {} } }) + "\n");
    await new Promise((r) => setTimeout(r, 400));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 121, method: "tools/call", params: { name: "browser_scroll_to_ref", arguments: { ref: "ag_1" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 400));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 122, method: "tools/call", params: { name: "browser_click", arguments: { ref: "ag_1" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 600));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const snap = getSnapshotRequests();
    const scroll = getScrollRequests();
    const click = getClickRequests();
    assert.equal(snap.length, 1, `expected one snapshot request, got ${snap.length}`);
    assert.equal(scroll.length, 1, `expected one scroll request, got ${scroll.length}`);
    assert.equal(click.length, 1, `expected one click request, got ${click.length}`);
    assert.equal(snap[0].body.browser_runtime_id, "test_runtime_001", "snapshot must use the stored runtime id");
    assert.equal(scroll[0].body.browser_runtime_id, "test_runtime_001", "scroll must use the stored runtime id");
    assert.equal(click[0].body.browser_runtime_id, "test_runtime_001", "click must use the stored runtime id");
  });

  test("recovery: a SESSION_NOT_FOUND that clears after one re-init resolves normally", { timeout: 8000 }, async () => {
    const { server, port, getClickRequests, getEndpointRequests } = await createMockApiServer({
      browserClickStatusSequence: [404, 200],
      browserClickBodySequence: [
        SNF_BODY,
        { ok: true, data: { mode: "realistic_pointer_click", pointer_path_point_count: 9, pointer_start_source: "session", pointer_state_persisted: true } },
      ],
    });
    const { binPath, cleanup } = createFakeMcpBin();
    const adapter = spawnRealisticAdapter(port, binPath);

    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 123, method: "tools/call", params: { name: "browser_click", arguments: { ref: "ag_1" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 123);
    assert.ok(resp, `expected response for id=123`);
    assert.ok(!resp.result?.isError, `expected success after recovery, got: ${JSON.stringify(resp.result)}`);
    assert.equal(getClickRequests().length, 2, "expected exactly one retry (2 click requests)");
    assert.equal(getEndpointRequests().length, 2, "expected exactly one re-init (init + 1 re-init)");
    assert.ok(stderrBuf.includes("action=reinit_retry"), `expected reinit_retry diagnostic, got: ${stderrBuf}`);
  });

  test("persistent SESSION_NOT_FOUND: exactly one re-init + retry, then a clear error (no silent continue)", { timeout: 8000 }, async () => {
    const { server, port, getClickRequests, getEndpointRequests } = await createMockApiServer({
      browserClickStatus: 404,
      browserClickBody: SNF_BODY,
    });
    const { binPath, cleanup } = createFakeMcpBin();
    const adapter = spawnRealisticAdapter(port, binPath);

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 124, method: "tools/call", params: { name: "browser_click", arguments: { ref: "ag_1" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 124);
    assert.ok(resp, `expected response for id=124`);
    assert.equal(resp.result?.isError, true, `expected isError after persistent SESSION_NOT_FOUND, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("SESSION_NOT_FOUND"), `expected SESSION_NOT_FOUND in error: ${text}`);
    assert.ok(/reinitialize the browser runtime/i.test(text), `expected reinitialize guidance: ${text}`);
    assert.equal(getClickRequests().length, 2, "expected exactly one retry (2 click requests), not an infinite loop");
    assert.equal(getEndpointRequests().length, 2, "expected exactly one re-init (init + 1 re-init)");
  });

  test("browser_fill does not silently fall through to @playwright/mcp on SESSION_NOT_FOUND", { timeout: 8000 }, async () => {
    // browser-type endpoint always 404s SESSION_NOT_FOUND. The fake MCP child never
    // answers tools/call, so a fallthrough would yield NO response for the id. A
    // clear isError SESSION_NOT_FOUND response proves the adapter handled it itself.
    const { server, port } = await createMockApiServer({ browserTypeStatus: 404, browserTypeBody: SNF_BODY });
    const { binPath, cleanup } = createFakeMcpBin();
    const adapter = spawnRealisticAdapter(port, binPath);

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 125, method: "tools/call", params: { name: "browser_fill", arguments: { value: "desk lamp" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 125);
    assert.ok(resp, `expected an adapter response for id=125 (no silent child fallthrough)`);
    assert.equal(resp.result?.isError, true, `expected isError, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("SESSION_NOT_FOUND"), `expected SESSION_NOT_FOUND in error: ${text}`);
  });

  test("browser_navigate fails loudly on persistent SESSION_NOT_FOUND (one re-init + retry)", { timeout: 9000 }, async () => {
    const { server, port, getNavRequests } = await createNavMockApiServer({
      navStateStatus: 404,
      navStateBody: SNF_BODY,
    });
    const { binPath, cleanup } = createNavigateFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 126, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 126);
    assert.ok(resp, `expected response for id=126`);
    assert.equal(resp.result?.isError, true, `expected isError on persistent SESSION_NOT_FOUND, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("SESSION_NOT_FOUND"), `expected SESSION_NOT_FOUND in error: ${text}`);
    assert.equal(getNavRequests().length, 2, "expected exactly one nav-state retry (2 nav-state requests)");
  });

  // ── Fresh-id continuity: the retry body must carry the re-init's fresh id, not
  // the stale captured id. The mock returns DISTINCT ids per browser-endpoint call
  // (init → tbsess_old, re-init → tbsess_new) so a stale-id retry is detectable.

  test("Test 1 — nav-state retry uses the FRESH runtime id (not the stale one)", { timeout: 9000 }, async () => {
    const { server, port, getNavRequests, getEndpointRequests } = await createNavMockApiServer({
      browserEndpointIdSequence: ["tbsess_old", "tbsess_new"],
      navStateStatusSequence: [404, 200],
      navStateBodySequence: [
        SNF_BODY,
        { ok: true, data: { pointer_state_persisted: true, pointer_start_source: "session", pointer_action: "navigation_proxy" } },
      ],
    });
    const { binPath, cleanup } = createNavigateFakeMcpBin();
    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 130, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const nav = getNavRequests();
    assert.equal(nav.length, 2, `expected exactly 2 nav-state requests, got ${nav.length}`);
    assert.equal(nav[0].browser_runtime_id, "tbsess_old", "first nav-state must use the stale id");
    assert.equal(nav[1].browser_runtime_id, "tbsess_new", "retry nav-state must use the FRESH id, not the stale one");
    assert.equal(getEndpointRequests().length, 2, "expected exactly one re-init (init + 1 re-init)");

    const resp = parseMcpResponse(stdoutBuf, 130);
    assert.ok(resp, `expected response for id=130`);
    assert.ok(!resp.result?.isError, `expected navigation success after fresh-id retry, got: ${JSON.stringify(resp.result)}`);
    assert.ok(
      /runtime_retry .*retry_uses_fresh_runtime_id=true/.test(stderrBuf),
      `expected runtime_retry continuity diagnostic with retry_uses_fresh_runtime_id=true, got: ${stderrBuf}`,
    );
  });

  test("Test 2 — persistent nav-state SNF: retry carried the fresh id, then a loud error", { timeout: 9000 }, async () => {
    const { server, port, getNavRequests, getEndpointRequests } = await createNavMockApiServer({
      browserEndpointIdSequence: ["tbsess_old", "tbsess_new"],
      navStateStatus: 404,
      navStateBody: SNF_BODY,
    });
    const { binPath, cleanup } = createNavigateFakeMcpBin();
    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 131, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const nav = getNavRequests();
    assert.equal(nav.length, 2, `expected exactly 2 nav-state requests (no infinite retry), got ${nav.length}`);
    assert.equal(nav[1].browser_runtime_id, "tbsess_new", "retry must still use the fresh id even when it persists in failing");
    assert.equal(getEndpointRequests().length, 2, "expected exactly one re-init");

    const resp = parseMcpResponse(stdoutBuf, 131);
    assert.ok(resp, `expected response for id=131`);
    assert.equal(resp.result?.isError, true, `expected isError on persistent SNF, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("SESSION_NOT_FOUND"), `expected SESSION_NOT_FOUND in error: ${text}`);
    assert.ok(/reinitialize the browser runtime/i.test(text), `expected reinitialize guidance: ${text}`);
  });

  test("Test 3 — transient nav-state error (timeout) stays soft: no re-init, navigation succeeds", { timeout: 9000 }, async () => {
    // nav-state delays past the adapter's 400ms abort → AbortError → TIMEOUT.
    // TIMEOUT is not SESSION_NOT_FOUND, so there must be NO re-init and the child's
    // navigation success must still be forwarded.
    const { server, port, getNavRequests, getEndpointRequests } = await createNavMockApiServer({
      navStateDelayMs: 800,
    });
    const { binPath, cleanup } = createNavigateFakeMcpBin();
    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 132, method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://www.ikea.com/us/en/" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 2000));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    assert.equal(getEndpointRequests().length, 1, "transient TIMEOUT must NOT trigger a re-init (init only)");
    assert.equal(getNavRequests().length, 1, "transient TIMEOUT must NOT trigger a nav-state retry");
    const resp = parseMcpResponse(stdoutBuf, 132);
    assert.ok(resp, `expected response for id=132`);
    assert.ok(!resp.result?.isError, `transient nav-state failure must stay soft (navigation forwarded), got: ${JSON.stringify(resp.result)}`);
  });

  test("Test 4a — browser_click retry rebuilds the body with the fresh runtime id", { timeout: 8000 }, async () => {
    const { server, port, getClickRequests, getEndpointRequests } = await createMockApiServer({
      browserEndpointIdSequence: ["tbsess_old", "tbsess_new"],
      browserClickStatusSequence: [404, 200],
      browserClickBodySequence: [
        SNF_BODY,
        { ok: true, data: { mode: "realistic_pointer_click", pointer_path_point_count: 9, pointer_start_source: "session", pointer_state_persisted: true } },
      ],
    });
    const { binPath, cleanup } = createFakeMcpBin();
    const adapter = spawnRealisticAdapter(port, binPath);

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 133, method: "tools/call", params: { name: "browser_click", arguments: { ref: "ag_1" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const click = getClickRequests();
    assert.equal(click.length, 2, `expected one click retry (2 requests), got ${click.length}`);
    assert.equal(click[0].body.browser_runtime_id, "tbsess_old", "first click must use the stale id");
    assert.equal(click[1].body.browser_runtime_id, "tbsess_new", "click retry must use the FRESH id");
    assert.equal(getEndpointRequests().length, 2, "expected exactly one re-init");
    const resp = parseMcpResponse(stdoutBuf, 133);
    assert.ok(resp && !resp.result?.isError, `expected click success after fresh-id retry, got: ${JSON.stringify(resp?.result)}`);
  });

  test("Test 4b — antigen_snapshot retry rebuilds the body with the fresh runtime id", { timeout: 8000 }, async () => {
    const { server, port, getSnapshotRequests, getEndpointRequests } = await createMockApiServer({
      browserEndpointIdSequence: ["tbsess_old", "tbsess_new"],
      browserSnapshotStatusSequence: [404, 200],
      browserSnapshotBodySequence: [SNF_BODY, null], // null → DEFAULT_SNAPSHOT_BODY on retry
    });
    const { binPath, cleanup } = createFakeMcpBin();
    const adapter = spawnRealisticAdapter(port, binPath);

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 134, method: "tools/call", params: { name: "antigen_snapshot", arguments: {} } }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const snap = getSnapshotRequests();
    assert.equal(snap.length, 2, `expected one snapshot retry (2 requests), got ${snap.length}`);
    assert.equal(snap[0].body.browser_runtime_id, "tbsess_old", "first snapshot must use the stale id");
    assert.equal(snap[1].body.browser_runtime_id, "tbsess_new", "snapshot retry must use the FRESH id");
    assert.equal(getEndpointRequests().length, 2, "expected exactly one re-init");
    const resp = parseMcpResponse(stdoutBuf, 134);
    assert.ok(resp && !resp.result?.isError, `expected snapshot success after fresh-id retry, got: ${JSON.stringify(resp?.result)}`);
  });
});

// ─── M. clipRuntimeId — safe id clipping for continuity diagnostics ────────────

describe("M. clipRuntimeId", () => {
  test("clips a long id to a 14-char prefix with ellipsis", () => {
    assert.equal(clipRuntimeId("tbsess_abcdef0123456789"), "tbsess_abcdef0…");
  });
  test("returns a short id unchanged", () => {
    assert.equal(clipRuntimeId("tbsess_old"), "tbsess_old");
  });
  test("returns 'none' for null/empty/non-string", () => {
    assert.equal(clipRuntimeId(null), "none");
    assert.equal(clipRuntimeId(undefined), "none");
    assert.equal(clipRuntimeId(""), "none");
    assert.equal(clipRuntimeId(42), "none");
  });
});

// ─── N. tool-surface disposition & QA hard mode ───────────────────────────────
// Verifies that browser tool calls record a tool-surface disposition (sanitized
// stderr line + best-effort POST to the dev-only trace disposition route), and
// that QA hard mode (ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS=true) fails loudly
// instead of silently forwarding Antigen-owned actions to the untraced
// @playwright/mcp child. Default mode is behavior-identical except for the
// best-effort diagnostics.

describe("N. tool disposition and Antigen hard mode", () => {
  // Spawn the adapter against a mock backend + fake @playwright/mcp, send one
  // browser tool call, then return captured stdout/stderr and the mock recorders.
  async function runToolCall({ tool, args, id, env = {}, waitMs = 1500, serverOpts = {} }) {
    const mock = await createMockApiServer(serverOpts);
    const { binPath, cleanup } = createFakeMcpBin();
    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${mock.port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
        ANTIGEN_BROWSER_TRACE: "true",
        // Default OFF — hard-mode tests opt in explicitly via `env`.
        ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    adapter.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: tool, arguments: args },
    }) + "\n");
    await new Promise((r) => setTimeout(r, waitMs));

    adapter.kill("SIGTERM");
    mock.server.close();
    cleanup();
    return {
      stdoutBuf, stderrBuf,
      getDispositionRequests: mock.getDispositionRequests,
      getSnapshotRequests: mock.getSnapshotRequests,
      getTypeRequests: mock.getTypeRequests,
    };
  }

  test("browser_snapshot default mode records adapter_child_forwarded (not blocked)", { timeout: 7000 }, async () => {
    const { stdoutBuf, stderrBuf, getDispositionRequests } = await runToolCall({
      tool: "browser_snapshot", args: {}, id: 701,
    });
    // Not blocked — no synthetic ANTIGEN_TOOL_REQUIRED error for this id.
    const resp = parseMcpResponse(stdoutBuf, 701);
    assert.ok(!resp || resp.result?.isError !== true, `browser_snapshot must not be blocked in default mode: ${JSON.stringify(resp?.result)}`);
    assert.ok(!stdoutBuf.includes("ANTIGEN_TOOL_REQUIRED"), `default mode must not return ANTIGEN_TOOL_REQUIRED`);
    assert.match(stderrBuf, /tool_disposition tool=browser_snapshot surface=adapter_child_playwright disposition=adapter_child_forwarded/);
    const disp = getDispositionRequests().find((d) => d.body?.tool === "browser_snapshot");
    assert.ok(disp, `expected a disposition POST for browser_snapshot, stderr: ${stderrBuf}`);
    assert.equal(disp.body.tool_surface, "adapter_child_playwright");
    assert.equal(disp.body.disposition, "adapter_child_forwarded");
  });

  test("browser_snapshot hard mode fails loudly with guidance to antigen_snapshot", { timeout: 7000 }, async () => {
    const { stdoutBuf, stderrBuf, getDispositionRequests } = await runToolCall({
      tool: "browser_snapshot", args: {}, id: 702,
      env: { ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS: "true" },
    });
    const resp = parseMcpResponse(stdoutBuf, 702);
    assert.ok(resp, `expected a response for id=702: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("ANTIGEN_TOOL_REQUIRED"), `expected ANTIGEN_TOOL_REQUIRED: ${text}`);
    assert.ok(text.includes("antigen_snapshot"), `expected guidance to antigen_snapshot: ${text}`);
    assert.match(stderrBuf, /tool_disposition tool=browser_snapshot surface=antigen_adapter disposition=blocked_by_antigen_required/);
    const disp = getDispositionRequests().find((d) => d.body?.tool === "browser_snapshot");
    assert.ok(disp, `expected a disposition POST`);
    assert.equal(disp.body.disposition, "blocked_by_antigen_required");
  });

  test("antigen_snapshot hard mode succeeds through the backend (antigen_backend)", { timeout: 7000 }, async () => {
    const { stdoutBuf, stderrBuf, getDispositionRequests, getSnapshotRequests } = await runToolCall({
      tool: "antigen_snapshot", args: { max_candidates: 50, viewport_only: true }, id: 703,
      env: { ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS: "true" },
    });
    assert.equal(getSnapshotRequests().length, 1, `expected one backend snapshot call`);
    const resp = parseMcpResponse(stdoutBuf, 703);
    assert.ok(resp && resp.result?.isError !== true, `expected antigen_snapshot success: ${JSON.stringify(resp?.result)}`);
    assert.match(stderrBuf, /tool_disposition tool=antigen_snapshot surface=antigen_adapter disposition=antigen_backend/);
    const disp = getDispositionRequests().find((d) => d.body?.tool === "antigen_snapshot");
    assert.ok(disp, `expected a disposition POST for antigen_snapshot`);
    assert.equal(disp.body.disposition, "antigen_backend");
    // Disposition payloads carry no forbidden internals.
    const raw = JSON.stringify(getDispositionRequests());
    for (const f of ["cdp_url", "user_data_dir", "secret_ref", "password", "9222", "localhost", "\"box\"", "doc_x"]) {
      assert.ok(!raw.includes(f), `disposition payload leaked ${f}`);
    }
  });

  test("browser_fill hard mode blocks the @playwright/mcp fallback", { timeout: 7000 }, async () => {
    const { stdoutBuf, stderrBuf, getDispositionRequests } = await runToolCall({
      tool: "browser_fill", args: { value: "hello world" }, id: 704,
      env: { ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS: "true" },
      serverOpts: { browserTypeStatus: 422, browserTypeBody: { ok: false, error: { code: "ELEMENT_NOT_FOUND", message: "nope" } } },
    });
    const resp = parseMcpResponse(stdoutBuf, 704);
    assert.ok(resp, `expected a response for id=704: ${stdoutBuf}`);
    assert.equal(resp.result?.isError, true);
    assert.ok((resp.result?.content?.[0]?.text ?? "").includes("ANTIGEN_TOOL_REQUIRED"), `expected ANTIGEN_TOOL_REQUIRED`);
    assert.match(stderrBuf, /browser_fill_blocked reason=ANTIGEN_TOOL_REQUIRED/);
    const disp = getDispositionRequests().find((d) => d.body?.tool === "browser_fill");
    assert.ok(disp, `expected a disposition POST for browser_fill`);
    assert.equal(disp.body.disposition, "blocked_by_antigen_required");
    // No raw typed value ever leaves the adapter.
    assert.ok(!stdoutBuf.includes("hello world") && !stderrBuf.includes("hello world"), `raw fill value leaked`);
  });

  test("browser_fill default mode preserves the child fallback (raw_fallback)", { timeout: 7000 }, async () => {
    const { stdoutBuf, stderrBuf, getDispositionRequests } = await runToolCall({
      tool: "browser_fill", args: { value: "hello world" }, id: 705,
      serverOpts: { browserTypeStatus: 422, browserTypeBody: { ok: false, error: { code: "ELEMENT_NOT_FOUND", message: "nope" } } },
    });
    // Default mode falls through to the child — no synthetic block error.
    assert.ok(!stdoutBuf.includes("ANTIGEN_TOOL_REQUIRED"), `default mode must not block browser_fill`);
    assert.match(stderrBuf, /realistic_type_fallback reason=ELEMENT_NOT_FOUND source=browser_fill/);
    const disp = getDispositionRequests().find((d) => d.body?.tool === "browser_fill");
    assert.ok(disp, `expected a disposition POST for browser_fill`);
    assert.equal(disp.body.tool_surface, "adapter_child_playwright");
    assert.equal(disp.body.disposition, "raw_fallback");
  });

  test("browser_click success records an antigen_backend disposition", { timeout: 7000 }, async () => {
    const { stdoutBuf, stderrBuf, getDispositionRequests } = await runToolCall({
      tool: "browser_click", args: { ref: "ag_1", element: "Add to bag" }, id: 706,
    });
    const resp = parseMcpResponse(stdoutBuf, 706);
    assert.ok(resp && resp.result?.isError !== true, `expected browser_click success: ${JSON.stringify(resp?.result)}`);
    assert.match(stderrBuf, /tool_disposition tool=browser_click surface=antigen_adapter disposition=antigen_backend/);
    const disp = getDispositionRequests().find((d) => d.body?.tool === "browser_click");
    assert.ok(disp, `expected a disposition POST for browser_click`);
    assert.equal(disp.body.disposition, "antigen_backend");
  });
});

// ─── Navigation realism / direct navigation discipline ────────────────────────
// Pure-function coverage for classifyNavigationDiscipline + deriveNavHintsFromSnapshot
// (Antigen Browser Realism v1). Blocking only ever happens in hard mode; default
// mode always allows but emits a warn disposition; stale/missing hints never block.

describe("Navigation realism / direct navigation discipline", () => {
  const IKEA = "https://www.ikea.com";
  // A snapshot page map for an IKEA listing page with the affordances that justify
  // ref-based movement: a search input, product cards, and a cart/bag control.
  const ikeaListingSnapshot = {
    page_summary: { url_host: "www.ikea.com", url_path: "/us/en/cat/bookcases" },
    forms: [{ label: "Search IKEA", input_refs: ["ag_2"], submit_refs: ["ag_3"], action_hint: "browser_type_then_submit" }],
    product_cards: [{ title: "BILLY Bookcase", price_text: "$59", add_ref: "ag_10", details_ref: "ag_11", refs: ["ag_10", "ag_11"] }],
    warnings_or_modals: [{ kind: "cart_drawer", message: "Your bag", dismiss_refs: ["ag_20"] }],
    primary_actions: [{ ref: "ag_30", role: "link", name: "Shopping bag" }],
    elements: [
      { kind: "input", name: "Search", ref: "ag_2", state: { typeable: true }, hints: {} },
      { kind: "link", name: "BILLY Bookcase", ref: "ag_11", state: { clickable: true }, hints: { href_path: "/us/en/p/billy-bookcase-white-00263851" } },
    ],
  };
  const freshHints = () => deriveNavHintsFromSnapshot(ikeaListingSnapshot);

  test("deriveNavHintsFromSnapshot surfaces the expected affordances", () => {
    const h = freshHints();
    assert.equal(h.host, "www.ikea.com");
    assert.equal(h.hasSearchInput, true);
    assert.equal(h.hasProductCards, true);
    assert.equal(h.hasCartRef, true);
    assert.ok(h.hrefPaths.includes("/us/en/p/billy-bookcase-white-00263851"));
  });

  test("1. initial navigation (no current url) → allow", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: IKEA, currentUrl: null, isFirstNavigation: true, navHints: null, hardMode: true,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.reason, "initial_navigation");
  });

  test("2. top-level / home entry → allow", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/", currentUrl: "https://www.reddit.com/r/malelivingspace",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.reason, "cross_site_navigation");
  });

  test("2b. same-site home path → allow (top_level_site_entry)", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/", currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.reason, "top_level_site_entry");
  });

  test("3. cross-site navigation (host changes) → allow", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      currentUrl: "https://www.reddit.com/r/malelivingspace",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.reason, "cross_site_navigation");
  });

  test("4. same-site product deeplink with refs → warned default, blocked hard", () => {
    const args = {
      targetUrl: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: freshHints(),
    };
    const dflt = classifyNavigationDiscipline({ ...args, hardMode: false });
    assert.equal(dflt.decision, "allow");
    assert.equal(dflt.disposition, "direct_navigation_warned");
    assert.equal(dflt.category, "product");

    const hard = classifyNavigationDiscipline({ ...args, hardMode: true });
    assert.equal(hard.decision, "block");
    assert.equal(hard.disposition, "direct_navigation_blocked");
    assert.equal(hard.category, "product");
  });

  test("5. search-query URL with a search input ref → blocked in hard mode", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/search/?q=billy+bookcase",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    assert.equal(r.decision, "block");
    assert.equal(r.category, "search");
    assert.equal(r.reason, "same_site_search_deeplink");
  });

  test("6. cart URL with a cart ref → blocked in hard mode", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/shoppingcart/",
      currentUrl: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    assert.equal(r.decision, "block");
    assert.equal(r.category, "cart");
    assert.equal(r.reason, "cart_deeplink");
  });

  test("7. cart URL with NO cart ref → warned, never blocked", () => {
    const noCart = deriveNavHintsFromSnapshot({
      page_summary: { url_host: "www.ikea.com" },
      elements: [{ kind: "link", name: "About", ref: "ag_1", hints: {} }],
    });
    assert.equal(noCart.hasCartRef, false);
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/shoppingcart/",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: noCart, hardMode: true,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.disposition, "direct_navigation_warned");
    assert.equal(r.reason, "no_cart_ref");
  });

  test("8. missing snapshot hints + same-site product deeplink in hard mode → block (fresh_snapshot_required)", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: null, hardMode: true,
    });
    assert.equal(r.decision, "block");
    assert.equal(r.disposition, "direct_navigation_blocked");
    assert.equal(r.reason, "fresh_snapshot_required");
    assert.equal(r.category, "snapshot_required");
  });

  test("8a. missing hints + same-site search-query URL in hard mode → block (snapshot_required)", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/search/?q=billy",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: null, hardMode: true,
    });
    assert.equal(r.decision, "block");
    assert.equal(r.category, "snapshot_required");
    assert.equal(r.reason, "fresh_snapshot_required");
  });

  test("8b. stale snapshot (passed as null) in hard mode → blocks same-site deep nav, requiring a fresh snapshot", () => {
    // The adapter passes navHints:null when the cached snapshot is older than the
    // TTL. A stale snapshot must NOT be a free pass for same-site deep navigation:
    // assert each deep target now blocks with fresh_snapshot_required so the agent
    // re-establishes a page map before deep-linking (it still must not click stale
    // refs — that is governed separately at click-resolution time).
    const staleAsNull = null;
    for (const targetUrl of [
      "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      "https://www.ikea.com/us/en/search/?q=billy",
      "https://www.ikea.com/us/en/shoppingcart/",
    ]) {
      const r = classifyNavigationDiscipline({
        targetUrl, currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
        isFirstNavigation: false, navHints: staleAsNull, hardMode: true,
      });
      assert.equal(r.decision, "block", `stale-hints deep target ${targetUrl} must block in hard mode`);
      assert.equal(r.reason, "fresh_snapshot_required");
      assert.equal(r.category, "snapshot_required");
    }
  });

  test("8b-i. missing hints in DEFAULT mode → still allow (no_recent_snapshot), behavior-compatible", () => {
    for (const targetUrl of [
      "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      "https://www.ikea.com/us/en/search/?q=billy",
      "https://www.ikea.com/us/en/shoppingcart/",
    ]) {
      const r = classifyNavigationDiscipline({
        targetUrl, currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
        isFirstNavigation: false, navHints: null, hardMode: false,
      });
      assert.equal(r.decision, "allow", `default mode must not block ${targetUrl} without a snapshot`);
      assert.equal(r.disposition, "direct_navigation_allowed");
      assert.equal(r.reason, "no_recent_snapshot");
    }
  });

  test("8b-ii. missing hints in hard mode → first nav / cross-site / home still allowed", () => {
    // first navigation
    assert.equal(classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      currentUrl: null, isFirstNavigation: true, navHints: null, hardMode: true,
    }).decision, "allow");
    // cross-site
    assert.equal(classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      currentUrl: "https://www.reddit.com/r/malelivingspace",
      isFirstNavigation: false, navHints: null, hardMode: true,
    }).decision, "allow");
    // same-site top-level/home
    assert.equal(classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/", currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: null, hardMode: true,
    }).decision, "allow");
  });

  test("8b-iii. missing hints in hard mode → safe recovery paths still allowed (search landing, reload)", () => {
    // Search-LANDING page without a query string is an acceptable entry/recovery path.
    const landing = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/search/",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: null, hardMode: true,
    });
    assert.equal(landing.decision, "allow", "search landing without query must be allowed as recovery");
    assert.equal(landing.reason, "no_recent_snapshot");

    // Explicit reload/refresh of the current page (same host + same path).
    const reload = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/cat/bookcases",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: null, hardMode: true,
    });
    assert.equal(reload.decision, "allow", "reload of current page must be allowed");
  });

  test("8c. default mode NEVER blocks product/search/cart even with refs", () => {
    for (const targetUrl of [
      "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      "https://www.ikea.com/us/en/search/?q=billy",
      "https://www.ikea.com/us/en/shoppingcart/",
    ]) {
      const r = classifyNavigationDiscipline({
        targetUrl, currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
        isFirstNavigation: false, navHints: freshHints(), hardMode: false,
      });
      assert.equal(r.decision, "allow", `default mode must not block ${targetUrl}`);
      assert.equal(r.disposition, "direct_navigation_warned");
    }
  });

  test("9. same-site path matching no affordance → allow (no_matching_ref)", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/customer-service/",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.reason, "no_matching_ref");
  });

  test("9b. exact href match to a visible link → blocked in hard mode", () => {
    const r = classifyNavigationDiscipline({
      // Same path as the visible product link, but not product-path-shaped on its own.
      targetUrl: "https://www.ikea.com/us/en/p/billy-bookcase-white-00263851",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    assert.equal(r.decision, "block");
  });

  test("10. a blocked decision exposes only safe enum fields (no query/coords)", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/search/?q=secret+query+text",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: freshHints(), hardMode: true,
    });
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes("secret+query+text") && !/[?]q=/.test(blob), `no raw query leaked: ${blob}`);
    assert.ok(!/\bx\b|\bdoc_x\b|width|height/.test(blob), `no coordinates leaked: ${blob}`);
    assert.deepEqual(Object.keys(r).sort(), ["category", "decision", "disposition", "reason"]);
  });

  test("navigationBlockMessage gives a category-specific next action", () => {
    assert.match(navigationBlockMessage("product"), /antigen_snapshot.*browser_click the product\/result ref/);
    assert.match(navigationBlockMessage("search"), /browser_type on the search input ref/);
    assert.match(navigationBlockMessage("cart"), /browser_click on the cart\/bag\/checkout ref/);
    assert.match(navigationBlockMessage(null), /browser_click the product\/result ref/);
    assert.match(
      navigationBlockMessage("snapshot_required"),
      /Use antigen_snapshot first.*browser_click\/browser_type\/browser_scroll_to_ref with visible refs/,
    );
  });

  test("11. a fresh_snapshot_required block exposes only safe enum fields (no query/coords)", () => {
    const r = classifyNavigationDiscipline({
      targetUrl: "https://www.ikea.com/us/en/search/?q=secret+query+text",
      currentUrl: "https://www.ikea.com/us/en/cat/bookcases",
      isFirstNavigation: false, navHints: null, hardMode: true,
    });
    assert.equal(r.decision, "block");
    assert.equal(r.reason, "fresh_snapshot_required");
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes("secret+query+text") && !/[?]q=/.test(blob), `no raw query leaked: ${blob}`);
    assert.ok(!/\bdoc_x\b|width|height/.test(blob), `no coordinates leaked: ${blob}`);
    assert.deepEqual(Object.keys(r).sort(), ["category", "decision", "disposition", "reason"]);
  });

  test("12. sanitizeHostPath reduces a URL to host+path with query/fragment stripped", () => {
    assert.equal(
      sanitizeHostPath("https://www.ikea.com/us/en/search/?q=secret+query#frag"),
      "www.ikea.com/us/en/search/",
    );
    assert.equal(sanitizeHostPath("https://www.ikea.com/"), "www.ikea.com");
    assert.equal(sanitizeHostPath(""), "");
    assert.equal(sanitizeHostPath(null), "");
    assert.equal(sanitizeHostPath("about:blank"), "");
    const blob = sanitizeHostPath("https://www.ikea.com/p/x?token=abc123&cvv=999");
    assert.ok(!blob.includes("abc123") && !blob.includes("999") && !blob.includes("?"), `no secret/query leaked: ${blob}`);
  });
});

// ─── G. Startup QA-env guard (fail-closed) ────────────────────────────────────
// The adapter must refuse to serve tools when launched without the required QA env
// (default-on), so a cached/weak direct launch FATALs instead of running weak.
// These spawns build an EXPLICIT env object — they do NOT spread `...process.env`,
// so they do not inherit the module-scope ANTIGEN_ADAPTER_REQUIRE_QA_ENV=false.

// Spawn the adapter with a fully explicit env, capture stderr + exit code.
function spawnGuardAdapter(env) {
  const adapter = spawn(process.execPath, [ADAPTER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  adapter.stderr.on("data", (d) => { stderr += d.toString(); });
  const closed = new Promise((resolve) => adapter.on("close", (code) => resolve(code)));
  return { adapter, getStderr: () => stderr, closed };
}

const FULL_QA_ENV = {
  AEGIS_API_BASE: "http://127.0.0.1:4000",
  AEGIS_AGENT_TOKEN: "test_token",
  ANTIGEN_BROWSER_HEADLESS: "false",
  ANTIGEN_INPUT_REALISM: "realistic",
  ANTIGEN_BROWSER_TRACE: "true",
  ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS: "true",
  ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION: "true",
};

describe("G. Startup QA-env guard", () => {
  test("default-on + missing QA env → FATAL exit 1 before serving tools", { timeout: 5000 }, async () => {
    // Only API base + token; no QA flags; guard NOT opted out → must fail closed.
    const { getStderr, closed } = spawnGuardAdapter({
      AEGIS_API_BASE: "http://127.0.0.1:4000",
      AEGIS_AGENT_TOKEN: "test_token",
    });
    const code = await closed;
    const stderr = getStderr();
    assert.notEqual(code, 0, `adapter must exit non-zero on missing QA env; stderr: ${stderr}`);
    assert.match(stderr, /FATAL/, `expected FATAL: ${stderr}`);
    assert.match(stderr, /Antigen QA adapter launched without required QA env/, stderr);
    // Names at least one missing flag.
    assert.match(stderr, /ANTIGEN_BROWSER_TRACE/, `expected a missing flag name: ${stderr}`);
    // Did not advance to runtime/serving.
    assert.ok(!stderr.includes("Runtime ready"), `must not serve before guard: ${stderr}`);
  });

  test("explicit opt-out (ANTIGEN_ADAPTER_REQUIRE_QA_ENV=false) → starts in weak mode, no FATAL", { timeout: 5000 }, async () => {
    const { adapter, getStderr } = spawnGuardAdapter({
      AEGIS_API_BASE: "http://127.0.0.1:4000",
      AEGIS_AGENT_TOKEN: "test_token",
      ANTIGEN_ADAPTER_REQUIRE_QA_ENV: "false",
    });
    await new Promise((r) => setTimeout(r, 400));
    const stderr = getStderr();
    assert.ok(!stderr.includes("FATAL"), `weak mode must not FATAL when opted out: ${stderr}`);
    assert.ok(stderr.includes("adapter loaded"), `expected startup log: ${stderr}`);
    assert.equal(adapter.exitCode, null, `adapter should still be running (not exited): ${stderr}`);
    adapter.kill("SIGTERM");
  });

  test("full QA env → starts, qa_flags all true, realism=realistic", { timeout: 5000 }, async () => {
    const { adapter, getStderr } = spawnGuardAdapter({ ...FULL_QA_ENV });
    await new Promise((r) => setTimeout(r, 400));
    const stderr = getStderr();
    assert.ok(!stderr.includes("FATAL"), `full QA env must not FATAL: ${stderr}`);
    assert.match(
      stderr,
      /qa_flags require_realistic_navigation=true require_antigen_tools=true browser_trace=true/,
      `expected all qa_flags true: ${stderr}`,
    );
    assert.match(stderr, /realism=realistic/, `expected realism=realistic: ${stderr}`);
    adapter.kill("SIGTERM");
  });
});

// ─── P. Post-click state realization (browser_click response) ─────────────────
//
// The backend's sanitized post_click_state must reach the agent: a click that
// opens a modal returns the surface (type/title) + names-only actions; a click
// that navigates returns query-free paths — WITHOUT requiring an extra
// antigen_snapshot to find out what happened. Names only: refs always come from
// one fresh antigen_snapshot.

describe("P1. buildPostClickStateText — pure rendering", () => {
  const modalState = {
    change: "modal_opened",
    navigation_or_route_detected: false,
    url_changed: false,
    title_changed: false,
    main_content_changed: true,
    surface: {
      overlay_blocking: true,
      overlay_type: "dialog",
      title: "Choose how to check out",
      surface_actions: [
        { name: "Continue as guest", classification: "primary" },
        { name: "Log in", classification: "secondary" },
        { name: "Place order", classification: "secondary", requires_handoff: true },
        { name: "Close", classification: "dismiss" },
      ],
    },
    recommended_next_step: "refresh_snapshot",
    next: "refs_require_fresh_snapshot",
  };

  test("modal: renders surface, names-only actions, handoff flag, decisive next step", () => {
    const text = buildPostClickStateText(modalState, { intentVerified: true });
    assert.ok(text.includes("Post-click state: modal_opened"), text);
    assert.ok(text.includes('Post-click surface: dialog (blocking) — "Choose how to check out"'), text);
    assert.ok(text.includes('primary "Continue as guest"'), text);
    assert.ok(text.includes('"Place order" [requires_handoff]'), text);
    assert.ok(text.includes('dismiss "Close"'), text);
    assert.ok(text.includes("refs require one antigen_snapshot"), text);
    assert.ok(text.includes("do NOT re-click or wait"), text);
    assert.ok(!text.includes("ref="), `no refs in post-click block: ${text}`);
  });

  test("navigation: renders sanitized path transition + titles + ready_state", () => {
    const text = buildPostClickStateText({
      change: "navigation",
      navigation_or_route_detected: true,
      url_changed: true,
      old_url_path: "/us/en/cart/",
      new_url_path: "/us/en/checkout",
      title_changed: true,
      old_title: "Shopping bag",
      new_title: "Checkout",
      document_ready_state: "complete",
      main_content_changed: true,
      recommended_next_step: "refresh_snapshot",
      next: "refs_require_fresh_snapshot",
    });
    assert.ok(text.includes("Post-click state: navigation"), text);
    assert.ok(text.includes("URL path: /us/en/cart/ → /us/en/checkout (ready_state=complete)"), text);
    assert.ok(text.includes('Title: "Shopping bag" → "Checkout"'), text);
    assert.ok(text.includes("take one antigen_snapshot"), text);
  });

  test("still_loading: tells the agent to wait briefly then snapshot once", () => {
    const text = buildPostClickStateText({
      change: "still_loading",
      navigation_or_route_detected: true,
      url_changed: true,
      title_changed: false,
      main_content_changed: false,
      document_ready_state: "interactive",
      recommended_next_step: "wait_for_load_then_snapshot",
      next: "refs_require_fresh_snapshot",
    });
    assert.ok(text.includes("Post-click state: still_loading"), text);
    assert.ok(text.includes("wait briefly"), text);
  });

  test("none: explicit no-effect message, never a silent success", () => {
    const text = buildPostClickStateText({
      change: "none",
      navigation_or_route_detected: false,
      url_changed: false,
      title_changed: false,
      main_content_changed: false,
      recommended_next_step: "try_alternate_ref",
      next: "refs_require_fresh_snapshot",
    });
    assert.ok(text.includes("Post-click state: none"), text);
    assert.ok(text.includes("do not blind-retry"), text);
  });

  test("absorbed click: unverified + persistent blocking surface warns explicitly", () => {
    const text = buildPostClickStateText(
      { ...modalState, change: "none" },
      { intentVerified: false },
    );
    assert.ok(text.includes("likely absorbed"), text);
  });

  test("absent/malformed state renders nothing", () => {
    assert.equal(buildPostClickStateText(undefined), "");
    assert.equal(buildPostClickStateText(null), "");
    assert.equal(buildPostClickStateText("nope"), "");
    assert.equal(buildPostClickStateText({}), "");
  });
});

describe("P2. adapter browser_click — post-click state passthrough", () => {
  const guestModalClickBody = {
    ok: true,
    data: {
      mode: "realistic_pointer_click",
      pointer_path_point_count: 42,
      pointer_start_source: "session",
      pointer_state_persisted: true,
      click_dispatched: true,
      intent_verified: true,
      verification_signal: "modal_opened",
      outcome: "CLICK_VERIFIED",
      recommended_next_step: "none",
      verify_ms: 480,
      settle_polls: 3,
      post_click_state: {
        change: "modal_opened",
        navigation_or_route_detected: false,
        url_changed: false,
        title_changed: false,
        main_content_changed: true,
        surface: {
          overlay_blocking: true,
          overlay_type: "dialog",
          title: "Choose how to check out",
          surface_actions: [
            { name: "Continue as guest", classification: "secondary" },
            { name: "Log in", classification: "secondary" },
            { name: "Close", classification: "dismiss" },
          ],
        },
        recommended_next_step: "refresh_snapshot",
        next: "refs_require_fresh_snapshot",
      },
    },
  };

  test("click that opens the guest modal: agent text carries verification + surface info (no extra snapshot needed)", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({ browserClickBody: guestModalClickBody });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 71, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Continue to checkout", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 71);
    assert.ok(resp, `expected response for id=71, stdout was: ${stdoutBuf}`);
    assert.ok(!resp.result?.isError, `expected success, got: ${JSON.stringify(resp.result)}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    // Verification scalars now agent-visible.
    assert.ok(text.includes("intent_verified=true"), text);
    assert.ok(text.includes("verification_signal=modal_opened"), text);
    assert.ok(text.includes("outcome=CLICK_VERIFIED"), text);
    assert.ok(text.includes("verify_ms=480"), text);
    assert.ok(text.includes("settle_polls=3"), text);
    // Post-click surface realization: modal + action names, no snapshot required.
    assert.ok(text.includes("Post-click state: modal_opened"), text);
    assert.ok(text.includes('"Choose how to check out"'), text);
    assert.ok(text.includes('"Continue as guest"'), text);
    // Names only — no refs/boxes/hrefs/query content anywhere in the output.
    const postClickBlock = text.slice(text.indexOf("Post-click state:"));
    assert.ok(!postClickBlock.includes("ref="), `no refs in post-click block: ${postClickBlock}`);
    const FORBIDDEN = ["user_data_dir", "pass_id", "secret_ref", '"box"', "cdp_url", "post_click_internal", "title_hash"];
    for (const f of FORBIDDEN) {
      assert.ok(!stdoutBuf.includes(f), `forbidden internal "${f}" leaked to stdout`);
    }
  });

  test("navigation click: agent text carries the sanitized path transition", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer({
      browserClickBody: {
        ok: true,
        data: {
          mode: "realistic_pointer_click",
          pointer_state_persisted: true,
          click_dispatched: true,
          intent_verified: true,
          verification_signal: "url_changed",
          outcome: "CLICK_VERIFIED",
          recommended_next_step: "none",
          verify_ms: 130,
          settle_polls: 1,
          post_click_state: {
            change: "navigation",
            navigation_or_route_detected: true,
            url_changed: true,
            old_url_path: "/us/en/cart/",
            new_url_path: "/us/en/checkout",
            title_changed: true,
            old_title: "Shopping bag",
            new_title: "Checkout",
            document_ready_state: "complete",
            main_content_changed: true,
            recommended_next_step: "refresh_snapshot",
            next: "refs_require_fresh_snapshot",
          },
        },
      },
    });
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 72, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "Shopping bag", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 72);
    assert.ok(resp, `expected response for id=72, stdout was: ${stdoutBuf}`);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("Post-click state: navigation"), text);
    assert.ok(text.includes("URL path: /us/en/cart/ → /us/en/checkout (ready_state=complete)"), text);
    assert.ok(text.includes('Title: "Shopping bag" → "Checkout"'), text);
    assert.ok(!stdoutBuf.includes("?session"), "query content must never appear");
  });

  test("legacy response without verification fields: today's text format unchanged", { timeout: 7000 }, async () => {
    const { server, port } = await createMockApiServer(); // default body: pointer metadata only
    const { binPath, cleanup } = createFakeMcpBin();

    const adapter = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        AEGIS_API_BASE: `http://127.0.0.1:${port}`,
        AEGIS_AGENT_TOKEN: "test_token",
        ANTIGEN_BROWSER_HEADLESS: "false",
        ANTIGEN_INPUT_REALISM: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    adapter.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    adapter.stdin.write(MCP_INIT_MSG);
    await new Promise((r) => setTimeout(r, 200));
    adapter.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 73, method: "tools/call",
      params: { name: "browser_click", arguments: { element: "desk lamp", ref: "ag_1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 1500));

    adapter.kill("SIGTERM");
    server.close();
    cleanup();

    const resp = parseMcpResponse(stdoutBuf, 73);
    const text = resp.result?.content?.[0]?.text ?? "";
    assert.ok(text.includes("path=realistic_success"), text);
    assert.ok(text.includes("pointer_path_point_count=42"), text);
    assert.ok(!text.includes("Post-click state:"), `no post-click block without backend fields: ${text}`);
    assert.ok(!text.includes("intent_verified"), `no verification keys without backend fields: ${text}`);
  });
});

// ─── P4. buildPostFillStateText — pure rendering (post_fill_state) ────────────
//
// The protected-fill analogue of P1: allowlist-only rendering of the backend's
// sanitized post_fill_state from the profile/payment fill execute responses.
// Names-only actions with disabled/handoff flags, masking/redaction one-liner,
// fail-closed iframe-mismatch warning, one decisive next step per outcome —
// and never a ref, selector, query string, or value.

describe("P4. buildPostFillStateText — pure rendering", () => {
  const readyState = {
    outcome: "ready_for_next_action",
    filled_count: 4,
    failed_count: 0,
    validation_error_count: 0,
    next_action_names: [
      { name: "Continue to payment", classification: "primary" },
      { name: "Save and continue later", classification: "secondary", disabled: true },
      { name: "Place order", classification: "secondary", requires_handoff: true },
      { name: "Close", classification: "dismiss" },
    ],
    masking: {
      dom_filled_marker_count: 4,
      visual_mask_marker_count: 4,
      iframe_redaction_fields: ["card_number", "cvv"],
    },
    probe_ms: 142,
    raw_values_revealed_to_agent: false,
    recommended_next_step: "snapshot_then_click_named_action",
    next: "refs_require_fresh_snapshot",
  };

  test("ready_for_next_action: names the primary, reports masking, forbids scroll-hunt/re-verification", () => {
    const text = buildPostFillStateText(readyState);
    assert.ok(text.includes("Post-fill state: ready_for_next_action"), text);
    assert.ok(text.includes("Fill result: 4 filled, 0 failed; validation_errors=0"), text);
    assert.ok(text.includes("4 DOM fill markers"), text);
    assert.ok(text.includes("iframe redaction registered: card_number, cvv"), text);
    assert.ok(text.includes('primary "Continue to payment"'), text);
    assert.ok(text.includes('"Save and continue later" [disabled]'), text);
    assert.ok(text.includes('"Place order" [requires_handoff]'), text);
    assert.ok(text.includes('click "Continue to payment"'), text);
    assert.ok(text.includes("do not scroll-hunt"), text);
    assert.ok(text.includes("refs require one antigen_snapshot"), text);
    assert.ok(!text.includes("ref="), `no refs in post-fill block: ${text}`);
  });

  test("validation_errors_present: review guidance, no blind retry", () => {
    const text = buildPostFillStateText({
      ...readyState,
      outcome: "validation_errors_present",
      validation_error_count: 2,
      recommended_next_step: "review_validation_errors",
    });
    assert.ok(text.includes("Post-fill state: validation_errors_present"), text);
    assert.ok(text.includes("validation_errors=2"), text);
    assert.ok(text.includes("review the flagged fields"), text);
    assert.ok(text.includes("do not retry the fill blindly"), text);
  });

  test("handoff_required_next: explicit do-NOT-click-final-action instruction", () => {
    const text = buildPostFillStateText({
      ...readyState,
      outcome: "handoff_required_next",
      next_action_names: [{ name: "Place order", classification: "secondary", requires_handoff: true }],
      recommended_next_step: "handoff_required",
    });
    assert.ok(text.includes("Post-fill state: handoff_required_next"), text);
    assert.ok(text.includes("do NOT click the final action yourself"), text);
    assert.ok(text.includes("handoff tools"), text);
  });

  test("fill_incomplete: points at filled_fields and re-requesting only failures", () => {
    const text = buildPostFillStateText({
      ...readyState,
      outcome: "fill_incomplete",
      filled_count: 2,
      failed_count: 2,
      recommended_next_step: "refresh_snapshot",
    });
    assert.ok(text.includes("Post-fill state: fill_incomplete"), text);
    assert.ok(text.includes("Fill result: 2 filled, 2 failed"), text);
    assert.ok(text.includes("re-request only the failed fields"), text);
  });

  test("no_next_action_visible: snapshot first, no blind scroll", () => {
    const text = buildPostFillStateText({
      ...readyState,
      outcome: "no_next_action_visible",
      next_action_names: undefined,
      recommended_next_step: "refresh_snapshot",
    });
    assert.ok(text.includes("Post-fill state: no_next_action_visible"), text);
    assert.ok(text.includes("do not blind-scroll first"), text);
  });

  test("unknown: fill result stays authoritative; one confirming snapshot", () => {
    const text = buildPostFillStateText({
      outcome: "unknown",
      filled_count: 3,
      failed_count: 0,
      masking: {},
      raw_values_revealed_to_agent: false,
      recommended_next_step: "refresh_snapshot",
      next: "refs_require_fresh_snapshot",
    });
    assert.ok(text.includes("Post-fill state: unknown"), text);
    assert.ok(text.includes("still authoritative"), text);
    assert.ok(text.includes("take one antigen_snapshot"), text);
  });

  test("iframe redaction mismatch renders the fail-closed WARNING", () => {
    const text = buildPostFillStateText({
      ...readyState,
      masking: {
        dom_filled_marker_count: 1,
        visual_mask_marker_count: 1,
        iframe_redaction_fields: ["card_number"],
        iframe_redaction_mismatch: true,
      },
    });
    assert.ok(text.includes("WARNING"), text);
    assert.ok(text.includes("MISSING from the screenshot-redaction registry"), text);
    assert.ok(text.includes("do not take screenshots"), text);
  });

  test("post-fill surface renders names-only overlay context", () => {
    const text = buildPostFillStateText({
      ...readyState,
      surface: { overlay_blocking: true, overlay_type: "dialog", title: "Verify your address" },
    });
    assert.ok(text.includes('Post-fill surface: dialog (blocking) — "Verify your address"'), text);
  });

  test("absent/malformed state renders nothing", () => {
    assert.equal(buildPostFillStateText(undefined), "");
    assert.equal(buildPostFillStateText(null), "");
    assert.equal(buildPostFillStateText("nope"), "");
    assert.equal(buildPostFillStateText({}), "");
  });

  test("leak boundary: planted refs/selectors/query strings never reach the rendered text", () => {
    const text = buildPostFillStateText({
      ...readyState,
      // Hostile payload shape: unknown fields must be ignored, never stringified.
      ref: "ag_42",
      selector: "#card-number",
      page_url: "https://x.test/checkout?session=tok_secret",
      next_action_names: [
        { name: "Continue to payment", classification: "primary", ref: "ag_9", href: "/a?b=1" },
      ],
    });
    assert.ok(!text.includes("ag_42"), text);
    assert.ok(!text.includes("ag_9"), text);
    assert.ok(!text.includes("#card-number"), text);
    assert.ok(!text.includes("tok_secret"), text);
    assert.ok(!text.includes("?"), text);
  });
});

// ─── P5. withPostFillSummary — fill-handler pass-through contract ─────────────
//
// The live IKEA smoke could not distinguish "the API never emitted
// post_fill_state" from "the adapter dropped it". This group pins the adapter
// side: the API data object is passed through UNTOUCHED (post_fill_state
// preserved by reference) and post_fill_summary is appended only when the state
// renders. Both fill execute handlers route through this helper.

describe("P5. withPostFillSummary — fill-handler pass-through", () => {
  const fillData = {
    fill_request_id: "pcfr_1",
    status: "filled",
    raw_values_revealed_to_agent: false,
    purchase_not_authorized: true,
    post_fill_state: {
      outcome: "ready_for_next_action",
      filled_count: 1,
      failed_count: 0,
      validation_error_count: 0,
      next_action_names: [{ name: "Continue", classification: "primary" }],
      raw_values_revealed_to_agent: false,
      recommended_next_step: "snapshot_then_click_named_action",
      next: "refs_require_fresh_snapshot",
    },
  };

  test("preserves post_fill_state AND appends a non-empty post_fill_summary", () => {
    const out = withPostFillSummary(fillData);
    // The state object survives untouched (same reference — nothing stripped).
    assert.equal(out.post_fill_state, fillData.post_fill_state);
    assert.equal(out.status, "filled");
    assert.equal(typeof out.post_fill_summary, "string");
    assert.ok(out.post_fill_summary.startsWith("Post-fill state:"), out.post_fill_summary);
    assert.ok(out.post_fill_summary.includes("ready_for_next_action"), out.post_fill_summary);
  });

  test("data without post_fill_state is returned unchanged — no key added", () => {
    const plain = { fill_request_id: "pcfr_2", status: "filled" };
    const out = withPostFillSummary(plain);
    assert.equal(out, plain);
    assert.ok(!("post_fill_summary" in out));
  });

  test("unrenderable state (missing outcome) → data unchanged, state still present", () => {
    const data = { status: "filled", post_fill_state: { filled_count: 1 } };
    const out = withPostFillSummary(data);
    assert.equal(out, data);
    assert.equal(out.post_fill_state, data.post_fill_state);
    assert.ok(!("post_fill_summary" in out));
  });

  test("undefined/null data passes through (error paths never throw here)", () => {
    assert.equal(withPostFillSummary(undefined), undefined);
    assert.equal(withPostFillSummary(null), null);
  });

  test("leak boundary: a poisoned extra field never reaches the rendered summary", () => {
    const out = withPostFillSummary({
      ...fillData,
      post_fill_state: {
        ...fillData.post_fill_state,
        secret_ref: "devvault://nope",
        page_url: "https://x.test/pay?session=tok_secret",
      },
    });
    assert.ok(out.post_fill_summary, "summary expected");
    assert.ok(!out.post_fill_summary.includes("devvault"), out.post_fill_summary);
    assert.ok(!out.post_fill_summary.includes("tok_secret"), out.post_fill_summary);
    assert.ok(!out.post_fill_summary.includes("?"), out.post_fill_summary);
  });
});
