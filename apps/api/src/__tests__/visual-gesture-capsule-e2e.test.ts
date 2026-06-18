/**
 * Visual Gesture Capsule (VGC) — controlled backend END-TO-END flow test (M1I).
 *
 * Proves the whole opaque human-verification (HV) loop works as a server flow,
 * with NO real browser, NO real CDP, and NO UI:
 *
 *   agent action hits an opaque page-level HV wall (M1H)
 *     → 409 HUMAN_VERIFICATION_REQUIRED with safe visual_gesture_capsule metadata
 *     → GET /visual-gesture-capsules            (capsule discoverable)
 *     → GET /:id/screenshot                     (the ONE byte-bearing endpoint)
 *     → POST /:id/gesture                       (user tap / press-hold relayed)
 *     → POST /:id/recheck                       (cleared / rejected_retryable / manual_fallback)
 *
 * This is NOT a live-browser test — every CDP/browser touch is mocked at the
 * module boundary. The agent-facing path is REAL (agentApiRoutes), the internal
 * VGC routes are REAL (visualGestureCapsuleRoutes), and the VGC store/safe-view
 * is REAL. The capture/relay/recheck helpers are mocked: capture stores a known
 * fake PNG frame; relay/recheck mutate the real store via the lifecycle helpers
 * so the routes' re-fetched safe views stay consistent with real behavior.
 *
 * Non-leakage is asserted across every agent-facing and safe-internal response:
 * screenshot bytes are confined to GET /:id/screenshot; coordinates, viewport
 * dimensions, cdp_url, target_id, and gesture strategy never appear anywhere.
 *
 * Harness mirrors human-verification-preflight-ordering.test.ts.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Force a stale ref WITHOUT a real browser/CDP, so the action takes the HV
// preflight branch (the snapshot store stays real).
const clickKnownBoxMock = vi.hoisted(() => vi.fn());
const clickByDescriptionMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return { ...actual, realisticClickKnownBox: clickKnownBoxMock, realisticClickByDescription: clickByDescriptionMock };
});

// Place/remove the opaque page-level HV wall deterministically.
const hvWallProbeMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  return { ...actual, detectPageHumanVerificationWallViaCDP: hvWallProbeMock };
});

// Give the guard a resolvable "page" to probe.
const resolveTargetMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, resolveSnapshotCdpTarget: resolveTargetMock };
});

// Mock the M1C capture helper (the orchestrator's + recapture endpoint's only CDP
// touch). Spread actual so types/other exports survive; the function is replaced.
vi.mock("../runtime/visualGestureCapsuleCapture.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/visualGestureCapsuleCapture.js")>(
    "../runtime/visualGestureCapsuleCapture.js",
  );
  return { ...actual, captureVisualGestureCapsuleScreenshotFrame: vi.fn() };
});

// Mock the M1E relay + M1G recheck helpers (the gesture/recheck routes give no
// HTTP injection seam, and the real helpers need CDP). Full replacement — the
// routes import only the one function from each.
vi.mock("../runtime/visualGestureCapsuleRelay.js", () => ({
  relayVisualGestureCapsuleGesture: vi.fn(),
}));
vi.mock("../runtime/visualGestureCapsuleRecheck.js", () => ({
  recheckVisualGestureCapsule: vi.fn(),
}));

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
import { visualGestureCapsuleRoutes } from "../routes/visual-gesture-capsules.js";
import { agentDelegations, passes, humanVerificationRequests } from "../store/index.js";
import { clearAllActiveHumanVerificationForTests } from "../runtime/humanVerificationState.js";
import { clearBrowserRunTraces } from "../runtime/browserRunTrace.js";
import {
  listActiveVisualGestureCapsules,
  clearVisualGestureCapsulesForTests,
  storeVisualGestureCapsuleScreenshotFrame,
  getVisualGestureCapsule,
  transitionVisualGestureCapsule,
  markGestureCapsuleCleared,
  markGestureAttemptRejected,
} from "../runtime/visualGestureCapsule.js";
import { captureVisualGestureCapsuleScreenshotFrame } from "../runtime/visualGestureCapsuleCapture.js";
import { relayVisualGestureCapsuleGesture } from "../runtime/visualGestureCapsuleRelay.js";
import { recheckVisualGestureCapsule } from "../runtime/visualGestureCapsuleRecheck.js";

const mockedCapture = vi.mocked(captureVisualGestureCapsuleScreenshotFrame);
const mockedRelay = vi.mocked(relayVisualGestureCapsuleGesture);
const mockedRecheck = vi.mocked(recheckVisualGestureCapsule);

const BEARER = "Bearer tok_vgce2e_001";
const DELEGATION_ID = "del_vgce2e_001";
const PASS_ID = "pass_vgce2e_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_vgce2e_001";
const CLICK_URL = "/api/agent/v1/runtime/browser-click";
const BBW_URL = "https://www.bathandbodyworks.com/";

// A clearly distinctive non-empty "frame" so any byte leak is unambiguous in a
// raw-body substring check. The store only requires a non-empty string.
const FAKE_PNG = "FAKE_PNG_BYTES_e2e_do_not_leak_AAAABBBBCCCC";

const PRESS_AND_HOLD_WALL = {
  human_verification: true as const,
  hv_challenge_type: "press_and_hold" as const,
  user_presence_required: true as const,
  blocking: true as const,
  page_level: true as const,
};

const CAPTURE_FAIL = { ok: false as const, reason: "capture_failed" as const };

let server: FastifyInstance;

// ─── seed helpers (mirror the preflight harness) ─────────────────────────────

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_vgce2e_001",
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

/**
 * Faithful capture mock: the real M1C helper STORES a redacted frame in the M1B
 * frame store on success (which is what makes `screenshot_available` true). Mirror
 * that here (no real CDP) and return the recapture-shaped result.
 */
