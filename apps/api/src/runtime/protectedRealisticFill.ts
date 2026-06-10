import WebSocket from "ws";
import {
  makePointerRuntimeState,
  clickBoxWithPointer,
  type PointerRuntimeState,
  type ElementBox,
} from "./nativePointerRuntime.js";
import {
  getTaskBrowserSessionPointerState,
  setTaskBrowserSessionPointerState,
} from "./taskBrowserSessions.js";
import { getLoadedPointerTraces } from "./pointerProfileLoader.js";
import { getInputRealismMode, typeCharsViaCDP } from "./inputRealismTyper.js";
import { timingEnabled } from "./browserTiming.js";

/**
 * Protected Realistic Fill — shared sensitive-value input primitive.
 *
 * Generalizes the proven realistic-fill state machine used by
 * `executeSecretInjectionViaCDP` (secretInjection.ts) so that any protected
 * sensitive fill enters its value the way a human would: realistic pointer
 * movement to the field, click/focus, character-by-character typing, and the
 * input/change/blur sequence the page's validators expect — instead of an
 * invisible DOM `value` mutation.
 *
 * Secret-safety contract (do not weaken):
 * - The sensitive `value` flows: caller → this function → CDP key events /
 *   Runtime.evaluate → browser field. It is NEVER logged, returned, persisted,
 *   or placed in an error message. Only masked booleans / enum summaries are
 *   returned.
 * - `selectorExpr` is built by the caller and must never embed the value.
 * - When `maskDomValue` is set (card_number / cvv / password), the field's DOM
 *   `value` getter is masked to '' after the fill so the value can't be read back.
 * - SELECT fields are never masked (the page must read the option to submit) and
 *   never typed — the actual option is selected and verified by read-back.
 * - Fields inside an <iframe> fail closed with IFRAME_NOT_SUPPORTED. This
 *   primitive does not reach into cross-origin payment iframes (pointer
 *   coordinates are parent-document-relative); hosted-iframe support stays on
 *   each caller's dedicated path.
 *
 * The caller resolves the browser WebSocket URL and page target and passes
 * `pageTargetId`, so each caller keeps its own target-selection and selector
 * guards outside this primitive.
 */

export interface ProtectedRealisticFillParams {
  /** Browser-level CDP WebSocket debugger URL (from /json/version). */
  browserWsUrl: string;
  /** CDP target id of the page to attach to. Caller selects this. */
  pageTargetId: string;
  /** JS expression that resolves to the target element. Must NOT embed the value. */
  selectorExpr: string;
  /** The sensitive value. CDP-only — never logged, returned, or persisted. */
  value: string;
  /** Install the post-fill DOM `value` getter mask (card_number / cvv / password). */
  maskDomValue: boolean;
  /**
   * Visually mask the field after fill so the rendered value never appears in the
   * live browser UI or in agent-facing screenshots. Independent of `maskDomValue`:
   * the underlying submittable value is untouched (text-security is purely visual).
   * Tags the element `data-antigen-masked="true"` so the screenshot redaction layer
   * can find exactly the registered protected fields (never the whole page).
   */
  visualMask?: boolean;
  /**
   * Render the pointer/cursor debug overlay during the focus pointer move. When
   * omitted, falls back to the ANTIGEN_POINTER_DEBUG_OVERLAY env. Callers should
   * pass `resolveOverlayEnabled(session)` so headed (visible) sessions show the
   * overlay without a separate env var — matching the click/type paths.
   */
  debugOverlay?: boolean;
  /** Timing-jitter profile only — never logged as a value. */
  typingProfile: "username" | "password";
  /** Safe-to-log request identifier. */
  requestId: string;
  /** Safe-to-log domain. */
  domain: string;
  /** Safe-to-log field label (e.g. "card_number"). Never a value. */
  fieldLabel: string;
  /** Task browser session id for pointer-state continuity (optional). */
  browserSessionId?: string;
  /** Owning user id — required alongside browserSessionId for pointer-state persistence. */
  userId?: string;
}

export interface ProtectedRealisticFillRealism {
  mode: "realistic" | "direct";
  strategy?: "key_events" | "direct_assignment";
  char_count_bucket?: string;
  duration_ms?: number;
  fallback_used?: boolean;
  fallback_reason?: string;
  verified?: boolean;
}

export interface ProtectedRealisticFillResult {
  success: boolean;
  error?: string;
  field_shape?: "input" | "select";
  /** Masked telemetry only — never contains the value or its length. */
  realism?: ProtectedRealisticFillRealism;
}

