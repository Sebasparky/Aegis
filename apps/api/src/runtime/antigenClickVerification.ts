// ─── Antigen Post-Click Intent Verification ──────────────────────────────────
//
// Today a browser_click "succeeds" the moment CDP pointer events are dispatched,
// even if the intended page/UI effect never happened (dynamic toasts, late
// modals, re-rendered listings). This module makes a SUCCESSFUL low-risk click
// mean the intended effect was OBSERVED — URL / modal / cart / title / focus
// changed — not just that mouse events fired.
//
// It holds three things, all pure / string-only (no browser, no CDP):
//   1. PageStateProbe / ClickVerification types + enum sets (for trace gating).
//   2. buildPageStateProbeExpr() — a raw-JS IIFE (Node tsconfig has no DOM lib,
//      so page-evaluated code MUST be raw JS strings) that reads a compact page
//      state. It reuses the SAME structural overlay classifier as the snapshot
//      extraction (buildOverlaySnippetJs) so modal/toast/drawer/chat detection
//      can never drift between the two surfaces.
//   3. classifyClickVerification() — the pure before/after → signal decision.
//
// LEAK BOUNDARY: hashes (FNV-1a, computed PAGE-SIDE) remain the ONLY comparison
// keys — the pure classifier never reads a raw title or body text. As a
// deliberate, scoped DISPLAY addition (mirroring the snapshot's existing
// value-free-title policy: ActiveSurface.title / page_summary.visible_heading),
// the probe also returns the clipped document.title, the dominant overlay's
// clipped accessible title (same overlayTitle() snippet the snapshot uses), and
// — only when collectSurfaceActions is requested — the dominant overlay's
// clickable action NAMES (accessible names only; `.value` read solely for
// submit/button/reset inputs). These display fields feed the endpoint's
// sanitized `post_click_state`; they never influence classification. Body text
// stays hash-only. Full URLs cross CDP for internal comparison but never leave
// the API agent-facing — the endpoint's post_click_state builder reduces them
// to query-/fragment-free paths. Nothing here returns coordinates, refs, field
// values, or secrets. The feature is gated behind ANTIGEN_CLICK_VERIFY
// (default-off): when off, the runtime never builds a probe and the endpoint
// response is byte-identical to today.

import type { ElementBox } from "./nativePointerRuntime.js";
import type { AntigenOverlayType } from "./antigenSnapshotRuntime.js";
import { buildOverlaySnippetJs } from "./antigenSnapshotRuntime.js";

