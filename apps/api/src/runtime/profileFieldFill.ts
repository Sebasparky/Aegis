import WebSocket from "ws";
import type { ProfileFieldFillRequest, ProfileFieldFillEntry, ProfileFieldKind } from "@aegis/types";

// Reuse same dangerous-selector rules as paymentCardFill.ts — profile fill targets input fields only.
const DANGEROUS_SELECTOR_PATTERNS: RegExp[] = [
  /\bbutton\b/i,
  /\bsubmit\b/i,
  /\[type\s*=\s*["']?submit/i,
  /input\[type\s*=\s*["']?button/i,
  /\bform\b/i,
  /\ba\[href\b/i,
  /\[role\s*=\s*["']?button/i,
];

export function validateProfileFillSelector(selector: string): { valid: boolean; reason?: string } {
  for (const pattern of DANGEROUS_SELECTOR_PATTERNS) {
    if (pattern.test(selector)) {
      return {
        valid: false,
        reason:
          `Selector "${selector}" appears to target a button, submit control, form, or anchor — ` +
          `which are prohibited for profile field fill. Provide a selector that targets only the input field.`,
      };
    }
  }
  return { valid: true };
}

// Generate a masked summary for display purposes only — raw value is consumed by CDP and never returned.
// DOM value is left intact (not masked) so checkout pages can read and submit it normally.
function maskProfileValue(kind: ProfileFieldKind, rawValue: string): string {
  if (!rawValue) return "***";
  switch (kind) {
    case "first_name":
    case "last_name":
      return rawValue[0] + "***";
    case "email": {
      const atIdx = rawValue.indexOf("@");
      if (atIdx > 0) {
        const user = rawValue.slice(0, atIdx);
        const domain = rawValue.slice(atIdx + 1);
        const dotIdx = domain.lastIndexOf(".");
        const tld = dotIdx >= 0 ? domain.slice(dotIdx) : "";
        return `${user[0]}***@***.${tld.slice(1) || "***"}`;
      }
      return `${rawValue[0]}***`;
    }
    case "phone":
      return `***-***-${rawValue.slice(-4)}`;
    case "shipping_address_line1": {
      const parts = rawValue.split(" ");
      if (parts.length > 1) return `*** ${parts.slice(1).join(" ")}`;
      return `${rawValue[0]}***`;
    }
    case "shipping_address_line2":
      return rawValue.length > 0 ? `${rawValue[0]}***` : "";
    case "postal_code":
      return `${rawValue[0]}***`;
    case "city":
    case "region":
    case "country":
      return rawValue;
    default:
      return `${rawValue[0]}***`;
  }
}

// Build the selector expression for a single field, using the same priority as paymentCardFill.ts.
function buildSelectorExpr(selector_hint?: string, label?: string, placeholder?: string): string {
  if (selector_hint) {
    return `document.querySelector(${JSON.stringify(selector_hint)})`;
  }
  if (label) {
    return `(function() {
      var labels = Array.from(document.querySelectorAll('label'));
      var lbl = labels.find(function(l) { return l.textContent && l.textContent.trim().toLowerCase().indexOf(${JSON.stringify(label.toLowerCase())}) !== -1; });
      if (!lbl) return null;
      if (lbl.htmlFor) return document.getElementById(lbl.htmlFor);
      return lbl.querySelector('input');
    })()`;
  }
  if (placeholder) {
    return `document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`;
  }
  return `document.querySelector('input[type="text"],input[type="email"],input[type="tel"],input:not([type])')`;
}

/**
 * Fill multiple profile fields in the agent's active browser via a single CDP WebSocket session.
 *
 * Security constraints:
 * - resolvedValues flows: KMS → caller → this function → CDP → browser field. Never logged, returned, or persisted.
 * - DOM value is NOT masked after fill — checkout pages need to read actual values for validation and submission.
 *   Masking is applied only to the masked_summary returned to the agent.
 * - If the target element is inside an iframe, the field records status "failed" with IFRAME_NOT_SUPPORTED.
 * - All Class 2 fields return masked_summary via maskProfileValue(), never the raw value.
 */
export async function executeProfileFieldFillViaCDP(
  fillRequest: ProfileFieldFillRequest,
  resolvedValues: Map<ProfileFieldKind, string>,
  cdpUrlOverride?: string,
): Promise<ProfileFieldFillEntry[]> {
  const cdpBase = cdpUrlOverride ?? process.env.AEGIS_PLAYWRIGHT_CDP_URL;
  if (!cdpBase) {
    return fillRequest.requested_fields.map((f) => ({
      key: f.key,
      field_filled: false,
      status: "failed" as const,
      raw_profile_value_revealed_to_agent: false as const,
      error:
        "AEGIS_PLAYWRIGHT_CDP_URL is not configured. " +
        "Set this to the Chrome remote debugging base URL (e.g. http://localhost:9222).",
    }));
  }

  try {
    const [versionData, targets] = await Promise.all([
      fetch(`${cdpBase}/json/version`).then((r) => r.json()),
      fetch(`${cdpBase}/json/list`).then((r) => r.json()),
    ]);

    const browserWsUrl: string = (versionData as Record<string, string>).webSocketDebuggerUrl;
    if (!browserWsUrl) {
      return fillRequest.requested_fields.map((f) => ({
        key: f.key,
        field_filled: false,
        status: "failed" as const,
        raw_profile_value_revealed_to_agent: false as const,
        error: "No browser WebSocket debugger URL returned by CDP.",
      }));
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
      return fillRequest.requested_fields.map((f) => ({
        key: f.key,
        field_filled: false,
        status: "failed" as const,
        raw_profile_value_revealed_to_agent: false as const,
        error: "No page targets found via CDP.",
      }));
    }

    return await new Promise<ProfileFieldFillEntry[]>((resolve) => {
      const entries: ProfileFieldFillEntry[] = [];
      const fields = fillRequest.requested_fields;
      let fieldIdx = 0;
      let msgId = 1;
      let sessionId: string | null = null;
      let phase: "attach" | "iframe_check" | "fill" = "attach";

      const timer = setTimeout(() => {
        ws.terminate();
        // Return entries collected so far, mark remaining as failed
        for (let i = fieldIdx; i < fields.length; i++) {
          entries.push({
            key: fields[i].key,
            field_filled: false,
            status: "failed",
            raw_profile_value_revealed_to_agent: false,
            error: "CDP fill timed out after 30 seconds.",
          });
        }
        resolve(entries);
      }, 30_000);

      const ws = new WebSocket(browserWsUrl);

      const send = (method: string, params: Record<string, unknown> = {}, sid?: string) => {
        const id = msgId++;
        const msg: Record<string, unknown> = { id, method, params };
        if (sid) msg.sessionId = sid;
        ws.send(JSON.stringify(msg));
        return id;
      };

      const advanceField = () => {
        if (fieldIdx >= fields.length) {
          clearTimeout(timer);
          ws.close();
          resolve(entries);
          return;
        }
        const field = fields[fieldIdx];
        const selectorExpr = buildSelectorExpr(field.selector_hint, field.label, field.placeholder);
        const iframeCheck = `(function() {
          var el = ${selectorExpr};
          if (!el) return { ok: false, reason: 'element not found' };
          var node = el;
          while (node.parentNode) {
            if (node.tagName === 'IFRAME') return { ok: false, reason: 'IFRAME_NOT_SUPPORTED' };
            node = node.parentNode;
          }
          return { ok: true };
        })()`;
        phase = "iframe_check";
        send("Runtime.evaluate", { expression: iframeCheck, returnByValue: true }, sessionId!);
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
          advanceField();
          return;
        }

        const evalResult = result?.result as Record<string, unknown> | undefined;
        if (evalResult?.type === "object" && evalResult?.value !== undefined && sessionId) {
          const val = evalResult.value as { ok?: boolean; reason?: string };
          const field = fields[fieldIdx];

          if (phase === "iframe_check") {
            if (!val?.ok) {
              entries.push({
                key: field.key,
                field_filled: false,
                status: "failed",
                raw_profile_value_revealed_to_agent: false,
                error: `CDP iframe check: ${val?.reason ?? "unknown"}`,
              });
              fieldIdx++;
              advanceField();
              return;
            }
            // Iframe check passed — fill the field
            const resolvedValue = resolvedValues.get(field.key) ?? "";
            const selectorExpr = buildSelectorExpr(field.selector_hint, field.label, field.placeholder);
            // No DOM value masking — leave field value intact so checkout pages can read and submit it.
            const fillExpr = `(function() {
              var el = ${selectorExpr};
              if (!el) return { ok: false, reason: 'element not found' };
              var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(el, ${JSON.stringify(resolvedValue)});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.setAttribute('data-antigen-filled', 'true');
              return { ok: true };
            })()`;
            phase = "fill";
            send("Runtime.evaluate", { expression: fillExpr, returnByValue: true }, sessionId);
            return;
          }

          if (phase === "fill") {
            const field = fields[fieldIdx];
            const rawValue = resolvedValues.get(field.key) ?? "";
            if (val?.ok) {
              entries.push({
                key: field.key,
                field_filled: true,
                status: "filled",
                masked_summary: maskProfileValue(field.key, rawValue),
                raw_profile_value_revealed_to_agent: false,
              });
            } else {
              entries.push({
                key: field.key,
                field_filled: false,
                status: "failed",
                raw_profile_value_revealed_to_agent: false,
                error: `CDP evaluate: ${val?.reason ?? "unknown"}`,
              });
            }
            fieldIdx++;
            advanceField();
            return;
          }
        }

        if (msg.error) {
          const field = fields[fieldIdx];
          if (field) {
            entries.push({
              key: field.key,
              field_filled: false,
              status: "failed",
              raw_profile_value_revealed_to_agent: false,
              error: `CDP error: ${JSON.stringify(msg.error)}`,
            });
            fieldIdx++;
            advanceField();
          }
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        for (let i = fieldIdx; i < fields.length; i++) {
          entries.push({
            key: fields[i].key,
            field_filled: false,
            status: "failed",
            raw_profile_value_revealed_to_agent: false,
            error: `WebSocket error: ${(err as Error).message}`,
          });
        }
        resolve(entries);
      });
    });
  } catch (err: unknown) {
    return fillRequest.requested_fields.map((f) => ({
      key: f.key,
      field_filled: false,
      status: "failed" as const,
      raw_profile_value_revealed_to_agent: false as const,
      error: err instanceof Error ? err.message : "CDP profile fill failed",
    }));
  }
}
