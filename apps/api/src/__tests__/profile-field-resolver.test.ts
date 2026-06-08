/**
 * Checkout Profile Field Fill v1 — semantic resolver unit tests.
 *
 * Proves the profile-field-fill executor's field resolution is stronger than a brittle id-based
 * selector / generic browser_type on hydrated checkout pages:
 *  - resolves a field by stable autocomplete even when the element id is randomized
 *  - honours an agent selector_hint, but recovers semantically when the hint is stale
 *  - fails closed (KIND_MISMATCH) when the only match declares a different field kind
 *  - fails closed (NO_CONFIDENT_MATCH) on ambiguous ties
 *
 * Pure functions — no DOM, no CDP, no store. The in-page enumeration that produces these
 * descriptors is exercised separately via the live IKEA / hydrated-checkout QA.
 */

import { describe, it, expect } from "vitest";
import {
  pickProfileFieldCandidate,
  verifyKindConsistency,
  type ProfileFieldCandidate,
} from "../runtime/profileFieldFill.js";

function cand(p: Partial<ProfileFieldCandidate>): ProfileFieldCandidate {
  return {
    fill_id: "f0",
    tag: "input",
    type: "text",
    name: "",
    id: "",
    autocomplete: "",
    placeholder: "",
    label_text: "",
    aria_label: "",
    section_text: "",
    ...p,
  };
}

