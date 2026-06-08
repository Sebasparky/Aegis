/**
 * Antigen Known-Box Revalidation (Phase 4B) — lightweight stale-ref guardrail.
 *
 * Phase 4A clicks an exact `ag_*` ref by handing the stored internal box to the
 * realistic pointer runtime. That trusts the box blindly. Modern pages shift
 * between snapshot and click (cookie banners, lazy grids, settling images,
 * modals, scroll, SPA swaps, intervening agent actions), so the stored box can
 * point at a *different* live element by click time.
 *
 * This module adds a single, conservative check: inspect the live element under
 * the stored box center via `document.elementFromPoint`, then confirm it is
 * broadly compatible with the snapshot element. It NEVER clicks, dispatches
 * events, scores, or rediscovers alternatives — it only reads. The caller
 * (realisticClickKnownBox) fails closed with ANTIGEN_REF_STALE when this returns
 * a stale result, before any pointer movement.
 *
 * Reuse: the live element's kind / normalized_name / href_path / enabled are
 * derived with the SAME pure helpers the snapshot uses (inferKind, normalizeName,
 * hrefPath, computeEnabled from antigenSnapshotRuntime.ts) — single source of
 * truth, no duplicated inference.
 *
 * The page-side IIFE is a raw JS string (NOT a TypeScript arrow function): the
 * Node tsconfig has no DOM lib, so DOM code lives in strings evaluated in the
 * page via CDP Runtime.evaluate — same convention as buildElementFindExpr /
 * buildAntigenExtractionExpr.
 *
 * Secret-safety invariants (asserted in tests):
 * - The IIFE reads `.value` ONLY for input[type=submit|button|reset] (button
 *   label). Never for password/hidden/text/payment/identity fields.
 * - Returned live metadata carries only safe semantic signals — never raw HTML,
 *   full text dumps, input values, cookies, storage, or profile paths.
 * - Diagnostics expose only kinds + accessible names (already surfaced in the
 *   snapshot external view) and are for server logs only — never returned to the
 *   agent in API/adapter output by the caller.
 */

import {
  inferKind,
  normalizeName,
  hrefPath,
  computeEnabled,
  type RawAntigenCandidate,
} from "./antigenSnapshotRuntime.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Snapshot-side metadata the live element is checked against. */
export interface AntigenKnownBoxRevalidationExpected {
  tag?: string | null;
  kind?: string | null;
  role?: string | null;
  name?: string | null;
  normalized_name?: string | null;
  href_path?: string | null;
}

export type AntigenKnownBoxRevalidationReason =
  | "NO_ELEMENT_AT_POINT"
  | "LIVE_ELEMENT_NOT_VISIBLE"
  | "NAME_MISMATCH"
  | "ROLE_KIND_MISMATCH"
  | "HREF_PATH_MISMATCH"
  | "BOX_OUT_OF_VIEWPORT";

export type AntigenKnownBoxRevalidationResult =
  | { status: "ok" }
  | {
      status: "stale";
      reason: AntigenKnownBoxRevalidationReason;
      diagnostic?: {
        expected_kind?: string;
        live_kind?: string;
        expected_name?: string;
        live_name?: string;
      };
    };

/**
 * Raw live record returned by the page-side IIFE for the chosen live element.
 * Shape matches RawAntigenCandidate (minus index) so the existing snapshot
 * derivation helpers can be applied directly. `visible` is computed page-side
 * (non-zero box + not display:none/visibility:hidden/opacity:0/aria-hidden).
 */
export interface RawLiveElement extends RawAntigenCandidate {
  visible: boolean;
}

/** Discriminated payload the IIFE resolves to (via returnByValue). */
export type AntigenRevalidationEvalValue =
  | { vw: number; vh: number; status: "out_of_viewport" }
  | { vw: number; vh: number; status: "no_element" }
  | { vw: number; vh: number; status: "ok"; live: RawLiveElement };

// ─── Page-side IIFE builder ──────────────────────────────────────────────────

/**
 * Builds the raw JS-string IIFE evaluated in the page via Runtime.evaluate.
 *
 * It reads viewport dims, bails when the center is outside the viewport, calls
 * document.elementFromPoint(centerX, centerY), walks up to ~5 ancestors to find
 * a meaningful interactive element, and returns safe metadata for it. It never
 * clicks or mutates the DOM.
 *
 * centerX / centerY are JSON.stringify-encoded — never raw-concatenated.
 */
