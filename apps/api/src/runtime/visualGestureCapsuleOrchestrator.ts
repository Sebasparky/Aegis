// ─── Visual Gesture Capsule — M1H opaque-HV creation orchestrator ─────────────
//
// The single backend trigger that mints a Visual Gesture Capsule. It is invoked
// ONLY from the canonical agent HUMAN_VERIFICATION_REQUIRED path (agent-api.ts
// `rejectStaleRefAsHumanVerification`) when the live probe finds an opaque,
// page-level human-verification wall (`wall.page_level === true`) — i.e. the
// challenge control lives in an inaccessible cross-origin iframe and the DOM
// Human Presence Relay has no `control_box` to target.
//
// Behavior is fail-safe and never throws into its caller: a disabled flag,
// missing identity, a failed create, or a failed first-frame capture all degrade
// to a structured result. When the capsule exists but its first frame could not
// be captured, the capsule is kept ALIVE (the M1D `/recapture` endpoint can retry)
// and `screenshot_available: false` is reported — a missing first frame must
// never break the agent's HV-required response.
//
// Output is SAFE-ONLY: it returns the M1A safe view (`getSafeVisualGestureCapsuleView`)
// and a boolean. It never returns or stores screenshot bytes, viewport dims,
// coordinates, gesture strategy, cdpUrl, targetId, or expectedUrl.

import {
  createVisualGestureCapsule,
  getSafeVisualGestureCapsuleView,
  isVisualGestureCapsuleEnabled,
  type SafeVisualGestureCapsuleView,
} from "./visualGestureCapsule.js";
import { captureVisualGestureCapsuleScreenshotFrame } from "./visualGestureCapsuleCapture.js";
import {
  publishHvHandoffUpdate,
  type HvHandoffTriggerBasis,
  type HvHandoffVisualPolicyDecision,
} from "./humanVerificationHandoff.js";
import { startVisualHandoffMonitor } from "./visualHandoffMonitor.js";

export interface CreateVgcForOpaqueHvInput {
  /** The owning HV request — links the capsule back to the user-presence stop state. */
  humanVerificationRequestId: string;
  /** Ephemeral task browser session the wall is blocking. */
  browserSessionId: string;
  /** Wall domain (display/scoping metadata only). */
  domain: string;
  /** CDP endpoint used ONLY by the capture helper — never surfaced to the agent. */
  cdpUrl: string;
  pageUrl?: string;
  delegationId?: string;
  userId?: string;
  /** Optional preferred CDP page target id (capture seam only). */
  targetId?: string;
  /** Optional expected page URL for the capture (advisory). */
  expectedUrl?: string;
  /**
   * Non-sensitive classification of why a visual capsule was needed. Input-only:
   * the capsule type has no safe dedicated reason field (`error` is reserved for
   * failure states), so this is NOT persisted on the capsule in this slice.
   */
  reason?: "opaque_hv_no_control_box" | "oopif_hv_no_dom_target" | string;
  /** Injectable for tests; defaults to the real redacted-capture helper. */
  capture?: typeof captureVisualGestureCapsuleScreenshotFrame;
  /**
   * OPTIONAL safe visual-judgment context (from the snapshot HV gate's model
   * result) to echo into the initial `detected` handoff status update. Status
   * metadata only — never gates anything. Absent on the no-progress backstop
   * (no model consulted there).
   */
  modelLabel?: string;
  modelConfidence?: number;
  visualPolicyDecision?: HvHandoffVisualPolicyDecision;
  triggerBasis?: HvHandoffTriggerBasis;
}

export type CreateVgcForOpaqueHvResult =
  | { ok: true; capsule: SafeVisualGestureCapsuleView; screenshot_available: boolean }
  | { ok: false; reason: "flag_disabled" | "create_failed" | "capture_failed" | "not_needed" };

/**
 * Create a Visual Gesture Capsule for an opaque, page-level HV wall and capture
 * its first redacted frame when possible. Order: flag → identity guard → create
 * → capture. Returns safe view + availability only. Never throws.
 */
