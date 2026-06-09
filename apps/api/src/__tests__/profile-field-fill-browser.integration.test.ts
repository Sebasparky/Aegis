/**
 * Protected profile fill — REAL browser integration test.
 *
 * Launches a real headless Chromium with a CDP http endpoint, loads a controlled
 * (React-like) checkout fixture, and drives the actual `executeProfileFieldFillViaCDP`
 * runtime against the live DOM. This proves — at the DOM level, which mocked-CDP tests
 * cannot — the fix for the live IKEA regression:
 *
 *  - the country-code-inclusive canonical phone ("15551234567") is formatted to a
 *    field-acceptable national form, the controlled model updates, and validate-on-blur
 *    clears aria-invalid (the raw 11-digit value would have failed the 10-digit rule),
 *  - the <select> region is genuinely committed (value + selectedIndex), the model
 *    updates, and aria-invalid clears,
 *  - a repeated fill replaces rather than appends (no "(555) 123-4567(555) 123-4567"),
 *  - no raw profile value is returned to the agent.
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
import type { ProfileFieldFillRequest, ProfileFieldKind } from "@aegis/types";

import { executeProfileFieldFillViaCDP } from "../runtime/profileFieldFill.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/profile-fill-form.html", import.meta.url));

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

/** Evaluate an arbitrary expression on the page over CDP and return the value. */
async function evalOnPage(cdpUrl: string, expression: string): Promise<unknown> {
  const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 1;
    let sessionId: string | null = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("evalOnPage timeout"));
    }, 5000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: id++, method: "Target.attachToTarget", params: { targetId: page.id, flatten: true } })),
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

function makeFillRequest(fields: Array<{ key: ProfileFieldKind; label: string }>): ProfileFieldFillRequest {
  return {
    fill_request_id: "pffr_it_" + Date.now(),
    user_id: "user_demo_001",
    delegation_id: "del_demo_001",
    domain: "localhost",
    page_url: `file://${FIXTURE}`,
    requested_fields: fields.map((f) => ({ key: f.key, label: f.label })),
    reason: "integration test",
    status: "executing",
    raw_profile_value_revealed_to_agent: false,
    raw_profile_values_revealed_to_agent: false,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  };
}

const EXE = chromiumExe();

describe.skipIf(!EXE)("Protected profile fill — real browser controlled form", () => {
  let proc: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    userDataDir = mkdtempSync(join(tmpdir(), "profile-fill-it-"));
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
    await new Promise((res) => setTimeout(res, 300));
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

  it("fills phone in a field-valid national format, updates the controlled model, and clears aria-invalid", async () => {
    // Canonical seed includes the US country code; the raw 11-digit value would FAIL the
    // fixture's 10-national-digit validator. The formatter must strip it.
    const req = makeFillRequest([{ key: "phone", label: "Phone number" }]);
    const resolved = new Map<ProfileFieldKind, string>([["phone", "15551234567"]]);

    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);

    const phoneEntry = entries.find((e) => e.key === "phone");
    expect(phoneEntry?.field_filled).toBe(true);
    expect(phoneEntry?.status).toBe("filled");
    expect(phoneEntry?.raw_profile_value_revealed_to_agent).toBe(false);

    const domValue = (await evalOnPage(cdpUrl, `document.getElementById('phone').value`)) as string;
    expect(domValue.replace(/\D+/g, "")).toBe("5551234567"); // exactly 10 national digits, country code stripped
    expect(domValue).not.toContain("155"); // never the shifted "+1-155-512-3456" corruption

    const model = (await evalOnPage(cdpUrl, `window.__model.phone`)) as string | null;
    expect(model).toBe(domValue); // controlled model updated via dispatched events

    const ariaInvalid = (await evalOnPage(cdpUrl, `document.getElementById('phone').getAttribute('aria-invalid')`)) as string;
    expect(ariaInvalid).toBe("false"); // validate-on-blur cleared
  });

  it("does not expose the raw or formatted phone value in the returned entries", async () => {
    const req = makeFillRequest([{ key: "phone", label: "Phone number" }]);
    const resolved = new Map<ProfileFieldKind, string>([["phone", "15551234567"]]);
    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    const json = JSON.stringify(entries);
    expect(json).not.toContain("15551234567");
    expect(json).not.toContain("5551234567");
  });

  it("commits the <select> region (value + selectedIndex), updates the model, and clears aria-invalid", async () => {
    const req = makeFillRequest([{ key: "region", label: "State" }]);
    const resolved = new Map<ProfileFieldKind, string>([["region", "MI"]]);

    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    const stateEntry = entries.find((e) => e.key === "region");
    expect(stateEntry?.field_filled).toBe(true);
    expect(stateEntry?.status).toBe("filled");

    const value = (await evalOnPage(cdpUrl, `document.getElementById('state').value`)) as string;
    expect(value).toBe("MI");
    const selectedIndex = (await evalOnPage(cdpUrl, `document.getElementById('state').selectedIndex`)) as number;
    expect(selectedIndex).toBeGreaterThan(0); // not the placeholder option
    const model = (await evalOnPage(cdpUrl, `window.__model.state`)) as string | null;
    expect(model).toBe("MI"); // controlled model updated via change event
    const ariaInvalid = (await evalOnPage(cdpUrl, `document.getElementById('state').getAttribute('aria-invalid')`)) as string;
    expect(ariaInvalid).toBe("false");
  });

  it("repeated phone fill REPLACES rather than appends (idempotent value)", async () => {
    const req = makeFillRequest([{ key: "phone", label: "Phone number" }]);
    const resolved = new Map<ProfileFieldKind, string>([["phone", "15551234567"]]);

    await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    const firstValue = (await evalOnPage(cdpUrl, `document.getElementById('phone').value`)) as string;
    await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    const secondValue = (await evalOnPage(cdpUrl, `document.getElementById('phone').value`)) as string;

    expect(secondValue).toBe(firstValue); // not doubled / appended
    expect(secondValue.replace(/\D+/g, "")).toBe("5551234567");
  });
});
