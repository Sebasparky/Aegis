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

import type { AegisWorkspace, AgentDelegation, ActionType, Collar } from "@aegis/types";
import {
  aegisWorkspaces,
  collars,
  workspaceAuditEvents,
  newId,
  type WorkspaceAuditEvent,
} from "../store/index.js";

export type WorkspaceAccessError =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ACCESS_DENIED"
  | "WORKSPACE_COLLAR_INACTIVE"
  | "WORKSPACE_PERMISSION_DENIED"
  | "WORKSPACE_PERMISSION_REQUIRES_APPROVAL";

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

  const delegationCollar = collars.get(delegation.default_collar_id);
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
