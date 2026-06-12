/**
 * Protected payment-card fill — REAL browser integration test.
 *
 * Launches a real headless Chromium with a CDP http endpoint, loads a
 * floating-label card form fixture, and drives `executeProtectedRealisticFill`
 * with selectors built by `buildRefSelectorExpr` against the live DOM. This
 * proves — at the DOM level, which the mocked-CDP tests cannot — the fix for
 * the live IKEA cardholder regression:
 *
 *  - a floating-label overlay covering the input (elementFromPoint at the box
 *    center returns the SPAN) still resolves to the real input and the fill
 *    succeeds — instead of `CDP evaluate (focus): TypeError: Illegal invocation`,
 *  - the maskDomValue variant masks `el.value` read-back while the native value
 *    persisted (boolean landing proof only),
 *  - a plain expiry input (center hits the input) keeps working (regression),
 *  - two adjacent inputs under one wide overlay resolve by point containment,
 *  - a decorative node with no fillable control within the 150px cap fails
 *    closed (`element_not_found`) — never an Illegal invocation.
 *
 * Gated behind Chromium availability so environments without the browser skip cleanly.
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

import { executeProtectedRealisticFill } from "../runtime/protectedRealisticFill.js";
import { buildRefSelectorExpr } from "../runtime/paymentCardFill.js";
import type { AntigenSnapshotElementRecord } from "../runtime/antigenSnapshotStore.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/floating-label-card-form.html", import.meta.url));

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

async function cdpEndpoints(cdpUrl: string): Promise<{ browserWsUrl: string; pageTargetId: string }> {
  const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return { browserWsUrl: version.webSocketDebuggerUrl, pageTargetId: page.id };
}

/** Evaluate an arbitrary expression on the page over CDP and return the value. */
async function evalOnPage(cdpUrl: string, expression: string): Promise<unknown> {
  const { browserWsUrl, pageTargetId } = await cdpEndpoints(cdpUrl);
  return new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl);
    let id = 1;
    let sessionId: string | null = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("evalOnPage timeout"));
    }, 5000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId: pageTargetId, flatten: true } })),
    );
    ws.on("message", (raw) => {
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
        resolve(msg.result.result.value);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Viewport-relative box of an element by id, measured from the live page. */
async function boxOf(cdpUrl: string, domId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const v = await evalOnPage(
    cdpUrl,
    `(function(){ var r = document.getElementById(${JSON.stringify(domId)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`,
  );
  return v as { x: number; y: number; width: number; height: number };
}

/** Snapshot-record stub: only id/tag/box are consumed by buildRefSelectorExpr. */
function recordFor(box: { x: number; y: number; width: number; height: number }, opts: { id?: string | null; tag?: string } = {}): AntigenSnapshotElementRecord {
  return { id: opts.id ?? null, tag: opts.tag ?? "input", box } as never;
}

function fillParams(selectorExpr: string, value: string, overrides: Partial<Parameters<typeof executeProtectedRealisticFill>[0]> = {}) {
  return {
    browserWsUrl: "",
    pageTargetId: "",
    selectorExpr,
    value,
    maskDomValue: false,
    visualMask: true,
    typingProfile: "username" as const,
    requestId: "pcfr_it_1",
    domain: "localhost",
    fieldLabel: "cardholder_name",
    ...overrides,
  };
}

const EXE = chromiumExe();

describe.skipIf(!EXE)("Protected payment-card fill — real browser floating-label form", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;
  let browserWsUrl: string;
  let pageTargetId: string;

  beforeAll(async () => {
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "card-fill-it-"));
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
        `file://${FIXTURE}`,
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(cdpUrl);
    await new Promise((res) => setTimeout(res, 300));
    ({ browserWsUrl, pageTargetId } = await cdpEndpoints(cdpUrl));

    // Precondition for the whole suite: the overlay really covers the input —
    // elementFromPoint at the input's center must return the SPAN, the exact
    // live-IKEA shape that used to throw Illegal invocation.
    const box = await boxOf(cdpUrl, "cardholder");
    const hitTag = await evalOnPage(
      cdpUrl,
      `document.elementFromPoint(${box.x + box.width / 2}, ${box.y + box.height / 2}).id`,
    );
    expect(hitTag).toBe("cardholder-overlay");
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

  it("fills cardholder under a floating-label overlay (the live Illegal-invocation case)", async () => {
    const box = await boxOf(cdpUrl, "cardholder");
    // No usable DOM id in the record (volatile-id case) — point resolution only.
    const selectorExpr = buildRefSelectorExpr(recordFor(box));

    const result = await executeProtectedRealisticFill(
      fillParams(selectorExpr, "Jane Cardholder", { browserWsUrl, pageTargetId }),
    );

    expect(result.error ?? "").not.toContain("Illegal invocation");
    expect(result.success).toBe(true);

    const value = await evalOnPage(cdpUrl, `document.getElementById('cardholder').value`);
    expect(value).toBe("Jane Cardholder");
    const masked = await evalOnPage(cdpUrl, `document.getElementById('cardholder').getAttribute('data-antigen-masked')`);
    expect(masked).toBe("true");
    const style = await evalOnPage(cdpUrl, `document.getElementById('cardholder').getAttribute('style') || ''`);
    expect(String(style)).toContain("text-security");
  }, 30_000);

  it("masks el.value read-back (maskDomValue) while the native value persisted", async () => {
    const box = await boxOf(cdpUrl, "masked-field");
    const selectorExpr = buildRefSelectorExpr(recordFor(box));

    const result = await executeProtectedRealisticFill(
      fillParams(selectorExpr, "Masked Holder", { browserWsUrl, pageTargetId, maskDomValue: true }),
    );
    expect(result.success).toBe(true);

    // Agent-visible read-back is masked…
    const readBack = await evalOnPage(cdpUrl, `document.getElementById('masked-field').value`);
    expect(readBack).toBe("");
    // …but the value verifiably landed (boolean landing proof + native getter length).
    const saw = await evalOnPage(cdpUrl, `window.__maskedFieldSawValue`);
    expect(saw).toBe(true);
    const nativeLen = await evalOnPage(
      cdpUrl,
      `(function(){ var el = document.getElementById('masked-field'); var g = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get; return g.call(el).length > 0; })()`,
    );
    expect(nativeLen).toBe(true);
  }, 30_000);

  it("keeps the plain expiry input green (center hits the input directly)", async () => {
    const box = await boxOf(cdpUrl, "expiry");
    const selectorExpr = buildRefSelectorExpr(recordFor(box));

    const result = await executeProtectedRealisticFill(
      fillParams(selectorExpr, "12/29", { browserWsUrl, pageTargetId, fieldLabel: "expiry_combined" }),
    );
    expect(result.success).toBe(true);

    const value = await evalOnPage(cdpUrl, `document.getElementById('expiry').value`);
    expect(value).toBe("12/29");
  }, 30_000);

  it("resolves the CONTAINING input when two adjacent inputs share one wide overlay", async () => {
    const box = await boxOf(cdpUrl, "pair-b");
    const selectorExpr = buildRefSelectorExpr(recordFor(box));

    const result = await executeProtectedRealisticFill(
      fillParams(selectorExpr, "right one", { browserWsUrl, pageTargetId, fieldLabel: "cardholder_name", visualMask: false }),
    );
    expect(result.success).toBe(true);

    const valueB = await evalOnPage(cdpUrl, `document.getElementById('pair-b').value`);
    expect(valueB).toBe("right one");
    const valueA = await evalOnPage(cdpUrl, `document.getElementById('pair-a').value`);
    expect(valueA).toBe("");
  }, 30_000);

  it("fails closed on a decorative node with no fillable control nearby — never Illegal invocation", async () => {
    const box = await boxOf(cdpUrl, "decoy");
    const selectorExpr = buildRefSelectorExpr(recordFor(box));

    const result = await executeProtectedRealisticFill(
      fillParams(selectorExpr, "should not land", { browserWsUrl, pageTargetId }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("element_not_found");
    expect(result.error ?? "").not.toContain("Illegal invocation");
    // The value landed nowhere on the page.
    const anyValue = await evalOnPage(
      cdpUrl,
      `Array.prototype.some.call(document.querySelectorAll('input'), function(i){ var g = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get; return g.call(i).indexOf('should not land') !== -1; })`,
    );
    expect(anyValue).toBe(false);
  }, 30_000);
});
