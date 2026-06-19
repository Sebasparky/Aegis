// ─── Visual Gesture Capsule — M1D internal user-facing endpoints ──────────────
//
// HTTP surface for the future Antigen app/web UI to drive a VisualGestureCapsule
// (the opaque-HV-wall user-presence path): list active capsules, fetch the held
// redacted screenshot frame, recapture that frame, recheck capsule state, and
// cancel a capsule.
//
// Strictly internal/user-facing — these routes are NOT registered on, exposed
// through, or callable by any agent-facing surface (/api/agent/v1). They reuse
// the M1A lifecycle + safe view, the M1B frame store, and the M1C capture helper;
// they add NO gesture relay, NO tap/press_hold dispatch, NO CDP input dispatch,
// NO humanPresenceRelay.ts changes, and NO agent-api tool wiring.
//
// Bytes discipline (mirrors M1B/M1C): the redacted PNG appears in exactly ONE
// place — GET /:id/screenshot. List, recapture, recheck, and cancel return only
// safe-view / safe-metadata shapes (availability + timestamps); never png_base64,
// viewport dimensions, coordinates, gesture traces, or any reusable strategy.
//
// Gated behind ANTIGEN_VISUAL_GESTURE_CAPSULE (default off, byte-identical when
// off): the list endpoint returns an empty `{ disabled: true }` list; every
// non-list endpoint returns a structured 404 VISUAL_GESTURE_CAPSULE_DISABLED.

import type { FastifyInstance } from "fastify";

import {
  isVisualGestureCapsuleEnabled,
  listActiveVisualGestureCapsules,
  getVisualGestureCapsule,
  getVisualGestureCapsuleScreenshotFrame,
  getSafeVisualGestureCapsuleView,
  cancelVisualGestureCapsule,
} from "../runtime/visualGestureCapsule.js";
import { captureVisualGestureCapsuleScreenshotFrame } from "../runtime/visualGestureCapsuleCapture.js";
import { relayVisualGestureCapsuleGesture } from "../runtime/visualGestureCapsuleRelay.js";
import { recheckVisualGestureCapsule } from "../runtime/visualGestureCapsuleRecheck.js";
import {
  startVgcHoldSession,
  heartbeatVgcHoldSession,
  endVgcHoldSession,
  cancelVgcHoldSession,
} from "../runtime/visualGestureCapsuleHold.js";
import { getTaskBrowserSessionCdpUrl } from "../runtime/taskBrowserSessions.js";

// Resolve the CDP base for a capsule's gesture/recheck/recapture call. The UI
// never holds a cdp_url; the server derives it from the capsule's authoritative
// browser_session_id link (M2B). An explicit body.cdp_url stays supported for
// backward-compatible internal callers/tests. The resolved value is used only to
// drive the relay/recheck/capture helpers — it is NEVER echoed in any response.
function resolveCapsuleCdpUrl(
  bodyCdpUrl: unknown,
  browserSessionId: string,
): string | undefined {
  if (typeof bodyCdpUrl === "string" && bodyCdpUrl.length > 0) return bodyCdpUrl;
  return getTaskBrowserSessionCdpUrl(browserSessionId);
}

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

// Map each relay refusal reason to a safe HTTP status + stable error code. The
// reason code is the ONLY relay detail surfaced — never the underlying pointer /
// browser error, cdp_url, target_id, coordinates, duration, or screenshot bytes.
// Unknown reasons fall back to a conservative 409 STORE_OR_STATE_FAILED.
const GESTURE_RELAY_ERROR_MAP: Record<string, { status: number; code: string }> = {
  flag_disabled: { status: 404, code: "VISUAL_GESTURE_CAPSULE_DISABLED" },
  not_found: { status: 404, code: "NOT_FOUND" },
  terminal: { status: 409, code: "TERMINAL" },
  manual_fallback: { status: 409, code: "MANUAL_FALLBACK" },
  invalid_gesture: { status: 400, code: "INVALID_GESTURE" },
  invalid_coordinates: { status: 400, code: "INVALID_COORDINATES" },
  screenshot_frame_unavailable: { status: 409, code: "SCREENSHOT_FRAME_UNAVAILABLE" },
  // Stale/mismatched viewport — the mapped point can't be trusted. 409 so the UI
  // recaptures or falls back to manual. The code carries no dims/coords/deltas.
  viewport_drifted: { status: 409, code: "VIEWPORT_DRIFTED" },
  // Page scrolled or reflowed after capture — the static screenshot no longer
  // describes the live layout, so the mapped point would miss. Same 409 recapture
  // signal; the unified code carries no scroll/layout values or deltas.
  scroll_drifted: { status: 409, code: "FRAME_STALE_RECAPTURE_REQUIRED" },
  layout_drifted: { status: 409, code: "FRAME_STALE_RECAPTURE_REQUIRED" },
  pointer_dispatch_failed: { status: 502, code: "POINTER_DISPATCH_FAILED" },
  store_or_state_failed: { status: 409, code: "STORE_OR_STATE_FAILED" },
};

