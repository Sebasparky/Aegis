import type { FastifyInstance } from "fastify";
import { MOCK_USER_ID } from "../store/index.js";
import {
  authenticatedSessionHandles,
  executeLoginForAuthenticatedSession,
  rejectAuthenticatedSession,
} from "../runtime/authenticatedSessions.js";

export async function authenticatedSessionRoutes(server: FastifyInstance): Promise<void> {
  // List authenticated session handles for the UI
  server.get("/api/authenticated-sessions", async (req, reply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    let handles = Array.from(authenticatedSessionHandles.values()).filter(
      (h) => h.user_id === MOCK_USER_ID,
    );
    if (status) {
      handles = handles.filter((h) => h.status === status);
    }
    return reply.send({ ok: true, data: handles });
  });

  // Approve: trigger Playwright login (fire-and-forget)
  server.post<{ Params: { sessionId: string } }>(
    "/api/authenticated-sessions/:sessionId/approve",
    async (req, reply) => {
      const { sessionId } = req.params;
      const handle = authenticatedSessionHandles.get(sessionId);
      if (!handle) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Session not found." } });
      }
      if (handle.user_id !== MOCK_USER_ID) {
        return reply.status(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Forbidden." } });
      }
      if (handle.status !== "pending_approval") {
        return reply.status(400).send({
          ok: false,
          error: {
            code: "INVALID_STATUS",
            message: `Session status is '${handle.status}'; only 'pending_approval' sessions can be approved.`,
          },
        });
      }

      // Transition to login_in_progress and fire login async
      executeLoginForAuthenticatedSession(sessionId).catch((err) => {
        console.error(`[auth-session] Login execution failed for ${sessionId}:`, err);
      });

      return reply.send({ ok: true, data: handle });
    },
  );

  // Reject: mark session as failed
  server.post<{ Params: { sessionId: string } }>(
    "/api/authenticated-sessions/:sessionId/reject",
    async (req, reply) => {
      const { sessionId } = req.params;
      const handle = authenticatedSessionHandles.get(sessionId);
      if (!handle) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Session not found." } });
      }
      if (handle.user_id !== MOCK_USER_ID) {
        return reply.status(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Forbidden." } });
      }
      rejectAuthenticatedSession(sessionId);
      return reply.send({ ok: true, data: handle });
    },
  );
}
