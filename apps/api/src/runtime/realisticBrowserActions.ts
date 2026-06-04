/**
 * Realistic Browser Actions — ordinary visible browsing path.
 *
 * Provides CDP-backed realistic pointer movement and per-character typing for
 * ordinary agent browsing actions (browser_click, browser_fill). These are
 * the non-credential counterpart of the secret/profile injection paths.
 *
 * Safe logging invariants:
 * - Never log element descriptions, typed text, or any page content values.
 * - Log only: char_count_bucket, duration_ms, surface, mode, box dimensions.
 * - Forbidden in logs and responses: user_data_dir, profile_key, raw cookies,
 *   raw localStorage, passwords, payment values, and secret material.
 * - cdp_url is permitted (internal runtime endpoint, not agent-facing output).
 *
 * The two exported async functions open their own raw CDP WebSocket connections
 * and close them when done — same pattern as executeSecretInjectionViaCDP.
 * dispatchTextCharsViaCDP and buildElementFindExpr are exported for unit testing.
 */

import WebSocket from "ws";
import {
  makePointerRuntimeState,
  clickBoxWithPointer,
  type ElementBox,
} from "./nativePointerRuntime.js";
import { pickBestPageTarget } from "./cdpTargetSelection.js";
import {
  buildAntigenRevalidationExpr,
  evaluateKnownBoxRevalidation,
  type AntigenKnownBoxRevalidationExpected,
  type AntigenRevalidationEvalValue,
} from "./antigenKnownBoxRevalidation.js";
import { getInputRealismMode, getCharCountBucket } from "./inputRealismTyper.js";
import { getLoadedPointerTraces } from "./pointerProfileLoader.js";
import {
  getTaskBrowserSessionPointerState,
  setTaskBrowserSessionPointerState,
} from "./taskBrowserSessions.js";

// Module-level general browsing pointer state — fast in-process fallback when
// userId is unavailable. Keyed by browser_session_id. When userId is known,
// taskBrowserSessions is used as the shared cross-path store instead.
const browsingPointerState = new Map<string, { x: number; y: number }>();

export const GENERAL_TYPING_PROFILE = { min_ms: 30, max_ms: 80 } as const;

/**
 * Shared realistic-pointer click dispatch for a KNOWN element box.
 *
 * This is the single pointer-movement primitive used by both the
 * description-matched click path (realisticClickByDescription) and the exact
 * Antigen-ref click path (realisticClickKnownBox). It owns: two-tier pointer
 * state load, makePointerRuntimeState, clickBoxWithPointer (template traces +
 * debug overlay), pointer-state persistence, and the success metadata shape.
 *
 * Callers supply the box + viewport dims + an attached-session sendCdp closure.
 * No element finding, no DOM/Playwright click — the click is always realistic
 * pointer movement to the given box via clickBoxWithPointer.
 */
