import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock playwright ───────────────────────────────────────────────────────────
// connectOverCDPMock must be hoisted so the vi.mock factory can reference it.

const connectOverCDPMock = vi.hoisted(() => vi.fn());

vi.mock("playwright", () => ({
  chromium: { connectOverCDP: connectOverCDPMock },
}));

const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue("https://github.com/login"),
  locator: vi.fn().mockReturnValue({
    first: vi.fn().mockReturnValue({ click: vi.fn().mockResolvedValue(undefined) }),
  }),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
};

const mockCtx = {
  pages: vi.fn().mockReturnValue([mockPage]),
};

function makeBrowser(overrides: Record<string, unknown> = {}) {
  return {
    contexts: vi.fn().mockReturnValue([mockCtx]),
    ...overrides,
  };
}

// ─── Mock agentSafeObservation ─────────────────────────────────────────────────
// MOCK_SNAPSHOT must be hoisted so the vi.mock factory can reference it.

const MOCK_SNAPSHOT = vi.hoisted(() => ({
  page_title: "GitHub · Login",
  headings: ["Sign in to GitHub"],
  links_sample: [],
  buttons_sample: ["Sign in"],
  forms_detected: 1,
}));

vi.mock("../runtime/agentSafeObservation.js", () => ({
  buildMinimalOpenObservation: vi.fn().mockResolvedValue(MOCK_SNAPSHOT),
}));

// ─── Import after mocks ────────────────────────────────────────────────────────

import { connectAndNavigate, connectAndObserve, connectAndClick } from "../runtime/taskBrowserControl.js";

const CDP_URL = "http://localhost:9226";

beforeEach(() => {
  vi.clearAllMocks();
  mockPage.goto.mockResolvedValue(undefined);
  mockPage.url.mockReturnValue("https://github.com/login");
  mockCtx.pages.mockReturnValue([mockPage]);
});

// ─── connectAndNavigate ────────────────────────────────────────────────────────

describe("connectAndNavigate", () => {
  it("succeeds when browser has no disconnect method", async () => {
    connectOverCDPMock.mockResolvedValue(makeBrowser()); // no disconnect key
    const result = await connectAndNavigate(CDP_URL, "https://github.com/login");
    expect(result.current_url).toBe("https://github.com/login");
    expect(result.snapshot).toMatchObject({ headings: expect.any(Array) });
  });

  it("succeeds when browser.disconnect throws", async () => {
    connectOverCDPMock.mockResolvedValue(
      makeBrowser({ disconnect: vi.fn().mockImplementation(() => { throw new Error("not a function"); }) }),
    );
    const result = await connectAndNavigate(CDP_URL, "https://github.com/login");
    expect(result.current_url).toBe("https://github.com/login");
  });

  it("succeeds when browser.disconnect exists and works", async () => {
    const disconnect = vi.fn();
    connectOverCDPMock.mockResolvedValue(makeBrowser({ disconnect }));
    await connectAndNavigate(CDP_URL, "https://github.com/login");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("propagates CDP_CONNECT_FAILED when connectOverCDP throws", async () => {
    connectOverCDPMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9226"));
    await expect(connectAndNavigate(CDP_URL, "https://github.com/login")).rejects.toMatchObject({
      code: "CDP_CONNECT_FAILED",
    });
  });

  it("propagates NAVIGATION_FAILED when page.goto throws", async () => {
    connectOverCDPMock.mockResolvedValue(makeBrowser({ disconnect: vi.fn() }));
    mockPage.goto.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
    await expect(connectAndNavigate(CDP_URL, "https://nonexistent.invalid")).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
  });
});

// ─── connectAndObserve ─────────────────────────────────────────────────────────

describe("connectAndObserve", () => {
  it("succeeds when browser has no disconnect method", async () => {
    connectOverCDPMock.mockResolvedValue(makeBrowser());
    const result = await connectAndObserve(CDP_URL);
    expect(result.current_url).toBe("https://github.com/login");
    expect(result.snapshot).toMatchObject({ headings: expect.any(Array) });
  });

  it("succeeds when browser.disconnect throws", async () => {
    connectOverCDPMock.mockResolvedValue(
      makeBrowser({ disconnect: vi.fn().mockImplementation(() => { throw new Error("not a function"); }) }),
    );
    const result = await connectAndObserve(CDP_URL);
    expect(result.current_url).toBe("https://github.com/login");
  });

  it("propagates CDP_CONNECT_FAILED when connectOverCDP throws", async () => {
    connectOverCDPMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9226"));
    await expect(connectAndObserve(CDP_URL)).rejects.toMatchObject({ code: "CDP_CONNECT_FAILED" });
  });
});

// ─── connectAndClick ───────────────────────────────────────────────────────────

describe("connectAndClick", () => {
  it("succeeds when browser has no disconnect method", async () => {
    connectOverCDPMock.mockResolvedValue(makeBrowser());
    const result = await connectAndClick(CDP_URL, "button[type=submit]");
    expect(result.current_url).toBe("https://github.com/login");
    expect(result.snapshot).toMatchObject({ headings: expect.any(Array) });
  });

  it("succeeds when browser.disconnect throws", async () => {
    connectOverCDPMock.mockResolvedValue(
      makeBrowser({ disconnect: vi.fn().mockImplementation(() => { throw new Error("not a function"); }) }),
    );
    const result = await connectAndClick(CDP_URL, "button[type=submit]");
    expect(result.current_url).toBe("https://github.com/login");
  });

  it("propagates CDP_CONNECT_FAILED when connectOverCDP throws", async () => {
    connectOverCDPMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9226"));
    await expect(connectAndClick(CDP_URL, "button")).rejects.toMatchObject({ code: "CDP_CONNECT_FAILED" });
  });

  it("propagates SELECTOR_NOT_FOUND on locator timeout", async () => {
    const clickMock = vi.fn().mockRejectedValue(new Error("Timeout 5000ms exceeded."));
    mockPage.locator.mockReturnValue({ first: vi.fn().mockReturnValue({ click: clickMock }) });
    connectOverCDPMock.mockResolvedValue(makeBrowser({ disconnect: vi.fn() }));
    await expect(connectAndClick(CDP_URL, "button.missing")).rejects.toMatchObject({
      code: "SELECTOR_NOT_FOUND",
    });
  });
});
