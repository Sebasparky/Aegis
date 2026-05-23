import type { FastifyInstance } from "fastify";
import type { PaymentCardFillAuthorization } from "@aegis/types";
import {
  MOCK_USER_ID,
  paymentCardFillAuthorizations,
  paymentCardFillRequests,
  userApprovalReceipts,
  sensitiveGrants,
  newId,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { buildSignedUserApprovalReceipt } from "../lib/userApprovalReceiptSigning.js";
import { buildSensitiveGrant } from "../lib/sensitiveGrants.js";

/**
 * Create a UserApprovalReceipt + SensitiveGrant for a payment card fill approval.
 * Throws APPROVAL_RECEIPT_SIGNING_FAILED if signing fails.
 * Grants are never created without a signed receipt.
 */
async function createPaymentCardFillGrant(auth: PaymentCardFillAuthorization): Promise<void> {
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
    approval_id: auth.authorization_id,
    approval_source: "payment_card_fill_authorization",
    action_type: "payment",
    target_domain: auth.domain,
    risk_level: "high",
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

  const grant = buildSensitiveGrant({
    grant_id: newId("sg"),
    grant_type: "payment_card_fill",
    scope: {
      user_id: auth.user_id,
      delegation_id: auth.delegation_id,
      domain: auth.domain,
      payment_method_id: auth.payment_method_id,
      authorization_id: auth.authorization_id,
    },
    expires_at: auth.expires_at,
    linked_uar_id: uarId,
    created_at: now,
  });

  sensitiveGrants.set(grant.grant_id, grant);
  schedulePersist();
}

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function paymentCardFillRoutes(server: FastifyInstance): Promise<void> {
  // ─── Approval UI routes ────────────────────────────────────────────────────────

  // List payment card fill authorizations for the approval UI.
  // Never returns payment_method_id, card_number_ref, cvv_ref, or any raw card value.
  server.get("/api/internal/payment-card-fill-authorizations", async (req, reply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    let items = Array.from(paymentCardFillAuthorizations.values()).filter(
      (a) => a.user_id === MOCK_USER_ID,
    );
    if (status) items = items.filter((a) => a.status === status);

    return reply.send({
      ok: true,
      data: items.map((a) => ({
        authorization_id: a.authorization_id,
        domain: a.domain,
        payment_method_label: a.payment_method_label,
        last4: a.last4,
        is_default: a.is_default,
        allowed_fields: a.allowed_fields,
        fields_filled: a.fields_filled,
        status: a.status,
        raw_values_revealed_to_agent: false as const,
        purchase_not_authorized: true as const,
        created_at: a.created_at,
        expires_at: a.expires_at,
        approved_at: a.approved_at,
        fulfilled_at: a.fulfilled_at,
        // Note: payment_method_id intentionally omitted
      })),
    });
  });

  // Approve a payment card fill authorization.
  server.post<{ Params: { id: string } }>(
    "/api/internal/payment-card-fill-authorizations/:id/approve",
    async (req, reply) => {
      const auth = paymentCardFillAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      if (auth.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (auth.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot approve authorization with status '${auth.status}'.`);
      }
      if (new Date(auth.expires_at) < new Date()) {
        auth.status = "expired";
        paymentCardFillAuthorizations.set(auth.authorization_id, auth);
        schedulePersist();
        return sendError(reply, 400, "EXPIRED", "Authorization has expired.");
      }

      const approvedAt = new Date().toISOString();
      try {
        await createPaymentCardFillGrant({ ...auth, approved_at: approvedAt });
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
      paymentCardFillAuthorizations.set(auth.authorization_id, auth);

      // Promote all linked pending fill requests to approved
      for (const req of paymentCardFillRequests.values()) {
        if (req.authorization_id === auth.authorization_id && req.status === "pending_approval") {
          req.status = "approved";
          req.approved_at = auth.approved_at;
          paymentCardFillRequests.set(req.fill_request_id, req);
        }
      }

      schedulePersist();
      return reply.send({
        ok: true,
        data: {
          authorization_id: auth.authorization_id,
          status: auth.status,
          raw_values_revealed_to_agent: false,
          purchase_not_authorized: true,
        },
      });
    },
  );

  // Deny a payment card fill authorization.
  server.post<{ Params: { id: string } }>(
    "/api/internal/payment-card-fill-authorizations/:id/deny",
    async (req, reply) => {
      const auth = paymentCardFillAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      if (auth.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (auth.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot deny authorization with status '${auth.status}'.`);
      }

      auth.status = "denied";
      paymentCardFillAuthorizations.set(auth.authorization_id, auth);

      // Cascade denial to all linked pending fill requests
      for (const req of paymentCardFillRequests.values()) {
        if (req.authorization_id === auth.authorization_id && req.status === "pending_approval") {
          req.status = "denied";
          paymentCardFillRequests.set(req.fill_request_id, req);
        }
      }

      schedulePersist();
      return reply.send({
        ok: true,
        data: { authorization_id: auth.authorization_id, status: auth.status },
      });
    },
  );
}
