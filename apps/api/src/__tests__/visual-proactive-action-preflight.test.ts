/**
 * Proactive visual-blocker ACTION preflight (ANTIGEN_HV_PROACTIVE_SURFACE).
 *
 * Server-side enforcement half of the dominant-surface invariant: a browser action
 * (click/type/set-value/scroll) must NOT execute behind a visibly dominant, unverified
 * scrim+modal surface merely because no VGC exists yet — the live B&BW "Press & Hold"
 * gap where the wall was only caught AFTER a failed click. The preflight runs BEFORE
 * pointer/type/value dispatch:
 *   • confident HV   → mint + 409 HUMAN_VERIFICATION_REQUIRED before dispatch;
 *   • UNCERTAIN      → 409 ACTION_BLOCKED_DOMINANT_SURFACE, NO mint, no dispatch;
 *   • confident benign / no dominant surface → proceed (dispatch runs).
 *
 * Hermetic: the realistic pointer runtime, both CDP probes, the CDP target resolver,
 * the VGC capture helper, and evaluateVisualJudgment are mocked.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

const clickKnownBoxMock = vi.hoisted(() => vi.fn());
const clickByDescriptionMock = vi.hoisted(() => vi.fn());
const typeKnownBoxMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return {
    ...actual,
    realisticClickKnownBox: clickKnownBoxMock,
    realisticClickByDescription: clickByDescriptionMock,
    realisticTypeKnownBox: typeKnownBoxMock,
  };
});

const hvWallProbeMock = vi.hoisted(() => vi.fn());
const ambiguousProbeMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  return {
    ...actual,
    detectPageHumanVerificationWallViaCDP: hvWallProbeMock,
    detectAmbiguousVisualObstructionViaCDP: ambiguousProbeMock,
  };
});

const resolveTargetMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, resolveSnapshotCdpTarget: resolveTargetMock };
});

const vgcCaptureMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/visualGestureCapsuleCapture.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/visualGestureCapsuleCapture.js")>(
    "../runtime/visualGestureCapsuleCapture.js",
  );
  return { ...actual, captureVisualGestureCapsuleScreenshotFrame: vgcCaptureMock };
});

const evalVisualJudgmentMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/visualBlockerClassifier/visualJudgment.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/visualBlockerClassifier/visualJudgment.js")>(
    "../runtime/visualBlockerClassifier/visualJudgment.js",
  );
  return { ...actual, evaluateVisualJudgment: evalVisualJudgmentMock };
});

// The dominant-surface-review path captures a redacted frame via this primitive.
// Mock it so the uncertain-block tests never open a real CDP WebSocket (hermetic +
// fast); the review record itself is created by the REAL dominantSurfaceReview module.
const captureRedactedScreenshotMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/screenshotRedaction.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/screenshotRedaction.js")>(
    "../runtime/screenshotRedaction.js",
  );
  return { ...actual, captureRedactedScreenshot: captureRedactedScreenshotMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import type { VisualJudgmentEvaluation } from "../runtime/visualBlockerClassifier/visualJudgment.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import {
  createAntigenSnapshotRecord,
  clearAntigenSnapshotStoreForTests,
} from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes, humanVerificationRequests } from "../store/index.js";
import {
  clearAllActiveHumanVerificationForTests,
  clearAllActionNoProgressForTests,
} from "../runtime/humanVerificationState.js";
import {
  listActiveVisualGestureCapsules,
  clearVisualGestureCapsulesForTests,
  storeVisualGestureCapsuleScreenshotFrame,
} from "../runtime/visualGestureCapsule.js";
import {
  clearHvHandoffUpdatesForTests,
  getLatestHvHandoffUpdate,
} from "../runtime/humanVerificationHandoff.js";
import {
  listActiveDominantSurfaceReviews,
  clearDominantSurfaceReviewsForTests,
} from "../runtime/dominantSurfaceReview.js";

const BEARER = "Bearer tok_vpa_001";
const DELEGATION_ID = "del_vpa_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_vpa_001";
const CLICK_URL = "/api/agent/v1/runtime/browser-click";
const TYPE_URL = "/api/agent/v1/runtime/browser-type";
const SET_VALUE_URL = "/api/agent/v1/runtime/browser-set-value";
const SCROLL_URL = "/api/agent/v1/runtime/browser-scroll-to-ref";
const PAGE_URL = "https://www.bathandbodyworks.com/";

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_vpa_001",
    ephemeral: true,
    mode: "visible",
    debug_visible: true,
    runtime_mode: "local_runtime_endpoint",
    current_url: PAGE_URL,
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
    href_path: "/p/champagne-toast",
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
    url: PAGE_URL,
    title: null,
    candidates,
  });
}

function clickRef() {
  return server.inject({
    method: "POST",
    url: CLICK_URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Champagne Toast 3-Wick Candle" },
  });
}

/** A dominant surface per the action probe: viewport scrim + large centered overlay. */
const DOMINANT_PROBE = {
  denial_text_seen: false,
  near_zero_interactive: false,
  visible_inaccessible_iframe_seen: false,
  large_centered_overlay_seen: true,
  viewport_scrim_seen: true,
  pointer_interceptor_seen: true,
  top_layer_dialog_seen: false,
};
/** A bare menu/dropdown: NOT dominant (no scrim, no centered overlay / dialog). */
const NON_DOMINANT_PROBE = { ...DOMINANT_PROBE, viewport_scrim_seen: false, large_centered_overlay_seen: false };
/** The live B&BW shape: large centered overlay over a preserved background, NO scrim. */
const NO_SCRIM_DOMINANT_PROBE = { ...DOMINANT_PROBE, viewport_scrim_seen: false };

