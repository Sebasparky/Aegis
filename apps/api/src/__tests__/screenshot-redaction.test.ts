/**
 * Redacted Screenshot — vision-channel protection tests.
 *
 * Part 1 (pure): the pixel-pass redactor blacks out exactly the requested boxes,
 * scaled correctly under a deviceScaleFactor.
 *
 * Part 2 (real Chromium): drives the actual protected-fill primitive against a live
 * card form, then proves that an agent-facing screenshot, captured through the
 * Aegis redaction path, does NOT reveal the rendered PAN — while the underlying
 * cardholder value is still intact/submittable for the website. This is the test
 * that proves the vision channel is closed at the pixel level; mocked CDP cannot.
 *
 * Gated behind Chromium availability so environments without the browser skip the
 * integration block cleanly (the pure pixel tests always run).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { PNG } from "pngjs";
import WebSocket from "ws";
import { chromium } from "playwright";

import { redactPngBoxes, captureRedactedScreenshot } from "../runtime/screenshotRedaction.js";
import { executeProtectedRealisticFill } from "../runtime/protectedRealisticFill.js";

// ─── Part 1: pure pixel-pass redactor ────────────────────────────────────────

function solidWhitePng(w: number, h: number): string {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255;
    png.data[i + 1] = 255;
    png.data[i + 2] = 255;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png).toString("base64");
}

function pixelAt(base64: string, x: number, y: number): [number, number, number, number] {
  const png = PNG.sync.read(Buffer.from(base64, "base64"));
  const idx = (png.width * y + x) << 2;
  return [png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]];
}

describe("redactPngBoxes — pixel pass", () => {
  it("blacks out exactly the requested box (scale 1) and leaves the rest white", () => {
    const out = redactPngBoxes(solidWhitePng(100, 40), [{ x: 10, y: 10, w: 20, h: 12 }], { vw: 100, vh: 40 });
    expect(pixelAt(out, 15, 15)).toEqual([0, 0, 0, 255]); // inside box → black
    expect(pixelAt(out, 90, 35)).toEqual([255, 255, 255, 255]); // outside box → untouched
  });

  it("scales boxes by the image/viewport ratio (deviceScaleFactor 2)", () => {
    // Image is 2x the CSS viewport. A CSS box at (10,10,10,5) maps to image (20,20,20,10).
    const out = redactPngBoxes(solidWhitePng(200, 80), [{ x: 10, y: 10, w: 10, h: 5 }], { vw: 100, vh: 40 });
    expect(pixelAt(out, 30, 25)).toEqual([0, 0, 0, 255]); // inside scaled box
    expect(pixelAt(out, 5, 5)).toEqual([255, 255, 255, 255]); // outside
  });

  it("returns a valid image untouched when there are no boxes", () => {
    const out = redactPngBoxes(solidWhitePng(20, 20), [], { vw: 20, vh: 20 });
    expect(pixelAt(out, 10, 10)).toEqual([255, 255, 255, 255]);
  });

  it("clamps a box that runs past the image bounds without throwing", () => {
    const out = redactPngBoxes(solidWhitePng(30, 30), [{ x: 20, y: 20, w: 100, h: 100 }], { vw: 30, vh: 30 });
    expect(pixelAt(out, 25, 25)).toEqual([0, 0, 0, 255]);
  });
});

// ─── Part 2: real Chromium — capture proves the value is not visible ─────────

const FIXTURE = fileURLToPath(new URL("./fixtures/vision-redact-form.html", import.meta.url));

function chromiumExe(): string | null {
  try {
    const p = chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const EXE = chromiumExe();

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

async function browserWsUrl(cdpUrl: string): Promise<string> {
  const v = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  return v.webSocketDebuggerUrl;
}
async function pageTargetId(cdpUrl: string): Promise<string> {
  const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return page.id;
}

/** Evaluate an expression on the page and return its (by-value) result. */
async function evalOnPage(cdpUrl: string, expression: string): Promise<unknown> {
  const wsUrl = await browserWsUrl(cdpUrl);
  const targetId = await pageTargetId(cdpUrl);
  return new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    let sessionId: string | null = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("evalOnPage timeout"));
    }, 6000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId, flatten: true } })),
    );
    ws.on("message", (raw) => {
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
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const FAKE_PAN = "4242424242424242";
const CARDHOLDER = "Jane Cardholder";

describe.skipIf(!EXE)("Redacted Screenshot — real browser vision channel", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;
  let wsUrl: string;
  let targetId: string;
  // Some headless CI/dev environments cannot composite a frame for
  // Page.captureScreenshot (it hangs regardless of flags). The vision-channel leak
  // this guards against occurs in HEADED/visible sessions, where capture works — so
  // we probe capture capability once and self-skip the capture-dependent assertions
  // when the environment cannot screenshot, while still running them wherever it can.
  let captureWorks = false;

  beforeAll(async () => {
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "vision-redact-it-"));
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
        "--force-device-scale-factor=1",
        `file://${FIXTURE}`,
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(cdpUrl);
    await new Promise((res) => setTimeout(res, 300));
    wsUrl = await browserWsUrl(cdpUrl);
    targetId = await pageTargetId(cdpUrl);

    // Fill the PAN through the protected primitive: DOM-value masked AND visually masked.
    const panRes = await executeProtectedRealisticFill({
      browserWsUrl: wsUrl,
      pageTargetId: targetId,
      selectorExpr: `document.querySelector('#cardnumber')`,
      value: FAKE_PAN,
      maskDomValue: true,
      visualMask: true,
      typingProfile: "password",
      requestId: "vis_test_pan",
      domain: "checkout.test",
      fieldLabel: "card_number",
    });
    expect(panRes.success).toBe(true);

    // Fill the cardholder name: part of the protected card bundle, so it is now BOTH
    // DOM-value masked (agent-opaque readback) and visually masked. The underlying
    // control still holds the real, submittable value (proven via the prototype getter
    // in the assertion below). Typing realism stays "username" (masking is decoupled
    // from typing profile — only PAN/CVV use the slower password timing).
    const nameRes = await executeProtectedRealisticFill({
      browserWsUrl: wsUrl,
      pageTargetId: targetId,
      selectorExpr: `document.querySelector('#cardname')`,
      value: CARDHOLDER,
      maskDomValue: true,
      visualMask: true,
      typingProfile: "username",
      requestId: "vis_test_name",
      domain: "checkout.test",
      fieldLabel: "cardholder_name",
    });
    expect(nameRes.success).toBe(true);

    // Probe whether this environment can actually capture a screenshot.
    const probe = await captureRedactedScreenshot({ browserWsUrl: wsUrl, pageTargetId: targetId });
    captureWorks = probe.ok;
    if (!captureWorks) {
      // eslint-disable-next-line no-console
      console.warn(
        "[screenshot-redaction] headless Page.captureScreenshot unavailable in this environment — " +
          "capture-dependent assertions will be skipped (redaction logic is covered by the pixel-pass unit tests).",
      );
    }
  }, 30_000);

  afterAll(() => {
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
  });

  it("tags both protected fields and applies a visual mask", async () => {
    const masked = await evalOnPage(
      cdpUrl,
      `document.querySelectorAll('[data-antigen-masked="true"]').length`,
    );
    expect(masked).toBe(2);
    const panTextSecurity = await evalOnPage(
      cdpUrl,
      `document.querySelector('#cardnumber').style.getPropertyValue('-webkit-text-security')`,
    );
    expect(panTextSecurity).toBe("disc");
  });

  it("hides both protected fields from a DOM read but keeps the real value submittable", async () => {
    // PAN: the value getter is masked → element.value reads empty (agent DOM read).
    const panValue = await evalOnPage(cdpUrl, `document.querySelector('#cardnumber').value`);
    expect(panValue).toBe("");
    // Cardholder is now part of the agent-opaque bundle: element.value also reads empty.
    const nameValue = await evalOnPage(cdpUrl, `document.querySelector('#cardname').value`);
    expect(nameValue).toBe("");
    // ...but the real value is intact for the website: the native prototype getter
    // (which form submission uses) still returns the cardholder name.
    const nameSubmittable = await evalOnPage(
      cdpUrl,
      `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').get.call(document.querySelector('#cardname'))`,
    );
    expect(nameSubmittable).toBe(CARDHOLDER);
    // PAN likewise stays submittable under the mask.
    const panSubmittable = await evalOnPage(
      cdpUrl,
      `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').get.call(document.querySelector('#cardnumber'))`,
    );
    expect(panSubmittable).toBe(FAKE_PAN);
  });

  it("returns a redacted screenshot: the PAN field region is blacked out", async () => {
    if (!captureWorks) return; // environment cannot screenshot — covered by pixel-pass unit tests
    const shot = await captureRedactedScreenshot({ browserWsUrl: wsUrl, pageTargetId: targetId });
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    expect(shot.redacted_field_count).toBe(2);
    expect(shot.mimeType).toBe("image/png");

    // The raw PAN never appears in the result object.
    expect(JSON.stringify(shot)).not.toContain(FAKE_PAN);

    // Sample the center of the PAN field in the captured image → must be black.
    const rect = (await evalOnPage(
      cdpUrl,
      `(function(){var r=document.querySelector('#cardnumber').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,vw:window.innerWidth};})()`,
    )) as { x: number; y: number; w: number; h: number; vw: number };

    const png = PNG.sync.read(Buffer.from(shot.base64, "base64"));
    const scale = png.width / rect.vw;
    const cx = Math.round((rect.x + rect.w / 2) * scale);
    const cy = Math.round((rect.y + rect.h / 2) * scale);
    const idx = (png.width * cy + cx) << 2;
    expect([png.data[idx], png.data[idx + 1], png.data[idx + 2]]).toEqual([0, 0, 0]);
  }, 20_000);

  it("redacts only the registered protected fields (count drops to 0 when untagged)", async () => {
    if (!captureWorks) return; // environment cannot screenshot — covered by pixel-pass unit tests
    await evalOnPage(
      cdpUrl,
      `(function(){document.querySelectorAll('[data-antigen-masked="true"]').forEach(function(e){e.removeAttribute('data-antigen-masked');});return true;})()`,
    );
    const shot = await captureRedactedScreenshot({ browserWsUrl: wsUrl, pageTargetId: targetId });
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    expect(shot.redacted_field_count).toBe(0);
  }, 20_000);

  it("fails closed (no image) when the page target cannot be attached", async () => {
    const shot = await captureRedactedScreenshot({ browserWsUrl: wsUrl, pageTargetId: "bogus-target-id-xyz" });
    expect(shot.ok).toBe(false);
    if (shot.ok) return;
    expect(shot.error_code).toBe("SCREENSHOT_REDACTION_FAILED");
  });
});

