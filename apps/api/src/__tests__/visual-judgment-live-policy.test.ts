import { describe, expect, it } from "vitest";

import {
  DEFAULT_BENIGN_SUPPRESSION_THRESHOLD,
  DEFAULT_HV_ACTION_THRESHOLD,
  decideVisualLivePolicy,
  type VisualLivePolicyInput,
} from "../runtime/visualBlockerClassifier/livePolicy.js";

/**
 * Base: fully live, model available. Each test overrides what it exercises.
 * Defaults to a benign suppression candidate so suppression-path tests are explicit.
 * There is no domain gate — suppression rests on the surface classification alone.
 */
function baseInput(overrides: Partial<VisualLivePolicyInput> = {}): VisualLivePolicyInput {
  return {
    heuristic_hv_stop: true,
    heuristic_label: "page_level_hv_wall",
    trigger_basis: "page_level_hv_wall",
    model_predicted_label: "false_positive_normal_modal",
    model_confidence: 0.97,
    model_available: true,
    visual_judgment_enabled: true,
    live_policy_enabled: true,
    dry_run: false,
    origin_host: "www.example.com",
    ...overrides,
  };
}

describe("decideVisualLivePolicy", () => {
  it("exposes the memo default thresholds", () => {
    expect(DEFAULT_HV_ACTION_THRESHOLD).toBe(0.85);
    expect(DEFAULT_BENIGN_SUPPRESSION_THRESHOLD).toBe(0.95);
  });

  it("1. disabled visual judgment → no_action, no suppress, visual_runtime_no_action", () => {
    const d = decideVisualLivePolicy(baseInput({ visual_judgment_enabled: false }));
    expect(d.action).toBe("no_action");
    expect(d.policy_decision).toBe("visual_runtime_no_action");
    expect(d.should_suppress_heuristic_stop).toBe(false);
    expect(d.runtime_action_taken_by_model).toBe(false);
  });

  it("2. live policy disabled → dry_run_only, no suppress", () => {
    const d = decideVisualLivePolicy(baseInput({ live_policy_enabled: false }));
    expect(d.action).toBe("dry_run_only");
    expect(d.should_suppress_heuristic_stop).toBe(false);
    expect(d.runtime_action_taken_by_model).toBe(false);
  });

  it("3. dry_run true → dry_run_only, no suppress", () => {
    const d = decideVisualLivePolicy(baseInput({ dry_run: true }));
    expect(d.action).toBe("dry_run_only");
    expect(d.should_suppress_heuristic_stop).toBe(false);
    expect(d.runtime_action_taken_by_model).toBe(false);
  });

  it("4. any host is eligible (no domain gate) → confident benign suppresses regardless of origin", () => {
    const d = decideVisualLivePolicy(
      baseInput({ origin_host: "deep.checkout.some-unlisted-site.example" }),
    );
    expect(d.action).toBe("suppress_heuristic_stop");
    expect(d.policy_decision).toBe("visual_benign_suppression_candidate");
    expect(d.should_suppress_heuristic_stop).toBe(true);
    expect(d.runtime_action_taken_by_model).toBe(true);
  });

  it("5. model unavailable → allow_heuristic_stop, no suppress, visual_runtime_no_action", () => {
    const explicit = decideVisualLivePolicy(baseInput({ model_available: false }));
    expect(explicit.action).toBe("allow_heuristic_stop");
    expect(explicit.policy_decision).toBe("visual_runtime_no_action");
    expect(explicit.should_suppress_heuristic_stop).toBe(false);

    const nullLabel = decideVisualLivePolicy(
      baseInput({ model_predicted_label: null, model_confidence: null }),
    );
    expect(nullLabel.action).toBe("allow_heuristic_stop");
    expect(nullLabel.policy_decision).toBe("visual_runtime_no_action");
    expect(nullLabel.should_suppress_heuristic_stop).toBe(false);
  });

  it("6. HV label high confidence → allow_heuristic_stop, visual_hv_confirmed", () => {
    const d = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "page_level_hv_wall", model_confidence: 0.9 }),
    );
    expect(d.action).toBe("allow_heuristic_stop");
    expect(d.policy_decision).toBe("visual_hv_confirmed");
    expect(d.should_suppress_heuristic_stop).toBe(false);
    expect(d.runtime_action_taken_by_model).toBe(false);
  });

  it("7. HV label low confidence → allow_heuristic_stop, visual_low_confidence_hv", () => {
    const d = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "page_level_hv_wall", model_confidence: 0.5 }),
    );
    expect(d.action).toBe("allow_heuristic_stop");
    expect(d.policy_decision).toBe("visual_low_confidence_hv");
    expect(d.should_suppress_heuristic_stop).toBe(false);
  });

  it("8. benign label above 0.95 → suppress_heuristic_stop, visual_benign_suppression_candidate", () => {
    const d = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "false_positive_normal_modal", model_confidence: 0.97 }),
    );
    expect(d.action).toBe("suppress_heuristic_stop");
    expect(d.policy_decision).toBe("visual_benign_suppression_candidate");
    expect(d.should_suppress_heuristic_stop).toBe(true);
    expect(d.runtime_action_taken_by_model).toBe(true);
  });

  it("9. benign label at 0.90 does NOT suppress by default", () => {
    const d = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "cookie_banner", model_confidence: 0.9 }),
    );
    expect(d.action).toBe("allow_heuristic_stop");
    expect(d.policy_decision).toBe("visual_uncertain");
    expect(d.should_suppress_heuristic_stop).toBe(false);
    expect(d.runtime_action_taken_by_model).toBe(false);
  });

  it("10. benign label below threshold → visual_uncertain, no suppress", () => {
    const d = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "newsletter_modal", model_confidence: 0.8 }),
    );
    expect(d.policy_decision).toBe("visual_uncertain");
    expect(d.should_suppress_heuristic_stop).toBe(false);
  });

  it("11. unknown label → visual_uncertain, no suppress", () => {
    const d = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "some_unknown_label", model_confidence: 0.99 }),
    );
    expect(d.policy_decision).toBe("visual_uncertain");
    expect(d.should_suppress_heuristic_stop).toBe(false);
    expect(d.runtime_action_taken_by_model).toBe(false);
  });

  it("12. benign suppression threshold override 0.90 allows 0.91 suppression", () => {
    const d = decideVisualLivePolicy(
      baseInput({
        model_predicted_label: "sign_in_drawer",
        model_confidence: 0.91,
        benign_suppression_threshold: 0.9,
      }),
    );
    expect(d.action).toBe("suppress_heuristic_stop");
    expect(d.policy_decision).toBe("visual_benign_suppression_candidate");
    expect(d.should_suppress_heuristic_stop).toBe(true);
    expect(d.runtime_action_taken_by_model).toBe(true);
    expect(d.benign_suppression_threshold).toBe(0.9);
  });

  it("13. HV threshold override 0.80 makes 0.81 HV confirmed", () => {
    const d = decideVisualLivePolicy(
      baseInput({
        model_predicted_label: "page_level_hv_wall",
        model_confidence: 0.81,
        hv_action_threshold: 0.8,
      }),
    );
    expect(d.policy_decision).toBe("visual_hv_confirmed");
    expect(d.should_suppress_heuristic_stop).toBe(false);
    expect(d.hv_action_threshold).toBe(0.8);
  });

  it("14. runtime_action_taken_by_model is true ONLY for actual suppression", () => {
    const suppression = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "false_positive_normal_page", model_confidence: 0.99 }),
    );
    expect(suppression.action).toBe("suppress_heuristic_stop");
    expect(suppression.runtime_action_taken_by_model).toBe(true);

    // Every non-suppression branch must be false.
    const hvConfirmed = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "page_level_hv_wall", model_confidence: 0.99 }),
    );
    const dryRun = decideVisualLivePolicy(baseInput({ dry_run: true }));
    const disabled = decideVisualLivePolicy(baseInput({ visual_judgment_enabled: false }));
    const uncertain = decideVisualLivePolicy(
      baseInput({ model_predicted_label: "cookie_banner", model_confidence: 0.5 }),
    );
    for (const d of [hvConfirmed, dryRun, disabled, uncertain]) {
      expect(d.runtime_action_taken_by_model).toBe(false);
    }
  });
});
