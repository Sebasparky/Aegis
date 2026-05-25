import type { FastifyInstance } from "fastify";
import { MOCK_USER_ID } from "../store/index.js";
import {
  taskBrowserSessions,
  createTaskBrowserSession,
  getTaskBrowserSession,
  closeTaskBrowserSession,
  getPortStatusForDiagnostics,
  cleanupOrphanedBrowserProcesses,
  type CreateTaskBrowserResult,
} from "../runtime/taskBrowserSessions.js";
import { requireAgentToken } from "./agent-api.js";
import { loginDiagnosticsStore } from "../lib/loginDiagnostics.js";

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
    mode: session.mode,
    debug_visible: session.debug_visible,
    runtime_mode: session.runtime_mode,
    created_at: session.created_at,
    expires_at: session.expires_at,
    closed_at: session.closed_at,
    cleanup_complete: session.cleanup_complete,
    error: session.error,
  };
}

export async function taskBrowserSessionRoutes(server: FastifyInstance): Promise<void> {
  // POST /api/task-browser-sessions — create an ephemeral task browser session.
  // Requires a valid Bearer token. delegation_id is derived from the token;
  // any delegation_id in the request body is ignored. No collar required —
  // sensitive actions within the session are gated by the collar/baseline at run time.
  server.post("/api/task-browser-sessions", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    try {
      const body = (req.body ?? {}) as { debug_visible?: boolean };
      const debug_visible = body.debug_visible === true;

      const result: CreateTaskBrowserResult = await createTaskBrowserSession({
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        debug_visible,
      });
      const { session, reused_existing, port_auto_selected, requires_browser_reconnect, user_message, mode } = result;
      const meta: Record<string, unknown> = { user_message, mode };
      if (reused_existing) meta.reused_existing = true;
      if (port_auto_selected) meta.port_auto_selected = true;
      if (requires_browser_reconnect) meta.requires_browser_reconnect = true;
      const httpStatus = reused_existing ? 200 : 201;
      return reply.status(httpStatus).send({ ok: true, data: { ...safeSessionView(session), ...meta } });
    } catch (err: unknown) {
      if (err instanceof Error) {
        const e = err as Error & { code?: string; occupied_port_range?: string; tracked_occupied_sessions?: unknown[] };
        const code = e.code ?? "UNKNOWN_ERROR";
        if (code === "NO_PORTS_AVAILABLE") {
          return reply.status(503).send({
            ok: false,
            error: {
              code,
              message: e.message,
              ...(e.occupied_port_range ? { occupied_port_range: e.occupied_port_range } : {}),
              tracked_occupied_sessions: e.tracked_occupied_sessions ?? [],
            },
          });
        }
        if (code === "CHROME_NOT_FOUND") return sendError(reply, 500, code, err.message);
        if (code === "CDP_NOT_READY") return sendError(reply, 500, code, err.message);
        return sendError(reply, 500, code, err.message);
      }
      throw err;
    }
  });

  // GET /api/task-browser-sessions — list sessions (internal/UI-only, not for external agents).
  server.get("/api/task-browser-sessions", async (req, reply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    let items = Array.from(taskBrowserSessions.values()).filter(
      (s) => s.user_id === MOCK_USER_ID,
    );
    if (status) items = items.filter((s) => s.status === status);
    return reply.send({ ok: true, data: items.map(safeSessionView) });
  });

  // GET /api/task-browser-sessions/:id — get a single session.
  // Requires a valid Bearer token; the session must belong to the caller's delegation.
  server.get<{ Params: { id: string } }>(
    "/api/task-browser-sessions/:id",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const session = getTaskBrowserSession(req.params.id, MOCK_USER_ID);
      if (!session) return sendError(reply, 404, "NOT_FOUND", "Session not found.");
      if (session.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This session does not belong to your delegation.");
      }
      return reply.send({ ok: true, data: safeSessionView(session) });
    },
  );

  // POST /api/task-browser-sessions/:id/close — close and destroy profile.
  // Requires a valid Bearer token; the session must belong to the caller's delegation.
  server.post<{ Params: { id: string } }>(
    "/api/task-browser-sessions/:id/close",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const session = getTaskBrowserSession(req.params.id, MOCK_USER_ID);
      if (!session) return sendError(reply, 404, "NOT_FOUND", "Session not found.");
      if (session.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This session does not belong to your delegation.");
      }

      try {
        const closed = await closeTaskBrowserSession(req.params.id, MOCK_USER_ID);
        return reply.send({
          ok: true,
          data: {
            browser_session_id: closed.browser_session_id,
            status: closed.status,
            closed_at: closed.closed_at,
            cleanup_complete: closed.cleanup_complete,
            ...(closed.error ? { error: closed.error } : {}),
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

  // GET /api/internal/task-browser-port-status — dev diagnostic: port occupancy and session inventory.
  // Never returns PIDs, user_data_dir paths, secrets, or credentials.
  server.get("/api/internal/task-browser-port-status", async (_req, reply) => {
    const status = await getPortStatusForDiagnostics();
    return reply.send({ ok: true, data: status });
  });

  // POST /api/internal/runtime-browser-sessions/cleanup-orphans
  // Dev/internal only — finds and kills untracked Aegis Chrome processes holding managed CDP ports.
  // Never kills processes that do not carry the aegis-agent-browser profile marker.
  server.post("/api/internal/runtime-browser-sessions/cleanup-orphans", async (_req, reply) => {
    const result = await cleanupOrphanedBrowserProcesses();
    return reply.send({
      ok: true,
      data: {
        ...result,
        message:
          result.orphans_killed > 0
            ? `Killed ${result.orphans_killed} orphaned Aegis browser process(es). ${result.ports_freed} port(s) now available.`
            : "No orphaned Aegis browser processes found.",
      },
    });
  });

  // GET /api/internal/login-diagnostics/recent — recent login failure diagnostics for the current user.
  // Internal/UI-only. Returns newest-first, capped at 20.
  server.get("/api/internal/login-diagnostics/recent", async (_req, reply) => {
    const items = Array.from(loginDiagnosticsStore.values())
      .filter((d) => d.user_id === MOCK_USER_ID)
      .sort((a, b) => b.detected_at.localeCompare(a.detected_at))
      .slice(0, 20)
      .map(({ user_id: _uid, ...rest }) => rest);
    return reply.send({ ok: true, data: items });
  });
}
