import type { FastifyInstance } from "fastify";
import type { SensitiveGrant } from "@aegis/types";
import { MOCK_USER_ID, sensitiveGrants, userApprovalReceipts } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { verifyStoredUserApprovalReceipt } from "../lib/userApprovalReceiptSigning.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

// Omit scope.pass_id from all owner-facing responses.
// pass_id is a vault pass ID (not a raw secret), but it is still credential metadata
// and must not be returned in API responses.
function safeGrant(g: SensitiveGrant) {
  const { pass_id: _omit, ...safeScope } = g.scope;
  return { ...g, scope: safeScope };
}

export async function sensitiveGrantRoutes(server: FastifyInstance): Promise<void> {
  // List grants for the owner
  server.get("/api/sensitive-grants", async (req, reply) => {
    const { grant_type, status, domain } = (req.query ?? {}) as {
      grant_type?: string;
      status?: string;
      domain?: string;
    };

    let items = Array.from(sensitiveGrants.values()).filter(
      (g) => g.scope.user_id === MOCK_USER_ID,
    );

    if (grant_type) items = items.filter((g) => g.grant_type === grant_type);
    if (status) items = items.filter((g) => g.status === status);
    if (domain) items = items.filter((g) => g.scope.domain === domain);

    return reply.send({ ok: true, data: items.map(safeGrant) });
  });

  // Get a single grant by ID
  server.get<{ Params: { grantId: string } }>(
    "/api/sensitive-grants/:grantId",
    async (req, reply) => {
      const grant = sensitiveGrants.get(req.params.grantId);
      if (!grant) return sendError(reply, 404, "NOT_FOUND", "Grant not found.");
      if (grant.scope.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      return reply.send({ ok: true, data: safeGrant(grant) });
    },
  );

  // Verify grant integrity by checking the linked UserApprovalReceipt
  server.get<{ Params: { grantId: string } }>(
    "/api/sensitive-grants/:grantId/verify",
    async (req, reply) => {
      const grant = sensitiveGrants.get(req.params.grantId);
      if (!grant) return sendError(reply, 404, "NOT_FOUND", "Grant not found.");
      if (grant.scope.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");

      const uar = userApprovalReceipts.get(grant.linked_uar_id);
      if (!uar) {
        return reply.send({
          ok: true,
          data: {
            grant_id: grant.grant_id,
            linked_uar_id: grant.linked_uar_id,
            uar_valid: false,
            scope_consistent: false,
            grant_status: grant.status,
            error: "LINKED_UAR_NOT_FOUND",
          },
        });
      }

      const verifyResult = await verifyStoredUserApprovalReceipt(uar);

      // Cross-check scope consistency: UAR fields must match grant scope
      const scopeConsistent =
        uar.user_id === grant.scope.user_id &&
        uar.decision === "approved" &&
        (uar.delegation_id === undefined || uar.delegation_id === grant.scope.delegation_id) &&
        (uar.target_domain === undefined || uar.target_domain === grant.scope.domain);

      return reply.send({
        ok: true,
        data: {
          grant_id: grant.grant_id,
          linked_uar_id: grant.linked_uar_id,
          uar_valid: verifyResult.valid,
          uar_hash_valid: verifyResult.hash_valid,
          scope_consistent: scopeConsistent,
          grant_status: grant.status,
          ...(verifyResult.error ? { uar_error: verifyResult.error } : {}),
        },
      });
    },
  );

  // Revoke an active grant (owner-facing only)
  server.post<{ Params: { grantId: string }; Body: { reason?: unknown } }>(
    "/api/sensitive-grants/:grantId/revoke",
    async (req, reply) => {
      const grant = sensitiveGrants.get(req.params.grantId);
      if (!grant) return sendError(reply, 404, "NOT_FOUND", "Grant not found.");
      if (grant.scope.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (grant.status !== "active") {
        return sendError(
          reply,
          400,
          "INVALID_STATUS",
          `Cannot revoke grant with status '${grant.status}'. Only active grants can be revoked.`,
        );
      }

      grant.status = "revoked";
      grant.revoked_at = new Date().toISOString();
      if (req.body?.reason && typeof req.body.reason === "string") {
        grant.revoke_reason = req.body.reason.slice(0, 200);
      }
      sensitiveGrants.set(grant.grant_id, grant);
      schedulePersist();

      return reply.send({ ok: true, data: { grant_id: grant.grant_id, status: grant.status } });
    },
  );
}
