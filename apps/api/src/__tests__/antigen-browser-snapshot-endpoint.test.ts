/**
 * POST /api/agent/v1/runtime/browser-snapshot — endpoint tests.
 *
 * Harness mirrors runtime-browser-endpoint.test.ts:
 * - persistence is a no-op mock,
 * - the task browser runtime is the REAL in-memory Map (we seed sessions),
 * - extractAntigenSnapshotCandidatesViaCDP is mocked (no real browser),
 * - the snapshot STORE is real, so we can assert internal boxes are stored.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock the CDP extraction transports — the store stays real. The endpoint calls
// the single-connection bundle; the mock delegates to the two per-phase mocks
// with the REAL bundle's error contract (candidate failures throw, page-meta
// failures resolve to undefined) so tests keep driving each phase independently.
const extractMock = vi.hoisted(() => vi.fn());
const pageMetaMock = vi.hoisted(() => vi.fn());
const bundleMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  bundleMock.mockImplementation(async (params: Record<string, unknown>) => {
    const candidates = await extractMock(params);
    let pageMeta: unknown;
    try {
      pageMeta = await pageMetaMock(params);
    } catch {
      pageMeta = undefined;
    }
    return { candidates, ...(pageMeta !== undefined ? { pageMeta } : {}) };
  });
  return {
    ...actual,
    extractAntigenSnapshotCandidatesViaCDP: extractMock,
    extractAntigenPageMetaViaCDP: pageMetaMock,
    extractAntigenSnapshotBundleViaCDP: bundleMock,
  };
});

// Mock the live CDP page-URL read AND the one-shot snapshot target resolver so
// tests can drive the live URL / unified target deterministically without a real
// browser. The rest of cdpTargetSelection (pickBestPageTarget) stays real.
const liveUrlMock = vi.hoisted(() => vi.fn());
const resolveTargetMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, readLiveCdpPageUrl: liveUrlMock, resolveSnapshotCdpTarget: resolveTargetMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import {
  getAntigenSnapshotElement,
  resolveAntigenRefForSession,
  clearAntigenSnapshotStoreForTests,
  isAntigenPageChanged,
} from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";
import {
  createVisualGestureCapsule,
  markGestureCapsuleCleared,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";

const BEARER = "Bearer tok_snap_001";
const DELEGATION_ID = "del_snap_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_snap_001";
const URL = "/api/agent/v1/runtime/browser-snapshot";

function makeSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_snap_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: "https://www.ikea.com/us/en/search/?q=desk%20lamp",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides,
  };
}

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session = makeSession(overrides);
  taskBrowserSessions.set(session.browser_session_id, session);
  return session;
}

function candidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "a",
    kind: "link",
    role: "link",
    name: "TERTIAL, Work lamp, light blue",
    normalized_name: "tertial work lamp light blue",
    id: null,
    href: "https://www.ikea.com/us/en/p/tertial-work-lamp-light-blue-70504295/",
    href_path: "/us/en/p/tertial-work-lamp-light-blue-70504295/",
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 12, y: 34, width: 220, height: 48 },
    ...overrides,
  };
}

const DEFAULT_CANDIDATES: AntigenSnapshotCandidate[] = [
  candidate(),
  candidate({
    tag: "button",
    kind: "button",
    role: "button",
    name: "Add to bag",
    normalized_name: "add to bag",
    href: null,
    href_path: null,
    box: { x: 50, y: 90, width: 120, height: 40 },
  }),
  // Password field fixture: its value/box must never reach the agent response.
  candidate({
    tag: "input",
    kind: "input",
    role: "textbox",
    name: "Password",
    normalized_name: "password",
    href: null,
    href_path: null,
    typeable: true,
    clickable: false,
    box: { x: 0, y: 0, width: 200, height: 30 },
  }),
];

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_snap_001", {
    id: "pass_snap_001",
    token: "tok_snap_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestSnapAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestSnapAgent",
    channel: "api",
    status: "active",
    token_id: "pass_snap_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_snap_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  extractMock.mockResolvedValue(DEFAULT_CANDIDATES);
  // Page meta is best-effort; default to none so the array-mock path is exercised.
  pageMetaMock.mockResolvedValue(undefined);
  // Live-URL read defaults to unavailable (null) so the endpoint falls back to the
  // seeded session.current_url — preserving the behavior the other tests assert.
  liveUrlMock.mockResolvedValue(null);
  // Target resolution defaults to unavailable (null) so existing tests exercise the
  // legacy fallback path (extraction self-fetch + readLiveCdpPageUrl). The dedupe
  // tests below override this with a concrete target.
  resolveTargetMock.mockResolvedValue(null);
});

describe("POST /api/agent/v1/runtime/browser-snapshot", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await server.inject({ method: "POST", url: URL, payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" } });
    expect(res.statusCode).toBe(401);
  });

  it("returns ok, snapshot_id, element_count, and ag_* refs for a valid request", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.snapshot_id).toMatch(/^snap_/);
    expect(body.data.element_count).toBe(3);
    expect(body.data.url).toBe("https://www.ikea.com/us/en/search/?q=desk%20lamp");
    expect(body.data.title).toBeNull();
    expect(body.data.snapshot_ttl_ms).toBe(90_000);
    // Remaining lifetime is surfaced for proactive re-snapshot planning and is
    // bounded by the TTL.
    expect(typeof body.data.ref_expires_in_ms).toBe("number");
    expect(body.data.ref_expires_in_ms).toBeGreaterThan(0);
    expect(body.data.ref_expires_in_ms).toBeLessThanOrEqual(90_000);
    expect(body.data.elements.map((e: { ref: string }) => e.ref)).toEqual(["ag_1", "ag_2", "ag_3"]);
  });

  it("returns safe semantic metadata per element (ref, kind, role, name, state, href_path hint)", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const [link, button] = res.json().data.elements;
    expect(link).toEqual({
      ref: "ag_1",
      kind: "link",
      role: "link",
      name: "TERTIAL, Work lamp, light blue",
      state: { visible: true, enabled: true, clickable: true, typeable: false },
      hints: { href_path: "/us/en/p/tertial-work-lamp-light-blue-70504295/" },
      // Snapshot v2: qualitative per-element status (no raw geometry). With no
      // page meta and a viewport-only snapshot, a returned element reads visible.
      viewport_status: "visible",
      scroll_required: false,
      stability_hint: "may_stale_after_navigation",
    });
    expect(button.ref).toBe("ag_2");
    expect(button.kind).toBe("button");
    expect(button.hints).toEqual({});
    expect(button.viewport_status).toBe("visible");
    expect(button.scroll_required).toBe(false);
    expect(button.stability_hint).toBe("fresh");
  });

  it("never includes boxes/coordinates or other forbidden internals in the response", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const raw = JSON.stringify(res.json());
    const FORBIDDEN = [
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "center",
      "doc_x", "doc_y", "nearby_text", "viewport_w", "viewport_h", "scroll_x", "scroll_y",
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref",
      "storageState", "9222",
    ];
    for (const f of FORBIDDEN) {
      expect(raw).not.toContain(f);
    }
  });

  it("stores internal bounding boxes server-side after the call", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const snapshotId = res.json().data.snapshot_id;
    const stored = getAntigenSnapshotElement(snapshotId, "ag_1", MOCK_USER_ID);
    expect(stored?.box).toEqual({ x: 12, y: 34, width: 220, height: 48 });
  });

  it("includes label/section context per element but never nearby_text or forbidden internals", async () => {
    seedSession();
    extractMock.mockResolvedValueOnce([
      candidate({
        tag: "button",
        kind: "button",
        role: "button",
        name: "Add to bag",
        normalized_name: "add to bag",
        href: null,
        href_path: null,
        context: {
          label: "SOLHETTA LED bulb E26 450 lumen",
          section: "Complete with",
          nearby_text: "Complete with SOLHETTA LED bulb E26 450 lumen INTERNAL_ONLY_99",
        },
      }),
    ]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const [el] = res.json().data.elements;
    expect(el.context).toEqual({
      label: "SOLHETTA LED bulb E26 450 lumen",
      section: "Complete with",
    });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("nearby_text");
    expect(raw).not.toContain("INTERNAL_ONLY_99");
    for (const f of ["\"box\"", "\"x\":", "cdp_url", "secret_ref", "9222"]) {
      expect(raw).not.toContain(f);
    }
  });

  it("returns 400 MISSING_FIELD when browser_runtime_id is absent", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_FIELD");
  });

  it("returns 400 INVALID_FIELD when action is not dom_snapshot", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "screenshot" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_FIELD");
  });

  it("returns 404 SESSION_NOT_FOUND for an unknown runtime id", async () => {
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: "unknown_id", action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns 502 SNAPSHOT_EXTRACTION_FAILED without leaking internals when extraction throws", async () => {
    seedSession();
    extractMock.mockRejectedValueOnce(
      Object.assign(new Error("CDP fetch failed at http://localhost:9222"), { code: "CDP_FETCH_FAILED" }),
    );
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.code).toBe("SNAPSHOT_EXTRACTION_FAILED");
    expect(JSON.stringify(body)).not.toContain("9222");
    expect(JSON.stringify(body)).not.toContain("localhost");
  });

  it("clamps max_candidates to [1,500] and passes it to extraction", async () => {
    seedSession();
    await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot", max_candidates: 9999 },
    });
    expect(extractMock).toHaveBeenCalledWith(expect.objectContaining({ maxCandidates: 500 }));
  });

  it("passes viewport_only through to extraction", async () => {
    seedSession();
    await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot", viewport_only: false },
    });
    expect(extractMock).toHaveBeenCalledWith(expect.objectContaining({ viewportOnly: false }));
    // Default is true when omitted.
    await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(extractMock).toHaveBeenLastCalledWith(expect.objectContaining({ viewportOnly: true }));
  });

  it("returns a valid empty snapshot for an empty candidate list", async () => {
    seedSession();
    extractMock.mockResolvedValueOnce([]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.element_count).toBe(0);
    expect(body.data.elements).toEqual([]);
    expect(body.data.snapshot_id).toMatch(/^snap_/);
  });

  it("never exposes password/hidden/payment-looking field values in the response", async () => {
    seedSession();
    extractMock.mockResolvedValueOnce([
      candidate({
        tag: "input", kind: "input", role: "textbox", name: "Card number",
        normalized_name: "card number", href: null, href_path: null, typeable: true, clickable: false,
        box: { x: 0, y: 0, width: 200, height: 30 },
      }),
    ]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const raw = JSON.stringify(res.json());
    // The candidate name "Card number" is a legitimate accessible name; a VALUE
    // would never be present. Assert no value-like leakage and no box.
    expect(raw).not.toContain("4111");
    expect(raw).not.toContain("\"value\"");
    expect(raw).not.toContain("\"box\"");
  });

  it("keeps only the latest snapshot when called twice for the same session", async () => {
    seedSession();
    const first = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const second = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });

    const idA = first.json().data.snapshot_id;
    const bodyB = second.json();
    const idB = bodyB.data.snapshot_id;
    expect(idA).not.toBe(idB);

    // Store invariant: the first snapshot was retired; only the latest survives.
    expect(getAntigenSnapshotElement(idA, "ag_1", MOCK_USER_ID)).toBeUndefined();
    expect(getAntigenSnapshotElement(idB, "ag_1", MOCK_USER_ID)).toBeDefined();

    // External response shape is unchanged on the second call.
    expect(bodyB.ok).toBe(true);
    expect(idB).toMatch(/^snap_/);
    expect(bodyB.data.snapshot_ttl_ms).toBe(90_000);
    expect(bodyB.data.elements.map((e: { ref: string }) => e.ref)).toEqual(["ag_1", "ag_2", "ag_3"]);
  });

  it("returns 403 FORBIDDEN when the session belongs to another delegation", async () => {
    seedSession({ delegation_id: "del_other" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("returns 400 SESSION_NOT_READY when the session is not ready", async () => {
    seedSession({ status: "starting" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SESSION_NOT_READY");
  });
});

// ─── Stale-runtime rebind (Bug 2) ─────────────────────────────────────────────
// After a runtime is closed and relaunched, a caller's cached browser_runtime_id
// points at a terminal session. antigen_snapshot must transparently rebind to the
// delegation's current ready runtime (it produces a fresh ref set bound to that
// session) rather than failing with a stale SESSION_NOT_READY.
describe("POST /api/agent/v1/runtime/browser-snapshot — stale runtime rebind", () => {
  const NEW_SESSION_ID = "tbsess_snap_new";

  it("rebinds a terminal runtime id to the delegation's current ready runtime and succeeds", async () => {
    // Stale cached id → now-closed session; a fresh visible runtime is live.
    seedSession({ browser_session_id: SESSION_ID, status: "closed" });
    seedSession({ browser_session_id: NEW_SESSION_ID, status: "ready", mode: "visible", current_url: "https://example.com/" });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.rebound).toBe(true);
    expect(body.data.browser_runtime_id).toBe(NEW_SESSION_ID);
    expect(body.data.effective_mode).toBe("visible");
    expect(body.data.snapshot_ready).toBe(true);

    // Refs must be bound to the RESOLVED session — resolvable under the new id,
    // not under the stale one.
    expect(resolveAntigenRefForSession(NEW_SESSION_ID, MOCK_USER_ID, "ag_1").status).toBe("ok");
    expect(resolveAntigenRefForSession(SESSION_ID, MOCK_USER_ID, "ag_1").status).toBe("no_snapshot");
  });

  it("returns 404 SESSION_NOT_FOUND for a terminal runtime id with no ready replacement (recoverable)", async () => {
    seedSession({ browser_session_id: SESSION_ID, status: "closed" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("does not rebind a 'starting' session — stays a true transient SESSION_NOT_READY", async () => {
    seedSession({ browser_session_id: SESSION_ID, status: "starting" });
    seedSession({ browser_session_id: NEW_SESSION_ID, status: "ready" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SESSION_NOT_READY");
  });

  it("a non-rebound ready snapshot reports rebound=false and its own runtime id", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const body = res.json();
    expect(body.data.rebound).toBe(false);
    expect(body.data.browser_runtime_id).toBe(SESSION_ID);
    expect(body.data.snapshot_ready).toBe(true);
  });

  it("never leaks cdp_url, user_data_dir, or cdp_port in a rebound response", async () => {
    seedSession({ browser_session_id: SESSION_ID, status: "closed" });
    seedSession({ browser_session_id: NEW_SESSION_ID, status: "ready", mode: "visible" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const raw = JSON.stringify(res.json());
    for (const f of ["cdp_url", "user_data_dir", "cdp_port", "password", "secret_ref"]) {
      expect(raw).not.toContain(f);
    }
  });
});

// ─── Antigen Snapshot v2 — agent-readable page map ───────────────────────────

describe("POST /api/agent/v1/runtime/browser-snapshot — v2 page map", () => {
  async function snapshot() {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }

  it("includes page_summary and evidence metadata", async () => {
    const data = await snapshot();
    expect(typeof data.page_summary).toBe("object");
    expect(typeof data.page_summary.page_kind).toBe("string");
    expect(data.page_summary.url_host).toBe("www.ikea.com");
    expect(data.page_summary.url_path).toBe("/us/en/search/");

    expect(data.evidence.snapshot_id).toBe(data.snapshot_id);
    expect(typeof data.evidence.captured_at).toBe("string");
    expect(data.evidence.viewport_only).toBe(true);
    expect(data.evidence.element_count).toBe(3);
    expect(data.evidence.clickable_count).toBe(2);
    expect(data.evidence.typeable_count).toBe(1);
    // No page-meta source in this path → no visible_text_hash.
    expect(data.evidence.visible_text_hash).toBeUndefined();
  });

  it("prioritizes the Add to bag button and routes the input into forms", async () => {
    const data = await snapshot();
    const primaryRefs = data.primary_actions.map((a: { ref: string }) => a.ref);
    expect(primaryRefs).toContain("ag_2");
    const addAction = data.primary_actions.find((a: { ref: string }) => a.ref === "ag_2");
    expect(addAction.action_hint).toBe("browser_click");
    expect(addAction.reason).toBe("primary_purchase_action");
    // The content link is NOT ranked among primary actions.
    expect(primaryRefs).not.toContain("ag_1");

    // The password input becomes a form field with a browser_type hint.
    expect(data.forms.length).toBeGreaterThanOrEqual(1);
    const form = data.forms.find((f: { input_refs: string[] }) => f.input_refs.includes("ag_3"));
    expect(form).toBeDefined();
    expect(form.action_hint).toBe("browser_type");
  });

  it("emits an action hint for every ref (input→browser_type, clickable→browser_click)", async () => {
    const data = await snapshot();
    const byRef = new Map(data.action_hints.map((h: { ref: string }) => [h.ref, h]));
    expect((byRef.get("ag_2") as { action_hint: string }).action_hint).toBe("browser_click");
    expect((byRef.get("ag_3") as { action_hint: string }).action_hint).toBe("browser_type");
  });

  it("classifies a below-viewport clickable element with a scroll-then-click hint", async () => {
    seedSession();
    extractMock.mockResolvedValueOnce([
      candidate({
        tag: "button", kind: "button", role: "button", name: "Checkout",
        normalized_name: "checkout", href: null, href_path: null,
        box: { x: 10, y: 2400, width: 120, height: 40 }, // far below an 800px viewport
      }),
    ]);
    pageMetaMock.mockResolvedValueOnce({
      viewport_w: 1280, viewport_h: 800, scroll_x: 0, scroll_y: 0, doc_h: 4000,
      heading: "Cart", text_excerpt: "Your cart subtotal checkout",
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot", viewport_only: false },
    });
    const data = res.json().data;
    const el = data.elements.find((e: { ref: string }) => e.ref === "ag_1");
    expect(el.viewport_status).toBe("below_viewport");
    expect(el.scroll_required).toBe(true);
    const hint = data.action_hints.find((h: { ref: string }) => h.ref === "ag_1");
    expect(hint.action_hint).toBe("browser_scroll_to_ref_then_click");
    // page_kind from the cart language + checkout button.
    expect(data.page_summary.page_kind).toBe("cart");
    // visible_text_hash present when a text source exists.
    expect(typeof data.evidence.visible_text_hash).toBe("string");
  });

  it("detects a cookie banner and surfaces its dismiss ref", async () => {
    seedSession();
    extractMock.mockResolvedValueOnce([
      candidate({
        tag: "button", kind: "button", role: "button", name: "Accept all",
        normalized_name: "accept all", href: null, href_path: null,
        context: { section: "Cookie consent banner", label: "We use cookies" },
        box: { x: 10, y: 10, width: 120, height: 40 },
      }),
    ]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const data = res.json().data;
    expect(data.warnings_or_modals.length).toBeGreaterThanOrEqual(1);
    const cookie = data.warnings_or_modals.find((w: { kind: string }) => w.kind === "cookie_banner");
    expect(cookie).toBeDefined();
    expect(cookie.dismiss_refs).toContain("ag_1");
    expect(cookie.action_hint).toBe("browser_click");
    // The dismiss hint reason is surfaced in action_hints.
    const hint = data.action_hints.find((h: { ref: string }) => h.ref === "ag_1");
    expect(hint.reason).toBe("dismiss_overlay");
  });

  it("groups product cards best-effort with clipped strings (no nearby_text)", async () => {
    seedSession();
    extractMock.mockResolvedValueOnce([
      candidate({
        tag: "a", kind: "link", role: "link", name: "BILLY Bookcase",
        normalized_name: "billy bookcase", href: "https://www.ikea.com/p/billy", href_path: "/p/billy",
        context: { label: "BILLY Bookcase white $59.99", nearby_text: "BILLY Bookcase white $59.99 SECRET_NEARBY_123" },
        box: { x: 10, y: 10, width: 200, height: 40 },
      }),
      candidate({
        tag: "button", kind: "button", role: "button", name: "Add to bag",
        normalized_name: "add to bag", href: null, href_path: null,
        context: { label: "BILLY Bookcase white $59.99", nearby_text: "BILLY Bookcase white $59.99 SECRET_NEARBY_123" },
        box: { x: 10, y: 60, width: 120, height: 40 },
      }),
    ]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const data = res.json().data;
    expect(data.product_cards.length).toBeGreaterThanOrEqual(1);
    const card = data.product_cards[0];
    expect(card.add_ref).toBe("ag_2");
    expect(card.title).toContain("BILLY");
    expect(card.price_text).toBe("$59.99");
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("nearby_text");
    expect(raw).not.toContain("SECRET_NEARBY_123");
  });

  it("never leaks raw geometry or page-meta numbers across the full v2 response", async () => {
    seedSession();
    pageMetaMock.mockResolvedValueOnce({
      viewport_w: 1280, viewport_h: 800, scroll_x: 0, scroll_y: 120, doc_h: 4000,
      heading: "Desk lamps", text_excerpt: "Showing 24 results for desk lamp",
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const raw = JSON.stringify(res.json());
    for (const f of [
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"",
      "doc_x", "doc_y", "nearby_text", "viewport_w", "viewport_h", "scroll_x", "scroll_y",
      "cdp_url", "user_data_dir", "secret_ref", "9222",
    ]) {
      expect(raw).not.toContain(f);
    }
  });
});

/**
 * Regression: snapshot URL capture must come from the LIVE CDP page target, not
 * the cached session.current_url. Before this fix the endpoint stored
 * session.current_url, which lags a navigation (Enter-submit/SPA/redirect); the
 * very next ref action then compared a stale snapshot_url against the live URL
 * and failed with a FALSE ANTIGEN_REF_PAGE_CHANGED before recovery could run.
 *
 * These tests drive readLiveCdpPageUrl deterministically and assert against the
 * REAL snapshot store + the REAL isAntigenPageChanged guard (the same guard the
 * click/type/scroll paths use), so they prove the end-to-end behavior, not a
 * reimplementation of it.
 */
