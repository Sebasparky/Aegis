import type { FastifyInstance } from "fastify";
import { receipts, MOCK_USER_ID } from "../store/index.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function receiptRoutes(server: FastifyInstance) {
  server.get("/api/receipts", async () => {
    const result = Array.from(receipts.values()).filter(
      (r) => r.user_id === MOCK_USER_ID
    );
    return { ok: true, data: result };
  });

  /**
   * GET /api/route-run-receipts
   *
   * List RouteRunReceipts for the demo user, newest first.
   */
  server.get("/api/route-run-receipts", async () => {
    const result = await getReceiptRepository().listReceipts(MOCK_USER_ID);
    return {
      ok: true,
      data: result.sort(
        (a, b) => b.completed_at?.localeCompare(a.completed_at ?? "") ?? -1
      ),
    };
  });

  /**
   * GET /api/route-run-receipts/:receiptId
   *
   * Return a single RouteRunReceipt or 404.
   */
  server.get<{ Params: { receiptId: string } }>(
    "/api/route-run-receipts/:receiptId",
    async (req, reply) => {
      const receipt = await getReceiptRepository().getReceipt(req.params.receiptId);
      if (!receipt || receipt.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Receipt not found.");
      }
      return { ok: true, data: receipt };
    }
  );

  /**
   * GET /api/route-run-receipts/:receiptId/verify
   *
   * Verify the cryptographic integrity of a receipt.
   * Returns hash validity, JWS signature validity, and hash chain link status.
   * Does not re-execute the route or expose any secrets.
   */
  server.get<{ Params: { receiptId: string } }>(
    "/api/route-run-receipts/:receiptId/verify",
    async (req, reply) => {
      const result = await getReceiptRepository().verifyReceipt(req.params.receiptId);
      if (!result) {
        return sendError(reply, 404, "NOT_FOUND", "Receipt not found.");
      }
      return { ok: true, data: result };
    }
  );
}
