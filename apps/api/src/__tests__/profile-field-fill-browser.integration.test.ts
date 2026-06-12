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

  it("types first/last name into their fields and updates the controlled model", async () => {
    const req = makeFillRequest([
      { key: "first_name", label: "First name" },
      { key: "last_name", label: "Last name" },
    ]);
    const resolved = new Map<ProfileFieldKind, string>([
      ["first_name", "Ada"],
      ["last_name", "Lovelace"],
    ]);

    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    expect(entries.find((e) => e.key === "first_name")?.status).toBe("filled");
    expect(entries.find((e) => e.key === "last_name")?.status).toBe("filled");

    expect(await evalOnPage(cdpUrl, `document.getElementById('first_name').value`)).toBe("Ada");
    expect(await evalOnPage(cdpUrl, `document.getElementById('last_name').value`)).toBe("Lovelace");
    // Controlled model updated only via dispatched input/change — proves realistic key events landed.
    expect(await evalOnPage(cdpUrl, `window.__model.first_name`)).toBe("Ada");
    expect(await evalOnPage(cdpUrl, `window.__model.last_name`)).toBe("Lovelace");

    const json = JSON.stringify(entries);
    expect(json).not.toContain("Ada");
    expect(json).not.toContain("Lovelace");
  });

  it("fills email, updates the model, and clears aria-invalid on blur", async () => {
    const req = makeFillRequest([{ key: "email", label: "Email" }]);
    const resolved = new Map<ProfileFieldKind, string>([["email", "ada@example.com"]]);

    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    expect(entries.find((e) => e.key === "email")?.status).toBe("filled");

    expect(await evalOnPage(cdpUrl, `document.getElementById('email').value`)).toBe("ada@example.com");
    expect(await evalOnPage(cdpUrl, `window.__model.email`)).toBe("ada@example.com");
    expect(await evalOnPage(cdpUrl, `document.getElementById('email').getAttribute('aria-invalid')`)).toBe("false");

    expect(JSON.stringify(entries)).not.toContain("ada@example.com");
  });

  it("routes shipping_address_line1 to the line-1 field, never the optional line-2 field", async () => {
    const req = makeFillRequest([{ key: "shipping_address_line1", label: "Street address" }]);
    const resolved = new Map<ProfileFieldKind, string>([["shipping_address_line1", "10 Downing St"]]);

    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    expect(entries.find((e) => e.key === "shipping_address_line1")?.status).toBe("filled");

    expect(await evalOnPage(cdpUrl, `document.getElementById('address1').value`)).toBe("10 Downing St");
    // The optional line-2 field must remain untouched.
    expect(await evalOnPage(cdpUrl, `document.getElementById('address2').value`)).toBe("");
  });

  it("fills city and zip text fields", async () => {
    const req = makeFillRequest([
      { key: "city", label: "City" },
      { key: "postal_code", label: "ZIP code" },
    ]);
    const resolved = new Map<ProfileFieldKind, string>([
      ["city", "London"],
      ["postal_code", "48104"],
    ]);

    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    expect(entries.find((e) => e.key === "city")?.status).toBe("filled");
    expect(entries.find((e) => e.key === "postal_code")?.status).toBe("filled");

    expect(await evalOnPage(cdpUrl, `document.getElementById('city').value`)).toBe("London");
    expect(await evalOnPage(cdpUrl, `document.getElementById('zip').value`)).toBe("48104");
  });

  it("repeated TEXT fill REPLACES rather than appends (idempotent value)", async () => {
    const req = makeFillRequest([{ key: "first_name", label: "First name" }]);
    const resolved = new Map<ProfileFieldKind, string>([["first_name", "Ada"]]);

    await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);
    const value = (await evalOnPage(cdpUrl, `document.getElementById('first_name').value`)) as string;

    expect(value).toBe("Ada"); // not "AdaAda"
  });

  // ─── Verify-and-correct: prefilled page values are untrusted ────────────────

  it("OVERWRITES a wrong prefilled city (the Taylor → Ann Arbor bug) and reports corrected_existing_value", async () => {
    // Simulate site/browser autofill prepopulating the wrong city. Direct assignment fires
    // no events — exactly like a restored/autofilled value the page model never saw.
    await evalOnPage(cdpUrl, `(function(){ document.getElementById('city').value = 'Taylor'; return true; })()`);

    const req = makeFillRequest([{ key: "city", label: "City" }]);
    const resolved = new Map<ProfileFieldKind, string>([["city", "Ann Arbor"]]);
    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);

    const cityEntry = entries.find((e) => e.key === "city");
    expect(cityEntry?.status).toBe("corrected_existing_value");
    expect(cityEntry?.field_filled).toBe(true);
    expect(cityEntry?.raw_profile_value_revealed_to_agent).toBe(false);

    expect(await evalOnPage(cdpUrl, `document.getElementById('city').value`)).toBe("Ann Arbor");
    expect(await evalOnPage(cdpUrl, `window.__model.city`)).toBe("Ann Arbor"); // events dispatched

    // Neither the untrusted existing value nor the protected expected value leaks.
    const json = JSON.stringify(entries);
    expect(json).not.toContain("Taylor");
    expect(json).not.toContain("Ann Arbor");
  });

  it("reports already_correct for a matching prefilled city (case/whitespace) WITHOUT rewriting", async () => {
    await evalOnPage(
      cdpUrl,
      `(function(){ document.getElementById('city').value = ' ann  ARBOR '; window.__model.city = null; return true; })()`,
    );

    const req = makeFillRequest([{ key: "city", label: "City" }]);
    const resolved = new Map<ProfileFieldKind, string>([["city", "Ann Arbor"]]);
    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);

    const cityEntry = entries.find((e) => e.key === "city");
    expect(cityEntry?.status).toBe("already_correct");
    expect(cityEntry?.field_filled).toBe(true);

    // Untouched: value preserved verbatim and NO events were dispatched (model still null).
    expect(await evalOnPage(cdpUrl, `document.getElementById('city').value`)).toBe(" ann  ARBOR ");
    expect(await evalOnPage(cdpUrl, `window.__model.city`)).toBe(null);

    expect(JSON.stringify(entries)).not.toContain("Ann Arbor");
  });

  it("treats a formatted-equivalent prefilled phone as already_correct", async () => {
    await evalOnPage(
      cdpUrl,
      `(function(){ document.getElementById('phone').value = '(555) 123-4567'; window.__model.phone = null; return true; })()`,
    );

    const req = makeFillRequest([{ key: "phone", label: "Phone number" }]);
    const resolved = new Map<ProfileFieldKind, string>([["phone", "15551234567"]]);
    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);

    expect(entries.find((e) => e.key === "phone")?.status).toBe("already_correct");
    expect(await evalOnPage(cdpUrl, `document.getElementById('phone').value`)).toBe("(555) 123-4567");
    expect(await evalOnPage(cdpUrl, `window.__model.phone`)).toBe(null); // nothing dispatched
  });

  it("OVERWRITES wrong prefilled phone digits and the corrected value passes validation", async () => {
    await evalOnPage(
      cdpUrl,
      `(function(){ document.getElementById('phone').value = '(555) 999-0000'; return true; })()`,
    );

    const req = makeFillRequest([{ key: "phone", label: "Phone number" }]);
    const resolved = new Map<ProfileFieldKind, string>([["phone", "15551234567"]]);
    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);

    expect(entries.find((e) => e.key === "phone")?.status).toBe("corrected_existing_value");
    const domValue = (await evalOnPage(cdpUrl, `document.getElementById('phone').value`)) as string;
    expect(domValue.replace(/\D+/g, "")).toBe("5551234567");
    expect(await evalOnPage(cdpUrl, `document.getElementById('phone').getAttribute('aria-invalid')`)).toBe("false");
    expect(JSON.stringify(entries)).not.toContain("9990000");
  });

  it("reports already_correct for a select whose option is already committed", async () => {
    // The earlier region test committed MI. A repeat fill must not re-dispatch events.
    await evalOnPage(cdpUrl, `(function(){ window.__model.state = null; return true; })()`);

    const req = makeFillRequest([{ key: "region", label: "State" }]);
    const resolved = new Map<ProfileFieldKind, string>([["region", "MI"]]);
    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);

    expect(entries.find((e) => e.key === "region")?.status).toBe("already_correct");
    expect(await evalOnPage(cdpUrl, `document.getElementById('state').value`)).toBe("MI");
    expect(await evalOnPage(cdpUrl, `window.__model.state`)).toBe(null); // no events dispatched
  });

  it("OVERWRITES a wrong committed select option and reports corrected_existing_value", async () => {
    await evalOnPage(
      cdpUrl,
      `(function(){ var s = document.getElementById('state'); s.value = 'OH'; return true; })()`,
    );

    const req = makeFillRequest([{ key: "region", label: "State" }]);
    const resolved = new Map<ProfileFieldKind, string>([["region", "MI"]]);
    const entries = await executeProfileFieldFillViaCDP(req, resolved, cdpUrl, `file://${FIXTURE}`);

    expect(entries.find((e) => e.key === "region")?.status).toBe("corrected_existing_value");
    expect(await evalOnPage(cdpUrl, `document.getElementById('state').value`)).toBe("MI");
    expect(await evalOnPage(cdpUrl, `window.__model.state`)).toBe("MI"); // change event dispatched
  });
});
