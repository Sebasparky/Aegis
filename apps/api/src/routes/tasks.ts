import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import type { AgentTask, ProtectedSession } from "@aegis/types";
import {
  agentTasks,
  passes,
  collars,
  users,
  sessions,
  domainTrust,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { validatePassToken } from "../services/passValidator.js";
import { createBrowserSession } from "../browser/browserManager.js";
import type { PassWithToken } from "../store/index.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

interface CreateTaskBody {
  title: string;
  description?: string;
  start_url: string;
  collar_id?: string;
  expires_in_minutes?: number;
}

interface CreateTaskSessionBody {
  launch_token: string;
  mode?: "headless" | "visible";
}

export async function taskRoutes(server: FastifyInstance) {
  // GET /api/tasks
  server.get("/api/tasks", async () => {
    const tasks = Array.from(agentTasks.values())
      .filter((t) => t.user_id === MOCK_USER_ID)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { ok: true, data: tasks };
  });

  // GET /api/tasks/:taskId
  server.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (req, reply) => {
      const task = agentTasks.get(req.params.taskId);
      if (!task || task.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Task not found.");
      }
      return { ok: true, data: task };
    }
  );

  // POST /api/tasks
  server.post<{ Body: CreateTaskBody }>("/api/tasks", async (req, reply) => {
    const { title, description, start_url, collar_id, expires_in_minutes } =
      req.body ?? {};

    if (!title) {
      return sendError(reply, 400, "VALIDATION_ERROR", "title is required.");
    }
    if (!start_url) {
      return sendError(reply, 400, "VALIDATION_ERROR", "start_url is required.");
    }

    let start_domain: string;
    try {
      start_domain = new URL(start_url).hostname;
    } catch {
      return sendError(reply, 400, "VALIDATION_ERROR", "Invalid start_url.");
    }

    // Resolve collar
    let collar;
    if (collar_id) {
      collar = collars.get(collar_id);
      if (!collar) {
        return sendError(reply, 404, "NOT_FOUND", "Collar not found.");
      }
      if (collar.user_id !== MOCK_USER_ID || collar.status !== "active") {
        return sendError(reply, 400, "COLLAR_INACTIVE", "Collar is not active.");
      }
    } else {
      // Use most recently updated active collar
      collar = Array.from(collars.values())
        .filter((c) => c.user_id === MOCK_USER_ID && c.status === "active")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      if (!collar) {
        return sendError(
          reply,
          400,
          "NO_ACTIVE_COLLAR",
          "No active collar found for this user."
        );
      }
    }

    const user = users.get(MOCK_USER_ID);
    const user_aegis_id = user?.aegis_id ?? "aid_user_001";

    const domainRecord = domainTrust.get(start_domain);
    const website_aegis_id = domainRecord?.website_aegis_id;

    const constraints: AgentTask["constraints"] = {
      max_purchase_amount: collar.spending_limits.max_with_approval,
      subscriptions_allowed: collar.spending_limits.subscriptions_allowed,
      purchase_requires_approval:
        collar.approval_required_actions.includes("purchase"),
      payment_requires_approval:
        collar.approval_required_actions.includes("payment"),
      identity_disclosure_blocked:
        collar.blocked_actions.includes("identity_disclosure"),
    };

    const now = new Date().toISOString();
    const expiresMs = (expires_in_minutes ?? 120) * 60 * 1000;

    const pass: PassWithToken = {
      id: newId("pass"),
      token: `aegis_pass_${randomUUID().replace(/-/g, "")}`,
      user_id: MOCK_USER_ID,
      agent_name: `Task: ${title}`,
      purpose: description ?? title,
      default_collar_id: collar.id,
      status: "active",
      expires_at: new Date(Date.now() + expiresMs).toISOString(),
      created_at: now,
    };
    passes.set(pass.id, pass);

    const task: AgentTask = {
      id: newId("task"),
      user_id: MOCK_USER_ID,
      user_aegis_id,
      title,
      description,
      start_url,
      start_domain,
      website_aegis_id,
      collar_id: collar.id,
      pass_id: pass.id,
      status: "ready",
      constraints,
      created_at: now,
      updated_at: now,
    };
    agentTasks.set(task.id, task);
    schedulePersist();

    return { ok: true, data: { task, launch_token: pass.token } };
  });

  // POST /api/tasks/:taskId/cancel
  server.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/cancel",
    async (req, reply) => {
      const task = agentTasks.get(req.params.taskId);
      if (!task || task.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Task not found.");
      }
      if (["completed", "failed", "canceled"].includes(task.status)) {
        return sendError(
          reply,
          400,
          "INVALID_STATE",
          `Task is already ${task.status}.`
        );
      }

      const now = new Date().toISOString();
      task.status = "canceled";
      task.updated_at = now;

      const pass = passes.get(task.pass_id);
      if (pass && pass.status === "active") {
        pass.status = "revoked";
        (pass as PassWithToken & { revoked_at: string }).revoked_at = now;
      }

      schedulePersist();
      return { ok: true, data: task };
    }
  );

  // POST /api/tasks/:taskId/create-session
  server.post<{ Params: { taskId: string }; Body: CreateTaskSessionBody }>(
    "/api/tasks/:taskId/create-session",
    async (req, reply) => {
      const task = agentTasks.get(req.params.taskId);
      if (!task || task.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Task not found.");
      }
      if (task.status !== "ready") {
        return sendError(
          reply,
          400,
          "INVALID_STATE",
          `Task is not ready (current status: ${task.status}).`
        );
      }

      const { launch_token, mode } = req.body ?? {};
      if (!launch_token) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "launch_token is required."
        );
      }

      const validation = validatePassToken(launch_token);
      if (!validation.ok) {
        return sendError(reply, 401, validation.code, validation.message);
      }
      const { pass, collar } = validation;

      if (pass.id !== task.pass_id) {
        return sendError(
          reply,
          403,
          "FORBIDDEN",
          "Token does not belong to this task."
        );
      }

      const collarMaxMs = collar.session_limits.max_duration_minutes * 60 * 1000;
      const collarExpiry = new Date(Date.now() + collarMaxMs);
      const passExpiry = new Date(pass.expires_at);
      const expires_at = (
        collarExpiry < passExpiry ? collarExpiry : passExpiry
      ).toISOString();

      const now = new Date().toISOString();
      const session: ProtectedSession = {
        id: newId("sess"),
        user_id: MOCK_USER_ID,
        aegis_pass_id: pass.id,
        collar_id: collar.id,
        status: "active",
        mode: mode ?? "headless",
        created_at: now,
        expires_at,
      };
      sessions.set(session.id, session);

      try {
        await createBrowserSession(session.id, session.mode);
      } catch {
        session.status = "error";
        task.status = "failed";
        task.updated_at = new Date().toISOString();
        schedulePersist();
        return sendError(
          reply,
          500,
          "INTERNAL_ERROR",
          "Failed to launch browser session."
        );
      }

      task.status = "in_progress";
      task.updated_at = new Date().toISOString();
      schedulePersist();

      return {
        ok: true,
        data: {
          task_id: task.id,
          session_id: session.id,
          start_url: task.start_url,
          collar_id: collar.id,
          constraints: task.constraints,
        },
      };
    }
  );
}