function captureOkStoringFrame() {
  return vi.fn(async ({ capsuleId }: { capsuleId: string }) => {
    const stored = storeVisualGestureCapsuleScreenshotFrame(capsuleId, {
      png_base64: FAKE_PNG,
      viewport_css_width: 640,
      viewport_css_height: 400,
    });
    const frame = stored.ok ? stored.frame : undefined;
    return {
      ok: true as const,
      capsule_id: capsuleId,
      screenshot_available: true as const,
      screenshot_captured_at: frame?.captured_at ?? new Date().toISOString(),
      screenshot_expires_at: frame?.expires_at ?? new Date(Date.now() + 45_000).toISOString(),
    };
  });
}

// ─── internal endpoint inject helpers (no auth — internal routes) ────────────

const ROOT = "/api/internal/visual-gesture-capsules";
const listCapsules = () => server.inject({ method: "GET", url: ROOT });
const getScreenshot = (id: string) =>
  server.inject({ method: "GET", url: `${ROOT}/${id}/screenshot` });
const postGesture = (id: string, gesture: unknown) =>
  server.inject({ method: "POST", url: `${ROOT}/${id}/gesture`, payload: { cdp_url: "ws://test", gesture } });
const postRecheck = (id: string) =>
  server.inject({ method: "POST", url: `${ROOT}/${id}/recheck`, payload: { cdp_url: "ws://test" } });
const postRecapture = (id: string) =>
  server.inject({ method: "POST", url: `${ROOT}/${id}/recapture`, payload: { cdp_url: "ws://test" } });

// ─── non-leakage assertions ──────────────────────────────────────────────────

/**
 * Keys that must NEVER appear in any agent-facing or safe-internal response.
 * Checked as parsed-JSON KEYS (not raw substrings) so short/ambiguous tokens
 * (fx/fy/cssX/cssY/path) can't false-positive on unrelated substrings or bare
 * numbers (e.g. 640/400 must not be raw-string matched).
 */
const FORBIDDEN_KEYS = [
  "png_base64",
  "viewport_css_width",
  "viewport_css_height",
  "cssX",
  "cssY",
  "fx",
  "fy",
  "cdp_url",
  "cdpUrl",
  "target_id",
  "targetId",
  "expected_url",
  "control_box",
  "strategy",
  "path",
  "duration_ms",
];

function collectKeys(value: unknown, acc: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}

/**
 * Assert a parsed response body leaks neither bytes nor geometry. NOT for the
 * screenshot endpoint, which is intentionally byte-bearing.
 */
function assertNoLeak(body: unknown) {
  const keys = collectKeys(body);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys.has(forbidden), `unexpected key "${forbidden}" in response`).toBe(false);
  }
  // Distinctive value-bearing tokens that must never be embedded anywhere.
  const raw = JSON.stringify(body);
  for (const token of [FAKE_PNG, "data:image"]) {
    expect(raw).not.toContain(token);
  }
}

// ─── default mock wiring ─────────────────────────────────────────────────────

/**
 * Default relay mock: dispatch landed → transition the REAL capsule to `checking`
 * (mirrors M1E) and return the safe relay result the route reads. No geometry,
 * no bytes.
 */
function wireRelayDispatched() {
  mockedRelay.mockImplementation(async ({ capsuleId }: { capsuleId: string }) => {
    const r = transitionVisualGestureCapsule(capsuleId, "checking");
    return {
      ok: true as const,
      capsule_id: capsuleId,
      status: r.ok ? r.capsule!.status : "checking",
      gesture_relayed: true as const,
    };
  });
}

