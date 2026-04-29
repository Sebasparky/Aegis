import type { FastifyInstance } from "fastify";
import { sessions, MOCK_USER_ID } from "../store/index.js";

export async function sessionRoutes(server: FastifyInstance) {
  // List sessions for the current user (read-only; browser sessions not yet implemented)
  server.get("/api/sessions", async () => {
    const result = Array.from(sessions.values()).filter(
      (s) => s.user_id === MOCK_USER_ID
    );
    return { ok: true, data: result };
  });
}
