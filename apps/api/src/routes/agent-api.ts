import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type {
  AgentDelegation,
  DelegationTrustTaskCategory,
  ExternalAgentIdentity,
  ExternalAgentSkillSummary,
  ExternalAgentRunSummary,
  RouteRun,
  RouteRunReceipt,
  AegisExecutionSurface,
  RuntimeCoverageSummary,
  RuntimeObservationModeState,
  AuthenticatedSessionLoginRequest,
  SecretFieldInjection,
  SecretFieldInjectionStatus,
  CredentialUseAuthorization,
  SecurityChallenge,
  SecurityChallengeType,
  SecurityChallengeStatus,
  ChallengeEmailResolution,
  ChallengeEmailResolutionStatus,
  WorkspaceArtifactKind,
} from "@aegis/types";
import {
  createAuthenticatedSession,
  getAuthenticatedSessionHandle,
  observeAuthenticatedSession,
  navigateAuthenticatedSession,
} from "../runtime/authenticatedSessions.js";
import { executeSecretInjectionViaCDP } from "../runtime/secretInjection.js";
import {
  agentDelegations,
  skills,
  installedSkills,
  routes,
  routeRuns,
  collars,
  aegisVaultPasses,
  secretFieldInjections,
  credentialUseAuthorizations,
  securityChallenges,
  challengeEmailResolutions,
  aegisWorkspaces,
  workspaceTasks,
  workspaceArtifacts,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { requireWorkspaceAccess, checkWorkspacePermission, emitWorkspaceAudit, buildEffectivePermissionsMap, checkTaskEligibility } from "../lib/workspaceDomain.js";
import { challengeCodes, executeChallengeInjectionViaCDP } from "../runtime/challengeInjection.js";
import { resolutionCodes, searchGmailForChallengeCode, isEmailChallengeSupported } from "../runtime/emailChallengeResolver.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";
import { getKmsProvider } from "../lib/kms.js";
import { recordKmsAuditEvent } from "../lib/kmsAudit.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { schedulePersist } from "../store/persistence.js";
import { computeWebsiteAgentSafetyProfile } from "./website-agent-safety.js";
import { getWebsiteAegisPolicyForDomain } from "./website-aegis-policy.js";
import { runObservationDryRun } from "../runtime/observationDryRun.js";

const ALLOWED_DOMAINS = new Set(["en.wikipedia.org", "localhost", "test.aegis.local"]);

const VALID_TASK_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "login",
  "credential_fill",
  "purchase",
  "payment",
  "travel_booking",
  "financial_action",
  "identity_disclosure",
  "account_change",
  "destructive_action",
  "message_send",
]);

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: string) {
  return reply.status(status).send({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

/** Validates Bearer token and returns the matched AgentDelegation, or writes a 401 and returns null. */
async function requireAgentToken(req: FastifyRequest, reply: FastifyReply): Promise<AgentDelegation | null> {
  const authHeader = (req.headers["authorization"] as string | undefined) ?? "";
  const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
  const token = bearerMatch?.[1]?.trim();

  if (!token) {
    sendError(reply, 401, "AUTH_REQUIRED", "Authorization: Bearer <token> is required.");
    return null;
  }

  const delegation = Array.from(agentDelegations.values()).find(
    (d) => d.user_id === MOCK_USER_ID && d.status === "active" && d.token_id === token
  );

  if (!delegation) {
    sendError(reply, 401, "INVALID_TOKEN", "Token does not match an active delegation.");
    return null;
  }

  return delegation;
}

function filterBySkillAccessPolicy(skillIds: string[], delegation: AgentDelegation): string[] {
  const mode = delegation.skill_access_mode ?? "all";
  const ids = delegation.skill_access_skill_ids ?? [];
  if (mode === "only") return skillIds.filter((id) => ids.includes(id));
  if (mode === "exclude") return skillIds.filter((id) => !ids.includes(id));
  return skillIds;
}

function buildRunSummary(run: RouteRun, receiptIds: string[]): ExternalAgentRunSummary {
  return {
    run_id: run.run_id,
    skill_id: run.skill_id,
    route_id: run.route_id,
    status: run.status,
    approval_required: run.status === "pending_approval" || (run.approval_required_permissions?.length ?? 0) > 0,
    ...(run.approval_required_permissions?.length ? { approval_required_permissions: run.approval_required_permissions } : {}),
    created_at: run.created_at,
    ...(run.completed_at ? { completed_at: run.completed_at } : {}),
    ...(run.error ? { error: run.error } : {}),
    receipt_ids: receiptIds,
  };
}

interface SafeReceiptSummary {
  receipt_id: string;
  run_id: string;
  skill_name: string;
  route_name: string;
  domain: string;
  status: "completed" | "failed";
  execution_surface: AegisExecutionSurface;
  created_at: string;
  completed_at?: string;
  error?: string;
  credential_used?: boolean;
  secret_values_revealed_to_agent: false | undefined;
  authorization_context?: {
    authorization_id: string;
    authorization_hash: string;
  };
  runtime_coverage_summary?: RuntimeCoverageSummary;
  capability_release_summary?: {
    releases_created: number;
    login_credential_releases: number;
    payment_method_releases: number;
    identity_profile_releases: number;
    raw_secret_revealed_to_agent: false;
  };
  observation_mode_summary?: RuntimeObservationModeState;
  jws_present: boolean;
}

function toSafeReceiptSummary(r: RouteRunReceipt): SafeReceiptSummary {
  return {
    receipt_id: r.receipt_id,
    run_id: r.run_id,
    skill_name: r.skill_name,
    route_name: r.route_name,
    domain: r.domain,
    status: r.status,
    execution_surface: r.execution_surface,
    created_at: r.created_at,
    ...(r.completed_at ? { completed_at: r.completed_at } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.credential_used !== undefined ? { credential_used: r.credential_used } : {}),
    secret_values_revealed_to_agent: r.secret_values_revealed_to_agent,
    ...(r.authorization_context
      ? {
          authorization_context: {
            authorization_id: r.authorization_context.authorization_id,
            authorization_hash: r.authorization_context.authorization_hash,
          },
        }
      : {}),
    ...(r.runtime_coverage_summary ? { runtime_coverage_summary: r.runtime_coverage_summary } : {}),
    ...(r.capability_release_summary ? { capability_release_summary: r.capability_release_summary } : {}),
    ...(r.observation_mode_summary ? { observation_mode_summary: r.observation_mode_summary } : {}),
    jws_present: false, // JWS is stored in Supabase row metadata; not available in in-memory path
  };
}

export async function agentApiRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/agent/v1/me
   * Returns the token-scoped identity of the calling agent.
   */
  server.get("/api/agent/v1/me", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const mode = delegation.skill_access_mode ?? "all";
    const ids = delegation.skill_access_skill_ids ?? [];

    const identity: ExternalAgentIdentity = {
      agent_id: delegation.agent_name,
      agent_name: delegation.agent_name,
      ...(delegation.agent_platform ? { agent_platform: delegation.agent_platform } : {}),
      delegation_id: delegation.id,
      user_aegis_id: delegation.user_aegis_id,
      ...(delegation.default_collar_id ? { default_collar_id: delegation.default_collar_id } : {}),
      delegation_status: delegation.status,
      token_scope: {
        skill_access_mode: mode,
        ...(mode === "only" ? { allowed_skill_ids: ids } : {}),
        ...(mode === "exclude" ? { excluded_skill_ids: ids } : {}),
      },
    };

    return reply.send({ ok: true, data: identity });
  });

  /**
   * GET /api/agent/v1/skills
   * Lists installed skills visible to this delegation's skill access policy.
   */
  server.get("/api/agent/v1/skills", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const userInstalled = Array.from(installedSkills.values()).filter(
      (i) => i.user_id === MOCK_USER_ID && i.enabled
    );

    const visibleSkillIds = filterBySkillAccessPolicy(
      userInstalled.map((i) => i.skill_id),
      delegation
    );

    const result: ExternalAgentSkillSummary[] = visibleSkillIds
      .map((skillId) => skills.get(skillId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({
        skill_id: s.skill_id,
        name: s.name,
        summary: s.summary,
        domain: s.domain,
        required_permissions: s.required_permissions,
        ...(s.risk_level ? { risk_level: s.risk_level } : {}),
        ...(s.trust_tier ? { trust_tier: s.trust_tier } : {}),
        ...(s.execution_mode ? { execution_mode: s.execution_mode } : {}),
        ...(s.sensitivity_level ? { sensitivity_level: s.sensitivity_level } : {}),
      }));

    return reply.send({ ok: true, data: result });
  });

  /**
   * POST /api/agent/v1/runs
   * Requests execution of an installed skill under this delegation.
   */
  server.post<{ Body: { skill_id?: string; variables?: Record<string, string> } }>(
    "/api/agent/v1/runs",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { skill_id: skillId, variables } = req.body ?? {};

      if (!skillId) {
        return sendError(reply, 400, "MISSING_SKILL_ID", "skill_id is required.");
      }

      const skill = skills.get(skillId);
      if (!skill) return sendError(reply, 404, "SKILL_NOT_FOUND", "Skill not found.");

      const installedSkill = Array.from(installedSkills.values()).find(
        (i) => i.skill_id === skillId && i.user_id === MOCK_USER_ID && i.enabled
      );
      if (!installedSkill) {
        return sendError(reply, 403, "SKILL_NOT_INSTALLED", "Skill is not installed or is disabled for this user.");
      }

      // Apply skill access policy
      const mode = delegation.skill_access_mode ?? "all";
      const ids = delegation.skill_access_skill_ids ?? [];
      if (mode === "exclude" && ids.includes(skillId)) {
        return sendError(reply, 403, "SKILL_ACCESS_DENIED", "This delegation does not allow this skill.");
      }
      if (mode === "only" && !ids.includes(skillId)) {
        return sendError(reply, 403, "SKILL_ACCESS_DENIED", "This delegation does not allow this skill.");
      }

      const route = routes.get(skill.route_id);
      if (!route) {
        return sendError(reply, 500, "ROUTE_NOT_FOUND", "Underlying route not found for this skill.");
      }

      if (!ALLOWED_DOMAINS.has(skill.domain)) {
        return sendError(
          reply,
          400,
          "DOMAIN_NOT_SUPPORTED",
          `Runs are not supported for domain "${skill.domain}".`
        );
      }

      // Check required variables
      if (route.variables && route.variables.length > 0) {
        const internalValuePolicyTypes = new Set(["pass_field", "secret_ref", "safe_literal"]);
        const missingRequired: string[] = [];
        for (const v of route.variables) {
          const hasDefault = v.default_value !== undefined && v.default_value !== "";
          const supplied = variables && v.name in variables;
          const boundStep = route.steps.find((s) => s.step_id === v.step_id);
          const isInternallyResolved =
            boundStep?.value_policy && internalValuePolicyTypes.has(boundStep.value_policy.type);
          if (!hasDefault && !supplied && !isInternallyResolved) {
            missingRequired.push(v.name);
          }
        }
        if (missingRequired.length > 0) {
          return sendError(reply, 400, "MISSING_VARIABLES", `Required variables not supplied: ${missingRequired.join(", ")}.`);
        }
      }

      const agent_id = delegation.agent_name;
      const delegation_id = delegation.id;
      const collar_id = delegation.default_collar_id;

      // Collar enforcement
      if (collar_id) {
        const collar = collars.get(collar_id);
        if (collar && collar.status === "active") {
          const needsApproval: string[] = [];
          const hardBlocked: string[] = [];

          for (const perm of route.required_permissions) {
            if (collar.blocked_actions.includes(perm as any)) {
              hardBlocked.push(perm);
            } else if (
              !collar.allowed_actions.includes(perm as any) &&
              !collar.approval_required_actions.includes(perm as any)
            ) {
              hardBlocked.push(perm);
            } else if (collar.approval_required_actions.includes(perm as any)) {
              needsApproval.push(perm);
            }
          }

          if (hardBlocked.length > 0) {
            return sendError(
              reply,
              403,
              "COLLAR_BLOCKED",
              "This delegation's collar does not allow this route.",
              `Blocked permission(s): ${hardBlocked.join(", ")}.`
            );
          }

          if (needsApproval.length > 0) {
            const run: RouteRun = {
              run_id: newId("run"),
              skill_id: skill.skill_id,
              route_id: route.route_id,
              installed_skill_id: installedSkill.installed_skill_id,
              user_id: MOCK_USER_ID,
              domain: skill.domain,
              status: "pending_approval",
              approval_required_permissions: needsApproval,
              created_at: new Date().toISOString(),
              ...(agent_id ? { agent_id } : {}),
              ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
              ...(delegation_id ? { delegation_id } : {}),
              ...(collar_id ? { collar_id } : {}),
            };
            routeRuns.set(run.run_id, run);
            schedulePersist();
            return reply.send({
              ok: true,
              data: {
                run: buildRunSummary(run, []),
                approval_required: true,
                next_action: "wait_for_user_approval",
                message: `Approval required for: ${needsApproval.join(", ")}. Approve at /route-run-approvals in the Aegis UI.`,
              },
            });
          }
        }
      }

      const run: RouteRun = {
        run_id: newId("run"),
        skill_id: skill.skill_id,
        route_id: route.route_id,
        installed_skill_id: installedSkill.installed_skill_id,
        user_id: MOCK_USER_ID,
        domain: skill.domain,
        status: "pending",
        created_at: new Date().toISOString(),
        ...(agent_id ? { agent_id } : {}),
        ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
        ...(delegation_id ? { delegation_id } : {}),
        ...(collar_id ? { collar_id } : {}),
      };

      routeRuns.set(run.run_id, run);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          run: buildRunSummary(run, []),
          approval_required: false,
          next_action: "poll_run_status",
        },
      });
    }
  );

  /**
   * GET /api/agent/v1/runs/:runId
   * Returns a safe status summary for a run owned by this delegation.
   */
  server.get<{ Params: { runId: string } }>(
    "/api/agent/v1/runs/:runId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { runId } = req.params;
      const run = routeRuns.get(runId);
      if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.");

      if (run.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This run does not belong to your delegation.");
      }

      const receipts = Array.from(
        (await getReceiptRepository().listReceipts(MOCK_USER_ID))
      ).filter((r) => r.run_id === runId);

      return reply.send({
        ok: true,
        data: buildRunSummary(run, receipts.map((r) => r.receipt_id)),
      });
    }
  );

  /**
   * GET /api/agent/v1/runs/:runId/receipts
   * Returns safe receipt summaries for a run owned by this delegation.
   * Does not expose: pass_ids_used, runtime_capability_releases, variables, or internal IDs.
   */
  server.get<{ Params: { runId: string } }>(
    "/api/agent/v1/runs/:runId/receipts",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { runId } = req.params;
      const run = routeRuns.get(runId);
      if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.");

      if (run.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This run does not belong to your delegation.");
      }

      const receipts = (await getReceiptRepository().listReceipts(MOCK_USER_ID)).filter(
        (r) => r.run_id === runId
      );

      return reply.send({
        ok: true,
        data: receipts.map(toSafeReceiptSummary),
      });
    }
  );

  /**
   * GET /api/agent/v1/websites/:domain/safety-profile
   * Returns a compact domain safety profile for the given task category.
   * Query param: ?task_category= (required)
   */
  server.get<{ Params: { domain: string }; Querystring: { task_category?: string } }>(
    "/api/agent/v1/websites/:domain/safety-profile",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { domain } = req.params;
      const { task_category } = req.query;

      if (!task_category) {
        return sendError(reply, 400, "MISSING_TASK_CATEGORY", "task_category query parameter is required.");
      }
      if (!VALID_TASK_CATEGORIES.has(task_category as DelegationTrustTaskCategory)) {
        return sendError(reply, 400, "INVALID_TASK_CATEGORY", `Unknown task_category: "${task_category}".`);
      }

      const profile = await computeWebsiteAgentSafetyProfile(
        domain,
        task_category as DelegationTrustTaskCategory
      );

      return reply.send({ ok: true, data: profile });
    }
  );

  /**
   * GET /api/agent/v1/websites/:domain/policy
   * Returns the well-known Aegis policy for the domain (localhost-only in v1).
   */
  server.get<{ Params: { domain: string } }>(
    "/api/agent/v1/websites/:domain/policy",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { domain } = req.params;
      const result = await getWebsiteAegisPolicyForDomain(domain);
      const available = result.policy !== undefined || result.validation !== undefined;

      return reply.send({
        ok: true,
        data: {
          available,
          ...(result.policy ? { policy: result.policy } : {}),
          ...(result.validation
            ? { validation: { valid: result.validation.valid, errors: result.validation.errors, warnings: result.validation.warnings } }
            : {}),
        },
      });
    }
  );

  /**
   * POST /api/agent/v1/observation-dry-runs
   * Navigate to a URL in an isolated headless browser, inspect DOM for sensitive signals,
   * and return a structured observation report. Observe-only — no clicks, no typing,
   * no form submit, no credential fill, no capability release, no KMS, no route execution.
   */
  server.post(
    "/api/agent/v1/observation-dry-runs",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = req.body as { url?: unknown; task_category?: unknown };

      if (!body.url || typeof body.url !== "string") {
        return sendError(reply, 400, "INVALID_URL", "url is required and must be a string.");
      }
      if (
        body.task_category !== undefined &&
        !VALID_TASK_CATEGORIES.has(body.task_category as DelegationTrustTaskCategory)
      ) {
        return sendError(reply, 400, "INVALID_TASK_CATEGORY", `Unknown task_category: "${body.task_category}".`);
      }

      try {
        const result = await runObservationDryRun({
          requested_url: body.url,
          task_category: body.task_category as DelegationTrustTaskCategory | undefined,
          user_id: MOCK_USER_ID,
        });
        return reply.send({ ok: true, data: result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unexpected error during observation dry run.";
        return sendError(reply, 500, "OBSERVATION_DRY_RUN_FAILED", msg);
      }
    }
  );

  // ─── Authenticated Session Boundary v1 ─────────────────────────────────────

  // Request Aegis to perform a login on the agent's behalf.
  // Agent never receives cookies, storage, password, or session secrets.
  // Returns a session handle with status pending_approval.
  // Login runs after user approval; stops on 2FA/CAPTCHA/passkey/security challenge.
  server.post(
    "/api/agent/v1/authenticated-sessions/login-request",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = (req.body ?? {}) as {
        domain?: unknown;
        login_url?: unknown;
        task_summary?: unknown;
        pass_id?: unknown;
      };

      if (!body.domain || typeof body.domain !== "string" || !body.domain.trim()) {
        return sendError(reply, 400, "MISSING_DOMAIN", "domain is required and must be a non-empty string.");
      }
      if (!body.login_url || typeof body.login_url !== "string") {
        return sendError(reply, 400, "MISSING_LOGIN_URL", "login_url is required.");
      }
      if (!/^https?:\/\//i.test(body.login_url)) {
        return sendError(reply, 400, "INVALID_LOGIN_URL", "login_url must start with http:// or https://.");
      }
      if (!body.task_summary || typeof body.task_summary !== "string" || !body.task_summary.trim()) {
        return sendError(reply, 400, "MISSING_TASK_SUMMARY", "task_summary is required and must be a non-empty string.");
      }

      const loginReq: AuthenticatedSessionLoginRequest = {
        domain: (body.domain as string).trim(),
        login_url: body.login_url as string,
        task_summary: (body.task_summary as string).trim(),
        pass_id: typeof body.pass_id === "string" ? body.pass_id : undefined,
      };

      const handle = createAuthenticatedSession(loginReq, delegation);
      return reply.send({ ok: true, data: handle });
    },
  );

  // Get the current handle for an authenticated session.
  server.get<{ Params: { sessionId: string } }>(
    "/api/agent/v1/authenticated-sessions/:sessionId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const handle = getAuthenticatedSessionHandle(req.params.sessionId, delegation.user_id);
      if (!handle) return sendError(reply, 404, "SESSION_NOT_FOUND", "Authenticated session not found.");
      return reply.send({ ok: true, data: handle });
    },
  );

  // Observe the current state of an authenticated session.
  // Returns safe observation only — never cookies, storage, or credentials.
  server.get<{ Params: { sessionId: string } }>(
    "/api/agent/v1/authenticated-sessions/:sessionId/observe",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const handle = getAuthenticatedSessionHandle(req.params.sessionId, delegation.user_id);
      if (!handle) return sendError(reply, 404, "SESSION_NOT_FOUND", "Authenticated session not found.");
      // Allow observation for authenticated and manual_step_required — browser is kept open in both states.
      // For other statuses (pending_approval, login_in_progress, failed, expired) return handle only.
      const canObserve = handle.status === "authenticated" || handle.status === "manual_step_required";
      if (!canObserve) {
        return reply.send({ ok: true, data: { session_id: handle.session_id, status: handle.status, handle } });
      }
      try {
        const result = await observeAuthenticatedSession(req.params.sessionId, delegation.user_id);
        return reply.send({ ok: true, data: result });
      } catch (err: unknown) {
        const e = err as { code?: string; status?: number; message?: string };
        return sendError(reply, e.status ?? 500, e.code ?? "OBSERVE_FAILED", e.message ?? "Observation failed.");
      }
    },
  );

  // Navigate to a same-domain URL within an authenticated session, then return safe observation.
  // No form submission, POST, credential fill, or arbitrary clicking allowed.
  server.post<{ Params: { sessionId: string }; Body: { url?: unknown } }>(
    "/api/agent/v1/authenticated-sessions/:sessionId/navigate",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const handle = getAuthenticatedSessionHandle(req.params.sessionId, delegation.user_id);
      if (!handle) return sendError(reply, 404, "SESSION_NOT_FOUND", "Authenticated session not found.");
      if (handle.status !== "authenticated") {
        return sendError(
          reply, 400, "SESSION_NOT_AUTHENTICATED",
          `Session status is '${handle.status}'; must be 'authenticated' to navigate.`,
        );
      }
      if (!handle.capabilities.includes("safe_navigation")) {
        return sendError(reply, 403, "CAPABILITY_NOT_GRANTED", "safe_navigation capability is not available.");
      }
      const url = req.body?.url;
      if (!url || typeof url !== "string") {
        return sendError(reply, 400, "INVALID_URL", "url is required and must be a string.");
      }
      try {
        const result = await navigateAuthenticatedSession(req.params.sessionId, delegation.user_id, url);
        return reply.send({ ok: true, data: result });
      } catch (err: unknown) {
        const e = err as { code?: string; status?: number; message?: string };
        return sendError(reply, e.status ?? 500, e.code ?? "NAVIGATE_FAILED", e.message ?? "Navigation failed.");
      }
    },
  );

  // ─── Agent-Browser Secret Injection v1 ─────────────────────────────────────

  function injectionNextAction(status: SecretFieldInjectionStatus, authCovered?: boolean): string {
    switch (status) {
      case "pending_approval":
        return authCovered
          ? "Tell the user to approve in the Aegis UI at /route-run-approvals under 'Login credential requests'. Then call wait_for_credential_authorization with the authorization_id from this response — it will return automatically when approved. Do NOT ask the user to type 'done'."
          : "Tell the user to approve in the Aegis UI at /route-run-approvals under 'Login credential requests'. Then call wait_for_credential_authorization with the authorization_id. Do NOT ask the user to type 'done'.";
      case "approved":
        return "Injection is approved. Call execute_secret_field_injection with this injection_request_id.";
      case "executing":
        return "Injection is in progress. Poll get_secret_injection_status again shortly.";
      case "filled":
        return "Field was filled successfully. Continue your workflow — navigate, click submit, etc.";
      case "denied":
        return "Injection was denied by the user. Do not retry without user direction.";
      case "failed":
        return "Injection failed. Check error for details. Request a new injection if the issue is transient.";
      case "expired":
        return "Injection expired (5-minute TTL or API restart). Call request_secret_field_injection to start a new login attempt — a new user approval will be required.";
    }
  }

  // POST /api/agent/v1/injections — create a secret field injection request
  server.post(
    "/api/agent/v1/injections",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = req.body as {
        domain?: string;
        pass_id?: string;
        field_kind?: string;
        page_url?: string;
        element_hint?: {
          label?: string;
          placeholder?: string;
          input_type?: string;
          selector_hint?: string;
        };
        reason?: string;
      };

      if (!body.domain || typeof body.domain !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!body.field_kind || !["username", "password"].includes(body.field_kind)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "field_kind must be 'username' or 'password'.");
      }
      if (!body.page_url || typeof body.page_url !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "page_url is required.");
      }
      if (!body.reason || typeof body.reason !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "reason is required.");
      }

      // Domain must match the page_url hostname to prevent cross-domain injection
      let pageHostname: string;
      try {
        pageHostname = new URL(body.page_url).hostname;
      } catch {
        return sendError(reply, 400, "INVALID_URL", "page_url is not a valid URL.");
      }
      if (pageHostname !== body.domain && !pageHostname.endsWith(`.${body.domain}`)) {
        return sendError(
          reply, 400, "DOMAIN_MISMATCH",
          `Aegis will not inject ${body.domain} credentials into ${pageHostname}. ` +
          `Navigate to the ${body.domain} login page (using username/password, not OAuth) before requesting injection.`,
        );
      }

      // Find the vault pass
      const vaultRepo = getVaultRepository();
      let pass: Awaited<ReturnType<typeof vaultRepo.getVaultPass>> | undefined;
      if (body.pass_id) {
        pass = aegisVaultPasses.get(body.pass_id) ?? await vaultRepo.getVaultPass(body.pass_id);
        if (!pass || pass.user_id !== MOCK_USER_ID || pass.domain !== body.domain) {
          return sendError(reply, 404, "PASS_NOT_FOUND", `No vault pass found for pass_id '${body.pass_id}' on domain '${body.domain}'.`);
        }
      } else {
        pass = Array.from(aegisVaultPasses.values()).find(
          (p) => p.user_id === MOCK_USER_ID && p.domain === body.domain,
        );
        if (!pass) {
          return sendError(reply, 404, "PASS_NOT_FOUND", `No vault pass found for domain '${body.domain}'. Add credentials for this domain first.`);
        }
      }

      // Find or create a CredentialUseAuthorization for this login attempt.
      // One approval covers both username and password for the same pass/domain/delegation.
      const now = new Date();
      const fieldKind = body.field_kind as "username" | "password";

      // An approved auth is only reusable if the field_kind has remaining uses.
      const approvedAuth = Array.from(credentialUseAuthorizations.values()).find(
        (a) =>
          a.user_id === MOCK_USER_ID &&
          a.delegation_id === delegation.id &&
          a.domain === body.domain &&
          a.pass_id === pass.pass_id &&
          a.purpose === "login" &&
          a.status === "approved" &&
          new Date(a.expires_at) > now &&
          a.allowed_field_kinds.includes(fieldKind) &&
          (a.use_counts[fieldKind] ?? 0) < (a.max_uses_per_field[fieldKind] ?? 1),
      );

      const pendingAuth = !approvedAuth
        ? Array.from(credentialUseAuthorizations.values()).find(
            (a) =>
              a.user_id === MOCK_USER_ID &&
              a.delegation_id === delegation.id &&
              a.domain === body.domain &&
              a.pass_id === pass.pass_id &&
              a.purpose === "login" &&
              a.status === "pending_approval" &&
              new Date(a.expires_at) > now,
          )
        : undefined;

      let auth: CredentialUseAuthorization;
      let injectionStatus: SecretFieldInjectionStatus;

      if (approvedAuth) {
        auth = approvedAuth;
        injectionStatus = "approved";
      } else if (pendingAuth) {
        auth = pendingAuth;
        injectionStatus = "pending_approval";
      } else {
        auth = {
          authorization_id: newId("credauth"),
          user_id: MOCK_USER_ID,
          delegation_id: delegation.id,
          domain: body.domain,
          pass_id: pass.pass_id,
          pass_label: pass.label,
          pass_username: pass.username,
          allowed_field_kinds: ["username", "password"],
          max_uses_per_field: { username: 1, password: 1 },
          purpose: "login",
          status: "pending_approval",
          raw_values_revealed_to_agent: false,
          persistence_allowed: false,
          browser_storage_allowed: false,
          website_save_allowed: false,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          used_field_kinds: [],
          use_counts: { username: 0, password: 0 },
        };
        credentialUseAuthorizations.set(auth.authorization_id, auth);
        injectionStatus = "pending_approval";
      }

      const injection: SecretFieldInjection = {
        injection_request_id: newId("inj"),
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        domain: body.domain,
        field_kind: fieldKind,
        pass_id: pass.pass_id,
        page_url: body.page_url,
        element_hint: body.element_hint,
        reason: body.reason,
        status: injectionStatus,
        authorization_id: auth.authorization_id,
        raw_value_revealed_to_agent: false,
        created_at: new Date().toISOString(),
        expires_at: auth.expires_at,
      };
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();

      const authCovered = injectionStatus === "pending_approval";
      const remainingUses = auth.allowed_field_kinds.reduce(
        (acc, fk) => {
          acc[fk] = (auth.max_uses_per_field[fk] ?? 1) - (auth.use_counts[fk] ?? 0);
          return acc;
        },
        {} as Record<string, number>,
      );
      return reply.send({
        ok: true,
        data: {
          injection_request_id: injection.injection_request_id,
          status: injection.status,
          domain: injection.domain,
          field_kind: injection.field_kind,
          pass_label: pass.label,
          raw_value_revealed_to_agent: false,
          expires_at: injection.expires_at,
          authorization_id: auth.authorization_id,
          authorization_covers: "username and password for this login attempt — one approval, one use each, 5-minute TTL",
          remaining_uses: remainingUses,
          next_action: injectionNextAction(injection.status, authCovered),
        },
      });
    },
  );

  // GET /api/agent/v1/injections/:injectionId — poll status
  server.get<{ Params: { injectionId: string } }>(
    "/api/agent/v1/injections/:injectionId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const injection = secretFieldInjections.get(req.params.injectionId);
      if (!injection) return sendError(reply, 404, "INJECTION_NOT_FOUND", "Injection not found.");
      if (injection.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This injection does not belong to your delegation.");
      }

      // Lazily promote injection status from linked authorization if approved/denied/expired
      const terminalStatuses = ["filled", "denied", "failed", "expired"] as const;
      if (!terminalStatuses.includes(injection.status as any)) {
        if (new Date(injection.expires_at) < new Date()) {
          injection.status = "expired";
          secretFieldInjections.set(injection.injection_request_id, injection);
          schedulePersist();
        } else if (injection.status === "pending_approval" && injection.authorization_id) {
          const auth = credentialUseAuthorizations.get(injection.authorization_id);
          if (auth) {
            if (auth.status === "approved" && auth.allowed_field_kinds.includes(injection.field_kind)) {
              injection.status = "approved";
              injection.approved_at = auth.approved_at;
              secretFieldInjections.set(injection.injection_request_id, injection);
              schedulePersist();
            } else if (["denied", "expired", "fulfilled", "revoked"].includes(auth.status)) {
              injection.status = auth.status === "fulfilled" ? "denied" : auth.status as any;
              secretFieldInjections.set(injection.injection_request_id, injection);
              schedulePersist();
            }
          }
        }
      }

      return reply.send({
        ok: true,
        data: {
          injection_request_id: injection.injection_request_id,
          status: injection.status,
          domain: injection.domain,
          field_kind: injection.field_kind,
          raw_value_revealed_to_agent: false,
          expires_at: injection.expires_at,
          ...(injection.filled_at ? { filled_at: injection.filled_at } : {}),
          ...(injection.error ? { error: injection.error } : {}),
          next_action: injectionNextAction(injection.status),
        },
      });
    },
  );

  // POST /api/agent/v1/injections/:injectionId/execute — CDP fill trigger
  server.post<{ Params: { injectionId: string } }>(
    "/api/agent/v1/injections/:injectionId/execute",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const injection = secretFieldInjections.get(req.params.injectionId);
      if (!injection) return sendError(reply, 404, "INJECTION_NOT_FOUND", "Injection not found.");
      if (injection.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This injection does not belong to your delegation.");
      }

      // Expiry check
      if (new Date(injection.expires_at) < new Date() && injection.status !== "filled") {
        injection.status = "expired";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        return sendError(reply, 400, "INJECTION_EXPIRED", "Injection has expired. Request a new injection.");
      }

      // Promote via authorization if still pending; also enforce use limits
      if (injection.authorization_id) {
        const auth = credentialUseAuthorizations.get(injection.authorization_id);
        if (auth) {
          // Lazy expire the auth if past TTL
          if (new Date(auth.expires_at) < new Date() && auth.status === "approved") {
            auth.status = "expired";
            credentialUseAuthorizations.set(auth.authorization_id, auth);
            schedulePersist();
          }
          // Promote pending injection to approved if auth is now approved
          if (
            injection.status === "pending_approval" &&
            auth.status === "approved" &&
            auth.allowed_field_kinds.includes(injection.field_kind)
          ) {
            injection.status = "approved";
            injection.approved_at = auth.approved_at;
            secretFieldInjections.set(injection.injection_request_id, injection);
            schedulePersist();
          }
          // Block if authorization is fulfilled (all uses exhausted)
          if (auth.status === "fulfilled") {
            return sendError(
              reply, 400, "AUTHORIZATION_FULFILLED",
              `The credential-use authorization for this login attempt has already been fulfilled. ` +
              `Request a new injection to start a new login attempt — a new approval will be required.`,
            );
          }
          // Enforce per-field use limit
          if (injection.status === "approved" || auth.status === "approved") {
            const used = auth.use_counts[injection.field_kind] ?? 0;
            const max = auth.max_uses_per_field[injection.field_kind] ?? 1;
            if (used >= max) {
              return sendError(
                reply, 400, "USE_LIMIT_EXCEEDED",
                `The ${injection.field_kind} field has already been filled once for this login attempt. ` +
                `Request a new injection to start a new login attempt.`,
              );
            }
          }
        }
      }

      if (injection.status !== "approved") {
        return sendError(
          reply, 400, "INJECTION_NOT_APPROVED",
          `Injection status is '${injection.status}'; only 'approved' injections can be executed. ${injectionNextAction(injection.status)}`,
        );
      }

      // Transition to executing
      injection.status = "executing";
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();

      // Resolve credential — resolvedValue never leaves this function into any response or log
      const vaultRepo = getVaultRepository();
      const pass = aegisVaultPasses.get(injection.pass_id) ?? await vaultRepo.getVaultPass(injection.pass_id);
      if (!pass || pass.user_id !== MOCK_USER_ID) {
        injection.status = "failed";
        injection.error = "Vault pass not found or access denied.";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        return sendError(reply, 404, "PASS_NOT_FOUND", "Vault pass not found.");
      }

      let resolvedValue: string;
      const kms = getKmsProvider();

      try {
        if (injection.field_kind === "username") {
          if (!pass.username) throw new Error("Pass has no username stored.");
          resolvedValue = pass.username;
          // Username is non-secret metadata — no KMS needed, no audit event
        } else {
          // Password — decrypt via KMS
          const blob = await vaultRepo.getEncryptedSecret(pass.secret_ref);
          if (!blob) throw new Error(`Secret not available for pass ${pass.pass_id}.`);
          const kmsCtx = {
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            purpose: "login_password" as const,
          };
          resolvedValue = await kms.decryptSecret(blob, kmsCtx);
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            run_id: `injection:${injection.injection_request_id}`,
            success: true,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Credential resolution failed";
        if (injection.field_kind === "password") {
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            run_id: `injection:${injection.injection_request_id}`,
            success: false,
            error_code: "RESOLVE_FAILED",
          });
        }
        injection.status = "failed";
        injection.error = msg;
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        return sendError(reply, 500, "CREDENTIAL_RESOLVE_FAILED", msg);
      }

      // CDP fill — resolvedValue used here and immediately discarded; never returned in response
      const fillResult = await executeSecretInjectionViaCDP(injection, resolvedValue);

      if (fillResult.success) {
        injection.status = "filled";
        injection.filled_at = new Date().toISOString();
        injection.error = undefined;
        // Update use counts and check for fulfillment
        if (injection.authorization_id) {
          const auth = credentialUseAuthorizations.get(injection.authorization_id);
          if (auth) {
            const now = new Date().toISOString();
            auth.use_counts[injection.field_kind] = (auth.use_counts[injection.field_kind] ?? 0) + 1;
            if (!auth.used_field_kinds.includes(injection.field_kind)) {
              auth.used_field_kinds = [...auth.used_field_kinds, injection.field_kind];
            }
            auth.last_used_at = now;
            // Fulfilled when all allowed fields have hit their max use count
            const allFulfilled = auth.allowed_field_kinds.every(
              (fk) => (auth.use_counts[fk] ?? 0) >= (auth.max_uses_per_field[fk] ?? 1),
            );
            if (allFulfilled) {
              auth.status = "fulfilled";
              auth.fulfilled_at = now;
            }
            credentialUseAuthorizations.set(auth.authorization_id, auth);
          }
        }
      } else {
        injection.status = "failed";
        injection.error = fillResult.error ?? "CDP fill failed";
      }
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();

      if (!fillResult.success) {
        return sendError(reply, 500, "CDP_FILL_FAILED", fillResult.error ?? "CDP fill failed");
      }

      // Response NEVER includes resolvedValue or pass_id
      return reply.send({
        ok: true,
        data: {
          injection_request_id: injection.injection_request_id,
          status: "filled",
          field_kind: injection.field_kind,
          domain: injection.domain,
          filled_at: injection.filled_at,
          raw_value_revealed_to_agent: false,
          note: "Aegis injected the field value directly via CDP. The raw credential was never returned to the agent.",
        },
      });
    },
  );

  // GET /api/agent/v1/credential-authorizations/:authorizationId — poll authorization status
  server.get<{ Params: { authorizationId: string } }>(
    "/api/agent/v1/credential-authorizations/:authorizationId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const auth = credentialUseAuthorizations.get(req.params.authorizationId);
      if (!auth) return sendError(reply, 404, "AUTHORIZATION_NOT_FOUND", "Credential authorization not found.");
      if (auth.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This authorization does not belong to your delegation.");
      }

      // Lazy expire if past TTL and still in a non-terminal pre-approved state
      const terminalStatuses = ["fulfilled", "denied", "expired", "revoked"];
      if (!terminalStatuses.includes(auth.status) && new Date(auth.expires_at) < new Date()) {
        auth.status = "expired";
        credentialUseAuthorizations.set(auth.authorization_id, auth);
        schedulePersist();
      }

      const remainingUses = auth.allowed_field_kinds.reduce(
        (acc, fk) => {
          acc[fk] = (auth.max_uses_per_field[fk] ?? 1) - (auth.use_counts[fk] ?? 0);
          return acc;
        },
        {} as Record<string, number>,
      );

      // Safe metadata only — no pass_id, secret_ref, raw values, cookies, KMS material
      return reply.send({
        ok: true,
        data: {
          authorization_id: auth.authorization_id,
          domain: auth.domain,
          pass_label: auth.pass_label,
          allowed_field_kinds: auth.allowed_field_kinds,
          max_uses_per_field: auth.max_uses_per_field,
          use_counts: auth.use_counts,
          remaining_uses: remainingUses,
          status: auth.status,
          raw_values_revealed_to_agent: false,
          expires_at: auth.expires_at,
          approved_at: auth.approved_at,
          fulfilled_at: auth.fulfilled_at,
          last_used_at: auth.last_used_at,
          used_field_kinds: auth.used_field_kinds,
        },
      });
    },
  );

  // ─── Challenge Relay v1 ────────────────────────────────────────────────────

  const VALID_CHALLENGE_TYPES = new Set<SecurityChallengeType>([
    "email_device_verification", "sms_code", "totp", "passkey",
    "captcha", "device_verification", "unknown",
  ]);

  function challengeNextAction(status: SecurityChallengeStatus): string {
    switch (status) {
      case "pending_user":
        return 'Tell the user: "A verification code is needed. Please enter it in the Aegis UI at /route-run-approvals under \'Security challenges\'." Do NOT ask the user to paste the code into chat. Call wait_for_security_challenge again.';
      case "code_submitted":
        return "User has submitted the code. Call inject_security_challenge_code now.";
      case "code_injected":
        return "Code was injected into the browser field. Click 'Verify', 'Continue', or 'Submit' in your Playwright browser to complete the challenge.";
      case "user_completed":
        return "User completed the challenge directly in the browser. Continue your workflow.";
      case "cancelled":
        return "Challenge was cancelled by the user. Do not retry without user direction.";
      case "expired":
        return "Challenge expired. Navigate back to the challenge page and call report_security_challenge again.";
      case "failed":
        return "Challenge injection failed. Check the error field. The user may submit the code again via the Aegis UI.";
    }
  }

  // POST /api/agent/v1/security-challenges — agent reports a detected challenge
  server.post(
    "/api/agent/v1/security-challenges",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = req.body as {
        domain?: unknown;
        page_url?: unknown;
        challenge_type?: unknown;
        masked_destination?: unknown;
        browser_session_id?: unknown;
        element_hint?: unknown;
        instructions?: unknown;
      };

      if (!body.domain || typeof body.domain !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!body.page_url || typeof body.page_url !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "page_url is required.");
      }

      let pageHostname: string;
      try {
        pageHostname = new URL(body.page_url).hostname;
      } catch {
        return sendError(reply, 400, "INVALID_URL", "page_url is not a valid URL.");
      }
      if (pageHostname !== body.domain && !pageHostname.endsWith(`.${body.domain}`)) {
        return sendError(
          reply, 400, "DOMAIN_MISMATCH",
          `page_url hostname '${pageHostname}' must match domain '${body.domain}'.`,
        );
      }

      const challengeType = (typeof body.challenge_type === "string" && VALID_CHALLENGE_TYPES.has(body.challenge_type as SecurityChallengeType))
        ? body.challenge_type as SecurityChallengeType
        : "unknown";

      const now = new Date();
      const challenge: SecurityChallenge = {
        challenge_id: newId("chlg"),
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        browser_session_id: typeof body.browser_session_id === "string" ? body.browser_session_id : undefined,
        domain: body.domain,
        page_url: body.page_url,
        challenge_type: challengeType,
        status: "pending_user",
        masked_destination: typeof body.masked_destination === "string" ? body.masked_destination : undefined,
        element_hint: (body.element_hint && typeof body.element_hint === "object") ? body.element_hint as SecurityChallenge["element_hint"] : undefined,
        instructions: (typeof body.instructions === "string" && body.instructions.trim())
          ? body.instructions.trim()
          : `${body.domain} requires a security verification code. Enter the code in the Aegis UI.`,
        raw_code_revealed_to_agent: false,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      };

      securityChallenges.set(challenge.challenge_id, challenge);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          challenge_id: challenge.challenge_id,
          status: challenge.status,
          challenge_type: challenge.challenge_type,
          domain: challenge.domain,
          masked_destination: challenge.masked_destination,
          expires_at: challenge.expires_at,
          raw_code_revealed_to_agent: false as const,
          next_action: `Tell the user: "A security challenge was detected on ${challenge.domain}. Please enter the verification code in the Aegis UI at /route-run-approvals under 'Security challenges'." Do NOT ask the user to paste the code into chat. Then call wait_for_security_challenge with challenge_id="${challenge.challenge_id}".`,
        },
      });
    },
  );

  // GET /api/agent/v1/security-challenges/:challengeId — poll challenge status
  server.get<{ Params: { challengeId: string } }>(
    "/api/agent/v1/security-challenges/:challengeId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "CHALLENGE_NOT_FOUND", "Security challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID || challenge.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this challenge.");
      }

      // Lazy expire
      if (
        (challenge.status === "pending_user" || challenge.status === "code_submitted") &&
        new Date(challenge.expires_at) < new Date()
      ) {
        challenge.status = "expired";
        challengeCodes.delete(challenge.challenge_id);
        securityChallenges.set(challenge.challenge_id, challenge);
        schedulePersist();
      }

      return reply.send({
        ok: true,
        data: {
          challenge_id: challenge.challenge_id,
          status: challenge.status,
          challenge_type: challenge.challenge_type,
          domain: challenge.domain,
          masked_destination: challenge.masked_destination,
          expires_at: challenge.expires_at,
          submitted_at: challenge.submitted_at,
          injected_at: challenge.injected_at,
          completed_at: challenge.completed_at,
          error: challenge.error,
          raw_code_revealed_to_agent: false as const,
          next_action: challengeNextAction(challenge.status),
        },
      });
    },
  );

  // ─── Connected Email Challenge Resolver v1 ──────────────────────────────────

  function resolutionNextAction(status: ChallengeEmailResolutionStatus): string {
    switch (status) {
      case "pending_approval":
        return "Wait for the user to approve the Gmail search in the Aegis UI at /route-run-approvals under 'Security challenges'. Then call wait_for_challenge_email_resolution again.";
      case "code_found":
        return "Call inject_challenge_email_code to inject the code into the browser field. The agent never sees the code.";
      case "injected":
        return "Code was injected into the browser field. Click 'Verify', 'Continue', or 'Submit' in your Playwright browser to complete the challenge. Aegis does not click for you.";
      case "not_found":
        return "No code found in recent verification emails. Tell the user: 'Aegis could not find the verification code in Gmail. Please enter it manually in the Aegis UI at /route-run-approvals under Security challenges.'";
      case "failed":
        return "Email resolution failed. Tell the user to enter the verification code manually in the Aegis UI.";
      case "cancelled":
        return "Resolution was cancelled. The user can enter the code manually in the Aegis UI.";
      case "expired":
        return "Resolution expired. Request a new resolution if the challenge is still active.";
      case "searching":
        return "Gmail search is in progress. Call wait_for_challenge_email_resolution again shortly.";
    }
  }

  function safeEmailResolution(res: ChallengeEmailResolution) {
    return {
      resolution_id: res.resolution_id,
      challenge_id: res.challenge_id,
      provider: res.provider,
      domain: res.domain,
      status: res.status,
      raw_code_revealed_to_agent: false as const,
      email_body_revealed_to_agent: false as const,
      search_window_started_at: res.search_window_started_at,
      searched_at: res.searched_at,
      found_at: res.found_at,
      injected_at: res.injected_at,
      sender_domain: res.sender_domain,
      received_at: res.received_at,
      extraction_source: res.extraction_source,
      error: res.error,
      created_at: res.created_at,
      updated_at: res.updated_at,
    };
  }

  // POST /api/agent/v1/security-challenges/:challengeId/email-resolution-request
  // Agent requests Gmail-based email resolution for a live challenge.
  server.post<{ Params: { challengeId: string } }>(
    "/api/agent/v1/security-challenges/:challengeId/email-resolution-request",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "CHALLENGE_NOT_FOUND", "Security challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID || challenge.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this challenge.");
      }

      if (challenge.status !== "pending_user") {
        return sendError(
          reply, 400, "INVALID_CHALLENGE_STATUS",
          `Challenge status is '${challenge.status}'. Gmail resolver requires status 'pending_user'.`,
        );
      }
      if (!isEmailChallengeSupported(challenge.domain)) {
        return sendError(
          reply, 400, "DOMAIN_NOT_SUPPORTED",
          `Email resolver does not support '${challenge.domain}' challenges. Use report_security_challenge for unsupported domains.`,
        );
      }
      if (challenge.challenge_type !== "email_device_verification") {
        return sendError(
          reply, 400, "CHALLENGE_TYPE_NOT_SUPPORTED",
          `Email resolver v1 only supports 'email_device_verification'. This challenge is '${challenge.challenge_type}'.`,
        );
      }

      // Deduplication: return existing non-terminal resolution for this challenge
      const existing = Array.from(challengeEmailResolutions.values()).find(
        (r) =>
          r.challenge_id === challenge.challenge_id &&
          !["injected", "not_found", "failed", "expired", "cancelled"].includes(r.status),
      );
      if (existing) {
        return reply.send({
          ok: true,
          data: {
            ...safeEmailResolution(existing),
            next_action: resolutionNextAction(existing.status),
          },
        });
      }

      const now = new Date().toISOString();
      const resolution: ChallengeEmailResolution = {
        resolution_id: newId("ceres"),
        challenge_id: challenge.challenge_id,
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        provider: "gmail",
        domain: challenge.domain,
        status: "pending_approval",
        raw_code_revealed_to_agent: false,
        email_body_revealed_to_agent: false,
        search_window_started_at: challenge.created_at,
        created_at: now,
        updated_at: now,
      };

      challengeEmailResolutions.set(resolution.resolution_id, resolution);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          ...safeEmailResolution(resolution),
          next_action: resolutionNextAction(resolution.status),
        },
      });
    },
  );

  // GET /api/agent/v1/challenge-email-resolutions/:resolutionId — poll resolution status
  server.get<{ Params: { resolutionId: string } }>(
    "/api/agent/v1/challenge-email-resolutions/:resolutionId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const resolution = challengeEmailResolutions.get(req.params.resolutionId);
      if (!resolution) return sendError(reply, 404, "RESOLUTION_NOT_FOUND", "Email resolution not found.");
      if (resolution.user_id !== MOCK_USER_ID || resolution.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this resolution.");
      }

      // Lazy expiry: resolutions expire 10 minutes after creation if not completed
      const RESOLUTION_TTL_MS = 10 * 60 * 1000;
      const isNonTerminal = !["injected", "not_found", "failed", "expired", "cancelled"].includes(resolution.status);
      if (isNonTerminal && new Date(resolution.created_at).getTime() + RESOLUTION_TTL_MS < Date.now()) {
        resolution.status = "expired";
        resolution.updated_at = new Date().toISOString();
        resolutionCodes.delete(resolution.resolution_id);
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
      }

      return reply.send({
        ok: true,
        data: {
          ...safeEmailResolution(resolution),
          next_action: resolutionNextAction(resolution.status),
        },
      });
    },
  );

  // POST /api/agent/v1/challenge-email-resolutions/:resolutionId/inject
  // Agent triggers CDP injection of the found code.
  server.post<{ Params: { resolutionId: string } }>(
    "/api/agent/v1/challenge-email-resolutions/:resolutionId/inject",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const resolution = challengeEmailResolutions.get(req.params.resolutionId);
      if (!resolution) return sendError(reply, 404, "RESOLUTION_NOT_FOUND", "Email resolution not found.");
      if (resolution.user_id !== MOCK_USER_ID || resolution.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this resolution.");
      }
      if (resolution.status !== "code_found") {
        return sendError(
          reply, 400, "INVALID_STATUS",
          `Cannot inject for resolution with status '${resolution.status}'. Status must be 'code_found'.`,
        );
      }

      const codeEntry = resolutionCodes.get(resolution.resolution_id);
      if (!codeEntry) {
        resolution.status = "failed";
        resolution.error = "Code is no longer available. It may have expired. Request a new resolution.";
        resolution.updated_at = new Date().toISOString();
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
        return sendError(reply, 400, "CODE_NOT_AVAILABLE", resolution.error);
      }
      if (new Date(codeEntry.expires_at) < new Date()) {
        resolutionCodes.delete(resolution.resolution_id);
        resolution.status = "expired";
        resolution.error = "The retrieved code has expired. Request a new resolution.";
        resolution.updated_at = new Date().toISOString();
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
        return sendError(reply, 400, "CODE_EXPIRED", resolution.error);
      }

      // Retrieve the original challenge for CDP targeting
      const challenge = securityChallenges.get(resolution.challenge_id);
      if (!challenge) {
        resolutionCodes.delete(resolution.resolution_id);
        resolution.status = "failed";
        resolution.error = "Associated challenge not found.";
        resolution.updated_at = new Date().toISOString();
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
        return sendError(reply, 400, "CHALLENGE_NOT_FOUND", resolution.error);
      }

      // Consume the code immediately — deleted regardless of outcome
      const { code } = codeEntry;
      resolutionCodes.delete(resolution.resolution_id);

      const fillResult = await executeChallengeInjectionViaCDP(challenge, code);

      if (fillResult.success) {
        resolution.status = "injected";
        resolution.injected_at = new Date().toISOString();
        resolution.error = undefined;
      } else {
        resolution.status = "failed";
        resolution.error = fillResult.error;
      }
      resolution.updated_at = new Date().toISOString();
      challengeEmailResolutions.set(resolution.resolution_id, resolution);
      schedulePersist();

      return reply.send({
        ok: fillResult.success,
        data: {
          resolution_id: resolution.resolution_id,
          status: resolution.status,
          injected_at: resolution.injected_at,
          raw_code_revealed_to_agent: false as const,
          email_body_revealed_to_agent: false as const,
          ...(resolution.error ? { error: resolution.error } : {}),
          next_action: resolutionNextAction(resolution.status),
        },
      });
    },
  );

  // POST /api/agent/v1/security-challenges/:challengeId/inject — CDP code injection
  server.post<{ Params: { challengeId: string } }>(
    "/api/agent/v1/security-challenges/:challengeId/inject",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "CHALLENGE_NOT_FOUND", "Security challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID || challenge.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this challenge.");
      }
      if (challenge.status !== "code_submitted") {
        return sendError(
          reply, 400, "INVALID_STATUS",
          `Cannot inject code for challenge with status '${challenge.status}'. The user must submit the code in the Aegis UI first.`,
        );
      }

      const entry = challengeCodes.get(challenge.challenge_id);
      if (!entry) {
        return sendError(
          reply, 400, "CODE_NOT_AVAILABLE",
          "No code found for this challenge. It may have been cleared after submission. Ask the user to submit again in the Aegis UI.",
        );
      }
      if (new Date(entry.expires_at) < new Date()) {
        challengeCodes.delete(challenge.challenge_id);
        challenge.status = "expired";
        securityChallenges.set(challenge.challenge_id, challenge);
        schedulePersist();
        return sendError(reply, 400, "CODE_EXPIRED", "The submitted code has expired. Ask the user to submit again.");
      }

      // Consume the code immediately — deleted regardless of outcome
      const { code } = entry;
      challengeCodes.delete(challenge.challenge_id);

      const fillResult = await executeChallengeInjectionViaCDP(challenge, code);

      if (fillResult.success) {
        challenge.status = "code_injected";
        challenge.injected_at = new Date().toISOString();
        challenge.error = undefined;
      } else {
        challenge.status = "failed";
        challenge.error = fillResult.error;
      }
      securityChallenges.set(challenge.challenge_id, challenge);
      schedulePersist();

      return reply.send({
        ok: fillResult.success,
        data: {
          challenge_id: challenge.challenge_id,
          status: challenge.status,
          raw_code_revealed_to_agent: false as const,
          ...(challenge.error ? { error: challenge.error } : {}),
          next_action: challenge.status === "code_injected"
            ? "Code injected into the browser field. Click 'Verify', 'Continue', or 'Submit' in your Playwright browser to complete the challenge. Aegis does not click for you."
            : `Injection failed: ${challenge.error ?? "unknown error"}. Ensure the browser is still open on the challenge page. Ask the user to submit the code again in the Aegis UI.`,
        },
      });
    },
  );

  // ─── Workspaces v0 ────────────────────────────────────────────────────────────

  const VALID_ARTIFACT_KINDS = new Set<WorkspaceArtifactKind>(["text", "json", "csv", "markdown"]);
  const ARTIFACT_MAX_BYTES = 50 * 1024; // 50KB

  /**
   * GET /api/agent/v1/workspaces/:workspaceId
   * Returns workspace metadata for participants. Never exposes owner_user_id or full participant list.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId",
    async (req: FastifyRequest<{ Params: { workspaceId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_read");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const taskList = Array.from(workspaceTasks.values()).filter(
        (t) => t.workspace_id === workspace.workspace_id,
      );
      const artifactList = Array.from(workspaceArtifacts.values()).filter(
        (a) => a.workspace_id === workspace.workspace_id,
      );

      return reply.send({
        ok: true,
        data: {
          workspace_id: workspace.workspace_id,
          name: workspace.name,
          description: workspace.description,
          collar_id: workspace.collar_id,
          status: workspace.status,
          participant_count: workspace.participant_delegation_ids.length,
          task_counts: {
            open: taskList.filter((t) => t.status === "open").length,
            in_progress: taskList.filter((t) => t.status === "in_progress").length,
            completed: taskList.filter((t) => t.status === "completed").length,
          },
          artifact_count: artifactList.length,
          created_at: workspace.created_at,
        },
      });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/manifest
   * Orientation manifest for agents joining a workspace. Returns identity, effective
   * permissions, task summary, artifact metadata, workflow rules, and next actions.
   * No audit event emitted — read-only orientation call.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/manifest",
    async (req: FastifyRequest<{ Params: { workspaceId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;

      const workspaceCollar = collars.get(workspace.collar_id);
      if (!workspaceCollar || workspaceCollar.status !== "active") {
        return sendError(reply, 403, "WORKSPACE_COLLAR_INACTIVE", "The workspace collar is inactive or missing.");
      }

      const delegationCollar = collars.get(delegation.default_collar_id);
      if (!delegationCollar || delegationCollar.status !== "active") {
        return sendError(reply, 403, "WORKSPACE_COLLAR_INACTIVE", "Your delegation collar is inactive or missing.");
      }

      const permResult = checkWorkspacePermission(workspace, workspaceCollar, delegation, "workspace_read");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const perms = buildEffectivePermissionsMap(workspaceCollar, delegationCollar);

      // Build task summary — classify open tasks by eligibility
      const allTasks = Array.from(workspaceTasks.values()).filter(
        (t) => t.workspace_id === workspace.workspace_id,
      );

      // assigned_delegation_id dual role:
      //   assignment_type="delegation" + status="open"  → reserved for that delegation (pre-assigned)
      //   status="in_progress" (any type)               → the actual claimant
      const assignedToMe: typeof allTasks = [];
      const eligible: typeof allTasks = [];
      const openUnassigned: typeof allTasks = [];
      const notEligible: { task_id: string; title: string; status: string; reason: string }[] = [];

      for (const t of allTasks) {
        if (t.status !== "open") continue;
        const type = t.assignment_type ?? "open";
        if (type === "delegation") {
          if (t.assigned_delegation_id === delegation.id) {
            assignedToMe.push(t);
          } else {
            notEligible.push({ task_id: t.task_id, title: t.title, status: t.status, reason: "assigned_to_other_delegation" });
          }
        } else if (type === "collar") {
          // Omit tasks whose required collar is inactive/missing from all buckets
          const rc = t.required_collar_id ? collars.get(t.required_collar_id) : undefined;
          if (!rc || rc.status !== "active") {
            notEligible.push({ task_id: t.task_id, title: t.title, status: t.status, reason: "required_collar_inactive_or_missing" });
          } else if (delegation.default_collar_id === t.required_collar_id) {
            eligible.push(t);
          } else {
            notEligible.push({ task_id: t.task_id, title: t.title, status: t.status, reason: `requires_collar:${t.required_collar_id}` });
          }
        } else {
          // "open" or absent — any participant may claim
          openUnassigned.push(t);
        }
      }

      const mineTasks = allTasks.filter(
        (t) => t.assigned_delegation_id === delegation.id && t.status === "in_progress",
      );
      const recentlyCompleted = allTasks
        .filter((t) => t.status === "completed")
        .sort((a, b) => (b.completed_at ?? "0").localeCompare(a.completed_at ?? "0"))
        .slice(0, 3);

      // Build artifact metadata list (no content)
      const allArtifacts = Array.from(workspaceArtifacts.values()).filter(
        (a) => a.workspace_id === workspace.workspace_id,
      );

      // Compute next_actions — priority: assigned_to_me > eligible > open > complete > artifact > read
      const nextActions: string[] = [];
      const wsPath = `/api/agent/v1/workspaces/${workspace.workspace_id}`;
      const canClaim = perms.workspace_task_claim === "allow";

      if (canClaim && assignedToMe.length > 0 && mineTasks.length === 0) {
        nextActions.push(`Claim your assigned task: PATCH ${wsPath}/tasks/{taskId} {"action":"claim"}`);
      }
      if (canClaim && eligible.length > 0 && mineTasks.length === 0 && assignedToMe.length === 0) {
        nextActions.push(`Claim an eligible task (your collar qualifies): PATCH ${wsPath}/tasks/{taskId} {"action":"claim"}`);
      }
      if (canClaim && openUnassigned.length > 0 && mineTasks.length === 0 && assignedToMe.length === 0 && eligible.length === 0) {
        nextActions.push(`Claim an open task: PATCH ${wsPath}/tasks/{taskId} {"action":"claim"}`);
      }
      if (mineTasks.length > 0) {
        nextActions.push(`Complete your in-progress task when done: PATCH ${wsPath}/tasks/{taskId} {"action":"complete"}`);
      }
      if (mineTasks.length > 0 && perms.workspace_artifact_create === "allow") {
        nextActions.push(`Create an artifact for your task: POST ${wsPath}/artifacts`);
      }
      if (allArtifacts.length > 0 && perms.workspace_artifact_read === "allow") {
        const firstId = allArtifacts[0].artifact_id;
        nextActions.push(`Read artifact content by ID: GET ${wsPath}/artifacts/${firstId}`);
      }
      if (nextActions.length === 0) {
        const allOpen = assignedToMe.length + eligible.length + openUnassigned.length;
        if (allOpen === 0 && mineTasks.length === 0) {
          nextActions.push("All tasks are done or claimed. Check the artifact list for results from other agents.");
        } else {
          nextActions.push("No actions available. Check your effective_permissions or contact the workspace owner.");
        }
      }

      // Build operations catalog
      const wsId = workspace.workspace_id;
      const operations = [
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/manifest`,
          description: "This endpoint. Orientation manifest — identity, permissions, tasks, artifacts, next actions.",
          available: true,
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}`,
          description: "Workspace metadata: task counts, artifact count.",
          available: perms.workspace_read === "allow",
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/tasks`,
          description: "List open tasks and your assigned tasks. Optional ?status= filter.",
          available: perms.workspace_task_list === "allow",
        },
        {
          method: "PATCH",
          path: `/api/agent/v1/workspaces/${wsId}/tasks/{taskId}`,
          description: 'Claim: {"action":"claim"} · Complete: {"action":"complete"}',
          available: perms.workspace_task_claim === "allow" || perms.workspace_task_complete === "allow",
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/artifacts`,
          description: "List artifact metadata (no content). Discover outputs from other agents.",
          available: perms.workspace_artifact_list === "allow",
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/artifacts/{artifactId}`,
          description: "Read full artifact content by ID.",
          available: perms.workspace_artifact_read === "allow",
        },
        {
          method: "POST",
          path: `/api/agent/v1/workspaces/${wsId}/artifacts`,
          description: "Create artifact (text/json/csv/markdown, max 50KB). Optionally link task_id.",
          available: perms.workspace_artifact_create === "allow",
        },
      ];

      const workflowRules = [
        "Claim a task before working on it — only one delegation may hold a task at a time.",
        'Claim: PATCH .../tasks/{taskId} {"action":"claim"}. Idempotent if already yours.',
        'Complete: PATCH .../tasks/{taskId} {"action":"complete"}. Only the assigned delegation can complete.',
        "Artifacts are shared with all participants. Create them to hand off results to other agents.",
        "POST artifact response omits content — use GET .../artifacts/{artifactId} to read.",
        "Both the workspace collar and your delegation collar must allow an action (stricter wins).",
      ];

      return reply.send({
        ok: true,
        data: {
          workspace: {
            workspace_id: workspace.workspace_id,
            name: workspace.name,
            description: workspace.description,
            collar_id: workspace.collar_id,
            status: workspace.status,
            participant_count: workspace.participant_delegation_ids.length,
            task_counts: {
              open: allTasks.filter((t) => t.status === "open").length,
              in_progress: allTasks.filter((t) => t.status === "in_progress").length,
              completed: allTasks.filter((t) => t.status === "completed").length,
            },
            artifact_count: allArtifacts.length,
            created_at: workspace.created_at,
          },
          identity: {
            delegation_id: delegation.id,
            agent_name: delegation.agent_name,
          },
          effective_permissions: perms,
          task_summary: {
            assigned_to_me: assignedToMe.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              assignment_type: t.assignment_type,
              created_at: t.created_at,
              updated_at: t.updated_at,
            })),
            eligible: eligible.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              assignment_type: t.assignment_type,
              required_collar_id: t.required_collar_id,
              created_at: t.created_at,
              updated_at: t.updated_at,
            })),
            open: openUnassigned.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              created_at: t.created_at,
              updated_at: t.updated_at,
            })),
            mine: mineTasks.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              created_at: t.created_at,
              updated_at: t.updated_at,
              completed_at: t.completed_at,
            })),
            recently_completed: recentlyCompleted.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              completed_at: t.completed_at,
              assigned_delegation_id: t.assigned_delegation_id,
            })),
            not_eligible: notEligible,
          },
          artifacts: allArtifacts.map((a) => ({
            artifact_id: a.artifact_id,
            name: a.name,
            kind: a.kind,
            size_bytes: Buffer.byteLength(a.content, "utf8"),
            task_id: a.task_id,
            created_by_delegation_id: a.created_by_delegation_id,
            created_at: a.created_at,
          })),
          workflow_rules: workflowRules,
          operations,
          next_actions: nextActions,
        },
      });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/tasks
   * Lists open tasks and tasks assigned to the calling delegation.
   * Optional ?status= filter (open | in_progress | completed | cancelled).
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/tasks",
    async (req: FastifyRequest<{ Params: { workspaceId: string }; Querystring: { status?: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_task_list");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      let tasks = Array.from(workspaceTasks.values()).filter(
        (t) => t.workspace_id === workspace.workspace_id,
      );

      const statusFilter = req.query.status;
      if (statusFilter) {
        tasks = tasks.filter((t) => t.status === statusFilter);
      } else {
        // Default: open tasks + tasks assigned to this delegation
        tasks = tasks.filter(
          (t) => t.status === "open" || t.assigned_delegation_id === delegation.id,
        );
      }

      return reply.send({
        ok: true,
        data: tasks.map((t) => ({
          task_id: t.task_id,
          title: t.title,
          description: t.description,
          status: t.status,
          is_mine: t.assigned_delegation_id === delegation.id,
          created_at: t.created_at,
          updated_at: t.updated_at,
          completed_at: t.completed_at,
        })),
      });
    },
  );

  /**
   * PATCH /api/agent/v1/workspaces/:workspaceId/tasks/:taskId
   * Body: { action: "claim" | "complete" }
   * claim    — enforce eligibility, then set status=in_progress (idempotent if already mine)
   *            assigned_delegation_id on an open/delegation task = reserved claimant;
   *            once in_progress it becomes the actual claimant (same field, different semantic).
   * complete — set status=completed (only if assigned to this delegation)
   */
  server.patch(
    "/api/agent/v1/workspaces/:workspaceId/tasks/:taskId",
    async (req: FastifyRequest<{ Params: { workspaceId: string; taskId: string }; Body: { action?: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;

      const { action } = req.body ?? {};

      // Validate action before permission check so unknown actions always return INVALID_ACTION
      if (action !== "claim" && action !== "complete") {
        return sendError(reply, 400, "INVALID_ACTION", "action must be \"claim\" or \"complete\".");
      }

      const wsAction = action === "complete" ? "workspace_task_complete" : "workspace_task_claim";
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, wsAction);
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const task = workspaceTasks.get(req.params.taskId);
      if (!task || task.workspace_id !== workspace.workspace_id) {
        return sendError(reply, 404, "TASK_NOT_FOUND", "Task not found in this workspace.");
      }

      if (action === "claim") {
        // Idempotent: already claimed by this delegation
        if (task.status === "in_progress" && task.assigned_delegation_id === delegation.id) {
          return reply.send({ ok: true, data: { ...task, is_mine: true } });
        }
        // Already claimed by someone else
        if (task.status === "in_progress") {
          return sendError(reply, 409, "TASK_ALREADY_CLAIMED", "Task is already claimed by another agent.");
        }
        if (task.status !== "open") {
          return sendError(reply, 409, "TASK_ALREADY_CLAIMED", "Task is not open.");
        }
        // Eligibility check: assignment_type governs who may claim an open task
        const eligibility = checkTaskEligibility(task, delegation);
        if (!eligibility.ok) {
          return sendError(reply, 403, eligibility.code, eligibility.message);
        }
        const now = new Date().toISOString();
        task.status = "in_progress";
        task.assigned_delegation_id = delegation.id;
        task.updated_at = now;
        workspaceTasks.set(task.task_id, task);
        emitWorkspaceAudit({ workspace_id: workspace.workspace_id, task_id: task.task_id, delegation_id: delegation.id, event_type: "task_claimed" });
        return reply.send({ ok: true, data: { ...task, is_mine: true } });
      }

      if (task.assigned_delegation_id !== delegation.id) {
        return sendError(reply, 403, "TASK_NOT_ASSIGNED", "You can only complete tasks assigned to your delegation.");
      }
      if (task.status !== "in_progress") {
        return sendError(reply, 409, "TASK_NOT_IN_PROGRESS", "Task must be in_progress to complete.");
      }
      const now = new Date().toISOString();
      task.status = "completed";
      task.completed_at = now;
      task.updated_at = now;
      workspaceTasks.set(task.task_id, task);
      emitWorkspaceAudit({ workspace_id: workspace.workspace_id, task_id: task.task_id, delegation_id: delegation.id, event_type: "task_completed" });
      return reply.send({ ok: true, data: { ...task, is_mine: true } });
    },
  );

  /**
   * POST /api/agent/v1/workspaces/:workspaceId/artifacts
   * Creates a text artifact. Content max 50KB. Never returns content in the response.
   */
  server.post(
    "/api/agent/v1/workspaces/:workspaceId/artifacts",
    async (req: FastifyRequest<{ Params: { workspaceId: string }; Body: { name?: string; kind?: string; content?: string; task_id?: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_artifact_create");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const { name, kind, content, task_id } = req.body ?? {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return sendError(reply, 400, "MISSING_NAME", "name is required.");
      }
      if (!kind || !VALID_ARTIFACT_KINDS.has(kind as WorkspaceArtifactKind)) {
        return sendError(reply, 400, "INVALID_ARTIFACT_KIND", `kind must be one of: ${[...VALID_ARTIFACT_KINDS].join(", ")}.`);
      }
      if (typeof content !== "string") {
        return sendError(reply, 400, "MISSING_CONTENT", "content is required and must be a string.");
      }
      if (Buffer.byteLength(content, "utf8") > ARTIFACT_MAX_BYTES) {
        return sendError(reply, 400, "ARTIFACT_TOO_LARGE", "Artifact content exceeds 50KB limit.");
      }
      if (task_id !== undefined) {
        const linkedTask = workspaceTasks.get(task_id);
        if (!linkedTask || linkedTask.workspace_id !== workspace.workspace_id) {
          return sendError(reply, 400, "INVALID_TASK_REFERENCE", "task_id does not reference a task in this workspace.");
        }
      }

      const now = new Date().toISOString();
      const artifact = {
        artifact_id: newId("artifact"),
        workspace_id: workspace.workspace_id,
        name: name.trim(),
        kind: kind as WorkspaceArtifactKind,
        content,
        ...(task_id !== undefined ? { task_id } : {}),
        created_by_delegation_id: delegation.id,
        created_at: now,
      };
      workspaceArtifacts.set(artifact.artifact_id, artifact);
      emitWorkspaceAudit({ workspace_id: workspace.workspace_id, artifact_id: artifact.artifact_id, task_id, delegation_id: delegation.id, event_type: "artifact_created" });

      // Never return content in POST response
      return reply.status(201).send({
        ok: true,
        data: {
          artifact_id: artifact.artifact_id,
          workspace_id: artifact.workspace_id,
          name: artifact.name,
          kind: artifact.kind,
          size_bytes: Buffer.byteLength(content, "utf8"),
          ...(task_id !== undefined ? { task_id } : {}),
          created_by_delegation_id: artifact.created_by_delegation_id,
          created_at: artifact.created_at,
        },
      });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/artifacts
   * Lists artifact metadata. Never includes content.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/artifacts",
    async (req: FastifyRequest<{ Params: { workspaceId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_artifact_list");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const artifacts = Array.from(workspaceArtifacts.values())
        .filter((a) => a.workspace_id === workspace.workspace_id)
        .map((a) => ({
          artifact_id: a.artifact_id,
          workspace_id: a.workspace_id,
          name: a.name,
          kind: a.kind,
          size_bytes: Buffer.byteLength(a.content, "utf8"),
          task_id: a.task_id,
          created_by_delegation_id: a.created_by_delegation_id,
          created_at: a.created_at,
        }));

      return reply.send({ ok: true, data: artifacts });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/artifacts/:artifactId
   * Returns artifact including content. Participant access only.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/artifacts/:artifactId",
    async (req: FastifyRequest<{ Params: { workspaceId: string; artifactId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_artifact_read");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const artifact = workspaceArtifacts.get(req.params.artifactId);
      if (!artifact || artifact.workspace_id !== workspace.workspace_id) {
        return sendError(reply, 404, "ARTIFACT_NOT_FOUND", "Artifact not found in this workspace.");
      }

      return reply.send({
        ok: true,
        data: {
          artifact_id: artifact.artifact_id,
          workspace_id: artifact.workspace_id,
          name: artifact.name,
          kind: artifact.kind,
          content: artifact.content,
          size_bytes: Buffer.byteLength(artifact.content, "utf8"),
          task_id: artifact.task_id,
          created_by_delegation_id: artifact.created_by_delegation_id,
          created_at: artifact.created_at,
        },
      });
    },
  );
}
