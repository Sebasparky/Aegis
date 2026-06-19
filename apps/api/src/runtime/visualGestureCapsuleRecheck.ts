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
import { buildAmbiguousVisualObstructionExpr } from "./antigenSnapshotRuntime.js";
import { logHvDebug } from "./humanVerificationState.js";

/**
 * Injectable presence probe seam. Production default lives below; tests inject a
 * fake. The probe receives only connection coordinates and returns a coarse
 * present/absent/unknown verdict — NEVER coordinates, geometry, tokens, or any
 * provider/iframe internals.
 */
export interface VisualGestureCapsulePresenceProbe {
  (args: { cdpUrl: string; targetId?: string; expectedUrl?: string }): Promise<
    | {
        ok: true;
        presence: "present" | "absent" | "unknown";
        reason?: string;
        /**
         * Coarse per-detector booleans for SAFE debug telemetry only (consumed by
         * logHvDebug, never placed in the HTTP response). Geometry/text internals
         * are reduced to a single boolean inside the probe adapter — no rects,
         * coordinates, page text, or provider data ever ride along.
         */
        hv_present?: boolean;
        geo_present?: boolean;
      }
    | { ok: false; reason?: string }
  >;
}

/**
 * Pure union decision: combine the structural-HV verdict and the geometry-
 * obstruction verdict into a single presence classification. Either detector
 * reporting `present` wins (fail-closed — the wall is still up). `absent` only
 * when BOTH parsed and BOTH report absent. When neither verdict is a usable
 * boolean the result is `unknown` (no clear, no attempt burn).
 *
 * This is the fix for the false-clear bug: a capsule minted by the geometry
 * detector (large centered overlay / scrim / pointer interceptor) must NOT be
 * cleared just because the structural/text HV probe — which never matched this
 * opaque wall — reports absent. Exported for direct unit testing.
 */
export function combineRecheckPresence(
  hvPresent: boolean | undefined,
  geoPresent: boolean | undefined,
): "present" | "absent" | "unknown" {
  if (hvPresent === true || geoPresent === true) return "present";
  if (hvPresent === false || geoPresent === false) return "absent";
  return "unknown";
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
 * Reduce the geometry-obstruction probe's STATIC signals to a single boolean.
 * `repeated_stale` is deliberately NOT consulted: it is a per-action runtime
 * signal (corroboration at MINT time), not a page-state signal. At recheck the
 * only question is "is an obstruction still painted on the page", so any one
 * static obstruction signal counts as present. Returns undefined when the probe
 * shape is unusable (so the union can fall back to the HV verdict / unknown).
 */
export function geometryObstructionPresent(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const keys = [
    "large_centered_overlay_seen",
    "viewport_scrim_seen",
    "pointer_interceptor_seen",
    "denial_text_seen",
    "visible_inaccessible_iframe_seen",
  ] as const;
  // Require at least one recognizable boolean field before trusting the verdict.
  if (!keys.some((k) => typeof v[k] === "boolean")) return undefined;
  return keys.some((k) => v[k] === true);
}

/**
 * Default production probe — a thin, fail-safe adapter that unions the existing
 * page-level structural-HV detection with the geometry-obstruction detection on
 * a SINGLE opened CDP client. Reuses openCdpPageClient +
 * buildHumanVerificationProbeExpr (the same pair the Human Presence Relay probe
 * uses) AND buildAmbiguousVisualObstructionExpr (the geometry detector that mints
 * ambiguous-block capsules). Both IIFEs reduce geometry to booleans inside the
 * page, so control_box / rects / vw/vh / page text never escape into the result.
 *
 * Mapping (see combineRecheckPresence):
 *   either detector present → "present"  (fail-closed; wall still up)
 *   both parsed + both absent → "absent" (genuinely unblocked → clear)
 *   neither usable          → "unknown"  (no clear, no attempt burn)
 *   connect/eval error      → { ok: false } (→ probe_failed; no attempt burn)
 */
const defaultPresenceProbe: VisualGestureCapsulePresenceProbe = async ({ cdpUrl, expectedUrl }) => {
  const opened = await openCdpPageClient({ cdpUrl, preferredUrl: expectedUrl });
  if (!opened.ok) return { ok: false, reason: "probe_connect_failed" };
  try {
    const hvRaw = await opened.client.evaluate(buildHumanVerificationProbeExpr());
    const hvPresentVal = (hvRaw as { present?: unknown } | null | undefined)?.present;
    const hvPresent = typeof hvPresentVal === "boolean" ? hvPresentVal : undefined;

    // Geometry detector is best-effort: a failure here must not block a valid HV
    // verdict, so a throw degrades the geometry side to undefined (not probe_failed).
    let geoPresent: boolean | undefined;
    try {
      const geoRaw = await opened.client.evaluate(buildAmbiguousVisualObstructionExpr());
      geoPresent = geometryObstructionPresent(geoRaw);
    } catch {
      geoPresent = undefined;
    }

    return {
      ok: true,
      presence: combineRecheckPresence(hvPresent, geoPresent),
      ...(hvPresent !== undefined ? { hv_present: hvPresent } : {}),
      ...(geoPresent !== undefined ? { geo_present: geoPresent } : {}),
    };
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
  if (!result.ok) {
    logHvDebug({ scope: "vgc_recheck", recheck_outcome: "probe_failed" });
    return { ok: false, reason: "probe_failed" };
  }

  // Safe debug: coarse per-detector booleans + outcome enum only. No-op when
  // ANTIGEN_HV_DEBUG is off; never carries coords, durations, or page bytes.
  logHvDebug({
    scope: "vgc_recheck",
    ...(result.hv_present !== undefined ? { probe_hv_present: result.hv_present } : {}),
    ...(result.geo_present !== undefined ? { probe_geo_present: result.geo_present } : {}),
    recheck_outcome:
      result.presence === "absent"
        ? "cleared"
        : result.presence === "present"
          ? "still_present"
          : "unknown",
  });

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