/** Recheck mock → wall gone: terminal-clear the REAL capsule (mirrors M1G). */
function wireRecheckCleared() {
  mockedRecheck.mockImplementation(async ({ capsuleId }: { capsuleId: string }) => {
    markGestureCapsuleCleared(capsuleId);
    const c = getVisualGestureCapsule(capsuleId);
    return {
      ok: true as const,
      capsule_id: capsuleId,
      outcome: "cleared" as const,
      status: c?.status ?? ("cleared" as const),
      attempt_count: c?.attempt_count ?? 0,
    };
  });
}

/** Recheck mock → wall still present: burn one attempt on the REAL capsule. */
function wireRecheckStillPresent() {
  mockedRecheck.mockImplementation(async ({ capsuleId }: { capsuleId: string }) => {
    markGestureAttemptRejected(capsuleId);
    const c = getVisualGestureCapsule(capsuleId);
    return {
      ok: true as const,
      capsule_id: capsuleId,
      outcome: "still_present" as const,
      status: c?.status ?? ("rejected_retryable" as const),
      attempt_count: c?.attempt_count ?? 0,
    };
  });
}

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set(PASS_ID, {
    id: PASS_ID,
    token: "tok_vgce2e_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestVgcE2eAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestVgcE2eAgent",
    channel: "api",
    status: "active",
    token_id: PASS_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(visualGestureCapsuleRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete(PASS_ID);
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearAllActiveHumanVerificationForTests();
  humanVerificationRequests.clear();
  clearBrowserRunTraces();
  clearVisualGestureCapsulesForTests();
  vi.clearAllMocks();

  // A resolvable page target exists so the guard's probe can run.
  resolveTargetMock.mockResolvedValue({
    browserWsUrl: "ws://localhost:9222/devtools/browser/abc",
    target: { id: "TARGET_1", url: BBW_URL },
  });
  // Default: NO wall (each test arms one as needed).
  hvWallProbeMock.mockResolvedValue(null);
  // Default click result: the product ref is STALE (the wall changed the DOM).
  clickKnownBoxMock.mockResolvedValue({ success: false, error: "ANTIGEN_REF_STALE" });
  // Default capture: succeeds and stores a fake frame.
  mockedCapture.mockImplementation(captureOkStoringFrame());
  // Default relay: dispatch lands → checking.
  wireRelayDispatched();
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  clearVisualGestureCapsulesForTests();
});

/** Drive the M1H opaque-HV path and return the minted capsule_id (flag must be on). */
async function mintCapsuleViaOpaqueHv(): Promise<string> {
  seedSession();
  seedSnapshot([candidate()]);
  hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);

  const res = await clickStaleProductRef();
  expect(res.statusCode).toBe(409);
  const body = res.json();
  expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
  expect(body.error.visual_gesture_capsule.available).toBe(true);
  return body.error.visual_gesture_capsule.capsule.capsule_id as string;
}

describe("VGC backend E2E — A. happy path (opaque HV → capsule → screenshot → gesture → recheck cleared)", () => {
  it("completes the full loop and confines bytes to GET /:id/screenshot", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";

    // 1–6. Agent action hits the opaque wall → safe 409 with capsule metadata.
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);

    const actionRes = await clickStaleProductRef();
    expect(actionRes.statusCode).toBe(409);
    const actionBody = actionRes.json();
    expect(actionBody.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(actionBody.error.visual_gesture_capsule.available).toBe(true);
    const capsuleId = actionBody.error.visual_gesture_capsule.capsule.capsule_id as string;
    expect(capsuleId).toMatch(/^vgc_/);
    expect(actionBody.error.visual_gesture_capsule.capsule.status).toBe("awaiting_user_gesture");
    expect(actionBody.error.visual_gesture_capsule.capsule.screenshot_available).toBe(true);
    assertNoLeak(actionBody);

    // 7. Internal list shows the capsule with screenshot_available, no geometry.
    const listRes = await listCapsules();
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    const listed = listBody.data.find((c: any) => c.capsule_id === capsuleId);
    expect(listed).toBeDefined();
    expect(listed.screenshot_available).toBe(true);
    assertNoLeak(listBody);

    // 8. Screenshot endpoint — the ONLY byte-bearing endpoint.
    const shotRes = await getScreenshot(capsuleId);
    expect(shotRes.statusCode).toBe(200);
    const shotBody = shotRes.json();
    expect(shotBody.mime_type).toBe("image/png");
    expect(shotBody.png_base64).toBe(FAKE_PNG);

    // 9. Gesture (tap) → relayed, capsule advances to checking. No leak.
    const gestureRes = await postGesture(capsuleId, { kind: "tap", fx: 0.5, fy: 0.5 });
    expect(gestureRes.statusCode).toBe(200);
    const gestureBody = gestureRes.json();
    expect(gestureBody.ok).toBe(true);
    expect(gestureBody.gesture_relayed).toBe(true);
    expect(gestureBody.status).toBe("checking");
    assertNoLeak(gestureBody);

    // 10. Recheck → wall gone → cleared. No leak.
    wireRecheckCleared();
    const recheckRes = await postRecheck(capsuleId);
    expect(recheckRes.statusCode).toBe(200);
    const recheckBody = recheckRes.json();
    expect(recheckBody.ok).toBe(true);
    expect(recheckBody.recheck).toBe("cleared");
    expect(recheckBody.status).toBe("cleared");
    assertNoLeak(recheckBody);

    // 11. Cleared capsule is terminal → excluded from the active list.
    const finalListRes = await listCapsules();
    const finalList = finalListRes.json();
    expect(finalList.data.find((c: any) => c.capsule_id === capsuleId)).toBeUndefined();
  });
});

