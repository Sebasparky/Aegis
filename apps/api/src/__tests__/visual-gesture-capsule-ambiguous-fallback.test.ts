/**
 * Visual Gesture Capsule — ambiguous visual-obstruction fallback.
 *
 * Live failure mode (Bath & Body Works): the visible browser showed an opaque
 * "Press & Hold" / denial wall, but the structural HV wall probe returned null
 * (the control lived in a cross-origin iframe / the page churned refs), so Antigen
 * finalized a flat ANTIGEN_REF_STALE / zero-ref / inconclusive stop instead of
 * escalating to user-presence review.
 *
 * This suite covers the conservative fallback that, when VGC is on + a live
 * session exists + a CONCRETE static obstruction signal is present, mints a
 * Visual Gesture Capsule and returns safe user-presence metadata — without
 * requiring wall.page_level === true.
 *
 * Two integration points:
 *  - the stale-ref action backstop (browser-click), and
 *  - the snapshot endpoint's no-structural-wall branch.
 *
 * Plus the pure classifier truth table (the over-fire guard).
 *
 * Hermetic: realistic click, both CDP probes, the snapshot bundle, the CDP target
 * resolver, and the VGC redacted-capture helper are mocked — no real browser.
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
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return { ...actual, realisticClickKnownBox: clickKnownBoxMock, realisticClickByDescription: clickByDescriptionMock };
});

// Mock the structural wall probe (null by default), the booleans-only ambiguous
// probe, AND the snapshot bundle — everything else in the module (the REAL
// classifyAmbiguousVisualObstruction) stays live.
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

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession } from "@aegis/types";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import { classifyAmbiguousVisualObstruction } from "../runtime/antigenSnapshotRuntime.js";
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

const BEARER = "Bearer tok_vgcamb_001";
const DELEGATION_ID = "del_vgcamb_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_vgcamb_001";
const CLICK_URL = "/api/agent/v1/runtime/browser-click";
const SNAPSHOT_URL = "/api/agent/v1/runtime/browser-snapshot";
const PAGE_URL = "https://www.example-shop.com/p/some-product";

function seedSession(overrides: Partial<TaskBrowserSession> = {}): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-tbsess_vgcamb_001",
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

function clickStaleProductRef() {
  return server.inject({
    method: "POST",
    url: CLICK_URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", element: "Some Product" },
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

const PRESS_AND_HOLD_WALL = {
  human_verification: true as const,
  hv_challenge_type: "press_and_hold" as const,
  user_presence_required: true as const,
  blocking: true as const,
  page_level: true as const,
};

const CAPTURE_OK = {
  ok: true as const,
  capsule_id: "ignored",
  screenshot_available: true as const,
  screenshot_captured_at: new Date().toISOString(),
  screenshot_expires_at: new Date(Date.now() + 45_000).toISOString(),
};
const CAPTURE_FAIL = { ok: false as const, reason: "capture_failed" as const };

/** Faithful capture mock — stores a redacted frame so the safe view's
 * screenshot_available is exercised end-to-end (mirrors the real helper). */
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

/** Recursively collect every object key in a JSON value. */
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
  "path",
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
  passes.set("pass_vgcamb_001", {
    id: "pass_vgcamb_001",
    token: "tok_vgcamb_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestVgcAmbiguousAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestVgcAmbiguousAgent",
    channel: "api",
    status: "active",
    token_id: "pass_vgcamb_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.ready();
});

