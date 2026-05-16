import { CompactSign, compactVerify, importJWK } from "jose";
import { createHash } from "crypto";
import type {
  WebsiteTrustProfile,
  WebsiteTrustProfileJwsPayload,
  WebsiteTrustProfileVerificationResult,
  WebsiteSafetyPromise,
  WebsiteVerificationStatus,
  WebsiteProfileStatus,
} from "@aegis/types";
// Reuses AEGIS_RECEIPT_JWS_PRIVATE_JWK / PUBLIC_JWK keypair (same as other receipt/assertion signing).
// TODO: split into a dedicated website-trust-profile signing keypair.
// Never expose these env vars in any response, log, or front-end import.

// ─── Standard safety promises ─────────────────────────────────────────────────

export const STANDARD_SAFETY_PROMISES: Omit<WebsiteSafetyPromise, "committed">[] = [
  {
    promise_id: "site_will_not_prompt_inject_agents",
    title: "No Prompt Injection",
    description:
      "This website will not embed instructions in page content intended to redirect, override, or manipulate agent reasoning or tool calls.",
    severity_if_violated: "critical",
  },
  {
    promise_id: "site_will_not_request_secrets_outside_approved_flows",
    title: "Secrets Only in Approved Flows",
    description:
      "This website will not request credentials, tokens, or secrets outside of Antigen-approved secure injection flows.",
    severity_if_violated: "critical",
  },
  {
    promise_id: "site_will_not_disguise_sensitive_actions",
    title: "No Disguised Sensitive Actions",
    description:
      "This website will not hide payment, identity disclosure, or account mutation actions inside innocuous-looking UI elements.",
    severity_if_violated: "high",
  },
  {
    promise_id: "site_will_respect_aegis_approval_boundaries",
    title: "Respect Antigen Approval Boundaries",
    description:
      "This website will not attempt to bypass, circumvent, or accelerate through Antigen-required approval gates.",
    severity_if_violated: "high",
  },
  {
    promise_id: "site_will_expose_clear_sensitive_action_metadata",
    title: "Clear Sensitive Action Metadata",
    description:
      "This website will expose machine-readable metadata (ARIA, data attributes, or structured headers) identifying sensitive actions so Antigen can detect and govern them.",
    severity_if_violated: "medium",
  },
  {
    promise_id: "site_will_not_exfiltrate_agent_context",
    title: "No Agent Context Exfiltration",
    description:
      "This website will not attempt to extract, log, or transmit the agent's task context, delegation details, or collar configuration.",
    severity_if_violated: "high",
  },
  {
    promise_id: "site_will_not_override_collar_policy",
    title: "No Collar Policy Override",
    description:
      "This website will not present UI flows designed to induce the agent to take actions blocked by its active collar.",
    severity_if_violated: "critical",
  },
];

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

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Canonical hash of the website trust profile's substantive fields.
 * Excludes profile_hash, profile_jws, jws_present — these are computed/circular.
 * All promise and policy fields are included so any tampering invalidates the hash.
 */
export function hashWebsiteTrustProfile(
  profile: Omit<WebsiteTrustProfile, "profile_hash" | "profile_jws" | "jws_present">
): string {
  const stable = JSON.stringify({ profile_json: profile }, sortedReplacer);
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ─── Key loading ──────────────────────────────────────────────────────────────

async function loadPrivateKey(): Promise<{ key: Awaited<ReturnType<typeof importJWK>>; kid?: string }> {
  const raw = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  if (!raw) {
    throw new Error(
      "[websiteTrustProfileSigning] AEGIS_RECEIPT_JWS_PRIVATE_JWK is not set. " +
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

export async function signWebsiteTrustProfileJws(
  payload: WebsiteTrustProfileJwsPayload
): Promise<{ jws: string; signing_key_id?: string }> {
  const { key, kid } = await loadPrivateKey();
  const encoder = new TextEncoder();
  const jws = await new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ: "aegis-website-trust-profile+jws" })
    .sign(key);
  return { jws, signing_key_id: kid };
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export async function verifyWebsiteTrustProfileJws(
  jws: string
): Promise<{ valid: boolean; payload?: WebsiteTrustProfileJwsPayload; error?: string }> {
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
    ) as WebsiteTrustProfileJwsPayload;
    return { valid: true, payload: decoded };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "VERIFY_FAILED",
    };
  }
}

