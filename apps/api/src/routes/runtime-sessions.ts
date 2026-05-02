import type { FastifyInstance } from "fastify";
import { routeRuns } from "../store/index.js";
import { executeRouteRunWithPlaywright } from "../runtime/playwrightRuntime.js";
import { runtimeSessions } from "../runtime/aegisRuntime.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function runtimeSessionRoutes(server: FastifyInstance) {
  /**
   * POST /api/runtime/route-runs/:runId/playwright/start
   *
   * Start an approved pending RouteRun in the Aegis Playwright controlled runtime.
   * Refuses runs that are pending_approval — user must approve first.
   * Synchronous for v1: awaits completion before responding.
   */
  server.post<{ Params: { runId: string } }>(
    "/api/runtime/route-runs/:runId/playwright/start",
    async (req, reply) => {
      const { runId } = req.params;

      const run = routeRuns.get(runId);
      if (!run) return sendError(reply, 404, "NOT_FOUND", "Run not found.");

      if (run.status === "pending_approval") {
        return sendError(reply, 409, "APPROVAL_REQUIRED", "Run requires user approval before Playwright execution. Approve at /route-run-approvals.");
      }

      if (run.status === "completed" || run.status === "failed" || run.status === "blocked") {
        return sendError(reply, 409, "RUN_ALREADY_TERMINAL", `Run is already in terminal state: ${run.status}.`);
      }

      // If already running, return the existing session if one exists
      if (run.status === "running") {
        const existing = Array.from(runtimeSessions.values()).find(
          (s) => s.run_id === runId && s.execution_surface === "aegis_playwright"
        );
        if (existing) return reply.send({ ok: true, data: existing });
      }

      let session;
      try {
        session = await executeRouteRunWithPlaywright(runId);
      } catch (err: any) {
        const code = err?.code ?? "EXECUTION_FAILED";
        const status = code === "APPROVAL_REQUIRED" ? 409 : 500;
        return sendError(reply, status, code, err?.message ?? "Playwright execution failed.");
      }

      return reply.send({ ok: true, data: session });
    }
  );

  /**
   * GET /api/runtime/sessions
   *
   * List all Playwright runtime sessions (ephemeral — lost on API restart).
   */
  server.get("/api/runtime/sessions", async (_req, reply) => {
    const sessions = Array.from(runtimeSessions.values());
    return reply.send({ ok: true, data: sessions });
  });

  /**
   * GET /api/runtime/sessions/:runtimeSessionId
   */
  server.get<{ Params: { runtimeSessionId: string } }>(
    "/api/runtime/sessions/:runtimeSessionId",
    async (req, reply) => {
      const session = runtimeSessions.get(req.params.runtimeSessionId);
      if (!session) return sendError(reply, 404, "NOT_FOUND", "Runtime session not found.");
      return reply.send({ ok: true, data: session });
    }
  );
}