describe("POST /api/agent/v1/runtime/browser-snapshot — live snapshot URL capture", () => {
  const URL_A = "https://www.ikea.com/us/en/"; // stale cached homepage
  const URL_B = "https://www.ikea.com/us/en/search/?q=coffee%20mug"; // live search page

  async function snapshot() {
    return server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
  }

  // (1) Snapshot stores the live CDP URL, not the stale session.current_url, and
  // brings session.current_url into lockstep with it.
  it("stores the live CDP URL (not stale session.current_url) and updates the session", async () => {
    seedSession({ current_url: URL_A });
    liveUrlMock.mockResolvedValueOnce(URL_B);

    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Response + stored record carry the LIVE URL.
    expect(body.data.url).toBe(URL_B);
    const resolved = resolveAntigenRefForSession(SESSION_ID, MOCK_USER_ID, "ag_1");
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") expect(resolved.snapshot_url).toBe(URL_B);

    // Cached session metadata is updated to the live URL (no longer stale).
    expect(taskBrowserSessions.get(SESSION_ID)?.current_url).toBe(URL_B);
  });

  // (2) A fresh snapshot taken on URL B (after navigating from A) must NOT make a
  // subsequent URL-B action report PAGE_CHANGED.
  it("fresh snapshot on URL B does not make a URL B action report PAGE_CHANGED", async () => {
    seedSession({ current_url: URL_A }); // cached value is still A (the bug trigger)
    liveUrlMock.mockResolvedValueOnce(URL_B);

    await snapshot();
    const resolved = resolveAntigenRefForSession(SESSION_ID, MOCK_USER_ID, "ag_1");
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") {
      // Same guard the click/type/scroll paths use; live URL is still B.
      expect(isAntigenPageChanged(resolved.snapshot_url, URL_B)).toBe(false);
    }
  });

  // (3) A ref captured on URL A, used after a real navigation to URL B, MUST still
  // report PAGE_CHANGED — the fix must not weaken true page-change detection.
  it("a ref snapshotted on URL A still reports PAGE_CHANGED when live URL is B", async () => {
    seedSession({ current_url: URL_A });
    liveUrlMock.mockResolvedValueOnce(URL_A); // snapshot genuinely taken on A

    await snapshot();
    const resolved = resolveAntigenRefForSession(SESSION_ID, MOCK_USER_ID, "ag_1");
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") {
      expect(resolved.snapshot_url).toBe(URL_A);
      expect(isAntigenPageChanged(resolved.snapshot_url, URL_B)).toBe(true);
    }
  });

  // (4) Equivalent query encodings ("+" vs "%20", trailing slash) on the same page
  // must still compare equal — decoded-query normalization is preserved.
  it("equivalent query encoding on the same page is not a PAGE_CHANGED", async () => {
    const liveAtSnapshot = "https://site.test/search?q=blahaj+soft+toy";
    const liveAtAction = "https://site.test/search/?q=blahaj%20soft%20toy";
    seedSession({ current_url: URL_A });
    liveUrlMock.mockResolvedValueOnce(liveAtSnapshot);

    await snapshot();
    const resolved = resolveAntigenRefForSession(SESSION_ID, MOCK_USER_ID, "ag_1");
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") {
      expect(isAntigenPageChanged(resolved.snapshot_url, liveAtAction)).toBe(false);
    }
  });
});

