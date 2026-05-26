import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock playwright before any imports ───────────────────────────────────────
const mockLaunch = vi.hoisted(() => vi.fn());

vi.mock("playwright", () => ({
  chromium: { launch: mockLaunch },
}));

// stepSafety has no store dependency — no store mock needed.

import type { AegisRoute, RouteStep } from "@aegis/types";
import { verifyRouteWithPlaywright } from "../services/routeVerifier.js";

// ── Fake browser/page helpers ─────────────────────────────────────────────────

function makeFakeLocator(opts: {
  attached?: boolean;
  onPress?: (key: string) => void;
  onClick?: () => void;
} = {}) {
  const loc: Record<string, any> = {
    waitFor: vi.fn().mockImplementation(({ state }: { state: string }) => {
      if (state === "attached" && opts.attached === false) {
        return Promise.reject(new Error("Element not found"));
      }
      return Promise.resolve();
    }),
    click: vi.fn().mockImplementation(() => {
      opts.onClick?.();
      return Promise.resolve();
    }),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockImplementation((key: string) => {
      opts.onPress?.(key);
      return Promise.resolve();
    }),
    selectOption: vi.fn().mockResolvedValue(undefined),
    innerText: vi.fn().mockResolvedValue(""),
  };
  loc.first = () => loc;
  loc.or = () => loc;
  return loc;
}

interface FakePageOpts {
  state: { url: string; title: string };
  locatorAttached?: boolean;
  onLocatorPress?: (key: string) => void;
  onLocatorClick?: () => void;
  onWaitForLoadState?: () => void;
}

function makeFakePage(opts: FakePageOpts) {
  const locator = makeFakeLocator({
    attached: opts.locatorAttached ?? true,
    onPress: opts.onLocatorPress,
    onClick: opts.onLocatorClick,
  });

  const page: Record<string, any> = {
    url: () => opts.state.url,
    title: vi.fn().mockImplementation(() => Promise.resolve(opts.state.title)),
    waitForLoadState: vi.fn().mockImplementation(() => {
      opts.onWaitForLoadState?.();
      return Promise.resolve();
    }),
    goto: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    getByRole: vi.fn().mockReturnValue(locator),
    getByLabel: vi.fn().mockReturnValue(locator),
    getByPlaceholder: vi.fn().mockReturnValue(locator),
    getByTestId: vi.fn().mockReturnValue(locator),
    locator: vi.fn().mockReturnValue(locator),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    _locator: locator,   // expose for assertion convenience
  };
  return page;
}

