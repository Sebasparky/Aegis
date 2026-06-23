/**
 * VisualBlockerClassifierPipeline — flag gate (Phase 1).
 *
 * `ANTIGEN_HV_VISION_CLASSIFIER` controls whether the (shadow) pipeline RUNS.
 * It is deliberately INDEPENDENT of `ANTIGEN_HV_DEBUG`, which controls only the
 * existing snapshot_hv_gate debug telemetry output. Default off ⇒ byte-identical:
 * when off, the pipeline never builds a candidate, never invokes the stub, and
 * emits no telemetry. Even when on, Phase 1 is shadow-only — no VGC mint, no 409,
 * no capsule change, and every PolicyDecision is `enforced: false`.
 *
 * Mirrors the per-flag getter discipline in `isVisualGestureCapsuleEnabled()` /
 * `isHvDebugEnabled()` so parsing semantics stay consistent across the runtime.
 */
export function isHvVisionClassifierEnabled(): boolean {
  return process.env.ANTIGEN_HV_VISION_CLASSIFIER === "true";
}

/**
 * `ANTIGEN_HV_VISION_DATASET` controls whether dev-only redacted dataset capture
 * runs (Phase 2A). It is an ADDITIONAL opt-in on top of the classifier flag — a
 * dataset record is only ever produced for a real `visual_classifier_candidate`,
 * which the pipeline only builds when `ANTIGEN_HV_VISION_CLASSIFIER` is on. This
 * flag is independent of `ANTIGEN_HV_DEBUG`. Default off ⇒ no writes, no telemetry,
 * behavior byte-identical. Even when on it is strictly dev/local: it writes a
 * gitignored `frame.png` + safe `meta.json` and NEVER affects the request.
 */
export function isHvVisionDatasetEnabled(): boolean {
  return process.env.ANTIGEN_HV_VISION_DATASET === "true";
}

/**
 * `ANTIGEN_VISION_CAPTURE_AND_SKIP` enables the explicit exploration / data-gathering
 * mode (on top of the classifier + dataset flags). When all three are on AND the
 * SurfaceBoundaryRouter decided this surface is a `visual_classifier_candidate`, the
 * snapshot path: runs the existing pipeline, AWAITS the existing redacted dataset
 * capture (so it can honestly report written/attempted/skipped), and returns a 422
 * `ANTIGEN_VISUAL_BLOCKER_CAPTURED` skip response telling the agent to abandon this
 * path. It does NOT mint a VGC and does NOT return a HUMAN_VERIFICATION_REQUIRED 409 —
 * in this mode it suppresses snapshot-path VGC minting even if the VGC flag is on.
 * This is exploration only — never solves, routes through, or assists a bypass.
 * Default off ⇒ normal user-task mode is byte-identical.
 */
export function isVisionCaptureAndSkipEnabled(): boolean {
  return process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP === "true";
}

/**
 * `ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE` enables the dev/QA-only MANUAL capture of
 * benign hard negatives from NORMAL snapshots. Unlike the dataset/classifier flags,
 * this path is never automatic and never watches: a capture happens ONLY when the QA
 * agent explicitly calls the manual-capture tool/endpoint after a normal snapshot.
 * It runs NO classifier; it just writes a redacted frame and appends one safe event
 * to the runtime judgment queue (which the existing offline importer folds into the
 * review pipeline). Default off ⇒ the endpoint/tool is unavailable and no-op,
 * behavior byte-identical.
 */
export function isManualVisualReviewCaptureEnabled(): boolean {
  return process.env.ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE === "true";
}

/**
 * `ANTIGEN_HV_PROACTIVE_SURFACE` enables PROACTIVE visual judgment on a visibly
 * dominant centered surface (a centered modal backed by a viewport scrim OR, after the
 * no-scrim broadening, a centered fixed-overlay surface with no scrim) — BEFORE DOM
 * phrase/affordance detection or a failed action proves it is a human-verification wall.
 * It is the fix for the live Bath & Body Works "Press & Hold" gap where the snapshot
 * returned normal actionable refs (and an action ran behind the wall) because
 * `no_hv_phrase` left `screenHv.wall` false (and, in the no-scrim case, the scrim-only
 * gate stayed closed) so the model was never consulted.
 *
 * When on (and `ANTIGEN_VISUAL_GESTURE_CAPSULE` on, with a live CDP session), the
 * snapshot path and the browser-click/type/set-value/scroll preflight run the SAME
 * visual classifier the no-progress backstop uses on a dominant centered surface
 * (scrim-backed or no-scrim fixed-overlay). A confident HV verdict mints + fails closed
 * (409); a confident benign verdict proceeds; an UNCERTAIN verdict over a dominant
 * surface returns a recoverable non-actionable snapshot state (200, refs withheld) and
 * HARD-BLOCKS actions (`ACTION_BLOCKED_DOMINANT_SURFACE` 409) without minting (a dominant
 * surface alone never mints — the `requireOpaqueBoundary` authority is unchanged).
 *
 * Default off ⇒ byte-identical: no new trigger, no CDP probe, no model call, no new
 * response field, no new telemetry, no changed status code. Behavioral effects keyed
 * on a model verdict additionally require `ANTIGEN_VISUAL_JUDGMENT_ENABLED` (a
 * disabled model never mints or blocks).
 */
export function isHvProactiveSurfaceEnabled(): boolean {
  return process.env.ANTIGEN_HV_PROACTIVE_SURFACE === "true";
}
