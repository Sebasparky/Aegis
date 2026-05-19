import type { FastifyInstance } from "fastify";
import type { AgentDelegation, AgentDelegationChannel, SkillAccessMode } from "@aegis/types";
import {
  agentDelegations,
  collars,
  MOCK_USER_ID,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { createDelegationWithPass } from "../lib/createDelegationWithPass.js";
import { revokeDelegationById } from "../lib/revokeDelegation.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

interface CreateDelegationBody {
  agent_name: string;
  agent_platform?: string;
  channel?: AgentDelegationChannel;
  default_collar_id?: string;
  expires_in_minutes?: number;
}

export async function delegationRoutes(server: FastifyInstance) {
  // GET /api/delegations
  server.get("/api/delegations", async () => {
    const result = Array.from(agentDelegations.values())
      .filter((d) => d.user_id === MOCK_USER_ID)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { ok: true, data: result };
  });

  // GET /api/delegations/:delegationId
  server.get<{ Params: { delegationId: string } }>(
    "/api/delegations/:delegationId",
    async (req, reply) => {
      const delegation = agentDelegations.get(req.params.delegationId);
      if (!delegation || delegation.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Delegation not found.");
      }
      return { ok: true, data: delegation };
    }
  );

  // POST /api/delegations
  server.post<{ Body: CreateDelegationBody }>(
    "/api/delegations",
    async (req, reply) => {
      const {
        agent_name,
        agent_platform,
        channel = "slack",
        default_collar_id,
        expires_in_minutes = 10080,
      } = req.body ?? {};

      if (!agent_name) {
        return sendError(reply, 400, "VALIDATION_ERROR", "agent_name is required.");
      }

      // Resolve collar — optional, agent may connect with no rule set and add one later.
      if (default_collar_id) {
        const collar = collars.get(default_collar_id);
        if (!collar) {
          return sendError(reply, 404, "NOT_FOUND", "Collar not found.");
        }
        if (collar.user_id !== MOCK_USER_ID || collar.status !== "active") {
          return sendError(reply, 400, "COLLAR_INACTIVE", "Collar is not active.");
        }
      }

      const { delegation, token } = createDelegationWithPass({
        agent_name,
        agent_platform,
        channel,
        default_collar_id,
        expires_in_minutes,
      });

      // token returned once only — not stored in AgentDelegation
      return { ok: true, data: { delegation, delegation_token: token } };
    }
  );

  // PATCH /api/delegations/:delegationId/skill-access
  server.patch<{
    Params: { delegationId: string };
    Body: { mode: SkillAccessMode; skill_ids?: string[] };
  }>("/api/delegations/:delegationId/skill-access", async (req, reply) => {
    const delegation = agentDelegations.get(req.params.delegationId);
    if (!delegation || delegation.user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "NOT_FOUND", "Delegation not found.");
    }
    if (delegation.status !== "active") {
      return sendError(reply, 400, "INVALID_STATE", `Delegation is already ${delegation.status}.`);
    }

    const { mode, skill_ids = [] } = req.body ?? {};
    const validModes: SkillAccessMode[] = ["all", "exclude", "only"];
    if (!validModes.includes(mode)) {
      return sendError(reply, 400, "VALIDATION_ERROR", `mode must be one of: ${validModes.join(", ")}.`);
    }

    delegation.skill_access_mode = mode;
    delegation.skill_access_skill_ids = skill_ids;
    delegation.updated_at = new Date().toISOString();

    schedulePersist();
    return { ok: true, data: delegation };
  });

  // POST /api/delegations/:delegationId/revoke
  server.post<{ Params: { delegationId: string } }>(
    "/api/delegations/:delegationId/revoke",
    async (req, reply) => {
      const result = revokeDelegationById(req.params.delegationId);
      if (!result.ok) {
        if (result.error === "NOT_FOUND") {
          return sendError(reply, 404, "NOT_FOUND", "Delegation not found.");
        }
        const delegation = agentDelegations.get(req.params.delegationId);
        return sendError(reply, 400, "INVALID_STATE", `Delegation is already ${delegation?.status}.`);
      }
      return { ok: true, data: { id: result.delegation_id, status: "revoked" } };
    }
  );
}
