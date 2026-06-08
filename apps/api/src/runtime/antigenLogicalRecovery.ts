/**
 * Antigen Same-Page Logical-Ref Recovery (env-gated, default-off).
 *
 * Problem: on dynamic SPA/listing pages the logically-equivalent target (same
 * accessible name / href / kind) survives a re-render but re-flows to a NEW box.
 * Phase 4B (antigenKnownBoxRevalidation.ts) is purely point-centered — it only
 * inspects the element under the *stored* box center — so once the box drifts it
 * fails closed with ANTIGEN_REF_STALE even though the target still exists. On a
 * page that keeps re-rendering, re-snapshotting loops forever.
 *
 * This module adds a conservative, OPT-IN fallback: after a recoverable Phase 4B
 * stale, search the live DOM for a UNIQUE element matching the snapshot's stored
 * identity, and (only if exactly one visible+enabled+in-viewport match exists)
 * propose its current box. The caller then re-runs the unchanged, trusted
 * realisticClickKnownBox on the proposed box — Phase 4B is the authoritative
 * safety gate on the recovered box; recovery only *proposes*, it never clicks.
 *
 * Hard safety boundaries (all enforced here):
 * - Default OFF. Recovery only runs when ANTIGEN_LOGICAL_REF_RECOVERY === "true".
 *   With the flag unset, the caller never enters this path — strict fail-closed
 *   behavior is byte-for-byte unchanged.
 * - Opt-in by safety CLASSIFICATION, not "not obviously sensitive". Default deny.
 *   A central predicate allows recovery only for clearly low-risk navigation /
 *   listing / cart-style targets. Any checkout / payment / place-order / buy /
 *   pay / confirm / approval / auth (sign-in/out) / delete / remove / subscribe /
 *   authorize target is ineligible — fail closed.
 * - Uniqueness required. Two equivalent matches → refuse (ambiguous).
 * - Identity matching reuses compareLiveToExpected (single source of truth with
 *   Phase 4B) — no divergent logic.
 *
 * Secret-safety: the page-side IIFE reuses the same `.value`-only-for-button
 * restriction as Phase 4B and returns only safe semantic descriptors + boxes.
 * Boxes are internal-only and are NEVER returned to the agent; the caller surfaces
 * only enum recovery_state / stale_reason metadata.
 *
 * The page-side IIFE is a raw JS string (the Node tsconfig has no DOM lib) — same
 * convention as buildAntigenRevalidationExpr / buildAntigenExtractionExpr.
 */

import WebSocket from "ws";
import { pickBestPageTarget } from "./cdpTargetSelection.js";
import { isAntigenPageChanged } from "./antigenSnapshotStore.js";
import { normalizeName, hrefPath } from "./antigenSnapshotRuntime.js";
import {
  compareLiveToExpected,
  type AntigenKnownBoxRevalidationExpected,
  type AntigenKnownBoxRevalidationReason,
  type RawLiveElement,
} from "./antigenKnownBoxRevalidation.js";
import type { ElementBox } from "./nativePointerRuntime.js";

// TODO(context-recovery): a future increment should extract the snapshot's
// `extractContext` block from antigenSnapshotRuntime.ts into ONE shared raw-JS
// string reused by both the snapshot IIFE and buildLogicalRecoverySearchExpr,
// add a `context?` field to AntigenKnownBoxRevalidationExpected, harvest live
// candidate context here, and upgrade scoreLogicalRecoveryConfidence so
// "exact name + same card/product context" grades `strong` and href-less
// product links become eligible/recoverable. Until that shared extraction
// lands, do NOT add divergent lightweight context semantics: this increment
// anchors strong identity on href_path only, and recovers low-risk buttons on
// an EXACT unique normalized name.

// ─── Env gate ────────────────────────────────────────────────────────────────

/** Recovery is strictly opt-in. Default OFF preserves current fail-closed behavior. */
export function isLogicalRefRecoveryEnabled(): boolean {
  return process.env.ANTIGEN_LOGICAL_REF_RECOVERY === "true";
}

// ─── Eligibility classification (pure, default-deny) ─────────────────────────

export type LogicalRecoveryAction = "click" | "type" | "scroll";

