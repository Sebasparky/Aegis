import type { FastifyInstance } from "fastify";
import { receipts, routeRunReceipts, MOCK_USER_ID } from "../store/index.js";

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
    const result = Array.from(routeRunReceipts.values())
      .filter((r) => r.user_id === MOCK_USER_ID)
      .sort((a, b) => b.completed_at?.localeCompare(a.completed_at ?? "") ?? -1);
    return { ok: true, data: result };
  });

  /**
   * GET /api/route-run-receipts/:receiptId
   *
   * Return a single RouteRunReceipt or 404.
   */
  server.get<{ Params: { receiptId: string } }>(
    "/api/route-run-receipts/:receiptId",
    async (req, reply) => {
      const receipt = routeRunReceipts.get(req.params.receiptId);
      if (!receipt || receipt.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Receipt not found.");
      }
      return { ok: true, data: receipt };
    }
  );
}
