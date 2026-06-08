/**
 * POST /api/agent/v1/runtime/browser-type — Antigen exact-ref (ag_*) tests.
 *
 * The typing counterpart of antigen-browser-click-endpoint.test.ts. These prove
 * GENERIC snapshot-ref typing support — not any single site. When antigen_snapshot
 * gives a typeable ag_* ref, browser_type must type into that exact ref via the
 * known-box runtime, exactly like browser_click uses exact clickable refs.
 *
 * Harness:
 * - persistence is a no-op mock,
 * - the task browser runtime is the REAL in-memory Map (we seed sessions),
 * - the snapshot STORE is real (we seed snapshots via createAntigenSnapshotRecord),
 * - the realistic typing runtime is mocked (no real browser/CDP), so we assert the
 *   ag_* path resolves the exact stored box and invokes realisticTypeKnownBox —
 *   never the fuzzy description path (realisticTypeTextViaCDP).
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock only the realistic typing runtime — the snapshot store stays real.
const typeKnownBoxMock = vi.hoisted(() => vi.fn());
const typeByDescriptionMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return {
    ...actual,
    realisticTypeKnownBox: typeKnownBoxMock,
    realisticTypeTextViaCDP: typeByDescriptionMock,
  };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import {
  createAntigenSnapshotRecord,
  clearAntigenSnapshotStoreForTests,
} from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";

const BEARER = "Bearer tok_type_001";
const DELEGATION_ID = "del_type_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_type_001";
const URL = "/api/agent/v1/runtime/browser-type";

function makeSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_type_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: "https://example.test/checkout",
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

/** A typeable text input candidate — the generic shape of a fillable field. */
function inputCandidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "input",
    kind: "input",
    role: null,
    name: "Email address",
    normalized_name: "email address",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: true,
    clickable: false,
    box: { x: 100, y: 200, width: 220, height: 36 },
    ...overrides,
  };
}

/** Seed an active snapshot for SESSION_ID/MOCK_USER_ID with the given candidates. */
function seedSnapshot(candidates: AntigenSnapshotCandidate[], now?: Date) {
  return createAntigenSnapshotRecord({
    browser_session_id: SESSION_ID,
    browser_runtime_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    url: "https://example.test/checkout",
    title: null,
    candidates,
    now,
  });
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_type_001", {
    id: "pass_type_001",
    token: "tok_type_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestTypeAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestTypeAgent",
    channel: "api",
    status: "active",
    token_id: "pass_type_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_type_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  typeKnownBoxMock.mockResolvedValue({
    success: true,
    char_count_bucket: "5-8",
    duration_ms: 120,
    focused: true,
    submitted: false,
    pointer_path_point_count: 7,
    pointer_start_source: "session",
    pointer_state_persisted: true,
  });
});

