/**
 * Workspace domain logic — reusable helpers for workspace access checks and audit events.
 * Kept separate from route handlers to avoid burying business rules in HTTP plumbing.
 *
 * Collar enforcement:
 *   - workspace.collar_id must reference an existing, active collar (liveness check)
 *   - delegation must be in workspace.participant_delegation_ids
 *   - per-operation ActionType enforcement uses the intersection of the workspace collar
 *     and the delegation's default collar — the stricter limit wins.
 */

import type {
  AegisWorkspace,
  AgentDelegation,
  ActionType,
  Collar,
  WorkspaceTask,
  TaskKind,
  TaskMode,
  TaskPriority,
  TaskEligibilityLabel,
  TaskReadinessLabel,
  TaskBlockerReasons,
  TaskRecommendedAction,
  WorkspaceTaskManifestEntry,
} from "@aegis/types";
import {
  aegisWorkspaces,
  collars,
  workspaceArtifacts,
  workspaceAuditEvents,
  newId,
  type WorkspaceAuditEvent,
} from "../store/index.js";

export type WorkspaceAccessError =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ACCESS_DENIED"
  | "WORKSPACE_COLLAR_INACTIVE"
  | "WORKSPACE_PERMISSION_DENIED"
  | "WORKSPACE_PERMISSION_REQUIRES_APPROVAL"
  | "TASK_NOT_ELIGIBLE"
  | "TASK_NOT_READY";

export interface WorkspaceAccessResult {
  ok: true;
  workspace: AegisWorkspace;
}

export interface WorkspaceAccessDenied {
  ok: false;
  code: WorkspaceAccessError;
  message: string;
}

/**
 * Validates that a delegation may access the given workspace:
 *   1. Workspace exists and is active.
 *   2. Workspace collar exists and is active.
 *   3. Delegation is in participant_delegation_ids.
 */
export function requireWorkspaceAccess(
  workspaceId: string,
  delegation: AgentDelegation,
): WorkspaceAccessResult | WorkspaceAccessDenied {
  const workspace = aegisWorkspaces.get(workspaceId);
  if (!workspace || workspace.status !== "active") {
    return { ok: false, code: "WORKSPACE_NOT_FOUND", message: "Workspace not found." };
  }

  const collar = collars.get(workspace.collar_id);
  if (!collar || collar.status !== "active") {
    return {
      ok: false,
      code: "WORKSPACE_COLLAR_INACTIVE",
      message: "The workspace collar is inactive or missing. Contact the workspace owner.",
    };
  }

  if (!workspace.participant_delegation_ids.includes(delegation.id)) {
    return {
      ok: false,
      code: "WORKSPACE_ACCESS_DENIED",
      message: "Your delegation is not a participant in this workspace.",
    };
  }

  return { ok: true, workspace };
}

function evaluateCollarForAction(
  collar: Collar,
  action: ActionType,
): "allow" | "approval_required" | "hard_block" {
  if (collar.blocked_actions.includes(action)) return "hard_block";
  if (!collar.allowed_actions.includes(action) && !collar.approval_required_actions.includes(action))
    return "hard_block";
  if (collar.approval_required_actions.includes(action)) return "approval_required";
  return "allow";
}

/**
 * Checks that the given action is permitted by the intersection of the workspace collar
 * and the delegation's default collar. Call this after requireWorkspaceAccess succeeds.
 *
 * Note: approval_required from either collar returns WORKSPACE_PERMISSION_REQUIRES_APPROVAL
 * (403) in v1 — no workspace CRUD approval flow exists yet.
 */
