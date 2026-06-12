import type { PaymentCardFillRequest, PaymentCardField } from "@aegis/types";
import { fillOppwaIframeField } from "./paymentIframeFill.js";
import { executeProtectedRealisticFill } from "./protectedRealisticFill.js";
import { resolveAntigenRefForSession, type AntigenSnapshotElementRecord } from "./antigenSnapshotStore.js";

/** An opaque Antigen snapshot ref token: `ag_` followed by one or more digits. */
const ANTIGEN_REF_PATTERN = /^ag_\d+$/;

/** True iff the string is a well-formed opaque `ag_*` snapshot ref (not a selector). */
export function isAntigenRef(ref: string): boolean {
  return ANTIGEN_REF_PATTERN.test(ref);
}

/**
 * Build the in-page `selectorExpr` for a payment field from its resolved Antigen
 * snapshot record. The snapshot already located the element robustly, so we reuse
 * its stored identity instead of re-guessing with fragile selector heuristics:
 *
 *  - Prefer `document.getElementById(id)` when the snapshot captured a DOM id —
 *    scroll-independent and exact. A non-fillable id-hit (an id on a wrapper) is
 *    walked, not returned raw.
 *  - Otherwise fall back to `document.elementFromPoint(cx, cy)` at the box center
 *    (the same box-center strategy the realistic click/type path uses), then walk
 *    to the nearest fillable control: label association (`closest('label')` →
 *    `.control` / `htmlFor` / descendant), `closest()`, then a bounded ancestor
 *    walk (≤3 levels) preferring a descendant control whose rect CONTAINS the
 *    point, else nearest-by-center under a 150px cap. Floating-label markup —
 *    where the point hit is an overlay span, not the input — resolves to the real
 *    control this way.
 *  - FAIL CLOSED: resolves to `null` when no fillable control is found, so the
 *    fill primitive reports `element_not_found` instead of attempting native
 *    input calls on a decorative node ("Illegal invocation").
 *
 * When the snapshot recorded the element as input/select/textarea, only that tag
 * is accepted as the resolution target (prevents grabbing an adjacent control of
 * a different shape).
 *
 * The id/box/coordinates live ONLY inside this CDP-evaluated expression — they are
 * never returned to the agent, logged, or placed in any response/trace/error.
 */
export function buildRefSelectorExpr(record: AntigenSnapshotElementRecord): string {
  const cx = record.box.x + record.box.width / 2;
  const cy = record.box.y + record.box.height / 2;
  const byIdExpr = record.id ? `document.getElementById(${JSON.stringify(record.id)})` : "null";
  const wanted = ["input", "select", "textarea"].includes(record.tag)
    ? record.tag
    : "input,select,textarea";
  return `(function() {
    var SEL = ${JSON.stringify(wanted)};
    var cx = ${cx}, cy = ${cy};
    function fillable(n) {
      if (!n || !n.tagName) return false;
      if (n.tagName !== 'INPUT' && n.tagName !== 'SELECT' && n.tagName !== 'TEXTAREA') return false;
      return SEL === 'input,select,textarea' || n.tagName === SEL.toUpperCase();
    }
    function fromLabel(n) {
      var lab = (n && n.closest) ? n.closest('label') : null;
      if (!lab) return null;
      if (lab.control && fillable(lab.control)) return lab.control;
      if (lab.htmlFor) { var t = document.getElementById(lab.htmlFor); if (fillable(t)) return t; }
      var d = lab.querySelector(SEL);
      return fillable(d) ? d : null;
    }
    function containsPoint(n) {
      var r = n.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    }
    function bestDescendant(root) {
      if (!root || !root.querySelectorAll) return null;
      var list = root.querySelectorAll(SEL);
      var best = null, bestD = Infinity;
      for (var i = 0; i < list.length; i++) {
        if (!fillable(list[i])) continue;
        if (containsPoint(list[i])) return list[i];
        var r = list[i].getBoundingClientRect();
        var dx = (r.left + r.width / 2) - cx, dy = (r.top + r.height / 2) - cy;
        var d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = list[i]; }
      }
      return (best && bestD <= 150 * 150) ? best : null;
    }
    function resolve(start) {
      if (fillable(start)) return start;
      var viaLabel = fromLabel(start);
      if (viaLabel) return viaLabel;
      var up = (start && start.closest) ? start.closest(SEL) : null;
      if (up && fillable(up)) return up;
      var node = start;
      for (var depth = 0; node && depth <= 3; depth++) {
        var hit = bestDescendant(node);
        if (hit) return hit;
        node = node.parentElement;
      }
      return null;
    }
    var byId = ${byIdExpr};
    if (byId) { var r1 = resolve(byId); if (r1) return r1; }
    var el = document.elementFromPoint(cx, cy);
    return el ? resolve(el) : null;
  })()`;
}

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
/**
 * Priority-ordered CSS selectors for locating a payment-card field on the parent page when the
 * agent supplies no element_hint. Tried in order (first match wins) — NOT joined into a single
 * `querySelector` list, because a comma list returns the first match in DOM order, which on an
 * OPPWA checkout returns the cardholder input for an expiry request. Each list ends with a safe
 * generic input as a last resort. Card number / CVV normally fill inside their OPPWA PCI iframes;
 * these parent selectors only apply on non-iframe checkouts. Exported for unit testing.
 */
