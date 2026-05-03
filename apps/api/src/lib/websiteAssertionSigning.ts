import { CompactSign, compactVerify, importJWK } from "jose";
import { createHash } from "crypto";
import type { WebsiteTrustAssertion } from "@aegis/types";
// Reuse receipt signing env keys for v1. TODO: split into dedicated website-assertion signing keypair.
// Never expose AEGIS_RECEIPT_JWS_PRIVATE_JWK in any response, log, or front-end import.

export interface AssertionJwsPayload {
  typ: "aegis.website_assertion.v1";
  assertion_id: string;
  assertion_hash: string;
  issuer: string;
  issued_at: string;
  expires_at: string;
  requesting_domain: string;
  user_aegis_id: string;
  agent_id: string;
  delegation_id: string;
  passport_id?: string;
  task_category: string;
  recommendation: string;
  trust_status: string;
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

export function hashWebsiteTrustAssertion(
  assertion: Omit<WebsiteTrustAssertion, "verification">
): string {
  const stable = JSON.stringify({ assertion_json: assertion }, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ─── Key loading ──────────────────────────────────────────────────────────────

async function loadPrivateKey() {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    throw new Error(
      "[websiteAssertionSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
        "Run `npm run generate:receipt-keypair` and add the keys to .env. " +
        "Website assertions require a real signing key — no unsigned fallback is available."
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

export async function signWebsiteAssertionJws(
  payload: AssertionJwsPayload
): Promise<string> {
  const privateKey = await loadPrivateKey();
  const encoder = new TextEncoder();
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-website-assertion+jws" })
    .sign(privateKey);
}

export async function verifyWebsiteAssertionJws(
  jws: string
): Promise<{ valid: boolean; payload?: AssertionJwsPayload; error?: string }> {
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
    ) as AssertionJwsPayload;
    return { valid: true, payload: decoded };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "VERIFY_FAILED",
    };
  }
}
