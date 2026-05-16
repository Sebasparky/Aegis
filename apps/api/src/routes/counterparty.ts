import type { FastifyInstance } from "fastify";
import { users, receipts, runnerTasks, approvals, collars } from "../store/index.js";
import type {
  AgentTrustPassport,
  AgentTrustStatus,
  RecommendedBusinessAction,
} from "@aegis/types";

export async function counterpartyRoutes(server: FastifyInstance) {
  server.get<{ Params: { aegisId: string } }>(
    "/api/counterparty/agent/:aegisId/trust-passport",
    async (req, reply) => {
      const { aegisId } = req.params;

      const user = Array.from(users.values()).find((u) => u.aegis_id === aegisId);
      if (!user) {
        return reply.status(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: "AntigenID not found" },
        });
      }

      const userId = user.id;
      const userReceipts = Array.from(receipts.values()).filter((r) => r.user_id === userId);
      const userApprovals = Array.from(approvals.values()).filter((a) => a.user_id === userId);
      const userRunners = Array.from(runnerTasks.values()).filter((t) => t.user_id === userId);

      const runner_completed_purchases = userRunners.filter(
        (t) => t.status === "completed" && t.task_type === "complete_approved_purchase"
      ).length;

      const approvals_granted = userApprovals.filter((a) => a.status === "approved").length;
      const approvals_denied = userApprovals.filter((a) => a.status === "denied").length;

      const blocked_risky_actions = userReceipts.filter(
        (r) => r.decision === "blocked" || r.outcome === "blocked"
      ).length;

      // Always 0 in current system — vault values are never returned to outside agents.
      // Real incident tracking is not yet implemented.
      const credential_exposure_incidents = 0;

      const sensitive_data_shared_with_agent_count = userReceipts.filter(
        (r) => r.sensitive_data_shared_with_agent === true
      ).length;

      let trust_status: AgentTrustStatus;
      if (credential_exposure_incidents > 0 || sensitive_data_shared_with_agent_count > 0) {
        trust_status = "risk_flagged";
      } else if (
        runner_completed_purchases >= 1 &&
        credential_exposure_incidents === 0 &&
        sensitive_data_shared_with_agent_count === 0
      ) {
        trust_status = "demo_verified";
      } else {
        trust_status = "limited_history";
      }

      const actionMap: Record<AgentTrustStatus, RecommendedBusinessAction> = {
        demo_verified: "allow_with_aegis_controls",
        limited_history: "require_extra_verification",
        risk_flagged: "block_sensitive_interaction",
      };

      // Use the most recently updated active collar; fall back to first active collar found.
      const activeCollars = Array.from(collars.values()).filter(
        (c) => c.user_id === userId && c.status === "active"
      );
      const activeCollar = activeCollars.sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )[0];

      const active_policy_summary = {
        purchase_requires_approval: activeCollar?.approval_required_actions.includes("purchase") ?? true,
        payment_requires_approval: activeCollar?.approval_required_actions.includes("payment") ?? true,
        subscriptions_allowed: activeCollar?.spending_limits.subscriptions_allowed ?? false,
        max_purchase_amount: activeCollar?.spending_limits.max_with_approval ?? 0,
        identity_disclosure_blocked: activeCollar?.blocked_actions.includes("identity_disclosure") ?? true,
      };

      // verified_human_backed is demo/mock true — real human verification is not yet implemented.
      const passport: AgentTrustPassport = {
        aegis_id: aegisId,
        verified_human_backed: true,
        trust_status,
        runner_completed_purchases,
        approvals_granted,
        approvals_denied,
        blocked_risky_actions,
        credential_exposure_incidents,
        sensitive_data_shared_with_agent_count,
        active_policy_summary,
        recommended_business_action: actionMap[trust_status],
        disclosure_level: "claims_only_no_raw_history",
        last_updated: new Date().toISOString(),
      };

      return { ok: true, data: passport };
    }
  );
}
