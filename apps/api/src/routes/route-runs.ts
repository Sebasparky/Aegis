import type { FastifyInstance } from "fastify";
import type { RouteRun, RouteRunReceipt, RouteRunStatus, AegisExecutionSurface } from "@aegis/types";
import { skills, installedSkills, routes, routeRuns, agentDelegations, collars, aegisVaultPasses, encryptedSecretVault, routePassBindings, MOCK_USER_ID, newId } from "../store/index.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { getKmsProvider, type KmsContext } from "../lib/kms.js";
import { schedulePersist } from "../store/persistence.js";
import { resolveRouteStepValue } from "../lib/secretResolution.js";

export function buildReceipt(
  run: RouteRun,
  status: "completed" | "failed",
  error?: string,
  executionSurface: AegisExecutionSurface = "chrome_extension"
): RouteRunReceipt {
  const skill = skills.get(run.skill_id);
  const route = routes.get(run.route_id);
  const skillName = skill?.name ?? run.skill_id;
  const routeName = route?.workflow_name ?? run.route_id;
  const trustTier = route?.trust_tier ?? "unknown";
  const now = new Date().toISOString();

  const surfaceLabel = executionSurface === "aegis_playwright"
    ? "the Aegis Playwright runtime"
    : "the Aegis browser extension";

  const allowed_reason = status === "completed"
    ? `Skill "${skillName}" was installed for user_001. Route domain matched ${run.domain}. Execution was completed through ${surfaceLabel}.`
    : `Skill "${skillName}" was installed for user_001. Route domain matched ${run.domain}. Execution was attempted through ${surfaceLabel} but failed: ${error ?? "unknown error"}.`;

  const receipt: RouteRunReceipt = {
    receipt_id: newId("rrreceipt"),
    run_id: run.run_id,
    skill_id: run.skill_id,
    route_id: run.route_id,
    installed_skill_id: run.installed_skill_id,
    user_id: run.user_id,
    domain: run.domain,
    status,
    allowed_reason,
    execution_surface: executionSurface,
    route_trust_tier: trustTier,
    skill_name: skillName,
    route_name: routeName,
    created_at: run.created_at,
    completed_at: now,
    ...(run.agent_id ? { agent_id: run.agent_id } : {}),
    ...(run.variables && Object.keys(run.variables).length > 0 ? { variables: run.variables } : {}),
    ...(error ? { error } : {}),
    credential_used: run.credential_used ?? false,
    pass_ids_used: run.pass_ids_used ?? [],
    secret_values_revealed_to_agent: false as const,
  };
  return receipt;
}

function isTerminalStatus(status: RouteRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked";
}

const ALLOWED_DOMAINS = new Set(["en.wikipedia.org", "localhost", "test.aegis.local"]);

