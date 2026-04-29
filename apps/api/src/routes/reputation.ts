import type { FastifyInstance } from "fastify";
import { sessions, approvals, receipts, reputationEvents, runnerTasks, MOCK_USER_ID } from "../store/index.js";

export async function reputationRoutes(server: FastifyInstance) {
  server.get("/api/reputation/summary", async () => {
    const userSessions = Array.from(sessions.values()).filter((s) => s.user_id === MOCK_USER_ID);
    const userApprovals = Array.from(approvals.values()).filter((a) => a.user_id === MOCK_USER_ID);
    const userReceipts = Array.from(receipts.values()).filter((r) => r.user_id === MOCK_USER_ID);

    const approvals_granted = userApprovals.filter((a) => a.status === "approved").length;
    const approvals_denied = userApprovals.filter((a) => a.status === "denied").length;

    const risky_actions_blocked = userReceipts.filter(
      (r) => r.decision === "blocked" || r.outcome === "blocked"
    ).length;

    const issues_reported = Array.from(reputationEvents.values()).filter(
      (e) => e.event_type === "issue_reported"
    ).length;

    const runner_tasks_completed = Array.from(runnerTasks.values()).filter(
      (t) => t.user_id === MOCK_USER_ID && t.status === "completed"
    ).length;

    return {
      ok: true,
      data: {
        protected_sessions: userSessions.length,
        sensitive_actions_requested: userApprovals.length,
        approvals_granted,
        approvals_denied,
        risky_actions_blocked,
        receipts_created: userReceipts.length,
        issues_reported,
        runner_tasks_completed,
      },
    };
  });
}
