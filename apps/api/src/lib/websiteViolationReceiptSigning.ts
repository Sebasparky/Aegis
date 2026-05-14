import { CompactSign, compactVerify, importJWK } from "jose";
import { createHash } from "crypto";
import type {
  WebsiteViolationReceipt,
  WebsiteViolationReceiptJwsPayload,
  WebsiteViolationReceiptVerificationResult,
} from "@aegis/types";
// Reuses AEGIS_RECEIPT_JWS_PRIVATE_JWK / PUBLIC_JWK keypair (same as all other receipt types).
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
 * Canonical hash of all substantive fields in a WebsiteViolationReceipt.
 * Excludes `verification` — it is circular (the hash is stored inside it).
 * All violation-bearing fields (violation_type, severity, decision, profile_hash, etc.)
 * are included so any tampering invalidates the hash.
 */
export function hashWebsiteViolationReceipt(
  receipt: Omit<WebsiteViolationReceipt, "verification">
): string {
  const stable = JSON.stringify({ receipt_json: receipt }, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ─── Key loading ──────────────────────────────────────────────────────────────

async function loadPrivateKey(): Promise<{ key: Awaited<ReturnType<typeof importJWK>>; kid?: string }> {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    throw new Error(
      "[websiteViolationReceiptSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
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

export async function signWebsiteViolationReceiptJws(
  payload: WebsiteViolationReceiptJwsPayload
): Promise<{ jws: string; signing_key_id?: string }> {
  const { key, kid } = await loadPrivateKey();
  const encoder = new TextEncoder();
  const jws = await new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-website-violation+jws" })
    .sign(key);
  return { jws, signing_key_id: kid };
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export async function verifyWebsiteViolationReceiptJws(
  jws: string
): Promise<{ valid: boolean; payload?: WebsiteViolationReceiptJwsPayload; error?: string }> {
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
    ) as WebsiteViolationReceiptJwsPayload;
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
 * Build and sign a WebsiteViolationReceipt from the violation fields.
 * If signing is unavailable (no key configured), the receipt is stored with
 * jws = "" and jws_present = false — it will verify as invalid with SIGNING_KEY_UNAVAILABLE.
 * Violation creation must not be blocked by signing failure (non-throwing by design).
 */
export async function buildSignedWebsiteViolationReceipt(
  fields: Omit<WebsiteViolationReceipt, "verification">
): Promise<WebsiteViolationReceipt> {
  const now = new Date().toISOString();

  const hash = hashWebsiteViolationReceipt(fields);

  const jwsPayload: WebsiteViolationReceiptJwsPayload = {
    typ: "aegis.website_violation.v1",
    receipt_id: fields.receipt_id,
    payload_hash: hash,
    issuer: fields.issuer,
    issued_at: now,
    website_profile_id: fields.website_profile_id,
    domain: fields.domain,
    violation_type: fields.violation_type,
    severity: fields.severity,
    decision: fields.decision,
  };

  let jws = "";
  let jws_present = false;
  let signing_key_id: string | undefined;

  try {
    const result = await signWebsiteViolationReceiptJws(jwsPayload);
    jws = result.jws;
    jws_present = true;
    signing_key_id = result.signing_key_id;
  } catch {
    // Non-blocking — receipt is stored unsigned; verification returns SIGNING_KEY_UNAVAILABLE
  }

  const receipt: WebsiteViolationReceipt = {
    ...fields,
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

export async function verifyStoredWebsiteViolationReceipt(
  receipt: WebsiteViolationReceipt
): Promise<WebsiteViolationReceiptVerificationResult> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { verification, ...hashableFields } = receipt;

  const recomputed_hash = hashWebsiteViolationReceipt(hashableFields);
  const hash_valid = recomputed_hash === verification.canonical_payload_hash;

  let signature_valid = false;
  let jws_payload: WebsiteViolationReceiptJwsPayload | undefined;
  let error: string | undefined;

  if (!verification.jws_present || !verification.jws) {
    error = "SIGNING_KEY_UNAVAILABLE";
  } else {
    const jwsResult = await verifyWebsiteViolationReceiptJws(verification.jws);
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
        p.website_profile_id === receipt.website_profile_id &&
        p.domain === receipt.domain &&
        p.violation_type === receipt.violation_type &&
        p.severity === receipt.severity &&
        p.decision === receipt.decision;
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
