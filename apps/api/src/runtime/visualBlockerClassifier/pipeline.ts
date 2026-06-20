/**
 * VisualBlockerClassifierPipeline — orchestrator (Phase 1, shadow-only).
 *
 * Stage 3 of the staged architecture (docs/visual-blocker-classifier-pipeline.md):
 *
 *   build VisualClassifierCandidate (safe fields)
 *     → shadowStubAdapter → VisualClassifierResult
 *     → mapResultToPolicyDecision → PolicyDecision (enforced: false)
 *
 * Runs ONLY when `ANTIGEN_HV_VISION_CLASSIFIER` is on AND the SurfaceBoundaryRouter
 * already decided `route_decided === "visual_classifier_candidate"`. It is SHADOW:
 * the returned outcome is discarded by the call site, never branched on, never mints
 * a VGC, never returns a 409, never changes capsule state. Phase 1 does NO capture,
 * NO dataset write, and emits only safe booleans/enums/buckets/ids in telemetry.
 *
 * Telemetry is gated by the VISION flag (independent of ANTIGEN_HV_DEBUG): when the
 * pipeline runs, its lines are emitted; when the flag is off, nothing runs at all.
 */

import { randomUUID } from "node:crypto";
import type {
  SurfaceBoundaryDecision,
  SurfaceBoundarySignals,
} from "../surfaceBoundary.js";
import { isHvVisionClassifierEnabled } from "./flags.js";
import { shadowStubAdapter } from "./classifierAdapter.js";
import { mapResultToPolicyDecision } from "./policy.js";
import type {
  PipelineOutcome,
  VisualClassifierCandidate,
  VisualClassifierCandidateReason,
  VisualClassifierDominantSurfaceKind,
  VisualClassifierTriggerBasis,
} from "./types.js";

export interface RunVisualBlockerClassifierPipelineArgs {
  surfaceDecision: SurfaceBoundaryDecision;
  surfaceSignals: SurfaceBoundarySignals | null | undefined;
  browserSessionId: string;
  domain: string;
}

/**
 * Safe vision-classifier telemetry logger. No-op unless the vision flag is on, so
 * call sites stay clean. Callers MUST pass only safe scalars (booleans, enums,
 * buckets, non-sensitive ids) — never URLs, raw text, coords, rects, iframe src,
 * selectors, base64, or values. Mirrors the `logHvActionDebug` discipline.
 */
function logVisionClassifierDebug(fields: Record<string, string | number | boolean>): void {
  if (!isHvVisionClassifierEnabled()) return;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  // eslint-disable-next-line no-console
  console.log(`[VisionClassifier] ${parts.join(" ")}`);
}

function deriveTriggerBasis(
  reason: VisualClassifierCandidateReason,
): VisualClassifierTriggerBasis {
  if (reason === "unreadable_dominant_surface") return "unreadable_dominant_surface";
  if (reason === "page_level_hv_wall") return "page_level_hv_wall";
  return "opaque_dominant_surface";
}

function deriveDominantSurfaceKind(
  signals: SurfaceBoundarySignals,
): VisualClassifierDominantSurfaceKind {
  const k = signals.surface_dominant_visible_surface_kind;
  if (
    k === "scrim_center_modal" ||
    k === "top_layer_dialog" ||
    k === "fixed_overlay" ||
    k === "iframe"
  ) {
    return k;
  }
  return "unknown";
}

/**
 * Run the shadow pipeline. Returns an outcome (never throws). The call site
 * discards it — it exists for tests and future phases, not for branching today.
 */
export function runVisualBlockerClassifierPipeline(
  args: RunVisualBlockerClassifierPipelineArgs,
): PipelineOutcome {
  if (!isHvVisionClassifierEnabled()) {
    return { ran: false, skip_reason: "flag_disabled" };
  }

  const { surfaceDecision } = args;
  const reason = surfaceDecision.visual_classifier_candidate_reason;
  if (
    surfaceDecision.route_decided !== "visual_classifier_candidate" ||
    reason === "none"
  ) {
    return { ran: false, skip_reason: "not_a_candidate" };
  }

  const s: SurfaceBoundarySignals =
    args.surfaceSignals && typeof args.surfaceSignals === "object" ? args.surfaceSignals : {};

  const candidate: VisualClassifierCandidate = {
    candidate_id: randomUUID(),
    browser_session_id: args.browserSessionId,
    domain: args.domain,
    trigger_basis: deriveTriggerBasis(reason),
    candidate_reason: reason,
    dominant_surface_kind: deriveDominantSurfaceKind(s),
    signals: {
      scrim_seen: s.screen_viewport_scrim_seen === true || s.viewport_scrim_seen === true,
      centered_modal_seen:
        s.screen_centered_modal_seen === true ||
        s.large_centered_overlay_seen === true ||
        s.surface_blocks_viewport_center === true,
      opaque_iframe_seen: s.opaque_iframe_seen === true,
      visual_dom_contradiction_seen: s.visual_dom_contradiction_seen === true,
      dominant_text_uninspectable:
        s.surface_dominant_text_uninspectable === true || s.surface_text_uninspectable === true,
      pointer_interceptor_seen: s.pointer_interceptor_seen === true,
    },
    created_at: new Date().toISOString(),
  };

  logVisionClassifierDebug({
    event: "visual_classifier_candidate_created",
    candidate_id: candidate.candidate_id,
    trigger_basis: candidate.trigger_basis,
    candidate_reason: candidate.candidate_reason,
    dominant_surface_kind: candidate.dominant_surface_kind,
  });

  // Stage 3: classifier adapter (shadow stub; no capture, no inference).
  logVisionClassifierDebug({
    event: "visual_classifier_invoked",
    candidate_id: candidate.candidate_id,
    classifier_source: "shadow_stub",
    region: "full_viewport",
  });
  const result = shadowStubAdapter(candidate);
  logVisionClassifierDebug({
    event: "visual_classifier_result",
    candidate_id: result.candidate_id,
    blocker_type: result.blocker_type,
    confidence_bucket: result.confidence_bucket,
    user_presence_required: result.user_presence_required,
    wall_visible: result.wall_visible,
    safe_to_resume: result.safe_to_resume,
    classifier_source: result.classifier_source,
  });

  // Stage 4: policy maps result → action. Phase 1: enforced is always false.
  const policy = mapResultToPolicyDecision(result);
  logVisionClassifierDebug({
    event: "visual_classifier_policy_decision",
    candidate_id: policy.candidate_id,
    action: policy.action,
    enforced: policy.enforced,
    basis_blocker_type: policy.basis_blocker_type,
    confidence_bucket: policy.confidence_bucket,
  });

  return { ran: true, candidate, result, policy };
}