function uncertainVerdict(): VisualJudgmentEvaluation {
  return {
    ran: true,
    suppress: false,
    hvConfirmed: false,
    outcome: "uncertain",
    result: {
      predictedLabel: "cookie_banner",
      confidence: 0.43,
      topLabels: [{ label: "cookie_banner", confidence: 0.43 }],
      needsHumanReview: false,
      advisoryOnly: true,
      source: "model",
    },
  };
}
function benignSuppressVerdict(): VisualJudgmentEvaluation {
  return {
    ran: true,
    suppress: true,
    hvConfirmed: false,
    outcome: "confident_false_positive_or_benign",
    result: {
      predictedLabel: "cookie_banner",
      confidence: 0.97,
      topLabels: [{ label: "cookie_banner", confidence: 0.97 }],
      needsHumanReview: false,
      advisoryOnly: true,
      source: "model",
    },
  };
}
function confidentHvVerdict(confidence = 0.9993): VisualJudgmentEvaluation {
  return {
    ran: true,
    suppress: false,
    hvConfirmed: true,
    outcome: "confident_human_needed",
    result: {
      predictedLabel: "page_level_hv_wall",
      confidence,
      topLabels: [{ label: "page_level_hv_wall", confidence }],
      needsHumanReview: false,
      advisoryOnly: true,
      source: "model",
    },
  };
}

