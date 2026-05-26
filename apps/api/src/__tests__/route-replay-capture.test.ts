import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

vi.mock("../runtime/taskBrowserSessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/taskBrowserSessions.js")>();
  return { ...actual, createTaskBrowserSession: vi.fn(), getTaskBrowserSessionForReuse: vi.fn() };
});

// Mock captureRouteReplay and captureRouteStartPreview so tests don't launch a real browser.
// Preserve classifyStepSafety — it is pure logic with no Playwright dependency.
vi.mock("../lib/routePreviewCapture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/routePreviewCapture.js")>();
  return {
    ...actual,
    captureRouteStartPreview: vi.fn(),
    captureRouteReplay: vi.fn(),
    PREVIEW_DIR: "/tmp/fake-previews",
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { routeRoutes } from "../routes/routes.js";
import { routes } from "../store/index.js";
import { seedTestData, resetStore, IDS } from "./helpers.js";
import type { AegisRoute, RouteReplayAsset } from "@aegis/types";
import { classifyStepSafety } from "../lib/routePreviewCapture.js";

// ─── classifyStepSafety — pure logic ─────────────────────────────────────────

function makeStep(overrides: Partial<AegisRoute["steps"][0]> = {}): AegisRoute["steps"][0] {
  return {
    step_id: "step_test",
    order: 1,
    action: "click",
    intent: "search",
    description: "click Search",
    target: {
      preferred_locator: { type: "label", name: "Search" },
      fallback_locators: [],
      confidence: 0.9,
    },
    approval_required: false,
    confidence_required: 0.7,
    ...overrides,
  };
}

describe("classifyStepSafety", () => {
  it("classifies safe_literal fill as safe", () => {
    const step = makeStep({
      action: "fill",
      value_policy: { type: "safe_literal", value: "Michigan", store_value: true },
    });
    expect(classifyStepSafety(step)).toBe("safe");
  });

  it("classifies pass_field fill as sensitive", () => {
    const step = makeStep({
      action: "fill",
      value_policy: { type: "pass_field", store_value: false },
    });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies secret_ref fill as sensitive", () => {
    const step = makeStep({
      action: "fill",
      value_policy: { type: "secret_ref", store_value: false },
    });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies fill with no value_policy as sensitive", () => {
    const step = makeStep({ action: "fill" });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies click with neutral intent as safe", () => {
    const step = makeStep({ action: "click", intent: "search", description: "click Search" });
    expect(classifyStepSafety(step)).toBe("safe");
  });

  it("classifies click with 'confirm' in description as sensitive", () => {
    const step = makeStep({ action: "click", intent: "confirm_order", description: "click Confirm Purchase" });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies click with 'submit' in intent as sensitive", () => {
    const step = makeStep({ action: "click", intent: "submit_payment", description: "click Pay Now" });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies navigate action as safe", () => {
    const step = makeStep({ action: "navigate", intent: "go_to_page", description: "navigate to start" });
    expect(classifyStepSafety(step)).toBe("safe");
  });

  it("classifies read action as safe", () => {
    const step = makeStep({ action: "read", intent: "read_content", description: "read article" });
    expect(classifyStepSafety(step)).toBe("safe");
  });

  it("treats approval_required=true as always sensitive", () => {
    const step = makeStep({ action: "click", intent: "search", description: "click Search", approval_required: true });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies unknown action type as sensitive (conservative)", () => {
    const step = makeStep({ action: "download" as any });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies submit action with submit_search intent as safe", () => {
    const step = makeStep({ action: "submit", intent: "submit_search", description: "submit search" });
    expect(classifyStepSafety(step)).toBe("safe");
  });

  it("classifies submit action with pay intent as sensitive", () => {
    const step = makeStep({ action: "submit", intent: "submit_payment", description: "submit payment form" });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });

  it("classifies submit action with approval_required as sensitive", () => {
    const step = makeStep({ action: "submit", intent: "submit_search", description: "submit search", approval_required: true });
    expect(classifyStepSafety(step)).toBe("sensitive");
  });
});

// ─── POST /api/routes/:routeId/capture-replay-preview ────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(routeRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetStore();
  seedTestData();
  vi.clearAllMocks();
});

function makeReplayAssets(routeId: string, ts = 1716662400000): RouteReplayAsset[] {
  return [
    {
      asset_id: "rra_poster_001",
      route_id: routeId,
      route_hash: "abc123def456",
      kind: "poster_frame",
      url_path: `/api/route-preview-assets/${routeId}-poster-${ts}.png`,
      captured_at: "2026-01-01T00:00:00.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture",
      replay_safety: "full",
    },
    {
      asset_id: "rra_video_001",
      route_id: routeId,
      route_hash: "abc123def456",
      kind: "replay_video",
      url_path: `/api/route-preview-assets/${routeId}-replay-${ts}.webm`,
      poster_url_path: `/api/route-preview-assets/${routeId}-poster-${ts}.png`,
      captured_at: "2026-01-01T00:00:00.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture",
      replay_safety: "full",
    },
  ];
}