export function checkWorkspacePermission(
  _workspace: AegisWorkspace,
  workspaceCollar: Collar,
  delegation: AgentDelegation,
  action: ActionType,
): { ok: true } | WorkspaceAccessDenied {
  const wsDecision = evaluateCollarForAction(workspaceCollar, action);

  const delegationCollar = delegation.default_collar_id ? collars.get(delegation.default_collar_id) : undefined;
  if (!delegationCollar || delegationCollar.status !== "active") {
    return {
      ok: false,
      code: "WORKSPACE_COLLAR_INACTIVE",
      message: "Your delegation collar is inactive or missing.",
    };
  }
  const delDecision = evaluateCollarForAction(delegationCollar, action);

  if (wsDecision === "hard_block" || delDecision === "hard_block") {
    return {
      ok: false,
      code: "WORKSPACE_PERMISSION_DENIED",
      message: "This operation is not permitted by the active collars.",
    };
  }

  if (wsDecision === "approval_required" || delDecision === "approval_required") {
    return {
      ok: false,
      code: "WORKSPACE_PERMISSION_REQUIRES_APPROVAL",
      message: "This operation requires approval; workspace CRUD approvals are not yet supported.",
    };
  }

  return { ok: true };
}

/**
 * Checks whether a delegation is eligible to claim a specific task based on assignment_type.
 * Called after workspace access and permission checks have already passed.
 *
 * assignment_type semantics:
 *   "open" (or absent) — any participant may claim
 *   "delegation"       — only assigned_delegation_id may claim;
 *                        assigned_delegation_id on an open task = reserved claimant
 *   "collar"           — only a delegation whose default_collar_id matches required_collar_id
 */
export function checkTaskEligibility(
  task: WorkspaceTask,
  delegation: AgentDelegation,
): { ok: true } | WorkspaceAccessDenied {
  const type = task.assignment_type ?? "open";

  if (type === "open") return { ok: true };

  if (type === "delegation") {
    if (task.assigned_delegation_id === delegation.id) return { ok: true };
    return {
      ok: false,
      code: "TASK_NOT_ELIGIBLE",
      message: "This task is assigned to a specific delegation and cannot be claimed by others.",
    };
  }

  // type === "collar"
  if (!task.required_collar_id) {
    return {
      ok: false,
      code: "TASK_NOT_ELIGIBLE",
      message: "This task requires a collar but none is configured.",
    };
  }
  const requiredCollar = collars.get(task.required_collar_id);
  if (!requiredCollar || requiredCollar.status !== "active") {
    return {
      ok: false,
      code: "TASK_NOT_ELIGIBLE",
      message: "Required collar is inactive or missing.",
    };
  }
  if (delegation.default_collar_id !== task.required_collar_id) {
    return {
      ok: false,
      code: "TASK_NOT_ELIGIBLE",
      message: `Your delegation collar does not match the required collar.`,
    };
  }
  return { ok: true };
}

export const WORKSPACE_ACTIONS = [
  "workspace_read",
  "workspace_task_list",
  "workspace_task_claim",
  "workspace_task_complete",
  "workspace_artifact_create",
  "workspace_artifact_list",
  "workspace_artifact_read",
] as const;

export type WorkspacePermissionVerdict = "allow" | "step_up_required" | "blocked";
export type EffectivePermissionsMap = Record<
  (typeof WORKSPACE_ACTIONS)[number],
  WorkspacePermissionVerdict
>;

/**
 * Computes the effective permission verdict for all 7 workspace actions using the
 * intersection of the workspace collar and delegation collar. Stricter limit wins.
 */
export function buildEffectivePermissionsMap(
  workspaceCollar: Collar,
  delegationCollar: Collar,
): EffectivePermissionsMap {
  const result = {} as EffectivePermissionsMap;
  for (const action of WORKSPACE_ACTIONS) {
    const ws = evaluateCollarForAction(workspaceCollar, action);
    const del = evaluateCollarForAction(delegationCollar, action);
    if (ws === "hard_block" || del === "hard_block") result[action] = "blocked";
    else if (ws === "approval_required" || del === "approval_required") result[action] = "step_up_required";
    else result[action] = "allow";
  }
  return result;
}

/** Emits a lightweight audit event for task_claimed, task_completed, or artifact_created. */
export function emitWorkspaceAudit(
  event: Omit<WorkspaceAuditEvent, "event_id" | "created_at">,
): void {
  const record: WorkspaceAuditEvent = {
    ...event,
    event_id: newId("waudit"),
    created_at: new Date().toISOString(),
  };
  workspaceAuditEvents.set(record.event_id, record);
}

