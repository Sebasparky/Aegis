import type { FastifyInstance } from "fastify";
import type { ChallengeEmailResolution } from "@aegis/types";
import {
  MOCK_USER_ID,
  securityChallenges,
  challengeEmailResolutions,
  newId,
} from "../store/index.js";
import {
  resolutionCodes,
  getEmailResolverStatus,
  searchGmailForChallengeCode,
  isEmailChallengeSupported,
  classifyGmailError,
} from "../runtime/emailChallengeResolver.js";
import { schedulePersist } from "../store/persistence.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

function safeResolution(res: ChallengeEmailResolution) {
  return {
    resolution_id: res.resolution_id,
    challenge_id: res.challenge_id,
    provider: res.provider,
    domain: res.domain,
    status: res.status,
    raw_code_revealed_to_agent: false as const,
    email_body_revealed_to_agent: false as const,
    search_window_started_at: res.search_window_started_at,
    searched_at: res.searched_at,
    found_at: res.found_at,
    injected_at: res.injected_at,
    sender_domain: res.sender_domain,
    received_at: res.received_at,
    extraction_source: res.extraction_source,
    error: res.error,
    email_search_error_code: res.email_search_error_code,
    manual_entry_available: res.status === "failed" ? (true as const) : undefined,
    created_at: res.created_at,
    updated_at: res.updated_at,
  };
}

