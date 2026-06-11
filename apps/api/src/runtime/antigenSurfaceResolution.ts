/**
 * Antigen Surface-Scoped Live Resolution (ANTIGEN_SURFACE_RESOLVE, default-off).
 *
 * Slice 2 of the surface model. Problem: SPA pages (IKEA add-to-bag panel,
 * header/cart hydration) re-render faster than the snapshot→click lifecycle, so
 * an ag_* ref inside an active overlay goes ANTIGEN_REF_STALE even though the
 * SEMANTICALLY identical action ("Go to shopping bag" inside the dialog titled
 * "GLIMMA was added to your shopping bag") is still right there. Page-wide
 * logical recovery can lose the same race and matches against the whole page.
 *
 * This module re-resolves a stale surface-member ref by its SEMANTIC identity,
 * scoped to its live surface:
 *
 *   surface identity (overlay_type + accessible title)
 *     → find the live surface (singleton relaxation when titles churn)
 *     → find the UNIQUE compatible, unoccluded action inside that surface
 *     → propose its fresh box
 *
 * The caller then re-runs the unchanged realisticClickKnownBox on the proposed
 * box — Phase 4B remains the authoritative final gate. Resolution only
 * PROPOSES; it never clicks, types, or mutates the DOM.
 *
 * Hard safety boundaries (enforced here + at the endpoint):
 * - Default OFF (env flag). Flag off is byte-for-byte today's behavior.
 * - Click-only, and ONLY for clearly low-risk intents (navigation /
 *   cart_mutation / checkout_transition). Final / sensitive / payment / auth
 *   targets are refused via the SAME sensitive denylist logical recovery uses
 *   (classifyLogicalRecoveryEligibility → ineligible_sensitive ⇒ refuse).
 * - Surface members NEVER fall back to a page-wide match: surface gone ⇒ fail
 *   closed (SURFACE-level failure is itself signal — the panel dismissed).
 * - Uniqueness required at BOTH levels: ambiguous surface ⇒ refuse; ambiguous
 *   action within the surface ⇒ refuse.
 * - Identity matching reuses compareLiveToExpected (single source of truth with
 *   Phase 4B); occlusion is checked page-side via elementFromPoint.
 * - Live intent re-check (defense in depth): the resolved live element is
 *   re-classified and must still be a low-risk reversible intent — otherwise
 *   intent drift ⇒ refuse.
 *
 * Secret-safety: the page-side IIFE reads `.value` ONLY for
 * input[type=submit|button|reset] (button label) — same restriction as Phase 4B
 * — and returns only safe semantic descriptors + boxes. Boxes are internal-only.
 * Agent-facing output carries only the enum surface_resolution_state.
 *
 * The page-side IIFE is a raw JS string (the Node tsconfig has no DOM lib) —
 * same convention as buildAntigenRevalidationExpr / buildAntigenExtractionExpr.
 */

import WebSocket from "ws";
import { pickBestPageTarget } from "./cdpTargetSelection.js";
import { isAntigenPageChanged } from "./antigenSnapshotStore.js";
import { normalizeName, hrefPath, buildOverlaySnippetJs, inferKind } from "./antigenSnapshotRuntime.js";
import {
  compareLiveToExpected,
  type AntigenKnownBoxRevalidationExpected,
  type RawLiveElement,
} from "./antigenKnownBoxRevalidation.js";
import { classifyLogicalRecoveryEligibility } from "./antigenLogicalRecovery.js";
import { classifyActionIntent } from "../detection/actionIntent.js";
import type { ActionIntent, RiskState } from "@aegis/types";
import type { ElementBox } from "./nativePointerRuntime.js";

// ─── Env gate ────────────────────────────────────────────────────────────────

/** Surface resolution is strictly opt-in. Default OFF preserves current behavior. */
export function isSurfaceResolveEnabled(): boolean {
  return process.env.ANTIGEN_SURFACE_RESOLVE === "true";
}

// ─── Surface identity ────────────────────────────────────────────────────────

/**
 * Semantic surface identity stored on the snapshot element's overlay membership.
 * Durable across re-renders by construction: type + accessible title — never a
 * node, box, or selector.
 */
export interface SurfaceIdentity {
  overlay_type: string;
  modal_title?: string | null;
}

// ─── Eligibility (pure, default-deny) ────────────────────────────────────────

/** Clearly low-risk, reversible click intents — the only ones that may live-resolve. */
export const SURFACE_RESOLVE_LOW_RISK_INTENTS: ReadonlySet<string> = new Set([
  "navigation",
  "cart_mutation",
  "checkout_transition",
]);

