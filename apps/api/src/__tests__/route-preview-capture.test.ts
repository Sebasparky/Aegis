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

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { routeRoutes } from "../routes/routes.js";
import { routes } from "../store/index.js";
import { seedTestData, resetStore, IDS } from "./helpers.js";
import type { AegisRoute } from "@aegis/types";
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