export function buildAntigenRevalidationExpr(centerX: number, centerY: number): string {
  const cx = JSON.stringify(centerX);
  const cy = JSON.stringify(centerY);

  return `(function(){
    var CX=${cx}, CY=${cy};
    var vw=window.innerWidth, vh=window.innerHeight;
    if(!(CX>=0&&CX<=vw&&CY>=0&&CY<=vh)) return {vw:vw,vh:vh,status:"out_of_viewport"};
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
    function isVisible(el){
      try{
        var r=el.getBoundingClientRect();
        if(!(r.width>0&&r.height>0)) return false;
        var cs=null; try{ cs=(window.getComputedStyle?window.getComputedStyle(el):null); }catch(e){ cs=null; }
        if(cs){
          if(cs.display==='none') return false;
          if(cs.visibility==='hidden'||cs.visibility==='collapse') return false;
          if(String(cs.opacity)==='0') return false;
        }
        if(attr(el,'aria-hidden')==='true') return false;
        return true;
      }catch(e){ return false; }
    }
    function nameOf(el,tag,type){
      var al=attr(el,'aria-label'); if(txt(al)) return txt(al);
      var lb=attr(el,'aria-labelledby');
      if(lb){
        var ids=lb.split(/\\s+/); var parts=[];
        for(var i=0;i<ids.length;i++){ try{ var ref=document.getElementById(ids[i]); if(ref) parts.push(ref.textContent||''); }catch(e){} }
        var t=txt(parts.join(' ')); if(t) return t;
      }
      try{
        if(el.labels&&el.labels.length){
          var lp=[]; for(var j=0;j<el.labels.length;j++){ lp.push(el.labels[j].textContent||''); }
          var lt=txt(lp.join(' ')); if(lt) return lt;
        }
      }catch(e){}
      try{ if(el.querySelector){ var img=el.querySelector('img'); if(img){ var a=attr(img,'alt'); if(txt(a)) return txt(a); } } }catch(e){}
      var ti=attr(el,'title'); if(txt(ti)) return txt(ti);
      // value is read ONLY for submit/button/reset inputs (the button label).
      if(tag==='input'&&(type==='submit'||type==='button'||type==='reset')){
        try{ if(el.value!=null){ var v=txt(el.value); if(v) return v; } }catch(e){}
      }
      var it=null; try{ it=(el.innerText!=null?el.innerText:el.textContent); }catch(e){ it=null; }
      if(txt(it)) return txt(it);
      var ph=attr(el,'placeholder'); if(txt(ph)) return txt(ph);
      return '';
    }
    var hit=null; try{ hit=document.elementFromPoint(CX,CY); }catch(e){ hit=null; }
    if(!hit) return {vw:vw,vh:vh,status:"no_element"};
    var INTERACTIVE='a[href],button,input,textarea,select,[role],[tabindex],[contenteditable="true"],summary';
    var node=hit, hops=0, chosen=null;
    while(node&&hops<5){
      try{ if(node.matches&&node.matches(INTERACTIVE)){ chosen=node; break; } }catch(e){}
      node=node.parentElement; hops++;
    }
    if(!chosen) chosen=hit;
    var tag=(chosen.tagName||'').toLowerCase();
    var rawType=attr(chosen,'type');
    var type=rawType?String(rawType).toLowerCase():(tag==='input'?'text':null);
    var contentEditable=false;
    try{ contentEditable=(chosen.isContentEditable===true)||(attr(chosen,'contenteditable')==='true'); }catch(e){ contentEditable=false; }
    var nm=nameOf(chosen,tag,type);
    if(nm&&nm.length>160) nm=nm.slice(0,160);
    var r=chosen.getBoundingClientRect();
    return {vw:vw,vh:vh,status:"ok",live:{
      tag: tag,
      type: type,
      role: attr(chosen,'role'),
      content_editable: contentEditable,
      id: attr(chosen,'id'),
      href: attr(chosen,'href'),
      disabled: chosen.disabled===true,
      aria_disabled: attr(chosen,'aria-disabled')==='true',
      read_only: chosen.readOnly===true,
      name: nm,
      box: { x:r.left, y:r.top, width:r.width, height:r.height },
      visible: isVisible(chosen)
    }};
  })()`;
}