/**
 * A surface-member stale ref may live-resolve only when (a) the action gate
 * already classified the click as a low-risk reversible intent AND (b) the
 * target's name does not hit the sensitive-commit denylist (checkout / pay /
 * place order / sign in / delete / authorize / …). Unlike page-wide logical
 * recovery there is NO low-risk name allowlist: the surface scope + uniqueness
 * + live intent re-check + Phase 4B replace it. The denylist still wins first.
 */
export function isSurfaceResolutionEligible(
  expected: AntigenKnownBoxRevalidationExpected,
  actionIntent: string,
): boolean {
  if (!SURFACE_RESOLVE_LOW_RISK_INTENTS.has(actionIntent)) return false;
  const cls = classifyLogicalRecoveryEligibility(expected, "click");
  if (cls.risk_class === "ineligible_sensitive") return false;
  return true;
}

// ─── Live intent re-check (defense in depth) ─────────────────────────────────

/**
 * Re-classifies the RESOLVED live element's intent from its live structural
 * metadata. The unique match already passed compareLiveToExpected, so a drift
 * here should be impossible — this is the belt-and-braces guard that a matcher
 * gap can never promote a stale low-risk ref onto a commit-shaped live element.
 */
export function checkSurfaceLiveIntent(
  live: { name: string; kind: string; href_path: string | null },
  opts: { url?: string; risk_state?: RiskState },
): { ok: boolean; live_intent: ActionIntent } {
  const cls = classifyActionIntent({
    action: "click",
    text: live.name,
    kind: live.kind,
    href_path: live.href_path,
    url: opts.url,
    risk_state: opts.risk_state,
  });
  return {
    ok: cls.reversibility === "reversible" && SURFACE_RESOLVE_LOW_RISK_INTENTS.has(cls.action_intent),
    live_intent: cls.action_intent,
  };
}

// ─── Resolution state (for responses + trace; enum-gated) ────────────────────

export type AntigenSurfaceResolutionState =
  | "disabled" // flag off — never attempted
  | "skipped_ineligible" // flag on, but intent/denylist/sensitive refused it
  | "resolved" // unique surface action re-resolved, re-validated, dispatched
  | "failed_surface_gone" // the surface no longer exists (panel dismissed)
  | "failed_surface_ambiguous" // >1 live surface matches the identity
  | "failed_action_ambiguous" // >1 compatible unoccluded action in the surface
  | "failed_action_not_found" // no compatible (or no unoccluded) action
  | "failed_intent_drift" // live element re-classified as non-low-risk
  | "failed_revalidation" // fresh box proposed, but Phase 4B re-click failed
  | "failed_page_changed" // page navigated since the snapshot
  | "failed_cdp"; // CDP/search error

export const ANTIGEN_SURFACE_RESOLUTION_STATES: ReadonlySet<AntigenSurfaceResolutionState> = new Set([
  "disabled",
  "skipped_ineligible",
  "resolved",
  "failed_surface_gone",
  "failed_surface_ambiguous",
  "failed_action_ambiguous",
  "failed_action_not_found",
  "failed_intent_drift",
  "failed_revalidation",
  "failed_page_changed",
  "failed_cdp",
]);

// ─── Page-side search IIFE ───────────────────────────────────────────────────

/** Upper bound on surface-member candidates returned from the page. */
const MAX_SURFACE_CANDIDATES = 200;

/**
 * Raw live surface-member candidate: safe identity descriptor + box + overlay
 * membership + an occlusion probe. Only elements INSIDE a real (non-background)
 * overlay are returned — the page never reports background/header elements here.
 */
export interface RawSurfaceCandidate extends RawLiveElement {
  box: ElementBox;
  /** Live surface membership (named `surface`, not `overlay` — the base
   *  candidate type reserves `overlay` for the full AntigenOverlayInfo shape). */
  surface: { type: string; title: string; blocking: boolean };
  /** elementFromPoint at the candidate's center hits the candidate (top-most). */
  hit_match: boolean;
}

export type SurfaceActionSearchValue =
  | { vw: number; vh: number; status: "ok"; candidates: RawSurfaceCandidate[] }
  | { vw: number; vh: number; status: "error" };

/**
 * Builds the raw JS-string IIFE that collects visible interactive elements that
 * are members of a live overlay, with their identity descriptors, current boxes,
 * overlay identity (type + value-free accessible title), and an occlusion probe.
 * It NEVER clicks or mutates the DOM. Surface matching / uniqueness / intent
 * checks are done TS-side (single source of truth) — the page only reports.
 *
 * Overlay classification is the SHARED buildOverlaySnippetJs — the same
 * structural classifier the snapshot and the post-click probe use, so surface
 * identity can never drift between capture and resolution.
 */
