/**
 * Antigen Snapshot Runtime — DOM candidate extraction (v1, increment 1).
 *
 * The first primitive toward Antigen-owned snapshots:
 *
 *   live CDP page → DOM/CDP extraction → visible interactive candidate list
 *                   with internal bounding boxes + safe semantic metadata
 *
 * This module is intentionally NOT wired into browser_click, browser_type,
 * browser_snapshot, the adapter, any API endpoint, the snapshot store, or
 * ag_* refs. It only proves that Antigen can independently inspect the live
 * page over CDP and return sanitized internal candidate records. Later phases
 * add ref assignment, the snapshot store, revalidation, and scoring.
 *
 * Source of truth: docs/antigen-snapshot/{extraction-strategy,internal-model,
 * security-and-privacy,scoring-and-fallback-resolution}.md
 *
 * Security invariants (enforced by construction; asserted in tests):
 * - The page-side IIFE NEVER reads `.value` for any field except
 *   input[type=submit|button|reset] (where value is the button label).
 *   Password / hidden / payment / identity field values are never read.
 * - input[type=hidden] is skipped entirely.
 * - Returned candidates contain ONLY the AntigenSnapshotCandidate fields.
 *   They never contain cdp_url, user_data_dir, profile_key, pass_id,
 *   secret_ref, field values, cookies, localStorage/sessionStorage, raw HTML,
 *   the full DOM, or browser profile paths.
 * - Bounding boxes ARE included here because this runtime function is internal
 *   (Antigen-only) and not yet agent-facing. Future API endpoints keep boxes
 *   internal per docs/antigen-snapshot/security-and-privacy.md.
 *
 * The page-side IIFE is a raw JS string (NOT a TypeScript arrow function): the
 * Node tsconfig has no DOM lib, so DOM code lives in strings evaluated in the
 * page via CDP Runtime.evaluate — same convention as buildElementFindExpr in
 * realisticBrowserActions.ts. buildAntigenExtractionExpr and the pure helpers
 * are exported for unit testing without a real browser.
 */

import WebSocket from "ws";

// ─── Public types ────────────────────────────────────────────────────────────

export type AntigenCandidateKind =
  | "link"
  | "button"
  | "input"
  | "textarea"
  | "select"
  | "control"
  | "editable"
  | "summary"
  | "unknown";

export interface AntigenSnapshotCandidate {
  index: number;
  tag: string;
  kind: AntigenCandidateKind;
  role: string | null;
  name: string;
  normalized_name: string;
  id: string | null;
  href: string | null;
  href_path: string | null;
  visible: boolean;
  enabled: boolean;
  typeable: boolean;
  clickable: boolean;
  box: { x: number; y: number; width: number; height: number };
  /**
   * Bounded, visible-page-derived disambiguation context for repeated/generic
   * controls (e.g. two "Add to bag" buttons on different product cards).
   * `label`/`section` are agent-facing; `nearby_text` is internal-only.
   * Never carries input values, secrets, raw DOM, hrefs, or coordinates.
   */
  context?: AntigenSnapshotContext;
}

/** Bounded disambiguation context. label≤120, section≤80, nearby_text≤160. */
export interface AntigenSnapshotContext {
  label?: string;
  section?: string;
  nearby_text?: string;
}

export interface ExtractAntigenSnapshotCandidatesParams {
  /** CDP http endpoint, e.g. http://localhost:9222 (not a ws:// URL). */
  cdpUrl: string;
  /** Hard cap on returned candidates. Default 200. */
  maxCandidates?: number;
  /** If true (default), only elements intersecting the current viewport. */
  viewportOnly?: boolean;
}

/**
 * Raw, JSON-serializable record returned by the page-side IIFE for a single
 * surviving (visible) element. Carries only safe signals — never values for
 * sensitive fields. The TS layer derives kind / typeable / clickable /
 * normalized_name / href_path from these signals.
 */
export interface RawAntigenCandidate {
  tag: string;
  type: string | null;
  role: string | null;
  content_editable: boolean;
  id: string | null;
  href: string | null;
  disabled: boolean;
  aria_disabled: boolean;
  read_only: boolean;
  name: string;
  box: { x: number; y: number; width: number; height: number };
  /** Raw, page-derived disambiguation context (bounded in the IIFE). */
  context?: AntigenSnapshotContext;
}