// ─── Task Readiness and Work Queue ──────────────────────────────────────────

export interface TaskReadinessResult {
  readiness: TaskReadinessLabel;
  blockers?: TaskBlockerReasons;
}

/**
 * Determines whether a task's preconditions are satisfied.
 * Does NOT consider eligibility — call checkTaskEligibility separately.
 * For non-open tasks, derives status-based readiness labels directly.
 */
export function computeTaskReadiness(
  task: WorkspaceTask,
  callingDelegationId: string,
  allTasks: WorkspaceTask[],
  artifactNames: Set<string>,
): TaskReadinessResult {
  if (task.status === "in_progress") {
    return {
      readiness:
        task.assigned_delegation_id === callingDelegationId ? "in_progress_mine" : "in_progress_other",
    };
  }
  if (task.status === "completed") return { readiness: "completed" };
  if (task.status === "cancelled") return { readiness: "cancelled" };

  // task.status === "open" — check dependency and artifact preconditions
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
    const blockers: TaskBlockerReasons = {};
    if (incompleteDeps.length > 0) blockers.incomplete_dependency_task_ids = incompleteDeps;
    if (missingArtifacts.length > 0) blockers.missing_artifact_names = missingArtifacts;
    return { readiness: "blocked", blockers };
  }

  return { readiness: "ready" };
}

/**
 * Builds a WorkspaceTaskManifestEntry for a single task from the calling delegation's perspective.
 * Eligibility mirrors the manifest bucket logic; readiness checks dependencies and artifacts.
 */
export function enrichTaskForManifest(
  task: WorkspaceTask,
  callingDelegationId: string,
  callingDelegationCollarId: string,
  allTasks: WorkspaceTask[],
  artifactNames: Set<string>,
): WorkspaceTaskManifestEntry {
  const task_kind: TaskKind = task.task_kind ?? "other";
  const task_mode: TaskMode = task.task_mode ?? "direct";
  const priority: TaskPriority = task.priority ?? "normal";

  // Determine eligibility label
  let eligibility: TaskEligibilityLabel;
  const type = task.assignment_type ?? "open";

  if (task.status === "in_progress" && task.assigned_delegation_id === callingDelegationId) {
    eligibility = "assigned_to_me";
  } else if (type === "delegation") {
    eligibility =
      task.assigned_delegation_id === callingDelegationId ? "assigned_to_me" : "not_eligible";
  } else if (type === "collar") {
    const rc = task.required_collar_id ? collars.get(task.required_collar_id) : undefined;
    if (!rc || rc.status !== "active") {
      eligibility = "not_eligible";
    } else if (callingDelegationCollarId === task.required_collar_id) {
      eligibility = "eligible";
    } else {
      eligibility = "not_eligible";
    }
  } else {
    eligibility = "open";
  }

  // Compute readiness
  const { readiness, blockers } = computeTaskReadiness(task, callingDelegationId, allTasks, artifactNames);

  // Build blocker_reasons — include not_eligible_reason when ineligible
  let blocker_reasons: TaskBlockerReasons | undefined = blockers ? { ...blockers } : undefined;
  if (eligibility === "not_eligible") {
    blocker_reasons = blocker_reasons ?? {};
    if (type === "delegation") {
      blocker_reasons.not_eligible_reason = "assigned_to_other_delegation";
    } else if (type === "collar") {
      const rc = task.required_collar_id ? collars.get(task.required_collar_id) : undefined;
      if (!rc || rc.status !== "active") {
        blocker_reasons.not_eligible_reason = "required_collar_inactive_or_missing";
      } else {
        blocker_reasons.not_eligible_reason = `requires_collar:${task.required_collar_id}`;
      }
    }
  }
  if (readiness === "in_progress_other") {
    blocker_reasons = blocker_reasons ?? {};
    blocker_reasons.claimed_by_other = true;
  }

  // Derive recommended_action
  let recommended_action: TaskRecommendedAction;
  let reason: string;

  if (readiness === "in_progress_mine") {
    recommended_action = "continue_work";
    reason = "You have claimed this task. Continue working and complete it when done.";
  } else if (readiness === "in_progress_other") {
    recommended_action = "wait";
    reason = "This task is in progress by another agent.";
  } else if (readiness === "completed") {
    recommended_action = "none";
    reason = "Task is complete.";
  } else if (readiness === "cancelled") {
    recommended_action = "none";
    reason = "Task is cancelled.";
  } else if (eligibility === "not_eligible") {
    recommended_action = "none";
    reason = blocker_reasons?.not_eligible_reason ?? "Not eligible to claim this task.";
  } else if (readiness === "ready") {
    recommended_action = "claim";
    reason =
      task_mode === "plan_first"
        ? "Ready to claim. plan_first: draft an approach before executing."
        : "Ready to claim.";
  } else {
    // blocked + eligible
    recommended_action = "wait";
    const parts: string[] = [];
    if (blockers?.incomplete_dependency_task_ids?.length) {
      parts.push(`waiting on tasks: ${blockers.incomplete_dependency_task_ids.join(", ")}`);
    }
    if (blockers?.missing_artifact_names?.length) {
      parts.push(`missing artifacts: ${blockers.missing_artifact_names.join(", ")}`);
    }
    reason = `Blocked — ${parts.join("; ")}.`;
  }

  const entry: WorkspaceTaskManifestEntry = {
    task_id: task.task_id,
    title: task.title,
    description: task.description,
    task_kind,
    task_mode,
    priority,
    status: task.status,
    eligibility,
    readiness,
    recommended_action,
    reason,
  };
  if (blocker_reasons && Object.keys(blocker_reasons).length > 0) {
    entry.blocker_reasons = blocker_reasons;
  }
  return entry;
}

