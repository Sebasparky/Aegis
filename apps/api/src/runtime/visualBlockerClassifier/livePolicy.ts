/**
 * Antigen Visual-Judgment Live Policy v0 — PURE decision function (NOT wired).
 *
 * STATUS: pure, deterministic, dev-experiment-only. This module implements the
 * "smallest safe implementation slice" from
 * `docs/antigen-visual-judgment-live-policy-v0.md` §10: a single pure function that
 * decides whether an already-activation-gated heuristic HV (human-verification) stop
 * should be KEPT or SUPPRESSED, given the model output + thresholds + flags.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * This file is imported by NOTHING in runtime. It does not capture screenshots,
 * call the sidecar, read env, touch the filesystem, log, mutate any session, or
 * change any API route. All inputs are passed as arguments. It is fully testable in
 * isolation. Wiring into `snapshotVisualJudgment` lives behind the ENABLED +
 * LIVE_POLICY flags and dry-run-off — there is NO domain allowlist gate.
 *
 * ── WHY NO DOMAIN ALLOWLIST ─────────────────────────────────────────────────
 * A hostname is not a reliable guarantee of safety: the same site can render a
 * benign marketing/modal surface on one page and a real human-verification wall
 * deeper in checkout/login/account flows. Antigen does NOT trust domains — it
 * trusts the current rendered surface classification. An exact-host allowlist was
 * acceptable as first-blast-radius scaffolding but must not become architecture,
 * so it has been removed. Live suppression remains dev-only via the flags above.
 *
 * ── INVARIANTS (do not weaken) ──────────────────────────────────────────────
 * - Stop/routing is the DEFAULT failure mode. Any unmet/ambiguous/unavailable
 *   condition keeps the heuristic stop (or does no action).
 * - A stop is NEVER created by the model.
 * - The ONLY policy decision that may suppress a stop is
 *   `visual_benign_suppression_candidate`.
 * - The ONLY action that may set `runtime_action_taken_by_model: true` is
 *   `suppress_heuristic_stop`. Antigen never *interacts* with a challenge — this
 *   flag records only that a stop was suppressed.
 */

import type { VisualClassifierTriggerBasis } from "./types.js";
import type { VisualJudgmentLabelScore } from "./runtimeSeam.js";

// ── Thresholds (defaults from the live-policy memo §3) ───────────────────────

/** A `page_level_hv_wall` prediction at/above this is treated as confirmed HV. */
export const DEFAULT_HV_ACTION_THRESHOLD = 0.85;

/**
 * Minimum model confidence in a BENIGN label required to suppress a heuristic HV
 * stop in live mode. Deliberately STRICTER than the dry-run scoring threshold (0.80)
 * — live suppression is a behavior change with real downside.
 */
export const DEFAULT_BENIGN_SUPPRESSION_THRESHOLD = 0.95;

/**
 * Benign page-state labels eligible for suppression. Mirrors `BENIGN_LABELS` in
 * `visualJudgment.ts` — duplicated locally on purpose so this pure module pulls in
 * no runtime coupling (visualJudgment.ts has value imports of the CDP/screenshot
 * stack). Keep the two lists in sync until a shared-label refactor lands.
 */
export const LIVE_POLICY_BENIGN_LABELS = [
  "false_positive_normal_page",
  "false_positive_normal_modal",
  "cookie_banner",
  "newsletter_modal",
  "sign_in_drawer",
] as const;

/** The single high-consequence HV wall label. */
export const LIVE_POLICY_HV_WALL_LABEL = "page_level_hv_wall";

// ── Decision taxonomy ────────────────────────────────────────────────────────

/** Concrete runtime effect a (future) call site would apply. */
export type VisualLivePolicyAction =
  | "allow_heuristic_stop"
  | "suppress_heuristic_stop"
  | "dry_run_only"
  | "no_action";

/** Live-policy decision label — matches the memo §2 taxonomy. */
export type VisualLivePolicyDecisionLabel =
  | "visual_hv_confirmed"
  | "visual_benign_suppression_candidate"
  | "visual_uncertain"
  | "visual_low_confidence_hv"
  | "visual_runtime_no_action";

export interface VisualLivePolicyInput {
  /**
   * The heuristic detector has already decided to mint an HV stop (the entry state
   * for every case). Defaults to true — this function only runs inside the
   * activation-gated path. `heuristic_label` is optional descriptive metadata.
   */
  heuristic_hv_stop?: boolean;
  heuristic_label?: string | null;
  trigger_basis?: VisualClassifierTriggerBasis | string | null;

  /** Model output (advisory). null label/confidence ⇒ model unavailable. */
  model_predicted_label: string | null;
  model_confidence: number | null;
  model_top_3?: VisualJudgmentLabelScore[];
  /** Explicit unavailability signal; also inferred from null label/confidence. */
  model_available?: boolean;

  /** Gate: master visual-judgment flag (ANTIGEN_VISUAL_JUDGMENT_ENABLED). */
  visual_judgment_enabled: boolean;
  /** Gate: live-policy flag (ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY). */
  live_policy_enabled: boolean;
  /** Gate: dry-run — compute + report, never suppress. */
  dry_run: boolean;

  /** Threshold overrides; defaults applied when omitted. */
  hv_action_threshold?: number;
  benign_suppression_threshold?: number;

  /** Hostname only — policy metadata. Never a full URL/path/query. */
  origin_host?: string;
}

