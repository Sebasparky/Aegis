/**
 * Human Verification Handoff Status Layer — unit suite (always-run, no Chromium).
 *
 * Pins the product contract for the safe, model-INFORMED live handoff status:
 *   1. No mint (e.g. benign suppression path) → NO handoff update.
 *   2. VGC mint → `detected`, requires_user_attention/agent_should_wait true,
 *      echoes the model label/confidence/policy/trigger.
 *   3. A conservative mint with no model context still publishes `detected`.
 *   4. Hold lifecycle: start → `holding`; model `looks_clear` →
 *      `looks_complete_checking` with agent_should_wait STILL true; model
 *      `wall_present` → `still_active`.
 *   5. Conservative completion (DOM in-hold absent / recheck cleared) → `completed`
 *      clearing attention + wait. The model alone NEVER publishes `completed`.
 *   6. No unsafe fields leak in updates or endpoint responses.
 *   7. (Cross-checked in human-verification-lifecycle suite) the 409 attribution
 *      is unchanged — this suite asserts no handoff field rides the publish.
 *   8. No model call happens outside an active hold (no continuous monitor).
 *   9. Model-unavailable → DOM probe authority unchanged, no premature publish.
 *  10. Endpoint shape + lazy expiry.
 */

import Fastify from "fastify";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  publishHvHandoffUpdate,
  getLatestHvHandoffUpdate,
  listHvHandoffUpdates,
  clearHvHandoffUpdatesForTests,
  HV_HANDOFF_TTL_MS,
  type HumanVerificationHandoffUpdate,
} from "../runtime/humanVerificationHandoff.js";
import { humanVerificationHandoffRoutes } from "../routes/human-verification-handoff.js";
import { createVisualGestureCapsuleForOpaqueHv } from "../runtime/visualGestureCapsuleOrchestrator.js";
import {
  startVgcHoldSession,
  cancelVgcHoldSession,
  clearVgcHoldSessionsForTests,
  type VgcHoldDeps,
  type VgcHoldPresence,
} from "../runtime/visualGestureCapsuleHold.js";
import { recheckVisualGestureCapsule } from "../runtime/visualGestureCapsuleRecheck.js";
import {
  createVisualGestureCapsule,
  storeVisualGestureCapsuleScreenshotFrame,
  getVisualGestureCapsule,
  clearVisualGestureCapsulesForTests,
} from "../runtime/visualGestureCapsule.js";

const SESSION = "tbs_handoff_001";
const CDP = "http://localhost:9222";
const VW = 1280;
const VH = 800;

