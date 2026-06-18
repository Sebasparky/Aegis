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

// ─── Recent action no-progress marker ────────────────────────────────────────
//
// A short-lived, per-session marker set when a ref-based action (click/type/
// set-value) fails to realize progress (stale / page-changed / out-of-viewport /
// generic realization failure) AND the live HV backstop did NOT already mint a
// capsule. It lets the NEXT antigen_snapshot run the ambiguous visual-obstruction
// probe even on a high-element page — the live overlay-over-normal-page shape
// where a healthy element_count would otherwise skip the probe.
//
// Memory-only and TTL-bounded (default 30s) as a backstop; it is also cleared
// explicitly on snapshot resolution and on session teardown so it never outlives
// the situation that armed it. Never carries text, geometry, or refs.

const DEFAULT_NO_PROGRESS_TTL_MS = 30_000;

const recentActionNoProgress = new Map<string, { detected_at: number }>();

export function recordActionNoProgress(browserSessionId: string): void {
  recentActionNoProgress.set(browserSessionId, { detected_at: Date.now() });
}

export function hasRecentActionNoProgress(
  browserSessionId: string,
  withinMs: number = DEFAULT_NO_PROGRESS_TTL_MS,
): boolean {
  const marker = recentActionNoProgress.get(browserSessionId);
  if (!marker) return false;
  if (Date.now() - marker.detected_at > withinMs) {
    recentActionNoProgress.delete(browserSessionId);
    return false;
  }
  return true;
}

export function clearActionNoProgress(browserSessionId: string): void {
  recentActionNoProgress.delete(browserSessionId);
}

export function clearAllActionNoProgressForTests(): void {
  recentActionNoProgress.clear();
}