export function buildSurfaceActionSearchExpr(): string {
  const cap = JSON.stringify(MAX_SURFACE_CANDIDATES);
  return `(function(){
    var CAP=${cap};
    var vw=window.innerWidth, vh=window.innerHeight;
    var OVERLAY_TITLE_MAX=120;
    var OVERLAY_WALK_DEPTH=12;
    var OVERLAY_DRAWER_RE=/(drawer|flyout|off-?canvas|side-?panel|slide-?over|snackbar)/i;
    var OVERLAY_DISMISS_RE=/\\b(close|dismiss|no thanks|not now|maybe later)\\b/i;
    var OVERLAY_CHAT_RE=/(chat|messeng|intercom|zendesk|drift|live\\s*help|support\\s*widget|help\\s*widget|chat\\s*widget|launcher)/i;
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
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
    ${buildOverlaySnippetJs()}
    try{
      var INTERACTIVE='a[href],button,input,textarea,select,[role],[tabindex],[contenteditable="true"],summary';
      var nodes=document.querySelectorAll(INTERACTIVE);
      var out=[];
      for(var k=0;k<nodes.length&&out.length<CAP;k++){
        var el=nodes[k];
        if(!isVisible(el)) continue;
        var tag=(el.tagName||'').toLowerCase();
        var rawType=attr(el,'type');
        var type=rawType?String(rawType).toLowerCase():(tag==='input'?'text':null);
        if(tag==='input'&&type==='hidden') continue;
        var contentEditable=false;
        try{ contentEditable=(el.isContentEditable===true)||(attr(el,'contenteditable')==='true'); }catch(e){ contentEditable=false; }
        var nm=nameOf(el,tag,type); if(nm&&nm.length>160) nm=nm.slice(0,160);
        var ovl=null; try{ ovl=computeOverlay(el,nm); }catch(e){ ovl=null; }
        // Surface members ONLY — background-behind-modal markers are excluded by
        // construction, so a header/background element can never be matched here.
        if(!ovl||ovl.background===true) continue;
        var r=el.getBoundingClientRect();
        var cx=r.left+r.width/2, cy=r.top+r.height/2;
        var hit=false;
        try{
          var h=document.elementFromPoint(cx,cy);
          hit=!!h&&(h===el||(el.contains&&el.contains(h))||(h.contains&&h.contains(el)));
        }catch(e){ hit=false; }
        out.push({
          tag: tag,
          type: type,
          role: attr(el,'role'),
          content_editable: contentEditable,
          id: attr(el,'id'),
          href: attr(el,'href'),
          disabled: el.disabled===true,
          aria_disabled: attr(el,'aria-disabled')==='true',
          read_only: el.readOnly===true,
          name: nm,
          visible: true,
          box: { x:r.left, y:r.top, width:r.width, height:r.height },
          surface: { type: ovl.overlay_type, title: ovl.modal_title?String(ovl.modal_title):'', blocking: ovl.blocking===true },
          hit_match: hit
        });
      }
      return {vw:vw,vh:vh,status:"ok",candidates:out};
    }catch(e){ return {vw:vw,vh:vh,status:"error"}; }
  })()`;
}

// ─── Pure surface + action matcher ───────────────────────────────────────────

export type SurfaceActionPick =
  | {
      status: "resolved";
      box: ElementBox;
      /** Safe live descriptor for the endpoint's intent-drift re-check. */
      live: { name: string; kind: string; href_path: string | null };
    }
  | { status: "surface_gone" }
  | { status: "surface_ambiguous" }
  | { status: "action_ambiguous" }
  | { status: "action_not_found" };

/** Exact normalized match, or one a substring of the other (shorter length ≥ 2). */
function titlesCompatible(expected: string, live: string): boolean {
  if (expected === live) return true;
  if (!expected || !live) return false;
  const shorter = expected.length <= live.length ? expected : live;
  const longer = expected.length <= live.length ? live : expected;
  if (shorter.length < 2) return false;
  return longer.includes(shorter);
}

/**
 * Resolves the surface, then the unique action inside it.
 *
 * Surface matching: candidates are grouped by (type, normalized title).
 *  - No group of the expected type → surface_gone (the panel dismissed).
 *  - With a stored title: exactly one title-compatible group wins; several →
 *    surface_ambiguous; none → SINGLETON RELAXATION: when exactly one group of
 *    the type is live, accept it (titles legitimately churn — "1 item" →
 *    "2 items"); two-or-more → surface_ambiguous.
 *  - Without a stored title: only the singleton case is accepted.
 *
 * Action matching within the surface group:
 *  - compatibility = compareLiveToExpected (single source of truth with 4B);
 *  - occluded candidates (hit_match=false) are not actionable and are filtered
 *    BEFORE uniqueness (a responsive duplicate hidden under another layer never
 *    blocks the visible top-most one);
 *  - exactly one compatible unoccluded in-viewport candidate → resolved;
 *    several → action_ambiguous; none → action_not_found. Never guess.
 */
