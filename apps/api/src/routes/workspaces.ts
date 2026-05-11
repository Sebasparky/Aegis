import type { FastifyInstance, FastifyReply } from "fastify";
import type { AegisWorkspace } from "@aegis/types";
import { aegisWorkspaces, collars, agentDelegations, MOCK_USER_ID, newId } from "../store/index.js";

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function workspaceRoutes(server: FastifyInstance) {
  /**
   * POST /api/workspaces
   * Create a new workspace (user-facing, uses MOCK_USER_ID).
   * Body: { name, description?, collar_id, participant_delegation_ids? }
   */
  server.post("/api/workspaces", async (req, reply) => {
    const body = req.body as {
      name?: string;
      description?: string;
      collar_id?: string;
      participant_delegation_ids?: string[];
    };

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return sendError(reply, 400, "MISSING_NAME", "name is required.");
    }
    if (!body.collar_id || typeof body.collar_id !== "string") {
      return sendError(reply, 400, "MISSING_COLLAR", "collar_id is required.");
    }

    const collar = collars.get(body.collar_id);
    if (!collar || collar.user_id !== MOCK_USER_ID) {
      return sendError(reply, 400, "COLLAR_NOT_FOUND", "collar_id not found.");
    }
    if (collar.status !== "active") {
      return sendError(reply, 400, "COLLAR_INACTIVE", "collar_id references an inactive collar.");
    }

    const participants = body.participant_delegation_ids ?? [];
    for (const delgId of participants) {
      const d = agentDelegations.get(delgId);
      if (!d || d.user_id !== MOCK_USER_ID) {
        return sendError(reply, 400, "INVALID_PARTICIPANT", `Delegation ${delgId} not found.`);
      }
    }

    const now = new Date().toISOString();
    const workspace: AegisWorkspace = {
      workspace_id: newId("ws"),
      owner_user_id: MOCK_USER_ID,
      name: body.name.trim(),
      description: body.description,
      collar_id: body.collar_id,
      participant_delegation_ids: participants,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    aegisWorkspaces.set(workspace.workspace_id, workspace);

    return reply.status(201).send({ ok: true, data: workspace });
  });

  /**
   * GET /api/workspaces
   * List workspaces owned by the current user.
   */
  server.get("/api/workspaces", async (_req, reply) => {
    const list = Array.from(aegisWorkspaces.values())
      .filter((w) => w.owner_user_id === MOCK_USER_ID)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return reply.send({ ok: true, data: list });
  });
}