export type LogicalRecoveryRiskClass =
  | "low_risk_navigation" // link to a product/listing/detail page
  | "low_risk_listing_interaction" // view / show more / load more / next / add-to-cart
  | "ineligible_sensitive" // matched a sensitive-commit denylist term
  | "ineligible_unclassified"; // not clearly low-risk → fail closed

export interface LogicalRecoveryEligibility {
  eligible: boolean;
  risk_class: LogicalRecoveryRiskClass;
}

/**
 * Sensitive-commit denylist — checked FIRST, deny wins. Generic (no site-specific
 * strings). Matched against the normalized accessible name as whole-ish phrases.
 * These represent irreversible / financial / auth / destructive commitments that
 * must never be recovered onto a drifted box.
 */
const SENSITIVE_NAME_TERMS: readonly string[] = [
  "checkout",
  "check out",
  "place order",
  "place your order",
  "submit order",
  "buy now",
  "buy",
  "pay",
  "pay now",
  "payment",
  "continue to payment",
  "complete purchase",
  "purchase",
  "confirm",
  "confirm order",
  "confirm payment",
  "sign in",
  "signin",
  "log in",
  "login",
  "sign out",
  "signout",
  "log out",
  "logout",
  "delete",
  "remove",
  "subscribe",
  "authorize",
  "authorise",
  "approve",
  "agree",
  "accept",
  "send",
  "transfer",
];

/**
 * Low-risk listing/cart interaction allowlist (generic). Add-to-cart-style and
 * pure navigation affordances on listing pages. "add to cart/bag/basket" is the
 * only cart action allowed — the sensitive denylist already removes checkout/pay/
 * place-order/buy-now, so an "add to cart" here is the low-commitment shelf action.
 */
const LOW_RISK_NAME_TERMS: readonly string[] = [
  "add to cart",
  "add to bag",
  "add to basket",
  "add to list",
  "view",
  "view details",
  "show more",
  "load more",
  "see more",
  "more",
  "next",
  "previous",
  "next page",
];

/** Sensitive typeable-field name/identity hints — never recover typing into these. */
const SENSITIVE_FIELD_TERMS: readonly string[] = [
  "password",
  "card",
  "cardnumber",
  "card number",
  "cc",
  "cvv",
  "cvc",
  "security code",
  "ssn",
  "social security",
  "secret",
  "pin",
];

function nameMatchesAny(normalizedName: string, terms: readonly string[]): boolean {
  if (!normalizedName) return false;
  // normalized_name is already lowercased / punctuation-stripped / ws-collapsed.
  const padded = ` ${normalizedName} `;
  return terms.some((t) => padded.includes(` ${t} `) || normalizedName === t);
}

/**
 * Decides whether a stale ref is eligible for same-page logical recovery. Pure,
 * default-deny: returns eligible only for clearly low-risk navigation/listing/
 * cart-style targets. Sensitive denylist wins over everything.
 *
 * NOTE: `type` recovery is intentionally NOT implemented in this increment —
 * typeable targets always classify ineligible here. (Scroll uses document
 * geometry and is not subject to box-drift stale, so it never reaches recovery.)
 */
export function classifyLogicalRecoveryEligibility(
  expected: AntigenKnownBoxRevalidationExpected,
  action: LogicalRecoveryAction,
): LogicalRecoveryEligibility {
  const normalized = (expected.normalized_name ?? "").trim();

  // Typeable fields: never recover sensitive fields; type recovery deferred.
  if (action === "type") {
    if (nameMatchesAny(normalized, SENSITIVE_FIELD_TERMS)) {
      return { eligible: false, risk_class: "ineligible_sensitive" };
    }
    return { eligible: false, risk_class: "ineligible_unclassified" };
  }

  if (action !== "click") {
    return { eligible: false, risk_class: "ineligible_unclassified" };
  }

  // Sensitive-commit denylist wins first.
  if (nameMatchesAny(normalized, SENSITIVE_NAME_TERMS)) {
    return { eligible: false, risk_class: "ineligible_sensitive" };
  }

  // Pure navigation links: low-commitment. Recovery still requires an EXACT
  // href_path match downstream, so a link can only recover onto the same path.
  if (expected.kind === "link" && expected.href_path) {
    return { eligible: true, risk_class: "low_risk_navigation" };
  }

  // Low-risk listing/cart buttons (add-to-cart-style, view/more/next).
  if (
    (expected.kind === "button" || expected.kind === "control" || expected.kind === "link") &&
    nameMatchesAny(normalized, LOW_RISK_NAME_TERMS)
  ) {
    return { eligible: true, risk_class: "low_risk_listing_interaction" };
  }

  // Anything else: fail closed.
  return { eligible: false, risk_class: "ineligible_unclassified" };
}

