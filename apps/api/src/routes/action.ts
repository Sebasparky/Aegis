import type { FastifyInstance } from "fastify";
import type { ActionRequest } from "@aegis/types";
import { sessions, collars, routes } from "../store/index.js";
import { evaluateActionRequest } from "../services/actionPolicyService.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function actionRoutes(server: FastifyInstance) {
  /**
   * POST /api/action/request
   *
   * Policy decision layer for agent-requested route actions.
   * Returns allow | block | approval_required | pause.
   *
   * Does NOT execute browser actions.
   * Does NOT create approval inbox requests.
   * Collar restrictions always override route permissions.
   * Agents never receive a Playwright handle or unrestricted browser context.
   */
  server.post<{ Body: ActionRequest }>("/api/action/request", async (req, reply) => {
    const body = req.body ?? {};

    if (!body.session_id) return sendError(reply, 400, "VALIDATION_ERROR", "session_id is required.");
    if (!body.route_id) return sendError(reply, 400, "VALIDATION_ERROR", "route_id is required.");
    if (!body.requested_action?.type) return sendError(reply, 400, "VALIDATION_ERROR", "requested_action.type is required.");
    if (!body.requested_action?.step_id) return sendError(reply, 400, "VALIDATION_ERROR", "requested_action.step_id is required.");
    if (!body.requested_action?.target_locator) return sendError(reply, 400, "VALIDATION_ERROR", "requested_action.target_locator is required.");

    const result = evaluateActionRequest(body, sessions, collars, routes);

    if (!result.ok) {
      return sendError(reply, result.status, result.code, result.message);
    }

    return { ok: true, data: result.data };
  });
}
