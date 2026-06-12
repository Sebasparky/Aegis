import WebSocket from "ws";
import { PNG } from "pngjs";

import { BrowserTimingScope } from "./browserTiming.js";
import { fieldRemaskSelectors } from "./paymentCardFill.js";
import type { ProtectedTopLevelFieldKind } from "./protectedIframeRedaction.js";

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
  /**
   * Protected card fields that Antigen filled inside a cross-origin OPPWA PCI
   * iframe in this session (from the protected-iframe redaction registry). For
   * each one, the matching top-document <iframe> element is marked
   * `data-antigen-masked="true"` so its bounding box is redacted. If any expected
   * field's iframe cannot be located/sized, capture FAILS CLOSED — no image. The
   * top document only reads the parent-owned `src` attribute and bounding box;
   * iframe internals are never inspected.
   */
  expectedIframeFields?: Array<"card_number" | "cvv" | "expiry">;
  /**
   * Protected card fields Antigen filled on the TOP document with visualMask in
   * this session (from the top-level redaction registry). The fill-time
   * `data-antigen-masked` marker can be wiped when a hydrated checkout re-renders
   * the node after the fill (OPPWA widget re-init — the live IKEA expiry leak), so
   * for each expected field the capture path VERIFIES a live, visible masked node
   * of that kind still exists, and otherwise re-locates the field by precise
   * field-specific selectors and re-applies the mask. If a field can neither be
   * verified nor safely re-located, capture FAILS CLOSED with
   * `redaction_mismatch` — it never reports full redaction while a protected
   * value may be visible.
   */
  expectedTopLevelFields?: ProtectedTopLevelFieldKind[];
}

export type CaptureRedactedScreenshotResult =
  | { ok: true; base64: string; mimeType: "image/png"; redacted_field_count: number }
  | {
      ok: false;
      error_code: "SCREENSHOT_REDACTION_FAILED";
      /** True when an expected protected top-level field could not be verified or re-masked. */
      redaction_mismatch?: true;
      /** Field-kind enums only — never selectors, boxes, or values. */
      missing_field_kinds?: ProtectedTopLevelFieldKind[];
    };

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

// Mark the top-document <iframe> elements that host the protected card fields the
// caller knows were filled inside cross-origin OPPWA PCI iframes. Reads only the
// parent-owned `src` attribute + bounding box — never iframe internals. Tags each
// located iframe `data-antigen-masked="true"` so the OVERLAY_EXPR enumerator
// collects and redacts its rectangle. Returns the kinds it could actually mark
// (sized, non-zero box) so the caller can FAIL CLOSED on any miss. Match logic
// mirrors `pickOppwaIframeIndexForField` in paymentIframeFill.ts.
function buildIframeMarkExpr(fields: Array<"card_number" | "cvv" | "expiry">): string {
  return `(function(fields){
  try {
    var iframes = Array.prototype.slice.call(document.querySelectorAll('iframe'));
    var oppwa = [];
    for (var i = 0; i < iframes.length; i++) {
      try {
        var u = new URL(iframes[i].src);
        if (u.hostname.endsWith('oppwa.com') && u.pathname === '/v1/pciIframe.html') {
          oppwa.push(iframes[i]);
        }
      } catch (e) {}
    }
    function byName(name) {
      for (var j = 0; j < oppwa.length; j++) {
        try { if (new URL(oppwa[j].src).searchParams.get('name') === name) return oppwa[j]; } catch (e) {}
      }
      return null;
    }
    var marked = [];
    for (var k = 0; k < fields.length; k++) {
      var fk = fields[k];
      var el = null;
      if (fk === 'card_number') { el = byName('card.number') || oppwa[0] || null; }
      else if (fk === 'cvv') { el = byName('card.cvv') || (oppwa.length > 1 ? oppwa[1] : null); }
      else if (fk === 'expiry') { el = byName('card.expiry') || byName('card.expiryMonth') || (oppwa.length > 2 ? oppwa[2] : null); }
      if (!el) continue;
      var r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      el.setAttribute('data-antigen-masked', 'true');
      el.setAttribute('data-antigen-filled', 'true');
      el.setAttribute('data-antigen-iframe-field', fk);
      marked.push(fk);
    }
    return { ok: true, marked: marked };
  } catch (e) { return { ok: false, reason: String(e) }; }
})(${JSON.stringify(fields)})`;
}

/**
 * Verify-or-remask expression for protected TOP-LEVEL card fields. For each expected
 * field kind:
 *   1. covered if a live, VISIBLE element still carries
 *      `data-antigen-masked="true"` + `data-antigen-field="<kind>"` (fill-time tag);
 *   2. otherwise re-locate the field by its precise selector list (first VISIBLE
 *      match in priority order — hydrated widgets keep hidden original inputs, so
 *      visibility is the discriminator) and re-apply the visual mask + tags. The
 *      style blocks mirror protectedRealisticFill.ts — keep them in sync;
 *   3. otherwise the kind is reported `missing` so the caller can FAIL CLOSED.
 * Never reads or embeds any value; returns field-kind enums only.
 * Exported for unit testing.
 */
