import type { FastifyInstance } from "fastify";
import { MOCK_USER_ID } from "../store/index.js";
import {
  taskBrowserSessions,
  createTaskBrowserSession,
  getTaskBrowserSession,
  closeTaskBrowserSession,
  type CreateTaskBrowserResult,
} from "../runtime/taskBrowserSessions.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

// Safe fields returned to callers — never includes PIDs, process handles, or raw filesystem paths in agent-facing paths.
// Internal API returns user_data_dir for local dev debugging; MCP tool layer omits it.
function safeSessionView(session: ReturnType<typeof getTaskBrowserSession>) {
  if (!session) return null;
  return {
    browser_session_id: session.browser_session_id,
    user_id: session.user_id,
    delegation_id: session.delegation_id,
    status: session.status,
    cdp_url: session.cdp_url,
    cdp_port: session.cdp_port,
    user_data_dir: session.user_data_dir,
    ephemeral: session.ephemeral,
    created_at: session.created_at,
    expires_at: session.expires_at,
    closed_at: session.closed_at,
    cleanup_complete: session.cleanup_complete,
    error: session.error,
  };
}

export async function taskBrowserSessionRoutes(server: FastifyInstance): Promise<void> {
  // POST /api/task-browser-sessions — create an ephemeral task browser session
  server.post("/api/task-browser-sessions", async (req, reply) => {
    const body = (req.body ?? {}) as { delegation_id?: string };
    try {
      const result: CreateTaskBrowserResult = await createTaskBrowserSession({
        user_id: MOCK_USER_ID,
        delegation_id: body.delegation_id,
      });
      const { session, reused_existing, port_auto_selected, requires_browser_reconnect, user_message } = result;
      const meta: Record<string, unknown> = { user_message };
      if (reused_existing) meta.reused_existing = true;
      if (port_auto_selected) meta.port_auto_selected = true;
      if (requires_browser_reconnect) meta.requires_browser_reconnect = true;
      const httpStatus = reused_existing ? 200 : 201;
      return reply.status(httpStatus).send({ ok: true, data: { ...safeSessionView(session), ...meta } });
    } catch (err: unknown) {
      if (err instanceof Error) {
        const code = (err as any).code ?? "UNKNOWN_ERROR";
        if (code === "NO_PORTS_AVAILABLE") return sendError(reply, 503, code, err.message);
        if (code === "CHROME_NOT_FOUND") return sendError(reply, 500, code, err.message);
        if (code === "CDP_NOT_READY") return sendError(reply, 500, code, err.message);
        return sendError(reply, 500, code, err.message);
      }
      throw err;
    }
  });

  // GET /api/task-browser-sessions — list sessions for local dev user
  server.get("/api/task-browser-sessions", async (req, reply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    let items = Array.from(taskBrowserSessions.values()).filter(
      (s) => s.user_id === MOCK_USER_ID,
    );
    if (status) items = items.filter((s) => s.status === status);
    return reply.send({ ok: true, data: items.map(safeSessionView) });
  });

  // GET /api/task-browser-sessions/:id — get a single session
  server.get<{ Params: { id: string } }>(
    "/api/task-browser-sessions/:id",
    async (req, reply) => {
      const session = getTaskBrowserSession(req.params.id, MOCK_USER_ID);
      if (!session) return sendError(reply, 404, "NOT_FOUND", "Session not found.");
      return reply.send({ ok: true, data: safeSessionView(session) });
    },
  );

  // POST /api/task-browser-sessions/:id/close — close and destroy profile
  server.post<{ Params: { id: string } }>(
    "/api/task-browser-sessions/:id/close",
    async (req, reply) => {
      try {
        const session = await closeTaskBrowserSession(req.params.id, MOCK_USER_ID);
        return reply.send({
          ok: true,
          data: {
            browser_session_id: session.browser_session_id,
            status: session.status,
            closed_at: session.closed_at,
            cleanup_complete: session.cleanup_complete,
            ...(session.error ? { error: session.error } : {}),
          },
        });
      } catch (err: unknown) {
        if (err instanceof Error) {
          const code = (err as any).code ?? "UNKNOWN_ERROR";
          if (code === "NOT_FOUND") return sendError(reply, 404, code, err.message);
          if (code === "FORBIDDEN") return sendError(reply, 403, code, err.message);
          return sendError(reply, 500, code, err.message);
        }
        throw err;
      }
    },
  );
}
