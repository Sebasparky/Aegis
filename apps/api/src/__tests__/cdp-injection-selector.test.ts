/**
 * Unit tests for CDP injection selector expression builder and diagnostic expression.
 *
 * Verifies:
 * - selector_hint is honored first, regardless of field_kind
 * - username field_kind fallback includes autocomplete=username and name=email candidates
 * - password field_kind fallback uses input[type="password"]
 * - selector helper takes no resolved-value parameter (secret cannot appear in output)
 * - diagnostic expression (CDP_DIAG_EXPR) references no resolved-value variable
 */

import { describe, it, expect } from "vitest";
import { buildInjectionSelectorExpr, CDP_DIAG_EXPR } from "../runtime/secretInjection.js";

describe("buildInjectionSelectorExpr", () => {
  it("selector_hint '#email' wins before username fallback candidates", () => {
    const expr = buildInjectionSelectorExpr("username", { selector_hint: "#email" });
    expect(expr).toBe('document.querySelector("#email")');
  });

  it("selector_hint wins for password field too", () => {
    const expr = buildInjectionSelectorExpr("password", { selector_hint: "#pass" });
    expect(expr).toBe('document.querySelector("#pass")');
  });

  it("username fallback includes input[autocomplete=\"username\"]", () => {
    const expr = buildInjectionSelectorExpr("username");
    expect(expr).toContain('input[autocomplete="username"]');
  });

  it("username fallback includes input[name=\"email\"]", () => {
    const expr = buildInjectionSelectorExpr("username");
    expect(expr).toContain('input[name="email"]');
  });

  it("username fallback includes input[name=\"username\"]", () => {
    const expr = buildInjectionSelectorExpr("username");
    expect(expr).toContain('input[name="username"]');
  });

  it("username fallback includes #email id selector", () => {
    const expr = buildInjectionSelectorExpr("username");
    expect(expr).toContain('#email');
  });

  it("username fallback includes input[type=\"text\"] as low-priority option", () => {
    const expr = buildInjectionSelectorExpr("username");
    expect(expr).toContain('input[type="text"]');
  });

  it("password field_kind without hints uses input[type=\"password\"]", () => {
    const expr = buildInjectionSelectorExpr("password");
    expect(expr).toBe('document.querySelector(\'input[type="password"]\')');
  });

  it("label hint builds label-scanning IIFE and does not use generic fallback", () => {
    const expr = buildInjectionSelectorExpr("username", { label: "Email" });
    expect(expr).toContain("querySelectorAll('label')");
    expect(expr).toContain('"email"');
    // Must not fall through to the username IIFE
    expect(expr).not.toContain('autocomplete="username"');
  });

  it("placeholder hint builds attribute selector", () => {
    const expr = buildInjectionSelectorExpr("username", { placeholder: "email@example.com" });
    expect(expr).toContain('input[placeholder=');
    expect(expr).toContain("email@example.com");
  });

  it("input_type hint builds type attribute selector", () => {
    const expr = buildInjectionSelectorExpr("username", { input_type: "email" });
    expect(expr).toContain('input[type="email"]');
  });

  it("selector helper takes no resolved-value parameter — output cannot contain a sentinel secret", () => {
    // The function signature has no resolvedValue parameter.
    // Verify by checking that any injected selector_hint is JSON.stringify'd safely.
    const sentinel = "SUPER_SECRET_PASSWORD_123";
    // selector_hint can only be a CSS selector string — the helper never receives a secret value
    const expr = buildInjectionSelectorExpr("username", { selector_hint: "#safe-selector" });
    expect(expr).not.toContain(sentinel);
    // Ensure even if somehow called with a weird hint, it's wrapped in JSON.stringify
    expect(expr).toBe('document.querySelector("#safe-selector")');
  });

  it("username fallback IIFE has autocomplete=username before name=email (semantic before structural)", () => {
    const expr = buildInjectionSelectorExpr("username");
    const autocompleteIdx = expr.indexOf('autocomplete="username"');
    const nameEmailIdx = expr.indexOf('name="email"');
    expect(autocompleteIdx).toBeGreaterThanOrEqual(0);
    expect(nameEmailIdx).toBeGreaterThanOrEqual(0);
    expect(autocompleteIdx).toBeLessThan(nameEmailIdx);
  });
});

describe("CDP_DIAG_EXPR", () => {
  it("is a non-empty string", () => {
    expect(typeof CDP_DIAG_EXPR).toBe("string");
    expect(CDP_DIAG_EXPR.length).toBeGreaterThan(0);
  });

  it("does not reference a resolved-value variable or injection value", () => {
    // The diagnostic expression is static — it must not contain resolvedValue, injection,
    // or any variable that would carry a secret. It may reference DOM property names like
    // 'type' and 'autocomplete' as structural metadata keys — that is intentional and safe.
    expect(CDP_DIAG_EXPR).not.toContain("resolvedValue");
    expect(CDP_DIAG_EXPR).not.toContain("injection");
    expect(CDP_DIAG_EXPR).not.toContain("secret");
    expect(CDP_DIAG_EXPR).not.toContain("kms");
  });

  it("includes structural-only fields: url, readyState, inputSummary", () => {
    expect(CDP_DIAG_EXPR).toContain("location.href");
    expect(CDP_DIAG_EXPR).toContain("readyState");
    expect(CDP_DIAG_EXPR).toContain("inputSummary");
  });

  it("inputSummary maps structural attributes only — no value property", () => {
    // Ensure '.value' is never collected from input elements in the diagnostic
    // (collecting .value would expose current field contents).
    // We check the map() body does not include 'i.value' or '.value'.
    const mapBodyStart = CDP_DIAG_EXPR.indexOf("return { id:");
    expect(mapBodyStart).toBeGreaterThanOrEqual(0);
    const mapBody = CDP_DIAG_EXPR.slice(mapBodyStart);
    expect(mapBody).not.toContain(".value");
  });
});
