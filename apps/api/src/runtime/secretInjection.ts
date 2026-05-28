import WebSocket from "ws";
import type { SecretFieldInjection } from "@aegis/types";
import {
  makePointerRuntimeState,
  clickBoxWithPointer,
  type PointerRuntimeState,
  type ElementBox,
} from "./nativePointerRuntime.js";
import { pickBestPageTarget } from "./cdpTargetSelection.js";
import {
  getTaskBrowserSessionPointerState,
  setTaskBrowserSessionPointerState,
} from "./taskBrowserSessions.js";
import { getLoadedPointerTraces } from "./pointerProfileLoader.js";
import {
  getInputRealismMode,
  typeCharsViaCDP,
} from "./inputRealismTyper.js";
import { logInputRealismLifecycle } from "../lib/inputRealismLifecycleLog.js";

/**
 * Builds a JS selector expression for a credential field.
 *
 * Priority:
 *   1. selector_hint (direct querySelector — agent-supplied CSS selector)
 *   2. label (IIFE scanning label elements)
 *   3. placeholder (input[placeholder=...])
 *   4. input_type (input[type=...])
 *   5. field_kind === "username" (ordered candidates: autocomplete > name > type > id)
 *   6. field_kind === "password" (input[type="password"])
 *   7. Generic fallback (email/text/no-type)
 *
 * The returned expression evaluates to the DOM element or null.
 * It never contains a resolved secret value — that is the caller's responsibility.
 */
export function buildInjectionSelectorExpr(
  fieldKind: "username" | "password",
  hint?: { selector_hint?: string; label?: string; placeholder?: string; input_type?: string },
): string {
  const { selector_hint, label, placeholder, input_type } = hint ?? {};

  if (selector_hint) {
    return `document.querySelector(${JSON.stringify(selector_hint)})`;
  }
  if (label) {
    return `(function() {
        const labels = Array.from(document.querySelectorAll('label'));
        const lbl = labels.find(l => l.textContent?.trim().toLowerCase().includes(${JSON.stringify(label.toLowerCase())}));
        if (!lbl) return null;
        if (lbl.htmlFor) return document.getElementById(lbl.htmlFor);
        return lbl.querySelector('input');
      })()`;
  }
  if (placeholder) {
    return `document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`;
  }
  if (input_type) {
    return `document.querySelector('input[type=${JSON.stringify(input_type)}]')`;
  }
  if (fieldKind === "username") {
    // Ordered candidates for username/email fields — prefer semantic attributes over structural type.
    return `(function() {
        return document.querySelector('input[autocomplete="username"]')
          || document.querySelector('input[name="email"]')
          || document.querySelector('input[name="username"]')
          || document.querySelector('input[type="email"]')
          || document.querySelector('#email')
          || document.querySelector('#username')
          || document.querySelector('input[type="text"]')
          || document.querySelector('input:not([type])');
      })()`;
  }
  if (fieldKind === "password") {
    return `document.querySelector('input[type="password"]')`;
  }
  return `document.querySelector('input[type="email"],input[type="text"],input:not([type])')`;
}

/**
 * Safe page-state diagnostic expression — no secrets, no field values.
 * Only structural DOM metadata: url, readyState, input element shapes.
 * Evaluated only when ANTIGEN_CDP_DIAGNOSTICS=true.
 */
export const CDP_DIAG_EXPR = `(function(){
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    hasEmailId: !!document.querySelector('#email'),
    inputSummary: Array.from(document.querySelectorAll('input')).map(function(i){
      return { id: i.id, name: i.name, type: i.type,
               placeholder: i.placeholder, autocomplete: i.autocomplete,
               disabled: i.disabled, readOnly: i.readOnly };
    })
  };
})()`;

// In-memory pointer state per injection request — tracks current pointer position
// so repeated fills in the same session start from a plausible location.
const pointerStateByInjection = new Map<string, PointerRuntimeState>();

function getOrCreatePointerState(key: string): PointerRuntimeState {
  let state = pointerStateByInjection.get(key);
  if (!state) {
    state = makePointerRuntimeState();
    pointerStateByInjection.set(key, state);
  }
  return state;
}

