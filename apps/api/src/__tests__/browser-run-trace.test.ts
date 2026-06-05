/**
 * Dev-only Antigen browser run trace.
 *
 * Drives the real Antigen browser tool endpoints (snapshot / click / scroll /
 * type / navigation-state) with the runtime mocked, then reads the sanitized
 * trace via GET /api/internal/browser-run-trace/:browser_runtime_id. Asserts:
 *  - the right event_type / result_code / error_code is recorded per boundary,
 *  - pointer_dispatch reflects whether a dispatch actually occurred,
 *  - navigation_state preserves host+path (no query strings),
 *  - browser_type never records raw typed text,
 *  - no forbidden internals (cdp_url, coordinates, profile paths, secrets) leak,
 *  - recording is gated by ANTIGEN_BROWSER_TRACE and bounded per session.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock the realistic runtime (no real browser/CDP).
const clickKnownBoxMock = vi.hoisted(() => vi.fn());
const clickByDescriptionMock = vi.hoisted(() => vi.fn());
const typeTextMock = vi.hoisted(() => vi.fn());
const scrollIntoViewMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return {
    ...actual,
    realisticClickKnownBox: clickKnownBoxMock,
    realisticClickByDescription: clickByDescriptionMock,
    realisticTypeTextViaCDP: typeTextMock,
    scrollKnownBoxIntoView: scrollIntoViewMock,
  };
});

// Mock snapshot extraction so browser-snapshot works without a real page.
const extractMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  return { ...actual, extractAntigenSnapshotCandidatesViaCDP: extractMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { createAntigenSnapshotRecord, clearAntigenSnapshotStoreForTests } from "../runtime/antigenSnapshotStore.js";
import {
  recordBrowserTraceEvent,
  getBrowserRunTrace,
  listBrowserRunTraces,
  clearBrowserRunTraces,
} from "../runtime/browserRunTrace.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { browserRunTraceRoutes } from "../routes/browser-run-trace.js";
import { agentDelegations, passes } from "../store/index.js";

const BEARER = "Bearer tok_trace_001";
const DELEGATION_ID = "del_trace_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_trace_001";
const CLICK_URL = "/api/agent/v1/runtime/browser-click";
const SCROLL_URL = "/api/agent/v1/runtime/browser-scroll-to-ref";
const SNAPSHOT_URL = "/api/agent/v1/runtime/browser-snapshot";
const TYPE_URL = "/api/agent/v1/runtime/browser-type";
const NAV_URL = "/api/agent/v1/runtime/browser-navigation-state";
const TRACE_URL = `/api/internal/browser-run-trace/${SESSION_ID}`;
const CATEGORY_URL = "https://www.ikea.com/us/en/cat/workspace-desks-chairs-fu004/?ref=secret123&token=abc";

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_trace_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: "https://www.google.com/search?q=best+ikea+shelves+reddit",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  };
  taskBrowserSessions.set(session.browser_session_id, session);
  return session;
}

function candidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "button",
    kind: "button",
    role: "button",
    name: "Add to bag",
    normalized_name: "add to bag",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 100, y: 200, width: 80, height: 40, doc_x: 100, doc_y: 1800 },
    ...overrides,
  };
}

function seedSnapshot(candidates: AntigenSnapshotCandidate[]) {
  return createAntigenSnapshotRecord({
    browser_session_id: SESSION_ID,
    browser_runtime_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    url: "https://www.ikea.com/us/en/cat/",
    title: null,
    candidates,
  });
}

async function readTrace() {
  const res = await server.inject({ method: "GET", url: TRACE_URL });
  expect(res.statusCode).toBe(200);
  return res.json().data as { browser_runtime_id: string; event_count: number; events: any[] };
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_trace_001", {
    id: "pass_trace_001",
    token: "tok_trace_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestTraceAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestTraceAgent",
    channel: "api",
    status: "active",
    token_id: "pass_trace_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(browserRunTraceRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_trace_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  vi.stubEnv("ANTIGEN_BROWSER_TRACE", "true");
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearBrowserRunTraces();
  vi.clearAllMocks();
  clickKnownBoxMock.mockResolvedValue({
    success: true,
    pointer_start_source: "session",
    pointer_path_point_count: 7,
    pointer_state_persisted: true,
    current_url: CATEGORY_URL,
  });
  clickByDescriptionMock.mockResolvedValue({
    success: true,
    pointer_path_point_count: 5,
    current_url: CATEGORY_URL,
  });
  typeTextMock.mockResolvedValue({
    success: true,
    char_count_bucket: "9-16",
    duration_ms: 120,
    focused: true,
    submitted: true,
    pointer_path_point_count: 4,
  });
  scrollIntoViewMock.mockResolvedValue({ success: true });
  extractMock.mockResolvedValue([
    candidate({ name: "Add to bag", clickable: true, typeable: false }),
    candidate({ name: "Search", kind: "textbox", role: "textbox", clickable: false, typeable: true }),
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("browser run trace — recording at tool boundaries", () => {
  it("records a successful ag_* click with click_path=ag_ref, realistic_success, pointer_dispatch=true", async () => {
    seedSession();
    seedSnapshot([candidate({ name: "Add to bag" })]);
    const res = await server.inject({
      method: "POST", url: CLICK_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element_description: "Add to bag" },
    });
    expect(res.statusCode).toBe(200);

    const trace = await readTrace();
    const click = trace.events.find((e) => e.event_type === "browser_click");
    expect(click).toBeTruthy();
    expect(click.click_path).toBe("ag_ref");
    expect(click.ref).toBe("ag_1");
    expect(click.result_code).toBe("realistic_success");
    expect(click.pointer_dispatch).toBe(true);
    expect(click.element_name).toBe("Add to bag");
    // url_after is host+path only — no query string / secret params.
    expect(click.url_after).toBe("www.ikea.com/us/en/cat/workspace-desks-chairs-fu004/");
    expect(click.url_after).not.toContain("secret123");
    expect(click.url_after).not.toContain("?");
  });

  it("records an offscreen ag_* click as ANTIGEN_REF_OUT_OF_VIEWPORT with pointer_dispatch=false", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_OUT_OF_VIEWPORT" });
    const res = await server.inject({
      method: "POST", url: CLICK_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element_description: "Add to bag" },
    });
    expect(res.statusCode).toBe(422);

    const trace = await readTrace();
    const click = trace.events.find((e) => e.event_type === "browser_click");
    expect(click.error_code).toBe("ANTIGEN_REF_OUT_OF_VIEWPORT");
    expect(click.pointer_dispatch).toBe(false);
    expect(click.result_code).toBeUndefined();
  });

  it("records browser_scroll_to_ref success as scroll_to_ref_success", async () => {
    seedSession();
    seedSnapshot([candidate({ box: { x: 10, y: 5000, width: 80, height: 40, doc_x: 10, doc_y: 5000 } })]);
    const res = await server.inject({
      method: "POST", url: SCROLL_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(200);

    const trace = await readTrace();
    const scroll = trace.events.find((e) => e.event_type === "browser_scroll_to_ref");
    expect(scroll.result_code).toBe("scroll_to_ref_success");
    expect(scroll.ref).toBe("ag_1");
  });

  it("records antigen_snapshot with viewport_only and element/clickable/typeable counts only", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: SNAPSHOT_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot", viewport_only: true },
    });
    expect(res.statusCode).toBe(200);

    const trace = await readTrace();
    const snap = trace.events.find((e) => e.event_type === "antigen_snapshot");
    expect(snap.result_code).toBe("antigen_snapshot_success");
    expect(snap.snapshot.viewport_only).toBe(true);
    expect(snap.snapshot.element_count).toBe(2);
    expect(snap.snapshot.clickable_count).toBe(1);
    expect(snap.snapshot.typeable_count).toBe(1);
    // The snapshot event must not carry element names/values.
    expect(snap.element_name).toBeUndefined();
  });

  it("records browser_type with char_count_bucket/submit and never the raw text", async () => {
    seedSession();
    const SECRET_QUERY = "best ikea billy shelves reddit";
    const res = await server.inject({
      method: "POST", url: TYPE_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, text: SECRET_QUERY, submit: true },
    });
    expect(res.statusCode).toBe(200);

    const trace = await readTrace();
    const typed = trace.events.find((e) => e.event_type === "browser_type");
    expect(typed.char_count_bucket).toBe("9-16");
    expect(typed.submit).toBe(true);
    expect(typed.result_code).toBe("realistic_type_success");
    // Raw typed text must never appear anywhere in the trace.
    expect(JSON.stringify(trace)).not.toContain("billy");
    expect(JSON.stringify(trace)).not.toContain(SECRET_QUERY);
  });

  it("records navigation_state with sanitized host+path and no query string", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: NAV_URL, headers: { authorization: BEARER },
      payload: {
        browser_runtime_id: SESSION_ID, action: "navigation_proxy",
        url: "https://www.reddit.com/r/IKEA/comments/abc123/best_shelves/?utm_source=secret",
      },
    });
    expect(res.statusCode).toBe(200);

    const trace = await readTrace();
    const nav = trace.events.find((e) => e.event_type === "navigation_state");
    // url_before is the seeded google search (host+path, query stripped).
    expect(nav.url_before).toBe("www.google.com/search");
    expect(nav.url_after).toBe("www.reddit.com/r/IKEA/comments/abc123/best_shelves/");
    expect(nav.url_after).not.toContain("utm_source");
    expect(nav.url_after).not.toContain("secret");
    expect(nav.url_after).not.toContain("?");
  });
});

describe("browser run trace — leak guard & gating", () => {
  it("never leaks forbidden internals in trace output", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    await server.inject({
      method: "POST", url: CLICK_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element_description: "Add to bag" },
    });
    await server.inject({
      method: "POST", url: SNAPSHOT_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    await server.inject({
      method: "POST", url: NAV_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "navigation_proxy", url: CATEGORY_URL },
    });

    const res = await server.inject({ method: "GET", url: TRACE_URL });
    const raw = JSON.stringify(res.json());
    const FORBIDDEN = [
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref", "password",
      "cookies", "localStorage", "sessionStorage", "innerHTML",
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "doc_x", "doc_y",
      "nearby_text", "9222", "localhost",
    ];
    for (const f of FORBIDDEN) {
      expect(raw).not.toContain(f);
    }
  });

  it("does not record when ANTIGEN_BROWSER_TRACE is unset (endpoint returns empty)", async () => {
    vi.stubEnv("ANTIGEN_BROWSER_TRACE", "");
    seedSession();
    seedSnapshot([candidate()]);
    const res = await server.inject({
      method: "POST", url: CLICK_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element_description: "Add to bag" },
    });
    expect(res.statusCode).toBe(200);

    const trace = await readTrace();
    expect(trace.event_count).toBe(0);
    expect(trace.events).toHaveLength(0);
  });

  it("bounds events per session to 200, dropping the oldest", () => {
    for (let i = 0; i < 250; i++) {
      recordBrowserTraceEvent(SESSION_ID, {
        event_type: "navigation_state",
        browser_runtime_id: SESSION_ID,
        url_after: `example.com/page/${i}`,
      });
    }
    const trace = getBrowserRunTrace(SESSION_ID)!;
    expect(trace.events).toHaveLength(200);
    expect(trace.event_count).toBe(250);
    // Oldest dropped — first retained event is page/50.
    expect(trace.events[0].url_after).toBe("example.com/page/50");
    expect(trace.events[199].url_after).toBe("example.com/page/249");
  });

  it("returns empty events for an unknown runtime id", async () => {
    const res = await server.inject({
      method: "GET", url: "/api/internal/browser-run-trace/does_not_exist",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.events).toHaveLength(0);
  });
});

describe("browser run trace — list/index endpoint", () => {
  const LIST_URL = "/api/internal/browser-run-traces";

  async function readList(query = "") {
    const res = await server.inject({ method: "GET", url: `${LIST_URL}${query}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    return body.data as {
      trace_count: number;
      traces: Array<{
        browser_runtime_id: string;
        created_at: string;
        last_event_at: string;
        expires_at: string;
        ttl_ms: number;
        age_ms: number;
        event_count: number;
        last_event_type?: string;
        last_ts?: string;
        last_url?: string;
      }>;
    };
  }

  it("returns an empty list when ANTIGEN_BROWSER_TRACE is unset", async () => {
    // Even if some events were recorded under the (then-enabled) flag, disabling
    // the flag makes the list return empty without throwing.
    recordBrowserTraceEvent("rt_disabled", {
      event_type: "navigation_state",
      browser_runtime_id: "rt_disabled",
      url_after: "example.com/page",
    });
    vi.stubEnv("ANTIGEN_BROWSER_TRACE", "");

    const data = await readList();
    expect(data.trace_count).toBe(0);
    expect(data.traces).toEqual([]);
  });

  it("returns active traces with safe metadata when enabled", async () => {
    recordBrowserTraceEvent("rt_alpha", {
      event_type: "navigation_state",
      browser_runtime_id: "rt_alpha",
      url_after: "www.ikea.com/us/en/cat",
    });
    recordBrowserTraceEvent("rt_alpha", {
      event_type: "browser_click",
      browser_runtime_id: "rt_alpha",
      ref: "ag_1",
      result_code: "realistic_success",
    });
    recordBrowserTraceEvent("rt_beta", {
      event_type: "antigen_snapshot",
      browser_runtime_id: "rt_beta",
      result_code: "antigen_snapshot_success",
    });

    const data = await readList();
    expect(data.trace_count).toBe(2);

    const ids = data.traces.map((t) => t.browser_runtime_id).sort();
    expect(ids).toEqual(["rt_alpha", "rt_beta"]);

    const alpha = data.traces.find((t) => t.browser_runtime_id === "rt_alpha")!;
    expect(alpha.created_at).toBeTruthy();
    expect(alpha.event_count).toBe(2);
    expect(alpha.last_event_type).toBe("browser_click");
    expect(alpha.last_ts).toBeTruthy();
  });

  it("derives last_url as sanitized host+path with no query/fragment", async () => {
    seedSession();
    await server.inject({
      method: "POST", url: NAV_URL, headers: { authorization: BEARER },
      payload: {
        browser_runtime_id: SESSION_ID, action: "navigation_proxy",
        url: "https://www.reddit.com/r/IKEA/comments/abc/title/?token=secret#frag",
      },
    });

    const data = await readList();
    const entry = data.traces.find((t) => t.browser_runtime_id === SESSION_ID)!;
    expect(entry.last_url).toBe("www.reddit.com/r/IKEA/comments/abc/title/");
    expect(entry.last_url).not.toContain("token");
    expect(entry.last_url).not.toContain("secret");
    expect(entry.last_url).not.toContain("?");
    expect(entry.last_url).not.toContain("#");
  });

  it("respects ?limit and never 500s on invalid limit", async () => {
    for (const id of ["rt_1", "rt_2", "rt_3", "rt_4"]) {
      recordBrowserTraceEvent(id, {
        event_type: "navigation_state",
        browser_runtime_id: id,
        url_after: `example.com/${id}`,
      });
    }

    const limited = await readList("?limit=2");
    expect(limited.traces).toHaveLength(2);
    expect(limited.trace_count).toBe(2);

    // Invalid / negative limits fall back safely — no 500.
    const invalid = await readList("?limit=abc");
    expect(invalid.traces.length).toBeGreaterThan(0);
    const negative = await readList("?limit=-5");
    expect(negative.traces.length).toBeGreaterThan(0);
  });

  it("never leaks forbidden internals in the list response", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    await server.inject({
      method: "POST", url: CLICK_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element_description: "Add to bag" },
    });
    await server.inject({
      method: "POST", url: NAV_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "navigation_proxy", url: CATEGORY_URL },
    });

    const res = await server.inject({ method: "GET", url: LIST_URL });
    const raw = JSON.stringify(res.json());
    const FORBIDDEN = [
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref", "password",
      "cookies", "localStorage", "sessionStorage", "innerHTML",
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "doc_x", "doc_y",
      "nearby_text", "9222", "localhost", "secret123",
    ];
    for (const f of FORBIDDEN) {
      expect(raw).not.toContain(f);
    }
  });

  it("returns ids usable against the per-runtime endpoint", async () => {
    seedSession();
    seedSnapshot([candidate({ name: "Add to bag" })]);
    await server.inject({
      method: "POST", url: CLICK_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element_description: "Add to bag" },
    });

    const data = await readList();
    expect(data.trace_count).toBe(1);
    const id = data.traces[0].browser_runtime_id;

    const res = await server.inject({
      method: "GET", url: `/api/internal/browser-run-trace/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const full = res.json().data as { events: any[] };
    expect(full.events.length).toBeGreaterThan(0);
    expect(full.events.some((e) => e.event_type === "browser_click")).toBe(true);
  });
});

describe("browser run trace — rejected/orphan calls (SESSION_NOT_FOUND)", () => {
  const STALE_ID = "tbsess_stale_999";

  async function readStaleTrace() {
    const res = await server.inject({
      method: "GET", url: `/api/internal/browser-run-trace/${STALE_ID}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json().data as { browser_runtime_id: string; event_count: number; events: any[] };
  }

  it("records browser_tool_rejected for a browser-click against an unknown session", async () => {
    // No session seeded — beforeEach clears taskBrowserSessions.
    const res = await server.inject({
      method: "POST", url: CLICK_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: STALE_ID, ref: "ag_1", element_description: "Add to bag" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");

    const trace = await readStaleTrace();
    expect(trace.browser_runtime_id).toBe(STALE_ID);
    const rejected = trace.events.find((e) => e.event_type === "browser_tool_rejected");
    expect(rejected).toBeTruthy();
    expect(rejected.tool).toBe("browser_click");
    expect(rejected.error_code).toBe("SESSION_NOT_FOUND");
  });

  it("records browser_tool_rejected (tool=browser_navigation_state) for nav-state against an unknown session", async () => {
    const res = await server.inject({
      method: "POST", url: NAV_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: STALE_ID, url: CATEGORY_URL, action: "navigation_proxy" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");

    const trace = await readStaleTrace();
    const rejected = trace.events.find(
      (e) => e.event_type === "browser_tool_rejected" && e.tool === "browser_navigation_state",
    );
    expect(rejected).toBeTruthy();
    expect(rejected.error_code).toBe("SESSION_NOT_FOUND");
  });

  it("rejected event leaks no internals — only event_type, tool, error_code, id, ts", async () => {
    await server.inject({
      method: "POST", url: SNAPSHOT_URL, headers: { authorization: BEARER },
      payload: { browser_runtime_id: STALE_ID, action: "dom_snapshot" },
    });
    const trace = await readStaleTrace();
    const rejected = trace.events.find((e) => e.event_type === "browser_tool_rejected");
    expect(rejected).toBeTruthy();
    expect(rejected.tool).toBe("antigen_snapshot");

    const serialized = JSON.stringify(trace);
    // No forbidden internals: cdp_url, ports, profile paths, secrets, coordinates.
    expect(serialized).not.toMatch(/cdp_url|user_data_dir|localhost:9222|9222|secret|pass_id|doc_x|doc_y/);
    // The rejected event carries only the safe allowlist fields.
    const keys = Object.keys(rejected).sort();
    expect(keys).toEqual(["browser_runtime_id", "error_code", "event_type", "tool", "ts"]);
  });
});

describe("browser run trace — TTL & expiration metadata", () => {
  const TTL_MS = 60 * 60 * 1000; // must match TRACE_TTL_MS in browserRunTrace.ts
  const T0 = new Date("2026-06-05T00:00:00.000Z").getTime();
  const LIST_URL = "/api/internal/browser-run-traces";

  beforeEach(() => {
    // Outer beforeEach already stubbed ANTIGEN_BROWSER_TRACE=true and cleared traces.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function recordNav(id: string, page: string) {
    recordBrowserTraceEvent(id, {
      event_type: "navigation_state",
      browser_runtime_id: id,
      url_after: page,
    });
  }

  async function readList() {
    const res = await server.inject({ method: "GET", url: LIST_URL });
    expect(res.statusCode).toBe(200);
    return res.json().data as {
      trace_count: number;
      traces: Array<{
        browser_runtime_id: string;
        created_at: string;
        last_event_at: string;
        expires_at: string;
        ttl_ms: number;
        age_ms: number;
        event_count: number;
      }>;
    };
  }

  it("A. keeps a trace alive when it keeps receiving events (TTL slides forward)", () => {
    recordNav("rt_ttl_a", "example.com/p1");
    // Idle almost the full TTL, then a fresh event refreshes last-activity.
    vi.setSystemTime(T0 + TTL_MS - 60_000);
    recordNav("rt_ttl_a", "example.com/p2");
    // Past created_at + TTL, but before last_event_at + TTL — must still be present.
    vi.setSystemTime(T0 + TTL_MS + 30 * 60_000);
    const traces = listBrowserRunTraces();
    expect(traces.some((t) => t.browser_runtime_id === "rt_ttl_a")).toBe(true);
  });

  it("B. expires a trace once idle past last_event_at + TTL", () => {
    recordNav("rt_ttl_b", "example.com/p1");
    vi.setSystemTime(T0 + TTL_MS + 1);
    expect(listBrowserRunTraces()).toEqual([]);
    expect(getBrowserRunTrace("rt_ttl_b")).toBeUndefined();
  });

  it("C. index exposes expiration metadata derived from last_event_at, not created_at", async () => {
    recordNav("rt_ttl_c", "example.com/p1");
    // A later event must move last_event_at / expires_at forward.
    vi.setSystemTime(T0 + 10 * 60_000);
    recordNav("rt_ttl_c", "example.com/p2");

    const data = await readList();
    const entry = data.traces.find((t) => t.browser_runtime_id === "rt_ttl_c")!;
    expect(entry.ttl_ms).toBe(TTL_MS);
    expect(entry.last_event_at).toBe(new Date(T0 + 10 * 60_000).toISOString());
    expect(entry.expires_at).toBe(new Date(T0 + 10 * 60_000 + TTL_MS).toISOString());
    // Expiry tracks the later event, not creation time.
    expect(entry.expires_at).not.toBe(new Date(T0 + TTL_MS).toISOString());
    expect(entry.created_at).toBe(new Date(T0).toISOString());
    expect(entry.age_ms).toBe(0);

    // age_ms grows with idle time since the last event.
    vi.setSystemTime(T0 + 15 * 60_000);
    const later = (await readList()).traces.find((t) => t.browser_runtime_id === "rt_ttl_c")!;
    expect(later.age_ms).toBe(5 * 60_000);
  });

  it("D. per-runtime endpoint exposes the same expiration metadata", async () => {
    recordNav("rt_ttl_d", "example.com/p1");
    const res = await server.inject({
      method: "GET", url: "/api/internal/browser-run-trace/rt_ttl_d",
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      last_event_at: string; expires_at: string; ttl_ms: number; age_ms: number; created_at: string;
    };
    expect(data.ttl_ms).toBe(TTL_MS);
    expect(data.last_event_at).toBe(new Date(T0).toISOString());
    expect(data.expires_at).toBe(new Date(T0 + TTL_MS).toISOString());
    expect(data.age_ms).toBe(0);
    expect(data.created_at).toBe(new Date(T0).toISOString());
  });

  it("E. expiration metadata leaks no forbidden internals", async () => {
    recordNav("rt_ttl_e", "www.ikea.com/us/en/cat");
    const listRaw = JSON.stringify((await server.inject({ method: "GET", url: LIST_URL })).json());
    const oneRaw = JSON.stringify(
      (await server.inject({ method: "GET", url: "/api/internal/browser-run-trace/rt_ttl_e" })).json(),
    );
    const FORBIDDEN = [
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref", "password",
      "cookies", "localStorage", "sessionStorage", "innerHTML",
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "doc_x", "doc_y",
      "nearby_text", "9222", "localhost",
    ];
    for (const f of FORBIDDEN) {
      expect(listRaw).not.toContain(f);
      expect(oneRaw).not.toContain(f);
    }
  });
});

describe("browser run trace — tool-surface disposition & warnings", () => {
  const DISP_ID = "tbsess_disp_001";
  const DISP_URL = `/api/internal/browser-run-trace/${DISP_ID}/disposition`;

  async function readDispTrace(id = DISP_ID) {
    const res = await server.inject({ method: "GET", url: `/api/internal/browser-run-trace/${id}` });
    expect(res.statusCode).toBe(200);
    return res.json().data as { browser_runtime_id: string; event_count: number; events: any[]; warnings?: string[] };
  }

  it("records a sanitized browser_tool_disposition via the internal route", async () => {
    const res = await server.inject({
      method: "POST", url: DISP_URL,
      payload: {
        tool: "browser_snapshot",
        tool_surface: "adapter_child_playwright",
        disposition: "adapter_child_forwarded",
        result_code: "forwarded",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const trace = await readDispTrace();
    const disp = trace.events.find((e) => e.event_type === "browser_tool_disposition");
    expect(disp).toBeTruthy();
    expect(disp.tool).toBe("browser_snapshot");
    expect(disp.tool_surface).toBe("adapter_child_playwright");
    expect(disp.disposition).toBe("adapter_child_forwarded");
    expect(disp.result_code).toBe("forwarded");
    // Only the allowlist keys appear — no payload/body/coordinates/internals.
    const keys = Object.keys(disp).sort();
    expect(keys).toEqual([
      "browser_runtime_id", "disposition", "event_type", "result_code", "tool", "tool_surface", "ts",
    ]);
  });

  it("drops out-of-enum tool_surface / disposition values (enum-gated)", () => {
    recordBrowserTraceEvent(DISP_ID, {
      event_type: "browser_tool_disposition",
      browser_runtime_id: DISP_ID,
      tool: "browser_click",
      // @ts-expect-error — deliberately invalid enum values must be dropped.
      tool_surface: "totally_made_up_surface",
      // @ts-expect-error — deliberately invalid enum values must be dropped.
      disposition: "definitely_not_a_disposition",
    });
    const trace = getBrowserRunTrace(DISP_ID)!;
    const disp = trace.events.find((e) => e.event_type === "browser_tool_disposition")!;
    expect(disp.tool).toBe("browser_click");
    expect(disp.tool_surface).toBeUndefined();
    expect(disp.disposition).toBeUndefined();
  });

  it("disposition output leaks no forbidden internals", async () => {
    await server.inject({
      method: "POST", url: DISP_URL,
      payload: {
        tool: "browser_snapshot",
        tool_surface: "antigen_adapter",
        disposition: "blocked_by_antigen_required",
        error_code: "ANTIGEN_TOOL_REQUIRED",
      },
    });
    const raw = JSON.stringify((await readDispTrace()));
    const FORBIDDEN = [
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref", "password",
      "cookies", "localStorage", "sessionStorage", "innerHTML",
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "doc_x", "doc_y",
      "nearby_text", "9222", "localhost",
    ];
    for (const f of FORBIDDEN) expect(raw).not.toContain(f);
  });

  it("the disposition route is a no-op when ANTIGEN_BROWSER_TRACE is unset", async () => {
    vi.stubEnv("ANTIGEN_BROWSER_TRACE", "");
    const res = await server.inject({
      method: "POST", url: DISP_URL,
      payload: { tool: "browser_snapshot", tool_surface: "adapter_child_playwright", disposition: "adapter_child_forwarded" },
    });
    // Always returns ok, but records nothing while disabled.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    vi.stubEnv("ANTIGEN_BROWSER_TRACE", "true");
    const trace = await readDispTrace();
    expect(trace.event_count).toBe(0);
  });

  it("warns navigation_without_antigen_actions, then clears once an Antigen action is recorded", async () => {
    const WARN_ID = "tbsess_warn_001";
    // Two navigations, no Antigen-owned snapshot/click/type → warning.
    recordBrowserTraceEvent(WARN_ID, { event_type: "navigation_state", browser_runtime_id: WARN_ID, url_after: "reddit.com/r/x" });
    recordBrowserTraceEvent(WARN_ID, { event_type: "navigation_state", browser_runtime_id: WARN_ID, url_after: "ikea.com/cat" });

    const getRes = await server.inject({ method: "GET", url: `/api/internal/browser-run-trace/${WARN_ID}` });
    expect(getRes.json().data.warnings).toContain("navigation_without_antigen_actions");

    const listRes = await server.inject({ method: "GET", url: "/api/internal/browser-run-traces" });
    const listEntry = listRes.json().data.traces.find((t: any) => t.browser_runtime_id === WARN_ID);
    expect(listEntry.warnings).toContain("navigation_without_antigen_actions");

    // A child-forwarded disposition is NOT an Antigen action — warning persists.
    recordBrowserTraceEvent(WARN_ID, {
      event_type: "browser_tool_disposition", browser_runtime_id: WARN_ID,
      tool: "browser_snapshot", tool_surface: "adapter_child_playwright", disposition: "adapter_child_forwarded",
    });
    const stillWarn = await server.inject({ method: "GET", url: `/api/internal/browser-run-trace/${WARN_ID}` });
    expect(stillWarn.json().data.warnings).toContain("navigation_without_antigen_actions");

    // A real Antigen-owned snapshot clears it.
    recordBrowserTraceEvent(WARN_ID, {
      event_type: "antigen_snapshot", browser_runtime_id: WARN_ID, result_code: "antigen_snapshot_success",
    });
    const cleared = await server.inject({ method: "GET", url: `/api/internal/browser-run-trace/${WARN_ID}` });
    expect(cleared.json().data.warnings).toBeUndefined();
  });

  it("does not warn for a single navigation (avoids fresh-session noise)", async () => {
    const SINGLE_ID = "tbsess_single_001";
    recordBrowserTraceEvent(SINGLE_ID, { event_type: "navigation_state", browser_runtime_id: SINGLE_ID, url_after: "reddit.com/r/x" });
    const res = await server.inject({ method: "GET", url: `/api/internal/browser-run-trace/${SINGLE_ID}` });
    expect(res.json().data.warnings).toBeUndefined();
  });
});
