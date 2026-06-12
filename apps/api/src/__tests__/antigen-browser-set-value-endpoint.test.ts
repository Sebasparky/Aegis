/**
 * POST /api/agent/v1/runtime/browser-set-value — Antigen exact-ref (ag_*) tests.
 *
 * Exact-replacement counterpart of antigen-browser-type-endpoint.test.ts. These
 * prove that the EXACT-FILL endpoint:
 *  - resolves an ag_* ref to its stored box and invokes setFieldValueKnownBox,
 *  - refuses SENSITIVE fields (SENSITIVE_FIELD_REQUIRES_INJECTION) WITHOUT calling
 *    the runtime and WITHOUT echoing any value,
 *  - surfaces VALUE_MISMATCH / NOT_FILLABLE / REF_REQUIRED / stale-ref envelopes,
 *  - passes through changed=false (idempotent skip).
 *
 * The runtime (setFieldValueKnownBox) is mocked — no real browser/CDP. The
 * snapshot store is real (seeded via createAntigenSnapshotRecord).
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

const setValueMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return {
    ...actual,
    setFieldValueKnownBox: setValueMock,
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

const BEARER = "Bearer tok_setval_001";
const DELEGATION_ID = "del_setval_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_setval_001";
const URL = "/api/agent/v1/runtime/browser-set-value";

function makeSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_setval_001",
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

function inputCandidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "input",
    kind: "input",
    role: null,
    name: "First name",
    normalized_name: "first name",
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
  passes.set("pass_setval_001", {
    id: "pass_setval_001",
    token: "tok_setval_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestSetValueAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestSetValueAgent",
    channel: "api",
    status: "active",
    token_id: "pass_setval_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_setval_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  vi.clearAllMocks();
  setValueMock.mockResolvedValue({
    success: true,
    fillable: true,
    changed: true,
    verified: true,
    element_kind: "input",
    actual_value: "Sebastian",
    actual_value_present: true,
    actual_value_length: 9,
    duration_ms: 12,
  });
});

function post(payload: Record<string, unknown>, auth = true) {
  return server.inject({
    method: "POST",
    url: URL,
    headers: auth ? { authorization: BEARER } : {},
    payload,
  });
}

describe("POST /api/agent/v1/runtime/browser-set-value", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "x" }, false);
    expect(res.statusCode).toBe(401);
  });

  it("resolves the stored box and calls setFieldValueKnownBox with expected metadata", async () => {
    seedSession();
    seedSnapshot([
      inputCandidate({ name: "First name", normalized_name: "first name", box: { x: 10, y: 20, width: 200, height: 36 } }),
      inputCandidate({ name: "Last name", normalized_name: "last name", box: { x: 10, y: 80, width: 200, height: 36 } }),
    ]);

    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_2", value: "Chacon" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.changed).toBe(true);
    expect(body.data.verified).toBe(true);
    expect(body.data.requested_value).toBe("Chacon");
    expect(body.data.actual_value).toBe("Sebastian");
    expect(body.data.element_kind).toBe("input");

    expect(setValueMock).toHaveBeenCalledTimes(1);
    expect(setValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        box: { x: 10, y: 80, width: 200, height: 36 },
        value: "Chacon",
        sessionId: SESSION_ID,
        userId: MOCK_USER_ID,
        expected: expect.objectContaining({ name: "Last name", kind: "input" }),
      }),
    );
  });

  it("passes through changed=false (idempotent skip)", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    setValueMock.mockResolvedValueOnce({
      success: true, fillable: true, changed: false, verified: true,
      element_kind: "input", actual_value: "Chacon", actual_value_present: true, actual_value_length: 6, duration_ms: 3,
    });
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "Chacon" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.changed).toBe(false);
    expect(res.json().data.verified).toBe(true);
  });

  it("requires an ag_* ref (REF_REQUIRED)", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "#first", value: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("REF_REQUIRED");
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it("returns ANTIGEN_REF_NOT_FOUND when the ref is absent from the latest snapshot", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_9", value: "x" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it("returns NOT_FILLABLE for a non-fillable ref (a button)", async () => {
    seedSession();
    seedSnapshot([
      inputCandidate({ tag: "button", kind: "button", name: "Continue", normalized_name: "continue", typeable: false, clickable: true }),
    ]);
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "x" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("NOT_FILLABLE");
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it("REFUSES a sensitive field and never calls the runtime or echoes a value", async () => {
    seedSession();
    seedSnapshot([
      inputCandidate({
        name: "Password",
        normalized_name: "password",
        value_meta: { sensitive: true, sensitivity: "credential", value_present: true, value_length: 8 },
      }),
    ]);
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "hunter2" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("SENSITIVE_FIELD_REQUIRES_INJECTION");
    expect(setValueMock).not.toHaveBeenCalled();
    // No value of any kind is echoed back.
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("REFUSES a payment field and routes to the payment-card fill path", async () => {
    seedSession();
    seedSnapshot([
      inputCandidate({
        name: "Card number",
        normalized_name: "card number",
        value_meta: { sensitive: true, sensitivity: "payment", value_present: false, value_length: 0 },
      }),
    ]);
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "4242424242424242" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("SENSITIVE_FIELD_REQUIRES_PAYMENT_CARD_FILL");
    expect(body.error.message).toContain("request_payment_card_fill");
    expect(setValueMock).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("4242424242424242");
  });

  it("FILLS a non-sensitive search field (no injection handoff)", async () => {
    seedSession();
    seedSnapshot([
      inputCandidate({
        name: "Search products",
        normalized_name: "search products",
        value_meta: { sensitive: false, sensitivity: null, value_present: false, value_length: 0 },
      }),
    ]);
    setValueMock.mockResolvedValueOnce({
      success: true, fillable: true, changed: true, verified: true,
      element_kind: "input", actual_value: "desk lamp", actual_value_present: true, actual_value_length: 9, duration_ms: 8,
    });
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "desk lamp" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(setValueMock).toHaveBeenCalledWith(expect.objectContaining({ value: "desk lamp" }));
  });

  it("surfaces VALUE_MISMATCH from the runtime as a structured 422", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    setValueMock.mockResolvedValueOnce({
      success: false, error: "VALUE_MISMATCH", fillable: true, changed: true, verified: false,
      element_kind: "input", actual_value: "Seb", duration_ms: 9,
    });
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "Sebastian" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("VALUE_MISMATCH");
    expect(body.data.verified).toBe(false);
  });

  it("maps a stale-ref runtime failure to ANTIGEN_REF_STALE", async () => {
    seedSession();
    seedSnapshot([inputCandidate()]);
    setValueMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_STALE", duration_ms: 4 });
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "x" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
  });
});

describe("POST /api/agent/v1/runtime/browser-set-value — TTL-expiry recovery", () => {
  const EXPIRED = () => new Date(Date.now() - 120_000);

  afterEach(() => {
    delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
  });

  it("flag OFF: an expired ref hard-fails ANTIGEN_REF_EXPIRED with no set (strict default)", async () => {
    delete process.env.ANTIGEN_LOGICAL_REF_RECOVERY;
    seedSession();
    seedSnapshot([inputCandidate()], EXPIRED());
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "x" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_EXPIRED");
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it("flag ON: an expired non-sensitive field is re-validated, set, and reports ttl_expired_recovered", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([inputCandidate()], EXPIRED());
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "Sebastian" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ttl_recovery_state).toBe("ttl_expired_recovered");
    expect(setValueMock).toHaveBeenCalledTimes(1);
  });

  it("flag ON: an expired ref on a CHANGED page fails closed with page_changed", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([inputCandidate()], EXPIRED());
    setValueMock.mockResolvedValueOnce({ success: false, error: "ANTIGEN_REF_PAGE_CHANGED", duration_ms: 0 });
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "x" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_PAGE_CHANGED");
    expect(res.json().error.ttl_recovery_state).toBe("page_changed");
  });

  it("flag ON: an expired ref on a SENSITIVE field fails closed with sensitive_requires_fresh_ref (no set)", async () => {
    process.env.ANTIGEN_LOGICAL_REF_RECOVERY = "true";
    seedSession();
    seedSnapshot([
      inputCandidate({
        name: "Card number", normalized_name: "card number",
        value_meta: { sensitive: true, sensitivity: "payment", value_present: false, value_length: 0 },
      }),
    ], EXPIRED());
    const res = await post({ browser_runtime_id: SESSION_ID, ref: "ag_1", value: "4111111111111111" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_EXPIRED");
    expect(res.json().error.ttl_recovery_state).toBe("sensitive_requires_fresh_ref");
    expect(setValueMock).not.toHaveBeenCalled();
  });
});
