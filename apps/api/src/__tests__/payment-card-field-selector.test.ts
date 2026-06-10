/**
 * Payment card parent-page field selector — unit tests.
 *
 * When the agent passes no element_hint, executePaymentCardFillViaCDP resolves the target field
 * with fieldFallbackSelectors(). The previous behaviour ("first text/tel input on the page") mis-
 * targeted on OPPWA checkouts (e.g. IKEA): the cardholder input is the first text input, so an
 * unhinted expiry fill landed on the cardholder field and the real MM/YY control stayed empty
 * (and therefore unredacted in the screenshot — the live 3/4 smoke result).
 *
 * These tests pin the priority order and the guards that keep expiry off the hidden
 * card.expiryMonth/Year inputs.
 */

import { describe, it, expect } from "vitest";
import { fieldFallbackSelectors } from "../runtime/paymentCardFill.js";

describe("fieldFallbackSelectors", () => {
  it("targets the OPPWA expiry widget class first for expiry_combined (not the cardholder)", () => {
    const sels = fieldFallbackSelectors("expiry_combined");
    expect(sels[0]).toBe(".wpwl-control-expiry");
    // The generic 'first input' selector must be the LAST resort, never the first choice.
    expect(sels[sels.length - 1]).toContain('input[type="text"]');
    expect(sels.indexOf(".wpwl-control-expiry")).toBeLessThan(sels.length - 1);
  });

  it("excludes hidden inputs from the expiry name-based fallback (avoids card.expiryMonth/Year)", () => {
    const sels = fieldFallbackSelectors("expiry_combined");
    const nameSel = sels.find((s) => s.includes('name*="expiry"'));
    expect(nameSel).toBeDefined();
    expect(nameSel).toContain(':not([type="hidden"])');
  });

  it("accepts an MM/YY placeholder as an expiry signal", () => {
    const sels = fieldFallbackSelectors("expiry_combined");
    expect(sels.some((s) => /placeholder\*="MM\/YY" i/.test(s))).toBe(true);
  });

  it("targets the cardholder widget class / name first for cardholder_name", () => {
    const sels = fieldFallbackSelectors("cardholder_name");
    expect(sels[0]).toBe(".wpwl-control-cardHolder");
    expect(sels).toContain('input[name="card.holder" i]');
  });

  it("targets card-number and cvv widget classes for the non-iframe fallback path", () => {
    expect(fieldFallbackSelectors("card_number")[0]).toBe(".wpwl-control-cardNumber");
    expect(fieldFallbackSelectors("cvv")[0]).toBe(".wpwl-control-cvv");
  });

  it("keeps billing_zip readable via postal-code signals", () => {
    const sels = fieldFallbackSelectors("billing_zip");
    expect(sels).toContain('input[autocomplete="postal-code"]');
  });

  it("every field's selector list ends with a safe generic input fallback", () => {
    for (const field of [
      "card_number", "cvv", "expiry_combined", "expiry_month", "expiry_year", "cardholder_name", "billing_zip",
    ] as const) {
      const sels = fieldFallbackSelectors(field);
      expect(sels[sels.length - 1]).toBe('input[type="text"],input[type="tel"],input:not([type])');
    }
  });
});
