import WebSocket from "ws";
import type { SecretFieldInjection } from "@aegis/types";

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

    // Find the page whose hostname matches the injection domain; fall back to last target.
    const pageTarget = (targets as Array<{ id: string; url: string; type: string }>)
      .filter((t) => t.type === "page")
      .find((t) => {
        try {
          const h = new URL(t.url).hostname;
          return h === injection.domain || h.endsWith(`.${injection.domain}`);
        } catch {
          return false;
        }
      }) ?? (targets as Array<{ id: string; url: string; type: string }>).filter((t) => t.type === "page").at(-1);

    if (!pageTarget) {
      return { success: false, error: "No page targets found via CDP." };
    }

    // Build a JS selector expression from element_hint, mirroring the Playwright locator logic.
    const { selector_hint, label, placeholder, input_type } = injection.element_hint ?? {};

    let selectorExpr: string;
    if (selector_hint) {
      selectorExpr = `document.querySelector(${JSON.stringify(selector_hint)})`;
    } else if (label) {
      // Find label by text, then resolve its associated input.
      selectorExpr = `(function() {
        const labels = Array.from(document.querySelectorAll('label'));
        const lbl = labels.find(l => l.textContent?.trim().toLowerCase().includes(${JSON.stringify(label.toLowerCase())}));
        if (!lbl) return null;
        if (lbl.htmlFor) return document.getElementById(lbl.htmlFor);
        return lbl.querySelector('input');
      })()`;
    } else if (placeholder) {
      selectorExpr = `document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`;
    } else if (input_type) {
      selectorExpr = `document.querySelector('input[type=${JSON.stringify(input_type)}]')`;
    } else if (injection.field_kind === "password") {
      selectorExpr = `document.querySelector('input[type="password"]')`;
    } else {
      selectorExpr = `document.querySelector('input[type="email"],input[type="text"],input:not([type])')`;
    }

    // Phase 1 (focus/clear): locate element, scroll into view, focus, clear existing value.
    // No secret value in this expression.
    const focusExpr = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };
      el.scrollIntoView({ block: 'nearest' });
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return { ok: true };
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

    return await new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl);
      let msgId = 1;
      let sessionId: string | null = null;

      // Track each CDP command's message ID so responses can be routed unambiguously.
      let attachId: number;
      let focusId: number;
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
        const result = msg.result as Record<string, unknown> | undefined;

        // Attach response — got a session ID; start phase 1 (focus/clear).
        if (id === attachId) {
          if (!result?.sessionId) {
            finish(false, "CDP attach failed: no sessionId returned.");
            return;
          }
          sessionId = result.sessionId as string;
          focusId = send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId);
          return;
        }

        // Phase 1 result — focus/clear eval.
        if (id === focusId) {
          const val = (result?.result as Record<string, unknown> | undefined);
          const evalVal = val?.value as { ok?: boolean; reason?: string } | undefined;
          if (evalVal?.ok) {
            // Focus succeeded — phase 2: type via Input.insertText (secret in params, not in JS).
            insertId = send("Input.insertText", { text: resolvedValue }, sessionId!);
          } else {
            finish(false, `CDP evaluate (focus): ${evalVal?.reason ?? "element not found"}`);
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

        if (msg.error && !id) {
          finish(false, `CDP error: ${JSON.stringify(msg.error)}`);
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