/** Recording / verification is enabled only when the dev flag is explicitly set. */
export function isClickVerifyEnabled(): boolean {
  return process.env.ANTIGEN_CLICK_VERIFY === "true";
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** One clickable member of the dominant overlay — DISPLAY ONLY (names, no
 * geometry/refs/hrefs). Collected only when the probe is built with
 * collectSurfaceActions; never read by the classifier. */
export interface OverlayProbeAction {
  name: string; // accessible name, clipped page-side (≤80)
  kind: "button" | "link";
  dismiss: boolean;
}

/** Compact page-level overlay summary used for before/after comparison. */
export interface OverlayProbeSummary {
  present: boolean;
  blocking: boolean;
  overlay_type: AntigenOverlayType | null;
  // Hash of the dominant overlay's accessible title — the COMPARISON key.
  title_hash: string | null;
  // Clipped value-free accessible title of the dominant overlay (same
  // overlayTitle() extraction the snapshot uses for ActiveSurface.title).
  // DISPLAY ONLY — feeds the endpoint's post_click_state; never compared.
  title?: string | null;
  // Dominant-overlay clickable action names (collectSurfaceActions only).
  // DISPLAY ONLY — capped page-side (≤8 of ≤40 scanned).
  actions?: OverlayProbeAction[];
  // Count of distinct visible, classified overlay regions on the page. Optional
  // (older probes/literals omit it → treated as 0). Used ONLY for cart-mutation
  // intent to detect a freshly-appearing add-to-bag notification even when a
  // persistent aria-live region still dominates the summary. Internal-only —
  // never surfaced in any agent response or trace.
  count?: number;
}

/**
 * A compact snapshot of page state read once (before) and again (after) a click.
 * Everything here is leak-safe: URLs are compared by the same page-change guard
 * the click path already uses; titles/body text are hashes; cart_count is an
 * integer; focus is a boolean.
 */
export interface PageStateProbe {
  url: string | null;
  title_hash: string | null;
  // Clipped (≤120) document.title — DISPLAY ONLY (post_click_state); the
  // classifier compares title_hash exclusively.
  title?: string | null;
  // document.readyState at probe time — DISPLAY ONLY; lets the endpoint report
  // "still_loading" after a navigation. Never read by the classifier.
  ready_state?: "loading" | "interactive" | "complete" | null;
  overlay: OverlayProbeSummary;
  cart_count: number | null;
  visible_text_hash: string | null;
  focused_editable_at_target: boolean;
  // "error" => the after-probe could not be read => the outcome is UNVERIFIED
  // (an unreadable probe is NOT evidence the click missed, so it is never
  // treated as a no-effect retry trigger).
  status: "ok" | "error";
}

export type VerificationSignal =
  | "url_changed"
  | "modal_opened"
  | "modal_closed"
  | "overlay_changed"
  | "cart_changed"
  | "title_changed"
  | "focus_changed"
  | "no_effect";

export type ClickOutcome =
  | "CLICK_VERIFIED"
  | "CLICK_DISPATCHED_NO_EFFECT"
  | "CLICK_INTENT_UNVERIFIED";

export type RecommendedNextStep = "refresh_snapshot" | "try_alternate_ref" | "none";

/**
 * INTERNAL carrier of before/after display state — filled by the runtime, read
 * ONLY by the endpoint's buildPostClickState mapper. Holds RAW URLs (the
 * endpoint reduces them to query-/fragment-free paths) and clipped display
 * titles. MUST NEVER be spread into an API response, trace event, or log.
 */
export interface PostClickInternal {
  before_url: string | null;
  after_url: string | null;
  before_title: string | null;
  after_title: string | null;
  ready_state: "loading" | "interactive" | "complete" | null;
  // visible_text_hash before ≠ after (computed by the runtime from hashes).
  main_content_changed: boolean;
  // The dominant overlay summary from the FINAL after-probe, when present.
  after_overlay?: OverlayProbeSummary;
}

export interface ClickVerification {
  click_dispatched: boolean;
  intent_verified: boolean;
  verification_signal: VerificationSignal;
  outcome: ClickOutcome;
  recommended_next_step: RecommendedNextStep;
  // Sanitized telemetry the endpoint maps into trace booleans/enums. No titles,
  // no text, no refs, no coordinates.
  overlay_before_present: boolean;
  overlay_before_blocking: boolean;
  overlay_after_present: boolean;
  overlay_after_blocking: boolean;
  overlay_before_type: AntigenOverlayType | null;
  overlay_after_type: AntigenOverlayType | null;
  url_changed: boolean;
  // Timing telemetry, filled by the runtime (not the pure classifier).
  verify_ms?: number;
  settle_polls?: number;
  // INTERNAL (runtime-filled): display state for the endpoint's sanitized
  // post_click_state. Never spread into responses/traces — the endpoint maps
  // it through buildPostClickState (explicit-field allowlist) only.
  post_click_internal?: PostClickInternal;
}

export interface ClickVerificationContext {
  // The clicked target is an editable field — success is FOCUS, not a page
  // change. Field-focus clicks must not require url/modal/cart movement.
  editableTarget: boolean;
  // At snapshot time the clicked element was background-behind a blocking modal.
  // If the same blocking modal persists unchanged, the click was absorbed and
  // must NOT verify as successful (the modal-trap guard).
  targetWasBehindBlockingModal: boolean;
  // Injected so url comparison reuses the exact page-change semantics the click
  // path already uses (hash/trailing-slash/query-multiset aware).
  pageChangedCompare: (a: string | null | undefined, b: string | null | undefined) => boolean;
  // The click was classified as a cart-mutation (add-to-bag) intent. ONLY then do
  // the two cart-specific signals below apply: first-add cart count (null→positive)
  // and a new notification region (overlay count increase). Generic clicks keep
  // today's behavior — null→positive and count-increase never verify them.
  cartMutationIntent: boolean;
  // The click was classified as a checkout transition ("Continue to checkout").
  // Sites often render the checkout-method overlay / route AFTER a network round
  // trip, later than the default settle budget — this selects the extended
  // settle schedule only. It changes NO classification rule.
  checkoutTransitionIntent: boolean;
}

// Enum sets for trace enum-gating (mirrors ANTIGEN_RECOVERY_STATES discipline).
export const VERIFICATION_SIGNALS: ReadonlySet<VerificationSignal> = new Set<VerificationSignal>([
  "url_changed",
  "modal_opened",
  "modal_closed",
  "overlay_changed",
  "cart_changed",
  "title_changed",
  "focus_changed",
  "no_effect",
]);

export const CLICK_OUTCOMES: ReadonlySet<ClickOutcome> = new Set<ClickOutcome>([
  "CLICK_VERIFIED",
  "CLICK_DISPATCHED_NO_EFFECT",
  "CLICK_INTENT_UNVERIFIED",
]);

export const OVERLAY_TYPE_VALUES: ReadonlySet<AntigenOverlayType> = new Set<AntigenOverlayType>([
  "dialog",
  "alertdialog",
  "popover",
  "toast",
  "drawer",
  "overlay",
]);

// ─── Adaptive settle schedules ───────────────────────────────────────────────

// Default after-click settle schedule (ms between re-probes) for non-editable
// targets. Cheap-first: an immediate probe runs before this loop; polling only
// continues while no signal is observed and the after-probe is still readable.
// ~600ms of waits (≈800ms total incl. realistic pointer dispatch).
export const CLICK_VERIFY_SETTLE_SCHEDULE_MS: readonly number[] = [150, 200, 250];

// Cart-mutation (add-to-bag) clicks often confirm ASYNCHRONOUSLY — the toast /
// cart badge lands only after a network round trip, later than the default
// budget. For cart_mutation clicks only, poll a bit longer (~1.2s of waits,
// ≈1.3s total) so the confirmation is observed. Still early-exits on the first
// verified signal, so a fast add adds zero extra latency.
export const CART_MUTATION_SETTLE_SCHEDULE_MS: readonly number[] = [150, 200, 250, 300, 300];

// Checkout transitions ("Continue to checkout") frequently open their
// checkout-method overlay / next route only after a network round trip (IKEA's
// "Choose how to check out" dialog is the canonical case) — slower than the
// default budget. Poll longer (~1.6s of waits) for checkout_transition clicks
// only. Still early-exits on the first verified signal, so a fast checkout
// transition pays zero extra latency.
export const CHECKOUT_TRANSITION_SETTLE_SCHEDULE_MS: readonly number[] = [150, 200, 250, 300, 300, 400];

/**
 * Pick the adaptive after-click settle schedule. Only cart_mutation and
 * checkout_transition clicks get an extended schedule, and only when they are
 * not editable/focus targets and not behind a blocking modal (modal-trap).
 * Navigation, editable/focus, modal-trap, and sensitive/final clicks all use
 * the cheap default. UNVERIFIED (probe error) stops polling via the caller's
 * status guard.
 */
export function selectSettleSchedule(
  ctx: ClickVerificationContext,
  editableTarget: boolean,
): readonly number[] {
  if (ctx.cartMutationIntent && !editableTarget && !ctx.targetWasBehindBlockingModal) {
    return CART_MUTATION_SETTLE_SCHEDULE_MS;
  }
  if (ctx.checkoutTransitionIntent && !editableTarget && !ctx.targetWasBehindBlockingModal) {
    return CHECKOUT_TRANSITION_SETTLE_SCHEDULE_MS;
  }
  return CLICK_VERIFY_SETTLE_SCHEDULE_MS;
}

// ─── Page-state probe IIFE builder ───────────────────────────────────────────

/**
 * Builds the raw-JS IIFE that reads a PageStateProbe from the live page. Reuses
 * buildOverlaySnippetJs() (the single source of overlay structural detection) so
 * the probe's modal/toast/drawer/chat classification and the blocking test stay
 * identical to the snapshot's. targetBox (the clicked element box) is used only
 * to decide whether focus landed on the intended editable field.
 *
 * Returns a value shaped like PageStateProbe. Any failure returns status:"error".
 * targetBox is interpolated via JSON.stringify — never raw concatenation.
 *
 * collectSurfaceActions (default false): additionally harvest the dominant
 * overlay's clickable action NAMES (bounded: scan ≤40, return ≤8; accessible
 * names only — `.value` read solely for submit/button/reset inputs, matching
 * buildSurfaceActionSearchExpr's nameOf precedence). Display-only output for
 * the endpoint's post_click_state; never compared by the classifier.
 */
export function buildPageStateProbeExpr(opts: {
  targetBox?: ElementBox;
  collectSurfaceActions?: boolean;
}): string {
  const targetBox = JSON.stringify(opts.targetBox ?? null);
  const collectActions = JSON.stringify(opts.collectSurfaceActions === true);
  return `(function(){
    try{
      var OVERLAY_TITLE_MAX=120;
      var OVERLAY_WALK_DEPTH=12;
      var OVERLAY_DRAWER_RE=/(drawer|flyout|off-?canvas|side-?panel|slide-?over|snackbar)/i;
      var OVERLAY_DISMISS_RE=/\\b(close|dismiss|no thanks|not now|maybe later)\\b/i;
      var OVERLAY_CHAT_RE=/(chat|messeng|intercom|zendesk|drift|live\\s*help|support\\s*widget|help\\s*widget|chat\\s*widget|launcher)/i;
      var TARGET_BOX=${targetBox};
      var COLLECT_ACTIONS=${collectActions};
      function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
      function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
      function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
      // FNV-1a (page-side) so raw titles / body text never leave the page.
      function fnv(s){ s=String(s==null?'':s); var h=0x811c9dc5>>>0; for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0; } return ('00000000'+h.toString(16)).slice(-8); }
      ${buildOverlaySnippetJs()}
      function isVisibleNode(node){
        try{
          var r=node.getBoundingClientRect();
          if(!(r.width>0&&r.height>0)) return false;
          var cs=cssOf(node);
          if(cs){ if(cs.display==='none') return false; if(cs.visibility==='hidden'||cs.visibility==='collapse') return false; }
          return true;
        }catch(e){ return false; }
      }
      // Accessible name of one overlay action — SAME precedence as
      // buildSurfaceActionSearchExpr's nameOf (aria-label → aria-labelledby →
      // labels → img alt → title attr → .value ONLY for submit/button/reset
      // inputs → innerText/textContent). Clipped to 80 chars.
      function actionName(el,tag,type){
        var al=attr(el,'aria-label'); if(txt(al)) return clip(al,80);
        var lb=attr(el,'aria-labelledby');
        if(lb){
          var ids=lb.split(/\\s+/); var parts=[];
          for(var i=0;i<ids.length;i++){ try{ var ref=document.getElementById(ids[i]); if(ref) parts.push(ref.textContent||''); }catch(e){} }
          var t=txt(parts.join(' ')); if(t) return clip(t,80);
        }
        try{
          if(el.labels&&el.labels.length){
            var lp=[]; for(var j=0;j<el.labels.length;j++){ lp.push(el.labels[j].textContent||''); }
            var lt=txt(lp.join(' ')); if(lt) return clip(lt,80);
          }
        }catch(e){}
        try{ if(el.querySelector){ var img=el.querySelector('img'); if(img){ var a=attr(img,'alt'); if(txt(a)) return clip(a,80); } } }catch(e){}
        var ti=attr(el,'title'); if(txt(ti)) return clip(ti,80);
        if(tag==='input'&&(type==='submit'||type==='button'||type==='reset')){
          try{ if(el.value!=null){ var v=txt(el.value); if(v) return clip(v,80); } }catch(e){}
        }
        var it=null; try{ it=(el.innerText!=null?el.innerText:el.textContent); }catch(e){ it=null; }
        if(txt(it)) return clip(it,80);
        return '';
      }
      // Dominant-overlay clickable action names (COLLECT_ACTIONS only). Bounded:
      // scan <=40 nodes, return <=8. Names + dismiss flag only — no hrefs, no
      // boxes, no values. Best-effort: any failure returns [].
      function overlayActions(container){
        var out=[];
        try{
          var nodes=container.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"]');
          nodes=Array.prototype.slice.call(nodes);
          var lim=Math.min(nodes.length,40);
          for(var i=0;i<lim&&out.length<8;i++){
            var el=nodes[i]; if(!el) continue;
            if(!isVisibleNode(el)) continue;
            var tag=(el.tagName||'').toLowerCase();
            var rawType=attr(el,'type');
            var type=rawType?String(rawType).toLowerCase():null;
            if(el.disabled===true||attr(el,'aria-disabled')==='true') continue;
            var nm=actionName(el,tag,type); if(!nm) continue;
            var dis=false; try{ dis=isDismissEl(el,nm)===true; }catch(e){ dis=false; }
            out.push({ name:nm, kind:(tag==='a'?'link':'button'), dismiss:dis });
          }
        }catch(e){ return []; }
        return out;
      }
      // Page-level active-overlay summary: scan structural overlay containers,
      // classify each with the SHARED overlayKindOf, and reduce to a compact
      // present/blocking/type/title_hash. Prefers blocking > dialog/alertdialog
      // > any, mirroring the snapshot page-map's active-overlay selection.
      // title (clipped, value-free) and actions (COLLECT_ACTIONS) are DISPLAY
      // additions for post_click_state; title_hash stays the comparison key.
      function overlaySummary(){
        var present=false, blocking=false, best=null, cnt=0;
        function rank(k){ var r=0; if(k.blocking) r+=1000; if(k.type==='dialog'||k.type==='alertdialog') r+=100; return r; }
        var nodes;
        try{ nodes=document.querySelectorAll('dialog,[role="dialog"],[role="alertdialog"],[popover],[aria-modal],[role="alert"],[role="status"],[aria-live],[class*="drawer"],[class*="flyout"],[class*="offcanvas"],[class*="snackbar"],[id*="drawer"]'); }
        catch(e){ return { present:false, blocking:false, overlay_type:null, title_hash:null, count:0 }; }
        nodes=Array.prototype.slice.call(nodes);
        var lim=Math.min(nodes.length,60);
        for(var i=0;i<lim;i++){
          var node=nodes[i]; if(!node) continue;
          if(!isVisibleNode(node)) continue;
          var k=null; try{ k=overlayKindOf(node); }catch(e){ k=null; }
          if(!k) continue;
          present=true;
          cnt++;
          if(k.blocking) blocking=true;
          if(!best||rank(k)>rank(best.k)){ best={ k:k, node:node }; }
        }
        var ttl=''; try{ ttl=best?overlayTitle(best.node):''; }catch(e){ ttl=''; }
        var res={ present:present, blocking:blocking, overlay_type:best?best.k.type:null, title_hash:ttl?fnv(ttl):null, title:ttl?clip(ttl,120):null, count:cnt };
        if(COLLECT_ACTIONS&&best){ res.actions=overlayActions(best.node); }
        return res;
      }
      // Best-effort cart-quantity heuristic. Returns an integer or null — never
      // throws, never blocks verification when a site has no readable counter.
      function cartCount(){
        try{
          var direct=document.querySelector('[data-cart-count],[data-cart-quantity],[data-cart-items],[data-quantity]');
          if(direct){
            var dv=attr(direct,'data-cart-count')||attr(direct,'data-cart-quantity')||attr(direct,'data-cart-items')||attr(direct,'data-quantity')||direct.textContent||'';
            var dn=parseInt(String(dv).replace(/[^0-9]/g,''),10);
            if(!isNaN(dn)) return dn;
          }
          var cands=document.querySelectorAll('[aria-label*="cart" i],[aria-label*="bag" i],[aria-label*="basket" i]');
          cands=Array.prototype.slice.call(cands);
          var n=Math.min(cands.length,20);
          for(var i=0;i<n;i++){
            var c=cands[i]; if(!c) continue;
            var lab=(attr(c,'aria-label')||'')+' '+(c.textContent||'');
            var m=lab.match(/(\\d{1,3})/);
            if(m){ var v=parseInt(m[1],10); if(!isNaN(v)) return v; }
          }
          return null;
        }catch(e){ return null; }
      }
      // True when the active element is an editable field AT/NEAR the clicked
      // box — the success criterion for a field-focus click.
      function focusedEditableAtTarget(box){
        try{
          var ae=document.activeElement; if(!ae) return false;
          var tag=(ae.tagName||'').toLowerCase();
          var editable=(tag==='input'||tag==='textarea'||tag==='select')||ae.isContentEditable===true;
          if(!editable) return false;
          if(!box) return true;
          var r=ae.getBoundingClientRect();
          var cx=r.left+r.width/2, cy=r.top+r.height/2;
          var tcx=box.x+box.width/2, tcy=box.y+box.height/2;
          var tol=Math.max(40, box.width/2+12, box.height/2+12);
          return Math.abs(cx-tcx)<=tol && Math.abs(cy-tcy)<=tol;
        }catch(e){ return false; }
      }
      var url=null; try{ url=document.location.href||null; }catch(e){ url=null; }
      var docTitle=''; try{ docTitle=document.title||''; }catch(e){ docTitle=''; }
      var readyState=null; try{ var rs=document.readyState; if(rs==='loading'||rs==='interactive'||rs==='complete') readyState=rs; }catch(e){ readyState=null; }
      var bodyText=''; try{ bodyText=(document.body&&document.body.innerText)?String(document.body.innerText):''; }catch(e){ bodyText=''; }
      if(bodyText.length>4000) bodyText=bodyText.slice(0,4000);
      return {
        url: url,
        title_hash: docTitle?fnv(docTitle):null,
        title: docTitle?clip(docTitle,120):null,
        ready_state: readyState,
        overlay: overlaySummary(),
        cart_count: cartCount(),
        visible_text_hash: bodyText?fnv(bodyText):null,
        focused_editable_at_target: focusedEditableAtTarget(TARGET_BOX),
        status: "ok"
      };
    }catch(e){
      return { url:null, title_hash:null, title:null, ready_state:null, overlay:{ present:false, blocking:false, overlay_type:null, title_hash:null }, cart_count:null, visible_text_hash:null, focused_editable_at_target:false, status:"error" };
    }
  })()`;
}

// ─── Pure classifier ─────────────────────────────────────────────────────────

/**
 * Decide whether a dispatched click produced its intended low-risk effect, by
 * comparing the page state before vs after. First match in the priority order
 * below wins. Text-hash changes alone NEVER verify (SPA re-renders / lazy
 * media / toasts mutate body text without the intended action). The modal-trap
 * guard sits above url/overlay so a click absorbed by a still-present blocking
 * modal can never be rescued by an incidental change.
 */
export function classifyClickVerification(
  before: PageStateProbe,
  after: PageStateProbe,
  ctx: ClickVerificationContext,
): ClickVerification {
  const telemetry = {
    overlay_before_present: before.overlay.present,
    overlay_before_blocking: before.overlay.blocking,
    overlay_after_present: after.overlay.present,
    overlay_after_blocking: after.overlay.blocking,
    overlay_before_type: before.overlay.overlay_type,
    overlay_after_type: after.overlay.overlay_type,
    url_changed: ctx.pageChangedCompare(before.url, after.url),
  };
  const verified = (signal: VerificationSignal): ClickVerification => ({
    click_dispatched: true,
    intent_verified: true,
    verification_signal: signal,
    outcome: "CLICK_VERIFIED",
    recommended_next_step: "none",
    ...telemetry,
  });
  const noEffect = (
    next: RecommendedNextStep,
    outcome: ClickOutcome = "CLICK_DISPATCHED_NO_EFFECT",
    signal: VerificationSignal = "no_effect",
  ): ClickVerification => ({
    click_dispatched: true,
    intent_verified: false,
    verification_signal: signal,
    outcome,
    recommended_next_step: next,
    ...telemetry,
  });

  // Unreadable after-probe — not evidence the click missed; never a retry trigger.
  if (after.status === "error") {
    return noEffect("refresh_snapshot", "CLICK_INTENT_UNVERIFIED");
  }

  // Editable target: success is focus only — no url/modal/cart requirement.
  if (ctx.editableTarget) {
    return after.focused_editable_at_target
      ? verified("focus_changed")
      : noEffect("refresh_snapshot");
  }

  // Modal-trap guard: the target sat behind a blocking modal that still persists
  // unchanged — the click was absorbed; never verify (above url/overlay checks).
  if (
    ctx.targetWasBehindBlockingModal &&
    before.overlay.blocking &&
    after.overlay.blocking &&
    before.overlay.overlay_type === after.overlay.overlay_type &&
    before.overlay.title_hash === after.overlay.title_hash &&
    !telemetry.url_changed
  ) {
    return noEffect("refresh_snapshot");
  }

  if (telemetry.url_changed) return verified("url_changed");
  if (!before.overlay.blocking && after.overlay.blocking) return verified("modal_opened");
  if (before.overlay.present && !after.overlay.present) return verified("modal_closed");
  if (
    before.overlay.present &&
    after.overlay.present &&
    (before.overlay.overlay_type !== after.overlay.overlay_type ||
      before.overlay.title_hash !== after.overlay.title_hash)
  ) {
    return verified("overlay_changed");
  }
  if (
    before.cart_count != null &&
    after.cart_count != null &&
    before.cart_count !== after.cart_count
  ) {
    return verified("cart_changed");
  }
  // First add-to-cart, cart-mutation intent only: the counter was absent/zero-
  // rendered (null) before and shows a positive quantity after. Sites that hide
  // the badge until the first item (e.g. "Shopping bag" → "Shopping bag, 1 items")
  // would otherwise be missed by the null-safe both-present check above. Gated on
  // cartMutationIntent so a generic click that merely surfaces a cart badge never
  // verifies this way.
  if (
    ctx.cartMutationIntent &&
    before.cart_count == null &&
    after.cart_count != null &&
    after.cart_count > 0
  ) {
    return verified("cart_changed");
  }
  // New add-to-bag notification, cart-mutation intent only: a fresh overlay region
  // appeared (region count rose) even though a persistent aria-live region
  // (delivery/location) still dominates the summary, leaving overlay_type/title
  // unchanged. Count-increase is purely structural — no text-hash dependence.
  if (
    ctx.cartMutationIntent &&
    (after.overlay.count ?? 0) > (before.overlay.count ?? 0) &&
    after.overlay.present
  ) {
    return verified(
      after.overlay.blocking && !before.overlay.blocking ? "modal_opened" : "overlay_changed",
    );
  }
  if (before.title_hash !== after.title_hash) return verified("title_changed");
  // Non-editable target, but focus moved into a field (e.g. a wrapper that
  // focuses an input). Treated as a real, observed effect.
  if (after.focused_editable_at_target) return verified("focus_changed");
  // Body text changed but nothing structural did — not sufficient to verify.
  return noEffect("try_alternate_ref");
}