// ─── Sanitized stale-reason ergonomics ───────────────────────────────────────

/** Agent-safe stale-reason vocabulary (carries no values, coords, or diagnostics). */
export type AntigenSanitizedStaleReason =
  | "target_replaced"
  | "page_re_rendering"
  | "element_not_visible"
  | "out_of_viewport";

/** Agent-actionable hint for what to do next. */
export type AntigenStabilityHint =
  | "target_replaced_resnapshot"
  | "page_re_rendering_retry_or_resnapshot"
  | "wait_for_settle_or_resnapshot"
  | "scroll_into_view_and_resnapshot";

export interface SanitizedStaleSignal {
  stale_reason: AntigenSanitizedStaleReason;
  stability_hint: AntigenStabilityHint;
}

/**
 * Maps an internal Phase 4B reason to a coarse, agent-safe stale signal. The raw
 * reason codes carry no coordinates/values, but we still collapse to a small
 * product vocabulary so the agent can distinguish "moved/replaced" (recoverable)
 * from "gone" without exposing internal matching details.
 */
export function sanitizeStaleReason(
  reason: AntigenKnownBoxRevalidationReason | undefined,
): SanitizedStaleSignal {
  switch (reason) {
    case "BOX_OUT_OF_VIEWPORT":
      return { stale_reason: "out_of_viewport", stability_hint: "scroll_into_view_and_resnapshot" };
    case "LIVE_ELEMENT_NOT_VISIBLE":
      return { stale_reason: "element_not_visible", stability_hint: "wait_for_settle_or_resnapshot" };
    case "NO_ELEMENT_AT_POINT":
      return { stale_reason: "page_re_rendering", stability_hint: "page_re_rendering_retry_or_resnapshot" };
    case "NAME_MISMATCH":
    case "ROLE_KIND_MISMATCH":
    case "HREF_PATH_MISMATCH":
    default:
      return { stale_reason: "target_replaced", stability_hint: "target_replaced_resnapshot" };
  }
}

// ─── Recovery state (for responses + trace; enum-gated) ──────────────────────

export type AntigenRecoveryState =
  | "disabled" // flag off — recovery not attempted
  | "skipped_ineligible" // flag on, but target classified not low-risk
  | "recovered" // unique match found, re-validated, re-click succeeded
  | "failed_ambiguous" // >1 equivalent match — refused
  | "failed_not_found" // no equivalent match
  | "failed_revalidation" // recovered box, but re-click Phase 4B still stale
  | "failed_out_of_viewport" // unique match but offscreen
  | "failed_page_changed" // page navigated during recovery
  | "failed_cdp"; // CDP/search error during recovery

export const ANTIGEN_RECOVERY_STATES: ReadonlySet<AntigenRecoveryState> = new Set([
  "disabled",
  "skipped_ineligible",
  "recovered",
  "failed_ambiguous",
  "failed_not_found",
  "failed_revalidation",
  "failed_out_of_viewport",
  "failed_page_changed",
  "failed_cdp",
]);

export const ANTIGEN_SANITIZED_STALE_REASONS: ReadonlySet<AntigenSanitizedStaleReason> = new Set([
  "target_replaced",
  "page_re_rendering",
  "element_not_visible",
  "out_of_viewport",
]);

// ─── Page-side search IIFE ───────────────────────────────────────────────────

/** Upper bound on candidates returned from the page (rare fallback path). */
const MAX_RECOVERY_CANDIDATES = 600;

/** Raw live candidate returned by the search IIFE: identity descriptor + box. */
export interface RawLiveCandidate extends RawLiveElement {
  box: ElementBox;
}

