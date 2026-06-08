import type { ActionType, RiskLevel } from "@aegis/types";
import { classifyActionIntent, type ActionIntentInput } from "./actionIntent.js";

export interface DetectionInput {
  action: "click" | "type";
  url?: string;
  targetText?: string;
  elementInfo?: {
    tagName?: string;
    inputType?: string;
    id?: string;
    name?: string;
    autocomplete?: string;
    placeholder?: string;
  };
  pageText?: string;
}

export interface DetectionResult {
  sensitive: boolean;
  action_type: ActionType;
  risk_level: RiskLevel;
  reason: string;
  signals: string[];
}

const NONE: DetectionResult = {
  sensitive: false,
  action_type: "browse",
  risk_level: "low",
  reason: "No sensitive action detected.",
  signals: [],
};

/**
 * Legacy detection surface (used by the older agent.ts enforceAndExecute path).
 *
 * This now DELEGATES to the generic capability-state classifier in
 * actionIntent.ts so the legacy aegis_click path and the primary Antigen
 * browser_click gate agree on classification — one source of truth, no
 * duplicated flat denylist. The public `detect()` signature and DetectionResult
 * shape are unchanged so existing callers keep working; intents are mapped back
 * to the legacy ActionType/RiskLevel/sensitive shape below.
 *
 * Semantic change vs the old denylist: reversible funnel transitions
 * ("Continue to checkout", "Add to cart", a bare "Submit" with no high-liability
 * context) are no longer flagged sensitive. Final/irreversible commitments
 * (place order, pay now, confirm purchase), publish/send, account/security
 * changes, and high-liability submits are.
 */
export function detect(input: DetectionInput): DetectionResult {
  const el = input.elementInfo ?? {};
  // Legacy click targets are action elements; treat them as button-like so the
  // classifier's button-gated publish/send rules fire as before.
  const tag = (el.tagName ?? "").toLowerCase();
  const kind =
    input.action === "type"
      ? "input"
      : tag === "a"
        ? "link"
        : "button";

  const classifierInput: ActionIntentInput = {
    action: input.action,
    text: input.targetText,
    kind,
    tag: el.tagName,
    url: input.url,
    input_type: el.inputType,
    autocomplete: el.autocomplete,
    field_name: el.name,
    placeholder: el.placeholder,
  };

  const c = classifyActionIntent(classifierInput);
  const text = (input.targetText ?? "").toLowerCase();
  const url = (input.url ?? "").toLowerCase();
  const signals = c.signals.slice();

  const ret = (action_type: ActionType, reason: string): DetectionResult => ({
    sensitive: true,
    action_type,
    risk_level: c.risk_level,
    reason,
    signals,
  });

  switch (c.action_intent) {
    case "final_commit":
      return ret("purchase", "Final purchase/payment commitment.");
    case "payment_method_use":
      return ret("payment", "Payment card field.");
    case "publish_send": {
      if (url.includes("mail") || text.includes("send")) {
        return ret("send_email", "Send action under the user's identity.");
      }
      return ret("post_publicly", "Public post/publish action.");
    }
    case "account_security_change": {
      if (text.includes("delete account") || text.includes("deactivate") || text.includes("close account")) {
        return ret("delete_account", "Account deletion/deactivation.");
      }
      if (text.includes("authori") || text.includes("connect")) {
        return ret("oauth_authorize", "OAuth grant / external account connection.");
      }
      return ret("account_setting_change", "Account or security change.");
    }
    case "high_liability_submit":
      return ret("submit_form", "High-liability form submission.");
    case "protected_fill": {
      if (signals.includes("credential_field")) return ret("login", "Password/credential field.");
      if (signals.includes("government_id_field")) return ret("government_id_upload", "Government ID / sensitive identity field.");
      if (el.autocomplete === "email" || (el.name ?? "").toLowerCase().includes("email")) {
        return ret("share_email", "Email input — will share email address.");
      }
      if (el.autocomplete === "tel" || /phone|tel/.test((el.name ?? "").toLowerCase())) {
        return ret("share_phone", "Phone number input.");
      }
      return ret("share_address", "Address / contact input.");
    }
    case "checkout_transition":
    case "cart_mutation":
    case "navigation":
    default:
      return NONE;
  }
}
