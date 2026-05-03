import type { FastifyInstance } from "fastify";
import type {
  WebsiteAgentSafetyProfile,
  WebsiteVerificationLevel,
  WebsiteAgentSafetyStatus,
  DelegationTrustTaskCategory,
  RuntimeCapabilityType,
  ActionType,
  WebsiteAegisPolicy,
  WebsiteAegisPolicyValidationResult,
} from "@aegis/types";
import { routes, domainTrust, MOCK_USER_ID, newId } from "../store/index.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { getWebsiteAegisPolicyForDomain } from "./website-aegis-policy.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TASK_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "login", "credential_fill", "purchase", "payment", "travel_booking",
  "financial_action", "identity_disclosure", "account_change",
  "destructive_action", "message_send",
]);

// ActionType values that indicate a route supports a given task category.
// credential_fill maps to "login" because routes use the "login" ActionType.
const CATEGORY_PERMISSIONS: Record<DelegationTrustTaskCategory, ActionType[]> = {
  login: ["login"],
  credential_fill: ["login"],
  purchase: ["purchase"],
  payment: ["payment"],
  travel_booking: ["travel_booking", "payment"],
  financial_action: ["payment", "purchase", "financial_data_disclosure"],
  identity_disclosure: ["identity_disclosure", "government_id_upload", "medical_data_disclosure"],
  account_change: ["account_setting_change", "connect_app", "oauth_authorize"],
  destructive_action: ["delete_account"],
  message_send: ["direct_message", "send_email", "forward_email", "post_publicly", "comment"],
};

// Reverse: ActionType → task category for deriving supported categories from route permissions.
const PERMISSION_TO_CATEGORY: Partial<Record<ActionType, DelegationTrustTaskCategory>> = {
  login: "login",
  purchase: "purchase",
  payment: "payment",
  travel_booking: "travel_booking",
  identity_disclosure: "identity_disclosure",
  government_id_upload: "identity_disclosure",
  medical_data_disclosure: "identity_disclosure",
  financial_data_disclosure: "financial_action",
  account_setting_change: "account_change",
  delete_account: "destructive_action",
  connect_app: "account_change",
  oauth_authorize: "account_change",
  direct_message: "message_send",
  send_email: "message_send",
  forward_email: "message_send",
  post_publicly: "message_send",
  comment: "message_send",
};

// The Aegis capability type required to safely execute a task category.
const CATEGORY_CAPABILITY: Partial<Record<DelegationTrustTaskCategory, RuntimeCapabilityType>> = {
  login: "login_credential",
  credential_fill: "login_credential",
  purchase: "payment_method",
  payment: "payment_method",
  travel_booking: "payment_method",
  financial_action: "payment_method",
  identity_disclosure: "identity_profile",
};

const SENSITIVE_TRUST_TIERS = new Set(["aegis_scanned", "community_verified", "business_verified"]);

// ─── Route ────────────────────────────────────────────────────────────────────

export async function websiteAgentSafetyRoutes(app: FastifyInstance) {
  app.get("/api/website-agent-safety/profile", async (req, reply) => {
    const { domain, task_category } = req.query as Record<string, string>;

    if (!domain) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PARAM", message: "domain is required" } });
    }
    if (!task_category) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PARAM", message: "task_category is required" } });
    }
    if (!VALID_TASK_CATEGORIES.has(task_category as DelegationTrustTaskCategory)) {
      return reply.code(400).send({ ok: false, error: { code: "INVALID_TASK_CATEGORY", message: `task_category must be one of: ${[...VALID_TASK_CATEGORIES].join(", ")}` } });
    }

    const profile = await computeWebsiteAgentSafetyProfile(domain, task_category as DelegationTrustTaskCategory);
    return reply.send({ ok: true, data: profile });
  });
}

// ─── Shared profile computation (exported for reuse) ─────────────────────────