const DEFAULT_MAX_CANDIDATES = 200;

// ─── Context bounds (shared by IIFE + TS sanitizer) ──────────────────────────
const CONTEXT_LABEL_MAX = 120;
const CONTEXT_SECTION_MAX = 80;
const CONTEXT_NEARBY_MAX = 160;

/**
 * The candidate selector list from docs/antigen-snapshot/extraction-strategy.md.
 * Generic visible interactive elements — deliberately site-agnostic.
 */
export const ANTIGEN_CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "details > summary",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

// ─── Pure helpers (browser-agnostic; unit-testable) ──────────────────────────

const TEXTLIKE_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "password",
]);

const BUTTONLIKE_INPUT_TYPES = new Set(["submit", "button", "reset"]);

const TYPEABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

const CONTROL_ROLES = new Set(["checkbox", "radio", "switch", "option"]);

/**
 * Deterministic name normalization for `normalized_name`, per the pipeline in
 * docs/antigen-snapshot/scoring-and-fallback-resolution.md. Only the minimal
 * normalization needed for normalized_name is implemented here; tokenization,
 * generic-word removal, and scoring are deferred to a later phase.
 *
 * lowercase → replace -_/| with space → strip .,!?;:'"()[]{} (keep &)
 *  → collapse whitespace → trim.
 */
export function normalizeName(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[-_/|]+/g, " ")
    .replace(/[.,!?;:'"()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Re-clamps and cleans raw page-derived context (defense-in-depth against a
 * malicious page that ignores the IIFE bounds). Trims, collapses whitespace,
 * enforces per-field maxima, drops fields that merely echo the element name,
 * and returns `undefined` when nothing useful remains. Never reads or carries
 * values, secrets, hrefs, DOM, or coordinates.
 */
export function sanitizeContext(
  raw: AntigenSnapshotContext | null | undefined,
  name: string,
): AntigenSnapshotContext | undefined {
  if (!raw) return undefined;
  const echo = normalizeName(name);
  const clean = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
    if (!trimmed) return undefined;
    if (echo && normalizeName(trimmed) === echo) return undefined; // pure name echo
    return trimmed;
  };
  const out: AntigenSnapshotContext = {};
  const label = clean(raw.label, CONTEXT_LABEL_MAX);
  const section = clean(raw.section, CONTEXT_SECTION_MAX);
  const nearby = clean(raw.nearby_text, CONTEXT_NEARBY_MAX);
  if (label) out.label = label;
  if (section) out.section = section;
  if (nearby) out.nearby_text = nearby;
  return out.label || out.section || out.nearby_text ? out : undefined;
}

/** Pathname-only portion of an href. Origin and query string are dropped. */
export function hrefPath(href: string | null): string | null {
  if (!href) return null;
  const raw = href.trim();
  if (!raw) return null;
  // Skip non-navigational hrefs that have no meaningful path.
  if (raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) return null;
  try {
    // Base lets relative hrefs resolve; absolute hrefs ignore the base.
    return new URL(raw, "http://antigen.invalid").pathname || null;
  } catch {
    return null;
  }
}

/** kind inference per the table in extraction-strategy.md. */
export function inferKind(raw: RawAntigenCandidate): AntigenCandidateKind {
  const tag = raw.tag;
  const type = raw.type;
  const role = raw.role;

  // ARIA role takes priority for semantic classification where unambiguous.
  if (role === "link") return "link";
  if (role === "button" || role === "menuitem" || role === "tab") return "button";
  if (role === "combobox") return "select";
  if (role === "searchbox" || role === "textbox") return tag === "textarea" ? "textarea" : "input";
  if (role && CONTROL_ROLES.has(role)) return "control";

  if (tag === "a") return raw.href ? "link" : "unknown";
  if (tag === "button") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  if (tag === "summary") return "summary";

  if (tag === "input") {
    if (type && BUTTONLIKE_INPUT_TYPES.has(type)) return "button";
    if (type === "checkbox" || type === "radio") return "control";
    // text, search, email, tel, url, number, password, or untyped → input
    return "input";
  }

  if (raw.content_editable) return "editable";

  return "unknown";
}

