import { randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import type { AccountCreationRequest, AccountCreationApproval, ProfileFieldFillRequest, ProfileFieldKind } from "@aegis/types";
import {
  accountCreationRequests,
  accountCreationStepRequests,
  aegisVaultPasses,
  privateProfileMemory,
  profileFieldFillRequests,
  encryptedSecretVault,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { createAndStoreVaultPass } from "./vault-passes.js";
import { getKmsProvider } from "../lib/kms.js";

function safeView(r: AccountCreationRequest) {
  const hasDefaultEmail = Array.from(privateProfileMemory.values())
    .some(m => m.user_id === MOCK_USER_ID && m.field_kind === "account_creation_email");
  return {
    request_id: r.request_id,
    domain: r.domain,
    signup_url: r.signup_url,
    reason: r.reason,
    wall_type: r.wall_type,
    status: r.status,
    raw_password_revealed_to_agent: false as const,
    otp_revealed_to_agent: false as const,
    // email_strategy is safe to show; email_used (the resolved value) is never stored or returned
    email_strategy: r.policy?.email_strategy,
    password_strategy: r.policy?.password_strategy,
    has_default_account_email: hasDefaultEmail,
    created_at: r.created_at,
    expires_at: r.expires_at,
    approved_at: r.approved_at,
    completed_at: r.completed_at,
    denied_at: r.denied_at,
    error: r.error,
    // vault_pass_id intentionally omitted — internal only
  };
}

function safeStepView(step: import("@aegis/types").AccountCreationStepRequest) {
  return {
    step_request_id: step.step_request_id,
    account_creation_request_id: step.account_creation_request_id,
    domain: step.domain,
    page_url: step.page_url,
    requested_fields: step.requested_fields,
    status: step.status,
    created_at: step.created_at,
    expires_at: step.expires_at,
    resolved_at: step.resolved_at,
    error: step.error,
    raw_email_revealed_to_agent: false as const,
    raw_username_revealed_to_agent: false as const,
    raw_password_revealed_to_agent: false as const,
    otp_revealed_to_agent: false as const,
    // profile_fill_request_id and pass_id exposed only after resolution
    ...(step.status === "resolved" && step.profile_fill_request_id
      ? { profile_fill_request_id: step.profile_fill_request_id }
      : {}),
    ...(step.status === "resolved" && step.pass_id
      ? { pass_id: step.pass_id }
      : {}),
    ...(step.email_verification_request_id
      ? { email_verification_request_id: step.email_verification_request_id }
      : {}),
  };
}

export async function accountCreationRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/internal/account-creation-requests
  // Returns pending account creation requests for the Antigen approval UI.
  server.get("/api/internal/account-creation-requests", async (req, reply) => {
    const { status } = req.query as { status?: string };
    const now = new Date();

    // Lazy expiry: mark pending_user requests that have passed their TTL.
    for (const r of accountCreationRequests.values()) {
      if (r.user_id === MOCK_USER_ID && r.status === "pending_user" && new Date(r.expires_at) <= now) {
        r.status = "expired";
        accountCreationRequests.set(r.request_id, r);
      }
    }

    let items = Array.from(accountCreationRequests.values())
      .filter(r => r.user_id === MOCK_USER_ID);
    if (status) items = items.filter(r => r.status === status);

    return reply.send({ ok: true, data: items.map(safeView) });
  });

  // POST /api/internal/account-creation-requests/:id/approve
  // User approves account creation. Antigen generates a password and stores it in the vault.
  // The raw generated password is never returned in any response.
  server.post("/api/internal/account-creation-requests/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as AccountCreationApproval | undefined;

    const r = accountCreationRequests.get(id);
    if (!r || r.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Account creation request not found." } });
    }
    if (r.status !== "pending_user") {
      return reply.status(409).send({ ok: false, error: { code: "REQUEST_NOT_PENDING", message: `Request status is '${r.status}'; cannot approve.` } });
    }
    if (new Date(r.expires_at) <= new Date()) {
      r.status = "expired";
      accountCreationRequests.set(id, r);
      schedulePersist();
      return reply.status(410).send({ ok: false, error: { code: "REQUEST_EXPIRED", message: "Account creation request has expired." } });
    }

    const emailStrategy = body?.email_strategy ?? "primary_email";
    const passwordStrategy = body?.password_strategy ?? "aegis_generated";

    // Resolve account email — stays server-side only, never returned in any response.
    // Resolution order:
    //   1. Inline email provided by user in this approval request
    //   2. Saved account_creation_email preference
    //   3. Generic email profile field (legacy fallback)
    //   4. None found → 422 ACCOUNT_EMAIL_REQUIRED
    let emailUsed = "";
    if (emailStrategy === "primary_email") {
      const inlineEmail = typeof body?.email === "string" ? body.email.trim() : "";
      if (inlineEmail) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inlineEmail)) {
          return reply.status(422).send({
            ok: false,
            error: { code: "INVALID_EMAIL_FORMAT", message: "The provided email address is not valid." },
          });
        }
        emailUsed = inlineEmail;
      } else {
        // Try account_creation_email preference first, then generic email.
        const emailMemory =
          Array.from(privateProfileMemory.values()).find(
            m => m.user_id === MOCK_USER_ID && m.field_kind === "account_creation_email",
          ) ??
          Array.from(privateProfileMemory.values()).find(
            m => m.user_id === MOCK_USER_ID && m.field_kind === "email",
          );

        if (!emailMemory) {
          return reply.status(422).send({
            ok: false,
            error: {
              code: "ACCOUNT_EMAIL_REQUIRED",
              message: "No account email is saved. Provide an email to continue.",
            },
          });
        }

        const blob = encryptedSecretVault.get(emailMemory.memory_id);
        if (!blob) {
          return reply.status(422).send({
            ok: false,
            error: { code: "ACCOUNT_EMAIL_DECRYPT_FAILED", message: "Antigen found an account email but could not read it. Re-enter your email to replace it." },
          });
        }
        try {
          const kms = getKmsProvider();
          emailUsed = await kms.decryptSecret(blob, {
            user_id: MOCK_USER_ID,
            pass_id: emailMemory.memory_id,
            domain: emailMemory.provenance.domain_at_creation, // use stored provenance, not hardcoded
            purpose: "profile_field",
          });
        } catch {
          return reply.status(422).send({
            ok: false,
            error: {
              code: "ACCOUNT_EMAIL_DECRYPT_FAILED",
              message: "Antigen found an account email but could not decrypt it. Re-enter your email to replace it.",
            },
          });
        }
      }

      // Persist as account_creation_email preference if user requested.
      if (body?.save_as_default_account_email && emailUsed) {
        try {
          const kms = getKmsProvider();
          const existing = Array.from(privateProfileMemory.values()).find(
            m => m.user_id === MOCK_USER_ID && m.field_kind === "account_creation_email",
          );
          const memoryId = existing?.memory_id ?? newId("ppm");
          const blob = await kms.encryptSecret(emailUsed, {
            user_id: MOCK_USER_ID,
            pass_id: memoryId,
            domain: "aegis.preferences", // fixed sentinel for user preferences
            purpose: "profile_field",
          });
          encryptedSecretVault.set(memoryId, blob);
          const now = new Date().toISOString();
          if (!existing) {
            privateProfileMemory.set(memoryId, {
              memory_id: memoryId,
              user_id: MOCK_USER_ID,
              field_kind: "account_creation_email",
              value_ref: `ppvault://${memoryId}/value`,
              data_class: 2,
              sensitivity: "private",
              default_disclosure_mode: "fill_only",
              agent_visible_allowed: false,
              provenance: { source: "user_provided", domain_at_creation: "aegis.preferences" },
              created_at: now,
              updated_at: now,
              user_editable: true,
              uses: [],
            });
          } else {
            existing.updated_at = now;
            privateProfileMemory.set(memoryId, existing);
          }
        } catch {
          // Non-fatal: preference save failure does not block credential creation.
          console.error("[account-creation] Failed to save account_creation_email preference.");
        }
      }
    }

    // Generate a strong random password only after email is resolved.
    // 32 bytes of entropy → base64url → first 24 chars (~143 bits).
    // This value is used only to call createAndStoreVaultPass and is never stored elsewhere.
    const generatedPassword = randomBytes(32).toString("base64url").slice(0, 24);

    r.status = "approved";
    r.approved_at = new Date().toISOString();
    r.policy = {
      email_strategy: emailStrategy,
      password_strategy: passwordStrategy,
      raw_password_revealed_to_agent: false,
      otp_revealed_to_agent: false,
      save_to_vault: true,
    };
    accountCreationRequests.set(id, r);

    // Store credential in vault. createAndStoreVaultPass handles KMS encryption and audit events.
    const result = await createAndStoreVaultPass({
      label: `${r.domain} (auto-created)`,
      kind: "login_password",
      domain: r.domain,
      username: emailUsed,
      password: generatedPassword,
    });

    // generatedPassword is no longer needed — let GC reclaim it.
    if (!result.ok) {
      r.status = "failed";
      r.error = result.error;
      accountCreationRequests.set(id, r);
      schedulePersist();
      return reply.status(500).send({ ok: false, error: { code: "VAULT_STORE_ERROR", message: "Failed to store generated credential in vault." } });
    }

    // Store vault_pass_id internally only — never returned in responses.
    r.vault_pass_id = result.pass.pass_id;
    r.status = "credential_generated";
    accountCreationRequests.set(id, r);
    schedulePersist();

    // TODO(v2): Create a signed UserApprovalReceipt for account creation decisions.
    // For now, the approved_at and vault_pass_id fields on the request provide an
    // auditable record for the demo.

    return reply.send({ ok: true, data: safeView(r) });
  });

  // POST /api/internal/account-creation-requests/:id/deny
  server.post("/api/internal/account-creation-requests/:id/deny", async (req, reply) => {
    const { id } = req.params as { id: string };

    const r = accountCreationRequests.get(id);
    if (!r || r.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Account creation request not found." } });
    }
    if (r.status !== "pending_user") {
      return reply.status(409).send({ ok: false, error: { code: "REQUEST_NOT_PENDING", message: `Request status is '${r.status}'; cannot deny.` } });
    }

    r.status = "denied";
    r.denied_at = new Date().toISOString();
    accountCreationRequests.set(id, r);
    schedulePersist();

    return reply.send({ ok: true, data: safeView(r) });
  });

  // GET /api/internal/account-creation-requests/:id
  // Used by the UI to check request state after approve/deny.
  server.get("/api/internal/account-creation-requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = accountCreationRequests.get(id);
    if (!r || r.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Account creation request not found." } });
    }
    return reply.send({ ok: true, data: safeView(r) });
  });

  // GET /api/internal/account-creation-step-requests
  // Returns step requests for display in the Antigen approval UI.
  // Optional ?account_creation_request_id= to filter by parent request.
  server.get("/api/internal/account-creation-step-requests", async (req, reply) => {
    const { account_creation_request_id } = req.query as { account_creation_request_id?: string };
    const now = new Date();

    const results = [];
    for (const step of accountCreationStepRequests.values()) {
      if (step.user_id !== MOCK_USER_ID) continue;
      if (account_creation_request_id && step.account_creation_request_id !== account_creation_request_id) continue;

      // Lazy expiry for pending_user steps
      if (step.status === "pending_user" && new Date(step.expires_at) <= now) {
        step.status = "failed";
        step.error = "STEP_EXPIRED";
        accountCreationStepRequests.set(step.step_request_id, step);
      }

      results.push(safeStepView(step));
    }

    return reply.send({ ok: true, data: results });
  });

  // POST /api/internal/account-creation-step-requests/:id/submit-email
  // User provides an email address when the account_email step returned pending_user.
  server.post("/api/internal/account-creation-step-requests/:id/submit-email", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { email, save_as_default } = req.body as { email?: string; save_as_default?: boolean };

    if (!email || typeof email !== "string" || !email.includes("@") || !email.includes(".")) {
      return reply.status(422).send({ ok: false, error: { code: "INVALID_EMAIL_FORMAT", message: "A valid email address is required." } });
    }

    const step = accountCreationStepRequests.get(id);
    if (!step || step.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Step request not found." } });
    }
    if (step.status !== "pending_user") {
      return reply.status(409).send({ ok: false, error: { code: "STEP_NOT_PENDING", message: `Step status is '${step.status}'; only pending_user steps can be submitted.` } });
    }
    if (new Date(step.expires_at) <= new Date()) {
      step.status = "failed";
      step.error = "STEP_EXPIRED";
      accountCreationStepRequests.set(id, step);
      schedulePersist();
      return reply.status(410).send({ ok: false, error: { code: "STEP_EXPIRED", message: "Step request has expired." } });
    }

    // Optionally save email as account_creation_email preference (same path as approve endpoint)
    if (save_as_default) {
      try {
        const kms = getKmsProvider();
        const memId = newId("ppm");
        const blob = await kms.encryptSecret(email, {
          user_id: MOCK_USER_ID,
          pass_id: memId,
          domain: "aegis.preferences",
          purpose: "profile_field",
        });
        encryptedSecretVault.set(memId, blob);
        privateProfileMemory.set(memId, {
          memory_id: memId,
          user_id: MOCK_USER_ID,
          field_kind: "account_creation_email",
          value_ref: `ppvault://${memId}/value`,
          data_class: 2,
          sensitivity: "private",
          default_disclosure_mode: "fill_only",
          agent_visible_allowed: false,
          provenance: { source: "user_provided", domain_at_creation: "aegis.preferences" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          user_editable: true,
          uses: [],
        });
      } catch {
        // Non-fatal — proceed without saving preference
      }
    }

    // Create a ProfileFieldFillRequest so the agent can fill the email field via CDP
    const fillRequestId = newId("pffr");
    const pffr: ProfileFieldFillRequest = {
      fill_request_id: fillRequestId,
      user_id: MOCK_USER_ID,
      delegation_id: step.delegation_id,
      domain: step.domain,
      page_url: step.page_url,
      requested_fields: [{
        key: "account_creation_email" as ProfileFieldKind,
        reason: "Account creation email field fill (user-provided)",
      }],
      reason: "Account creation email provided by user",
      status: "pending",
      raw_profile_value_revealed_to_agent: false,
      raw_profile_values_revealed_to_agent: false,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    profileFieldFillRequests.set(fillRequestId, pffr);

    step.status = "resolved";
    step.profile_fill_request_id = fillRequestId;
    step.resolved_at = new Date().toISOString();
    accountCreationStepRequests.set(id, step);
    schedulePersist();

    return reply.send({ ok: true, data: { ...safeStepView(step), profile_fill_request_id: fillRequestId } });
  });
}

