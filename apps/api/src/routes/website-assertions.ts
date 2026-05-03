import type { FastifyInstance } from "fastify";
import type { DelegationTrustTaskCategory, WebsiteTrustAssertion } from "@aegis/types";
import {
  agentDelegations,
  delegationPassports,
  websiteTrustAssertions,
  domainTrust,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import {
  computeDelegationTrustProfile,
  DelegationNotFoundError,
  DelegationForbiddenError,
} from "./delegation-trust.js";
import {
  hashWebsiteTrustAssertion,
  signWebsiteAssertionJws,
  verifyWebsiteAssertionJws,
} from "../lib/websiteAssertionSigning.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TASK_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "login", "credential_fill", "purchase", "payment", "travel_booking",
  "financial_action", "identity_disclosure", "account_change",
  "destructive_action", "message_send",
]);

const PAYMENT_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "purchase", "payment", "travel_booking", "financial_action",
]);

const DEFAULT_EXPIRES_MINUTES = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectVerificationLevel(
  domain: string
): WebsiteTrustAssertion["requesting_website"]["verification_level"] {
  if (domain === "localhost" || domain.startsWith("localhost:")) {
    return "dev_localhost";
  }
  return "domain_observed";
}

type Recommendation = WebsiteTrustAssertion["decision"]["recommendation"];

