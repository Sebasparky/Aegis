/**
 * Proactive dominant-surface snapshot gate (ANTIGEN_HV_PROACTIVE_SURFACE).
 *
 * Regression coverage for the live Bath & Body Works "Press & Hold" gap: a visibly
 * dominant scrim + centered modal was on screen, but `antigen_snapshot` returned a
 * normal 200 with actionable refs (and an action later ran behind it) because DOM
 * phrase/affordance detection failed (`no_hv_phrase` ⇒ screenHv.wall:false) and the
 * visual model was never consulted on a high-element, no-marker first snapshot.
 *
 * Invariant under test: when a dominant scrim+centered surface is present, the SAME
 * memoized visual classifier runs PROACTIVELY (independent of element count / hint /
 * no-progress marker). Confident HV mints + 409; confident benign continues (200,
 * actionable); UNCERTAIN over a dominant surface returns a recoverable non-actionable
 * 200 (attention_required + blocked_attention, refs flagged, NO capsule — scrim alone
 * never mints).
 *
 * Hermetic: snapshot bundle (incl. screenHv), both CDP probes, the CDP target
 * resolver, the VGC redacted-capture helper, AND evaluateVisualJudgment are mocked.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

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
import type {
  AntigenSnapshotCandidate,
  ScreenHvWallSignals,
} from "../runtime/antigenSnapshotRuntime.js";
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
import { clearHvHandoffUpdatesForTests } from "../runtime/humanVerificationHandoff.js";

const BEARER = "Bearer tok_vps_001";
const DELEGATION_ID = "del_vps_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_vps_001";
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
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_vps_001",
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

/** Dominant centered modal over a full-viewport scrim, NO HV phrase / press-hold. */
function screenHvSignals(overrides: Partial<ScreenHvWallSignals> = {}): ScreenHvWallSignals {
  return {
    wall: false,
    viewport_scrim_seen: true,
    centered_modal_seen: true,
    press_hold_affordance_seen: false,
    hv_phrase_seen: false,
    top_layer_dialog_seen: false,
    dominant_visible_surface_seen: true,
    dominant_visible_surface_kind: "scrim_center_modal",
    dominant_text_extraction_attempted: true,
    dominant_text_extractable: true,
    dominant_text_uninspectable: false,
    dominant_text_source: "unknown",
    visible_but_semantically_unclassified: false,
    dominant_surface_contains_iframe: false,
    dominant_surface_iframe_text_not_harvested: false,
    unreadable_dominant_surface_seen: false,
    browser_check_phrase_seen: false,
    ...overrides,
  };
}

