import WebSocket from "ws";
import type { ProfileFieldFillRequest, ProfileFieldFillEntry, ProfileFieldKind } from "@aegis/types";
import {
  makePointerRuntimeState,
  clickBoxWithPointer,
  type PointerRuntimeState,
  type ElementBox,
} from "./nativePointerRuntime.js";
import { pickBestPageTarget } from "./cdpTargetSelection.js";

// US state abbreviation → full name (uppercase keys)
const US_STATE_MAP: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};
// Full name → abbreviation (lowercase keys for case-insensitive lookup)
const US_STATE_REV_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_MAP).map(([abbr, name]) => [name.toLowerCase(), abbr]),
);

// ISO 2-letter code → full name (uppercase keys)
const COUNTRY_MAP: Record<string, string> = {
  US: "United States", CA: "Canada", GB: "United Kingdom",
  AU: "Australia", DE: "Germany", FR: "France", NL: "Netherlands",
  SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland",
  JP: "Japan", CN: "China", IN: "India", BR: "Brazil", MX: "Mexico",
};
// Full name → code (lowercase keys)
const COUNTRY_REV_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_MAP).map(([code, name]) => [name.toLowerCase(), code]),
);

/**
 * Find the best matching <select> option value for a raw profile value.
 * Tries exact case-insensitive match first, then state/country abbreviation mapping.
 * Returns the option's `.value` attribute on match, or null if no match found.
 * Exported for unit testing — the same logic is also embedded in the CDP fill expression.
 */
