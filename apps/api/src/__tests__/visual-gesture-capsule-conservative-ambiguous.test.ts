/**
 * Visual Gesture Capsule — RETIRED conservative ambiguous-blocker (regression guard).
 *
 * A scrim + centered modal + active no-progress marker, with NO opaque-boundary evidence
 * (no denial wall, no inaccessible cross-origin iframe) and NO model confirmation, used to
 * mint a "conservative" VGC. Live QA proved that shape is a FALSE-POSITIVE source: a benign
 * centered modal over a dimmer, on a page where a prior action happened to stall, was
 * flagged as a human-verification wall and then false-completed by the handoff monitor.
 *
 * The conservative blocker is now RETIRED. This suite is the regression guard for the
 * authority rule it violated:
 *   • no-progress / scrim / repeated-stale / centered modal alone → NEVER mint;
 *   • confident-benign model verdict (suppress OR outcome) → never mint;
 *   • confident-HV model verdict → still mints via visual_judgment_promoted_hv;
 *   • only genuine opaque-boundary evidence may mint via the DOM/geometry path.
 *
 * Hermetic: the snapshot bundle (incl. screenHv), both CDP probes, the CDP target
 * resolver, the VGC redacted-capture helper, AND evaluateVisualJudgment are mocked — no
 * real browser, no real sidecar.
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

// The single seam that injects the model verdict.
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
  recordActionNoProgress,
  clearAllActionNoProgressForTests,
} from "../runtime/humanVerificationState.js";
import {
  listActiveVisualGestureCapsules,
  clearVisualGestureCapsulesForTests,
  storeVisualGestureCapsuleScreenshotFrame,
} from "../runtime/visualGestureCapsule.js";
import { clearHvHandoffUpdatesForTests } from "../runtime/humanVerificationHandoff.js";

const BEARER = "Bearer tok_vgcca_001";
const DELEGATION_ID = "del_vgcca_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_vgcca_001";
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
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_vgcca_001",
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

// ── Screen-scan fixture: a dominant centered modal over a full-viewport scrim, but
// NOT a model/text-confirmed wall (wall:false, no HV phrase / press-hold affordance).
// This is the exact B&BW search-wall shape the model misreads as low-confidence benign.
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

// ── Visual-judgment verdict builders ──────────────────────────────────────────
/** Model uncertain — low-confidence cookie_banner (the live B&BW verdict). */
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
/** Model UNAVAILABLE (sidecar down): ran, but no result, neither suppress nor confirm. */
function unavailableVerdict(): VisualJudgmentEvaluation {
  return { ran: true, suppress: false, hvConfirmed: false, outcome: "uncertain", result: null };
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
/** Model CONFIDENT page-level HV wall (the promotion authority). */
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

/** Inconclusive DOM probe — the B&BW shape the geometry classifier declines on:
 *  no denial text, >3 controls, no opaque frame, and its OWN scrim signal below
 *  threshold (false). Any conservative mint here is purely the new backstop. */
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
  "cdp_url",
  "cdpUrl",
  "target_id",
  "targetId",
  "expected_url",
  "expectedUrl",
  "control_box",
  "strategy",
  "frame_path",
  "user_data_dir",
  "pass_id",
  "secret_ref",
];

function assertNoLeak(body: unknown) {
  const keys = collectKeys(body);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys.has(forbidden), `unexpected key "${forbidden}" in response`).toBe(false);
  }
  const raw = JSON.stringify(body);
  for (const f of ["data:image", "png_base64", "9222", "devtools", "/tmp/aegis"]) {
    expect(raw, `unexpected substring "${f}"`).not.toContain(f);
  }
}

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_vgcca_001", {
    id: "pass_vgcca_001",
    token: "tok_vgcca_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestVgcConservativeAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestVgcConservativeAgent",
    channel: "api",
    status: "active",
    token_id: "pass_vgcca_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_vgcca_001");
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
  evalVisualJudgmentMock.mockResolvedValue(uncertainVerdict());
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  delete process.env.ANTIGEN_HV_DEBUG;
});