export type LogicalRecoverySearchValue =
  | { vw: number; vh: number; status: "ok"; candidates: RawLiveCandidate[] }
  | { vw: number; vh: number; status: "error" };

/**
 * Builds the raw JS-string IIFE that collects visible interactive elements with
 * their safe identity descriptors + current boxes. It NEVER clicks or mutates the
 * DOM. Matching/uniqueness is done TS-side via compareLiveToExpected (single
 * source of truth) — the page only reports candidates.
 *
 * `.value` is read ONLY for input[type=submit|button|reset] (button label), the
 * same restriction as Phase 4B — never for password/text/payment fields.
 */
export function buildLogicalRecoverySearchExpr(): string {
  const cap = JSON.stringify(MAX_RECOVERY_CANDIDATES);
  return `(function(){
    var CAP=${cap};
    var vw=window.innerWidth, vh=window.innerHeight;
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
      if(tag==='input'&&(type==='submit'||type==='button'||type==='reset')){
        try{ if(el.value!=null){ var v=txt(el.value); if(v) return v; } }catch(e){}
      }
      var it=null; try{ it=(el.innerText!=null?el.innerText:el.textContent); }catch(e){ it=null; }
      if(txt(it)) return txt(it);
      var ph=attr(el,'placeholder'); if(txt(ph)) return txt(ph);
      return '';
    }
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
        var contentEditable=false;
        try{ contentEditable=(el.isContentEditable===true)||(attr(el,'contenteditable')==='true'); }catch(e){ contentEditable=false; }
        var nm=nameOf(el,tag,type); if(nm&&nm.length>160) nm=nm.slice(0,160);
        var r=el.getBoundingClientRect();
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
          box: { x:r.left, y:r.top, width:r.width, height:r.height }
        });
      }
      return {vw:vw,vh:vh,status:"ok",candidates:out};
    }catch(e){ return {vw:vw,vh:vh,status:"error"}; }
  })()`;
}

// ─── Confidence model (pure, graded, default-conservative) ───────────────────

/**
 * Graded confidence that a live candidate is the SAME logical target the
 * snapshot ref pointed at. Used as the recovery acceptance gate.
 *
 * - `incompatible` — `compareLiveToExpected` failed (identity / visibility /
 *   enabled mismatch). Preserves every existing fail-closed guarantee.
 * - `strong` — exact `href_path` match (the strongest signal; an exact name is
 *   a bonus, not required). Nav links recover only at this tier.
 * - `name_exact` — no href anchor, but the live normalized name equals the
 *   expected normalized name EXACTLY (and kind/role already compatible). Only
 *   low-risk listing interactions recover at this tier.
 * - `weak` — compatible only via a substring name match (no href, not exact).
 *   Never recovered, for any risk class — fail closed.
 *
 * No card/product context is used in this increment (see TODO at top of file).
 */
export type LogicalRecoveryConfidence = "strong" | "name_exact" | "weak" | "incompatible";

export function scoreLogicalRecoveryConfidence(
  live: RawLiveElement,
  expected: AntigenKnownBoxRevalidationExpected,
): LogicalRecoveryConfidence {
  if (compareLiveToExpected(live, expected).status !== "ok") return "incompatible";

  const expectedHref = (expected.href_path ?? "").trim();
  if (expectedHref.length > 0 && hrefPath(live.href) === expectedHref) return "strong";

  const expectedName = (expected.normalized_name ?? "").trim();
  if (expectedName.length > 0 && normalizeName(live.name) === expectedName) return "name_exact";

  return "weak";
}

// ─── Pure unique-match picker ────────────────────────────────────────────────

export type LogicalRecoveryPick =
  | { status: "recovered"; box: ElementBox }
  | { status: "ambiguous" }
  | { status: "not_found" }
  | { status: "out_of_viewport" };

