import { CompactSign, compactVerify, importJWK } from "jose";
import { createHash } from "crypto";
import type { DelegationPassport } from "@aegis/types";
// Reuse receipt signing env keys for v1. TODO: split into dedicated passport signing keypair.
// Never expose AEGIS_RECEIPT_JWS_PRIVATE_JWK in any response, log, or front-end import.
export { UnsignedDevModeError } from "./receiptSigning.js";

export interface PassportJwsPayload {
  typ: "aegis.delegation_passport.v1";
  passport_id: string;
  passport_hash: string;
  issuer: string;
  issued_at: string;
  expires_at: string;
  user_aegis_id: string;
  // agent_id is delegation.agent_name — a temporary fallback.
  // TODO: replace with a stable AgentDelegation.agent_id field when the model is extended.
  agent_id: string;
  delegation_id: string;
  collar_id?: string;
}

// ─── Stable JSON serializer (sorted keys, no secrets) ────────────────────────

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      )
    );
  }
  return value;
}

/**
 * Hash the immutable fields of a passport, excluding `verification` and `status`.
 * `status` is excluded because it is mutable (revocation updates it in-place) and
 * must not invalidate the hash of the underlying delegation content.
 * Revocation is checked separately via the `status` field and the JWS expiry claim.
 */
export function hashDelegationPassport(
  passport: Omit<DelegationPassport, "verification">
): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { status: _status, ...immutable } = passport;
  const stable = JSON.stringify({ passport_json: immutable }, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ─── Key loading (lazy, no import-time errors) ────────────────────────────────

async function loadPrivateKey() {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    if (process.env.AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV === "true") {
      // Import and re-throw so callers see UnsignedDevModeError specifically.
      const { UnsignedDevModeError: Err } = await import("./receiptSigning.js");
      throw new Err();
    }
    throw new Error(
      "[delegationPassportSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
        "Run `npm run generate:receipt-keypair` and add the keys to .env, " +
        "or set AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV=true for unsigned dev mode."
    );
  }
  return importJWK(JSON.parse(raw), "EdDSA");
}

async function loadPublicKey() {
  const raw = process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK;
  if (!raw) return null;
  return importJWK(JSON.parse(raw), "EdDSA");
}

// ─── Sign / Verify ────────────────────────────────────────────────────────────

export async function signDelegationPassportJws(
  payload: PassportJwsPayload
): Promise<string> {
  const privateKey = await loadPrivateKey();
  const encoder = new TextEncoder();
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-delegation-passport+jws" })
    .sign(privateKey);
}

export async function verifyDelegationPassportJws(
  jws: string
): Promise<{ valid: boolean; payload?: PassportJwsPayload; error?: string }> {
  const publicKey = await loadPublicKey();
  if (!publicKey) {
    return { valid: false, error: "SIGNING_NOT_CONFIGURED" };
  }
  try {
    const { payload: payloadBytes } = await compactVerify(jws, publicKey, {
      algorithms: ["EdDSA"],
    });
    const decoded = JSON.parse(
      new TextDecoder().decode(payloadBytes)
    ) as PassportJwsPayload;
    return { valid: true, payload: decoded };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "VERIFY_FAILED",
    };
  }
}