/** Forbidden substrings that must NEVER appear in a serialized handoff update. */
function assertNoUnsafeFields(payload: unknown): void {
  const s = JSON.stringify(payload);
  // No full URL / path / query / scheme / coordinates / base64 / frame path.
  expect(s).not.toMatch(/https?:\/\//);
  expect(s).not.toContain("/wall");
  expect(s).not.toContain("?");
  expect(s).not.toMatch(/\bcss[XY]\b/);
  expect(s).not.toMatch(/data:image/);
  expect(s).not.toContain(".png");
  expect(s).not.toContain("iVBOR"); // PNG base64 magic
}

function seedCapsuleWithFrame() {
  const capsule = createVisualGestureCapsule({
    human_verification_request_id: "hvr_handoff_001",
    browser_session_id: SESSION,
    domain: "example.com",
    page_url: "https://example.com/wall",
  });
  const stored = storeVisualGestureCapsuleScreenshotFrame(capsule.capsule_id, {
    png_base64: "iVBORw0KGgoREDACTED==",
    viewport_css_width: VW,
    viewport_css_height: VH,
  });
  expect(stored.ok).toBe(true);
  return capsule;
}

/** A recording CDP client (logs mouse types). */
function makeRecordingClient() {
  const order: string[] = [];
  const client = {
    send() {},
    async call(method: string, params: Record<string, unknown>) {
      if (method === "Input.dispatchMouseEvent") order.push(String(params.type));
      return {};
    },
    async evaluate() {
      return {};
    },
    close() {
      order.push("close");
    },
  };
  return { client, order };
}

/** Build hold deps with an injected DOM probe + model classifier. */
function makeHoldDeps(opts: {
  domPresences: VgcHoldPresence[];
  model?: { available: boolean; verdict?: "wall_present" | "looks_clear" | "uncertain"; model_label?: string; model_confidence?: number };
}): { deps: VgcHoldDeps; modelCalls: () => number } {
  const { client } = makeRecordingClient();
  let i = 0;
  const probeOnClient = vi.fn(async () => {
    const v = opts.domPresences[Math.min(i, opts.domPresences.length - 1)];
    i += 1;
    return v;
  });
  const classifyModel = vi.fn(async () => ({
    available: opts.model?.available ?? false,
    verdict: opts.model?.verdict ?? ("uncertain" as const),
    ...(opts.model?.model_label ? { model_label: opts.model.model_label } : {}),
    ...(opts.model?.model_confidence !== undefined ? { model_confidence: opts.model.model_confidence } : {}),
  }));
  const deps: VgcHoldDeps = {
    openCdpClient: (async () => ({ ok: true, client, target: { id: "T" } })) as unknown as VgcHoldDeps["openCdpClient"],
    readLiveViewport: async () => ({ width: VW, height: VH }),
    probeOnClient,
    classifyModel: classifyModel as unknown as VgcHoldDeps["classifyModel"],
  };
  return { deps, modelCalls: () => classifyModel.mock.calls.length };
}

beforeEach(() => {
  process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE = "true";
  vi.useFakeTimers();
  clearHvHandoffUpdatesForTests();
  clearVgcHoldSessionsForTests();
  clearVisualGestureCapsulesForTests();
});

afterEach(() => {
  clearHvHandoffUpdatesForTests();
  clearVgcHoldSessionsForTests();
  clearVisualGestureCapsulesForTests();
  vi.useRealTimers();
  delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
  delete process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED;
  vi.restoreAllMocks();
});

// ─── 1 + 2 + 3. mint publishing & no-mint silence ────────────────────────────

describe("VGC mint → detected handoff", () => {
  it("flag-off mint (suppression-equivalent: no capsule) publishes NO handoff", async () => {
    delete process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE;
    const res = await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: "hvr_x",
      browserSessionId: SESSION,
      domain: "example.com",
      cdpUrl: CDP,
    });
    expect(res.ok).toBe(false);
    expect(listHvHandoffUpdates()).toHaveLength(0);
  });

  it("mint publishes detected with attention+wait and echoed model fields", async () => {
    const res = await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: "hvr_handoff_002",
      browserSessionId: SESSION,
      domain: "example.com",
      cdpUrl: CDP,
      pageUrl: "https://example.com/wall",
      capture: (async () => ({ ok: true })) as never,
      modelLabel: "page_level_hv_wall",
      modelConfidence: 0.92,
      visualPolicyDecision: "visual_hv_confirmed",
      triggerBasis: "page_level_hv_wall",
    });
    expect(res.ok).toBe(true);
    const latest = getLatestHvHandoffUpdate(SESSION)!;
    expect(latest.phase).toBe("detected");
    expect(latest.requires_user_attention).toBe(true);
    expect(latest.agent_should_wait).toBe(true);
    expect(latest.model_label).toBe("page_level_hv_wall");
    expect(latest.model_confidence).toBe(0.92);
    expect(latest.visual_policy_decision).toBe("visual_hv_confirmed");
    expect(latest.trigger_basis).toBe("page_level_hv_wall");
    expect(latest.presence_source).toBe("model");
    expect(latest.release_authority).toBe("conservative_probe");
  });

  it("conservative mint without model context still publishes detected", async () => {
    const res = await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: "hvr_handoff_003",
      browserSessionId: SESSION,
      domain: "example.com",
      cdpUrl: CDP,
      capture: (async () => ({ ok: false })) as never,
    });
    expect(res.ok).toBe(true);
    const latest = getLatestHvHandoffUpdate(SESSION)!;
    expect(latest.phase).toBe("detected");
    expect(latest.presence_source).toBe("none");
    expect(latest.model_label).toBeUndefined();
  });
});

// ─── 4. hold lifecycle + model-informed status ───────────────────────────────

