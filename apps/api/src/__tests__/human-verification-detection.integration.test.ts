/**
 * Human Presence Relay v1 — REAL browser detection integration test.
 *
 * Launches a real headless Chromium (Playwright-bundled binary), loads the
 * three Human Presence Relay fixtures, and drives the ACTUAL extraction IIFE
 * and live presence probe against the live DOM:
 *
 *  - the Bath & Body Works-style "Press & Hold" interstitial classifies as a
 *    blocking human_verification surface (challenge_type press_and_hold) and
 *    the hold button carries the internal hv_control marker,
 *  - the "I'm not a robot" checkbox modal classifies checkbox_human with the
 *    checkbox as the control,
 *  - a structurally-identical PROMO modal ("We Missed You — 10% off") does NOT
 *    classify (strong-phrase guard),
 *  - buildHumanVerificationProbeExpr finds/loses the live control before/after
 *    the modal is removed,
 *  - a real mirrored hold (pressAtPoint → wait → releaseAtPoint) clears the
 *    fixture challenge; an early release does not.
 *
 * Gated behind Chromium availability so environments without the browser skip
 * cleanly (same harness as antigen-set-value-browser.integration.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";
import { chromium } from "playwright";

import type { HumanVerificationRequest } from "@aegis/types";
import {
  extractAntigenSnapshotCandidatesViaCDP,
  type AntigenSnapshotCandidate,
} from "../runtime/antigenSnapshotRuntime.js";
import {
  buildHumanVerificationProbeExpr,
  startHoldSession,
  heartbeatHoldSession,
  endHoldSession,
  clearHoldSessionsForTests,
} from "../runtime/humanPresenceRelay.js";
import { pressAtPoint, releaseAtPoint } from "../runtime/nativePointerRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";

const FIXTURE_HOLD = fileURLToPath(new URL("./fixtures/press-and-hold-modal.html", import.meta.url));
const FIXTURE_CHECKBOX = fileURLToPath(new URL("./fixtures/checkbox-human-modal.html", import.meta.url));
const FIXTURE_PROMO = fileURLToPath(new URL("./fixtures/promo-discount-modal.html", import.meta.url));

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

const EXE = chromiumExe();

/** Attach to the live page and run a callback with a send/evaluate channel. */
async function withPageSession<T>(
  cdpUrl: string,
  fn: (ctx: {
    send: (method: string, params: Record<string, unknown>) => void;
    evaluate: (expr: string) => Promise<unknown>;
  }) => Promise<T>,
): Promise<T> {
  const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 1;
    let sessionId: string | null = null;
    const pending = new Map<number, (v: Record<string, unknown> | undefined) => void>();
    const timer = setTimeout(() => { ws.close(); reject(new Error("page session timeout")); }, 20_000);
    const send = (method: string, params: Record<string, unknown>) => {
      const msgId = id++;
      ws.send(JSON.stringify({ id: msgId, method, sessionId, params }));
      return msgId;
    };
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown> | undefined>((res) => {
        const msgId = send(method, params);
        pending.set(msgId, res);
      });
    ws.on("open", () => ws.send(JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId: page.id, flatten: true } })));
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      const result = msg.result as Record<string, unknown> | undefined;
      if (result?.sessionId && !sessionId) {
        sessionId = result.sessionId as string;
        try {
          const out = await fn({
            send: (m, p) => void send(m, p),
            evaluate: async (expr) => {
              const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true });
              return (r?.result as Record<string, unknown> | undefined)?.value;
            },
          });
          clearTimeout(timer);
          ws.close();
          resolve(out);
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
        return;
      }
      const handler = pending.get(msg.id as number);
      if (handler) {
        pending.delete(msg.id as number);
        handler(result);
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function gotoFixture(cdpUrl: string, fixturePath: string): Promise<void> {
  await withPageSession(cdpUrl, async ({ evaluate }) => {
    await evaluate(`location.href = ${JSON.stringify(`file://${fixturePath}`)}`);
  });
  // Let the navigation + page scripts settle.
  await new Promise((res) => setTimeout(res, 500));
}

interface ProbeValue {
  present: boolean;
  challenge_type?: string;
  control_box?: { x: number; y: number; width: number; height: number } | null;
  vw: number;
  vh: number;
}

async function runProbe(cdpUrl: string): Promise<ProbeValue> {
  return (await withPageSession(cdpUrl, ({ evaluate }) => evaluate(buildHumanVerificationProbeExpr()))) as ProbeValue;
}

describe.skipIf(!EXE)("Human Presence Relay — real browser detection", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "antigen-hv-it-"));
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
        `file://${FIXTURE_HOLD}`,
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(cdpUrl);
    await new Promise((res) => setTimeout(res, 400));
  }, 30_000);

  afterAll(() => {
    try { proc?.kill("SIGKILL"); } catch { /* ignore */ }
    try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function snapshot(): Promise<AntigenSnapshotCandidate[]> {
    return extractAntigenSnapshotCandidatesViaCDP({ cdpUrl, viewportOnly: false });
  }

  it("classifies the press-and-hold interstitial as a blocking human_verification surface", async () => {
    await gotoFixture(cdpUrl, FIXTURE_HOLD);
    const cands = await snapshot();

    const holdBtn = cands.find((c) => /press\s*&\s*hold/i.test(c.name));
    expect(holdBtn).toBeDefined();
    expect(holdBtn!.overlay?.blocking).toBe(true);
    expect(holdBtn!.overlay?.human_verification).toBe(true);
    expect(holdBtn!.overlay?.hv_challenge_type).toBe("press_and_hold");
    expect(holdBtn!.overlay?.hv_control).toBe(true);
  }, 20_000);

  it("live probe finds the control, and loses it after the modal is removed", async () => {
    await gotoFixture(cdpUrl, FIXTURE_HOLD);

    const before = await runProbe(cdpUrl);
    expect(before.present).toBe(true);
    expect(before.challenge_type).toBe("press_and_hold");
    expect(before.control_box).toBeTruthy();
    expect(before.control_box!.width).toBeGreaterThan(0);

    await withPageSession(cdpUrl, async ({ evaluate }) => {
      await evaluate(`(function(){var b=document.getElementById('hv-backdrop'); if(b) b.parentNode.removeChild(b); return true;})()`);
    });

    const after = await runProbe(cdpUrl);
    expect(after.present).toBe(false);
  }, 20_000);

  it("a real mirrored hold clears the challenge; an early release does not", async () => {
    await gotoFixture(cdpUrl, FIXTURE_HOLD);
    const probe = await runProbe(cdpUrl);
    expect(probe.present).toBe(true);
    const box = probe.control_box!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Early release: press, release after 150ms — fixture requires >= 600ms.
    await withPageSession(cdpUrl, async ({ send }) => {
      await pressAtPoint(send, point, "fast", sleep);
      await sleep(150);
      releaseAtPoint(send, point);
    });
    await sleep(200);
    const stillThere = await runProbe(cdpUrl);
    expect(stillThere.present).toBe(true);

    // Live mirrored hold: press, hold 900ms, release — challenge clears.
    await withPageSession(cdpUrl, async ({ send }) => {
      await pressAtPoint(send, point, "fast", sleep);
      await sleep(900);
      releaseAtPoint(send, point);
    });
    await sleep(300);
    const cleared = await runProbe(cdpUrl);
    expect(cleared.present).toBe(false);
  }, 25_000);

  it("the REAL relay module mirrors a heartbeat-driven hold that clears the challenge", async () => {
    await gotoFixture(cdpUrl, FIXTURE_HOLD);

    const sessionId = "tbsess_hv_relay_it";
    taskBrowserSessions.set(sessionId, {
      browser_session_id: sessionId,
      user_id: "user_001",
      delegation_id: "del_hv_relay_it",
      status: "ready",
      cdp_url: cdpUrl,
      cdp_port: 0,
      user_data_dir: userDataDir,
      ephemeral: true,
      mode: "headless",
      debug_visible: false,
      runtime_mode: "local_runtime_endpoint",
      current_url: `file://${FIXTURE_HOLD}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    } as never);
    const request = {
      request_id: "hvr_relay_it_001",
      user_id: "user_001",
      delegation_id: "del_hv_relay_it",
      browser_session_id: sessionId,
      domain: "",
      page_url: `file://${FIXTURE_HOLD}`,
      challenge_type: "press_and_hold",
      status: "pending_user",
      instructions: "test",
      user_presence_required: true,
      purchase_authorized: false,
      hold_attempt_count: 0,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
    } as HumanVerificationRequest;

    try {
      // hold-start: live re-locate + realistic move + mousePressed.
      const started = await startHoldSession(request);
      expect(started).toEqual({ ok: true });

      // Live heartbeats keep the hold down past the fixture's 600ms requirement.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      for (let i = 0; i < 4; i++) {
        await sleep(250);
        expect(heartbeatHoldSession(request.request_id).holding).toBe(true);
      }

      // User releases → browser release → post-release probe shows it cleared.
      const end = await endHoldSession(request.request_id);
      expect(end.hold_state).toBe("released");
      expect(end.challenge_present).toBe(false);
    } finally {
      clearHoldSessionsForTests();
      taskBrowserSessions.delete(sessionId);
    }
  }, 30_000);

  it("classifies the not-a-robot checkbox modal as checkbox_human with the checkbox as control", async () => {
    await gotoFixture(cdpUrl, FIXTURE_CHECKBOX);
    const cands = await snapshot();

    const checkbox = cands.find((c) => c.tag === "input" && /not a robot/i.test(c.name));
    expect(checkbox).toBeDefined();
    expect(checkbox!.overlay?.human_verification).toBe(true);
    expect(checkbox!.overlay?.hv_challenge_type).toBe("checkbox_human");
    expect(checkbox!.overlay?.hv_control).toBe(true);

    const probe = await runProbe(cdpUrl);
    expect(probe.present).toBe(true);
    expect(probe.challenge_type).toBe("checkbox_human");
    expect(probe.control_box).toBeTruthy();
  }, 20_000);

  it("does NOT classify a structurally-identical promo modal (strong-phrase guard)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_PROMO);
    const cands = await snapshot();

    // The promo modal IS a blocking overlay…
    const shopBtn = cands.find((c) => /shop now/i.test(c.name));
    expect(shopBtn).toBeDefined();
    expect(shopBtn!.overlay?.blocking).toBe(true);
    // …but carries NO human-verification classification anywhere.
    for (const c of cands) {
      expect(c.overlay?.human_verification).toBeUndefined();
      expect(c.overlay?.hv_control).toBeUndefined();
    }

    const probe = await runProbe(cdpUrl);
    expect(probe.present).toBe(false);
  }, 20_000);
});
