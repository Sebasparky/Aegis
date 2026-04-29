import type {
  Collar,
  ProtectedSession,
  ActionType,
  PolicyEvalResult,
  PolicyEvalInput,
  RiskLevel,
} from "@aegis/types";

// ─── Risk Classification ──────────────────────────────────────────────────────

// Critical: almost always blocked or requires strict approval
const CRITICAL_ACTIONS: ActionType[] = [
  "government_id_upload",
  "medical_data_disclosure",
  "financial_data_disclosure",
  "delete_account",
  "oauth_authorize",
];

// High: usually require approval
const HIGH_RISK_ACTIONS: ActionType[] = [
  "purchase",
  "payment",
  "login",
  "create_account",
  "identity_disclosure",
  "account_setting_change",
  "connect_app",
];

// Medium: may require approval depending on context
const MEDIUM_RISK_ACTIONS: ActionType[] = [
  "share_email",
  "share_phone",
  "share_address",
  "post_publicly",
  "send_email",
  "forward_email",
  "upload_file",
  "submit_form",
  "subscription",
  "comment",
  "direct_message",
];

// Low: generally safe without approval
const LOW_RISK_ACTIONS: ActionType[] = [
  "browse",
  "search",
  "read",
  "compare",
  "draft",
  "add_to_cart",
  "download_file",
];

export function riskLevel(action: ActionType): RiskLevel {
  if (CRITICAL_ACTIONS.includes(action)) return "critical";
  if (HIGH_RISK_ACTIONS.includes(action)) return "high";
  if (MEDIUM_RISK_ACTIONS.includes(action)) return "medium";
  return "low";
}

function isSensitive(action: ActionType): boolean {
  return riskLevel(action) !== "low";
}

// ─── Spending Limit Check ─────────────────────────────────────────────────────

function checkSpendingLimits(
  collar: Collar,
  action_type: ActionType,
  context?: Record<string, unknown>
): PolicyEvalResult | null {
  // subscriptions hard-blocked if not allowed in spending_limits
  if (action_type === "subscription" && !collar.spending_limits.subscriptions_allowed) {
    return {
      decision: "block",
      reason: "This collar does not allow subscriptions.",
      risk_level: "high",
    };
  }

  // purchase amount exceeds max_with_approval → block
  if (
    (action_type === "purchase" || action_type === "payment") &&
    context?.amount !== undefined
  ) {
    const amount = Number(context.amount);
    if (amount > collar.spending_limits.max_with_approval) {
      return {
        decision: "block",
        reason: `Purchase amount $${amount} exceeds this collar's maximum allowed amount of $${collar.spending_limits.max_with_approval}.`,
        risk_level: "critical",
      };
    }
  }

  return null;
}

// ─── Counterparty Trust Check ─────────────────────────────────────────────────

function checkCounterpartyRules(
  collar: Collar,
  action_type: ActionType,
  counterparty_trust_status?: PolicyEvalInput["counterparty_trust_status"]
): PolicyEvalResult | null {
  if (!collar.counterparty_rules.sensitive_actions_require_verified_business) return null;
  if (!isSensitive(action_type)) return null;

  const unverified =
    !counterparty_trust_status ||
    counterparty_trust_status === "unknown" ||
    counterparty_trust_status === "unverified";

  if (unverified) {
    return {
      decision: "approval_required",
      reason: `This collar requires a verified business for sensitive actions. The counterparty is ${counterparty_trust_status ?? "unknown"}.`,
      risk_level: riskLevel(action_type),
    };
  }

  if (counterparty_trust_status === "flagged") {
    return {
      decision: "block",
      reason: "This counterparty has been flagged and cannot be used for sensitive actions.",
      risk_level: "critical",
    };
  }

  return null;
}

// ─── Session Validity Check ───────────────────────────────────────────────────