async function dispatchPointerClickToBox(opts: {
  box: ElementBox;
  vw: number;
  vh: number;
  sessionId?: string;
  userId?: string;
  sendCdp: (method: string, p: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  debugOverlay: boolean;
}): Promise<RealisticClickResult> {
  const { box, vw, vh, sessionId, userId, sendCdp, sleep, debugOverlay } = opts;

  // Two-tier pointer state load: taskBrowserSessions (shared cross-path store)
  // preferred when userId is available; browsingPointerState as fast fallback.
  let savedClickState: { x: number; y: number } | undefined;
  if (sessionId && userId) {
    const saved = getTaskBrowserSessionPointerState(sessionId, userId);
    if (saved?.initialized) savedClickState = { x: saved.x, y: saved.y };
  }
  if (!savedClickState && sessionId) savedClickState = browsingPointerState.get(sessionId);
  const clickPointerStartSource: "session" | "viewport_center" = savedClickState ? "session" : "viewport_center";

  const state = makePointerRuntimeState({
    current_x: savedClickState?.x ?? vw / 2,
    current_y: savedClickState?.y ?? vh / 2,
    viewport_width: vw,
    viewport_height: vh,
    browser_session_id: sessionId,
    interaction_mode: "realistic",
  });

  let clickPathCount: number | undefined;
  await clickBoxWithPointer(state, box, sendCdp, sleep, {
    debugOverlay,
    debugLabel: "general_click",
    templateTraces: getLoadedPointerTraces(),
    purpose: "button_click",
    onFocusComplete: (info) => { clickPathCount = info.path_point_count; },
  });

  let clickStatePersisted = false;
  if (sessionId) {
    browsingPointerState.set(sessionId, { x: state.current_x, y: state.current_y });
    if (userId) {
      setTaskBrowserSessionPointerState(sessionId, userId, {
        x: state.current_x,
        y: state.current_y,
        initialized: true,
        updated_at: new Date().toISOString(),
      });
      clickStatePersisted = true;
    }
  }

  return {
    success: true,
    pointer_start_source: clickPointerStartSource,
    ...(clickPathCount !== undefined ? { pointer_path_point_count: clickPathCount } : {}),
    pointer_state_persisted: clickStatePersisted,
  };
}

// JS IIFE that checks whether the active element is a focusable input/textarea/contenteditable.
// Returns true if focusable and visible, null otherwise.
// Exported for unit testing.
export const ACTIVE_ELEMENT_CHECK_EXPR = `(function(){
  var el=document.activeElement;if(!el)return null;
  var tag=el.tagName.toLowerCase();
  var r=el.getBoundingClientRect();
  if((r.width>0||r.height>0)&&(tag==='input'||tag==='textarea'||el.isContentEditable))return true;
  return null;
})()`;

// JS IIFE that finds a visible search/submit button.
// Returns { x, y, width, height, vw, vh } or null. Used by the submit fallback path
// when Enter does not trigger navigation. Returns only box geometry — no text or hrefs.
export const SEARCH_BUTTON_FIND_EXPR = "(function(){"
  + "var selectors=['button[type=submit]','input[type=submit]',"
  + "'button[aria-label*=\"search\" i]','[role=\"button\"][aria-label*=\"search\" i]'];"
  + "for(var i=0;i<selectors.length;i++){"
  + "var el=document.querySelector(selectors[i]);"
  + "if(!el)continue;"
  + "var r=el.getBoundingClientRect();"
  + "if(r.width>0&&r.height>0)return{x:r.left,y:r.top,width:r.width,height:r.height,vw:window.innerWidth,vh:window.innerHeight};}"
  + "return null;})()";

export interface RealisticClickResult {
  success: boolean;
  error?: string;
  pointer_start_source?: "session" | "viewport_center";
  pointer_path_point_count?: number;
  pointer_state_persisted?: boolean;
  // Internal-only: the live page URL read after a successful click, used by the
  // route handler to refresh session.current_url so later Antigen snapshots are
  // not stale after a click-triggered navigation. Never returned to the agent.
  current_url?: string;
}

/**
 * Reads the live page URL (document.location.href) after a click settles.
 *
 * Best-effort and non-fatal: waits a short settle window (so a click-triggered
 * navigation has a chance to commit), evaluates document.location.href, and
 * returns the string or null. Any failure returns null — the caller must still
 * report click success. Only reads the URL; no DOM mutation, no element lookup.
 */
async function readCurrentUrlAfterClick(
  sendAndWait: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>,
  sleep: (ms: number) => Promise<void>,
): Promise<string | null> {
  try {
    await sleep(250); // brief settle so click-triggered navigation can commit
    const r = await sendAndWait("Runtime.evaluate", { expression: "document.location.href", returnByValue: true });
    const val = (r?.result as Record<string, unknown> | undefined)?.value;
    return typeof val === "string" && val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

export interface RealisticTypeResult {
  success: boolean;
  error?: string;
  char_count_bucket: string;
  duration_ms: number;
  focused?: boolean;             // true if this call performed a click to focus the target field
  submitted?: boolean;           // true if Enter was dispatched after typing
  submit_method?: "enter" | "button_fallback"; // present when submitted=true
  pointer_path_point_count?: number; // present when focused=true
  pointer_start_source?: "session" | "viewport_center";
  pointer_state_persisted?: boolean;
}

/**
 * Builds the JS IIFE expression for Runtime.evaluate that finds a visible
 * interactive element and returns its bounding box or a sentinel.
 *
 * All string inputs are JSON.stringify-encoded before embedding — never
 * interpolated as raw strings.
 *
 * When selectorHint is provided (a CSS/aria selector from the MCP tool call),
 * it is tried first via document.querySelector. On match, the element is
 * returned directly without text-scan. On failure the expression falls through
 * to description-based matching so the caller always gets a best-effort result.
 *
 * Returns (inside the browser):
 *   null        — no match (ELEMENT_NOT_FOUND)
 *   "AMBIGUOUS" — multiple text-scan matches (AMBIGUOUS_ELEMENT)
 *   { x, y, width, height, vw, vh } — matched element's bounding rect + viewport
 *
 * Matching priority:
 *   1. querySelector(selectorHint) if provided and visible
 *   2. Exact case-insensitive match on aria-label, placeholder, title, name attr
 *   3. Exact case-insensitive match on trimmed textContent
 *   4. Contains match on any of the above fields
 * Only considers visible (non-zero bounding box) interactive elements.
 */
export function buildElementFindExpr(elementDescription: string, selectorHint?: string, intent?: "type" | "click"): string {
  const desc = JSON.stringify(elementDescription);
  const intentVal = JSON.stringify(intent ?? "click");

  // Selector-first block: injected only when a hint is available.
  // Wrapped in try/catch so an invalid selector never throws to the caller.
  const selectorBlock = selectorHint
    ? `try{var sh=document.querySelector(${JSON.stringify(selectorHint)});if(sh){var shr=sh.getBoundingClientRect();if(shr.width>0||shr.height>0){sh.scrollIntoView({block:'center',inline:'center'});shr=sh.getBoundingClientRect();return {x:shr.left,y:shr.top,width:shr.width,height:shr.height,vw:window.innerWidth,vh:window.innerHeight};}}}catch(se){}`
    : "";

  return `(function(){${selectorBlock}
    var desc=${desc};
    var descLower=desc.toLowerCase();
    var intent=${intentVal};
    function vis(el){try{var r=el.getBoundingClientRect();return r.width>0||r.height>0;}catch(e){return false;}}
    var q=Array.from(document.querySelectorAll('a,button,[role=button],[role=link],input,select,textarea,[tabindex],[role=combobox],[role=searchbox]'));
    q=q.filter(function(el){return vis(el);});
    function fields(el){
      var f=[
        (el.getAttribute('aria-label')||'').trim().toLowerCase(),
        (el.getAttribute('placeholder')||'').trim().toLowerCase(),
        (el.getAttribute('title')||'').trim().toLowerCase(),
        (el.getAttribute('name')||'').trim().toLowerCase(),
        (el.textContent||'').trim().toLowerCase()
      ];
      var lby=el.getAttribute('aria-labelledby');
      if(lby){var lbyText=lby.split(' ').map(function(id){var le=document.getElementById(id);return le?(le.textContent||'').trim():''}).filter(Boolean).join(' ').toLowerCase();if(lbyText)f.push(lbyText);}
      if(el.labels&&el.labels.length>0){var lt=(el.labels[0].textContent||'').trim().toLowerCase();if(lt)f.push(lt);}
      return f.filter(function(s){return s!='';});}
    function descriptionAliases(d){
      var a=[d];
      if(d.includes('search')&&(d.includes('box')||d.includes('field')||d.includes('input')||d.includes('bar'))){a.push('search');}
      if(intent==='click'){
        var SUFFIX=['link','button','item','result','option','suggestion','menu'];
        var SUFFIX_PHRASES=['search suggestion','menu item'];
        var parts=d.split(' ').filter(Boolean);
        var changed=true;
        while(changed&&parts.length>0){
          changed=false;
          var joined=parts.join(' ');
          for(var si=0;si<SUFFIX_PHRASES.length;si++){
            if(joined===SUFFIX_PHRASES[si]){parts=[];changed=true;break;}
            if(joined.endsWith(' '+SUFFIX_PHRASES[si])){var nj=joined.slice(0,joined.length-SUFFIX_PHRASES[si].length-1);parts=nj?nj.split(' ').filter(Boolean):[];changed=true;break;}
          }
          if(!changed&&parts.length>0){var last=parts[parts.length-1];if(SUFFIX.indexOf(last)>=0){parts=parts.slice(0,parts.length-1);changed=true;}}
        }
        var stripped=parts.join(' ');
        if(stripped&&stripped!==d){var allSuffix=parts.every(function(w){return SUFFIX.indexOf(w)>=0;});if(!allSuffix){a.push(stripped);}}
      }
      return a.filter(function(v,i,arr){return arr.indexOf(v)===i;});}
    function isTypeable(el){
      var tag=el.tagName.toLowerCase();
      var role=(el.getAttribute('role')||'').toLowerCase();
      if(tag==='input'||tag==='textarea'){return !el.disabled&&!el.readOnly;}
      if(el.isContentEditable&&el.contentEditable!=='false'){return true;}
      if(role==='combobox'||role==='searchbox'||role==='textbox'){return el.getAttribute('aria-disabled')!=='true';}
      return false;}
    var aliases=descriptionAliases(descLower);
    var exact=q.filter(function(el){return fields(el).some(function(f){return aliases.some(function(a){return f===a;});});});
    var pool=exact.length>0?exact:q.filter(function(el){return fields(el).some(function(f){return aliases.some(function(a){return f.includes(a);});});});
    if(pool.length===0)return null;
    if(intent==='type'&&pool.length>1){
      var typeable=pool.filter(isTypeable);
      if(typeable.length===1){pool=typeable;}
      else if(typeable.length>1){return 'AMBIGUOUS';}
    }
    if(pool.length>1)return 'AMBIGUOUS';
    var el=pool[0];
    el.scrollIntoView({block:'center',inline:'center'});
    var r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0)return null;
    return {x:r.left,y:r.top,width:r.width,height:r.height,vw:window.innerWidth,vh:window.innerHeight};
  })()`;
}

/**
 * Dispatches text character-by-character via CDP Input.dispatchKeyEvent.
 * General-purpose (non-credential) typing with realistic inter-character jitter.
 * Assumes the target field is already focused.
 *
 * Exported for unit testing with injected sendCdp / sleep.
 * Never logs the text value or any character sequences.
 */
export async function dispatchTextCharsViaCDP(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  sleep: (ms: number) => Promise<void>,
  text: string,
  opts?: { random?: () => number },
): Promise<Pick<RealisticTypeResult, "char_count_bucket" | "duration_ms">> {
  const random = opts?.random ?? Math.random;
  const startMs = Date.now();

  await sleep(50); // brief onset pause before first keystroke

  for (const char of text) {
    sendCdp("Input.dispatchKeyEvent", { type: "char", text: char });
    const jitter =
      GENERAL_TYPING_PROFILE.min_ms +
      random() * (GENERAL_TYPING_PROFILE.max_ms - GENERAL_TYPING_PROFILE.min_ms);
    await sleep(Math.round(jitter));
  }

  return { char_count_bucket: getCharCountBucket(text.length), duration_ms: Date.now() - startMs };
}

/**
 * Dispatches an Enter key press via CDP using Playwright-equivalent event sequence:
 * rawKeyDown → char ("\r") → keyUp. The char event fires the DOM keypress event,
 * which is what form submit handlers (including IKEA search) listen for.
 * Exported for unit testing with injected sendCdp / sleep.
 */
export async function dispatchEnterViaCDP(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  sendCdp("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(30);
  sendCdp("Input.dispatchKeyEvent", {
    type: "char", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    text: "\r", unmodifiedText: "\r",
  });
  await sleep(30);
  sendCdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(100);
}

/**
 * Finds a visible interactive element and performs a realistic pointer movement
 * + click via CDP Input.dispatchMouseEvent events.
 *
 * When selectorHint is provided (a CSS/aria selector extracted from the MCP tool
 * call's `target` argument), the element lookup tries querySelector(selectorHint)
 * first before falling back to text-description matching. This improves hit rates
 * on pages where element text does not cleanly match the agent's description.
 *
 * Returns ELEMENT_NOT_FOUND or AMBIGUOUS_ELEMENT on lookup failures so the
 * caller can fall back to @playwright/mcp's native click.
 */
export async function realisticClickByDescription(params: {
  cdpUrl: string;
  elementDescription: string;
  sessionId?: string;
  userId?: string;
  selectorHint?: string;
}): Promise<RealisticClickResult> {
  if (getInputRealismMode() === "direct") {
    return { success: false, error: "REALISM_DISABLED" };
  }

  const { cdpUrl, elementDescription, sessionId, userId, selectorHint } = params;
  const cdpDiagnostics = process.env.ANTIGEN_CDP_DIAGNOSTICS === "true";
  const debugOverlay = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true";
  const slowMoMs = parseInt(process.env.ANTIGEN_BROWSER_SLOW_MO_MS ?? "0", 10) || 0;

  let versionData: { webSocketDebuggerUrl?: string };
  let targets: Array<{ id: string; url: string; type: string }>;
  try {
    [versionData, targets] = await Promise.all([
      fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
      fetch(`${cdpUrl}/json/list`).then((r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>),
    ]);
  } catch (err) {
    return { success: false, error: `CDP_FETCH_FAILED: ${(err as Error).message}` };
  }

  const browserWsUrl = versionData.webSocketDebuggerUrl;
  if (!browserWsUrl) return { success: false, error: "No browser WebSocket debugger URL from CDP." };

  const { target: pageTarget } = pickBestPageTarget(targets, {});
  if (!pageTarget) return { success: false, error: "No page targets found via CDP." };

  const findExpr = buildElementFindExpr(elementDescription, selectorHint);
  if (cdpDiagnostics) {
    console.log("[RealisticClick] attempting element find", {
      surface: "browser_click",
      element_description: elementDescription,
      selector_hint_present: selectorHint !== undefined,
    });
  }

  return new Promise<RealisticClickResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    let boxId: number;
    // One-time CDP response handlers for sendAndWait (post-click URL read).
    const oneTimeHandlers = new Map<number, (result: Record<string, unknown> | undefined) => void>();

    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ success: false, error: "Realistic click timed out after 8 seconds." });
    }, 8_000);

    const sendMsg = (method: string, params: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    const finish = (result: RealisticClickResult) => {
      clearTimeout(timer);
      ws.close();
      resolve(result);
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

      // Dispatch one-time handlers (sendAndWait) before named stage handlers.
      if (oneTimeHandlers.has(id)) {
        const handler = oneTimeHandlers.get(id)!;
        oneTimeHandlers.delete(id);
        handler(result);
        return;
      }

      if (id === attachId) {
        if (!result?.sessionId) {
          finish({ success: false, error: "CDP attach failed: no sessionId." });
          return;
        }
        cdpSessionId = result.sessionId as string;
        boxId = sendMsg("Runtime.evaluate", { expression: findExpr, returnByValue: true }, cdpSessionId);
        return;
      }

      if (id === boxId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const val = evalResult?.value;

        if (val === null || val === undefined) {
          if (cdpDiagnostics) {
            console.log("[RealisticClick] element not found", {
              surface: "browser_click",
              element_description: elementDescription,
              selector_hint_present: selectorHint !== undefined,
              reason: "ELEMENT_NOT_FOUND",
            });
          }
          finish({ success: false, error: "ELEMENT_NOT_FOUND" });
          return;
        }
        if (val === "AMBIGUOUS") {
          if (cdpDiagnostics) {
            console.log("[RealisticClick] ambiguous element match", {
              surface: "browser_click",
              element_description: elementDescription,
              selector_hint_present: selectorHint !== undefined,
              reason: "AMBIGUOUS",
            });
          }
          finish({ success: false, error: "AMBIGUOUS_ELEMENT" });
          return;
        }

        const boxVal = val as { x: number; y: number; width: number; height: number; vw?: number; vh?: number };
        const vw = boxVal.vw ?? 1280;
        const vh = boxVal.vh ?? 800;
        const box: ElementBox = { x: boxVal.x, y: boxVal.y, width: boxVal.width, height: boxVal.height };

        if (cdpDiagnostics) {
          console.log("[RealisticClick] element located, dispatching pointer", {
            surface: "browser_click",
            box_width: Math.round(box.width),
            box_height: Math.round(box.height),
          });
        }

        const sendCdp = (method: string, p: Record<string, unknown>) => {
          void sendMsg(method, p, cdpSessionId!);
        };
        const sendAndWait = (method: string, p: Record<string, unknown>): Promise<Record<string, unknown> | undefined> =>
          new Promise((res) => {
            const reqId = sendMsg(method, p, cdpSessionId!);
            oneTimeHandlers.set(reqId, res);
          });
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

        void (async () => {
          try {
            const clickResult = await dispatchPointerClickToBox({
              box, vw, vh, sessionId, userId, sendCdp, sleep, debugOverlay,
            });
            // Refresh the live URL after a click-triggered navigation settles.
            // Best-effort: a failed read never fails an otherwise-successful click.
            const currentUrl = clickResult.success ? await readCurrentUrlAfterClick(sendAndWait, sleep) : null;
            finish(currentUrl ? { ...clickResult, current_url: currentUrl } : clickResult);
          } catch (err) {
            finish({ success: false, error: `CDP_CLICK_FAILED: ${(err as Error).message}` });
          }
        })();
      }
    });

    ws.on("error", (err: Error) => {
      finish({ success: false, error: `WS_ERROR: ${err.message}` });
    });
  });
}

