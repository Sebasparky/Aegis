import type {
  ActionGateResult,
  ActionIntentClassification,
  GateDisposition,
  RecommendedHandoff,
  RiskState,
} from "@aegis/types";

/**
 * Capability-state gate. Maps a classified action intent to a disposition.
 *
 * Reversible navigation/cart/checkout-transition is allowed without a user
 * prompt (and still passes through the unchanged URL/TTL/viewport/Phase 4B
 * validation downstream). Final/irreversible or identity-committing intents are
 * NOT dispatched — the gate returns a structured directive pointing at the
 * existing handoff tool. The gate NEVER creates a user approval, NEVER prompts
 * the user, and NEVER touches secrets: the handoff tools remain the only path
 * that produces a user approval, consumes a SensitiveGrant, and signs a
 * UserApprovalReceipt.
 *
 * Reason strings are fixed and keyed by intent — never derived from page
 * text/URL/HTML.
 */

// Fixed canned reasons — enum-keyed, no page-derived content.
const REASONS: Record<string, string> = {
  navigation: "Reversible navigation — allowed without a user prompt.",
  cart_mutation: "Cart change is reversible — allowed without a user prompt.",
  checkout_transition: "Continuing into the checkout funnel is reversible — allowed without a user prompt.",
  protected_fill: "Sensitive field — Antigen fills the value through a protected handoff; the raw value is never exposed to the agent.",
  payment_method_use: "Payment instrument fields must be filled through Antigen's protected payment handoff.",
  final_commit: "This is a final purchase/payment commitment. Route through the purchase-confirmation handoff, which carries the user approval and signed receipt.",
  publish_send: "Publishing or sending under the user's identity requires user approval. Route through a verified sensitive workflow.",
  account_security_change: "Account or security changes require user approval. Route through a verified sensitive workflow.",
  high_liability_submit: "Submitting a high-liability (legal/medical/financial/government) form requires user approval. Route through a verified sensitive workflow.",
  uncertain: "Antigen could not confirm this action is reversible while the workflow is near a commitment. Failing closed — route through a verified sensitive workflow.",
};

function handoffForProtectedFill(classification: ActionIntentClassification): RecommendedHandoff {
  if (classification.signals.includes("credential_field")) return "request_secret_field_injection";
  return "request_profile_field_fill";
}

export function evaluateActionGate(
  classification: ActionIntentClassification,
  _risk_state?: RiskState,
): ActionGateResult {
  const { action_intent, reversibility } = classification;

  // Fail closed: any uncertain high-risk classification is blocked.
  if (reversibility === "uncertain") {
    return {
      disposition: "blocked_by_antigen_platform",
      action_intent,
      recommended_handoff: "sensitive_workflow_required",
      reason: REASONS.uncertain,
    };
  }

  let disposition: GateDisposition;
  let recommended_handoff: RecommendedHandoff | undefined;

  switch (action_intent) {
    case "navigation":
    case "cart_mutation":
    case "checkout_transition":
      disposition = "allowed_without_user_prompt";
      break;
    case "protected_fill":
      disposition = "platform_control_required";
      recommended_handoff = handoffForProtectedFill(classification);
      break;
    case "payment_method_use":
      disposition = "platform_control_required";
      recommended_handoff = "request_payment_card_fill";
      break;
    case "final_commit":
      disposition = "blocked_by_antigen_platform";
      recommended_handoff = "request_purchase_confirmation";
      break;
    case "publish_send":
    case "account_security_change":
    case "high_liability_submit":
      disposition = "blocked_by_antigen_platform";
      recommended_handoff = "sensitive_workflow_required";
      break;
    default:
      // Exhaustive guard — fail closed on any unmapped intent.
      disposition = "blocked_by_antigen_platform";
      recommended_handoff = "sensitive_workflow_required";
  }

  return {
    disposition,
    action_intent,
    ...(recommended_handoff ? { recommended_handoff } : {}),
    reason: REASONS[action_intent] ?? REASONS.uncertain,
  };
}