describe("POST /api/routes/:routeId/capture-replay-preview", () => {
  it("returns 404 for unknown route", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/routes/route_nonexistent/capture-replay-preview",
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 200 with captured: true and safe metadata when replay succeeds", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");
    const mockAssets = makeReplayAssets(IDS.ROUTE_WIKI);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAssets);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.captured).toBe(true);
    expect(body.data.replay_safety).toBe("full");
    expect(Array.isArray(body.data.assets)).toBe(true);
    expect(body.data.assets.length).toBe(2);

    const videoAsset = body.data.assets.find((a: any) => a.kind === "replay_video");
    expect(videoAsset).toBeDefined();
    expect(videoAsset.url_path).toMatch(/^\/api\/route-preview-assets\//);
    expect(videoAsset.url_path).toMatch(/\.webm$/);
  });

  it("returns 200 with captured: false when capture returns null (no capturable URL)", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.captured).toBe(false);
    expect(body.data.reason).toBeDefined();
  });

  it("stores replay_assets on the route and calls schedulePersist", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");
    const { schedulePersist } = await import("../store/persistence.js");
    const mockAssets = makeReplayAssets(IDS.ROUTE_WIKI);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAssets);

    await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });

    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route?.replay_assets).toBeDefined();
    expect(route?.replay_assets?.length).toBe(2);
    expect(route?.replay_assets?.some(a => a.kind === "replay_video")).toBe(true);
    expect(route?.replay_assets?.some(a => a.kind === "poster_frame")).toBe(true);
    expect(schedulePersist).toHaveBeenCalled();
  });

  it("response assets contain no sensitive fields", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");
    const mockAssets = makeReplayAssets(IDS.ROUTE_WIKI);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAssets);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });
    const body = JSON.parse(res.body);
    const str = JSON.stringify(body);
    expect(str).not.toContain("cdp_url");
    expect(str).not.toContain("user_data_dir");
    expect(str).not.toContain("cookies");
    expect(str).not.toContain("pass_id");
    expect(str).not.toContain("secret_ref");
    expect(str).not.toContain("devvault://");
    expect(str).not.toContain("route_hash");
  });

  it("reflects partial replay_safety when route has sensitive steps", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");
    const partialAssets: RouteReplayAsset[] = [
      {
        asset_id: "rra_poster_partial",
        route_id: IDS.ROUTE_WIKI,
        route_hash: "abc123def456",
        kind: "poster_frame",
        url_path: `/api/route-preview-assets/${IDS.ROUTE_WIKI}-poster-999.png`,
        captured_at: "2026-01-01T00:00:00.000Z",
        width: 1280,
        height: 800,
        redaction_applied: true,
        source: "manual_capture",
        replay_safety: "partial",
        stop_reason: "Stopped before: confirm payment",
      },
    ];
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(partialAssets);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.replay_safety).toBe("partial");
    expect(body.data.stop_reason).toContain("confirm payment");
  });

  it("does not corrupt the existing route when capture returns null", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });

    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route).toBeDefined();
    expect(route?.route_id).toBe(IDS.ROUTE_WIKI);
  });

  it("returns captured: false with a non-empty reason when navigation fails (e.g. Michigan not reached)", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");
    // Simulate destination-check failure: captureRouteReplay returns null
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.captured).toBe(false);
    expect(typeof body.data.reason).toBe("string");
    expect(body.data.reason.length).toBeGreaterThan(0);
    // Route must not be mutated (no stale replay_assets)
    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route?.replay_assets ?? []).toHaveLength(0);
  });

  it("re-captures replace existing replay_assets by kind without duplicating", async () => {
    const { captureRouteReplay } = await import("../lib/routePreviewCapture.js");

    // Seed an existing capture on the route.
    const route = routes.get(IDS.ROUTE_WIKI)!;
    route.replay_assets = makeReplayAssets(IDS.ROUTE_WIKI, 1000000);
    routes.set(IDS.ROUTE_WIKI, route);

    // New capture with fresh asset_ids.
    const newAssets = makeReplayAssets(IDS.ROUTE_WIKI, 2000000).map(a => ({
      ...a,
      asset_id: a.asset_id.replace("001", "002"),
    }));
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newAssets);

    await server.inject({
      method: "POST",
      url: `/api/routes/${IDS.ROUTE_WIKI}/capture-replay-preview`,
    });

    const updated = routes.get(IDS.ROUTE_WIKI)!;
    const videos = updated.replay_assets?.filter(a => a.kind === "replay_video") ?? [];
    const posters = updated.replay_assets?.filter(a => a.kind === "poster_frame") ?? [];

    // Exactly one of each kind — no duplicates.
    expect(videos).toHaveLength(1);
    expect(posters).toHaveLength(1);
    // The new asset_ids replaced the old ones.
    expect(videos[0].asset_id).toBe("rra_video_002");
    expect(posters[0].asset_id).toBe("rra_poster_002");
  });
});

// ─── Static asset filename validation — video extensions ─────────────────────

describe("route-preview-assets filename validation — video extensions", () => {
  const VALID_RE = /^[a-zA-Z0-9_-]+\.(png|webm|mp4)$/;

  it("accepts a valid .webm replay filename", () => {
    expect(VALID_RE.test("route_demo_wikipedia_001-replay-1716662400000.webm")).toBe(true);
  });

  it("accepts a valid .mp4 replay filename", () => {
    expect(VALID_RE.test("route_demo_wikipedia_001-replay-1716662400000.mp4")).toBe(true);
  });

  it("accepts a valid .png poster filename", () => {
    expect(VALID_RE.test("route_demo_wikipedia_001-poster-1716662400000.png")).toBe(true);
  });

  it("rejects path traversal with ../", () => {
    expect(VALID_RE.test("../../../etc/passwd")).toBe(false);
  });

  it("rejects path traversal with encoded slash", () => {
    expect(VALID_RE.test("..%2F..%2Fetc%2Fpasswd")).toBe(false);
  });

  it("rejects disallowed extensions (.exe)", () => {
    expect(VALID_RE.test("malicious.exe")).toBe(false);
  });

  it("rejects disallowed extensions (.sh)", () => {
    expect(VALID_RE.test("shell.sh")).toBe(false);
  });

  it("rejects filenames with null bytes", () => {
    expect(VALID_RE.test("file\0.webm")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(VALID_RE.test("")).toBe(false);
  });
});
