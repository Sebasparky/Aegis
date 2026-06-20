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
