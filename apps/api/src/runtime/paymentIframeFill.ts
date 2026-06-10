import WebSocket from "ws";

// ─── OPPWA / Worldline iframe fill v1 ─────────────────────────────────────────
//
// Fills card_number and CVV fields hosted inside OPPWA cross-origin PCI iframes
// (eu-prod.oppwa.com/v1/pciIframe.html).  The fill uses direct native-setter
// assignment + dispatchEvent, which is sufficient in v1 mocked tests.
//
// TODO(v2): If real OPPWA validation rejects setter-assigned values, replace
// the fill expression with:
//   el.focus();
//   send("Input.insertText", { text: resolvedValue }, sessionId)
// or character-by-character Input.dispatchKeyEvent calls, which more closely
// replicate real typing and are more likely to trigger widget event listeners.
// Defer until manual IKEA validation confirms or denies setter reliability.

// ─── Error codes ──────────────────────────────────────────────────────────────

export const OPPWA_ERRORS = {
  FRAME_NOT_FOUND:      "OPPWA_FRAME_NOT_FOUND",
  FRAME_ATTACH_FAILED:  "OPPWA_FRAME_ATTACH_FAILED",
  INPUT_NOT_FOUND:      "OPPWA_INPUT_NOT_FOUND",
  TYPING_FAILED:        "OPPWA_TYPING_FAILED",
  UNSUPPORTED_PROVIDER: "UNSUPPORTED_PAYMENT_IFRAME_PROVIDER",
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────
// Internal only — never returned directly to agents.

export type PaymentIframeProvider  = "oppwa" | "unknown";
export type PaymentIframeFieldKind = "card_number" | "cvv" | "expiry" | "unknown";

export interface PaymentIframeDescriptor {
  provider: PaymentIframeProvider;
  field_kind: PaymentIframeFieldKind;
  iframe_name?: string;
  iframe_title?: string;
  iframe_classes?: string[];
  origin: string;    // sanitized (no query / hash)
  hostname: string;
  pathname: string;
}

export type PaymentIframeFillResult =
  | { status: "not_applicable" }
  | {
      status: "filled";
      iframe_provider: "oppwa";
      iframe_origin: string;
      iframe_path: string;
      raw_value_revealed_to_agent: false;
      purchase_not_authorized: true;
    }
  | {
      status: "failed";
      error_code: string;
      iframe_provider?: "oppwa";
      raw_value_revealed_to_agent: false;
      purchase_not_authorized: true;
    };

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Strip query string and hash from a URL string.
 * Called before any hostname / pathname comparison.
 */
export function sanitizeIframeUrl(url: string): string {
  try {
    const u = new URL(url);
    const result = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "");
    return result || url;
  } catch {
    return url;
  }
}

/**
 * Classify an iframe by its origin attributes.
 * Pure — no side effects, no network calls.
 *
 * Allowed OPPWA PCI iframe path: /v1/pciIframe.html on any *.oppwa.com host.
 * Iframes with name=internalRequest, class wpwl-target, or non-oppwa origins
 * (e.g. pay.google.com) are returned as provider="unknown".
 */
export function classifyPaymentIframe(input: {
  origin: string;
  pathname?: string;
  name?: string;
  title?: string;
  classes?: string[];
}): PaymentIframeDescriptor {
  const sanitized = sanitizeIframeUrl(input.origin);

  let hostname = "";
  let parsedPathname = "";
  try {
    const u = new URL(sanitized);
    hostname = u.hostname;
    parsedPathname = u.pathname;
  } catch {
    // hostname stays empty → will classify as unknown
  }

  const effectivePathname = input.pathname ?? parsedPathname;

  const base: PaymentIframeDescriptor = {
    provider: "unknown",
    field_kind: "unknown",
    iframe_name: input.name,
    iframe_title: input.title,
    iframe_classes: input.classes,
    origin: sanitized,
    hostname,
    pathname: effectivePathname,
  };

  // Must be an oppwa.com host on exactly the PCI iframe path
  if (!hostname.endsWith("oppwa.com") || effectivePathname !== "/v1/pciIframe.html") {
    return base;
  }

  // Reject internal / non-fill iframes even on oppwa.com
  if (input.name === "internalRequest" || input.classes?.includes("wpwl-target")) {
    return base;
  }

  base.provider = "oppwa";

  if (
    input.name === "card.number" ||
    input.classes?.includes("wpwl-control-cardNumber")
  ) {
    base.field_kind = "card_number";
  } else if (
    input.name === "card.cvv" ||
    input.classes?.includes("wpwl-control-cvv")
  ) {
    base.field_kind = "cvv";
  } else if (
    input.name === "card.expiry" ||
    input.name === "card.expiryMonth" ||
    input.name === "card.expiryYear" ||
    input.classes?.includes("wpwl-control-expiry")
  ) {
    base.field_kind = "expiry";
  }
  // field_kind stays "unknown" for unrecognized OPPWA iframes

  return base;
}

// ─── Internal disambiguation helper ──────────────────────────────────────────

interface CdpTargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
}