describe("POST /api/agent/v1/runtime/browser-type — Antigen ag_* path", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await server.inject({ method: "POST", url: URL, payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", text: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("uses the known-box path for a typeable ag_* ref (not fuzzy description)", async () => {
    seedSession();
    seedSnapshot([
      inputCandidate({ name: "First name", normalized_name: "first name", box: { x: 10, y: 20, width: 200, height: 36 } }),
      inputCandidate({ name: "Email address", normalized_name: "email address", box: { x: 10, y: 80, width: 200, height: 36 } }),
    ]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_2", element: "Email address", text: "abc@x.io" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.char_count_bucket).toBe("5-8");
    expect(body.data.focused).toBe(true);

    // The known-box path was used (NOT fuzzy description matching).
    expect(typeByDescriptionMock).not.toHaveBeenCalled();
    expect(typeKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(typeKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      box: { x: 10, y: 80, width: 200, height: 36 },
      text: "abc@x.io",
      sessionId: SESSION_ID,
      userId: MOCK_USER_ID,
    }));
  });

  it("types the exact ref even when its label is duplicated (avoids fuzzy ambiguity)", async () => {
    seedSession();
    // Two fields share the identical accessible label — fuzzy matching would be
    // AMBIGUOUS, but the exact ref selects one deterministically.
    seedSnapshot([
      inputCandidate({ name: "Phone", normalized_name: "phone", box: { x: 10, y: 20, width: 200, height: 36 } }),
      inputCandidate({ name: "Phone", normalized_name: "phone", box: { x: 10, y: 90, width: 200, height: 36 } }),
    ]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_2", element: "Phone", text: "5551234" },
    });

    expect(res.statusCode).toBe(200);
    expect(typeByDescriptionMock).not.toHaveBeenCalled();
    expect(typeKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      box: { x: 10, y: 90, width: 200, height: 36 },
    }));
  });

  it("passes snapshot metadata as `expected` for Phase 4B revalidation", async () => {
    seedSession();
    seedSnapshot([
      inputCandidate({
        tag: "input", kind: "input", role: "textbox", name: "Street address",
        normalized_name: "street address", box: { x: 100, y: 200, width: 240, height: 36 },
      }),
    ]);

    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Street address", text: "1 Main St" },
    });

    expect(res.statusCode).toBe(200);
    expect(typeKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      expected: {
        tag: "input", kind: "input", role: "textbox", name: "Street address",
        normalized_name: "street address", href_path: null,
      },
    }));
  });

  it("forwards the submit flag to the known-box runtime", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x", submit: true },
    });
    expect(typeKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({ submit: true }));
  });

  it("returns 422 ANTIGEN_REF_NOT_TYPEABLE for a non-typeable ref", async () => {
    seedSession();
    seedSnapshot([inputCandidate({ tag: "button", kind: "button", typeable: false, clickable: true, name: "Continue", normalized_name: "continue" })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Continue", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_TYPEABLE");
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_TYPEABLE for a disabled field", async () => {
    seedSession();
    seedSnapshot([inputCandidate({ enabled: false })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_TYPEABLE");
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_TYPEABLE for a zero-area box", async () => {
    seedSession();
    seedSnapshot([inputCandidate({ box: { x: 5, y: 5, width: 0, height: 36 } })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_TYPEABLE");
  });

  it("maps a runtime ANTIGEN_REF_STALE result to a 422 ANTIGEN_REF_STALE error", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    typeKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", char_count_bucket: "1-4", duration_ms: 0 });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
    expect(res.json().error.message).toContain("antigen_snapshot");
  });

  it("maps a runtime ANTIGEN_REF_OUT_OF_VIEWPORT result to a 422 error with scroll guidance", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    typeKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_OUT_OF_VIEWPORT", char_count_bucket: "1-4", duration_ms: 0 });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_OUT_OF_VIEWPORT");
    expect(body.error.message).toContain("viewport");
    expect(body.error.message.toLowerCase()).toContain("scroll");
  });

  it("returns 422 ANTIGEN_REF_NOT_FOUND for a missing ref in the active snapshot", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_99", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_NOT_FOUND when no snapshot exists for the session", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("returns 422 ANTIGEN_REF_EXPIRED when the snapshot is past its TTL", async () => {
    seedSession();
    // Past the 90s wall-clock TTL.
    seedSnapshot([inputCandidate()], new Date(Date.now() - 120_000));
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_EXPIRED");
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("still resolves a ref ~15s into the snapshot (within the 90s TTL)", async () => {
    seedSession();
    // 15s old: previously past the 10s TTL, now comfortably within the 90s budget
    // so ordinary agent reasoning between snapshot and action does not expire refs.
    seedSnapshot([inputCandidate()], new Date(Date.now() - 15_000));
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(typeKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("passes the snapshot URL as expectedUrl for the live-URL guard", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(typeKnownBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedUrl: "https://example.test/checkout",
    }));
  });

  it("maps a runtime ANTIGEN_REF_PAGE_CHANGED result to a 422 with re-snapshot guidance", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    typeKnownBoxMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_PAGE_CHANGED", char_count_bucket: "1-4", duration_ms: 0 });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_REF_PAGE_CHANGED");
    expect(body.error.message.toLowerCase()).toContain("antigen_snapshot");
  });

  it("returns 422 ANTIGEN_REF_INVALID for a malformed ag_ ref", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_abc", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_INVALID");
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("does not resolve a ref seeded under a different session", async () => {
    seedSession();
    createAntigenSnapshotRecord({
      browser_session_id: "tbsess_other",
      browser_runtime_id: "tbsess_other",
      user_id: MOCK_USER_ID,
      url: null, title: null,
      candidates: [inputCandidate()],
    });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
  });

  it("never leaks box/coordinates/internals in the response", async () => {
    seedSession();
    seedSnapshot([inputCandidate({ box: { x: 100, y: 200, width: 220, height: 36 } })]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "secret@x.io" },
    });
    const raw = JSON.stringify(res.json());
    const FORBIDDEN = [
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"",
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref",
      "storageState", "9222", "localhost", "secret@x.io",
    ];
    for (const f of FORBIDDEN) {
      expect(raw).not.toContain(f);
    }
  });

  it("returns 404 SESSION_NOT_FOUND for an unknown runtime id on the ag_* path", async () => {
    seedSnapshot([inputCandidate()]);
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: "unknown_id", ref: "ag_1", element: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("fails closed with RUNTIME_SESSION_CHANGED when the runtime was relaunched (stale id + ready replacement)", async () => {
    seedSnapshot([inputCandidate()]);
    seedSession({ status: "closed" });
    seedSession({ browser_session_id: "tbsess_type_relaunched", status: "ready" });
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address", text: "x" },
    });
    // The stale ag_* ref must not be carried across runtimes.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("RUNTIME_SESSION_CHANGED");
  });
});

describe("POST /api/agent/v1/runtime/browser-type — non-ag fuzzy fallback unchanged", () => {
  beforeEach(() => {
    typeByDescriptionMock.mockResolvedValue({
      success: true,
      char_count_bucket: "1-4",
      duration_ms: 60,
      focused: true,
      submitted: false,
    });
  });

  it("uses the fuzzy description path when no ref is supplied", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, element_description: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(typeByDescriptionMock).toHaveBeenCalledTimes(1);
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("ignores a Playwright-style ref (e221) and falls through to the fuzzy path", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "e221", element_description: "Email address", text: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(typeByDescriptionMock).toHaveBeenCalledTimes(1);
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });

  it("still requires text", async () => {
    seedSession();
    const res = await server.inject({
      method: "POST", url: URL,
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Email address" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_FIELD");
    expect(typeKnownBoxMock).not.toHaveBeenCalled();
  });
});