// Map each live-hold (hold-start) refusal reason to a safe HTTP status + stable
// error code. Reuses the gesture-relay codes where the meaning is identical
// (drift, manual fallback, missing frame). The reason code is the ONLY hold
// detail surfaced — never the mapped point, cdp_url, target_id, or browser error.
const GESTURE_HOLD_ERROR_MAP: Record<string, { status: number; code: string }> = {
  flag_disabled: { status: 404, code: "VISUAL_GESTURE_CAPSULE_DISABLED" },
  not_found: { status: 404, code: "NOT_FOUND" },
  terminal: { status: 409, code: "TERMINAL" },
  manual_fallback: { status: 409, code: "MANUAL_FALLBACK" },
  invalid_coordinates: { status: 400, code: "INVALID_COORDINATES" },
  screenshot_frame_unavailable: { status: 409, code: "SCREENSHOT_FRAME_UNAVAILABLE" },
  viewport_drifted: { status: 409, code: "VIEWPORT_DRIFTED" },
  scroll_drifted: { status: 409, code: "FRAME_STALE_RECAPTURE_REQUIRED" },
  layout_drifted: { status: 409, code: "FRAME_STALE_RECAPTURE_REQUIRED" },
  hold_already_active: { status: 409, code: "HOLD_ALREADY_ACTIVE" },
  cdp_failed: { status: 502, code: "CDP_FAILED" },
  pointer_dispatch_failed: { status: 502, code: "POINTER_DISPATCH_FAILED" },
};

// Map each recheck refusal reason to a safe HTTP status + stable error code. As
// with the relay map, the reason code is the ONLY detail surfaced — never the
// probe/browser error, cdp_url, target_id, expected_url, coordinates, or bytes.
const GESTURE_RECHECK_ERROR_MAP: Record<string, { status: number; code: string }> = {
  flag_disabled: { status: 404, code: "VISUAL_GESTURE_CAPSULE_DISABLED" },
  not_found: { status: 404, code: "NOT_FOUND" },
  terminal: { status: 409, code: "TERMINAL" },
  invalid_state: { status: 409, code: "INVALID_STATE" },
  probe_failed: { status: 502, code: "PROBE_FAILED" },
  state_update_failed: { status: 409, code: "STATE_UPDATE_FAILED" },
};

/** Non-list flag-off response: treat the feature as non-existent (structured 404). */
function sendDisabled(reply: any) {
  return sendError(
    reply,
    404,
    "VISUAL_GESTURE_CAPSULE_DISABLED",
    "Visual gesture capsules are not enabled.",
  );
}