// 3a — snapshot CDP target dedupe: DOM extraction, page metadata, and the stored
// snapshot URL must all bind to the SAME single resolved target, and the separate
// readLiveCdpPageUrl fetch is not used when resolution succeeds.
describe("POST /api/agent/v1/runtime/browser-snapshot — unified CDP target (3a)", () => {
  const TARGET_URL = "https://www.ikea.com/us/en/cat/home-textiles-tl001/";
  const TARGET = { browserWsUrl: "ws://localhost:9222/devtools/browser/xyz", target: { id: "tgt_live", url: TARGET_URL, type: "page" } };

  async function snapshot() {
    return server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
  }

  it("threads the single resolved target into DOM extraction AND page metadata, and stores its URL", async () => {
    seedSession({ current_url: "https://www.ikea.com/us/en/" }); // stale cached URL
    resolveTargetMock.mockResolvedValueOnce(TARGET);

    const res = await snapshot();
    expect(res.statusCode).toBe(200);

    // The stored + returned URL is the resolved target's URL — not the stale cache.
    expect(res.json().data.url).toBe(TARGET_URL);
    const resolved = resolveAntigenRefForSession(SESSION_ID, MOCK_USER_ID, "ag_1");
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") expect(resolved.snapshot_url).toBe(TARGET_URL);

    // Both extraction calls received the SAME pre-resolved target (id + url).
    const expectedResolved = { browserWsUrl: TARGET.browserWsUrl, pageTarget: { id: TARGET.target.id, url: TARGET_URL } };
    expect(extractMock).toHaveBeenCalledWith(expect.objectContaining({ resolvedTarget: expectedResolved }));
    expect(pageMetaMock).toHaveBeenCalledWith(expect.objectContaining({ resolvedTarget: expectedResolved }));
  });

  it("does NOT make the separate readLiveCdpPageUrl fetch when target resolution succeeds", async () => {
    seedSession();
    resolveTargetMock.mockResolvedValueOnce(TARGET);

    await snapshot();

    // The dedupe guarantee: the URL came from the already-resolved target, so the
    // extra /json/list round-trip (readLiveCdpPageUrl) is never issued.
    expect(liveUrlMock).not.toHaveBeenCalled();
  });

  it("falls back to readLiveCdpPageUrl + cached URL when target resolution is unavailable", async () => {
    seedSession({ current_url: "https://fallback.test/cached/" });
    resolveTargetMock.mockResolvedValueOnce(null); // resolution failed → legacy path
    liveUrlMock.mockResolvedValueOnce(null); // live read also unavailable

    const res = await snapshot();
    expect(res.statusCode).toBe(200);

    // Legacy fallback preserved: extraction self-fetches (resolvedTarget undefined),
    // readLiveCdpPageUrl is attempted, then cached session.current_url is used.
    expect(extractMock).toHaveBeenCalledWith(expect.objectContaining({ resolvedTarget: undefined }));
    expect(liveUrlMock).toHaveBeenCalledTimes(1);
    expect(res.json().data.url).toBe("https://fallback.test/cached/");
  });
});

