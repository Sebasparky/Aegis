/**
 * VisualBlockerClassifierPipeline — Phase 1 shadow skeleton.
 *
 * Asserts the staged architecture is NOT collapsed: the pipeline runs only for the
 * two router `visual_classifier_candidate` bases, only when the vision flag is on,
 * the stub always returns `unknown_blocked`/`low`, policy is `fail_closed_or_ask_user`
 * with `enforced: false`, and no safe object/telemetry carries an unsafe field.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  classifySurfaceBoundary,
  type SurfaceBoundaryDecision,
  type SurfaceBoundarySignals,
} from "../runtime/surfaceBoundary.js";
import { runVisualBlockerClassifierPipeline } from "../runtime/visualBlockerClassifier/pipeline.js";
import { shadowStubAdapter } from "../runtime/visualBlockerClassifier/classifierAdapter.js";
import { mapResultToPolicyDecision } from "../runtime/visualBlockerClassifier/policy.js";
import { isHvVisionClassifierEnabled } from "../runtime/visualBlockerClassifier/flags.js";
import { getAntigenRuntimeStatus } from "../runtime/antigenRuntimeFlags.js";
import type {
  BlockerType,
  PolicyDecisionAction,
  VisualClassifierResult,
} from "../runtime/visualBlockerClassifier/types.js";

const FLAG = "ANTIGEN_HV_VISION_CLASSIFIER";

function withFlag(value: boolean): void {
  if (value) process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

afterEach(() => {
  delete process.env[FLAG];
});

// ── Router signal fixtures ───────────────────────────────────────────────────

/** An UNREADABLE dominant surface (scrim + centered + uninspectable text). */
const unreadableSignals: SurfaceBoundarySignals = {
  screen_viewport_scrim_seen: true,
  screen_centered_modal_seen: true,
  surface_dominant_visible_surface_seen: true,
  surface_dominant_visible_surface_kind: "scrim_center_modal",
  surface_dominant_text_extraction_attempted: true,
  surface_dominant_text_extractable: false,
  surface_dominant_text_uninspectable: true,
};

/** An OPAQUE dominant cross-origin iframe over the main content. */
const opaqueSignals: SurfaceBoundarySignals = {
  opaque_iframe_seen: true,
  visible_cross_origin_iframe_seen: true,
  opaque_dominant_surface_seen: true,
  surface_over_main_content: true,
  surface_blocks_viewport_center: true,
  surface_text_uninspectable: true,
};

function run(signals: SurfaceBoundarySignals, decision?: SurfaceBoundaryDecision) {
  const surfaceDecision = decision ?? classifySurfaceBoundary(signals);
  return runVisualBlockerClassifierPipeline({
    surfaceDecision,
    surfaceSignals: signals,
    browserSessionId: "bs_test_001",
    domain: "example.com",
  });
}

// ── Flag gating ──────────────────────────────────────────────────────────────

describe("pipeline flag gating", () => {
  it("does not run when the flag is off (returns flag_disabled)", () => {
    withFlag(false);
    expect(isHvVisionClassifierEnabled()).toBe(false);
    const out = run(unreadableSignals);
    expect(out.ran).toBe(false);
    if (out.ran === false) expect(out.skip_reason).toBe("flag_disabled");
  });
});

// ── The two candidate bases run the stub → policy, enforced:false ──────────────

describe("pipeline runs for visual_classifier_candidate bases", () => {
  it("unreadable_dominant_surface → runs, stub unknown_blocked, policy enforced:false", () => {
    withFlag(true);
    const decision = classifySurfaceBoundary(unreadableSignals);
    expect(decision.route_decided).toBe("visual_classifier_candidate");
    expect(decision.trigger_basis).toBe("unreadable_dominant_surface");

    const out = run(unreadableSignals, decision);
    expect(out.ran).toBe(true);
    if (out.ran !== true) throw new Error("expected ran");
    expect(out.candidate.trigger_basis).toBe("unreadable_dominant_surface");
    expect(out.candidate.candidate_reason).toBe("unreadable_dominant_surface");
    expect(out.result.blocker_type).toBe("unknown_blocked");
    expect(out.result.confidence_bucket).toBe("low");
    expect(out.result.classifier_source).toBe("shadow_stub");
    expect(out.policy.action).toBe("fail_closed_or_ask_user");
    expect(out.policy.enforced).toBe(false);
  });

  it("opaque_dominant_surface → runs, stub unknown_blocked, policy enforced:false", () => {
    withFlag(true);
    const decision = classifySurfaceBoundary(opaqueSignals);
    expect(decision.route_decided).toBe("visual_classifier_candidate");
    expect(decision.trigger_basis).toBe("opaque_dominant_surface");

    const out = run(opaqueSignals, decision);
    expect(out.ran).toBe(true);
    if (out.ran !== true) throw new Error("expected ran");
    expect(out.candidate.trigger_basis).toBe("opaque_dominant_surface");
    expect(out.result.blocker_type).toBe("unknown_blocked");
    expect(out.policy.action).toBe("fail_closed_or_ask_user");
    expect(out.policy.enforced).toBe(false);
  });
});

// ── Non-candidate routes never run ────────────────────────────────────────────

