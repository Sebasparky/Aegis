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
  buildSyntheticSuccessText,
  buildAntigenSnapshotText,
} from "./lib/adapter-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = join(__dirname, "antigen-browser-adapter.mjs");

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
  } = opts;

  // Captured antigen_snapshot request bodies + their Authorization header,
  // so tests can assert what the adapter sent.
  const snapshotRequests = [];

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
        const responseBody = browserSnapshotBody ?? DEFAULT_SNAPSHOT_BODY;
        res.writeHead(browserSnapshotStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-endpoint") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: {
            cdp_url: "http://127.0.0.1:19999",
            browser_runtime_id: "test_runtime_001",
            runtime_mode: "test_mode",
            reused_existing: false,
          },
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-type") {
        if (browserTypeDestroy) { req.socket.destroy(); return; }
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
        const responseBody = browserClickBody ?? {
          ok: true,
          data: { mode: "realistic_pointer_click", pointer_path_point_count: 42, pointer_start_source: "session", pointer_state_persisted: true },
        };
        res.writeHead(browserClickStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, getSnapshotRequests: () => snapshotRequests };
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
  } = opts;

  const navRequests = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/agent/v1/runtime/browser-endpoint") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: {
            cdp_url: "http://127.0.0.1:19999",
            browser_runtime_id: "test_runtime_001",
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
        const respond = () => {
          const responseBody = navStateBody ?? {
            ok: true,
            data: { pointer_state_persisted: true, pointer_start_source: "session", pointer_action: "navigation_proxy" },
          };
          res.writeHead(navStateStatus, { "Content-Type": "application/json" });
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
  return { server, port: server.address().port, getNavRequests: () => navRequests };
}

// Fake MCP stub that responds to browser_navigate with a success result.
const FAKE_MCP_NAVIGATE_STUB_SRC = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line.trim());
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp-nav", version: "0" } }
      }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params?.name === "browser_navigate") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: "Navigated to " + (msg.params?.arguments?.url ?? "unknown") }] }
      }) + "\\n");
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
});

// ─── J. buildAntigenSnapshotText — pure allowlist formatter ───────────────────

describe("J. buildAntigenSnapshotText — pure formatter", () => {
  const V = "2026-05-29";
  const SAMPLE = {
    snapshot_id: "snap_abc123",
    url: "https://www.ikea.com/us/en/search/?q=desk%20lamp",
    title: null,
    expires_at: "2026-01-01T00:00:10.000Z",
    element_count: 2,
    elements: [
      {
        ref: "ag_1", kind: "link", role: "link", name: "TERTIAL, Work lamp, light blue",
        state: { visible: true, enabled: true, clickable: true, typeable: false },
        hints: { href_path: "/us/en/p/tertial-work-lamp-light-blue-70504295/" },
      },
      {
        ref: "ag_2", kind: "button", role: "button", name: "Add to bag",
        state: { visible: true, enabled: true, clickable: true, typeable: false },
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

  test("includes url and expires_at when present", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(text.includes("url: https://www.ikea.com/us/en/search/?q=desk%20lamp"), text);
    assert.ok(text.includes("expires_at: 2026-01-01T00:00:10.000Z"), text);
  });

  test("omits url/title/expires_at lines when absent", () => {
    const text = buildAntigenSnapshotText({ snapshot_id: "snap_x", element_count: 0, elements: [] }, V);
    assert.ok(!text.includes("url:"), text);
    assert.ok(!text.includes("title:"), text);
    assert.ok(!text.includes("expires_at:"), text);
  });

  test("omits title line when title is null", () => {
    const text = buildAntigenSnapshotText(SAMPLE, V);
    assert.ok(!text.includes("title:"), text);
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