/**
 * Realistic-pointer click of a KNOWN element box (Antigen Phase 4A + 4B).
 *
 * Used by the exact `ag_*` ref path: the caller has already resolved the box
 * from the active Antigen snapshot store, so there is NO element finding here.
 *
 * Phase 4B — lightweight stale-ref revalidation: when `expected` snapshot
 * metadata is supplied, the single Runtime.evaluate on this path inspects the
 * live element under the stored box center via document.elementFromPoint and
 * returns its safe metadata alongside viewport dims. It NEVER clicks, dispatches
 * events, or rediscovers alternatives. If the live element is not broadly
 * compatible with the snapshot element, this fails closed with ANTIGEN_REF_STALE
 * BEFORE any pointer movement. When `expected` is absent, the eval reads viewport
 * dims only (Phase 4A behavior) for pointer clamping.
 *
 * The click itself is realistic pointer movement to the given box via
 * clickBoxWithPointer (shared dispatchPointerClickToBox), so it produces the same
 * pointer metadata as the description path. Never element.click().
 */
export async function realisticClickKnownBox(params: {
  cdpUrl: string;
  box: ElementBox;
  sessionId?: string;
  userId?: string;
  expected?: AntigenKnownBoxRevalidationExpected;
}): Promise<RealisticClickResult> {
  if (getInputRealismMode() === "direct") {
    return { success: false, error: "REALISM_DISABLED" };
  }

  const { cdpUrl, box, sessionId, userId, expected } = params;
  const cdpDiagnostics = process.env.ANTIGEN_CDP_DIAGNOSTICS === "true";
  const debugOverlay = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true";
  const slowMoMs = parseInt(process.env.ANTIGEN_BROWSER_SLOW_MO_MS ?? "0", 10) || 0;

  let versionData: { webSocketDebuggerUrl?: string };
  let targets: Array<{ id: string; url: string; type: string }>;
  try {
    [versionData, targets] = await Promise.all([
      fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
      fetch(`${cdpUrl}/json/list`).then((r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>),
    ]);
  } catch (err) {
    return { success: false, error: `CDP_FETCH_FAILED: ${(err as Error).message}` };
  }

  const browserWsUrl = versionData.webSocketDebuggerUrl;
  if (!browserWsUrl) return { success: false, error: "No browser WebSocket debugger URL from CDP." };

  const { target: pageTarget } = pickBestPageTarget(targets, {});
  if (!pageTarget) return { success: false, error: "No page targets found via CDP." };

  // Phase 4B: when `expected` snapshot metadata is supplied, this eval also
  // inspects the live element under the stored box center (elementFromPoint) for
  // stale-ref revalidation; it still returns vw/vh for pointer clamping. With no
  // `expected`, it is the Phase 4A geometry-only viewport read. Either way: no
  // element click, no DOM mutation.
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const viewportExpr = expected
    ? buildAntigenRevalidationExpr(centerX, centerY)
    : "(function(){return {vw:window.innerWidth,vh:window.innerHeight};})()";

  return new Promise<RealisticClickResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    let viewportId: number;
    // One-time CDP response handlers for sendAndWait (post-click URL read).
    const oneTimeHandlers = new Map<number, (result: Record<string, unknown> | undefined) => void>();

    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ success: false, error: "Realistic click timed out after 8 seconds." });
    }, 8_000);

    const sendMsg = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params: p };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    const finish = (result: RealisticClickResult) => {
      clearTimeout(timer);
      ws.close();
      resolve(result);
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

      // Dispatch one-time handlers (sendAndWait) before named stage handlers.
      if (oneTimeHandlers.has(id)) {
        const handler = oneTimeHandlers.get(id)!;
        oneTimeHandlers.delete(id);
        handler(result);
        return;
      }

      if (id === attachId) {
        if (!result?.sessionId) {
          finish({ success: false, error: "CDP attach failed: no sessionId." });
          return;
        }
        cdpSessionId = result.sessionId as string;
        viewportId = sendMsg("Runtime.evaluate", { expression: viewportExpr, returnByValue: true }, cdpSessionId);
        return;
      }

      if (id === viewportId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const val = evalResult?.value as ({ vw?: number; vh?: number } & Partial<AntigenRevalidationEvalValue>) | undefined;
        const vw = val?.vw ?? 1280;
        const vh = val?.vh ?? 800;

        // Phase 4B: fail closed before any pointer movement when the live element
        // under the stored box center is not broadly compatible with the snapshot
        // element. Revalidation only runs when `expected` was supplied (the eval
        // carries a `status` discriminator); the elementFromPoint inspection never
        // clicks or mutates the DOM.
        if (expected && val?.status) {
          const revalidation = evaluateKnownBoxRevalidation({
            eval: val as AntigenRevalidationEvalValue,
            expected,
          });
          if (revalidation.status === "stale") {
            if (cdpDiagnostics) {
              console.log("[RealisticClick] antigen ref stale", {
                surface: "browser_click",
                reason: revalidation.reason,
                ...(revalidation.diagnostic ?? {}),
              });
            }
            finish({ success: false, error: "ANTIGEN_REF_STALE" });
            return;
          }
        }

        if (cdpDiagnostics) {
          console.log("[RealisticClick] antigen ref box, dispatching pointer", {
            surface: "browser_click",
            box_width: Math.round(box.width),
            box_height: Math.round(box.height),
          });
        }

        const sendCdp = (method: string, p: Record<string, unknown>) => {
          void sendMsg(method, p, cdpSessionId!);
        };
        const sendAndWait = (method: string, p: Record<string, unknown>): Promise<Record<string, unknown> | undefined> =>
          new Promise((res) => {
            const reqId = sendMsg(method, p, cdpSessionId!);
            oneTimeHandlers.set(reqId, res);
          });
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

        void (async () => {
          try {
            const clickResult = await dispatchPointerClickToBox({
              box, vw, vh, sessionId, userId, sendCdp, sleep, debugOverlay,
            });
            // Refresh the live URL after a click-triggered navigation settles.
            // Best-effort: a failed read never fails an otherwise-successful click.
            const currentUrl = clickResult.success ? await readCurrentUrlAfterClick(sendAndWait, sleep) : null;
            finish(currentUrl ? { ...clickResult, current_url: currentUrl } : clickResult);
          } catch (err) {
            finish({ success: false, error: `CDP_CLICK_FAILED: ${(err as Error).message}` });
          }
        })();
      }
    });

    ws.on("error", (err: Error) => {
      finish({ success: false, error: `WS_ERROR: ${err.message}` });
    });
  });
}

