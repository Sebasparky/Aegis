/**
 * Visual Gesture Capsule (VGC) — controlled REAL-SESSION fixture test (M2D).
 *
 * Every other VGC test mocks the browser boundary: the M1I e2e and the M1D route
 * tests module-mock capture/relay/recheck, and the M2C smoke uses capsules with
 * NO live task browser session (so gesture/recheck/recapture correctly return
 * BROWSER_SESSION_UNAVAILABLE). None of them exercise the real derivation path:
 *
 *   capsule.browser_session_id → getTaskBrowserSessionCdpUrl → real cdp_url
 *     → real capture / relay / recheck helpers → real CDP
 *
 * This slice closes that gap. It launches a real headless Chromium, registers a
 * real TaskBrowserSession whose cdp_url points at it, loads CONTROLLED LOCAL
 * fixtures (no Bath & Body Works, no third-party site, no provider logic, no
 * OCR/vision, no postMessage/token handling), and drives the internal VGC
 * endpoints exactly as the UI would — with NO cdp_url in the gesture/recheck/
 * recapture bodies. NO VGC helper is mocked.
 *
 * It proves:
 *   1. The real page-level HV detector (the function the agent browser-click path
 *      calls) classifies a controlled cross-origin-iframe wall as page_level.
 *   2. A capsule minted from a real session carries browser_session_id INTERNALLY
 *      while the safe view / every endpoint response excludes it.
 *   3. /gesture, /recheck, /recapture work WITHOUT a body cdp_url because the
 *      backend derives it server-side — never BROWSER_SESSION_UNAVAILABLE.
 *   4. The real presence probe drives still_present → cleared deterministically
 *      from controlled page state (modal present, then removed).
 *   5. Screenshot bytes appear ONLY in GET /:id/screenshot; no response leaks
 *      cdp_url, browser_session_id, target_id, expected_url, viewport dims,
 *      coordinates, path, strategy, or bytes.
 *
 * GATED: skipped by default. Runs only when Chromium is available AND
 * ANTIGEN_VGC_REAL_SESSION_TEST=true. Harness mirrors
 * human-verification-detection.integration.test.ts.
 *
 *   ANTIGEN_VISUAL_GESTURE_CAPSULE=true ANTIGEN_VGC_REAL_SESSION_TEST=true \
 *     npx vitest run visual-gesture-capsule-real-session
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";
import { chromium } from "playwright";

import type { TaskBrowserSession } from "@aegis/types";
import { visualGestureCapsuleRoutes } from "../routes/visual-gesture-capsules.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { detectPageHumanVerificationWallViaCDP } from "../runtime/antigenSnapshotRuntime.js";
import { createVisualGestureCapsuleForOpaqueHv } from "../runtime/visualGestureCapsuleOrchestrator.js";
import {
  getVisualGestureCapsule,
  getActiveVisualGestureCapsuleForBrowserSession,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";

// ─── controlled local fixtures (reused; no B&BW, no provider branding) ────────
// Page-level wall: challenge text in the top document, control in a single
// inaccessible (sandboxed, opaque-origin) iframe → the real page-level probe
// classifies it; zero top-document candidates.
const FIXTURE_WALL = fileURLToPath(
  new URL("./fixtures/denial-wall-cross-origin-iframe.html", import.meta.url),
);
// Recheck-deterministic control: the real buildHumanVerificationProbeExpr probe
// reports present:true while #hv-backdrop is in the DOM and present:false once it
// is removed (proven in human-verification-detection.integration.test.ts).
const FIXTURE_MODAL = fileURLToPath(
  new URL("./fixtures/press-and-hold-modal.html", import.meta.url),
);
// Tap-clears control: clears on a single click of #hv-tap-btn (no hold). Proves a
// `tap` gesture clears a tap wall while a `tap` does NOT satisfy a press-hold wall.
const FIXTURE_TAP = fileURLToPath(new URL("./fixtures/tap-wall.html", import.meta.url));

const SESSION_ID = "tbsess_vgc_realsession_m2d";

// ─── gate ─────────────────────────────────────────────────────────────────────
function chromiumExe(): string | null {
  try {
    const p = chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const EXE = chromiumExe();
const GATE_ON = process.env.ANTIGEN_VGC_REAL_SESSION_TEST === "true";

// ─── tiny CDP harness (copied from the HV detection integration test) ─────────
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

/** Attach to the live page and run a callback with a send/evaluate channel. */
async function withPageSession<T>(
  cdpUrl: string,
  fn: (ctx: { evaluate: (expr: string) => Promise<unknown> }) => Promise<T>,
): Promise<T> {
  const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{
    id: string;
    type: string;
  }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 1;
    let sessionId: string | null = null;
    const pending = new Map<number, (v: Record<string, unknown> | undefined) => void>();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("page session timeout"));
    }, 20_000);
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
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          id: id++,
          method: "Target.attachToTarget",
          params: { targetId: page.id, flatten: true },
        }),
      ),
    );
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      const result = msg.result as Record<string, unknown> | undefined;
      if (result?.sessionId && !sessionId) {
        sessionId = result.sessionId as string;
        try {
          const out = await fn({
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
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function gotoFixture(cdpUrl: string, fixturePath: string): Promise<void> {
  await withPageSession(cdpUrl, async ({ evaluate }) => {
    await evaluate(`location.href = ${JSON.stringify(`file://${fixturePath}`)}`);
  });
  // Let navigation + page scripts settle.
  await new Promise((res) => setTimeout(res, 500));
}

async function resolveTarget(
  cdpUrl: string,
): Promise<{ browserWsUrl: string; pageTarget: { id: string; url: string } }> {
  const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{
    id: string;
    type: string;
    url: string;
  }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return { browserWsUrl: version.webSocketDebuggerUrl, pageTarget: { id: page.id, url: page.url } };
}

// ─── non-leakage assertions (parsed-JSON keys + distinctive raw tokens) ───────
// Checked as parsed-JSON KEYS so short/ambiguous tokens (fx/fy/cssX/cssY/path)
// can't false-positive on unrelated substrings or bare numbers.
const FORBIDDEN_KEYS = [
  "png_base64",
  "viewport_css_width",
  "viewport_css_height",
  "cssX",
  "cssY",
  "fx",
  "fy",
  "cdp_url",
  "cdpUrl",
  "browser_session_id",
  "target_id",
  "targetId",
  "expected_url",
  "control_box",
  "strategy",
  "path",
  "duration_ms",
];

function collectKeys(value: unknown, acc: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}

/**
 * Assert a parsed response leaks neither bytes nor browser internals. NOT for the
 * screenshot endpoint, which is intentionally byte-bearing. `rawBody` is the
 * serialized response; `pngBytes` (when known) is the live screenshot string,
 * which must never appear outside GET /:id/screenshot.
 */
function assertNoLeak(body: unknown, rawBody: string, pngBytes?: string): void {
  const keys = collectKeys(body);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys.has(forbidden), `unexpected key "${forbidden}" in response`).toBe(false);
  }
  // Distinctive, unambiguous tokens that must never be embedded anywhere.
  expect(rawBody).not.toContain(SESSION_ID);
  expect(rawBody).not.toContain(CDP_URL);
  expect(rawBody).not.toContain("data:image");
  if (pngBytes) expect(rawBody).not.toContain(pngBytes);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ─── shared real-browser + server state ───────────────────────────────────────
let proc: ChildProcess;
let userDataDir: string;
let CDP_URL = "";
let server: FastifyInstance;
const prevEnv: Record<string, string | undefined> = {};

describe.skipIf(!EXE || !GATE_ON)("VGC — real browser session fixture (M2D)", () => {
  beforeAll(async () => {
    prevEnv.ANTIGEN_VISUAL_GESTURE_CAPSULE = process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    prevEnv.ANTIGEN_HUMAN_VERIFICATION = process.env.ANTIGEN_HUMAN_VERIFICATION;
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HUMAN_VERIFICATION = "true";

    const port = await freePort();
    CDP_URL = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "antigen-vgc-realsession-"));
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
        "--window-size=1280,800",
        `file://${FIXTURE_WALL}`,
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(CDP_URL);
    await new Promise((res) => setTimeout(res, 400));

    // Register a REAL task browser session pointing at the spawned browser. This
    // is the only seam getTaskBrowserSessionCdpUrl reads; the endpoints derive
    // cdp_url from it. Fully typed — no `as any`.
    const session: TaskBrowserSession = {
      browser_session_id: SESSION_ID,
      user_id: "user_001",
      delegation_id: "del_vgc_realsession_m2d",
      status: "ready",
      cdp_url: CDP_URL,
      cdp_port: port,
      user_data_dir: userDataDir,
      ephemeral: true,
      mode: "headless",
      debug_visible: false,
      runtime_mode: "local_runtime_endpoint",
      current_url: `file://${FIXTURE_WALL}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    taskBrowserSessions.set(SESSION_ID, session);

    server = Fastify({ logger: false });
    await server.register(visualGestureCapsuleRoutes);
    await server.ready();
  }, 30_000);

  afterAll(async () => {
    try {
      await server?.close();
    } catch {
      /* ignore */
    }
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
    clearVisualGestureCapsulesForTests();
    taskBrowserSessions.delete(SESSION_ID);
    if (prevEnv.ANTIGEN_VISUAL_GESTURE_CAPSULE === undefined)
      delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    else process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = prevEnv.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    if (prevEnv.ANTIGEN_HUMAN_VERIFICATION === undefined)
      delete process.env.ANTIGEN_HUMAN_VERIFICATION;
    else process.env.ANTIGEN_HUMAN_VERIFICATION = prevEnv.ANTIGEN_HUMAN_VERIFICATION;
  });

  // ─── endpoint inject helpers (internal routes — no auth, no body cdp_url) ───
  const ROOT = "/api/internal/visual-gesture-capsules";
  const listCapsules = () => server.inject({ method: "GET", url: ROOT });
  const getScreenshot = (id: string) =>
    server.inject({ method: "GET", url: `${ROOT}/${id}/screenshot` });
  // Bodies intentionally omit cdp_url — the backend must derive it server-side.
  const postGesture = (id: string, gesture: unknown) =>
    server.inject({ method: "POST", url: `${ROOT}/${id}/gesture`, payload: { gesture } });
  const postRecheck = (id: string) =>
    server.inject({ method: "POST", url: `${ROOT}/${id}/recheck`, payload: {} });
  const postRecapture = (id: string) =>
    server.inject({ method: "POST", url: `${ROOT}/${id}/recapture`, payload: {} });

  // Capsules are session-bound; clear between tests so each mints its own and the
  // active-for-session guard never sees a leftover from a prior test.
  afterEach(() => {
    clearVisualGestureCapsulesForTests();
  });

  // Normalized center fraction of an element — exactly what a user pointing at the
  // control in the redacted screenshot would produce. Test-side only (the relay
  // never receives a fraction the agent could see).
  async function buttonFraction(elementId: string): Promise<{ fx: number; fy: number }> {
    const out = (await withPageSession(CDP_URL, async ({ evaluate }) =>
      evaluate(
        `(function(){var e=document.getElementById(${JSON.stringify(elementId)});` +
          `var r=e.getBoundingClientRect();` +
          `return {fx:(r.left+r.width/2)/window.innerWidth, fy:(r.top+r.height/2)/window.innerHeight};})()`,
      ),
    )) as { fx: number; fy: number };
    return out;
  }

  async function readClearedFlag(): Promise<boolean> {
    const v = await withPageSession(CDP_URL, async ({ evaluate }) =>
      evaluate(`(function(){return window.__hv_cleared===true;})()`),
    );
    return v === true;
  }

  async function mintCapsule(pageUrl: string): Promise<string> {
    const created = await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: `hvr_${Date.now()}`,
      browserSessionId: SESSION_ID,
      domain: "localhost",
      cdpUrl: CDP_URL,
      pageUrl,
      userId: "user_001",
      delegationId: "del_vgc_realsession_m2d",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("capsule creation failed");
    expect(created.screenshot_available).toBe(true);
    return created.capsule.capsule_id;
  }

  it("a real user press-hold clears a real press-hold wall, recheck goes terminal, agent resumes", async () => {
    await gotoFixture(CDP_URL, FIXTURE_MODAL);
    const capsuleId = await mintCapsule(`file://${FIXTURE_MODAL}`);
    const { fx, fy } = await buttonFraction("hv-hold-btn");

    // 800ms hold clears the fixture's >=600ms threshold. Backend derives cdp_url.
    const res = await postGesture(capsuleId, { kind: "press_hold", fx, fy, duration_ms: 800 });
    expect(res.statusCode).toBe(200);
    expect(res.json().gesture_relayed).toBe(true);
    assertNoLeak(res.json(), res.body);

    // The REAL pointerup landed: the fixture cleared itself.
    expect(await readClearedFlag()).toBe(true);

    // Recheck → REAL probe → wall absent → terminal cleared.
    const recheck = await postRecheck(capsuleId);
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json().recheck).toBe("cleared");
    expect(recheck.json().status).toBe("cleared");
    assertNoLeak(recheck.json(), recheck.body);

    // Agent-resume precondition: no active capsule for the session (the guard that
    // returns 409 HUMAN_VERIFICATION_REQUIRED now finds nothing → next snapshot 200).
    expect(getActiveVisualGestureCapsuleForBrowserSession(SESSION_ID)).toBeUndefined();
    const list = (await listCapsules()).json();
    expect(list.data.find((c: any) => c.capsule_id === capsuleId)).toBeUndefined();
  }, 40_000);

  it("a too-short hold does NOT clear the wall; capsule stays active and the agent stays blocked", async () => {
    await gotoFixture(CDP_URL, FIXTURE_MODAL);
    const capsuleId = await mintCapsule(`file://${FIXTURE_MODAL}`);
    const { fx, fy } = await buttonFraction("hv-hold-btn");

    // 350ms >= HOLD_MIN (300) but < the fixture's 600ms requirement.
    const res = await postGesture(capsuleId, { kind: "press_hold", fx, fy, duration_ms: 350 });
    expect(res.statusCode).toBe(200);
    expect(await readClearedFlag()).toBe(false);

    const recheck = await postRecheck(capsuleId);
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json().recheck).toBe("still_present");
    assertNoLeak(recheck.json(), recheck.body);

    // Still active → the agent stays blocked.
    expect(getActiveVisualGestureCapsuleForBrowserSession(SESSION_ID)?.capsule_id).toBe(capsuleId);
  }, 40_000);

  it("tap clears a tap wall, but a tap does NOT clear a press-hold wall", async () => {
    // Tap clears the tap fixture.
    await gotoFixture(CDP_URL, FIXTURE_TAP);
    const tapCapsule = await mintCapsule(`file://${FIXTURE_TAP}`);
    const tapBtn = await buttonFraction("hv-tap-btn");
    const tapRes = await postGesture(tapCapsule, { kind: "tap", fx: tapBtn.fx, fy: tapBtn.fy });
    expect(tapRes.statusCode).toBe(200);
    expect(await readClearedFlag()).toBe(true);
    expect((await postRecheck(tapCapsule)).json().recheck).toBe("cleared");
    clearVisualGestureCapsulesForTests();

    // The same tap does NOT satisfy a press-hold wall.
    await gotoFixture(CDP_URL, FIXTURE_MODAL);
    const holdCapsule = await mintCapsule(`file://${FIXTURE_MODAL}`);
    const holdBtn = await buttonFraction("hv-hold-btn");
    const holdRes = await postGesture(holdCapsule, { kind: "tap", fx: holdBtn.fx, fy: holdBtn.fy });
    expect(holdRes.statusCode).toBe(200);
    expect(await readClearedFlag()).toBe(false);
    expect((await postRecheck(holdCapsule)).json().recheck).toBe("still_present");
  }, 60_000);

  it("the real page-level HV detector classifies the controlled cross-origin-iframe wall", async () => {
    await gotoFixture(CDP_URL, FIXTURE_WALL);

    // This is the exact function the agent browser-click path invokes when it
    // suspects an opaque wall. No mocks: real CDP against the controlled fixture.
    const wall = await detectPageHumanVerificationWallViaCDP({
      cdpUrl: CDP_URL,
      resolvedTarget: await resolveTarget(CDP_URL),
    });
    expect(wall).not.toBeNull();
    expect(wall!.page_level).toBe(true);
    expect(wall!.human_verification).toBe(true);
    expect(wall!.blocking).toBe(true);
    expect(wall!.user_presence_required).toBe(true);
    expect(wall!.hv_challenge_type).toBe("press_and_hold");
  }, 25_000);

  it("mints a capsule from the real session and drives the full UI loop via derived cdp_url", async () => {
    // Drive the recheck-deterministic control page. The real presence probe finds
    // the modal (present) until we remove it (absent) — controlled, but real.
    await gotoFixture(CDP_URL, FIXTURE_MODAL);

    // 1. Mint via the REAL orchestrator: real captureVisualGestureCapsuleScreenshotFrame
    //    runs against the real browser and stores a real redacted PNG frame. The
    //    capsule is bound to the real browser_session_id.
    const created = await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: "hvr_vgc_realsession_m2d",
      browserSessionId: SESSION_ID,
      domain: "localhost",
      cdpUrl: CDP_URL,
      pageUrl: `file://${FIXTURE_MODAL}`,
      userId: "user_001",
      delegationId: "del_vgc_realsession_m2d",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("capsule creation failed");
    expect(created.screenshot_available).toBe(true);
    const capsuleId = created.capsule.capsule_id;
    expect(capsuleId).toMatch(/^vgc_/);

    // browser_session_id is held INTERNALLY but excluded from the safe view.
    const raw = getVisualGestureCapsule(capsuleId);
    expect(raw?.browser_session_id).toBe(SESSION_ID);
    expect(created.capsule).not.toHaveProperty("browser_session_id");
    expect(JSON.stringify(created.capsule)).not.toContain(SESSION_ID);

    // 2. List shows the capsule with availability, no browser internals.
    const listRes = await listCapsules();
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    const listed = listBody.data.find((c: any) => c.capsule_id === capsuleId);
    expect(listed).toBeDefined();
    expect(listed.screenshot_available).toBe(true);
    assertNoLeak(listBody, listRes.body);

    // 3. Screenshot — the ONLY byte-bearing endpoint; bytes are a real PNG.
    const shotRes = await getScreenshot(capsuleId);
    expect(shotRes.statusCode).toBe(200);
    const shotBody = shotRes.json();
    expect(shotBody.mime_type).toBe("image/png");
    expect(typeof shotBody.png_base64).toBe("string");
    expect(shotBody.png_base64.length).toBeGreaterThan(0);
    const pngBytes: string = shotBody.png_base64;
    const decoded = Buffer.from(pngBytes, "base64");
    expect(decoded.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    // 4. Gesture WITHOUT body cdp_url → backend derives it from the session and a
    //    REAL CDP pointer event is dispatched. A tap cannot satisfy the modal's
    //    >=600ms hold, so the wall persists for the recheck below. No leak, and
    //    crucially NOT BROWSER_SESSION_UNAVAILABLE.
    const gestureRes = await postGesture(capsuleId, { kind: "tap", fx: 0.5, fy: 0.5 });
    expect(gestureRes.statusCode).toBe(200);
    const gestureBody = gestureRes.json();
    expect(gestureBody.gesture_relayed).toBe(true);
    expect(gestureBody.status).toBe("checking");
    assertNoLeak(gestureBody, gestureRes.body, pngBytes);

    // 5. Recapture WITHOUT body cdp_url → derives + real capture; metadata only.
    const recapRes = await postRecapture(capsuleId);
    expect(recapRes.statusCode).toBe(200);
    const recapBody = recapRes.json();
    expect(recapBody.screenshot_available).toBe(true);
    assertNoLeak(recapBody, recapRes.body, pngBytes);
    // Fresh bytes still flow only from the screenshot endpoint.
    const shot2 = await getScreenshot(capsuleId);
    expect(shot2.statusCode).toBe(200);
    expect(
      Buffer.from(shot2.json().png_base64, "base64").subarray(0, 8).equals(PNG_SIGNATURE),
    ).toBe(true);

    // 6. Recheck WITHOUT body cdp_url, modal still present → REAL probe → still_present.
    const r1 = await postRecheck(capsuleId);
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.recheck).toBe("still_present");
    expect(b1.status).toBe("rejected_retryable");
    expect(b1.attempt_count).toBe(1);
    assertNoLeak(b1, r1.body, pngBytes);

    // 7. Remove the wall via a real CDP eval, then recheck → REAL probe → cleared.
    await withPageSession(CDP_URL, async ({ evaluate }) => {
      await evaluate(
        `(function(){var b=document.getElementById('hv-backdrop'); if(b&&b.parentNode){b.parentNode.removeChild(b);} return true;})()`,
      );
    });
    await new Promise((res) => setTimeout(res, 200));

    const r2 = await postRecheck(capsuleId);
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();
    expect(b2.recheck).toBe("cleared");
    expect(b2.status).toBe("cleared");
    assertNoLeak(b2, r2.body, pngBytes);

    // 8. Cleared is terminal → excluded from the active list.
    const finalList = (await listCapsules()).json();
    expect(finalList.data.find((c: any) => c.capsule_id === capsuleId)).toBeUndefined();
  }, 40_000);
});