export function buildTopLevelRemaskExpr(fields: ProtectedTopLevelFieldKind[]): string {
  const selectorMap: Record<string, string[]> = {};
  for (const f of fields) selectorMap[f] = fieldRemaskSelectors(f);
  return `(function(map){
  try {
    function visible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      var s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    }
    function remask(el, kind) {
      if (el.tagName === 'SELECT') {
        el.style.setProperty('color', 'transparent', 'important');
        el.style.setProperty('text-shadow', '0 0 7px rgba(0,0,0,0.6)', 'important');
      } else {
        el.style.setProperty('-webkit-text-security', 'disc', 'important');
        el.style.setProperty('text-security', 'disc', 'important');
      }
      el.style.setProperty('outline', '2px solid #ff5000', 'important');
      el.style.setProperty('outline-offset', '1px', 'important');
      el.setAttribute('title', 'Filled by Antigen');
      el.setAttribute('data-antigen-masked', 'true');
      el.setAttribute('data-antigen-field', kind);
    }
    var covered = [], remasked = [], missing = [];
    for (var kind in map) {
      var tagged = document.querySelectorAll('[data-antigen-masked="true"][data-antigen-field="' + kind + '"]');
      var ok = false;
      for (var i = 0; i < tagged.length; i++) { if (visible(tagged[i])) { ok = true; break; } }
      if (ok) { covered.push(kind); continue; }
      var sels = map[kind];
      var el = null;
      for (var j = 0; j < sels.length && !el; j++) {
        var cands;
        try { cands = document.querySelectorAll(sels[j]); } catch (e) { continue; }
        for (var k = 0; k < cands.length; k++) { if (visible(cands[k])) { el = cands[k]; break; } }
      }
      if (!el) { missing.push(kind); continue; }
      try { remask(el, kind); remasked.push(kind); } catch (e) { missing.push(kind); }
    }
    return { ok: true, covered: covered, remasked: remasked, missing: missing };
  } catch (e) { return { ok: false, reason: String(e) }; }
})(${JSON.stringify(selectorMap)})`;
}

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
  const { browserWsUrl, pageTargetId, expectedIframeFields = [], expectedTopLevelFields = [] } = params;

  // Dev-only latency markers (gated). Sanitized: stage labels + durations +
  // counts only — never image bytes, boxes, URLs, or field values.
  const timing = new BrowserTimingScope("antigen_screenshot_redacted");

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
      timing.end({
        ok: result.ok,
        redacted_field_count: result.ok ? result.redacted_field_count : undefined,
        iframe_fields: expectedIframeFields.length,
        png_kb: result.ok && result.base64 ? Math.round((result.base64.length * 3) / 4096) : undefined,
      });
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
      timing.mark("connect_attach");

      // 0. Mark the cross-origin OPPWA iframe containers for any protected card
      //    field the caller knows was filled. FAIL CLOSED if any expected field's
      //    iframe rectangle cannot be located/sized — never return an image that
      //    leaves a filled PAN/CVV iframe visible.
      if (expectedIframeFields.length > 0) {
        const markRes = await send(
          "Runtime.evaluate",
          { expression: buildIframeMarkExpr(expectedIframeFields), returnByValue: true },
          sessionId,
        );
        const markVal = (markRes?.result as Record<string, unknown> | undefined)?.value as
          | { ok?: boolean; marked?: string[] }
          | undefined;
        if (!markVal?.ok) return finish(FAIL);
        const marked = Array.isArray(markVal.marked) ? markVal.marked : [];
        for (const field of expectedIframeFields) {
          if (!marked.includes(field)) return finish(FAIL);
        }
      }
      timing.mark("iframe_mark");

      // 0b. Verify/re-mask the protected TOP-LEVEL fields. A later page re-render
      //     (OPPWA widget re-init) may have replaced a masked node, wiping its
      //     fill-time marker — the live IKEA expiry leak. Each expected field must
      //     either still have a live visible masked node or be safely re-located and
      //     re-masked; anything else FAILS CLOSED with redaction_mismatch. Never
      //     report full redaction while a protected value may be visible.
      if (expectedTopLevelFields.length > 0) {
        const remaskRes = await send(
          "Runtime.evaluate",
          { expression: buildTopLevelRemaskExpr(expectedTopLevelFields), returnByValue: true },
          sessionId,
        );
        const remaskVal = (remaskRes?.result as Record<string, unknown> | undefined)?.value as
          | { ok?: boolean; covered?: string[]; remasked?: string[]; missing?: string[] }
          | undefined;
        if (!remaskVal?.ok) return finish(FAIL);
        const missing = (Array.isArray(remaskVal.missing) ? remaskVal.missing : []).filter(
          (m): m is ProtectedTopLevelFieldKind =>
            (expectedTopLevelFields as string[]).includes(m as string),
        );
        if (missing.length > 0) {
          return finish({
            ok: false,
            error_code: "SCREENSHOT_REDACTION_FAILED",
            redaction_mismatch: true,
            missing_field_kinds: missing,
          });
        }
      }
      timing.mark("toplevel_remask");

      // 1. Lay overlay boxes and collect the registered-field rects.
      const overlayRes = await send("Runtime.evaluate", { expression: OVERLAY_EXPR, returnByValue: true }, sessionId);
      const overlayVal = (overlayRes?.result as Record<string, unknown> | undefined)?.value as
        | { ok?: boolean; boxes?: RedactBox[]; vw?: number; vh?: number }
        | undefined;
      if (!overlayVal?.ok) return finish(FAIL);
      const boxes = Array.isArray(overlayVal.boxes) ? overlayVal.boxes : [];
      const vw = typeof overlayVal.vw === "number" ? overlayVal.vw : 0;
      const vh = typeof overlayVal.vh === "number" ? overlayVal.vh : 0;
      timing.mark("overlay_eval");

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
      timing.mark("capture");

      // 3. Pixel-pass fail-safe: black out the field rectangles in the image bytes.
      let redacted: string;
      try {
        redacted = boxes.length > 0 ? redactPngBoxes(captured, boxes, { vw, vh }) : captured;
      } catch {
        await removeOverlay();
        return finish(FAIL);
      }
      timing.mark("png_redact");

      // 4. Remove the temporary capture-only overlay so the live UI keeps the lighter
      //    text-security mask, not opaque boxes. Best-effort — never blocks the result.
      await removeOverlay();
      timing.mark("cleanup_eval");

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
