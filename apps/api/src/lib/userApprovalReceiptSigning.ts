import { CompactSign, compactVerify, importJWK } from "jose";
import { createHash } from "crypto";
import type {
  UserApprovalReceipt,
  UserApprovalJwsPayload,
  UserApprovalReceiptVerificationResult,
} from "@aegis/types";
// Reuses AEGIS_RECEIPT_JWS_PRIVATE_JWK / PUBLIC_JWK keypair (same as route-run and action-authorization receipts).
// TODO: split into a dedicated user-approval signing keypair.
// Never expose these env vars in any response, log, or front-end import.

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
 * Canonical hash of the user-decision fields in a UserApprovalReceipt.
 * Excludes `outcome`, `outcome_updated_at`, and `verification` — these are mutable or
 * circular and must not affect the signed hash.
 * All decision-bearing fields (decision, decided_at, user_id, approval_id, etc.)
 * are included so any tampering invalidates the hash.
 */
export function hashUserApprovalReceipt(
  receipt: Omit<UserApprovalReceipt, "outcome" | "outcome_updated_at" | "verification">
): string {
  const stable = JSON.stringify({ receipt_json: receipt }, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ─── Key loading ──────────────────────────────────────────────────────────────

async function loadPrivateKey(): Promise<{ key: Awaited<ReturnType<typeof importJWK>>; kid?: string }> {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    throw new Error(
      "[userApprovalReceiptSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
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

export async function signUserApprovalReceiptJws(
  payload: UserApprovalJwsPayload
): Promise<{ jws: string; signing_key_id?: string }> {
  const { key, kid } = await loadPrivateKey();
  const encoder = new TextEncoder();
  const jws = await new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-user-approval+jws" })
    .sign(key);
  return { jws, signing_key_id: kid };
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export async function verifyUserApprovalReceiptJws(
  jws: string
): Promise<{ valid: boolean; payload?: UserApprovalJwsPayload; error?: string }> {
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
    ) as UserApprovalJwsPayload;
    return { valid: true, payload: decoded };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "VERIFY_FAILED",
    };
  }
}

// ─── Build + sign a receipt in one call ──────────────────────────────────────

/**
 * Build and sign a UserApprovalReceipt from the immutable decision fields.
 * If signing is unavailable (no key configured), the receipt is stored with
 * jws = "" and jws_present = false — it will verify as invalid with SIGNING_KEY_UNAVAILABLE.
 * Approval/deny flows must not be blocked by signing failure (non-throwing by design).
 */
export async function buildSignedUserApprovalReceipt(
  fields: Omit<UserApprovalReceipt, "verification" | "outcome" | "outcome_updated_at">
): Promise<UserApprovalReceipt> {
  const now = new Date().toISOString();

  const hash = hashUserApprovalReceipt(fields);

  const jwsPayload: UserApprovalJwsPayload = {
    typ: "aegis.user_approval.v1",
    receipt_id: fields.receipt_id,
    payload_hash: hash,
    issuer: fields.issuer,
    issued_at: now,
    user_id: fields.user_id,
    decision: fields.decision,
    approval_id: fields.approval_id,
    approval_source: fields.approval_source,
  };

  let jws = "";
  let jws_present = false;
  let signing_key_id: string | undefined;

  try {
    const result = await signUserApprovalReceiptJws(jwsPayload);
    jws = result.jws;
    jws_present = true;
    signing_key_id = result.signing_key_id;
  } catch {
    // Non-blocking — receipt is stored unsigned; verification will return SIGNING_KEY_UNAVAILABLE
  }

  const receipt: UserApprovalReceipt = {
    ...fields,
    outcome: "pending",
    raw_secrets_in_receipt: false,
    raw_credentials_in_receipt: false,
    verification: {
      canonical_payload_hash: hash,
      jws,
      jws_present,
      signing_alg: "EdDSA",
      signed_at: now,
      ...(signing_key_id !== undefined ? { signing_key_id } : {}),
    },
  };

  return receipt;
}

// ─── Verify a stored receipt ──────────────────────────────────────────────────

export async function verifyStoredUserApprovalReceipt(
  receipt: UserApprovalReceipt
): Promise<UserApprovalReceiptVerificationResult> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { verification, outcome, outcome_updated_at, ...hashableFields } = receipt;

  const recomputed_hash = hashUserApprovalReceipt(hashableFields);
  const hash_valid = recomputed_hash === verification.canonical_payload_hash;

  let signature_valid = false;
  let jws_payload: UserApprovalJwsPayload | undefined;
  let error: string | undefined;

  if (!verification.jws_present || !verification.jws) {
    error = "SIGNING_KEY_UNAVAILABLE";
  } else {
    const jwsResult = await verifyUserApprovalReceiptJws(verification.jws);
    signature_valid = jwsResult.valid;
    jws_payload = jwsResult.payload;
    if (!jwsResult.valid) {
      error = jwsResult.error;
    }

    // Cross-check JWS payload fields against stored receipt
    if (signature_valid && jws_payload) {
      const p = jws_payload;
      const payloadConsistent =
        p.receipt_id === receipt.receipt_id &&
        p.payload_hash === verification.canonical_payload_hash &&
        p.user_id === receipt.user_id &&
        p.decision === receipt.decision &&
        p.approval_id === receipt.approval_id &&
        p.approval_source === receipt.approval_source;
      if (!payloadConsistent) {
        signature_valid = false;
        error = "JWS_PAYLOAD_MISMATCH";
      }
    }
  }

  return {
    receipt_id: receipt.receipt_id,
    valid: hash_valid && signature_valid,
    hash_valid,
    signature_valid,
    recomputed_hash,
    stored_hash: verification.canonical_payload_hash,
    ...(jws_payload ? { jws_payload } : {}),
    ...(error ? { error } : {}),
  };
}