function pickOppwaTarget(
  targets: CdpTargetInfo[],
  field_kind: "card_number" | "cvv" | "expiry",
): CdpTargetInfo | undefined {
  // 1. Primary: URL query param name=card.number / name=card.cvv / name=card.expiry
  for (const t of targets) {
    try {
      const n = new URL(t.url).searchParams.get("name");
      if (field_kind === "card_number" && n === "card.number") return t;
      if (field_kind === "cvv"         && n === "card.cvv")    return t;
      if (field_kind === "expiry"      && (n === "card.expiry" || n === "card.expiryMonth")) return t;
    } catch { /* skip */ }
  }

  // 2. Secondary: title substring (case-insensitive)
  for (const t of targets) {
    const ti = (t.title ?? "").toLowerCase();
    if (field_kind === "card_number" && ti.includes("card number")) return t;
    if (field_kind === "cvv" && (ti.includes("cvv") || ti.includes("security code"))) return t;
    if (field_kind === "expiry" && (ti.includes("expiry") || ti.includes("expiration") || ti.includes("valid thru") || ti.includes("mm/yy"))) return t;
  }

  // 3. Tertiary: positional — first OPPWA iframe = card_number, second = cvv, third = expiry
  if (field_kind === "card_number") return targets[0];
  if (field_kind === "cvv")         return targets[1];
  if (field_kind === "expiry")      return targets[2];

  return undefined;
}

/**
 * Pick the index of the top-document <iframe> element that hosts the given
 * protected card field, by inspecting only the parent-owned `src` attribute.
 *
 * This is the top-document mirror of `pickOppwaTarget` (which matches CDP iframe
 * *targets*). It is used by the screenshot redaction path to locate the iframe
 * container whose bounding box must be blacked out — it never inspects iframe
 * internals.
 *
 * Match priority (identical to pickOppwaTarget):
 *   1. Primary: `?name=card.number` / `?name=card.cvv` among iframes whose host
 *      ends with `oppwa.com` on path `/v1/pciIframe.html`.
 *   2. Positional fallback: first OPPWA iframe = card_number, second = cvv.
 * Returns -1 when no candidate matches (drives screenshot fail-closed).
 */
export function pickOppwaIframeIndexForField(
  iframes: { src: string }[],
  field: "card_number" | "cvv" | "expiry",
): number {
  // Indices of iframes that are OPPWA PCI iframes, in DOM order.
  const oppwaIdx: number[] = [];
  for (let i = 0; i < iframes.length; i++) {
    try {
      const u = new URL(iframes[i].src);
      if (u.hostname.endsWith("oppwa.com") && u.pathname === "/v1/pciIframe.html") {
        oppwaIdx.push(i);
      }
    } catch {
      /* skip non-URL src */
    }
  }
  if (oppwaIdx.length === 0) return -1;

  // 1. Primary: name query param. Expiry accepts the combined (card.expiry) or the
  //    month-first split (card.expiryMonth) iframe.
  const wantNames =
    field === "card_number" ? ["card.number"] :
    field === "cvv" ? ["card.cvv"] :
    ["card.expiry", "card.expiryMonth"];
  for (const i of oppwaIdx) {
    try {
      const n = new URL(iframes[i].src).searchParams.get("name");
      if (n && wantNames.includes(n)) return i;
    } catch {
      /* skip */
    }
  }

  // 2. Positional fallback: first OPPWA iframe = card_number, second = cvv, third = expiry.
  if (field === "card_number") return oppwaIdx[0];
  if (field === "cvv") return oppwaIdx.length > 1 ? oppwaIdx[1] : -1;
  if (field === "expiry") return oppwaIdx.length > 2 ? oppwaIdx[2] : -1;
  return -1;
}

// ─── CDP iframe fill ──────────────────────────────────────────────────────────

/**
 * Attach to an OPPWA PCI iframe target via CDP and fill the card field.
 *
 * Security invariants:
 * - resolvedValue is embedded only inside the IIFE expression string; it is
 *   never returned, logged, or included in any error message.
 * - raw_value_revealed_to_agent: false is a TypeScript literal in every branch.
 * - Value is masked after fill (Object.defineProperty returns '' on .value read).
 * - Returns status="not_applicable" when no OPPWA iframe targets are found so
 *   the caller can fall through to the existing parent-page fill path.
 */
