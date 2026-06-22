/**
 * Antigen Visual Judgment — activation-gated runtime SEAM (design types only).
 *
 * STATUS: TYPE CONTRACTS ONLY. This file declares the shapes for a FUTURE
 * shadow-mode visual-judgment call. It is:
 *   - imported by NOTHING in runtime (no call site, no wiring),
 *   - pure `type`/`interface` declarations (emits ZERO runtime JavaScript),
 *   - behavior-neutral: adding it changes no production code path.
 *
 * It is the companion to docs/antigen-visual-judgment-runtime-seam.md. Read that
 * doc for the activation rules, examples, promotion rule, and wiring steps.
 *
 * ── THE RULE YOU CANNOT MISS ────────────────────────────────────────────────
 * Antigen must NEVER continuously watch or classify the agent's screen. Visual
 * judgment is ACTIVATION-GATED: a screenshot is taken and a model is asked ONLY
 * when an existing suspicious-state trigger (see VisualJudgmentActivationReason)
 * has already fired. No activation reason ⇒ no screenshot ⇒ no model call. There
 * is no always-on / per-page-load / polling mode.
 *
 * ── SAFETY BOUNDARY (detect and route only) ─────────────────────────────────
 * The visual layer detects page STATE and routes to EXISTING flows. It must
 * NEVER solve, click, press, hold, drag, type into, OCR, classify the answer of,
 * or bypass any CAPTCHA / human-verification / 2FA / passkey check. The result
 * is an advisory label + confidence — nothing the agent could act on against a
 * challenge.
 *
 * SAFETY (data): no request/result object, log line, or API response built from
 * these types may ever carry screenshot bytes, base64, rects/coordinates,
 * selectors, iframe `src`, raw page text, field values, cookies, storage, or a
 * full URL. Correlation is by id. The redacted frame is produced ONLY by the
 * existing capture mechanism — this seam adds no new screenshot path.
 *
 * NOTE: when wired (a later, flag-gated change), inference must run via an
 * in-runtime adapter or a local sidecar — runtime must NOT shell out to or import
 * the offline Python harness (`scripts/hv_vision_*`).
 */

// Type-only imports are erased at compile time — they add no runtime dependency.
import type { VisualClassifierTriggerBasis, VisualClassifierSource } from "./types.js";

/**
 * The ONLY doors through which a visual-judgment request may be created. Each
 * corresponds to a suspicious state that ALREADY exists in runtime; this seam
 * adds no new detection. If none is true, there is no request and no capture.
 */
export type VisualJudgmentActivationReason =
  | "repeated_no_progress"
  | "action_failed"
  | "navigation_timeout"
  | "ref_stale_loop"
  | "possible_human_verification"
  | "protected_boundary"
  | "agent_requested_help"
  | "user_requested_review";

/**
 * Origin-only page metadata — included ONLY if already available and safe.
 * Follows the existing module's choice to keep full URLs out: hostname only,
 * never path/query, and a short sanitized title hint. Prefer omitting over
 * leaking.
 */
export interface VisualJudgmentPageMetadata {
  /** Hostname only (e.g. "www.example.com") — never a full URL, path, or query. */
  originHost?: string;
  /** Short, sanitized title hint. Never raw page text. */
  titleHint?: string;
}

/**
 * What runtime would pass to ask for one advisory page-state judgment.
 * Safe-fields only; correlation by id. No screenshot bytes ever live here.
 */
export interface VisualJudgmentRequest {
  /** Browser/task session correlation id. */
  sessionId: string;
  /** Required — the suspicious state that opened the gate. No empty/default reason. */
  activationReason: VisualJudgmentActivationReason;
  /** Preferred handle to an already-captured REDACTED frame (e.g. dataset candidate_id). */
  captureId?: string;
  /**
   * DEV-ONLY local, gitignored path to a redacted frame (e.g.
   * dev-artifacts/hv-vision-dataset/.../frame.png). NEVER sent to the agent,
   * NEVER logged, NEVER in an API response. Present only in local shadow runs.
   */
  framePath?: string;
  /** Reuses the existing enum when the surface router already produced one. */
  triggerBasis?: VisualClassifierTriggerBasis;
  /** Coarse failure-code strings already surfaced by runtime — no payloads. */
  recentFailureCodes: string[];
  /** Coarse action kind only (e.g. "click", "navigate") — never selectors/coords/values. */
  lastAgentAction?: string;
  /** Origin-only metadata, only if already available and safe. */
  pageMetadata?: VisualJudgmentPageMetadata;
}

/** One entry in the top-k label list. */
export interface VisualJudgmentLabelScore {
  /** Model-vocabulary page-state label (e.g. "page_level_hv_wall"). */
  label: string;
  /** Confidence in [0, 1]. */
  confidence: number;
}

/**
 * Advisory page-state estimate returned to runtime.
 *
 * `advisoryOnly` is the TypeScript literal `true` (mirrors `enforced: false` in
 * PolicyDecision). In v0 a result CANNOT interrupt the user, stop/redirect the
 * agent, mint a VGC, return a 409, or flip any enforcing decision — it is logged
 * for evaluation and otherwise discarded by the call site (shadow). It must
 * always be written as the literal `true`, never through a variable.
 */
export interface VisualJudgmentResult {
  /** Top page-state label (model-version dependent vocabulary). */
  predictedLabel: string;
  /** Top-label confidence in [0, 1]. */
  confidence: number;
  /** Top-k labels (typically 3), sorted descending. */
  topLabels: VisualJudgmentLabelScore[];
  /** True when below confidence threshold (or label is high-consequence). */
  needsHumanReview: boolean;
  /** Literal `true` — advisory/shadow-only; never promotable by mutation. */
  advisoryOnly: true;
  /** Model artifact id, when source is a model; absent otherwise. */
  modelVersion?: string;
  /** Reuses the existing enum: shadow_stub | dev_heuristic | manual_qa | model. */
  source: VisualClassifierSource;
}