// Per-fill pointer state so repeated fills in the same session start from a
// plausible location. Keyed by browser session (or request id) — coordinates only.
const pointerStateByKey = new Map<string, PointerRuntimeState>();

function getOrCreatePointerState(key: string): PointerRuntimeState {
  let state = pointerStateByKey.get(key);
  if (!state) {
    state = makePointerRuntimeState();
    pointerStateByKey.set(key, state);
  }
  return state;
}

/**
 * Fill a single protected sensitive field via realistic browser interaction.
 *
 * INPUT/TEXTAREA: box lookup → realistic pointer move + click/focus → focus & clear
 *   → character-by-character key events (fallback Input.insertText, then native
 *   setter) → verify (value present, never read) → mask (if requested) + change/blur.
 * SELECT: actual option selection + selectedIndex + native setter → input/change/blur
 *   → read-back verify. Never typed, never masked.
 */
export async function executeProtectedRealisticFill(
  params: ProtectedRealisticFillParams,
): Promise<ProtectedRealisticFillResult> {
  const {
    browserWsUrl,
    pageTargetId,
    selectorExpr,
    value,
    maskDomValue,
    typingProfile,
    requestId,
    domain,
    browserSessionId,
    userId,
    visualMask,
  } = params;

  const slowMoMs = parseInt(process.env.ANTIGEN_BROWSER_SLOW_MO_MS ?? "0", 10) || 0;
  // Honor the caller's resolved tri-state (visible-session aware) when provided;
  // otherwise preserve the legacy env-only behavior so nothing else regresses.
  const debugOverlay = params.debugOverlay ?? (process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true");
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

  // ── Eval expressions (none embed the value except the setter fallback, which is
  //    a last resort and JSON-encoded; it is never logged or returned). ──────────

  // Iframe guard + element shape. Fails closed for missing element or any IFRAME ancestor.
  const iframeGuardExpr = `(function() {
    try {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element_not_found' };
      var node = el;
      while (node && node.parentNode) {
        if (node.tagName === 'IFRAME') return { ok: false, reason: 'IFRAME_NOT_SUPPORTED' };
        node = node.parentNode;
      }
      return { ok: true, tagName: el.tagName };
    } catch (e) { return { ok: false, reason: 'guard_exception' }; }
  })()`;

  // INPUT: element box for native pointer focus before typing. No value here.
  const boxExpr = `(function() {
    try {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element_not_found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { ok: false, reason: 'zero_box' };
      return {
        ok: true,
        box: { x: r.left, y: r.top, width: r.width, height: r.height },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      };
    } catch (e) { return { ok: false, reason: String(e) }; }
  })()`;

  // INPUT: focus + clear existing/placeholder/masked value. No value here.
  const focusExpr = `(function() {
    try {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };
      el.scrollIntoView({ block: 'nearest' });
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return { ok: true };
    } catch (e) { return { ok: false, reason: String(e) }; }
  })()`;

  // INPUT: post-typing verification — checks the field is non-empty. Never reads the value.
  const typingVerifyExpr = `(function() {
    var el = ${selectorExpr};
    if (!el) return { ok: false, reason: 'element_not_found' };
    return { ok: el.value.length > 0, reason: el.value.length > 0 ? 'value_present' : 'empty_after_typing' };
  })()`;

  // INPUT: optional DOM `value` getter mask (card_number / cvv / password) so the
  // value cannot be read back through element.value / snapshots. Submission uses the
  // native control value, which is left intact.
  const valueGetterMaskBlock = maskDomValue
    ? `
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    Object.defineProperty(el, 'value', {
      get: function() { return ''; },
      set: function(v) { setter.call(el, v); },
      configurable: true,
    });`
    : "";

  // INPUT: visual mask — bullets in the live UI + a tag so the screenshot redaction
  // layer can find exactly this registered protected field. text-security is purely
  // visual; the submittable value is unchanged. The title + outline are the human
  // "Antigen filled this" affordance. Never embeds or reads the value.
  const visualMaskInputBlock = visualMask
    ? `
    try {
      el.style.setProperty('-webkit-text-security', 'disc', 'important');
      el.style.setProperty('text-security', 'disc', 'important');
      el.style.setProperty('outline', '2px solid #ff5000', 'important');
      el.style.setProperty('outline-offset', '1px', 'important');
      el.setAttribute('title', 'Filled by Antigen');
      el.setAttribute('data-antigen-masked', 'true');
    } catch (e) {}`
    : "";

  const maskBlock = valueGetterMaskBlock + visualMaskInputBlock;

  // SELECT: text-security does not mask a <select>'s rendered option, so make the
  // chosen option text illegible (transparent + blur) and tag it for the screenshot
  // redaction layer. The option value is left intact for submission. Never reads it.
  const visualMaskSelectBlock = visualMask
    ? `
    try {
      el.style.setProperty('color', 'transparent', 'important');
      el.style.setProperty('text-shadow', '0 0 7px rgba(0,0,0,0.6)', 'important');
      el.style.setProperty('outline', '2px solid #ff5000', 'important');
      el.style.setProperty('outline-offset', '1px', 'important');
      el.setAttribute('title', 'Filled by Antigen');
      el.setAttribute('data-antigen-masked', 'true');
    } catch (e) {}`
    : "";

  // SELECT: optional DOM `value` getter mask (protected expiry dropdowns) so the chosen
  // option value cannot be read back through element.value / browser_evaluate / snapshots.
  // Mirrors the input getter mask but on HTMLSelectElement.prototype. Native form
  // submission serializes the *selected option* (selectedIndex), not this JS getter, so
  // the submittable value is left intact. MUST be installed only after the commit-verify
  // (which reads el.value) has already passed — same accepted tradeoff as PAN/CVV inputs.
  const valueGetterMaskSelectBlock = maskDomValue
    ? `
    try {
      var selSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      Object.defineProperty(el, 'value', {
        get: function() { return ''; },
        set: function(v) { selSetter.call(el, v); },
        configurable: true,
      });
    } catch (e) {}`
    : "";

  const maskBlurExpr = `(function() {
    var el = ${selectorExpr};
    if (!el) return { ok: false, reason: 'element not found' };${maskBlock}
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.setAttribute('data-antigen-filled', 'true');
    return { ok: true };
  })()`;

  // INPUT: setter fallback (only if Input.insertText also fails). Value is JSON-encoded
  // in this expression — same as the proven secret path; never logged or returned.
  const setterFallbackExpr = `(function() {
    var el = ${selectorExpr};
    if (!el) return { ok: false, reason: 'element not found' };
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));${maskBlock}
    el.setAttribute('data-antigen-filled', 'true');
    return { ok: true };
  })()`;

  // SELECT: select the actual option, drive the controlled-component event sequence,
  // and read back to verify. Generic option matching (value/text, plus numeric variants
  // for expiry month/year). Never masked. Value appears as a match target only.
  const selectFillExpr = `(function() {
    var el = ${selectorExpr};
    if (!el) return { ok: false, reason: 'element not found' };
    var rawVal = ${JSON.stringify(value)};
    var lower = String(rawVal).toLowerCase().trim();
    var opts = Array.prototype.slice.call(el.options);
    function findIdx(needle) {
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        if (String(o.value).toLowerCase() === needle || String(o.text).toLowerCase().trim() === needle) return k;
      }
      return -1;
    }
    var idx = findIdx(lower);
    if (idx === -1) {
      var variants = [];
      var n = parseInt(rawVal, 10);
      if (!isNaN(n)) {
        variants.push(String(n));
        variants.push(('0' + String(n)).slice(-2));
        variants.push(String(rawVal).slice(-2));
      }
      for (var v = 0; v < variants.length && idx === -1; v++) idx = findIdx(String(variants[v]).toLowerCase());
    }
    if (idx === -1) return { ok: false, reason: 'select_option_not_found' };
    var match = opts[idx];
    try { el.focus(); } catch (e) {}
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.selectedIndex = idx;
    var sel = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (sel && sel.set) { sel.set.call(el, match.value); } else { el.value = match.value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.setAttribute('data-antigen-filled', 'true');${visualMaskSelectBlock}
    var committed = (el.value === match.value) && (el.selectedIndex === idx) && el.selectedIndex >= 0 && String(match.value).length > 0;
    if (!committed) return { ok: false, reason: 'select_commit_unverified' };${valueGetterMaskSelectBlock}
    return { ok: true, verified: true };
  })()`;

  const realism: ProtectedRealisticFillRealism = { mode: "realistic" };

  // Dev-only latency marker (gated). Sanitized: duration + shape token + realism
  // strategy/bucket only — NEVER the value, selector, domain, or coordinates.
  const fillTimingOn = timingEnabled();
  const tFillEnter = process.hrtime.bigint();

  return await new Promise<ProtectedRealisticFillResult>((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let sessionId: string | null = null;
    let fieldShape: "input" | "select" | undefined;

    let attachId: number;
    let iframeId: number;
    let boxId: number;
    let focusId: number;
    let typingVerifyId: number | undefined;
    let insertId: number | undefined;
    let maskId: number | undefined;
    let fallbackId: number | undefined;
    let selectId: number | undefined;

    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ success: false, error: "CDP fill timed out after 10 seconds.", field_shape: fieldShape, realism });
    }, 10_000);

    const send = (method: string, params: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    const finish = (success: boolean, error?: string) => {
      clearTimeout(timer);
      ws.close();
      if (fillTimingOn) {
        const totalMs = Math.round((Number(process.hrtime.bigint() - tFillEnter) / 1_000_000) * 100) / 100;
        // eslint-disable-next-line no-console
        console.log(
          `[AntigenTiming] antigen_protected_fill total=${totalMs}ms` +
            ` field_shape=${fieldShape ?? "unknown"} strategy=${realism.strategy ?? "none"}` +
            ` typing_ms=${realism.duration_ms ?? 0} char_count_bucket=${realism.char_count_bucket ?? "n/a"}` +
            ` fallback_used=${realism.fallback_used === true} success=${success}`,
        );
      }
      resolve({ success, error, field_shape: fieldShape, realism });
    };

    ws.on("open", () => {
      attachId = send("Target.attachToTarget", { targetId: pageTargetId, flatten: true });
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const id = msg.id as number | undefined;
      // CDP event notifications carry no `id`. Guard so uninitialized ids don't match.
      if (id === undefined) {
        if (msg.error) finish(false, `CDP error: ${JSON.stringify(msg.error)}`);
        return;
      }

      const result = msg.result as Record<string, unknown> | undefined;

      // Attach → session id → iframe guard.
      if (id === attachId) {
        if (!result?.sessionId) {
          finish(false, "CDP attach failed: no sessionId returned.");
          return;
        }
        sessionId = result.sessionId as string;
        iframeId = send("Runtime.evaluate", { expression: iframeGuardExpr, returnByValue: true }, sessionId);
        return;
      }

      // Iframe guard → branch on element shape.
      if (id === iframeId) {
        const val = ((result?.result as Record<string, unknown> | undefined)?.value) as
          { ok?: boolean; reason?: string; tagName?: string } | undefined;
        if (!val?.ok) {
          finish(false, val?.reason === "IFRAME_NOT_SUPPORTED" ? "IFRAME_NOT_SUPPORTED" : (val?.reason ?? "element_not_found"));
          return;
        }
        if (val.tagName === "SELECT") {
          fieldShape = "select";
          realism.mode = "direct";
          realism.strategy = "direct_assignment";
          selectId = send("Runtime.evaluate", { expression: selectFillExpr, returnByValue: true }, sessionId!);
        } else {
          fieldShape = "input";
          boxId = send("Runtime.evaluate", { expression: boxExpr, returnByValue: true }, sessionId!);
        }
        return;
      }

      // SELECT result.
      if (selectId !== undefined && id === selectId) {
        const val = ((result?.result as Record<string, unknown> | undefined)?.value) as
          { ok?: boolean; reason?: string; verified?: boolean } | undefined;
        realism.verified = !!val?.verified;
        finish(!!val?.ok, val?.ok ? undefined : `CDP select: ${val?.reason ?? "unknown"}`);
        return;
      }

      // INPUT: box lookup → realistic pointer focus → focus/clear.
      if (id === boxId) {
        const boxVal = ((result?.result as Record<string, unknown> | undefined)?.value) as {
          ok?: boolean;
          box?: ElementBox;
          viewport?: { width: number; height: number };
        } | undefined;

        const stateKey = browserSessionId ?? requestId ?? "default";
        const doPointerThenFocus = async () => {
          if (boxVal?.ok && boxVal?.box) {
            try {
              const pointerSend = (method: string, p: Record<string, unknown>) => {
                send(method, p, sessionId!);
              };
              const state = getOrCreatePointerState(stateKey);

              // Sync from session — load latest saved pointer position.
              if (browserSessionId && userId) {
                const saved = getTaskBrowserSessionPointerState(browserSessionId, userId);
                if (saved?.initialized) {
                  state.current_x = saved.x;
                  state.current_y = saved.y;
                }
              }
              // Initialize from viewport center if pointer is still at origin.
              if (state.current_x === 0 && state.current_y === 0) {
                if (boxVal.viewport) {
                  state.current_x = Math.round(boxVal.viewport.width * 0.5);
                  state.current_y = Math.round(boxVal.viewport.height * 0.5);
                } else {
                  state.current_x = 80;
                  state.current_y = 80;
                }
              }
              if (boxVal.viewport) {
                state.viewport_width = boxVal.viewport.width;
                state.viewport_height = boxVal.viewport.height;
              }
              await clickBoxWithPointer(state, boxVal.box, pointerSend, sleep, {
                debugOverlay,
                debugLabel: "protected_fill",
                templateTraces: getLoadedPointerTraces(),
                purpose: "input_focus",
              });
              // Persist final pointer position back to the task browser session.
              if (browserSessionId && userId) {
                setTaskBrowserSessionPointerState(browserSessionId, userId, {
                  x: state.current_x,
                  y: state.current_y,
                  initialized: true,
                  updated_at: new Date().toISOString(),
                });
              }
            } catch {
              // Native pointer focus failed — proceed to fill without it.
            }
          }
          focusId = send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
        };

        doPointerThenFocus().catch(() => {
          focusId = send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
        });
        return;
      }

      // INPUT: focus/clear result → realistic typing (or direct insert).
      if (id === focusId) {
        const evalVal = ((result?.result as Record<string, unknown> | undefined)?.value) as
          { ok?: boolean; reason?: string } | undefined;
        if (!evalVal?.ok) {
          finish(false, `CDP evaluate (focus): ${evalVal?.reason ?? "element not found"}`);
          return;
        }

        const realismMode = getInputRealismMode();
        if (realismMode === "direct") {
          realism.mode = "direct";
          realism.strategy = "direct_assignment";
          insertId = send("Input.insertText", { text: value }, sessionId!);
          return;
        }

        const sendForTyping = (method: string, p: Record<string, unknown>) => {
          send(method, p, sessionId!);
        };
        const doTypingThenVerify = async () => {
          const typingResult = await typeCharsViaCDP(sendForTyping, sleep, {
            value,
            fieldKind: typingProfile,
            injectionRequestId: requestId,
            domain,
          });
          realism.strategy = typingResult.strategy;
          realism.duration_ms = typingResult.duration_ms;
          realism.char_count_bucket = typingResult.char_count_bucket;
          if (typingResult.success) {
            typingVerifyId = send(
              "Runtime.evaluate",
              { expression: typingVerifyExpr, returnByValue: true },
              sessionId!,
            );
          } else {
            realism.fallback_used = true;
            realism.fallback_reason = typingResult.failure_reason ?? "typing_failed";
            insertId = send("Input.insertText", { text: value }, sessionId!);
          }
        };
        doTypingThenVerify().catch(() => {
          realism.fallback_used = true;
          realism.fallback_reason = "typing_exception";
          insertId = send("Input.insertText", { text: value }, sessionId!);
        });
        return;
      }

      // INPUT: post-typing verification → mask/blur, or fall back to insertText.
      if (typingVerifyId !== undefined && id === typingVerifyId) {
        const verifyVal = ((result?.result as Record<string, unknown> | undefined)?.value) as
          { ok?: boolean; reason?: string } | undefined;
        if (verifyVal?.ok) {
          realism.verified = true;
          maskId = send("Runtime.evaluate", { expression: maskBlurExpr, returnByValue: true }, sessionId!);
        } else {
          realism.fallback_used = true;
          realism.fallback_reason = verifyVal?.reason ?? "empty_after_typing";
          realism.strategy = "direct_assignment";
          insertId = send("Input.insertText", { text: value }, sessionId!);
        }
        return;
      }

      // INPUT: Input.insertText result → mask/blur, or fall back to native setter.
      if (insertId !== undefined && id === insertId) {
        if (msg.error) {
          fallbackId = send("Runtime.evaluate", { expression: setterFallbackExpr, returnByValue: true }, sessionId!);
        } else {
          maskId = send("Runtime.evaluate", { expression: maskBlurExpr, returnByValue: true }, sessionId!);
        }
        return;
      }

      // INPUT: mask/blur result.
      if (maskId !== undefined && id === maskId) {
        const evalVal = ((result?.result as Record<string, unknown> | undefined)?.value) as
          { ok?: boolean; reason?: string } | undefined;
        finish(!!evalVal?.ok, evalVal?.ok ? undefined : `CDP evaluate (mask/blur): ${evalVal?.reason ?? "unknown"}`);
        return;
      }

      // INPUT: native setter fallback result.
      if (fallbackId !== undefined && id === fallbackId) {
        const evalVal = ((result?.result as Record<string, unknown> | undefined)?.value) as
          { ok?: boolean; reason?: string } | undefined;
        finish(!!evalVal?.ok, evalVal?.ok ? undefined : `CDP fallback: ${evalVal?.reason ?? "unknown"}`);
        return;
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `WebSocket error: ${(err as Error).message}`, field_shape: fieldShape, realism });
    });
  });
}
