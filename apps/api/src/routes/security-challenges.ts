import type { FastifyInstance } from "fastify";
import type { SecurityChallenge } from "@aegis/types";
import { MOCK_USER_ID, securityChallenges } from "../store/index.js";
import { challengeCodes } from "../runtime/challengeInjection.js";
import { schedulePersist } from "../store/persistence.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

function safeChallenge(ch: SecurityChallenge) {
  return {
    challenge_id: ch.challenge_id,
    domain: ch.domain,
    page_url: ch.page_url,
    challenge_type: ch.challenge_type,
    status: ch.status,
    masked_destination: ch.masked_destination,
    element_hint: ch.element_hint,
    instructions: ch.instructions,
    raw_code_revealed_to_agent: false as const,
    created_at: ch.created_at,
    expires_at: ch.expires_at,
    submitted_at: ch.submitted_at,
    injected_at: ch.injected_at,
    completed_at: ch.completed_at,
    error: ch.error,
  };
}

const TERMINAL_STATUSES = new Set(["expired", "cancelled", "code_injected", "user_completed", "failed"]);

export async function securityChallengeRoutes(server: FastifyInstance): Promise<void> {
  // List challenges — used by the approval UI
  server.get("/api/internal/security-challenges", async (req, reply) => {
    const { status, include_terminal } = (req.query ?? {}) as { status?: string; include_terminal?: string };
    const now = new Date();

    let items = Array.from(securityChallenges.values()).filter(
      (c) => c.user_id === MOCK_USER_ID,
    );

    // Lazy expiry: mark stale active challenges as expired
    let dirty = false;
    for (const challenge of items) {
      if (
        (challenge.status === "pending_user" || challenge.status === "code_submitted") &&
        new Date(challenge.expires_at) < now
      ) {
        challenge.status = "expired";
        challengeCodes.delete(challenge.challenge_id);
        securityChallenges.set(challenge.challenge_id, challenge);
        dirty = true;
      }
    }
    if (dirty) schedulePersist();

    // By default hide terminal statuses; ?include_terminal=true for debugging
    if (include_terminal !== "true") {
      items = items.filter((c) => !TERMINAL_STATUSES.has(c.status));
    }

    if (status) items = items.filter((c) => c.status === status);
    return reply.send({ ok: true, data: items.map(safeChallenge) });
  });

  // User submits code into Aegis UI — code is stored memory-only, not persisted
  server.post<{ Params: { challengeId: string }; Body: { code?: unknown } }>(
    "/api/internal/security-challenges/:challengeId/submit-code",
    async (req, reply) => {
      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "NOT_FOUND", "Challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (challenge.status !== "pending_user") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot submit code for challenge with status '${challenge.status}'.`);
      }
      if (new Date(challenge.expires_at) < new Date()) {
        challenge.status = "expired";
        securityChallenges.set(challenge.challenge_id, challenge);
        schedulePersist();
        return sendError(reply, 400, "CHALLENGE_EXPIRED", "Challenge has expired.");
      }

      const rawCode = req.body?.code;
      if (!rawCode || typeof rawCode !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "code is required.");
      }
      const code = rawCode.trim();
      if (code.length < 4 || code.length > 10 || !/^[a-zA-Z0-9]+$/.test(code)) {
        return sendError(reply, 400, "INVALID_CODE", "code must be 4–10 alphanumeric characters.");
      }

      // Memory-only — never persisted; expires at the sooner of challenge TTL or 5 minutes from now
      const codeExpiresAt = new Date(
        Math.min(new Date(challenge.expires_at).getTime(), Date.now() + 5 * 60 * 1000),
      ).toISOString();
      challengeCodes.set(challenge.challenge_id, { code, expires_at: codeExpiresAt });

      challenge.status = "code_submitted";
      challenge.submitted_at = new Date().toISOString();
      securityChallenges.set(challenge.challenge_id, challenge);
      schedulePersist();

      return reply.send({ ok: true, data: safeChallenge(challenge) });
    },
  );

  // User cancelled the challenge
  server.post<{ Params: { challengeId: string } }>(
    "/api/internal/security-challenges/:challengeId/cancel",
    async (req, reply) => {
      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "NOT_FOUND", "Challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      challenge.status = "cancelled";
      challengeCodes.delete(challenge.challenge_id);
      securityChallenges.set(challenge.challenge_id, challenge);
      schedulePersist();
      return reply.send({ ok: true, data: safeChallenge(challenge) });
    },
  );

  // User completed the challenge directly in the browser (Phase 1 handoff path)
  server.post<{ Params: { challengeId: string } }>(
    "/api/internal/security-challenges/:challengeId/complete",
    async (req, reply) => {
      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "NOT_FOUND", "Challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      challenge.status = "user_completed";
      challenge.completed_at = new Date().toISOString();
      challengeCodes.delete(challenge.challenge_id);
      securityChallenges.set(challenge.challenge_id, challenge);
      schedulePersist();
      return reply.send({ ok: true, data: safeChallenge(challenge) });
    },
  );
}
