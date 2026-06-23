/**
 * Visual Gesture Capsule M1G — recheck / cleared-state handling (backend-only).
 *
 * After a user gesture is relayed (M1E/M1F) the capsule sits in `checking`. This
 * helper classifies the post-gesture page state from a SAFE, page-level presence
 * probe and resolves the capsule:
 *   - confident healthy page       → markGestureCapsuleCleared  (outcome "cleared")
 *   - probe says the wall remains  → markGestureAttemptRejected (outcome "still_present")
 *   - weak/ambiguous, unresolved   → markGestureAttemptRejected (outcome "inconclusive")
 *   - probe cannot decide          → no state change            (outcome "unknown")
 *   - probe failed to run          → no state change            (reason "probe_failed")
 *
 * Clearing requires a CONFIDENT healthy reading from BOTH detectors (HV absent
 * AND no geometry obstruction) — a weak/ambiguous reading must NEVER clear.
 * Attempts are burned on "still_present" AND "inconclusive" (both step the guided
 * hold up). Probe failure and `unknown` never burn an attempt and never clear.
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
import {
  publishHvHandoffUpdate,
  type HvHandoffPhase,
} from "./humanVerificationHandoff.js";

/**
 * Publish a safe handoff status from the recheck (the conservative completion
 * authority). `completed` is published ONLY from the `cleared` decision here (and
 * the in-hold DOM probe) — never from the advisory model path. Best-effort.
 */
function publishRecheckHandoff(capsuleId: string, phase: HvHandoffPhase): void {
  const capsule = getVisualGestureCapsule(capsuleId);
  if (!capsule) return;
  publishHvHandoffUpdate({
    browser_session_id: capsule.browser_session_id,
    source: "visual_gesture_capsule",
    phase,
    capsule_id: capsule.capsule_id,
    human_verification_request_id: capsule.human_verification_request_id,
    domain: capsule.domain,
    presence_source: "dom_probe",
  });
}

// ─── Post-release settle tunables ────────────────────────────────────────────

/**
 * Settle before the FIRST post-release probe. A wall frequently clears a beat
 * AFTER the user releases (the site finishes its own animation / navigation),
 * so probing instantly produced a premature `still_present`. Generic Antigen
 * timing — never provider-specific.
 */
export const VGC_RECHECK_SETTLE_MS = 750;

/**
 * Extra settle before the SINGLE weak-geometry retry probe. Used ONLY when the
 * first probe is geometry-only ambiguous (a lone pointer interceptor on an
 * otherwise-interactive page). A clearly-absent or clearly-walled first probe
 * resolves immediately WITHOUT this delay (the fast path).
 */
export const VGC_RECHECK_RETRY_SETTLE_MS = 1250;

/** Real wall-clock sleep; injectable so tests resolve instantly. */
type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

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
        /**
         * Coarse STRENGTH of the geometry obstruction, used to separate a weak
         * ambiguous reading (a lone pointer interceptor) from a strong wall
         * (centered overlay / scrim / inaccessible iframe / denial / near-zero
         * interactive). Booleans only — no rects, coordinates, or page text.
         */
        geo_strength?: "none" | "weak" | "strong";
        /**
         * Per-signal geometry booleans for SAFE debug telemetry only (logHvDebug,
         * never the HTTP response). Booleans only — the page IIFE reduces all
         * geometry/text to booleans, so no rects, coordinates, page text, iframe
         * src, or provider data ever ride along. Lets `geo_strength=strong` be
         * attributed to the exact signal that produced it.
         */
        geo_signals?: {
          denial_text_seen: boolean;
          near_zero_interactive: boolean;
          visible_inaccessible_iframe_seen: boolean;
          large_centered_overlay_seen: boolean;
          viewport_scrim_seen: boolean;
          pointer_interceptor_seen: boolean;
          top_layer_dialog_seen: boolean;
        };
      }
    | { ok: false; reason?: string }
  >;
}

/**
 * Reduce the raw geometry probe object to the SAFE per-signal boolean set for debug
 * telemetry. Every field is coerced to a literal boolean (`=== true`), so an unusable
 * shape degrades to all-false rather than leaking anything. Returns undefined when no
 * recognizable boolean field is present (so the caller omits geo_signals entirely).
 */
