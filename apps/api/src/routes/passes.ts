import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import type { AegisPass } from "@aegis/types";
import { passes, collars, MOCK_USER_ID, newId } from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

interface CreatePassBody {
  agent_name: string;
  purpose?: string;
  default_collar_id: string;
  expires_in_minutes?: number;
}

export async function passRoutes(server: FastifyInstance) {
  // List passes for the current user
  server.get("/api/passes", async () => {
    const result = Array.from(passes.values())
      .filter((p) => p.user_id === MOCK_USER_ID)
      .map(({ token: _token, ...pass }) => pass); // never return token in list
    return { ok: true, data: result };
  });

  // Create a pass
  server.post<{ Body: CreatePassBody }>("/api/passes", async (req, reply) => {
    const { agent_name, purpose, default_collar_id, expires_in_minutes = 120 } = req.body ?? {};

    if (!agent_name) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "agent_name is required." } });
    }
    if (!default_collar_id) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "default_collar_id is required." } });
    }

    const collar = collars.get(default_collar_id);
    if (!collar) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Collar not found." } });
    }
    if (collar.status !== "active") {
      return reply.status(400).send({ ok: false, error: { code: "COLLAR_REVOKED", message: "Collar is not active." } });
    }

    const now = new Date();
    const expires_at = new Date(now.getTime() + expires_in_minutes * 60 * 1000).toISOString();

    // Production: store only a hashed token and never return raw value after creation.
    const token = `aegis_pass_${randomUUID().replace(/-/g, "")}`;

    const pass: PassWithToken = {
      id: newId("pass"),
      user_id: MOCK_USER_ID,
      agent_name,
      purpose,
      default_collar_id,
      status: "active",
      expires_at,
      created_at: now.toISOString(),
      token,
    };

    passes.set(pass.id, pass);
    schedulePersist();

    // Return token only on creation
    return { ok: true, data: { ...pass } };
  });

  // Get pass detail (no token)
  server.get<{ Params: { passId: string } }>("/api/passes/:passId", async (req, reply) => {
    const pass = passes.get(req.params.passId);
    if (!pass) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Pass not found." } });
    }
    const { token: _token, ...safe } = pass;
    return { ok: true, data: safe };
  });

  // Revoke pass
  server.post<{ Params: { passId: string } }>(
    "/api/passes/:passId/revoke",
    async (req, reply) => {
      const pass = passes.get(req.params.passId);
      if (!pass) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Pass not found." } });
      }

      const now = new Date().toISOString();
      const revoked: PassWithToken = { ...pass, status: "revoked", revoked_at: now };
      passes.set(revoked.id, revoked);
      schedulePersist();
      return { ok: true, data: { id: revoked.id, status: revoked.status } };
    }
  );
}
