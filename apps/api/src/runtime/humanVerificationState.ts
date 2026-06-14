// ─── Human Presence Relay v1 — runtime session state ─────────────────────────
//
// Tracks, per browser session, whether the LAST antigen_snapshot detected a
// blocking human-verification surface and which HumanVerificationRequest it is
// linked to. The browser-click/type/set-value/scroll endpoints consult this
// (before any ref resolution) to fail fast with HUMAN_VERIFICATION_REQUIRED
// instead of producing stale-ref loops or attempting logical recovery behind
// the challenge.
//
// Memory-only by design: the marker is re-derived from every fresh snapshot,
// and the linked request expires quickly (and on API restart) anyway.

export interface ActiveHumanVerificationMarker {
  request_id: string;
  domain: string;
  detected_at: string;
}

/** Human Presence Relay flag — strictly opt-in; default off is byte-identical. */
export function isHumanVerificationEnabled(): boolean {
  return process.env.ANTIGEN_HUMAN_VERIFICATION === "true";
}

/**
 * HV debug telemetry flag — dev-only. Gates the safe `human_verification_debug`
 * object on antigen_snapshot responses. Effective ONLY when
 * ANTIGEN_HUMAN_VERIFICATION is also true; never emits raw page content. Purely
 * diagnostic — it does not influence any detection or response classification.
 */
export function isHvDebugEnabled(): boolean {
  return process.env.ANTIGEN_HV_DEBUG === "true";
}

const activeHumanVerification = new Map<string, ActiveHumanVerificationMarker>();

export function setActiveHumanVerification(
  browserSessionId: string,
  marker: ActiveHumanVerificationMarker,
): void {
  activeHumanVerification.set(browserSessionId, marker);
}

export function getActiveHumanVerification(
  browserSessionId: string,
): ActiveHumanVerificationMarker | undefined {
  return activeHumanVerification.get(browserSessionId);
}

export function clearActiveHumanVerification(browserSessionId: string): void {
  activeHumanVerification.delete(browserSessionId);
}

export function clearAllActiveHumanVerificationForTests(): void {
  activeHumanVerification.clear();
}