function extractGeoSignals(raw: unknown):
  | {
      denial_text_seen: boolean;
      near_zero_interactive: boolean;
      visible_inaccessible_iframe_seen: boolean;
      large_centered_overlay_seen: boolean;
      viewport_scrim_seen: boolean;
      pointer_interceptor_seen: boolean;
      top_layer_dialog_seen: boolean;
    }
  | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const keys = [
    "denial_text_seen",
    "near_zero_interactive",
    "visible_inaccessible_iframe_seen",
    "large_centered_overlay_seen",
    "viewport_scrim_seen",
    "pointer_interceptor_seen",
    "top_layer_dialog_seen",
  ] as const;
  if (!keys.some((k) => typeof v[k] === "boolean")) return undefined;
  return {
    denial_text_seen: v["denial_text_seen"] === true,
    near_zero_interactive: v["near_zero_interactive"] === true,
    visible_inaccessible_iframe_seen: v["visible_inaccessible_iframe_seen"] === true,
    large_centered_overlay_seen: v["large_centered_overlay_seen"] === true,
    viewport_scrim_seen: v["viewport_scrim_seen"] === true,
    pointer_interceptor_seen: v["pointer_interceptor_seen"] === true,
    top_layer_dialog_seen: v["top_layer_dialog_seen"] === true,
  };
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
      outcome: "cleared" | "still_present" | "inconclusive" | "unknown";
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
  // `large_centered_overlay_seen` and `pointer_interceptor_seen` are deliberately
  // excluded from the present-signal set: a benign marketing hero / sale carousel is
  // large+centered+fixed and occludes the sampled center points, so it trips BOTH
  // exactly like a real card wall. Only an obstructive dimmer/backdrop or opaque
  // iframe genuinely distinguishes a wall, so a lone large overlay / pointer
  // interceptor must NOT report "present" at recheck (that kept benign-hero capsules
  // alive). They are kept in `recognizedKeys` so a probe shape that includes them is
  // still trusted (and resolves to absent), not treated as unparseable.
  const presentKeys = [
    "viewport_scrim_seen",
    "denial_text_seen",
    "visible_inaccessible_iframe_seen",
  ] as const;
  const recognizedKeys = [
    ...presentKeys,
    "pointer_interceptor_seen",
    "large_centered_overlay_seen",
  ] as const;
  // Require at least one recognizable boolean field before trusting the verdict.
  if (!recognizedKeys.some((k) => typeof v[k] === "boolean")) return undefined;
  return presentKeys.some((k) => v[k] === true);
}

/**
 * Classify the geometry-obstruction probe's STATIC signals by STRENGTH so a
 * weak, ambiguous obstruction is handled differently from a real wall.
 *
 * STRONG (a genuine wall — keep `still_present`): an explicit denial page
 * (`denial_text_seen`), a full-viewport scrim/backdrop (`viewport_scrim_seen`), a
 * visible inaccessible cross-origin iframe (`visible_inaccessible_iframe_seen`), or a
 * near-zero-interactive page (`near_zero_interactive`). These are the markers a benign
 * page does NOT produce.
 *
 * NOT strong → "none" (clear-eligible): `large_centered_overlay_seen` and/or
 * `pointer_interceptor_seen` with NONE of the strong markers. A normal marketing hero
 * / sale carousel is large, centered, and fixed/absolute and occludes the sampled
 * center points, so it trips BOTH of these geometry signals exactly like a real
 * centered-card wall — they cannot tell a benign hero apart from a wall, and the live
 * B&BW homepage false positive proved a lone large overlay + pointer interceptor must
 * NOT keep a benign capsule alive at recheck. A real wall always ALSO paints a scrim /
 * iframe / denial / near-zero-interactive marker, which keeps it strong. (The "weak"
 * verdict is retained in the type and consumed by `classifyReleasePresence` for
 * injected/legacy probes, but this reducer no longer produces it.)
 *
 * `repeated_stale` is deliberately NOT consulted (a runtime signal, not a
 * page-state signal — same as geometryObstructionPresent). Returns undefined
 * when the shape is unusable so the caller can fall back to the HV verdict.
 */
