/**
 * Visual Gesture Capsule — model-promoted ambiguous mint (visual-judgment authority).
 *
 * The live Bath & Body Works regression: a PerimeterX/HUMAN press-and-hold wall is
 * visually present, but the DOM/geometry heuristic (classifyAmbiguousVisualObstruction)
 * sees no concrete obstruction signal (cross-origin frame below the dominance
 * threshold, no detectable scrim, >3 visible controls). Pre-fix, the snapshot returned
 * a healthy 200, no VGC, no handoff — the agent continued as if it were a 404/search
 * issue.
 *
 * The vision model, however, classified the captured frame as `page_level_hv_wall` at
 * high confidence. This suite proves that a model-CONFIRMED HV verdict (hvConfirmed)
 * may PROMOTE a VGC mint in the ambiguous snapshot path even when DOM geometry is
 * inconclusive — while benign suppression, uncertain/unavailable fallback to the DOM
 * classifier, the existing DOM-positive mint, secret-safety, and "no model call during
 * normal browsing" all remain intact.
 *
 * Hermetic: the snapshot bundle, both CDP probes, the CDP target resolver, the VGC
 * redacted-capture helper, AND evaluateVisualJudgment are mocked — no real browser, no
 * real sidecar. evaluateVisualJudgment is the SINGLE seam that injects the model verdict.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock the structural wall probe (null by default), the booleans-only ambiguous probe,
// AND the snapshot bundle — everything else in the runtime module stays live.
const hvWallProbeMock = vi.hoisted(() => vi.fn());
const ambiguousProbeMock = vi.hoisted(() => vi.fn());
const bundleMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  return {
    ...actual,
    detectPageHumanVerificationWallViaCDP: hvWallProbeMock,
    detectAmbiguousVisualObstructionViaCDP: ambiguousProbeMock,
    extractAntigenSnapshotBundleViaCDP: bundleMock,
  };
});

const resolveTargetMock = vi.hoisted(() => vi.fn());
const liveUrlMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, resolveSnapshotCdpTarget: resolveTargetMock, readLiveCdpPageUrl: liveUrlMock };
});

const vgcCaptureMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/visualGestureCapsuleCapture.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/visualGestureCapsuleCapture.js")>(
    "../runtime/visualGestureCapsuleCapture.js",
  );
  return { ...actual, captureVisualGestureCapsuleScreenshotFrame: vgcCaptureMock };
});

// The single seam that injects the model verdict. The REAL evaluator captures a frame +
// calls a localhost sidecar; here we return a deterministic VisualJudgmentEvaluation.
const evalVisualJudgmentMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/visualBlockerClassifier/visualJudgment.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/visualBlockerClassifier/visualJudgment.js")>(
    "../runtime/visualBlockerClassifier/visualJudgment.js",
  );
  return { ...actual, evaluateVisualJudgment: evalVisualJudgmentMock };
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
  recordActionNoProgress,
  clearAllActionNoProgressForTests,
} from "../runtime/humanVerificationState.js";
import {
  listActiveVisualGestureCapsules,
  clearVisualGestureCapsulesForTests,
  storeVisualGestureCapsuleScreenshotFrame,
} from "../runtime/visualGestureCapsule.js";
import {
  getLatestHvHandoffUpdate,
  clearHvHandoffUpdatesForTests,
} from "../runtime/humanVerificationHandoff.js";

const BEARER = "Bearer tok_vgcmp_001";
const DELEGATION_ID = "del_vgcmp_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_vgcmp_001";
const SNAPSHOT_URL = "/api/agent/v1/runtime/browser-snapshot";
const PAGE_URL = "https://www.bathandbodyworks.com/search";

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_vgcmp_001",
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
    name: "Some Product",
    normalized_name: "some product",
    id: null,
    href: null,
    href_path: "/p/some-product",
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

function snapshot() {
  return server.inject({
    method: "POST",
    url: SNAPSHOT_URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
  });
}

// ── Visual-judgment verdict builders ──────────────────────────────────────────

/** Model CONFIDENT page-level HV wall under live policy (the promotion signal). */
function confidentHvVerdict(confidence = 0.93): VisualJudgmentEvaluation {
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

/** Model CONFIDENT benign → suppress (false-positive kill). */
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

/** Model uncertain — neither suppress nor confirm (falls back to DOM geometry). */
function uncertainVerdict(): VisualJudgmentEvaluation {
  return { ran: true, suppress: false, hvConfirmed: false, outcome: "uncertain", result: null };
}

/** Flag-off / model-unavailable shape (byte-identical fallback to DOM). */
const FLAG_OFF_VERDICT: VisualJudgmentEvaluation = { ran: false, suppress: false, hvConfirmed: false };

/** Inconclusive DOM probe — the B&BW shape: no denial text, >3 controls, opaque frame
 *  below the dominance threshold, no detectable scrim. classifyAmbiguousVisualObstruction
 *  returns FALSE for this, so any mint here is purely the model's authority. */
const INCONCLUSIVE_PROBE = {
  denial_text_seen: false,
  near_zero_interactive: false,
  visible_inaccessible_iframe_seen: false,
  large_centered_overlay_seen: false,
  viewport_scrim_seen: false,
  pointer_interceptor_seen: false,
  top_layer_dialog_seen: false,
};

/** Concrete DOM signal — denial text fires classifyAmbiguousVisualObstruction on its own. */
const DENIAL_PROBE = {
  denial_text_seen: true,
  near_zero_interactive: true,
  visible_inaccessible_iframe_seen: false,
};

const CAPTURE_OK = {
  ok: true as const,
  capsule_id: "ignored",
  screenshot_available: true as const,
  screenshot_captured_at: new Date().toISOString(),
  screenshot_expires_at: new Date(Date.now() + 45_000).toISOString(),
};
const CAPTURE_FAIL = { ok: false as const, reason: "capture_failed" as const };

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
  "expectedUrl",
  "control_box",
  "strategy",
  "frame_path",
  "browser_session_id",
];

