import type { FastifyInstance } from "fastify";
import type { PaymentMethod, PaymentMethodView, PaymentMethodBrand } from "@aegis/types";
import { MOCK_USER_ID, newId, paymentMethods } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getKmsProvider } from "../lib/kms.js";
import type { KmsContext } from "../lib/kms.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";
import { recordKmsAuditEvent } from "../lib/kmsAudit.js";

// ─── Internal request types ───────────────────────────────────────────────────

interface CreatePaymentMethodBody {
  label: string;
  cardholder_name: string;
  card_number: string;   // Full PAN — encrypted immediately, never persisted as plaintext
  cvv: string;           // Security code — encrypted immediately, never persisted as plaintext
  exp_month: number;
  exp_year: number;
  billing_zip?: string;
  billing_country?: string;
}

interface UpdatePaymentMethodBody {
  label?: string;
  cardholder_name?: string;
  exp_month?: number;
  exp_year?: number;
  billing_zip?: string;
  billing_country?: string;
  is_default?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveBrand(cardNumber: string): PaymentMethodBrand {
  const n = cardNumber.replace(/\D/g, "");
  if (/^4/.test(n)) return "visa";
  if (/^5[1-5]/.test(n)) return "mastercard";
  if (/^3[47]/.test(n)) return "amex";
  if (/^6/.test(n)) return "discover";
  return "unknown";
}

// Maps a legacy network string (PaymentMethodCapability) to a PaymentMethodBrand.
function networkToBrand(network: string | undefined): PaymentMethodBrand {
  const n = (network ?? "").toLowerCase();
  if (n === "visa")       return "visa";
  if (n === "mastercard") return "mastercard";
  if (n === "amex")       return "amex";
  if (n === "discover")   return "discover";
  return "unknown";
}

// Produces a safe PaymentMethodView from either a full PaymentMethod or a legacy
// PaymentMethodCapability record loaded from disk/seed. Never exposes card_number_ref,
// cvv_ref, ciphertext, or any other secret field.
function normalizePaymentMethodForView(raw: Record<string, unknown>): PaymentMethodView {
  const brand: PaymentMethodBrand =
    typeof raw.brand === "string"
      ? (raw.brand as PaymentMethodBrand)
      : networkToBrand(raw.network as string | undefined);

  const status: "active" | "archived" =
    raw.status === "archived" ? "archived" : "active";

  return {
    payment_method_id: raw.payment_method_id as string,
    user_id:           raw.user_id as string,
    label:             raw.label as string,
    cardholder_name:   typeof raw.cardholder_name === "string" ? raw.cardholder_name : "Demo Cardholder",
    brand,
    last4:             raw.last4 as string,
    exp_month:         typeof raw.exp_month === "number" ? raw.exp_month : 12,
    exp_year:          typeof raw.exp_year  === "number" ? raw.exp_year  : 2027,
    billing_zip:       typeof raw.billing_zip     === "string" ? raw.billing_zip     : undefined,
    billing_country:   typeof raw.billing_country === "string" ? raw.billing_country : undefined,
    is_default:        raw.is_default === true,
    status,
    capability_ref:    raw.capability_ref as string,
    created_at:        raw.created_at as string,
    updated_at:        typeof raw.updated_at === "string" ? raw.updated_at : raw.created_at as string,
  };
}

// Returns active cards for a user. Treats missing status as "active" to handle
// legacy PaymentMethodCapability records that predate the status field.
function getActiveCards(userId: string): PaymentMethod[] {
  return Array.from(paymentMethods.values())
    .filter((pm) => {
      const raw = pm as unknown as Record<string, unknown>;
      return raw.user_id === userId && raw.status !== "archived";
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Unsets is_default on all active cards for userId except the one with exceptId.
function unsetOtherDefaults(userId: string, exceptId: string): void {
  const now = new Date().toISOString();
  for (const pm of paymentMethods.values()) {
    if (pm.user_id === userId && pm.is_default && pm.payment_method_id !== exceptId) {
      pm.is_default = false;
      pm.updated_at = now;
    }
  }
}

// Promotes the oldest remaining active card to default after the previous default is gone.
function promoteNextDefault(userId: string): void {
  const candidates = getActiveCards(userId).filter((pm) => !pm.is_default);
  if (candidates.length > 0) {
    candidates[0].is_default = true;
    candidates[0].updated_at = new Date().toISOString();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function paymentMethodRoutes(server: FastifyInstance) {
  // GET /api/payment-methods
  server.get("/api/payment-methods", async () => {
    const cards = Array.from(paymentMethods.values())
      .filter((pm) => pm.user_id === MOCK_USER_ID)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((pm) => normalizePaymentMethodForView(pm as unknown as Record<string, unknown>));
    return { ok: true, data: cards };
  });

  // POST /api/payment-methods
  server.post<{ Body: CreatePaymentMethodBody }>("/api/payment-methods", async (req, reply) => {
    const { label, cardholder_name, card_number, cvv, exp_month, exp_year, billing_zip, billing_country } = req.body ?? {};

    // Validation — never log card_number or cvv
    if (!label?.trim()) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "label is required." } });
    }
    if (!cardholder_name?.trim()) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "cardholder_name is required." } });
    }
    if (!card_number) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "card_number is required." } });
    }
    const cleanCard = card_number.replace(/[\s\-]/g, "");
    if (!/^\d{13,19}$/.test(cleanCard)) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "card_number must be 13–19 digits." } });
    }
    if (!cvv) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "cvv is required." } });
    }
    if (!/^\d{3,4}$/.test(cvv.trim())) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "cvv must be 3 or 4 digits." } });
    }
    const month = Number(exp_month);
    if (!month || month < 1 || month > 12) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "exp_month must be 1–12." } });
    }
    const year = Number(exp_year);
    if (!year || year < 2000 || year > 2099) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "exp_year must be a 4-digit year." } });
    }

    const payment_method_id = newId("pm");
    const now = new Date().toISOString();
    const brand = deriveBrand(cleanCard);
    const last4 = cleanCard.slice(-4);
    const card_number_ref = `devvault://${payment_method_id}/card_number`;
    const cvv_ref = `devvault://${payment_method_id}/cvv`;

    const kms = getKmsProvider();
    const baseContext: Omit<KmsContext, "purpose"> = {
      user_id: MOCK_USER_ID,
      pass_id: payment_method_id,
      domain: "aegis.payment",
    };

    let cardBlob;
    let cvvBlob;
    try {
      cardBlob = await kms.encryptSecret(cleanCard, { ...baseContext, purpose: "payment_card_number" });
      recordKmsAuditEvent({ operation: "encrypt_secret", provider: kms.provider, user_id: MOCK_USER_ID, pass_id: payment_method_id, domain: "aegis.payment", success: true });
    } catch (err) {
      recordKmsAuditEvent({ operation: "encrypt_secret", provider: kms.provider, user_id: MOCK_USER_ID, pass_id: payment_method_id, domain: "aegis.payment", success: false });
      return reply.status(500).send({ ok: false, error: { code: "ENCRYPTION_FAILED", message: "Failed to encrypt card number." } });
    }
    try {
      cvvBlob = await kms.encryptSecret(cvv.trim(), { ...baseContext, purpose: "payment_cvv" });
      recordKmsAuditEvent({ operation: "encrypt_secret", provider: kms.provider, user_id: MOCK_USER_ID, pass_id: payment_method_id, domain: "aegis.payment", success: true });
    } catch (err) {
      recordKmsAuditEvent({ operation: "encrypt_secret", provider: kms.provider, user_id: MOCK_USER_ID, pass_id: payment_method_id, domain: "aegis.payment", success: false });
      return reply.status(500).send({ ok: false, error: { code: "ENCRYPTION_FAILED", message: "Failed to encrypt CVV." } });
    }

    const repo = getVaultRepository();
    await repo.storeEncryptedSecret(card_number_ref, cardBlob);
    await repo.storeEncryptedSecret(cvv_ref, cvvBlob);

    // First active card for this user automatically becomes the default.
    const existingActive = getActiveCards(MOCK_USER_ID);
    const isDefault = existingActive.length === 0;

    const pm: PaymentMethod = {
      payment_method_id,
      user_id: MOCK_USER_ID,
      label: label.trim(),
      cardholder_name: cardholder_name.trim(),
      brand,
      last4,
      exp_month: month,
      exp_year: year,
      billing_zip: billing_zip?.trim() || undefined,
      billing_country: billing_country?.trim() || undefined,
      is_default: isDefault,
      status: "active",
      card_number_ref,
      cvv_ref,
      capability_ref: payment_method_id,
      created_at: now,
      updated_at: now,
    };

    paymentMethods.set(payment_method_id, pm);
    schedulePersist();

    return reply.status(201).send({ ok: true, data: normalizePaymentMethodForView(pm as unknown as Record<string, unknown>) });
  });

  // PATCH /api/payment-methods/:pmId
  server.patch<{ Params: { pmId: string }; Body: UpdatePaymentMethodBody }>(
    "/api/payment-methods/:pmId",
    async (req, reply) => {
      const pm = paymentMethods.get(req.params.pmId);
      if (!pm || pm.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Payment method not found." } });
      }
      if (pm.status === "archived") {
        return reply.status(400).send({ ok: false, error: { code: "ARCHIVED", message: "Cannot update an archived payment method." } });
      }

      const { label, cardholder_name, exp_month, exp_year, billing_zip, billing_country, is_default } = req.body ?? {};
      const now = new Date().toISOString();

      if (label !== undefined) pm.label = label.trim();
      if (cardholder_name !== undefined) pm.cardholder_name = cardholder_name.trim();
      if (exp_month !== undefined) {
        const m = Number(exp_month);
        if (m < 1 || m > 12) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "exp_month must be 1–12." } });
        }
        pm.exp_month = m;
      }
      if (exp_year !== undefined) {
        const y = Number(exp_year);
        if (y < 2000 || y > 2099) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "exp_year must be a 4-digit year." } });
        }
        pm.exp_year = y;
      }
      if (billing_zip !== undefined) pm.billing_zip = billing_zip?.trim() || undefined;
      if (billing_country !== undefined) pm.billing_country = billing_country?.trim() || undefined;

      if (is_default === true && !pm.is_default) {
        unsetOtherDefaults(MOCK_USER_ID, pm.payment_method_id);
        pm.is_default = true;
      }

      pm.updated_at = now;
      schedulePersist();

      return { ok: true, data: normalizePaymentMethodForView(pm as unknown as Record<string, unknown>) };
    }
  );

  // POST /api/payment-methods/:pmId/archive
  server.post<{ Params: { pmId: string } }>("/api/payment-methods/:pmId/archive", async (req, reply) => {
    const pm = paymentMethods.get(req.params.pmId);
    if (!pm || pm.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Payment method not found." } });
    }
    if (pm.status === "archived") {
      return { ok: true, data: normalizePaymentMethodForView(pm as unknown as Record<string, unknown>) };
    }

    const wasDefault = pm.is_default;
    pm.status = "archived";
    pm.is_default = false;
    pm.updated_at = new Date().toISOString();

    if (wasDefault) {
      promoteNextDefault(MOCK_USER_ID);
    }

    schedulePersist();
    return { ok: true, data: normalizePaymentMethodForView(pm as unknown as Record<string, unknown>) };
  });

  // DELETE /api/payment-methods/:pmId
  server.delete<{ Params: { pmId: string } }>("/api/payment-methods/:pmId", async (req, reply) => {
    const pm = paymentMethods.get(req.params.pmId);
    if (!pm || pm.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Payment method not found." } });
    }

    const wasDefault = pm.is_default && pm.status === "active";
    paymentMethods.delete(pm.payment_method_id);

    const repo = getVaultRepository();
    await repo.removeEncryptedSecret(pm.card_number_ref);
    await repo.removeEncryptedSecret(pm.cvv_ref);

    if (wasDefault) {
      promoteNextDefault(MOCK_USER_ID);
    }

    schedulePersist();
    return { ok: true };
  });
}