export async function computeWebsiteAgentSafetyProfile(
  domain: string,
  taskCategory: DelegationTrustTaskCategory
): Promise<WebsiteAgentSafetyProfile> {

  // 0. Attempt well-known policy fetch (best-effort; errors don't block profile)
  let wellKnownPolicy: WebsiteAegisPolicy | undefined;
  let policyValidation: WebsiteAegisPolicyValidationResult | undefined;
  try {
    const policyResult = await getWebsiteAegisPolicyForDomain(domain);
    wellKnownPolicy = policyResult.policy;
    policyValidation = policyResult.validation;
  } catch {
    // best-effort — errors don't block profile
  }
  const hasValidWellKnownPolicy =
    wellKnownPolicy !== undefined && policyValidation?.valid === true;

  // 1. Verification level
  const verificationLevel: WebsiteVerificationLevel =
    domain === "localhost" || domain.startsWith("localhost:")
      ? "dev_localhost"
      : "domain_observed";

  // 2. Route discovery
  const domainRoutes = Array.from(routes.values()).filter((r) => r.domain === domain);
  const categoryPerms = CATEGORY_PERMISSIONS[taskCategory];
  const matchingRoutes = domainRoutes.filter((route) => {
    const routePerms: string[] = [...route.required_permissions, ...route.allowed_actions];
    return categoryPerms.some((p) => routePerms.includes(p));
  });

  // 3. Task categories supported by any route on this domain
  const supportedCategorySet = new Set<DelegationTrustTaskCategory>();
  for (const route of domainRoutes) {
    for (const perm of [...route.required_permissions, ...route.allowed_actions]) {
      const cat = PERMISSION_TO_CATEGORY[perm as ActionType];
      if (cat) {
        supportedCategorySet.add(cat);
        // credential_fill is a sub-case of login — both are supported when login routes exist
        if (perm === "login") supportedCategorySet.add("credential_fill");
      }
    }
  }
  // Augment with task categories declared in well-known policy
  if (hasValidWellKnownPolicy && wellKnownPolicy) {
    for (const wf of wellKnownPolicy.supported_workflows) {
      supportedCategorySet.add(wf.task_category);
    }
  }
  const supportedTaskCategories = Array.from(supportedCategorySet);

  // 4. Receipt evidence — domain-scoped query via repository
  const allReceipts = await getReceiptRepository().listReceipts(MOCK_USER_ID);
  const domainReceipts = allReceipts.filter((r) => r.domain === domain);

  // Verify each receipt; only cryptographically verified receipts count as evidence.
  const verificationResults = await Promise.all(
    domainReceipts.map((r) => getReceiptRepository().verifyReceipt(r.receipt_id))
  );
  const validReceiptIds = new Set<string>(
    verificationResults
      .filter((v) => v !== null && v.valid)
      .map((v) => v!.receipt_id)
  );
  const validDomainReceipts = domainReceipts.filter((r) => validReceiptIds.has(r.receipt_id));

  // Compute safety signals from verified receipts
  let verifiedSuccessfulReceipts = 0;
  let failedViolationReceipts = 0;
  let uncoveredSensitiveEvents = 0;
  let totalRuntimeInterventions = 0;
  let secretExposureEvents = 0;
  let protectedObservationSessions = 0;
  let cleanSensitiveRuns = 0;
  let supportsAgentSafeObservation = false;
  let supportsCapabilityReleaseGate = false;

  for (const r of validDomainReceipts) {
    const uncovered = r.runtime_coverage_summary?.uncovered_events ?? 0;
    const interventions = r.runtime_interventions?.length ?? 0;

    if (r.status === "completed") {
      verifiedSuccessfulReceipts++;
      if (uncovered === 0 && interventions === 0) cleanSensitiveRuns++;
    } else if (r.status === "failed" && interventions > 0) {
      failedViolationReceipts++;
    }

    uncoveredSensitiveEvents += uncovered;
    totalRuntimeInterventions += interventions;

    // secret_values_revealed_to_agent is typed `false | undefined` in v1; a
    // truthiness check catches any future surface that sets it to a truthy value.
    if (r.secret_values_revealed_to_agent) secretExposureEvents++;

    if (r.observation_mode_summary?.mode === "protected_observation") {
      protectedObservationSessions++;
    }
    if (r.observation_mode_summary !== undefined) supportsAgentSafeObservation = true;
    if (r.capability_release_summary !== undefined) supportsCapabilityReleaseGate = true;
  }

  // 5. Capabilities derived from routes
  const hasKnownRoutes = domainRoutes.length > 0;
  const hasSensitiveWorkflowSupport = domainRoutes.some((r) => r.execution_mode === "aegis_controlled");
  const supportsAegisControlledRuntime = domainRoutes.some(
    (r) => r.execution_mode === "aegis_controlled" && SENSITIVE_TRUST_TIERS.has(r.trust_tier)
  );
  const hasSensitivePerms = domainRoutes.some((r) =>
    [...r.required_permissions, ...r.allowed_actions].some(
      (p) => PERMISSION_TO_CATEGORY[p as ActionType] !== undefined
    )
  );

  // 6. Website legibility
  const hasPolicySource = verificationLevel === "dev_localhost" || domainTrust.has(domain) || hasKnownRoutes || hasValidWellKnownPolicy;
  let policySource: "seeded_demo" | "route_metadata" | "well_known" | "manual_review" | undefined;
  if (hasValidWellKnownPolicy) policySource = "well_known";
  else if (verificationLevel === "dev_localhost" && hasKnownRoutes) policySource = "seeded_demo";
  else if (hasKnownRoutes) policySource = "route_metadata";
  else if (domainTrust.has(domain)) policySource = "manual_review";

  // 7. Task fit
  const requiredCapability = CATEGORY_CAPABILITY[taskCategory];
  const requiredCapabilities: RuntimeCapabilityType[] = requiredCapability ? [requiredCapability] : [];

  const knownConstraints: string[] = [];
  for (const route of matchingRoutes) {
    if ((route.approval_gates ?? []).length > 0 && !knownConstraints.includes("approval_required_for_sensitive_actions")) {
      knownConstraints.push("approval_required_for_sensitive_actions");
    }
    if (route.url_match && !knownConstraints.includes("route_scoped_to_specific_page")) {
      knownConstraints.push("route_scoped_to_specific_page");
    }
    if (route.execution_mode === "aegis_controlled" && !knownConstraints.includes("requires_aegis_controlled_execution")) {
      knownConstraints.push("requires_aegis_controlled_execution");
    }
    if ((route.forbidden_actions ?? []).length > 0 && !knownConstraints.includes("has_forbidden_actions")) {
      knownConstraints.push("has_forbidden_actions");
    }
  }

  // Enrich constraints from well-known policy
  if (hasValidWellKnownPolicy && wellKnownPolicy) {
    knownConstraints.push("well_known_policy_present");
    if (wellKnownPolicy.agent_access === "allowed_with_aegis") {
      knownConstraints.push("website_declares_agent_access_allowed_with_aegis");
    }
    const matchingPolicyWorkflows = wellKnownPolicy.supported_workflows.filter(
      (w) => w.task_category === taskCategory
    );
    if (matchingPolicyWorkflows.some((w) => w.requires_user_approval)) {
      knownConstraints.push("policy_requires_user_approval");
    }
    const policyCaps = new Set(matchingPolicyWorkflows.flatMap((w) => w.required_capabilities));
    for (const cap of policyCaps) {
      knownConstraints.push(`policy_requires_capability:${cap}`);
    }
  }

  // 8. Decision logic
  // Negative evidence overrides positive — violation receipts block allow_with_approval
  // even when clean receipts also exist.
  const hasViolationEvidence = failedViolationReceipts > 0 || uncoveredSensitiveEvents > 0;

  let agentSafetyStatus: WebsiteAgentSafetyStatus;
  let recommendation: "allow" | "allow_with_approval" | "step_up_required" | "deny";
  let confidence: "low" | "medium" | "high";

  if (secretExposureEvents > 0) {
    agentSafetyStatus = "unsafe";
    recommendation = "deny";
    confidence = "high";
  } else if (hasViolationEvidence) {
    agentSafetyStatus = "step_up_required";
    recommendation = "step_up_required";
    confidence = validDomainReceipts.length > 0 ? "medium" : "low";
  } else if (matchingRoutes.length === 0) {
    agentSafetyStatus = "unknown";
    recommendation = "step_up_required";
    confidence = "low";
  } else if (verifiedSuccessfulReceipts > 0 && cleanSensitiveRuns > 0) {
    agentSafetyStatus = "agent_callable_with_approval";
    recommendation = "allow_with_approval";
    confidence = cleanSensitiveRuns >= 3 ? "high" : "medium";
  } else {
    // Matching routes exist but no clean receipts yet
    agentSafetyStatus = "step_up_required";
    recommendation = "step_up_required";
    confidence = "low";
  }

  // 9. Disqualifying signals
  const disqualifyingSignals: string[] = [];
  if (secretExposureEvents > 0) disqualifyingSignals.push("secret_exposure_events_detected");
  if (failedViolationReceipts > 0) disqualifyingSignals.push("violation_receipts_present");
  if (uncoveredSensitiveEvents > 0) disqualifyingSignals.push("uncovered_sensitive_events_detected");
  if (matchingRoutes.length === 0) disqualifyingSignals.push("no_matching_route_for_task");
  if (validDomainReceipts.length === 0) disqualifyingSignals.push("no_execution_evidence");
  // Policy was fetched but invalid — caution signal, not a hard deny
  if (policyValidation !== undefined && !policyValidation.valid) {
    disqualifyingSignals.push("invalid_website_policy");
  }

  // 10. Machine-readable reasons
  const machineReadableReasons: string[] = [];
  if (verificationLevel === "dev_localhost") machineReadableReasons.push("domain_is_localhost_dev");
  if (hasKnownRoutes) machineReadableReasons.push(`${domainRoutes.length}_known_route(s)_for_domain`);
  if (matchingRoutes.length > 0) machineReadableReasons.push(`${matchingRoutes.length}_matching_route(s)_for_task_category`);
  if (verifiedSuccessfulReceipts > 0) machineReadableReasons.push(`${verifiedSuccessfulReceipts}_verified_successful_receipt(s)`);
  if (cleanSensitiveRuns > 0) machineReadableReasons.push(`${cleanSensitiveRuns}_clean_sensitive_run(s)`);
  if (failedViolationReceipts > 0) machineReadableReasons.push(`${failedViolationReceipts}_failed_violation_receipt(s)`);
  if (uncoveredSensitiveEvents > 0) machineReadableReasons.push(`${uncoveredSensitiveEvents}_uncovered_sensitive_event(s)`);
  if (supportsAegisControlledRuntime) machineReadableReasons.push("supports_aegis_controlled_runtime");
  if (supportsCapabilityReleaseGate) machineReadableReasons.push("capability_release_gate_active");
  if (hasSensitiveWorkflowSupport) machineReadableReasons.push("has_sensitive_workflow_support");
  if (hasValidWellKnownPolicy) {
    machineReadableReasons.push("well-known Aegis policy found for domain");
    const matchingPolicyWorkflows = wellKnownPolicy!.supported_workflows.filter(
      (w) => w.task_category === taskCategory
    );
    if (matchingPolicyWorkflows.length > 0) {
      machineReadableReasons.push(`policy declares workflow support for ${taskCategory}`);
    }
  }

  return {
    profile_id: newId("wsasp"),
    generated_at: new Date().toISOString(),
    domain,
    requested_task_category: taskCategory,
    website_verification_level: verificationLevel,
    agent_safety_status: agentSafetyStatus,
    recommendation,
    confidence,
    capabilities: {
      has_known_routes: hasKnownRoutes,
      supported_task_categories: supportedTaskCategories,
      has_sensitive_workflow_support: hasSensitiveWorkflowSupport,
      supports_aegis_controlled_runtime: supportsAegisControlledRuntime,
      supports_agent_safe_observation: supportsAgentSafeObservation,
      supports_capability_release_gate: supportsCapabilityReleaseGate,
    },
    safety_signals: {
      verified_successful_receipts: verifiedSuccessfulReceipts,
      failed_violation_receipts: failedViolationReceipts,
      uncovered_sensitive_events: uncoveredSensitiveEvents,
      runtime_interventions: totalRuntimeInterventions,
      secret_exposure_events: secretExposureEvents,
      protected_observation_sessions: protectedObservationSessions,
      clean_sensitive_runs: cleanSensitiveRuns,
    },
    website_legibility: {
      has_structured_route_metadata: hasKnownRoutes,
      has_known_start_url: domainRoutes.some((r) => r.start_url !== undefined),
      has_known_sensitive_actions: hasSensitivePerms,
      has_policy_source: hasPolicySource,
      ...(policySource ? { policy_source: policySource } : {}),
    },
    task_fit: {
      category: taskCategory,
      matching_routes: matchingRoutes.map((r) => r.route_id),
      required_capabilities: requiredCapabilities,
      known_constraints: knownConstraints,
    },
    disqualifying_signals: disqualifyingSignals,
    machine_readable_reasons: machineReadableReasons,
    limitations: {
      not_business_verified: true,  // v1: business_verified level is not implemented
      no_live_crawl_performed: true,
      based_only_on_aegis_observed_events: true,
      not_a_guarantee: true,
    },
  };
}
