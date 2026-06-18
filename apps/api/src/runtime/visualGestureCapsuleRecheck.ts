/**
 * Visual Gesture Capsule M1G — recheck / cleared-state handling (backend-only).
 *
 * After a user gesture is relayed (M1E/M1F) the capsule sits in `checking`. This
 * helper classifies the post-gesture page state from a SAFE, page-level presence
 * probe and resolves the capsule:
 *   - probe says the wall is gone  → markGestureCapsuleCleared  (outcome "cleared")
 *   - probe says the wall remains  → markGestureAttemptRejected (outcome "still_present")
 *   - probe cannot decide          → no state change            (outcome "unknown")
 *   - probe failed to run          → no state change            (reason "probe_failed")
 *
 * Attempts are burned ONLY on a positive "still present" classification. Probe
 * failure and `unknown` never burn an attempt and never mark cleared.
 *
 * State decisions are made strictly from safe page-level detection. The probe
 * must NOT inspect provider internals, iframe tokens, postMessage payloads, or
 * cross-origin challenge internals. The default production probe reuses the same
 * page-level HV detection the Human Presence Relay uses (openCdpPageClient +
 * buildHumanVerificationProbeExpr) and consumes ONLY the returned `present`
 * boolean — geometry (control_box / viewport dims) never leaves the adapter.
 *
 * Scope (M1G): no UI, no agent-facing tools, no agent-api wiring, no live-site
 * wiring, no provider-specific logic, no OCR/vision, no gesture dispatch, no
 * screenshot capture, no edits to humanPresenceRelay.ts. Gated behind
 * ANTIGEN_VISUAL_GESTURE_CAPSULE (default off, byte-identical when off).
 */

import {
  isVisualGestureCapsuleEnabled,
  getVisualGestureCapsule,
  isTerminalVisualGestureStatus,
  markGestureCapsuleCleared,
  markGestureAttemptRejected,
  type VisualGestureCapsuleStatus,
} from "./visualGestureCapsule.js";
import { openCdpPageClient, buildHumanVerificationProbeExpr } from "./humanPresenceRelay.js";

/**
 * Injectable presence probe seam. Production default lives below; tests inject a
 * fake. The probe receives only connection coordinates and returns a coarse
 * present/absent/unknown verdict — NEVER coordinates, geometry, tokens, or any
 * provider/iframe internals.
 */
export interface VisualGestureCapsulePresenceProbe {
  (args: { cdpUrl: string; targetId?: string; expectedUrl?: string }): Promise<
    | { ok: true; presence: "present" | "absent" | "unknown"; reason?: string }
    | { ok: false; reason?: string }
  >;
}

export type RecheckVisualGestureCapsuleResult =
  | {
      ok: true;
      capsule_id: string;
      outcome: "cleared" | "still_present" | "unknown";
      status: VisualGestureCapsuleStatus;
      attempt_count: number;
    }
  | {
      ok: false;
      reason:
        | "flag_disabled"
        | "not_found"
        | "terminal"
        | "invalid_state"
        | "probe_failed"
        | "state_update_failed";
    };

/**
 * States from which a recheck is meaningful:
 *  - checking: the normal post-relay path.
 *  - rejected_retryable: user recaptured / retried after a prior failed attempt.
 *  - awaiting_user_gesture: user/UI may recheck after manual work in the visible
 *    browser before any gesture was relayed.
 * `manual_fallback` is deliberately treated as `invalid_state` in M1G (the probe
 * is not run) — recheck-to-cleared from manual_fallback is deferred to a later
 * slice even though the store models it as non-terminal.
 */
const RECHECK_ALLOWED_STATES: ReadonlySet<VisualGestureCapsuleStatus> = new Set([
  "checking",
  "rejected_retryable",
  "awaiting_user_gesture",
]);

/**
 * Default production probe — a thin, fail-safe adapter over the existing
 * page-level HV detection. Reuses openCdpPageClient + buildHumanVerificationProbeExpr
 * (the same pair the Human Presence Relay probe uses) and consumes ONLY the
 * boolean `present`. The probe IIFE result's geometry (control_box, vw/vh) is
 * never read here, so it cannot escape into the recheck result.
 *
 * Mapping:
 *   present === true   → "present"
 *   present === false  → "absent"
 *   shape unparseable  → "unknown" (cannot safely decide; no attempt burn)
 *   connect/eval error → { ok: false } (→ probe_failed; no attempt burn)
 */
const defaultPresenceProbe: VisualGestureCapsulePresenceProbe = async ({ cdpUrl, expectedUrl }) => {
  const opened = await openCdpPageClient({ cdpUrl, preferredUrl: expectedUrl });
  if (!opened.ok) return { ok: false, reason: "probe_connect_failed" };
  try {
    const raw = await opened.client.evaluate(buildHumanVerificationProbeExpr());
    const present = (raw as { present?: unknown } | null | undefined)?.present;
    if (typeof present !== "boolean") return { ok: true, presence: "unknown" };
    return { ok: true, presence: present ? "present" : "absent" };
  } catch {
    return { ok: false, reason: "probe_eval_failed" };
  } finally {
    try {
      opened.client.close();
    } catch {
      // best-effort; never surfaced
    }
  }
};

/**
 * Recheck a capsule after a relayed gesture. Flag-off short-circuits BEFORE any
 * probe runs. See RecheckVisualGestureCapsuleResult for the outcome/error union.
 */
export async function recheckVisualGestureCapsule(args: {
  capsuleId: string;
  cdpUrl: string;
  targetId?: string;
  expectedUrl?: string;
  probe?: VisualGestureCapsulePresenceProbe;
}): Promise<RecheckVisualGestureCapsuleResult> {
  if (!isVisualGestureCapsuleEnabled()) return { ok: false, reason: "flag_disabled" };

  const capsule = getVisualGestureCapsule(args.capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };
  if (!RECHECK_ALLOWED_STATES.has(capsule.status)) return { ok: false, reason: "invalid_state" };

  const probe = args.probe ?? defaultPresenceProbe;
  const result = await probe({
    cdpUrl: args.cdpUrl,
    targetId: args.targetId,
    expectedUrl: args.expectedUrl,
  });

  // Probe could not run — leave attempts and status untouched.
  if (!result.ok) return { ok: false, reason: "probe_failed" };

  if (result.presence === "absent") {
    const cleared = markGestureCapsuleCleared(args.capsuleId);
    if (!cleared.ok || !cleared.capsule) return { ok: false, reason: "state_update_failed" };
    return {
      ok: true,
      capsule_id: args.capsuleId,
      outcome: "cleared",
      status: cleared.capsule.status,
      attempt_count: cleared.capsule.attempt_count,
    };
  }

  if (result.presence === "present") {
    const rejected = markGestureAttemptRejected(args.capsuleId);
    if (!rejected.ok || !rejected.capsule) return { ok: false, reason: "state_update_failed" };
    return {
      ok: true,
      capsule_id: args.capsuleId,
      outcome: "still_present",
      status: rejected.capsule.status,
      attempt_count: rejected.capsule.attempt_count,
    };
  }

  // presence === "unknown": cannot safely decide — no attempt burn, no clear,
  // status and attempt_count unchanged.
  return {
    ok: true,
    capsule_id: args.capsuleId,
    outcome: "unknown",
    status: capsule.status,
    attempt_count: capsule.attempt_count,
  };
}