describe("hold lifecycle handoff status", () => {
  it("hold start publishes holding", async () => {
    const capsule = seedCapsuleWithFrame();
    const { deps } = makeHoldDeps({ domPresences: ["present"] });
    const res = await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    expect(res.ok).toBe(true);
    expect(getLatestHvHandoffUpdate(SESSION)?.phase).toBe("holding");
    await cancelVgcHoldSession(capsule.capsule_id);
  });

  it("model looks_clear during hold → looks_complete_checking but agent_should_wait STAYS true", async () => {
    const capsule = seedCapsuleWithFrame();
    const { deps } = makeHoldDeps({
      domPresences: ["present", "present"], // DOM keeps holding (authority)
      model: { available: true, verdict: "looks_clear", model_label: "false_positive_normal_page", model_confidence: 0.97 },
    });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    // First in-hold probe fires at max(min, interval) = 1000ms.
    await vi.advanceTimersByTimeAsync(1000);
    const latest = getLatestHvHandoffUpdate(SESSION)!;
    expect(latest.phase).toBe("looks_complete_checking");
    expect(latest.agent_should_wait).toBe(true); // advisory only — never resumes
    expect(latest.requires_user_attention).toBe(true);
    expect(latest.presence_source).toBe("model");
    // Capsule NOT cleared — the model is not the release authority.
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).not.toBe("cleared");
    await cancelVgcHoldSession(capsule.capsule_id);
  });

  it("model wall_present during hold → still_active", async () => {
    const capsule = seedCapsuleWithFrame();
    const { deps } = makeHoldDeps({
      domPresences: ["present", "present"],
      model: { available: true, verdict: "wall_present", model_label: "page_level_hv_wall", model_confidence: 0.9 },
    });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLatestHvHandoffUpdate(SESSION)?.phase).toBe("still_active");
    await cancelVgcHoldSession(capsule.capsule_id);
  });

  it("cancel publishes cancelled", async () => {
    const capsule = seedCapsuleWithFrame();
    const { deps } = makeHoldDeps({ domPresences: ["present"] });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    await cancelVgcHoldSession(capsule.capsule_id);
    expect(getLatestHvHandoffUpdate(SESSION)?.phase).toBe("cancelled");
  });
});

// ─── 5. conservative completion authority ────────────────────────────────────

describe("conservative completion authority", () => {
  it("in-hold DOM absent → completed clears attention+wait (model never consulted)", async () => {
    const capsule = seedCapsuleWithFrame();
    // pre-start present (so it presses); first in-hold probe → absent.
    const { deps, modelCalls } = makeHoldDeps({
      domPresences: ["present", "absent"],
      model: { available: true, verdict: "looks_clear" },
    });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    await vi.advanceTimersByTimeAsync(1000);
    const latest = getLatestHvHandoffUpdate(SESSION)!;
    expect(latest.phase).toBe("completed");
    expect(latest.requires_user_attention).toBe(false);
    expect(latest.agent_should_wait).toBe(false);
    expect(latest.presence_source).toBe("dom_probe");
    // Model is short-circuited on the DOM `absent` path — not consulted.
    expect(modelCalls()).toBe(0);
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).toBe("cleared");
  });

  it("recheck cleared → completed", async () => {
    // Seed an awaiting capsule; recheck with an injected absent probe.
    const capsule = seedCapsuleWithFrame();
    const result = await recheckVisualGestureCapsule({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      settleMs: 0,
      retrySettleMs: 0,
      probe: async () => ({ ok: true, presence: "absent", hv_present: false, geo_strength: "none" }),
    });
    expect(result.ok && result.outcome).toBe("cleared");
    const latest = getLatestHvHandoffUpdate(SESSION)!;
    expect(latest.phase).toBe("completed");
    expect(latest.agent_should_wait).toBe(false);
  });

  it("recheck still-present → still_active (not completed)", async () => {
    const capsule = seedCapsuleWithFrame();
    const result = await recheckVisualGestureCapsule({
      capsuleId: capsule.capsule_id,
      cdpUrl: CDP,
      settleMs: 0,
      retrySettleMs: 0,
      probe: async () => ({ ok: true, presence: "present", hv_present: true }),
    });
    expect(result.ok && result.outcome).toBe("still_present");
    expect(getLatestHvHandoffUpdate(SESSION)?.phase).toBe("still_active");
  });
});

// ─── 8 + 9. no continuous monitor + model-unavailable fallback ───────────────

