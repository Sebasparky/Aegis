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
import { getInputRealismMode, getCharCountBucket } from "./inputRealismTyper.js";
import { getLoadedPointerTraces } from "./pointerProfileLoader.js";

// Module-level general browsing pointer state — tracks position between actions
// in the same browser session. Keyed by browser_runtime_id.
// Separate from credential injection pointer state to avoid cross-contamination.
const browsingPointerState = new Map<string, { x: number; y: number }>();

export const GENERAL_TYPING_PROFILE = { min_ms: 30, max_ms: 80 } as const;

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

export interface RealisticClickResult {
  success: boolean;
  error?: string;
}

export interface RealisticTypeResult {
  success: boolean;
  error?: string;
  char_count_bucket: string;
  duration_ms: number;
  focused?: boolean;    // true if this call performed a click to focus the target field
  submitted?: boolean;  // true if Enter was dispatched after typing
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
export function buildElementFindExpr(elementDescription: string, selectorHint?: string): string {
  const desc = JSON.stringify(elementDescription);

  // Selector-first block: injected only when a hint is available.
  // Wrapped in try/catch so an invalid selector never throws to the caller.
  const selectorBlock = selectorHint
    ? `try{var sh=document.querySelector(${JSON.stringify(selectorHint)});if(sh){var shr=sh.getBoundingClientRect();if(shr.width>0||shr.height>0){sh.scrollIntoView({block:'center',inline:'center'});shr=sh.getBoundingClientRect();return {x:shr.left,y:shr.top,width:shr.width,height:shr.height,vw:window.innerWidth,vh:window.innerHeight};}}}catch(se){}`
    : "";

  return `(function(){${selectorBlock}
    var desc=${desc};
    var descLower=desc.toLowerCase();
    function vis(el){try{var r=el.getBoundingClientRect();return r.width>0||r.height>0;}catch(e){return false;}}
    var q=Array.from(document.querySelectorAll('a,button,[role=button],[role=link],input,select,textarea,[tabindex]'));
    q=q.filter(function(el){return vis(el);});
    function fields(el){return [
      (el.getAttribute('aria-label')||'').trim().toLowerCase(),
      (el.getAttribute('placeholder')||'').trim().toLowerCase(),
      (el.getAttribute('title')||'').trim().toLowerCase(),
      (el.getAttribute('name')||'').trim().toLowerCase(),
      (el.textContent||'').trim().toLowerCase()
    ].filter(function(f){return f!=='';});}
    var exact=q.filter(function(el){return fields(el).some(function(f){return f===descLower;});});
    var pool=exact.length>0?exact:q.filter(function(el){return fields(el).some(function(f){return f.includes(descLower);});});
    if(pool.length===0)return null;
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
 * Dispatches an Enter key press (keyDown + keyUp) via CDP.
 * Used after typing when submit:true is requested.
 * Exported for unit testing with injected sendCdp / sleep.
 */
export async function dispatchEnterViaCDP(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  sendCdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Return", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(50);
  sendCdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Return", code: "Enter",
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
  selectorHint?: string;
}): Promise<RealisticClickResult> {
  if (getInputRealismMode() === "direct") {
    return { success: false, error: "REALISM_DISABLED" };
  }

  const { cdpUrl, elementDescription, sessionId, selectorHint } = params;
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
  if (cdpDiagnostics && selectorHint) {
    console.log("[RealisticClick] selector_hint provided — trying querySelector first", { surface: "browser_click" });
  }

  return new Promise<RealisticClickResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    let boxId: number;

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
          if (cdpDiagnostics) console.log("[RealisticClick] element not found", { surface: "browser_click" });
          finish({ success: false, error: "ELEMENT_NOT_FOUND" });
          return;
        }
        if (val === "AMBIGUOUS") {
          if (cdpDiagnostics) console.log("[RealisticClick] ambiguous element match", { surface: "browser_click" });
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

        const localState = sessionId ? browsingPointerState.get(sessionId) : undefined;
        const state = makePointerRuntimeState({
          current_x: localState?.x ?? vw / 2,
          current_y: localState?.y ?? vh / 2,
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
            await clickBoxWithPointer(state, box, sendCdp, sleep, {
              debugOverlay,
              debugLabel: "general_click",
              templateTraces: getLoadedPointerTraces(),
              purpose: "button_click",
            });
            if (sessionId) {
              browsingPointerState.set(sessionId, { x: state.current_x, y: state.current_y });
            }
            finish({ success: true });
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
  elementDescription?: string;
  selectorHint?: string;
  submit?: boolean;
}): Promise<RealisticTypeResult> {
  const charCountBucket = getCharCountBucket(params.text.length);

  if (getInputRealismMode() === "direct") {
    return { success: false, error: "REALISM_DISABLED", char_count_bucket: charCountBucket, duration_ms: 0 };
  }

  const { cdpUrl, text, elementDescription, selectorHint, submit, sessionId } = params;
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

  return new Promise<RealisticTypeResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    // evalId: used when elementDescription provided — lookup + focus path
    let evalId: number | null = null;
    // activeCheckId: used when no elementDescription — verify active element
    let activeCheckId: number | null = null;
    const startMs = Date.now();

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
          // Focus path: find element, click to focus, then type
          const findExpr = buildElementFindExpr(elementDescription, selectorHint);
          evalId = sendMsg("Runtime.evaluate", { expression: findExpr, returnByValue: true }, cdpSessionId);
        } else {
          // No-target path: verify there is an active focusable element
          activeCheckId = sendMsg("Runtime.evaluate", { expression: ACTIVE_ELEMENT_CHECK_EXPR, returnByValue: true }, cdpSessionId);
        }
        return;
      }

      // ── Stage 2a: element lookup (with elementDescription) ────────────────────
      if (evalId !== null && id === evalId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const val = evalResult?.value;

        if (val === null || val === undefined) {
          if (cdpDiagnostics) console.log("[RealisticType] focus_fallback", { surface: "browser_type", reason: "ELEMENT_NOT_FOUND" });
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

        const localState = sessionId ? browsingPointerState.get(sessionId) : undefined;
        const state = makePointerRuntimeState({
          current_x: localState?.x ?? vw / 2,
          current_y: localState?.y ?? vh / 2,
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
            await clickBoxWithPointer(state, box, sendCdp, sleep, {
              debugOverlay,
              debugLabel: "type_focus",
              templateTraces: getLoadedPointerTraces(),
              purpose: "input_focus",
            });
            if (sessionId) {
              browsingPointerState.set(sessionId, { x: state.current_x, y: state.current_y });
            }
            const typing = await dispatchTextCharsViaCDP(sendCdp, sleep, text);
            let submitted = false;
            if (submit) {
              await dispatchEnterViaCDP(sendCdp, sleep);
              submitted = true;
              if (cdpDiagnostics) console.log("[RealisticType] submit_success", { surface: "browser_type" });
            }
            if (cdpDiagnostics) {
              console.log("[RealisticType] complete", {
                surface: "browser_type",
                char_count_bucket: typing.char_count_bucket,
                duration_ms: typing.duration_ms,
                focused: true,
                submitted,
              });
            }
            finish({ success: true, char_count_bucket: typing.char_count_bucket, duration_ms: typing.duration_ms, focused: true, submitted });
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
            const typing = await dispatchTextCharsViaCDP(sendCdp, sleep, text);
            let submitted = false;
            if (submit) {
              await dispatchEnterViaCDP(sendCdp, sleep);
              submitted = true;
              if (cdpDiagnostics) console.log("[RealisticType] submit_success", { surface: "browser_type" });
            }
            if (cdpDiagnostics) {
              console.log("[RealisticType] complete", {
                surface: "browser_type",
                char_count_bucket: typing.char_count_bucket,
                duration_ms: typing.duration_ms,
                focused: false,
                submitted,
              });
            }
            finish({ success: true, char_count_bucket: typing.char_count_bucket, duration_ms: typing.duration_ms, focused: false, submitted });
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
