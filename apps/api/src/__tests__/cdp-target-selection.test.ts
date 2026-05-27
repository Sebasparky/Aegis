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

import { describe, it, expect } from "vitest";
import { pickBestPageTarget } from "../runtime/cdpTargetSelection.js";

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
