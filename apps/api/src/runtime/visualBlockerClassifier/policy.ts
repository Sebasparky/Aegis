/**
 * VisualBlockerClassifierPipeline — policy engine (Phase 1, shadow).
 *
 * The MODEL classifies; the POLICY governs. This maps a `VisualClassifierResult`
 * to a `PolicyDecisionAction` using the table from
 * docs/visual-blocker-classifier-pipeline.md. Every action reuses an EXISTING flow
 * (VGC orchestrator, credential injection, approval inbox) — the pipeline never
 * invents a new action surface.
 *
 * Phase 1 invariant: `enforced` is the literal `false` for ALL decisions (shadow).
 * No decision here mints a VGC, returns a 409, or changes any live behavior.
 */

import type {
  BlockerType,
  PolicyDecision,
  PolicyDecisionAction,
  VisualClassifierResult,
} from "./types.js";

/** Full BlockerType → action map (memo table). Total over the enum. */
function actionForBlockerType(blockerType: BlockerType): PolicyDecisionAction {
  switch (blockerType) {
    case "hv_full_page":
    case "hv_center_modal":
    case "hv_small_widget":
    case "hv_press_hold":
      return "route_to_user_presence_vgc";
    case "hv_interaction_active":
      return "live_guidance_keep_holding";
    case "hv_cleared_or_settling":
      return "wait_and_recheck";
    case "login_wall":
      return "route_to_credential_flow";
    case "cookie_banner":
    case "marketing_modal":
    case "normal_or_unblocked":
    case "non_hv_modal":
      return "agent_may_handle";
    case "unknown_blocked":
      return "fail_closed_or_ask_user";
    default: {
      // Exhaustiveness guard: any unmapped BlockerType fails closed.
      const _exhaustive: never = blockerType;
      void _exhaustive;
      return "fail_closed_or_ask_user";
    }
  }
}

/**
 * Map a classifier result to a shadow PolicyDecision. `enforced` is written as the
 * literal `false` — never through a variable — per the Phase 1 invariant.
 */
export function mapResultToPolicyDecision(result: VisualClassifierResult): PolicyDecision {
  return {
    candidate_id: result.candidate_id,
    action: actionForBlockerType(result.blocker_type),
    enforced: false,
    basis_blocker_type: result.blocker_type,
    confidence_bucket: result.confidence_bucket,
    decided_at: new Date().toISOString(),
  };
}