export function geometryObstructionStrength(
  raw: unknown,
): "none" | "weak" | "strong" | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const strongKeys = [
    "denial_text_seen",
    "viewport_scrim_seen",
    "visible_inaccessible_iframe_seen",
    "near_zero_interactive",
  ] as const;
  // `large_centered_overlay_seen` and `pointer_interceptor_seen` are recognized (so a
  // probe that surfaces only them is trusted and resolves to "none") but are NOT strong
  // and no longer downgrade to "weak" — see the doc comment above.
  const allKeys = [
    ...strongKeys,
    "pointer_interceptor_seen",
    "large_centered_overlay_seen",
  ] as const;
  // Require at least one recognizable boolean field before trusting the verdict.
  if (!allKeys.some((k) => typeof v[k] === "boolean")) return undefined;
  if (strongKeys.some((k) => v[k] === true)) return "strong";
  return "none";
}

/**
 * Final post-release presence decision: combine the structural-HV verdict with
 * the geometry-obstruction STRENGTH. Separates a weak, ambiguous geometry-only
 * reading from a strong wall, and — critically — only CLEARS on a CONFIDENT
 * healthy reading from BOTH detectors:
 *   - structural HV present                       → "present"
 *   - strong geometry                             → "present"
 *   - weak geometry only (pointer interceptor)    → "weak_ambiguous"
 *   - HV absent AND no geometry obstruction       → "absent"  (CLEAR)
 *   - anything else (one side unreadable, weak,…) → "unknown"
 *
 * The clear condition is a strict AND (`hvPresent === false` AND
 * `geoStrength === "none"`), NOT an OR: a lone pointer interceptor, a probe that
 * could only read one detector, or any weak/ambiguous reading must NEVER mark the
 * capsule cleared. `geoStrength === "none"` is itself the healthy-page
 * confirmation — it requires >3 interactive controls and no overlay/scrim/
 * iframe/denial/pointer-interceptor signal. Exported for direct unit testing.
 */
