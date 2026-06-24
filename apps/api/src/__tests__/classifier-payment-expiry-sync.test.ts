/**
 * Guard for the payment-expiry classifier rule in the two synced copies of
 * classifySensitivity (agentSafeObservation.ts + antigenSnapshotRuntime.ts).
 *
 * The bug: the original rule only tested the autocomplete attribute
 * (`/cc-exp/.test(ac)`), so expiry fields named `expiry_month` / `exp_date` without
 * `autocomplete="cc-exp"` fell through to sensitive:false and were typed through the
 * runtime. The fix broadens the rule to test the combined name/id/autocomplete/
 * placeholder string. The classifier runs page-side (a JS-string IIFE), so we extract
 * the actual regex literal from source and exercise it directly — this also locks the
 * two copies in sync (the in-file comment requires identical logic).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(here, "../runtime/antigenSnapshotRuntime.ts");
const OBSERVATION = join(here, "../runtime/agentSafeObservation.ts");

// Pull the payment-expiry regex source out of the `... return 'payment'` line that
// begins with the cc-exp alternation, from a given source file.
function extractExpiryPattern(filePath: string): string {
  const src = readFileSync(filePath, "utf8");
  const m = src.match(/\/(cc-exp[^/]*)\/\.test\(combined\)\)\s*return\s*'payment'/);
  if (!m) throw new Error(`Could not find the payment-expiry classifier rule in ${filePath}`);
  return m[1];
}

describe("payment-expiry classifier rule", () => {
  const runtimePattern = extractExpiryPattern(RUNTIME);
  const observationPattern = extractExpiryPattern(OBSERVATION);

  it("is identical across the two synced copies", () => {
    expect(runtimePattern).toBe(observationPattern);
  });

  it("matches expiry fields by name/id (not just autocomplete=cc-exp)", () => {
    const re = new RegExp(runtimePattern);
    for (const name of [
      "cc-exp",
      "expiry_month",
      "expiry_year",
      "exp_date",
      "exp-date",
      "expiration date",
      "card_expiry",
      "expires",
    ]) {
      expect(re.test(` ${name} `.toLowerCase())).toBe(true);
    }
  });

  it("does not fire on common non-payment fields", () => {
    const re = new RegExp(runtimePattern);
    for (const name of ["first name", "last name", "email address", "search products", "phone"]) {
      expect(re.test(` ${name} `.toLowerCase())).toBe(false);
    }
  });
});