// Expose normalized domain helper for agent-api.ts reuse.
export function normalizeAccountDomain(raw: string): string {
  try {
    const withProto = raw.startsWith("http") ? raw : `https://${raw}`;
    return new URL(withProto).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw.toLowerCase().trim();
  }
}

// Build the next_action guidance string for a given status.
export function accountCreationNextAction(status: string): string {
  switch (status) {
    case "pending_user":
      return "Waiting for user approval in Antigen UI at /route-run-approvals. Tell the user to approve the account creation request. Poll get_account_access_resolution in a few seconds.";
    case "approved":
      return "User approved. Antigen is generating and storing the credential. Poll again shortly.";
    case "credential_generated":
      return "Credential created and stored in vault. Navigate to the signup form. Call request_secret_field_injection with the pass_id for the email and password fields. Do not type credentials directly — Antigen injects via CDP.";
    case "completed":
      return "Account creation completed. Credential is saved in vault for future logins. For subsequent logins, call request_account_access_resolution; if the response is credential_available, observe the page first and choose the appropriate handoff.";
    case "denied":
      return "User denied account creation. Do not retry without explicit user direction.";
    case "expired":
      return "Request expired (10-minute TTL). Call request_account_access_resolution again to start a new request.";
    case "failed":
      return "Credential generation failed. Do not proceed. Check error field for details.";
    default:
      return "Unknown status.";
  }
}

// Return vault pass_id only for safe terminal/ready statuses.
export function accountCreationPassIdForAgent(r: AccountCreationRequest): string | undefined {
  if (r.status === "credential_generated" || r.status === "completed") {
    return r.vault_pass_id;
  }
  return undefined;
}
