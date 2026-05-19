import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual, randomBytes } from "crypto";
import {
  aegisVaultPasses,
  credentialSessions,
  credentialFillRequests,
  encryptedSecretVault,
  MOCK_USER_ID,
  newId,
  type CredentialUseSession,
  type CredentialFillRequest,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getKmsProvider, type KmsContext } from "../lib/kms.js";
import { recordKmsAuditEvent } from "../lib/kmsAudit.js";

// Field-level credential delegation — extension-only surface.
// Two-layer protection: AEGIS_EXTENSION_SECRET (shared local secret) + per-request resolve_token (one-time).

const SESSION_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Warn at startup if extension secret is not configured.
if (!process.env.AEGIS_EXTENSION_SECRET) {
  console.warn(
    "[credential-sessions] AEGIS_EXTENSION_SECRET is not set — GET /api/credential-fill-requests " +
      "and POST /api/credential-fill-requests/:id/resolve-value are unauthenticated. " +
      "Set AEGIS_EXTENSION_SECRET in .env to enable Layer 1 protection."
  );
}

// Timing-safe equality that returns false on missing or length-mismatched inputs.
// Node's timingSafeEqual throws when buffer lengths differ — this guard prevents that.
function safeTokenEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function generateResolveToken(): string {
  return randomBytes(32).toString("hex"); // 64-char hex, 256 bits
}

// Layer 1 guard — must pass before any credential fill metadata or secret is returned.
// Reads process.env dynamically so tests can use vi.stubEnv without module reset.
function checkExtensionAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = process.env.AEGIS_EXTENSION_SECRET;
  if (!secret) return true; // not configured → allow (backward-compat; startup warning above)
  const presented = req.headers["x-aegis-extension-secret"];
  if (!safeTokenEquals(presented as string | undefined, secret)) {
    reply.status(401).send({
      ok: false,
      error: { code: "EXTENSION_AUTH_REQUIRED", message: "Missing or invalid X-Aegis-Extension-Secret header." },
    });
    return false;
  }
  return true;
}

function isSessionExpired(session: CredentialUseSession): boolean {
  if (!session.expires_at) return false;
  return new Date(session.expires_at) < new Date();
}

