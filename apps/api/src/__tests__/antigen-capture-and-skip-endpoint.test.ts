/**
 * POST /api/agent/v1/runtime/browser-snapshot — ANTIGEN_VISION_CAPTURE_AND_SKIP mode.
 *
 * Exploration / data-gathering mode: when the SurfaceBoundaryRouter decides a surface
 * is a `visual_classifier_candidate`, the snapshot AWAITS the existing dataset capture
 * and returns a 422 `ANTIGEN_VISUAL_BLOCKER_CAPTURED` skip signal — never a VGC, never
 * a 409 HUMAN_VERIFICATION_REQUIRED. Normal mode is unchanged.
 *
 * Harness mirrors antigen-browser-snapshot-endpoint.test.ts. The dataset capture
 * module is mocked so we control written/attempted/skipped deterministically.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

const extractMock = vi.hoisted(() => vi.fn());
const pageMetaMock = vi.hoisted(() => vi.fn());
const bundleMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  bundleMock.mockImplementation(async (params: Record<string, unknown>) => {
    const candidates = await extractMock(params);
    let pageMeta: unknown;
    try {
      pageMeta = await pageMetaMock(params);
    } catch {
      pageMeta = undefined;
    }
    return { candidates, ...(pageMeta !== undefined ? { pageMeta } : {}) };
  });
  return {
    ...actual,
    extractAntigenSnapshotCandidatesViaCDP: extractMock,
    extractAntigenPageMetaViaCDP: pageMetaMock,
    extractAntigenSnapshotBundleViaCDP: bundleMock,
  };
});

const liveUrlMock = vi.hoisted(() => vi.fn());
const resolveTargetMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, readLiveCdpPageUrl: liveUrlMock, resolveSnapshotCdpTarget: resolveTargetMock };
});

// Mock the dataset capture so we control written / attempted / skipped outcomes and
// can assert it is (or isn't) awaited. The pipeline stays real.
const captureMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/visualBlockerClassifier/datasetCapture.js", async () => {
  const actual = await vi.importActual<
    typeof import("../runtime/visualBlockerClassifier/datasetCapture.js")
  >("../runtime/visualBlockerClassifier/datasetCapture.js");
  return { ...actual, captureVisionDatasetRecord: captureMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type {
  AntigenSnapshotCandidate,
  ScreenHvWallSignals,
} from "../runtime/antigenSnapshotRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { clearAntigenSnapshotStoreForTests } from "../runtime/antigenSnapshotStore.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { agentDelegations, passes } from "../store/index.js";
import {
  clearVisualGestureCapsulesForTests,
  getActiveVisualGestureCapsuleForBrowserSession,
} from "../runtime/visualGestureCapsule.js";

const BEARER = "Bearer tok_cas_001";
const DELEGATION_ID = "del_cas_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_cas_001";
const URL = "/api/agent/v1/runtime/browser-snapshot";

function makeSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  return {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_cas_001",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: "https://challenge.example.com/protected",
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

function candidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "a",
    kind: "link",
    role: "link",
    name: "Product",
    normalized_name: "product",
    id: null,
    href: "/p/1",
    href_path: "/p/1",
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 12, y: 34, width: 220, height: 48 },
    ...overrides,
  };
}

// 25 overlay-free candidates → a HIGH element count, so the low-element structural
// and ambiguous fallbacks can't open. Only the surface-boundary screen scan drives
// the visual_classifier_candidate, proving the mode does not rely on a low count.
const HIGH_ELEMENT_CANDIDATES: AntigenSnapshotCandidate[] = Array.from({ length: 25 }, (_, i) =>
  candidate({ name: `Product ${i}`, normalized_name: `product ${i}`, href: `/p/${i}`, href_path: `/p/${i}` }),
);

// A scrim + centered DOMINANT surface whose text is NOT extractable → the classifier's
// `unreadable_dominant_surface` route → route_decided === "visual_classifier_candidate".
// `wall: true` would normally mint a VGC; capture-and-skip mode must suppress it.
const UNREADABLE_SURFACE_HV: ScreenHvWallSignals = {
  wall: true,
  challenge_type: "press_and_hold",
  viewport_scrim_seen: true,
  centered_modal_seen: true,
  press_hold_affordance_seen: true,
  hv_phrase_seen: true,
  top_layer_dialog_seen: false,
  dominant_visible_surface_seen: true,
  dominant_visible_surface_kind: "scrim_center_modal",
  dominant_text_extraction_attempted: true,
  dominant_text_extractable: false,
  dominant_text_uninspectable: true,
  dominant_text_source: "none",
  visible_but_semantically_unclassified: true,
  dominant_surface_contains_iframe: false,
  dominant_surface_iframe_text_not_harvested: false,
  unreadable_dominant_surface_seen: true,
};

// A PAGE-LEVEL HV WALL: a full-page terminal blocker DOCUMENT (no scrim, no dominant
// surface, no iframe) where the page itself is the wall. `wall: false` (the no-scrim
// case the screen-HV mint misses), but the strong screen-HV TEXT signals are present.
// Combined with a near-empty page (zero candidates) this drives the new
// `page_level_hv_wall` route → route_decided === "visual_classifier_candidate".
const PAGE_LEVEL_WALL_HV: ScreenHvWallSignals = {
  wall: false,
  viewport_scrim_seen: false,
  centered_modal_seen: true,
  press_hold_affordance_seen: true,
  hv_phrase_seen: true,
  top_layer_dialog_seen: false,
  dominant_visible_surface_seen: false,
  dominant_visible_surface_kind: "unknown",
  dominant_text_extraction_attempted: false,
  dominant_text_extractable: false,
  dominant_text_uninspectable: false,
  dominant_text_source: "none",
  visible_but_semantically_unclassified: false,
  dominant_surface_contains_iframe: false,
  dominant_surface_iframe_text_not_harvested: false,
  unreadable_dominant_surface_seen: false,
};

// A normal page: no scrim, no dominant surface → route_decided !== candidate.
const NO_SURFACE_HV: ScreenHvWallSignals = {
  wall: false,
  viewport_scrim_seen: false,
  centered_modal_seen: false,
  press_hold_affordance_seen: false,
  hv_phrase_seen: false,
  top_layer_dialog_seen: false,
  dominant_visible_surface_seen: false,
  dominant_visible_surface_kind: "unknown",
  dominant_text_extraction_attempted: false,
  dominant_text_extractable: false,
  dominant_text_uninspectable: false,
  dominant_text_source: "none",
  visible_but_semantically_unclassified: false,
  dominant_surface_contains_iframe: false,
  dominant_surface_iframe_text_not_harvested: false,
  unreadable_dominant_surface_seen: false,
};

// An INSPECTABLE scrim+centered surface that DID yield text → dom_semantic_candidate
// (a different route — must NOT trigger capture-and-skip).
const DOM_SEMANTIC_HV: ScreenHvWallSignals = {
  ...UNREADABLE_SURFACE_HV,
  wall: false,
  dominant_text_extractable: true,
  dominant_text_uninspectable: false,
  unreadable_dominant_surface_seen: false,
  visible_but_semantically_unclassified: false,
};

let server: FastifyInstance;

beforeAll(async () => {
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_cas_001", {
    id: "pass_cas_001",
    token: "tok_cas_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestCasAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestCasAgent",
    channel: "api",
    status: "active",
    token_id: "pass_cas_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_cas_001");
  agentDelegations.delete(DELEGATION_ID);
});

const FLAG_KEYS = [
  "ANTIGEN_HUMAN_VERIFICATION",
  "ANTIGEN_VISUAL_GESTURE_CAPSULE",
  "ANTIGEN_HV_VISION_CLASSIFIER",
  "ANTIGEN_HV_VISION_DATASET",
  "ANTIGEN_VISION_CAPTURE_AND_SKIP",
] as const;
const prevFlags: Record<string, string | undefined> = {};

beforeEach(() => {
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearVisualGestureCapsulesForTests();
  vi.clearAllMocks();
  extractMock.mockResolvedValue(HIGH_ELEMENT_CANDIDATES);
  pageMetaMock.mockResolvedValue(undefined);
  liveUrlMock.mockResolvedValue(null);
  resolveTargetMock.mockResolvedValue(null);
  captureMock.mockResolvedValue({ written: true });
  for (const k of FLAG_KEYS) prevFlags[k] = process.env[k];
});

afterEach(() => {
  clearVisualGestureCapsulesForTests();
  for (const k of FLAG_KEYS) {
    if (prevFlags[k] === undefined) delete process.env[k];
    else process.env[k] = prevFlags[k];
  }
});

function enableExplorationMode(): void {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  process.env.ANTIGEN_HV_VISION_CLASSIFIER = "true";
  process.env.ANTIGEN_HV_VISION_DATASET = "true";
  process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP = "true";
}

async function snapshot() {
  return server.inject({
    method: "POST",
    url: URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
  });
}

describe("browser-snapshot — capture-and-skip exploration mode", () => {
  it("flag OFF → behavior unchanged: a visual_classifier_candidate returns a normal 200, no capture awaited", async () => {
    // HV + classifier + dataset on, but VGC off and capture-and-skip OFF → shadow only.
    process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
    process.env.ANTIGEN_HV_VISION_CLASSIFIER = "true";
    process.env.ANTIGEN_HV_VISION_DATASET = "true";
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "false";
    delete process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP;
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    // Normal dataset mode is fire-and-forget — not the awaited exploration path.
    // (capture may be scheduled fire-and-forget; the response must be a normal 200.)
    expect(res.json().error?.code).toBeUndefined();
  });

  it("ON + visual_classifier_candidate + capture written → 422 with capture_written", async () => {
    enableExplorationMode();
    captureMock.mockResolvedValueOnce({ written: true });
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ANTIGEN_VISUAL_BLOCKER_CAPTURED");
    expect(body.error.blocker_status).toBe("capture_written");
    expect(body.error.suggested_agent_action).toBe("skip_and_continue");
    expect(body.error.trigger_basis).toBe("unreadable_dominant_surface");
    expect(body.error.candidate_reason).toBe("unreadable_dominant_surface");
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it("ON + capture failure (write_failed) → 422 with capture_attempted", async () => {
    enableExplorationMode();
    captureMock.mockResolvedValueOnce({ written: false, skip_reason: "write_failed" });
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.blocker_status).toBe("capture_attempted");
  });

  it("ON + capture rejects → still 422 (capture_attempted), blocker is present", async () => {
    enableExplorationMode();
    captureMock.mockRejectedValueOnce(new Error("boom"));
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_VISUAL_BLOCKER_CAPTURED");
    expect(res.json().error.blocker_status).toBe("capture_attempted");
  });

  it("ON + throttled/rate_limited capture → still 422 (capture_skipped), no duplicate record", async () => {
    enableExplorationMode();
    captureMock.mockResolvedValueOnce({ written: true }); // first write lands
    captureMock.mockResolvedValueOnce({ written: false, skip_reason: "rate_limited" }); // second throttled
    seedSession();

    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });
    const first = await snapshot();
    expect(first.statusCode).toBe(422);
    expect(first.json().error.blocker_status).toBe("capture_written");

    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });
    const second = await snapshot();
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe("ANTIGEN_VISUAL_BLOCKER_CAPTURED");
    expect(second.json().error.blocker_status).toBe("capture_skipped");
  });

  it("ON + legacy HV/VGC condition also true → suppresses VGC, returns 422 (no 409, no capsule)", async () => {
    enableExplorationMode();
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true"; // would normally mint a VGC
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_VISUAL_BLOCKER_CAPTURED");
    // No VGC minted for this session.
    expect(getActiveVisualGestureCapsuleForBrowserSession(SESSION_ID)).toBeUndefined();
    // Never the human-verification 409 shape.
    expect(res.statusCode).not.toBe(409);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("HUMAN_VERIFICATION_REQUIRED");
    expect(raw).not.toContain("visual_gesture_capsule");
  });

  it("ON + page-level HV wall (no scrim, zero elements) → 422 page_level_hv_wall, VGC suppressed", async () => {
    enableExplorationMode();
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true"; // would normally mint; must be suppressed
    captureMock.mockResolvedValueOnce({ written: true });
    seedSession();
    // Zero candidates → page_appears_unusable true. The full-page terminal wall.
    bundleMock.mockResolvedValueOnce({ candidates: [], screenHv: PAGE_LEVEL_WALL_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("ANTIGEN_VISUAL_BLOCKER_CAPTURED");
    expect(body.error.trigger_basis).toBe("page_level_hv_wall");
    expect(body.error.candidate_reason).toBe("page_level_hv_wall");
    expect(body.error.blocker_status).toBe("capture_written");
    // No VGC, no 409 — capture-and-skip wins.
    expect(getActiveVisualGestureCapsuleForBrowserSession(SESSION_ID)).toBeUndefined();
    expect(res.statusCode).not.toBe(409);
    expect(JSON.stringify(body)).not.toContain("HUMAN_VERIFICATION_REQUIRED");
  });

  it("ON + ordinary zero-element page without HV text → no 422, normal 200 (page_wall_attempted is not a trigger)", async () => {
    enableExplorationMode();
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // Zero candidates (page_appears_unusable + page_wall_attempted both true) but NO
    // screen-HV text → must NOT become a page_level_hv_wall candidate.
    bundleMock.mockResolvedValueOnce({ candidates: [], screenHv: NO_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("ON + non-candidate route (normal page) → no 422, normal 200", async () => {
    enableExplorationMode();
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: NO_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("ON + dom_semantic_candidate (inspectable surface) → no 422, no capture", async () => {
    enableExplorationMode();
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: DOM_SEMANTIC_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("422 skip response contains no unsafe fields", async () => {
    enableExplorationMode();
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: HIGH_ELEMENT_CANDIDATES, screenHv: UNREADABLE_SURFACE_HV });

    const res = await snapshot();
    expect(res.statusCode).toBe(422);
    const raw = JSON.stringify(res.json());
    for (const forbidden of [
      "png_base64",
      "base64",
      "\"box\"",
      "\"x\":",
      "\"y\":",
      "cdp_url",
      "user_data_dir",
      "9222",
      "target_id",
      "secret_ref",
      "frame.png",
      "meta.json",
      "candidate_id",
      "challenge.example.com",
      "/protected",
      "challenge_type",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
