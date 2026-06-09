import WebSocket from "ws";
import { PNG } from "pngjs";

/**
 * Redacted Screenshot capture — vision-channel protection for protected fills.
 *
 * The agent's `browser_take_screenshot` must never reveal a raw protected value
 * (PAN, CVV, expiry, cardholder name, password) that Antigen filled, even though
 * the page renders it visually. The structured channels (DOM read, snapshot, tool
 * responses) are already protected; this closes the vision channel.
 *
 * Two redaction layers, both keyed to the REGISTERED protected fields only — the
 * elements tagged `data-antigen-masked="true"` by the protected-fill primitive —
 * never the whole page:
 *   1. Pre-capture DOM overlay: an opaque "Filled by Antigen" box is laid over each
 *      registered field before the screenshot is taken.
 *   2. Pixel pass (fail-safe): the captured PNG's pixels under each field's box are
 *      painted solid black, so redaction survives even if the DOM overlay failed.
 *
 * Fail-closed contract:
 *   - If the page enumeration, capture, or pixel pass cannot complete, this returns
 *     { ok: false, error_code: "SCREENSHOT_REDACTION_FAILED" } and NO image. The
 *     caller must never fall back to an unredacted screenshot.
 *   - Field bounding boxes and the raw/redacted image bytes are returned ONLY to the
 *     caller for the agent's (redacted) image result — never logged. The function
 *     surfaces only an aggregate `redacted_field_count`.
 *   - page.evaluate callbacks are raw JS string IIFEs (the Node tsconfig has no DOM lib).
 */

export interface CaptureRedactedScreenshotParams {
  /** Browser-level CDP WebSocket debugger URL (from /json/version). */
  browserWsUrl: string;
  /** CDP target id of the page to capture. Caller selects this. */
  pageTargetId: string;
}

export type CaptureRedactedScreenshotResult =
  | { ok: true; base64: string; mimeType: "image/png"; redacted_field_count: number }
  | { ok: false; error_code: "SCREENSHOT_REDACTION_FAILED" };

interface RedactBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Enumerate the registered protected fields, lay opaque overlay boxes, and return
// their viewport-relative rects + the live viewport size. NEVER reads any value.
const OVERLAY_EXPR = `(function(){
  try {
    var nodes = document.querySelectorAll('[data-antigen-masked="true"]');
    var existing = document.getElementById('__antigen_redact_layer');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var layer = document.createElement('div');
    layer.id = '__antigen_redact_layer';
    layer.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(layer);
    var boxes = [];
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      var b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;background:#111;color:#fff;font:600 11px/' + r.height + 'px -apple-system,system-ui,monospace;text-align:center;overflow:hidden;white-space:nowrap;border-radius:3px;box-shadow:0 0 0 2px #ff5000;z-index:2147483647;pointer-events:none;';
      b.textContent = 'Filled by Antigen';
      layer.appendChild(b);
    }
    return { ok: true, boxes: boxes, vw: window.innerWidth, vh: window.innerHeight };
  } catch (e) { return { ok: false, reason: String(e) }; }
})()`;

const REMOVE_OVERLAY_EXPR = `(function(){
  try {
    var l = document.getElementById('__antigen_redact_layer');
    if (l && l.parentNode) l.parentNode.removeChild(l);
    return { ok: true };
  } catch (e) { return { ok: false }; }
})()`;

/**
 * Paint solid-black rectangles over the registered protected-field boxes. Boxes are
 * viewport CSS px; the scale to image pixels is derived from the actual image
 * dimensions vs. the live viewport, so it is correct under any deviceScaleFactor.
 * Throws on decode/encode failure so the caller can fail closed.
 */
export function redactPngBoxes(
  pngBase64: string,
  boxes: RedactBox[],
  viewport: { vw: number; vh: number },
): string {
  const png = PNG.sync.read(Buffer.from(pngBase64, "base64"));
  const scaleX = viewport.vw > 0 ? png.width / viewport.vw : 1;
  const scaleY = viewport.vh > 0 ? png.height / viewport.vh : 1;
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x * scaleX));
    const y0 = Math.max(0, Math.floor(box.y * scaleY));
    const x1 = Math.min(png.width, Math.ceil((box.x + box.w) * scaleX));
    const y1 = Math.min(png.height, Math.ceil((box.y + box.h) * scaleY));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (png.width * y + x) << 2;
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png).toString("base64");
}