/**
 * Sorts enriched manifest entries into the recommended_work_queue.
 *
 * Tier 0 — in_progress_mine (continue_work)
 * Tier 1 — ready + eligible/assigned_to_me/open  (sorted by priority, unblock count, created_at)
 * Tier 2 — blocked + eligible/assigned_to_me/open
 * Tier 3 — not_eligible
 * Tier 4 — completed or cancelled
 */
export function buildWorkQueue(
  entries: WorkspaceTaskManifestEntry[],
  allTasks: WorkspaceTask[],
): WorkspaceTaskManifestEntry[] {
  const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

  // Precompute how many other tasks depend on each task_id
  const unblockCount = new Map<string, number>();
  for (const t of allTasks) {
    for (const depId of t.depends_on_task_ids ?? []) {
      unblockCount.set(depId, (unblockCount.get(depId) ?? 0) + 1);
    }
  }

  // Map task_id → created_at for stable tiebreaking
  const createdAt = new Map<string, string>(allTasks.map((t) => [t.task_id, t.created_at]));

  function tier(e: WorkspaceTaskManifestEntry): number {
    if (e.readiness === "in_progress_mine") return 0;
    if (e.eligibility !== "not_eligible") {
      if (e.readiness === "ready") return 1;
      if (e.readiness === "blocked") return 2;
    }
    if (e.eligibility === "not_eligible") return 3;
    return 4; // completed / cancelled
  }

  return [...entries].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 1) {
      const pDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (pDiff !== 0) return pDiff;
      const ucDiff = (unblockCount.get(b.task_id) ?? 0) - (unblockCount.get(a.task_id) ?? 0);
      if (ucDiff !== 0) return ucDiff;
    }
    return (createdAt.get(a.task_id) ?? "").localeCompare(createdAt.get(b.task_id) ?? "");
  });
}

/**
 * Builds the artifact name set for a workspace — used by computeTaskReadiness.
 * Pass the workspace_id to filter to the correct workspace.
 */
export function buildWorkspaceArtifactNames(workspaceId: string): Set<string> {
  const names = new Set<string>();
  for (const a of workspaceArtifacts.values()) {
    if (a.workspace_id === workspaceId) names.add(a.name);
  }
  return names;
}
