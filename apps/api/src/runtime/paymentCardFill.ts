import type { PaymentCardFillRequest, PaymentCardField } from "@aegis/types";
import { fillOppwaIframeField } from "./paymentIframeFill.js";
import { executeProtectedRealisticFill } from "./protectedRealisticFill.js";

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
 * The card value is entered through the shared realistic-fill primitive
 * (`executeProtectedRealisticFill`): realistic pointer movement to the field,
 * click/focus, character-by-character typing, and the input/change/blur sequence
 * the page expects — NOT an invisible DOM `value` mutation. Expiry <select>
 * controls are committed by real option selection (the primitive auto-detects
 * element shape).
 *
 * Security constraints:
 * - The ONLY pointer/click performed is to focus the target field. No submit
 *   button, Pay/Place Order/Confirm control, requestSubmit(), keyboard Enter, or
 *   navigation is ever triggered.
 * - card_number and cvv DOM values are masked after fill (same technique as password masking in secretInjection.ts).
 * - resolvedValue flows: KMS/pm → this function → CDP key events / eval → browser field. It is never logged, returned, or persisted.
 * - For card_number and cvv: attempts OPPWA PCI iframe fill first via Target.getTargets.
 *   Returns with iframeProvider set on success, or { success: false, error: "OPPWA_..." } on failure.
 *   Falls through to parent-page fill when no OPPWA iframes are detected (not_applicable).
 * - For non-card fields, a field inside an <iframe> fails closed with IFRAME_NOT_SUPPORTED.
 */
export async function executePaymentCardFillViaCDP(
  fillRequest: PaymentCardFillRequest,
  resolvedValue: string,
  cdpUrlOverride?: string,
  opts?: { debugOverlay?: boolean },
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

    // Card number and CVV are masked in the DOM after fill (value getter → '') to prevent
    // element.value readback. Non-secret fields (expiry, cardholder_name, billing_zip) are
    // not masked — checkout pages must read and submit them. Expiry <select> controls are
    // never masked (handled by the primitive's SELECT branch).
    const maskDomValue = fillRequest.field === "card_number" || fillRequest.field === "cvv";

    // Visually mask ALL protected payment-card fields after fill so the rendered
    // value never appears in the live browser UI or in an agent-facing screenshot:
    // PAN, CVV, expiry, and cardholder name. (billing_zip is not a card secret and
    // is left visible.) This is purely visual — the submittable value is untouched —
    // and tags each field `data-antigen-masked="true"` for the screenshot redaction
    // layer. Independent of `maskDomValue` (DOM-read protection for PAN/CVV only).
    const visualMask =
      fillRequest.field === "card_number" ||
      fillRequest.field === "cvv" ||
      fillRequest.field === "expiry_month" ||
      fillRequest.field === "expiry_year" ||
      fillRequest.field === "expiry_combined" ||
      fillRequest.field === "cardholder_name";

    // Enter the value through the shared realistic-fill primitive: realistic pointer
    // move → click/focus → character-by-character typing → input/change/blur (or real
    // option selection for <select>). The resolvedValue flows only into the primitive
    // via CDP; it is never returned here. A field inside an <iframe> fails closed with
    // IFRAME_NOT_SUPPORTED.
    const fillResult = await executeProtectedRealisticFill({
      browserWsUrl,
      pageTargetId: pageTarget.id,
      selectorExpr,
      value: resolvedValue,
      maskDomValue,
      visualMask,
      debugOverlay: opts?.debugOverlay,
      typingProfile: maskDomValue ? "password" : "username",
      requestId: fillRequest.fill_request_id,
      domain: fillRequest.domain,
      fieldLabel: fillRequest.field,
      browserSessionId: fillRequest.browser_session_id,
      userId: fillRequest.user_id,
    });

    return { success: fillResult.success, error: fillResult.error };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "CDP card fill failed",
    };
  }
}
