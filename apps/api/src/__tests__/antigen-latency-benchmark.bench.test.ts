/**
 * Antigen browser runtime — latency benchmark (manual, NEVER in CI).
 *
 * Double-gated: runs only when ANTIGEN_BENCHMARK=true AND a Playwright Chromium
 * is installed. Default `vitest run` always skips it, so it can never become a
 * CI gate or a flake source. Assertions are intentionally trivial (success only);
 * the deliverable is the printed latency table.
 *
 * Run:
 *   ANTIGEN_BENCHMARK=true npx vitest run antigen-latency-benchmark
 * Add ANTIGEN_BROWSER_TIMING_DEBUG=true for per-stage breakdowns.
 *
 * Benchmarked operations (real Chromium + local fixture page):
 *   1. snapshot_core        — resolveSnapshotCdpTarget + candidate extraction + page-meta
 *   2. click_fast           — realisticClickKnownBox, ANTIGEN_POINTER_TIMING=fast (transport cost)
 *   3. click_realistic      — realisticClickKnownBox, default realistic profile (realism share)
 *   4. set_value            — setFieldValueKnownBox exact replacement (alternating values)
 *   5. type_short           — realisticTypeKnownBox, 3 chars, realism on
 *   6. screenshot_0_fields  — captureRedactedScreenshot, no protected fields
 *   7. screenshot_2_fields  — captureRedactedScreenshot, 2 marked fields (pixel pass)
 *
 * Screenshot benches tolerate capture failure (headless Page.captureScreenshot is
 * broken on some boxes) and report "capture_unavailable" instead of failing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright";

import { resolveSnapshotCdpTarget } from "../runtime/cdpTargetSelection.js";
import {
  extractAntigenSnapshotCandidatesViaCDP,
  extractAntigenSnapshotBundleViaCDP,
  type AntigenSnapshotCandidate,
} from "../runtime/antigenSnapshotRuntime.js";
import {
  realisticClickKnownBox,
  realisticTypeKnownBox,
  setFieldValueKnownBox,
} from "../runtime/realisticBrowserActions.js";
import { captureRedactedScreenshot } from "../runtime/screenshotRedaction.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/latency-benchmark.html", import.meta.url));
const N = Math.max(3, parseInt(process.env.ANTIGEN_BENCHMARK_N ?? "20", 10) || 20);

function chromiumExe(): string | null {
  try {
    const p = chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(cdpUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${cdpUrl}/json/version`);
      if (r.ok) {
        const j = (await r.json()) as { webSocketDebuggerUrl?: string };
        if (j.webSocketDebuggerUrl) return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("CDP endpoint did not become ready");
}

interface BenchRow {
  name: string;
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
  note?: string;
}

function stats(name: string, samples: number[], note?: string): BenchRow {
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    name, n: sorted.length,
    p50: r(q(0.5)), p95: r(q(0.95)),
    min: r(sorted[0] ?? 0), max: r(sorted.at(-1) ?? 0), mean: r(mean),
    ...(note ? { note } : {}),
  };
}

async function measure(fn: () => Promise<void>, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    out.push(Number(process.hrtime.bigint() - t0) / 1_000_000);
  }
  return out;
}

const EXE = chromiumExe();
const ENABLED = process.env.ANTIGEN_BENCHMARK === "true" && EXE !== null;

describe.skipIf(!ENABLED)("Antigen latency benchmark (manual)", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;
  let candidates: AntigenSnapshotCandidate[] = [];
  const rows: BenchRow[] = [];
  const fixtureUrl = `file://${FIXTURE}`;
  const origPointerTiming = process.env.ANTIGEN_POINTER_TIMING;

  const findByName = (needle: string): AntigenSnapshotCandidate => {
    const c = candidates.find((x) => x.normalized_name.includes(needle));
    if (!c) throw new Error(`benchmark fixture candidate not found: ${needle}`);
    return c;
  };

  beforeAll(async () => {
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "antigen-bench-"));
    proc = spawn(
      EXE!,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        fixtureUrl,
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(cdpUrl);
    await new Promise((res) => setTimeout(res, 300));
    candidates = await extractAntigenSnapshotCandidatesViaCDP({ cdpUrl });
  }, 30_000);

  afterAll(() => {
    if (origPointerTiming === undefined) delete process.env.ANTIGEN_POINTER_TIMING;
    else process.env.ANTIGEN_POINTER_TIMING = origPointerTiming;
    try {
      proc?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    try {
      if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // The deliverable: one markdown table, printed AND written to a file (vitest
    // can swallow hook stdout on success).
    const lines = [
      "### Antigen latency benchmark (ms per operation)",
      "",
      "| operation | n | p50 | p95 | min | max | mean | note |",
      "|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.name} | ${r.n} | ${r.p50} | ${r.p95} | ${r.min} | ${r.max} | ${r.mean} | ${r.note ?? ""} |`),
      "",
    ];
    // eslint-disable-next-line no-console
    console.log("\n" + lines.join("\n"));
    const outPath = process.env.ANTIGEN_BENCHMARK_OUT ?? join(tmpdir(), "antigen-benchmark.md");
    try {
      writeFileSync(outPath, lines.join("\n"));
    } catch {
      /* best-effort */
    }
  });

  it("1. snapshot_core (endpoint path: resolve + single-connection bundle)", async () => {
    const samples = await measure(async () => {
      const resolved = await resolveSnapshotCdpTarget(cdpUrl);
      const resolvedTarget = resolved
        ? { browserWsUrl: resolved.browserWsUrl, pageTarget: { id: resolved.target.id, url: resolved.target.url } }
        : undefined;
      const bundle = await extractAntigenSnapshotBundleViaCDP({ cdpUrl, resolvedTarget });
      expect(bundle.candidates.length).toBeGreaterThan(0);
    }, N);
    rows.push(stats("snapshot_core", samples));
  }, 120_000);

  it("2. click_fast (pointer timing = fast → transport cost)", async () => {
    process.env.ANTIGEN_POINTER_TIMING = "fast";
    const btn = findByName("toggle counter");
    const samples = await measure(async () => {
      const r = await realisticClickKnownBox({ cdpUrl, box: btn.box, expectedUrl: fixtureUrl });
      expect(r.success).toBe(true);
    }, N);
    rows.push(stats("click_fast", samples));
  }, 180_000);

  it("3. click_realistic (default pointer profile)", async () => {
    delete process.env.ANTIGEN_POINTER_TIMING;
    const btn = findByName("toggle counter");
    const samples = await measure(async () => {
      const r = await realisticClickKnownBox({ cdpUrl, box: btn.box, expectedUrl: fixtureUrl });
      expect(r.success).toBe(true);
    }, Math.min(N, 10));
    rows.push(stats("click_realistic", samples));
  }, 180_000);

  it("4. set_value (exact replacement, alternating values)", async () => {
    const field = findByName("full name");
    let i = 0;
    const samples = await measure(async () => {
      i += 1;
      const r = await setFieldValueKnownBox({ cdpUrl, box: field.box, value: `Bench Value ${i % 2}`, expectedUrl: fixtureUrl });
      expect(r.success).toBe(true);
    }, N);
    rows.push(stats("set_value", samples));
  }, 120_000);

  it("5. type_short (3 chars, realism on)", async () => {
    process.env.ANTIGEN_POINTER_TIMING = "fast";
    const field = findByName("city");
    const samples = await measure(async () => {
      const r = await realisticTypeKnownBox({ cdpUrl, box: field.box, text: "abc", expectedUrl: fixtureUrl });
      expect(r.success).toBe(true);
    }, Math.min(N, 10));
    delete process.env.ANTIGEN_POINTER_TIMING;
    rows.push(stats("type_short", samples));
  }, 180_000);

  it("6+7. screenshot redaction (0 fields, then 2 marked fields)", async () => {
    const resolved = await resolveSnapshotCdpTarget(cdpUrl);
    expect(resolved).not.toBeNull();
    const browserWsUrl = resolved!.browserWsUrl;
    const pageTargetId = resolved!.target.id;

    const first = await captureRedactedScreenshot({ browserWsUrl, pageTargetId });
    if (!first.ok) {
      rows.push(stats("screenshot_0_fields", [], "capture_unavailable_on_this_box"));
      rows.push(stats("screenshot_2_fields", [], "capture_unavailable_on_this_box"));
      return;
    }

    const zeroSamples = await measure(async () => {
      const r = await captureRedactedScreenshot({ browserWsUrl, pageTargetId });
      expect(r.ok).toBe(true);
    }, Math.min(N, 10));
    rows.push(stats("screenshot_0_fields", zeroSamples));

    // Mark two fixture fields the way protected fills do, so the overlay+pixel pass engages.
    await realisticClickKnownBox({ cdpUrl, box: findByName("toggle counter").box, expectedUrl: fixtureUrl }); // warm pointer; harmless
    const markExpr = `(function(){
      ["bench-text","bench-city"].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.setAttribute("data-antigen-masked","true");
      });
      return true;
    })()`;
    const markRes = await setMarkViaSnapshotEval(markExpr);
    expect(markRes).toBe(true);

    const twoSamples = await measure(async () => {
      const r = await captureRedactedScreenshot({ browserWsUrl, pageTargetId });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.redacted_field_count).toBe(2);
    }, Math.min(N, 10));
    rows.push(stats("screenshot_2_fields", twoSamples));
  }, 240_000);

  /** Evaluate a marking expression on the fixture page over CDP (bench-only helper). */
  async function setMarkViaSnapshotEval(expression: string): Promise<unknown> {
    const { default: WebSocket } = await import("ws");
    const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string }>;
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      let id = 1;
      let sessionId: string | null = null;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("eval timeout"));
      }, 5000);
      ws.on("open", () =>
        ws.send(JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId: page.id, flatten: true } })),
      );
      ws.on("message", (raw: Buffer | string) => {
        const msg = JSON.parse(raw.toString());
        if (msg.result?.sessionId && !sessionId) {
          sessionId = msg.result.sessionId;
          ws.send(JSON.stringify({ id: id++, method: "Runtime.evaluate", sessionId, params: { expression, returnByValue: true } }));
          return;
        }
        if (msg.result?.result && msg.id >= 2) {
          clearTimeout(timer);
          ws.close();
          resolve(msg.result.result.value);
        }
      });
      ws.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
});