/**
 * Element-rich B&BW search-wall shape: many interactive candidates (DOM preserved
 * behind the wall) + a lingering no-progress marker that opens the high-element
 * ambiguous gate + a screen scan that saw a centered modal over a viewport scrim.
 * The geometry probe is INCONCLUSIVE so the DOM classifier declines.
 */
function seedConservativeBbwShape(opts: {
  noProgress?: boolean;
  screenHv?: Partial<ScreenHvWallSignals>;
} = {}) {
  seedSession();
  if (opts.noProgress !== false) recordActionNoProgress(SESSION_ID);
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

describe("retired conservative ambiguous-blocker — scrim + modal + no-progress never mints", () => {
  it("(1) scrim + centered modal + active no-progress + UNCERTAIN model + no opaque boundary → NO mint (200)", async () => {
    seedConservativeBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    // The model is still consulted on the ambiguous (unreadable_dominant_surface) basis;
    // it just no longer grants mint authority on a scrim/no-progress shape.
    expect(evalVisualJudgmentMock).toHaveBeenCalled();
    expect(evalVisualJudgmentMock.mock.calls.at(-1)?.[0]).toMatchObject({
      triggerBasis: "unreadable_dominant_surface",
    });
  });

  it("(1b) model UNAVAILABLE (sidecar down) + scrim/modal + no-progress, no opaque boundary → NO mint (200)", async () => {
    seedConservativeBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(unavailableVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(2) CONFIDENT BENIGN model suppresses — no mint even with scrim + no-progress", async () => {
    seedConservativeBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(benignSuppressVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(3) NO no-progress marker → no mint (200) even with scrim + centered modal", async () => {
    // Low element count opens the ambiguous gate WITHOUT a no-progress marker.
    seedSession();
    const few = [candidate(), candidate({ index: 1 })];
    bundleMock.mockResolvedValueOnce({
      candidates: few,
      hvWallHint: false,
      screenHv: screenHvSignals(),
    });
    seedSnapshot(few);
    ambiguousProbeMock.mockResolvedValueOnce({ ...INCONCLUSIVE_PROBE, near_zero_interactive: true });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(4) CONFIDENT HV model still mints via visual_judgment_promoted_hv (authority path unchanged)", async () => {
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedConservativeBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
    const dbg = res.json().error.hv_debug;
    expect(dbg.reason).toBe("visual_judgment_promoted_hv");
    expect(dbg.visual_judgment_promoted).toBe(true);
    // The retired conservative attribution must no longer appear on any 409.
    expect(dbg.conservative_ambiguous_promoted).toBeUndefined();
  });

  it("(5) confident-HV minted response leaks no unsafe fields", async () => {
    seedConservativeBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(confidentHvVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    assertNoLeak(res.json());
  });

  it("(6) opaque-boundary evidence (inaccessible iframe) + no-progress → STILL mints (ambiguous_fired)", async () => {
    // The retirement only removes the scrim/no-progress-alone path. A genuine opaque
    // cross-origin challenge frame corroborated by a stalled action remains a valid mint.
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedSession();
    recordActionNoProgress(SESSION_ID);
    const many = [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })];
    bundleMock.mockResolvedValueOnce({ candidates: many, hvWallHint: false, screenHv: screenHvSignals() });
    seedSnapshot(many);
    ambiguousProbeMock.mockResolvedValueOnce({
      ...INCONCLUSIVE_PROBE,
      visible_inaccessible_iframe_seen: true,
    });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
    const dbg = res.json().error.hv_debug;
    expect(dbg.reason).toBe("ambiguous_fired");
    expect(dbg.visual_judgment_promoted).toBe(false);
  });

  it("(7a) benign centered modal with NO scrim (e.g. newsletter/hero) + no-progress → no mint", async () => {
    seedConservativeBbwShape({ screenHv: { viewport_scrim_seen: false } });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(7b) scrim with NO centered modal (e.g. cookie bar) + no-progress → no mint", async () => {
    seedConservativeBbwShape({ screenHv: { centered_modal_seen: false } });
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(8) VGC flag OFF → byte-identical 200, no capsule", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "false";
    seedConservativeBbwShape();
    evalVisualJudgmentMock.mockResolvedValueOnce(uncertainVerdict());

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });
});
