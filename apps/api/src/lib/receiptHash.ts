import { createHash } from "crypto";
import type { RouteRunReceipt } from "@aegis/types";

// SHA-256 of stable (sorted-key) JSON for tamper-evidence fingerprinting.
// Two receipts with the same field values produce the same hash regardless of
// JS object insertion order. Stored in aegis_receipts.receipt_hash at insert time.
export function hashReceipt(receipt: RouteRunReceipt): string {
  const stable = JSON.stringify(receipt, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (value as Record<string, unknown>)[k];
        return acc;
      }, {});
  }
  return value;
}
