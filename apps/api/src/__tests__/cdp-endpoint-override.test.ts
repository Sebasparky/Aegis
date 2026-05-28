/**
 * CDP endpoint resolution for execute_secret_field_injection.
 *
 * Tests the 5-tier precedence in resolveSecretInjectionCdpEndpoint directly — no Fastify setup required.
 * The route wires the same function with getTaskBrowserSession + validateExternalCdpUrl.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSecretInjectionCdpEndpoint,
  type CdpEndpointResolution,
} from "../runtime/cdpEndpointResolver.js";

const VALID_URL = { valid: true as const };
const INVALID_URL = { valid: false as const, code: "INVALID_CDP_URL", message: "not a valid URL" };

function makeInjection(overrides: Partial<{
  browser_session_id: string;
  external_cdp_url: string;
  page_url: string;
}> = {}) {
  return {
    browser_session_id: undefined as string | undefined,
    external_cdp_url: undefined as string | undefined,
    page_url: "http://localhost:8787/login.html",
    ...overrides,
  };
}

function readySession(cdp_url: string, current_url?: string) {
  return (id: string) =>
    id === cdp_url.replace("http://localhost:", "sess-")
      ? { cdp_url, current_url, status: "ready" }
      : undefined;
}

// Helper: session lookup that always returns the named session as ready
function sessionLookup(sessions: Record<string, { cdp_url: string; current_url?: string; status: string }>) {
  return (id: string) => sessions[id];
}

describe("resolveSecretInjectionCdpEndpoint — 5-tier precedence", () => {
  it("1. body.browser_session_id → uses session cdp_url and current_url", () => {
    const sessions = {
      "bs-001": { cdp_url: "http://localhost:9222", current_url: "http://localhost:8787/login.html", status: "ready" },
    };
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection(),
      "bs-001",
      undefined,
      sessionLookup(sessions),
      () => VALID_URL,
    );
    expect(result.source).toBe("body_browser_session_id");
    expect(result.cdpUrlOverride).toBe("http://localhost:9222");
    expect(result.preferredTargetUrl).toBe("http://localhost:8787/login.html");
    expect(result.error).toBeUndefined();
  });

  it("2. body.external_cdp_url → uses it; preferredTargetUrl from injection.page_url", () => {
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection({ page_url: "http://localhost:8787/login.html" }),
      undefined,
      "http://localhost:9222",
      () => undefined,
      () => VALID_URL,
    );
    expect(result.source).toBe("body_external_cdp_url");
    expect(result.cdpUrlOverride).toBe("http://localhost:9222");
    expect(result.preferredTargetUrl).toBe("http://localhost:8787/login.html");
    expect(result.error).toBeUndefined();
  });

  it("3. body.browser_session_id takes precedence over stored external_cdp_url", () => {
    const sessions = {
      "bs-body": { cdp_url: "http://localhost:9222", current_url: "http://localhost:8787/login.html", status: "ready" },
    };
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection({ external_cdp_url: "http://localhost:9999" }),
      "bs-body",
      undefined,
      sessionLookup(sessions),
      () => VALID_URL,
    );
    expect(result.source).toBe("body_browser_session_id");
    expect(result.cdpUrlOverride).toBe("http://localhost:9222");
  });

  it("4. stored browser_session_id (no body override) → session cdp_url + current_url", () => {
    const sessions = {
      "bs-stored": { cdp_url: "http://localhost:9222", current_url: "http://localhost:8787/login.html", status: "ready" },
    };
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection({ browser_session_id: "bs-stored" }),
      undefined,
      undefined,
      sessionLookup(sessions),
      () => VALID_URL,
    );
    expect(result.source).toBe("stored_browser_session_id");
    expect(result.cdpUrlOverride).toBe("http://localhost:9222");
    expect(result.preferredTargetUrl).toBe("http://localhost:8787/login.html");
    expect(result.error).toBeUndefined();
  });

  it("5. no body, no stored endpoint → env fallback (cdpUrlOverride undefined)", () => {
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection(),
      undefined,
      undefined,
      () => undefined,
      () => VALID_URL,
    );
    expect(result.source).toBe("env_fallback");
    expect(result.cdpUrlOverride).toBeUndefined();
    expect(result.preferredTargetUrl).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("6. body.browser_session_id missing/not-ready → BROWSER_SESSION_NOT_READY error", () => {
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection(),
      "bs-missing",
      undefined,
      () => undefined,
      () => VALID_URL,
    );
    expect(result.source).toBe("body_browser_session_id");
    expect(result.error?.code).toBe("BROWSER_SESSION_NOT_READY");
    expect(result.cdpUrlOverride).toBeUndefined();
  });

  it("6b. body.browser_session_id found but status !== ready → BROWSER_SESSION_NOT_READY", () => {
    const sessions = {
      "bs-starting": { cdp_url: "http://localhost:9222", status: "starting" },
    };
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection(),
      "bs-starting",
      undefined,
      sessionLookup(sessions),
      () => VALID_URL,
    );
    expect(result.source).toBe("body_browser_session_id");
    expect(result.error?.code).toBe("BROWSER_SESSION_NOT_READY");
  });

  it("7. body.external_cdp_url fails validation → propagates error", () => {
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection(),
      undefined,
      "ftp://bad-url",
      () => undefined,
      () => INVALID_URL,
    );
    expect(result.source).toBe("body_external_cdp_url");
    expect(result.error?.code).toBe("INVALID_CDP_URL");
    expect(result.cdpUrlOverride).toBeUndefined();
  });

  it("8. diagnostic source field never contains resolved credential — only structural metadata", () => {
    const SECRET = "sup3r-s3cr3t-p@ssword!";
    const sessions = {
      "bs-001": { cdp_url: "http://localhost:9222", current_url: "http://localhost:8787/login.html", status: "ready" },
    };
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection(),
      "bs-001",
      undefined,
      sessionLookup(sessions),
      () => VALID_URL,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(result.source).toBe("body_browser_session_id");
    // The resolved source is structural metadata — cdp_url and current_url only
    expect(result.cdpUrlOverride).toBe("http://localhost:9222");
  });

  it("9. body.browser_session_id → preferredTargetUrl comes from bs.current_url, not injection.page_url", () => {
    const sessions = {
      "bs-001": {
        cdp_url: "http://localhost:9222",
        current_url: "http://localhost:8787/dashboard.html",  // different from injection.page_url
        status: "ready",
      },
    };
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection({ page_url: "http://localhost:8787/login.html" }),
      "bs-001",
      undefined,
      sessionLookup(sessions),
      () => VALID_URL,
    );
    expect(result.preferredTargetUrl).toBe("http://localhost:8787/dashboard.html");
    expect(result.preferredTargetUrl).not.toBe("http://localhost:8787/login.html");
  });

  it("stored external_cdp_url (no body, no stored session) → uses it + injection.page_url", () => {
    const result = resolveSecretInjectionCdpEndpoint(
      makeInjection({ external_cdp_url: "http://localhost:9223", page_url: "http://localhost:8787/login.html" }),
      undefined,
      undefined,
      () => undefined,
      () => VALID_URL,
    );
    expect(result.source).toBe("stored_external_cdp_url");
    expect(result.cdpUrlOverride).toBe("http://localhost:9223");
    expect(result.preferredTargetUrl).toBe("http://localhost:8787/login.html");
    expect(result.error).toBeUndefined();
  });
});