afterAll(() => {
  server.close();
  passes.delete("pass_vgcamb_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearAllActiveHumanVerificationForTests();
  clearAllActionNoProgressForTests();
  clearVisualGestureCapsulesForTests();
  humanVerificationRequests.clear();
  vi.clearAllMocks();
  resolveTargetMock.mockResolvedValue({
    browserWsUrl: "ws://localhost:9222/devtools/browser/abc",
    target: { id: "TARGET_1", url: PAGE_URL },
  });
  liveUrlMock.mockResolvedValue(PAGE_URL);
  hvWallProbeMock.mockResolvedValue(null);
  ambiguousProbeMock.mockResolvedValue(null);
  clickKnownBoxMock.mockResolvedValue({ success: false, error: "ANTIGEN_REF_STALE" });
  bundleMock.mockResolvedValue({ candidates: [], hvWallHint: false });
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  delete process.env.ANTIGEN_HV_DEBUG;
  delete process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP;
});

// ── Pure classifier truth table (the over-fire guard) ─────────────────────────
describe("classifyAmbiguousVisualObstruction — pure verdict", () => {
  it("returns false on empty / garbage input", () => {
    expect(classifyAmbiguousVisualObstruction(undefined)).toBe(false);
    expect(classifyAmbiguousVisualObstruction(null)).toBe(false);
    expect(classifyAmbiguousVisualObstruction({})).toBe(false);
  });

  it("denial text alone fires", () => {
    expect(classifyAmbiguousVisualObstruction({ denial_text_seen: true })).toBe(true);
  });

  it("near-zero interactive alone does NOT fire", () => {
    expect(classifyAmbiguousVisualObstruction({ near_zero_interactive: true })).toBe(false);
  });

  it("near-zero interactive + inaccessible iframe fires", () => {
    expect(
      classifyAmbiguousVisualObstruction({
        near_zero_interactive: true,
        visible_inaccessible_iframe_seen: true,
      }),
    ).toBe(true);
  });

  it("inaccessible iframe alone does NOT fire", () => {
    expect(classifyAmbiguousVisualObstruction({ visible_inaccessible_iframe_seen: true })).toBe(false);
  });

  it("inaccessible iframe + repeated stale fires", () => {
    expect(
      classifyAmbiguousVisualObstruction({
        visible_inaccessible_iframe_seen: true,
        repeated_stale: true,
      }),
    ).toBe(true);
  });

  it("repeated stale ALONE never fires (the over-fire guard)", () => {
    expect(classifyAmbiguousVisualObstruction({ repeated_stale: true })).toBe(false);
  });

  // ── Geometry signals (the B&BW DOM-textless overlay shape) ──
  // The discriminator is the obstructive dimmer/backdrop (viewport_scrim_seen) or an
  // opaque cross-origin frame (visible_inaccessible_iframe_seen). A large centered
  // overlay / pointer interceptor is produced just as readily by a benign marketing
  // hero, so neither fires on its own — only WITH a scrim/iframe shape (which already
  // carries its own fire path).
  it("viewport scrim + repeated stale fires (the real dimmer/backdrop)", () => {
    expect(
      classifyAmbiguousVisualObstruction({
        viewport_scrim_seen: true,
        repeated_stale: true,
      }),
    ).toBe(true);
  });

  it("large centered overlay + repeated stale alone does NOT fire (a benign marketing hero)", () => {
    expect(
      classifyAmbiguousVisualObstruction({
        large_centered_overlay_seen: true,
        repeated_stale: true,
      }),
    ).toBe(false);
    // …but the SAME overlay over a dimmer/backdrop fires via the scrim marker.
    expect(
      classifyAmbiguousVisualObstruction({
        large_centered_overlay_seen: true,
        viewport_scrim_seen: true,
        repeated_stale: true,
      }),
    ).toBe(true);
  });

  it("pointer interceptor + repeated stale alone does NOT fire (a hero occludes the center too)", () => {
    expect(
      classifyAmbiguousVisualObstruction({
        pointer_interceptor_seen: true,
        repeated_stale: true,
      }),
    ).toBe(false);
    // …but with an opaque cross-origin frame it fires via the iframe marker.
    expect(
      classifyAmbiguousVisualObstruction({
        pointer_interceptor_seen: true,
        visible_inaccessible_iframe_seen: true,
        repeated_stale: true,
      }),
    ).toBe(true);
  });

  it("the obstruction markers WITHOUT repeated stale do NOT fire (corroborator discipline)", () => {
    expect(classifyAmbiguousVisualObstruction({ viewport_scrim_seen: true })).toBe(false);
    expect(classifyAmbiguousVisualObstruction({ visible_inaccessible_iframe_seen: true })).toBe(false);
    // …and the benign geometry signals never fire regardless of repeated_stale.
    expect(classifyAmbiguousVisualObstruction({ large_centered_overlay_seen: true })).toBe(false);
    expect(classifyAmbiguousVisualObstruction({ pointer_interceptor_seen: true })).toBe(false);
  });

  it("top-layer dialog is diagnostic-only — never fires even with repeated stale", () => {
    expect(
      classifyAmbiguousVisualObstruction({
        top_layer_dialog_seen: true,
        repeated_stale: true,
      }),
    ).toBe(false);
  });
});

// ── Stale-ref action backstop (browser-click) ─────────────────────────────────
describe("ambiguous fallback — stale-ref action backstop", () => {
  it("(1) explicit page_level wall still mints a VGC; the ambiguous probe is not consulted", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.capsule_id).toMatch(/^vgc_/);
    // The structural wall path handled it — the ambiguous probe never ran.
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(2) zero-ref denial state with VGC OFF stays ANTIGEN_REF_STALE, no probe, no capsule", async () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    seedSession();
    seedSnapshot([candidate()]);
    // Even if the page WERE blocked, the disabled feature never probes.
    ambiguousProbeMock.mockResolvedValue({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: true,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(3) denial text + VGC ON mints a VGC and returns HUMAN_VERIFICATION_REQUIRED", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: false,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.purchase_authorized).toBe(false);
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.status).toBe("awaiting_user_gesture");
    expect(body.error.visual_gesture_capsule.capsule.screenshot_available).toBe(true);
    expect(ambiguousProbeMock).toHaveBeenCalledTimes(1);
    expect(hvWallProbeMock).toHaveBeenCalledTimes(1); // structural probe ran first and ruled out
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(4) overlay-on-normal-page: refs exist, stale, no page_level — iframe + repeated stale fires a VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    // No denial text, page not near-empty — only a visible inaccessible iframe.
    // The stale-ref branch supplies repeated_stale:true → fires.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(5) repeated stale WITHOUT any static signal does NOT mint a VGC (normal churn)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    // The probe found nothing concrete — page churn / carousel ref invalidation.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(6) DOM-visible control_box relay (non-page_level wall) is unchanged and mints no VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    // A relay-targetable checkbox challenge — truthy wall, not page_level.
    hvWallProbeMock.mockResolvedValueOnce({
      human_verification: true as const,
      hv_challenge_type: "checkbox_human" as const,
      user_presence_required: true as const,
      blocking: true as const,
      page_level: false as const,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error).not.toHaveProperty("visual_gesture_capsule");
    // Wall was truthy → the !wall ambiguous branch was never entered.
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(7) HV-absent healthy page (successful click) never probes and never mints a VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({
      success: true,
      pointer_start_source: "session",
      pointer_path_point_count: 6,
      pointer_state_persisted: true,
      current_url: PAGE_URL,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(200);
    expect(hvWallProbeMock).not.toHaveBeenCalled();
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(8) capture failure preserves the stop response with screenshot_available:false", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: false,
    });
    vgcCaptureMock.mockResolvedValueOnce(CAPTURE_FAIL);

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.screenshot_available).toBe(false);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(9) the 409 body leaks no bytes/coords/viewport/cdp/strategy/session keys", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();
    assertNoLeak(res.json());
  });

  it("a probe transport error on the stale branch fails OPEN to ANTIGEN_REF_STALE", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockRejectedValueOnce(new Error("CDP boom"));

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ANTIGEN_REF_STALE");
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });
});

