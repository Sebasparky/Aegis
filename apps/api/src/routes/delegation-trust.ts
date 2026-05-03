import type { FastifyInstance } from "fastify";
import type {
  DelegationTrustProfile,
  DelegationTrustTaskCategory,
  DelegationTrustStatus,
} from "@aegis/types";
import {
  agentDelegations,
  actionAuthorizations,
  paymentMethods,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TASK_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "login", "credential_fill", "purchase", "payment", "travel_booking",
  "financial_action", "identity_disclosure", "account_change",
  "destructive_action", "message_send",
]);

// Categories that require an Aegis-held login credential.
const LOGIN_CATEGORIES = new Set<DelegationTrustTaskCategory>(["login", "credential_fill"]);

// Categories that require a payment method capability.
const PAYMENT_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "purchase", "payment", "travel_booking", "financial_action",
]);

// Categories that require an identity profile (unavailable in v1 — always false).
const IDENTITY_CATEGORIES = new Set<DelegationTrustTaskCategory>(["identity_disclosure"]);

// ─── Typed errors for shared computeDelegationTrustProfile ───────────────────

export class DelegationNotFoundError extends Error {
  constructor(id: string) {
    super(`Delegation ${id} not found`);
    this.name = "DelegationNotFoundError";
  }
}

export class DelegationForbiddenError extends Error {
  constructor() {
    super("Delegation does not belong to current user");
    this.name = "DelegationForbiddenError";
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function delegationTrustRoutes(app: FastifyInstance) {
  app.get("/api/delegation-trust/profile", async (req, reply) => {
    const { delegation_id, task_category } = req.query as Record<string, string>;

    if (!delegation_id) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PARAM", message: "delegation_id is required" } });
    }
    if (!task_category) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PARAM", message: "task_category is required" } });
    }
    if (!VALID_TASK_CATEGORIES.has(task_category as DelegationTrustTaskCategory)) {
      return reply.code(400).send({ ok: false, error: { code: "INVALID_TASK_CATEGORY", message: `task_category must be one of: ${[...VALID_TASK_CATEGORIES].join(", ")}` } });
    }

    try {
      const profile = await computeDelegationTrustProfile(
        delegation_id,
        task_category as DelegationTrustTaskCategory,
        MOCK_USER_ID
      );
      return reply.send({ ok: true, data: profile });
    } catch (err) {
      if (err instanceof DelegationNotFoundError) {
        return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: err.message } });
      }
      if (err instanceof DelegationForbiddenError) {
        return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: err.message } });
      }
      throw err;
    }
  });
}

// ─── Shared trust profile computation (also used by website-assertions.ts) ───

