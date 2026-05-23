import { vi } from "vitest";

const { mockCreateReceipt, mockFindByRunId } = vi.hoisted(() => ({
  mockCreateReceipt: vi.fn().mockResolvedValue(undefined),
  mockFindByRunId: vi.fn().mockResolvedValue(null),
}));

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

vi.mock("../lib/userApprovalReceiptSigning.js", () => ({
  buildSignedUserApprovalReceipt: vi.fn(),
  verifyStoredUserApprovalReceipt: vi.fn(),
  hashUserApprovalReceipt: vi.fn(),
  signUserApprovalReceiptJws: vi.fn(),
  verifyUserApprovalReceiptJws: vi.fn(),
}));

vi.mock("../lib/actionAuthorizationSigning.js", () => ({
  hashActionAuthorization: vi.fn().mockReturnValue("mock_auth_hash"),
  signActionAuthorizationJws: vi.fn().mockResolvedValue("mock.authz.jws"),
}));

vi.mock("../repositories/receiptRepository.js", () => ({
  getReceiptRepository: vi.fn().mockReturnValue({
    createReceipt: mockCreateReceipt,
    findByRunId: mockFindByRunId,
  }),
}));

vi.mock("../runtime/playwrightRuntime.js", () => ({
  executeRouteRunWithPlaywright: vi.fn().mockResolvedValue(undefined),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { routeRuns } from "../store/index.js";
import { buildTestServer, injectRun, seedTestData, resetStore, IDS } from "./helpers.js";

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  server = await buildTestServer();
});

beforeEach(() => {
  routeRuns.clear();
  mockCreateReceipt.mockClear();
  mockFindByRunId.mockClear().mockResolvedValue(null);
});

afterAll(async () => {
  await server.close();
  resetStore();
});

// ─── start_skill_run ─────────────────────────────────────────────────────────

describe("POST /api/route-runs/:runId/start", () => {
  it("transitions pending → running and sets started_at", async () => {
    injectRun("run_start_001", "pending");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_start_001/start",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("running");
    expect(body.data.started_at).toBeTruthy();
  });

  it("rejects start from running status with 409 INVALID_STATE", async () => {
    injectRun("run_start_002", "running");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_start_002/start",
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("rejects start from completed status with 409", async () => {
    injectRun("run_start_003", "completed");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_start_003/start",
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for unknown run", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_nonexistent/start",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── complete_skill_run ───────────────────────────────────────────────────────

describe("POST /api/route-runs/:runId/complete", () => {
  it("transitions running → completed and creates receipt", async () => {
    injectRun("run_complete_001", "running");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_001/complete",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("completed");
    expect(body.data.completed_at).toBeTruthy();
    expect(mockCreateReceipt).toHaveBeenCalledOnce();
  });

  it("stores task_browser_session_id on run when provided", async () => {
    injectRun("run_complete_002", "running");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_002/complete",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ browser_session_id: "bsid_test_abc" }),
    });
    expect(res.statusCode).toBe(200);
    const run = routeRuns.get("run_complete_002");
    expect(run?.task_browser_session_id).toBe("bsid_test_abc");
  });

  it("includes task_browser_session_id in receipt when provided", async () => {
    injectRun("run_complete_003", "running");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_003/complete",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ browser_session_id: "bsid_receipt_check" }),
    });
    expect(mockCreateReceipt).toHaveBeenCalledOnce();
    const receipt = mockCreateReceipt.mock.calls[0][0];
    expect(receipt.task_browser_session_id).toBe("bsid_receipt_check");
  });

  it("does not include unsafe browser internals in receipt", async () => {
    injectRun("run_complete_004", "running");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_004/complete",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ browser_session_id: "bsid_safe_check" }),
    });
    const receipt = mockCreateReceipt.mock.calls[0][0];
    expect(receipt).not.toHaveProperty("cdp_url");
    expect(receipt).not.toHaveProperty("user_data_dir");
    expect(receipt).not.toHaveProperty("cookies");
    expect(receipt).not.toHaveProperty("storage");
    expect(receipt).not.toHaveProperty("pid");
  });

  it("sanitizes agent summary before including in receipt", async () => {
    injectRun("run_complete_005", "running");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_005/complete",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "Logged in with password=secret123" }),
    });
    const receipt = mockCreateReceipt.mock.calls[0][0];
    expect(receipt.agent_summary).toBeDefined();
    expect(receipt.agent_summary).not.toContain("secret123");
    expect(receipt.agent_summary).toContain("[redacted]");
  });

  it("rejects complete from pending status with 409 INVALID_STATE", async () => {
    injectRun("run_complete_006", "pending");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_006/complete",
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("rejects complete from already-terminal status with 409 ALREADY_TERMINAL", async () => {
    injectRun("run_complete_007", "completed");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_007/complete",
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("ALREADY_TERMINAL");
  });

  it("does not create a second receipt if one already exists", async () => {
    injectRun("run_complete_008", "running");
    mockFindByRunId.mockResolvedValueOnce({ receipt_id: "existing_receipt" });
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_008/complete",
    });
    expect(res.statusCode).toBe(200);
    expect(mockCreateReceipt).not.toHaveBeenCalled();
  });

  it("works for aegis_controlled run in running state (existing behavior preserved)", async () => {
    injectRun("run_complete_009", "running", {
      claimed_execution_surface: "aegis_playwright",
      domain: "en.wikipedia.org",
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_complete_009/complete",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("completed");
  });
});

// ─── fail_skill_run ───────────────────────────────────────────────────────────

describe("POST /api/route-runs/:runId/fail", () => {
  it("transitions running → failed and creates receipt", async () => {
    injectRun("run_fail_001", "running");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_001/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Page not found" }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("failed");
    expect(body.data.completed_at).toBeTruthy();
    expect(mockCreateReceipt).toHaveBeenCalledOnce();
  });

  it("stores task_browser_session_id on run when provided", async () => {
    injectRun("run_fail_002", "running");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_002/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "network error", browser_session_id: "bsid_fail_test" }),
    });
    const run = routeRuns.get("run_fail_002");
    expect(run?.task_browser_session_id).toBe("bsid_fail_test");
  });

  it("sanitizes error message before storing", async () => {
    injectRun("run_fail_003", "running");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_003/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "verification code=123456 was invalid" }),
    });
    const run = routeRuns.get("run_fail_003");
    // The credential pattern (code=X) fires after the digit pattern, so raw number is gone
    expect(run?.error).not.toContain("123456");
    expect(run?.error).toContain("[redacted]");
  });

  it("includes sanitized error in receipt", async () => {
    injectRun("run_fail_004", "running");
    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_004/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "token=abc999 expired" }),
    });
    const receipt = mockCreateReceipt.mock.calls[0][0];
    expect(receipt.status).toBe("failed");
    expect(receipt.error).not.toContain("abc999");
    expect(receipt.error).toContain("[redacted]");
  });

  it("rejects fail from completed status with 409 ALREADY_TERMINAL", async () => {
    injectRun("run_fail_005", "completed");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_005/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "too late" }),
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("ALREADY_TERMINAL");
  });

  it("rejects fail from pending status with 409 INVALID_STATE", async () => {
    injectRun("run_fail_006", "pending");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_006/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "not running" }),
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("does not create a second receipt if one already exists", async () => {
    injectRun("run_fail_007", "running");
    mockFindByRunId.mockResolvedValueOnce({ receipt_id: "existing_fail_receipt" });
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_007/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "something" }),
    });
    expect(res.statusCode).toBe(200);
    expect(mockCreateReceipt).not.toHaveBeenCalled();
  });

  it("succeeds without error body field (optional)", async () => {
    injectRun("run_fail_008", "running");
    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_fail_008/fail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("failed");
  });
});
