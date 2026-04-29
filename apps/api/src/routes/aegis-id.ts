import type { FastifyInstance } from "fastify";
import { receipts, runnerTasks, approvals, users, MOCK_USER_ID } from "../store/index.js";

export async function aegisIdRoutes(server: FastifyInstance) {
  server.get("/api/aegis-id/me/trust-claims", async () => {
    const user = users.get(MOCK_USER_ID);
    const aegis_id = user?.aegis_id ?? "aid_user_001";

    const userReceipts = Array.from(receipts.values()).filter((r) => r.user_id === MOCK_USER_ID);
    const userApprovals = Array.from(approvals.values()).filter((a) => a.user_id === MOCK_USER_ID);
    const userRunners = Array.from(runnerTasks.values()).filter((t) => t.user_id === MOCK_USER_ID);

    const runner_completed_purchases = userRunners.filter(
      (t) => t.status === "completed" && t.task_type === "complete_approved_purchase"
    ).length;

    const blocked_risky_actions = userReceipts.filter(
      (r) => r.decision === "blocked" || r.outcome === "blocked"
    ).length;

    const approvals_granted = userApprovals.filter((a) => a.status === "approved").length;
    const approvals_denied = userApprovals.filter((a) => a.status === "denied").length;

    // Always 0 in current system — vault values are never returned to the outside agent.
    // Incident reporting is not yet implemented; this will become dynamic in a future milestone.
    const credential_exposure_incidents = 0;

    const sensitive_data_shared_with_agent_count = userReceipts.filter(
      (r) => r.sensitive_data_shared_with_agent === true
    ).length;

    const purchase_history =
      runner_completed_purchases >= 1 && credential_exposure_incidents === 0
        ? "demo_clean"
        : "no_history";

    return {
      ok: true,
      data: {
        aegis_id,
        verified_human_backed: true,
        runner_completed_purchases,
        blocked_risky_actions,
        approvals_granted,
        approvals_denied,
        credential_exposure_incidents,
        sensitive_data_shared_with_agent_count,
        purchase_history,
        last_updated: new Date().toISOString(),
      },
    };
  });
}
