import { CompactSign, compactVerify, importJWK } from "jose";

export interface ReceiptJwsPayload {
  typ: "aegis.receipt.v1";
  receipt_id: string;
  receipt_hash: string;
  previous_receipt_hash: string | null;
  issuer: string;
  issued_at: string;
}

// Thrown when signing keys are absent and AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV=true.
// Callers can catch this specifically to allow unsigned storage in local/dev mode.
export class UnsignedDevModeError extends Error {
  constructor() {
    super(
      "[receiptSigning] Signing keys not configured. AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV=true — proceeding unsigned."
    );
    this.name = "UnsignedDevModeError";
  }
}

// Keys are loaded lazily so importing this module never throws on missing env vars.

async function loadPrivateKey() {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    if (process.env.AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV === "true") {
      throw new UnsignedDevModeError();
    }
    throw new Error(
      "[receiptSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
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

export async function signReceiptJws(payload: ReceiptJwsPayload): Promise<string> {
  const privateKey = await loadPrivateKey();
  const encoder = new TextEncoder();
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-receipt+jws" })
    .sign(privateKey);
}

export async function verifyReceiptJws(
  jws: string
): Promise<{ valid: boolean; payload?: ReceiptJwsPayload; error?: string }> {
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
    ) as ReceiptJwsPayload;
    return { valid: true, payload: decoded };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "VERIFY_FAILED" };
  }
}
