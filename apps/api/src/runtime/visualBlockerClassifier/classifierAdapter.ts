/**
 * VisualBlockerClassifierPipeline — classifier adapter (Phase 1, shadow stub).
 *
 * v0 is a SHADOW STUB. It performs NO capture and NO inference — it always
 * returns `unknown_blocked` / `low`, which policy maps to `fail_closed_or_ask_user`
 * (and in Phase 1 that is `enforced: false`, so the live path is unchanged). Its
 * only value is exercising the pipeline shape and emitting safe telemetry.
 *
 * It deliberately NEVER asserts HV: a `dev_heuristic` adapter and a `manual_qa`
 * label tool are deferred and kept separate so we never train on the stub's guess.
 */

import type { VisualClassifierCandidate, VisualClassifierResult } from "./types.js";

/**
 * Shadow stub: constant safe output keyed to the candidate. `wall_visible: true`
 * reflects that we were routed here from a `visual_classifier_candidate` surface,
 * but `blocker_type` stays `unknown_blocked` and `user_presence_required`/
 * `safe_to_resume` stay conservative. No `model_version` (only set for "model").
 */
export function shadowStubAdapter(candidate: VisualClassifierCandidate): VisualClassifierResult {
  return {
    candidate_id: candidate.candidate_id,
    blocker_type: "unknown_blocked",
    confidence_bucket: "low",
    user_presence_required: false,
    wall_visible: true,
    safe_to_resume: false,
    classifier_source: "shadow_stub",
    classified_at: new Date().toISOString(),
  };
}