function assertNoLeak(body: unknown) {
  const keys = collectKeys(body);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys.has(forbidden), `unexpected key "${forbidden}" in response`).toBe(false);
  }
  const raw = JSON.stringify(body);
  for (const f of ["data:image", "png_base64", "9222", "devtools"]) {
    expect(raw, `unexpected substring "${f}"`).not.toContain(f);
  }
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_vgcmp_001", {
    id: "pass_vgcmp_001",
    token: "tok_vgcmp_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestVgcModelPromotedAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestVgcModelPromotedAgent",
    channel: "api",
    status: "active",
    token_id: "pass_vgcmp_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_vgcmp_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearAllActiveHumanVerificationForTests();
  clearAllActionNoProgressForTests();
  clearVisualGestureCapsulesForTests();
  clearHvHandoffUpdatesForTests();
  humanVerificationRequests.clear();
  vi.clearAllMocks();
  resolveTargetMock.mockResolvedValue({
    browserWsUrl: "ws://localhost:9222/devtools/browser/abc",
    target: { id: "TARGET_1", url: PAGE_URL },
  });
  liveUrlMock.mockResolvedValue(PAGE_URL);
  hvWallProbeMock.mockResolvedValue(null);
  ambiguousProbeMock.mockResolvedValue(null);
  bundleMock.mockResolvedValue({ candidates: [], hvWallHint: false });
  // Default: no model action (flag-off shape) → DOM geometry stays the authority.
  evalVisualJudgmentMock.mockResolvedValue(FLAG_OFF_VERDICT);
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  delete process.env.ANTIGEN_HV_DEBUG;
});

// Seed the element-rich B&BW shape: many candidates + a lingering no-progress marker
// that opens the high-element ambiguous gate (element_count alone would skip it).
function seedElementRichBbwShape() {
  seedSession();
  recordActionNoProgress(SESSION_ID);
  const many = [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })];
  bundleMock.mockResolvedValueOnce({ candidates: many, hvWallHint: false });
  seedSnapshot(many);
}