export async function fillOppwaIframeField(args: {
  browserWsUrl: string;
  field_kind: "card_number" | "cvv" | "expiry";
  resolvedValue: string;
  timeout?: number;
}): Promise<PaymentIframeFillResult> {
  const { browserWsUrl, field_kind, resolvedValue, timeout = 10_000 } = args;

  // Build fill expression — resolvedValue embedded here, never returned.
  // Masking is always applied since card_number, cvv, and expiry are all sensitive.
  // See module-level TODO for v2 Input.dispatchKeyEvent alternative.
  const fillExpr = `(function() {
  var el = document.querySelector('input[type="tel"]')
         || document.querySelector('input[type="text"]')
         || document.querySelector('input');
  if (!el) return { ok: false, reason: 'OPPWA_INPUT_NOT_FOUND' };
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(resolvedValue)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  Object.defineProperty(el, 'value', {
    get: function() { return ''; },
    set: function(v) { setter.call(el, v); },
    configurable: true,
  });
  el.setAttribute('data-antigen-filled', 'true');
  return { ok: true };
})()`;

  return new Promise<PaymentIframeFillResult>((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(browserWsUrl);
    } catch (err) {
      resolve({
        status: "failed",
        error_code: OPPWA_ERRORS.TYPING_FAILED,
        raw_value_revealed_to_agent: false,
        purchase_not_authorized: true,
      });
      return;
    }

    let msgId = 1;
    let phase: "get_targets" | "attach" | "fill" = "get_targets";
    let sessionId: string | null = null;

    const timer = setTimeout(() => {
      ws.terminate();
      resolve({
        status: "failed",
        error_code: OPPWA_ERRORS.TYPING_FAILED,
        raw_value_revealed_to_agent: false,
        purchase_not_authorized: true,
      });
    }, timeout);

    // send at browser level (no sessionId) or page/frame level (with sessionId).
    // For Target.getTargets and Target.attachToTarget: call with no sid argument.
    const send = (method: string, params: Record<string, unknown> = {}, sid?: string) => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    ws.on("open", () => {
      // Browser-level command — no sessionId
      send("Target.getTargets");
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const result = msg.result as Record<string, unknown> | undefined;

      // ── Phase: get_targets ────────────────────────────────────────────────
      if (phase === "get_targets") {
        const targetInfos = result?.targetInfos as CdpTargetInfo[] | undefined;
        if (!Array.isArray(targetInfos)) return; // wait for the right message

        // Filter to OPPWA PCI iframe targets only (strict allowlist)
        const oppwaTargets = targetInfos.filter((t) => {
          if (t.type !== "iframe") return false;
          try {
            const u = new URL(t.url);
            return (
              u.hostname.endsWith("oppwa.com") &&
              u.pathname === "/v1/pciIframe.html"
            );
          } catch {
            return false;
          }
        });

        if (oppwaTargets.length === 0) {
          // No OPPWA iframes present — caller falls through to parent-page fill
          clearTimeout(timer);
          ws.close();
          resolve({ status: "not_applicable" });
          return;
        }

        const target = pickOppwaTarget(oppwaTargets, field_kind);
        if (!target) {
          clearTimeout(timer);
          ws.close();
          resolve({ status: "not_applicable" });
          return;
        }

        phase = "attach";
        // Browser-level — no sessionId
        send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        return;
      }

      // ── Phase: attach ─────────────────────────────────────────────────────
      if (phase === "attach") {
        if (result?.sessionId && !sessionId) {
          sessionId = result.sessionId as string;
          phase = "fill";
          send("Runtime.evaluate", { expression: fillExpr, returnByValue: true }, sessionId);
          return;
        }
        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          resolve({
            status: "failed",
            error_code: OPPWA_ERRORS.FRAME_ATTACH_FAILED,
            iframe_provider: "oppwa",
            raw_value_revealed_to_agent: false,
            purchase_not_authorized: true,
          });
          return;
        }
      }

      // ── Phase: fill ───────────────────────────────────────────────────────
      if (phase === "fill" && sessionId) {
        const evalResult = result?.result as Record<string, unknown> | undefined;
        if (evalResult?.type === "object" && evalResult?.value !== undefined) {
          const val = evalResult.value as { ok?: boolean; reason?: string };
          clearTimeout(timer);
          ws.close();
          if (val?.ok) {
            resolve({
              status: "filled",
              iframe_provider: "oppwa",
              iframe_origin: "https://eu-prod.oppwa.com",
              iframe_path: "/v1/pciIframe.html",
              raw_value_revealed_to_agent: false,
              purchase_not_authorized: true,
            });
          } else if (val?.reason === "OPPWA_INPUT_NOT_FOUND") {
            resolve({
              status: "failed",
              error_code: OPPWA_ERRORS.INPUT_NOT_FOUND,
              iframe_provider: "oppwa",
              raw_value_revealed_to_agent: false,
              purchase_not_authorized: true,
            });
          } else {
            resolve({
              status: "failed",
              error_code: OPPWA_ERRORS.TYPING_FAILED,
              iframe_provider: "oppwa",
              raw_value_revealed_to_agent: false,
              purchase_not_authorized: true,
            });
          }
          return;
        }

        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          resolve({
            status: "failed",
            error_code: OPPWA_ERRORS.TYPING_FAILED,
            iframe_provider: "oppwa",
            raw_value_revealed_to_agent: false,
            purchase_not_authorized: true,
          });
          return;
        }
      }
    });

    ws.on("error", () => {
      clearTimeout(timer);
      resolve({
        status: "failed",
        error_code: OPPWA_ERRORS.TYPING_FAILED,
        raw_value_revealed_to_agent: false,
        purchase_not_authorized: true,
      });
    });
  });
}
