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
} from "@aegis/types";
import {
  agentDelegations,
  skills,
  installedSkills,
  routes,
  routeRuns,
  collars,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
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
}
