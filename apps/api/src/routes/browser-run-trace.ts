import type { FastifyInstance } from "fastify";
import { getBrowserRunTrace } from "../runtime/browserRunTrace.js";

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
}
