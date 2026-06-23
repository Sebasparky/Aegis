/**
 * Antigen Runtime Flag Diagnostics.
 *
 * Single source of truth for "which Antigen runtime flags are effective in THIS
 * API process". Used by both the boot-time startup log line and the
 * GET /api/runtime/status diagnostic endpoint, so the two can never disagree.
 *
 * Motivation: during live smokes, ANTIGEN_* flags were repeatedly set in the
 * wrong shell (adapter/MCP env) while the API process ran without them, making
 * results misleading. This makes the API process's effective flags observable.
 *
 * SAFETY: output is a fixed allowlist object literal. There is no path that
 * copies arbitrary process.env into the result. AEGIS_PLAYWRIGHT_CDP_URL is
 * reported only as a boolean (cdp_port_configured) — never the URL itself. No
 * secrets, tokens, cookies, vault/KMS config, or extension secrets are read or
 * returned here.
 */

import { isClickVerifyEnabled } from "./antigenClickVerification.js";
import { isActiveSurfacesEnabled } from "./antigenSnapshotPageMap.js";
import { isSurfaceResolveEnabled } from "./antigenSurfaceResolution.js";
import { isLogicalRefRecoveryEnabled } from "./antigenLogicalRecovery.js";
import { isHumanVerificationEnabled, isHvDebugEnabled } from "./humanVerificationState.js";
import { isFillStateEnabled } from "./postFillProbe.js";
import { getKeyEventsFullEnabled } from "./inputRealismTyper.js";
import { resolvePointerTimingMode } from "./nativePointerRuntime.js";
import { traceEnabled } from "./browserRunTrace.js";
import { timingEnabled } from "./browserTiming.js";
import { isVisualGestureCapsuleEnabled } from "./visualGestureCapsule.js";
import {
  isHvVisionClassifierEnabled,
  isHvVisionDatasetEnabled,
  isManualVisualReviewCaptureEnabled,
} from "./visualBlockerClassifier/flags.js";
import {
  isVisualJudgmentEnabled,
  isVisualJudgmentDryRun,
  isVisualJudgmentLivePolicyEnabled,
} from "./visualBlockerClassifier/visualJudgment.js";

export interface AntigenRuntimeStatus {
  click_verify: boolean;
  active_surfaces: boolean;
  surface_resolve: boolean;
  logical_recovery: boolean;
  human_verification: boolean;
  /**
   * Whether ANTIGEN_HV_DEBUG is on. Dev-only HV wall debug telemetry is emitted
   * only when this AND human_verification are both true. Metadata flag only — no
   * challenge text, URLs, selectors, refs, iframe srcs, or HTML are ever logged.
   */
  hv_debug: boolean;
  /**
   * Whether ANTIGEN_VISUAL_GESTURE_CAPSULE is on (default off). Gates the
   * Visual Gesture Capsule path (opaque-wall user-presence relay). Foundation
   * is byte-identical when off — no capsule created, no capture, no relay.
   */
  visual_gesture_capsule: boolean;
  /**
   * Whether ANTIGEN_HV_VISION_CLASSIFIER is on (default off). Gates the shadow-only
   * VisualBlockerClassifierPipeline that runs after the SurfaceBoundaryRouter decides
   * `visual_classifier_candidate`. Phase 1 is byte-identical when off and shadow-only
   * when on — no VGC mint, no 409, no capsule change; every PolicyDecision is
   * `enforced: false`. Independent of hv_debug (which gates only debug logging).
   */
  hv_vision_classifier: boolean;
  /**
   * Whether ANTIGEN_HV_VISION_DATASET is on (default off). Additional opt-in on top
   * of hv_vision_classifier that enables DEV-ONLY, LOCAL, gitignored redacted dataset
   * capture (frame.png + safe meta.json) for a real visual_classifier_candidate.
   * Fire-and-forget — never affects the request; byte-identical when off. No API route
   * or labeling UI (those are a later phase).
   */
  hv_vision_dataset: boolean;
  /**
   * Whether ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE is on (default off). Gates the
   * dev/QA-only MANUAL capture of benign hard negatives from NORMAL snapshots. Never
   * automatic and never watches — a capture happens only on an explicit QA call. Runs
   * NO classifier; writes a redacted frame + one safe runtime-judgment-queue event for
   * the existing offline importer. Endpoint/tool is unavailable + no-op when off;
   * byte-identical.
   */
  manual_visual_review_capture: boolean;
  /**
   * Whether ANTIGEN_VISUAL_JUDGMENT_ENABLED is on (default off). Master gate for the
   * activation-gated visual judgment adapter (redacted frame capture + localhost sidecar
   * call + review-queue write inside snapshot HV stuck-state handling). Off ⇒ byte-identical.
   */
  visual_judgment_enabled: boolean;
  /**
   * Whether ANTIGEN_VISUAL_JUDGMENT_DRY_RUN is on. When on, the judgment is computed and
   * queued but NEVER suppresses a stop — the safe rollout step before live suppression.
   */
  visual_judgment_dry_run: boolean;
  /**
   * Whether ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY is on (default off). The second, independent
   * gate that lets `decideVisualLivePolicy` actually suppress a snapshot HV 409 — for a
   * confident benign surface verdict (≥0.95) with dry-run off. There is NO domain allowlist:
   * suppression rests solely on the current rendered-surface classification. Off ⇒ judgment
   * stays telemetry-only.
   */
  visual_judgment_live_policy: boolean;
  fill_state: boolean;
  /**
   * Whether ANTIGEN_INPUT_KEYEVENTS_FULL is on (default true). When on, realistic
   * typing emits the full rawKeyDown → char → keyUp sequence per character instead
   * of the lone char event. Behavior-neutral for form fields.
   */
  keyevents_full: boolean;
  /**
   * Pointer animation timing. "fast" maps to the internal "native" profile
   * (~120ms move, dev/QA); "realistic" is the production-safe default.
   */
  pointer_timing: "fast" | "realistic";
  browser_trace: boolean;
  timing_debug: boolean;
  require_antigen_tools: boolean;
  /** True unless ANTIGEN_BROWSER_HEADLESS === "false" (which forces visible). */
  headless: boolean;
  /** Whether AEGIS_PLAYWRIGHT_CDP_URL is configured. Never the URL itself. */
  cdp_port_configured: boolean;
}

