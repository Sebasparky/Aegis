/**
 * VisualBlockerClassifierPipeline — exploration / data-gathering skip response.
 *
 * Pure helpers for `ANTIGEN_VISION_CAPTURE_AND_SKIP` mode (see flags.ts). When a
 * `visual_classifier_candidate` is captured for the training set, the snapshot path
 * returns a structured 422 telling the agent to skip this path. This module owns:
 *   - mapping the (already-run) dataset capture result to a coarse, safe status, and
 *   - building the safe 422 response body.
 *
 * SAFETY: the response body is safe-fields ONLY — code/message/status/action plus the
 * two already-narrowed enums (trigger_basis, candidate_reason) sourced from the
 * candidate. It NEVER contains a screenshot path, base64, crop geometry, rect, URL,
 * iframe `src`, raw page text, candidate_id, domain, counts, or challenge details.
 * This is NOT a VGC and NOT a HUMAN_VERIFICATION_REQUIRED 409 — it is an exploration
 * skip signal. It never solves, routes through, or assists a bypass.
 */

import type {
  VisionDatasetCaptureResult,
  VisualClassifierCandidate,
} from "./types.js";

/** Coarse, safe disposition of the dataset capture attempt for the agent. */
export type VisualBlockerStatus =
  | "capture_written"
  | "capture_attempted"
  | "capture_skipped";

/**
 * Map the dataset capture result to a coarse status. `written` ⇒ a record landed on
 * disk. A failure that occurred DURING the capture attempt (redaction / write) is
 * `capture_attempted`. A pre-capture skip (throttle, no session, flags) is
 * `capture_skipped`. In every case the blocker is present, so the caller still skips.
 */
export function mapCaptureResultToBlockerStatus(
  result: VisionDatasetCaptureResult,
): VisualBlockerStatus {
  if (result.written) return "capture_written";
  switch (result.skip_reason) {
    case "redaction_failed":
    case "redaction_unverified":
    case "write_failed":
      return "capture_attempted";
    case "rate_limited":
    case "no_session":
    case "flag_disabled":
    case "not_a_candidate":
    default:
      return "capture_skipped";
  }
}

export interface VisualBlockerSkip {
  candidate: VisualClassifierCandidate;
  blocker_status: VisualBlockerStatus;
}

/**
 * The safe 422 body the snapshot path sends in capture-and-skip mode. `trigger_basis`
 * and `candidate_reason` come from the candidate (already narrowed to safe enums) —
 * never from the raw surface decision. No other keys are added; do not widen this.
 */
export function buildVisualBlockerCapturedResponse(skip: VisualBlockerSkip): {
  ok: false;
  error: {
    code: "ANTIGEN_VISUAL_BLOCKER_CAPTURED";
    message: string;
    blocker_status: VisualBlockerStatus;
    suggested_agent_action: "skip_and_continue";
    trigger_basis: VisualClassifierCandidate["trigger_basis"];
    candidate_reason: VisualClassifierCandidate["candidate_reason"];
  };
} {
  return {
    ok: false,
    error: {
      code: "ANTIGEN_VISUAL_BLOCKER_CAPTURED",
      message:
        "A visual blocker was detected and captured for training. Skip this site or path and continue elsewhere.",
      blocker_status: skip.blocker_status,
      suggested_agent_action: "skip_and_continue",
      trigger_basis: skip.candidate.trigger_basis,
      candidate_reason: skip.candidate.candidate_reason,
    },
  };
}
