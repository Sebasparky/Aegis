import type { FastifyInstance } from "fastify";
import {
  getBrowserRunTrace,
  listBrowserRunTraces,
  recordBrowserTraceEvent,
  type BrowserToolSurface,
  type BrowserToolDisposition,
} from "../runtime/browserRunTrace.js";

// ─── Dev-Only Browser Run Trace ───────────────────────────────────────────────
// Internal / dev-only endpoint for reading the sanitized Antigen browser run
// trace captured during broad agent-realistic QA. In-memory only; gated by
// ANTIGEN_BROWSER_TRACE=true at record time. Not a production public API and
// never agent-facing.
//
// Never returns cdp_url, user_data_dir, profile_key, pass_id, secret_ref,
// passwords, cookies, localStorage/sessionStorage, raw DOM, coordinates
// (x/y/width/height/doc_x/doc_y), nearby_text, or raw typed text — the trace
// store sanitizes every event field-by-field before storage.

export async function browserRunTraceRoutes(server: FastifyInstance): Promise<void> {
  // Index of active traces so QA can discover runtime ids without knowing them
  // up front. Sanitized metadata only — no event bodies. Static path, registered
  // before the parametric per-runtime route for clarity.
  server.get<{ Querystring: { limit?: string } }>(
    "/api/internal/browser-run-traces",
    async (req, reply) => {
      const limitRaw = req.query?.limit;
      const limit =
        typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Math.min(50, Math.max(1, parseInt(limitRaw, 10)))
          : 50;
      const traces = listBrowserRunTraces(limit);
      return reply.send({ ok: true, data: { trace_count: traces.length, traces } });
    },
  );

  server.get<{ Params: { browser_runtime_id: string }; Querystring: { limit?: string } }>(
    "/api/internal/browser-run-trace/:browser_runtime_id",
    async (req, reply) => {
      const { browser_runtime_id } = req.params;
      const limitRaw = req.query?.limit;
      const limit =
        typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Math.min(200, Math.max(1, parseInt(limitRaw, 10)))
          : undefined;

      const trace = getBrowserRunTrace(browser_runtime_id, limit);
      if (!trace) {
        return reply.send({
          ok: true,
          data: { browser_runtime_id, event_count: 0, events: [] },
        });
      }
      return reply.send({ ok: true, data: trace });
    },
  );

  // Internal / dev-only: record a tool-surface DISPOSITION for a browser tool
  // call. Posted by the Antigen adapter (a separate Node process) so adapter-only
  // dispositions — most importantly a child-forwarded `browser_snapshot` that
  // never reaches the backend — land in the trace and make tool-surface bypass
  // visible. recordBrowserTraceEvent is a no-op when ANTIGEN_BROWSER_TRACE!=true
  // and enum-gates tool_surface/disposition, so sanitization is centralized
  // there. Always returns { ok: true }; never returns trace contents.
  server.post<{
    Params: { browser_runtime_id: string };
    Body: {
      tool?: string;
      tool_surface?: BrowserToolSurface;
      disposition?: BrowserToolDisposition;
      result_code?: string;
      error_code?: string;
    };
  }>(
    "/api/internal/browser-run-trace/:browser_runtime_id/disposition",
    async (req, reply) => {
      const { browser_runtime_id } = req.params;
      const body = req.body ?? {};
      // Explicit allowlist — never spread the request body into the trace store.
      recordBrowserTraceEvent(browser_runtime_id, {
        event_type: "browser_tool_disposition",
        browser_runtime_id,
        tool: typeof body.tool === "string" ? body.tool : undefined,
        tool_surface: body.tool_surface,
        disposition: body.disposition,
        result_code: typeof body.result_code === "string" ? body.result_code : undefined,
        error_code: typeof body.error_code === "string" ? body.error_code : undefined,
      });
      return reply.send({ ok: true });
    },
  );
}
