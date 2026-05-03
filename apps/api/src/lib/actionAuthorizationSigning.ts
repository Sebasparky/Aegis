import { CompactSign, compactVerify, importJWK } from "jose";
import { createHash } from "crypto";
import type { ActionAuthorizationReceipt } from "@aegis/types";
// Reuse receipt signing env keys for v1. TODO: split into dedicated authorization signing keypair.
// Never expose AEGIS_RECEIPT_JWS_PRIVATE_JWK in any response, log, or front-end import.

export interface AuthorizationJwsPayload {
  typ: "aegis.action_authorization.v1";
  authorization_id: string;
  authorization_hash: string;
  issuer: string;
  issued_at: string;
  user_aegis_id: string;
  agent_id: string;
  delegation_id: string;
  run_id: string;
  action_type: string;
  risk_tier: string;
}

// ─── Stable JSON serializer (sorted keys) ────────────────────────────────────

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
 * Hash the immutable fields of an authorization receipt, excluding `status`,
 * `fulfillment`, and `verification`. These three fields are mutable:
 * - `status` changes when the authorization is fulfilled or revoked
 * - `fulfillment` is populated after successful execution
 * - `verification` contains the hash itself (circular)
 * Excluding them ensures the hash stays valid throughout the receipt's lifecycle.
 */
export function hashActionAuthorization(
  auth: Omit<ActionAuthorizationReceipt, "verification">
): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { status: _status, fulfillment: _fulfillment, ...immutable } = auth;
  const stable = JSON.stringify({ authorization_json: immutable }, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ─── Key loading ──────────────────────────────────────────────────────────────

async function loadPrivateKey() {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    throw new Error(
      "[actionAuthorizationSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
        "Run `npm run generate:receipt-keypair` and add the keys to .env."
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

export async function signActionAuthorizationJws(
  payload: AuthorizationJwsPayload
): Promise<string> {
  const privateKey = await loadPrivateKey();
  const encoder = new TextEncoder();
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-action-authorization+jws" })
    .sign(privateKey);
}

export async function verifyActionAuthorizationJws(
  jws: string
): Promise<{ valid: boolean; payload?: AuthorizationJwsPayload; error?: string }> {
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
    ) as AuthorizationJwsPayload;
    return { valid: true, payload: decoded };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "VERIFY_FAILED",
    };
  }
}
