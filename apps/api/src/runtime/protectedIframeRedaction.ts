// ─── Protected iframe redaction registry ──────────────────────────────────────
//
// Records which protected payment-card fields Antigen filled inside a supported
// cross-origin PCI iframe (OPPWA) per browser session, so the agent-facing
// screenshot path can redact those iframe regions and FAIL CLOSED if it cannot
// locate one of them.
//
// Why a registry: the top document cannot read attributes inside a cross-origin
// iframe, so `data-antigen-masked` set on the iframe's internal <input> is
// invisible to the screenshot enumerator. This registry is the source of truth
// for "Antigen filled card_number/cvv into an OPPWA iframe in this session"; the
// screenshot path uses it to mark and redact the top-document <iframe> element's
// bounding box.
//
// Security: memory-only (like challengeCodes), never persisted, never logged.
// Stores ONLY the field-kind enum per session — never a raw value, an iframe URL,
// a coordinate, or any other sensitive metadata.

export type ProtectedIframeFieldKind = "card_number" | "cvv" | "expiry";

// keyed by browser_session_id → set of filled protected iframe field kinds
const protectedIframeRedactions = new Map<string, Set<ProtectedIframeFieldKind>>();

// ─── Top-level protected-field redaction registry ─────────────────────────────
//
// Records which protected payment-card fields Antigen filled on the TOP document
// (parent page) with visualMask, per browser session. The fill primitive tags the
// node `data-antigen-masked` at fill time, but hydrated checkouts (OPPWA widget
// re-init after PAN/CVV iframe fills) can REPLACE the node afterwards, silently
// dropping the marker — the live IKEA expiry leak. This registry is the server-side
// truth "this field kind was filled and must be visually protected"; the screenshot
// path uses it to re-locate and re-mask the live field at capture time and FAIL
// CLOSED if it cannot. Same storage rules as the iframe registry above: memory-only,
// field-kind enums only — never values, selectors, coordinates, or boxes.

/** Top-level card fields that carry visualMask after fill (everything but billing_zip). */
export type ProtectedTopLevelFieldKind =
  | "card_number"
  | "cvv"
  | "expiry_month"
  | "expiry_year"
  | "expiry_combined"
  | "cardholder_name";

// keyed by browser_session_id → set of filled protected TOP-LEVEL field kinds
const protectedTopLevelRedactions = new Map<string, Set<ProtectedTopLevelFieldKind>>();

/** Record a successful top-level (non-iframe) protected card field fill for this session. */
export function registerProtectedTopLevelRedaction(
  browserSessionId: string,
  field: ProtectedTopLevelFieldKind,
): void {
  if (!browserSessionId) return;
  let set = protectedTopLevelRedactions.get(browserSessionId);
  if (!set) {
    set = new Set<ProtectedTopLevelFieldKind>();
    protectedTopLevelRedactions.set(browserSessionId, set);
  }
  set.add(field);
}

/**
 * Top-level protected field kinds the screenshot path must verify/re-mask for this
 * session. Empty array when none. Field-kind enums only.
 */
export function getProtectedTopLevelRedactionFields(
  browserSessionId: string,
): ProtectedTopLevelFieldKind[] {
  const set = protectedTopLevelRedactions.get(browserSessionId);
  return set ? Array.from(set) : [];
}

/**
 * Record that a protected card field was filled inside a supported cross-origin
 * iframe for this session. `provider` is "oppwa" in v1 (the only supported PCI
 * iframe provider); other providers are not registered.
 */
export function registerProtectedIframeRedaction(
  browserSessionId: string,
  field: ProtectedIframeFieldKind,
  provider: "oppwa",
): void {
  if (!browserSessionId || provider !== "oppwa") return;
  let set = protectedIframeRedactions.get(browserSessionId);
  if (!set) {
    set = new Set<ProtectedIframeFieldKind>();
    protectedIframeRedactions.set(browserSessionId, set);
  }
  set.add(field);
}

/**
 * Return the protected iframe field kinds the screenshot path must redact for this
 * session. Empty array when none. Safe to expose internally — field-kind enums only.
 */
export function getProtectedIframeRedactionFields(
  browserSessionId: string,
): ProtectedIframeFieldKind[] {
  const set = protectedIframeRedactions.get(browserSessionId);
  return set ? Array.from(set) : [];
}

/** Drop a session's registry entries — iframe AND top-level (best-effort hygiene on session close). */
export function clearProtectedIframeRedactions(browserSessionId: string): void {
  protectedIframeRedactions.delete(browserSessionId);
  protectedTopLevelRedactions.delete(browserSessionId);
}
