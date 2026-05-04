import type { FastifyInstance } from "fastify";
import { getKmsAuditEvents } from "../lib/kmsAudit.js";

// Internal / dev-only endpoint. Not intended as a production public API.
// Events are in-memory only and reset on process restart.
export async function kmsAuditRoutes(server: FastifyInstance) {
  server.get("/api/kms-audit-events", async () => {
    const events = getKmsAuditEvents().sort(
      (a, b) => b.created_at.localeCompare(a.created_at)
    );
    return { ok: true, data: events };
  });
}
