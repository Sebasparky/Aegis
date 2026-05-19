import type { FastifyInstance } from "fastify";
import type { RouteRun, RouteRunReceipt, RouteRunStatus, AegisExecutionSurface, AuthorizationActionType, AuthorizationRiskTier, ApprovalManifest, ApprovalManifestLineItem, RunApprovalContext } from "@aegis/types";
import { users, skills, installedSkills, routes, routeRuns, agentDelegations, collars, aegisVaultPasses, encryptedSecretVault, routePassBindings, delegationPassports, actionAuthorizations, paymentMethods, spendingLimitStepUps, userApprovalReceipts, MOCK_USER_ID, newId } from "../store/index.js";
import { resolveEffectiveCollar } from "../lib/collarPolicy.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { getKmsProvider, type KmsContext } from "../lib/kms.js";
import { schedulePersist } from "../store/persistence.js";
import { resolveRouteStepValue } from "../lib/secretResolution.js";
import { hashActionAuthorization, signActionAuthorizationJws } from "../lib/actionAuthorizationSigning.js";
import { buildSignedUserApprovalReceipt } from "../lib/userApprovalReceiptSigning.js";

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
    ? "the Antigen Playwright runtime"
    : "the Antigen browser extension";

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

function deriveActionType(permissions: string[]): AuthorizationActionType {
  if (permissions.includes("travel_booking")) return "travel_booking";
  if (permissions.includes("payment") || permissions.includes("purchase")) return "payment";
  if (permissions.includes("identity_disclosure")) return "identity_disclosure";
  if (permissions.includes("account_deletion") || permissions.includes("delete_account")) return "destructive_action";
  if (permissions.includes("credential_fill")) return "credential_fill";
  if (permissions.includes("login")) return "login";
  return "login";
}

function deriveRiskTier(permissions: string[]): AuthorizationRiskTier {
  if (permissions.some((p) => ["identity_disclosure", "account_deletion", "delete_account"].includes(p))) return "critical";
  if (permissions.some((p) => ["payment", "purchase", "financial_action", "travel_booking"].includes(p))) return "high";
  if (permissions.some((p) => ["login", "credential_fill", "submit_form"].includes(p))) return "medium";
  return "low";
}

