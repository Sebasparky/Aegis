/**
 * Antigen exact-replacement — REAL browser integration test.
 *
 * Launches a real headless Chromium (the Playwright-bundled binary) with a CDP
 * http endpoint, loads a local HTML fixture with PREFILLED fields, and drives the
 * actual Antigen runtime functions against the live DOM. This is the test that
 * proves the IKEA-style corruption bug is fixed at the DOM level — mocked-CDP
 * tests cannot prove real append-vs-replace or React-controlled setter behavior.
 *
 * Proves:
 *  - browser_type (dispatchTextCharsViaCDP) APPENDS on a prefilled field,
 *  - setFieldValueKnownBox REPLACES exactly (verified read-back),
 *  - a repeated exact set is idempotent (changed=false, no events),
 *  - the snapshot exposes non-sensitive current values and redacts the password,
 *  - a React-like controlled input sticks (native setter + dispatched events),
 *  - <select> replacement works by value and by visible label,
 *  - a value the field coerces away surfaces VALUE_MISMATCH.
 *
 * Gated behind Chromium availability so environments without the browser skip
 * cleanly (matching the otherwise all-mocked suite).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

import {
  extractAntigenSnapshotCandidatesViaCDP,
  type AntigenSnapshotCandidate,
} from "../runtime/antigenSnapshotRuntime.js";
import {
  dispatchTextCharsViaCDP as appendCharsViaCDP,
  setFieldValueKnownBox as setValueKnownBox,
} from "../runtime/realisticBrowserActions.js";
import WebSocket from "ws";
import { chromium } from "playwright";

const FIXTURE = fileURLToPath(new URL("./fixtures/exact-fill-form.html", import.meta.url));

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

/** Reads back a DOM value over CDP for assertions the snapshot does not expose. */
async function readDomValue(cdpUrl: string, selector: string): Promise<string> {
  const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string; url: string }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 1;
    let sessionId: string | null = null;
    const timer = setTimeout(() => { ws.close(); reject(new Error("readDomValue timeout")); }, 5000);
    ws.on("open", () => ws.send(JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId: page.id, flatten: true } })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.result?.sessionId && !sessionId) {
        sessionId = msg.result.sessionId;
        ws.send(JSON.stringify({
          id: id++, method: "Runtime.evaluate", sessionId,
          params: { expression: `(function(){var e=document.querySelector(${JSON.stringify(selector)});return e?String(e.value):null;})()`, returnByValue: true },
        }));
        return;
      }
      if (msg.result?.result && msg.id >= 2) {
        clearTimeout(timer);
        ws.close();
        resolve(String(msg.result.result.value ?? ""));
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

describe.skipIf(!EXE)("Antigen exact-replacement — real browser", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "antigen-setval-it-"));
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
        `file://${FIXTURE}`,
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(cdpUrl);
    // Give the page scripts (controlled/upper handlers) a tick to attach.
    await new Promise((res) => setTimeout(res, 300));
  }, 30_000);

  afterAll(() => {
    try { proc?.kill("SIGKILL"); } catch { /* ignore */ }
    try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function snapshot(): Promise<AntigenSnapshotCandidate[]> {
    return extractAntigenSnapshotCandidatesViaCDP({ cdpUrl, viewportOnly: false });
  }

  function byName(cands: AntigenSnapshotCandidate[], name: string): AntigenSnapshotCandidate {
    const c = cands.find((x) => x.normalized_name === name.toLowerCase() || x.name === name);
    if (!c) throw new Error(`candidate '${name}' not found; have: ${cands.map((x) => x.name).join(" | ")}`);
    return c;
  }

  it("snapshot exposes non-sensitive current values and redacts the password", async () => {
    const cands = await snapshot();
    const first = byName(cands, "First name");
    expect(first.value_meta?.sensitive).toBe(false);
    expect(first.value_meta?.value).toBe("Sebastian");
    expect(first.value_meta?.value_present).toBe(true);

    const zip = byName(cands, "ZIP");
    expect(zip.value_meta?.value).toBe("48180");

    const password = byName(cands, "Password");
    expect(password.value_meta?.sensitive).toBe(true);
    expect(password.value_meta?.value).toBeUndefined();
    expect(password.value_meta?.value_present).toBe(true);
    // The raw secret never appears anywhere in the snapshot candidate.
    expect(JSON.stringify(password)).not.toContain("hunter2-SECRET");
  });

  it("browser_type APPENDS on a prefilled field (the old corruption behavior)", async () => {
    // Focus the prefilled Last name field, then dispatch chars the way browser_type
    // does — no clear. Proves the contrast with exact replacement below.
    const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string }>;
    const page = list.find((t) => t.type === "page")!;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      let id = 1;
      let sessionId: string | null = null;
      const timer = setTimeout(() => { ws.close(); reject(new Error("append timeout")); }, 6000);
      ws.on("open", () => ws.send(JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId: page.id, flatten: true } })));
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.result?.sessionId && !sessionId) {
          sessionId = msg.result.sessionId;
          // Focus + place caret at end of the existing value.
          ws.send(JSON.stringify({
            id: id++, method: "Runtime.evaluate", sessionId,
            params: { expression: `(function(){var e=document.getElementById('last');e.focus();e.setSelectionRange(e.value.length,e.value.length);return true;})()`, returnByValue: true },
          }));
          const send = (method: string, params: Record<string, unknown>) => ws.send(JSON.stringify({ id: id++, method, sessionId, params }));
          await appendCharsViaCDP((m, p) => send(m, p), (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), "Z");
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const after = await readDomValue(cdpUrl, "#last");
    expect(after).toBe("ChaconZ"); // appended, NOT replaced
  });

  it("setFieldValueKnownBox REPLACES a prefilled field exactly and is idempotent", async () => {
    let cands = await snapshot();
    const first = byName(cands, "First name");
    const r1 = await setValueKnownBox({ cdpUrl, box: first.box, value: "Marie" });
    expect(r1.success).toBe(true);
    expect(r1.changed).toBe(true);
    expect(r1.verified).toBe(true);
    expect(await readDomValue(cdpUrl, "#first")).toBe("Marie"); // replaced, not "SebastianMarie"

    // Re-snapshot (box may shift) and repeat the SAME value → idempotent skip.
    cands = await snapshot();
    const first2 = byName(cands, "First name");
    expect(first2.value_meta?.value).toBe("Marie");
    const r2 = await setValueKnownBox({ cdpUrl, box: first2.box, value: "Marie" });
    expect(r2.success).toBe(true);
    expect(r2.changed).toBe(false);
    expect(await readDomValue(cdpUrl, "#first")).toBe("Marie");
  });

  it("sets a React-like controlled input via the native setter (value sticks)", async () => {
    const cands = await snapshot();
    const ctrl = byName(cands, "Controlled");
    const r = await setValueKnownBox({ cdpUrl, box: ctrl.box, value: "typed-by-antigen" });
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    // Wait past the controller's revert interval — the value must persist because
    // the input event updated the controller's state.
    await new Promise((res) => setTimeout(res, 40));
    expect(await readDomValue(cdpUrl, "#controlled")).toBe("typed-by-antigen");
  });

  it("replaces a <select> by option value and by visible label", async () => {
    let cands = await snapshot();
    const stateSel = byName(cands, "State");
    const r1 = await setValueKnownBox({ cdpUrl, box: stateSel.box, value: "MI" });
    expect(r1.success).toBe(true);
    expect(await readDomValue(cdpUrl, "#state")).toBe("MI");

    cands = await snapshot();
    const stateSel2 = byName(cands, "State");
    const r2 = await setValueKnownBox({ cdpUrl, box: stateSel2.box, value: "Ohio", selectByLabel: true });
    expect(r2.success).toBe(true);
    expect(await readDomValue(cdpUrl, "#state")).toBe("OH");
  });

  it("surfaces VALUE_MISMATCH when the field coerces the value away", async () => {
    const cands = await snapshot();
    const upper = byName(cands, "Upper");
    const r = await setValueKnownBox({ cdpUrl, box: upper.box, value: "chacon" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("VALUE_MISMATCH");
    // The field coerced to uppercase; nothing crashed and no append occurred.
    expect(await readDomValue(cdpUrl, "#upper")).toBe("CHACON");
  });
});