export async function emailChallengeResolverRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/internal/email-resolver/status — check if Gmail resolver is configured
  server.get("/api/internal/email-resolver/status", async (_req, reply) => {
    const status = getEmailResolverStatus();
    return reply.send({ ok: true, data: status });
  });

  // GET /api/internal/challenge-email-resolutions — list resolutions for current user
  server.get("/api/internal/challenge-email-resolutions", async (req, reply) => {
    const { challenge_id } = (req.query ?? {}) as { challenge_id?: string };
    const now = new Date();

    let items = Array.from(challengeEmailResolutions.values()).filter(
      (r) => r.user_id === MOCK_USER_ID,
    );

    // Lazy expiry: mark non-terminal resolutions as expired when their challenge has expired
    const NON_TERMINAL = new Set(["pending_approval", "searching", "code_found"]);
    let dirty = false;
    for (const res of items) {
      if (!NON_TERMINAL.has(res.status)) continue;
      const linked = securityChallenges.get(res.challenge_id);
      if (!linked || new Date(linked.expires_at) < now) {
        res.status = "expired";
        res.error = res.error ?? "The associated security challenge has expired.";
        res.updated_at = now.toISOString();
        resolutionCodes.delete(res.resolution_id);
        challengeEmailResolutions.set(res.resolution_id, res);
        dirty = true;
      }
    }
    if (dirty) schedulePersist();

    if (challenge_id) items = items.filter((r) => r.challenge_id === challenge_id);
    return reply.send({ ok: true, data: items.map(safeResolution) });
  });

  // POST /api/internal/challenge-email-resolutions/start
  // User-initiated: creates a resolution AND immediately approves (runs Gmail search synchronously).
  // The click IS the approval — no separate approve step needed from the UI.
  server.post<{ Body: { challenge_id?: unknown } }>(
    "/api/internal/challenge-email-resolutions/start",
    async (req, reply) => {
      const challengeId = req.body?.challenge_id;
      if (!challengeId || typeof challengeId !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "challenge_id is required.");
      }

      const challenge = securityChallenges.get(challengeId);
      if (!challenge) return sendError(reply, 404, "NOT_FOUND", "Security challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");

      if (challenge.status !== "pending_user") {
        return sendError(
          reply, 400, "INVALID_CHALLENGE_STATUS",
          `Challenge status is '${challenge.status}'. Gmail resolver requires status 'pending_user'.`,
        );
      }
      if (new Date(challenge.expires_at) < new Date()) {
        challenge.status = "expired";
        securityChallenges.set(challengeId, challenge);
        schedulePersist();
        return sendError(reply, 400, "CHALLENGE_EXPIRED", "Challenge has expired.");
      }
      if (!isEmailChallengeSupported(challenge.domain)) {
        return sendError(
          reply, 400, "DOMAIN_NOT_SUPPORTED",
          `Gmail resolver does not support '${challenge.domain}' challenges.`,
        );
      }

      // Deduplication: if a non-terminal resolution already exists for this challenge, return it
      const existing = Array.from(challengeEmailResolutions.values()).find(
        (r) => r.challenge_id === challengeId && !["injected", "not_found", "failed", "expired", "cancelled"].includes(r.status),
      );
      if (existing) {
        // If already code_found, the agent can inject — no need to re-search
        if (existing.status === "code_found") {
          return reply.send({ ok: true, data: safeResolution(existing) });
        }
        // pending_approval: re-run the search (user re-clicked)
      }

      const now = new Date().toISOString();
      const resolution: ChallengeEmailResolution = existing ?? {
        resolution_id: newId("ceres"),
        challenge_id: challengeId,
        user_id: MOCK_USER_ID,
        delegation_id: challenge.delegation_id,
        provider: "gmail",
        domain: challenge.domain,
        status: "pending_approval",
        raw_code_revealed_to_agent: false,
        email_body_revealed_to_agent: false,
        search_window_started_at: challenge.created_at,
        created_at: now,
        updated_at: now,
      };

      // Run Gmail search synchronously — user click = approval
      const searchedAt = new Date().toISOString();
      resolution.searched_at = searchedAt;
      resolution.updated_at = searchedAt;

      try {
        const result = await searchGmailForChallengeCode(challenge);

        if (result) {
          // Code found: store in memory-only resolutionCodes with 5-min TTL
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          resolutionCodes.set(resolution.resolution_id, { code: result.code, expires_at: expiresAt });

          resolution.status = "code_found";
          resolution.found_at = new Date().toISOString();
          resolution.sender_domain = result.sender_domain;
          resolution.received_at = result.received_at;
          resolution.extraction_source = result.extraction_source;
          resolution.updated_at = resolution.found_at;
        } else {
          resolution.status = "not_found";
          resolution.updated_at = new Date().toISOString();
        }
      } catch (err: unknown) {
        const { email_search_error_code, user_message } = classifyGmailError(err);
        console.error("[email-resolver] Gmail search failed:", err instanceof Error ? err.message : err);
        resolution.status = "failed";
        resolution.error = user_message;
        resolution.email_search_error_code = email_search_error_code;
        resolution.updated_at = new Date().toISOString();
      }

      challengeEmailResolutions.set(resolution.resolution_id, resolution);
      schedulePersist();

      return reply.send({ ok: true, data: safeResolution(resolution) });
    },
  );

  // POST /api/internal/challenge-email-resolutions/:resolutionId/approve
  // Used when the agent created the resolution (pending_approval) and the user approves from the UI.
  server.post<{ Params: { resolutionId: string } }>(
    "/api/internal/challenge-email-resolutions/:resolutionId/approve",
    async (req, reply) => {
      const resolution = challengeEmailResolutions.get(req.params.resolutionId);
      if (!resolution) return sendError(reply, 404, "NOT_FOUND", "Resolution not found.");
      if (resolution.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
      if (resolution.status !== "pending_approval") {
        return sendError(
          reply, 400, "INVALID_STATUS",
          `Resolution status is '${resolution.status}'. Can only approve 'pending_approval' resolutions.`,
        );
      }

      const challenge = securityChallenges.get(resolution.challenge_id);
      if (!challenge || new Date(challenge.expires_at) < new Date()) {
        resolution.status = "expired";
        resolution.error = "The associated security challenge has expired.";
        resolution.updated_at = new Date().toISOString();
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
        return sendError(reply, 400, "CHALLENGE_EXPIRED", "The associated security challenge has expired.");
      }

      const searchedAt = new Date().toISOString();
      resolution.searched_at = searchedAt;
      resolution.updated_at = searchedAt;

      try {
        const result = await searchGmailForChallengeCode(challenge);

        if (result) {
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          resolutionCodes.set(resolution.resolution_id, { code: result.code, expires_at: expiresAt });

          resolution.status = "code_found";
          resolution.found_at = new Date().toISOString();
          resolution.sender_domain = result.sender_domain;
          resolution.received_at = result.received_at;
          resolution.extraction_source = result.extraction_source;
          resolution.updated_at = resolution.found_at;
        } else {
          resolution.status = "not_found";
          resolution.updated_at = new Date().toISOString();
        }
      } catch (err: unknown) {
        const { email_search_error_code, user_message } = classifyGmailError(err);
        console.error("[email-resolver] Gmail search failed:", err instanceof Error ? err.message : err);
        resolution.status = "failed";
        resolution.error = user_message;
        resolution.email_search_error_code = email_search_error_code;
        resolution.updated_at = new Date().toISOString();
      }

      challengeEmailResolutions.set(resolution.resolution_id, resolution);
      schedulePersist();

      return reply.send({ ok: true, data: safeResolution(resolution) });
    },
  );

  // POST /api/internal/challenge-email-resolutions/:resolutionId/cancel
  server.post<{ Params: { resolutionId: string } }>(
    "/api/internal/challenge-email-resolutions/:resolutionId/cancel",
    async (req, reply) => {
      const resolution = challengeEmailResolutions.get(req.params.resolutionId);
      if (!resolution) return sendError(reply, 404, "NOT_FOUND", "Resolution not found.");
      if (resolution.user_id !== MOCK_USER_ID) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");

      resolutionCodes.delete(resolution.resolution_id);
      resolution.status = "cancelled";
      resolution.updated_at = new Date().toISOString();
      challengeEmailResolutions.set(resolution.resolution_id, resolution);
      schedulePersist();

      return reply.send({ ok: true, data: safeResolution(resolution) });
    },
  );
}