export interface VisualLivePolicyDecision {
  action: VisualLivePolicyAction;
  policy_decision: VisualLivePolicyDecisionLabel;
  should_suppress_heuristic_stop: boolean;
  /** True ONLY for an actual suppression. */
  runtime_action_taken_by_model: boolean;
  reason: string;
  /** Resolved thresholds actually used. */
  hv_action_threshold: number;
  benign_suppression_threshold: number;
  /** Echoed model output for telemetry. */
  model_predicted_label: string | null;
  model_confidence: number | null;
  model_top_3?: VisualJudgmentLabelScore[];
  origin_host?: string;
}

// ── Classification (model output → raw decision) ─────────────────────────────

interface Classification {
  policy_decision: VisualLivePolicyDecisionLabel;
  would_suppress: boolean;
  reason: string;
}

/**
 * Classify the model output into a policy decision, independent of gating. This is
 * computed even in dry-run / shadow so telemetry carries the meaningful decision
 * (memo QA Stage 1). It NEVER produces a suppression on its own — gating decides
 * whether `would_suppress` is honored.
 */
function classifyModelOutput(
  predictedLabel: string | null,
  confidence: number | null,
  modelAvailable: boolean,
  hvThreshold: number,
  benignThreshold: number,
): Classification {
  if (!modelAvailable || predictedLabel == null || confidence == null) {
    return {
      policy_decision: "visual_runtime_no_action",
      would_suppress: false,
      reason: "Model/sidecar unavailable or no usable prediction; fail safe to heuristic stop.",
    };
  }

  if (predictedLabel === LIVE_POLICY_HV_WALL_LABEL) {
    if (confidence >= hvThreshold) {
      return {
        policy_decision: "visual_hv_confirmed",
        would_suppress: false,
        reason: "Model confirms page_level_hv_wall at/above the HV action threshold; keep the heuristic stop.",
      };
    }
    return {
      policy_decision: "visual_low_confidence_hv",
      would_suppress: false,
      reason: "Low-confidence HV prediction is not actionable; keep the heuristic stop (model-improvement signal only).",
    };
  }

  if ((LIVE_POLICY_BENIGN_LABELS as readonly string[]).includes(predictedLabel)) {
    if (confidence >= benignThreshold) {
      return {
        policy_decision: "visual_benign_suppression_candidate",
        would_suppress: true,
        reason: "Model confidently predicts a benign surface at/above the benign suppression threshold.",
      };
    }
    return {
      policy_decision: "visual_uncertain",
      would_suppress: false,
      reason: "Benign prediction below the suppression threshold; keep the heuristic stop.",
    };
  }

  return {
    policy_decision: "visual_uncertain",
    would_suppress: false,
    reason: "Unknown / non-suppressible label; keep the heuristic stop.",
  };
}

// ── Public decision function (pure) ──────────────────────────────────────────

/**
 * Decide whether an activation-gated heuristic HV stop should be kept or suppressed.
 * Pure: no I/O, no env, no mutation. Gating (flags/dry-run/availability) is applied on
 * top of the model classification; suppression is permitted ONLY when fully live and the
 * model is a confident benign-suppression candidate. There is NO domain gate — the
 * current rendered-surface classification is the sole trust signal.
 */
export function decideVisualLivePolicy(input: VisualLivePolicyInput): VisualLivePolicyDecision {
  const hvThreshold = input.hv_action_threshold ?? DEFAULT_HV_ACTION_THRESHOLD;
  const benignThreshold = input.benign_suppression_threshold ?? DEFAULT_BENIGN_SUPPRESSION_THRESHOLD;
  const modelAvailable =
    input.model_available !== false && input.model_predicted_label != null && input.model_confidence != null;

  const classification = classifyModelOutput(
    input.model_predicted_label,
    input.model_confidence,
    modelAvailable,
    hvThreshold,
    benignThreshold,
  );

  const base = {
    hv_action_threshold: hvThreshold,
    benign_suppression_threshold: benignThreshold,
    model_predicted_label: input.model_predicted_label,
    model_confidence: input.model_confidence,
    ...(input.model_top_3 !== undefined ? { model_top_3: input.model_top_3 } : {}),
    ...(input.origin_host !== undefined ? { origin_host: input.origin_host } : {}),
  };

  // Gating — first match wins. Stop/routing is the default failure mode.

  if (!input.visual_judgment_enabled) {
    return {
      ...base,
      action: "no_action",
      policy_decision: "visual_runtime_no_action",
      should_suppress_heuristic_stop: false,
      runtime_action_taken_by_model: false,
      reason: "Visual judgment disabled; no action.",
    };
  }

  if (!input.live_policy_enabled) {
    return {
      ...base,
      action: "dry_run_only",
      policy_decision: classification.policy_decision,
      should_suppress_heuristic_stop: false,
      runtime_action_taken_by_model: false,
      reason: "Live policy disabled; decision computed for telemetry only, no runtime action.",
    };
  }

  if (input.dry_run) {
    return {
      ...base,
      action: "dry_run_only",
      policy_decision: classification.policy_decision,
      should_suppress_heuristic_stop: false,
      runtime_action_taken_by_model: false,
      reason: "Dry-run mode; decision computed for telemetry only, no runtime action.",
    };
  }

  // Fully live (no domain gate). Only a confident benign-suppression candidate may suppress.
  if (classification.policy_decision === "visual_benign_suppression_candidate") {
    return {
      ...base,
      action: "suppress_heuristic_stop",
      policy_decision: "visual_benign_suppression_candidate",
      should_suppress_heuristic_stop: true,
      runtime_action_taken_by_model: true,
      reason: classification.reason,
    };
  }

  return {
    ...base,
    action: "allow_heuristic_stop",
    policy_decision: classification.policy_decision,
    should_suppress_heuristic_stop: false,
    runtime_action_taken_by_model: false,
    reason: classification.reason,
  };
}
