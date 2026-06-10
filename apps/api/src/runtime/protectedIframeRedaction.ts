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

/** Drop a session's registry entry (best-effort hygiene on session close). */
export function clearProtectedIframeRedactions(browserSessionId: string): void {
  protectedIframeRedactions.delete(browserSessionId);
}