// Metadata view — never includes secret values, username that isn't already known, or secret_ref.
function sessionView(session: CredentialUseSession, pass_label?: string, pass_username?: string) {
  return {
    session_id: session.session_id,
    user_id: session.user_id,
    agent_id: session.agent_id,
    pass_id: session.pass_id,
    ...(pass_label !== undefined ? { pass_label } : {}),
    ...(pass_username !== undefined ? { pass_username } : {}),
    domain: session.domain,
    status: session.status,
    allowed_fields: session.allowed_fields,
    fields_filled: session.fields_filled,
    approved_at: session.approved_at,
    expires_at: session.expires_at,
    ...(session.target_url !== undefined ? { target_url: session.target_url } : {}),
    ...(session.url_match !== undefined ? { url_match: session.url_match } : {}),
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

export async function credentialSessionRoutes(server: FastifyInstance) {
  /**
   * POST /api/credential-sessions
   * Agent requests a new field-level credential session for a vault pass.
   * Creates a pending_approval session — user must approve before fills are allowed.
   */
  server.post<{
    Body: { pass_id: string; domain: string; allowed_fields?: Array<"username" | "password">; target_url?: string };
  }>("/api/credential-sessions", async (req, reply) => {
    const { pass_id, domain, allowed_fields = ["username", "password"], target_url } = req.body ?? {};

    if (!pass_id?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "pass_id is required." } });
    if (!domain?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "domain is required." } });

    const pass = aegisVaultPasses.get(pass_id);
    if (!pass || pass.user_id !== MOCK_USER_ID)
      return reply.status(404).send({ ok: false, error: { code: "PASS_NOT_FOUND", message: "Vault pass not found." } });
    if (pass.domain !== domain)
      return reply.status(400).send({ ok: false, error: { code: "DOMAIN_MISMATCH", message: `Pass domain "${pass.domain}" does not match requested domain "${domain}".` } });

    let url_match: CredentialUseSession["url_match"];
    if (target_url) {
      let parsed: URL;
      try {
        parsed = new URL(target_url);
      } catch {
        return reply.status(400).send({ ok: false, error: { code: "INVALID_TARGET_URL", message: "target_url is not a valid URL." } });
      }
      const portSuffix = parsed.port ? `:${parsed.port}` : "";
      const fullHostname = `${parsed.hostname}${portSuffix}`;
      if (parsed.hostname !== domain && fullHostname !== domain) {
        return reply.status(400).send({ ok: false, error: { code: "TARGET_URL_DOMAIN_MISMATCH", message: `target_url hostname "${parsed.hostname}" does not match session domain "${domain}".` } });
      }
      url_match = { hostname: parsed.hostname, ...(parsed.pathname !== "/" ? { path_prefix: parsed.pathname } : {}) };
    } else {
      url_match = { hostname: domain.split(":")[0] };
    }

    const validFields: Array<"username" | "password"> = ["username", "password"];
    const sanitizedFields = (allowed_fields ?? []).filter((f): f is "username" | "password" => validFields.includes(f));
    if (sanitizedFields.length === 0)
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "allowed_fields must include at least one of: username, password." } });

    if (sanitizedFields.includes("password") && !encryptedSecretVault.has(pass.secret_ref))
      return reply.status(400).send({ ok: false, error: { code: "SECRET_NOT_AVAILABLE", message: "Password is not available for this credential. Re-create the pass or check KMS configuration." } });

    const now = new Date().toISOString();
    const session: CredentialUseSession = {
      session_id: newId("credsess"),
      user_id: MOCK_USER_ID,
      pass_id,
      domain,
      status: "pending_approval",
      allowed_fields: sanitizedFields,
      fields_filled: [],
      ...(target_url ? { target_url } : {}),
      url_match,
      created_at: now,
      updated_at: now,
    };

    credentialSessions.set(session.session_id, session);
    schedulePersist();

    return reply.status(201).send({
      ok: true,
      data: {
        ...sessionView(session),
        approval_required: true,
        message: "Session is pending user approval. Direct the user to http://localhost:3000/route-run-approvals to approve.",
      },
    });
  });

  /**
   * GET /api/credential-sessions
   * List credential sessions for the current user. Optionally filter by status.
   * Includes pass_label and pass_username for display in the approval UI.
   * Never returns secret values or secret_ref.
   */
  server.get<{ Querystring: { status?: string } }>("/api/credential-sessions", async (req) => {
    const { status } = req.query;
    let all = Array.from(credentialSessions.values()).filter((s) => s.user_id === MOCK_USER_ID);
    if (status) all = all.filter((s) => s.status === status);
    const result = all
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((s) => {
        const pass = aegisVaultPasses.get(s.pass_id);
        return sessionView(s, pass?.label, pass?.username);
      });
    return { ok: true, data: result };
  });

  /**
   * GET /api/credential-sessions/:sessionId
   * Get metadata for a specific credential session.
   * Never returns secret values.
   */
  server.get<{ Params: { sessionId: string } }>("/api/credential-sessions/:sessionId", async (req, reply) => {
    const session = credentialSessions.get(req.params.sessionId);
    if (!session || session.user_id !== MOCK_USER_ID)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Credential session not found." } });

    const expired = isSessionExpired(session) && session.status === "active";
    if (expired) {
      const updated: CredentialUseSession = { ...session, status: "expired", updated_at: new Date().toISOString() };
      credentialSessions.set(session.session_id, updated);
      schedulePersist();
      return { ok: true, data: { ...sessionView(updated), terminal: true, next_action: "Session expired. Start a new credential session." } };
    }

    const terminal = ["completed", "failed", "expired"].includes(session.status);
    const next_action = terminal
      ? `Session ended with status "${session.status}".`
      : session.status === "pending_approval"
        ? "Awaiting user approval at http://localhost:3000/route-run-approvals."
        : "Session is active. Call fill_credential_field to request a field fill on the active tab.";

    return { ok: true, data: { ...sessionView(session), terminal, next_action } };
  });

  /**
   * POST /api/credential-sessions/:sessionId/approve
   * User approves a pending credential session. Activates it for 10 minutes.
   * Generates resolve_token for all pre-existing pending fill requests under this session.
   */
  server.post<{ Params: { sessionId: string } }>("/api/credential-sessions/:sessionId/approve", async (req, reply) => {
    const session = credentialSessions.get(req.params.sessionId);
    if (!session || session.user_id !== MOCK_USER_ID)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Credential session not found." } });
    if (session.status !== "pending_approval")
      return reply.status(400).send({ ok: false, error: { code: "INVALID_STATE", message: `Session is "${session.status}", not pending_approval.` } });

    const now = new Date();
    const expires_at = new Date(now.getTime() + SESSION_EXPIRY_MS).toISOString();
    const updated: CredentialUseSession = {
      ...session,
      status: "active",
      approved_at: now.toISOString(),
      expires_at,
      updated_at: now.toISOString(),
    };
    credentialSessions.set(session.session_id, updated);

    // Generate resolve tokens for any pending fill requests created before approval.
    for (const [id, fillReq] of credentialFillRequests.entries()) {
      if (fillReq.session_id === session.session_id && fillReq.status === "pending" && !fillReq.resolve_token) {
        credentialFillRequests.set(id, { ...fillReq, resolve_token: generateResolveToken() });
      }
    }

    schedulePersist();

    return { ok: true, data: sessionView(updated) };
  });

  /**
   * POST /api/credential-sessions/:sessionId/fill
   * Agent requests Antigen to fill a specific credential field on the active matching tab.
   * Creates a pending CredentialFillRequest; the extension picks it up and executes the fill.
   * Secrets are never returned to the agent — only the extension resolves and fills values.
   */
  server.post<{
    Params: { sessionId: string };
    Body: { field: "username" | "password" };
  }>("/api/credential-sessions/:sessionId/fill", async (req, reply) => {
    const { field } = req.body ?? {};
    const session = credentialSessions.get(req.params.sessionId);

    if (!session || session.user_id !== MOCK_USER_ID)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Credential session not found." } });
    if (session.status !== "active")
      return reply.status(400).send({ ok: false, error: { code: "INVALID_STATE", message: `Session is "${session.status}", not active.` } });
    if (isSessionExpired(session))
      return reply.status(400).send({ ok: false, error: { code: "SESSION_EXPIRED", message: "Credential session has expired. Start a new session." } });
    if (!field || !["username", "password"].includes(field))
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "field must be 'username' or 'password'." } });
    if (!session.allowed_fields.includes(field))
      return reply.status(400).send({ ok: false, error: { code: "FIELD_NOT_ALLOWED", message: `Field "${field}" is not in this session's allowed_fields.` } });

    // One in-flight fill per field at a time — prevents duplicate requests
    const inFlight = Array.from(credentialFillRequests.values()).find(
      (r) => r.session_id === session.session_id && r.field === field && (r.status === "pending" || r.status === "running")
    );
    if (inFlight)
      return reply.status(409).send({ ok: false, error: { code: "FILL_IN_PROGRESS", message: `A fill for field "${field}" is already in progress (${inFlight.request_id}).` } });

    const now = new Date().toISOString();
    const fillReq: CredentialFillRequest = {
      request_id: newId("filreq"),
      session_id: session.session_id,
      field,
      domain: session.domain,
      status: "pending",
      created_at: now,
      // Session is already active — generate resolve token immediately.
      // If session were still pending_approval (shouldn't reach here), token generated at approval.
      resolve_token: generateResolveToken(),
    };
    credentialFillRequests.set(fillReq.request_id, fillReq);
    schedulePersist();

    return reply.status(201).send({
      ok: true,
      data: {
        request_id: fillReq.request_id,
        session_id: fillReq.session_id,
        field: fillReq.field,
        status: fillReq.status,
        message: `Fill request created for "${field}". The Antigen extension will fill the field on the active ${session.domain} tab.`,
      },
    });
  });

  /**
   * GET /api/credential-fill-requests
   * Extension polls this to find pending fill requests for the current active tab domain.
   * Requires X-Aegis-Extension-Secret header (Layer 1).
   * Returns resolve_token for unconsumed requests — extension must present it to resolve-value.
   * Never returns credential values.
   */
  server.get<{ Querystring: { domain?: string; status?: string } }>("/api/credential-fill-requests", async (req, reply) => {
    if (!checkExtensionAuth(req, reply)) return;

    const { domain, status } = req.query;
    let requests = Array.from(credentialFillRequests.values());
    if (domain) requests = requests.filter((r) => r.domain === domain);
    if (status) requests = requests.filter((r) => r.status === status);
    // Only surface requests whose session is still active and not expired
    requests = requests.filter((r) => {
      const session = credentialSessions.get(r.session_id);
      return session && session.user_id === MOCK_USER_ID && session.status === "active" && !isSessionExpired(session);
    });
    const withContext = requests.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => {
      const session = credentialSessions.get(r.session_id);
      return {
        request_id: r.request_id,
        session_id: r.session_id,
        field: r.field,
        domain: r.domain,
        status: r.status,
        created_at: r.created_at,
        // Omit resolve_token once consumed — extension must poll for a fresh request on retry.
        resolve_token: r.resolve_token_used ? undefined : r.resolve_token,
        session_context: {
          target_url: session?.target_url,
          url_match: session?.url_match,
        },
      };
    });
    return { ok: true, data: withContext };
  });

  /**
   * POST /api/credential-fill-requests/:requestId/resolve-value
   * Extension calls this to get the actual credential value for field injection.
   *
   * Two-layer protection:
   *   Layer 1 — X-Aegis-Extension-Secret: shared local secret (AEGIS_EXTENSION_SECRET env var)
   *   Layer 2 — X-Aegis-Resolve-Token: per-request one-time token generated at session approval
   *
   * The token is consumed (nullified + resolve_token_used=true) before KMS decryption —
   * any subsequent call returns 409 RESOLVE_TOKEN_CONSUMED even if decryption failed.
   *
   * This endpoint MUST NOT be exposed to agents, MCP tools, logs, or any public surface.
   * The value field in the response must never be logged.
   */
  server.post<{ Params: { requestId: string } }>("/api/credential-fill-requests/:requestId/resolve-value", async (req, reply) => {
    // Layer 1: extension shared secret
    if (!checkExtensionAuth(req, reply)) return;

    const fillReq = credentialFillRequests.get(req.params.requestId);
    if (!fillReq)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Fill request not found." } });
    if (fillReq.status !== "pending" && fillReq.status !== "running")
      return reply.status(400).send({ ok: false, error: { code: "INVALID_STATE", message: `Fill request is "${fillReq.status}", not pending or running.` } });

    const session = credentialSessions.get(fillReq.session_id);
    if (!session || session.user_id !== MOCK_USER_ID)
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Associated credential session not found." } });
    if (session.status !== "active")
      return reply.status(400).send({ ok: false, error: { code: "SESSION_NOT_ACTIVE", message: `Session is "${session.status}", not active.` } });
    if (isSessionExpired(session)) {
      const expired: CredentialUseSession = { ...session, status: "expired", updated_at: new Date().toISOString() };
      credentialSessions.set(session.session_id, expired);
      schedulePersist();
      return reply.status(400).send({ ok: false, error: { code: "SESSION_EXPIRED", message: "Credential session has expired." } });
    }

    // Layer 2: one-time resolve token
    const presentedToken = req.headers["x-aegis-resolve-token"] as string | undefined;
    if (!presentedToken) {
      return reply.status(401).send({ ok: false, error: { code: "RESOLVE_TOKEN_REQUIRED", message: "Missing X-Aegis-Resolve-Token header." } });
    }
    // Check consumed before checking existence — token is nullified after first use, so
    // replay must return 409 (not 403) even when resolve_token field is now undefined.
    if (fillReq.resolve_token_used) {
      return reply.status(409).send({ ok: false, error: { code: "RESOLVE_TOKEN_CONSUMED", message: "This fill request has already been resolved. Create a new fill request to retry." } });
    }
    if (!fillReq.resolve_token) {
      return reply.status(403).send({ ok: false, error: { code: "NO_RESOLVE_TOKEN", message: "Fill request has no resolve token. Session may not yet be approved." } });
    }
    if (!safeTokenEquals(presentedToken, fillReq.resolve_token)) {
      return reply.status(403).send({ ok: false, error: { code: "INVALID_RESOLVE_TOKEN", message: "Invalid resolve token." } });
    }

    const pass = aegisVaultPasses.get(session.pass_id);
    if (!pass)
      return reply.status(404).send({ ok: false, error: { code: "PASS_NOT_FOUND", message: "Vault pass not found." } });

    // Consume the token before decryption — fail closed if decrypt throws.
    // resolve_token is nullified so it cannot be presented again even in error recovery.
    credentialFillRequests.set(fillReq.request_id, {
      ...fillReq,
      status: "running",
      resolve_token: undefined,
      resolve_token_used: true,
    });
    schedulePersist();

    let value: string;
    if (fillReq.field === "username") {
      if (!pass.username)
        return reply.status(400).send({ ok: false, error: { code: "NO_USERNAME", message: "This pass has no username." } });
      value = pass.username;
    } else {
      const blob = encryptedSecretVault.get(pass.secret_ref);
      if (!blob)
        return reply.status(400).send({ ok: false, error: { code: "SECRET_NOT_AVAILABLE", message: "Password not available. Re-create the pass or check KMS configuration." } });
      try {
        const kms = getKmsProvider();
        const kmsContext: KmsContext = {
          user_id: pass.user_id,
          pass_id: pass.pass_id,
          domain: pass.domain,
          purpose: "login_password",
        };
        value = await kms.decryptSecret(blob, kmsContext);
        recordKmsAuditEvent({
          operation: "resolve_secret_for_runtime",
          provider: kms.provider,
          user_id: pass.user_id,
          pass_id: pass.pass_id,
          domain: pass.domain,
          success: true,
        });
      } catch {
        recordKmsAuditEvent({
          operation: "resolve_secret_for_runtime",
          provider: getKmsProvider().provider,
          user_id: pass.user_id,
          pass_id: pass.pass_id,
          domain: pass.domain,
          success: false,
          error_code: "DECRYPT_FAILED",
        });
        console.error("[credential-sessions] Decrypt failed for pass", pass.pass_id);
        return reply.status(500).send({ ok: false, error: { code: "SECRET_DECRYPT_FAILED", message: "Failed to decrypt credential." } });
      }
    }

    // Value is returned only to the extension — never logged, never forwarded to agents.
    return {
      ok: true,
      data: {
        value,
        field: fillReq.field,
        pass_id: pass.pass_id,
        redacted: fillReq.field === "password",
      },
    };
  });

  /**
   * POST /api/credential-fill-requests/:requestId/complete
   * Extension marks a fill as completed and appends the field to session.fields_filled.
   */
  server.post<{
    Params: { requestId: string };
    Body: { tab_url?: string };
  }>("/api/credential-fill-requests/:requestId/complete", async (req, reply) => {
    const fillReq = credentialFillRequests.get(req.params.requestId);
    if (!fillReq)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Fill request not found." } });
    if (fillReq.status !== "pending" && fillReq.status !== "running")
      return reply.status(400).send({ ok: false, error: { code: "INVALID_STATE", message: `Fill request is already "${fillReq.status}".` } });

    const now = new Date().toISOString();
    const completed: CredentialFillRequest = { ...fillReq, status: "completed", completed_at: now };
    credentialFillRequests.set(fillReq.request_id, completed);

    const session = credentialSessions.get(fillReq.session_id);
    if (session) {
      const entry: { field: "username" | "password"; filled_at: string; tab_url?: string } = {
        field: fillReq.field,
        filled_at: now,
      };
      if (req.body?.tab_url) entry.tab_url = req.body.tab_url;

      const fields_filled = [...session.fields_filled, entry];
      const filledFieldNames = new Set(fields_filled.map((f) => f.field));
      const allFilled = session.allowed_fields.every((f) => filledFieldNames.has(f));
      const updatedSession: CredentialUseSession = {
        ...session,
        fields_filled,
        status: allFilled ? "completed" : session.status,
        updated_at: now,
      };
      credentialSessions.set(session.session_id, updatedSession);
    }
    schedulePersist();

    return { ok: true, data: completed };
  });

  /**
   * POST /api/credential-fill-requests/:requestId/fail
   * Extension marks a fill request as failed.
   */
  server.post<{
    Params: { requestId: string };
    Body: { error?: string };
  }>("/api/credential-fill-requests/:requestId/fail", async (req, reply) => {
    const fillReq = credentialFillRequests.get(req.params.requestId);
    if (!fillReq)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Fill request not found." } });
    if (fillReq.status !== "pending" && fillReq.status !== "running")
      return reply.status(400).send({ ok: false, error: { code: "INVALID_STATE", message: `Fill request is already "${fillReq.status}".` } });

    const now = new Date().toISOString();
    const failed: CredentialFillRequest = {
      ...fillReq,
      status: "failed",
      completed_at: now,
      error: req.body?.error,
    };
    credentialFillRequests.set(fillReq.request_id, failed);
    schedulePersist();

    return { ok: true, data: failed };
  });
}
