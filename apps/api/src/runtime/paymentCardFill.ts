import WebSocket from "ws";
import type { PaymentCardFillRequest, PaymentCardField } from "@aegis/types";
import { fillOppwaIframeField } from "./paymentIframeFill.js";

// Purchase-control selector patterns — any selector matching these must be rejected at creation time.
// This is a defence-in-depth validation; the runtime contains no click path.
const DANGEROUS_SELECTOR_PATTERNS: RegExp[] = [
  /\bbutton\b/i,
  /\bsubmit\b/i,
  /\[type\s*=\s*["']?submit/i,
  /input\[type\s*=\s*["']?button/i,
  /\bform\b/i,
  /\ba\[href\b/i,
  /\[role\s*=\s*["']?button/i,
];

/**
 * Validate a CSS selector_hint provided by the agent.
 * Rejects selectors that could target buttons, submit controls, forms, or anchor links.
 * Called at fill-request creation time — never at execution time.
 */
export function validateCardFillSelector(selector: string): { valid: boolean; reason?: string } {
  for (const pattern of DANGEROUS_SELECTOR_PATTERNS) {
    if (pattern.test(selector)) {
      return {
        valid: false,
        reason:
          `Selector "${selector}" appears to target a button, submit control, form, or anchor — ` +
          `which are prohibited for card field fill. Provide a selector that targets only the input field.`,
      };
    }
  }
  return { valid: true };
}

/**
 * Resolve the plain-text value for a given PaymentCardField from the payment method record.
 * For KMS-protected fields (card_number, cvv) the blob + context are resolved by the caller
 * and passed in as resolvedKmsValues. Non-secret fields are derived directly from the pm struct.
 */
export function resolveFieldValue(
  field: PaymentCardField,
  pm: {
    cardholder_name: string;
    exp_month: number;
    exp_year: number;
    billing_zip?: string;
  },
  resolvedKmsValues: Partial<Record<"card_number" | "cvv", string>>,
): string {
  switch (field) {
    case "card_number":
      return resolvedKmsValues.card_number ?? "";
    case "cvv":
      return resolvedKmsValues.cvv ?? "";
    case "expiry_month":
      return String(pm.exp_month);
    case "expiry_year":
      return String(pm.exp_year);
    case "expiry_combined":
      return `${String(pm.exp_month).padStart(2, "0")}/${String(pm.exp_year).slice(-2)}`;
    case "cardholder_name":
      return pm.cardholder_name;
    case "billing_zip":
      return pm.billing_zip ?? "";
  }
}

/**
 * Fill a single payment card field in the agent's active browser via raw CDP WebSocket.
 *
 * Security constraints:
 * - No click(), submit(), requestSubmit(), dispatchEvent(MouseEvent), keyboard Enter, or navigation.
 * - card_number and cvv DOM values are masked after fill (same technique as password masking in secretInjection.ts).
 * - resolvedValue flows: KMS/pm → this function → CDP → browser field. It is never logged, returned, or persisted.
 * - For card_number and cvv: attempts OPPWA PCI iframe fill first via Target.getTargets.
 *   Returns with iframeProvider set on success, or { success: false, error: "OPPWA_..." } on failure.
 *   Falls through to parent-page fill when no OPPWA iframes are detected (not_applicable).
 * - For non-card fields, iframe detection still returns IFRAME_NOT_SUPPORTED as before.
 */
export async function executePaymentCardFillViaCDP(
  fillRequest: PaymentCardFillRequest,
  resolvedValue: string,
  cdpUrlOverride?: string,
): Promise<{
  success: boolean;
  error?: string;
  iframeProvider?: "oppwa";
  iframeOrigin?: string;
  iframePath?: string;
}> {
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
    const [versionData, targets] = await Promise.all([
      fetch(`${cdpBase}/json/version`).then((r) => r.json()),
      fetch(`${cdpBase}/json/list`).then((r) => r.json()),
    ]);

    const browserWsUrl: string = (versionData as Record<string, string>).webSocketDebuggerUrl;
    if (!browserWsUrl) {
      return { success: false, error: "No browser WebSocket debugger URL returned by CDP." };
    }

    // OPPWA iframe routing — card_number and cvv fields may live inside cross-origin
    // PCI iframes that are unreachable from the parent page's document context.
    // Attempt the OPPWA iframe path first; fall through only when not_applicable.
    if (fillRequest.field === "card_number" || fillRequest.field === "cvv") {
      const iframeResult = await fillOppwaIframeField({
        browserWsUrl,
        field_kind: fillRequest.field,
        resolvedValue,
      });
      if (iframeResult.status === "filled") {
        return {
          success: true,
          iframeProvider: "oppwa",
          iframeOrigin: iframeResult.iframe_origin,
          iframePath: iframeResult.iframe_path,
        };
      }
      if (iframeResult.status === "failed") {
        return { success: false, error: iframeResult.error_code };
      }
      // status === "not_applicable" → no OPPWA iframes present; fall through to parent-page fill
    }

    const pageTarget = (targets as Array<{ id: string; url: string; type: string }>)
      .filter((t) => t.type === "page")
      .find((t) => {
        try {
          const h = new URL(t.url).hostname;
          return h === fillRequest.domain || h.endsWith(`.${fillRequest.domain}`);
        } catch {
          return false;
        }
      }) ?? (targets as Array<{ id: string; url: string; type: string }>).filter((t) => t.type === "page").at(-1);

    if (!pageTarget) {
      return { success: false, error: "No page targets found via CDP." };
    }

    const { selector_hint, label, placeholder, input_type } = fillRequest.element_hint ?? {};

    let selectorExpr: string;
    if (selector_hint) {
      selectorExpr = `document.querySelector(${JSON.stringify(selector_hint)})`;
    } else if (label) {
      selectorExpr = `(function() {
        var labels = Array.from(document.querySelectorAll('label'));
        var lbl = labels.find(function(l) { return l.textContent && l.textContent.trim().toLowerCase().indexOf(${JSON.stringify(label.toLowerCase())}) !== -1; });
        if (!lbl) return null;
        if (lbl.htmlFor) return document.getElementById(lbl.htmlFor);
        return lbl.querySelector('input');
      })()`;
    } else if (placeholder) {
      selectorExpr = `document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`;
    } else if (input_type) {
      selectorExpr = `document.querySelector('input[type=${JSON.stringify(input_type)}]')`;
    } else {
      // Generic fallback by field — prefers text/tel inputs, avoids submit controls
      selectorExpr = `document.querySelector('input[type="text"],input[type="tel"],input:not([type])')`;
    }

    // Mask card_number and cvv DOM values after fill to prevent element.value readback.
    // Non-secret fields (expiry, cardholder_name, billing_zip) are not masked.
    const isSensitiveField = fillRequest.field === "card_number" || fillRequest.field === "cvv";
    const maskBlock = isSensitiveField
      ? `
      Object.defineProperty(el, 'value', {
        get: function() { return ''; },
        set: function(v) { setter.call(el, v); },
        configurable: true,
      });`
      : "";

    // Iframe detection — return a clear error if the field is inside an iframe.
    // No broad iframe traversal in v1.
    const iframeCheck = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };
      var node = el;
      while (node.parentNode) {
        if (node.tagName === 'IFRAME') return { ok: false, reason: 'IFRAME_NOT_SUPPORTED' };
        node = node.parentNode;
      }
      return { ok: true, el: el };
    })()`;

    // Separate fill expression — only executed after iframe check passes.
    const fillExpr = `(function() {
      var el = ${selectorExpr};
      if (!el) return { ok: false, reason: 'element not found' };
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(resolvedValue)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));${maskBlock}
      el.setAttribute('data-antigen-filled', 'true');
      return { ok: true };
    })()`;

    return await new Promise<{
      success: boolean;
      error?: string;
      iframeProvider?: "oppwa";
      iframeOrigin?: string;
      iframePath?: string;
    }>((resolve) => {
      const ws = new WebSocket(browserWsUrl);
      let msgId = 1;
      let sessionId: string | null = null;
      let phase: "attach" | "iframe_check" | "fill" = "attach";

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

        // Phase: attach — got session ID; run iframe check first
        if (result?.sessionId && !sessionId) {
          sessionId = result.sessionId as string;
          phase = "iframe_check";
          send("Runtime.evaluate", { expression: iframeCheck, returnByValue: true }, sessionId);
          return;
        }

        const evalResult = result?.result as Record<string, unknown> | undefined;
        if (evalResult?.type === "object" && evalResult?.value !== undefined && sessionId) {
          const val = evalResult.value as { ok?: boolean; reason?: string };

          if (phase === "iframe_check") {
            if (!val?.ok) {
              clearTimeout(timer);
              ws.close();
              resolve({ success: false, error: `CDP iframe check: ${val?.reason ?? "unknown"}` });
              return;
            }
            // Iframe check passed — proceed to fill
            phase = "fill";
            send("Runtime.evaluate", { expression: fillExpr, returnByValue: true }, sessionId);
            return;
          }

          if (phase === "fill") {
            clearTimeout(timer);
            ws.close();
            if (val?.ok) {
              resolve({ success: true });
            } else {
              resolve({ success: false, error: `CDP evaluate: ${val?.reason ?? "unknown"}` });
            }
            return;
          }
        }

        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          resolve({ success: false, error: `CDP error: ${JSON.stringify(msg.error)}` });
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
      error: err instanceof Error ? err.message : "CDP card fill failed",
    };
  }
}