// ─── HV debug telemetry (ANTIGEN_HV_DEBUG, dev-only) ─────────────────────────
// Strictly diagnostic. human_verification_debug must be ABSENT unless BOTH
// ANTIGEN_HUMAN_VERIFICATION and ANTIGEN_HV_DEBUG are "true", and must contain
// only booleans/enums/buckets when present (never raw text/URLs/selectors/refs).
describe("POST /api/agent/v1/runtime/browser-snapshot — human_verification_debug", () => {
  // The full set of keys the debug object is ever allowed to carry. Any key
  // outside this set is a leak risk and fails the test.
  const ALLOWED_KEYS = new Set([
    "hv_enabled",
    "elements_count",
    "hv_member_found",
    "hv_wall_hint",
    "page_wall_probe_considered",
    "page_wall_probe_attempted",
    "page_wall_probe_reason",
    "page_wall_probe_result",
    "page_wall_probe_error_code",
    "top_doc_title_flags",
    "top_doc_text_flags",
    "iframe_flags",
    "blocker_flags",
    "overlay_intercept_flags",
    "oopif_flags",
    "would_classify_oopif",
    // Ambiguous visual-obstruction fallback diagnostics (no-structural-wall branch).
    // Booleans / enums / counts only — see HumanVerificationDebug. The capsule id is
    // never emitted here; ambiguous_skip_reason: "fired" denotes a successful create.
    "ambiguous_fallback_considered",
    "ambiguous_skip_reason",
    "ambiguous_element_count",
    "ambiguous_hv_wall_hint",
    "ambiguous_denial_text_seen",
    "ambiguous_near_zero_interactive",
    "ambiguous_visible_inaccessible_iframe_seen",
    "ambiguous_large_centered_overlay_seen",
    "ambiguous_viewport_scrim_seen",
    "ambiguous_pointer_interceptor_seen",
    "ambiguous_top_layer_dialog_seen",
    "ambiguous_repeated_stale",
    "ambiguous_created_capsule",
    // Snapshot-level screen-HV visible-wall diagnostics. Booleans / enum only.
    "screen_hv_considered",
    "screen_hv_detected",
    "screen_hv_challenge_type",
    "screen_hv_viewport_scrim_seen",
    "screen_hv_centered_modal_seen",
    "screen_hv_press_hold_affordance_seen",
    "screen_hv_phrase_seen",
    "screen_hv_top_layer_dialog_seen",
    "screen_hv_created_capsule",
    "screen_hv_failure_reason",
  ]);

  function withEnv(
    vars: { hv?: string; debug?: string },
    fn: () => Promise<void>,
  ): Promise<void> {
    const prevHv = process.env.ANTIGEN_HUMAN_VERIFICATION;
    const prevDebug = process.env.ANTIGEN_HV_DEBUG;
    const set = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    set("ANTIGEN_HUMAN_VERIFICATION", vars.hv);
    set("ANTIGEN_HV_DEBUG", vars.debug);
    return fn().finally(() => {
      set("ANTIGEN_HUMAN_VERIFICATION", prevHv);
      set("ANTIGEN_HV_DEBUG", prevDebug);
    });
  }

  async function snapshotData() {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }

  it("is ABSENT when both flags are off", async () => {
    await withEnv({ hv: undefined, debug: undefined }, async () => {
      const data = await snapshotData();
      expect(data.human_verification_debug).toBeUndefined();
    });
  });

  it("is ABSENT when ANTIGEN_HV_DEBUG is off even with ANTIGEN_HUMAN_VERIFICATION on", async () => {
    await withEnv({ hv: "true", debug: undefined }, async () => {
      const data = await snapshotData();
      expect(data.human_verification_debug).toBeUndefined();
    });
  });

  it("is ABSENT when only ANTIGEN_HV_DEBUG is on (HV gate off)", async () => {
    await withEnv({ hv: undefined, debug: "true" }, async () => {
      const data = await snapshotData();
      expect(data.human_verification_debug).toBeUndefined();
    });
  });

  it("is PRESENT (safe booleans/enums only) when BOTH flags are on", async () => {
    await withEnv({ hv: "true", debug: "true" }, async () => {
      const data = await snapshotData();
      const dbg = data.human_verification_debug;
      expect(dbg).toBeDefined();
      // Only whitelisted keys — no raw text/URL/selector/ref keys can appear.
      for (const k of Object.keys(dbg)) expect(ALLOWED_KEYS.has(k)).toBe(true);
      // Orchestration fields reflect the real path: 3 candidates (<=3) with no
      // per-member HV → the low-element page-wall probe is attempted; production
      // returns null (no resolved target in this harness) and the debug probe
      // surfaces a typed connect error (no real CDP). No raw signals leak.
      expect(dbg.hv_enabled).toBe(true);
      expect(dbg.elements_count).toBe(3);
      expect(dbg.hv_member_found).toBe(false);
      expect(dbg.hv_wall_hint).toBe(false);
      expect(dbg.page_wall_probe_considered).toBe(true);
      expect(dbg.page_wall_probe_attempted).toBe(true);
      expect(dbg.page_wall_probe_reason).toBe("low_element_count");
      expect(dbg.page_wall_probe_result).toBe("null");
      expect(dbg.page_wall_probe_error_code).toBe("cdp_connect_failed");
      // No live screenHv in this harness (bundle mock omits it) → the attribution
      // reports the eval-absent gate, NOT a false "no_scrim".
      expect(dbg.screen_hv_failure_reason).toBe("not_plumbed");
    });
  });
});

