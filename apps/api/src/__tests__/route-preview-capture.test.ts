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

// Mock captureRouteStartPreview and captureRouteReplay so endpoint tests don't require a real browser.
// Use importOriginal to preserve resolveStartUrl and classifyStepSafety (pure logic, no playwright).
vi.mock("../lib/routePreviewCapture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/routePreviewCapture.js")>();
  return {
    ...actual,
    captureRouteStartPreview: vi.fn(),
    captureRouteReplay: vi.fn(),
    PREVIEW_DIR: "/tmp/fake-previews",
  };
});

vi.mock("../services/routeVerifier.js", () => ({
  verifyRouteWithPlaywright: vi.fn(),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { routeRoutes } from "../routes/routes.js";
import { routes } from "../store/index.js";
import { seedTestData, resetStore, IDS } from "./helpers.js";
import type { AegisRoute, RouteVerificationReport } from "@aegis/types";
import { verifyRouteWithPlaywright } from "../services/routeVerifier.js";
import { resolveStartUrl } from "../lib/routePreviewCapture.js";

// ─── resolveStartUrl — URL determination logic ────────────────────────────────

function makeRoute(overrides: Partial<AegisRoute> = {}): AegisRoute {
  return {
    route_id: "route_test_url",
    version: "1.0.0",
    created_at: "2026-01-01T00:00:00.000Z",
    last_verified_at: "2026-01-01T00:00:00.000Z",
    creator_aegis_id: "aid_test",
    trust_tier: "unverified_draft",
    domain: "example.com",
    workflow_name: "Test",
    workflow_description: "Test",
    risk_level: "low",
    required_permissions: [],
    allowed_actions: [],
    forbidden_actions: [],
    approval_gates: [],
    confidence_threshold: 0.7,
    steps: [],
    run_count: 0,
    success_rate: 0,
    incident_count: 0,
    ...overrides,
  };
}

describe("resolveStartUrl — URL determination", () => {
  it("returns wikipedia main page URL for en.wikipedia.org domain", () => {
    const route = makeRoute({ domain: "en.wikipedia.org" });
    expect(resolveStartUrl(route)).toBe("https://en.wikipedia.org/wiki/Main_Page");
  });

  it("uses start_url directly when set, ignoring domain", () => {
    const route = makeRoute({ domain: "en.wikipedia.org", start_url: "https://custom.example.com/start" });
    expect(resolveStartUrl(route)).toBe("https://custom.example.com/start");
  });

  it("uses start_url for any domain when set", () => {
    const route = makeRoute({ domain: "some-site.com", start_url: "https://some-site.com/login" });
    expect(resolveStartUrl(route)).toBe("https://some-site.com/login");
  });

  it("returns null for localhost domain without start_url", () => {
    expect(resolveStartUrl(makeRoute({ domain: "localhost" }))).toBeNull();
  });

  it("returns null for 127.0.0.1 domain without start_url", () => {
    expect(resolveStartUrl(makeRoute({ domain: "127.0.0.1" }))).toBeNull();
  });

  it("returns null for test.aegis.local domain without start_url", () => {
    expect(resolveStartUrl(makeRoute({ domain: "test.aegis.local" }))).toBeNull();
  });

  it("returns null for unknown domain without start_url", () => {
    expect(resolveStartUrl(makeRoute({ domain: "some-unknown-site.com" }))).toBeNull();
  });
});

// ─── POST /api/routes/:routeId/capture-preview ────────────────────────────────

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

describe("POST /api/routes/:routeId/capture-preview", () => {
  it("returns 404 for unknown route", async () => {
    const res = await server.inject({ method: "POST", url: "/api/routes/route_nonexistent/capture-preview" });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 200 with captured: true when asset is returned", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    const mockAsset = {
      asset_id: "rpa_test_001",
      kind: "start_page" as const,
      route_id: IDS.ROUTE_WIKI,
      url_path: "/api/route-preview-assets/route_demo_wikipedia_001-start-123.png",
      captured_at: "2026-01-01T00:00:00.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture" as const,
    };
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAsset);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/capture-preview` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.captured).toBe(true);
    expect(body.data.asset.kind).toBe("start_page");
    expect(body.data.asset.url_path).toMatch(/^\/api\/route-preview-assets\//);
  });

  it("returns 200 with captured: false when capture returns null", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/capture-preview` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.captured).toBe(false);
    expect(body.data.reason).toBeDefined();
  });

  it("stores asset in route.preview_assets and calls schedulePersist", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    const { schedulePersist } = await import("../store/persistence.js");
    const mockAsset = {
      asset_id: "rpa_test_002",
      kind: "start_page" as const,
      route_id: IDS.ROUTE_WIKI,
      url_path: "/api/route-preview-assets/route_demo_wikipedia_001-start-999.png",
      captured_at: "2026-01-01T00:00:00.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture" as const,
    };
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAsset);

    await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/capture-preview` });

    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route?.preview_assets).toBeDefined();
    expect(route?.preview_assets?.length).toBeGreaterThan(0);
    expect(route?.preview_assets?.[0].asset_id).toBe("rpa_test_002");
    expect(schedulePersist).toHaveBeenCalled();
  });

  it("asset metadata contains no sensitive fields", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    const mockAsset = {
      asset_id: "rpa_safe_001",
      kind: "start_page" as const,
      route_id: IDS.ROUTE_WIKI,
      url_path: "/api/route-preview-assets/route_demo_wikipedia_001-start-000.png",
      captured_at: "2026-01-01T00:00:00.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture" as const,
    };
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAsset);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/capture-preview` });
    const body = JSON.parse(res.body);
    const assetStr = JSON.stringify(body.data.asset);
    expect(assetStr).not.toContain("cdp_url");
    expect(assetStr).not.toContain("user_data_dir");
    expect(assetStr).not.toContain("cookies");
    expect(assetStr).not.toContain("pass_id");
    expect(assetStr).not.toContain("secret_ref");
    expect(assetStr).not.toContain("devvault://");
  });

  it("GET /api/routes/:id includes preview_assets after capture", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    const mockAsset = {
      asset_id: "rpa_test_003",
      kind: "start_page" as const,
      route_id: IDS.ROUTE_WIKI,
      url_path: "/api/route-preview-assets/route_demo_wikipedia_001-start-111.png",
      captured_at: "2026-01-01T00:00:00.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture" as const,
    };
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAsset);

    await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/capture-preview` });

    const res = await server.inject({ method: "GET", url: `/api/routes/${IDS.ROUTE_WIKI}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preview_assets).toBeDefined();
    expect(body.data.preview_assets[0].url_path).toMatch(/^\/api\/route-preview-assets\//);
  });

  it("does not corrupt route when capture fails gracefully", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/capture-preview` });
    expect(res.statusCode).toBe(200);

    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route).toBeDefined();
    expect(route?.route_id).toBe(IDS.ROUTE_WIKI);
  });
});

// ─── Path traversal guard ─────────────────────────────────────────────────────

describe("GET /api/route-preview-assets/:filename — path traversal regex", () => {
  const VALID_RE = /^[a-zA-Z0-9_-]+\.png$/;

  it("accepts a valid route preview filename", () => {
    expect(VALID_RE.test("route_demo_wikipedia_001-start-1716662400000.png")).toBe(true);
  });

  it("rejects path traversal with ../", () => {
    expect(VALID_RE.test("../../../etc/passwd")).toBe(false);
  });

  it("rejects path traversal with encoded slash", () => {
    expect(VALID_RE.test("..%2F..%2Fetc%2Fpasswd")).toBe(false);
  });

  it("rejects filenames without .png extension", () => {
    expect(VALID_RE.test("somefile")).toBe(false);
  });

  it("rejects non-png extensions", () => {
    expect(VALID_RE.test("shell.sh")).toBe(false);
    expect(VALID_RE.test("file.jpg")).toBe(false);
  });

  it("rejects filenames with null bytes", () => {
    expect(VALID_RE.test("file\0.png")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(VALID_RE.test("")).toBe(false);
  });
});

// ─── POST /api/routes/:routeId/verify — synchronous preview capture ───────────

const PASSED_REPORT: RouteVerificationReport = {
  route_id: IDS.ROUTE_WIKI,
  passed: true,
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: "2026-01-01T00:00:01.000Z",
  step_results: [],
  errors: [],
};

describe("POST /api/routes/:routeId/verify — synchronous preview capture", () => {
  it("stores preview_asset on route immediately after successful verification", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    const mockAsset = {
      asset_id: "rpa_verify_001",
      kind: "start_page" as const,
      route_id: IDS.ROUTE_WIKI,
      url_path: "/api/route-preview-assets/route_demo_wikipedia_001-start-verify.png",
      captured_at: "2026-01-01T00:00:01.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture" as const,
    };
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAsset);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    // preview_assets must be populated synchronously — no waiting for a background task.
    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route?.preview_assets).toBeDefined();
    expect(route?.preview_assets?.length).toBe(1);
    expect(route?.preview_assets?.[0].asset_id).toBe("rpa_verify_001");
  });

  it("returns ok:true when captureRouteStartPreview returns null (no capturable URL)", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route?.preview_assets ?? []).toHaveLength(0);
  });

  it("returns ok:true when captureRouteStartPreview throws — capture failure is non-fatal", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Playwright launch failed"));

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("replaces existing start_page asset on re-verify (no duplicate accumulation)", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");

    // Seed an existing preview asset on the route.
    const route = routes.get(IDS.ROUTE_WIKI)!;
    route.preview_assets = [{
      asset_id: "rpa_old",
      kind: "start_page",
      route_id: IDS.ROUTE_WIKI,
      url_path: "/api/route-preview-assets/old.png",
      captured_at: "2026-01-01T00:00:00.000Z",
      redaction_applied: true,
      source: "manual_capture",
    }];
    routes.set(IDS.ROUTE_WIKI, route);

    const newAsset = {
      asset_id: "rpa_new",
      kind: "start_page" as const,
      route_id: IDS.ROUTE_WIKI,
      url_path: "/api/route-preview-assets/new.png",
      captured_at: "2026-01-01T00:00:02.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture" as const,
    };
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newAsset);

    await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });

    const updated = routes.get(IDS.ROUTE_WIKI);
    const startPages = updated?.preview_assets?.filter(a => a.kind === "start_page") ?? [];
    expect(startPages).toHaveLength(1);
    expect(startPages[0].asset_id).toBe("rpa_new");
  });

  it("does not capture preview when verification fails", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    const failedReport: RouteVerificationReport = { ...PASSED_REPORT, passed: false };
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failedReport);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });
    expect(res.statusCode).toBe(200);
    expect(captureRouteStartPreview).not.toHaveBeenCalled();
  });
});

// ─── POST /api/routes/:routeId/verify — replay asset auto-generation ─────────

import type { RouteReplayAsset } from "@aegis/types";
import { captureRouteReplay } from "../lib/routePreviewCapture.js";

function makeVerifyReplayAssets(routeId: string): RouteReplayAsset[] {
  return [
    {
      asset_id: "rra_verify_poster",
      route_id: routeId,
      route_hash: "verify_hash_001",
      kind: "poster_frame",
      url_path: `/api/route-preview-assets/${routeId}-poster-verify.png`,
      captured_at: "2026-01-01T00:00:01.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture",
      replay_safety: "full",
    },
    {
      asset_id: "rra_verify_video",
      route_id: routeId,
      route_hash: "verify_hash_001",
      kind: "replay_video",
      url_path: `/api/route-preview-assets/${routeId}-replay-verify.webm`,
      poster_url_path: `/api/route-preview-assets/${routeId}-poster-verify.png`,
      captured_at: "2026-01-01T00:00:01.000Z",
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture",
      replay_safety: "full",
    },
  ];
}

const PASSED_REPORT_REPLAY: RouteVerificationReport = {
  route_id: IDS.ROUTE_WIKI,
  passed: true,
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: "2026-01-01T00:00:01.000Z",
  step_results: [],
  errors: [],
};

describe("POST /api/routes/:routeId/verify — replay asset auto-generation", () => {
  it("calls captureRouteReplay alongside captureRouteStartPreview on successful verification", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT_REPLAY);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });

    expect(captureRouteStartPreview).toHaveBeenCalledOnce();
    expect(captureRouteReplay).toHaveBeenCalledOnce();
  });

  it("stores replay_assets on route after successful verification", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT_REPLAY);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeVerifyReplayAssets(IDS.ROUTE_WIKI));

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route?.replay_assets).toBeDefined();
    expect(route?.replay_assets?.some(a => a.kind === "replay_video")).toBe(true);
    expect(route?.replay_assets?.some(a => a.kind === "poster_frame")).toBe(true);
  });

  it("verification still returns ok:true when captureRouteReplay returns null", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT_REPLAY);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const route = routes.get(IDS.ROUTE_WIKI);
    expect(route?.replay_assets ?? []).toHaveLength(0);
  });

  it("verification still returns ok:true when captureRouteReplay throws", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT_REPLAY);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Playwright crashed"));

    const res = await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("re-verify replaces existing replay_assets by kind without duplicating", async () => {
    const { captureRouteStartPreview } = await import("../lib/routePreviewCapture.js");

    // Seed existing replay assets.
    const route = routes.get(IDS.ROUTE_WIKI)!;
    route.replay_assets = makeVerifyReplayAssets(IDS.ROUTE_WIKI).map(a => ({ ...a, asset_id: "rra_old_" + a.kind }));
    routes.set(IDS.ROUTE_WIKI, route);

    const newAssets = makeVerifyReplayAssets(IDS.ROUTE_WIKI).map(a => ({ ...a, asset_id: "rra_new_" + a.kind }));
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PASSED_REPORT_REPLAY);
    (captureRouteStartPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (captureRouteReplay as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newAssets);

    await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });

    const updated = routes.get(IDS.ROUTE_WIKI)!;
    const videos = updated.replay_assets?.filter(a => a.kind === "replay_video") ?? [];
    const posters = updated.replay_assets?.filter(a => a.kind === "poster_frame") ?? [];
    expect(videos).toHaveLength(1);
    expect(posters).toHaveLength(1);
    expect(videos[0].asset_id).toBe("rra_new_replay_video");
    expect(posters[0].asset_id).toBe("rra_new_poster_frame");
  });

  it("captureRouteReplay is NOT called when verification fails", async () => {
    (verifyRouteWithPlaywright as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...PASSED_REPORT_REPLAY,
      passed: false,
    });

    await server.inject({ method: "POST", url: `/api/routes/${IDS.ROUTE_WIKI}/verify` });

    expect(captureRouteReplay).not.toHaveBeenCalled();
  });
});

// ─── routeCompiler — start_url extraction ────────────────────────────────────

function makeRecordingPayload(domain: string, firstUrl: string) {
  return {
    workflow_name: "Test Route",
    domain,
    events: [
      {
        type: "click" as const,
        url: firstUrl,
        timestamp: "2026-01-01T00:00:00.000Z",
        locators: [{ type: "role" as const, role: "button", name: "Submit" }],
      },
    ],
  };
}

describe("routeCompiler — start_url extraction from first event", () => {
  it("sets start_url when first event hostname matches domain", async () => {
    const { compileRoute } = await import("../services/routeCompiler.js");
    const route = compileRoute(makeRecordingPayload("en.wikipedia.org", "https://en.wikipedia.org/wiki/Main_Page") as any);
    expect(route.start_url).toBe("https://en.wikipedia.org/wiki/Main_Page");
  });

  it("does not set start_url when first event hostname does not match domain", async () => {
    const { compileRoute } = await import("../services/routeCompiler.js");
    const route = compileRoute(makeRecordingPayload("example.com", "https://other-site.com/page") as any);
    expect(route.start_url).toBeUndefined();
  });

  it("resolveStartUrl returns the extracted start_url for an external domain route", () => {
    const route = makeRoute({ domain: "example.com", start_url: "https://example.com/login" });
    expect(resolveStartUrl(route)).toBe("https://example.com/login");
  });
});