// ── No-progress action backstop (non-stale realization failures) ──────────────
//
// The live B&BW regression: the click failed with success=false but did NOT
// classify as a stale ref — it landed on the generic REALISTIC_CLICK_FAILED
// branch, which previously returned 422 WITHOUT consulting the HV/ambiguous
// backstop. These cases prove the backstop now reaches that branch too.
describe("ambiguous fallback — no-progress (non-stale) action backstop", () => {
  it("(1) REALISTIC_CLICK_FAILED + inaccessible iframe + VGC ON mints a VGC (the live overlay-over-normal-page shape)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // Many refs — a normal underlying page (B&BW had element_count=27).
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    // Click physically fails to realize, but NOT as a stale ref.
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.visual_gesture_capsule.available).toBe(true);
    expect(ambiguousProbeMock).toHaveBeenCalledTimes(1);
    expect(hvWallProbeMock).toHaveBeenCalledTimes(1); // structural probe ran first and ruled out
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(2) REALISTIC_CLICK_FAILED with NO static signal preserves the original 422 (no fire on click-failure alone)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    // Probe finds nothing concrete — no iframe, no denial. Repeated/no-progress
    // alone must never fire.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REALISTIC_CLICK_FAILED");
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(3) REALISTIC_CLICK_FAILED + large centered overlay WITH a dimmer/scrim (DOM-textless) + VGC ON mints a VGC (live B&BW shape)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // Many refs still extractable — the modal text is NOT in the accessible DOM, so
    // denial_text/iframe/near_zero are all false. The real B&BW press-and-hold wall is
    // a centered overlay OVER A FULL-VIEWPORT DIMMER, so viewport_scrim_seen is the
    // obstructive corroborator that distinguishes it from a benign marketing hero.
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: true,
      viewport_scrim_seen: true,
      pointer_interceptor_seen: false,
      top_layer_dialog_seen: false,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.purchase_authorized).toBe(false);
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(ambiguousProbeMock).toHaveBeenCalledTimes(1);
    expect(hvWallProbeMock).toHaveBeenCalledTimes(1); // structural probe ran first and ruled out
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(3b) REALISTIC_CLICK_FAILED + benign marketing hero (large centered overlay, NO scrim/iframe/top-layer/broad-occlusion) does NOT mint a VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // The B&BW homepage/search false-positive: a normal hero / sale carousel is large,
    // centered, and fixed/absolute, so large_centered_overlay_seen fires — but there is
    // NO obstructive corroborator (no dimmer, no opaque iframe, not a :modal, and after
    // the probe tightening it no longer trips broad pointer occlusion). It must surface
    // the original 422, never mint a VGC.
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: true,
      viewport_scrim_seen: false,
      pointer_interceptor_seen: false,
      top_layer_dialog_seen: false,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REALISTIC_CLICK_FAILED");
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(3c) REALISTIC_CLICK_FAILED + large overlay + broad pointer occlusion but NO scrim/iframe does NOT mint (geometry alone can't tell a hero from a wall)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // A large centered overlay that also intercepts the sampled points is exactly the
    // shape a benign marketing hero produces, so geometry alone (no dimmer/backdrop,
    // no opaque iframe) must NOT mint — it surfaces the original 422. Real walls of
    // this class also paint a scrim/iframe (see case 3) and are still caught there.
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: true,
      viewport_scrim_seen: false,
      pointer_interceptor_seen: true,
      top_layer_dialog_seen: false,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REALISTIC_CLICK_FAILED");
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(4) viewport scrim alone (no overlay/iframe/denial) + click no-progress mints a VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: false,
      viewport_scrim_seen: true,
      pointer_interceptor_seen: false,
      top_layer_dialog_seen: false,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(5) top-layer dialog ONLY (legit modal, no overlay/scrim/interceptor) does NOT mint a VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    // A :modal dialog is present but it is NOT classified as a blocking overlay — a
    // legit product modal. top_layer_dialog_seen is diagnostic-only and never fires alone.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: false,
      viewport_scrim_seen: false,
      pointer_interceptor_seen: false,
      top_layer_dialog_seen: true,
    });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REALISTIC_CLICK_FAILED");
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(6) geometry-fired 409 body leaks no bytes/coords/viewport/cdp/strategy/session keys", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: true,
      viewport_scrim_seen: true,
      pointer_interceptor_seen: true,
      top_layer_dialog_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();
    assertNoLeak(res.json());
  });

  it("REALISM_DISABLED is NOT a no-progress code — it never probes (config failure, not a visual block)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISM_DISABLED" });

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REALISM_DISABLED");
    expect(hvWallProbeMock).not.toHaveBeenCalled();
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });
});

