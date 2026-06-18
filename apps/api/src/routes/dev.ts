import type { FastifyInstance } from "fastify";
import { PNG } from "pngjs";

import { resetStoreForDemo } from "../store/persistence.js";
import { newId } from "../store/index.js";
import {
  isVisualGestureCapsuleEnabled,
  createVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  getSafeVisualGestureCapsuleView,
} from "../runtime/visualGestureCapsule.js";

// Build a small solid-color PNG (base64) so the smoke capsule has a renderable
// frame without any real CDP capture. Bytes are a synthetic placeholder — the
// only place they surface is the existing screenshot endpoint.
function makeSmokeScreenshotPngBase64(width: number, height: number): string {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0x1e; // R — muted indigo placeholder
    png.data[i + 1] = 0x29;
    png.data[i + 2] = 0x3b;
    png.data[i + 3] = 0xff;
  }
  return PNG.sync.write(png).toString("base64");
}

export async function devRoutes(server: FastifyInstance) {
  server.post("/api/dev/reset-store", async () => {
    await resetStoreForDemo();
    return { ok: true, data: { reset: true } };
  });

  // ── Visual Gesture Capsule local smoke (M2C) ───────────────────────────────
  //
  // Development-only helper to render an active Visual Gesture Capsule in the
  // /human-verification UI without a real opaque-HV wall. Creates a fake
  // smoke.test capsule and stores a fake (solid-color) screenshot frame, so the
  // list → screenshot render → cancel flow can be exercised locally.
  //
  // This route exists only because devRoutes is registered solely when
  // NODE_ENV !== "production" (see index.ts) — it is never reachable in
  // production. It also requires ANTIGEN_VISUAL_GESTURE_CAPSULE=true.
  //
  // The fake capsule deliberately carries a browser_session_id that is NOT a
  // registered task browser session, so gesture / recheck / recapture honestly
  // return BROWSER_SESSION_UNAVAILABLE — those paths require a live task browser
  // session and are not part of the smoke. We do NOT fabricate a cdp_url or
  // session just to make them pass.
  //
  // The response returns ONLY getSafeVisualGestureCapsuleView output (no cdp_url,
  // browser_session_id, target_id, expected_url, viewport dims, coordinates,
  // path, strategy, or screenshot bytes). Screenshot bytes remain available only
  // through GET /api/internal/visual-gesture-capsules/:id/screenshot.
  server.post("/api/dev/visual-gesture-capsules/smoke", async (_req, reply) => {
    if (!isVisualGestureCapsuleEnabled()) {
      return reply.status(404).send({
        ok: false,
        error: {
          code: "VISUAL_GESTURE_CAPSULE_DISABLED",
          message: "Visual gesture capsules are not enabled.",
        },
      });
    }

    const capsule = createVisualGestureCapsule({
      human_verification_request_id: newId("hvr"),
      // Intentionally NOT a registered task browser session — keeps gesture /
      // recheck / recapture honestly BROWSER_SESSION_UNAVAILABLE for smoke.
      browser_session_id: newId("smoke_sess"),
      domain: "smoke.test",
      page_url: "https://smoke.test/verify",
    });

    const width = 320;
    const height = 180;
    storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
      png_base64: makeSmokeScreenshotPngBase64(width, height),
      viewport_css_width: width,
      viewport_css_height: height,
    });

    return reply.send({ ok: true, data: getSafeVisualGestureCapsuleView(capsule) });
  });
}
