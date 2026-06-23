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

/**
 * Crop a PNG to a viewport-CSS-px rectangle. Used ONLY by the dev-only vision
 * dataset capture (Phase 2B) to save a blocker-region crop of an ALREADY-REDACTED
 * frame — cropping after redaction can only remove pixels, never unredact. The box
 * is in viewport CSS px and scaled to image px exactly like `redactPngBoxes` so it
 * is correct under any deviceScaleFactor. The box is clamped to the image bounds.
 * Throws on decode/encode failure or an empty resulting rect so the caller can fall
 * back to the full frame. Coordinates are never logged or returned.
 */
export function cropPng(
  pngBase64: string,
  box: { x: number; y: number; w: number; h: number },
  viewport: { vw: number; vh: number },
): string {
  const png = PNG.sync.read(Buffer.from(pngBase64, "base64"));
  const scaleX = viewport.vw > 0 ? png.width / viewport.vw : 1;
  const scaleY = viewport.vh > 0 ? png.height / viewport.vh : 1;
  const x0 = Math.max(0, Math.min(png.width, Math.floor(box.x * scaleX)));
  const y0 = Math.max(0, Math.min(png.height, Math.floor(box.y * scaleY)));
  const x1 = Math.max(0, Math.min(png.width, Math.ceil((box.x + box.w) * scaleX)));
  const y1 = Math.max(0, Math.min(png.height, Math.ceil((box.y + box.h) * scaleY)));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) throw new Error("CROP_EMPTY");
  const dst = new PNG({ width: cw, height: ch });
  // Manual RGBA row copy of the (cw×ch) region at (x0,y0) → dst (0,0). Avoids
  // depending on a particular pngjs bitblt surface across the sync/stream APIs.
  for (let row = 0; row < ch; row++) {
    const srcStart = ((png.width * (y0 + row)) + x0) << 2;
    const dstStart = (cw * row) << 2;
    png.data.copy(dst.data, dstStart, srcStart, srcStart + (cw << 2));
  }
  return PNG.sync.write(dst).toString("base64");
}

/** Internal-only blocker-region geometry. NEVER logged, stored, or returned to agents. */
export interface BlockerCropBox {
  box: { x: number; y: number; w: number; h: number };
  viewport: { vw: number; vh: number };
}