// ── Snapshot endpoint no-structural-wall branch ───────────────────────────────
describe("ambiguous fallback — snapshot endpoint", () => {
  it("(3-snap) zero-ref access-denied + VGC ON fails closed with HUMAN_VERIFICATION_REQUIRED + a minted VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // Zero extracted candidates → the full-denial shape (<= PAGE_HV_PROBE_MAX).
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    // A freshly minted capsule fails the snapshot closed (409) — the SAME shape the
    // action-triggered path emits — so the user can relay the gesture immediately.
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.request_id).toMatch(/^hvr_/);
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.screenshot_available).toBe(true);
    expect(ambiguousProbeMock).toHaveBeenCalledTimes(1);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(2-snap) zero-ref denial state with VGC OFF is unchanged — no probe, no vgc field", async () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValue({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: true,
    });

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).not.toHaveProperty("visual_gesture_capsule");
    expect(data).not.toHaveProperty("human_verification");
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(7-snap) healthy element-rich page never probes and never mints a VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // Many candidates and no hint → the probe gate is not tripped.
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("visual_gesture_capsule");
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(9-snap) snapshot response leaks no bytes/coords/viewport/cdp/strategy/session keys", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();
    assertNoLeak(res.json());
  });

  // ── Part D: high-element probing only on a corroborating no-progress marker ──
  it("(3-snap-D) many elements, no hint, NO no-progress marker → ambiguous probe is NOT run", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });
    // A concrete signal IS present, but with no corroborating marker the
    // high-element gate stays closed — a healthy page must pay nothing.
    ambiguousProbeMock.mockResolvedValue({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: true,
    });

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("visual_gesture_capsule");
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(4-snap-D) many elements + recent no-progress marker + inaccessible iframe → probes and mints a VGC", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // A prior action failed to realize (overlay over a normal page) — the marker
    // opens the high-element ambiguous gate the element_count alone would skip.
    recordActionNoProgress(SESSION_ID);
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });
    // High element_count → near_zero_interactive is false; the marker supplies
    // repeated_stale → iframe + repeated_stale fires.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    // Minted capsule → fail closed with 409 (was 200 before the snapshot-time fix).
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(ambiguousProbeMock).toHaveBeenCalledTimes(1);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(4b-snap-D) marker present but probe finds no static signal → no VGC (repeated/no-progress alone never fires)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    recordActionNoProgress(SESSION_ID);
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
    });

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("visual_gesture_capsule");
    // The gate opened (marker present) so the probe ran, but the classifier held.
    expect(ambiguousProbeMock).toHaveBeenCalledTimes(1);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  // ── Structural page-level wall at snapshot time (the full-page denied fix) ─────
  it("(structural-snap) page-level wall at snapshot mints a VGC + fails closed with 409 (ambiguous probe not consulted)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    // Zero candidates — the full-page "Access denied" / press-and-hold shape whose
    // control lives in a cross-origin iframe.
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(body.error.challenge_type).toBe("press_and_hold");
    expect(body.error.user_presence_required).toBe(true);
    expect(body.error.purchase_authorized).toBe(false);
    expect(body.error.visual_gesture_capsule.available).toBe(true);
    expect(body.error.visual_gesture_capsule.capsule.capsule_id).toMatch(/^vgc_/);
    expect(body.error.visual_gesture_capsule.capsule.screenshot_available).toBe(true);
    // The structural wall path handled it — the ambiguous probe never ran.
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(structural-snap-off) page-level wall at snapshot with VGC OFF stays 200 + synthesized surface, no capsule", async () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);

    const res = await snapshot();

    // VGC off → no mint → existing 200 synthesized-surface behavior (byte-identical).
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.recommended_next_step).toBe("human_presence_relay_required");
    expect(data.page_level_human_verification).toBe(true);
    expect(data.human_verification.user_presence_required).toBe(true);
    expect(data).not.toHaveProperty("visual_gesture_capsule");
    expect(
      (data.active_surfaces ?? []).some((s: { surface_id?: string }) => s.surface_id === "surf_hv_page"),
    ).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(structural-snap-leak) the 409 structural-wall body leaks no bytes/coords/viewport/cdp/session keys", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();
    assertNoLeak(res.json());
  });

  it("(empty-snap) ordinary empty page (no wall, no denial) returns 200 element_count 0 and mints nothing", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(null);
    // The gate opens (near-zero candidates) so the probe runs, but with no denial /
    // iframe / geometry signal the classifier holds — and repeated_stale is NOT set
    // at snapshot time (no action failed), so nothing mints.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: false,
      viewport_scrim_seen: false,
      pointer_interceptor_seen: false,
      top_layer_dialog_seen: false,
    });

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.element_count).toBe(0);
    expect(data.elements).toEqual([]);
    expect(data).not.toHaveProperty("visual_gesture_capsule");
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });
});