// ─── Pure compatibility evaluator ────────────────────────────────────────────

/** Conservative kind compatibility. Click-relevant kinds only; others permissive. */
function kindsCompatible(expectedKind: string | null | undefined, liveKind: string): boolean {
  switch (expectedKind) {
    case "link":
      return liveKind === "link";
    case "button":
      return liveKind === "button" || liveKind === "control";
    case "control":
      return liveKind === "control" || liveKind === "button";
    case "select":
      return liveKind === "select";
    case "summary":
      return liveKind === "summary" || liveKind === "button";
    default:
      // input / textarea / editable / unknown / unset — do not block on kind.
      return true;
  }
}

/** Exact match, or one a substring of the other (shorter length ≥ 2 — short UI labels). */
function namesCompatible(expected: string, live: string): boolean {
  if (expected === live) return true;
  if (!live) return false;
  const shorter = expected.length <= live.length ? expected : live;
  const longer = expected.length <= live.length ? live : expected;
  if (shorter.length < 2) return false;
  return longer.includes(shorter);
}

/**
 * Compares a single live element (raw, from any page-side IIFE) against the
 * snapshot's expected metadata. Pure — no CDP, no geometry. Fails closed on
 * strong mismatch. This is the single source of truth for "is this live element
 * logically the same element the snapshot ref pointed at" — reused both by
 * Phase 4B known-box revalidation (the element under the stored box center) and
 * by same-page logical-ref recovery (candidate elements found elsewhere on the
 * page). Diagnostics carry only kinds + accessible names; callers keep them out
 * of agent-facing output.
 */
export function compareLiveToExpected(
  live: RawLiveElement,
  expected: AntigenKnownBoxRevalidationExpected,
): AntigenKnownBoxRevalidationResult {
  const liveKind = inferKind(live);
  const liveNormalizedName = normalizeName(live.name);
  const liveHrefPath = hrefPath(live.href);
  const liveEnabled = computeEnabled(live);

  const diagnostic = {
    ...(expected.kind ? { expected_kind: expected.kind } : {}),
    live_kind: liveKind,
    ...(expected.name ? { expected_name: expected.name } : {}),
    ...(live.name ? { live_name: live.name } : {}),
  };

  if (!live.visible || !liveEnabled) {
    return { status: "stale", reason: "LIVE_ELEMENT_NOT_VISIBLE", diagnostic };
  }

  // href_path is the strongest link signal — must match exactly when expected has one.
  if (expected.href_path) {
    if (liveHrefPath !== expected.href_path) {
      return { status: "stale", reason: "HREF_PATH_MISMATCH", diagnostic };
    }
  }

  if (!kindsCompatible(expected.kind, liveKind)) {
    return { status: "stale", reason: "ROLE_KIND_MISMATCH", diagnostic };
  }

  // Name check only when the snapshot element carried a meaningful name.
  const expectedNormalized = (expected.normalized_name ?? "").trim();
  if (expectedNormalized) {
    if (!namesCompatible(expectedNormalized, liveNormalizedName)) {
      return { status: "stale", reason: "NAME_MISMATCH", diagnostic };
    }
  }

  return { status: "ok" };
}

/**
 * Compares the live element (raw, from the IIFE) against the snapshot's expected
 * metadata. Pure — no CDP. Fails closed on strong mismatch. Diagnostics carry
 * only kinds + accessible names; the caller keeps them out of agent-facing output.
 */
export function evaluateKnownBoxRevalidation(input: {
  eval: AntigenRevalidationEvalValue;
  expected: AntigenKnownBoxRevalidationExpected;
}): AntigenKnownBoxRevalidationResult {
  const ev = input.eval;

  if (ev.status === "out_of_viewport") return { status: "stale", reason: "BOX_OUT_OF_VIEWPORT" };
  if (ev.status === "no_element") return { status: "stale", reason: "NO_ELEMENT_AT_POINT" };

  return compareLiveToExpected(ev.live, input.expected);
}
