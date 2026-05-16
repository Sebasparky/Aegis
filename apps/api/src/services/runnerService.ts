import type { ApprovalRequest, RunnerTask } from "@aegis/types";
import { runnerTasks, MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getController } from "../browser/browserManager.js";
import { getMockCheckoutData } from "./mockVaultService.js";

export function createRunnerTaskFromApproval(approval: ApprovalRequest): RunnerTask {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 120_000).toISOString();
  const isPurchase = approval.action_type === "purchase" || approval.action_type === "payment";

  const task: RunnerTask = {
    id: newId("runner"),
    user_id: MOCK_USER_ID,
    session_id: approval.session_id,
    approval_request_id: approval.id,
    collar_id: approval.collar_id,
    task_type: isPurchase ? "complete_approved_purchase" : "complete_approved_sensitive_action",
    status: "pending",
    domain: approval.domain,
    constraints: isPurchase
      ? {
          amount: approval.context?.amount,
          domain: approval.domain,
          can_save_payment_method: false,
          can_buy_subscription: false,
        }
      : { domain: approval.domain },
    created_at: now.toISOString(),
    expires_at: expiresAt,
  };

  runnerTasks.set(task.id, task);
  schedulePersist();
  return task;
}

export async function executeRunnerTask(runnerTaskId: string): Promise<RunnerTask> {
  const task = runnerTasks.get(runnerTaskId);
  if (!task) throw new Error(`Runner task not found: ${runnerTaskId}`);

  if (task.status === "completed") return task;

  const now = new Date().toISOString();
  const running: RunnerTask = { ...task, status: "running", started_at: now };
  runnerTasks.set(running.id, running);

  let result: string;
  let extraConstraints: Record<string, unknown> = {};

  if (task.task_type === "complete_approved_purchase") {
    const controller = getController(task.session_id);
    if (controller) {
      try {
        const vaultData = getMockCheckoutData();
        const fillResult = await controller.fillCheckoutFromVault(vaultData);
        result =
          "Antigen Runner filled fake checkout details from the mock vault. No real payment was made. No credentials were exposed to the outside agent.";
        extraConstraints = {
          mock_vault_used: true,
          fields_filled_count: fillResult.fields_filled.length,
          sensitive_data_shared_with_agent: false,
        };
      } catch (err) {
        console.error("[RunnerService] fillCheckoutFromVault failed:", err);
        result =
          "Antigen Runner attempted form fill but encountered an error. Simulated completion. No real payment was made and no credentials were exposed.";
        extraConstraints = { mock_vault_used: false, sensitive_data_shared_with_agent: false };
      }
    } else {
      // No live browser session — fall back to simulation
      result =
        "Simulated checkout completed. No real payment was made and no credentials were exposed.";
      extraConstraints = { mock_vault_used: false, sensitive_data_shared_with_agent: false };
    }
  } else {
    result =
      "Simulated sensitive action completed. No credentials were exposed to the outside agent.";
  }

  const completed: RunnerTask = {
    ...running,
    status: "completed",
    result,
    constraints: { ...running.constraints, ...extraConstraints },
    completed_at: new Date().toISOString(),
  };
  runnerTasks.set(completed.id, completed);
  schedulePersist();
  return completed;
}