export async function visualGestureCapsuleRoutes(server: FastifyInstance): Promise<void> {
  // List active capsules (safe views only). Lazy expiry + terminal exclusion are
  // handled inside listActiveVisualGestureCapsules / getSafeVisualGestureCapsuleView.
  // Flag off → empty list with a `disabled` signal (no error path for the UI).
  server.get("/api/internal/visual-gesture-capsules", async (_req, reply) => {
    if (!isVisualGestureCapsuleEnabled()) {
      return reply.send({ ok: true, data: [], disabled: true });
    }
    const data = listActiveVisualGestureCapsules().map(getSafeVisualGestureCapsuleView);
    return reply.send({ ok: true, data });
  });

  // Fetch the current redacted screenshot frame bytes. The ONLY endpoint that
  // returns png_base64. No viewport dims, coordinates, or strategy.
  server.get<{ Params: { id: string } }>(
    "/api/internal/visual-gesture-capsules/:id/screenshot",
    async (req, reply) => {
      if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

      const capsule = getVisualGestureCapsule(req.params.id);
      if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

      const frame = getVisualGestureCapsuleScreenshotFrame(req.params.id);
      if (!frame) {
        // No live frame (never captured, expired, or purged) — tell the caller to
        // recapture. No browser/session detail leaked.
        return sendError(
          reply,
          404,
          "SCREENSHOT_FRAME_UNAVAILABLE",
          "No live screenshot frame is held; recapture before viewing.",
        );
      }

      // Bytes flow ONLY here. Deliberately omit viewport_css_width/height.
      return reply.send({
        ok: true,
        mime_type: "image/png",
        png_base64: frame.png_base64,
        captured_at: frame.captured_at,
        expires_at: frame.expires_at,
      });
    },
  );

  // Recapture: run the M1C capture helper and store a fresh frame. Returns safe
  // metadata only — NO png_base64. Caller fetches the screenshot endpoint after.
  server.post<{
    Params: { id: string };
    Body: { cdp_url?: unknown; target_id?: unknown; expected_url?: unknown };
  }>("/api/internal/visual-gesture-capsules/:id/recapture", async (req, reply) => {
    if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

    const capsule = getVisualGestureCapsule(req.params.id);
    if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

    const body = req.body ?? {};
    // cdp_url is server-derived from the capsule's browser session when the UI
    // omits it (M2B); an explicit body value stays supported. Never echoed back.
    const cdpUrl = resolveCapsuleCdpUrl(body.cdp_url, capsule.browser_session_id);
    if (typeof cdpUrl !== "string" || cdpUrl.length === 0) {
      return sendError(
        reply,
        409,
        "BROWSER_SESSION_UNAVAILABLE",
        "No live browser session is available for this capsule.",
      );
    }
    const targetId = typeof body.target_id === "string" ? body.target_id : undefined;
    const expectedUrl = typeof body.expected_url === "string" ? body.expected_url : undefined;

    const result = await captureVisualGestureCapsuleScreenshotFrame({
      capsuleId: req.params.id,
      cdpUrl,
      targetId,
      expectedUrl,
    });

    if (!result.ok) {
      // Map the capture reason to a safe status + code. The reason code is the
      // only detail surfaced — no bytes, no browser/session internals.
      const status =
        result.reason === "not_found" ? 404 : result.reason === "terminal" ? 409 : 502;
      return sendError(reply, status, result.reason.toUpperCase(), "Screenshot recapture failed.");
    }

    return reply.send({
      ok: true,
      screenshot_available: true,
      screenshot_captured_at: result.screenshot_captured_at,
      screenshot_expires_at: result.screenshot_expires_at,
    });
  });

  // Recheck (M1G): classify the post-gesture page state via the backend recheck
  // helper and resolve the capsule. The helper runs a SAFE page-level presence
  // probe and may mark the capsule cleared (wall gone), burn one attempt (wall
  // still present → rejected_retryable / manual_fallback), or leave state
  // unchanged (unknown / probe failure). The route performs only flag + shallow
  // body validation and delegates all probing and state decisions to the helper.
  // The response carries safe metadata only: never cdp_url, target_id,
  // expected_url, probe internals, screenshot bytes, coordinates, duration, path,
  // or provider details. Strictly internal — NOT exposed on /api/agent/v1.
  server.post<{
    Params: { id: string };
    Body: { cdp_url?: unknown; target_id?: unknown; expected_url?: unknown };
  }>("/api/internal/visual-gesture-capsules/:id/recheck", async (req, reply) => {
    // Flag gate FIRST — return before reading the body or calling the helper.
    if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Capsule id is required.");
    }

    // Fetch the capsule up front so cdp_url can be derived from its browser
    // session when the UI omits it. The recheck helper re-resolves the capsule
    // (with lazy expiry) and owns the terminal/invalid-state decisions.
    const capsule = getVisualGestureCapsule(id);
    if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

    const body = req.body ?? {};
    const cdpUrl = resolveCapsuleCdpUrl(body.cdp_url, capsule.browser_session_id);
    if (typeof cdpUrl !== "string" || cdpUrl.length === 0) {
      return sendError(
        reply,
        409,
        "BROWSER_SESSION_UNAVAILABLE",
        "No live browser session is available for this capsule.",
      );
    }
    const targetId = typeof body.target_id === "string" ? body.target_id : undefined;
    const expectedUrl = typeof body.expected_url === "string" ? body.expected_url : undefined;

    const result = await recheckVisualGestureCapsule({
      capsuleId: id,
      cdpUrl,
      targetId,
      expectedUrl,
    });

    if (!result.ok) {
      const mapped =
        GESTURE_RECHECK_ERROR_MAP[result.reason] ??
        { status: 409, code: "STATE_UPDATE_FAILED" };
      // Generic message only — no probe/browser internals are echoed.
      return sendError(reply, mapped.status, mapped.code, "Gesture recheck failed.");
    }

    // Re-fetch for the safe view; a post-recheck race that purged the capsule is
    // reported as a safe 409 rather than a 500.
    const current = getVisualGestureCapsule(id);
    if (!current) {
      return sendError(reply, 409, "STATE_UPDATE_FAILED", "Gesture recheck failed.");
    }

    return reply.send({
      ok: true,
      recheck: result.outcome,
      status: result.status,
      attempt_count: result.attempt_count,
      data: getSafeVisualGestureCapsuleView(current),
    });
  });

  // Cancel: terminal-cancel the capsule. The lifecycle transition purges the held
  // screenshot frame. Full agent pause/resume integration is deferred to a later
  // slice — this endpoint only resolves the capsule, it does not resume the agent.
  server.post<{ Params: { id: string } }>(
    "/api/internal/visual-gesture-capsules/:id/cancel",
    async (req, reply) => {
      if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

      const capsule = getVisualGestureCapsule(req.params.id);
      if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

      // Release any live hold FIRST so the browser mouse never lingers down until
      // the 1.2s fail-closed timer — the UI cancels a hold this way rather than
      // relying on fail-closed. Best-effort + idempotent (no-op without a session).
      await cancelVgcHoldSession(req.params.id);

      const result = cancelVisualGestureCapsule(req.params.id);
      // Already-terminal capsules return their current safe view (idempotent from
      // the UI's perspective); cancelVisualGestureCapsule purges the frame on a
      // successful transition.
      const current = getVisualGestureCapsule(req.params.id) ?? capsule;
      return reply.send({
        ok: true,
        cancelled: result.ok,
        data: getSafeVisualGestureCapsuleView(current),
      });
    },
  );

  // Submit a user-provided gesture (tap or bounded press-hold) for a capsule. The
  // route performs only shallow body validation and delegates ALL geometry, point
  // mapping, and pointer dispatch to the M1E relay seam — it does NOT expose the
  // pointerRelay injection seam over HTTP. The response carries safe metadata only:
  // never png_base64, fx/fy, cssX/cssY, duration_ms, cdp_url, target_id, viewport
  // dimensions, path points, or gesture strategy. Strictly internal — NOT exposed
  // on any agent-facing surface (/api/agent/v1).
  server.post<{
    Params: { id: string };
    Body: { cdp_url?: unknown; target_id?: unknown; gesture?: unknown };
  }>("/api/internal/visual-gesture-capsules/:id/gesture", async (req, reply) => {
    // Flag gate FIRST — return before reading the body or calling the relay seam.
    if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Capsule id is required.");
    }

    // Fetch the capsule up front so cdp_url can be derived from its browser
    // session when the UI omits it. The relay seam re-resolves the capsule (with
    // lazy expiry) and owns the terminal / manual_fallback / dispatch decisions.
    const capsule = getVisualGestureCapsule(id);
    if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

    const body = req.body ?? {};
    const cdpUrl = resolveCapsuleCdpUrl(body.cdp_url, capsule.browser_session_id);
    if (typeof cdpUrl !== "string" || cdpUrl.length === 0) {
      return sendError(
        reply,
        409,
        "BROWSER_SESSION_UNAVAILABLE",
        "No live browser session is available for this capsule.",
      );
    }
    const targetId = typeof body.target_id === "string" ? body.target_id : undefined;

    // Shallow gesture shape check — presence of kind/fx/fy only. Deep validation
    // (range of fx/fy, press-hold duration bounds) is the relay helper's job and
    // surfaces as invalid_gesture / invalid_coordinates below.
    const gesture = body.gesture as
      | { kind?: unknown; fx?: unknown; fy?: unknown }
      | null
      | undefined;
    if (
      !gesture ||
      typeof gesture !== "object" ||
      (gesture.kind !== "tap" && gesture.kind !== "press_hold") ||
      typeof gesture.fx !== "number" ||
      typeof gesture.fy !== "number"
    ) {
      return sendError(reply, 400, "VALIDATION_ERROR", "A valid gesture is required.");
    }

    const result = await relayVisualGestureCapsuleGesture({
      capsuleId: id,
      cdpUrl,
      targetId,
      gesture: gesture as any,
    });

    if (!result.ok) {
      const mapped =
        GESTURE_RELAY_ERROR_MAP[result.reason] ??
        { status: 409, code: "STORE_OR_STATE_FAILED" };
      // Generic message only — no relay/pointer/browser internals are echoed.
      return sendError(reply, mapped.status, mapped.code, "Gesture relay failed.");
    }

    // Dispatch landed. Re-fetch for the safe view; a post-relay race that purged
    // the capsule is reported as a safe 409 rather than a 500.
    const current = getVisualGestureCapsule(id);
    if (!current) {
      return sendError(reply, 409, "STORE_OR_STATE_FAILED", "Gesture relay failed.");
    }

    // Top-level status comes from the relay result; data is the safe view.
    return reply.send({
      ok: true,
      gesture_relayed: true,
      status: result.status,
      data: getSafeVisualGestureCapsuleView(current),
    });
  });

  // ── Live guided press-and-hold (hold-start → heartbeat → hold-end) ──────────
  //
  // The point-anchored counterpart to the DOM Human Presence Relay's live hold.
  // For a press-and-hold wall the UI presses on the screenshot target and the
  // browser mouse stays down ONLY while heartbeats arrive — no recorded duration
  // is ever replayed (that is the single-shot /gesture path, kept for taps). All
  // geometry/point mapping lives in the relay module; these routes never echo
  // fx/fy, the mapped point, cdp_url, target_id, browser internals, or bytes.
  // Strictly internal — NOT exposed on any agent-facing surface (/api/agent/v1).

  // Begin a live hold at a normalized screenshot point (fx, fy ∈ [0,1]).
  server.post<{
    Params: { id: string };
    Body: { cdp_url?: unknown; target_id?: unknown; fx?: unknown; fy?: unknown };
  }>("/api/internal/visual-gesture-capsules/:id/hold-start", async (req, reply) => {
    if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Capsule id is required.");
    }

    const capsule = getVisualGestureCapsule(id);
    if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

    const body = req.body ?? {};
    const cdpUrl = resolveCapsuleCdpUrl(body.cdp_url, capsule.browser_session_id);
    if (typeof cdpUrl !== "string" || cdpUrl.length === 0) {
      return sendError(
        reply,
        409,
        "BROWSER_SESSION_UNAVAILABLE",
        "No live browser session is available for this capsule.",
      );
    }
    const targetId = typeof body.target_id === "string" ? body.target_id : undefined;

    // Shallow shape check — fx/fy must be present numbers. Range validation and
    // point mapping are the hold module's job (surfacing invalid_coordinates).
    if (typeof body.fx !== "number" || typeof body.fy !== "number") {
      return sendError(reply, 400, "VALIDATION_ERROR", "A valid press point (fx, fy) is required.");
    }

    const result = await startVgcHoldSession({
      capsuleId: id,
      cdpUrl,
      targetId,
      fx: body.fx,
      fy: body.fy,
    });

    if (!result.ok) {
      const mapped =
        GESTURE_HOLD_ERROR_MAP[result.reason] ?? { status: 409, code: "STORE_OR_STATE_FAILED" };
      return sendError(reply, mapped.status, mapped.code, "Could not start the live hold.");
    }

    const current = getVisualGestureCapsule(id) ?? capsule;
    return reply.send({
      ok: true,
      hold_state: result.hold_state,
      data: getSafeVisualGestureCapsuleView(current),
    });
  });

  // Live heartbeat — re-arms the fail-closed timer. Empty body.
  server.post<{ Params: { id: string } }>(
    "/api/internal/visual-gesture-capsules/:id/heartbeat",
    async (req, reply) => {
      if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

      const capsule = getVisualGestureCapsule(req.params.id);
      if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

      const result = heartbeatVgcHoldSession(req.params.id);
      if (result.hold_state === "no_hold") {
        return sendError(reply, 409, "NO_ACTIVE_HOLD", "No live hold is active for this capsule.");
      }
      return reply.send({ ok: true, hold_state: result.hold_state });
    },
  );

  // Release the live hold + run the definitive post-release recheck. Empty body.
  server.post<{ Params: { id: string } }>(
    "/api/internal/visual-gesture-capsules/:id/hold-end",
    async (req, reply) => {
      if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

      const capsule = getVisualGestureCapsule(req.params.id);
      if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

      const result = await endVgcHoldSession(req.params.id);
      if (result.hold_state === "no_hold") {
        return sendError(reply, 409, "NO_ACTIVE_HOLD", "No live hold is active for this capsule.");
      }

      const current = getVisualGestureCapsule(req.params.id) ?? capsule;
      return reply.send({
        ok: true,
        hold_state: result.hold_state,
        data: getSafeVisualGestureCapsuleView(current),
      });
    },
  );
}