function checkSession(session?: ProtectedSession): PolicyEvalResult | null {
  if (!session) return null;

  if (session.status === "revoked") {
    return { decision: "block", reason: "Session has been revoked.", risk_level: "critical" };
  }
  if (session.status === "expired") {
    return { decision: "block", reason: "Session has expired.", risk_level: "critical" };
  }
  if (new Date(session.expires_at) < new Date()) {
    return { decision: "block", reason: "Session has expired.", risk_level: "critical" };
  }

  return null;
}

// ─── Main Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate a requested action against a collar policy.
 *
 * Precedence order:
 *   1. Collar revoked/inactive          → block
 *   2. Session expired/revoked           → block
 *   3. Spending limit exceeded           → block
 *   4. Counterparty flagged              → block
 *   5. Action in blocked_actions         → block
 *   6. Counterparty unverified + sensitive_actions_require_verified_business → approval_required
 *   7. Action in approval_required_actions → approval_required
 *   8. Action in allowed_actions         → allow
 *   9. Critical unknown action           → approval_required
 *  10. Non-critical unknown action       → approval_required (safe default for MVP)
 *
 * Pure and testable — no I/O or side effects.
 */
export function evaluateAction(input: PolicyEvalInput): PolicyEvalResult;
/** @deprecated Use evaluateAction(input: PolicyEvalInput) instead. */
export function evaluateAction(collar: Collar, action_type: ActionType): PolicyEvalResult;
export function evaluateAction(
  collarOrInput: Collar | PolicyEvalInput,
  action_type_legacy?: ActionType
): PolicyEvalResult {
  // Support both the new object form and the old positional form
  let collar: Collar;
  let input: PolicyEvalInput;

  if (action_type_legacy !== undefined) {
    // Legacy call: evaluateAction(collar, action_type)
    collar = collarOrInput as Collar;
    input = { collar, action_type: action_type_legacy };
  } else {
    input = collarOrInput as PolicyEvalInput;
    collar = input.collar;
  }

  const { session, action_type, context, counterparty_trust_status } = input;

  // 1. Collar state
  if (collar.status !== "active") {
    return { decision: "block", reason: "Collar is not active or has been revoked.", risk_level: "critical" };
  }

  // 2. Session state
  const sessionCheck = checkSession(session);
  if (sessionCheck) return sessionCheck;

  // 3 & 4. Spending limits and flagged counterparties
  const spendingResult = checkSpendingLimits(collar, action_type, context);
  if (spendingResult?.decision === "block") return spendingResult;

  const counterpartyFlaggedResult = checkCounterpartyRules(collar, action_type, counterparty_trust_status);
  if (counterpartyFlaggedResult?.decision === "block") return counterpartyFlaggedResult;

  // 5. Explicit block list
  if (collar.blocked_actions.includes(action_type)) {
    return {
      decision: "block",
      reason: `This collar blocks the action: ${action_type}.`,
      risk_level: riskLevel(action_type),
    };
  }

  // 6. Counterparty trust upgrade (unverified + rule enabled)
  if (counterpartyFlaggedResult?.decision === "approval_required") return counterpartyFlaggedResult;

  // 7. Explicit approval list
  if (collar.approval_required_actions.includes(action_type)) {
    return {
      decision: "approval_required",
      reason: `This collar requires approval before: ${action_type}.`,
      risk_level: riskLevel(action_type),
    };
  }

  // Also escalate spending-limit to approval_required (amount within max_with_approval range)
  if (spendingResult?.decision === "approval_required") return spendingResult;

  // 8. Explicit allow list
  if (collar.allowed_actions.includes(action_type)) {
    return {
      decision: "allow",
      reason: `Action allowed by collar: ${action_type}.`,
      risk_level: "low",
    };
  }

  // 9 & 10. Unknown action — always require approval for safety in MVP
  const rl = riskLevel(action_type);
  return {
    decision: "approval_required",
    reason: `Action "${action_type}" is not explicitly listed in this collar. Approval required by default.`,
    risk_level: rl,
  };
}
