/**
 * Demo payment-method top-up / self-heal tests (seedDemoPaymentMethod).
 *
 * Verifies:
 * - Fresh seed creates one usable active default card for user_001 (pay_method_demo_001)
 *   with card_number_ref + cvv_ref, and encrypts both fake secrets into the vault.
 * - A legacy display-only capability record (network, no refs) is REPAIRED IN PLACE under
 *   the same id — not duplicated — and created_at is preserved.
 * - The top-up is idempotent and non-destructive: a user-added usable default card is never
 *   overwritten and the demo card is not injected.
 * - The KMS context for the demo refs matches the execute path
 *   ({ user_id: "user_001", pass_id: "pay_method_demo_001", domain: "aegis.payment" }).
 * - The default-card lookup used by request_payment_card_fill resolves the demo card.
 * - Fake test card only (4242…/123); no raw PAN/CVV leaks into the record.
 */

import { vi } from "vitest";

const mockEncryptedBlob = {
  provider: "local_dev" as const,
  version: 1 as const,
  algorithm: "aes-256-gcm" as const,
  nonce_b64: "mock-nonce-b64",
  ciphertext_b64: "mock-ciphertext-b64",
  tag_b64: "mock-tag-b64",
  aad_b64: "mock-aad-b64",
  created_at: new Date().toISOString(),
};

const encryptSecretMock = vi.fn().mockResolvedValue(mockEncryptedBlob);

vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: encryptSecretMock,
    decryptSecret: vi.fn().mockResolvedValue("plaintext-never-returned"),
  })),
}));

import { describe, it, expect, beforeEach } from "vitest";
import type { PaymentMethod } from "@aegis/types";
import { paymentMethods, encryptedSecretVault, MOCK_USER_ID } from "../store/index.js";
import { seedDemoPaymentMethod } from "../store/persistence.js";

const PM_ID = "pay_method_demo_001";
const CARD_NUMBER_REF = "devvault://demo-card-number";
const CVV_REF = "devvault://demo-card-cvv";

// Mirror of the default-card lookup predicate in agent-api.ts request_payment_card_fill.
function findDefaultCard(): PaymentMethod | undefined {
  return Array.from(paymentMethods.values()).find(
    (p) => p.user_id === MOCK_USER_ID && p.is_default && p.status === "active",
  );
}

beforeEach(() => {
  paymentMethods.clear();
  encryptedSecretVault.clear();
  encryptSecretMock.mockClear();
});

describe("seedDemoPaymentMethod", () => {
  it("creates one usable active default demo card on a fresh store", async () => {
    await seedDemoPaymentMethod();

    const pm = paymentMethods.get(PM_ID);
    expect(pm).toBeDefined();
    expect(pm!.user_id).toBe("user_001");
    expect(pm!.is_default).toBe(true);
    expect(pm!.status).toBe("active");
    expect(pm!.brand).toBe("visa");
    expect(pm!.last4).toBe("4242");
    expect(pm!.card_number_ref).toBe(CARD_NUMBER_REF);
    expect(pm!.cvv_ref).toBe(CVV_REF);

    // Both fake secrets encrypted into the vault.
    expect(encryptedSecretVault.has(CARD_NUMBER_REF)).toBe(true);
    expect(encryptedSecretVault.has(CVV_REF)).toBe(true);

    // No raw PAN/CVV stored on the record.
    expect(JSON.stringify(pm)).not.toContain("4242424242424242");
    expect(JSON.stringify(pm)).not.toContain("123");
  });

  it("encrypts the demo secrets with the KMS context the execute path expects", async () => {
    await seedDemoPaymentMethod();

    expect(encryptSecretMock).toHaveBeenCalledWith("4242424242424242", {
      user_id: "user_001",
      pass_id: PM_ID,
      domain: "aegis.payment",
      purpose: "payment_card_number",
    });
    expect(encryptSecretMock).toHaveBeenCalledWith("123", {
      user_id: "user_001",
      pass_id: PM_ID,
      domain: "aegis.payment",
      purpose: "payment_cvv",
    });
  });

  it("repairs a legacy display-only capability record IN PLACE (same id, no duplicate)", async () => {
    // Legacy shape: network instead of brand, no refs, no is_default/status.
    paymentMethods.set(PM_ID, {
      payment_method_id: PM_ID,
      user_id: "user_001",
      label: "Aegis Demo Card",
      network: "visa",
      last4: "4242",
      billing_country: "US",
      capability_ref: "demo-payment-method",
      created_at: "2026-04-30T13:00:00.000Z",
    } as unknown as PaymentMethod);

    await seedDemoPaymentMethod();

    // Exactly one card, same id, now usable.
    const all = Array.from(paymentMethods.values()).filter((p) => p.user_id === "user_001");
    expect(all).toHaveLength(1);
    const pm = paymentMethods.get(PM_ID)!;
    expect(pm.is_default).toBe(true);
    expect(pm.status).toBe("active");
    expect(pm.brand).toBe("visa");
    expect(pm.card_number_ref).toBe(CARD_NUMBER_REF);
    expect(pm.cvv_ref).toBe(CVV_REF);
    // created_at preserved from the legacy record.
    expect(pm.created_at).toBe("2026-04-30T13:00:00.000Z");
  });

  it("is non-destructive: never overwrites a user-added usable default card", async () => {
    const userCardRef = "devvault://user-card-number/abc";
    encryptedSecretVault.set(userCardRef, mockEncryptedBlob);
    const userCard: PaymentMethod = {
      payment_method_id: "pm_user_real_001",
      user_id: "user_001",
      label: "My Real Card",
      cardholder_name: "Real User",
      brand: "mastercard",
      last4: "5454",
      exp_month: 6,
      exp_year: 2030,
      is_default: true,
      status: "active",
      card_number_ref: userCardRef,
      cvv_ref: "devvault://user-card-cvv/abc",
      capability_ref: "pm_user_real_001",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    };
    paymentMethods.set(userCard.payment_method_id, userCard);

    await seedDemoPaymentMethod();

    // Demo card NOT injected; user card untouched; KMS not invoked.
    expect(paymentMethods.has(PM_ID)).toBe(false);
    expect(paymentMethods.get("pm_user_real_001")).toEqual(userCard);
    expect(encryptSecretMock).not.toHaveBeenCalled();
  });

  it("is idempotent across repeated runs (single card, no duplicate secrets)", async () => {
    await seedDemoPaymentMethod();
    await seedDemoPaymentMethod();

    const all = Array.from(paymentMethods.values()).filter((p) => p.user_id === "user_001");
    expect(all).toHaveLength(1);
    // Second run short-circuits on the usable-default guard — no re-encryption.
    expect(encryptSecretMock).toHaveBeenCalledTimes(2);
  });

  it("makes the demo card resolvable by the request_payment_card_fill default lookup", async () => {
    await seedDemoPaymentMethod();
    const found = findDefaultCard();
    expect(found?.payment_method_id).toBe(PM_ID);
  });
});
