import type { FastifyInstance } from "fastify";
import { runnerTasks, MOCK_USER_ID } from "../store/index.js";
import { executeRunnerTask } from "../services/runnerService.js";

export async function runnerRoutes(server: FastifyInstance) {
  server.get("/api/runners", async () => {
    const result = Array.from(runnerTasks.values())
      .filter((t) => t.user_id === MOCK_USER_ID)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { ok: true, data: result };
  });

  server.get<{ Params: { runnerId: string } }>("/api/runners/:runnerId", async (req, reply) => {
    const task = runnerTasks.get(req.params.runnerId);
    if (!task || task.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Runner task not found." } });
    }
    return { ok: true, data: task };
  });

  server.post<{ Params: { runnerId: string } }>("/api/runners/:runnerId/execute", async (req, reply) => {
    const task = runnerTasks.get(req.params.runnerId);
    if (!task || task.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Runner task not found." } });
    }
    if (task.status === "canceled" || task.status === "expired") {
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Cannot execute a ${task.status} runner task.` } });
    }
    const completed = await executeRunnerTask(task.id);
    return { ok: true, data: { id: completed.id, status: completed.status, result: completed.result } };
  });
}
