import type { FastifyInstance } from "fastify";
import type { PurchaseConfirmationAuthorization } from "@aegis/types";
import {
  MOCK_USER_ID,
  purchaseConfirmationAuthorizations,
  userApprovalReceipts,
  newId,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { buildSignedUserApprovalReceipt } from "../lib/userApprovalReceiptSigning.js";

async function createPurchaseConfirmationApprovalReceipt(
  auth: PurchaseConfirmationAuthorization,
): Promise<void> {
  const now = new Date().toISOString();
  const uarId = newId("uar");

  const uar = await buildSignedUserApprovalReceipt({
    receipt_id: uarId,
    receipt_type: "user_approval",
    schema_version: "1.0",
    issuer: "aegis",
    created_at: now,
    user_id: auth.user_id,
    delegation_id: auth.delegation_id,
    approval_id: auth.purchase_confirmation_id,
    approval_source: "purchase_confirmation_authorization",
    action_type: "purchase",
    target_domain: auth.domain,
    risk_level: "critical",
    decision: "approved",
    decided_at: auth.approved_at ?? now,
    decision_source: "user_click",
    raw_secrets_in_receipt: false,
    raw_credentials_in_receipt: false,
  });

  if (!uar.verification.jws_present) {
    throw new Error("APPROVAL_RECEIPT_SIGNING_FAILED");
  }

  userApprovalReceipts.set(uarId, uar);
}

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

/** Safe view for UI — never exposes payment_method_id or raw card values. */
function safeView(auth: PurchaseConfirmationAuthorization) {
  return {
    purchase_confirmation_id: auth.purchase_confirmation_id,
    domain: auth.domain,
    page_url: auth.page_url,
    merchant: auth.merchant,
    amount: auth.amount,
    currency: auth.currency,
    amount_unknown: auth.amount_unknown,
    item_summary: auth.item_summary,
    payment_method_label: auth.payment_method_label,
    payment_method_last4: auth.payment_method_last4,
    button_text: auth.button_text,
    card_fill_authorization_id: auth.card_fill_authorization_id,
    status: auth.status,
    risk_level: auth.risk_level,
    raw_values_revealed_to_agent: false as const,
    purchase_action_authorized: auth.purchase_action_authorized,
    created_at: auth.created_at,
    expires_at: auth.expires_at,
    approved_at: auth.approved_at,
    fulfilled_at: auth.fulfilled_at,
    // payment_method_id intentionally omitted
  };
}

export async function purchaseConfirmationRoutes(server: FastifyInstance): Promise<void> {
  // ─── List purchase confirmation authorizations for the approval UI ─────────────

  server.get("/api/internal/purchase-confirmation-authorizations", async (req, reply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    let items = Array.from(purchaseConfirmationAuthorizations.values()).filter(
      (a) => a.user_id === MOCK_USER_ID,
    );
    if (status) items = items.filter((a) => a.status === status);

    return reply.send({ ok: true, data: items.map(safeView) });
  });

  // ─── Approve a purchase confirmation authorization ─────────────────────────────

  server.post<{ Params: { id: string } }>(
    "/api/internal/purchase-confirmation-authorizations/:id/approve",
    async (req, reply) => {
      const auth = purchaseConfirmationAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      if (auth.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");

      // Idempotent: already approved → return current state without error
      if (auth.status === "approved") {
        return reply.send({
          ok: true,
          data: { purchase_confirmation_id: auth.purchase_confirmation_id, status: auth.status, purchase_action_authorized: auth.purchase_action_authorized },
        });
      }

      if (auth.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot approve authorization with status '${auth.status}'.`);
      }
      if (new Date(auth.expires_at) < new Date()) {
        auth.status = "expired";
        purchaseConfirmationAuthorizations.set(auth.purchase_confirmation_id, auth);
        schedulePersist();
        return sendError(reply, 400, "EXPIRED", "Authorization has expired.");
      }

      const approvedAt = new Date().toISOString();
      try {
        await createPurchaseConfirmationApprovalReceipt({ ...auth, approved_at: approvedAt });
      } catch {
        return sendError(
          reply,
          500,
          "APPROVAL_RECEIPT_SIGNING_FAILED",
          "Unable to create signed approval receipt. Authorization not processed.",
        );
      }

      auth.status = "approved";
      auth.approved_at = approvedAt;
      auth.purchase_action_authorized = true;
      purchaseConfirmationAuthorizations.set(auth.purchase_confirmation_id, auth);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          purchase_confirmation_id: auth.purchase_confirmation_id,
          status: auth.status,
          purchase_action_authorized: auth.purchase_action_authorized,
          raw_values_revealed_to_agent: false,
        },
      });
    },
  );

  // ─── Deny a purchase confirmation authorization ────────────────────────────────

  server.post<{ Params: { id: string } }>(
    "/api/internal/purchase-confirmation-authorizations/:id/deny",
    async (req, reply) => {
      const auth = purchaseConfirmationAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      if (auth.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (auth.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot deny authorization with status '${auth.status}'.`);
      }

      auth.status = "denied";
      auth.purchase_action_authorized = false;
      purchaseConfirmationAuthorizations.set(auth.purchase_confirmation_id, auth);
      schedulePersist();

      return reply.send({
        ok: true,
        data: { purchase_confirmation_id: auth.purchase_confirmation_id, status: auth.status },
      });
    },
  );
}