// ─── Active Visual Gesture Capsule guard ─────────────────────────────────────
// Once a VGC is pending for the session, browser-snapshot must fail closed with
// HUMAN_VERIFICATION_REQUIRED + safe capsule metadata BEFORE returning a normal
// (possibly zero-element / access-denied) snapshot — and resume normally once the
// capsule goes terminal.
describe("POST /api/agent/v1/runtime/browser-snapshot — active VGC guard", () => {
  const prevFlag = process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    clearVisualGestureCapsulesForTests();
  });

  afterEach(() => {
    clearVisualGestureCapsulesForTests();
    if (prevFlag === undefined) delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    else process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = prevFlag;
  });

  it("returns 409 HUMAN_VERIFICATION_REQUIRED + safe capsule view when a VGC is pending", async () => {
    seedSession();
    createVisualGestureCapsule({
      human_verification_request_id: "hvreq_snap_vgc_001",
      browser_session_id: SESSION_ID,
      domain: "www.bathandbodyworks.com",
      page_url: "https://www.bathandbodyworks.com/checkout",
    });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.purchase_authorized).toBe(false);
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    const capsule = body.error.visual_gesture_capsule.capsule;
    expect(capsule.capsule_id).toMatch(/^vgc_/);
    expect(capsule.status).toBe("awaiting_user_gesture");
    expect(capsule.user_presence_required).toBe(true);
    expect(capsule.raw_gesture_revealed_to_agent).toBe(false);
    expect(capsule.screenshot_revealed_to_agent).toBe(false);
    // NOT a normal snapshot.
    expect(body.data).toBeUndefined();
  });

  it("never leaks bytes/coords/cdp/session internals in the VGC stop response", async () => {
    seedSession();
    createVisualGestureCapsule({
      human_verification_request_id: "hvreq_snap_vgc_002",
      browser_session_id: SESSION_ID,
      domain: "www.bathandbodyworks.com",
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const raw = JSON.stringify(res.json());
    for (const f of [
      "png_base64", "\"box\"", "\"x\":", "\"y\":", "cdp_url", "user_data_dir",
      "browser_session_id", "9222", "target_id", "secret_ref",
    ]) {
      expect(raw).not.toContain(f);
    }
  });

  it("resumes the normal snapshot once the capsule is terminal (cleared)", async () => {
    seedSession();
    const capsule = createVisualGestureCapsule({
      human_verification_request_id: "hvreq_snap_vgc_003",
      browser_session_id: SESSION_ID,
      domain: "www.bathandbodyworks.com",
    });
    markGestureCapsuleCleared(capsule.capsule_id);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.element_count).toBe(3);
  });

  it("does NOT guard a capsule belonging to a different session", async () => {
    seedSession();
    createVisualGestureCapsule({
      human_verification_request_id: "hvreq_snap_vgc_004",
      browser_session_id: "tbsess_other_999",
      domain: "www.bathandbodyworks.com",
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.element_count).toBe(3);
  });
});

