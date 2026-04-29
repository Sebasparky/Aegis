import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import type { AgentDelegation, AgentDelegationChannel } from "@aegis/types";
import {
  agentDelegations,
  passes,
  collars,
  users,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

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

      // Resolve collar
      let collar;
      if (default_collar_id) {
        collar = collars.get(default_collar_id);
        if (!collar) {
          return sendError(reply, 404, "NOT_FOUND", "Collar not found.");
        }
        if (collar.user_id !== MOCK_USER_ID || collar.status !== "active") {
          return sendError(reply, 400, "COLLAR_INACTIVE", "Collar is not active.");
        }
      } else {
        collar = Array.from(collars.values())
          .filter((c) => c.user_id === MOCK_USER_ID && c.status === "active")
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
        if (!collar) {
          return sendError(reply, 400, "NO_ACTIVE_COLLAR", "No active collar found for this user.");
        }
      }

      const user = users.get(MOCK_USER_ID);
      const user_aegis_id = user?.aegis_id ?? "aid_user_001";

      const now = new Date().toISOString();
      const expires_at = new Date(Date.now() + expires_in_minutes * 60 * 1000).toISOString();

      const pass: PassWithToken = {
        id: newId("pass"),
        token: `aegis_pass_${randomUUID().replace(/-/g, "")}`,
        user_id: MOCK_USER_ID,
        agent_name,
        purpose: `Delegation for ${agent_name}`,
        default_collar_id: collar.id,
        status: "active",
        expires_at,
        created_at: now,
      };
      passes.set(pass.id, pass);

      const delegation: AgentDelegation = {
        id: newId("delg"),
        user_id: MOCK_USER_ID,
        user_aegis_id,
        agent_name,
        agent_platform,
        channel,
        default_collar_id: collar.id,
        status: "active",
        token_id: pass.id,
        created_at: now,
        updated_at: now,
        expires_at,
      };
      agentDelegations.set(delegation.id, delegation);
      schedulePersist();

      // token returned once only — not stored in AgentDelegation
      return { ok: true, data: { delegation, delegation_token: pass.token } };
    }
  );

  // POST /api/delegations/:delegationId/revoke
  server.post<{ Params: { delegationId: string } }>(
    "/api/delegations/:delegationId/revoke",
    async (req, reply) => {
      const delegation = agentDelegations.get(req.params.delegationId);
      if (!delegation || delegation.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Delegation not found.");
      }
      if (delegation.status !== "active") {
        return sendError(reply, 400, "INVALID_STATE", `Delegation is already ${delegation.status}.`);
      }

      const now = new Date().toISOString();
      delegation.status = "revoked";
      delegation.updated_at = now;

      // Revoke underlying pass so existing MCP tools stop working with this token
      const pass = passes.get(delegation.token_id);
      if (pass && pass.status === "active") {
        pass.status = "revoked";
        (pass as PassWithToken & { revoked_at: string }).revoked_at = now;
      }

      schedulePersist();
      return { ok: true, data: { id: delegation.id, status: delegation.status } };
    }
  );
}