function uncertainVerdict(): VisualJudgmentEvaluation {
  return {
    ran: true,
    suppress: false,
    hvConfirmed: false,
    outcome: "uncertain",
    result: {
      predictedLabel: "cookie_banner",
      confidence: 0.4314,
      topLabels: [{ label: "cookie_banner", confidence: 0.4314 }],
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

/** Geometry probe present (so the model is consulted) but with NO opaque boundary —
 *  the exact preserved-background B&BW shape the DOM classifier declines on. */
const INCONCLUSIVE_PROBE = {
  denial_text_seen: false,
  near_zero_interactive: false,
  visible_inaccessible_iframe_seen: false,
  large_centered_overlay_seen: true,
  viewport_scrim_seen: false,
  pointer_interceptor_seen: true,
  top_layer_dialog_seen: false,
};

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

const FORBIDDEN_SUBSTRINGS = ["data:image", "png_base64", "9222", "devtools", "/tmp/aegis", "ws://", "TARGET_1"];
function assertNoLeak(raw: string) {
  for (const f of FORBIDDEN_SUBSTRINGS) {
    expect(raw, `unexpected substring "${f}"`).not.toContain(f);
  }
}

/** Element-rich page (DOM preserved behind the wall) + NO no-progress marker + a
 *  dominant scrim+centered screen scan: ONLY the proactive trigger can open the gate. */
function seedDominantBbwShape(opts: { screenHv?: Partial<ScreenHvWallSignals> } = {}) {
  seedSession();
  const many = [
    candidate(),
    candidate({ index: 1 }),
    candidate({ index: 2 }),
    candidate({ index: 3 }),
    candidate({ index: 4 }),
  ];
  bundleMock.mockResolvedValueOnce({
    candidates: many,
    hvWallHint: false,
    screenHv: screenHvSignals(opts.screenHv),
  });
  seedSnapshot(many);
  ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE });
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_vps_001", {
    id: "pass_vps_001",
    token: "tok_vps_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestProactiveSnapshotAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestProactiveSnapshotAgent",
    channel: "api",
    status: "active",
    token_id: "pass_vps_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_vps_001");
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
  humanVerificationRequests.clear();
  // resetAllMocks (not clearAllMocks): flag-off / model-disabled cases queue
  // mockResolvedValueOnce verdicts that are never consumed; reset clears the once-queue
  // each test so they cannot leak into a later test.
  vi.resetAllMocks();
  resolveTargetMock.mockResolvedValue({
    browserWsUrl: "ws://localhost:9222/devtools/browser/abc",
    target: { id: "TARGET_1", url: PAGE_URL },
  });
  liveUrlMock.mockResolvedValue(PAGE_URL);
  hvWallProbeMock.mockResolvedValue(null);
  ambiguousProbeMock.mockResolvedValue(null);
  bundleMock.mockResolvedValue({ candidates: [], hvWallHint: false });
  evalVisualJudgmentMock.mockResolvedValue(uncertainVerdict());
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
  delete process.env.ANTIGEN_HV_PROACTIVE_SURFACE;
  delete process.env.ANTIGEN_HV_DEBUG;
});

describe("proactive dominant-surface snapshot gate", () => {
  it("(1) scrim+centered + DOM phrase fail + CONFIDENT HV → 409 + VGC minted ON the snapshot (before any action)", async () => {
    seedDominantBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
    // The model was consulted proactively on the dominant-surface basis.
    expect(evalVisualJudgmentMock).toHaveBeenCalled();
    expect(evalVisualJudgmentMock.mock.calls.at(-1)?.[0]).toMatchObject({
      triggerBasis: "unreadable_dominant_surface",
    });
    assertNoLeak(JSON.stringify(body));
  });

  it("(2) scrim+centered + CONFIDENT BENIGN → 200, no capsule, refs stay actionable", async () => {
    seedDominantBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(benignSuppressVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    expect(body.data.attention_required).toBeUndefined();
    expect(body.data.blocked_attention).toBeUndefined();
    // Refs are NOT force-flagged as blocked in the benign case.
    expect(body.data.elements.every((e: any) => e.likely_blocked_by_overlay !== true)).toBe(true);
  });

  it("(3) scrim+centered + UNCERTAIN model + no opaque boundary → recoverable 200, NO capsule, refs withheld", async () => {
    seedDominantBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Conservative non-actionable state — never mints (scrim alone).
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    expect(body.data.attention_required).toBe(true);
    expect(body.data.blocked_attention).toMatchObject({
      code: "DOMINANT_SURFACE_UNVERIFIED",
      surface_present: true,
      surface_trusted: false,
      surface_resolution: "unverified",
      actionable_refs_withheld: true,
    });
    // Naming clarity: the modal is NOT described as DOM-uninspectable.
    expect(body.data.blocked_attention).not.toHaveProperty("surface_inspectable");
    // Every background ref is flagged non-actionable (advisory; preflight is the
    // hard enforcement).
    expect(body.data.elements.length).toBeGreaterThan(0);
    expect(body.data.elements.every((e: any) => e.likely_blocked_by_overlay === true)).toBe(true);
    // The model RAN proactively.
    expect(evalVisualJudgmentMock).toHaveBeenCalled();
    assertNoLeak(JSON.stringify(body));
  });

  it("(4) PROACTIVE FLAG OFF → byte-identical: no model call, no attention state, 200, refs actionable", async () => {
    delete process.env.ANTIGEN_HV_PROACTIVE_SURFACE;
    seedDominantBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict()); // even a wall is never consulted

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // High element count + no no-progress + no hint ⇒ the gate stays closed; the new
    // dominant trigger is the only thing that could have opened it.
    expect(evalVisualJudgmentMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    expect(body.data.attention_required).toBeUndefined();
    expect(body.data.elements.every((e: any) => e.likely_blocked_by_overlay !== true)).toBe(true);
  });

  it("(5) UNCERTAIN conservative 200 leaks no bytes/coords/cdp/urls in body OR console telemetry", async () => {
    process.env.ANTIGEN_HV_DEBUG = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      seedDominantBbwShape();
      evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

      const res = await snapshot();

      expect(res.statusCode).toBe(200);
      expect(res.json().data.attention_required).toBe(true);
      assertNoLeak(JSON.stringify(res.json()));
      // Console telemetry (logHvActionDebug / [HvDebug]) is booleans/enums only.
      const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      assertNoLeak(logged);
      expect(logged).not.toMatch(/ag_\d+/);
      expect(logged).not.toMatch(/\d{2,},\d{2,}/); // no coordinate pairs
    } finally {
      logSpy.mockRestore();
    }
  });
});

