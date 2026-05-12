import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  AegisWorkspace,
  WorkspaceTask,
  WorkspaceArtifact,
  WorkspaceArtifactKind,
  TaskKind,
  TaskMode,
  TaskPriority,
  TaskReadinessLabel,
  TaskBlockerReasons,
} from "@aegis/types";
import {
  aegisWorkspaces,
  collars,
  agentDelegations,
  workspaceTasks,
  workspaceArtifacts,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { buildWorkspaceArtifactNames } from "../lib/workspaceDomain.js";

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

    const enriched = list.map((w) => {
      const tasks = Array.from(workspaceTasks.values()).filter((t) => t.workspace_id === w.workspace_id);
      const artifact_count = Array.from(workspaceArtifacts.values()).filter(
        (a) => a.workspace_id === w.workspace_id,
      ).length;
      return {
        ...w,
        task_counts: {
          open: tasks.filter((t) => t.status === "open").length,
          in_progress: tasks.filter((t) => t.status === "in_progress").length,
          completed: tasks.filter((t) => t.status === "completed").length,
          cancelled: tasks.filter((t) => t.status === "cancelled").length,
        },
        artifact_count,
      };
    });
    return reply.send({ ok: true, data: enriched });
  });

  /**
   * GET /api/workspaces/:workspaceId
   * Single workspace detail with task counts and artifact count.
   */
  server.get("/api/workspaces/:workspaceId", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    const tasks = Array.from(workspaceTasks.values()).filter((t) => t.workspace_id === workspaceId);
    const artifact_count = Array.from(workspaceArtifacts.values()).filter(
      (a) => a.workspace_id === workspaceId,
    ).length;
    return reply.send({
      ok: true,
      data: {
        ...workspace,
        task_counts: {
          open: tasks.filter((t) => t.status === "open").length,
          in_progress: tasks.filter((t) => t.status === "in_progress").length,
          completed: tasks.filter((t) => t.status === "completed").length,
          cancelled: tasks.filter((t) => t.status === "cancelled").length,
        },
        artifact_count,
      },
    });
  });

  /**
   * GET /api/workspaces/:workspaceId/tasks
   * Owner-facing task list with simplified readiness (no delegation identity).
   */
  server.get("/api/workspaces/:workspaceId/tasks", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    const allTasks = Array.from(workspaceTasks.values()).filter((t) => t.workspace_id === workspaceId);
    const artifactNames = buildWorkspaceArtifactNames(workspaceId);

    const result = allTasks.map((task) => {
      const readinessResult = computeOwnerTaskReadiness(task, allTasks, artifactNames);
      return { ...task, ...readinessResult };
    });

    return reply.send({ ok: true, data: result });
  });

  /**
   * POST /api/workspaces/:workspaceId/tasks
   * Create a task (owner-facing).
   */
  server.post("/api/workspaces/:workspaceId/tasks", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }

    const body = req.body as {
      title?: string;
      description?: string;
      task_kind?: TaskKind;
      task_mode?: TaskMode;
      priority?: TaskPriority;
      assignment_type?: "open" | "delegation" | "collar";
      assigned_delegation_id?: string;
      required_collar_id?: string;
      depends_on_task_ids?: string[];
      required_artifact_names?: string[];
    };

    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      return sendError(reply, 400, "MISSING_TITLE", "title is required.");
    }

    const VALID_KINDS: TaskKind[] = [
      "research", "analysis", "draft", "review", "shopping",
      "coding", "planning", "approval_prep", "execution", "other",
    ];
    const VALID_MODES: TaskMode[] = ["direct", "plan_first"];
    const VALID_PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
    const VALID_ASSIGNMENT: Array<"open" | "delegation" | "collar"> = ["open", "delegation", "collar"];

    if (body.task_kind && !VALID_KINDS.includes(body.task_kind)) {
      return sendError(reply, 400, "INVALID_TASK_KIND", "Invalid task_kind.");
    }
    if (body.task_mode && !VALID_MODES.includes(body.task_mode)) {
      return sendError(reply, 400, "INVALID_TASK_MODE", "Invalid task_mode.");
    }
    if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
      return sendError(reply, 400, "INVALID_PRIORITY", "Invalid priority.");
    }
    if (body.assignment_type && !VALID_ASSIGNMENT.includes(body.assignment_type)) {
      return sendError(reply, 400, "INVALID_ASSIGNMENT_TYPE", "Invalid assignment_type.");
    }

    // Validate depends_on_task_ids reference this workspace
    if (body.depends_on_task_ids) {
      for (const depId of body.depends_on_task_ids) {
        const dep = workspaceTasks.get(depId);
        if (!dep || dep.workspace_id !== workspaceId) {
          return sendError(reply, 400, "INVALID_DEPENDENCY", `Task ${depId} not found in this workspace.`);
        }
      }
    }

    const now = new Date().toISOString();
    const task: WorkspaceTask = {
      task_id: newId("task"),
      workspace_id: workspaceId,
      title: body.title.trim(),
      description: body.description,
      status: "open",
      assignment_type: body.assignment_type ?? "open",
      assigned_delegation_id: body.assigned_delegation_id,
      required_collar_id: body.required_collar_id,
      task_kind: body.task_kind ?? "other",
      task_mode: body.task_mode ?? "direct",
      priority: body.priority ?? "normal",
      depends_on_task_ids: body.depends_on_task_ids ?? [],
      required_artifact_names: body.required_artifact_names ?? [],
      created_by_user_id: MOCK_USER_ID,
      created_at: now,
      updated_at: now,
    };
    workspaceTasks.set(task.task_id, task);
    return reply.status(201).send({ ok: true, data: task });
  });

  /**
   * GET /api/workspaces/:workspaceId/artifacts
   * Owner-facing artifact list (metadata only, no content).
   */
  server.get("/api/workspaces/:workspaceId/artifacts", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    const list = Array.from(workspaceArtifacts.values())
      .filter((a) => a.workspace_id === workspaceId)
      .map(({ content: _content, ...meta }) => ({
        ...meta,
        size_bytes: Buffer.byteLength(_content, "utf8"),
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return reply.send({ ok: true, data: list });
  });

  /**
   * GET /api/workspaces/:workspaceId/artifacts/:artifactId
   * Owner-facing artifact with full content.
   */
  server.get("/api/workspaces/:workspaceId/artifacts/:artifactId", async (req, reply) => {
    const { workspaceId, artifactId } = req.params as { workspaceId: string; artifactId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    const artifact = workspaceArtifacts.get(artifactId);
    if (!artifact || artifact.workspace_id !== workspaceId) {
      return sendError(reply, 404, "ARTIFACT_NOT_FOUND", "Artifact not found.");
    }
    return reply.send({ ok: true, data: artifact });
  });

  /**
   * POST /api/workspaces/:workspaceId/artifacts
   * Owner-facing artifact creation (text/json/csv/markdown only).
   */
  server.post("/api/workspaces/:workspaceId/artifacts", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }

    const body = req.body as {
      name?: string;
      kind?: WorkspaceArtifactKind;
      content?: string;
      task_id?: string;
    };

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return sendError(reply, 400, "MISSING_NAME", "name is required.");
    }
    const VALID_KINDS: WorkspaceArtifactKind[] = ["text", "json", "csv", "markdown"];
    if (!body.kind || !VALID_KINDS.includes(body.kind)) {
      return sendError(reply, 400, "INVALID_KIND", "kind must be one of: text, json, csv, markdown.");
    }
    if (typeof body.content !== "string") {
      return sendError(reply, 400, "MISSING_CONTENT", "content is required.");
    }
    if (Buffer.byteLength(body.content, "utf8") > 50 * 1024) {
      return sendError(reply, 400, "CONTENT_TOO_LARGE", "content exceeds 50KB limit.");
    }
    if (body.task_id) {
      const task = workspaceTasks.get(body.task_id);
      if (!task || task.workspace_id !== workspaceId) {
        return sendError(reply, 400, "INVALID_TASK", "task_id not found in this workspace.");
      }
    }

    const now = new Date().toISOString();
    const artifact: WorkspaceArtifact = {
      artifact_id: newId("art"),
      workspace_id: workspaceId,
      name: body.name.trim(),
      kind: body.kind,
      content: body.content,
      task_id: body.task_id,
      created_at: now,
    };
    workspaceArtifacts.set(artifact.artifact_id, artifact);

    const { content: _content, ...meta } = artifact;
    return reply.status(201).send({
      ok: true,
      data: { ...meta, size_bytes: Buffer.byteLength(_content, "utf8") },
    });
  });
}

