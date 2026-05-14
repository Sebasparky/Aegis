import type { FastifyInstance } from "fastify";
import { userApprovalReceipts, MOCK_USER_ID } from "../store/index.js";
import { verifyStoredUserApprovalReceipt } from "../lib/userApprovalReceiptSigning.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function userApprovalReceiptRoutes(server: FastifyInstance) {
  /**
   * GET /api/user-approval-receipts
   *
   * List signed user approval receipts for the owner.
   * Optional query params:
   *   ?decision=approved|denied
   *   ?source=approval_request|route_run_rejection
   *
   * JWS is omitted from the list response to keep payloads small.
   * Use GET /api/user-approval-receipts/:receiptId for the full receipt including JWS.
   */
  server.get<{ Querystring: { decision?: string; source?: string } }>(
    "/api/user-approval-receipts",
    async (req) => {
      let result = Array.from(userApprovalReceipts.values()).filter(
        (r) => r.user_id === MOCK_USER_ID
      );

      if (req.query.decision) {
        result = result.filter((r) => r.decision === req.query.decision);
      }
      if (req.query.source) {
        result = result.filter((r) => r.approval_source === req.query.source);
      }

      result.sort((a, b) => b.created_at.localeCompare(a.created_at));

      // Omit jws from list response; include jws_present so callers know if signing occurred.
      const summary = result.map(({ verification, ...rest }) => ({
        ...rest,
        verification: {
          canonical_payload_hash: verification.canonical_payload_hash,
          jws_present: verification.jws_present,
          signing_alg: verification.signing_alg,
          signed_at: verification.signed_at,
          ...(verification.signing_key_id !== undefined
            ? { signing_key_id: verification.signing_key_id }
            : {}),
        },
      }));

      return { ok: true, data: summary };
    }
  );

  /**
   * GET /api/user-approval-receipts/:receiptId
   *
   * Full receipt including JWS signature.
   */
  server.get<{ Params: { receiptId: string } }>(
    "/api/user-approval-receipts/:receiptId",
    async (req, reply) => {
      const receipt = userApprovalReceipts.get(req.params.receiptId);
      if (!receipt || receipt.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "User approval receipt not found.");
      }
      return { ok: true, data: receipt };
    }
  );

  /**
   * GET /api/user-approval-receipts/:receiptId/verify
   *
   * Verify the cryptographic integrity of a stored receipt.
   * Returns valid: true only if both hash and JWS signature are intact.
   * Returns valid: false with error: "SIGNING_KEY_UNAVAILABLE" if the receipt was stored unsigned.
   * Returns valid: false with hash_valid: false if any signed field was tampered.
   */
  server.get<{ Params: { receiptId: string } }>(
    "/api/user-approval-receipts/:receiptId/verify",
    async (req, reply) => {
      const receipt = userApprovalReceipts.get(req.params.receiptId);
      if (!receipt || receipt.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "User approval receipt not found.");
      }

      const result = await verifyStoredUserApprovalReceipt(receipt);
      return { ok: true, data: result };
    }
  );
}
