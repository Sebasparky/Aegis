/**
 * Unit tests for the generic, site-agnostic capability-state classifier.
 * Structural metadata only — no field values. No site names.
 */
import { describe, it, expect } from "vitest";
import { classifyActionIntent } from "../detection/actionIntent.js";

describe("classifyActionIntent — clicks", () => {
  const click = (text: string, extra = {}) =>
    classifyActionIntent({ action: "click", text, kind: "button", ...extra });

  it("classifies final purchase/payment commitments as final_commit (final)", () => {
    for (const label of [
      "Place order",
      "Place Order — $42.99",
      "Pay now",
      "Pay $12.99",
      "Pay",
      "Confirm purchase",
      "Confirm order",
      "Complete purchase",
      "Submit payment",
      "Buy now",
    ]) {
      const c = click(label);
      expect(c.action_intent, label).toBe("final_commit");
      expect(c.reversibility, label).toBe("final");
    }
  });

  it("classifies subscribe as final_commit ONLY with monetary/paid-plan signals", () => {
    // Paid subscription signals → final_commit.
    expect(click("Subscribe for $9.99/mo").action_intent).toBe("final_commit");
    expect(click("Start paid subscription").action_intent).toBe("final_commit");
    expect(classifyActionIntent({ action: "click", text: "Subscribe", kind: "button", context: { section: "Billing — 7-day trial then renews monthly" } }).action_intent).toBe("final_commit");
    // Bare newsletter/update subscribe → NOT final_commit.
    expect(click("Subscribe").action_intent).not.toBe("final_commit");
    expect(classifyActionIntent({ action: "click", text: "Subscribe", kind: "button", context: { section: "Get our weekly newsletter" } }).action_intent).not.toBe("final_commit");
    expect(click("Subscribe to updates").action_intent).not.toBe("final_commit");
  });

  it("keeps checkout transitions reversible (NOT final)", () => {
    for (const label of ["Continue to checkout", "Proceed to checkout", "Go to checkout", "Checkout"]) {
      const c = click(label);
      expect(c.action_intent, label).toBe("checkout_transition");
      expect(c.reversibility, label).toBe("reversible");
    }
  });

  it("keeps cart mutations reversible", () => {
    for (const label of ["Add to cart", "Add to bag", "Remove from cart", "Update quantity", "Save for later"]) {
      const c = click(label);
      expect(c.action_intent, label).toBe("cart_mutation");
      expect(c.reversibility, label).toBe("reversible");
    }
  });

  it("classifies publish/send under identity as publish_send", () => {
    for (const label of ["Publish", "Post", "Tweet", "Send", "Send message"]) {
      const c = click(label);
      expect(c.action_intent, label).toBe("publish_send");
      expect(c.reversibility, label).toBe("final");
    }
  });

  it("classifies account/security changes", () => {
    for (const label of ["Change password", "Delete account", "Disable 2FA", "Authorize", "Connect GitHub"]) {
      const c = click(label);
      expect(c.action_intent, label).toBe("account_security_change");
    }
  });

  it("classifies high-liability submits only with risky context", () => {
    expect(classifyActionIntent({ action: "click", text: "Submit application", kind: "button", url: "https://x/loan-application" }).action_intent).toBe("high_liability_submit");
    expect(classifyActionIntent({ action: "click", text: "I agree", kind: "button", context: { section: "Consent & disclosure" } }).action_intent).toBe("high_liability_submit");
    // Bare submit with no high-liability context is NOT flagged.
    expect(click("Submit").action_intent).not.toBe("high_liability_submit");
  });

  it("treats plain navigation as reversible and allowed", () => {
    expect(click("Next page").action_intent).toBe("navigation");
    expect(classifyActionIntent({ action: "click", text: "Workspace desks", kind: "link", href_path: "/cat/desks" }).action_intent).toBe("navigation");
  });

  it("fails closed: a generic commit-shaped button near a commitment is uncertain", () => {
    const c = click("Continue", { risk_state: "final_review" });
    expect(c.reversibility).toBe("uncertain");
    expect(c.confidence).toBe("low");
  });

  it("does not over-block a generic 'Continue' with no risky state/context", () => {
    expect(click("Continue").action_intent).toBe("navigation");
  });
});

describe("classifyActionIntent — type", () => {
  const type = (extra: object) => classifyActionIntent({ action: "type", ...extra });

  it("classifies password/credential fields as protected_fill (credential)", () => {
    const c = type({ input_type: "password", field_name: "password" });
    expect(c.action_intent).toBe("protected_fill");
    expect(c.signals).toContain("credential_field");
  });

  it("classifies card fields as payment_method_use", () => {
    expect(type({ autocomplete: "cc-number", field_name: "cardNumber" }).action_intent).toBe("payment_method_use");
    expect(type({ field_name: "cvv" }).action_intent).toBe("payment_method_use");
  });

  it("classifies contact/identity fields as protected_fill (profile)", () => {
    for (const f of [{ autocomplete: "email" }, { field_name: "phone" }, { autocomplete: "street-address" }]) {
      const c = type(f);
      expect(c.action_intent, JSON.stringify(f)).toBe("protected_fill");
      expect(c.signals, JSON.stringify(f)).toContain("profile_field");
    }
  });

  it("treats a plain text field as benign", () => {
    expect(type({ field_name: "search", placeholder: "Search products" }).action_intent).toBe("navigation");
  });
});