function computeRecommendation(
  trustProfile: Awaited<ReturnType<typeof computeDelegationTrustProfile>>,
  taskCategory: DelegationTrustTaskCategory,
  delegationStatus: string
): Recommendation {
  if (delegationStatus !== "active") return "deny";

  const { trust_status, capability_summary } = trustProfile;

  if (trust_status === "suspended" || trust_status === "risky") return "deny";
  if (trust_status === "caution") return "step_up_required";

  if (PAYMENT_CATEGORIES.has(taskCategory) && !capability_summary.payment_method_available) {
    return trust_status === "unproven" ? "deny" : "step_up_required";
  }

  if (trust_status === "trusted_for_category") return "allow";
  if (trust_status === "proven_limited") return "allow_with_approval";

  // unproven, capable_but_unproven
  return "step_up_required";
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function websiteAssertionRoutes(app: FastifyInstance) {

  // POST /api/website-assertions — create a signed website trust assertion
  app.post("/api/website-assertions", async (req, reply) => {
    const body = req.body as {
      delegation_id?: string;
      task_category?: string;
      requesting_domain?: string;
      requesting_origin?: string;
      passport_id?: string;
      human_readable_summary?: string;
      expires_in_minutes?: number;
    };

    if (!body.delegation_id) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PARAM", message: "delegation_id is required" } });
    }
    if (!body.task_category) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PARAM", message: "task_category is required" } });
    }
    if (!VALID_TASK_CATEGORIES.has(body.task_category as DelegationTrustTaskCategory)) {
      return reply.code(400).send({ ok: false, error: { code: "INVALID_TASK_CATEGORY", message: `task_category must be one of: ${[...VALID_TASK_CATEGORIES].join(", ")}` } });
    }
    if (!body.requesting_domain) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PARAM", message: "requesting_domain is required" } });
    }

    const {
      delegation_id,
      task_category,
      requesting_domain,
      requesting_origin,
      passport_id,
      human_readable_summary,
      expires_in_minutes = DEFAULT_EXPIRES_MINUTES,
    } = body as Required<Pick<typeof body, "delegation_id" | "task_category" | "requesting_domain">> & typeof body;

    const taskCat = task_category as DelegationTrustTaskCategory;

    const delegation = agentDelegations.get(delegation_id);
    if (!delegation) {
      return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Delegation not found" } });
    }
    if (delegation.user_id !== MOCK_USER_ID) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Delegation does not belong to current user" } });
    }

    // Compute trust profile
    let trustProfile: Awaited<ReturnType<typeof computeDelegationTrustProfile>>;
    try {
      trustProfile = await computeDelegationTrustProfile(delegation_id, taskCat, MOCK_USER_ID);
    } catch (err) {
      if (err instanceof DelegationNotFoundError) {
        return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: err.message } });
      }
      if (err instanceof DelegationForbiddenError) {
        return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: err.message } });
      }
      throw err;
    }

    // Optional passport cross-reference
    let resolvedPassportId: string | undefined;
    let resolvedPassportHash: string | undefined;

    if (passport_id) {
      const passport = delegationPassports.get(passport_id);
      if (!passport) {
        return reply.code(400).send({ ok: false, error: { code: "PASSPORT_NOT_FOUND", message: `Passport ${passport_id} not found` } });
      }
      if (passport.delegation.delegation_id !== delegation_id) {
        return reply.code(400).send({ ok: false, error: { code: "PASSPORT_DELEGATION_MISMATCH", message: "Passport delegation_id does not match request delegation_id" } });
      }
      resolvedPassportId = passport.passport_id;
      const isExpired = new Date() >= new Date(passport.expires_at);
      if (!isExpired) {
        resolvedPassportHash = passport.verification.passport_hash;
      }
    }

    // Compute recommendation
    const recommendation = computeRecommendation(trustProfile, taskCat, delegation.status);

    // Build assertion without verification
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expires_in_minutes * 60 * 1000);

    const assertionWithoutVerification: Omit<WebsiteTrustAssertion, "verification"> = {
      assertion_id: newId("wta"),
      issuer: process.env.AEGIS_RECEIPT_ISSUER ?? "aegis.dev",
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      requesting_website: {
        domain: requesting_domain,
        ...(requesting_origin ? { origin: requesting_origin } : {}),
        verification_level: detectVerificationLevel(requesting_domain),
      },
      subject: {
        user_aegis_id: delegation.user_aegis_id,
        agent_id: delegation.agent_name,
        delegation_id,
        ...(resolvedPassportId ? { passport_id: resolvedPassportId } : {}),
        ...(resolvedPassportHash ? { passport_hash: resolvedPassportHash } : {}),
      },
      requested_task: {
        category: taskCat,
        domain: requesting_domain,
        ...(human_readable_summary ? { human_readable_summary } : {}),
      },
      decision: {
        recommendation,
        trust_status: trustProfile.trust_status,
        confidence: trustProfile.confidence,
        reasons: [...trustProfile.machine_readable_reasons],
        disqualifying_signals: [...trustProfile.disqualifying_signals],
      },
      capability_summary: trustProfile.capability_summary,
      coverage_summary: trustProfile.coverage_summary,
      limitations: trustProfile.limitations,
    };

    // Hash and sign — no unsigned fallback; signing keys are required for website assertions
    const assertionHash = hashWebsiteTrustAssertion(assertionWithoutVerification);
    let assertionJws: string;
    try {
      assertionJws = await signWebsiteAssertionJws({
        typ: "aegis.website_assertion.v1",
        assertion_id: assertionWithoutVerification.assertion_id,
        assertion_hash: assertionHash,
        issuer: assertionWithoutVerification.issuer,
        issued_at: assertionWithoutVerification.issued_at,
        expires_at: assertionWithoutVerification.expires_at,
        requesting_domain,
        user_aegis_id: delegation.user_aegis_id,
        agent_id: delegation.agent_name,
        delegation_id,
        ...(resolvedPassportId ? { passport_id: resolvedPassportId } : {}),
        task_category: taskCat,
        recommendation,
        trust_status: trustProfile.trust_status,
      });
    } catch (err) {
      console.error("[website-assertions] Signing failed:", err);
      return reply.code(500).send({
        ok: false,
        error: {
          code: "SIGNING_NOT_CONFIGURED",
          message: "Website assertion signing failed. Ensure AEGIS_RECEIPT_JWS_PRIVATE_JWK is set.",
        },
      });
    }

    const assertion: WebsiteTrustAssertion = {
      ...assertionWithoutVerification,
      verification: {
        assertion_hash: assertionHash,
        assertion_jws: assertionJws,
      },
    };

    websiteTrustAssertions.set(assertion.assertion_id, assertion);
    schedulePersist();

    return reply.code(201).send({ ok: true, data: assertion });
  });

  // GET /api/website-assertions/:assertionId — retrieve an assertion
  app.get("/api/website-assertions/:assertionId", async (req, reply) => {
    const { assertionId } = req.params as { assertionId: string };
    const assertion = websiteTrustAssertions.get(assertionId);
    if (!assertion) {
      return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Assertion not found" } });
    }
    return reply.send({ ok: true, data: assertion });
  });

  // GET /api/website-assertions/:assertionId/verify — verify assertion integrity
  app.get("/api/website-assertions/:assertionId/verify", async (req, reply) => {
    const { assertionId } = req.params as { assertionId: string };
    const assertion = websiteTrustAssertions.get(assertionId);
    if (!assertion) {
      return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Assertion not found" } });
    }

    const { verification, ...assertionWithoutVerification } = assertion;

    const recomputedHash = hashWebsiteTrustAssertion(assertionWithoutVerification);
    const hashValid = recomputedHash === verification.assertion_hash;

    const jwsResult = await verifyWebsiteAssertionJws(verification.assertion_jws);
    const signatureValid = jwsResult.valid;

    let payloadFieldsValid = false;
    if (jwsResult.valid && jwsResult.payload) {
      const p = jwsResult.payload;
      payloadFieldsValid =
        p.assertion_id === assertion.assertion_id &&
        p.assertion_hash === verification.assertion_hash &&
        p.user_aegis_id === assertion.subject.user_aegis_id &&
        p.agent_id === assertion.subject.agent_id &&
        p.delegation_id === assertion.subject.delegation_id &&
        p.task_category === assertion.requested_task.category &&
        p.recommendation === assertion.decision.recommendation;
    }

    const expired = new Date() >= new Date(assertion.expires_at);

    const valid = hashValid && signatureValid && payloadFieldsValid && !expired;

    let error: string | null = null;
    if (!hashValid) error = "HASH_MISMATCH";
    else if (!signatureValid) error = jwsResult.error ?? "SIGNATURE_INVALID";
    else if (!payloadFieldsValid) error = "PAYLOAD_MISMATCH";
    else if (expired) error = "EXPIRED";

    return reply.send({
      ok: true,
      data: {
        valid,
        hash_valid: hashValid,
        signature_valid: signatureValid,
        expired,
        assertion_hash: verification.assertion_hash,
        recomputed_hash: recomputedHash,
        jws_payload: jwsResult.payload ?? null,
        recommendation: assertion.decision.recommendation,
        trust_status: assertion.decision.trust_status,
        error,
      },
    });
  });
}
