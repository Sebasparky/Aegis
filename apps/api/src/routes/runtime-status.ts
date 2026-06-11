import type { FastifyInstance } from "fastify";
import { getAntigenRuntimeStatus } from "../runtime/antigenRuntimeFlags.js";

/**
 * GET /api/runtime/status — dev/local diagnostic confirming which Antigen
 * runtime flags are effective IN THIS API PROCESS (not the adapter/MCP env).
 *
 * Allowlist-only: returns the fixed safe status object from
 * getAntigenRuntimeStatus() plus a little process metadata. Never dumps
 * process.env; never returns the CDP URL, secrets, tokens, cookies, vault/KMS
 * config, or extension secrets. Returns 404 in production.
 */
export async function runtimeStatusRoutes(server: FastifyInstance) {
  server.get("/api/runtime/status", async (_req, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply
        .status(404)
        .send({ ok: false, error: { code: "NOT_FOUND", message: "Not found." } });
    }

    return {
      ok: true,
      service: "aegis-api",
      environment: process.env.NODE_ENV ?? "development",
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      antigen: getAntigenRuntimeStatus(),
    };
  });
}