/**
 * Types text character-by-character into a target element via CDP.
 *
 * When elementDescription is provided, first finds the element via Runtime.evaluate,
 * then performs a realistic pointer click (focus), then types. Pointer overlay appears
 * for the focus click just as it does for browser_click.
 *
 * When elementDescription is absent, verifies that there is already a focusable active
 * element before dispatching key events. Returns NO_FOCUSABLE_ACTIVE_ELEMENT if not.
 *
 * When submit is true, dispatches Enter after typing.
 *
 * The text value is never logged or returned to the caller.
 */
export async function realisticTypeTextViaCDP(params: {
  cdpUrl: string;
  text: string;
  sessionId?: string;
  userId?: string;
  elementDescription?: string;
  selectorHint?: string;
  submit?: boolean;
}): Promise<RealisticTypeResult> {
  const charCountBucket = getCharCountBucket(params.text.length);

  if (getInputRealismMode() === "direct") {
    return { success: false, error: "REALISM_DISABLED", char_count_bucket: charCountBucket, duration_ms: 0 };
  }

  const { cdpUrl, text, elementDescription, selectorHint, submit, sessionId, userId } = params;
  const cdpDiagnostics = process.env.ANTIGEN_CDP_DIAGNOSTICS === "true";
  const debugOverlay = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true";
  const slowMoMs = parseInt(process.env.ANTIGEN_BROWSER_SLOW_MO_MS ?? "0", 10) || 0;

  let versionData: { webSocketDebuggerUrl?: string };
  let targets: Array<{ id: string; url: string; type: string }>;
  try {
    [versionData, targets] = await Promise.all([
      fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
      fetch(`${cdpUrl}/json/list`).then((r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>),
    ]);
  } catch (err) {
    return {
      success: false,
      error: `CDP_FETCH_FAILED: ${(err as Error).message}`,
      char_count_bucket: charCountBucket,
      duration_ms: 0,
    };
  }

  const browserWsUrl = versionData.webSocketDebuggerUrl;
  if (!browserWsUrl) {
    return { success: false, error: "No browser WebSocket debugger URL from CDP.", char_count_bucket: charCountBucket, duration_ms: 0 };
  }

  const { target: pageTarget } = pickBestPageTarget(targets, {});
  if (!pageTarget) {
    return { success: false, error: "No page targets found via CDP.", char_count_bucket: charCountBucket, duration_ms: 0 };
  }

  if (cdpDiagnostics) {
    const pageCandidates = targets
      .filter((t) => t.type === "page")
      .map((t) => ({ url: t.url, chosen: t.id === pageTarget.id }));
    console.log("[RealisticType] target_candidates", { surface: "browser_type", candidates: pageCandidates });
  }

  return new Promise<RealisticTypeResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    // evalId: used when elementDescription provided — lookup + focus path
    let evalId: number | null = null;
    // activeCheckId: used when no elementDescription — verify active element
    let activeCheckId: number | null = null;
    // Diagnostic state: href + selector checks fired before the findExpr eval when cdpDiagnostics=true
    let hrefCheckId: number | null = null;
    let selectorCheckId: number | null = null;
    let diagHrefDone = false;
    let diagSelectorDone = false;
    let diagHref: string | null = null;
    let diagSelectorFound: boolean | null = null;
    let diagEvalFired = false;
    let diagFallbackTimerId: ReturnType<typeof setTimeout> | null = null;
    const startMs = Date.now();
    // One-time CDP response handlers for sendAndWait calls inside Stage 2a/2b IIFEs.
    // Checked before all named stage handlers in ws.on("message", ...).
    const oneTimeHandlers = new Map<number, (result: Record<string, unknown> | undefined) => void>();
    let finishCalled = false;

    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ success: false, error: "Realistic type timed out after 15 seconds.", char_count_bucket: charCountBucket, duration_ms: Date.now() - startMs });
    }, 15_000);

    const sendMsg = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params: p };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    const finish = (result: RealisticTypeResult) => {
      if (finishCalled) return;
      finishCalled = true;
      clearTimeout(timer);
      if (diagFallbackTimerId !== null) clearTimeout(diagFallbackTimerId);
      ws.close();
      resolve(result);
    };

    // Fires the findExpr eval exactly once — called when both diag checks complete or
    // when the fallback timer fires (guards against a hung CDP eval stalling the flow).
    const fireEvalIdOnce = () => {
      if (diagEvalFired) return;
      diagEvalFired = true;
      if (diagFallbackTimerId !== null) clearTimeout(diagFallbackTimerId);
      evalId = sendMsg("Runtime.evaluate", { expression: buildElementFindExpr(elementDescription!, selectorHint, "type"), returnByValue: true }, cdpSessionId!);
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

      // Dispatch one-time handlers (sendAndWait) before named stage handlers.
      if (oneTimeHandlers.has(id)) {
        const handler = oneTimeHandlers.get(id)!;
        oneTimeHandlers.delete(id);
        handler(result);
        return;
      }

      // ── Stage 1: attach response ──────────────────────────────────────────────
      if (id === attachId) {
        if (!result?.sessionId) {
          finish({ success: false, error: "CDP attach failed.", char_count_bucket: charCountBucket, duration_ms: Date.now() - startMs });
          return;
        }
        cdpSessionId = result.sessionId as string;

        if (cdpDiagnostics) {
          console.log("[RealisticType] attempt", {
            surface: "browser_type",
            has_target: !!elementDescription,
            submit: !!submit,
            char_count_bucket: charCountBucket,
          });
        }

        if (elementDescription) {
          if (cdpDiagnostics) {
            // Fire href + querySelector checks first; evalId fires after both return (or after fallback timer)
            hrefCheckId = sendMsg("Runtime.evaluate", { expression: "location.href", returnByValue: true }, cdpSessionId);
            selectorCheckId = sendMsg("Runtime.evaluate", { expression: "document.querySelector('#ikea-search-input') !== null", returnByValue: true }, cdpSessionId);
            diagFallbackTimerId = setTimeout(fireEvalIdOnce, 1000);
          } else {
            // Non-diagnostic path: fire findExpr directly
            evalId = sendMsg("Runtime.evaluate", { expression: buildElementFindExpr(elementDescription, selectorHint, "type"), returnByValue: true }, cdpSessionId);
          }
        } else {
          // No-target path: verify there is an active focusable element
          activeCheckId = sendMsg("Runtime.evaluate", { expression: ACTIVE_ELEMENT_CHECK_EXPR, returnByValue: true }, cdpSessionId);
        }
        return;
      }

      // ── Diag: href check (cdpDiagnostics path only) ───────────────────────────
      if (hrefCheckId !== null && id === hrefCheckId) {
        const r = result?.result as Record<string, unknown> | undefined;
        diagHref = (r?.value as string) ?? null;
        diagHrefDone = true;
        if (diagSelectorDone) fireEvalIdOnce();
        return;
      }

      // ── Diag: selector check (cdpDiagnostics path only) ──────────────────────
      if (selectorCheckId !== null && id === selectorCheckId) {
        const r = result?.result as Record<string, unknown> | undefined;
        diagSelectorFound = (r?.value as boolean) ?? null;
        diagSelectorDone = true;
        if (diagHrefDone) fireEvalIdOnce();
        return;
      }

      // ── Stage 2a: element lookup (with elementDescription) ────────────────────
      if (evalId !== null && id === evalId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const val = evalResult?.value;

        if (val === null || val === undefined) {
          if (cdpDiagnostics) {
            console.log("[RealisticType] element_not_found_detail", {
              chosen_target_href: diagHref,
              selector_check: diagSelectorFound,
              element_description: elementDescription,
            });
            console.log("[RealisticType] focus_fallback", { surface: "browser_type", reason: "ELEMENT_NOT_FOUND" });
          }
          finish({ success: false, error: "ELEMENT_NOT_FOUND", char_count_bucket: charCountBucket, duration_ms: Date.now() - startMs });
          return;
        }
        if (val === "AMBIGUOUS") {
          if (cdpDiagnostics) console.log("[RealisticType] focus_fallback", { surface: "browser_type", reason: "AMBIGUOUS_ELEMENT" });
          finish({ success: false, error: "AMBIGUOUS_ELEMENT", char_count_bucket: charCountBucket, duration_ms: Date.now() - startMs });
          return;
        }

        const boxVal = val as { x: number; y: number; width: number; height: number; vw?: number; vh?: number };
        const vw = boxVal.vw ?? 1280;
        const vh = boxVal.vh ?? 800;
        const box: ElementBox = { x: boxVal.x, y: boxVal.y, width: boxVal.width, height: boxVal.height };

        if (cdpDiagnostics) {
          console.log("[RealisticType] focus_success", {
            surface: "browser_type",
            box_width: Math.round(box.width),
            box_height: Math.round(box.height),
          });
        }

        // Two-tier pointer state load: taskBrowserSessions preferred when userId is
        // available; browsingPointerState as fast in-process fallback.
        let savedTypeState: { x: number; y: number } | undefined;
        if (sessionId && userId) {
          const saved = getTaskBrowserSessionPointerState(sessionId, userId);
          if (saved?.initialized) savedTypeState = { x: saved.x, y: saved.y };
        }
        if (!savedTypeState && sessionId) savedTypeState = browsingPointerState.get(sessionId);
        const typePointerStartSource: "session" | "viewport_center" = savedTypeState ? "session" : "viewport_center";

        const state = makePointerRuntimeState({
          current_x: savedTypeState?.x ?? vw / 2,
          current_y: savedTypeState?.y ?? vh / 2,
          viewport_width: vw,
          viewport_height: vh,
          browser_session_id: sessionId,
          interaction_mode: "realistic",
        });

        const sendCdp = (method: string, p: Record<string, unknown>) => {
          void sendMsg(method, p, cdpSessionId!);
        };
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

        void (async () => {
          try {
            const sendAndWait = (method: string, p: Record<string, unknown>): Promise<Record<string, unknown> | undefined> =>
              new Promise((resolve) => {
                const id = sendMsg(method, p, cdpSessionId!);
                oneTimeHandlers.set(id, resolve);
              });

            let focusPathCount: number | undefined;
            await clickBoxWithPointer(state, box, sendCdp, sleep, {
              debugOverlay,
              debugLabel: "type_focus",
              templateTraces: getLoadedPointerTraces(),
              purpose: "input_focus",
              onFocusComplete: (info) => { focusPathCount = info.path_point_count; },
            });
            let typeStatePersisted = false;
            if (sessionId) {
              browsingPointerState.set(sessionId, { x: state.current_x, y: state.current_y });
              if (userId) {
                setTaskBrowserSessionPointerState(sessionId, userId, {
                  x: state.current_x,
                  y: state.current_y,
                  initialized: true,
                  updated_at: new Date().toISOString(),
                });
                typeStatePersisted = true;
              }
            }

            // Capture URL before typing — only when submit=true, for post-Enter navigation check.
            let urlBefore: string | null = null;
            if (submit) {
              const r = await sendAndWait("Runtime.evaluate", { expression: "document.location.href", returnByValue: true });
              urlBefore = (r?.result as Record<string, unknown>)?.value as string ?? null;
            }

            const typing = await dispatchTextCharsViaCDP(sendCdp, sleep, text);
            let submitted = false;
            let submitMethod: "enter" | "button_fallback" | undefined;
            if (submit) {
              await dispatchEnterViaCDP(sendCdp, sleep);
              submitted = true;
              if (cdpDiagnostics) console.log("[RealisticType] submit_success", { surface: "browser_type" });
              submitMethod = "enter";

              // Fallback: if Enter did not navigate, try a visible search/submit button.
              if (urlBefore !== null) {
                await sleep(300);
                const r2 = await sendAndWait("Runtime.evaluate", { expression: "document.location.href", returnByValue: true });
                const urlAfter = (r2?.result as Record<string, unknown>)?.value as string ?? null;
                if (urlAfter !== null && urlAfter === urlBefore) {
                  const r3 = await sendAndWait("Runtime.evaluate", { expression: SEARCH_BUTTON_FIND_EXPR, returnByValue: true });
                  const btn = (r3?.result as Record<string, unknown>)?.value as { x: number; y: number; width: number; height: number; vw: number; vh: number } | null | undefined;
                  if (btn && btn.width > 0 && btn.height > 0) {
                    // state already holds pointer at search-input position — fallback click moves naturally from there.
                    const fallbackBox: ElementBox = { x: btn.x, y: btn.y, width: btn.width, height: btn.height };
                    await clickBoxWithPointer(state, fallbackBox, sendCdp, sleep, {
                      debugOverlay,
                      debugLabel: "submit_button_fallback",
                      templateTraces: getLoadedPointerTraces(),
                      purpose: "button_click",
                    });
                    if (sessionId) {
                      browsingPointerState.set(sessionId, { x: state.current_x, y: state.current_y });
                      if (userId) {
                        setTaskBrowserSessionPointerState(sessionId, userId, {
                          x: state.current_x,
                          y: state.current_y,
                          initialized: true,
                          updated_at: new Date().toISOString(),
                        });
                      }
                    }
                    submitMethod = "button_fallback";
                    if (cdpDiagnostics) console.log("[RealisticType] submit_button_fallback", { surface: "browser_type" });
                  }
                }
              }
            }

            if (cdpDiagnostics) {
              console.log("[RealisticType] complete", {
                surface: "browser_type",
                char_count_bucket: typing.char_count_bucket,
                duration_ms: typing.duration_ms,
                focused: true,
                submitted,
                ...(submitMethod !== undefined ? { submit_method: submitMethod } : {}),
              });
            }
            finish({
              success: true,
              char_count_bucket: typing.char_count_bucket,
              duration_ms: typing.duration_ms,
              focused: true,
              submitted,
              ...(submitMethod !== undefined ? { submit_method: submitMethod } : {}),
              ...(focusPathCount !== undefined ? { pointer_path_point_count: focusPathCount } : {}),
              pointer_start_source: typePointerStartSource,
              pointer_state_persisted: typeStatePersisted,
            });
          } catch (err) {
            finish({ success: false, error: `CDP_TYPE_FAILED: ${(err as Error).message}`, char_count_bucket: charCountBucket, duration_ms: Date.now() - startMs });
          }
        })();
        return;
      }

      // ── Stage 2b: active element check (no elementDescription) ───────────────
      if (activeCheckId !== null && id === activeCheckId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const val = evalResult?.value;

        if (val === null || val === undefined) {
          finish({ success: false, error: "NO_FOCUSABLE_ACTIVE_ELEMENT", char_count_bucket: charCountBucket, duration_ms: Date.now() - startMs });
          return;
        }

        const sendCdp = (method: string, p: Record<string, unknown>) => {
          void sendMsg(method, p, cdpSessionId!);
        };
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

        void (async () => {
          try {
            const sendAndWait = (method: string, p: Record<string, unknown>): Promise<Record<string, unknown> | undefined> =>
              new Promise((resolve) => {
                const id = sendMsg(method, p, cdpSessionId!);
                oneTimeHandlers.set(id, resolve);
              });

            let urlBefore: string | null = null;
            if (submit) {
              const r = await sendAndWait("Runtime.evaluate", { expression: "document.location.href", returnByValue: true });
              urlBefore = (r?.result as Record<string, unknown>)?.value as string ?? null;
            }

            const typing = await dispatchTextCharsViaCDP(sendCdp, sleep, text);
            let submitted = false;
            let submitMethod: "enter" | "button_fallback" | undefined;
            if (submit) {
              await dispatchEnterViaCDP(sendCdp, sleep);
              submitted = true;
              if (cdpDiagnostics) console.log("[RealisticType] submit_success", { surface: "browser_type" });
              submitMethod = "enter";

              if (urlBefore !== null) {
                await sleep(300);
                const r2 = await sendAndWait("Runtime.evaluate", { expression: "document.location.href", returnByValue: true });
                const urlAfter = (r2?.result as Record<string, unknown>)?.value as string ?? null;
                if (urlAfter !== null && urlAfter === urlBefore) {
                  const r3 = await sendAndWait("Runtime.evaluate", { expression: SEARCH_BUTTON_FIND_EXPR, returnByValue: true });
                  const btn = (r3?.result as Record<string, unknown>)?.value as { x: number; y: number; width: number; height: number; vw: number; vh: number } | null | undefined;
                  if (btn && btn.width > 0 && btn.height > 0) {
                    let savedFallbackState: { x: number; y: number } | undefined;
                    if (sessionId && userId) {
                      const saved = getTaskBrowserSessionPointerState(sessionId, userId);
                      if (saved?.initialized) savedFallbackState = { x: saved.x, y: saved.y };
                    }
                    if (!savedFallbackState && sessionId) savedFallbackState = browsingPointerState.get(sessionId);
                    const fallbackState = makePointerRuntimeState({
                      current_x: savedFallbackState?.x ?? btn.vw / 2,
                      current_y: savedFallbackState?.y ?? btn.vh / 2,
                      viewport_width: btn.vw,
                      viewport_height: btn.vh,
                      browser_session_id: sessionId,
                      interaction_mode: "realistic",
                    });
                    const fallbackBox: ElementBox = { x: btn.x, y: btn.y, width: btn.width, height: btn.height };
                    await clickBoxWithPointer(fallbackState, fallbackBox, sendCdp, sleep, {
                      debugOverlay,
                      debugLabel: "submit_button_fallback",
                      templateTraces: getLoadedPointerTraces(),
                      purpose: "button_click",
                    });
                    if (sessionId) {
                      browsingPointerState.set(sessionId, { x: fallbackState.current_x, y: fallbackState.current_y });
                      if (userId) {
                        setTaskBrowserSessionPointerState(sessionId, userId, {
                          x: fallbackState.current_x,
                          y: fallbackState.current_y,
                          initialized: true,
                          updated_at: new Date().toISOString(),
                        });
                      }
                    }
                    submitMethod = "button_fallback";
                    if (cdpDiagnostics) console.log("[RealisticType] submit_button_fallback", { surface: "browser_type" });
                  }
                }
              }
            }

            if (cdpDiagnostics) {
              console.log("[RealisticType] complete", {
                surface: "browser_type",
                char_count_bucket: typing.char_count_bucket,
                duration_ms: typing.duration_ms,
                focused: false,
                submitted,
                ...(submitMethod !== undefined ? { submit_method: submitMethod } : {}),
              });
            }
            finish({
              success: true,
              char_count_bucket: typing.char_count_bucket,
              duration_ms: typing.duration_ms,
              focused: false,
              submitted,
              ...(submitMethod !== undefined ? { submit_method: submitMethod } : {}),
            });
          } catch (err) {
            finish({ success: false, error: `CDP_TYPE_FAILED: ${(err as Error).message}`, char_count_bucket: charCountBucket, duration_ms: Date.now() - startMs });
          }
        })();
        return;
      }
    });

    ws.on("error", (err: Error) => {
      finish({ success: false, error: `WS_ERROR: ${err.message}`, char_count_bucket: charCountBucket, duration_ms: 0 });
    });
  });
}
