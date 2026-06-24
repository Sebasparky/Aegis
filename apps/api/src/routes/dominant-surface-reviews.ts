// ─── Dominant Surface Review — internal user-facing endpoints ─────────────────
//
// HTTP surface for the Antigen UI to see and dismiss the NON-HV "uncertain
// dominant surface" attention items minted by the proactive action preflight
// (the 409 ACTION_BLOCKED_DOMINANT_SURFACE block). List pending reviews, fetch
// the held redacted screenshot frame, and acknowledge (dismiss) a review.
//
// Strictly internal/user-facing — NOT registered on, exposed through, or callable
// by any agent-facing surface (/api/agent/v1). These add NO gesture relay, NO CDP
// input, NO VGC mint/clear. Acknowledging a review NEVER resumes the agent; the
// agent recovers only by re-running antigen_snapshot once the surface clears.
//
// Bytes discipline (mirrors visual-gesture-capsules.ts): the redacted PNG appears
// in exactly ONE place — GET /:id/screenshot. List and acknowledge return only
// safe-view shapes (availability + timestamps); never png_base64, coordinates,
// cdp_url, target_id, full URL, or page text.
//
// No feature flag: a review record only ever exists when the preflight block
// fires (already gated behind ANTIGEN_HV_PROACTIVE_SURFACE + VGC + visual
// judgment + a live CDP session), so when the block is off the list is simply
// empty and these endpoints are inert.

import type { FastifyInstance } from "fastify";

import {
  listActiveDominantSurfaceReviews,
  getDominantSurfaceReview,
  getDominantSurfaceReviewScreenshotFrame,
  acknowledgeDominantSurfaceReview,
  getSafeDominantSurfaceReviewView,
} from "../runtime/dominantSurfaceReview.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function dominantSurfaceReviewRoutes(server: FastifyInstance): Promise<void> {
  // List active (pending) reviews as safe views. Lazy expiry + terminal exclusion
  // are handled inside listActiveDominantSurfaceReviews / the safe-view builder.
  server.get("/api/internal/dominant-surface-reviews", async (_req, reply) => {
    const data = listActiveDominantSurfaceReviews().map(getSafeDominantSurfaceReviewView);
    return reply.send({ ok: true, data });
  });

  // Fetch the held redacted screenshot frame bytes. The ONLY endpoint that returns
  // png_base64. No coordinates, viewport dims, or strategy.
  server.get<{ Params: { id: string } }>(
    "/api/internal/dominant-surface-reviews/:id/screenshot",
    async (req, reply) => {
      const review = getDominantSurfaceReview(req.params.id);
      if (!review) return sendError(reply, 404, "NOT_FOUND", "Dominant surface review not found.");

      const frame = getDominantSurfaceReviewScreenshotFrame(req.params.id);
      if (!frame) {
        return sendError(
          reply,
          404,
          "SCREENSHOT_FRAME_UNAVAILABLE",
          "No live screenshot frame is held for this review.",
        );
      }

      // Bytes flow ONLY here.
      return reply.send({
        ok: true,
        mime_type: "image/png",
        png_base64: frame.png_base64,
        captured_at: frame.captured_at,
        expires_at: frame.expires_at,
      });
    },
  );

  // Acknowledge (dismiss) a review. Terminal + idempotent. Returns the safe view.
  // This is a user acknowledgement only — it does NOT mint a VGC, resume the
  // agent, or assert the surface is benign.
  server.post<{ Params: { id: string } }>(
    "/api/internal/dominant-surface-reviews/:id/acknowledge",
    async (req, reply) => {
      const review = acknowledgeDominantSurfaceReview(req.params.id);
      if (!review) return sendError(reply, 404, "NOT_FOUND", "Dominant surface review not found.");
      return reply.send({ ok: true, data: getSafeDominantSurfaceReviewView(review) });
    },
  );
}
