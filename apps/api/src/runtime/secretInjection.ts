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
 * The resolvedValue flows: KMS → this function → CDP Runtime.evaluate → browser field.
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

    // Build a JS fill expression from element_hint, mirroring the Playwright locator logic.
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

    // Embed resolvedValue as a JSON string literal so it never appears in logs as plain text.
    const fillExpr = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(resolvedValue)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`;

    return await new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl);
      let msgId = 1;
      let sessionId: string | null = null;
      const timer = setTimeout(() => {
        ws.terminate();
        resolve({ success: false, error: "CDP fill timed out after 10 seconds." });
      }, 10_000);

      const send = (method: string, params: Record<string, unknown> = {}, sid?: string) => {
        const id = msgId++;
        const msg: Record<string, unknown> = { id, method, params };
        if (sid) msg.sessionId = sid;
        ws.send(JSON.stringify(msg));
        return id;
      };

      ws.on("open", () => {
        send("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
      });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Attached — got a session ID; now evaluate the fill expression.
        const result = msg.result as Record<string, unknown> | undefined;
        if (result?.sessionId && !sessionId) {
          sessionId = result.sessionId as string;
          send("Runtime.evaluate", { expression: fillExpr, returnByValue: true }, sessionId);
          return;
        }

        // Evaluate result returned.
        const evalResult = (result?.result as Record<string, unknown> | undefined);
        if (evalResult?.type === "object" && evalResult?.value !== undefined && sessionId) {
          clearTimeout(timer);
          ws.close();
          const val = evalResult.value as { ok?: boolean; reason?: string };
          if (val?.ok) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `CDP evaluate: ${val?.reason ?? "unknown"}` });
          }
          return;
        }

        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          resolve({ success: false, error: `CDP error: ${JSON.stringify(msg.error)}` });
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: `WebSocket error: ${err.message}` });
      });
    });
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "CDP fill failed",
    };
  }
}
