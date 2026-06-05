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