// ── Snapshot HV/VGC 409 attribution (ANTIGEN_HV_DEBUG) ────────────────────────
// Phase 1 telemetry: every snapshot-minted (or reused) 409 carries a sanitized
// `hv_debug` reason so the next healthy-/cart false positive is self-attributing.
// Detection behavior is unchanged — these assert ONLY the added telemetry and that
// it is absent / byte-identical when the flag is off, with no raw leaks.
describe("snapshot HV 409 attribution (ANTIGEN_HV_DEBUG)", () => {
  // A real obstruction shape: high-element page + a lingering no-progress marker
  // (synthetic repeated_stale) + a dimmer/backdrop scrim. The telemetry must name it:
  // ambiguous_fired, repeated_stale_source=no_progress_marker, geometry_strength=strong.
  it("attributes a real scrim-backed ambiguous mint when the flag is on", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedSession();
    recordActionNoProgress(SESSION_ID);
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });
    // A full-viewport dimmer/backdrop over a preserved page — the obstruction marker
    // that distinguishes a real wall from a benign hero. Fires via the scrim path.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: true,
      viewport_scrim_seen: true,
      pointer_interceptor_seen: true,
      top_layer_dialog_seen: false,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    const dbg = res.json().error.hv_debug;
    expect(dbg).toMatchObject({
      scope: "snapshot_hv",
      tool: "antigen_snapshot",
      returned_409: true,
      reason: "ambiguous_fired",
      structural_wall_seen: false,
      ambiguous_considered: true,
      created_capsule: true,
      no_progress_signal: true,
      repeated_stale_source: "no_progress_marker",
      geometry_strength: "strong",
      viewport_scrim_seen: true,
      denial_text_seen: false,
      visible_inaccessible_iframe_seen: false,
    });
    // Bucket, never a raw count.
    expect(dbg.element_count_bucket).toBe("4-20");
    expect(dbg).not.toHaveProperty("element_count");
  });

  it("the lone-pointer /cart false positive is now FIXED — high-element page + no-progress marker + lone pointer interceptor returns 200, no capsule", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedSession();
    recordActionNoProgress(SESSION_ID);
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });
    // The suspected false-positive shape: a lone pointer interceptor (a sticky header /
    // marketing hero on an otherwise-healthy page). With no scrim/iframe marker it must
    // no longer mint — the snapshot proceeds normally.
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: true,
      viewport_scrim_seen: false,
      pointer_interceptor_seen: true,
      top_layer_dialog_seen: false,
    });

    const res = await snapshot();

    expect(res.statusCode).toBe(200);
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("attributes the structural page-level wall mint", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.hv_debug).toMatchObject({
      scope: "snapshot_hv",
      reason: "structural_page_level_wall",
      structural_wall_seen: true,
      page_level: true,
      ambiguous_considered: false,
      created_capsule: true,
    });
  });

  it("attributes the pre-extract reuse guard on the SECOND snapshot", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedSession();
    // First snapshot mints a capsule (structural wall).
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());
    const first = await snapshot();
    expect(first.statusCode).toBe(409);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);

    // Second snapshot short-circuits in the pre-extract guard — page state is never
    // inspected; the reason names the reuse, not a fresh mint.
    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.hv_debug).toMatchObject({
      scope: "hv_active_guard",
      tool: "antigen_snapshot",
      reason: "reused_existing_capsule",
      reused_existing_capsule: true,
      created_capsule: false,
    });
    // The reuse path does not re-run the page probe.
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
  });

  it("emits NO hv_debug when the flag is off (byte-identical 409 body)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    // ANTIGEN_HV_DEBUG intentionally unset.
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).not.toHaveProperty("hv_debug");
  });

  it("a 409 carrying hv_debug still leaks no bytes/coords/viewport/cdp/session keys", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedSession();
    recordActionNoProgress(SESSION_ID);
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: false,
      large_centered_overlay_seen: true,
      viewport_scrim_seen: true,
      pointer_interceptor_seen: true,
      top_layer_dialog_seen: false,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.hv_debug).toBeDefined();
    assertNoLeak(res.json());
  });
});

