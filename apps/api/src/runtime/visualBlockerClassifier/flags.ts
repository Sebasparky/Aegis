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
