/**
 * Payment Methods v1 tests.
 *
 * Verifies:
 * - CRUD operations (create, list, archive, delete)
 * - Encrypted secret storage for card_number and cvv
 * - API responses never expose card_number, cvv, secret refs, or ciphertext
 * - Brand derivation from card number
 * - Default management (first card, set default, archive default promotes next)
 * - Validation errors for missing/invalid fields
 * - No domain field required or stored
 */

import { vi } from "vitest";

// ─── Mocks (hoisted before all imports) ───────────────────────────────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

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

vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn().mockResolvedValue(mockEncryptedBlob),
    decryptSecret: vi.fn().mockResolvedValue("plaintext-never-returned"),
  })),
}));

vi.mock("../lib/kmsAudit.js", () => ({ recordKmsAuditEvent: vi.fn() }));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { paymentMethods, encryptedSecretVault } from "../store/index.js";
import { paymentMethodRoutes } from "../routes/payment-methods.js";

// ─── Test server ──────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(paymentMethodRoutes);
  await server.ready();
});

afterAll(async () => { await server.close(); });

beforeEach(() => {
  paymentMethods.clear();
  encryptedSecretVault.clear();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    label: "Test Visa",
    cardholder_name: "Jane Doe",
    card_number: "4111111111111111",
    cvv: "123",
    exp_month: 12,
    exp_year: 2027,
    ...overrides,
  };
}

async function createCard(overrides: Record<string, unknown> = {}) {
  return server.inject({
    method: "POST",
    url: "/api/payment-methods",
    payload: validBody(overrides),
  });
}

function assertNoSecrets(body: Record<string, unknown>) {
  const str = JSON.stringify(body);
  expect(str).not.toContain("card_number_ref");
  expect(str).not.toContain("cvv_ref");
  expect(str).not.toContain("ciphertext");
  expect(str).not.toContain("nonce_b64");
  expect(str).not.toContain("tag_b64");
  // Should not contain the full card number used in tests
  expect(str).not.toContain("4111111111111111");
  // Should not contain raw CVV
  expect(str).not.toContain('"cvv"');
  expect(str).not.toContain('"card_number"');
}

// ─── GET /api/payment-methods ─────────────────────────────────────────────────