export function classifyReleasePresence(
  hvPresent: boolean | undefined,
  geoStrength: "none" | "weak" | "strong" | undefined,
): "present" | "weak_ambiguous" | "absent" | "unknown" {
  if (hvPresent === true) return "present";
  if (geoStrength === "strong") return "present";
  if (geoStrength === "weak") return "weak_ambiguous";
  // CLEAR requires a CONFIDENT healthy reading from BOTH detectors.
  if (hvPresent === false && geoStrength === "none") return "absent";
  return "unknown";
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
    let geoStrength: "none" | "weak" | "strong" | undefined;
    let geoSignals: ReturnType<typeof extractGeoSignals>;
    try {
      const geoRaw = await opened.client.evaluate(buildAmbiguousVisualObstructionExpr());
      geoPresent = geometryObstructionPresent(geoRaw);
      geoStrength = geometryObstructionStrength(geoRaw);
      geoSignals = extractGeoSignals(geoRaw);
    } catch {
      geoPresent = undefined;
      geoStrength = undefined;
      geoSignals = undefined;
    }

    return {
      ok: true,
      presence: combineRecheckPresence(hvPresent, geoPresent),
      ...(hvPresent !== undefined ? { hv_present: hvPresent } : {}),
      ...(geoPresent !== undefined ? { geo_present: geoPresent } : {}),
      ...(geoStrength !== undefined ? { geo_strength: geoStrength } : {}),
      ...(geoSignals !== undefined ? { geo_signals: geoSignals } : {}),
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

/** Per-probe presence reading reduced to a single classification. */
type ProbeReading = Awaited<ReturnType<VisualGestureCapsulePresenceProbe>>;

/**
 * Reduce one probe reading to a release-decision, preferring the granular
 * hv_present / geo_strength fields. Falls back to the legacy `presence` verdict
 * for probes (and injected fakes) that don't surface the granular fields, so no
 * existing caller regresses. Never returns weak_ambiguous via the legacy path.
 */
function decideFromProbe(
  r: Extract<ProbeReading, { ok: true }>,
): "present" | "weak_ambiguous" | "absent" | "unknown" {
  const geoStrength =
    r.geo_strength ??
    (r.geo_present === true ? "strong" : r.geo_present === false ? "none" : undefined);
  if (r.hv_present !== undefined || geoStrength !== undefined) {
    return classifyReleasePresence(r.hv_present, geoStrength);
  }
  return r.presence;
}

/**
 * Recheck a capsule after a relayed gesture / live press-hold release. Flag-off
 * short-circuits BEFORE any settle or probe. A short settle precedes the first
 * probe (walls often clear a beat after release). A clearly-absent or
 * clearly-walled first probe resolves immediately; a WEAK geometry-only reading
 * (a lone pointer interceptor) triggers ONE retry after a further settle. A weak
 * reading NEVER clears: the capsule clears ONLY if the retry yields a CONFIDENT
 * healthy `absent` (HV absent AND no geometry obstruction). A real wall on retry
 * burns an attempt (`still_present`); a retry that stays weak/ambiguous is
 * `inconclusive` (burns an attempt to step the guided hold up, but does not
 * clear); a retry probe that could not run is `unknown` (no burn, no clear).
 * See RecheckVisualGestureCapsuleResult for the outcome/error union.
 */
export async function recheckVisualGestureCapsule(args: {
  capsuleId: string;
  cdpUrl: string;
  targetId?: string;
  expectedUrl?: string;
  probe?: VisualGestureCapsulePresenceProbe;
  /** Injectable sleep (tests resolve instantly). */
  sleep?: SleepFn;
  /** Override the first-probe settle (default VGC_RECHECK_SETTLE_MS). */
  settleMs?: number;
  /** Override the weak-geometry retry settle (default VGC_RECHECK_RETRY_SETTLE_MS). */
  retrySettleMs?: number;
}): Promise<RecheckVisualGestureCapsuleResult> {
  if (!isVisualGestureCapsuleEnabled()) return { ok: false, reason: "flag_disabled" };

  const capsule = getVisualGestureCapsule(args.capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };
  if (!RECHECK_ALLOWED_STATES.has(capsule.status)) return { ok: false, reason: "invalid_state" };

  const probe = args.probe ?? defaultPresenceProbe;
  const sleep = args.sleep ?? realSleep;
  const settleMs = args.settleMs ?? VGC_RECHECK_SETTLE_MS;
  const retrySettleMs = args.retrySettleMs ?? VGC_RECHECK_RETRY_SETTLE_MS;
  const runProbe = (): Promise<ProbeReading> =>
    probe({ cdpUrl: args.cdpUrl, targetId: args.targetId, expectedUrl: args.expectedUrl });

  // Settle before the first probe — a wall often clears a beat after release.
  if (settleMs > 0) await sleep(settleMs);
  const first = await runProbe();

  // Probe could not run — leave attempts and status untouched.
  if (!first.ok) {
    logHvDebug({ scope: "vgc_recheck", recheck_outcome: "probe_failed" });
    return { ok: false, reason: "probe_failed" };
  }

  // Fast path for clearly-absent / clearly-walled; only WEAK geometry retries.
  // Widened to include "inconclusive" — the resolved state of an unresolved weak
  // reading (weak first probe, still weak/ambiguous on retry).
  let decision: "present" | "weak_ambiguous" | "absent" | "inconclusive" | "unknown" =
    decideFromProbe(first);
  let last: ProbeReading = first;
  let retryUsed = false;
  if (decision === "weak_ambiguous") {
    retryUsed = true;
    if (retrySettleMs > 0) await sleep(retrySettleMs);
    const second = await runProbe();
    if (!second.ok) {
      // Couldn't even RUN the retry probe — do NOT burn, do NOT clear; the UI can
      // recheck again. Distinct from a probe that ran but stayed ambiguous.
      decision = "unknown";
    } else {
      last = second;
      // A weak reading NEVER clears. It clears ONLY if the retry gives a CONFIDENT
      // healthy `absent` (hv_present === false AND geo_strength === "none"). A real
      // wall (strong / HV present) burns an attempt; a still-weak / unknown retry is
      // INCONCLUSIVE — burn an attempt to step the guided hold up, but never clear.
      const retry = decideFromProbe(second);
      decision =
        retry === "present" ? "present" : retry === "absent" ? "absent" : "inconclusive";
    }
  }

  // Safe debug: coarse per-detector booleans + strength + outcome enum only.
  // No-op when ANTIGEN_HV_DEBUG is off; never carries coords, durations, bytes.
  // Coarse attribution for why geo_strength landed where it did — booleans only.
  const geoSig = last.ok ? last.geo_signals : undefined;
  // Why the capsule resolved as it did, so a false `still_present` is attributable.
  const recheckReason =
    decision === "absent"
      ? "healthy_cleared"
      : decision === "present"
        ? last.ok && last.hv_present === true
          ? "hv_present"
          : "strong_geometry"
        : decision === "inconclusive"
          ? "weak_unresolved"
          : "probe_unreadable";
  logHvDebug({
    scope: "vgc_recheck",
    ...(last.ok && last.hv_present !== undefined ? { probe_hv_present: last.hv_present } : {}),
    ...(last.ok && last.geo_present !== undefined ? { probe_geo_present: last.geo_present } : {}),
    ...(last.ok && last.geo_strength !== undefined ? { geo_strength: last.geo_strength } : {}),
    ...(geoSig
      ? {
          denial_text_seen: geoSig.denial_text_seen,
          near_zero_interactive: geoSig.near_zero_interactive,
          visible_inaccessible_iframe_seen: geoSig.visible_inaccessible_iframe_seen,
          large_centered_overlay_seen: geoSig.large_centered_overlay_seen,
          viewport_scrim_seen: geoSig.viewport_scrim_seen,
          pointer_interceptor_seen: geoSig.pointer_interceptor_seen,
          top_layer_dialog_seen: geoSig.top_layer_dialog_seen,
        }
      : {}),
    retry_used: retryUsed,
    recheck_reason: recheckReason,
    recheck_outcome:
      decision === "absent"
        ? "cleared"
        : decision === "present"
          ? "still_present"
          : decision === "inconclusive"
            ? "inconclusive"
            : "unknown",
  });

  if (decision === "absent") {
    const cleared = markGestureCapsuleCleared(args.capsuleId);
    if (!cleared.ok || !cleared.capsule) return { ok: false, reason: "state_update_failed" };
    // Conservative authority: the ONLY place (besides the in-hold DOM probe) that
    // publishes `completed` / lets the agent resume.
    publishRecheckHandoff(args.capsuleId, "completed");
    return {
      ok: true,
      capsule_id: args.capsuleId,
      outcome: "cleared",
      status: cleared.capsule.status,
      attempt_count: cleared.capsule.attempt_count,
    };
  }

  if (decision === "present") {
    const rejected = markGestureAttemptRejected(args.capsuleId);
    if (!rejected.ok || !rejected.capsule) return { ok: false, reason: "state_update_failed" };
    publishRecheckHandoff(args.capsuleId, "still_active");
    return {
      ok: true,
      capsule_id: args.capsuleId,
      outcome: "still_present",
      status: rejected.capsule.status,
      attempt_count: rejected.capsule.attempt_count,
    };
  }

  if (decision === "inconclusive") {
    // A weak/ambiguous reading that the retry could not resolve to a confident
    // healthy `absent`. We must NEVER clear here — instead burn one attempt so the
    // guided hold steps up (5s → 10s → 15s → manual fallback) and the UI prompts a
    // longer hold. Shares the attempt accounting with `still_present`, but reports
    // a distinct outcome so the UI can say "couldn't confirm" rather than "still
    // present" (and never "presence confirmed").
    const rejected = markGestureAttemptRejected(args.capsuleId);
    if (!rejected.ok || !rejected.capsule) return { ok: false, reason: "state_update_failed" };
    publishRecheckHandoff(args.capsuleId, "still_active");
    return {
      ok: true,
      capsule_id: args.capsuleId,
      outcome: "inconclusive",
      status: rejected.capsule.status,
      attempt_count: rejected.capsule.attempt_count,
    };
  }

  // decision === "unknown": cannot safely decide — no attempt burn, no clear,
  // status and attempt_count unchanged.
  return {
    ok: true,
    capsule_id: args.capsuleId,
    outcome: "unknown",
    status: capsule.status,
    attempt_count: capsule.attempt_count,
  };
}