// ─── Snapshot-level screen-HV visible-wall mint ──────────────────────────────
// A visible same-origin / top-level "Press & Hold" wall can sit over a HIGH
// element-count background page. The bundle surfaces `screenHv.wall === true`
// (iframe-, element-count-, and stale-independent). The snapshot must fail closed
// with 409 HUMAN_VERIFICATION_REQUIRED + a freshly minted VGC — while a normal
// high-element product/search page (screenHv.wall === false) still returns 200.
describe("POST /api/agent/v1/runtime/browser-snapshot — screen-HV visible wall", () => {
  const prevVgc = process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  const prevHv = process.env.ANTIGEN_HUMAN_VERIFICATION;

  // 25 overlay-free candidates → a HIGH element count, so neither the low-element
  // structural probe nor the ambiguous fallback can open; only the screen-HV path
  // can produce a 409. This proves the detector does not rely on a low count.
  const HIGH_ELEMENT_CANDIDATES: AntigenSnapshotCandidate[] = Array.from({ length: 25 }, (_, i) =>
    candidate({ name: `Product ${i}`, normalized_name: `product ${i}`, href: `/p/${i}`, href_path: `/p/${i}` }),
  );

  const SCREEN_HV: import("../runtime/antigenSnapshotRuntime.js").ScreenHvWallSignals = {
    wall: true,
    challenge_type: "press_and_hold",
    viewport_scrim_seen: true,
    centered_modal_seen: true,
    press_hold_affordance_seen: true,
    hv_phrase_seen: true,
    top_layer_dialog_seen: false,
  };

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
    clearVisualGestureCapsulesForTests();
  });

  afterEach(() => {
    clearVisualGestureCapsulesForTests();
    if (prevVgc === undefined) delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    else process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = prevVgc;
    if (prevHv === undefined) delete process.env.ANTIGEN_HUMAN_VERIFICATION;
    else process.env.ANTIGEN_HUMAN_VERIFICATION = prevHv;
  });

  it("returns 409 + a minted VGC for a visible wall over a HIGH-element page (no stale / no low count)", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: SCREEN_HV });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.capsule_id).toMatch(/^vgc_/);
    expect(body.error.visual_gesture_capsule.capsule.status).toBe("awaiting_user_gesture");
    // NOT a normal snapshot.
    expect(body.data).toBeUndefined();
  });

  it("never leaks bytes/coords/cdp/session internals in the screen-HV stop response", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: SCREEN_HV });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    const raw = JSON.stringify(res.json());
    for (const f of [
      "png_base64", "\"box\"", "\"x\":", "\"y\":", "cdp_url", "user_data_dir",
      "9222", "target_id", "secret_ref",
    ]) {
      expect(raw).not.toContain(f);
    }
  });

  it("returns 200 for a normal HIGH-element page with no screen-HV wall", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({
      candidates: HIGH_ELEMENT_CANDIDATES,
      screenHv: { ...SCREEN_HV, wall: false, challenge_type: undefined, viewport_scrim_seen: false, hv_phrase_seen: false },
    });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().data.element_count).toBe(25);
  });

  it("does NOT mint when the VGC flag is off (screen-HV wall present but capsule disabled)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "false";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: SCREEN_HV });

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.element_count).toBe(25);
  });
});