function buildRunApprovalContext(runId: string): RunApprovalContext | null {
  const run = routeRuns.get(runId);
  if (!run) return null;

  const route = routes.get(run.route_id);
  const skill = skills.get(run.skill_id);
  const collar = run.collar_id ? collars.get(run.collar_id) : undefined;
  const delegation = run.delegation_id ? agentDelegations.get(run.delegation_id) : undefined;

  const userPaymentMethod =
    Array.from(paymentMethods.values()).find((pm) => (pm as any).user_id === MOCK_USER_ID) ??
    Array.from(paymentMethods.values())[0];

  const permissions = run.approval_required_permissions ?? [];

  const taskCategory = permissions.includes("travel_booking")
    ? "travel_booking"
    : permissions.includes("login")
    ? "login"
    : permissions.includes("payment")
    ? "payment"
    : permissions.includes("purchase")
    ? "purchase"
    : permissions[0] ?? "unknown";

  let manifest: ApprovalManifest;

  if (taskCategory === "travel_booking") {
    const steps = route?.steps ?? [];
    const getSafeLiteral = (intent: string): string | undefined => {
      const step = steps.find((s) => s.intent === intent);
      return step?.value_policy?.type === "safe_literal" ? step.value_policy.value : undefined;
    };

    const passenger = getSafeLiteral("fill_passenger_name");
    const fromCity = getSafeLiteral("fill_from_city");
    const toCity = getSafeLiteral("fill_to_city");
    const rawDate = getSafeLiteral("fill_departure_date");
    const departureFormatted = rawDate
      ? new Date(rawDate + "T12:00:00Z").toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })
      : undefined;

    const lineItems: ApprovalManifestLineItem[] = [];
    if (passenger) lineItems.push({ label: "Passenger", value: passenger });
    if (fromCity && toCity) lineItems.push({ label: "Route", value: `${fromCity} → ${toCity}` });
    if (departureFormatted) lineItems.push({ label: "Departure", value: departureFormatted });
    lineItems.push({ label: "Fare (demo)", value: "$248.00 USD", tone: "money" });
    lineItems.push({ label: "Website", value: run.domain });

    const subtitle = fromCity && toCity ? `${fromCity} → ${toCity}` : (route?.workflow_description ?? "");

    const payLabel = userPaymentMethod
      ? `${userPaymentMethod.label} ending ${userPaymentMethod.last4}`
      : "Demo card only";

    const collarMax = collar?.spending_limits?.max_with_approval;
    const stepUp = spendingLimitStepUps.get(runId);
    const effectiveLimit = stepUp?.approved_limit_usd ?? collarMax;
    const fareAmount = 248;
    const isOverLimit = effectiveLimit !== undefined && fareAmount > effectiveLimit;
    const hasApprovedStepUp = stepUp !== undefined && stepUp.approved_limit_usd >= fareAmount;

    const constraintWarnings: string[] = [];
    let approvalBlocked = false;
    let approvalBlockReason: string | undefined;
    let spendingStepUp: ApprovalManifest["spending_step_up"] | undefined;

    if (hasApprovedStepUp) {
      constraintWarnings.push(
        `One-time spending limit approved for this run: $${stepUp.approved_limit_usd.toFixed(2)}.`
      );
      spendingStepUp = {
        required: false,
        requested_amount_usd: fareAmount,
        approved_amount_usd: stepUp.approved_limit_usd,
        currency: "USD",
        status: "approved",
        scope: "this_run_only",
      };
    } else if (isOverLimit) {
      approvalBlocked = true;
      approvalBlockReason = "This purchase exceeds the approved spending limit.";
      constraintWarnings.push(
        `Estimated fare $${fareAmount.toFixed(2)} exceeds the current approved limit of $${effectiveLimit!.toFixed(2)}.`
      );
      spendingStepUp = {
        required: true,
        requested_amount_usd: fareAmount,
        currency: "USD",
        status: "not_requested",
        scope: "this_run_only",
      };
    }

    manifest = {
      title: skill?.name ?? route?.workflow_name ?? "Book flight",
      subtitle,
      task_category: taskCategory,
      primary_action_label: "Book flight",
      risk_tier: route?.risk_level ?? "high",
      line_items: lineItems,
      capabilities_to_release: ["payment_method"],
      custody_guarantees: [
        "Raw card data will not be shown to the agent",
        "Payment is processed in the Antigen-controlled runtime only",
      ],
      spending_limit: {
        ...(collarMax !== undefined ? { max_amount_usd: collarMax } : {}),
        currency: "USD",
        payment_instrument_label: payLabel,
      },
      runtime_guarantees: [
        "Antigen executes this in an isolated Playwright browser session",
        "Coverage violation detection blocks unexpected sensitive actions",
        "A signed execution receipt is created and linked to this approval",
      ],
      website_context: {
        domain: run.domain,
        policy_status: "policy_found",
        safety_recommendation: "allow_with_approval",
      },
      purchase_amount: { amount_usd: fareAmount, currency: "USD", label: "Fare (demo)" },
      ...(constraintWarnings.length > 0 ? { constraint_warnings: constraintWarnings } : {}),
      ...(approvalBlocked ? { approval_blocked: true, approval_block_reason: approvalBlockReason } : {}),
      ...(spendingStepUp ? { spending_step_up: spendingStepUp } : {}),
    };
  } else if (taskCategory === "login") {
    const lineItems: ApprovalManifestLineItem[] = [
      { label: "Website", value: run.domain },
      { label: "Login type", value: "Username + password (Antigen-managed)" },
    ];

    manifest = {
      title: `Log in to ${run.domain}`,
      subtitle: "Antigen fills credentials without showing them to the agent",
      task_category: taskCategory,
      primary_action_label: "Allow login",
      risk_tier: route?.risk_level ?? "high",
      line_items: lineItems,
      capabilities_to_release: ["login_credential"],
      custody_guarantees: [
        "Password is filled by Antigen — never shown to the agent",
        "Credentials come from your Antigen vault, not from the agent",
      ],
      runtime_guarantees: [
        "Antigen executes this in an isolated Playwright browser session",
        "A signed execution receipt is created and linked to this approval",
      ],
      website_context: {
        domain: run.domain,
        policy_status: "policy_found",
        safety_recommendation: "allow_with_approval",
      },
    };
  } else {
    const lineItems: ApprovalManifestLineItem[] = [
      { label: "Website", value: run.domain },
      { label: "Permissions", value: permissions.join(", ") || "—" },
    ];

    manifest = {
      title: skill?.name ?? route?.workflow_name ?? "Agent action",
      subtitle: route?.workflow_description ?? `Requesting: ${permissions.join(", ")}`,
      task_category: taskCategory,
      primary_action_label: "Allow action",
      risk_tier: route?.risk_level ?? "medium",
      line_items: lineItems,
      capabilities_to_release: permissions,
      custody_guarantees: [
        "Sensitive operations are executed by Antigen, not exposed directly to the agent",
      ],
      runtime_guarantees: [
        "Antigen executes this in an isolated Playwright browser session",
        "A signed execution receipt is created and linked to this approval",
      ],
      website_context: {
        domain: run.domain,
      },
    };
  }

  return {
    run_id: run.run_id,
    manifest,
    skill_name: skill?.name,
    route_name: route?.workflow_name,
    agent_id: delegation?.agent_name ?? run.agent_id,
    execution_surface: run.claimed_execution_surface,
  };
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
      (d) => d.user_id === MOCK_USER_ID && d.token_id === token
    );

    if (!delegation) {
      return sendError(reply, 401, "INVALID_TOKEN", "Token does not match any delegation.");
    }

    if (delegation.status === "revoked") {
      return sendError(reply, 401, "DELEGATION_REVOKED", "This delegation has been revoked.");
    }

    if (delegation.status === "expired" || (delegation.expires_at && new Date(delegation.expires_at) < new Date())) {
      delegation.status = "expired";
      delegation.updated_at = new Date().toISOString();
      agentDelegations.set(delegation.id, delegation);
      schedulePersist();
      return sendError(reply, 401, "DELEGATION_EXPIRED", "This delegation has expired. Request a new delegation.");
    }

    const agent_id = delegation.agent_name;
    const delegation_id = delegation.id;

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

    const collarResult = resolveEffectiveCollar(delegation, collars);
    if (!collarResult.ok) {
      return sendError(reply, collarResult.status, collarResult.code, collarResult.message);
    }
    const { collar, policy_mode } = collarResult;
    const effectiveCollarId = policy_mode === "collar" ? collar.id : undefined;

    // Permission enforcement — works identically for real collar and baseline policy.
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
        ...(effectiveCollarId ? { collar_id: effectiveCollarId } : {}),
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
      ...(effectiveCollarId ? { collar_id: effectiveCollarId } : {}),
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
      const approvedAt = new Date().toISOString();

      // ActionAuthorizationReceipt is the blocking authorization proof for route-run approvals.
      // run.status is NOT mutated until signing succeeds — fail closed on signing failure.
      // Note: a UserApprovalReceipt for the user's approval click may be added in a future increment.
      try {
        const user = users.get(run.user_id);
        const delegation = run.delegation_id ? agentDelegations.get(run.delegation_id) : undefined;
        const collar = run.collar_id ? collars.get(run.collar_id) : undefined;

        // Find the active delegation passport for this delegation (if one was issued)
        const passport = run.delegation_id
          ? Array.from(delegationPassports.values()).find(
              (p) => p.delegation.delegation_id === run.delegation_id && p.status === "active"
            )
          : undefined;

        const permissions = run.approval_required_permissions ?? [];
        const action_type = deriveActionType(permissions);
        const risk_tier = deriveRiskTier(permissions);

        const authorization_id = newId("authz");
        const authWithoutVerification = {
          authorization_id,
          issuer: "aegis.dev",
          issued_at: approvedAt,
          status: "active" as const,
          user_id: run.user_id,
          user_aegis_id: user?.aegis_id ?? run.user_id,
          agent_id: delegation?.agent_name ?? run.agent_id ?? "unknown",
          delegation_id: run.delegation_id ?? "",
          passport_id: passport?.passport_id,
          passport_hash: passport?.verification.passport_hash,
          run_id: run.run_id,
          route_id: run.route_id,
          skill_id: run.skill_id,
          domain: run.domain,
          action: {
            action_type,
            human_readable_summary: `User approved ${action_type} for ${run.domain} via skill ${run.skill_id ?? run.route_id}`,
            risk_tier,
            requires_user_approval: true,
          },
          constraints: {
            allowed_domains: [run.domain],
            ...(["travel_booking", "payment", "purchase"].includes(action_type) && {
              max_amount_usd: spendingLimitStepUps.get(run.run_id)?.approved_limit_usd
                ?? collar?.spending_limits?.max_with_approval
                ?? 500,
              currency: "USD",
              allowed_payment_instrument_types: ["demo_card"],
            }),
            approval_required_for: permissions,
          },
          approval: {
            approval_method: "user_click" as const,
            approved_at: approvedAt,
            approval_ui_version: "route-run-approvals-v1",
            approval_text_shown: action_type === "travel_booking"
              ? `Book demo flight on ${run.domain} (max $${spendingLimitStepUps.get(run.run_id)?.approved_limit_usd ?? collar?.spending_limits?.max_with_approval ?? 500} USD, Antigen Demo Card ending 4242)`
              : action_type === "payment"
              ? `Approve payment on ${run.domain} (max $${spendingLimitStepUps.get(run.run_id)?.approved_limit_usd ?? collar?.spending_limits?.max_with_approval ?? 500} USD, demo card only)`
              : `Approve ${action_type} on ${run.domain}?`,
            liability_terms_version: "aegis-v1",
            user_liability_acknowledged: true,
          },
          custody: {
            agent_receives_raw_credentials: false as const,
            agent_receives_raw_payment_data: false as const,
            agent_receives_raw_identity_documents: false as const,
            capability_release_model: "aegis_controlled_runtime" as const,
          },
        };

        const authorization_hash = hashActionAuthorization(authWithoutVerification);
        const authorization_jws = await signActionAuthorizationJws({
          typ: "aegis.action_authorization.v1",
          authorization_id,
          authorization_hash,
          issuer: "aegis.dev",
          issued_at: approvedAt,
          user_aegis_id: authWithoutVerification.user_aegis_id,
          agent_id: authWithoutVerification.agent_id,
          delegation_id: authWithoutVerification.delegation_id,
          run_id: run.run_id,
          action_type,
          risk_tier,
        });

        const fullAuth = { ...authWithoutVerification, verification: { authorization_hash, authorization_jws } };
        actionAuthorizations.set(authorization_id, fullAuth);
        run.authorization_id = authorization_id;
        run.authorization_hash = authorization_hash;
      } catch {
        // Signing failure is fail-closed — run stays at pending_approval, no authority released.
        return sendError(reply, 500, "APPROVAL_RECEIPT_SIGNING_FAILED", "Unable to create signed authorization receipt. Approval not processed.");
      }

      // Only mutate run status after signed authorization proof exists.
      run.status = "pending";
      run.approved_at = approvedAt;
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
   * GET /api/route-runs/:runId/approval-context
   *
   * Returns a human-readable ApprovalManifest for a pending_approval run.
   * Assembles safe context from route step safe_literal values, collar spending limits,
   * and payment method metadata. Never exposes secrets, secret_ref, pass_id, KMS data,
   * card PAN, CVV, or credential values.
   */
  server.get<{ Params: { runId: string } }>(
    "/api/route-runs/:runId/approval-context",
    async (req, reply) => {
      const context = buildRunApprovalContext(req.params.runId);
      if (!context) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
      return reply.send({ ok: true, data: context });
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
    const rejectedAt = new Date().toISOString();
    run.status = "blocked";
    run.error = req.body?.reason ?? "Rejected by user.";
    routeRuns.set(run.run_id, run);

    // Create a signed liability receipt for this user rejection (non-blocking).
    const delegation = run.delegation_id ? agentDelegations.get(run.delegation_id) : undefined;
    const collar = run.collar_id ? collars.get(run.collar_id) : undefined;
    const receipt_id = newId("uar");
    buildSignedUserApprovalReceipt({
      receipt_id,
      receipt_type: "user_approval",
      schema_version: "1.0",
      issuer: "aegis",
      created_at: rejectedAt,
      user_id: run.user_id,
      user_aegis_id: users.get(run.user_id)?.aegis_id,
      delegation_id: delegation?.id,
      agent_name: delegation?.agent_name,
      agent_platform: delegation?.agent_platform,
      collar_id: run.collar_id,
      approval_id: run.run_id,
      approval_source: "route_run_rejection",
      route_run_id: run.run_id,
      action_type: (run.approval_required_permissions ?? []).join(", ") || undefined,
      requested_action_summary: (run.approval_required_permissions ?? []).join(", ") || undefined,
      target_domain: run.domain,
      decision: "denied",
      decided_at: rejectedAt,
      decision_source: "user_click",
      scope_shown: collar
        ? {
            collar_name: collar.name,
            approval_required_actions: collar.approval_required_actions as string[],
            spending_limit_max_with_approval: collar.spending_limits.max_with_approval,
            currency: "USD",
          }
        : undefined,
      raw_secrets_in_receipt: false,
      raw_credentials_in_receipt: false,
    })
      .then((receipt) => {
        userApprovalReceipts.set(receipt.receipt_id, receipt);
        schedulePersist();
      })
      .catch((err) => {
        console.error("[route-runs] Failed to create user rejection receipt:", err);
      });

    schedulePersist();
    return { ok: true, data: run };
  });

  /**
   * POST /api/route-runs/:runId/spending-step-up
   *
   * User-only: approve a one-time spending limit for a pending_approval run.
   * Does NOT mutate the collar. Not exposed via /api/agent/v1.
   * Returns the updated RunApprovalContext so the UI can reflect the new limit immediately.
   */
  server.post<{
    Params: { runId: string };
    Body: { requested_limit_usd: number; currency?: string };
  }>("/api/route-runs/:runId/spending-step-up", async (req, reply) => {
    const run = routeRuns.get(req.params.runId);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
    if (run.status !== "pending_approval") {
      return sendError(reply, 400, "INVALID_STATE", `Run is not pending approval (status: ${run.status}).`);
    }

    const permissions = run.approval_required_permissions ?? [];
    const isPaymentRun = permissions.some((p) =>
      ["travel_booking", "payment", "purchase", "financial_action"].includes(p)
    );
    if (!isPaymentRun) {
      return sendError(reply, 400, "NOT_APPLICABLE", "Spending step-up only applies to payment/travel runs.");
    }

    const { requested_limit_usd } = req.body ?? {};
    if (typeof requested_limit_usd !== "number" || requested_limit_usd <= 0 || requested_limit_usd > 1000) {
      return sendError(reply, 400, "INVALID_AMOUNT", "requested_limit_usd must be a positive number up to 1000.");
    }

    const collar = run.collar_id ? collars.get(run.collar_id) : undefined;
    spendingLimitStepUps.set(run.run_id, {
      run_id: run.run_id,
      original_limit_usd: collar?.spending_limits?.max_with_approval,
      requested_limit_usd,
      approved_limit_usd: requested_limit_usd,
      currency: "USD",
      scope: "this_run_only",
      approved_at: new Date().toISOString(),
      approved_by: "user",
    });
    schedulePersist();

    const context = buildRunApprovalContext(run.run_id);
    if (!context) return sendError(reply, 500, "INTERNAL_ERROR", "Failed to build updated approval context.");
    return reply.send({ ok: true, data: context });
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
   * Secret values are never returned to agents — only the Antigen extension calls this endpoint.
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