/** Computes simplified task readiness for the workspace owner view (no delegation identity). */
function computeOwnerTaskReadiness(
  task: WorkspaceTask,
  allTasks: WorkspaceTask[],
  artifactNames: Set<string>,
): { readiness: TaskReadinessLabel; blocker_reasons?: TaskBlockerReasons } {
  if (task.status === "in_progress") return { readiness: "in_progress_other" };
  if (task.status === "completed") return { readiness: "completed" };
  if (task.status === "cancelled") return { readiness: "cancelled" };

  const incompleteDeps: string[] = [];
  for (const depId of task.depends_on_task_ids ?? []) {
    const dep = allTasks.find((t) => t.task_id === depId);
    if (!dep || dep.status !== "completed") incompleteDeps.push(depId);
  }
  const missingArtifacts: string[] = [];
  for (const name of task.required_artifact_names ?? []) {
    if (!artifactNames.has(name)) missingArtifacts.push(name);
  }
  if (incompleteDeps.length > 0 || missingArtifacts.length > 0) {
    const blocker_reasons: TaskBlockerReasons = {};
    if (incompleteDeps.length > 0) blocker_reasons.incomplete_dependency_task_ids = incompleteDeps;
    if (missingArtifacts.length > 0) blocker_reasons.missing_artifact_names = missingArtifacts;
    return { readiness: "blocked", blocker_reasons };
  }
  return { readiness: "ready" };
}
