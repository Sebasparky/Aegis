import type { FastifyInstance } from "fastify";
import type { DelegationPassport } from "@aegis/types";
import {
  agentDelegations,
  collars,
  delegationPassports,
  newId,
  MOCK_USER_ID,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import {
  hashDelegationPassport,
  signDelegationPassportJws,
  verifyDelegationPassportJws,
  UnsignedDevModeError,
} from "../lib/delegationPassportSigning.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function delegationPassportRoutes(server: FastifyInstance) {
  // ─── POST /api/delegation-passports ─────────────────────────────────────────

  server.post<{
    Body: { delegation_id: string; expires_in_minutes?: number };
  }>("/api/delegation-passports", async (request, reply) => {
    const { delegation_id, expires_in_minutes = 60 } = request.body ?? {};

    if (!delegation_id) {
      return sendError(reply, 400, "MISSING_DELEGATION_ID", "delegation_id is required.");
    }

    const delegation = agentDelegations.get(delegation_id);
    if (!delegation) {
      return sendError(reply, 404, "DELEGATION_NOT_FOUND", `Delegation ${delegation_id} not found.`);
    }
    if (delegation.user_id !== MOCK_USER_ID) {
      return sendError(reply, 403, "FORBIDDEN", "This delegation does not belong to the current user.");
    }

    const collar = delegation.default_collar_id ? collars.get(delegation.default_collar_id) : undefined;

    // ─── Capability attestations from vault passes ───────────────────────────
    const vaultRepo = getVaultRepository();
    const passes = await vaultRepo.listVaultPasses(MOCK_USER_ID);

    // ─── Evidence summary from verified receipts ─────────────────────────────
    const receiptRepo = getReceiptRepository();
    const allReceipts = await receiptRepo.listReceipts(MOCK_USER_ID);

    let verifiedCount = 0;
    let sensitiverCount = 0;
    let credentialUses = 0;
    let coveredEvents = 0;
    let uncoveredEvents = 0;
    let secretsRevealed = 0;
    const verifiedIds: { id: string; created_at: string }[] = [];

    for (const receipt of allReceipts) {
      const result = await receiptRepo.verifyReceipt(receipt.receipt_id);
      if (!result?.valid) continue;

      verifiedCount++;
      verifiedIds.push({ id: receipt.receipt_id, created_at: receipt.created_at ?? "" });

      if (receipt.credential_used === true) {
        credentialUses++;
        sensitiverCount++;
      }
      const coverage = receipt.runtime_coverage_summary;
      if (coverage) {
        const sensitiveEvents = (coverage as unknown as Record<string, number>)["sensitive_events"] ?? 0;
        if (sensitiveEvents > 0) sensitiverCount++;
        coveredEvents += (coverage as unknown as Record<string, number>)["covered_events"] ?? 0;
        uncoveredEvents += (coverage as unknown as Record<string, number>)["uncovered_events"] ?? 0;
      }
      // The type is `false | undefined` by design (Aegis never returns true).
      // Count truthy values as a defensive guard in case the field evolves.
      if (receipt.secret_values_revealed_to_agent) {
        secretsRevealed++;
      }
    }

    // Most recent 5 verified receipt IDs
    verifiedIds.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const recentReceiptIds = verifiedIds.slice(0, 5).map((x) => x.id);

    // ─── Build passport (without verification block) ─────────────────────────
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expires_in_minutes * 60 * 1000).toISOString();
    const issuedAt = now.toISOString();
    const passportId = newId("pp");
    const issuer = process.env.AEGIS_RECEIPT_ISSUER ?? "aegis.dev";

    const passportWithoutVerification: Omit<DelegationPassport, "verification"> = {
      passport_id: passportId,
      issuer,
      issued_at: issuedAt,
      expires_at: expiresAt,
      status: "active",

      human_subject: {
        user_id: delegation.user_id,
        user_aegis_id: delegation.user_aegis_id ?? "aid_user_001",
        identity_level: "dev_verified",
        liability_acknowledged: true,
        liability_terms_version: "aegis-terms-v0.1",
      },

      agent_subject: {
        // agent_name is used as agent_id — a fallback until AgentDelegation gains a stable agent_id field.
        agent_id: delegation.agent_name,
        agent_name: delegation.agent_name,
        agent_platform: delegation.agent_platform,
      },

      delegation: {
        delegation_id: delegation.id,
        collar_id: collar?.id,
        allowed_actions: collar?.allowed_actions ?? ["browse", "login"],
        blocked_actions: collar?.blocked_actions ?? [
          "payment",
          "purchase_above_limit",
          "account_deletion",
          "password_change",
        ],
        approval_required_for: collar?.approval_required_actions ?? [
          "login",
          "payment",
          "purchase",
          "identity_disclosure",
        ],
      },

      capability_attestations: {
        login_credentials_available: passes.length > 0,
        payment_method_available: false,
        identity_profile_available: false,
        credential_domains: [...new Set(passes.map((p) => p.domain))],
        max_transaction_amount_usd: collar?.spending_limits?.max_with_approval ?? 0,
      },

      secret_custody: {
        aegis_holds_user_secrets: passes.length > 0,
        agent_receives_raw_credentials: false,
        agent_receives_raw_payment_data: false,
        agent_receives_raw_identity_documents: false,
        release_model: "aegis_controlled_context_bound",
      },

      aegis_coverage_boundary: {
        covered_only_when_aegis_authorizes_and_releases_capability: true,
        covered_actions_require_controlled_runtime: true,
        covered_actions_require_sensitive_workflow_detection: true,
        covered_actions_require_signed_receipt: true,
        out_of_band_secret_use_not_covered: true,
        aegis_does_not_prove_agent_has_no_out_of_band_secrets: true,
      },

      evidence_summary: {
        verified_receipts: verifiedCount,
        verified_sensitive_receipts: sensitiverCount,
        credential_uses: credentialUses,
        covered_sensitive_events: coveredEvents,
        uncovered_sensitive_events: uncoveredEvents,
        secrets_revealed_to_agents: secretsRevealed,
        policy_violations: 0,
        recent_receipt_ids: recentReceiptIds,
      },
    };

    // ─── Hash and sign ────────────────────────────────────────────────────────
    const passportHash = hashDelegationPassport(passportWithoutVerification);

    let passportJws = "";
    try {
      passportJws = await signDelegationPassportJws({
        typ: "aegis.delegation_passport.v1",
        passport_id: passportId,
        passport_hash: passportHash,
        issuer,
        issued_at: issuedAt,
        expires_at: expiresAt,
        user_aegis_id: passportWithoutVerification.human_subject.user_aegis_id,
        agent_id: passportWithoutVerification.agent_subject.agent_id,
        delegation_id: delegation.id,
        collar_id: collar?.id,
      });
    } catch (err) {
      if (err instanceof UnsignedDevModeError) {
        passportJws = "unsigned-dev-mode";
      } else {
        return sendError(reply, 500, "SIGNING_FAILED", "Failed to sign delegation passport.");
      }
    }

    const passport: DelegationPassport = {
      ...passportWithoutVerification,
      verification: {
        passport_hash: passportHash,
        passport_jws: passportJws,
      },
    };

    delegationPassports.set(passportId, passport);
    schedulePersist();

    return reply.send({ ok: true, data: passport });
  });

  // ─── GET /api/delegation-passports/:passportId ───────────────────────────────

  server.get<{ Params: { passportId: string } }>(
    "/api/delegation-passports/:passportId",
    async (request, reply) => {
      const passport = delegationPassports.get(request.params.passportId);
      if (!passport) {
        return sendError(reply, 404, "NOT_FOUND", "Delegation passport not found.");
      }
      if (passport.human_subject.user_id !== MOCK_USER_ID) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied.");
      }
      return reply.send({ ok: true, data: passport });
    }
  );

  // ─── GET /api/delegation-passports/:passportId/status ───────────────────────

  server.get<{ Params: { passportId: string } }>(
    "/api/delegation-passports/:passportId/status",
    async (request, reply) => {
      const passport = delegationPassports.get(request.params.passportId);
      if (!passport) {
        return sendError(reply, 404, "NOT_FOUND", "Delegation passport not found.");
      }
      if (passport.human_subject.user_id !== MOCK_USER_ID) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied.");
      }
      const now = new Date();
      const expired = now >= new Date(passport.expires_at);
      const revoked = passport.status === "revoked";
      const active = passport.status === "active" && !expired && !revoked;
      return reply.send({
        ok: true,
        data: {
          passport_id: passport.passport_id,
          status: passport.status,
          expires_at: passport.expires_at,
          active,
          revoked,
        },
      });
    }
  );

  // ─── GET /api/delegation-passports/:passportId/verify ───────────────────────

  server.get<{ Params: { passportId: string } }>(
    "/api/delegation-passports/:passportId/verify",
    async (request, reply) => {
      const passport = delegationPassports.get(request.params.passportId);
      if (!passport) {
        return sendError(reply, 404, "NOT_FOUND", "Delegation passport not found.");
      }

      // Recompute hash from everything except the verification block.
      const { verification, ...passportWithoutVerification } = passport;

      const recomputedHash = hashDelegationPassport(passportWithoutVerification);
      const hashValid = recomputedHash === verification.passport_hash;

      // Verify JWS signature.
      const jwsResult =
        verification.passport_jws === "unsigned-dev-mode"
          ? { valid: false, error: "UNSIGNED_DEV_MODE" }
          : await verifyDelegationPassportJws(verification.passport_jws);

      let signatureValid = jwsResult.valid;
      const jwsPayload = jwsResult.payload;

      // Cross-check JWS payload fields against the stored passport.
      if (signatureValid && jwsPayload) {
        if (
          jwsPayload.passport_id !== passport.passport_id ||
          jwsPayload.passport_hash !== verification.passport_hash ||
          jwsPayload.user_aegis_id !== passport.human_subject.user_aegis_id ||
          jwsPayload.agent_id !== passport.agent_subject.agent_id ||
          jwsPayload.delegation_id !== passport.delegation.delegation_id
        ) {
          signatureValid = false;
        }
      }

      const now = new Date();
      const expired = now >= new Date(passport.expires_at);
      const revoked = passport.status === "revoked";
      const active = passport.status === "active" && !expired && !revoked;
      const valid = hashValid && signatureValid && active;

      return reply.send({
        ok: true,
        data: {
          valid,
          hash_valid: hashValid,
          signature_valid: signatureValid,
          active,
          expired,
          revoked,
          passport_hash: verification.passport_hash,
          recomputed_hash: recomputedHash,
          jws_payload: jwsPayload ?? null,
          error: !valid
            ? !hashValid
              ? "HASH_MISMATCH"
              : !signatureValid
              ? jwsResult.error ?? "SIGNATURE_INVALID"
              : expired
              ? "EXPIRED"
              : revoked
              ? "REVOKED"
              : null
            : null,
        },
      });
    }
  );

  // ─── POST /api/delegation-passports/:passportId/revoke ───────────────────────

  server.post<{ Params: { passportId: string } }>(
    "/api/delegation-passports/:passportId/revoke",
    async (request, reply) => {
      const passport = delegationPassports.get(request.params.passportId);
      if (!passport) {
        return sendError(reply, 404, "NOT_FOUND", "Delegation passport not found.");
      }
      if (passport.human_subject.user_id !== MOCK_USER_ID) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied.");
      }
      if (passport.status === "revoked") {
        return sendError(reply, 409, "ALREADY_REVOKED", "Passport is already revoked.");
      }
      passport.status = "revoked";
      schedulePersist();
      return reply.send({ ok: true, data: { passport_id: passport.passport_id, status: "revoked" } });
    }
  );
}
