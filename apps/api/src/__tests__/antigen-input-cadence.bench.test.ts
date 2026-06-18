/**
 * Antigen browser runtime — input / cadence measurement (manual, NEVER in CI).
 *
 * This is the measurement harness called for in backlog item #4 of
 * docs/ANTIGEN_INPUT_REALISM_AUDIT.md. It drives the REAL CDP runtime against a
 * controlled local fixture and reads back the browser-visible events the page
 * recorded (mousemove / mousedown / mouseup / click and
 * keydown / beforeinput / input / keyup, all with performance.now() timestamps).
 * It then reports the measured cadence and asserts loose, non-flaky bounds.
 *
 * It measures only — it changes no runtime behavior, contains no anti-bot /
 * vendor logic, and touches only a local file:// fixture. The deliverable is the
 * printed/written cadence table; assertions are intentionally wide bands.
 *
 * Double-gated: runs only when ANTIGEN_BENCHMARK=true AND a Playwright Chromium is
 * installed. Default `vitest run` always skips it, so it can never become a CI
 * gate or a flake source.
 *
 * Run:
 *   ANTIGEN_BENCHMARK=true npx vitest run antigen-input-cadence
 *   ANTIGEN_CADENCE_OUT=/path/report.md ANTIGEN_BENCHMARK=true npx vitest run antigen-input-cadence
 *
 * Measured numbers are a REPRESENTATIVE LOCAL BASELINE — they depend on machine,
 * Chromium build, and load. They are not a universal guarantee.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright";

import {
  extractAntigenSnapshotCandidatesViaCDP,
  type AntigenSnapshotCandidate,
} from "../runtime/antigenSnapshotRuntime.js";
import {
  realisticClickKnownBox,
  realisticTypeKnownBox,
} from "../runtime/realisticBrowserActions.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/input-cadence-fixture.html", import.meta.url));
const N = Math.max(3, parseInt(process.env.ANTIGEN_BENCHMARK_N ?? "10", 10) || 10);
const TYPE_TEXT = "hello world";

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

// --- recorded-event shapes (mirrors the fixture's window.__antigenCadence) ----
interface TimedEvent {
  t: number;
  key?: string;
  target?: string;
  inputType?: string;
}
interface CadenceLog {
  markT: number;
  marks: Record<string, number>;
  mousemove: TimedEvent[];
  mousedown: TimedEvent[];
  mouseup: TimedEvent[];
  click: TimedEvent[];
  keydown: TimedEvent[];
  beforeinput: TimedEvent[];
  input: TimedEvent[];
  keyup: TimedEvent[];
}

interface CadenceRow {
  name: string;
  unit: string;
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
  note?: string;
}

function stats(name: string, unit: string, samples: number[], note?: string): CadenceRow {
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    name,
    unit,
    n: sorted.length,
    p50: r(q(0.5)),
    p95: r(q(0.95)),
    min: r(sorted[0] ?? 0),
    max: r(sorted.at(-1) ?? 0),
    mean: r(mean),
    ...(note ? { note } : {}),
  };
}

const EXE = chromiumExe();
const ENABLED = process.env.ANTIGEN_BENCHMARK === "true" && EXE !== null;

describe.skipIf(!ENABLED)("Antigen input / cadence measurement (manual)", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;
  let candidates: AntigenSnapshotCandidate[] = [];
  const rows: CadenceRow[] = [];
  const fixtureUrl = `file://${FIXTURE}`;
  // Measure at the production-default pointer profile (realistic) and default
  // input-realism (full key-event sequence ON). We pin nothing except clearing a
  // stray ANTIGEN_POINTER_TIMING so a developer's shell can't skew the baseline.
  const origPointerTiming = process.env.ANTIGEN_POINTER_TIMING;

  const findByName = (needle: string): AntigenSnapshotCandidate => {
    const c = candidates.find((x) => x.normalized_name.includes(needle));
    if (!c) throw new Error(`cadence fixture candidate not found: ${needle}`);
    return c;
  };

  beforeAll(async () => {
    delete process.env.ANTIGEN_POINTER_TIMING; // ensure realistic profile
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "antigen-cadence-"));
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
    const lines = [
      "### Antigen input / cadence measurement",
      "",
      "Representative local baseline — depends on machine, Chromium build, and load.",
      "",
      "| metric | unit | n | p50 | p95 | min | max | mean | note |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows.map(
        (r) =>
          `| ${r.name} | ${r.unit} | ${r.n} | ${r.p50} | ${r.p95} | ${r.min} | ${r.max} | ${r.mean} | ${r.note ?? ""} |`,
      ),
      "",
    ];
    // eslint-disable-next-line no-console
    console.log("\n" + lines.join("\n"));
    const outPath = process.env.ANTIGEN_CADENCE_OUT ?? join(tmpdir(), "antigen-input-cadence.md");
    try {
      writeFileSync(outPath, lines.join("\n"));
    } catch {
      /* best-effort */
    }
  });

  /** Evaluate an expression on the fixture page over CDP, returning its value. */
  async function cdpEval<T>(expression: string): Promise<T> {
    const { default: WebSocket } = await import("ws");
    const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string }>;
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    return new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      let id = 1;
      let sessionId: string | null = null;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("eval timeout"));
      }, 5000);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId: page.id, flatten: true } }),
        ),
      );
      ws.on("message", (raw: Buffer | string) => {
        const msg = JSON.parse(raw.toString());
        if (msg.result?.sessionId && !sessionId) {
          sessionId = msg.result.sessionId;
          ws.send(
            JSON.stringify({
              id: id++,
              method: "Runtime.evaluate",
              sessionId,
              params: { expression, returnByValue: true },
            }),
          );
          return;
        }
        if (msg.result?.result && msg.id >= 2) {
          clearTimeout(timer);
          ws.close();
          resolve(msg.result.result.value as T);
        }
      });
      ws.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  const resetRecorder = () => cdpEval<boolean>("window.__antigenCadence.reset()");
  const readCadence = () => cdpEval<CadenceLog>("window.__antigenCadence.get()");

  it("click cadence — mousemoves, press→release gap, action-start→click onset", async () => {
    const btn = findByName("action a");
    const moveCounts: number[] = [];
    const pressReleaseGaps: number[] = [];
    const upToClickGaps: number[] = [];
    const onsets: number[] = []; // recorder reset → click event

    for (let i = 0; i < Math.min(N, 10); i++) {
      await resetRecorder();
      const r = await realisticClickKnownBox({ cdpUrl, box: btn.box, expectedUrl: fixtureUrl });
      expect(r.success).toBe(true);
      const log = await readCadence();

      expect(log.mousedown.length).toBeGreaterThanOrEqual(1);
      expect(log.mouseup.length).toBeGreaterThanOrEqual(1);
      expect(log.click.length).toBeGreaterThanOrEqual(1);

      const down = log.mousedown.at(-1)!;
      const up = log.mouseup.at(-1)!;
      const click = log.click.at(-1)!;
      // Ordering: a real click is press → release → click.
      expect(down.t).toBeLessThanOrEqual(up.t + 1);
      expect(up.t).toBeLessThanOrEqual(click.t + 1);

      moveCounts.push(log.mousemove.length);
      pressReleaseGaps.push(up.t - down.t);
      upToClickGaps.push(click.t - up.t);
      onsets.push(click.t - log.markT);
    }

    rows.push(stats("click_mousemove_count", "count", moveCounts));
    rows.push(stats("click_press_release_gap", "ms", pressReleaseGaps));
    rows.push(stats("click_up_to_click_gap", "ms", upToClickGaps));
    rows.push(stats("click_onset_to_click", "ms", onsets, "recorder reset → click event"));

    // Loose bands — realistic profile is ~20 path points + an 80ms press→release.
    const meanMoves = moveCounts.reduce((a, b) => a + b, 0) / moveCounts.length;
    expect(meanMoves).toBeGreaterThanOrEqual(5);
    expect(meanMoves).toBeLessThanOrEqual(40);
    const meanGap = pressReleaseGaps.reduce((a, b) => a + b, 0) / pressReleaseGaps.length;
    expect(meanGap).toBeGreaterThanOrEqual(20);
    expect(meanGap).toBeLessThanOrEqual(400);
  }, 180_000);

  it("typing cadence — full key-event sequence + inter-character delays", async () => {
    const field = findByName("free text");
    const charCount = TYPE_TEXT.length;
    const interCharDelays: number[] = [];
    const onsets: number[] = []; // reset → first keydown
    const keydownCounts: number[] = [];
    const keyupCounts: number[] = [];
    const inputCounts: number[] = [];
    const beforeinputCounts: number[] = [];

    for (let i = 0; i < Math.min(N, 8); i++) {
      await resetRecorder();
      const r = await realisticTypeKnownBox({ cdpUrl, box: field.box, text: TYPE_TEXT, expectedUrl: fixtureUrl });
      expect(r.success).toBe(true);
      const log = await readCadence();

      keydownCounts.push(log.keydown.length);
      keyupCounts.push(log.keyup.length);
      inputCounts.push(log.input.length);
      beforeinputCounts.push(log.beforeinput.length);

      // Full key-event sequence (commit ea4cb66): every printable char emits
      // keydown → char → keyUp, so the DOM sees one keydown AND one keyup per char.
      expect(log.keydown.length).toBe(charCount);
      expect(log.keyup.length).toBe(charCount);
      expect(log.input.length).toBe(charCount);

      const ks = log.keydown;
      if (ks.length > 0) onsets.push(ks[0].t - log.markT);
      for (let j = 1; j < ks.length; j++) interCharDelays.push(ks[j].t - ks[j - 1].t);
    }

    rows.push(stats("type_keydown_count", "count", keydownCounts, `expected == ${charCount}`));
    rows.push(stats("type_keyup_count", "count", keyupCounts, `expected == ${charCount}`));
    rows.push(stats("type_input_count", "count", inputCounts, `expected == ${charCount}`));
    rows.push(stats("type_beforeinput_count", "count", beforeinputCounts));
    rows.push(stats("type_onset_to_first_key", "ms", onsets, "reset → first keydown"));
    rows.push(stats("type_interchar_delay", "ms", interCharDelays, "between successive keydowns"));

    // Inter-char delay should sit in a wide band around the 30–80ms general profile.
    const meanDelay = interCharDelays.reduce((a, b) => a + b, 0) / Math.max(1, interCharDelays.length);
    expect(meanDelay).toBeGreaterThanOrEqual(10);
    expect(meanDelay).toBeLessThanOrEqual(200);
  }, 180_000);

  it("action spacing — gap between two consecutive clicks (no debounce by design)", async () => {
    const a = findByName("action a");
    const b = findByName("action b");
    const spacings: number[] = [];

    for (let i = 0; i < Math.min(N, 8); i++) {
      await resetRecorder();
      const r1 = await realisticClickKnownBox({ cdpUrl, box: a.box, expectedUrl: fixtureUrl });
      const r2 = await realisticClickKnownBox({ cdpUrl, box: b.box, expectedUrl: fixtureUrl });
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      const log = await readCadence();
      expect(log.click.length).toBeGreaterThanOrEqual(2);
      spacings.push(log.click.at(-1)!.t - log.click[0].t);
    }

    rows.push(
      stats(
        "action_spacing_two_clicks",
        "ms",
        spacings,
        "click→click; ≈ animation+settle time, no artificial delay",
      ),
    );
    const meanSpacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    expect(meanSpacing).toBeGreaterThan(0);
  }, 240_000);

  it("retry/stale observation — clean fixture triggers no retries", async () => {
    // The runtime click/type functions perform a SINGLE dispatch; retry/recovery
    // lives at the endpoint layer and is single-attempt, low-risk-gated, and
    // fail-closed (see ANTIGEN_INPUT_REALISM_AUDIT §3). On a clean controlled
    // fixture the ref is fresh and the click verifies, so 0 retries fire. We
    // record that explicitly rather than forcing a stale condition.
    const btn = findByName("action a");
    const r = await realisticClickKnownBox({ cdpUrl, box: btn.box, expectedUrl: fixtureUrl });
    expect(r.success).toBe(true);
    expect(r.stale_reason).toBeUndefined();
    rows.push(
      stats("retries_observed", "count", [0], "single-dispatch runtime layer; clean fixture; fail-closed ≤2 at endpoint"),
    );
  }, 60_000);
});