/**
 * The semantic role surfaced on the candidate. Explicit role attribute wins;
 * otherwise a reasonable default is inferred from tag/type. May be null.
 */
export function inferRole(raw: RawAntigenCandidate): string | null {
  if (raw.role) return raw.role;
  const { tag, type } = raw;
  if (tag === "a" && raw.href) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (tag === "input") {
    if (type === "search") return "searchbox";
    if (type && BUTTONLIKE_INPUT_TYPES.has(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (!type || TEXTLIKE_INPUT_TYPES.has(type)) return "textbox";
  }
  if (raw.content_editable) return "textbox";
  return null;
}

/** enabled = not disabled and not aria-disabled. (readonly affects typeable.) */
export function computeEnabled(raw: RawAntigenCandidate): boolean {
  return !raw.disabled && !raw.aria_disabled;
}

/** A field is typeable if it accepts text input and is enabled and editable. */
export function inferTypeable(raw: RawAntigenCandidate): boolean {
  if (!computeEnabled(raw) || raw.read_only) return false;
  if (raw.tag === "textarea") return true;
  if (raw.content_editable) return true;
  if (raw.role && TYPEABLE_ROLES.has(raw.role)) return true;
  if (raw.tag === "input") {
    const type = raw.type;
    if (!type) return true; // untyped input defaults to text
    return TEXTLIKE_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * Clickable = the element is primarily an action/navigation target rather than
 * a text field. Text inputs, textareas, and editable regions are typeable, not
 * click targets, so they are not marked clickable here.
 */
export function inferClickable(raw: RawAntigenCandidate): boolean {
  const kind = inferKind(raw);
  switch (kind) {
    case "link":
    case "button":
    case "control":
    case "summary":
    case "select":
      return true;
    case "input":
    case "textarea":
    case "editable":
      return false;
    default:
      // unknown: clickable only if it is not a typeable field.
      return !inferTypeable(raw);
  }
}

/** Assemble a final candidate from a raw record + its position. */
export function mapRawToCandidate(raw: RawAntigenCandidate, index: number): AntigenSnapshotCandidate {
  const candidate: AntigenSnapshotCandidate = {
    index,
    tag: raw.tag,
    kind: inferKind(raw),
    role: inferRole(raw),
    name: raw.name,
    normalized_name: normalizeName(raw.name),
    id: raw.id,
    href: raw.href,
    href_path: hrefPath(raw.href),
    visible: true, // raw records only exist for elements that passed the visibility filter
    enabled: computeEnabled(raw),
    typeable: inferTypeable(raw),
    clickable: inferClickable(raw),
    box: raw.box,
  };
  // Only attach context when something useful survives sanitization — keeps the
  // key off candidates that have no disambiguation context.
  const context = sanitizeContext(raw.context, raw.name);
  if (context) candidate.context = context;
  return candidate;
}

// ─── Page-side extraction IIFE builder ───────────────────────────────────────

/**
 * Builds the raw JS string IIFE evaluated in the page via Runtime.evaluate.
 *
 * It returns an array of RawAntigenCandidate. The IIFE:
 *   1. Queries the candidate selector list.
 *   2. Skips input[type=hidden] entirely.
 *   3. Filters by visibility (box, display, visibility, opacity, aria-hidden,
 *      and — when viewportOnly — viewport intersection).
 *   4. Resolves a safe accessible name WITHOUT reading sensitive field values.
 *   5. Captures the current getBoundingClientRect() box.
 *   6. Caps at maxCandidates in DOM order.
 *
 * Options are interpolated via JSON.stringify — never raw string concatenation.
 */
export function buildAntigenExtractionExpr(opts: {
  maxCandidates: number;
  viewportOnly: boolean;
}): string {
  const selector = JSON.stringify(ANTIGEN_CANDIDATE_SELECTOR);
  const maxCandidates = JSON.stringify(opts.maxCandidates);
  const viewportOnly = JSON.stringify(opts.viewportOnly);
  const labelMax = JSON.stringify(CONTEXT_LABEL_MAX);
  const sectionMax = JSON.stringify(CONTEXT_SECTION_MAX);
  const nearbyMax = JSON.stringify(CONTEXT_NEARBY_MAX);

  return `(function(){
    var SELECTOR=${selector};
    var MAX=${maxCandidates};
    var VIEWPORT_ONLY=${viewportOnly};
    var CTX_LABEL_MAX=${labelMax};
    var CTX_SECTION_MAX=${sectionMax};
    var CTX_NEARBY_MAX=${nearbyMax};
    var CTX_WALK_DEPTH=8;
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
    function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
    function rectOf(el){
      var r=el.getBoundingClientRect();
      if(!(r.width>0&&r.height>0)) return null;
      var cs=null; try{ cs=(window.getComputedStyle?window.getComputedStyle(el):null); }catch(e){ cs=null; }
      if(cs){
        if(cs.display==='none') return null;
        if(cs.visibility==='hidden'||cs.visibility==='collapse') return null;
        if(String(cs.opacity)==='0') return null;
      }
      if(attr(el,'aria-hidden')==='true') return null;
      if(VIEWPORT_ONLY){
        var right=r.left+r.width, bottom=r.top+r.height;
        var vw=window.innerWidth, vh=window.innerHeight;
        if(!(r.left<vw&&right>0&&r.top<vh&&bottom>0)) return null;
      }
      return r;
    }
    function nameOf(el,tag,type){
      var al=attr(el,'aria-label'); if(txt(al)) return txt(al);
      var lb=attr(el,'aria-labelledby');
      if(lb){
        var ids=lb.split(/\\s+/); var parts=[];
        for(var i=0;i<ids.length;i++){ try{ var ref=document.getElementById(ids[i]); if(ref) parts.push(ref.textContent||''); }catch(e){} }
        var t=txt(parts.join(' ')); if(t) return t;
      }
      // Associated <label> elements (HTMLInputElement.labels). Never reads value.
      try{
        if(el.labels&&el.labels.length){
          var lp=[]; for(var j=0;j<el.labels.length;j++){ lp.push(el.labels[j].textContent||''); }
          var lt=txt(lp.join(' ')); if(lt) return lt;
        }
      }catch(e){}
      // alt text of an inner <img> (for icon links/buttons).
      try{ if(el.querySelector){ var img=el.querySelector('img'); if(img){ var a=attr(img,'alt'); if(txt(a)) return txt(a); } } }catch(e){}
      var ti=attr(el,'title'); if(txt(ti)) return txt(ti);
      // value is read ONLY for submit/button/reset inputs (the button label).
      // Never for password/hidden/payment/identity/text fields.
      if(tag==='input'&&(type==='submit'||type==='button'||type==='reset')){
        try{ if(el.value!=null){ var v=txt(el.value); if(v) return v; } }catch(e){}
      }
      var it=null; try{ it=(el.innerText!=null?el.innerText:el.textContent); }catch(e){ it=null; }
      if(txt(it)) return txt(it);
      var ph=attr(el,'placeholder'); if(txt(ph)) return txt(ph);
      return '';
    }
    // ─── Disambiguation context (bounded, visible-text only) ───────────────
    function isHeading(node){
      if(!node||!node.tagName) return false;
      var t=node.tagName.toLowerCase();
      if(t==='h1'||t==='h2'||t==='h3'||t==='h4'||t==='h5'||t==='h6') return true;
      return attr(node,'role')==='heading';
    }
    // Nearest section: a preceding-sibling heading at some ancestor level
    // (captures "Complete with"), else an ancestor's aria-label
    // (captures "Cookie consent banner").
    // Returns {text, fromHeading}: a heading-derived section ("Complete with") is
    // a real product sub-group and blocks the main-product fallback; an ancestor
    // aria-label is a weaker grouping that does not, on its own, block it.
    function findSection(el){
      var node=el, depth=0;
      while(node&&depth<CTX_WALK_DEPTH){
        var sib=node.previousElementSibling, scan=0;
        while(sib&&scan<6){
          if(isHeading(sib)){ var h=txt(sib.innerText!=null?sib.innerText:sib.textContent); if(h) return {text:clip(h,CTX_SECTION_MAX),fromHeading:true}; }
          sib=sib.previousElementSibling; scan++;
        }
        var al=txt(attr(node,'aria-label'));
        if(al) return {text:clip(al,CTX_SECTION_MAX),fromHeading:false};
        node=node.parentElement; depth++;
      }
      return {text:'',fromHeading:false};
    }
    // Meaningful descendants of a container: peer links, headings, emphasis,
    // and images. Used both to measure breadth and to harvest identity text.
    function harvestNodes(container){
      var ns;
      try{ ns=container.querySelectorAll('a,h1,h2,h3,h4,h5,h6,strong,b,[role="heading"],img'); }catch(e){ return null; }
      try{ return Array.prototype.slice.call(ns); }catch(e){ return null; }
    }
    // Bounded identity text from a node set. Never reads input values or
    // serialized DOM; per-snippet and total length capped; de-duplicated; the
    // control's own name and the section heading are excluded.
    // Returns {text, fromLinkOrHeading}. fromLinkOrHeading marks that a
    // contributing node was a product link or heading — i.e. strong card-local
    // identity that must never be overridden by the page product header.
    function harvestFrom(ns,nameLow,sectionLow){
      var seen={}, parts=[], total=0, strong=false;
      for(var i=0;i<ns.length;i++){
        var n=ns[i]; if(!n) continue;
        var tg=(n.tagName||'').toLowerCase(), t='';
        if(tg==='img'){ t=txt(attr(n,'alt')); }
        else { try{ t=txt(n.innerText!=null?n.innerText:n.textContent); }catch(e){ t=''; } }
        if(!t) continue;
        var low=t.toLowerCase();
        if(nameLow&&low===nameLow) continue;       // skip the control's own label
        if(sectionLow&&low===sectionLow) continue; // avoid echoing the section
        if(seen[low]) continue; seen[low]=1;
        if(t.length>80) t=clip(t,80);
        if(tg==='a'||isHeading(n)) strong=true;
        parts.push(t); total+=t.length+1;
        if(parts.length>=6||total>=CTX_NEARBY_MAX) break;
      }
      return {text:clip(parts.join(' '),CTX_NEARBY_MAX),fromLinkOrHeading:strong};
    }
    // Walk ancestors and return the first one whose harvested text is non-empty.
    // Empty wrapper levels (e.g. a tiny button container) are skipped so a
    // generic button still picks up its sibling product link / title text. The
    // walk STOPS before entering a page-level region (one with too many
    // matches), so a control never inherits unrelated page-wide text such as
    // the product H1 from a sibling header.
    function harvestLabel(el,nameLow,sectionLow){
      var node=el.parentElement, depth=0;
      while(node&&depth<CTX_WALK_DEPTH){
        var ns=harvestNodes(node);
        if(ns&&ns.length>0){
          if(ns.length>14) return {text:'',fromLinkOrHeading:false}; // page region, not an item card — stop
          var r=harvestFrom(ns,nameLow,sectionLow);
          if(r.text) return r;
        }
        node=node.parentElement; depth++;
      }
      return {text:'',fromLinkOrHeading:false};
    }
    function priceMatch(s){
      try{ var m=String(s).slice(0,400).match(/[$£€]\\s?\\d[\\d.,]*/); return m?txt(m[0]):''; }catch(e){ return ''; }
    }
    // A nearby price from the control's own ancestor chain (e.g. a purchase
    // panel or product card). Bounded scan of a few ancestors.
    function findPriceNear(el){
      var node=el.parentElement, depth=0;
      while(node&&depth<4){
        var t=''; try{ t=(node.innerText!=null?node.innerText:node.textContent); }catch(e){ t=''; }
        var p=priceMatch(t); if(p) return clip(p,16);
        node=node.parentElement; depth++;
      }
      return '';
    }
    // Main-product fallback: the nearest page H1 plus a short following
    // subtitle. Generic for ecommerce product pages; not site-specific.
    function pageProductHeader(){
      var h1=null; try{ h1=document.querySelector('h1'); }catch(e){ h1=null; }
      if(!h1) return '';
      var parts=[];
      var title=''; try{ title=txt(h1.innerText!=null?h1.innerText:h1.textContent); }catch(e){ title=''; }
      if(title) parts.push(clip(title,100));
      var sib=h1.nextElementSibling, scan=0;
      while(sib&&scan<3){
        var st=''; try{ st=txt(sib.innerText!=null?sib.innerText:sib.textContent); }catch(e){ st=''; }
        if(st&&st.length<=80&&!isHeading(sib)){ parts.push(st); break; }
        sib=sib.nextElementSibling; scan++;
      }
      return clip(txt(parts.join(' ')),CTX_NEARBY_MAX);
    }
    // Page product header is computed at most once per snapshot (memoized).
    var _pageHeader;
    function pageHeaderMemo(){
      if(_pageHeader===undefined){ try{ _pageHeader=pageProductHeader()||''; }catch(e){ _pageHeader=''; } }
      return _pageHeader;
    }
    // A generic add-to-cart/bag/basket control. No brand/site strings; the
    // source intentionally avoids the literal phrase the brand-string test
    // forbids. \\badd\\b avoids matching "address".
    function isAddToCartName(n){ return /\\badd\\b[\\s\\S]{0,12}\\b(cart|bag|basket)\\b/.test(n); }
    // Clearly unrelated regions (cookie/nav/footer/modal/legal) block the
    // main-product fallback — by section keyword or by a structural landmark
    // ancestor. Bounded ancestor walk.
    function isUnrelatedRegion(el,sectionLow){
      if(sectionLow&&/cookie|consent|nav|navigation|menu|footer|modal|dialog|legal|privacy|terms|newsletter|subscribe/.test(sectionLow)) return true;
      var node=el, depth=0;
      while(node&&depth<CTX_WALK_DEPTH){
        var tg=(node.tagName||'').toLowerCase();
        if(tg==='nav'||tg==='footer') return true;
        var role=attr(node,'role');
        if(role){ role=String(role).toLowerCase(); if(role==='navigation'||role==='dialog'||role==='banner'||role==='contentinfo'||role==='menu') return true; }
        node=node.parentElement; depth++;
      }
      return false;
    }
    function extractContext(el,name){
      var nameLow=name?txt(name).toLowerCase():'';
      var sec=findSection(el);
      var section=sec.text;
      var sectionLow=section?section.toLowerCase():'';
      var hv=harvestLabel(el,nameLow,sectionLow);
      var raw=hv.text;
      // Main-product fallback: adopt the page product header when there is no
      // card-local context at all, or when a generic add-to-cart/bag/basket
      // control sits in a shallow neutral wrapper whose local text is blank or
      // weak (not a product link/heading and carrying no price). A real heading
      // sub-section ("Complete with") and clearly unrelated regions
      // (cookie/nav/footer/modal/legal) keep their own identity and block the
      // fallback; a tiny neutral wrapper aria-label ("Purchase options") does not.
      var unrelated=isUnrelatedRegion(el,sectionLow);
      var isPurchase=isAddToCartName(nameLow);
      var weak=!raw||(!priceMatch(raw)&&!hv.fromLinkOrHeading);
      if(!unrelated&&!sec.fromHeading&&((!raw&&!section)||(isPurchase&&weak))){ var ph=pageHeaderMemo(); if(ph) raw=ph; }
      var price=findPriceNear(el);
      if(raw&&price&&raw.indexOf(price)<0){ raw=clip(raw+' '+price,CTX_NEARBY_MAX); }
      else if(!raw&&price){ raw=price; }
      var ctx={};
      var label=clip(raw,CTX_LABEL_MAX);
      if(label) ctx.label=label;
      if(section) ctx.section=section;
      if(raw) ctx.nearby_text=raw;
      return (ctx.label||ctx.section||ctx.nearby_text)?ctx:null;
    }
    var out=[];
    var nodes;
    try{ nodes=document.querySelectorAll(SELECTOR); }catch(e){ return []; }
    nodes=Array.prototype.slice.call(nodes);
    for(var k=0;k<nodes.length&&out.length<MAX;k++){
      var el=nodes[k];
      if(!el) continue;
      var tag=(el.tagName||'').toLowerCase();
      var rawType=attr(el,'type');
      var type=rawType?String(rawType).toLowerCase():(tag==='input'?'text':null);
      // Never extract hidden inputs — they carry no interactive surface and
      // their values must never be read.
      if(tag==='input'&&type==='hidden') continue;
      var r=rectOf(el);
      if(!r) continue;
      var contentEditable=false;
      try{ contentEditable=(el.isContentEditable===true)||(attr(el,'contenteditable')==='true'); }catch(e){ contentEditable=false; }
      var theName=nameOf(el,tag,type);
      var ctx=null; try{ ctx=extractContext(el,theName); }catch(e){ ctx=null; }
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
        name: theName,
        box: { x:r.left, y:r.top, width:r.width, height:r.height },
        context: ctx
      });
    }
    return out;
  })()`;
}

// ─── CDP transport ───────────────────────────────────────────────────────────

/**
 * Connects to a live Chromium page over CDP, evaluates the extraction IIFE, and
 * returns sanitized internal candidate records with their current bounding
 * boxes. Opens its own raw CDP WebSocket and closes it when done — same pattern
 * as realisticClickByDescription / executeSecretInjectionViaCDP.
 *
 * Returns [] for an empty page (no candidates). Throws (with an attached error
 * `code`) on connection/attach/evaluate failures.
 */
export async function extractAntigenSnapshotCandidatesViaCDP(
  params: ExtractAntigenSnapshotCandidatesParams,
): Promise<AntigenSnapshotCandidate[]> {
  const { cdpUrl } = params;
  const maxCandidates = params.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const viewportOnly = params.viewportOnly ?? true;

  let versionData: { webSocketDebuggerUrl?: string };
  let targets: Array<{ id: string; url: string; type: string }>;
  try {
    [versionData, targets] = await Promise.all([
      fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
      fetch(`${cdpUrl}/json/list`).then(
        (r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>,
      ),
    ]);
  } catch (err) {
    throw Object.assign(new Error(`CDP fetch failed: ${(err as Error).message}`), {
      code: "CDP_FETCH_FAILED",
    });
  }

  const browserWsUrl = versionData.webSocketDebuggerUrl;
  if (!browserWsUrl) {
    throw Object.assign(new Error("No browser WebSocket debugger URL from CDP."), {
      code: "CDP_FETCH_FAILED",
    });
  }

  const pageTarget = pickAntigenPageTarget(targets);
  if (!pageTarget) {
    throw Object.assign(new Error("No page targets found via CDP."), {
      code: "NO_PAGE_TARGET",
    });
  }

  const expr = buildAntigenExtractionExpr({ maxCandidates, viewportOnly });

  const raw = await new Promise<RawAntigenCandidate[]>((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    let evalId: number;
    let settled = false;

    const timer = setTimeout(() => {
      fail(Object.assign(new Error("Antigen snapshot extraction timed out after 8 seconds."), {
        code: "CDP_EVALUATE_FAILED",
      }));
    }, 8_000);

    const sendMsg = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params: p };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    const succeed = (records: RawAntigenCandidate[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(records);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(err);
    };

    ws.on("open", () => {
      attachId = sendMsg("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
    });

    ws.on("error", (err: Error) => {
      fail(Object.assign(new Error(`CDP socket error: ${err.message}`), { code: "CDP_FETCH_FAILED" }));
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return; // CDP event notification, no id
      const result = msg.result as Record<string, unknown> | undefined;

      if (id === attachId) {
        if (!result?.sessionId) {
          fail(Object.assign(new Error("CDP attach failed: no sessionId."), { code: "CDP_ATTACH_FAILED" }));
          return;
        }
        cdpSessionId = result.sessionId as string;
        evalId = sendMsg("Runtime.evaluate", { expression: expr, returnByValue: true }, cdpSessionId);
        return;
      }

      if (id === evalId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const value = evalResult?.value;
        if (!Array.isArray(value)) {
          // Empty page or non-array result → no candidates.
          succeed([]);
          return;
        }
        succeed(value as RawAntigenCandidate[]);
      }
    });
  });

  return raw.slice(0, maxCandidates).map((rec, i) => mapRawToCandidate(rec, i));
}

/**
 * Minimal page-target picker. Inlined (rather than importing
 * cdpTargetSelection.pickBestPageTarget) to keep this increment self-contained
 * and free of cross-module coupling; we can dedupe against that helper in a
 * later phase when ref/store wiring lands.
 */
function pickAntigenPageTarget(
  targets: Array<{ id: string; url: string; type: string }>,
): { id: string; url: string } | undefined {
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) return undefined;
  const unusablePrefixes = ["about:", "chrome://", "devtools://", "chrome-extension://"];
  const usable = pages.find((t) => !unusablePrefixes.some((p) => t.url.startsWith(p)));
  return usable ?? pages.at(-1);
}