/**
 * Effective Antigen runtime flag values for the current API process. Reuses the
 * authoritative per-flag getters so parsing semantics match the code that acts
 * on them; the three getter-less flags are parsed here with documented rules.
 */
export function getAntigenRuntimeStatus(): AntigenRuntimeStatus {
  return {
    click_verify: isClickVerifyEnabled(),
    active_surfaces: isActiveSurfacesEnabled(),
    surface_resolve: isSurfaceResolveEnabled(),
    logical_recovery: isLogicalRefRecoveryEnabled(),
    human_verification: isHumanVerificationEnabled(),
    hv_debug: isHvDebugEnabled(),
    visual_gesture_capsule: isVisualGestureCapsuleEnabled(),
    hv_vision_classifier: isHvVisionClassifierEnabled(),
    hv_vision_dataset: isHvVisionDatasetEnabled(),
    manual_visual_review_capture: isManualVisualReviewCaptureEnabled(),
    visual_judgment_enabled: isVisualJudgmentEnabled(),
    visual_judgment_dry_run: isVisualJudgmentDryRun(),
    visual_judgment_live_policy: isVisualJudgmentLivePolicyEnabled(),
    fill_state: isFillStateEnabled(),
    keyevents_full: getKeyEventsFullEnabled(),
    pointer_timing: resolvePointerTimingMode() === "native" ? "fast" : "realistic",
    browser_trace: traceEnabled(),
    timing_debug: timingEnabled(),
    require_antigen_tools: process.env.ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS === "true",
    // Code treats ANTIGEN_BROWSER_HEADLESS === "false" as "visible"; default headless.
    headless: process.env.ANTIGEN_BROWSER_HEADLESS !== "false",
    // Boolean only — the URL is never read into output.
    cdp_port_configured: Boolean(process.env.AEGIS_PLAYWRIGHT_CDP_URL),
  };
}

/**
 * One-line sanitized startup log string, e.g.:
 * [AntigenRuntimeFlags] click_verify=true active_surfaces=true surface_resolve=true
 *   logical_recovery=true human_verification=true hv_debug=false fill_state=true
 *   keyevents_full=true pointer_timing=fast browser_trace=true timing_debug=true
 *   require_antigen_tools=false headless=false cdp_port_configured=true
 */
export function formatAntigenRuntimeFlagsLine(): string {
  const s = getAntigenRuntimeStatus();
  const parts = [
    `click_verify=${s.click_verify}`,
    `active_surfaces=${s.active_surfaces}`,
    `surface_resolve=${s.surface_resolve}`,
    `logical_recovery=${s.logical_recovery}`,
    `human_verification=${s.human_verification}`,
    `hv_debug=${s.hv_debug}`,
    `visual_gesture_capsule=${s.visual_gesture_capsule}`,
    `hv_vision_classifier=${s.hv_vision_classifier}`,
    `hv_vision_dataset=${s.hv_vision_dataset}`,
    `manual_visual_review_capture=${s.manual_visual_review_capture}`,
    `visual_judgment_enabled=${s.visual_judgment_enabled}`,
    `visual_judgment_dry_run=${s.visual_judgment_dry_run}`,
    `visual_judgment_live_policy=${s.visual_judgment_live_policy}`,
    `fill_state=${s.fill_state}`,
    `keyevents_full=${s.keyevents_full}`,
    `pointer_timing=${s.pointer_timing}`,
    `browser_trace=${s.browser_trace}`,
    `timing_debug=${s.timing_debug}`,
    `require_antigen_tools=${s.require_antigen_tools}`,
    `headless=${s.headless}`,
    `cdp_port_configured=${s.cdp_port_configured}`,
  ];
  return `[AntigenRuntimeFlags] ${parts.join(" ")}`;
}