export async function createVisualGestureCapsuleForOpaqueHv(
  input: CreateVgcForOpaqueHvInput,
): Promise<CreateVgcForOpaqueHvResult> {
  // 1. Flag gate FIRST — no capsule, no capture, no CDP touched when off.
  if (!isVisualGestureCapsuleEnabled()) return { ok: false, reason: "flag_disabled" };

  // 2. Required identity guard — the caller shouldn't have invoked without these.
  if (!input.humanVerificationRequestId || !input.browserSessionId || !input.domain) {
    return { ok: false, reason: "not_needed" };
  }

  // 3. Create the capsule (status `awaiting_user_gesture`). No screenshot bytes,
  //    no reason persisted. A throw here degrades to create_failed.
  let capsule;
  try {
    capsule = createVisualGestureCapsule({
      human_verification_request_id: input.humanVerificationRequestId,
      browser_session_id: input.browserSessionId,
      domain: input.domain,
      ...(input.pageUrl ? { page_url: input.pageUrl } : {}),
      ...(input.delegationId ? { delegation_id: input.delegationId } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
    });
  } catch {
    return { ok: false, reason: "create_failed" };
  }

  // 4. Attempt the first redacted frame. Any non-ok result OR a thrown capture
  //    keeps the capsule alive (retryable via /recapture) and degrades to
  //    screenshot_available:false — it must not break the HV-required response.
  const capture = input.capture ?? captureVisualGestureCapsuleScreenshotFrame;
  let screenshotAvailable = false;
  try {
    const cap = await capture({
      capsuleId: capsule.capsule_id,
      cdpUrl: input.cdpUrl,
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input.expectedUrl !== undefined ? { expectedUrl: input.expectedUrl } : {}),
    });
    screenshotAvailable = cap.ok === true;
  } catch {
    screenshotAvailable = false;
  }

  // 5. Publish the initial `detected` handoff status (advisory, safe-fields-only).
  //    Best-effort: a publish failure never affects the HV-required response. This
  //    runs ONLY when a capsule was actually minted (i.e. NOT on benign
  //    suppression, which never reaches the orchestrator).
  publishHvHandoffUpdate({
    browser_session_id: capsule.browser_session_id,
    source: "visual_gesture_capsule",
    phase: "detected",
    capsule_id: capsule.capsule_id,
    human_verification_request_id: capsule.human_verification_request_id,
    domain: capsule.domain,
    presence_source: input.modelLabel ? "model" : "none",
    ...(input.modelLabel ? { model_label: input.modelLabel } : {}),
    ...(input.modelConfidence !== undefined ? { model_confidence: input.modelConfidence } : {}),
    ...(input.visualPolicyDecision ? { visual_policy_decision: input.visualPolicyDecision } : {}),
    ...(input.triggerBasis ? { trigger_basis: input.triggerBasis } : {}),
  });

  // 5b. Start the lifecycle visual handoff monitor (no-op unless
  //     ANTIGEN_HV_VISUAL_HANDOFF + the visual judgment model are enabled). While
  //     the capsule is active it polls the visual model ~500ms and is the SOLE
  //     completion authority (stable visual clear), with the DOM demoted to
  //     auxiliary/debug. Best-effort; never affects the HV-required response.
  //     TODO(ui-start-gate): once the Antigen UI exposes a "Start verification"
  //     button, move this polling START from mint-time to Start-click time.
  startVisualHandoffMonitor({
    capsuleId: capsule.capsule_id,
    cdpUrl: input.cdpUrl,
    browserSessionId: capsule.browser_session_id,
  });

  // 6. Safe view only — `screenshot_available` is re-derived from the live frame
  //    store inside the safe view, so it is authoritative regardless of the path.
  return {
    ok: true,
    capsule: getSafeVisualGestureCapsuleView(capsule),
    screenshot_available: screenshotAvailable,
  };
}
