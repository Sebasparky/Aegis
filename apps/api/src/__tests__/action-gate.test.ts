/**
 * Unit tests for the capability-state gate: intent → disposition + recommended_handoff.
 */
import { describe, it, expect } from "vitest";
import { classifyActionIntent } from "../detection/actionIntent.js";
import { evaluateActionGate } from "../detection/actionGate.js";

const gateFor = (text: string, extra = {}) =>
  evaluateActionGate(classifyActionIntent({ action: "click", text, kind: "button", ...extra }));

describe("evaluateActionGate", () => {
  it("allows reversible navigation/cart/checkout-transition without a prompt", () => {
    expect(gateFor("Continue to checkout").disposition).toBe("allowed_without_user_prompt");
    expect(gateFor("Add to cart").disposition).toBe("allowed_without_user_prompt");
    expect(gateFor("Next page").disposition).toBe("allowed_without_user_prompt");
  });

  it("blocks final_commit and routes to the purchase-confirmation handoff", () => {
    const g = gateFor("Place order");
    expect(g.disposition).toBe("blocked_by_antigen_platform");
    expect(g.action_intent).toBe("final_commit");
    expect(g.recommended_handoff).toBe("request_purchase_confirmation");
  });

  it("blocks publish_send / account_security / high_liability to sensitive_workflow_required", () => {
    expect(gateFor("Publish").recommended_handoff).toBe("sensitive_workflow_required");
    expect(gateFor("Delete account").recommended_handoff).toBe("sensitive_workflow_required");
    expect(gateFor("Submit application", { url: "https://x/tax-return" }).recommended_handoff).toBe("sensitive_workflow_required");
  });

  it("routes protected fills to platform control (never agent-typed values)", () => {
    const cred = evaluateActionGate(classifyActionIntent({ action: "type", input_type: "password", field_name: "password" }));
    expect(cred.disposition).toBe("platform_control_required");
    expect(cred.recommended_handoff).toBe("request_secret_field_injection");

    const card = evaluateActionGate(classifyActionIntent({ action: "type", autocomplete: "cc-number", field_name: "cardNumber" }));
    expect(card.disposition).toBe("platform_control_required");
    expect(card.recommended_handoff).toBe("request_payment_card_fill");

    const profile = evaluateActionGate(classifyActionIntent({ action: "type", autocomplete: "email" }));
    expect(profile.disposition).toBe("platform_control_required");
    expect(profile.recommended_handoff).toBe("request_profile_field_fill");
  });

  it("fails closed on ambiguous high-risk clicks", () => {
    const g = gateFor("Confirm", { risk_state: "commit_ready" });
    expect(g.disposition).toBe("blocked_by_antigen_platform");
    expect(g.recommended_handoff).toBe("sensitive_workflow_required");
  });

  it("uses fixed canned reason strings (not page-derived)", () => {
    const g = gateFor("Place order");
    expect(typeof g.reason).toBe("string");
    expect(g.reason).not.toContain("Place order"); // reason is keyed by intent, never echoes page text
  });
});
