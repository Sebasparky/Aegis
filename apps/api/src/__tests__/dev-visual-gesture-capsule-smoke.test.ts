/**
 * Visual Gesture Capsule — M2C dev smoke route tests.
 *
 * Proves the development-only smoke helper:
 *  - requires ANTIGEN_VISUAL_GESTURE_CAPSULE=true (flag off → 404, no capsule),
 *  - creates an active smoke.test capsule with a renderable frame,
 *  - returns ONLY safe-view metadata (never cdp_url, browser_session_id,
 *    target_id, expected_url, viewport dims, coordinates, or png bytes),
 *  - keeps screenshot bytes confined to the existing screenshot endpoint.
 *
 * Production unavailability is NOT exercised here: it comes from devRoutes being
 * registered only when NODE_ENV !== "production" (see index.ts), which is a
 * registration-layer concern outside this inject-based test.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { devRoutes } from "../routes/dev.js";
import { visualGestureCapsuleRoutes } from "../routes/visual-gesture-capsules.js";
import { clearVisualGestureCapsulesForTests } from "../runtime/visualGestureCapsule.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify();
  await server.register(devRoutes);
  await server.register(visualGestureCapsuleRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  clearVisualGestureCapsulesForTests();
});

async function smoke() {
  return server.inject({ method: "POST", url: "/api/dev/visual-gesture-capsules/smoke" });
}

describe("dev visual gesture capsule smoke route", () => {
  it("returns 404 VISUAL_GESTURE_CAPSULE_DISABLED when the flag is off and creates nothing", async () => {
    const res = await smoke();
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("VISUAL_GESTURE_CAPSULE_DISABLED");

    // No capsule leaked into the active list.
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const list = await server.inject({
      method: "GET",
      url: "/api/internal/visual-gesture-capsules",
    });
    expect(list.json().data).toHaveLength(0);
  });

  it("creates an active smoke capsule with a ready frame when the flag is on", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const res = await smoke();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("awaiting_user_gesture");
    expect(body.data.domain).toBe("smoke.test");
    expect(body.data.screenshot_available).toBe(true);
    expect(body.data.capsule_id).toMatch(/^vgc/);
  });

  it("returns only safe-view metadata — no browser internals or bytes", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const res = await smoke();
    const raw = res.payload;
    for (const forbidden of [
      "cdp_url",
      "browser_session_id",
      "target_id",
      "expected_url",
      "viewport_css_width",
      "viewport_css_height",
      "png_base64",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("keeps screenshot bytes available only through the screenshot endpoint", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const created = await smoke();
    const capsuleId = created.json().data.capsule_id;

    const shot = await server.inject({
      method: "GET",
      url: `/api/internal/visual-gesture-capsules/${capsuleId}/screenshot`,
    });
    expect(shot.statusCode).toBe(200);
    const body = shot.json();
    expect(body.mime_type).toBe("image/png");
    expect(typeof body.png_base64).toBe("string");
    expect(body.png_base64.length).toBeGreaterThan(0);
  });
});
