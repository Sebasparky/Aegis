import type { FastifyInstance } from "fastify";
import type { CredentialUseAuthorization, SecretFieldInjection } from "@aegis/types";
import { MOCK_USER_ID, secretFieldInjections, credentialUseAuthorizations, userApprovalReceipts, sensitiveGrants, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { buildSignedUserApprovalReceipt } from "../lib/userApprovalReceiptSigning.js";
import { buildSensitiveGrant } from "../lib/sensitiveGrants.js";
import { logInjectionLifecycle, logAuthLifecycle } from "../lib/injectionLifecycleLog.js";

/**
 * Create a UserApprovalReceipt + SensitiveGrant for a credential injection approval.
 * Throws APPROVAL_RECEIPT_SIGNING_FAILED if signing fails — unsigned receipts are never stored
 * and grants are never created without a signed UAR. Callers must await and handle the throw.
 */
async function createCredentialGrant(auth: CredentialUseAuthorization): Promise<void> {
  const now = new Date().toISOString();
  const uarId = newId("uar");

  const uar = await buildSignedUserApprovalReceipt({
    receipt_id: uarId,
    receipt_type: "user_approval",
    schema_version: "1.0",
    issuer: "aegis",
    created_at: now,
    user_id: auth.user_id,
    delegation_id: auth.delegation_id,
    approval_id: auth.authorization_id,
    approval_source: "credential_authorization",
    action_type: "login",
    target_domain: auth.domain,
    risk_level: "high",
    decision: "approved",
    decided_at: auth.approved_at ?? now,
    decision_source: "user_click",
    raw_secrets_in_receipt: false,
    raw_credentials_in_receipt: false,
  });

  if (!uar.verification.jws_present) {
    throw new Error("APPROVAL_RECEIPT_SIGNING_FAILED");
  }

  userApprovalReceipts.set(uarId, uar);

  const grant = buildSensitiveGrant({
    grant_id: newId("sg"),
    grant_type: "credential_injection",
    scope: {
      user_id: auth.user_id,
      delegation_id: auth.delegation_id,
      domain: auth.domain,
      pass_id: auth.pass_id,
      authorization_id: auth.authorization_id,
    },
    expires_at: auth.expires_at,
    linked_uar_id: uarId,
    created_at: now,
  });

  sensitiveGrants.set(grant.grant_id, grant);
  schedulePersist();
}

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function secretFieldInjectionRoutes(server: FastifyInstance): Promise<void> {
  // ─── Credential-use authorization routes (one approval per login attempt) ────

  // List pending authorizations for the approval UI
  server.get("/api/internal/credential-authorizations", async (req, reply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    let items = Array.from(credentialUseAuthorizations.values()).filter(
      (a) => a.user_id === MOCK_USER_ID,
    );
    if (status) items = items.filter((a) => a.status === status);
    // Return metadata only — never include pass_id
    return reply.send({
      ok: true,
      data: items.map((a) => ({
        authorization_id: a.authorization_id,
        domain: a.domain,
        pass_label: a.pass_label,
        pass_username: a.pass_username,
        allowed_field_kinds: a.allowed_field_kinds,
        max_uses_per_field: a.max_uses_per_field,
        use_counts: a.use_counts,
        purpose: a.purpose,
        status: a.status,
        raw_values_revealed_to_agent: false as const,
        created_at: a.created_at,
        expires_at: a.expires_at,
        approved_at: a.approved_at,
        fulfilled_at: a.fulfilled_at,
        last_used_at: a.last_used_at,
        used_field_kinds: a.used_field_kinds,
      })),
    });
  });

  // Approve a credential-use authorization (also promotes all linked pending injections)
  server.post<{ Params: { id: string } }>(
    "/api/internal/credential-authorizations/:id/approve",
    async (req, reply) => {
      const auth = credentialUseAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      if (auth.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (auth.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot approve authorization with status '${auth.status}'.`);
      }
      if (new Date(auth.expires_at) < new Date()) {
        auth.status = "expired";
        credentialUseAuthorizations.set(auth.authorization_id, auth);
        schedulePersist();
        return sendError(reply, 400, "EXPIRED", "Authorization has expired.");
      }

      // Signed receipt and SensitiveGrant must exist before authority is released.
      // Pass approvedAt via spread so auth is not mutated until signing succeeds.
      const approvedAt = new Date().toISOString();
      try {
        await createCredentialGrant({ ...auth, approved_at: approvedAt });
      } catch {
        return sendError(reply, 500, "APPROVAL_RECEIPT_SIGNING_FAILED", "Unable to create signed approval receipt. Authorization not processed.");
      }

      // Only mutate auth state after signed proof exists.
      auth.status = "approved";
      auth.approved_at = approvedAt;
      credentialUseAuthorizations.set(auth.authorization_id, auth);
      logAuthLifecycle("auth_approved", auth);

      // Promote all linked pending injections
      for (const inj of secretFieldInjections.values()) {
        if (inj.authorization_id === auth.authorization_id && inj.status === "pending_approval") {
          inj.status = "approved";
          inj.approved_at = auth.approved_at;
          secretFieldInjections.set(inj.injection_request_id, inj);
          logInjectionLifecycle("injection_approved_via_auth", inj);
        }
      }

      schedulePersist();
      return reply.send({ ok: true, data: { authorization_id: auth.authorization_id, status: auth.status } });
    },
  );

  // Deny a credential-use authorization (also marks linked pending injections as denied)
  server.post<{ Params: { id: string } }>(
    "/api/internal/credential-authorizations/:id/deny",
    async (req, reply) => {
      const auth = credentialUseAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Authorization not found.");
      if (auth.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (auth.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot deny authorization with status '${auth.status}'.`);
      }

      auth.status = "denied";
      credentialUseAuthorizations.set(auth.authorization_id, auth);
      logAuthLifecycle("auth_denied", auth);

      // Mark all linked pending injections as denied
      for (const inj of secretFieldInjections.values()) {
        if (inj.authorization_id === auth.authorization_id && inj.status === "pending_approval") {
          inj.status = "denied";
          secretFieldInjections.set(inj.injection_request_id, inj);
          logInjectionLifecycle("injection_denied_via_auth", inj);
        }
      }

      schedulePersist();
      return reply.send({ ok: true, data: { authorization_id: auth.authorization_id, status: auth.status } });
    },
  );

  // ─── Individual injection routes (used by agent polling and legacy standalone cards) ─

  // List injection requests — excludes auth-backed pending ones (shown via authorization card)
  server.get("/api/internal/injections", async (req, reply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    let items = Array.from(secretFieldInjections.values()).filter(
      (i) => i.user_id === MOCK_USER_ID,
    );
    if (status) {
      items = items.filter((i) => i.status === status);
      // For pending_approval, only show injections NOT backed by an authorization
      // (auth-backed ones appear in the authorization card instead)
      if (status === "pending_approval") {
        items = items.filter((i) => !i.authorization_id);
      }
    }
    return reply.send({
      ok: true,
      data: items.map((i) => ({
        injection_request_id: i.injection_request_id,
        domain: i.domain,
        field_kind: i.field_kind,
        page_url: i.page_url,
        element_hint: i.element_hint,
        reason: i.reason,
        status: i.status,
        raw_value_revealed_to_agent: false as const,
        created_at: i.created_at,
        expires_at: i.expires_at,
        approved_at: i.approved_at,
        executing_at: i.executing_at,
        filled_at: i.filled_at,
        error: i.error,
      })),
    });
  });

  // Approve a standalone injection (no authorization)
  server.post<{ Params: { id: string } }>(
    "/api/internal/injections/:id/approve",
    async (req, reply) => {
      const injection = secretFieldInjections.get(req.params.id);
      if (!injection) return sendError(reply, 404, "NOT_FOUND", "Injection not found.");
      if (injection.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (injection.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot approve injection with status '${injection.status}'.`);
      }
      if (new Date(injection.expires_at) < new Date()) {
        injection.status = "expired";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        return sendError(reply, 400, "INJECTION_EXPIRED", "Injection has expired.");
      }
      injection.status = "approved";
      injection.approved_at = new Date().toISOString();
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();
      logInjectionLifecycle("injection_approved_standalone", injection);
      return reply.send({ ok: true, data: { injection_request_id: injection.injection_request_id, status: injection.status } });
    },
  );

  // Deny a standalone injection
  server.post<{ Params: { id: string } }>(
    "/api/internal/injections/:id/deny",
    async (req, reply) => {
      const injection = secretFieldInjections.get(req.params.id);
      if (!injection) return sendError(reply, 404, "NOT_FOUND", "Injection not found.");
      if (injection.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (injection.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot deny injection with status '${injection.status}'.`);
      }
      injection.status = "denied";
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();
      logInjectionLifecycle("injection_denied_standalone", injection);
      return reply.send({ ok: true, data: { injection_request_id: injection.injection_request_id, status: injection.status } });
    },
  );

  // ─── Lifecycle diagnostic endpoint ───────────────────────────────────────────

  // Read-only: no writes, no secrets, no DOM values, no pass_id
  server.get<{ Params: { injectionId: string } }>(
    "/api/internal/injection-lifecycle/:injectionId",
    async (req, reply) => {
      const injection = secretFieldInjections.get(req.params.injectionId);
      if (!injection) return sendError(reply, 404, "NOT_FOUND", "Injection not found.");
      if (injection.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");

      // Derive lifecycle_stage from current status — status remains the source of truth
      const STAGE_MAP: Record<string, string> = {
        pending_approval: "pending_user_approval",
        approved: "ready_for_agent_execute",
        executing: "executing",
        filled: "filled",
        failed: "failed",
        denied: "denied",
        expired: "expired_stale",
      };
      const lifecycle_stage = STAGE_MAP[injection.status] ?? injection.status;

      // Elapsed time between lifecycle stages
      const nowMs = Date.now();
      const createdMs = new Date(injection.created_at).getTime();
      const approvedMs = injection.approved_at ? new Date(injection.approved_at).getTime() : null;
      const executingMs = injection.executing_at ? new Date(injection.executing_at).getTime() : null;
      const filledMs = injection.filled_at ? new Date(injection.filled_at).getTime() : null;

      const elapsed = {
        created_to_approved_ms: approvedMs !== null ? approvedMs - createdMs : null,
        approved_to_executing_ms:
          approvedMs !== null && executingMs !== null ? executingMs - approvedMs : null,
        executing_to_filled_ms:
          executingMs !== null && filledMs !== null ? filledMs - executingMs : null,
        total_elapsed_ms: nowMs - createdMs,
      };

      // Stale detection — purely advisory, no writes
      const TERMINAL = new Set(["filled", "denied", "failed", "expired"]);
      const expiresMs = new Date(injection.expires_at).getTime();
      const expiresInMs = expiresMs - nowMs;

      let is_stale = false;
      let stale_reason: string | null = null;

      if (injection.status === "approved" && executingMs === null) {
        const approvedAgeSec = approvedMs !== null ? (nowMs - approvedMs) / 1000 : 0;
        if (approvedAgeSec > 30) {
          is_stale = true;
          stale_reason = "approved_but_not_executing_for_over_30s";
        }
      } else if (injection.status === "executing" && filledMs === null) {
        const executingAgeSec = executingMs !== null ? (nowMs - executingMs) / 1000 : 0;
        if (executingAgeSec > 60) {
          is_stale = true;
          stale_reason = "executing_but_not_filled_for_over_60s";
        }
      } else if (injection.status === "pending_approval" && expiresInMs < 60_000) {
        is_stale = true;
        stale_reason = "pending_approval_expiring_within_60s";
      }

      const stale = {
        is_stale,
        stale_reason,
        expires_in_ms: TERMINAL.has(injection.status) ? null : expiresInMs,
      };

      // Linked auth summary — aggregate metadata only, no pass_id or labels
      let auth_summary: object | null = null;
      if (injection.authorization_id) {
        const auth = credentialUseAuthorizations.get(injection.authorization_id);
        if (auth) {
          const remainingUses: Record<string, number> = {};
          for (const fk of auth.allowed_field_kinds) {
            remainingUses[fk] = (auth.max_uses_per_field[fk] ?? 1) - (auth.use_counts[fk] ?? 0);
          }
          auth_summary = {
            authorization_id: auth.authorization_id,
            status: auth.status,
            used_field_kinds: auth.used_field_kinds,
            remaining_uses: remainingUses,
            expires_at: auth.expires_at,
          };
        }
      }

      const input_realism = injection.input_realism
        ? {
            mode: injection.input_realism.mode,
            strategy: injection.input_realism.strategy,
            char_count_bucket: injection.input_realism.char_count_bucket,
            duration_ms: injection.input_realism.duration_ms,
            success: injection.input_realism.success,
            fallback_used: injection.input_realism.fallback_used,
            fallback_reason: injection.input_realism.fallback_reason,
            failure_reason: injection.input_realism.failure_reason,
            started_at: injection.input_realism.started_at,
            completed_at: injection.input_realism.completed_at,
            verify_started_at: injection.input_realism.verify_started_at,
            verify_completed_at: injection.input_realism.verify_completed_at,
          }
        : null;

      return reply.send({
        ok: true,
        data: {
          injection_request_id: injection.injection_request_id,
          domain: injection.domain,
          field_kind: injection.field_kind,
          page_url: injection.page_url,
          reason: injection.reason,
          status: injection.status,
          lifecycle_stage,
          raw_value_revealed_to_agent: false as const,
          created_at: injection.created_at,
          expires_at: injection.expires_at,
          approved_at: injection.approved_at,
          executing_at: injection.executing_at,
          filled_at: injection.filled_at,
          error: injection.error,
          elapsed,
          stale,
          auth_summary,
          input_realism,
        },
      });
    },
  );
}
