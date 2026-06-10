/**
 * Protected iframe redaction registry — unit tests.
 *
 * The registry records which protected card fields (card_number/cvv) Antigen filled
 * inside a cross-origin OPPWA PCI iframe per browser session, so the screenshot path
 * can redact those iframe regions and fail closed if it cannot locate one. It must
 * store ONLY the field-kind enum per session — never a raw value, URL, or coordinate.
 */

import { describe, it, expect } from "vitest";
import {
  registerProtectedIframeRedaction,
  getProtectedIframeRedactionFields,
  clearProtectedIframeRedactions,
} from "../runtime/protectedIframeRedaction.js";

describe("protectedIframeRedaction registry", () => {
  it("records card_number and cvv for a session and returns both", () => {
    const sid = `tbsess_${Math.random().toString(36).slice(2)}`;
    expect(getProtectedIframeRedactionFields(sid)).toEqual([]);

    registerProtectedIframeRedaction(sid, "card_number", "oppwa");
    registerProtectedIframeRedaction(sid, "cvv", "oppwa");

    const fields = getProtectedIframeRedactionFields(sid);
    expect(fields.sort()).toEqual(["card_number", "cvv"]);
    clearProtectedIframeRedactions(sid);
  });

  it("records the expiry iframe field kind and returns it alongside card_number/cvv", () => {
    const sid = `tbsess_${Math.random().toString(36).slice(2)}`;
    registerProtectedIframeRedaction(sid, "card_number", "oppwa");
    registerProtectedIframeRedaction(sid, "cvv", "oppwa");
    registerProtectedIframeRedaction(sid, "expiry", "oppwa");
    expect(getProtectedIframeRedactionFields(sid).sort()).toEqual(["card_number", "cvv", "expiry"]);
    clearProtectedIframeRedactions(sid);
  });

  it("de-duplicates a repeated field", () => {
    const sid = `tbsess_${Math.random().toString(36).slice(2)}`;
    registerProtectedIframeRedaction(sid, "card_number", "oppwa");
    registerProtectedIframeRedaction(sid, "card_number", "oppwa");
    expect(getProtectedIframeRedactionFields(sid)).toEqual(["card_number"]);
    clearProtectedIframeRedactions(sid);
  });

  it("isolates sessions from one another", () => {
    const a = `tbsess_a_${Math.random().toString(36).slice(2)}`;
    const b = `tbsess_b_${Math.random().toString(36).slice(2)}`;
    registerProtectedIframeRedaction(a, "card_number", "oppwa");
    registerProtectedIframeRedaction(b, "cvv", "oppwa");
    expect(getProtectedIframeRedactionFields(a)).toEqual(["card_number"]);
    expect(getProtectedIframeRedactionFields(b)).toEqual(["cvv"]);
    clearProtectedIframeRedactions(a);
    clearProtectedIframeRedactions(b);
  });

  it("ignores a missing session id and a non-oppwa provider", () => {
    expect(getProtectedIframeRedactionFields("")).toEqual([]);
    registerProtectedIframeRedaction("", "card_number", "oppwa");
    expect(getProtectedIframeRedactionFields("")).toEqual([]);

    const sid = `tbsess_${Math.random().toString(36).slice(2)}`;
    // @ts-expect-error — only "oppwa" is accepted; other providers are not registered.
    registerProtectedIframeRedaction(sid, "card_number", "stripe");
    expect(getProtectedIframeRedactionFields(sid)).toEqual([]);
    clearProtectedIframeRedactions(sid);
  });

  it("clear() removes the session entry", () => {
    const sid = `tbsess_${Math.random().toString(36).slice(2)}`;
    registerProtectedIframeRedaction(sid, "cvv", "oppwa");
    expect(getProtectedIframeRedactionFields(sid)).toEqual(["cvv"]);
    clearProtectedIframeRedactions(sid);
    expect(getProtectedIframeRedactionFields(sid)).toEqual([]);
  });

  it("never retains anything beyond the field-kind enum", () => {
    const sid = `tbsess_${Math.random().toString(36).slice(2)}`;
    registerProtectedIframeRedaction(sid, "card_number", "oppwa");
    registerProtectedIframeRedaction(sid, "cvv", "oppwa");
    const serialized = JSON.stringify(getProtectedIframeRedactionFields(sid));
    expect(serialized).not.toContain("oppwa.com");
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toMatch(/http/);
    clearProtectedIframeRedactions(sid);
  });
});
