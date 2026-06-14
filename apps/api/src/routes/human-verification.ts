/**
 * Human Presence Relay v1 — internal (Aegis UI) routes.
 *
 * The user-facing side of the relay: list pending human-verification requests,
 * stream a live press-and-hold (hold-start → 300ms heartbeats → hold-end),
 * confirm presence (checkbox challenges), recheck (manual captcha handoff),
 * and cancel.
 *
 * Heartbeat transport contract (v1, swappable later):
 * - hold-start dispatches the browser mousePressed and arms a 1.2s fail-closed
 *   timer; the browser hold lives ONLY while heartbeats keep arriving.
 * - heartbeat re-arms the timer. Silence → immediate browser mouseReleased.
 * - hold-end releases in the browser and probes whether the challenge cleared.
 * - No gesture is recorded, stored, or replayed anywhere.
 *
 * SAFETY: responses carry the safe request view only — never selectors,
 * coordinates, boxes, CDP expressions, cookies, or page values. Completing a
 * human verification NEVER authorizes a purchase (purchase_authorized: false).
 */

import type { FastifyInstance } from "fastify";
import type { HumanVerificationRequest } from "@aegis/types";

import { MOCK_USER_ID, humanVerificationRequests } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import {
  cancelHumanVerificationRequest,
  failHumanVerificationRequest,
  humanVerificationAgentNextAction,
  isTerminalHumanVerificationStatus,
  lazyExpireHumanVerificationRequest,
  markHumanVerificationCompleted,
  resolveChallengeNoLongerPresent,
  toHumanVerificationRequestView,
} from "../lib/humanVerificationLifecycle.js";
import {
  confirmPresenceClick,
  endHoldSession,
  heartbeatHoldSession,
  probeHumanVerification,
  startHoldSession,
} from "../runtime/humanPresenceRelay.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

/** Lookup + ownership + lazy expiry. Returns undefined after replying. */
function loadRequest(
  requestId: string,
  reply: any,
): HumanVerificationRequest | undefined {
  const request = humanVerificationRequests.get(requestId);
  if (!request) {
    sendError(reply, 404, "NOT_FOUND", "Human-verification request not found.");
    return undefined;
  }
  if (request.user_id !== MOCK_USER_ID) {
    sendError(reply, 403, "FORBIDDEN", "Forbidden.");
    return undefined;
  }
  lazyExpireHumanVerificationRequest(request);
  return request;
}

function requireActionable(request: HumanVerificationRequest, reply: any): boolean {
  if (request.status === "pending_user" || request.status === "in_progress") return true;
  sendError(
    reply,
    409,
    "REQUEST_NOT_ACTIONABLE",
    `This request is '${request.status}' and can no longer be acted on.`,
  );
  return false;
}

