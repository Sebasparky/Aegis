import type { FastifyInstance } from "fastify";
import type { VerificationCard, VerificationType, VerificationProviderSession } from "@aegis/types";
import {
  verificationCards,
  verificationProviderSessions,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import {
  buildSignedVerificationCard,
  verifyStoredVerificationCard,
} from "../lib/verificationCardSigning.js";
import { PROVIDERS, findProvider, findProviderForType } from "../lib/verificationProviders.js";

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
      },
    });
  });

  server.post<{
    Body: { verification_type: VerificationType; provider_name?: string; mock_input?: unknown };
  }>("/api/verifications/sessions", async (req, reply) => {
    const { verification_type, provider_name, mock_input } = req.body ?? {};

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

    const { provider_session_id, redirect_url } = await provider.initiate(session);
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
