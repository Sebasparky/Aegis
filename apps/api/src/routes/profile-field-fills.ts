import type { FastifyInstance } from "fastify";
import { privateProfileMemory, MOCK_USER_ID } from "../store/index.js";

export async function profileFieldFillRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/internal/profile-memory/items — metadata only, never returns value_ref or raw values
  server.get("/api/internal/profile-memory/items", async (_req, reply) => {
    const items = Array.from(privateProfileMemory.values())
      .filter((m) => m.user_id === MOCK_USER_ID)
      .map((m) => ({
        memory_id: m.memory_id,
        field_kind: m.field_kind,
        data_class: m.data_class,
        sensitivity: m.sensitivity,
        default_disclosure_mode: m.default_disclosure_mode,
        agent_visible_allowed: m.agent_visible_allowed,
        provenance: m.provenance,
        created_at: m.created_at,
        updated_at: m.updated_at,
        last_used_at: m.last_used_at,
        user_editable: true as const,
        use_count: m.uses.length,
        // value_ref intentionally omitted — never returned to any caller
        // raw profile values never returned — fill-only by default for all Class 2 fields
      }));
    return reply.send({ ok: true, data: items });
  });
}
