import type { FastifyInstance } from "fastify";
import type {
  WebsiteAegisPolicy,
  WebsiteAegisPolicyValidationResult,
  WebsitePolicyCompatibilityResult,
  WebsiteAegisAgentAccess,
  WebsiteVerificationLevel,
  RuntimeCapabilityType,
  DelegationTrustTaskCategory,
} from "@aegis/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_AGENT_ACCESS = new Set<WebsiteAegisAgentAccess>([
  "not_supported",
  "allowed_with_aegis",
  "allowed_with_approval",
  "restricted",
  "blocked",
]);

const VALID_VERIFICATION_LEVELS = new Set<WebsiteVerificationLevel>([
  "dev_localhost",
  "domain_observed",
  "domain_verified",
  "business_verified",
]);

const VALID_CAPABILITY_TYPES = new Set<RuntimeCapabilityType>([
  "login_credential",
  "payment_method",
  "identity_profile",
]);

const VALID_TASK_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "login", "credential_fill", "purchase", "payment", "travel_booking",
  "financial_action", "identity_disclosure", "account_change",
  "destructive_action", "message_send",
]);

// ─── Shared Helpers ───────────────────────────────────────────────────────────

export function validateWebsiteAegisPolicy(
  raw: unknown
): WebsiteAegisPolicyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { valid: false, errors: ["policy is not an object"], warnings };
  }

  const p = raw as Record<string, unknown>;

  if (p["version"] !== "aegis-policy-v1") {
    errors.push(`version must be "aegis-policy-v1", got "${p["version"]}"`);
  }
  if (typeof p["domain"] !== "string" || !p["domain"]) {
    errors.push("domain must be a non-empty string");
  }
  if (!VALID_AGENT_ACCESS.has(p["agent_access"] as WebsiteAegisAgentAccess)) {
    errors.push(`agent_access "${p["agent_access"]}" is not valid`);
  }
  if (!VALID_VERIFICATION_LEVELS.has(p["verification_level"] as WebsiteVerificationLevel)) {
    errors.push(`verification_level "${p["verification_level"]}" is not valid`);
  }

  if (!Array.isArray(p["supported_workflows"])) {
    errors.push("supported_workflows must be an array");
  } else {
    for (const wf of p["supported_workflows"] as unknown[]) {
      if (typeof wf !== "object" || wf === null) {
        errors.push("each supported_workflow must be an object");
        continue;
      }
      const w = wf as Record<string, unknown>;
      if (typeof w["workflow_id"] !== "string") errors.push("workflow missing workflow_id");
      if (typeof w["task_category"] !== "string") errors.push("workflow missing task_category");
      if (!Array.isArray(w["path_prefixes"])) errors.push(`workflow "${w["workflow_id"]}" missing path_prefixes`);
      if (!Array.isArray(w["required_capabilities"])) errors.push(`workflow "${w["workflow_id"]}" missing required_capabilities`);
      if (typeof w["requires_user_approval"] !== "boolean") errors.push(`workflow "${w["workflow_id"]}" missing requires_user_approval`);

      if (Array.isArray(w["required_capabilities"])) {
        for (const cap of w["required_capabilities"] as unknown[]) {
          if (!VALID_CAPABILITY_TYPES.has(cap as RuntimeCapabilityType)) {
            errors.push(`workflow "${w["workflow_id"]}" has invalid required_capability "${cap}"`);
          }
        }
      }
    }
  }

  const limitations = p["limitations"] as Record<string, unknown> | undefined;
  if (!limitations || limitations["self_asserted_policy"] !== true) {
    errors.push("limitations.self_asserted_policy must be true");
  }
  if (!limitations || limitations["not_a_guarantee"] !== true) {
    errors.push("limitations.not_a_guarantee must be true");
  }

  // Warnings — non-disqualifying
  const vl = p["verification_level"] as WebsiteVerificationLevel | undefined;
  if (vl && vl !== "business_verified") {
    warnings.push("policy is self-asserted and not business-verified");
  }
  const contact = p["contact"] as Record<string, unknown> | undefined;
  if (!contact?.["support_url"]) {
    warnings.push("no support URL declared");
  }
  const workflows = p["supported_workflows"];
  if (Array.isArray(workflows) && workflows.length === 0) {
    warnings.push("no supported workflows declared");
  }
  if (p["agent_access"] === "restricted") {
    warnings.push("agent access is restricted");
  }

  const valid = errors.length === 0;
  return { valid, errors, warnings, ...(valid ? { policy: raw as WebsiteAegisPolicy } : {}) };
}