/**
 * No-scrim broadening: the live B&BW wall is a centered FIXED-OVERLAY card over a
 * PRESERVED background with NO viewport scrim (the smoking-gun `screen_viewport_scrim_seen=
 * false`, `surface_dominant_visible_surface_kind=fixed_overlay` shape). The old scrim-only
 * gate skipped it (`ambiguous_gate_open=false`). The broadened gate opens on a dominant
 * centered surface with or without a scrim; the model stays the sole authority.
 */
function seedNoScrimDominantShape() {
  seedDominantBbwShape({
    screenHv: { viewport_scrim_seen: false, dominant_visible_surface_kind: "fixed_overlay" },
  });
}

describe("proactive dominant-surface snapshot gate — no-scrim fixed overlay", () => {
  it("(1) centered modal + fixed_overlay + NO scrim + CONFIDENT HV → 409 + VGC minted", async () => {
    seedNoScrimDominantShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
    expect(evalVisualJudgmentMock).toHaveBeenCalled();
    expect(evalVisualJudgmentMock.mock.calls.at(-1)?.[0]).toMatchObject({
      triggerBasis: "unreadable_dominant_surface",
    });
    assertNoLeak(JSON.stringify(body));
  });

  it("(2) centered modal + fixed_overlay + NO scrim + CONFIDENT BENIGN → 200, no capsule, refs actionable", async () => {
    seedNoScrimDominantShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(benignSuppressVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    expect(body.data.attention_required).toBeUndefined();
    expect(body.data.blocked_attention).toBeUndefined();
    expect(body.data.elements.every((e: any) => e.likely_blocked_by_overlay !== true)).toBe(true);
  });

  it("(3) centered modal + fixed_overlay + NO scrim + UNCERTAIN → recoverable 200, NO capsule, refs withheld", async () => {
    seedNoScrimDominantShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    expect(body.data.attention_required).toBe(true);
    expect(body.data.blocked_attention).toMatchObject({
      code: "DOMINANT_SURFACE_UNVERIFIED",
      surface_present: true,
      surface_trusted: false,
      surface_resolution: "unverified",
      actionable_refs_withheld: true,
    });
    expect(body.data.elements.length).toBeGreaterThan(0);
    expect(body.data.elements.every((e: any) => e.likely_blocked_by_overlay === true)).toBe(true);
    expect(evalVisualJudgmentMock).toHaveBeenCalled();
    assertNoLeak(JSON.stringify(body));
  });

  it("(4) PROACTIVE FLAG OFF + no-scrim dominant → byte-identical: no model call, 200, refs actionable", async () => {
    delete process.env.ANTIGEN_HV_PROACTIVE_SURFACE;
    seedNoScrimDominantShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict()); // never consulted

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(evalVisualJudgmentMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    expect(body.data.attention_required).toBeUndefined();
    expect(body.data.elements.every((e: any) => e.likely_blocked_by_overlay !== true)).toBe(true);
  });
});