/**
 * Picks the single live candidate that is logically equivalent to the snapshot
 * element, requiring uniqueness, a confident identity match, in-viewport
 * position, and a viewport-center. Identity matching reuses compareLiveToExpected
 * (same logic as Phase 4B); acceptance is graded by scoreLogicalRecoveryConfidence
 * and gated by the target's risk class.
 *
 * - 0 compatible candidates → not_found
 * - >1 compatible candidates → ambiguous (refuse; never guess — covers two
 *   buttons sharing the same name)
 * - exactly 1 compatible, but not confident enough for its risk class → not_found
 *   (fail closed): `strong` recovers for any eligible class; `name_exact`
 *   recovers ONLY for low_risk_listing_interaction; `weak` (substring-only)
 *   never recovers.
 * - exactly 1 accepted, but offscreen → out_of_viewport
 * - exactly 1 accepted, in-viewport → recovered (propose its live box)
 */
export function pickLogicalRecoveryMatch(
  value: LogicalRecoverySearchValue,
  expected: AntigenKnownBoxRevalidationExpected,
  riskClass: LogicalRecoveryRiskClass,
): LogicalRecoveryPick {
  if (value.status !== "ok") return { status: "not_found" };
  const { vw, vh, candidates } = value;

  // Score against the FULL candidate set so substring-compatible peers still
  // count toward ambiguity even though they are never accepted on their own.
  const compatible = candidates
    .map((c) => ({ c, confidence: scoreLogicalRecoveryConfidence(c, expected) }))
    .filter((s) => s.confidence !== "incompatible");

  if (compatible.length === 0) return { status: "not_found" };
  if (compatible.length > 1) return { status: "ambiguous" };

  const { c, confidence } = compatible[0];

  // Risk-aware acceptance. strong: any eligible class. name_exact: low-risk
  // listing interactions only. weak (substring-only): fail closed everywhere.
  const accepted =
    confidence === "strong" ||
    (confidence === "name_exact" && riskClass === "low_risk_listing_interaction");
  if (!accepted) return { status: "not_found" };

  const box = c.box;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (!(cx >= 0 && cx <= vw && cy >= 0 && cy <= vh)) {
    return { status: "out_of_viewport" };
  }
  return { status: "recovered", box };
}

// ─── Thin CDP search orchestration ───────────────────────────────────────────

export type RecoverAntigenRefResult =
  | { status: "recovered"; box: ElementBox }
  | { status: "ambiguous" }
  | { status: "not_found" }
  | { status: "out_of_viewport" }
  | { status: "page_changed" }
  | { status: "cdp_error" };

/**
 * Opens its OWN short-lived CDP connection, runs the search IIFE once, and
 * returns a proposed box for a unique logical match (or a typed failure). It does
 * NOT click — the caller re-runs the unchanged realisticClickKnownBox on the
 * proposed box so the trusted Phase 4B is the final gate.
 *
 * The live-URL guard runs first (same as the click/type paths): recovery never
 * proceeds on a page that navigated since the snapshot.
 */
export async function recoverAntigenRefBox(params: {
  cdpUrl: string;
  expected: AntigenKnownBoxRevalidationExpected;
  expectedUrl?: string | null;
  /** Risk class of the target (from classifyLogicalRecoveryEligibility). Gates
   *  the confidence tier required to accept a unique match. */
  riskClass: LogicalRecoveryRiskClass;
}): Promise<RecoverAntigenRefResult> {
  const { cdpUrl, expected, expectedUrl, riskClass } = params;

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

  // Live-URL guard — fail closed if the page navigated since the snapshot.
  if (isAntigenPageChanged(expectedUrl, pageTarget.url)) return { status: "page_changed" };

  const searchExpr = buildLogicalRecoverySearchExpr();

  return new Promise<RecoverAntigenRefResult>((resolve) => {
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

    const finish = (result: RecoverAntigenRefResult) => {
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
        const value = evalResult?.value as LogicalRecoverySearchValue | undefined;
        if (!value) {
          finish({ status: "cdp_error" });
          return;
        }
        const pick = pickLogicalRecoveryMatch(value, expected, riskClass);
        if (pick.status === "recovered") finish({ status: "recovered", box: pick.box });
        else if (pick.status === "ambiguous") finish({ status: "ambiguous" });
        else if (pick.status === "out_of_viewport") finish({ status: "out_of_viewport" });
        else finish({ status: "not_found" });
      }
    });

    ws.on("error", () => finish({ status: "cdp_error" }));
  });
}