describe("pickProfileFieldCandidate — semantic resolution", () => {
  it("resolves email by stable autocomplete even when the id is randomized", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", id: "field_x9f31a", type: "text", autocomplete: "email", name: "" }),
      cand({ fill_id: "agfill_1", id: "field_b22kk0", type: "text", autocomplete: "tel", name: "" }),
    ];
    const res = pickProfileFieldCandidate("email", candidates, {});
    expect(res.fill_id).toBe("agfill_0");
    expect(res.strategy).toBe("autocomplete");
  });

  it("distinguishes shipping address line1 from line2 by autocomplete", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", id: "a_77", autocomplete: "shipping address-line1" }),
      cand({ fill_id: "agfill_1", id: "a_88", autocomplete: "shipping address-line2" }),
    ];
    expect(pickProfileFieldCandidate("shipping_address_line1", candidates, {}).fill_id).toBe("agfill_0");
    expect(pickProfileFieldCandidate("shipping_address_line2", candidates, {}).fill_id).toBe("agfill_1");
  });

  it("resolves address line1 to the primary 'Street address' when a 'Street address 2 (optional)' sibling is present (label-only, no autocomplete)", () => {
    // Mirrors the live IKEA shape: both fields share 'Street address' label, ids randomized,
    // no distinguishing autocomplete. Line-2 indicator on the optional field breaks the tie.
    const candidates = [
      cand({ fill_id: "agfill_0", id: "field_a1b2", name: "address1", label_text: "street address" }),
      cand({ fill_id: "agfill_1", id: "field_c3d4", name: "address2", label_text: "street address 2 (optional)" }),
    ];
    const res = pickProfileFieldCandidate("shipping_address_line1", candidates, {});
    expect(res.fill_id).toBe("agfill_0");
  });

  it("resolves address line2 to the 'Street address 2 (optional)' sibling in that same label-only fixture", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", id: "field_a1b2", name: "address1", label_text: "street address" }),
      cand({ fill_id: "agfill_1", id: "field_c3d4", name: "address2", label_text: "street address 2 (optional)" }),
    ];
    const res = pickProfileFieldCandidate("shipping_address_line2", candidates, {});
    expect(res.fill_id).toBe("agfill_1");
  });

  it("fails closed (NO_CONFIDENT_MATCH) for line1 when the only address-like field is 'Street address 2 (optional)'", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", id: "field_c3d4", name: "address2", label_text: "street address 2 (optional)" }),
    ];
    const res = pickProfileFieldCandidate("shipping_address_line1", candidates, {});
    expect(res.fill_id).toBeNull();
    expect(res.reason).toBe("NO_CONFIDENT_MATCH");
  });

  it("fails closed for line2 when only a bare 'Street address' field exists (deliberate: do not steal the primary line when no line-2 field is present)", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", id: "field_a1b2", name: "address1", label_text: "street address" }),
    ];
    const res = pickProfileFieldCandidate("shipping_address_line2", candidates, {});
    expect(res.fill_id).toBeNull();
    expect(res.reason).toBe("NO_CONFIDENT_MATCH");
  });

  it("honours a selector_hint that uniquely matches a candidate id", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", id: "first", autocomplete: "given-name" }),
      cand({ fill_id: "agfill_1", id: "last", autocomplete: "family-name" }),
    ];
    const res = pickProfileFieldCandidate("last_name", candidates, { selector_hint: "#last" });
    expect(res.fill_id).toBe("agfill_1");
    expect(res.strategy).toBe("selector_hint");
  });

  it("recovers semantically when the provided selector_hint is stale (no id match)", () => {
    // Hint targets an id that no longer exists after re-render, but autocomplete is stable.
    const candidates = [
      cand({ fill_id: "agfill_0", id: "phone_regenerated_id", autocomplete: "tel" }),
    ];
    const res = pickProfileFieldCandidate("phone", candidates, { selector_hint: "#phone_old_id" });
    expect(res.fill_id).toBe("agfill_0");
    expect(res.strategy).toBe("autocomplete");
  });

  it("resolves by name/id keyword when there is no autocomplete or label", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", name: "zip", id: "" }),
      cand({ fill_id: "agfill_1", name: "addr", id: "" }),
    ];
    const res = pickProfileFieldCandidate("postal_code", candidates, {});
    expect(res.fill_id).toBe("agfill_0");
    expect(res.strategy).toBe("name_id");
  });

  it("prefers an agent-provided label hint over generic kind keywords", () => {
    const candidates = [
      cand({ fill_id: "agfill_0", label_text: "billing email" }),
      cand({ fill_id: "agfill_1", label_text: "contact email for delivery updates" }),
    ];
    const res = pickProfileFieldCandidate("email", candidates, { label: "contact email" });
    expect(res.fill_id).toBe("agfill_1");
    expect(res.strategy).toBe("hint_label");
  });

  it("fails closed with KIND_MISMATCH when the only hint match is a different kind", () => {
    // selector_hint points at a phone field, but the requested kind is email.
    const candidates = [
      cand({ fill_id: "agfill_0", id: "contact", autocomplete: "tel", type: "tel" }),
    ];
    const res = pickProfileFieldCandidate("email", candidates, { selector_hint: "#contact" });
    expect(res.fill_id).toBeNull();
    expect(res.reason).toBe("KIND_MISMATCH");
  });

  it("fails closed with KIND_MISMATCH when the top semantic match declares another kind", () => {
    // A field labelled 'Email' but actually autocomplete=tel must not be filled with an email.
    const candidates = [
      cand({ fill_id: "agfill_0", label_text: "email", autocomplete: "tel", type: "tel" }),
    ];
    const res = pickProfileFieldCandidate("email", candidates, {});
    expect(res.fill_id).toBeNull();
    expect(res.reason).toBe("KIND_MISMATCH");
  });

  it("fails closed with NO_CONFIDENT_MATCH on an ambiguous tie", () => {
    // Two indistinguishable candidates both weakly match first_name at the same tier.
    const candidates = [
      cand({ fill_id: "agfill_0", label_text: "first name" }),
      cand({ fill_id: "agfill_1", label_text: "first name" }),
    ];
    const res = pickProfileFieldCandidate("first_name", candidates, {});
    expect(res.fill_id).toBeNull();
    expect(res.reason).toBe("NO_CONFIDENT_MATCH");
  });

  it("fails closed with NO_CONFIDENT_MATCH when nothing matches", () => {
    const candidates = [cand({ fill_id: "agfill_0", label_text: "promo code", name: "promo" })];
    const res = pickProfileFieldCandidate("email", candidates, {});
    expect(res.fill_id).toBeNull();
    expect(res.reason).toBe("NO_CONFIDENT_MATCH");
  });

  it("returns NO_CONFIDENT_MATCH for an empty candidate list", () => {
    const res = pickProfileFieldCandidate("city", [], {});
    expect(res.fill_id).toBeNull();
    expect(res.reason).toBe("NO_CONFIDENT_MATCH");
  });
});

describe("verifyKindConsistency", () => {
  it("accepts a generic text input with no conflicting signals", () => {
    expect(verifyKindConsistency("city", cand({ label_text: "city" })).ok).toBe(true);
  });

  it("accepts an email kind on an email-typed input", () => {
    expect(verifyKindConsistency("email", cand({ type: "email", autocomplete: "email" })).ok).toBe(true);
  });

  it("rejects a postal_code request against a tel autocomplete", () => {
    const v = verifyKindConsistency("postal_code", cand({ autocomplete: "tel" }));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("autocomplete=tel");
  });

  it("rejects an email request against a tel-typed input", () => {
    const v = verifyKindConsistency("email", cand({ type: "tel" }));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("type=tel");
  });

  it("rejects line1 against an address-line2 autocomplete", () => {
    const v = verifyKindConsistency("shipping_address_line1", cand({ autocomplete: "address-line2" }));
    expect(v.ok).toBe(false);
  });

  it("strips section prefixes from autocomplete before family lookup", () => {
    expect(verifyKindConsistency("shipping_address_line1", cand({ autocomplete: "shipping address-line1" })).ok).toBe(true);
  });
});
