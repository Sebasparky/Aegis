import { vi, describe, it, expect, beforeEach } from "vitest";

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

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  let counter = 0;
  return { ...actual, newId: vi.fn(() => `rra_test_${++counter}`) };
});

vi.mock("playwright", () => ({
  chromium: { launch: vi.fn() },
}));

import type { AegisRoute } from "@aegis/types";
import { captureRouteReplay } from "../lib/routePreviewCapture.js";
import { chromium } from "playwright";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPage() {
  return {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://example.com/result"),
    title: vi.fn().mockResolvedValue("Result Page"),
    close: vi.fn().mockResolvedValue(undefined),
    video: vi.fn().mockReturnValue({
      path: vi.fn().mockResolvedValue("/tmp/fake-video.webm"),
    }),
  };
}

// Non-Wikipedia route_id avoids the seeded-destination-check branch (line 142 in routePreviewCapture.ts).
const TEST_ROUTE = {
  route_id: "route_test_settle_001",
  version: 1,
  start_url: "https://example.com",
  domain: "example.com",
  steps: [],
  replay_assets: [],
} as unknown as AegisRoute;

let mockPage: ReturnType<typeof makeMockPage>;

beforeEach(() => {
  vi.clearAllMocks();
  mockPage = makeMockPage();
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };
  (chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("captureRouteReplay — final settled frame", () => {
  it("calls page.close after all steps finish", async () => {
    const result = await captureRouteReplay(TEST_ROUTE);
    expect(result).not.toBeNull();
    expect(mockPage.close).toHaveBeenCalledOnce();
  });

  it("calls waitForLoadState(domcontentloaded), waitForLoadState(networkidle), waitForTimeout, then page.close in that order", async () => {
    const callOrder: string[] = [];
    mockPage.waitForLoadState.mockImplementation(async (state: string) => {
      callOrder.push(`wfl:${state}`);
    });
    mockPage.waitForTimeout.mockImplementation(async () => {
      callOrder.push("timeout");
    });
    mockPage.close.mockImplementation(async () => {
      callOrder.push("close");
    });

    await captureRouteReplay(TEST_ROUTE);

    const dIdx = callOrder.indexOf("wfl:domcontentloaded");
    const nIdx = callOrder.indexOf("wfl:networkidle");
    const tIdx = callOrder.lastIndexOf("timeout");
    const cIdx = callOrder.indexOf("close");

    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(nIdx).toBeGreaterThan(dIdx);
    expect(tIdx).toBeGreaterThan(nIdx);
    expect(cIdx).toBeGreaterThan(tIdx);
  });

  it("still returns assets when waitForLoadState rejects (navigation failure)", async () => {
    mockPage.waitForLoadState.mockRejectedValue(new Error("Navigation timeout"));
    const result = await captureRouteReplay(TEST_ROUTE);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });

  it("remains bounded and still returns assets when networkidle never resolves", async () => {
    mockPage.waitForLoadState.mockImplementation(async (state: string) => {
      if (state === "networkidle") throw new Error("Timeout exceeded: networkidle never fired");
    });
    const result = await captureRouteReplay(TEST_ROUTE);
    expect(result).not.toBeNull();
    expect(result!.some(a => a.kind === "poster_frame")).toBe(true);
  });

  it("returns both poster_frame and replay_video assets", async () => {
    const result = await captureRouteReplay(TEST_ROUTE);
    expect(result).not.toBeNull();
    const kinds = result!.map(a => a.kind);
    expect(kinds).toContain("poster_frame");
    expect(kinds).toContain("replay_video");
  });
});