export function findBestSelectOption(
  options: Array<{ value: string; text: string }>,
  rawValue: string,
): string | null {
  const lower = rawValue.toLowerCase().trim();

  const exact = options.find(
    (o) => o.value.toLowerCase() === lower || o.text.toLowerCase().trim() === lower,
  );
  if (exact) return exact.value;

  const upper = rawValue.toUpperCase();
  const alt =
    US_STATE_MAP[upper] ??
    US_STATE_REV_MAP[lower] ??
    COUNTRY_MAP[upper] ??
    COUNTRY_REV_MAP[lower];

  if (alt) {
    const altLower = alt.toLowerCase().trim();
    const altMatch = options.find(
      (o) => o.value.toLowerCase() === altLower || o.text.toLowerCase().trim() === altLower,
    );
    if (altMatch) return altMatch.value;
  }

  return null;
}

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
export function maskProfileValue(kind: ProfileFieldKind, rawValue: string): string {
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
    case "shipping_address_line1":
      return "Street address filled";
    case "shipping_address_line2":
      return rawValue.length > 0 ? "Address line 2 filled" : "";
    case "postal_code":
      return `${rawValue[0]}***`;
    case "city":
    case "region":
    case "country":
      return rawValue.length > 0 ? `${rawValue[0]}***` : "***";
    default:
      return rawValue.length > 0 ? `${rawValue[0]}***` : "***";
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
      return lbl.querySelector('input, select');
    })()`;
  }
  if (placeholder) {
    return `document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`;
  }
  return `document.querySelector('input[type="text"],input[type="email"],input[type="tel"],input:not([type])')`;
}

// In-memory pointer state per fill session — tracks current pointer position across fields.
// Keyed by browser_session_id when available, then fill_request_id, then "default".
const pointerStateByFill = new Map<string, PointerRuntimeState>();

function getOrCreateFillPointerState(key: string): PointerRuntimeState {
  let state = pointerStateByFill.get(key);
  if (!state) {
    state = makePointerRuntimeState();
    pointerStateByFill.set(key, state);
  }
  return state;
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
  preferredTargetUrl?: string,
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

    // Select the active page target. Priority: exact URL > same origin > domain > non-blank > last.
    const { target: pageTarget, candidates } = pickBestPageTarget(
      targets as Array<{ id: string; url: string; type: string }>,
      { domain: fillRequest.domain, preferredUrl: preferredTargetUrl },
    );

    if (!pageTarget) {
      const urls = candidates.map((c) => c.url).join(", ") || "(none)";
      return fillRequest.requested_fields.map((f) => ({
        key: f.key,
        field_filled: false,
        status: "failed" as const,
        raw_profile_value_revealed_to_agent: false as const,
        error: `No page targets found via CDP. Active page target binding failed. Candidates: [${urls}]`,
      }));
    }

    return await new Promise<ProfileFieldFillEntry[]>((resolve) => {
      const entries: ProfileFieldFillEntry[] = [];
      const fields = fillRequest.requested_fields;
      let fieldIdx = 0;
      let msgId = 1;
      let sessionId: string | null = null;
      let phase: "attach" | "iframe_check" | "input_box_lookup" | "input_pointer" | "select_fill" | "input_focus" | "input_insert" | "input_blur" | "input_setter_fallback" = "attach";

      // Track CDP command IDs for unambiguous response routing.
      let attachMsgId: number | null = null;
      let insertMsgId: number | null = null;

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

      // Dev-only: ANTIGEN_BROWSER_SLOW_MO_MS adds extra delay per pointer event for visual verification.
      const slowMoMs = parseInt(process.env.ANTIGEN_BROWSER_SLOW_MO_MS ?? "0", 10) || 0;
      const debugOverlay = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true";
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

      const recordFilled = (rawValue: string) => {
        const field = fields[fieldIdx];
        entries.push({
          key: field.key,
          field_filled: true,
          status: "filled",
          masked_summary: maskProfileValue(field.key, rawValue),
          raw_profile_value_revealed_to_agent: false,
        });
        fieldIdx++;
        advanceField();
      };

      const recordFailed = (error: string) => {
        const field = fields[fieldIdx];
        entries.push({
          key: field.key,
          field_filled: false,
          status: "failed",
          raw_profile_value_revealed_to_agent: false,
          error,
        });
        fieldIdx++;
        advanceField();
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
        // Include tagName in result so the handler can branch on SELECT vs INPUT.
        const iframeCheck = `(function() {
          var el = ${selectorExpr};
          if (!el) return { ok: false, reason: 'element not found' };
          var node = el;
          while (node.parentNode) {
            if (node.tagName === 'IFRAME') return { ok: false, reason: 'IFRAME_NOT_SUPPORTED' };
            node = node.parentNode;
          }
          return { ok: true, tagName: el.tagName };
        })()`;
        phase = "iframe_check";
        send("Runtime.evaluate", { expression: iframeCheck, returnByValue: true }, sessionId!);
      };

      ws.on("open", () => {
        attachMsgId = send("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
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

        // Attach response — identified by tracked message ID.
        if (id === attachMsgId && result?.sessionId && !sessionId) {
          sessionId = result.sessionId as string;
          advanceField();
          return;
        }

        // Input.insertText response — result is empty {}, not a Runtime.evaluate shape.
        if (id === insertMsgId) {
          insertMsgId = null;
          const field = fields[fieldIdx];
          const selectorExpr = buildSelectorExpr(field.selector_hint, field.label, field.placeholder);
          if (msg.error) {
            // Input.insertText not supported — fall back to setter fill (value embedded in JS).
            const resolvedValue = resolvedValues.get(field.key) ?? "";
            const setterFallbackExpr = `(function() {
              var el = ${selectorExpr};
              if (!el) return { ok: false, reason: 'element not found' };
              var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(el, ${JSON.stringify(resolvedValue)});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
              el.setAttribute('data-antigen-filled', 'true');
              return { ok: true };
            })()`;
            phase = "input_setter_fallback";
            send("Runtime.evaluate", { expression: setterFallbackExpr, returnByValue: true }, sessionId!);
          } else {
            // Insert succeeded — dispatch change/blur and mark filled.
            const blurExpr = `(function() {
              var el = ${selectorExpr};
              if (!el) return { ok: false, reason: 'element not found' };
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
              el.setAttribute('data-antigen-filled', 'true');
              return { ok: true };
            })()`;
            phase = "input_blur";
            send("Runtime.evaluate", { expression: blurExpr, returnByValue: true }, sessionId!);
          }
          return;
        }

        const evalResult = result?.result as Record<string, unknown> | undefined;
        if (evalResult?.type === "object" && evalResult?.value !== undefined && sessionId) {
          const val = evalResult.value as { ok?: boolean; reason?: string; tagName?: string };
          const field = fields[fieldIdx];

          if (phase === "iframe_check") {
            if (!val?.ok) {
              recordFailed(`CDP iframe check: ${val?.reason ?? "unknown"}`);
              return;
            }
            const selectorExpr = buildSelectorExpr(field.selector_hint, field.label, field.placeholder);
            const resolvedValue = resolvedValues.get(field.key) ?? "";

            if (val.tagName === "SELECT") {
              // SELECT element — use existing setter fill (no realistic typing needed for dropdowns).
              // No DOM value masking — leave field value intact so checkout pages can read and submit it.
              const selectFillExpr = `(function() {
                var el = ${selectorExpr};
                if (!el) return { ok: false, reason: 'element not found' };
                var rawVal = ${JSON.stringify(resolvedValue)};
                var stateMap = ${JSON.stringify(US_STATE_MAP)};
                var stateRevMap = ${JSON.stringify(US_STATE_REV_MAP)};
                var countryMap = ${JSON.stringify(COUNTRY_MAP)};
                var countryRevMap = ${JSON.stringify(COUNTRY_REV_MAP)};
                var lower = rawVal.toLowerCase().trim();
                var upper = rawVal.toUpperCase();
                var opts = Array.from(el.options).map(function(o) { return { value: o.value, text: o.text }; });
                var match = opts.find(function(o) {
                  return o.value.toLowerCase() === lower || o.text.toLowerCase().trim() === lower;
                });
                if (!match) {
                  var alt = stateMap[upper] || stateRevMap[lower] || countryMap[upper] || countryRevMap[lower];
                  if (alt) {
                    var altLow = alt.toLowerCase().trim();
                    match = opts.find(function(o) {
                      return o.value.toLowerCase() === altLow || o.text.toLowerCase().trim() === altLow;
                    });
                  }
                }
                if (!match) return { ok: false, reason: 'select_option_not_found' };
                var sel = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
                if (sel && sel.set) { sel.set.call(el, match.value); } else { el.value = match.value; }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                el.setAttribute('data-antigen-filled', 'true');
                return { ok: true };
              })()`;
              phase = "select_fill";
              send("Runtime.evaluate", { expression: selectFillExpr, returnByValue: true }, sessionId);
            } else {
              // INPUT element — get element box for native pointer focus before typing.
              // No secret in this expression.
              const boxLookupExpr = `(function() {
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
              phase = "input_box_lookup";
              send("Runtime.evaluate", { expression: boxLookupExpr, returnByValue: true }, sessionId);
            }
            return;
          }

          if (phase === "input_box_lookup") {
            const boxVal = val as {
              ok?: boolean;
              box?: ElementBox;
              viewport?: { width: number; height: number };
            } | undefined;

            const selectorExpr = buildSelectorExpr(field.selector_hint, field.label, field.placeholder);
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

            const stateKey = fillRequest.browser_session_id ?? fillRequest.fill_request_id ?? "default";
            const doPointerThenFocus = async () => {
              if (boxVal?.ok && boxVal?.box) {
                try {
                  const pointerSend = (method: string, params: Record<string, unknown>) => {
                    send(method, params, sessionId!);
                  };
                  const state = getOrCreateFillPointerState(stateKey);
                  if (boxVal.viewport) {
                    state.viewport_width = boxVal.viewport.width;
                    state.viewport_height = boxVal.viewport.height;
                  }
                  phase = "input_pointer"; // guard against stray CDP errors during pointer dispatch
                  await clickBoxWithPointer(state, boxVal.box, pointerSend, sleep, { debugOverlay });
                } catch {
                  // Native pointer focus failed — proceed to fill without it.
                }
              }
              phase = "input_focus";
              send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
            };

            doPointerThenFocus().catch(() => {
              phase = "input_focus";
              send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
            });
            return;
          }

          if (phase === "input_focus") {
            if (!val?.ok) {
              recordFailed(`CDP evaluate (focus): ${val?.reason ?? "element not found"}`);
              return;
            }
            // Focus succeeded — type via Input.insertText (value in CDP params, not JS expression).
            const resolvedValue = resolvedValues.get(field.key) ?? "";
            phase = "input_insert";
            insertMsgId = send("Input.insertText", { text: resolvedValue }, sessionId!);
            return;
          }

          if (phase === "input_blur" || phase === "input_setter_fallback") {
            const rawValue = resolvedValues.get(field.key) ?? "";
            if (val?.ok) {
              recordFilled(rawValue);
            } else {
              recordFailed(`CDP evaluate: ${val?.reason ?? "unknown"}`);
            }
            return;
          }

          if (phase === "select_fill") {
            const rawValue = resolvedValues.get(field.key) ?? "";
            if (val?.ok) {
              recordFilled(rawValue);
            } else {
              recordFailed(`CDP evaluate: ${val?.reason ?? "unknown"}`);
            }
            return;
          }
        }

        if (msg.error) {
          // Ignore CDP errors during async pointer dispatch — these are from fire-and-forget
          // Input.dispatchMouseEvent calls and must not fail the field fill.
          if (phase === "input_pointer") return;
          const field = fields[fieldIdx];
          if (field) {
            recordFailed(`CDP error: ${JSON.stringify(msg.error)}`);
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