const CAPTURE_OK = {
  ok: true as const,
  capsule_id: "ignored",
  screenshot_available: true as const,
  screenshot_captured_at: new Date().toISOString(),
  screenshot_expires_at: new Date(Date.now() + 45_000).toISOString(),
};
function captureOkStoringFrame() {
  return vi.fn(async ({ capsuleId }: { capsuleId: string }) => {
    storeVisualGestureCapsuleScreenshotFrame(capsuleId, {
      png_base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      viewport_css_width: 1280,
      viewport_css_height: 800,
    });
    return CAPTURE_OK;
  });
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_vpa_001", {
    id: "pass_vpa_001",
    token: "tok_vpa_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestProactivePreflightAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestProactivePreflightAgent",
    channel: "api",
    status: "active",
    token_id: "pass_vpa_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_vpa_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
  process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED = "true";
  process.env.ANTIGEN_HV_PROACTIVE_SURFACE = "true";
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearAllActiveHumanVerificationForTests();
  clearAllActionNoProgressForTests();
  clearVisualGestureCapsulesForTests();
  clearHvHandoffUpdatesForTests();
  clearDominantSurfaceReviewsForTests();
  humanVerificationRequests.clear();
  // resetAllMocks (not clearAllMocks): flag-off / model-disabled cases queue
  // mockResolvedValueOnce values that are never consumed; reset clears the once-queue
  // each test so they cannot leak into a later test.
  vi.resetAllMocks();
  resolveTargetMock.mockResolvedValue({
    browserWsUrl: "ws://localhost:9222/devtools/browser/abc",
    target: { id: "TARGET_1", url: PAGE_URL },
  });
  hvWallProbeMock.mockResolvedValue(null);
  ambiguousProbeMock.mockResolvedValue(null);
  // Default: a successful click (only reached when the preflight allows the action).
  clickKnownBoxMock.mockResolvedValue({
    success: true,
    pointer_start_source: "session",
    pointer_path_point_count: 6,
    pointer_state_persisted: true,
    current_url: PAGE_URL,
  });
  typeKnownBoxMock.mockResolvedValue({ success: true });
  evalVisualJudgmentMock.mockResolvedValue(uncertainVerdict());
  // Default: a successful redacted-frame capture for the dominant-surface review.
  captureRedactedScreenshotMock.mockResolvedValue({
    ok: true,
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    mimeType: "image/png",
    redacted_field_count: 0,
  });
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
  delete process.env.ANTIGEN_HV_PROACTIVE_SURFACE;
});

describe("proactive action preflight — click", () => {
  it("(1) dominant surface + UNCERTAIN model → 409 ACTION_BLOCKED_DOMINANT_SURFACE before pointer dispatch, no mint", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...DOMINANT_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await clickRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("ACTION_BLOCKED_DOMINANT_SURFACE");
    expect(body.error.surface_trusted).toBe(false);
    expect(body.error.surface_resolution).toBe("unverified");
    expect(body.error.next_action).toBe("antigen_snapshot");
    // NOT human verification — the response says so, and the user gets a visible,
    // non-HV review item (not a VGC) so the hard block is never invisible.
    expect(body.error.confirmed_human_verification).toBe(false);
    expect(body.error.user_presence_required).toBe(false);
    expect(typeof body.error.review_id).toBe("string");
    expect(body.error.review_id).toMatch(/^dsr_/);
    const reviews = listActiveDominantSurfaceReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].review_id).toBe(body.error.review_id);
    expect(reviews[0].outcome).toBe("uncertain");
    expect(reviews[0].confirmed_human_verification).toBe(false);
    // The agent-facing message must NOT claim an HV handoff exists.
    expect(body.error.message).toContain("not confirmed human verification");
    expect(body.error.message).not.toMatch(/human[- ]verification handoff/i);
    // Blocked BEFORE the realistic pointer runtime ran, and NO VGC minted.
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    const raw = JSON.stringify(body);
    for (const f of ["9222", "devtools", "/tmp/aegis", "data:image", "png_base64", "TARGET_1"]) {
      expect(raw).not.toContain(f);
    }
  });

  it("(2) dominant surface + CONFIDENT HV → 409 HUMAN_VERIFICATION_REQUIRED + VGC minted before dispatch", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...DOMINANT_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    // Antigen-owned handoff contract is present on the action-preflight 409 too.
    expect(body.error.handoff_owner).toBe("antigen");
    expect(body.error.confirmed_human_verification).toBe(true);
    expect(body.error.agent_should_wait).toBe(true);
    expect(body.error.capsule_id).toBe(body.error.visual_gesture_capsule.capsule.capsule_id);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("(3) dominant surface + CONFIDENT BENIGN → action proceeds (pointer runtime runs), no 409", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...DOMINANT_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(benignSuppressVerdict());

    const res = await clickRef();

    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    // A benign surface is neither HV nor a blocked review — no attention item.
    expect(listActiveDominantSurfaceReviews()).toHaveLength(0);
  });

  it("(4) NON-dominant surface (no scrim) → model never consulted, action proceeds", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...NON_DOMINANT_PROBE });

    const res = await clickRef();

    expect(res.statusCode).toBe(200);
    expect(evalVisualJudgmentMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("(5) PROACTIVE FLAG OFF → byte-identical: no obstruction probe, no model call, action proceeds", async () => {
    delete process.env.ANTIGEN_HV_PROACTIVE_SURFACE;
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...DOMINANT_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());

    const res = await clickRef();

    expect(res.statusCode).toBe(200);
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(evalVisualJudgmentMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("(6) VISUAL JUDGMENT DISABLED → no model call, no block, action proceeds", async () => {
    delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...DOMINANT_PROBE });

    const res = await clickRef();

    expect(res.statusCode).toBe(200);
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });

  it("(7) probe transport error fails OPEN — action proceeds, never 500", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockRejectedValueOnce(new Error("CDP boom"));

    const res = await clickRef();

    expect(res.statusCode).toBe(200);
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });
});

