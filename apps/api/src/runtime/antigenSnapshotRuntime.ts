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
}

const DEFAULT_MAX_CANDIDATES = 200;

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
  return {
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

  return `(function(){
    var SELECTOR=${selector};
    var MAX=${maxCandidates};
    var VIEWPORT_ONLY=${viewportOnly};
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
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
        name: nameOf(el,tag,type),
        box: { x:r.left, y:r.top, width:r.width, height:r.height }
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