export async function captureRedactedScreenshot(
  params: CaptureRedactedScreenshotParams,
): Promise<CaptureRedactedScreenshotResult> {
  const { browserWsUrl, pageTargetId } = params;

  return await new Promise<CaptureRedactedScreenshotResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let sessionId: string | null = null;
    let settled = false;
    const pending = new Map<number, (result: Record<string, unknown> | undefined, error?: unknown) => void>();

    const FAIL: CaptureRedactedScreenshotResult = { ok: false, error_code: "SCREENSHOT_REDACTION_FAILED" };

    const timer = setTimeout(() => finish(FAIL), 12_000);

    const finish = (result: CaptureRedactedScreenshotResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const send = (method: string, p: Record<string, unknown> = {}, sid?: string): Promise<Record<string, unknown> | undefined> =>
      new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, (result, error) => (error ? rej(error) : res(result)));
        const message: Record<string, unknown> = { id, method, params: p };
        if (sid) message.sessionId = sid;
        ws.send(JSON.stringify(message));
      });

    const run = async () => {
      const attach = await send("Target.attachToTarget", { targetId: pageTargetId, flatten: true });
      sessionId = (attach?.sessionId as string) ?? null;
      if (!sessionId) return finish(FAIL);

      // 1. Lay overlay boxes and collect the registered-field rects.
      const overlayRes = await send("Runtime.evaluate", { expression: OVERLAY_EXPR, returnByValue: true }, sessionId);
      const overlayVal = (overlayRes?.result as Record<string, unknown> | undefined)?.value as
        | { ok?: boolean; boxes?: RedactBox[]; vw?: number; vh?: number }
        | undefined;
      if (!overlayVal?.ok) return finish(FAIL);
      const boxes = Array.isArray(overlayVal.boxes) ? overlayVal.boxes : [];
      const vw = typeof overlayVal.vw === "number" ? overlayVal.vw : 0;
      const vh = typeof overlayVal.vh === "number" ? overlayVal.vh : 0;

      // 2. Capture the (already DOM-overlaid) viewport. Enable the Page domain first
      //    — some Chromium builds need it before captureScreenshot resolves.
      let captureRes: Record<string, unknown> | undefined;
      try {
        await send("Page.enable", {}, sessionId).catch(() => undefined);
        captureRes = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      } catch {
        await removeOverlay();
        return finish(FAIL);
      }
      const captured = captureRes?.data as string | undefined;
      if (!captured) {
        await removeOverlay();
        return finish(FAIL);
      }

      // 3. Pixel-pass fail-safe: black out the field rectangles in the image bytes.
      let redacted: string;
      try {
        redacted = boxes.length > 0 ? redactPngBoxes(captured, boxes, { vw, vh }) : captured;
      } catch {
        await removeOverlay();
        return finish(FAIL);
      }

      // 4. Remove the temporary capture-only overlay so the live UI keeps the lighter
      //    text-security mask, not opaque boxes. Best-effort — never blocks the result.
      await removeOverlay();

      return finish({ ok: true, base64: redacted, mimeType: "image/png", redacted_field_count: boxes.length });
    };

    const removeOverlay = async () => {
      try {
        if (sessionId) await send("Runtime.evaluate", { expression: REMOVE_OVERLAY_EXPR, returnByValue: true }, sessionId);
      } catch {
        /* best-effort */
      }
    };

    ws.on("open", () => {
      run().catch(() => finish(FAIL));
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return; // CDP event notification — ignore.
      const cb = pending.get(id);
      if (!cb) return;
      pending.delete(id);
      if (msg.error) cb(undefined, msg.error);
      else cb(msg.result as Record<string, unknown> | undefined);
    });

    ws.on("error", () => finish(FAIL));
  });
}
