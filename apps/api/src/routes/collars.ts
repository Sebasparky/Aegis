import type { FastifyInstance } from "fastify";
import type { Collar, ActionType } from "@aegis/types";
import { collars, MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

export async function collarRoutes(server: FastifyInstance) {
  // List collars for the current user
  server.get("/api/collars", async () => {
    const result = Array.from(collars.values()).filter(
      (c) => c.user_id === MOCK_USER_ID
    );
    return { ok: true, data: result };
  });

  // Create a collar
  server.post<{ Body: Partial<Collar> }>("/api/collars", async (req, reply) => {
    const body = req.body ?? {};
    const { name, allowed_actions, approval_required_actions, blocked_actions } = body;

    if (!name) {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "name is required." } });
    }

    const now = new Date().toISOString();
    const collar: Collar = {
      id: newId("collar"),
      user_id: MOCK_USER_ID,
      name,
      description: body.description,
      purpose: body.purpose,
      status: "active",
      allowed_actions: (allowed_actions as ActionType[]) ?? [],
      approval_required_actions: (approval_required_actions as ActionType[]) ?? [],
      blocked_actions: (blocked_actions as ActionType[]) ?? [],
      spending_limits: body.spending_limits ?? { max_without_approval: 0, max_with_approval: 0, subscriptions_allowed: false },
      counterparty_rules: body.counterparty_rules ?? { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: true },
      session_limits: body.session_limits ?? { max_duration_minutes: 120 },
      created_at: now,
      updated_at: now,
    };

    collars.set(collar.id, collar);
    schedulePersist();
    return { ok: true, data: collar };
  });

  // Get collar by id
  server.get<{ Params: { collarId: string } }>("/api/collars/:collarId", async (req, reply) => {
    const collar = collars.get(req.params.collarId);
    if (!collar) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Collar not found." } });
    }
    return { ok: true, data: collar };
  });

  // Update collar
  server.patch<{ Params: { collarId: string }; Body: Partial<Collar> }>(
    "/api/collars/:collarId",
    async (req, reply) => {
      const collar = collars.get(req.params.collarId);
      if (!collar) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Collar not found." } });
      }
      if (collar.status === "revoked") {
        return reply.status(400).send({ ok: false, error: { code: "COLLAR_REVOKED", message: "Cannot update a revoked collar." } });
      }

      const body = req.body ?? {};
      const updated: Collar = {
        ...collar,
        name: body.name ?? collar.name,
        description: body.description ?? collar.description,
        purpose: body.purpose ?? collar.purpose,
        allowed_actions: body.allowed_actions ?? collar.allowed_actions,
        approval_required_actions: body.approval_required_actions ?? collar.approval_required_actions,
        blocked_actions: body.blocked_actions ?? collar.blocked_actions,
        spending_limits: body.spending_limits ?? collar.spending_limits,
        counterparty_rules: body.counterparty_rules ?? collar.counterparty_rules,
        session_limits: body.session_limits ?? collar.session_limits,
        updated_at: new Date().toISOString(),
      };

      collars.set(updated.id, updated);
      schedulePersist();
      return { ok: true, data: updated };
    }
  );

  // Revoke collar
  server.post<{ Params: { collarId: string } }>(
    "/api/collars/:collarId/revoke",
    async (req, reply) => {
      const collar = collars.get(req.params.collarId);
      if (!collar) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Collar not found." } });
      }

      const now = new Date().toISOString();
      const revoked: Collar = { ...collar, status: "revoked", revoked_at: now, updated_at: now };
      collars.set(revoked.id, revoked);
      schedulePersist();
      return { ok: true, data: { id: revoked.id, status: revoked.status } };
    }
  );
}
