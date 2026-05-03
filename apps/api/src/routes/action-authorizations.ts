import type { FastifyInstance } from "fastify";
import type { ActionAuthorizationReceipt } from "@aegis/types";
import { actionAuthorizations, MOCK_USER_ID } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import {
  hashActionAuthorization,
  verifyActionAuthorizationJws,
} from "../lib/actionAuthorizationSigning.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function actionAuthorizationRoutes(server: FastifyInstance) {
  server.get("/api/action-authorizations", async () => {
    const all = Array.from(actionAuthorizations.values()).filter(
      (a) => a.user_id === MOCK_USER_ID
    );
    return { ok: true, data: all };
  });

  server.get<{ Params: { authorizationId: string } }>(
    "/api/action-authorizations/:authorizationId",
    async (req, reply) => {
      const auth = actionAuthorizations.get(req.params.authorizationId);
      if (!auth || auth.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      }
      return { ok: true, data: auth };
    }
  );

  server.get<{ Params: { authorizationId: string } }>(
    "/api/action-authorizations/:authorizationId/verify",
    async (req, reply) => {
      const auth = actionAuthorizations.get(req.params.authorizationId);
      if (!auth || auth.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      }

      // Recompute hash from immutable fields (status, fulfillment, verification excluded by hashActionAuthorization)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { verification, ...authWithoutVerification } = auth;
      const recomputed_hash = hashActionAuthorization(authWithoutVerification);
      const hash_valid = recomputed_hash === verification.authorization_hash;

      const jwsResult = await verifyActionAuthorizationJws(verification.authorization_jws);
      const signature_valid = jwsResult.valid;

      // Cross-check JWS payload fields against stored receipt
      let payload_valid = false;
      if (jwsResult.payload) {
        const p = jwsResult.payload;
        payload_valid =
          p.authorization_id === auth.authorization_id &&
          p.authorization_hash === verification.authorization_hash &&
          p.user_aegis_id === auth.user_aegis_id &&
          p.agent_id === auth.agent_id &&
          p.delegation_id === auth.delegation_id &&
          p.run_id === auth.run_id;
      }

      const revoked = auth.status === "revoked";
      const expired =
        auth.status === "expired" ||
        (auth.constraints.expires_at
          ? new Date() >= new Date(auth.constraints.expires_at)
          : false);
      const fulfilled = auth.status === "fulfilled";

      // valid = cryptographic proof is intact and authorization is not revoked/expired
      // fulfilled authorizations remain valid (the action was approved and completed)
      const valid = hash_valid && signature_valid && payload_valid && !revoked && !expired;

      return {
        ok: true,
        data: {
          valid,
          hash_valid,
          signature_valid,
          payload_valid,
          fulfilled,
          revoked,
          expired,
          status: auth.status,
          fulfillment: auth.fulfillment ?? null,
          authorization_hash: verification.authorization_hash,
          recomputed_hash,
          jws_payload: jwsResult.payload ?? null,
        },
      };
    }
  );

  server.post<{ Params: { authorizationId: string } }>(
    "/api/action-authorizations/:authorizationId/revoke",
    async (req, reply) => {
      const auth = actionAuthorizations.get(req.params.authorizationId);
      if (!auth || auth.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      }
      if (auth.status === "fulfilled") {
        return sendError(reply, 409, "ALREADY_FULFILLED", "Cannot revoke a fulfilled authorization — the action has already been executed.");
      }
      if (auth.status === "revoked") {
        return sendError(reply, 409, "ALREADY_REVOKED", "Authorization is already revoked.");
      }

      (auth as ActionAuthorizationReceipt).status = "revoked";
      actionAuthorizations.set(auth.authorization_id, auth);
      schedulePersist();

      return { ok: true };
    }
  );
}
