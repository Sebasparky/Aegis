import { createReadStream, createWriteStream, existsSync } from "fs";
import { pipeline } from "stream/promises";
import { extname } from "path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  AegisWorkspace,
  WorkspaceTask,
  WorkspaceArtifact,
  WorkspaceTextArtifact,
  WorkspaceFileArtifact,
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
import { schedulePersist } from "../store/persistence.js";
import {
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  FILE_MAX_BYTES,
  sanitizeFilename,
  getArtifactFilePath,
  ensureArtifactDir,
  deleteArtifactFile,
  getFileExtension,
} from "../lib/artifactStorage.js";

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

// "file" kind is created via POST /artifacts/upload — not accepted here
const TEXT_ARTIFACT_KINDS: WorkspaceArtifactKind[] = ["text", "json", "csv", "markdown"];

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

    // Title
    const trimmedTitle = typeof body.title === "string" ? body.title.trim() : "";
    if (!trimmedTitle) {
      return sendError(reply, 400, "INVALID_TASK_TITLE", "title is required.");
    }
    if (trimmedTitle.length > 200) {
      return sendError(reply, 400, "INVALID_TASK_TITLE", "title must be 200 characters or fewer.");
    }

    // Description
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        return sendError(reply, 400, "INVALID_TASK_DESCRIPTION", "description must be a string.");
      }
      if (body.description.length > 2000) {
        return sendError(reply, 400, "INVALID_TASK_DESCRIPTION", "description must be 2000 characters or fewer.");
      }
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
      return sendError(reply, 400, "INVALID_TASK_PRIORITY", "Invalid priority.");
    }
    if (body.assignment_type && !VALID_ASSIGNMENT.includes(body.assignment_type)) {
      return sendError(reply, 400, "INVALID_ASSIGNMENT_TYPE", "Invalid assignment_type.");
    }

    // Assignment type cross-field validation
    const assignmentType = body.assignment_type ?? "open";

    if (assignmentType === "delegation") {
      if (!body.assigned_delegation_id) {
        return sendError(reply, 400, "MISSING_ASSIGNED_DELEGATION", "assigned_delegation_id is required when assignment_type is 'delegation'.");
      }
      const delegation = agentDelegations.get(body.assigned_delegation_id);
      if (!delegation || delegation.user_id !== MOCK_USER_ID) {
        return sendError(reply, 400, "INVALID_ASSIGNED_DELEGATION", "Delegation not found.");
      }
      if (delegation.status !== "active") {
        return sendError(reply, 400, "INVALID_ASSIGNED_DELEGATION", "Delegation is not active.");
      }
      if (!workspace.participant_delegation_ids.includes(body.assigned_delegation_id)) {
        return sendError(reply, 400, "INVALID_ASSIGNED_DELEGATION", "Delegation is not a participant in this workspace.");
      }
    }

    if (assignmentType === "collar") {
      if (!body.required_collar_id) {
        return sendError(reply, 400, "MISSING_REQUIRED_COLLAR", "required_collar_id is required when assignment_type is 'collar'.");
      }
      const requiredCollar = collars.get(body.required_collar_id);
      if (!requiredCollar) {
        return sendError(reply, 400, "INVALID_REQUIRED_COLLAR", "Collar not found.");
      }
      if (requiredCollar.status !== "active") {
        return sendError(reply, 400, "INVALID_REQUIRED_COLLAR", "Collar is not active.");
      }
    }

    // Dependency validation — deduplicate then verify each exists in this workspace
    const uniqueDeps = [...new Set(body.depends_on_task_ids ?? [])];
    for (const depId of uniqueDeps) {
      const dep = workspaceTasks.get(depId);
      if (!dep || dep.workspace_id !== workspaceId) {
        return sendError(reply, 400, "INVALID_TASK_DEPENDENCY", `Task ${depId} not found in this workspace.`);
      }
    }

    // Required artifact names — trim, reject empty/long, deduplicate, enforce count limit
    const rawNames = body.required_artifact_names ?? [];
    if (rawNames.length > 20) {
      return sendError(reply, 400, "INVALID_REQUIRED_ARTIFACT_NAME", "required_artifact_names must have 20 or fewer entries.");
    }
    const trimmedNames = rawNames.map((n) => (typeof n === "string" ? n.trim() : ""));
    const emptyIdx = trimmedNames.findIndex((n) => !n);
    if (emptyIdx !== -1) {
      return sendError(reply, 400, "INVALID_REQUIRED_ARTIFACT_NAME", "required_artifact_names must not contain empty or whitespace-only strings.");
    }
    const longName = trimmedNames.find((n) => n.length > 100);
    if (longName) {
      return sendError(reply, 400, "INVALID_REQUIRED_ARTIFACT_NAME", `Artifact name exceeds maximum length of 100 characters.`);
    }
    const dedupedNames = [...new Set(trimmedNames)];

    const now = new Date().toISOString();
    const task: WorkspaceTask = {
      task_id: newId("task"),
      workspace_id: workspaceId,
      title: trimmedTitle,
      description: body.description,
      status: "open",
      assignment_type: assignmentType,
      assigned_delegation_id: assignmentType === "delegation" ? body.assigned_delegation_id : undefined,
      required_collar_id: assignmentType === "collar" ? body.required_collar_id : undefined,
      task_kind: body.task_kind ?? "other",
      task_mode: body.task_mode ?? "direct",
      priority: body.priority ?? "normal",
      depends_on_task_ids: uniqueDeps,
      required_artifact_names: dedupedNames,
      created_by_user_id: MOCK_USER_ID,
      created_at: now,
      updated_at: now,
    };
    workspaceTasks.set(task.task_id, task);
    return reply.status(201).send({ ok: true, data: task });
  });

  /**
   * GET /api/workspaces/:workspaceId/artifacts
   * Owner-facing artifact list (metadata only, no content, no local_path).
   */
  server.get("/api/workspaces/:workspaceId/artifacts", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    const list = Array.from(workspaceArtifacts.values())
      .filter((a) => a.workspace_id === workspaceId)
      .map((a) => {
        if (a.kind === "file") {
          const { local_path: _lp, ...rest } = a as WorkspaceFileArtifact;
          return rest;
        }
        const { content: _c, ...meta } = a as WorkspaceTextArtifact;
        return { ...meta, size_bytes: Buffer.byteLength(_c, "utf8") };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return reply.send({ ok: true, data: list });
  });

  /**
   * GET /api/workspaces/:workspaceId/artifacts/:artifactId/download
   * Owner-facing file artifact download. Must be registered before /:artifactId.
   */
  server.get("/api/workspaces/:workspaceId/artifacts/:artifactId/download", async (req, reply) => {
    const { workspaceId, artifactId } = req.params as { workspaceId: string; artifactId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }
    const artifact = workspaceArtifacts.get(artifactId);
    if (!artifact || artifact.workspace_id !== workspaceId) {
      return sendError(reply, 404, "ARTIFACT_NOT_FOUND", "Artifact not found.");
    }
    if (artifact.kind !== "file") {
      return sendError(reply, 400, "NOT_A_FILE", "This artifact is not a file artifact.");
    }
    const fa = artifact as WorkspaceFileArtifact;
    if (!existsSync(fa.local_path)) {
      return sendError(reply, 404, "FILE_NOT_FOUND", "File not found on disk.");
    }
    reply.header("Content-Type", fa.mime_type);
    reply.header("Content-Disposition", `attachment; filename="${fa.name}"`);
    reply.header("Content-Length", String(fa.size_bytes));
    return reply.send(createReadStream(fa.local_path));
  });

  /**
   * GET /api/workspaces/:workspaceId/artifacts/:artifactId
   * Owner-facing artifact with full content. local_path is never returned.
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
    if (artifact.kind === "file") {
      const { local_path: _lp, ...safe } = artifact as WorkspaceFileArtifact;
      return reply.send({ ok: true, data: safe });
    }
    return reply.send({ ok: true, data: artifact });
  });

  /**
   * POST /api/workspaces/:workspaceId/artifacts/upload
   * Owner-facing file artifact upload. Must be registered before POST /artifacts.
   * Accepts multipart/form-data with fields: name (string), task_id? (string), file (binary).
   */
  server.post("/api/workspaces/:workspaceId/artifacts/upload", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = aegisWorkspaces.get(workspaceId);
    if (!workspace || workspace.owner_user_id !== MOCK_USER_ID) {
      return sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    }

    let artifactName = "";
    let taskId: string | undefined;
    let filePart: import("@fastify/multipart").MultipartFile | undefined;

    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "name") artifactName = String(part.value ?? "").trim();
        else if (part.fieldname === "task_id") taskId = String(part.value ?? "").trim() || undefined;
      } else if (part.type === "file") {
        filePart = part;
        break; // only one file expected
      }
    }

    if (!artifactName) {
      return sendError(reply, 400, "MISSING_NAME", "name field is required.");
    }
    if (!filePart) {
      return sendError(reply, 400, "MISSING_FILE", "file part is required.");
    }

    const mimeType = filePart.mimetype;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      await filePart.toBuffer().catch(() => {}); // drain stream
      return sendError(reply, 400, "INVALID_MIME_TYPE", `MIME type '${mimeType}' is not allowed.`);
    }

    const ext = getFileExtension(filePart.filename || "");
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      await filePart.toBuffer().catch(() => {});
      return sendError(reply, 400, "INVALID_EXTENSION", `File extension '${ext}' is not allowed.`);
    }

    let safeFilename: string;
    try {
      safeFilename = sanitizeFilename(filePart.filename || "upload");
    } catch {
      return sendError(reply, 400, "INVALID_FILENAME", "Filename contains invalid characters.");
    }

    if (taskId) {
      const task = workspaceTasks.get(taskId);
      if (!task || task.workspace_id !== workspaceId) {
        return sendError(reply, 400, "INVALID_TASK", "task_id not found in this workspace.");
      }
    }

    const artifactId = newId("art");
    ensureArtifactDir(workspaceId);
    const destPath = getArtifactFilePath(workspaceId, artifactId, safeFilename);

    let sizeBytes = 0;
    const dest = createWriteStream(destPath);
    let sizeExceeded = false;

    try {
      await pipeline(
        filePart.file,
        async function* (source) {
          for await (const chunk of source) {
            sizeBytes += chunk.length;
            if (sizeBytes > FILE_MAX_BYTES) {
              sizeExceeded = true;
              return;
            }
            yield chunk;
          }
        },
        dest,
      );
    } catch {
      deleteArtifactFile(destPath);
      if (sizeExceeded) {
        return sendError(reply, 400, "FILE_TOO_LARGE", `File exceeds the ${FILE_MAX_BYTES / 1024 / 1024}MB limit.`);
      }
      return sendError(reply, 500, "UPLOAD_FAILED", "Failed to write file.");
    }

    if (sizeExceeded) {
      deleteArtifactFile(destPath);
      return sendError(reply, 400, "FILE_TOO_LARGE", `File exceeds the ${FILE_MAX_BYTES / 1024 / 1024}MB limit.`);
    }

    const now = new Date().toISOString();
    const artifact: WorkspaceFileArtifact = {
      artifact_id: artifactId,
      workspace_id: workspaceId,
      name: artifactName,
      kind: "file",
      mime_type: mimeType,
      size_bytes: sizeBytes,
      local_path: destPath,
      task_id: taskId,
      created_at: now,
    };
    workspaceArtifacts.set(artifactId, artifact);
    schedulePersist();

    const { local_path: _lp, ...meta } = artifact;
    return reply.status(201).send({ ok: true, data: meta });
  });

  /**
   * POST /api/workspaces/:workspaceId/artifacts
   * Owner-facing text artifact creation (text/json/csv/markdown only).
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
    if (!body.kind || !TEXT_ARTIFACT_KINDS.includes(body.kind)) {
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
    const artifact: WorkspaceTextArtifact = {
      artifact_id: newId("art"),
      workspace_id: workspaceId,
      name: body.name.trim(),
      kind: body.kind as "text" | "json" | "csv" | "markdown",
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
