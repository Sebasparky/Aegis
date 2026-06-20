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
import http from "node:http";
import WebSocket from "ws";
import { chromium } from "playwright";

import type { HumanVerificationRequest } from "@aegis/types";
import {
  extractAntigenSnapshotCandidatesViaCDP,
  extractAntigenSnapshotBundleViaCDP,
  detectPageHumanVerificationWallViaCDP,
  detectAmbiguousVisualObstructionViaCDP,
  classifyAmbiguousVisualObstruction,
  collectPageHvWallDebugViaCDP,
  type AntigenSnapshotCandidate,
  type ScreenHvWallSignals,
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
// Split-overlay fixtures: a TEXTLESS full-page dimmer + a SEPARATE foreground
// card — neither node alone is both blocking AND text-positive, so only the
// screen-level (flag-gated) detector classifies them.
const FIXTURE_SPLIT_HOLD = fileURLToPath(new URL("./fixtures/split-overlay-press-and-hold.html", import.meta.url));
const FIXTURE_SPLIT_PROMO = fileURLToPath(new URL("./fixtures/split-overlay-promo.html", import.meta.url));
// Page-level full-page denial wall (B&BW shape): challenge TEXT in the top
// document, the only control inside a SINGLE cross-origin iframe, zero
// top-document candidates. Plus two negatives that must NOT classify.
const FIXTURE_WALL_XORIGIN = fileURLToPath(new URL("./fixtures/denial-wall-cross-origin-iframe.html", import.meta.url));
const FIXTURE_DENIED_PLAIN = fileURLToPath(new URL("./fixtures/access-denied-plain.html", import.meta.url));
const FIXTURE_ECOMM_IFRAME = fileURLToPath(new URL("./fixtures/ecommerce-marketing-iframe.html", import.meta.url));
// Live B&BW OVERLAY-wall shape: a blocking wall over a STILL-PRESENT ecommerce
// background (20+ extractable refs). element_count is high, so the low-element
// fast path skips — the cheap hint must fire and the probe must still classify.
const FIXTURE_OVERLAY_WALL = fileURLToPath(new URL("./fixtures/overlay-wall-preserved-background.html", import.meta.url));
// OOPIF / cross-origin-iframe wall: the challenge text AND control render INSIDE
// the cross-origin iframe, so the top document has NO HV text. Only the
// text-INDEPENDENT OOPIF path (inaccessible iframe + OOPIF child target +
// blocking overlay) classifies it.
const FIXTURE_OOPIF_NO_TEXT = fileURLToPath(new URL("./fixtures/oopif-overlay-no-text-wall.html", import.meta.url));
// Geometry-only ambiguous obstruction: a DOM-TEXTLESS blocking overlay (centered
// card + full-viewport scrim) over an element-rich page — no HV text, no denial
// text, no iframe. Only the coarse layout-geometry signals detect it. Plus a
// healthy control page whose fixed top banner must trip NO geometry signal.
const FIXTURE_CENTERED_OVERLAY = fileURLToPath(new URL("./fixtures/centered-overlay-over-normal-page.html", import.meta.url));
const FIXTURE_STICKY_HEADER = fileURLToPath(new URL("./fixtures/sticky-header-healthy-page.html", import.meta.url));
const FIXTURE_HOMEPAGE_HERO = fileURLToPath(new URL("./fixtures/homepage-hero-no-scrim.html", import.meta.url));
// Same-origin / top-level "Press & Hold" wall over a PRESERVED high-element
// background (NO iframe, NO stale signal). Only screenHumanVerification()
// (scrim + strong HV phrase) classifies it — the iframe-required hint is false.
// Plus a high-element benign-hero page (no scrim / no HV phrase) that must NOT.
const FIXTURE_SCREEN_HV_PRODUCT = fileURLToPath(new URL("./fixtures/screen-hv-wall-over-product-page.html", import.meta.url));
const FIXTURE_SCREEN_HV_BENIGN = fileURLToPath(new URL("./fixtures/screen-hv-benign-hero-product-page.html", import.meta.url));
// Split-overlay "Press & Hold" walls whose card the OLD scanner could not read:
//   - …-zauto: the card has NO explicit z-index (relies on DOM order) — the old
//     `z-index >= 10` text gate skipped it.
//   - …-shadow: the card text/control live inside an OPEN shadow root (a bare
//     <div> control) — querySelectorAll never pierced it.
// Both have a detected scrim + centered modal; only the widened scan reads them.
const FIXTURE_SPLIT_HOLD_ZAUTO = fileURLToPath(new URL("./fixtures/split-overlay-press-and-hold-zauto.html", import.meta.url));
const FIXTURE_SPLIT_HOLD_SHADOW = fileURLToPath(new URL("./fixtures/split-overlay-press-and-hold-shadow.html", import.meta.url));

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
  // Tiny cross-site origin server (127.0.0.1) used to host a REAL OOPIF for the
  // cross-origin-iframe wall test. file:// parent + http://127.0.0.1 child are
  // cross-site, so under --site-per-process the iframe becomes an OOPIF child
  // target visible to CDP Target.getTargets.
  let challengeServer: http.Server;
  let challengeUrl: string;

  beforeAll(async () => {
    challengeServer = http.createServer((_req, res) => {
      // Minimal challenge body. No bearing on detection (text is never read from
      // the cross-origin iframe); it only needs to be a real cross-site document.
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>c</title><button id=h>hold</button>");
    });
    const serverPort = await freePort();
    await new Promise<void>((resolve) => challengeServer.listen(serverPort, "127.0.0.1", resolve));
    challengeUrl = `http://127.0.0.1:${serverPort}/challenge`;

    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "antigen-hv-it-"));
    proc = spawn(
      EXE!,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--headless=new",
        // Force OOPIFs for cross-site iframes so the OOPIF-wall test sees a real
        // child target (matches the live B&BW cross-origin-iframe shape).
        "--site-per-process",
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
    try { challengeServer?.close(); } catch { /* ignore */ }
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

  // ─── Screen-level (split-overlay) detection ──────────────────────────────
  // The dimmer and challenge card are SEPARATE siblings; this is the case the
  // per-container detector misses. The screen-level path is flag-gated
  // (ANTIGEN_HUMAN_VERIFICATION) and threaded into the extraction IIFE at build
  // time, so each test sets the env var before snapshotting and restores it.
  async function withHvFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.ANTIGEN_HUMAN_VERIFICATION;
    if (value === undefined) delete process.env.ANTIGEN_HUMAN_VERIFICATION;
    else process.env.ANTIGEN_HUMAN_VERIFICATION = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.ANTIGEN_HUMAN_VERIFICATION;
      else process.env.ANTIGEN_HUMAN_VERIFICATION = prev;
    }
  }

  it("classifies a SPLIT overlay (textless dimmer + separate card) as human_verification", async () => {
    await gotoFixture(cdpUrl, FIXTURE_SPLIT_HOLD);
    const cands = await withHvFlag("true", snapshot);

    // The Press & Hold control is the single blocking human_verification member,
    // even though its only overlay ancestor (the card) is not itself blocking.
    const holdBtn = cands.find((c) => /press\s*&\s*hold/i.test(c.name));
    expect(holdBtn).toBeDefined();
    expect(holdBtn!.overlay?.blocking).toBe(true);
    expect(holdBtn!.overlay?.human_verification).toBe(true);
    expect(holdBtn!.overlay?.hv_challenge_type).toBe("press_and_hold");
    expect(holdBtn!.overlay?.hv_control).toBe(true);

    // The background search input is NOT an overlay member — it is blocked
    // downstream via blocking_active, not by ad-hoc mutation here.
    const search = cands.find((c) => c.tag === "input" && /search/i.test(c.name));
    expect(search).toBeDefined();
    expect(search!.overlay?.human_verification).toBeUndefined();

    // Exactly one human_verification member is emitted (just the control).
    const hvMembers = cands.filter((c) => c.overlay?.human_verification === true);
    expect(hvMembers).toHaveLength(1);
  }, 20_000);

  it("does NOT classify a SPLIT promo overlay (We Missed You) even with the flag on", async () => {
    await gotoFixture(cdpUrl, FIXTURE_SPLIT_PROMO);
    const cands = await withHvFlag("true", snapshot);

    const shopBtn = cands.find((c) => /shop now/i.test(c.name));
    expect(shopBtn).toBeDefined();
    for (const c of cands) {
      expect(c.overlay?.human_verification).toBeUndefined();
      expect(c.overlay?.hv_control).toBeUndefined();
    }
  }, 20_000);

  it("flag OFF is byte-identical: the SPLIT overlay is not classified", async () => {
    await gotoFixture(cdpUrl, FIXTURE_SPLIT_HOLD);
    const cands = await withHvFlag("false", snapshot);

    const holdBtn = cands.find((c) => /press\s*&\s*hold/i.test(c.name));
    expect(holdBtn).toBeDefined();
    expect(holdBtn!.overlay?.human_verification).toBeUndefined();
    expect(holdBtn!.overlay?.hv_control).toBeUndefined();
    // No new blocking overlay member is invented when the flag is off.
    for (const c of cands) {
      expect(c.overlay?.human_verification).toBeUndefined();
    }
  }, 20_000);

  // ─── Page-level wall (cross-origin iframe) detection ─────────────────────
  // The control is inside a single cross-origin iframe → ZERO top-document
  // candidates. The page-level probe is the only path that classifies it.
  async function resolveTarget(): Promise<{ browserWsUrl: string; pageTarget: { id: string; url: string } }> {
    const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string; url: string }>;
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    return { browserWsUrl: version.webSocketDebuggerUrl, pageTarget: { id: page.id, url: page.url } };
  }

  async function detectWall() {
    return detectPageHumanVerificationWallViaCDP({ cdpUrl, resolvedTarget: await resolveTarget() });
  }

  it("classifies the cross-origin-iframe denial wall as a page-level human-verification surface", async () => {
    await gotoFixture(cdpUrl, FIXTURE_WALL_XORIGIN);
    // Zero top-document candidates — the element-based detectors find nothing.
    const cands = await withHvFlag("true", snapshot);
    expect(cands.filter((c) => c.overlay?.human_verification === true)).toHaveLength(0);

    const wall = await withHvFlag("true", detectWall);
    expect(wall).not.toBeNull();
    expect(wall!.human_verification).toBe(true);
    expect(wall!.page_level).toBe(true);
    expect(wall!.hv_challenge_type).toBe("press_and_hold");
    expect(wall!.user_presence_required).toBe(true);
    expect(wall!.blocking).toBe(true);
  }, 20_000);

  it("flag OFF: the page-level wall is not classified (byte-identical)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_WALL_XORIGIN);
    const wall = await withHvFlag("false", detectWall);
    expect(wall).toBeNull();
  }, 20_000);

  it("does NOT classify a generic 'access denied' page with no human/bot/press-hold language", async () => {
    await gotoFixture(cdpUrl, FIXTURE_DENIED_PLAIN);
    const wall = await withHvFlag("true", detectWall);
    expect(wall).toBeNull();
  }, 20_000);

  it("does NOT classify a normal ecommerce page with a marketing iframe", async () => {
    await gotoFixture(cdpUrl, FIXTURE_ECOMM_IFRAME);
    const wall = await withHvFlag("true", detectWall);
    expect(wall).toBeNull();
  }, 20_000);

  // ─── Overlay wall over a PRESERVED background (the live B&BW regression) ───
  async function bundleHint(): Promise<boolean | undefined> {
    const b = await extractAntigenSnapshotBundleViaCDP({
      cdpUrl,
      viewportOnly: false,
      resolvedTarget: await resolveTarget(),
    });
    return b.hvWallHint;
  }

  it("classifies an OVERLAY wall over a preserved background (many refs) as a page-level human-verification surface", async () => {
    await gotoFixture(cdpUrl, FIXTURE_OVERLAY_WALL);

    // The background DOM is fully present: 20+ extractable candidates remain, and
    // NONE is the press-and-hold control (it lives in the cross-origin iframe), so
    // the candidate/screen-level detectors find no human_verification member.
    const cands = await withHvFlag("true", snapshot);
    expect(cands.length).toBeGreaterThan(20);
    expect(cands.filter((c) => c.overlay?.human_verification === true)).toHaveLength(0);

    // The cheap in-bundle hint fires (strong HV text + an inaccessible iframe),
    // which is what gates the confirming probe when element_count is high.
    expect(await withHvFlag("true", bundleHint)).toBe(true);

    // The confirming probe classifies it despite the high background-control
    // count — the relaxed internal gate accepts a full-page blocker + wall text.
    const wall = await withHvFlag("true", detectWall);
    expect(wall).not.toBeNull();
    expect(wall!.human_verification).toBe(true);
    expect(wall!.page_level).toBe(true);
    expect(wall!.hv_challenge_type).toBe("press_and_hold");
    expect(wall!.user_presence_required).toBe(true);
    expect(wall!.blocking).toBe(true);
  }, 20_000);

  it("flag OFF: the overlay wall is not classified and emits no hint (byte-identical)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_OVERLAY_WALL);
    expect(await withHvFlag("false", detectWall)).toBeNull();
    expect(await withHvFlag("false", bundleHint)).toBeUndefined();
  }, 20_000);

  // ─── Same-origin / top-level screen-HV wall over a high-element page ───────
  // The visible "Press & Hold" wall has NO inaccessible iframe (so hvWallHint is
  // false) and sits over a preserved high-element background (so the low-element
  // probe is skipped). Only the iframe-independent screen-HV verdict classifies
  // it. This is the confirmed snapshot-200 miss.
  async function bundleScreenHv(): Promise<ScreenHvWallSignals | undefined> {
    const b = await extractAntigenSnapshotBundleViaCDP({
      cdpUrl,
      viewportOnly: false,
      resolvedTarget: await resolveTarget(),
    });
    return b.screenHv;
  }

  it("emits a screen-HV wall verdict on a same-origin Press & Hold wall over a high-element page (no iframe / no stale)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_SCREEN_HV_PRODUCT);

    // The background DOM is fully present (20+ refs) and NONE is the HV control
    // (the affordance is a painted, non-interactive div), so no per-candidate hv
    // member is emitted — the page-level screen verdict is the only signal.
    const cands = await withHvFlag("true", snapshot);
    expect(cands.length).toBeGreaterThan(20);
    expect(cands.filter((c) => c.overlay?.human_verification === true)).toHaveLength(0);

    // The iframe-required hint is FALSE (no inaccessible iframe present)…
    expect(await withHvFlag("true", bundleHint)).toBe(false);
    // …but the screen-HV verdict fires on scrim + strong HV phrase.
    const sv = await withHvFlag("true", bundleScreenHv);
    expect(sv).toBeDefined();
    expect(sv!.wall).toBe(true);
    expect(sv!.challenge_type).toBe("press_and_hold");
    expect(sv!.viewport_scrim_seen).toBe(true);
    expect(sv!.hv_phrase_seen).toBe(true);
    expect(sv!.press_hold_affordance_seen).toBe(true);
  }, 20_000);

  it("emits a screen-HV verdict when the challenge card has NO z-index (relies on DOM order)", async () => {
    // The card paints above the dimmer purely by source order; the old
    // `z-index >= 10` text gate skipped it, so the scrim + centered modal were
    // detected but hv_phrase_seen stayed false. The widened scan now reads it.
    await gotoFixture(cdpUrl, FIXTURE_SPLIT_HOLD_ZAUTO);
    const sv = await withHvFlag("true", bundleScreenHv);
    expect(sv).toBeDefined();
    expect(sv!.wall).toBe(true);
    expect(sv!.challenge_type).toBe("press_and_hold");
    expect(sv!.viewport_scrim_seen).toBe(true);
    expect(sv!.centered_modal_seen).toBe(true);
    expect(sv!.hv_phrase_seen).toBe(true);
    expect(sv!.press_hold_affordance_seen).toBe(true);
  }, 20_000);

  it("emits a screen-HV verdict when the challenge card lives in an OPEN shadow root (bare-div control)", async () => {
    // The card text + control are inside a shadow root that document-scoped
    // querySelectorAll never pierced; the one-level shadow-host enumeration in
    // the widened scan now harvests the strong phrase.
    await gotoFixture(cdpUrl, FIXTURE_SPLIT_HOLD_SHADOW);
    const sv = await withHvFlag("true", bundleScreenHv);
    expect(sv).toBeDefined();
    expect(sv!.wall).toBe(true);
    expect(sv!.challenge_type).toBe("press_and_hold");
    expect(sv!.viewport_scrim_seen).toBe(true);
    expect(sv!.centered_modal_seen).toBe(true);
    expect(sv!.hv_phrase_seen).toBe(true);
    expect(sv!.press_hold_affordance_seen).toBe(true);
  }, 20_000);

  it("flag OFF: the z-auto and shadow-DOM screen-HV walls emit no verdict (byte-identical)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_SPLIT_HOLD_ZAUTO);
    expect(await withHvFlag("false", bundleScreenHv)).toBeUndefined();
    await gotoFixture(cdpUrl, FIXTURE_SPLIT_HOLD_SHADOW);
    expect(await withHvFlag("false", bundleScreenHv)).toBeUndefined();
  }, 20_000);

  it("does NOT emit a screen-HV wall verdict on a high-element benign marketing hero (no scrim / no HV phrase)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_SCREEN_HV_BENIGN);
    const cands = await withHvFlag("true", snapshot);
    expect(cands.length).toBeGreaterThan(20);
    const sv = await withHvFlag("true", bundleScreenHv);
    expect(sv).toBeDefined();
    expect(sv!.wall).toBe(false);
    expect(sv!.viewport_scrim_seen).toBe(false);
    expect(sv!.hv_phrase_seen).toBe(false);
  }, 20_000);

  it("does NOT emit a screen-HV wall verdict on a scrim-only overlay with NO HV phrase (geometry preserved)", async () => {
    // centered-overlay-over-normal-page has a full scrim but no HV language; the
    // screen verdict must stay false (it keys on scrim AND phrase), leaving the
    // existing geometry/ambiguous handling untouched.
    await gotoFixture(cdpUrl, FIXTURE_CENTERED_OVERLAY);
    const sv = await withHvFlag("true", bundleScreenHv);
    expect(sv).toBeDefined();
    expect(sv!.wall).toBe(false);
    expect(sv!.hv_phrase_seen).toBe(false);
  }, 20_000);

  it("does NOT emit a screen-HV wall verdict on the homepage hero (no scrim)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_HOMEPAGE_HERO);
    const sv = await withHvFlag("true", bundleScreenHv);
    expect(sv).toBeDefined();
    expect(sv!.wall).toBe(false);
    expect(sv!.viewport_scrim_seen).toBe(false);
  }, 20_000);

  it("flag OFF: the screen-HV wall emits no verdict (byte-identical)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_SCREEN_HV_PRODUCT);
    expect(await withHvFlag("false", bundleScreenHv)).toBeUndefined();
  }, 20_000);

  // ─── OOPIF / cross-origin-iframe wall with NO top-document HV text ─────────
  // The live B&BW Press & Hold popup shape: text + control live inside the
  // cross-origin iframe, so the top document carries no HV language. The
  // text-independent OOPIF path is the only one that classifies it.
  it("classifies the OOPIF no-text wall as unknown_human_verification (text-independent path)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_OOPIF_NO_TEXT);
    // Point the host iframe at the cross-site origin so it becomes a REAL OOPIF
    // child target (the fixture ships about:blank as a static placeholder).
    await withPageSession(cdpUrl, async ({ evaluate }) => {
      await evaluate(
        `(function(){var f=document.querySelector('#hv-host iframe'); if(f){ f.removeAttribute('sandbox'); f.src=${JSON.stringify(challengeUrl)}; } return true;})()`,
      );
    });
    // Allow the cross-site document to load and the OOPIF child target to spawn.
    await new Promise((res) => setTimeout(res, 800));

    // No candidate/screen-level hv member (the control is in the cross-origin iframe).
    const cands = await withHvFlag("true", snapshot);
    expect(cands.filter((c) => c.overlay?.human_verification === true)).toHaveLength(0);

    // The cheap hint fires via the OOPIF shape (inaccessible iframe + blocking
    // overlay), independent of any top-document text.
    expect(await withHvFlag("true", bundleHint)).toBe(true);

    const wall = await withHvFlag("true", detectWall);
    expect(wall).not.toBeNull();
    expect(wall!.human_verification).toBe(true);
    expect(wall!.page_level).toBe(true);
    // Never asserts press_and_hold — the challenge text is unreadable.
    expect(wall!.hv_challenge_type).toBe("unknown_human_verification");
    expect(wall!.user_presence_required).toBe(true);
    expect(wall!.blocking).toBe(true);
  }, 20_000);

  it("flag OFF: the OOPIF no-text wall is not classified and emits no hint (byte-identical)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_OOPIF_NO_TEXT);
    expect(await withHvFlag("false", detectWall)).toBeNull();
    expect(await withHvFlag("false", bundleHint)).toBeUndefined();
  }, 20_000);

  it("does NOT classify a visible-iframe page with no blocking overlay (negative)", async () => {
    // ecommerce-marketing-iframe has a visible (possibly cross-origin) iframe but
    // NO fixed full-coverage backdrop / click-intercept, so neither the text path
    // nor the OOPIF path classifies it — even with the flag on.
    await gotoFixture(cdpUrl, FIXTURE_ECOMM_IFRAME);
    expect(await withHvFlag("true", detectWall)).toBeNull();
  }, 20_000);

  // ─── HV debug telemetry signals against a REAL wall (ANTIGEN_HV_DEBUG path) ──
  // Validates that the dev-only debug probe reports correct value-free signals so
  // a live B&BW run can pinpoint which condition fails. Positive (overlay wall)
  // and negative (plain access-denied) fixtures exercise both outcomes.
  async function debugProbe() {
    return collectPageHvWallDebugViaCDP({ resolvedTarget: await resolveTarget() });
  }

  it("debug probe reports HV text + inaccessible iframe + would_classify on the overlay wall", async () => {
    await gotoFixture(cdpUrl, FIXTURE_OVERLAY_WALL);
    const dbg = await withHvFlag("true", debugProbe);
    expect(dbg.result).toBe("positive");
    if (dbg.result === "error") throw new Error("expected signals");
    expect(dbg.signals.top_doc_text_flags.hv_text_seen).toBe(true);
    expect(dbg.signals.top_doc_text_flags.press_hold_seen).toBe(true);
    expect(dbg.signals.iframe_flags.visible_iframe_seen).toBe(true);
    expect(dbg.signals.iframe_flags.inaccessible_iframe_seen).toBe(true);
    expect(dbg.signals.iframe_flags.iframe_count_bucket).not.toBe("zero");
    expect(dbg.signals.would_classify).toBe(true);
  }, 20_000);

  it("debug probe reports would_classify=false on a plain access-denied page (no HV language)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_DENIED_PLAIN);
    const dbg = await withHvFlag("true", debugProbe);
    expect(dbg.result).toBe("null");
    if (dbg.result === "error") throw new Error("expected signals");
    expect(dbg.signals.top_doc_text_flags.hv_text_seen).toBe(false);
    expect(dbg.signals.would_classify).toBe(false);
  }, 20_000);

  // ─── Geometry-based ambiguous visual obstruction (DOM-textless overlay) ────
  // The live B&BW shape where the press-and-hold modal renders VISUALLY but its
  // text is NOT in the accessible DOM. The raw probe is not flag-gated (its caller
  // gates on the VGC flag), so it is driven directly here. Every returned field is
  // a boolean — no rects, coordinates, selectors, or text.
  const AMBIGUOUS_KEYS = [
    // Legacy ambiguous-obstruction signals (drive classifyAmbiguousVisualObstruction).
    "denial_text_seen",
    "large_centered_overlay_seen",
    "near_zero_interactive",
    "pointer_interceptor_seen",
    "top_layer_dialog_seen",
    "viewport_scrim_seen",
    "visible_inaccessible_iframe_seen",
    // Surface-Boundary Router SHADOW signals (observational only; never gate anything).
    "background_refs_available_behind_surface",
    "normal_page_dom_present_behind_surface",
    "off_path_iframe_seen",
    "opaque_dominant_surface_seen",
    "opaque_iframe_seen",
    "surface_blocks_viewport_center",
    "surface_over_main_content",
    "surface_text_inspectable",
    "surface_text_uninspectable",
    "visible_cross_origin_iframe_seen",
    "visual_dom_contradiction_seen",
  ].sort();

  async function detectAmbiguous() {
    return detectAmbiguousVisualObstructionViaCDP({ cdpUrl, resolvedTarget: await resolveTarget() });
  }

  it("detects a centered overlay + scrim over a normal page via geometry signals (no HV/denial text, no iframe)", async () => {
    await gotoFixture(cdpUrl, FIXTURE_CENTERED_OVERLAY);
    const probe = await detectAmbiguous();
    expect(probe).not.toBeNull();

    // Geometry obstruction signals fire from layout alone…
    expect(probe!.large_centered_overlay_seen).toBe(true);
    expect(probe!.viewport_scrim_seen).toBe(true);
    expect(probe!.pointer_interceptor_seen).toBe(true);
    // …with NO text/iframe signal (the overlay copy is intentionally neutral, and
    // the page is element-rich, so the legacy ambiguous signals all stay false).
    expect(probe!.denial_text_seen).toBe(false);
    expect(probe!.visible_inaccessible_iframe_seen).toBe(false);
    expect(probe!.near_zero_interactive).toBe(false);
    // Shadow surface-boundary signals: a same-origin scrim+overlay is NOT opaque —
    // the future router must not misroute a readable overlay to the visual classifier.
    expect(probe!.opaque_iframe_seen).toBe(false);
    expect(probe!.off_path_iframe_seen).toBe(false);
    expect(probe!.surface_text_inspectable).toBe(true);

    // Result is booleans ONLY — never raw geometry, selectors, text, or coordinates.
    expect(Object.keys(probe!).sort()).toEqual(AMBIGUOUS_KEYS);
    for (const v of Object.values(probe!)) expect(typeof v).toBe("boolean");
  }, 20_000);

  it("returns all-false geometry obstruction signals for a healthy page with only a fixed top banner", async () => {
    await gotoFixture(cdpUrl, FIXTURE_STICKY_HEADER);
    const probe = await detectAmbiguous();
    expect(probe).not.toBeNull();

    // A fixed/sticky header is the classic false-positive — every geometry signal
    // must stay false (top-anchored, low coverage, never intercepts the center).
    expect(probe!.large_centered_overlay_seen).toBe(false);
    expect(probe!.viewport_scrim_seen).toBe(false);
    expect(probe!.pointer_interceptor_seen).toBe(false);
    expect(probe!.top_layer_dialog_seen).toBe(false);
    // And no text/iframe obstruction either.
    expect(probe!.denial_text_seen).toBe(false);
    expect(probe!.visible_inaccessible_iframe_seen).toBe(false);
    expect(probe!.near_zero_interactive).toBe(false);

    expect(Object.keys(probe!).sort()).toEqual(AMBIGUOUS_KEYS);
    for (const v of Object.values(probe!)) expect(typeof v).toBe("boolean");
  }, 20_000);

  it("a benign large fixed marketing hero (no scrim/iframe) trips the geometry signals but does NOT classify as an obstruction", async () => {
    // The live B&BW homepage/search false positive: a large, centered, FIXED hero
    // occludes the sampled center points, so it trips large_centered_overlay_seen and
    // pointer_interceptor_seen exactly like a real card wall — but there is NO dimmer
    // scrim and NO opaque iframe, so the classifier must NOT fire.
    await gotoFixture(cdpUrl, FIXTURE_HOMEPAGE_HERO);
    const probe = await detectAmbiguous();
    expect(probe).not.toBeNull();

    // Geometry fires from the hero's layout…
    expect(probe!.large_centered_overlay_seen).toBe(true);
    expect(probe!.pointer_interceptor_seen).toBe(true);
    // …but the obstruction markers that distinguish a real wall are all absent.
    expect(probe!.viewport_scrim_seen).toBe(false);
    expect(probe!.visible_inaccessible_iframe_seen).toBe(false);
    expect(probe!.denial_text_seen).toBe(false);
    expect(probe!.near_zero_interactive).toBe(false);
    expect(probe!.top_layer_dialog_seen).toBe(false);

    // Classifier must NOT fire even with the action no-progress corroborator set.
    expect(classifyAmbiguousVisualObstruction({ ...probe!, repeated_stale: true })).toBe(false);

    expect(Object.keys(probe!).sort()).toEqual(AMBIGUOUS_KEYS);
    for (const v of Object.values(probe!)) expect(typeof v).toBe("boolean");
  }, 20_000);

  it("a real centered overlay WITH a scrim DOES classify as an obstruction (regression guard for the discriminator)", async () => {
    // Counterpart to the benign-hero case: the same large centered overlay shape, but
    // OVER A FULL-VIEWPORT DIMMER, must still classify as a wall via the scrim marker.
    await gotoFixture(cdpUrl, FIXTURE_CENTERED_OVERLAY);
    const probe = await detectAmbiguous();
    expect(probe).not.toBeNull();
    expect(probe!.viewport_scrim_seen).toBe(true);
    expect(classifyAmbiguousVisualObstruction({ ...probe!, repeated_stale: true })).toBe(true);
  }, 20_000);
});
