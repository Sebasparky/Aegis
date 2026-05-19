import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock signing so tests don't require real keys.
vi.mock("../lib/userApprovalReceiptSigning.js", () => ({
  buildSignedUserApprovalReceipt: vi.fn(),
  verifyStoredUserApprovalReceipt: vi.fn(),
  hashUserApprovalReceipt: vi.fn(),
  signUserApprovalReceiptJws: vi.fn(),
  verifyUserApprovalReceiptJws: vi.fn(),
}));

// Mock action authorization signing — configurable per-test via mockImplementation.
vi.mock("../lib/actionAuthorizationSigning.js", () => ({
  hashActionAuthorization: vi.fn().mockReturnValue("mock_auth_hash"),
  signActionAuthorizationJws: vi.fn().mockResolvedValue("mock.authz.jws"),
}));

// Mock receipt repository to avoid real DB calls.
vi.mock("../repositories/receiptRepository.js", () => ({
  getReceiptRepository: vi.fn().mockReturnValue({
    createReceipt: vi.fn().mockResolvedValue(undefined),
    findByRunId: vi.fn().mockResolvedValue(null),
  }),
}));

// Mock Playwright runtime to prevent real browser launches.
vi.mock("../runtime/playwrightRuntime.js", () => ({
  executeRouteRunWithPlaywright: vi.fn().mockResolvedValue(undefined),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { routeRuns, actionAuthorizations } from "../store/index.js";
import { routeRunRoutes } from "../routes/route-runs.js";
import { injectRun, seedTestData, IDS } from "./helpers.js";
import { signActionAuthorizationJws } from "../lib/actionAuthorizationSigning.js";

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  server = Fastify({ logger: false });
  await server.register(routeRunRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  routeRuns.clear();
  actionAuthorizations.clear();
  vi.clearAllMocks();
  // Default: signing succeeds
  (signActionAuthorizationJws as ReturnType<typeof vi.fn>).mockResolvedValue("mock.authz.jws");
});

describe("route-run approve — ActionAuthorizationReceipt signing blocking", () => {
  it("returns 200 and transitions run to pending when signing succeeds", async () => {
    injectRun("run_sign_ok_001", "pending_approval", {
      delegation_id: IDS.DELEGATION_ALL,
      collar_id: IDS.COLLAR,
      domain: "test.aegis.local",
      approval_required_permissions: ["purchase"],
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_sign_ok_001/approve",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(routeRuns.get("run_sign_ok_001")?.status).toBe("pending");
    expect(actionAuthorizations.size).toBe(1);
  });

  it("returns 500 and leaves run in pending_approval when signing throws", async () => {
    (signActionAuthorizationJws as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("SIGNING_NOT_CONFIGURED"),
    );

    injectRun("run_sign_fail_001", "pending_approval", {
      delegation_id: IDS.DELEGATION_ALL,
      collar_id: IDS.COLLAR,
      domain: "test.aegis.local",
      approval_required_permissions: ["purchase"],
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/route-runs/run_sign_fail_001/approve",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("APPROVAL_RECEIPT_SIGNING_FAILED");

    // Run must not have been transitioned to pending
    expect(routeRuns.get("run_sign_fail_001")?.status).toBe("pending_approval");
    // No authorization receipt stored
    expect(actionAuthorizations.size).toBe(0);
  });

  it("does not start Playwright when signing fails", async () => {
    (signActionAuthorizationJws as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("SIGNING_NOT_CONFIGURED"),
    );

    const { executeRouteRunWithPlaywright } = await import("../runtime/playwrightRuntime.js");

    injectRun("run_no_playwright_001", "pending_approval", {
      delegation_id: IDS.DELEGATION_ALL,
      collar_id: IDS.COLLAR,
      domain: "test.aegis.local",
      approval_required_permissions: ["purchase"],
    });

    await server.inject({
      method: "POST",
      url: "/api/route-runs/run_no_playwright_001/approve",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(executeRouteRunWithPlaywright).not.toHaveBeenCalled();
  });
});
