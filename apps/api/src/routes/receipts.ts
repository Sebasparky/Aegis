import type { FastifyInstance } from "fastify";
import { receipts, MOCK_USER_ID } from "../store/index.js";

export async function receiptRoutes(server: FastifyInstance) {
  server.get("/api/receipts", async () => {
    const result = Array.from(receipts.values()).filter(
      (r) => r.user_id === MOCK_USER_ID
    );
    return { ok: true, data: result };
  });
}
