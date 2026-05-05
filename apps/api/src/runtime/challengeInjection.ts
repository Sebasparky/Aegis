import WebSocket from "ws";
import type { SecurityChallenge } from "@aegis/types";

/**
 * Memory-only store for submitted verification codes.
 * Key: challenge_id. Value: { code, expires_at }.
 * Never persisted to disk. Never logged. Never returned to the agent.
 * Deleted immediately after successful or failed injection.
 */
export const challengeCodes = new Map<string, { code: string; expires_at: string }>();

/**
 * Fills the verification code field in the agent's active browser via raw CDP WebSocket.
 *
 * The resolvedCode flows: UI submit → this function → CDP Runtime.evaluate → browser field.
 * It is never logged, returned in an API response, or persisted.
 *
 * Uses the same browser-level CDP WebSocket approach as secretInjection.ts to avoid
 * conflicts with the Playwright MCP which already holds a session on the same Chrome instance.
 */
export async function executeChallengeInjectionViaCDP(
  challenge: SecurityChallenge,
  resolvedCode: string,
): Promise<{ success: boolean; error?: string }> {
  const cdpBase = process.env.AEGIS_PLAYWRIGHT_CDP_URL;
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
    const [versionData, targets] = await Promise.all([
      fetch(`${cdpBase}/json/version`).then((r) => r.json()),
      fetch(`${cdpBase}/json/list`).then((r) => r.json()),
    ]);

    const browserWsUrl: string = (versionData as Record<string, string>).webSocketDebuggerUrl;
    if (!browserWsUrl) {
      return { success: false, error: "No browser WebSocket debugger URL returned by CDP." };
    }

    const pageTarget = (targets as Array<{ id: string; url: string; type: string }>)
      .filter((t) => t.type === "page")
      .find((t) => {
        try {
          const h = new URL(t.url).hostname;
          return h === challenge.domain || h.endsWith(`.${challenge.domain}`);
        } catch {
          return false;
        }
      }) ?? (targets as Array<{ id: string; url: string; type: string }>).filter((t) => t.type === "page").at(-1);

    if (!pageTarget) {
      return { success: false, error: "No page targets found via CDP." };
    }

    const { selector_hint, label, placeholder, input_type } = challenge.element_hint ?? {};

    let selectorExpr: string;
    if (selector_hint) {
      selectorExpr = `document.querySelector(${JSON.stringify(selector_hint)})`;
    } else if (label) {
      selectorExpr = `(function() {
        var labels = Array.from(document.querySelectorAll('label'));
        var lbl = labels.find(function(l) { return l.textContent && l.textContent.trim().toLowerCase().indexOf(${JSON.stringify(label.toLowerCase())}) >= 0; });
        if (!lbl) return null;
        if (lbl.htmlFor) return document.getElementById(lbl.htmlFor);
        return lbl.querySelector('input');
      })()`;
    } else if (placeholder) {
      selectorExpr = `document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`;
    } else if (input_type) {
      selectorExpr = `document.querySelector('input[type=${JSON.stringify(input_type)}]')`;
    } else {
      // Fallback selectors for verification code fields — prefer semantic attributes
      selectorExpr = `(document.querySelector('input[autocomplete="one-time-code"]') || document.querySelector('input[name*="code"]') || document.querySelector('input[id*="code"]') || document.querySelector('input[type="text"]') || document.querySelector('input[type="number"]'))`;
    }

    const fillExpr = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(resolvedCode)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`;

    return await new Promise<{ success: boolean; error?: string }>((resolve) => {
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
        const result = msg.result as Record<string, unknown> | undefined;
        if (result?.sessionId && !sessionId) {
          sessionId = result.sessionId as string;
          send("Runtime.evaluate", { expression: fillExpr, returnByValue: true }, sessionId);
          return;
        }
        const evalResult = result?.result as Record<string, unknown> | undefined;
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
