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

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

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
    const cdpUrl = body.cdp_url;
    if (typeof cdpUrl !== "string" || cdpUrl.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "cdp_url is required.");
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

  // Recheck (M1D stub): reserves the UI contract for future cleared / manual_fallback
  // probes. There is no HV-cleared probe yet, so this NEVER marks the capsule
  // cleared — it only echoes the current status + safe view.
  server.post<{ Params: { id: string } }>(
    "/api/internal/visual-gesture-capsules/:id/recheck",
    async (req, reply) => {
      if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

      const capsule = getVisualGestureCapsule(req.params.id);
      if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

      return reply.send({
        ok: true,
        recheck: "unwired",
        status: capsule.status,
        data: getSafeVisualGestureCapsuleView(capsule),
      });
    },
  );

  // Cancel: terminal-cancel the capsule. The lifecycle transition purges the held
  // screenshot frame. Full agent pause/resume integration is deferred to a later
  // slice — this endpoint only resolves the capsule, it does not resume the agent.
  server.post<{ Params: { id: string } }>(
    "/api/internal/visual-gesture-capsules/:id/cancel",
    async (req, reply) => {
      if (!isVisualGestureCapsuleEnabled()) return sendDisabled(reply);

      const capsule = getVisualGestureCapsule(req.params.id);
      if (!capsule) return sendError(reply, 404, "NOT_FOUND", "Visual gesture capsule not found.");

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
}