// ─── Always-on snapshot_hv_gate console telemetry ────────────────────────────
// The rich human_verification_debug object only rides the 200 RESPONSE BODY; on a
// NON-minting snapshot (the live B&BW preserved-background miss) nothing reached
// the LOG stream, so the failing screen-HV sub-gate was invisible from logs. This
// suite proves the dedicated `[HvDebug] scope=snapshot_hv_gate` line emits on EVERY
// snapshot HV consideration (mint or not) with the correct screen_hv_failure_reason
// attribution — and stays silent when ANTIGEN_HV_DEBUG is off.
describe("POST /api/agent/v1/runtime/browser-snapshot — snapshot_hv_gate telemetry", () => {
  const prevVgc = process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  const prevHv = process.env.ANTIGEN_HUMAN_VERIFICATION;
  const prevDebug = process.env.ANTIGEN_HV_DEBUG;

  const HIGH_ELEMENT_CANDIDATES: AntigenSnapshotCandidate[] = Array.from({ length: 25 }, (_, i) =>
    candidate({ name: `Product ${i}`, normalized_name: `product ${i}`, href: `/p/${i}`, href_path: `/p/${i}` }),
  );

  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    clearVisualGestureCapsulesForTests();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    clearVisualGestureCapsulesForTests();
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("ANTIGEN_VISUAL_GESTURE_CAPSULE", prevVgc);
    restore("ANTIGEN_HUMAN_VERIFICATION", prevHv);
    restore("ANTIGEN_HV_DEBUG", prevDebug);
  });

  // Parse the single `scope=snapshot_hv_gate` [HvDebug] line into a key→value map.
  function gateLine(): Record<string, string> | undefined {
    for (const call of logSpy.mock.calls) {
      const line = call.map(String).join(" ");
      if (!line.includes("[HvDebug]") || !line.includes("scope=snapshot_hv_gate")) continue;
      const out: Record<string, string> = {};
      for (const tok of line.replace("[HvDebug]", "").trim().split(/\s+/)) {
        const eq = tok.indexOf("=");
        if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
      }
      return out;
    }
    return undefined;
  }

  async function snapshot() {
    return server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
    });
  }

  it("emits screen_hv_failure_reason=no_scrim on a 200 miss (the B&BW preserved-background shape)", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({
      candidates: HIGH_ELEMENT_CANDIDATES,
      screenHv: {
        wall: false,
        viewport_scrim_seen: false,
        centered_modal_seen: false,
        press_hold_affordance_seen: false,
        hv_phrase_seen: false,
        top_layer_dialog_seen: false,
      },
    });
    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    const g = gateLine();
    expect(g).toBeDefined();
    expect(g!.screen_hv_detected).toBe("false");
    expect(g!.screen_viewport_scrim_seen).toBe("false");
    expect(g!.created_capsule).toBe("false");
    expect(g!.returned_409).toBe("false");
    expect(g!.screen_hv_failure_reason).toBe("no_scrim");
  });

  it("emits screen_hv_failure_reason=no_hv_phrase when a scrim+card are present but no HV phrase", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({
      candidates: HIGH_ELEMENT_CANDIDATES,
      screenHv: {
        wall: false,
        viewport_scrim_seen: true,
        centered_modal_seen: true,
        press_hold_affordance_seen: false,
        hv_phrase_seen: false,
        top_layer_dialog_seen: false,
      },
    });
    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    expect(gateLine()!.screen_hv_failure_reason).toBe("no_hv_phrase");
  });

  it("emits screen_hv_failure_reason=none + created_capsule=true on a minted wall (409)", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({
      candidates: HIGH_ELEMENT_CANDIDATES,
      screenHv: {
        wall: true,
        challenge_type: "press_and_hold",
        viewport_scrim_seen: true,
        centered_modal_seen: true,
        press_hold_affordance_seen: true,
        hv_phrase_seen: true,
        top_layer_dialog_seen: false,
      },
    });
    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    const g = gateLine();
    expect(g).toBeDefined();
    expect(g!.screen_hv_detected).toBe("true");
    expect(g!.created_capsule).toBe("true");
    expect(g!.returned_409).toBe("true");
    expect(g!.screen_hv_failure_reason).toBe("none");
  });

  it("emits NO snapshot_hv_gate line when ANTIGEN_HV_DEBUG is off", async () => {
    process.env.ANTIGEN_HV_DEBUG = "false";
    seedSession();
    bundleMock.mockResolvedValueOnce({
      candidates: HIGH_ELEMENT_CANDIDATES,
      screenHv: { wall: false, viewport_scrim_seen: false, centered_modal_seen: false, press_hold_affordance_seen: false, hv_phrase_seen: false, top_layer_dialog_seen: false },
    });
    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    expect(gateLine()).toBeUndefined();
  });
});