describe("VGC backend E2E — B. retry path (recheck still_present)", () => {
  it("first still_present → rejected_retryable, attempt_count 1; second → manual_fallback, attempt_count 2", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const capsuleId = await mintCapsuleViaOpaqueHv();

    // Round 1: gesture → recheck still_present.
    await postGesture(capsuleId, { kind: "tap", fx: 0.5, fy: 0.5 });
    wireRecheckStillPresent();
    const r1 = await postRecheck(capsuleId);
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.recheck).toBe("still_present");
    expect(b1.status).toBe("rejected_retryable");
    expect(b1.attempt_count).toBe(1);
    assertNoLeak(b1);

    // Round 2: gesture again → recheck still_present → attempts exhausted.
    await postGesture(capsuleId, { kind: "press_hold", fx: 0.4, fy: 0.6, duration_ms: 1200 });
    const r2 = await postRecheck(capsuleId);
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();
    expect(b2.recheck).toBe("still_present");
    expect(b2.status).toBe("manual_fallback");
    expect(b2.attempt_count).toBe(2);
    assertNoLeak(b2);
  });
});

describe("VGC backend E2E — C. capture failure still creates the capsule", () => {
  it("capsule exists with screenshot_available false; recapture later provides bytes", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";

    // First capture (during M1H) fails; subsequent captures (recapture) succeed.
    mockedCapture.mockResolvedValueOnce(CAPTURE_FAIL);
    mockedCapture.mockImplementation(captureOkStoringFrame());

    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);

    const actionRes = await clickStaleProductRef();
    expect(actionRes.statusCode).toBe(409);
    const actionBody = actionRes.json();
    expect(actionBody.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(actionBody.error.visual_gesture_capsule.available).toBe(true);
    const capsuleId = actionBody.error.visual_gesture_capsule.capsule.capsule_id as string;
    expect(actionBody.error.visual_gesture_capsule.capsule.screenshot_available).toBe(false);
    assertNoLeak(actionBody);

    // Screenshot endpoint reports the frame is unavailable (no leak path opened).
    const missRes = await getScreenshot(capsuleId);
    expect(missRes.statusCode).toBe(404);
    expect(missRes.json().error.code).toBe("SCREENSHOT_FRAME_UNAVAILABLE");

    // Recapture succeeds (stores a frame) — safe metadata only, no bytes.
    const recapRes = await postRecapture(capsuleId);
    expect(recapRes.statusCode).toBe(200);
    const recapBody = recapRes.json();
    expect(recapBody.screenshot_available).toBe(true);
    assertNoLeak(recapBody);

    // Now the screenshot endpoint returns the bytes.
    const shotRes = await getScreenshot(capsuleId);
    expect(shotRes.statusCode).toBe(200);
    expect(shotRes.json().png_base64).toBe(FAKE_PNG);
  });
});

describe("VGC backend E2E — D. flag off preserves old behavior", () => {
  it("HUMAN_VERIFICATION_REQUIRED with no visual_gesture_capsule key, no capsule, capture not called", async () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);

    const res = await clickStaleProductRef();
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error).not.toHaveProperty("visual_gesture_capsule");
    assertNoLeak(body);

    expect(mockedCapture).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);

    // Internal list reports the feature disabled.
    const listRes = await listCapsules();
    const listBody = listRes.json();
    expect(listBody.disabled).toBe(true);
    expect(listBody.data).toHaveLength(0);
  });
});