export async function getWebsiteAegisPolicyForDomain(domain: string): Promise<{
  policy?: WebsiteAegisPolicy;
  validation?: WebsiteAegisPolicyValidationResult;
}> {
  const isLocalhost =
    domain === "localhost" || domain.startsWith("localhost:");

  if (!isLocalhost) {
    return {};
  }

  const urls = [
    "http://localhost:3000/.well-known/aegis-policy.json",
    "http://localhost:3000/well-known/aegis-policy.json",
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const raw: unknown = await res.json();
      const validation = validateWebsiteAegisPolicy(raw);
      return { policy: validation.policy, validation };
    } catch {
      // try next URL
    }
  }

  return {};
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function websiteAegisPolicyRoutes(server: FastifyInstance) {
  server.get("/api/website-aegis-policy", async (req, reply) => {
    const { domain } = req.query as { domain?: string };
    if (!domain) {
      return reply.status(400).send({ ok: false, error: "MISSING_DOMAIN", message: "domain query param required" });
    }

    const isLocalhost = domain === "localhost" || domain.startsWith("localhost:");
    if (!isLocalhost) {
      return reply.status(404).send({
        ok: false,
        error: "POLICY_NOT_AVAILABLE",
        message: "Live policy fetching for non-localhost domains is not enabled in v1.",
      });
    }

    const { policy, validation } = await getWebsiteAegisPolicyForDomain(domain);

    if (!policy && (!validation || !validation.valid)) {
      return reply.status(404).send({
        ok: false,
        error: "POLICY_NOT_FOUND",
        message: "Could not fetch or parse an Antigen policy for this domain.",
      });
    }

    return reply.send({ ok: true, data: { policy, validation } });
  });

  server.get("/api/website-aegis-policy/validate", async (req, reply) => {
    const { domain } = req.query as { domain?: string };
    if (!domain) {
      return reply.status(400).send({ ok: false, error: "MISSING_DOMAIN", message: "domain query param required" });
    }

    const isLocalhost = domain === "localhost" || domain.startsWith("localhost:");
    if (!isLocalhost) {
      return reply.status(404).send({
        ok: false,
        error: "POLICY_NOT_AVAILABLE",
        message: "Live policy fetching for non-localhost domains is not enabled in v1.",
      });
    }

    const { validation } = await getWebsiteAegisPolicyForDomain(domain);

    if (!validation) {
      return reply.send({
        ok: true,
        data: {
          valid: false,
          errors: ["Could not fetch policy from well-known endpoint"],
          warnings: [],
        } satisfies WebsiteAegisPolicyValidationResult,
      });
    }

    return reply.send({ ok: true, data: validation });
  });

  server.get("/api/website-aegis-policy/compatibility", async (req, reply) => {
    const { domain, task_category } = req.query as { domain?: string; task_category?: string };
    if (!domain) {
      return reply.status(400).send({ ok: false, error: "MISSING_DOMAIN", message: "domain query param required" });
    }
    if (!task_category) {
      return reply.status(400).send({ ok: false, error: "MISSING_TASK_CATEGORY", message: "task_category query param required" });
    }
    if (!VALID_TASK_CATEGORIES.has(task_category as DelegationTrustTaskCategory)) {
      return reply.status(400).send({
        ok: false,
        error: "INVALID_TASK_CATEGORY",
        message: `"${task_category}" is not a valid DelegationTrustTaskCategory`,
      });
    }

    const isLocalhost = domain === "localhost" || domain.startsWith("localhost:");
    if (!isLocalhost) {
      return reply.status(404).send({
        ok: false,
        error: "POLICY_NOT_AVAILABLE",
        message: "Live policy fetching for non-localhost domains is not enabled in v1.",
      });
    }

    const { policy, validation } = await getWebsiteAegisPolicyForDomain(domain);

    const reasons: string[] = [];
    const mismatches: string[] = [];
    const taskCat = task_category as DelegationTrustTaskCategory;

    if (!validation?.valid || !policy) {
      const result: WebsitePolicyCompatibilityResult = {
        compatible: false,
        recommendation: "step_up_required",
        reasons: ["policy could not be fetched or is invalid"],
        mismatches: validation?.errors ?? ["policy fetch failed"],
        required_capabilities: [],
        required_assertions: [],
        matching_workflows: [],
      };
      return reply.send({ ok: true, data: result });
    }

    if (policy.agent_access === "blocked" || policy.agent_access === "not_supported") {
      const result: WebsitePolicyCompatibilityResult = {
        compatible: false,
        recommendation: "deny",
        reasons: [`website agent_access is "${policy.agent_access}"`],
        mismatches: [`agent_access: ${policy.agent_access}`],
        required_capabilities: [],
        required_assertions: policy.required_assertions,
        matching_workflows: [],
      };
      return reply.send({ ok: true, data: result });
    }

    const matchingWorkflows = policy.supported_workflows.filter(
      (w) => w.task_category === taskCat
    );

    const requiredCapabilities = Array.from(
      new Set(matchingWorkflows.flatMap((w) => w.required_capabilities))
    );
    const requiredAssertions = policy.required_assertions;
    const matchingWorkflowIds = matchingWorkflows.map((w) => w.workflow_id);

    if (matchingWorkflows.length === 0) {
      reasons.push(`no workflows declared for task_category "${task_category}"`);
      mismatches.push(`task_category "${task_category}" not in supported_workflows`);
      const result: WebsitePolicyCompatibilityResult = {
        compatible: false,
        recommendation: "step_up_required",
        reasons,
        mismatches,
        required_capabilities: requiredCapabilities,
        required_assertions: requiredAssertions,
        matching_workflows: matchingWorkflowIds,
      };
      return reply.send({ ok: true, data: result });
    }

    reasons.push(`${matchingWorkflows.length} workflow(s) declared for task_category "${task_category}"`);

    const needsApproval = matchingWorkflows.some((w) => w.requires_user_approval);
    if (needsApproval) {
      reasons.push("at least one matching workflow requires user approval");
    }

    let recommendation: WebsitePolicyCompatibilityResult["recommendation"];
    if (needsApproval || policy.agent_access === "allowed_with_aegis" || policy.agent_access === "allowed_with_approval") {
      recommendation = "allow_with_approval";
    } else {
      recommendation = "allow";
    }

    const result: WebsitePolicyCompatibilityResult = {
      compatible: true,
      recommendation,
      reasons,
      mismatches,
      required_capabilities: requiredCapabilities,
      required_assertions: requiredAssertions,
      matching_workflows: matchingWorkflowIds,
    };
    return reply.send({ ok: true, data: result });
  });
}
