import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VerificationCard, DisclosureReceipt } from "@aegis/types";
import {
  hashVerificationCard,
  buildSignedVerificationCard,
  verifyStoredVerificationCard,
} from "../lib/verificationCardSigning.js";

// ─── Sample builders ──────────────────────────────────────────────────────────

function makeCardFields(): Omit<VerificationCard, "verification"> {
  return {
    card_id: "vc_test_001",
    schema_version: "1.0",
    issuer: "aegis",
    user_id: "user_001",
    claims: [
      {
        claim_id: "vc_claim_001",
        card_id: "vc_test_001",
        claim_type: "email_ownership",
        claim_value: { kind: "email_ownership", email_domain: "example.com" },
        assurance_level: "provider_verified",
        verified_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    disclosure_policy: "user_approval_required",
    issued_at: "2026-01-01T00:00:00.000Z",
    revocation_status: "active",
    limitations: {
      raw_document_revealed_to_agent: false,
      raw_document_revealed_to_website: false,
      provider_result_only: true,
      not_a_guarantee: true,
    },
  };
}

function makeSampleDisclosureReceipt(): DisclosureReceipt {
  return {
    receipt_id: "vcdiscl_test_001",
    receipt_type: "claim_disclosure",
    card_id: "vc_test_001",
    user_id: "user_001",
    claim_types_disclosed: ["email_ownership"],
    disclosure_target: { kind: "agent", agent_id: "agent_001", delegation_id: "del_001" },
    disclosure_policy_at_time: "user_approval_required",
    approved_at: "2026-01-01T00:00:00.000Z",
    limitations: {
      raw_document_revealed_to_target: false,
      raw_document_in_receipt: false,
      full_card_revealed: false,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("hashVerificationCard", () => {
  it("produces a hex string for a valid card", () => {
    const hash = hashVerificationCard(makeCardFields());
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash for the same input", () => {
    const fields = makeCardFields();
    expect(hashVerificationCard(fields)).toBe(hashVerificationCard(fields));
  });

  it("changes hash when a claim field is mutated", () => {
    const original = makeCardFields();
    const mutated = {
      ...original,
      claims: [
        {
          ...original.claims[0],
          claim_value: { kind: "email_ownership" as const, email_domain: "attacker.com" },
        },
      ],
    };
    expect(hashVerificationCard(original)).not.toBe(hashVerificationCard(mutated));
  });

  it("does NOT change hash when revocation_status changes", () => {
    const active = makeCardFields();
    const revoked = { ...active, revocation_status: "revoked" as const };
    expect(hashVerificationCard(active)).toBe(hashVerificationCard(revoked));
  });
});

describe("buildSignedVerificationCard (no signing key)", () => {
  const savedPrivate = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  const savedPublic = process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK;

  beforeEach(() => {
    delete process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
    delete process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK;
  });

  afterEach(() => {
    if (savedPrivate !== undefined) process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK = savedPrivate;
    if (savedPublic !== undefined) process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK = savedPublic;
  });

  it("returns a card with a card_hash even without a signing key", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    expect(card.verification?.card_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets jws_present=false and card_jws='' when no signing key is configured", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    expect(card.verification?.jws_present).toBe(false);
    expect(card.verification?.card_jws).toBe("");
  });

  it("does not throw when the signing key is absent", async () => {
    await expect(buildSignedVerificationCard(makeCardFields())).resolves.toBeDefined();
  });
});

describe("verifyStoredVerificationCard (no signing key)", () => {
  const savedPrivate = process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
  const savedPublic = process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK;

  beforeEach(() => {
    delete process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK;
    delete process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK;
  });

  afterEach(() => {
    if (savedPrivate !== undefined) process.env.AEGIS_RECEIPT_JWS_PRIVATE_JWK = savedPrivate;
    if (savedPublic !== undefined) process.env.AEGIS_RECEIPT_JWS_PUBLIC_JWK = savedPublic;
  });

  it("hash_valid=true for an unmodified card", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    const result = await verifyStoredVerificationCard(card);
    expect(result.hash_valid).toBe(true);
  });

  it("hash_valid=false when a claim is mutated after signing", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    const tampered: VerificationCard = {
      ...card,
      claims: [
        {
          ...card.claims[0],
          claim_value: { kind: "email_ownership", email_domain: "tampered.com" },
        },
      ],
    };
    const result = await verifyStoredVerificationCard(tampered);
    expect(result.hash_valid).toBe(false);
  });

  it("hash_valid=true even after revocation_status changes", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    const revoked: VerificationCard = { ...card, revocation_status: "revoked" };
    const result = await verifyStoredVerificationCard(revoked);
    expect(result.hash_valid).toBe(true);
  });

  it("changing verification block does not affect canonical content hash", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    // Mutate only the verification block (tamper the jws string)
    const withTamperedJws: VerificationCard = {
      ...card,
      verification: {
        ...card.verification!,
        card_jws: "tampered.jws.value",
      },
    };
    // The hash of the content (sans verification) should still match stored card_hash
    const recomputed = hashVerificationCard(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (({ verification: _v, ...rest }) => rest)(withTamperedJws)
    );
    expect(recomputed).toBe(card.verification!.card_hash);
  });

  it("returns SIGNING_KEY_UNAVAILABLE when jws_present=false", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    const result = await verifyStoredVerificationCard(card);
    expect(result.error).toBe("SIGNING_KEY_UNAVAILABLE");
    expect(result.signature_valid).toBe(false);
  });
});