// ── ALWAYS-PRESENT human_verification_attribution (every 409 return path) ──────
// Unlike hv_debug (flag-gated dev telemetry), `human_verification_attribution` is
// present on EVERY HUMAN_VERIFICATION_REQUIRED 409 regardless of env flags, so every
// 409 self-identifies its source path and whether a fresh visual judgment event is
// expected. These assert ONLY the additive attribution — status code stays 409 and
// existing top-level fields are unchanged — and that attribution leaks nothing.
describe("human_verification_attribution (always present, every source)", () => {
  it("snapshot mint → source snapshot_mint_visual_judgment, fresh judgment expected", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    // Flag intentionally OFF — attribution must still be present.
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await snapshot();

    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    // Existing top-level fields unchanged.
    expect(err.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(err.user_presence_required).toBe(true);
    expect(err.purchase_authorized).toBe(false);
    // Always present even with the debug flag off.
    expect(err).not.toHaveProperty("hv_debug");
    expect(err.human_verification_attribution).toMatchObject({
      source: "snapshot_mint_visual_judgment",
      visual_judgment_coverage: "fresh_judgment_possible",
      fresh_visual_judgment_event_expected: true,
    });
    assertNoLeak(res.json());
  });

  it("VGC reuse guard (second snapshot) → source vgc_capsule_reuse_guard, no fresh judgment", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());
    const first = await snapshot();
    expect(first.statusCode).toBe(409);
    expect(first.json().error.human_verification_attribution.source).toBe(
      "snapshot_mint_visual_judgment",
    );

    // Second snapshot short-circuits in the pre-extract reuse guard.
    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.human_verification_attribution).toMatchObject({
      source: "vgc_capsule_reuse_guard",
      visual_judgment_coverage: "not_covered_reused_existing_state",
      fresh_visual_judgment_event_expected: false,
    });
    assertNoLeak(res.json());
  });

  it("ambiguous no-progress backstop (click) → source action_no_progress_ambiguous_backstop", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: false,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.human_verification_attribution).toMatchObject({
      source: "action_no_progress_ambiguous_backstop",
      visual_judgment_coverage: "not_covered_action_backstop",
      fresh_visual_judgment_event_expected: false,
    });
    assertNoLeak(res.json());
  });

  it("structural no-progress backstop (click) → source action_no_progress_structural_backstop", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.human_verification_attribution).toMatchObject({
      source: "action_no_progress_structural_backstop",
      visual_judgment_coverage: "not_covered_action_backstop",
      fresh_visual_judgment_event_expected: false,
    });
    // The ambiguous probe never ran — structural wall handled it.
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
    assertNoLeak(res.json());
  });

  it("attribution adds no unsafe fields and is byte-safe when the debug flag is off", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    seedSnapshot([candidate()]);
    ambiguousProbeMock.mockResolvedValueOnce({
      denial_text_seen: true,
      near_zero_interactive: true,
      visible_inaccessible_iframe_seen: true,
    });
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();
    expect(res.statusCode).toBe(409);
    const attribution = res.json().error.human_verification_attribution;
    // Only the safe attribution keys may appear.
    const allowed = new Set([
      "source",
      "visual_judgment_coverage",
      "fresh_visual_judgment_event_expected",
      "reason",
      "trigger_basis",
      "visual_judgment_ran",
      "visual_judgment_outcome",
      "visual_judgment_suppress",
    ]);
    for (const key of Object.keys(attribution)) {
      expect(allowed.has(key), `unexpected attribution key "${key}"`).toBe(true);
    }
    // reason is a short fixed prose string — never a URL/selector/coordinate.
    expect(typeof attribution.reason).toBe("string");
    expect(attribution.reason).not.toMatch(/https?:|:\/\/|<|>|\{|\}|px\b|\bref_|selector|\d{3,}/);
    assertNoLeak(res.json());
  });
});

