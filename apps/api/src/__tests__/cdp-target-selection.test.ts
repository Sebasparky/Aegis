/**
 * Unit tests for CDP target selection helper (pickBestPageTarget).
 *
 * Verifies priority-ordered target binding:
 *   1. Exact URL match
 *   2. Same-origin match
 *   3. Domain match
 *   4. Non-blank fallback
 *   5. Last-target fallback
 *   6. No-target / empty list
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  pickBestPageTarget,
  readLiveCdpPageUrl,
  resolveSnapshotCdpTarget,
  getBrowserWsUrl,
  invalidateBrowserWsUrl,
  clearBrowserWsUrlCacheForTests,
} from "../runtime/cdpTargetSelection.js";

const blank = { id: "t1", url: "about:blank", type: "page" };
const newtab = { id: "t2", url: "chrome://newtab/", type: "page" };
const loginPage = { id: "t3", url: "http://localhost:8787/login.html", type: "page" };
const loginPageAlt = { id: "t4", url: "http://localhost:8787/register.html", type: "page" };
const githubLogin = { id: "t5", url: "https://github.com/login", type: "page" };
const devtools = { id: "t6", url: "devtools://devtools/bundled/devtools_app.html", type: "page" };
const worker = { id: "t7", url: "https://example.com/worker.js", type: "service_worker" };

describe("pickBestPageTarget", () => {
  it("selects login page over about:blank when about:blank is first and domain matches", () => {
    const result = pickBestPageTarget([blank, loginPage], { domain: "localhost" });
    expect(result.reason).toBe("domain_match");
    expect(result.target?.id).toBe(loginPage.id);
    expect(result.target?.url).toBe(loginPage.url);
  });

  it("selects exact URL match when preferredUrl is provided", () => {
    const result = pickBestPageTarget([blank, loginPage, loginPageAlt], {
      domain: "localhost",
      preferredUrl: "http://localhost:8787/login.html",
    });
    expect(result.reason).toBe("exact_url_match");
    expect(result.target?.id).toBe(loginPage.id);
  });

  it("selects same-origin match when preferredUrl doesn't match exactly but origin does", () => {
    const result = pickBestPageTarget([blank, loginPageAlt], {
      domain: "localhost",
      preferredUrl: "http://localhost:8787/login.html",
    });
    // login.html is not in list, but register.html has the same origin
    expect(result.reason).toBe("same_origin_match");
    expect(result.target?.id).toBe(loginPageAlt.id);
  });

  it("falls back to domain match when preferredUrl has no match in list", () => {
    const result = pickBestPageTarget([blank, githubLogin], {
      domain: "github.com",
      preferredUrl: "https://github.com/login",
    });
    // exact match wins
    expect(result.reason).toBe("exact_url_match");
    expect(result.target?.id).toBe(githubLogin.id);
  });

  it("uses domain match (not non-blank fallback) when domain is provided", () => {
    const result = pickBestPageTarget([blank, githubLogin, loginPage], {
      domain: "github.com",
    });
    expect(result.reason).toBe("domain_match");
    expect(result.target?.id).toBe(githubLogin.id);
  });

  it("skips about:blank and chrome://newtab/ as non-blank fallback", () => {
    const result = pickBestPageTarget([blank, newtab, loginPage]);
    expect(result.reason).toBe("non_blank_fallback");
    expect(result.target?.id).toBe(loginPage.id);
  });

  it("skips devtools:// targets in non-blank fallback", () => {
    const result = pickBestPageTarget([blank, devtools, loginPage]);
    expect(result.reason).toBe("non_blank_fallback");
    expect(result.target?.id).toBe(loginPage.id);
  });

  it("falls back to last target when all targets are unusable", () => {
    const result = pickBestPageTarget([blank, newtab]);
    expect(result.reason).toBe("last_target_fallback");
    expect(result.target?.id).toBe(newtab.id);
  });

  it("returns no_targets for empty target list", () => {
    const result = pickBestPageTarget([]);
    expect(result.reason).toBe("no_targets");
    expect(result.target).toBeUndefined();
  });

  it("ignores non-page types (service_worker etc)", () => {
    const result = pickBestPageTarget([worker, loginPage], { domain: "example.com" });
    // worker is not type=page so it's filtered; loginPage is the only page target
    expect(result.target?.id).toBe(loginPage.id);
  });

  it("includes all page candidate URLs in result for diagnostics", () => {
    const result = pickBestPageTarget([blank, loginPage], { domain: "localhost" });
    const urls = result.candidates.map((c) => c.url);
    expect(urls).toContain("about:blank");
    expect(urls).toContain(loginPage.url);
  });

  it("does not include service_worker types in candidates", () => {
    const result = pickBestPageTarget([worker, loginPage]);
    const urls = result.candidates.map((c) => c.url);
    expect(urls).not.toContain(worker.url);
  });

  it("returns undefined target with candidate list when no valid target exists", () => {
    const result = pickBestPageTarget([]);
    expect(result.target).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });

  it("exact URL wins over domain match when both are available", () => {
    const exactTarget = { id: "tx", url: "http://localhost:8787/login.html", type: "page" };
    const domainTarget = { id: "td", url: "http://localhost:8787/other.html", type: "page" };
    const result = pickBestPageTarget([domainTarget, exactTarget], {
      domain: "localhost",
      preferredUrl: "http://localhost:8787/login.html",
    });
    expect(result.reason).toBe("exact_url_match");
    expect(result.target?.id).toBe("tx");
  });
});


describe("readLiveCdpPageUrl (live CDP page-target URL source)", () => {
  const CDP = "http://localhost:9222";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetchList(targets: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => targets }) as unknown as Response),
    );
  }

  it("returns the active page target URL via the same pickBestPageTarget source", async () => {
    // about:blank is unusable; the live search page is the authoritative target.
    stubFetchList([
      { id: "t1", url: "about:blank", type: "page" },
      { id: "t2", url: "https://www.ikea.com/us/en/search/?q=coffee%20mug", type: "page" },
    ]);
    await expect(readLiveCdpPageUrl(CDP)).resolves.toBe(
      "https://www.ikea.com/us/en/search/?q=coffee%20mug",
    );
  });

  it("returns null (fail-safe) when the CDP transport throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(readLiveCdpPageUrl(CDP)).resolves.toBeNull();
  });

  it("returns null when there are no usable page targets", async () => {
    stubFetchList([{ id: "w", url: "https://x.test/worker.js", type: "service_worker" }]);
    await expect(readLiveCdpPageUrl(CDP)).resolves.toBeNull();
  });

  it("returns null when the CDP list payload is not an array", async () => {
    stubFetchList({ unexpected: true });
    await expect(readLiveCdpPageUrl(CDP)).resolves.toBeNull();
  });
});

describe("resolveSnapshotCdpTarget (one-shot snapshot target resolution)", () => {
  const CDP = "http://localhost:9222";
  const WS = "ws://localhost:9222/devtools/browser/abc";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearBrowserWsUrlCacheForTests();
  });

  // Branch on the requested URL: /json/version → ws endpoint; /json/list → targets.
  function stubFetch(targets: unknown, opts: { wsUrl?: string | undefined } = {}): ReturnType<typeof vi.fn> {
    const wsUrl = "wsUrl" in opts ? opts.wsUrl : WS;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/json/version")) {
        return { json: async () => ({ webSocketDebuggerUrl: wsUrl }) } as unknown as Response;
      }
      return { json: async () => targets } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetches /json/list exactly once and returns the ws endpoint + pickBestPageTarget selection", async () => {
    const fetchMock = stubFetch([
      { id: "t1", url: "about:blank", type: "page" },
      { id: "t2", url: "https://www.ikea.com/us/en/search/?q=coffee%20mug", type: "page" },
    ]);

    const resolved = await resolveSnapshotCdpTarget(CDP);

    expect(resolved).not.toBeNull();
    expect(resolved!.browserWsUrl).toBe(WS);
    // Same authoritative selection the click/type/scroll guards use.
    expect(resolved!.target.id).toBe("t2");
    expect(resolved!.target.url).toBe("https://www.ikea.com/us/en/search/?q=coffee%20mug");

    // The snapshot path must hit /json/list a SINGLE time (the dedupe guarantee).
    const listCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/list"));
    const versionCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/version"));
    expect(listCalls).toHaveLength(1);
    expect(versionCalls).toHaveLength(1);
  });

  it("returns null (fail-safe) when the CDP transport throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(resolveSnapshotCdpTarget(CDP)).resolves.toBeNull();
  });

  it("returns null when no browser WebSocket endpoint is advertised", async () => {
    stubFetch([{ id: "t1", url: "https://x.test/", type: "page" }], { wsUrl: undefined });
    await expect(resolveSnapshotCdpTarget(CDP)).resolves.toBeNull();
  });

  it("returns null when there is no usable page target", async () => {
    stubFetch([{ id: "w", url: "https://x.test/worker.js", type: "service_worker" }]);
    await expect(resolveSnapshotCdpTarget(CDP)).resolves.toBeNull();
  });

  it("returns null when the CDP list payload is not an array", async () => {
    stubFetch({ unexpected: true });
    await expect(resolveSnapshotCdpTarget(CDP)).resolves.toBeNull();
  });
});

// ─── getBrowserWsUrl — short-TTL /json/version cache ─────────────────────────
//
// Only the process-level WS endpoint is cached. The contract under test:
//  - within the TTL, /json/version is NOT re-fetched
//  - /json/list is NEVER cached by this helper (resolveSnapshotCdpTarget and all
//    action paths fetch it fresh — the live-URL guard's input stays live)
//  - invalidation and TTL expiry force a fresh fetch
//  - transport failures propagate; missing wsUrl is never cached

describe("getBrowserWsUrl (short-TTL browser WS endpoint cache)", () => {
  const CDP = "http://localhost:9333";
  const WS = "ws://localhost:9333/devtools/browser/xyz";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearBrowserWsUrlCacheForTests();
  });

  function stubVersionFetch(wsUrl: string | undefined): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/json/version")) {
        return { json: async () => ({ webSocketDebuggerUrl: wsUrl }) } as unknown as Response;
      }
      return { json: async () => [] } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("serves a cached WS URL within the TTL without re-fetching /json/version", async () => {
    const fetchMock = stubVersionFetch(WS);
    await expect(getBrowserWsUrl(CDP)).resolves.toBe(WS);
    await expect(getBrowserWsUrl(CDP)).resolves.toBe(WS);
    await expect(getBrowserWsUrl(CDP)).resolves.toBe(WS);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/version"))).toHaveLength(1);
  });

  it("resolveSnapshotCdpTarget with a warm cache STILL fetches /json/list fresh every call", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/json/version")) {
        return { json: async () => ({ webSocketDebuggerUrl: WS }) } as unknown as Response;
      }
      return {
        json: async () => [{ id: "t1", url: "https://example.com/live", type: "page" }],
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolveSnapshotCdpTarget(CDP);
    await resolveSnapshotCdpTarget(CDP);
    await resolveSnapshotCdpTarget(CDP);

    const listCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/list"));
    const versionCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/version"));
    expect(listCalls).toHaveLength(3); // live page state: never cached
    expect(versionCalls).toHaveLength(1); // process-level WS endpoint: cached
  });

  it("invalidateBrowserWsUrl forces a fresh /json/version fetch", async () => {
    const fetchMock = stubVersionFetch(WS);
    await getBrowserWsUrl(CDP);
    invalidateBrowserWsUrl(CDP);
    await getBrowserWsUrl(CDP);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/version"))).toHaveLength(2);
  });

  it("TTL expiry forces a fresh /json/version fetch", async () => {
    vi.useFakeTimers();
    const fetchMock = stubVersionFetch(WS);
    await getBrowserWsUrl(CDP);
    vi.advanceTimersByTime(11_000); // past the 10s TTL
    await getBrowserWsUrl(CDP);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/version"))).toHaveLength(2);
  });

  it("transport failures propagate (caller error contract unchanged) and are not cached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(getBrowserWsUrl(CDP)).rejects.toThrow("ECONNREFUSED");
    const fetchMock = stubVersionFetch(WS);
    await expect(getBrowserWsUrl(CDP)).resolves.toBe(WS);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("a missing wsUrl resolves undefined and is never cached", async () => {
    const fetchMock = stubVersionFetch(undefined);
    await expect(getBrowserWsUrl(CDP)).resolves.toBeUndefined();
    await expect(getBrowserWsUrl(CDP)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/json/version"))).toHaveLength(2);
  });
});
