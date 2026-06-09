/**
 * Protected profile fill — value formatting + select-option matching unit tests.
 *
 * Covers the fix for the live IKEA checkout regression:
 *  - the country-code-inclusive canonical phone ("15551234567") must be formatted to a
 *    field-acceptable national form, never the shifted "+1-155-512-3456",
 *  - <select> region matching resolves MI / Michigan / US-MI to the same option.
 *
 * Pure unit tests — no browser, no CDP, no KMS. The formatter never receives or returns
 * a value to the agent; these assert the transformation only.
 */

import { describe, it, expect } from "vitest";
import {
  formatProfileValueForTarget,
  findBestSelectOption,
  type TargetFieldMeta,
} from "../runtime/profileFieldFill.js";

const tel = (over: Partial<TargetFieldMeta> = {}): TargetFieldMeta => ({
  type: "tel",
  autocomplete: "tel",
  placeholder: "",
  maxlength: null,
  pattern: null,
  ...over,
});

describe("formatProfileValueForTarget — phone", () => {
  const CANONICAL = "15551234567"; // 1 (country code) + 5551234567

  it("strips the US country code and defaults to bare national digits", () => {
    expect(formatProfileValueForTarget("phone", CANONICAL, tel())).toBe("5551234567");
  });

  it("NEVER produces the shifted +1-155-512-3456 corruption for any US tel metadata", () => {
    const metas: TargetFieldMeta[] = [
      tel(),
      tel({ placeholder: "(555) 123-4567" }),
      tel({ placeholder: "555-123-4567" }),
      tel({ placeholder: "+1-___-___-____" }),
      tel({ maxlength: 10 }),
      tel({ pattern: "\\d{10}" }),
      tel({ autocomplete: "tel-national" }),
      tel({ autocomplete: "tel-local" }),
    ];
    for (const m of metas) {
      expect(formatProfileValueForTarget("phone", CANONICAL, m)).not.toBe("+1-155-512-3456");
    }
  });

  it("leaves an already-national 10-digit number unchanged (bare default)", () => {
    expect(formatProfileValueForTarget("phone", "5551234567", tel())).toBe("5551234567");
  });

  it("renders a paren mask as (NNN) NNN-NNNN", () => {
    expect(formatProfileValueForTarget("phone", CANONICAL, tel({ placeholder: "(555) 123-4567" }))).toBe(
      "(555) 123-4567",
    );
  });

  it("renders a dash mask as NNN-NNN-NNNN", () => {
    expect(formatProfileValueForTarget("phone", CANONICAL, tel({ placeholder: "555-123-4567" }))).toBe(
      "555-123-4567",
    );
  });

  it("renders a dot mask as NNN.NNN.NNNN", () => {
    expect(formatProfileValueForTarget("phone", CANONICAL, tel({ placeholder: "555.123.4567" }))).toBe(
      "555.123.4567",
    );
  });

  it("uses international +1 form only on an explicit '+' mask/pattern signal", () => {
    expect(formatProfileValueForTarget("phone", CANONICAL, tel({ placeholder: "+1 555 555 5555" }))).toBe(
      "+15551234567",
    );
    expect(formatProfileValueForTarget("phone", CANONICAL, tel({ pattern: "\\+\\d{11}" }))).toBe(
      "+15551234567",
    );
  });

  it("bare maxlength=10 field gets bare national digits", () => {
    expect(formatProfileValueForTarget("phone", CANONICAL, tel({ maxlength: 10 }))).toBe("5551234567");
  });

  it("returns empty/garbage canonical untouched", () => {
    expect(formatProfileValueForTarget("phone", "", tel())).toBe("");
  });
});

describe("formatProfileValueForTarget — non-phone kinds pass through unchanged", () => {
  const meta = tel();
  it("first_name passthrough", () => {
    expect(formatProfileValueForTarget("first_name", "Marie", meta)).toBe("Marie");
  });
  it("region passthrough (select matching handles aliasing)", () => {
    expect(formatProfileValueForTarget("region", "MI", meta)).toBe("MI");
  });
  it("postal_code passthrough", () => {
    expect(formatProfileValueForTarget("postal_code", "48104", meta)).toBe("48104");
  });
});

describe("findBestSelectOption — region matching", () => {
  const STATE_OPTS = [
    { value: "", text: "Select a state" },
    { value: "MI", text: "Michigan" },
    { value: "OH", text: "Ohio" },
    { value: "CA", text: "California" },
  ];

  it("matches by exact option value", () => {
    expect(findBestSelectOption(STATE_OPTS, "MI")).toBe("MI");
  });

  it("matches by exact visible label", () => {
    expect(findBestSelectOption(STATE_OPTS, "Michigan")).toBe("MI");
  });

  it("maps full name Michigan to the MI option value", () => {
    expect(findBestSelectOption(STATE_OPTS, "michigan")).toBe("MI");
  });

  it("strips an ISO US- prefix (US-MI → Michigan option)", () => {
    expect(findBestSelectOption(STATE_OPTS, "US-MI")).toBe("MI");
  });

  it("matches a select whose option values are full names", () => {
    const fullNameOpts = [
      { value: "", text: "Select" },
      { value: "Michigan", text: "Michigan" },
      { value: "Ohio", text: "Ohio" },
    ];
    expect(findBestSelectOption(fullNameOpts, "MI")).toBe("Michigan");
  });

  it("returns null when no option matches", () => {
    expect(findBestSelectOption(STATE_OPTS, "ZZ")).toBeNull();
  });
});