// ── Stale cross-origin VGC reuse must not poison an unrelated later page ───────
// Regression for the attribution-QA finding: a capsule minted on one origin (e.g.
// etsy.com) kept returning 409 vgc_capsule_reuse_guard on a later, unrelated page
// (e.g. example.com) reached in the SAME browser session. The reuse guard now
// terminalizes a stale cross-origin capsule (current page origin != minted origin)
// and lets the new page proceed; same-origin reuse is unchanged.
describe("VGC reuse guard — stale cross-origin invalidation", () => {
  function sessionCapsules() {
    return listActiveVisualGestureCapsules().filter((c) => c.browser_session_id === SESSION_ID);
  }

  async function mintCapsuleOnPageUrl() {
    // First snapshot detects an opaque wall on PAGE_URL (www.example-shop.com) and
    // mints a Visual Gesture Capsule bound to that origin.
    bundleMock.mockResolvedValueOnce({ candidates: [], hvWallHint: false });
    hvWallProbeMock.mockResolvedValueOnce(PRESS_AND_HOLD_WALL);
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());
    const first = await snapshot();
    expect(first.statusCode).toBe(409);
    expect(first.json().error.human_verification_attribution.source).toBe(
      "snapshot_mint_visual_judgment",
    );
    expect(sessionCapsules()).toHaveLength(1);
  }

  it("same-origin reuse still blocks (control)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    seedSession();
    await mintCapsuleOnPageUrl();

    // Still on the minting origin — the capsule keeps guarding.
    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.human_verification_attribution.source).toBe("vgc_capsule_reuse_guard");
    expect(sessionCapsules()).toHaveLength(1);
  });

  it("cross-origin navigation clears the stale capsule and does NOT block the new page", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const session = seedSession();
    await mintCapsuleOnPageUrl();

    // The agent navigated to an unrelated origin; the adapter refreshed current_url
    // before this guard runs. The minted capsule is now stale cross-origin state.
    session.current_url = "https://www.unrelated-other.com/landing";

    const res = await snapshot();
    // Not blocked — the snapshot proceeds normally on the new page.
    expect(res.statusCode).toBe(200);
    // The stale capsule was terminalized (cancelled) — no active capsule remains.
    expect(sessionCapsules()).toHaveLength(0);
  });

  it("missing/unparseable current_url keeps blocking (conservative fail-safe)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    const session = seedSession();
    await mintCapsuleOnPageUrl();

    // current_url cannot be parsed → cross-origin cannot be proven → keep blocking.
    session.current_url = "";

    const res = await snapshot();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.human_verification_attribution.source).toBe("vgc_capsule_reuse_guard");
    expect(sessionCapsules()).toHaveLength(1);
  });

  it("stale cross-origin clear leaks no host/url/path/query in response or debug telemetry", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const session = seedSession();
      await mintCapsuleOnPageUrl();
      session.current_url = "https://secret-host.example.org/private/path?token=abc123";

      const res = await snapshot();
      expect(res.statusCode).toBe(200);

      // The agent-facing response never echoes the live origin's url/path/query.
      const raw = JSON.stringify(res.json());
      for (const s of ["secret-host.example.org", "/private/path", "token=abc123"]) {
        expect(raw, `response leaked "${s}"`).not.toContain(s);
      }

      // The stale-branch [HvDebug] line carries scalars only — never a host/url.
      const staleLine = logSpy.mock.calls
        .map((c) => c.map(String).join(" "))
        .find((l) => l.includes("[HvDebug]") && l.includes("vgc_reuse_stale_cross_origin"));
      expect(staleLine).toBeDefined();
      for (const s of [
        "secret-host.example.org",
        "example-shop.com",
        "/private/path",
        "token=abc123",
      ]) {
        expect(staleLine!, `debug telemetry leaked "${s}"`).not.toContain(s);
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── ANTIGEN_VISION_CAPTURE_AND_SKIP: action no-progress never mints a VGC ──────
//
// Dataset-gathering / exploration mode. The action no-progress backstop
// (rejectNoProgressActionAsHumanVerification) must NOT mint a capsule or HV
// request from an action failure — a single durable capsule would otherwise poison
// every later site in the run via the hv_active_guard reuse path. The action
// returns its original no-progress failure; the agent's next antigen_snapshot drives
// the existing visual-classifier / dataset-capture path. Normal mode is unchanged.
describe("capture-and-skip — action no-progress never mints a VGC", () => {
  // The exact shape that DID mint a capsule in normal mode (case 1 of the no-progress
  // suite). Proves the only difference is the flag.
  function seedNoProgressOverlay() {
    seedSession();
    seedSnapshot([candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 })]);
    clickKnownBoxMock.mockResolvedValueOnce({ success: false, error: "REALISTIC_CLICK_FAILED" });
    ambiguousProbeMock.mockResolvedValue({
      denial_text_seen: false,
      near_zero_interactive: false,
      visible_inaccessible_iframe_seen: true,
    });
  }

  it("(off — control) flag off + action no-progress mints a VGC and 409s (unchanged baseline)", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    // ANTIGEN_VISION_CAPTURE_AND_SKIP intentionally unset.
    seedNoProgressOverlay();
    vgcCaptureMock.mockImplementationOnce(captureOkStoringFrame());

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.visual_gesture_capsule.available).toBe(true);
    expect(listActiveVisualGestureCapsules()).toHaveLength(1);
  });

  it("(2) flag on + action no-progress → no capsule, no HV request, original 422 surfaces", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP = "true";
    seedNoProgressOverlay();

    const res = await clickStaleProductRef();

    // Original action failure surfaces — NOT a 409 HUMAN_VERIFICATION_REQUIRED.
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REALISTIC_CLICK_FAILED");
    // No capsule and no HV request were created — nothing to poison later sites.
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
    expect(humanVerificationRequests.size).toBe(0);
    expect(vgcCaptureMock).not.toHaveBeenCalled();
    // Short-circuits before any wall/visual probe runs.
    expect(hvWallProbeMock).not.toHaveBeenCalled();
    expect(ambiguousProbeMock).not.toHaveBeenCalled();
  });

  it("(3) flag on + action no-progress → response is never HUMAN_VERIFICATION_REQUIRED", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP = "true";
    seedNoProgressOverlay();

    const res = await clickStaleProductRef();

    expect(res.statusCode).not.toBe(409);
    expect(res.json().error.code).not.toBe("HUMAN_VERIFICATION_REQUIRED");
  });

  it("(4) flag on — a later snapshot is NOT blocked by hv_active_guard/reused_existing_capsule", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP = "true";
    seedNoProgressOverlay();

    const action = await clickStaleProductRef();
    expect(action.statusCode).toBe(422);
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);

    // The next site/page snapshot must proceed independently — no leftover capsule.
    bundleMock.mockResolvedValueOnce({
      candidates: [candidate(), candidate({ index: 1 }), candidate({ index: 2 }), candidate({ index: 3 }), candidate({ index: 4 })],
      hvWallHint: false,
    });
    const snap = await snapshot();

    expect(snap.statusCode).toBe(200);
    expect(snap.json().error?.code).not.toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(listActiveVisualGestureCapsules()).toHaveLength(0);
  });

  it("(6) telemetry on the suppressed path is safe — booleans/enums only, no leaks", async () => {
    process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
    process.env.ANTIGEN_VISION_CAPTURE_AND_SKIP = "true";
    process.env.ANTIGEN_HV_DEBUG = "true";
    seedNoProgressOverlay();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await clickStaleProductRef();

    expect(res.statusCode).toBe(422);
    const hvLines = logSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .filter((line) => line.startsWith("[HvDebug]"));
    const suppressLine = hvLines.find((l) => l.includes("capture_and_skip_suppressed_vgc=true"));
    expect(suppressLine).toBeDefined();
    expect(suppressLine).toContain("scope=no_progress_backstop");
    expect(suppressLine).toContain("created_capsule=false");
    // No URL, port, screenshot bytes, coords, or raw page text in the telemetry line.
    for (const forbidden of ["9222", "data:image", "png_base64", "example-shop.com", "http"]) {
      expect(suppressLine).not.toContain(forbidden);
    }
    // The 422 body itself is clean too.
    assertNoLeak(res.json());
    logSpy.mockRestore();
  });
});
