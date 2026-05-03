import type { FastifyInstance } from "fastify";
import {
  runtimeSessions,
  getLatestObservationSnapshot,
  getObservationModeState,
} from "../runtime/aegisRuntime.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function runtimeObservationRoutes(server: FastifyInstance) {
  /**
   * GET /api/runtime-sessions/:sessionId/observation
   *
   * Returns the latest agent-safe observation snapshot for this runtime session.
   * Never exposes raw DOM, raw page content, sensitive field values, passwords,
   * card numbers, CVVs, or any secret. Only agent-safe metadata.
   */
  server.get<{ Params: { sessionId: string } }>(
    "/api/runtime-sessions/:sessionId/observation",
    async (req, reply) => {
      const { sessionId } = req.params;

      if (!runtimeSessions.has(sessionId)) {
        return sendError(reply, 404, "NOT_FOUND", "Runtime session not found.");
      }

      const snapshot = getLatestObservationSnapshot(sessionId);
      if (!snapshot) {
        return sendError(reply, 404, "NO_SNAPSHOT", "No observation snapshot available for this session yet.");
      }

      return reply.send({ ok: true, data: snapshot });
    }
  );

  /**
   * GET /api/runtime-sessions/:sessionId/observation-mode
   *
   * Returns the current observation mode state for this runtime session.
   */
  server.get<{ Params: { sessionId: string } }>(
    "/api/runtime-sessions/:sessionId/observation-mode",
    async (req, reply) => {
      const { sessionId } = req.params;

      if (!runtimeSessions.has(sessionId)) {
        return sendError(reply, 404, "NOT_FOUND", "Runtime session not found.");
      }

      const modeState = getObservationModeState(sessionId);
      if (!modeState) {
        return sendError(reply, 404, "NO_OBSERVATION_MODE", "Observation mode state not available for this session.");
      }

      return reply.send({ ok: true, data: modeState });
    }
  );
}
