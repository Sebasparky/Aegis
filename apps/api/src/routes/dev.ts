import type { FastifyInstance } from "fastify";
import { resetStoreForDemo } from "../store/persistence.js";

export async function devRoutes(server: FastifyInstance) {
  server.post("/api/dev/reset-store", async () => {
    resetStoreForDemo();
    return { ok: true, data: { reset: true } };
  });
}