export async function computeDelegationTrustProfile(
  delegation_id: string,
  task_category: DelegationTrustTaskCategory,
  user_id: string
): Promise<DelegationTrustProfile> {
  const category = task_category;
  const delegation = agentDelegations.get(delegation_id);
  if (!delegation) throw new DelegationNotFoundError(delegation_id);
  if (delegation.user_id !== user_id) throw new DelegationForbiddenError();

  // ── Suspended fast-path ──────────────────────────────────────────────────
  if (delegation.status !== "active") {
    return buildSuspendedProfile(delegation_id, delegation.user_aegis_id, delegation.agent_name, category);
  }

  // ── Load evidence ────────────────────────────────────────────────────────

  const [vaultPasses, allReceipts] = await Promise.all([
    getVaultRepository().listVaultPasses(MOCK_USER_ID),
    getReceiptRepository().listReceipts(MOCK_USER_ID),
  ]);

  // Verify each receipt; only verified receipts count as trust evidence.
  const verificationResults = await Promise.all(
    allReceipts.map((r) => getReceiptRepository().verifyReceipt(r.receipt_id))
  );
  const validReceiptIds = new Set<string>(
    verificationResults
      .filter((v) => v !== null && v.valid)
      .map((v) => v!.receipt_id)
  );

  // All authorizations for this delegation.
  const delegationAuths = Array.from(actionAuthorizations.values()).filter(
    (a) => a.user_id === MOCK_USER_ID && a.delegation_id === delegation_id
  );
  const fulfilledAuths = delegationAuths.filter((a) => a.status === "fulfilled");
  const fulfilledAuthIds = new Set(fulfilledAuths.map((a) => a.authorization_id));

  // Delegation-linked valid receipts: receipts whose authorization_context points to a fulfilled auth.
  const linkedValidReceipts = allReceipts.filter(
    (r) =>
      r.authorization_context?.authorization_id !== undefined &&
      fulfilledAuthIds.has(r.authorization_context.authorization_id) &&
      validReceiptIds.has(r.receipt_id)
  );

  // ── Coverage stats ───────────────────────────────────────────────────────

  let coveredEvents = 0;
  let uncoveredEvents = 0;
  let secretExposureEvents = 0;
  let playwrightExecutions = 0;

  for (const r of linkedValidReceipts) {
    coveredEvents += r.runtime_coverage_summary?.covered_events ?? 0;
    uncoveredEvents += r.runtime_coverage_summary?.uncovered_events ?? 0;
    if (r.secret_values_revealed_to_agent) secretExposureEvents++;
    if (r.execution_surface === "aegis_playwright") playwrightExecutions++;
  }

  // ── Category experience ──────────────────────────────────────────────────

  const categoryFulfilledAuths = fulfilledAuths.filter(
    (a) => a.action.action_type === category
  );
  const categoryReceiptIds = categoryFulfilledAuths
    .map((a) => a.fulfillment?.execution_receipt_id)
    .filter((id): id is string => id !== undefined && validReceiptIds.has(id));

  // Sort by receipt created_at desc, take 5 most recent.
  const categoryReceiptsOrdered = allReceipts
    .filter((r) => categoryReceiptIds.includes(r.receipt_id))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, 5);
  const recentSuccessfulReceiptIds = categoryReceiptsOrdered.map((r) => r.receipt_id);

  // ── Capability summary ───────────────────────────────────────────────────

  const loginCredentialAvailable = vaultPasses.some((p) => p.kind === "login_password");
  const paymentMethodAvailable = [...paymentMethods.values()].some((pm) => pm.user_id === delegation.user_id);
  const identityProfileAvailable = false;  // v1: not implemented
  const credentialDomains = [...new Set(vaultPasses.map((p) => p.domain))];

  let capableForRequestedTask = false;
  const missingCapabilities: string[] = [];

  if (LOGIN_CATEGORIES.has(category)) {
    capableForRequestedTask = loginCredentialAvailable;
    if (!loginCredentialAvailable) missingCapabilities.push("login_credential");
  } else if (PAYMENT_CATEGORIES.has(category)) {
    capableForRequestedTask = paymentMethodAvailable;
    if (!paymentMethodAvailable) missingCapabilities.push("payment_method");
  } else if (IDENTITY_CATEGORIES.has(category)) {
    capableForRequestedTask = false;
    missingCapabilities.push("identity_profile");
  } else {
    // account_change, destructive_action, message_send — no credential required.
    capableForRequestedTask = true;
  }

  // ── Trust status + confidence ────────────────────────────────────────────

  const coverageClean = uncoveredEvents === 0 && secretExposureEvents === 0;
  const categoryFulfilledCount = categoryFulfilledAuths.length;

  let trustStatus: DelegationTrustStatus;
  if (secretExposureEvents > 0) {
    trustStatus = "risky";
  } else if (uncoveredEvents > 0) {
    trustStatus = "caution";
  } else if (!capableForRequestedTask && categoryFulfilledCount === 0) {
    trustStatus = "unproven";
  } else if (capableForRequestedTask && categoryFulfilledCount === 0) {
    trustStatus = "capable_but_unproven";
  } else if (categoryFulfilledCount >= 3 && coverageClean && !PAYMENT_CATEGORIES.has(category)) {
    trustStatus = "trusted_for_category";
  } else if (categoryFulfilledCount >= 1 && coverageClean) {
    trustStatus = "proven_limited";
  } else {
    trustStatus = "capable_but_unproven";
  }

  const confidence: "low" | "medium" | "high" =
    categoryReceiptIds.length >= 3 && coverageClean ? "high"
      : categoryReceiptIds.length >= 1 && coverageClean ? "medium"
      : "low";

  // ── Disqualifying signals ────────────────────────────────────────────────

  const disqualifyingSignals: string[] = [];
  if (secretExposureEvents > 0) disqualifyingSignals.push("secret_exposure_detected");
  if (uncoveredEvents > 0) disqualifyingSignals.push("uncovered_sensitive_events_detected");
  if (PAYMENT_CATEGORIES.has(category) && !paymentMethodAvailable) disqualifyingSignals.push("payment_capability_unavailable_v1");
  if (IDENTITY_CATEGORIES.has(category)) disqualifyingSignals.push("identity_capability_unavailable_v1");
  if (LOGIN_CATEGORIES.has(category) && !loginCredentialAvailable) {
    disqualifyingSignals.push("no_login_credential_for_category");
  }

  // ── Machine-readable reasons ─────────────────────────────────────────────

  const reasons: string[] = [];
  reasons.push(`delegation status: ${delegation.status}`);
  reasons.push(`${categoryFulfilledCount} fulfilled authorization(s) found for category '${category}'`);
  reasons.push(`${linkedValidReceipts.length} verified execution receipt(s) linked to this delegation`);
  reasons.push(coverageClean ? "coverage clean: no uncovered sensitive events or secret exposures" : `coverage issues: ${uncoveredEvents} uncovered event(s), ${secretExposureEvents} secret exposure(s)`);
  if (LOGIN_CATEGORIES.has(category)) {
    reasons.push(loginCredentialAvailable ? "login credential available in vault" : "no login credential found in vault");
  }
  if (PAYMENT_CATEGORIES.has(category)) {
    reasons.push(paymentMethodAvailable ? "payment method available (tokenized demo capability)" : "payment method not available (v1 limitation — capability gates trusted_for_category)");
  }
  if (IDENTITY_CATEGORIES.has(category)) {
    reasons.push("identity profile not available (v1 limitation)");
  }

  // ── Build profile ────────────────────────────────────────────────────────

  return {
    profile_id: newId("dtp"),
    generated_at: new Date().toISOString(),
    delegation_id,
    user_aegis_id: delegation.user_aegis_id,
    agent_id: delegation.agent_name,
    requested_task_category: category,
    trust_status: trustStatus,
    confidence,
    capability_summary: {
      login_credentials_available: loginCredentialAvailable,
      payment_method_available: paymentMethodAvailable,
      identity_profile_available: identityProfileAvailable,
      credential_domains: credentialDomains,
      capable_for_requested_task: capableForRequestedTask,
      missing_capabilities: missingCapabilities,
    },
    coverage_summary: {
      verified_execution_receipts: linkedValidReceipts.length,
      verified_authorizations: fulfilledAuths.length,
      covered_sensitive_events: coveredEvents,
      uncovered_sensitive_events: uncoveredEvents,
      secret_exposure_events: secretExposureEvents,
      aegis_playwright_executions: playwrightExecutions,
    },
    category_experience: {
      category,
      fulfilled_authorizations: categoryFulfilledCount,
      verified_execution_receipts: categoryReceiptIds.length,
      recent_successful_receipt_ids: recentSuccessfulReceiptIds,
    },
    disqualifying_signals: disqualifyingSignals,
    machine_readable_reasons: reasons,
    limitations: {
      not_a_guarantee: true,
      out_of_band_secret_use_not_covered: true,
      based_only_on_aegis_observed_events: true,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildSuspendedProfile(
  delegation_id: string,
  user_aegis_id: string,
  agent_id: string,
  category: DelegationTrustTaskCategory
): DelegationTrustProfile {
  return {
    profile_id: newId("dtp"),
    generated_at: new Date().toISOString(),
    delegation_id,
    user_aegis_id,
    agent_id,
    requested_task_category: category,
    trust_status: "suspended",
    confidence: "low",
    capability_summary: {
      login_credentials_available: false,
      payment_method_available: false,
      identity_profile_available: false,
      credential_domains: [],
      capable_for_requested_task: false,
      missing_capabilities: [],
    },
    coverage_summary: {
      verified_execution_receipts: 0,
      verified_authorizations: 0,
      covered_sensitive_events: 0,
      uncovered_sensitive_events: 0,
      secret_exposure_events: 0,
      aegis_playwright_executions: 0,
    },
    category_experience: {
      category,
      fulfilled_authorizations: 0,
      verified_execution_receipts: 0,
      recent_successful_receipt_ids: [],
    },
    disqualifying_signals: ["delegation_not_active"],
    machine_readable_reasons: ["delegation is not active — trust evaluation suspended"],
    limitations: {
      not_a_guarantee: true,
      out_of_band_secret_use_not_covered: true,
      based_only_on_aegis_observed_events: true,
    },
  };
}
