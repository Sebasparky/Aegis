/**
 * Verify-and-correct comparison — unit tests.
 *
 * Page-prefilled values (autofill/cookies/site defaults) are untrusted: the protected
 * profile fill primitive compares the existing value against the protected value under
 * conservative field-aware normalization, and overwrites on mismatch. These tests pin:
 *
 *  - the live IKEA bug: prefilled city "Taylor" must NOT compare equal to "Ann Arbor",
 *  - matching values under trim / internal-whitespace / case differences ARE equal,
 *  - phone compares national digits (formatted mask renderings compare equal),
 *  - addresses are NOT over-normalized (St ≠ Street),
 *  - region/country alias through state/country code maps (Michigan ≡ MI ≡ US-MI),
 *  - empty current values never match (empty → normal fill, not already_correct).
 */

import { describe, it, expect } from "vitest";
import {
  normalizeProfileValueForComparison,
  profileValuesMatch,
} from "../runtime/profileFieldFill.js";

describe("normalizeProfileValueForComparison", () => {
  it("trims, collapses internal whitespace, and lowercases text kinds", () => {
    expect(normalizeProfileValueForComparison("city", "  ann   ARBOR ")).toBe("ann arbor");
    expect(normalizeProfileValueForComparison("first_name", " Ada ")).toBe("ada");
  });

  it("phone normalizes to national digits (strips US country code)", () => {
    expect(normalizeProfileValueForComparison("phone", "(555) 123-4567")).toBe("5551234567");
    expect(normalizeProfileValueForComparison("phone", "+1-555-123-4567")).toBe("5551234567");
    expect(normalizeProfileValueForComparison("phone", "15551234567")).toBe("5551234567");
    expect(normalizeProfileValueForComparison("phone", "5551234567")).toBe("5551234567");
  });

  it("postal codes compare uppercased, whitespace-collapsed", () => {
    expect(normalizeProfileValueForComparison("postal_code", " 48104 ")).toBe("48104");
    expect(normalizeProfileValueForComparison("postal_code", "m5v 3l9")).toBe("M5V 3L9");
  });

  it("does NOT over-normalize addresses — St and Street stay different", () => {
    expect(normalizeProfileValueForComparison("shipping_address_line1", "10 Downing St")).not.toBe(
      normalizeProfileValueForComparison("shipping_address_line1", "10 Downing Street"),
    );
  });
});

describe("profileValuesMatch", () => {
  it("the IKEA bug: prefilled 'Taylor' does NOT match expected 'Ann Arbor'", () => {
    expect(profileValuesMatch("city", "Taylor", "Ann Arbor", "Ann Arbor")).toBe(false);
  });

  it("matching city under case/whitespace differences IS already correct", () => {
    expect(profileValuesMatch("city", "  ann  ARBOR ", "Ann Arbor", "Ann Arbor")).toBe(true);
  });

  it("empty current value never matches (empty fields get a normal fill)", () => {
    expect(profileValuesMatch("city", "", "Ann Arbor", "Ann Arbor")).toBe(false);
    expect(profileValuesMatch("city", "   ", "Ann Arbor", "Ann Arbor")).toBe(false);
  });

  it("formatted-equivalent phone matches the canonical value", () => {
    // Canonical seed is country-code-inclusive; the field may render a national mask.
    expect(profileValuesMatch("phone", "(555) 123-4567", "15551234567", "5551234567")).toBe(true);
    expect(profileValuesMatch("phone", "555-123-4567", "15551234567", "(555) 123-4567")).toBe(true);
  });

  it("wrong phone digits do NOT match", () => {
    expect(profileValuesMatch("phone", "(555) 999-0000", "15551234567", "5551234567")).toBe(false);
  });

  it("matches against the field-formatted candidate as well as the canonical", () => {
    expect(profileValuesMatch("phone", "5551234567", "15551234567", "5551234567")).toBe(true);
  });

  it("region aliases through the state map: Michigan ≡ MI ≡ US-MI", () => {
    expect(profileValuesMatch("region", "Michigan", "MI", "MI")).toBe(true);
    expect(profileValuesMatch("region", "MI", "US-MI", "US-MI")).toBe(true);
    expect(profileValuesMatch("region", "Ohio", "MI", "MI")).toBe(false);
  });

  it("country aliases through the country map: United States ≡ US", () => {
    expect(profileValuesMatch("country", "United States", "US", "US")).toBe(true);
    expect(profileValuesMatch("country", "Canada", "US", "US")).toBe(false);
  });

  it("different addresses never compare equal", () => {
    expect(
      profileValuesMatch("shipping_address_line1", "12 Oak Ave", "10 Downing St", "10 Downing St"),
    ).toBe(false);
    expect(
      profileValuesMatch("shipping_address_line1", "10 Downing Street", "10 Downing St", "10 Downing St"),
    ).toBe(false);
  });
});
