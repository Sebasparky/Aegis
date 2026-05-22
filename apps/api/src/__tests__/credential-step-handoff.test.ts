/**
 * Credential Step Handoff v1 tests.
 *
 * Tests the performSubmitAndWait runtime function:
 * - Button allowlist / blocklist enforcement
 * - Outcome classification (navigated, challenge_detected, invalid_credentials, etc.)
 * - raw_value_revealed_to_agent invariant
 * - CDP disconnect-not-close invariant
 *
 * No real Chrome needed — Playwright is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Track disconnect calls to verify never calling .close()
let disconnectCalled = false;
let closeCalled = false;

interface MockPage {
  url: () => string;
  title: () => Promise<string>;
  locator: (sel: string) => MockLocator;
  getByRole: (role: string, opts?: { name?: string; exact?: boolean }) => MockLocator;
  waitForLoadState: (state?: string, opts?: { timeout?: number }) => Promise<void>;
  evaluate: <T>(fn: (...args: unknown[]) => T, arg?: unknown) => Promise<T>;
  _url: string;
  _signals: string[];
}

interface MockLocator {
  first: () => MockLocator;
  textContent: (opts?: { timeout?: number }) => Promise<string | null>;
  getAttribute: (attr: string, opts?: { timeout?: number }) => Promise<string | null>;
  click: (opts?: { timeout?: number }) => Promise<void>;
}

function makeLocator(text: string | null, clickFn?: () => Promise<void>): MockLocator {
  const self: MockLocator = {
    first: () => self,
    textContent: async () => text,
    getAttribute: async () => null,
    click: clickFn ?? (async () => {}),
  };
  return self;
}

function makePage(opts: {
  url?: string;
  title?: string;
  signals?: string[];
  buttonText?: string;
  clickCallback?: () => void;
  navigatesOnClick?: boolean;
  navigatedUrl?: string;
}): MockPage {
  let currentUrl = opts.url ?? "https://github.com/login";
  const navigatedUrl = opts.navigatedUrl ?? "https://github.com/";

  const page: MockPage = {
    _url: currentUrl,
    _signals: opts.signals ?? [],
    url: () => currentUrl,
    title: async () => opts.title ?? "GitHub",
    waitForLoadState: async () => {
      if (opts.navigatesOnClick) currentUrl = navigatedUrl;
    },
    evaluate: async <T>(_fn: (...args: unknown[]) => T, selectors?: unknown): Promise<T> => {
      if (Array.isArray(selectors)) return page._signals as unknown as T;
      return [] as unknown as T;
    },
    locator: (_sel: string) => makeLocator(opts.buttonText ?? null, async () => { opts.clickCallback?.(); }),
    getByRole: (_role: string, roleOpts?: { name?: string }) =>
      makeLocator(roleOpts?.name ?? opts.buttonText ?? "Sign in", async () => { opts.clickCallback?.(); }),
  };
  return page;
}

function makePlaywrightMock(page: MockPage) {
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    disconnect: vi.fn(() => { disconnectCalled = true; }),
    close: vi.fn(() => { closeCalled = true; }),
  };
  return browser;
}

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}));

import { chromium } from "playwright";

// ─── Import under test ────────────────────────────────────────────────────────

import { performSubmitAndWait } from "../runtime/credentialStepHandoff.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  disconnectCalled = false;
  closeCalled = false;
  vi.mocked(chromium.connectOverCDP).mockReset();
});

describe("Credential Step Handoff — button blocklist", () => {
  it("blocks 'Pay now' button", async () => {
    const page = makePage({ buttonText: "Pay now", url: "https://github.com/login" });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Pay now" },
    });

    expect(result.status).toBe("blocked_policy");
    expect(result.blocked_reason).toMatch(/blocklist/i);
  });

  it("blocks 'Delete account' button via selector", async () => {
    const page = makePage({ buttonText: "Delete account", url: "https://github.com/login" });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { selector_hint: "button.dangerous" },
    });

    expect(result.status).toBe("blocked_policy");
  });

  it("blocks 'Purchase' button", async () => {
    const page = makePage({ buttonText: "Purchase", url: "https://github.com/login" });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Purchase" },
    });

    expect(result.status).toBe("blocked_policy");
  });
});

describe("Credential Step Handoff — allowlist enforcement (no explicit hint)", () => {
  it("allows 'Sign in' button (allowlist match)", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      navigatesOnClick: true,
      navigatedUrl: "https://github.com/",
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: {},
    });

    expect(result.status).toBe("navigated");
  });

  it("blocks unknown button text when no hint provided", async () => {
    const page = makePage({ buttonText: "Confirm checkout", url: "https://github.com/login" });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: {},
    });

    expect(result.status).toBe("blocked_policy");
    expect(result.blocked_reason).toMatch(/allowlist/i);
  });
});

describe("Credential Step Handoff — outcome classification", () => {
  it("returns 'navigated' when URL changes after click", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      navigatesOnClick: true,
      navigatedUrl: "https://github.com/",
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    expect(result.status).toBe("navigated");
    expect(result.current_url).toBe("https://github.com/");
  });

  it("returns 'challenge_detected' when page signals manual_challenge_required", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      signals: ["Two-factor authentication", "Enter the code from your authenticator app"],
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    expect(result.status).toBe("challenge_detected");
    expect(result.challenge_kind).toBe("totp");
    expect(result.next_action?.recommended).toBe("report_security_challenge");
  });

  it("returns 'challenge_detected' with email_code kind for email verification signals", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      signals: ["Verification code", "Check your email inbox for the code"],
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    expect(result.status).toBe("challenge_detected");
    expect(result.challenge_kind).toBe("email_code");
  });

  it("returns 'invalid_credentials' when page signals bad password", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      signals: ["Sign in", "Incorrect username or password."],
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    expect(result.status).toBe("invalid_credentials");
    expect(result.next_action?.recommended).toBe("retry_login");
  });

  it("returns 'submit_failed' when CDP connect fails", async () => {
    vi.mocked(chromium.connectOverCDP).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    expect(result.status).toBe("submit_failed");
    expect(result.blocked_reason).toMatch(/CDP connect failed/);
  });
});

describe("Credential Step Handoff — security invariants", () => {
  it("result never contains raw_value_revealed_to_agent: true", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      navigatesOnClick: true,
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    expect(JSON.stringify(result)).not.toContain('"raw_value_revealed_to_agent":true');
  });

  it("calls disconnect() not close() on the browser", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      navigatesOnClick: true,
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    expect(disconnectCalled).toBe(true);
    expect(closeCalled).toBe(false);
  });

  it("calls disconnect() even when blocked by policy", async () => {
    const page = makePage({ buttonText: "Pay now", url: "https://github.com/login" });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Pay now" },
    });

    expect(disconnectCalled).toBe(true);
    expect(closeCalled).toBe(false);
  });

  it("result does not contain page snapshot or form values", async () => {
    const page = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      navigatesOnClick: true,
      navigatedUrl: "https://github.com/dashboard",
    });
    const browser = makePlaywrightMock(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    const serialized = JSON.stringify(result);
    // No snapshot-like keys
    expect(serialized).not.toContain('"snapshot"');
    expect(serialized).not.toContain('"html"');
    expect(serialized).not.toContain('"form_values"');
    // Safe metadata present
    expect(result.current_url).toBe("https://github.com/dashboard");
  });
});

describe("Credential Step Handoff — domain-scoped page finding", () => {
  it("prefers the page matching the injection domain over other open tabs", async () => {
    const loginPage = makePage({
      buttonText: "Sign in",
      url: "https://github.com/login",
      navigatesOnClick: true,
      navigatedUrl: "https://github.com/",
    });
    const otherPage = makePage({ buttonText: "irrelevant", url: "https://google.com" });

    const browser = {
      contexts: () => [{ pages: () => [otherPage, loginPage] }],
      disconnect: vi.fn(() => { disconnectCalled = true; }),
      close: vi.fn(() => { closeCalled = true; }),
    };
    vi.mocked(chromium.connectOverCDP).mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);

    const result = await performSubmitAndWait({
      domain: "github.com",
      cdpUrl: "http://localhost:9222",
      step_kind: "password_submit",
      submit: { button_text: "Sign in" },
    });

    // Should have used github.com page, not google.com
    expect(result.status).toBe("navigated");
    expect(result.current_url).toBe("https://github.com/");
  });
});
