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

import {
  looksLikeSelector,
  charCountBucket,
  buildSyntheticSuccessText,
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