describe("proactive action preflight — no-scrim dominant overlay", () => {
  it("(1) no-scrim large centered overlay + CONFIDENT HV → 409 + VGC minted + handoff published, no dispatch", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...NO_SCRIM_DOMINANT_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
    // The mint publishes the initial HV handoff so the UI surfaces it live.
    expect(getLatestHvHandoffUpdate(SESSION_ID)?.phase).toBe("detected");
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("(2) no-scrim large centered overlay + UNCERTAIN model → 409 ACTION_BLOCKED_DOMINANT_SURFACE, no mint, no dispatch", async () => {
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...NO_SCRIM_DOMINANT_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await clickRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("ACTION_BLOCKED_DOMINANT_SURFACE");
    expect(body.error.review_id).toMatch(/^dsr_/);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    // The block is visible to the user as a non-HV review item.
    expect(listActiveDominantSurfaceReviews()).toHaveLength(1);
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
  });

  it("(3) PROACTIVE FLAG OFF + no-scrim dominant → byte-identical: no probe, no model call, action proceeds", async () => {
    delete process.env.ANTIGEN_HV_PROACTIVE_SURFACE;
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({ ...NO_SCRIM_DOMINANT_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());

    const res = await clickRef();

    expect(res.statusCode).toBe(200);
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(evalVisualJudgmentMock).not.toHaveBeenCalled();
    expect(clickKnownBoxMock).toHaveBeenCalledTimes(1);
  });
});

describe("proactive action preflight — wired on type / set-value / scroll", () => {
  const cases: { tool: string; url: string; payload: Record<string, unknown> }[] = [
    { tool: "browser_type", url: TYPE_URL, payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", text: "hello" } },
    { tool: "browser_set_value", url: SET_VALUE_URL, payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", value: "hello" } },
    { tool: "browser_scroll_to_ref", url: SCROLL_URL, payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" } },
  ];
  for (const c of cases) {
    it(`${c.tool}: dominant surface + UNCERTAIN model → 409 ACTION_BLOCKED_DOMINANT_SURFACE (no mint)`, async () => {
      seedSession();
      seedSnapshot([candidate({ typeable: true, kind: "input", role: "textbox" })]);
      ambiguousProbeMock.mockResolvedValueOnce({ ...DOMINANT_PROBE });
      evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

      const res = await server.inject({
        method: "POST",
        url: c.url,
        headers: { authorization: BEARER },
        payload: c.payload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ACTION_BLOCKED_DOMINANT_SURFACE");
      expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    });
  }
});