// Rect-only probe for the dominant blocking surface. A simplified, self-contained
// mirror of `_domSurfaceProbe` in antigenSnapshotRuntime.ts (kept separate ON PURPOSE
// so blocker geometry never flows through the snapshot/signals/telemetry path). Raw JS
// string IIFE (the Node tsconfig has no DOM lib). Returns NUMBERS ONLY — no text,
// selectors, src, or values ever leave the page.
const BLOCKER_CROP_PROBE_EXPR = `(function(){
  try {
    var vw = window.innerWidth||0, vh = window.innerHeight||0;
    if(!(vw>0&&vh>0)) return { ok:false };
    function visRect(el){
      var r=null; try{ r=el.getBoundingClientRect(); }catch(e){ return null; }
      if(!r||!(r.width>0&&r.height>0)) return null;
      var cs=null; try{ cs=window.getComputedStyle?window.getComputedStyle(el):null; }catch(e){ cs=null; }
      if(cs){
        if(cs.display==='none'||cs.visibility==='hidden'||cs.visibility==='collapse') return null;
        if(String(cs.opacity)==='0') return null;
      }
      return r;
    }
    function onScreen(r){ return r.left<vw&&(r.left+r.width)>0&&r.top<vh&&(r.top+r.height)>0; }
    var best=null, bestZ=-1;
    // 1. A genuinely modal <dialog> is the strongest blocker signal.
    try {
      var dlgs=document.querySelectorAll('dialog');
      for(var i=0;i<dlgs.length;i++){
        var d=dlgs[i], isModal=false;
        try{ isModal=(d.open===true)||(d.matches&&d.matches(':modal'))||d.getAttribute('open')!=null; }catch(e){ isModal=false; }
        if(!isModal) continue;
        var rd=visRect(d); if(!rd||!onScreen(rd)) continue;
        best=rd; bestZ=1000000; break;
      }
    } catch(e){}
    // 2. Else the highest-z, center-ish, large fixed/absolute surface.
    if(!best){
      var nodes=document.querySelectorAll('div,section,aside,[role="dialog"],[role="alertdialog"]');
      for(var j=0;j<nodes.length&&j<400;j++){
        var n=nodes[j], cs2=null;
        try{ cs2=window.getComputedStyle?window.getComputedStyle(n):null; }catch(e){ cs2=null; }
        if(!cs2) continue;
        var p=cs2.position||''; if(p!=='fixed'&&p!=='absolute') continue;
        var r2=visRect(n); if(!r2||!onScreen(r2)) continue;
        if(!(r2.width>=200&&r2.height>=120)) continue;
        var cx=r2.left+r2.width/2, cy=r2.top+r2.height/2;
        if(!(cx>=0.2*vw&&cx<=0.8*vw&&cy>=0.15*vh&&cy<=0.85*vh)) continue;
        var z=parseInt(cs2.zIndex,10); if(isNaN(z)) z=0;
        if(z>=bestZ){ bestZ=z; best=r2; }
      }
    }
    // 3. Else the largest visible iframe (a common challenge host).
    if(!best){
      var frames=document.querySelectorAll('iframe');
      var fb=null, fa=0;
      for(var k=0;k<frames.length&&k<20;k++){
        var rf=visRect(frames[k]); if(!rf||!onScreen(rf)) continue;
        var area=rf.width*rf.height; if(area>fa){ fa=area; fb=rf; }
      }
      if(fb) best=fb;
    }
    if(!best) return { ok:false };
    return { ok:true, x:best.left, y:best.top, w:best.width, h:best.height, vw:vw, vh:vh };
  } catch(e){ return { ok:false }; }
})()`;

/**
 * Locate the dominant blocking surface's bounding box for dev-only dataset cropping.
 * Returns viewport-CSS-px geometry + the live viewport size, or null on ANY failure
 * (transport, attach, no surface, non-finite numbers, timeout). Caller treats null as
 * "no safe crop" and keeps the full viewport. Fail-safe: never throws, never logs the
 * box. This is the ONLY place blocker geometry is computed off the snapshot path.
 */
export async function computeBlockerCropBox(params: {
  browserWsUrl: string;
  pageTargetId: string;
}): Promise<BlockerCropBox | null> {
  const { browserWsUrl, pageTargetId } = params;
  return await new Promise<BlockerCropBox | null>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let settled = false;
    const pending = new Map<number, (r: Record<string, unknown> | undefined, e?: unknown) => void>();
    const finish = (r: BlockerCropBox | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), 8_000);

    const send = (
      method: string,
      p: Record<string, unknown> = {},
      sid?: string,
    ): Promise<Record<string, unknown> | undefined> =>
      new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, (result, error) => (error ? rej(error) : res(result)));
        const message: Record<string, unknown> = { id, method, params: p };
        if (sid) message.sessionId = sid;
        ws.send(JSON.stringify(message));
      });

    const run = async () => {
      const attach = await send("Target.attachToTarget", { targetId: pageTargetId, flatten: true });
      const sessionId = (attach?.sessionId as string) ?? null;
      if (!sessionId) return finish(null);
      const res = await send(
        "Runtime.evaluate",
        { expression: BLOCKER_CROP_PROBE_EXPR, returnByValue: true },
        sessionId,
      );
      const val = (res?.result as Record<string, unknown> | undefined)?.value as
        | { ok?: boolean; x?: number; y?: number; w?: number; h?: number; vw?: number; vh?: number }
        | undefined;
      if (!val?.ok) return finish(null);
      const nums = [val.x, val.y, val.w, val.h, val.vw, val.vh];
      if (nums.some((v) => typeof v !== "number" || !Number.isFinite(v))) return finish(null);
      return finish({
        box: { x: val.x as number, y: val.y as number, w: val.w as number, h: val.h as number },
        viewport: { vw: val.vw as number, vh: val.vh as number },
      });
    };

    ws.on("open", () => {
      run().catch(() => finish(null));
    });
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return;
      const cb = pending.get(id);
      if (!cb) return;
      pending.delete(id);
      if (msg.error) cb(undefined, msg.error);
      else cb(msg.result as Record<string, unknown> | undefined);
    });
    ws.on("error", () => finish(null));
  });
}