function makeFakeBrowser(page: ReturnType<typeof makeFakePage>) {
  const ctx = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    newContext: vi.fn().mockResolvedValue(ctx),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Route/step builders ───────────────────────────────────────────────────────

function makeRoute(steps: RouteStep[]): AegisRoute {
  return {
    route_id: "route_test_verifier",
    version: "1.0.0",
    created_at: "2026-01-01T00:00:00.000Z",
    last_verified_at: "2026-01-01T00:00:00.000Z",
    creator_aegis_id: "aid_test",
    trust_tier: "unverified_draft",
    domain: "localhost",  // demo path — no real network calls
    workflow_name: "Test",
    workflow_description: "Test",
    risk_level: "low",
    required_permissions: [],
    allowed_actions: [],
    forbidden_actions: [],
    approval_gates: [],
    confidence_threshold: 0.7,
    steps,
    run_count: 0,
    success_rate: 0,
    incident_count: 0,
  };
}

function makeFillStep(overrides: Partial<RouteStep> = {}): RouteStep {
  return {
    step_id: "step_fill_001",
    order: 1,
    action: "fill",
    intent: "fill_search_query",
    description: "fill the search field",
    target: {
      preferred_locator: { type: "label", name: "Search" },
      fallback_locators: [],
      confidence: 0.88,
    },
    value_policy: { type: "safe_literal", value: "Michigan", store_value: true },
    approval_required: false,
    confidence_required: 0.7,
    ...overrides,
  };
}

function makeClickStep(overrides: Partial<RouteStep> = {}): RouteStep {
  return {
    step_id: "step_click_001",
    order: 2,
    action: "click",
    intent: "click_search_button",
    description: "click the search button",
    target: {
      preferred_locator: { type: "label", name: "Search" },
      fallback_locators: [],
      confidence: 0.88,
    },
    approval_required: false,
    confidence_required: 0.7,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("routeVerifier — outcome detection and Enter fallback", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("safe fill + ambiguous click with no URL/title progress → Enter fallback fires → step passes", async () => {
    const state = { url: "http://localhost:3001/bank.html", title: "Demo Bank" };
    const page = makeFakePage({
      state,
      onLocatorPress: (key) => {
        if (key === "Enter") {
          state.url = "http://localhost:3001/results?q=Michigan";
          state.title = "Results — Michigan";
        }
      },
    });
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    const report = await verifyRouteWithPlaywright(
      makeRoute([makeFillStep(), makeClickStep()]),
    );

    expect(report.passed).toBe(true);
    expect(report.step_results).toHaveLength(2);
    expect(report.step_results[0].passed).toBe(true);   // fill
    expect(report.step_results[1].passed).toBe(true);   // click via Enter fallback
    expect(report.step_results[1].failure_reason).toBeUndefined();
    // Enter was pressed on the fill locator (label "Search")
    expect(page._locator.press).toHaveBeenCalledWith("Enter");
  });

  it("click step prefers role:button over label-matched input when both are attached", async () => {
    const state = { url: "http://localhost:3001/start", title: "Start" };
    let enterPressed = false;
    const page = makeFakePage({
      state,
      onLocatorPress: (key) => {
        if (key === "Enter") {
          enterPressed = true;
          state.url = "http://localhost:3001/results";
        }
      },
    });
    // Both role:button and label resolve to the same locator (both attached)
    // buildClickCandidates places role:button first, so selected_locator.type === "role"
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    const report = await verifyRouteWithPlaywright(
      makeRoute([makeFillStep(), makeClickStep()]),
    );

    const clickResult = report.step_results[1];
    // The selected locator should be the synthetic role:button, not the original label
    expect(clickResult.selected_locator).not.toBeNull();
    expect(clickResult.selected_locator?.type).toBe("role");
    expect((clickResult.selected_locator as any).role).toBe("button");
  });

  it("click causes immediate URL progress → step passes without Enter fallback", async () => {
    const state = { url: "http://localhost:3001/bank.html", title: "Demo Bank" };
    const page = makeFakePage({
      state,
      onWaitForLoadState: () => {
        // Simulate navigation completing after click
        state.url = "http://localhost:3001/results?q=Michigan";
        state.title = "Results — Michigan";
      },
    });
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    const report = await verifyRouteWithPlaywright(
      makeRoute([makeFillStep(), makeClickStep()]),
    );

    expect(report.passed).toBe(true);
    expect(report.step_results[1].passed).toBe(true);
    // Enter should NOT have been pressed — direct progress was detected
    expect(page._locator.press).not.toHaveBeenCalledWith("Enter");
  });

  it("click step with no prior safe fill and no URL progress → no_meaningful_progress (no Enter fallback attempted)", async () => {
    const state = { url: "http://localhost:3001/bank.html", title: "Demo Bank" };
    const page = makeFakePage({ state });  // URL/title never change
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    // Only a click step — no fill before it
    const report = await verifyRouteWithPlaywright(
      makeRoute([makeClickStep()]),
    );

    expect(report.passed).toBe(false);
    expect(report.step_results[0].passed).toBe(false);
    expect(report.step_results[0].failure_reason).toBe("no_meaningful_progress");
    // Enter was never pressed because there was no prior safe fill
    expect(page._locator.press).not.toHaveBeenCalledWith("Enter");
  });

  it("approval_required click step with no URL progress → fallback blocked for safety", async () => {
    const state = { url: "http://localhost:3001/bank.html", title: "Demo Bank" };
    const page = makeFakePage({ state });
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    const report = await verifyRouteWithPlaywright(
      makeRoute([
        makeFillStep(),
        makeClickStep({ approval_required: true }),
      ]),
    );

    expect(report.step_results[1].passed).toBe(false);
    expect(report.step_results[1].failure_reason).toBe("fallback_blocked_safety");
    expect(page._locator.press).not.toHaveBeenCalledWith("Enter");
  });

  it("click step with sensitive keyword in intent with no URL progress → fallback blocked for safety", async () => {
    const state = { url: "http://localhost:3001/bank.html", title: "Demo Bank" };
    const page = makeFakePage({ state });
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    // "confirm" matches SENSITIVE_CLICK_RE → classifyStepSafety returns "sensitive"
    const report = await verifyRouteWithPlaywright(
      makeRoute([
        makeFillStep(),
        makeClickStep({
          intent: "confirm_payment",
          description: "click the Confirm button",
        }),
      ]),
    );

    expect(report.step_results[1].passed).toBe(false);
    expect(report.step_results[1].failure_reason).toBe("fallback_blocked_safety");
    expect(page._locator.press).not.toHaveBeenCalledWith("Enter");
  });

  it("Enter fallback via title-only change (SPA) → hasMeaningfulProgress detects title change → step passes", async () => {
    const state = { url: "http://localhost:3001/spa", title: "Search App" };
    const page = makeFakePage({
      state,
      onLocatorPress: (key) => {
        if (key === "Enter") {
          // URL stays the same (SPA), only title updates
          state.title = "Search App — Michigan Results";
        }
      },
    });
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    const report = await verifyRouteWithPlaywright(
      makeRoute([makeFillStep(), makeClickStep()]),
    );

    expect(report.step_results[1].passed).toBe(true);
    expect(page._locator.press).toHaveBeenCalledWith("Enter");
  });

  it("Enter fallback attempted but produces no progress → fallback_attempted_failed", async () => {
    const state = { url: "http://localhost:3001/bank.html", title: "Demo Bank" };
    // Neither click nor Enter change the state
    const page = makeFakePage({ state });
    mockLaunch.mockResolvedValueOnce(makeFakeBrowser(page));

    const report = await verifyRouteWithPlaywright(
      makeRoute([makeFillStep(), makeClickStep()]),
    );

    expect(report.step_results[1].passed).toBe(false);
    expect(report.step_results[1].failure_reason).toBe("fallback_attempted_failed");
    expect(page._locator.press).toHaveBeenCalledWith("Enter");
  });
});