function sendError(reply: any, status: number, code: string, message: string, details?: string) {
  return reply.status(status).send({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

export async function routeRunRoutes(server: FastifyInstance) {
  /**
   * POST /api/skills/:skillId/runs
   *
   * A third-party agent requests execution of an installed skill.
   * Creates a RouteRun with status "pending". Does not execute browser actions.
   */
  server.post<{
    Params: { skillId: string };
    Body: { variables?: Record<string, string>; pass_overrides?: Record<string, string> };
  }>("/api/skills/:skillId/runs", async (req, reply) => {
    const { skillId } = req.params;
    const { variables, pass_overrides } = req.body ?? {};

    const authHeader = (req.headers["authorization"] as string | undefined) ?? "";
    const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
    const token = bearerMatch?.[1]?.trim();

    if (!token) {
      return sendError(reply, 401, "AUTH_REQUIRED", "Authorization: Bearer <token> is required.");
    }

    const delegation = Array.from(agentDelegations.values()).find(
      (d) => d.user_id === MOCK_USER_ID && d.status === "active" && d.token_id === token
    );

    if (!delegation) {
      return sendError(reply, 401, "INVALID_TOKEN", "Token does not match an active delegation.");
    }

    const agent_id = delegation.agent_name;
    const delegation_id = delegation.id;
    const collar_id = delegation.default_collar_id;

    const skill = skills.get(skillId);
    if (!skill) return sendError(reply, 404, "SKILL_NOT_FOUND", "Skill not found.");

    const installedSkill = Array.from(installedSkills.values()).find(
      (i) => i.skill_id === skillId && i.user_id === MOCK_USER_ID && i.enabled
    );
    if (!installedSkill) {
      return sendError(reply, 403, "SKILL_NOT_INSTALLED", "Skill is not installed or is disabled for this user.");
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
        `RouteRun is not supported for domain "${skill.domain}". Supported: ${[...ALLOWED_DOMAINS].join(", ")}.`
      );
    }

    const SUPPORTED_PURPOSES = new Set(["login_password"]);
    let validatedPassOverrides: Record<string, string> | undefined;

    if (pass_overrides && Object.keys(pass_overrides).length > 0) {
      const errors: string[] = [];
      validatedPassOverrides = {};
      for (const [purpose, passId] of Object.entries(pass_overrides)) {
        if (!SUPPORTED_PURPOSES.has(purpose)) {
          errors.push(`Unsupported purpose "${purpose}".`);
          continue;
        }
        const vaultPass = aegisVaultPasses.get(passId);
        if (!vaultPass) { errors.push(`Pass "${passId}" not found.`); continue; }
        if (vaultPass.user_id !== MOCK_USER_ID) { errors.push(`Pass "${passId}" does not belong to this user.`); continue; }
        if (vaultPass.kind !== purpose) { errors.push(`Pass "${passId}" has kind "${vaultPass.kind}" but purpose is "${purpose}".`); continue; }
        if (vaultPass.domain !== route.domain) { errors.push(`Pass "${passId}" domain "${vaultPass.domain}" does not match route domain "${route.domain}".`); continue; }
        if (!encryptedSecretVault.has(vaultPass.secret_ref)) { errors.push(`Pass "${passId}" has no secret available (server may have restarted or KMS not configured).`); continue; }
        validatedPassOverrides[purpose] = passId;
      }
      if (errors.length > 0) {
        return sendError(reply, 400, "INVALID_PASS_OVERRIDE", errors.join(" "));
      }
    }

    if (route.variables && route.variables.length > 0) {
      // Value policy types resolved internally — never required from the agent.
      const internalValuePolicyTypes = new Set(["pass_field", "secret_ref", "safe_literal"]);

      const missingRequired: string[] = [];
      for (const v of route.variables) {
        const hasDefault = v.default_value !== undefined && v.default_value !== "";
        const supplied = variables && v.name in variables;
        // Skip if the bound step resolves the value internally (pass, secret, or literal).
        const boundStep = route.steps.find((s) => s.step_id === v.step_id);
        const isInternallyResolved = boundStep?.value_policy && internalValuePolicyTypes.has(boundStep.value_policy.type);
        if (!hasDefault && !supplied && !isInternallyResolved) {
          missingRequired.push(v.name);
        }
      }
      if (missingRequired.length > 0) {
        return sendError(
          reply,
          400,
          "MISSING_VARIABLES",
          `Required variables not supplied: ${missingRequired.join(", ")}.`
        );
      }
    }

    const mode = delegation.skill_access_mode ?? "all";
    const ids = delegation.skill_access_skill_ids ?? [];
    if (mode === "exclude" && ids.includes(skillId)) {
      return sendError(reply, 403, "SKILL_ACCESS_DENIED", "This agent is not allowed to use this installed skill.");
    }
    if (mode === "only" && !ids.includes(skillId)) {
      return sendError(reply, 403, "SKILL_ACCESS_DENIED", "This agent is not allowed to use this installed skill.");
    }

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
          // else: in allowed_actions — fine
        }

        if (hardBlocked.length > 0) {
          return sendError(
            reply,
            403,
            "COLLAR_BLOCKED",
            "This agent's collar does not allow this route.",
            `Permission(s) blocked or unknown: ${hardBlocked.join(", ")}.`
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
            ...(validatedPassOverrides && Object.keys(validatedPassOverrides).length > 0 ? { pass_overrides: validatedPassOverrides } : {}),
            ...(delegation_id ? { delegation_id } : {}),
            ...(collar_id ? { collar_id } : {}),
          };
          routeRuns.set(run.run_id, run);
          schedulePersist();
          return {
            ok: true,
            data: {
              run,
              approval_required: true,
              approval_required_permissions: needsApproval,
              message: `This run requires approval for: ${needsApproval.join(", ")}.`,
            },
          };
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
      ...(validatedPassOverrides && Object.keys(validatedPassOverrides).length > 0 ? { pass_overrides: validatedPassOverrides } : {}),
      ...(delegation_id ? { delegation_id } : {}),
      ...(collar_id ? { collar_id } : {}),
    };

    routeRuns.set(run.run_id, run);
    schedulePersist();

    return { ok: true, data: run };
  });

  /**
   * GET /api/route-runs
   *
   * List route runs. Optional filters: ?domain= and ?status=
   * Each result is joined with a skill and route summary.
   */
  server.get<{ Querystring: { domain?: string; status?: string } }>(
    "/api/route-runs",
    async (req) => {
      const { domain, status } = req.query;
      let list = Array.from(routeRuns.values()).filter((r) => r.user_id === MOCK_USER_ID);

      if (domain) list = list.filter((r) => r.domain === domain);
      if (status) list = list.filter((r) => r.status === status);

      const result = list
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((run) => {
          const skill = skills.get(run.skill_id);
          const route = routes.get(run.route_id);
          return {
            ...run,
            skill_summary: skill
              ? { skill_id: skill.skill_id, name: skill.name, domain: skill.domain, risk_level: skill.risk_level ?? null, execution_mode: skill.execution_mode ?? null, sensitivity_level: skill.sensitivity_level ?? null }
              : null,
            route_summary: route
              ? {
                  route_id: route.route_id,
                  workflow_name: route.workflow_name,
                  trust_tier: route.trust_tier,
                  step_count: route.steps.length,
                  domain: route.domain,
                  url_match: route.url_match ?? null,
                  start_url: route.start_url ?? null,
                }
              : null,
          };
        });

      return { ok: true, data: result };
    }
  );

  /**
   * POST /api/route-runs/:runId/complete
   *
   * Mark a run as completed.
   */
  server.post<{ Params: { runId: string } }>(
    "/api/route-runs/:runId/complete",
    async (req, reply) => {
      const run = routeRuns.get(req.params.runId);
      if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
      if (isTerminalStatus(run.status)) {
        return sendError(reply, 409, "ALREADY_TERMINAL", `Run is already in terminal status "${run.status}".`);
      }
      if (run.status !== "running") {
        return sendError(reply, 409, "INVALID_STATE", `Run cannot be completed from status "${run.status}". Expected "running".`);
      }

      run.status = "completed";
      run.completed_at = new Date().toISOString();
      routeRuns.set(run.run_id, run);

      const existingReceipt = await getReceiptRepository().findByRunId(run.run_id);
      if (!existingReceipt) {
        const receipt = buildReceipt(run, "completed");
        await getReceiptRepository().createReceipt(receipt);
      }

      schedulePersist();
      return { ok: true, data: run };
    }
  );

  /**
   * POST /api/route-runs/:runId/fail
   *
   * Mark a run as failed. Body: { "error": "reason" }
   */
  server.post<{
    Params: { runId: string };
    Body: { error?: string };
  }>("/api/route-runs/:runId/fail", async (req, reply) => {
    const run = routeRuns.get(req.params.runId);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
    if (isTerminalStatus(run.status)) {
      return sendError(reply, 409, "ALREADY_TERMINAL", `Run is already in terminal status "${run.status}".`);
    }
    if (run.status !== "running") {
      return sendError(reply, 409, "INVALID_STATE", `Run cannot be failed from status "${run.status}". Expected "running".`);
    }

    run.status = "failed";
    run.completed_at = new Date().toISOString();
    const failError = req.body?.error;
    if (failError) run.error = failError;
    routeRuns.set(run.run_id, run);

    const existingReceipt = await getReceiptRepository().findByRunId(run.run_id);
    if (!existingReceipt) {
      const receipt = buildReceipt(run, "failed", failError);
      await getReceiptRepository().createReceipt(receipt);
    }

    schedulePersist();
    return { ok: true, data: run };
  });

  /**
   * POST /api/route-runs/:runId/approve
   *
   * Approve a pending_approval run, transitioning it to pending status.
   * For aegis_controlled routes with a start_url, auto-starts the Playwright runtime
   * immediately after approval — no manual start command needed.
   */
  server.post<{ Params: { runId: string } }>(
    "/api/route-runs/:runId/approve",
    async (req, reply) => {
      const run = routeRuns.get(req.params.runId);
      if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
      if (run.status !== "pending_approval") {
        return sendError(reply, 400, "INVALID_STATE", `Run is not pending approval (status: ${run.status}).`);
      }
      run.status = "pending";
      run.approved_at = new Date().toISOString();
      run.approved_permissions = run.approval_required_permissions ?? [];

      const route = routes.get(run.route_id);
      const canAutoStart = route?.execution_mode === "aegis_controlled" && !!route.start_url;

      if (canAutoStart) {
        run.claimed_execution_surface = "aegis_playwright";
      }

      routeRuns.set(run.run_id, run);
      schedulePersist();

      if (canAutoStart) {
        // Fire-and-forget: auto-start Playwright runtime after approval.
        // Dynamic import avoids circular dependency (playwrightRuntime imports buildReceipt from this file).
        void (async () => {
          try {
            const { executeRouteRunWithPlaywright } = await import("../runtime/playwrightRuntime.js");
            await executeRouteRunWithPlaywright(run.run_id);
          } catch (err: any) {
            console.error("[auto-playwright] Failed to execute approved run", run.run_id, "—", err?.message);
          }
        })();
      }

      return { ok: true, data: run };
    }
  );

  /**
   * POST /api/route-runs/:runId/reject
   *
   * Reject a pending_approval run, blocking execution.
   */
  server.post<{
    Params: { runId: string };
    Body: { reason?: string };
  }>("/api/route-runs/:runId/reject", async (req, reply) => {
    const run = routeRuns.get(req.params.runId);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
    if (run.status !== "pending_approval") {
      return sendError(reply, 400, "INVALID_STATE", `Run is not pending approval (status: ${run.status}).`);
    }
    run.status = "blocked";
    run.error = req.body?.reason ?? "Rejected by user.";
    routeRuns.set(run.run_id, run);
    schedulePersist();
    return { ok: true, data: run };
  });

  /**
   * POST /api/route-runs/:runId/start
   *
   * Transition a pending run to running. Called by the extension
   * before injecting replay.js.
   */
  server.post<{ Params: { runId: string } }>(
    "/api/route-runs/:runId/start",
    async (req, reply) => {
      const run = routeRuns.get(req.params.runId);
      if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
      if (run.status !== "pending") {
        return sendError(reply, 409, "INVALID_STATE", `Run cannot be started from status "${run.status}". Expected "pending".`);
      }
      run.status = "running";
      run.started_at = new Date().toISOString();
      routeRuns.set(run.run_id, run);
      schedulePersist();
      return { ok: true, data: run };
    }
  );

  /**
   * POST /api/route-runs/:runId/resolve-value
   *
   * Extension-only: resolve a pass_field or secret_ref value during an approved running RouteRun.
   * Secret values are never returned to agents — only the Aegis extension calls this endpoint.
   */
  server.post<{
    Params: { runId: string };
    Body: { step_id: string };
  }>("/api/route-runs/:runId/resolve-value", async (req, reply) => {
    const { runId } = req.params;
    const { step_id } = req.body ?? {};

    const run = routeRuns.get(runId);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Run not found.");

    if (run.status !== "running")
      return sendError(reply, 409, "INVALID_STATE", `Run is not in running state (status: ${run.status}).`);

    const route = routes.get(run.route_id);
    if (!route) return sendError(reply, 404, "NOT_FOUND", "Route not found.");

    const step = route.steps.find((s) => s.step_id === step_id);
    if (!step) return sendError(reply, 404, "NOT_FOUND", "Step not found.");

    const vp = step.value_policy;
    if (!vp || (vp.type !== "pass_field" && vp.type !== "secret_ref"))
      return sendError(reply, 400, "NOT_PASS_STEP", "Step does not have a pass_field or secret_ref value policy.");

    if (vp.type === "secret_ref" && route.execution_mode !== "aegis_controlled")
      return sendError(reply, 403, "SECRET_NOT_ALLOWED", "Secret resolution requires aegis_controlled execution mode.");

    if (run.approval_required_permissions && run.approval_required_permissions.length > 0 && !run.approved_at)
      return sendError(reply, 403, "SECRET_NOT_ALLOWED", "Run requires approval before secret can be resolved.");

    let resolved: { value: string; redacted: boolean; pass_id: string };
    try {
      resolved = await resolveRouteStepValue(run, step);
    } catch (err: any) {
      console.error("[route-runs] resolve-value failed:", err?.message);
      return sendError(reply, 400, "RESOLVE_FAILED", err?.message ?? "Failed to resolve credential.");
    }

    // Track pass usage on the run — receipt will include this metadata
    run.credential_used = true;
    run.secret_values_revealed_to_agent = false;
    run.pass_ids_used = Array.from(new Set([...(run.pass_ids_used ?? []), resolved.pass_id]));
    routeRuns.set(runId, run);
    schedulePersist();

    return reply.send({ ok: true, data: { value: resolved.value, value_source: vp.type, pass_id: resolved.pass_id, redacted: resolved.redacted } });
  });
}