// Rect-only probe for a SMALLER, centered challenge-control candidate INSIDE a known
// dominant surface — the release-ready crop fallback used only when no live hold anchor
// exists. Kept as a SEPARATE expression from BLOCKER_CROP_PROBE_EXPR ON PURPOSE (that
// one is shared with dataset capture and must stay behavior-identical). Raw JS string
// IIFE (the Node tsconfig has no DOM lib). Receives the dominant box as numeric literals
// `__DX/__DY/__DW/__DH` (substituted by the caller) so candidates can be scoped to that
// surface. Returns NUMBERS ONLY — no text, selectors, src, or values ever leave the page.
const INNER_CONTROL_PROBE_EXPR_TEMPLATE = `(function(){
  try {
    var vw = window.innerWidth||0, vh = window.innerHeight||0;
    if(!(vw>0&&vh>0)) return { ok:false, count:0 };
    var DX=__DX, DY=__DY, DW=__DW, DH=__DH;
    function visRect(el){
      var r=null; try{ r=el.getBoundingClientRect(); }catch(e){ return null; }
      if(!r||!(r.width>0&&r.height>0)) return null;
      var cs=null; try{ cs=window.getComputedStyle?window.getComputedStyle(el):null; }catch(e){ cs=null; }
      if(cs){
        if(cs.display==='none'||cs.visibility==='hidden'||cs.visibility==='collapse') return null;
        if(String(cs.opacity)==='0') return null;
      }
      return r;
    }
    function onScreen(r){ return r.left<vw&&(r.left+r.width)>0&&r.top<vh&&(r.top+r.height)>0; }
    function inDom(cx,cy){
      // No dominant box → accept anything on-screen. Else require the candidate center
      // to fall inside the dominant surface (with a small slack for sub-pixel rounding).
      if(!(DW>0&&DH>0)) return true;
      return cx>=DX-2&&cx<=DX+DW+2&&cy>=DY-2&&cy<=DY+DH+2;
    }
    // Likely press-and-hold controls: real interactive elements + a same-origin iframe
    // (a common challenge host whose element rect IS visible even when its content is
    // cross-origin) + a few class/aria hints. Generic + bounded; no site hardcode.
    var sel = 'button,[role="button"],[role="slider"],canvas,input[type="button"],input[type="submit"],a[role="button"],iframe,[class*="press"],[class*="hold"],[class*="slider"],[class*="challenge"],[class*="captcha"],[class*="verify"],[aria-label]';
    var nodes=document.querySelectorAll(sel);
    var count=0, best=null, bestScore=Infinity;
    var cxv=vw/2, cyv=vh/2;
    for(var i=0;i<nodes.length&&i<600;i++){
      var r=visRect(nodes[i]); if(!r||!onScreen(r)) continue;
      var w=r.width, h=r.height, frac=(w*h)/(vw*vh);
      // Compact control gate: not the scrim/modal itself, not pixel noise.
      if(frac<0.0008||frac>=0.6) continue;
      if(w<32||h<16) continue;
      var ccx=r.left+w/2, ccy=r.top+h/2;
      if(!inDom(ccx,ccy)) continue;
      count++;
      // Prefer compact + centered: smaller distance-to-center AND smaller area win.
      var dist=Math.hypot((ccx-cxv)/vw,(ccy-cyv)/vh);
      var score=dist+frac;
      if(score<bestScore){ bestScore=score; best=r; }
    }
    if(!best) return { ok:false, count:count };
    return { ok:true, x:best.left, y:best.top, w:best.width, h:best.height, vw:vw, vh:vh, count:count };
  } catch(e){ return { ok:false, count:0 }; }
})()`;

