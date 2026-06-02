/**
 * POST /api/agent/v1/runtime/browser-snapshot — endpoint tests.
 *
 * Harness mirrors runtime-browser-endpoint.test.ts:
 * - persistence is a no-op mock,
 * - the task browser runtime is the REAL in-memory Map (we seed sessions),
 * - extractAntigenSnapshotCandidatesViaCDP is mocked (no real browser),
 * - the snapshot STORE is real, so we can assert internal boxes are stored.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock only the CDP extraction transport — the store stays real.
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
import {
  getAntigenSnapshotElement,
  clearAntigenSnapshotStoreForTests,
} from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";

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
    expect(body.data.snapshot_ttl_ms).toBe(10_000);
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
    });
    expect(button.ref).toBe("ag_2");
    expect(button.kind).toBe("button");
    expect(button.hints).toEqual({});
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
    expect(bodyB.data.snapshot_ttl_ms).toBe(10_000);
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
