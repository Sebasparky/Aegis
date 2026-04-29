import type { FastifyInstance } from "fastify";
import { users, MOCK_USER_ID } from "../store/index.js";

export async function userRoutes(server: FastifyInstance) {
  server.get("/api/user/me", async (_req, reply) => {
    const user = users.get(MOCK_USER_ID);
    if (!user) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "User not found." } });
    }
    return { ok: true, data: user };
  });
}
