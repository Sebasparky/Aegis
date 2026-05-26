import { createHash, timingSafeEqual, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  VerificationCard,
  VerificationType,
  VerificationProviderSession,
  ExternalVerificationSession,
  ExternalVerificationHandoffView,
  ExternalVerificationProviderName,
} from "@aegis/types";
import {
  verificationCards,
  verificationProviderSessions,
  externalVerificationSessions,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import {
  buildSignedVerificationCard,
  verifyStoredVerificationCard,
} from "../lib/verificationCardSigning.js";
import {
  PROVIDERS,
  findProvider,
  findProviderForType,
  EXTERNAL_PROVIDER_DESCRIPTORS,
  findExternalProviderDescriptor,
} from "../lib/verificationProviders.js";
import { sendVerificationOtpEmail } from "../lib/emailDelivery.js";

const KNOWN_VERIFICATION_TYPES = new Set<string>([
  "email_ownership",
  "phone_ownership",
  "government_id",
  "student_status",
  "military_status",
  "business_org_control",
  "domain_ownership",
  "employment_status",
]);

const SESSION_TERMINAL_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

// Ephemeral side-map — not exported, not persisted, reset on server restart.
// Stores mock_input submitted at session creation so complete() can use it.
const sessionMockInputs = new Map<string, unknown>();

// ─── OTP state for local_email provider ─────────────────────────────────────
// Exported for test access only — never persisted, never returned in API responses.

interface OtpRecord {
  hash: string;        // SHA-256 hex of the raw OTP code — never the raw code itself
  expires_at: string;  // 10-min TTL, shorter than the 30-min session expiry
  attempt_count: number;
}

export const sessionOtpRecords = new Map<string, OtpRecord>();
const sessionEmailDomains = new Map<string, string>(); // domain suffix only, never full email

// ─── Rate limiting for email_otp provider ────────────────────────────────────
// In-memory only; resets on restart. Keyed by normalized email (lowercase).
// Exported for test access only — never returned in API responses.

interface OtpRateLimitRecord {
  send_timestamps: number[]; // epoch ms, trimmed to OTP_WINDOW_MS
  last_send_at: number;      // epoch ms of most recent send
}

export const emailOtpRateLimits = new Map<string, OtpRateLimitRecord>();

const OTP_MAX_SENDS_PER_WINDOW = 3;
const OTP_WINDOW_MS = 15 * 60 * 1000;    // 15 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

function checkOtpRateLimit(normalizedEmail: string): "ok" | "rate_limited" | "resend_too_soon" {
  const now = Date.now();
  const rec = emailOtpRateLimits.get(normalizedEmail);
  if (!rec) return "ok";
  if (now - rec.last_send_at < OTP_RESEND_COOLDOWN_MS) return "resend_too_soon";
  const recentSends = rec.send_timestamps.filter((t) => now - t < OTP_WINDOW_MS);
  if (recentSends.length >= OTP_MAX_SENDS_PER_WINDOW) return "rate_limited";
  return "ok";
}

function recordOtpSend(normalizedEmail: string): void {
  const now = Date.now();
  const rec = emailOtpRateLimits.get(normalizedEmail) ?? { send_timestamps: [], last_send_at: 0 };
  rec.send_timestamps = rec.send_timestamps.filter((t) => now - t < OTP_WINDOW_MS);
  rec.send_timestamps.push(now);
  rec.last_send_at = now;
  emailOtpRateLimits.set(normalizedEmail, rec);
}

// ─── Safe views ──────────────────────────────────────────────────────────────

function toVerificationCardSummary(card: VerificationCard) {
  return {
    card_id: card.card_id,
    claim_types: card.claims.map((c) => c.claim_type),
    assurance_level: card.claims[0]?.assurance_level,
    disclosure_policy: card.disclosure_policy,
    issued_at: card.issued_at,
    expires_at: card.expires_at,
    revocation_status: card.revocation_status,
    jws_present: card.verification?.jws_present ?? false,
  };
}

function toVerificationCardDetail(card: VerificationCard) {
  return {
    card_id: card.card_id,
    schema_version: card.schema_version,
    issuer: card.issuer,
    claims: card.claims.map((claim) => ({
      claim_id: claim.claim_id,
      claim_type: claim.claim_type,
      claim_value: claim.claim_value,
      assurance_level: claim.assurance_level,
      verified_at: claim.verified_at,
      expires_at: claim.expires_at,
      // provider_reference_id intentionally omitted — internal opaque token
    })),
    disclosure_policy: card.disclosure_policy,
    issued_at: card.issued_at,
    expires_at: card.expires_at,
    revocation_status: card.revocation_status,
    limitations: card.limitations,
    jws_present: card.verification?.jws_present ?? false,
  };
}

// ─── External session helpers ─────────────────────────────────────────────────

const HANDOFF_TITLES: Record<string, string> = {
  student_status: "Verify Your Student Status",
  military_status: "Verify Your Military Status",
  government_id: "Verify Your Identity",
};

const HANDOFF_DESCRIPTIONS: Record<string, string> = {
  student_status: "Confirm your enrollment through a trusted student eligibility provider. Only your institution name and verified status will be stored.",
  military_status: "Confirm your military affiliation through a trusted eligibility provider. Only your affiliation status will be stored.",
  government_id: "Verify your identity through a trusted identity provider. No documents or document numbers are stored — only your verified status.",
};

function toHandoffView(
  session: ExternalVerificationSession,
  descriptor: ReturnType<typeof findExternalProviderDescriptor> & object
): ExternalVerificationHandoffView {
  return {
    session_id: session.session_id,
    verification_type: session.verification_type,
    provider_name: session.provider_name,
    provider_display_name: descriptor.display_name,
    status: session.status,
    title: HANDOFF_TITLES[session.verification_type] ?? "Verify",
    description: HANDOFF_DESCRIPTIONS[session.verification_type] ?? "",
    privacy_guarantees: descriptor.privacy_summary,
    agent_can_prove: descriptor.agent_disclosure_summary,
    expires_at: session.expires_at,
    raw_provider_payload_revealed_to_agent: false,
    raw_document_revealed_to_agent: false,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function verificationRoutes(server: FastifyInstance): Promise<void> {
  server.get("/api/verifications/types", async (_req, reply) => {
    return reply.send({
      ok: true,
      data: {
        providers: PROVIDERS.map((p) => ({
          name: p.name,
          supported_types: p.supported_types,
        })),
        external_providers: EXTERNAL_PROVIDER_DESCRIPTORS,
      },
    });
  });

  // ─── External verification session endpoints ─────────────────────────────

  server.post<{
    Body: { verification_type: VerificationType; provider_name: string };
  }>("/api/verifications/external-sessions", async (req, reply) => {
    const { verification_type, provider_name } = req.body ?? {};

    if (!verification_type || !KNOWN_VERIFICATION_TYPES.has(verification_type as string)) {
      return reply.status(400).send({
        ok: false,
        error: { code: "UNKNOWN_VERIFICATION_TYPE", message: `Unknown verification type: ${verification_type}` },
      });
    }

    const descriptor = findExternalProviderDescriptor(provider_name);
    if (!descriptor) {
      return reply.status(400).send({
        ok: false,
        error: { code: "UNKNOWN_EXTERNAL_PROVIDER", message: `Unknown external provider: ${provider_name}` },
      });
    }

    if (!descriptor.supported_types.includes(verification_type)) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "PROVIDER_TYPE_MISMATCH",
          message: `Provider ${provider_name} does not support ${verification_type}.`,
        },
      });
    }

    const now = new Date();
    const session: ExternalVerificationSession = {
      session_id: newId("evps"),
      verification_type,
      provider_name: provider_name as ExternalVerificationProviderName,
      user_id: MOCK_USER_ID,
      status: "handoff_ready",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      raw_provider_payload_revealed_to_agent: false,
      raw_document_revealed_to_agent: false,
    };

    externalVerificationSessions.set(session.session_id, session);

    return reply.status(201).send({
      ok: true,
      data: {
        session_id: session.session_id,
        status: session.status,
        handoff: toHandoffView(session, descriptor),
      },
    });
  });

  server.get<{ Params: { sessionId: string } }>(
    "/api/verifications/external-sessions/:sessionId",
    async (req, reply) => {
      const session = externalVerificationSessions.get(req.params.sessionId);
      if (!session || session.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "External verification session not found." },
        });
      }

      const descriptor = findExternalProviderDescriptor(session.provider_name);
      if (!descriptor) {
        return reply.status(500).send({
          ok: false,
          error: { code: "PROVIDER_NOT_FOUND", message: "Provider descriptor no longer available." },
        });
      }

      return reply.send({
        ok: true,
        data: { handoff: toHandoffView(session, descriptor) },
      });
    }
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/verifications/external-sessions/:sessionId/mock-complete",
    async (req, reply) => {
      const session = externalVerificationSessions.get(req.params.sessionId);
      if (!session || session.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "External verification session not found." },
        });
      }

      if (session.status === "card_issued") {
        return reply.status(409).send({
          ok: false,
          error: { code: "SESSION_ALREADY_COMPLETED", message: "Verification card already issued for this session." },
        });
      }

      if (session.status === "failed" || session.status === "cancelled" || session.status === "expired") {
        return reply.status(409).send({
          ok: false,
          error: { code: "SESSION_TERMINAL", message: `Session is ${session.status} and cannot be completed.` },
        });
      }

      if (new Date() > new Date(session.expires_at)) {
        session.status = "expired";
        return reply.status(400).send({
          ok: false,
          error: { code: "SESSION_EXPIRED", message: "Verification session has expired." },
        });
      }

      // Normalize claim by provider
      const now = new Date().toISOString();
      let claimType: VerificationType;
      let claimValue: Record<string, string>;
      let assuranceLevel: "provider_verified" | "document_verified";
      let expiresAt: string | undefined;

      if (session.provider_name === "mock_sheerid_student") {
        claimType = "student_status";
        claimValue = {
          kind: "student_status",
          status: "verified_student",
          verification_method: "provider_handoff",
          provider: "mock_sheerid_student",
          institution_name: "University of Michigan",
          institution_domain: "umich.edu",
        };
        assuranceLevel = "provider_verified";
      } else if (session.provider_name === "mock_sheerid_military") {
        claimType = "military_status";
        claimValue = {
          kind: "military_status",
          status: "verified_military_affiliation",
          verification_method: "provider_handoff",
          provider: "mock_sheerid_military",
          affiliation: "military",
        };
        assuranceLevel = "provider_verified";
      } else {
        // mock_stripe_identity
        claimType = "government_id";
        claimValue = {
          kind: "government_id",
          status: "identity_verified",
          verification_method: "provider_handoff",
          provider: "mock_stripe_identity",
          identity_assurance_level: "mock_document_selfie",
        };
        assuranceLevel = "document_verified";
        expiresAt = new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString();
      }

      const cardId = newId("vc");
      const claim = {
        claim_id: newId("vc_claim"),
        card_id: cardId,
        claim_type: claimType,
        claim_value: claimValue as Parameters<typeof buildSignedVerificationCard>[0]["claims"][0]["claim_value"],
        assurance_level: assuranceLevel,
        verified_at: now,
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      };

      const cardFields = {
        card_id: cardId,
        schema_version: "1.0" as const,
        issuer: "aegis" as const,
        user_id: MOCK_USER_ID,
        claims: [claim],
        disclosure_policy: "user_approval_required" as const,
        issued_at: now,
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        revocation_status: "active" as const,
        limitations: {
          raw_document_revealed_to_agent: false as const,
          raw_document_revealed_to_website: false as const,
          provider_result_only: true as const,
          not_a_guarantee: true as const,
        },
      };

      const card = await buildSignedVerificationCard(cardFields);
      verificationCards.set(card.card_id, card);
      schedulePersist();

      session.status = "card_issued";
      session.completed_at = now;
      session.card_id = card.card_id;

      return reply.status(201).send({
        ok: true,
        data: {
          card: toVerificationCardSummary(card),
          session_id: session.session_id,
        },
      });
    }
  );

  server.post<{
    Body: { verification_type: VerificationType; provider_name?: string; mock_input?: unknown; email?: string };
  }>("/api/verifications/sessions", async (req, reply) => {
    const { verification_type, provider_name, mock_input, email } = req.body ?? {};

    if (!verification_type || !KNOWN_VERIFICATION_TYPES.has(verification_type as string)) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "UNKNOWN_VERIFICATION_TYPE",
          message: `Unknown verification type: ${verification_type}`,
        },
      });
    }

    const provider = provider_name
      ? findProvider(provider_name, verification_type)
      : findProviderForType(verification_type);

    if (!provider) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "UNKNOWN_PROVIDER",
          message: `No provider found for ${provider_name ?? verification_type}`,
        },
      });
    }

    const now = new Date();
    const session: VerificationProviderSession = {
      session_id: newId("vps"),
      user_id: MOCK_USER_ID,
      verification_type,
      provider_name: provider.name,
      status: "initiated",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };

    let sessionDeliveryMode: "email" | "dev_console" | undefined;

    if (provider.requires_code_step) {
      const rawEmail = typeof email === "string" ? email.trim() : "";
      if (!rawEmail || !rawEmail.includes("@")) {
        return reply.status(400).send({
          ok: false,
          error: { code: "EMAIL_REQUIRED", message: "A valid email address is required for this provider." },
        });
      }
      const domain = rawEmail.split("@")[1] ?? "";
      if (!domain || !domain.includes(".")) {
        return reply.status(400).send({
          ok: false,
          error: { code: "EMAIL_INVALID", message: "Email domain is invalid." },
        });
      }

      if (provider.name === "email_otp") {
        const normalizedEmail = rawEmail.toLowerCase();
        const limitCheck = checkOtpRateLimit(normalizedEmail);
        if (limitCheck === "rate_limited") {
          return reply.status(429).send({
            ok: false,
            error: { code: "OTP_RATE_LIMITED", message: "Too many verification emails sent. Please wait before trying again." },
          });
        }
        if (limitCheck === "resend_too_soon") {
          return reply.status(429).send({
            ok: false,
            error: { code: "OTP_RESEND_TOO_SOON", message: "Please wait 60 seconds before requesting another code." },
          });
        }

        const otp = String(randomInt(100000, 1000000));
        const hash = createHash("sha256").update(otp, "utf8").digest("hex");
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        sessionOtpRecords.set(session.session_id, { hash, expires_at: otpExpiry, attempt_count: 0 });
        sessionEmailDomains.set(session.session_id, domain.toLowerCase());

        const delivery = await sendVerificationOtpEmail({
          to_email: normalizedEmail,
          otp,
          session_id: session.session_id,
        });
        recordOtpSend(normalizedEmail);
        sessionDeliveryMode = delivery.delivery_mode;
      } else {
        // local_email: dev console only, no real delivery
        const otp = String(randomInt(100000, 1000000));
        const hash = createHash("sha256").update(otp, "utf8").digest("hex");
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        sessionOtpRecords.set(session.session_id, { hash, expires_at: otpExpiry, attempt_count: 0 });
        sessionEmailDomains.set(session.session_id, domain.toLowerCase());
        if (process.env.NODE_ENV !== "production") {
          console.log(`[local_email OTP] session=${session.session_id} otp=${otp}`);
        }
      }

      session.status = "in_progress";
    }

    const { provider_session_id, redirect_url } = await provider.initiate(session, email ? { email } : undefined);
    if (provider_session_id) {
      session.provider_session_id = provider_session_id;
    }

    verificationProviderSessions.set(session.session_id, session);
    if (mock_input !== undefined) {
      sessionMockInputs.set(session.session_id, mock_input);
    }

    return reply.status(201).send({
      ok: true,
      data: {
        session_id: session.session_id,
        verification_type: session.verification_type,
        provider_name: session.provider_name,
        status: session.status,
        ...(provider.requires_code_step ? { requires_code_step: true } : {}),
        ...(sessionDeliveryMode !== undefined ? { delivery_channel: "email", delivery_mode: sessionDeliveryMode } : {}),
        ...(redirect_url !== undefined ? { redirect_url } : {}),
        expires_at: session.expires_at,
        // provider_session_id intentionally omitted
      },
    });
  });

  server.get<{ Params: { sessionId: string } }>(
    "/api/verifications/sessions/:sessionId",
    async (req, reply) => {
      const session = verificationProviderSessions.get(req.params.sessionId);
      if (!session || session.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "Session not found." },
        });
      }
      return reply.send({
        ok: true,
        data: {
          session_id: session.session_id,
          verification_type: session.verification_type,
          provider_name: session.provider_name,
          status: session.status,
          created_at: session.created_at,
          expires_at: session.expires_at,
          // provider_session_id intentionally omitted
        },
      });
    }
  );

  server.post<{ Params: { sessionId: string }; Body: { mock_input?: unknown } }>(
    "/api/verifications/sessions/:sessionId/complete",
    async (req, reply) => {
      const session = verificationProviderSessions.get(req.params.sessionId);
      if (!session || session.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "Session not found." },
        });
      }

      if (new Date() > new Date(session.expires_at)) {
        return reply.status(400).send({
          ok: false,
          error: { code: "SESSION_EXPIRED", message: "Verification session has expired." },
        });
      }

      if (SESSION_TERMINAL_STATUSES.has(session.status)) {
        return reply.status(409).send({
          ok: false,
          error: {
            code: "SESSION_ALREADY_TERMINAL",
            message: `Session is already ${session.status}.`,
          },
        });
      }

      const provider = findProvider(session.provider_name, session.verification_type);
      if (!provider) {
        return reply.status(500).send({
          ok: false,
          error: { code: "PROVIDER_NOT_FOUND", message: "Provider no longer available." },
        });
      }

      if (provider.requires_code_step === true) {
        return reply.status(400).send({
          ok: false,
          error: {
            code: "CODE_STEP_REQUIRED",
            message: "This session requires a code step. Call /submit-code instead.",
          },
        });
      }

      const mockInput = req.body?.mock_input ?? sessionMockInputs.get(session.session_id);
      const result = await provider.complete(session, mockInput);

      const cardId = newId("vc");
      const now = new Date().toISOString();

      const claims = result.claims.map((c) => ({
        ...c,
        claim_id: newId("vc_claim"),
        card_id: cardId,
      }));

      const cardFields = {
        card_id: cardId,
        schema_version: "1.0" as const,
        issuer: "aegis" as const,
        user_id: MOCK_USER_ID,
        claims,
        disclosure_policy: "user_approval_required" as const,
        issued_at: now,
        ...(result.expires_at !== undefined ? { expires_at: result.expires_at } : {}),
        revocation_status: "active" as const,
        limitations: {
          raw_document_revealed_to_agent: false as const,
          raw_document_revealed_to_website: false as const,
          provider_result_only: true as const,
          not_a_guarantee: true as const,
        },
      };

      const card = await buildSignedVerificationCard(cardFields);
      verificationCards.set(card.card_id, card);
      schedulePersist();

      session.status = "completed";
      sessionMockInputs.delete(session.session_id);

      return reply.status(201).send({
        ok: true,
        data: { card: toVerificationCardDetail(card) },
      });
    }
  );

  server.post<{ Params: { sessionId: string }; Body: { code: string } }>(
    "/api/verifications/sessions/:sessionId/submit-code",
    async (req, reply) => {
      const session = verificationProviderSessions.get(req.params.sessionId);
      if (!session || session.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "Session not found." },
        });
      }

      if (new Date() > new Date(session.expires_at)) {
        return reply.status(400).send({
          ok: false,
          error: { code: "SESSION_EXPIRED", message: "Verification session has expired." },
        });
      }

      const provider = findProvider(session.provider_name, session.verification_type);
      if (!provider?.requires_code_step) {
        return reply.status(400).send({
          ok: false,
          error: { code: "CODE_NOT_SUPPORTED", message: "This session does not require a code step." },
        });
      }

      if (session.status !== "in_progress") {
        return reply.status(409).send({
          ok: false,
          error: { code: "SESSION_NOT_AWAITING_CODE", message: `Session is ${session.status}, not awaiting a code.` },
        });
      }

      const otpRecord = sessionOtpRecords.get(session.session_id);
      if (!otpRecord) {
        return reply.status(400).send({
          ok: false,
          error: { code: "OTP_NOT_FOUND", message: "OTP record not found for this session." },
        });
      }

      if (new Date() > new Date(otpRecord.expires_at)) {
        sessionOtpRecords.delete(session.session_id);
        return reply.status(400).send({
          ok: false,
          error: { code: "OTP_EXPIRED", message: "The code has expired. Please start a new verification." },
        });
      }

      if (otpRecord.attempt_count >= 5) {
        return reply.status(429).send({
          ok: false,
          error: { code: "TOO_MANY_ATTEMPTS", message: "Too many incorrect attempts. Please start a new verification." },
        });
      }

      const code = String(req.body?.code ?? "");
      const computedHash = createHash("sha256").update(code, "utf8").digest("hex");
      const storedBuf = Buffer.from(otpRecord.hash, "hex");
      const computedBuf = Buffer.from(computedHash, "hex");

      otpRecord.attempt_count += 1;

      const codeMatches =
        storedBuf.length === computedBuf.length && timingSafeEqual(storedBuf, computedBuf);

      if (!codeMatches) {
        return reply.status(400).send({
          ok: false,
          error: {
            code: "INVALID_CODE",
            message: "The code you entered is incorrect.",
            attempts_remaining: 5 - otpRecord.attempt_count,
          },
        });
      }

      // Code validated — build and sign the VerificationCard directly
      const email_domain = sessionEmailDomains.get(session.session_id) ?? "";
      const expires_at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const cardId = newId("vc");
      const now = new Date().toISOString();

      const claims = [
        {
          claim_id: newId("vc_claim"),
          card_id: cardId,
          claim_type: "email_ownership" as const,
          claim_value: { kind: "email_ownership" as const, email_domain },
          assurance_level: "provider_verified" as const,
          verified_at: now,
          expires_at,
        },
      ];

      const cardFields = {
        card_id: cardId,
        schema_version: "1.0" as const,
        issuer: "aegis" as const,
        user_id: MOCK_USER_ID,
        claims,
        disclosure_policy: "user_approval_required" as const,
        issued_at: now,
        expires_at,
        revocation_status: "active" as const,
        limitations: {
          raw_document_revealed_to_agent: false as const,
          raw_document_revealed_to_website: false as const,
          provider_result_only: true as const,
          not_a_guarantee: true as const,
        },
      };

      const card = await buildSignedVerificationCard(cardFields);
      verificationCards.set(card.card_id, card);
      schedulePersist();

      session.status = "completed";

      // Cleanup ephemeral OTP data immediately after use
      sessionOtpRecords.delete(session.session_id);
      sessionEmailDomains.delete(session.session_id);
      sessionMockInputs.delete(session.session_id);

      return reply.status(201).send({
        ok: true,
        data: { card: toVerificationCardDetail(card) },
      });
    }
  );

  server.get("/api/verifications/cards", async (_req, reply) => {
    const cards = Array.from(verificationCards.values()).filter(
      (c) => c.user_id === MOCK_USER_ID
    );
    return reply.send({
      ok: true,
      data: { cards: cards.map(toVerificationCardSummary) },
    });
  });

  server.get<{ Params: { cardId: string } }>(
    "/api/verifications/cards/:cardId",
    async (req, reply) => {
      const card = verificationCards.get(req.params.cardId);
      if (!card || card.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "CARD_NOT_FOUND", message: "Verification card not found." },
        });
      }
      return reply.send({
        ok: true,
        data: { card: toVerificationCardDetail(card) },
      });
    }
  );

  server.get<{ Params: { cardId: string } }>(
    "/api/verifications/cards/:cardId/verify",
    async (req, reply) => {
      const card = verificationCards.get(req.params.cardId);
      if (!card || card.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "CARD_NOT_FOUND", message: "Verification card not found." },
        });
      }
      const result = await verifyStoredVerificationCard(card);
      const expired = card.expires_at ? new Date() > new Date(card.expires_at) : false;
      return reply.send({
        ok: true,
        data: {
          hash_valid: result.hash_valid,
          signature_valid: result.signature_valid,
          expired,
          revoked: card.revocation_status === "revoked",
          jws_present: card.verification?.jws_present ?? false,
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      });
    }
  );

  server.post<{ Params: { cardId: string } }>(
    "/api/verifications/cards/:cardId/revoke",
    async (req, reply) => {
      const card = verificationCards.get(req.params.cardId);
      if (!card || card.user_id !== MOCK_USER_ID) {
        return reply.status(404).send({
          ok: false,
          error: { code: "CARD_NOT_FOUND", message: "Verification card not found." },
        });
      }
      card.revocation_status = "revoked";
      schedulePersist();
      return reply.send({
        ok: true,
        data: { card: toVerificationCardSummary(card) },
      });
    }
  );
}