describe("pipeline does not run for non-candidate routes", () => {
  it("dom_semantic_candidate (readable login wall) → not_a_candidate", () => {
    withFlag(true);
    const signals: SurfaceBoundarySignals = {
      screen_viewport_scrim_seen: true,
      screen_centered_modal_seen: true,
      surface_text_inspectable: true,
      top_layer_dialog_seen: true,
      surface_dominant_text_extraction_attempted: true,
      surface_dominant_text_extractable: true,
    };
    const decision = classifySurfaceBoundary(signals);
    expect(decision.route_decided).toBe("dom_semantic_candidate");
    const out = run(signals, decision);
    expect(out.ran).toBe(false);
    if (out.ran === false) expect(out.skip_reason).toBe("not_a_candidate");
  });

  it("ignore_off_path → not_a_candidate", () => {
    withFlag(true);
    const decision = classifySurfaceBoundary({ off_path_iframe_seen: true });
    expect(decision.route_decided).toBe("ignore_off_path");
    const out = run({ off_path_iframe_seen: true }, decision);
    expect(out.ran).toBe(false);
  });

  it("none (empty signals) → not_a_candidate", () => {
    withFlag(true);
    const decision = classifySurfaceBoundary({});
    expect(decision.route_decided).toBe("none");
    const out = run({}, decision);
    expect(out.ran).toBe(false);
  });

  it("unknown route (synthetic) → not_a_candidate", () => {
    withFlag(true);
    const decision: SurfaceBoundaryDecision = {
      route_decided: "unknown",
      trigger_basis: "none",
      inspectability_class: "none",
      visual_classifier_candidate_reason: "none",
      opaque_dominant_surface_with_background_dom_contradiction: false,
      surface_newly_appeared: "unknown",
      surface_overlaps_agent_target: "unknown",
    };
    const out = run({}, decision);
    expect(out.ran).toBe(false);
    if (out.ran === false) expect(out.skip_reason).toBe("not_a_candidate");
  });
});

// ── Policy maps the full BlockerType enum per the memo table ───────────────────

describe("policy maps every BlockerType per the memo table", () => {
  const cases: Array<[BlockerType, PolicyDecisionAction]> = [
    ["hv_full_page", "route_to_user_presence_vgc"],
    ["hv_center_modal", "route_to_user_presence_vgc"],
    ["hv_small_widget", "route_to_user_presence_vgc"],
    ["hv_press_hold", "route_to_user_presence_vgc"],
    ["hv_interaction_active", "live_guidance_keep_holding"],
    ["hv_cleared_or_settling", "wait_and_recheck"],
    ["login_wall", "route_to_credential_flow"],
    ["cookie_banner", "agent_may_handle"],
    ["marketing_modal", "agent_may_handle"],
    ["normal_or_unblocked", "agent_may_handle"],
    ["non_hv_modal", "agent_may_handle"],
    ["unknown_blocked", "fail_closed_or_ask_user"],
  ];

  for (const [blockerType, action] of cases) {
    it(`${blockerType} → ${action} (enforced:false)`, () => {
      const result: VisualClassifierResult = {
        candidate_id: "cand_1",
        blocker_type: blockerType,
        confidence_bucket: "high",
        user_presence_required: false,
        wall_visible: true,
        safe_to_resume: false,
        classifier_source: "shadow_stub",
        classified_at: new Date().toISOString(),
      };
      const decision = mapResultToPolicyDecision(result);
      expect(decision.action).toBe(action);
      expect(decision.enforced).toBe(false);
      expect(decision.basis_blocker_type).toBe(blockerType);
    });
  }

  it("unknown_blocked specifically fails closed", () => {
    const r = shadowStubAdapter({
      candidate_id: "c",
      browser_session_id: "b",
      domain: "d",
      trigger_basis: "unreadable_dominant_surface",
      candidate_reason: "unreadable_dominant_surface",
      dominant_surface_kind: "scrim_center_modal",
      signals: {
        scrim_seen: true,
        centered_modal_seen: true,
        opaque_iframe_seen: false,
        visual_dom_contradiction_seen: false,
        dominant_text_uninspectable: true,
        pointer_interceptor_seen: false,
      },
      created_at: new Date().toISOString(),
    });
    expect(r.blocker_type).toBe("unknown_blocked");
    expect(mapResultToPolicyDecision(r).action).toBe("fail_closed_or_ask_user");
  });
});

// ── Safe-view: no unsafe fields anywhere in returned objects ───────────────────

describe("no unsafe fields in any returned safe object", () => {
  const UNSAFE_KEY = /(png_base64|base64|screenshot|page_url|\burl\b|src|rect|coord|selector|xpath|raw_text|\btext\b|value)/i;

  function assertNoUnsafeKeys(obj: unknown, path = "root"): void {
    if (obj === null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      expect(UNSAFE_KEY.test(k), `unsafe key "${k}" at ${path}`).toBe(false);
      assertNoUnsafeKeys(v, `${path}.${k}`);
    }
  }

  it("candidate, result, and policy expose only safe keys", () => {
    withFlag(true);
    const out = run(unreadableSignals);
    expect(out.ran).toBe(true);
    if (out.ran !== true) throw new Error("expected ran");
    assertNoUnsafeKeys(out.candidate);
    assertNoUnsafeKeys(out.result);
    assertNoUnsafeKeys(out.policy);
    // Specifically: page_url is omitted entirely from the candidate (Phase 1).
    expect("page_url" in (out.candidate as object)).toBe(false);
  });

  it("candidate signals are all booleans (no values/text)", () => {
    withFlag(true);
    const out = run(opaqueSignals);
    if (out.ran !== true) throw new Error("expected ran");
    const sig = out.candidate.signals as unknown as Record<string, unknown>;
    for (const v of Object.values(sig)) expect(typeof v).toBe("boolean");
  });
});

// ── Runtime status exposes the flag, default false ─────────────────────────────

describe("runtime status flag exposure", () => {
  it("hv_vision_classifier present and false by default", () => {
    withFlag(false);
    expect(getAntigenRuntimeStatus().hv_vision_classifier).toBe(false);
  });

  it("hv_vision_classifier true when the flag is on", () => {
    withFlag(true);
    expect(getAntigenRuntimeStatus().hv_vision_classifier).toBe(true);
  });
});