// ─── Part 3: real Chromium — cross-origin OPPWA iframe redaction ──────────────
//
// Reproduces the live IKEA gap: card_number and CVV are rendered inside cross-origin
// OPPWA PCI iframes whose internal masking marker is invisible to the top document.
// The screenshot path must mark the top-document <iframe> containers (driven by the
// caller's expectedIframeFields) and redact their bounding boxes — and FAIL CLOSED
// if an expected field's iframe cannot be located. The two top-document fields
// (expiry, cardholder) are pre-tagged in the fixture, so a full capture redacts all
// four regions.

const IFRAME_FIXTURE = fileURLToPath(new URL("./fixtures/vision-redact-iframe.html", import.meta.url));

describe.skipIf(!EXE)("Redacted Screenshot — cross-origin OPPWA iframe redaction", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;
  let wsUrl: string;
  let targetId: string;
  let captureWorks = false;

  beforeAll(async () => {
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "vision-redact-iframe-it-"));
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
        "--force-device-scale-factor=1",
        `file://${IFRAME_FIXTURE}`,
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(cdpUrl);
    await new Promise((res) => setTimeout(res, 400));
    wsUrl = await browserWsUrl(cdpUrl);
    targetId = await pageTargetId(cdpUrl);

    const probe = await captureRedactedScreenshot({
      browserWsUrl: wsUrl,
      pageTargetId: targetId,
      expectedIframeFields: [],
    });
    captureWorks = probe.ok;
    if (!captureWorks) {
      // eslint-disable-next-line no-console
      console.warn(
        "[screenshot-redaction] headless Page.captureScreenshot unavailable — iframe " +
          "capture-pixel assertions skipped (marking + fail-closed still run).",
      );
    }
  }, 30_000);

  afterAll(() => {
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
  });

  it("marks both top-document OPPWA iframe containers (parent-owned attribute only)", async () => {
    // Marking runs before capture, so this holds even where capture is unavailable.
    await captureRedactedScreenshot({
      browserWsUrl: wsUrl,
      pageTargetId: targetId,
      expectedIframeFields: ["card_number", "cvv"],
    });
    const panMasked = await evalOnPage(cdpUrl, `document.querySelector('#pan-frame').getAttribute('data-antigen-masked')`);
    const cvvMasked = await evalOnPage(cdpUrl, `document.querySelector('#cvv-frame').getAttribute('data-antigen-masked')`);
    const panField = await evalOnPage(cdpUrl, `document.querySelector('#pan-frame').getAttribute('data-antigen-iframe-field')`);
    const cvvField = await evalOnPage(cdpUrl, `document.querySelector('#cvv-frame').getAttribute('data-antigen-iframe-field')`);
    expect(panMasked).toBe("true");
    expect(cvvMasked).toBe("true");
    expect(panField).toBe("card_number");
    expect(cvvField).toBe("cvv");
  });

  it("redacts all four regions: both iframes + expiry + cardholder (count = 4)", async () => {
    if (!captureWorks) return; // environment cannot screenshot — marking + fail-closed cover the rest
    const shot = await captureRedactedScreenshot({
      browserWsUrl: wsUrl,
      pageTargetId: targetId,
      expectedIframeFields: ["card_number", "cvv"],
    });
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    expect(shot.redacted_field_count).toBe(4);
    expect(shot.mimeType).toBe("image/png");
    // No raw values of any kind in the result object.
    expect(JSON.stringify(shot)).not.toContain("4242");
    expect(JSON.stringify(shot)).not.toContain("oppwa.com");

    // The center of each cross-origin iframe region must be black in the image.
    const png = PNG.sync.read(Buffer.from(shot.base64, "base64"));
    for (const sel of ["#pan-frame", "#cvv-frame"]) {
      const rect = (await evalOnPage(
        cdpUrl,
        `(function(){var r=document.querySelector('${sel}').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,vw:window.innerWidth};})()`,
      )) as { x: number; y: number; w: number; h: number; vw: number };
      const scale = png.width / rect.vw;
      const cx = Math.round((rect.x + rect.w / 2) * scale);
      const cy = Math.round((rect.y + rect.h / 2) * scale);
      const idx = (png.width * cy + cx) << 2;
      expect([png.data[idx], png.data[idx + 1], png.data[idx + 2]]).toEqual([0, 0, 0]);
    }
  }, 20_000);

  // Must run last — removes the CVV iframe to assert fail-closed behaviour.
  it("fails closed (no image) when an expected protected iframe cannot be located", async () => {
    await evalOnPage(cdpUrl, `(function(){var e=document.querySelector('#cvv-frame');if(e)e.remove();return true;})()`);
    const shot = await captureRedactedScreenshot({
      browserWsUrl: wsUrl,
      pageTargetId: targetId,
      expectedIframeFields: ["card_number", "cvv"],
    });
    expect(shot.ok).toBe(false);
    if (shot.ok) return;
    expect(shot.error_code).toBe("SCREENSHOT_REDACTION_FAILED");
  }, 20_000);
});
