/**
 * Human Presence Relay — pre-action PRIORITY ORDERING tests.
 *
 * Regression coverage for the live-B&BW masking bug: a blocking "Press & Hold"
 * human-verification challenge appeared AFTER the last antigen_snapshot, so the
 * cached HV marker was never armed. The ref-based action then fell through to
 * ref resolution and returned ANTIGEN_REF_STALE — masking the higher-priority
 * human-verification stop state.
 *
 * Invariant under test:
 *   No ref-based browser action may return ANTIGEN_REF_STALE until Antigen has
 *   first ruled out an active/page-level human-verification stop state.
 *
 * Harness mirrors antigen-browser-click-endpoint.test.ts:
 * - persistence is a no-op mock,
 * - the realistic pointer click runtime is mocked (so we can force a stale ref
 *   WITHOUT a real browser/CDP),
 * - the live HV probe (detectPageHumanVerificationWallViaCDP) and CDP target
 *   resolver (resolveSnapshotCdpTarget) are mocked so we can place / remove a
 *   blocking challenge deterministically,
 * - the snapshot store and the HV lifecycle/state are REAL (we assert the marker
 *   actually gets armed and a request actually gets minted).
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock only the realistic click runtime — the snapshot store stays real.
const clickKnownBoxMock = vi.hoisted(() => vi.fn());
const clickByDescriptionMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return { ...actual, realisticClickKnownBox: clickKnownBoxMock, realisticClickByDescription: clickByDescriptionMock };
});

// Mock ONLY the live page-level HV probe out of the snapshot runtime module —
// everything else (overlay classifiers, etc.) stays real.
const hvWallProbeMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  return { ...actual, detectPageHumanVerificationWallViaCDP: hvWallProbeMock };
});

// Mock the CDP target resolver so the guard's probe always has a "page" to probe.
const resolveTargetMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, resolveSnapshotCdpTarget: resolveTargetMock };
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
import { agentDelegations, passes, humanVerificationRequests } from "../store/index.js";
import {
  clearAllActiveHumanVerificationForTests,
  getActiveHumanVerification,
} from "../runtime/humanVerificationState.js";
import { createOrReuseHumanVerificationRequest } from "../lib/humanVerificationLifecycle.js";
import { getBrowserRunTrace, clearBrowserRunTraces } from "../runtime/browserRunTrace.js";

const BEARER = "Bearer tok_hvpre_001";
const DELEGATION_ID = "del_hvpre_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_hvpre_001";
const CLICK_URL = "/api/agent/v1/runtime/browser-click";
const BBW_URL = "https://www.bathandbodyworks.com/";

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_hvpre_001",
    ephemeral: true,
    mode: "visible",
    debug_visible: true,
    runtime_mode: "local_runtime_endpoint",
    current_url: BBW_URL,
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
    tag: "a",
    kind: "link",
    role: "link",
    name: "Champagne Toast 3-Wick Candle",
    normalized_name: "champagne toast 3-wick candle",
    id: null,
    href: null,
    href_path: "/p/champagne-toast-3-wick-candle-028029548",
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 100, y: 200, width: 180, height: 40 },
    ...overrides,
  };
}

function seedSnapshot(candidates: AntigenSnapshotCandidate[]) {
  return createAntigenSnapshotRecord({
    browser_session_id: SESSION_ID,
    browser_runtime_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    url: BBW_URL,
    title: null,
    candidates,
  });
}

/** The product-result ref the agent clicks — its box is stale once the wall pops. */
function clickStaleProductRef() {
  return server.inject({
    method: "POST",
    url: CLICK_URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Champagne Toast 3-Wick Candle" },
  });
}

const PRESS_AND_HOLD_WALL = {
  human_verification: true as const,
  hv_challenge_type: "press_and_hold" as const,
  user_presence_required: true as const,
  blocking: true as const,
  page_level: true as const,
};

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_hvpre_001", {
    id: "pass_hvpre_001",
    token: "tok_hvpre_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestHvPreflightAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestHvPreflightAgent",
    channel: "api",
    status: "active",
    token_id: "pass_hvpre_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_hvpre_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  process.env.ANTIGEN_BROWSER_TRACE = "true"; // exercise the preflight ordering trace
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearAllActiveHumanVerificationForTests();
  humanVerificationRequests.clear();
  clearBrowserRunTraces();
  vi.clearAllMocks();
  // Default: a resolvable page target exists (so the probe can run).
  resolveTargetMock.mockResolvedValue({
    browserWsUrl: "ws://localhost:9222/devtools/browser/abc",
    target: { id: "TARGET_1", url: BBW_URL },
  });
  // Default: NO challenge present (each test overrides as needed).
  hvWallProbeMock.mockResolvedValue(null);
  // Default click result: the product ref is STALE (the wall changed the DOM).
  clickKnownBoxMock.mockResolvedValue({ success: false, error: "ANTIGEN_REF_STALE" });
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  delete process.env.ANTIGEN_BROWSER_TRACE;
});