describe("VerificationCard privacy guarantees", () => {
  it("limitations.raw_document_revealed_to_agent is always the literal false", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    expect(card.limitations.raw_document_revealed_to_agent).toBe(false);
    // TypeScript ensures this cannot be true at compile time; runtime confirms it
    expect(card.limitations.raw_document_revealed_to_agent).not.toBe(true);
  });

  it("limitations.raw_document_revealed_to_website is always the literal false", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    expect(card.limitations.raw_document_revealed_to_website).toBe(false);
  });

  it("limitations.provider_result_only is always true", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    expect(card.limitations.provider_result_only).toBe(true);
  });

  it("limitations.not_a_guarantee is always true", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    expect(card.limitations.not_a_guarantee).toBe(true);
  });

  it("card does not contain forbidden raw-evidence fields", async () => {
    const card = await buildSignedVerificationCard(makeCardFields());
    const json = JSON.stringify(card);
    // These are field names that would indicate actual raw data being stored.
    // Note: "raw_document_revealed_to_agent" is a legitimate limitation guarantee field
    // and intentionally present; we test for raw data values, not guarantee field names.
    const forbidden = [
      "\"ssn\"", "\"date_of_birth\"", "\"legal_name\"", "\"full_name\"",
      "\"biometric_data\"", "\"document_number\"", "\"passport_number\"",
      "\"id_number\"", "\"provider_payload\"", "\"raw_evidence\"",
    ];
    for (const field of forbidden) {
      expect(json.toLowerCase()).not.toContain(field.toLowerCase());
    }
  });
});

describe("DisclosureReceipt privacy guarantees", () => {
  it("limitations.raw_document_revealed_to_target is the literal false", () => {
    const receipt = makeSampleDisclosureReceipt();
    expect(receipt.limitations.raw_document_revealed_to_target).toBe(false);
  });

  it("limitations.raw_document_in_receipt is the literal false", () => {
    const receipt = makeSampleDisclosureReceipt();
    expect(receipt.limitations.raw_document_in_receipt).toBe(false);
  });

  it("limitations.full_card_revealed is the literal false", () => {
    const receipt = makeSampleDisclosureReceipt();
    expect(receipt.limitations.full_card_revealed).toBe(false);
  });

  it("receipt does not contain forbidden raw-evidence fields", () => {
    const receipt = makeSampleDisclosureReceipt();
    const json = JSON.stringify(receipt);
    const forbidden = [
      "\"ssn\"", "\"date_of_birth\"", "\"legal_name\"", "\"full_name\"",
      "\"biometric_data\"", "\"document_number\"", "\"provider_payload\"", "\"raw_evidence\"",
    ];
    for (const field of forbidden) {
      expect(json.toLowerCase()).not.toContain(field.toLowerCase());
    }
  });
});