export function fieldFallbackSelectors(field: PaymentCardField): string[] {
  const generic = 'input[type="text"],input[type="tel"],input:not([type])';
  switch (field) {
    case "card_number":
      return ['.wpwl-control-cardNumber', 'input[autocomplete="cc-number"]', 'input[name*="cardnumber" i]', 'input[name*="card-number" i]', generic];
    case "cvv":
      return ['.wpwl-control-cvv', 'input[autocomplete="cc-csc"]', 'input[name*="cvv" i]', 'input[name*="cvc" i]', 'input[name*="securitycode" i]', generic];
    case "expiry_combined":
      return ['.wpwl-control-expiry', 'input[autocomplete="cc-exp"]', 'input[name="card.expiry" i]', 'input[name*="expiry" i]:not([type="hidden"])', 'input[placeholder*="MM/YY" i]', 'input[placeholder*="MM / YY" i]', generic];
    case "expiry_month":
      return ['.wpwl-control-expiryMonth', 'input[autocomplete="cc-exp-month"]', 'input[name="card.expiryMonth" i]', 'input[name*="expmonth" i]', 'input[name*="expiry-month" i]', generic];
    case "expiry_year":
      return ['.wpwl-control-expiryYear', 'input[autocomplete="cc-exp-year"]', 'input[name="card.expiryYear" i]', 'input[name*="expyear" i]', 'input[name*="expiry-year" i]', generic];
    case "cardholder_name":
      return ['.wpwl-control-cardHolder', 'input[autocomplete="cc-name"]', 'input[name="card.holder" i]', 'input[name*="holder" i]', 'input[name*="cardname" i]', generic];
    case "billing_zip":
      return ['.wpwl-control-billingZip', 'input[autocomplete="postal-code"]', 'input[name*="zip" i]', 'input[name*="postal" i]', generic];
    default:
      return [generic];
  }
}

