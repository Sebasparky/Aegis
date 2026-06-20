/**
 * VisualBlockerClassifierPipeline — type contracts (Phase 1, shadow-only).
 *
 * Companion to docs/visual-blocker-classifier-pipeline.md. SAFETY: every value
 * that may leave this module's pure functions (candidate / result / policy) is a
 * boolean, enum, bucket, or already-non-sensitive id. NEVER a rect, coordinate,
 * iframe `src`, raw page text, base64, selector, screenshot, or field value.
 *
 * Architectural separation this module preserves (the named "do not collapse"
 * risk): the SurfaceBoundaryRouter decides "needs visual classification", this
 * pipeline decides blocker / user-presence TYPE, and policy decides the action.
 * The router never mints a VGC; only an `enforced` policy decision (a LATER phase)
 * could route to the existing VGC flow. In Phase 1 `enforced` is always `false`.
 *
 * Blocker enums are taken VERBATIM from the north-star memo
 * (docs/antigen-vision-blocker-classifier.md).
 */

export type BlockerType =
  | "normal_or_unblocked"
  | "non_hv_modal"
  | "cookie_banner"
  | "login_wall"
  | "marketing_modal"
  | "hv_full_page"
  | "hv_center_modal"
  | "hv_small_widget"
  | "hv_press_hold"
  | "hv_interaction_active"
  | "hv_cleared_or_settling"
  | "unknown_blocked";

export type ConfidenceBucket = "low" | "medium" | "high";

export type VisualClassifierTriggerBasis =
  | "opaque_dominant_surface"
  | "unreadable_dominant_surface";

export type VisualClassifierCandidateReason =
  | "opaque_iframe"
  | "unreadable_dominant_surface"
  | "visual_dom_mismatch";

export type VisualClassifierDominantSurfaceKind =
  | "scrim_center_modal"
  | "top_layer_dialog"
  | "fixed_overlay"
  | "iframe"
  | "unknown";

/**
 * Stage 2 → Stage 3 handoff. Safe-fields only. NOTE (Phase 1): `page_url` is
 * intentionally OMITTED — domain + browser_session_id + candidate_id are enough
 * for correlation, and we do not want any URL flowing into a returned object or
 * telemetry. A sanitized origin-only field may be added in a later phase if needed.
 */
export interface VisualClassifierCandidate {
  candidate_id: string;
  browser_session_id: string;
  domain: string;
  trigger_basis: VisualClassifierTriggerBasis;
  candidate_reason: VisualClassifierCandidateReason;
  dominant_surface_kind: VisualClassifierDominantSurfaceKind;
  signals: {
    scrim_seen: boolean;
    centered_modal_seen: boolean;
    opaque_iframe_seen: boolean;
    visual_dom_contradiction_seen: boolean;
    dominant_text_uninspectable: boolean;
    pointer_interceptor_seen: boolean;
  };
  created_at: string;
}

/**
 * Stage 3 capture input shape — DECLARED for contract completeness only. Phase 1
 * performs NO capture: no instance of this is ever produced, and `png_base64` is
 * never created. The bytes (when a future phase fills this in) are memory-only and
 * must NEVER appear in a safe view, log, or API response.
 */
export interface VisualClassifierInput {
  candidate_id: string;
  region: "full_viewport" | "blocker_crop";
  png_base64: string;
  viewport_css_width: number;
  viewport_css_height: number;
  redaction: VisualClassifierInputRedactionStatus;
  captured_at: string;
}

export interface VisualClassifierInputRedactionStatus {
  redacted_field_count: number;
  redaction_verified: boolean;
  crop_applied: boolean;
  sensitive_fields_present: boolean;
}

export type VisualClassifierSource = "shadow_stub" | "dev_heuristic" | "manual_qa" | "model";

/** Stage 3 classifier output — north-star "safe outputs" (no coords/answers/text). */
export interface VisualClassifierResult {
  candidate_id: string;
  blocker_type: BlockerType;
  confidence_bucket: ConfidenceBucket;
  user_presence_required: boolean;
  wall_visible: boolean;
  safe_to_resume: boolean;
  classifier_source: VisualClassifierSource;
  model_version?: string;
  classified_at: string;
}

export type PolicyDecisionAction =
  | "route_to_user_presence_vgc"
  | "route_to_credential_flow"
  | "route_to_approval_flow"
  | "agent_may_handle"
  | "wait_and_recheck"
  | "live_guidance_keep_holding"
  | "fail_closed_or_ask_user";

export interface PolicyDecision {
  candidate_id: string;
  action: PolicyDecisionAction;
  /** Phase 1: ALWAYS the literal `false` (shadow). Never set through a variable. */
  enforced: false;
  basis_blocker_type: BlockerType;
  confidence_bucket: ConfidenceBucket;
  decided_at: string;
}

export type DatasetCaptureSkipReason =
  | "flag_disabled"
  | "not_a_candidate"
  | "no_session"
  | "redaction_failed"
  | "redaction_unverified"
  | "write_failed"
  | "rate_limited";

export interface DatasetCaptureDecision {
  capture: boolean;
  skip_reason?: DatasetCaptureSkipReason;
}

/**
 * Safe metadata written to `<dataset_dir>/<date>/<candidate_id>/meta.json` (Phase 2A).
 * SAFETY: every field is a boolean, enum, bucket, count, hostname, ISO timestamp, or
 * an already-non-sensitive id. NEVER a screenshot, base64, rect, coordinate, selector,
 * iframe `src`, raw page text, field value, or URL path/query. `domain` is hostname
 * only. `label`/`outcome` are null at capture — slots a LATER phase fills via human or
 * outcome labeling (never the stub's own guess).
 */
export interface VisionDatasetCaptureMeta {
  candidate_id: string;
  created_at: string;
  /** Hostname only — never path or query. */
  domain: string;
  trigger_basis: VisualClassifierTriggerBasis;
  candidate_reason: VisualClassifierCandidateReason;
  dominant_surface_kind: VisualClassifierDominantSurfaceKind;
  /** All booleans (see VisualClassifierCandidate["signals"]). */
  signals: VisualClassifierCandidate["signals"];
  classifier_source: VisualClassifierSource;
  blocker_type: BlockerType;
  confidence_bucket: ConfidenceBucket;
  policy_action: PolicyDecisionAction;
  /** Phase 2A: ALWAYS the literal `false` — shadow capture, never enforcement. */
  policy_enforced: false;
  redaction_verified: boolean;
  redacted_field_count: number;
  /** Phase 2A captures the full redacted viewport. Crop is Phase 2B. */
  region: "full_viewport";
  /** Null at capture — human label slot for a later phase. */
  label: null;
  /** Null at capture — outcome label slot for a later phase. */
  outcome: null;
}

export type VisionDatasetCaptureResult =
  | { written: true }
  | { written: false; skip_reason: DatasetCaptureSkipReason };

/** Reasons the pipeline does not run (returned, never thrown). */
export type PipelineSkipReason = "flag_disabled" | "not_a_candidate";

export interface PipelineRanResult {
  ran: true;
  candidate: VisualClassifierCandidate;
  result: VisualClassifierResult;
  policy: PolicyDecision;
}

export interface PipelineSkippedResult {
  ran: false;
  skip_reason: PipelineSkipReason;
}

export type PipelineOutcome = PipelineRanResult | PipelineSkippedResult;