export async function humanVerificationRoutes(server: FastifyInstance): Promise<void> {
  // List requests — approvals UI. Lazy expiry; terminal hidden by default.
  server.get("/api/internal/human-verification-requests", async (req, reply) => {
    const { status, include_terminal } = (req.query ?? {}) as {
      status?: string;
      include_terminal?: string;
    };

    let items = Array.from(humanVerificationRequests.values()).filter(
      (r) => r.user_id === MOCK_USER_ID,
    );
    for (const request of items) lazyExpireHumanVerificationRequest(request);
    if (include_terminal !== "true") {
      items = items.filter((r) => !isTerminalHumanVerificationStatus(r.status));
    }
    if (status) items = items.filter((r) => r.status === status);
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return reply.send({ ok: true, data: items.map(toHumanVerificationRequestView) });
  });

  // Read one request — the focused /human-verification/[id] page polls this.
  server.get<{ Params: { requestId: string } }>(
    "/api/internal/human-verification-requests/:requestId",
    async (req, reply) => {
      const request = loadRequest(req.params.requestId, reply);
      if (!request) return;
      return reply.send({ ok: true, data: toHumanVerificationRequestView(request) });
    },
  );

  // ── Live hold relay (press_and_hold) ──────────────────────────────────────

  server.post<{ Params: { requestId: string } }>(
    "/api/internal/human-verification-requests/:requestId/hold-start",
    async (req, reply) => {
      const request = loadRequest(req.params.requestId, reply);
      if (!request) return;
      if (!requireActionable(request, reply)) return;
      // Page-level walls put the control inside a cross-origin iframe the relay
      // cannot target — never attempt a live hold; the UI routes these to manual
      // completion + recheck instead. Defense-in-depth (the UI hides the hold
      // button for page_level requests).
      if (request.page_level) {
        return sendError(
          reply,
          409,
          "MANUAL_COMPLETION_REQUIRED",
          "This challenge's control is inside a secured frame Aegis can't relay into. Complete it in the agent's browser window, then recheck.",
        );
      }
      if (request.challenge_type !== "press_and_hold") {
        return sendError(
          reply,
          400,
          "WRONG_CHALLENGE_TYPE",
          `hold-start applies to press_and_hold challenges only (this request is '${request.challenge_type}').`,
        );
      }

      const result = await startHoldSession(request, (reason) => {
        // Auto-release (fail-closed silence / max duration): the request stays
        // retryable until TTL — record why the hold dropped, nothing else.
        request.error = reason === "fail_closed" ? "hold_released_fail_closed" : "hold_released_max_duration";
        humanVerificationRequests.set(request.request_id, request);
        schedulePersist();
      });

      if (!result.ok) {
        if (result.code === "CHALLENGE_NOT_PRESENT") {
          // The challenge vanished before any live interaction — never credit
          // presence that didn't happen; the agent re-snapshots and resumes.
          resolveChallengeNoLongerPresent(request);
          return reply.send({
            ok: true,
            data: { ...toHumanVerificationRequestView(request), hold_state: "challenge_gone" },
          });
        }
        if (result.code === "BROWSER_SESSION_NOT_READY") {
          failHumanVerificationRequest(request, "browser_session_not_ready");
          return sendError(reply, 409, result.code, result.message ?? "Browser session is not ready.");
        }
        if (result.code === "HOLD_ALREADY_ACTIVE") {
          return sendError(reply, 409, result.code, result.message ?? "A live hold is already active.");
        }
        // CONTROL_NOT_FOUND / CDP_FAILED — transient; stays retryable until TTL.
        return sendError(reply, 502, result.code ?? "CDP_FAILED", result.message ?? "Could not start the hold.");
      }

      request.status = "in_progress";
      request.started_at = request.started_at ?? new Date().toISOString();
      request.hold_attempt_count += 1;
      delete request.error;
      humanVerificationRequests.set(request.request_id, request);
      schedulePersist();
      return reply.send({
        ok: true,
        data: { ...toHumanVerificationRequestView(request), hold_state: "holding" },
      });
    },
  );

  server.post<{ Params: { requestId: string } }>(
    "/api/internal/human-verification-requests/:requestId/heartbeat",
    async (req, reply) => {
      const request = loadRequest(req.params.requestId, reply);
      if (!request) return;
      if (request.status !== "in_progress") {
        return sendError(reply, 409, "NO_ACTIVE_HOLD", `No live hold for a '${request.status}' request.`);
      }
      const { holding } = heartbeatHoldSession(request.request_id);
      return reply.send({
        ok: true,
        data: { request_id: request.request_id, hold_state: holding ? "holding" : "released_fail_closed" },
      });
    },
  );

  server.post<{ Params: { requestId: string } }>(
    "/api/internal/human-verification-requests/:requestId/hold-end",
    async (req, reply) => {
      const request = loadRequest(req.params.requestId, reply);
      if (!request) return;
      if (request.status !== "in_progress") {
        return sendError(reply, 409, "NO_ACTIVE_HOLD", `No live hold for a '${request.status}' request.`);
      }

      const result = await endHoldSession(request.request_id);
      if (result.hold_state === "no_hold") {
        return sendError(reply, 409, "NO_ACTIVE_HOLD", "No live hold is active for this request.");
      }

      if (result.challenge_present === false) {
        markHumanVerificationCompleted(request, "relayed_live_presence");
      } else {
        // Still present (or probe unreadable): NOT a failure — the site may
        // need a longer hold. Retryable until TTL.
        request.error = result.challenge_present === true ? "challenge_still_present" : result.probe_error ?? "post_release_probe_failed";
        humanVerificationRequests.set(request.request_id, request);
        schedulePersist();
      }

      return reply.send({
        ok: true,
        data: {
          ...toHumanVerificationRequestView(request),
          hold_state: result.hold_state,
          held_ms: result.held_ms,
          challenge_present: result.challenge_present,
        },
      });
    },
  );

  // ── Single-tap confirmation (checkbox_human) ──────────────────────────────

  server.post<{ Params: { requestId: string } }>(
    "/api/internal/human-verification-requests/:requestId/confirm",
    async (req, reply) => {
      const request = loadRequest(req.params.requestId, reply);
      if (!request) return;
      if (!requireActionable(request, reply)) return;
      if (request.challenge_type !== "checkbox_human") {
        return sendError(
          reply,
          400,
          "WRONG_CHALLENGE_TYPE",
          `confirm applies to checkbox_human challenges only (this request is '${request.challenge_type}').`,
        );
      }

      request.status = "in_progress";
      request.started_at = request.started_at ?? new Date().toISOString();
      request.hold_attempt_count += 1;
      humanVerificationRequests.set(request.request_id, request);
      schedulePersist();

      const result = await confirmPresenceClick(request);
      if (!result.ok) {
        if (result.code === "CHALLENGE_NOT_PRESENT") {
          resolveChallengeNoLongerPresent(request);
          return reply.send({
            ok: true,
            data: { ...toHumanVerificationRequestView(request), confirm_state: "challenge_gone" },
          });
        }
        if (result.code === "BROWSER_SESSION_NOT_READY") {
          failHumanVerificationRequest(request, "browser_session_not_ready");
          return sendError(reply, 409, result.code, result.message ?? "Browser session is not ready.");
        }
        return sendError(reply, 502, result.code ?? "CDP_FAILED", result.message ?? "Could not mirror the confirmation.");
      }

      if (result.challenge_present === false) {
        markHumanVerificationCompleted(request, "relayed_live_presence");
      } else {
        request.error = "challenge_still_present";
        humanVerificationRequests.set(request.request_id, request);
        schedulePersist();
      }
      return reply.send({
        ok: true,
        data: {
          ...toHumanVerificationRequestView(request),
          confirm_state: result.challenge_present === false ? "cleared" : "still_present",
        },
      });
    },
  );

  // ── Manual handoff recheck (captcha / unknown types) ──────────────────────
  // Probe-only: the user solved the challenge directly in the browser and is
  // telling Aegis to verify. Never clicks, never auto-solves.
  server.post<{ Params: { requestId: string } }>(
    "/api/internal/human-verification-requests/:requestId/recheck",
    async (req, reply) => {
      const request = loadRequest(req.params.requestId, reply);
      if (!request) return;
      if (!requireActionable(request, reply)) return;

      const result = await probeHumanVerification(request);
      if (!result.ok) {
        if (result.error.startsWith("BROWSER_SESSION_NOT_READY")) {
          failHumanVerificationRequest(request, "browser_session_not_ready");
          return sendError(reply, 409, "BROWSER_SESSION_NOT_READY", result.error);
        }
        return sendError(reply, 502, "PROBE_FAILED", result.error);
      }

      if (!result.probe.present) {
        markHumanVerificationCompleted(
          request,
          request.hold_attempt_count > 0 ? "relayed_live_presence" : "manual_user_completion",
        );
      } else {
        request.error = "challenge_still_present";
        humanVerificationRequests.set(request.request_id, request);
        schedulePersist();
      }
      return reply.send({
        ok: true,
        data: {
          ...toHumanVerificationRequestView(request),
          challenge_present: result.probe.present,
        },
      });
    },
  );

  // ── Cancel ────────────────────────────────────────────────────────────────
  server.post<{ Params: { requestId: string } }>(
    "/api/internal/human-verification-requests/:requestId/cancel",
    async (req, reply) => {
      const request = loadRequest(req.params.requestId, reply);
      if (!request) return;
      if (isTerminalHumanVerificationStatus(request.status)) {
        return reply.send({ ok: true, data: toHumanVerificationRequestView(request) });
      }
      cancelHumanVerificationRequest(request, "user_cancelled");
      return reply.send({ ok: true, data: toHumanVerificationRequestView(request) });
    },
  );
}

/** Agent-facing view: safe view + per-status next_action guidance. */
export function toAgentHumanVerificationView(request: HumanVerificationRequest) {
  return {
    ...toHumanVerificationRequestView(request),
    next_action: humanVerificationAgentNextAction(request),
  };
}