export async function executePaymentCardFillViaCDP(
  fillRequest: PaymentCardFillRequest,
  resolvedValue: string,
  cdpUrlOverride?: string,
  opts?: { debugOverlay?: boolean },
): Promise<{
  success: boolean;
  error?: string;
  iframeProvider?: "oppwa";
  iframeFieldKind?: "card_number" | "cvv" | "expiry";
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

    // OPPWA iframe routing — card_number, cvv, and the combined expiry (MM/YY) field
    // may live inside cross-origin PCI iframes that are unreachable from the parent
    // page's document context. Map the request field to the iframe field-kind and
    // attempt the OPPWA iframe path first; fall through only when not_applicable.
    // (expiry_month / expiry_year stay on the parent-page path — those target split
    // <select> controls on non-OPPWA checkouts, not the combined OPPWA expiry widget.)
    const iframeFieldKind: "card_number" | "cvv" | "expiry" | null =
      fillRequest.field === "card_number" ? "card_number" :
      fillRequest.field === "cvv" ? "cvv" :
      fillRequest.field === "expiry_combined" ? "expiry" :
      null;
    if (iframeFieldKind) {
      const iframeResult = await fillOppwaIframeField({
        browserWsUrl,
        field_kind: iframeFieldKind,
        resolvedValue,
      });
      if (iframeResult.status === "filled") {
        return {
          success: true,
          iframeProvider: "oppwa",
          iframeFieldKind,
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

    const { antigen_ref, selector_hint, label, placeholder, input_type } = fillRequest.element_hint ?? {};

    let selectorExpr: string;
    if (antigen_ref) {
      // Highest-priority locator for top-level / parent-page payment fields (e.g.
      // IKEA's expiry MM/YY and cardholder inputs). The agent passes only the opaque
      // ag_* ref it received from antigen_snapshot; Aegis resolves it server-side to
      // the snapshot's stored element and derives an id/box-based selector. We FAIL
      // CLOSED on any resolution problem (stale/expired/wrong-session/missing) and ask
      // for a fresh snapshot — we do NOT fall back to fragile selectors, and we never
      // surface the id/box/coordinates to the agent.
      if (!isAntigenRef(antigen_ref)) {
        return { success: false, error: "INVALID_ANTIGEN_REF" };
      }
      const resolution = resolveAntigenRefForSession(
        fillRequest.browser_session_id ?? "",
        fillRequest.user_id,
        antigen_ref,
      );
      if (resolution.status !== "ok") {
        // no_snapshot | expired | ref_not_found → the snapshot the agent referenced is
        // no longer valid for this session. Re-snapshot and retry; no fill is attempted.
        return { success: false, error: "ANTIGEN_REF_STALE" };
      }
      selectorExpr = buildRefSelectorExpr(resolution.element);
    } else if (selector_hint) {
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
      // Field-aware fallback when the agent gives no hint. The previous generic
      // "first text/tel input" mis-targeted on OPPWA-style checkouts (e.g. IKEA): the
      // expiry MM/YY control and the cardholder field are plain inputs rendered by the
      // payment widget, and the FIRST text input on the page is the cardholder — so an
      // unhinted expiry fill landed on the wrong field. We try a priority-ordered list
      // of selectors (widget class → autocomplete → name/placeholder → generic) and take
      // the first that matches, in selector priority order rather than DOM order (a plain
      // `querySelector('A, B')` returns the first match in DOCUMENT order, which would
      // re-introduce the cardholder mis-target — so we loop instead).
      selectorExpr = `(function() {
        var sels = ${JSON.stringify(fieldFallbackSelectors(fillRequest.field))};
        for (var i = 0; i < sels.length; i++) {
          var el = document.querySelector(sels[i]);
          if (el) return el;
        }
        return null;
      })()`;
    }

    // The whole protected payment-card bundle is agent-opaque: every field that comes
    // from the protected card vault is DOM-readback masked after fill (value getter → ''
    // for inputs; a select getter mask for <select> expiry) so the raw value cannot be
    // read back through element.value / browser_evaluate / snapshots. The underlying
    // control keeps the real, submittable value (native setter / selected option intact).
    // billing_zip is NOT a card secret — checkout pages must read and submit it, so it
    // stays readable.
    const maskDomValue =
      fillRequest.field === "card_number" ||
      fillRequest.field === "cvv" ||
      fillRequest.field === "expiry_month" ||
      fillRequest.field === "expiry_year" ||
      fillRequest.field === "expiry_combined" ||
      fillRequest.field === "cardholder_name";

    // Only PAN and CVV are KMS-resolved true secrets — they drive the slower "password"
    // typing realism. Expiry/cardholder are non-secret metadata: keep normal typing timing
    // even though they are now DOM-readback masked (masking is decoupled from typing).
    const secretField = fillRequest.field === "card_number" || fillRequest.field === "cvv";

    // Visually mask ALL protected payment-card fields after fill so the rendered
    // value never appears in the live browser UI or in an agent-facing screenshot:
    // PAN, CVV, expiry, and cardholder name. (billing_zip is not a card secret and
    // is left visible.) This is purely visual — the submittable value is untouched —
    // and tags each field `data-antigen-masked="true"` for the screenshot redaction
    // layer. Tracks `maskDomValue` for the same four protected fields (billing_zip excluded).
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
      typingProfile: secretField ? "password" : "username",
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
