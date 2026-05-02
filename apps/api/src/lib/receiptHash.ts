import { createHash } from "crypto";
import type { RouteRunReceipt } from "@aegis/types";

// SHA-256 of stable (sorted-key) JSON for tamper-evidence fingerprinting.
// Wraps { previous_receipt_hash, receipt_json } so the hash chain is included.
// Two calls with the same receipt and previous hash always produce the same result.
export function hashReceipt(
  receipt: RouteRunReceipt,
  previousReceiptHash?: string | null
): string {
  const payload = {
    previous_receipt_hash: previousReceiptHash ?? null,
    receipt_json: receipt,
  };
  const stable = JSON.stringify(payload, sortedReplacer);
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