/** Internal-only inner-control crop result. `best` geometry is NEVER logged/returned. */
export interface InnerControlCropResult {
  best: BlockerCropBox | null;
  /** Coarse number of in-surface candidates considered (for bucketed telemetry only). */
  candidate_count: number;
}

/**
 * Locate a smaller, centered challenge-control candidate INSIDE the given dominant
 * `within` box (release-ready fallback for an oversized dominant crop). Returns the best
 * candidate's box + the live viewport, plus a candidate count, or `{ best:null, count:0 }`
 * on ANY failure (transport, attach, no candidate, non-finite). Geometry stays internal:
 * the box is consumed by the local crop and discarded; only the count buckets into a log.
 * Fail-safe: never throws, never logs the box. Separate from `computeBlockerCropBox`.
 */
export async function computeInnerControlCropBox(params: {
  browserWsUrl: string;
  pageTargetId: string;
  within: { x: number; y: number; w: number; h: number };
}): Promise<InnerControlCropResult> {
  const { browserWsUrl, pageTargetId, within } = params;
  const numOrZero = (v: number): string => (Number.isFinite(v) ? String(v) : "0");
  const expression = INNER_CONTROL_PROBE_EXPR_TEMPLATE.replace("__DX", numOrZero(within.x))
    .replace("__DY", numOrZero(within.y))
    .replace("__DW", numOrZero(within.w))
    .replace("__DH", numOrZero(within.h));
  return await new Promise<InnerControlCropResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let settled = false;
    const pending = new Map<number, (r: Record<string, unknown> | undefined, e?: unknown) => void>();
    const finish = (r: InnerControlCropResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const fail = () => finish({ best: null, candidate_count: 0 });
    const timer = setTimeout(fail, 8_000);

    const send = (
      method: string,
      p: Record<string, unknown> = {},
      sid?: string,
    ): Promise<Record<string, unknown> | undefined> =>
      new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, (result, error) => (error ? rej(error) : res(result)));
        const message: Record<string, unknown> = { id, method, params: p };
        if (sid) message.sessionId = sid;
        ws.send(JSON.stringify(message));
      });

    const run = async () => {
      const attach = await send("Target.attachToTarget", { targetId: pageTargetId, flatten: true });
      const sessionId = (attach?.sessionId as string) ?? null;
      if (!sessionId) return fail();
      const res = await send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
      );
      const val = (res?.result as Record<string, unknown> | undefined)?.value as
        | { ok?: boolean; x?: number; y?: number; w?: number; h?: number; vw?: number; vh?: number; count?: number }
        | undefined;
      const count = typeof val?.count === "number" && Number.isFinite(val.count) ? val.count : 0;
      if (!val?.ok) return finish({ best: null, candidate_count: count });
      const nums = [val.x, val.y, val.w, val.h, val.vw, val.vh];
      if (nums.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        return finish({ best: null, candidate_count: count });
      }
      return finish({
        best: {
          box: { x: val.x as number, y: val.y as number, w: val.w as number, h: val.h as number },
          viewport: { vw: val.vw as number, vh: val.vh as number },
        },
        candidate_count: count,
      });
    };

    ws.on("open", () => {
      run().catch(fail);
    });
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return;
      const cb = pending.get(id);
      if (!cb) return;
      pending.delete(id);
      if (msg.error) cb(undefined, msg.error);
      else cb(msg.result as Record<string, unknown> | undefined);
    });
    ws.on("error", fail);
  });
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
