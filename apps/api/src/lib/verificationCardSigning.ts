import { CompactSign, compactVerify, importJWK } from "jose";
import { createHash } from "crypto";
import type { VerificationCard } from "@aegis/types";
// Reuses AEGIS_RECEIPT_JWS_PRIVATE_JWK / PUBLIC_JWK keypair.
// TODO: split into a dedicated verification signing keypair.
// Never expose these env vars in any response, log, or front-end import.

export interface VerificationCardJwsPayload {
  typ: "aegis.verification_card.v1";
  card_id: string;
  card_hash: string;
  issuer: string;
  issued_at: string;
  user_id: string;
}

export interface VerificationCardVerificationResult {
  hash_valid: boolean;
  signature_valid: boolean;
  error?: string;
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
 * Hash the immutable fields of a VerificationCard, excluding `verification` and
 * `revocation_status`. `revocation_status` is excluded because it is mutable —
 * revocation must not invalidate the signed content of the card's claims.
 */
export function hashVerificationCard(
  card: Omit<VerificationCard, "verification">
): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { revocation_status: _rev, ...immutable } = card;
  const stable = JSON.stringify({ card_json: immutable }, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ─── Key loading ──────────────────────────────────────────────────────────────

async function loadPrivateKey(): Promise<{ key: Awaited<ReturnType<typeof importJWK>>; kid?: string }> {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    throw new Error(
      "[verificationCardSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
        "Run `npm run generate:receipt-keypair` and add the keys to .env."
    );
  }
  const jwk = JSON.parse(raw);
  const key = await importJWK(jwk, "EdDSA");
  return { key, kid: typeof jwk.kid === "string" ? jwk.kid : undefined };
}

async function loadPublicKey() {
  const raw = process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK;
  if (!raw) return null;
  return importJWK(JSON.parse(raw), "EdDSA");
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

export async function signVerificationCardJws(
  payload: VerificationCardJwsPayload
): Promise<{ jws: string; signing_key_id?: string }> {
  const { key, kid } = await loadPrivateKey();
  const encoder = new TextEncoder();
  const jws = await new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-verification-card+jws" })
    .sign(key);
  return { jws, signing_key_id: kid };
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export async function verifyVerificationCardJws(
  jws: string
): Promise<{ valid: boolean; payload?: VerificationCardJwsPayload; error?: string }> {
  if (!jws) {
    return { valid: false, error: "SIGNING_KEY_UNAVAILABLE" };
  }
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
    ) as VerificationCardJwsPayload;
    return { valid: true, payload: decoded };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "VERIFY_FAILED",
    };
  }
}

// ─── Build + sign a card in one call ─────────────────────────────────────────

/**
 * Build and sign a VerificationCard from the immutable card fields.
 * If signing is unavailable (no key configured), the card is returned with
 * jws = "" and jws_present = false — non-blocking by design.
 */
export async function buildSignedVerificationCard(
  fields: Omit<VerificationCard, "verification">
): Promise<VerificationCard> {
  const now = new Date().toISOString();

  const card_hash = hashVerificationCard(fields);

  const jwsPayload: VerificationCardJwsPayload = {
    typ: "aegis.verification_card.v1",
    card_id: fields.card_id,
    card_hash,
    issuer: fields.issuer,
    issued_at: now,
    user_id: fields.user_id,
  };

  let jws = "";
  let jws_present = false;
  let signing_key_id: string | undefined;

  try {
    const result = await signVerificationCardJws(jwsPayload);
    jws = result.jws;
    jws_present = true;
    signing_key_id = result.signing_key_id;
  } catch {
    // Non-blocking — card stored unsigned; verification returns SIGNING_KEY_UNAVAILABLE.
  }

  const card: VerificationCard = {
    ...fields,
    verification: {
      card_hash,
      card_jws: jws,
      jws_present,
      signing_alg: "EdDSA",
      signed_at: now,
      ...(signing_key_id !== undefined ? { signing_key_id } : {}),
    },
  };

  return card;
}

// ─── Verify a stored card ────────────────────────────────────────────────────

export async function verifyStoredVerificationCard(
  card: VerificationCard
): Promise<VerificationCardVerificationResult> {
  if (!card.verification) {
    return { hash_valid: false, signature_valid: false, error: "NO_VERIFICATION_BLOCK" };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { verification, ...hashableFields } = card;

  const recomputed_hash = hashVerificationCard(hashableFields);
  const hash_valid = recomputed_hash === verification.card_hash;

  let signature_valid = false;
  let error: string | undefined;

  if (!verification.jws_present || !verification.card_jws) {
    error = "SIGNING_KEY_UNAVAILABLE";
  } else {
    const jwsResult = await verifyVerificationCardJws(verification.card_jws);
    signature_valid = jwsResult.valid;
    if (!jwsResult.valid) {
      error = jwsResult.error;
    }

    if (signature_valid && jwsResult.payload) {
      const p = jwsResult.payload;
      const payloadConsistent =
        p.card_id === card.card_id &&
        p.card_hash === verification.card_hash &&
        p.user_id === card.user_id &&
        p.issuer === card.issuer;
      if (!payloadConsistent) {
        signature_valid = false;
        error = "JWS_PAYLOAD_MISMATCH";
      }
    }
  }

  return { hash_valid, signature_valid, ...(error !== undefined ? { error } : {}) };
}