describe("GET /api/payment-methods", () => {
  it("returns empty array when no cards saved", async () => {
    const res = await server.inject({ method: "GET", url: "/api/payment-methods" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("returns card views without any secret fields", async () => {
    await createCard();
    const res = await server.inject({ method: "GET", url: "/api/payment-methods" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    assertNoSecrets(body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].last4).toBe("1111");
    expect(body.data[0].brand).toBe("visa");
  });

  it("does not return card_number_ref or cvv_ref in list", async () => {
    await createCard();
    const res = await server.inject({ method: "GET", url: "/api/payment-methods" });
    const body = res.json();
    const card = body.data[0];
    expect(card).not.toHaveProperty("card_number_ref");
    expect(card).not.toHaveProperty("cvv_ref");
  });
});

// ─── POST /api/payment-methods — validation ───────────────────────────────────

describe("POST /api/payment-methods — validation", () => {
  it("rejects missing label", async () => {
    const res = await createCard({ label: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects missing cardholder_name", async () => {
    const res = await createCard({ cardholder_name: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects missing card_number", async () => {
    const res = await createCard({ card_number: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects non-numeric card_number", async () => {
    const res = await createCard({ card_number: "not-a-card-number" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    // Error message must not echo back the invalid value verbatim (security)
    expect(res.json().error.message).not.toContain("not-a-card-number");
  });

  it("rejects card_number shorter than 13 digits", async () => {
    const res = await createCard({ card_number: "411111111111" }); // 12 digits
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing cvv", async () => {
    const res = await createCard({ cvv: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects non-numeric cvv", async () => {
    const res = await createCard({ cvv: "abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects exp_month out of range", async () => {
    const res = await createCard({ exp_month: 13 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects exp_month = 0", async () => {
    const res = await createCard({ exp_month: 0 });
    expect(res.statusCode).toBe(400);
  });

  it("rejects exp_year outside range", async () => {
    const res = await createCard({ exp_year: 1999 });
    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /api/payment-methods — creation ────────────────────────────────────

describe("POST /api/payment-methods — successful creation", () => {
  it("returns 201 with PaymentMethodView on success", async () => {
    const res = await createCard();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.payment_method_id).toBeDefined();
    expect(body.data.last4).toBe("1111");
    expect(body.data.brand).toBe("visa");
    expect(body.data.label).toBe("Test Visa");
    expect(body.data.cardholder_name).toBe("Jane Doe");
    expect(body.data.exp_month).toBe(12);
    expect(body.data.exp_year).toBe(2027);
  });

  it("response never contains card_number, cvv, or any secret ref", async () => {
    const res = await createCard();
    assertNoSecrets(res.json());
  });

  it("derives brand=visa for card starting with 4", async () => {
    const res = await createCard({ card_number: "4111111111111111" });
    expect(res.json().data.brand).toBe("visa");
  });

  it("derives brand=mastercard for card starting with 51–55", async () => {
    const res = await createCard({ card_number: "5500000000000004" });
    expect(res.json().data.brand).toBe("mastercard");
  });

  it("derives brand=amex for card starting with 34 or 37", async () => {
    const res = await createCard({ card_number: "378282246310005" });
    expect(res.json().data.brand).toBe("amex");
  });

  it("derives brand=discover for card starting with 6", async () => {
    const res = await createCard({ card_number: "6011111111111117" });
    expect(res.json().data.brand).toBe("discover");
  });

  it("stores last4 correctly from 16-digit card", async () => {
    const res = await createCard({ card_number: "4111111111114242" });
    expect(res.json().data.last4).toBe("4242");
  });

  it("stores two encrypted blobs per card (card_number and cvv)", async () => {
    const res = await createCard();
    const pmId = res.json().data.payment_method_id;
    expect(encryptedSecretVault.has(`devvault://${pmId}/card_number`)).toBe(true);
    expect(encryptedSecretVault.has(`devvault://${pmId}/cvv`)).toBe(true);
  });

  it("first card is automatically set as default", async () => {
    const res = await createCard();
    expect(res.json().data.is_default).toBe(true);
  });

  it("second card is NOT automatically default", async () => {
    await createCard({ label: "Card 1" });
    const res2 = await createCard({ label: "Card 2" });
    expect(res2.json().data.is_default).toBe(false);
  });

  it("card has status=active on creation", async () => {
    const res = await createCard();
    expect(res.json().data.status).toBe("active");
  });

  it("does not require or store a domain field", async () => {
    const res = await createCard();
    const body = res.json();
    expect(body.data).not.toHaveProperty("domain");
    const stored = paymentMethods.get(body.data.payment_method_id);
    expect(stored).not.toHaveProperty("domain");
  });
});

// ─── Default management ───────────────────────────────────────────────────────

describe("Default management", () => {
  it("PATCH is_default=true unsets the previous default", async () => {
    const r1 = await createCard({ label: "Card 1" });
    const r2 = await createCard({ label: "Card 2" });
    const id1 = r1.json().data.payment_method_id;
    const id2 = r2.json().data.payment_method_id;

    // id1 is default, id2 is not
    await server.inject({
      method: "PATCH",
      url: `/api/payment-methods/${id2}`,
      payload: { is_default: true },
    });

    const list = await server.inject({ method: "GET", url: "/api/payment-methods" });
    const cards = list.json().data;
    const c1 = cards.find((c: { payment_method_id: string }) => c.payment_method_id === id1);
    const c2 = cards.find((c: { payment_method_id: string }) => c.payment_method_id === id2);
    expect(c1.is_default).toBe(false);
    expect(c2.is_default).toBe(true);
  });
});

// ─── Archive ──────────────────────────────────────────────────────────────────

describe("POST /api/payment-methods/:pmId/archive", () => {
  it("archives the card and sets status=archived", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;

    const res = await server.inject({ method: "POST", url: `/api/payment-methods/${pmId}/archive` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("archived");
    expect(res.json().data.is_default).toBe(false);
  });

  it("archiving default card promotes the next oldest active card", async () => {
    const r1 = await createCard({ label: "Card 1" }); // will be default
    const r2 = await createCard({ label: "Card 2" }); // not default
    const id1 = r1.json().data.payment_method_id;
    const id2 = r2.json().data.payment_method_id;

    await server.inject({ method: "POST", url: `/api/payment-methods/${id1}/archive` });

    const list = await server.inject({ method: "GET", url: "/api/payment-methods" });
    const cards = list.json().data;
    const c2 = cards.find((c: { payment_method_id: string }) => c.payment_method_id === id2);
    expect(c2.is_default).toBe(true);
  });

  it("archiving non-default card only changes status", async () => {
    await createCard({ label: "Card 1" }); // default
    const r2 = await createCard({ label: "Card 2" }); // not default
    const id2 = r2.json().data.payment_method_id;

    await server.inject({ method: "POST", url: `/api/payment-methods/${id2}/archive` });

    const list = await server.inject({ method: "GET", url: "/api/payment-methods" });
    const cards = list.json().data;
    // Card 1 should still be default
    const defaultCards = cards.filter((c: { is_default: boolean }) => c.is_default);
    expect(defaultCards).toHaveLength(1);
    expect(defaultCards[0].label).toBe("Card 1");
  });

  it("archiving the only card leaves no default", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;

    await server.inject({ method: "POST", url: `/api/payment-methods/${pmId}/archive` });

    const list = await server.inject({ method: "GET", url: "/api/payment-methods" });
    const defaultCards = list.json().data.filter((c: { is_default: boolean }) => c.is_default);
    expect(defaultCards).toHaveLength(0);
  });

  it("archive response never contains secret fields", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;
    const res = await server.inject({ method: "POST", url: `/api/payment-methods/${pmId}/archive` });
    assertNoSecrets(res.json());
  });
});

// ─── DELETE /api/payment-methods/:pmId ───────────────────────────────────────

describe("DELETE /api/payment-methods/:pmId", () => {
  it("removes the card from the store", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;

    const res = await server.inject({ method: "DELETE", url: `/api/payment-methods/${pmId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(paymentMethods.has(pmId)).toBe(false);
  });

  it("removes both encrypted blobs on delete", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;

    await server.inject({ method: "DELETE", url: `/api/payment-methods/${pmId}` });
    expect(encryptedSecretVault.has(`devvault://${pmId}/card_number`)).toBe(false);
    expect(encryptedSecretVault.has(`devvault://${pmId}/cvv`)).toBe(false);
  });

  it("promotes next active card to default after deleting the default", async () => {
    const r1 = await createCard({ label: "Card 1" }); // default
    const r2 = await createCard({ label: "Card 2" });
    const id1 = r1.json().data.payment_method_id;
    const id2 = r2.json().data.payment_method_id;

    await server.inject({ method: "DELETE", url: `/api/payment-methods/${id1}` });

    const list = await server.inject({ method: "GET", url: "/api/payment-methods" });
    const cards = list.json().data;
    const c2 = cards.find((c: { payment_method_id: string }) => c.payment_method_id === id2);
    expect(c2.is_default).toBe(true);
  });

  it("returns 404 for unknown pmId", async () => {
    const res = await server.inject({ method: "DELETE", url: "/api/payment-methods/pm_nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── PATCH /api/payment-methods/:pmId ────────────────────────────────────────

describe("PATCH /api/payment-methods/:pmId", () => {
  it("updates label successfully", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;

    const res = await server.inject({
      method: "PATCH",
      url: `/api/payment-methods/${pmId}`,
      payload: { label: "Updated Label" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.label).toBe("Updated Label");
  });

  it("PATCH response never contains secret fields", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;
    const res = await server.inject({
      method: "PATCH",
      url: `/api/payment-methods/${pmId}`,
      payload: { label: "New Label" },
    });
    assertNoSecrets(res.json());
  });

  it("returns 404 for unknown pmId", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/payment-methods/pm_nonexistent",
      payload: { label: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when patching an archived card", async () => {
    const r = await createCard();
    const pmId = r.json().data.payment_method_id;
    await server.inject({ method: "POST", url: `/api/payment-methods/${pmId}/archive` });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/payment-methods/${pmId}`,
      payload: { label: "New Label" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("ARCHIVED");
  });
});

// ─── Security invariants ──────────────────────────────────────────────────────

describe("Security invariants", () => {
  it("GET list never exposes any field named card_number, cvv, secret_ref, ciphertext, raw_value", async () => {
    await createCard();
    await createCard({ label: "Card 2", card_number: "5500000000000004" });
    const res = await server.inject({ method: "GET", url: "/api/payment-methods" });
    assertNoSecrets(res.json());
    const raw = res.body;
    expect(raw).not.toContain("secret_ref");
    expect(raw).not.toContain("raw_value");
    expect(raw).not.toContain("plaintext");
  });

  it("capability_ref equals payment_method_id (for runtime capability release system)", async () => {
    const r = await createCard();
    const data = r.json().data;
    expect(data.capability_ref).toBe(data.payment_method_id);
  });
});