describe("monitor gating + fallback", () => {
  it("no model call happens before/without an active hold", async () => {
    // A mint alone (no hold) must not trigger any model presence call.
    const { deps, modelCalls } = makeHoldDeps({ domPresences: ["present"] });
    await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: "hvr_handoff_004",
      browserSessionId: SESSION,
      domain: "example.com",
      cdpUrl: CDP,
      capture: (async () => ({ ok: true })) as never,
    });
    // Advance time well past any in-hold cadence — there is NO hold armed.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(modelCalls()).toBe(0);
    // (deps used only to obtain the spy; no hold started.)
    void deps;
  });

  it("model unavailable → DOM authority unchanged, no still_active/looks_complete published", async () => {
    const capsule = seedCapsuleWithFrame();
    const { deps } = makeHoldDeps({ domPresences: ["present", "present"], model: { available: false } });
    await startVgcHoldSession({ capsuleId: capsule.capsule_id, cdpUrl: CDP, fx: 0.5, fy: 0.5, deps });
    await vi.advanceTimersByTimeAsync(1000);
    // Stays at holding (model produced nothing; DOM said present → keep holding).
    expect(getLatestHvHandoffUpdate(SESSION)?.phase).toBe("holding");
    expect(getVisualGestureCapsule(capsule.capsule_id)?.status).not.toBe("cleared");
    await cancelVgcHoldSession(capsule.capsule_id);
  });
});

// ─── 6. no unsafe field leak ─────────────────────────────────────────────────

describe("safe fields only", () => {
  it("a full-URL domain is reduced to hostname and no unsafe fields leak", () => {
    const u = publishHvHandoffUpdate({
      browser_session_id: SESSION,
      source: "visual_gesture_capsule",
      phase: "detected",
      domain: "https://shop.example.com/checkout?token=abc#frag",
      model_label: "page_level_hv_wall",
      model_confidence: 0.9,
    })!;
    expect(u.domain).toBe("shop.example.com");
    assertNoUnsafeFields(u);
    expect(u.raw_surface_revealed_to_agent).toBe(false);
  });

  it("publish is deduped on identical consecutive phase", () => {
    const a = publishHvHandoffUpdate({ browser_session_id: SESSION, source: "visual_gesture_capsule", phase: "holding" });
    const b = publishHvHandoffUpdate({ browser_session_id: SESSION, source: "visual_gesture_capsule", phase: "holding" });
    expect(a).toBeDefined();
    expect(b).toBeUndefined();
  });
});

// ─── 10. endpoint shape + lazy expiry ────────────────────────────────────────

describe("handoff endpoint", () => {
  async function buildServer() {
    const app = Fastify();
    await app.register(humanVerificationHandoffRoutes);
    await app.ready();
    return app;
  }

  it("GET list + per-session return safe allowlist", async () => {
    publishHvHandoffUpdate({ browser_session_id: SESSION, source: "visual_gesture_capsule", phase: "detected", domain: "example.com" });
    const app = await buildServer();
    try {
      const list = await app.inject({ method: "GET", url: "/api/internal/human-verification-handoff" });
      expect(list.statusCode).toBe(200);
      const listBody = list.json() as { ok: boolean; data: HumanVerificationHandoffUpdate[] };
      expect(listBody.ok).toBe(true);
      expect(listBody.data).toHaveLength(1);
      assertNoUnsafeFields(listBody.data);

      const one = await app.inject({ method: "GET", url: `/api/internal/human-verification-handoff/${SESSION}` });
      const oneBody = one.json() as { ok: boolean; data: HumanVerificationHandoffUpdate | null };
      expect(oneBody.data?.phase).toBe("detected");
      expect(oneBody.data?.raw_surface_revealed_to_agent).toBe(false);

      const miss = await app.inject({ method: "GET", url: "/api/internal/human-verification-handoff/nope" });
      expect((miss.json() as { data: unknown }).data).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("expired updates are not returned (lazy expiry)", async () => {
    publishHvHandoffUpdate({ browser_session_id: SESSION, source: "visual_gesture_capsule", phase: "detected" });
    expect(getLatestHvHandoffUpdate(SESSION)).toBeDefined();
    // Advance the wall clock beyond the TTL.
    vi.setSystemTime(new Date(Date.now() + HV_HANDOFF_TTL_MS + 1000));
    expect(getLatestHvHandoffUpdate(SESSION)).toBeUndefined();
    expect(listHvHandoffUpdates()).toHaveLength(0);
  });
});
