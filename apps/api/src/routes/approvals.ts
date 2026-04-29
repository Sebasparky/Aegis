import type { FastifyInstance } from "fastify";
import type { ApprovalRequest, Receipt } from "@aegis/types";
import { approvals, receipts, reputationEvents, sessions, MOCK_USER_ID, newId } from "../store/index.js";
import type { ReputationEvent } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { createRunnerTaskFromApproval, executeRunnerTask } from "../services/runnerService.js";

export async function approvalRoutes(server: FastifyInstance) {
  // List approvals, optionally filtered by ?status=
  server.get<{ Querystring: { status?: string } }>("/api/approvals", async (req) => {
    const statusFilter = req.query.status;
    let result = Array.from(approvals.values()).filter(
      (a) => a.user_id === MOCK_USER_ID
    );
    if (statusFilter) {
      result = result.filter((a) => a.status === statusFilter);
    }
    // Most recent first
    result.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { ok: true, data: result };
  });

  // Approve a request
  server.post<{ Params: { approvalId: string }; Body: { note?: string } }>(
    "/api/approvals/:approvalId/approve",
    async (req, reply) => {
      const approval = approvals.get(req.params.approvalId);
      if (!approval) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Approval request not found." } });
      }
      if (approval.status !== "pending") {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Approval is not pending." } });
      }

      const now = new Date().toISOString();
      const updated: ApprovalRequest = { ...approval, status: "approved", resolved_at: now };
      approvals.set(updated.id, updated);

      // Create and execute a runner task before resuming the session
      const runnerTask = createRunnerTaskFromApproval(updated);
      const completedRunner = await executeRunnerTask(runnerTask.id);

      // Resume the session after runner completes
      const session = sessions.get(approval.session_id);
      if (session?.status === "waiting_for_approval") {
        sessions.set(session.id, { ...session, status: "active" });
      }

      const userNote = req.body?.note ? ` ${req.body.note}.` : "";
      const receipt: Receipt = {
        id: newId("rec"),
        user_id: MOCK_USER_ID,
        session_id: approval.session_id,
        collar_id: approval.collar_id,
        action_type: approval.action_type,
        decision: "completed_by_runner",
        domain: approval.domain,
        reason: `User approved request.${userNote} Aegis Runner simulated completion. No real payment was made and no credentials were exposed.`,
        outcome: "completed",
        sensitive_data_shared_with_agent: false,
        runner_task_id: completedRunner.id,
        created_at: now,
      };
      receipts.set(receipt.id, receipt);

      const repEvent: ReputationEvent = {
        id: newId("rep"),
        entity_type: "user_aegis_id",
        entity_id: "aid_user_001",
        event_type: "sensitive_action_approved",
        severity: "positive",
        receipt_id: receipt.id,
        session_id: approval.session_id,
        domain: approval.domain,
        weight: 1,
        created_at: now,
      };
      reputationEvents.set(repEvent.id, repEvent);
      schedulePersist();

      return {
        ok: true,
        data: {
          id: updated.id,
          status: updated.status,
          receipt_id: receipt.id,
          runner_task_id: completedRunner.id,
        },
      };
    }
  );

  // Deny a request
  server.post<{ Params: { approvalId: string }; Body: { note?: string } }>(
    "/api/approvals/:approvalId/deny",
    async (req, reply) => {
      const approval = approvals.get(req.params.approvalId);
      if (!approval) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Approval request not found." } });
      }
      if (approval.status !== "pending") {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Approval is not pending." } });
      }

      const now = new Date().toISOString();
      const updated: ApprovalRequest = { ...approval, status: "denied", resolved_at: now };
      approvals.set(updated.id, updated);

      // Resume the session after denial so the agent can continue browsing
      const session = sessions.get(approval.session_id);
      if (session?.status === "waiting_for_approval") {
        sessions.set(session.id, { ...session, status: "active" });
      }

      const receipt: Receipt = {
        id: newId("rec"),
        user_id: MOCK_USER_ID,
        session_id: approval.session_id,
        collar_id: approval.collar_id,
        action_type: approval.action_type,
        decision: "denied_by_user",
        domain: approval.domain,
        reason: req.body?.note ?? "User denied the request.",
        outcome: "blocked",
        sensitive_data_shared_with_agent: false,
        created_at: now,
      };
      receipts.set(receipt.id, receipt);

      const repEvent: ReputationEvent = {
        id: newId("rep"),
        entity_type: "user_aegis_id",
        entity_id: "aid_user_001",
        event_type: "sensitive_action_denied",
        severity: "info",
        receipt_id: receipt.id,
        session_id: approval.session_id,
        domain: approval.domain,
        weight: 0,
        created_at: now,
      };
      reputationEvents.set(repEvent.id, repEvent);
      schedulePersist();

      return { ok: true, data: { id: updated.id, status: updated.status, receipt_id: receipt.id } };
    }
  );
}