describe("HV preflight priority ordering — narrow (stale-path) live probe", () => {
  it("(1) stale product ref UNDER a blocking HV overlay returns HUMAN_VERIFICATION_REQUIRED, not ANTIGEN_REF_STALE", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    // The ref resolves stale (default mock); the stale-path live probe then
    // detects the Press & Hold wall that popped after the snapshot.
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);

    const res = await clickStaleProductRef();

    // The HIGHER-priority stop state wins over the stale ref.
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.purchase_authorized).toBe(false);
    expect(body.error.request_id).toMatch(/^hvr_/);
    // The stale ref was reached (cheap guard found no marker) and the live probe
    // ran exactly once on the stale branch.
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(hvWallProbeMock).toHaveBeenCalledTimes(1);
    // The probe armed the session marker so subsequent calls short-circuit cheap.
    expect(getActiveHumanVerification(SESSION_ID)).toBeDefined();
  });

  it("(2) stale product ref with NO HV present still returns ANTIGEN_REF_STALE (normal bounded recovery)", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValue(null); // no challenge anywhere

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
    expect(res.json().error.message).toContain("antigen_snapshot");
    // Ref resolution ran and went stale; the live probe ran once and ruled HV out.
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(hvWallProbeMock).toHaveBeenCalledTimes(1);
    // No marker was armed (no challenge).
    expect(getActiveHumanVerification(SESSION_ID)).toBeUndefined();
  });

  it("(3) an already-armed active HV marker short-circuits in the cheap guard BEFORE ref resolution or any live probe", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    // Arm the marker exactly as a prior snapshot would have.
    createOrReuseHumanVerificationRequest({
      user_id: MOCK_USER_ID,
      delegation_id: DELEGATION_ID,
      agent_name: "TestHvPreflightAgent",
      browser_session_id: SESSION_ID,
      domain: "www.bathandbodyworks.com",
      page_url: BBW_URL,
      challenge_type: "press_and_hold",
      surface_title: "Access challenge",
      page_level: true,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    // Cheap marker short-circuit: neither the runtime nor the live probe was reached.
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
    expect(hvWallProbeMock).not.toHaveBeenCalled();
  });

  it("(4) a SUCCESSFUL normal click never runs the live CDP probe (no added latency on the happy path)", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    // The click succeeds — the stale branch is never entered.
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true,
      pointer_start_source: "session",
      pointer_path_point_count: 6,
      pointer_state_persisted: true,
      current_url: "https://www.bathandbodyworks.com/p/champagne-toast-3-wick-candle-028029548",
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    // The whole point of the narrow placement: no probe on a successful action.
    expect(hvWallProbeMock).not.toHaveBeenCalled();
    expect(getActiveHumanVerification(SESSION_ID)).toBeUndefined();
  });

  it("(5) flag OFF is byte-identical: no probe runs and a stale ref returns ANTIGEN_REF_STALE", async () => {
    delete process.env.ANTIGEN_HUMAN_VERIFICATION;
    seedSession();
    seedSnapshot([candidate()]);
    // Even if a wall WOULD be detected, the disabled feature never probes.
    hvWallProbeMock.mockResolvedValue(PRESS_AND_HOLD_WALL);

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
    expect(hvWallProbeMock).not.toHaveBeenCalled();
  });

  it("a probe transport error on the stale branch fails OPEN to the original ANTIGEN_REF_STALE", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockRejectedValueOnce(new Error("CDP boom"));

    const res = await clickStaleProductRef();

    // Probe failure must not block — the action returns its original stale result.
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("emits the preflight ordering trace for HV-on-stale: marker → ref_resolution_started → probe → HUMAN_VERIFICATION_REQUIRED", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);

    await clickStaleProductRef();

    const trace = getBrowserRunTrace(SESSION_ID);
    expect(trace).toBeDefined();
    const stages = trace!.events
      .filter((e) => e.event_type === "action_preflight")
      .map((e) => e.preflight_stage);
    expect(stages).toEqual([
      "action_started",
      "hv_marker_checked",
      "ref_resolution_started",
      "hv_probe_checked",
      "returned_human_verification_required",
    ]);
    // The probe stage recorded detection as a plain boolean (no challenge text).
    const probeEvent = trace!.events.find(
      (e) => e.event_type === "action_preflight" && e.preflight_stage === "hv_probe_checked",
    );
    expect(probeEvent?.hv_detected).toBe(true);
    // ANTIGEN_REF_STALE was never surfaced (HV won).
    expect(stages).not.toContain("returned_ref_stale");
    // Trace leaks no challenge/page internals.
    const raw = JSON.stringify(trace);
    for (const f of ["press_and_hold", "bathandbodyworks", "TARGET_1", "9222", "devtools"]) {
      expect(raw).not.toContain(f);
    }
  });

  it("emits the preflight ordering trace for the no-HV stale case: marker → ref_resolution_started → probe → returned_ref_stale", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValue(null);

    await clickStaleProductRef();

    const trace = getBrowserRunTrace(SESSION_ID);
    const stages = trace!.events
      .filter((e) => e.event_type === "action_preflight")
      .map((e) => e.preflight_stage);
    expect(stages).toEqual([
      "action_started",
      "hv_marker_checked",
      "ref_resolution_started",
      "hv_probe_checked",
      "returned_ref_stale",
    ]);
  });
});