// ─── Build + sign a profile in one call ──────────────────────────────────────

/**
 * Build and sign a WebsiteTrustProfile from the substantive fields.
 * If signing is unavailable (no key configured), the profile is stored with
 * profile_jws = undefined and jws_present = false — it will verify as invalid.
 * Non-throwing by design: profile creation is not blocked by signing failure.
 */
export async function buildSignedWebsiteTrustProfile(
  fields: Omit<WebsiteTrustProfile, "profile_hash" | "profile_jws" | "jws_present">
): Promise<WebsiteTrustProfile> {
  const now = new Date().toISOString();

  const profile_hash = hashWebsiteTrustProfile(fields);

  const issuer = process.env.AEGIS_RECEIPT_ISSUER ?? "aegis-dev";

  const jwsPayload: WebsiteTrustProfileJwsPayload = {
    typ: "aegis.website_trust_profile.v1",
    profile_id: fields.profile_id,
    profile_hash,
    domain: fields.domain,
    issuer,
    issued_at: now,
    verification_status: fields.verification_status as WebsiteVerificationStatus,
    status: fields.status as WebsiteProfileStatus,
  };

  let profile_jws: string | undefined;
  let jws_present = false;

  try {
    const result = await signWebsiteTrustProfileJws(jwsPayload);
    profile_jws = result.jws;
    jws_present = true;
  } catch {
    // Non-blocking — profile is stored unsigned; verification will return SIGNING_KEY_UNAVAILABLE
  }

  const profile: WebsiteTrustProfile = {
    ...fields,
    profile_hash,
    ...(profile_jws !== undefined ? { profile_jws } : {}),
    jws_present,
  };

  return profile;
}

// ─── Verify a stored profile ──────────────────────────────────────────────────

export async function verifyStoredWebsiteTrustProfile(
  profile: WebsiteTrustProfile
): Promise<WebsiteTrustProfileVerificationResult> {
  const { profile_hash, profile_jws, jws_present, ...hashableFields } = profile;

  const recomputed_hash = hashWebsiteTrustProfile(hashableFields);
  const hash_valid = recomputed_hash === profile_hash;

  let signature_valid = false;
  let jws_payload: WebsiteTrustProfileJwsPayload | undefined;
  let error: string | undefined;

  if (!jws_present || !profile_jws) {
    error = "SIGNING_KEY_UNAVAILABLE";
  } else {
    const jwsResult = await verifyWebsiteTrustProfileJws(profile_jws);
    signature_valid = jwsResult.valid;
    jws_payload = jwsResult.payload;
    if (!jwsResult.valid) {
      error = jwsResult.error;
    }

    // Cross-check JWS payload fields against stored profile
    if (signature_valid && jws_payload) {
      const p = jws_payload;
      const payloadConsistent =
        p.profile_id === profile.profile_id &&
        p.profile_hash === profile_hash &&
        p.domain === profile.domain &&
        p.verification_status === profile.verification_status &&
        p.status === profile.status;
      if (!payloadConsistent) {
        signature_valid = false;
        error = "JWS_PAYLOAD_MISMATCH";
      }
    }
  }

  return {
    profile_id: profile.profile_id,
    valid: hash_valid && signature_valid,
    hash_valid,
    signature_valid,
    recomputed_hash,
    stored_hash: profile_hash,
    ...(jws_payload ? { jws_payload } : {}),
    ...(error ? { error } : {}),
  };
}
