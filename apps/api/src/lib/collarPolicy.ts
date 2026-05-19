import type { AgentDelegation, Collar } from "@aegis/types";

/**
 * Synthetic baseline policy applied when an agent has no custom collar.
 * Browsing/reading is allowed; sensitive actions require approval;
 * high-liability actions are blocked outright.
 *
 * This is the Aegis safety floor — collars add stricter controls on top.
 */
export const BASELINE_NO_COLLAR_POLICY: Collar = {
  id: "baseline",
  user_id: "system",
  name: "Baseline Safety Policy",
  description: "Default Aegis safety rules applied when no collar is assigned.",
  status: "active",
  allowed_actions: ["browse", "search", "read", "compare", "draft", "add_to_cart"],
  approval_required_actions: [
    "login",
    "purchase",
    "payment",
    "submit_form",
    "share_email",
    "share_phone",
    "send_email",
    "post_publicly",
    "create_account",
    "upload_file",
  ],
  blocked_actions: [
    "subscription",
    "delete_account",
    "identity_disclosure",
    "government_id_upload",
    "financial_data_disclosure",
    "medical_data_disclosure",
    "save_credential",
    "save_payment_method",
    "enable_persistence",
  ],
  spending_limits: { max_without_approval: 0, max_with_approval: 0, subscriptions_allowed: false },
  counterparty_rules: {
    sensitive_actions_require_verified_business: false,
    block_known_prompt_injection_sites: true,
  },
  session_limits: { max_duration_minutes: 60, max_active_sessions: 1 },
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

export type CollarResolution =
  | { ok: true; collar: Collar; policy_mode: "baseline" }
  | { ok: true; collar: Collar; policy_mode: "collar" }
  | { ok: false; status: 403; code: "COLLAR_NOT_FOUND" | "COLLAR_REVOKED"; message: string };

/**
 * Resolve the effective policy collar for a delegation. Three cases:
 *
 * - No default_collar_id → baseline safety policy (ok: true, policy_mode: "baseline")
 * - Active collar found → use it (ok: true, policy_mode: "collar")
 * - collar_id present but collar missing/revoked → fail closed (ok: false)
 *
 * The fail-closed rule is intentional: if a user assigned a collar and it is later
 * revoked or deleted, the agent must not silently downgrade to baseline safety.
 * "No collar" means the user intentionally has no custom rule set — it is a
 * different state from "collar assigned but broken."
 */
export function resolveEffectiveCollar(
  delegation: AgentDelegation,
  collarsMap: Map<string, Collar>
): CollarResolution {
  const collar_id = delegation.default_collar_id;

  if (!collar_id) {
    return { ok: true, collar: BASELINE_NO_COLLAR_POLICY, policy_mode: "baseline" };
  }

  const collar = collarsMap.get(collar_id);
  if (!collar) {
    return {
      ok: false,
      status: 403,
      code: "COLLAR_NOT_FOUND",
      message: "The collar attached to this delegation was not found.",
    };
  }

  if (collar.status !== "active") {
    return {
      ok: false,
      status: 403,
      code: "COLLAR_REVOKED",
      message: "The collar attached to this delegation is not active.",
    };
  }

  return { ok: true, collar, policy_mode: "collar" };
}