/**
 * Fills a protected credential field in the agent's active Playwright browser via raw CDP
 * WebSocket — without returning the value to the agent.
 *
 * Uses the browser-level CDP WebSocket (Target.attachToTarget + Runtime.evaluate) rather than
 * chromium.connectOverCDP. This avoids conflicts with the Playwright MCP which already holds
 * a CDP session on the same Chrome instance: multiple clients can connect to the browser-level
 * WS simultaneously, each managing their own sessions.
 *
 * Happy path (realistic fill):
 *   1. Runtime.evaluate — focus field and clear existing value (no secret in expression)
 *   2. Input.insertText  — type the secret via CDP params (never embedded in JS eval)
 *   3. Runtime.evaluate — apply password mask + dispatch change/blur + set data-antigen-filled
 *
 * Fallback (setter fill): if Input.insertText fails, falls back to the original
 * native-setter + event-dispatch approach. Secret still flows only through CDP; it appears
 * JSON-encoded in the fallback Runtime.evaluate expression but is never returned or logged.
 *
 * The resolvedValue flows: KMS → this function → CDP params / Runtime.evaluate → browser field.
 * It is never logged, returned in an API response, or persisted.
 */
export async function executeSecretInjectionViaCDP(
  injection: SecretFieldInjection,
  resolvedValue: string,
  cdpUrlOverride?: string,
  preferredTargetUrl?: string,
  browserSessionId?: string,
): Promise<{ success: boolean; error?: string }> {
  const cdpBase = cdpUrlOverride ?? process.env.AEGIS_PLAYWRIGHT_CDP_URL;
  if (!cdpBase) {
    return {
      success: false,
      error:
        "AEGIS_PLAYWRIGHT_CDP_URL is not configured. " +
        "Set this to the Chrome remote debugging base URL (e.g. http://localhost:9222). " +
        "Chrome must be started with --remote-debugging-port=9222.",
    };
  }

  try {
    // Resolve browser-level WebSocket URL and page targets in parallel.
    const [versionData, targets] = await Promise.all([
      fetch(`${cdpBase}/json/version`).then((r) => r.json()),
      fetch(`${cdpBase}/json/list`).then((r) => r.json()),
    ]);

    const browserWsUrl: string = (versionData as Record<string, string>).webSocketDebuggerUrl;
    if (!browserWsUrl) {
      return { success: false, error: "No browser WebSocket debugger URL returned by CDP." };
    }

    // Select the active page target. Priority: exact URL > same origin > domain > non-blank > last.
    const { target: pageTarget, candidates } = pickBestPageTarget(
      targets as Array<{ id: string; url: string; type: string }>,
      { domain: injection.domain, preferredUrl: preferredTargetUrl },
    );

    if (!pageTarget) {
      const urls = candidates.map((c) => c.url).join(", ") || "(none)";
      return {
        success: false,
        error: `No page targets found via CDP. Active page target binding failed. Candidates: [${urls}]`,
      };
    }

    // Build a JS selector expression from element_hint.
    const selectorExpr = buildInjectionSelectorExpr(injection.field_kind, injection.element_hint);

    const cdpDiagnostics = process.env.ANTIGEN_CDP_DIAGNOSTICS === "true";
    if (cdpDiagnostics) {
      const { selector_hint, label, placeholder, input_type } = injection.element_hint ?? {};
      console.log("[CdpInjection] selector resolution", {
        field_kind: injection.field_kind,
        selector_hint: selector_hint ?? null,
        label_hint: label ?? null,
        placeholder_hint: placeholder ?? null,
        input_type_hint: input_type ?? null,
        selector_expr_summary: selectorExpr.slice(0, 140),
      });
    }

    // Dev-only: ANTIGEN_BROWSER_SLOW_MO_MS adds extra delay per pointer event step for visual verification.
    const slowMoMs = parseInt(process.env.ANTIGEN_BROWSER_SLOW_MO_MS ?? "0", 10) || 0;
    const debugOverlay = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true";
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

    // Phase 0 (box lookup): get element bounding box for native pointer focus before text insert.
    // No secret value in this expression.
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

    // Phase 1 (focus/clear): locate element, scroll into view, focus, clear existing value.
    // No secret value in this expression.
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

    // Phase 3 (mask/blur): apply password mask if needed, dispatch change/blur, mark filled.
    // No secret value in this expression.
    const maskBlock = injection.field_kind === "password"
      ? `
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      Object.defineProperty(el, 'value', {
        get: function() { return ''; },
        set: function(v) { setter.call(el, v); },
        configurable: true,
      });`
      : "";

    const maskBlurExpr = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };${maskBlock}
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.setAttribute('data-antigen-filled', 'true');
      return { ok: true };
    })()`;

    // Post-typing verification — checks the field has a non-empty value after
    // realistic key event dispatch. Never reads or returns the value itself.
    const typingVerifyExpr = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element_not_found' };
      return { ok: el.value.length > 0, reason: el.value.length > 0 ? 'value_present' : 'empty_after_typing' };
    })()`;

    // Fallback setter fill (used only if Input.insertText fails).
    // Secret appears JSON-encoded in the expression — same as the original implementation.
    // React/Vue/Angular capture the value during the input event; masking after is safe for
    // those frameworks. Vanilla JS onsubmit handlers that read el.value will get '' for passwords.
    const setterFallbackMaskBlock = injection.field_kind === "password"
      ? `
      Object.defineProperty(el, 'value', {
        get: function() { return ''; },
        set: function(v) { setter.call(el, v); },
        configurable: true,
      });`
      : "";

    const setterFallbackExpr = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(resolvedValue)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));${setterFallbackMaskBlock}
      el.setAttribute('data-antigen-filled', 'true');
      return { ok: true };
    })()`;

    // Build a richer box lookup expression used only when ANTIGEN_CDP_DIAGNOSTICS=true.
    // Returns the same ok/box/viewport fields as boxExpr (for downstream compatibility)
    // plus selector_found, url, title, reason, and inputSummary (structural metadata only —
    // id, name, type, autocomplete, placeholder, disabled, readOnly — never .value).
    const buildBoxDiagExpr = (sel: string): string => `(function(){
      try {
        var el = ${sel};
        var inputs = Array.from(document.querySelectorAll("input")).map(function(i){
          return { id: i.id, name: i.name, type: i.type, autocomplete: i.autocomplete,
                   placeholder: i.placeholder, disabled: i.disabled, readOnly: i.readOnly };
        });
        if (!el) return { ok: false, reason: "element_not_found", url: location.href,
                          title: document.title, selector_found: false, inputSummary: inputs };
        el.scrollIntoView({ block: "center", inline: "center" });
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return { ok: false, reason: "zero_box", url: location.href,
          title: document.title, selector_found: true, inputSummary: inputs };
        return { ok: true, reason: "box_found", url: location.href, title: document.title,
                 selector_found: true, box: { x: r.left, y: r.top, width: r.width, height: r.height },
                 viewport: { width: window.innerWidth, height: window.innerHeight },
                 inputSummary: inputs };
      } catch (e) { return { ok: false, reason: "exception", url: location.href,
                             title: document.title, selector_found: false }; }
    })()`;
    const activeBoxExpr = cdpDiagnostics ? buildBoxDiagExpr(selectorExpr) : boxExpr;

    return await new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl);
      let msgId = 1;
      let sessionId: string | null = null;

      // Track each CDP command's message ID so responses can be routed unambiguously.
      let attachId: number;
      let diagId: number | undefined;
      let boxId: number;
      let focusId: number;
      let typingVerifyId: number | undefined;
      let insertId: number;
      let maskId: number;
      let fallbackId: number;

      const timer = setTimeout(() => {
        ws.terminate();
        resolve({ success: false, error: "CDP fill timed out after 10 seconds." });
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
        resolve({ success, error });
      };

      ws.on("open", () => {
        attachId = send("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
      });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const id = msg.id as number | undefined;

        // CDP event notifications carry no `id` field. Without this guard, uninitialized
        // numeric `let` vars (undefined) would match `id === boxId` and prematurely fire
        // the box phase before the attach response has arrived.
        if (id === undefined) {
          if (msg.error) finish(false, `CDP error: ${JSON.stringify(msg.error)}`);
          return;
        }

        const result = msg.result as Record<string, unknown> | undefined;

        // Attach response — got a session ID; start diagnostic (if enabled) or phase 0 (box lookup).
        if (id === attachId) {
          if (!result?.sessionId) {
            finish(false, "CDP attach failed: no sessionId returned.");
            return;
          }
          sessionId = result.sessionId as string;
          if (cdpDiagnostics) {
            diagId = send("Runtime.evaluate", { expression: CDP_DIAG_EXPR, returnByValue: true }, sessionId);
          } else {
            boxId = send("Runtime.evaluate", { expression: activeBoxExpr, returnByValue: true }, sessionId);
          }
          return;
        }

        // Diagnostic response — log safe page state, then start phase 0 (box lookup).
        if (diagId !== undefined && id === diagId) {
          const diagVal = ((result?.result as Record<string, unknown> | undefined)?.value) as Record<string, unknown> | undefined;
          if (diagVal) {
            console.log("[CdpInjection] page diagnostic", {
              url: diagVal["url"],
              title: diagVal["title"],
              readyState: diagVal["readyState"],
              hasEmailId: diagVal["hasEmailId"],
              inputSummary: diagVal["inputSummary"],
            });
          } else {
            console.log("[CdpInjection] page diagnostic: eval returned no value");
          }
          boxId = send("Runtime.evaluate", { expression: activeBoxExpr, returnByValue: true }, sessionId!);
          return;
        }

        // Phase 0 result — element box for native pointer focus before text insert.
        if (id === boxId) {
          const boxEval = (result?.result as Record<string, unknown> | undefined);
          const boxVal = boxEval?.value as {
            ok?: boolean;
            box?: ElementBox;
            viewport?: { width: number; height: number };
          } | undefined;

          if (cdpDiagnostics) {
            const bv = boxEval?.value as Record<string, unknown> | undefined;
            console.log("[CdpInjection] box lookup result", {
              path: "secret",
              eval_url: bv?.url ?? null,
              selector_found: bv?.selector_found ?? false,
              rect_width: (bv?.box as Record<string, unknown> | undefined)?.width ?? null,
              rect_height: (bv?.box as Record<string, unknown> | undefined)?.height ?? null,
              reason: bv?.reason ?? null,
              inputSummary: bv?.inputSummary ?? [],
            });
          }

          const stateKey = browserSessionId ?? injection.injection_request_id ?? "default";
          const pointerDiag = cdpDiagnostics || debugOverlay;
          const doPointerThenFocus = async () => {
            if (boxVal?.ok && boxVal?.box) {
              if (pointerDiag) {
                console.log("[PointerFocus] box found", {
                  path: "secret",
                  width: boxVal.box.width,
                  height: boxVal.box.height,
                });
              }
              try {
                const pointerSend = (method: string, params: Record<string, unknown>) => {
                  send(method, params, sessionId!);
                };
                const state = getOrCreatePointerState(stateKey);

                // Sync from session — load latest saved position for this task browser session.
                if (browserSessionId) {
                  const saved = getTaskBrowserSessionPointerState(browserSessionId, injection.user_id);
                  if (saved?.initialized) {
                    state.current_x = saved.x;
                    state.current_y = saved.y;
                    console.log("[PointerState] loaded", {
                      browser_session_id: browserSessionId,
                      x: saved.x,
                      y: saved.y,
                      initialized: true,
                    });
                  }
                }

                // Initialize from viewport center if pointer is still at origin.
                if (state.current_x === 0 && state.current_y === 0) {
                  if (boxVal.viewport) {
                    state.current_x = Math.round(boxVal.viewport.width * 0.5);
                    state.current_y = Math.round(boxVal.viewport.height * 0.5);
                    console.log("[PointerState] initialized", {
                      browser_session_id: browserSessionId ?? null,
                      x: state.current_x,
                      y: state.current_y,
                      source: "viewport_center",
                    });
                  } else {
                    state.current_x = 80;
                    state.current_y = 80;
                    console.log("[PointerState] initialized", {
                      browser_session_id: browserSessionId ?? null,
                      x: state.current_x,
                      y: state.current_y,
                      source: "fallback",
                    });
                  }
                }

                if (boxVal.viewport) {
                  state.viewport_width = boxVal.viewport.width;
                  state.viewport_height = boxVal.viewport.height;
                }
                await clickBoxWithPointer(state, boxVal.box, pointerSend, sleep, {
                  debugOverlay,
                  debugLabel: "secret",
                  templateTraces: getLoadedPointerTraces(),
                  purpose: "input_focus",
                });

                // Persist final pointer position back to the task browser session.
                if (browserSessionId) {
                  setTaskBrowserSessionPointerState(browserSessionId, injection.user_id, {
                    x: state.current_x,
                    y: state.current_y,
                    initialized: true,
                    updated_at: new Date().toISOString(),
                  });
                  console.log("[PointerState] saved", {
                    browser_session_id: browserSessionId,
                    x: state.current_x,
                    y: state.current_y,
                  });
                }
              } catch {
                // Native pointer focus failed — proceed to fill without it.
              }
            } else {
              if (pointerDiag) {
                console.log("[PointerFocus] skipped", { path: "secret", reason: "box_lookup_failed" });
              }
            }
            focusId = send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
          };

          doPointerThenFocus().catch(() => {
            focusId = send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
          });
          return;
        }

        // Phase 1 result — focus/clear eval.
        if (id === focusId) {
          const val = (result?.result as Record<string, unknown> | undefined);
          const evalVal = val?.value as { ok?: boolean; reason?: string } | undefined;
          if (!evalVal?.ok) {
            finish(false, `CDP evaluate (focus): ${evalVal?.reason ?? "element not found"}`);
            return;
          }

          // Phase 2: input realism for username/password fields only.
          // Other field kinds keep the existing insertText/direct path.
          const realismMode = getInputRealismMode();
          const fieldSupportsRealism =
            injection.field_kind === "username" || injection.field_kind === "password";

          logInputRealismLifecycle("input_realism_mode_selected", {
            injection_request_id: injection.injection_request_id,
            field_kind: injection.field_kind,
            domain: injection.domain,
            mode: realismMode === "direct" || !fieldSupportsRealism ? "direct" : realismMode,
          });

          if (realismMode === "direct" || !fieldSupportsRealism) {
            // Env override or unsupported field kind — skip realism, use insertText directly.
            logInputRealismLifecycle("input_realism_direct_mode", {
              injection_request_id: injection.injection_request_id,
              field_kind: injection.field_kind,
              domain: injection.domain,
              mode: "direct",
              strategy: "direct_assignment",
            });
            injection.input_realism = { mode: "direct", strategy: "direct_assignment" };
            insertId = send("Input.insertText", { text: resolvedValue }, sessionId!);
            return;
          }

          // Realistic path: fire-and-forget key events per character, then verify.
          injection.input_realism = { mode: "realistic", started_at: new Date().toISOString() };

          const sendForTyping = (method: string, params: Record<string, unknown>) => {
            send(method, params, sessionId!);
          };

          const doTypingThenVerify = async () => {
            logInputRealismLifecycle("input_realism_typing_started", {
              injection_request_id: injection.injection_request_id,
              field_kind: injection.field_kind,
              domain: injection.domain,
              mode: "realistic",
            });

            const typingResult = await typeCharsViaCDP(sendForTyping, sleep, {
              value: resolvedValue,
              fieldKind: injection.field_kind as "username" | "password",
              injectionRequestId: injection.injection_request_id,
              domain: injection.domain,
            });

            Object.assign(injection.input_realism!, {
              strategy: typingResult.strategy,
              duration_ms: typingResult.duration_ms,
              char_count_bucket: typingResult.char_count_bucket,
            });

            if (typingResult.success) {
              logInputRealismLifecycle("input_realism_typing_completed", {
                injection_request_id: injection.injection_request_id,
                field_kind: injection.field_kind,
                domain: injection.domain,
                strategy: typingResult.strategy,
                duration_ms: typingResult.duration_ms,
                char_count_bucket: typingResult.char_count_bucket,
                success: true,
              });

              injection.input_realism!.verify_started_at = new Date().toISOString();
              logInputRealismLifecycle("input_realism_verify_started", {
                injection_request_id: injection.injection_request_id,
                field_kind: injection.field_kind,
                domain: injection.domain,
              });

              typingVerifyId = send(
                "Runtime.evaluate",
                { expression: typingVerifyExpr, returnByValue: true },
                sessionId!,
              );
            } else {
              // Synchronous send failure inside typeCharsViaCDP — fall back to insertText.
              injection.input_realism!.fallback_used = true;
              injection.input_realism!.fallback_reason = typingResult.failure_reason ?? "typing_failed";
              logInputRealismLifecycle("input_realism_fallback_to_direct", {
                injection_request_id: injection.injection_request_id,
                field_kind: injection.field_kind,
                domain: injection.domain,
                fallback_used: true,
                fallback_reason: typingResult.failure_reason ?? "typing_failed",
              });
              insertId = send("Input.insertText", { text: resolvedValue }, sessionId!);
            }
          };

          doTypingThenVerify().catch(() => {
            if (injection.input_realism) {
              injection.input_realism.fallback_used = true;
              injection.input_realism.fallback_reason = "typing_exception";
            }
            logInputRealismLifecycle("input_realism_fallback_to_direct", {
              injection_request_id: injection.injection_request_id,
              field_kind: injection.field_kind,
              domain: injection.domain,
              fallback_used: true,
              fallback_reason: "typing_exception",
            });
            insertId = send("Input.insertText", { text: resolvedValue }, sessionId!);
          });
          return;
        }

        // Post-typing verification result — check whether the field has a value.
        if (typingVerifyId !== undefined && id === typingVerifyId) {
          const verifyVal = ((result?.result as Record<string, unknown> | undefined)
            ?.value) as { ok?: boolean; reason?: string } | undefined;
          if (verifyVal?.ok) {
            // Field has a value — proceed to mask/blur (phase 3).
            if (injection.input_realism) {
              injection.input_realism.verify_completed_at = new Date().toISOString();
              injection.input_realism.completed_at = new Date().toISOString();
              injection.input_realism.success = true;
            }
            logInputRealismLifecycle("input_realism_verify_completed", {
              injection_request_id: injection.injection_request_id,
              field_kind: injection.field_kind,
              domain: injection.domain,
              success: true,
            });
            maskId = send("Runtime.evaluate",
              { expression: maskBlurExpr, returnByValue: true }, sessionId!);
          } else {
            // Field is empty after typing (page may ignore synthetic key events).
            // Fall back to insertText, which triggers the existing mask path.
            if (injection.input_realism) {
              injection.input_realism.fallback_used = true;
              injection.input_realism.fallback_reason = verifyVal?.reason ?? "empty_after_typing";
              injection.input_realism.strategy = "direct_assignment";
            }
            logInputRealismLifecycle("input_realism_fallback_to_direct", {
              injection_request_id: injection.injection_request_id,
              field_kind: injection.field_kind,
              domain: injection.domain,
              fallback_used: true,
              fallback_reason: verifyVal?.reason ?? "empty_after_typing",
            });
            insertId = send("Input.insertText", { text: resolvedValue }, sessionId!);
          }
          return;
        }

        // Phase 2 result — Input.insertText.
        if (id === insertId) {
          if (msg.error) {
            // Input.insertText not supported or failed — fall back to setter fill.
            fallbackId = send("Runtime.evaluate", { expression: setterFallbackExpr, returnByValue: true }, sessionId!);
          } else {
            // Insert succeeded — phase 3: apply mask/blur.
            maskId = send("Runtime.evaluate", { expression: maskBlurExpr, returnByValue: true }, sessionId!);
          }
          return;
        }

        // Phase 3 result — mask/blur eval.
        if (id === maskId) {
          const val = (result?.result as Record<string, unknown> | undefined);
          const evalVal = val?.value as { ok?: boolean; reason?: string } | undefined;
          finish(!!evalVal?.ok, evalVal?.ok ? undefined : `CDP evaluate (mask/blur): ${evalVal?.reason ?? "unknown"}`);
          return;
        }

        // Fallback setter result.
        if (id === fallbackId) {
          const val = (result?.result as Record<string, unknown> | undefined);
          const evalVal = val?.value as { ok?: boolean; reason?: string } | undefined;
          finish(!!evalVal?.ok, evalVal?.ok ? undefined : `CDP fallback: ${evalVal?.reason ?? "unknown"}`);
          return;
        }

      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: `WebSocket error: ${(err as Error).message}` });
      });
    });
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "CDP fill failed",
    };
  }
}