export function pickSurfaceActionMatch(
  value: SurfaceActionSearchValue,
  expected: AntigenKnownBoxRevalidationExpected,
  surface: SurfaceIdentity,
): SurfaceActionPick {
  if (value.status !== "ok") return { status: "action_not_found" };
  const { vw, vh, candidates } = value;

  const ofType = candidates.filter((c) => c.surface.type === surface.overlay_type);
  if (ofType.length === 0) return { status: "surface_gone" };

  // Group by normalized live title.
  const groups = new Map<string, RawSurfaceCandidate[]>();
  for (const c of ofType) {
    const key = normalizeName(c.surface.title);
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const expectedTitle = normalizeName(surface.modal_title ?? "");
  let group: RawSurfaceCandidate[] | undefined;
  if (expectedTitle) {
    const matching = [...groups.entries()].filter(([title]) => titlesCompatible(expectedTitle, title));
    if (matching.length === 1) group = matching[0][1];
    else if (matching.length > 1) return { status: "surface_ambiguous" };
    else if (groups.size === 1) group = [...groups.values()][0]; // singleton relaxation
    else return { status: "surface_ambiguous" };
  } else {
    if (groups.size === 1) group = [...groups.values()][0];
    else return { status: "surface_ambiguous" };
  }

  // Compatible actions within the surface; occlusion-filter BEFORE uniqueness.
  const compatible = group.filter((c) => compareLiveToExpected(c, expected).status === "ok");
  if (compatible.length === 0) return { status: "action_not_found" };
  const actionable = compatible.filter((c) => {
    if (!c.hit_match) return false;
    const cx = c.box.x + c.box.width / 2;
    const cy = c.box.y + c.box.height / 2;
    return cx >= 0 && cx <= vw && cy >= 0 && cy <= vh;
  });
  if (actionable.length === 0) return { status: "action_not_found" };
  if (actionable.length > 1) return { status: "action_ambiguous" };

  const match = actionable[0];
  return {
    status: "resolved",
    box: match.box,
    live: { name: match.name, kind: inferKind(match), href_path: hrefPath(match.href) },
  };
}

// ─── Thin CDP orchestration ──────────────────────────────────────────────────

export type ResolveSurfaceActionResult =
  | SurfaceActionPick
  | { status: "page_changed" }
  | { status: "cdp_error" };

/**
 * Opens its OWN short-lived CDP connection, runs the surface search IIFE once,
 * and returns a proposed box for the unique surface action (or a typed
 * failure). It does NOT click — the caller re-runs the unchanged
 * realisticClickKnownBox on the proposed box, so the trusted Phase 4B remains
 * the final gate. The live-URL guard runs first, same as the click path.
 */
export async function resolveSurfaceActionBox(params: {
  cdpUrl: string;
  expected: AntigenKnownBoxRevalidationExpected;
  expectedUrl?: string | null;
  surface: SurfaceIdentity;
}): Promise<ResolveSurfaceActionResult> {
  const { cdpUrl, expected, expectedUrl, surface } = params;

  let versionData: { webSocketDebuggerUrl?: string };
  let targets: Array<{ id: string; url: string; type: string }>;
  try {
    [versionData, targets] = await Promise.all([
      fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
      fetch(`${cdpUrl}/json/list`).then((r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>),
    ]);
  } catch {
    return { status: "cdp_error" };
  }

  const browserWsUrl = versionData.webSocketDebuggerUrl;
  if (!browserWsUrl) return { status: "cdp_error" };

  const { target: pageTarget } = pickBestPageTarget(targets, {});
  if (!pageTarget) return { status: "cdp_error" };

  // Live-URL guard — never resolve a surface on a page that navigated away.
  if (isAntigenPageChanged(expectedUrl, pageTarget.url)) return { status: "page_changed" };

  const searchExpr = buildSurfaceActionSearchExpr();

  return new Promise<ResolveSurfaceActionResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    let searchId: number;
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      ws.terminate();
      resolve({ status: "cdp_error" });
    }, 8_000);

    const finish = (result: ResolveSurfaceActionResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    const sendMsg = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params: p };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    ws.on("open", () => {
      attachId = sendMsg("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
    });

    ws.on("message", (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return;
      const result = msg.result as Record<string, unknown> | undefined;

      if (id === attachId) {
        if (!result?.sessionId) {
          finish({ status: "cdp_error" });
          return;
        }
        cdpSessionId = result.sessionId as string;
        searchId = sendMsg("Runtime.evaluate", { expression: searchExpr, returnByValue: true }, cdpSessionId);
        return;
      }

      if (id === searchId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const value = evalResult?.value as SurfaceActionSearchValue | undefined;
        if (!value) {
          finish({ status: "cdp_error" });
          return;
        }
        finish(pickSurfaceActionMatch(value, expected, surface));
      }
    });

    ws.on("error", () => finish({ status: "cdp_error" }));
  });
}
