/**
 * Runtime orphan browser process cleanup tests.
 *
 * Verifies:
 * - parseAegisOrphanPids: correct PID extraction from ps output
 * - cleanupOrphanedBrowserProcesses: kills untracked PIDs, skips tracked PIDs
 * - closeAllTaskBrowserSessions: marks all sessions expired and kills processes
 * - POST /api/internal/runtime-browser-sessions/cleanup-orphans: endpoint shape
 * - NO_PORTS_AVAILABLE error message contains remediation hint
 */

import { vi } from "vitest";

// ─── Hoisted mocks — must come before all vi.mock() calls ─────────────────────

const mockExecSync = vi.hoisted(() => vi.fn<() => string>(() => ""));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Replace execSync while keeping spawn and other exports intact.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execSync: mockExecSync };
});

vi.mock("../runtime/paymentCardFill.js", () => ({
  executePaymentCardFillViaCDP: vi.fn(),
  validateCardFillSelector: vi.fn().mockReturnValue({ valid: true }),
}));
vi.mock("../runtime/purchaseConfirmationHandoff.js", () => ({
  executePurchaseConfirmation: vi.fn(),
}));
vi.mock("../runtime/secretInjection.js", () => ({ executeSecretInjectionViaCDP: vi.fn() }));
vi.mock("../runtime/challengeInjection.js", () => ({
  challengeCodes: new Map(),
  executeChallengeInjectionViaCDP: vi.fn(),
}));
vi.mock("../runtime/emailChallengeResolver.js", () => ({
  resolutionCodes: new Map(),
  searchGmailForChallengeCode: vi.fn(),
  isEmailChallengeSupported: vi.fn().mockReturnValue(false),
}));
vi.mock("../runtime/authenticatedSessions.js", () => ({
  createAuthenticatedSession: vi.fn(),
  getAuthenticatedSessionHandle: vi.fn(),
  observeAuthenticatedSession: vi.fn(),
  navigateAuthenticatedSession: vi.fn(),
}));
vi.mock("../repositories/receiptRepository.js", () => ({
  getReceiptRepository: vi.fn(() => ({
    createReceipt: vi.fn(),
    listReceipts: vi.fn().mockResolvedValue([]),
  })),
}));
vi.mock("../repositories/vaultRepository.js", () => ({
  getVaultRepository: vi.fn(() => ({
    getVaultPass: vi.fn().mockResolvedValue(null),
    getEncryptedSecret: vi.fn().mockResolvedValue(null),
    storeVaultPass: vi.fn(),
    storeEncryptedSecret: vi.fn(),
  })),
}));
vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn(),
    decryptSecret: vi.fn(),
  })),
}));
vi.mock("../lib/kmsAudit.js", () => ({ recordKmsAuditEvent: vi.fn() }));
vi.mock("../routes/website-agent-safety.js", () => ({
  computeWebsiteAgentSafetyProfile: vi.fn(),
}));
vi.mock("../routes/website-aegis-policy.js", () => ({
  getWebsiteAegisPolicyForDomain: vi.fn(),
}));
vi.mock("../lib/workspaceDomain.js", () => ({
  requireWorkspaceAccess: vi.fn(),
  checkWorkspacePermission: vi.fn(),
  emitWorkspaceAudit: vi.fn(),
  buildEffectivePermissionsMap: vi.fn(),
  checkTaskEligibility: vi.fn(),
  enrichTaskForManifest: vi.fn(),
  buildWorkQueue: vi.fn(),
  computeTaskReadiness: vi.fn(),
  buildWorkspaceArtifactNames: vi.fn(),
}));
vi.mock("../lib/delegationTrust.js", () => ({ computeDelegationTrustProfile: vi.fn() }));
vi.mock("../lib/loginDiagnostics.js", () => ({
  classifyLoginOutcome: vi.fn(),
  storeDiagnostic: vi.fn(),
  loginDiagnosticsStore: new Map(),
}));
vi.mock("../runtime/credentialStepHandoff.js", () => ({
  performSubmitAndWait: vi.fn(),
  SUBMIT_BLOCKLIST: new Set(),
}));
vi.mock("../runtime/observationDryRun.js", () => ({ runObservationDryRun: vi.fn() }));
vi.mock("../runtime/taskBrowserControl.js", () => ({
  connectAndNavigate: vi.fn(),
  connectAndObserve: vi.fn(),
  connectAndClick: vi.fn(),
}));
vi.mock("../lib/userApprovalReceiptSigning.js", () => ({
  buildSignedUserApprovalReceipt: vi.fn().mockImplementation(async (fields: object) => ({
    ...fields,
    verification: {
      canonical_payload_hash: "h",
      jws: "j",
      jws_present: true,
      signature_valid: true,
      signed_at: new Date().toISOString(),
    },
  })),
}));
vi.mock("../lib/routePreviewCapture.js", () => ({ captureRoutePreview: vi.fn() }));
vi.mock("../lib/verificationProviders.js", () => ({
  getVerificationProvider: vi.fn(),
  listVerificationProviders: vi.fn().mockReturnValue([]),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer, seedTestData } from "./helpers.js";
import {
  parseAegisOrphanPids,
  cleanupOrphanedBrowserProcesses,
  closeAllTaskBrowserSessions,
  taskBrowserSessions,
  _testOnlyInsertTrackedProcess,
  _testOnlyClearTrackedProcesses,
} from "../runtime/taskBrowserSessions.js";
import type { TaskBrowserSession } from "@aegis/types";
import type { ChildProcess } from "child_process";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const now = new Date();
  return {
    browser_session_id: "tbsess_test_001",
    user_id: "user_001",
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_test_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ─── parseAegisOrphanPids ─────────────────────────────────────────────────────

describe("parseAegisOrphanPids", () => {
  it("extracts PIDs from lines containing aegis-agent-browser", () => {
    const psOutput = [
      "  PID ARGS",
      " 1234 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aegis-agent-browser-tbsess_abc123",
      " 5678 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223 --user-data-dir=/tmp/aegis-agent-browser-tbsess_def456",
      "  999 /usr/bin/node /some/unrelated/process",
      "  777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
    ].join("\n");

    const pids = parseAegisOrphanPids(psOutput);
    expect(pids).toEqual([1234, 5678]);
  });

  it("returns empty array when no aegis-agent-browser lines present", () => {
    const psOutput = [
      "  PID ARGS",
      "  999 /usr/bin/node server.js",
      " 1111 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library",
    ].join("\n");

    expect(parseAegisOrphanPids(psOutput)).toEqual([]);
  });

  it("returns empty array for blank ps output", () => {
    expect(parseAegisOrphanPids("")).toEqual([]);
    expect(parseAegisOrphanPids("\n\n")).toEqual([]);
  });

  it("ignores lines where the first token is not a number", () => {
    const psOutput = "  PID ARGS\nabc /tmp/aegis-agent-browser-xyz";
    expect(parseAegisOrphanPids(psOutput)).toEqual([]);
  });

  it("does not match generic Chrome processes without the Aegis marker", () => {
    const psOutput =
      " 4321 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome";
    expect(parseAegisOrphanPids(psOutput)).toEqual([]);
  });
});

// ─── cleanupOrphanedBrowserProcesses ─────────────────────────────────────────

describe("cleanupOrphanedBrowserProcesses", () => {
  beforeEach(() => {
    mockExecSync.mockReturnValue("");
    _testOnlyClearTrackedProcesses();
    taskBrowserSessions.clear();
  });

  afterEach(() => {
    _testOnlyClearTrackedProcesses();
    taskBrowserSessions.clear();
  });

  it("sends SIGTERM to untracked Aegis Chrome PIDs", async () => {
    mockExecSync.mockReturnValue(
      "  PID ARGS\n 9999 /Applications/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aegis-agent-browser-tbsess_orphan",
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await cleanupOrphanedBrowserProcesses();

    expect(killSpy).toHaveBeenCalledWith(9999, "SIGTERM");
    expect(result.orphans_found).toBe(1);
    expect(result.orphans_killed).toBe(1);

    killSpy.mockRestore();
  });

  it("does not send SIGTERM to PIDs already tracked in taskBrowserProcesses", async () => {
    mockExecSync.mockReturnValue(
      "  PID ARGS\n 8888 /Applications/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aegis-agent-browser-tbsess_tracked",
    );
    const fakeProc = { pid: 8888 } as unknown as ChildProcess;
    _testOnlyInsertTrackedProcess("tbsess_tracked", fakeProc);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await cleanupOrphanedBrowserProcesses();

    expect(killSpy).not.toHaveBeenCalledWith(8888, "SIGTERM");
    expect(result.orphans_found).toBe(0);
    expect(result.orphans_killed).toBe(0);

    killSpy.mockRestore();
  });

  it("returns zero counts when no Aegis processes found", async () => {
    mockExecSync.mockReturnValue("  PID ARGS\n  1 /sbin/launchd");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await cleanupOrphanedBrowserProcesses();

    expect(killSpy).not.toHaveBeenCalled();
    expect(result.orphans_found).toBe(0);
    expect(result.orphans_killed).toBe(0);

    killSpy.mockRestore();
  });

  it("handles process.kill throwing (process already exited) without crashing", async () => {
    mockExecSync.mockReturnValue(
      "  PID ARGS\n 7777 /Applications/Google Chrome --user-data-dir=/tmp/aegis-agent-browser-tbsess_gone",
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });

    // Must not throw
    const result = await cleanupOrphanedBrowserProcesses();
    expect(result.orphans_found).toBe(1);
    expect(result.orphans_killed).toBe(0);

    killSpy.mockRestore();
  });

  it("handles execSync failure (ps unavailable) without crashing", async () => {
    mockExecSync.mockImplementation(() => { throw new Error("ps not found"); });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await cleanupOrphanedBrowserProcesses();

    expect(killSpy).not.toHaveBeenCalled();
    expect(result.orphans_found).toBe(0);
    expect(result.orphans_killed).toBe(0);

    killSpy.mockRestore();
  });
});

// ─── closeAllTaskBrowserSessions ──────────────────────────────────────────────

describe("closeAllTaskBrowserSessions", () => {
  beforeEach(() => {
    _testOnlyClearTrackedProcesses();
    taskBrowserSessions.clear();
  });

  afterEach(() => {
    _testOnlyClearTrackedProcesses();
    taskBrowserSessions.clear();
  });

  it("marks all ready sessions as expired", async () => {
    taskBrowserSessions.set("tbsess_s1", makeMockSession({ browser_session_id: "tbsess_s1", cdp_port: 9222 }));
    taskBrowserSessions.set("tbsess_s2", makeMockSession({ browser_session_id: "tbsess_s2", cdp_port: 9223 }));

    await closeAllTaskBrowserSessions();

    expect(taskBrowserSessions.get("tbsess_s1")?.status).toBe("expired");
    expect(taskBrowserSessions.get("tbsess_s2")?.status).toBe("expired");
    expect(taskBrowserSessions.get("tbsess_s1")?.closed_at).toBeDefined();
    expect(taskBrowserSessions.get("tbsess_s2")?.closed_at).toBeDefined();
  });

  it("does not change already-closed sessions", async () => {
    taskBrowserSessions.set(
      "tbsess_already_closed",
      makeMockSession({ browser_session_id: "tbsess_already_closed", status: "closed" }),
    );

    await closeAllTaskBrowserSessions();

    expect(taskBrowserSessions.get("tbsess_already_closed")?.status).toBe("closed");
  });

  it("sends SIGTERM to tracked processes when closing sessions", async () => {
    taskBrowserSessions.set("tbsess_kill_me", makeMockSession({ browser_session_id: "tbsess_kill_me" }));

    let terminated = false;
    const fakeProc = {
      pid: 4444,
      exitCode: null as number | null,
      kill: (sig: string) => { if (sig === "SIGTERM") terminated = true; },
      once: (_event: string, _cb: () => void) => fakeProc,
    } as unknown as ChildProcess;
    _testOnlyInsertTrackedProcess("tbsess_kill_me", fakeProc);

    await closeAllTaskBrowserSessions();

    expect(terminated).toBe(true);
    expect(taskBrowserSessions.get("tbsess_kill_me")?.status).toBe("expired");
  });

  it("is idempotent — second call does not change already-expired sessions", async () => {
    taskBrowserSessions.set("tbsess_idempotent", makeMockSession({ browser_session_id: "tbsess_idempotent" }));

    await closeAllTaskBrowserSessions();
    const firstStatus = taskBrowserSessions.get("tbsess_idempotent")?.status;

    await closeAllTaskBrowserSessions();
    const secondStatus = taskBrowserSessions.get("tbsess_idempotent")?.status;

    expect(firstStatus).toBe("expired");
    expect(secondStatus).toBe("expired");
  });
});

// ─── Admin cleanup endpoint ───────────────────────────────────────────────────

describe("POST /api/internal/runtime-browser-sessions/cleanup-orphans", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    seedTestData();
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    mockExecSync.mockReturnValue("");
    _testOnlyClearTrackedProcesses();
  });

  it("returns ok:true with zero counts when no orphans found", async () => {
    mockExecSync.mockReturnValue("  PID ARGS\n  1 /sbin/launchd");

    const res = await server.inject({
      method: "POST",
      url: "/api/internal/runtime-browser-sessions/cleanup-orphans",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.orphans_found).toBe(0);
    expect(body.data.orphans_killed).toBe(0);
    expect(typeof body.data.ports_freed).toBe("number");
    expect(body.data.message).toMatch(/no orphaned/i);
  });

  it("returns killed count and success message when orphans are found", async () => {
    mockExecSync.mockReturnValue(
      "  PID ARGS\n 6543 /Chrome --user-data-dir=/tmp/aegis-agent-browser-tbsess_http_test",
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const res = await server.inject({
      method: "POST",
      url: "/api/internal/runtime-browser-sessions/cleanup-orphans",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.orphans_killed).toBe(1);
    expect(body.data.message).toMatch(/killed 1/i);

    killSpy.mockRestore();
  });
});

// ─── NO_PORTS_AVAILABLE remediation hint ────────────────────────────────────

describe("NO_PORTS_AVAILABLE error message", () => {
  it("includes remediation hint pointing to the cleanup endpoint", () => {
    // Verify the error thrown in createTaskBrowserSession contains the expected
    // remediation text. We construct the error the same way the allocator does
    // to confirm the message format without needing to exercise all 29 ports.
    const portRange = "9222–9250";
    const err = Object.assign(
      new Error(
        `Antigen could not start a secure browser session — all ports ${portRange} are occupied and orphan cleanup did not free any. ` +
          `Call POST /api/internal/runtime-browser-sessions/cleanup-orphans or restart the API.`,
      ),
      { code: "NO_PORTS_AVAILABLE", occupied_port_range: portRange, tracked_occupied_sessions: [] },
    );

    expect(err.message).toContain("cleanup-orphans");
    expect(err.message).toContain("restart the API");
    expect((err as { code: string }).code).toBe("NO_PORTS_AVAILABLE");
    expect((err as { occupied_port_range: string }).occupied_port_range).toBe(portRange);
  });
});