describe("model-promoted ambiguous mint — visual judgment as a creation authority", () => {
  it("(1) element-rich page + INCONCLUSIVE DOM probe + confident HV verdict → mints a VGC and fails closed (DOM geometry would have declined)", async () => {
    seedElementRichBbwShape();
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.purchase_authorized).toBe(false);
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.capsule_id).toMatch(/^vgc_/);
    expect(body.error.visual_gesture_capsule.capsule.screenshot_available).toBe(true);
    // The model authority minted — the model seam was consulted exactly once.
    expect(evalVisualJudgmentMock).toHaveBeenCalledTimes(1);
    expect(evalVisualJudgmentMock.mock.calls[0][0]).toMatchObject({
      triggerBasis: "unreadable_dominant_surface",
    });
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(2) zero-candidate full-denial shape + INCONCLUSIVE probe + confident HV verdict → mints a VGC", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE, near_zero_interactive: true });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict(0.88));
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(3) confident BENIGN verdict suppresses even when a CONCRETE DOM signal is present → no mint, 200", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    // Denial text WOULD fire the DOM classifier — but benign suppression wins.
    ambiguousProbeMock.mockResolvedValueOnce({ ...DENIAL_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(benignSuppressVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("visual_gesture_capsule");
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(4) UNCERTAIN verdict falls back to the DOM classifier — concrete denial signal still mints", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValueOnce({ ...DENIAL_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(5) UNCERTAIN verdict + INCONCLUSIVE probe → DOM declines → no mint, 200 (no over-fire)", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE, near_zero_interactive: true });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("visual_gesture_capsule");
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(6) model UNAVAILABLE (flag-off shape) + concrete DOM signal → existing DOM-positive mint is unchanged", async () => {
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValueOnce({ ...DENIAL_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(FLAG_OFF_VERDICT);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(7) handoff update is PUBLISHED for the model-promoted mint with safe model metadata", async () => {
    seedElementRichBbwShape();
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict(0.91));
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();
    expect(res.statusCode).toBe(409);

    const handoff = getLatestHvHandoffUpdate(SESSION_ID);
    expect(handoff).toBeDefined();
    expect(handoff!.phase).toBe("detected");
    expect(handoff!.source).toBe("visual_gesture_capsule");
    expect(handoff!.presence_source).toBe("model");
    expect(handoff!.model_label).toBe("page_level_hv_wall");
    expect(handoff!.model_confidence).toBeCloseTo(0.91, 5);
    expect(handoff!.visual_policy_decision).toBe("visual_hv_confirmed");
    expect(handoff!.trigger_basis).toBe("unreadable_dominant_surface");
    expect(handoff!.agent_should_wait).toBe(true);
    expect(handoff!.requires_user_attention).toBe(true);
  });

  it("(8) the 409 attribution names the visual-judgment snapshot-mint path; hv_debug marks the promotion", async () => {
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedElementRichBbwShape();
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    // Attribution shape is unchanged: the snapshot-mint visual-judgment source.
    expect(err.human_verification_attribution).toMatchObject({
      source: "snapshot_mint_visual_judgment",
      visual_judgment_coverage: "fresh_judgment_possible",
      fresh_visual_judgment_event_expected: true,
      visual_judgment_ran: true,
      visual_judgment_outcome: "confident_human_needed",
      visual_judgment_suppress: false,
    });
    // Dev-only telemetry distinguishes the model-promoted mint from the DOM mint.
    expect(err.hv_debug).toMatchObject({
      scope: "snapshot_hv",
      returned_409: true,
      reason: "visual_judgment_promoted_hv",
      visual_judgment_promoted: true,
      created_capsule: true,
    });
  });

  it("(9) DOM-geometry mint (uncertain verdict) marks visual_judgment_promoted:false in hv_debug", async () => {
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValueOnce({ ...DENIAL_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.hv_debug).toMatchObject({
      reason: "ambiguous_fired",
      visual_judgment_promoted: false,
    });
  });

  it("(10) the model-promoted 409 body leaks no bytes/coords/viewport/cdp/frame-path/session keys", async () => {
    seedElementRichBbwShape();
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();
    assertNoLeak(res.json());
  });

  it("(11) confident HV verdict but VGC capture fails → still fails closed, screenshot_available:false", async () => {
    seedElementRichBbwShape();
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE });
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockResolvedValueOnce(CAPTURE_FAIL);

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.screenshot_available).toBe(false);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(12) NO model call during healthy element-rich browsing (gate never opens)", async () => {
    seedSession();
    // Many candidates, no hint, NO no-progress marker → the ambiguous gate stays closed.
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("visual_gesture_capsule");
    expect(evalVisualJudgmentMock).not.toHaveBeenCalled();
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(13) VGC OFF → no model-promoted mint even on a confident HV verdict (byte-identical 200)", async () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValue({ ...INCONCLUSIVE_PROBE, near_zero_interactive: true });
    evalVisualJudgmentMock.mockResolvedValue(confidentHvVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("visual_gesture_capsule");
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });
});
