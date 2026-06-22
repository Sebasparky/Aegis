/**
 * Activation-Gated Visual Judgment v0 — runtime stuck-state adapter.
 *
 * STATUS: flag-gated, default OFF, dev-local. This is the FIRST place the visual
 * classifier's result is allowed to influence a runtime decision — and ONLY inside
 * already-triggered human-verification (HV) stuck-state handling at the snapshot
 * gate. It is the wiring promised by `runtimeSeam.ts` (which forbids shelling out
 * to / importing the offline `scripts/hv_vision_*` harness): inference runs in a
 * dev-only LOCAL SIDECAR over localhost HTTP, reached through `callVisualJudgmentSidecar`.
 *
 * ── THE RULE YOU CANNOT MISS ────────────────────────────────────────────────
 * ACTIVATION-GATED. A screenshot is captured and the model is asked ONLY when an
 * existing suspicious/stuck/HV heuristic has already fired (the caller passes the
 * activation reason). No activation reason ⇒ no capture ⇒ no model call. There is
 * no continuous watching, no per-page-load classification, no polling.
 *
 * ── SAFETY BOUNDARY (detect and route only) ─────────────────────────────────
 * Antigen detects page STATE and routes to EXISTING flows. The model NEVER solves,
 * clicks, presses, holds, drags, types into, OCRs, classifies the answer of, or
 * bypasses any CAPTCHA / human-verification / 2FA / passkey check. The only runtime
 * effect this module can produce is to DECLINE to escalate a heuristic HV alarm that
 * the model judges (with high confidence) to be a benign surface — never to act
 * against a challenge. `confident_human_needed` and `uncertain` both fall through to
 * the caller's existing conservative behavior (mint VGC / 409).
 *
 * ── DATA SAFETY ─────────────────────────────────────────────────────────────
 * The review queue stores SAFE METADATA ONLY (hostname, enums, model label +
 * confidence + top-3, outcome, ids). No screenshot bytes, no full URL/path/query,
 * no selectors, no coordinates, no raw page text, no iframe src. The redacted frame
 * lives ONLY on disk under a gitignored dev-artifacts dir; its path is written to the
 * dev-local JSONL queue (so suppressions/uncertain cases stay reviewable) but is
 * NEVER emitted to a console log line or any API/agent response.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveSnapshotCdpTarget } from "../cdpTargetSelection.js";
import { captureRedactedScreenshot } from "../screenshotRedaction.js";
import { DEFAULT_BENIGN_SUPPRESSION_THRESHOLD, decideVisualLivePolicy } from "./livePolicy.js";
import type { VisualLivePolicyAction, VisualLivePolicyDecisionLabel } from "./livePolicy.js";
import type {
  VisualJudgmentActivationReason,
  VisualJudgmentLabelScore,
  VisualJudgmentResult,
} from "./runtimeSeam.js";

// ── Flags (mirror flags.ts getter discipline; all default OFF / safe) ────────

/** Master gate. OFF ⇒ no capture, no sidecar call, no queue write, byte-identical. */
export function isVisualJudgmentEnabled(): boolean {
  return process.env.ANTIGEN_VISUAL_JUDGMENT_ENABLED === "true";
}

/**
 * DRY_RUN: run the classifier and log/queue the decision, but NEVER suppress any
 * VGC/409 behavior. The safe rollout step before allowing live suppression.
 */
export function isVisualJudgmentDryRun(): boolean {
  return process.env.ANTIGEN_VISUAL_JUDGMENT_DRY_RUN === "true";
}

/**
 * LIVE_POLICY: the second, independent gate (on top of ENABLED + !DRY_RUN) that lets
 * `decideVisualLivePolicy` actually SUPPRESS a heuristic HV stop at the snapshot-mint
 * path. Default OFF ⇒ the policy stays computed-for-telemetry-only (`dry_run_only`) and
 * no snapshot 409 is ever suppressed. This is the master switch for the first dev-only
 * live-suppression experiment; it is intentionally separate from ENABLED so the model can
 * run + be reviewed in dry-run long before it is ever allowed to change behavior.
 */
export function isVisualJudgmentLivePolicyEnabled(): boolean {
  return process.env.ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY === "true";
}

/**
 * Parse `ANTIGEN_VISUAL_JUDGMENT_LIVE_ALLOWLIST` (comma-separated bare hostnames) into a
 * trimmed, lowercased, de-blanked list. Empty / unset ⇒ `[]` ⇒ no origin is ever allowed
 * (fail-closed). No subdomain wildcards in v0 — exact hostname match only.
 */
export function parseVisualJudgmentLiveAllowlist(): string[] {
  const raw = process.env.ANTIGEN_VISUAL_JUDGMENT_LIVE_ALLOWLIST;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Exact, case-insensitive allowlist membership for the live-policy gate. Empty/unset
 * allowlist ⇒ false (fail-closed) — a missing allowlist must never permit suppression.
 */
export function isOriginAllowedForVisualJudgmentLivePolicy(originHost: string): boolean {
  const host = (originHost ?? "").trim().toLowerCase();
  if (!host) return false;
  return parseVisualJudgmentLiveAllowlist().includes(host);
}

/** Localhost sidecar base URL (runtime → sidecar; never the offline harness). */
export function getVisualJudgmentSidecarUrl(): string {
  const v = process.env.ANTIGEN_VISUAL_JUDGMENT_SIDECAR_URL;
  return v && v.trim() ? v.trim() : "http://127.0.0.1:8782";
}

/** Conservative default — a false benign→wall is the dangerous direction. */
export function getVisualJudgmentHvThreshold(): number {
  return parseThreshold(process.env.ANTIGEN_VISUAL_JUDGMENT_HV_THRESHOLD, 0.85);
}

export function getVisualJudgmentBenignThreshold(): number {
  return parseThreshold(process.env.ANTIGEN_VISUAL_JUDGMENT_BENIGN_THRESHOLD, 0.8);
}

function parseThreshold(raw: string | undefined, fallback: number): number {
  if (!raw || !raw.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Sidecar HTTP timeout — short; a slow/hung sidecar must never block the runtime. */
const SIDECAR_TIMEOUT_MS = 2500;

/**
 * Benign page-state labels the model may use to SUPPRESS a false HV escalation
 * (verbatim from the trained model's label_map; mirrors the task's benign set).
 * `page_level_hv_wall` is the only HV label and is NEVER in this set.
 */
export const BENIGN_LABELS = [
  "false_positive_normal_page",
  "false_positive_normal_modal",
  "cookie_banner",
  "newsletter_modal",
  "sign_in_drawer",
] as const;

/** The single high-consequence HV wall label. */
export const HV_WALL_LABEL = "page_level_hv_wall";

// ── Outcome / internal status shape (for a FUTURE live-UI layer; no UI here) ──

export type VisualJudgmentOutcome =
  | "confident_human_needed"
  | "confident_false_positive_or_benign"
  | "uncertain";

export type VisualJudgmentReviewReason =
  | "high_consequence_prediction"
  | "benign_suppression"
  | "uncertain_fallback"
  | "classifier_unavailable";

/**
 * Compact, safe status for a session's most recent judgment. Exposed for a later
 * live-UI update layer — NOT rendered anywhere in this slice. Safe scalars only.
 */
export interface VisualJudgmentStatus {
  event_id: string;
  created_at: string;
  activation_reason: VisualJudgmentActivationReason;
  outcome: VisualJudgmentOutcome;
  model_predicted_label: string | null;
  model_confidence: number | null;
  runtime_action_taken_by_model: boolean;
}

const lastJudgmentBySession = new Map<string, VisualJudgmentStatus>();

/** Read the most recent judgment status for a session (future UI seam). */
export function getLastVisualJudgmentForSession(sessionId: string): VisualJudgmentStatus | undefined {
  return lastJudgmentBySession.get(sessionId);
}

// ── Decision policy (pure) ───────────────────────────────────────────────────

export interface OutcomeDecision {
  outcome: VisualJudgmentOutcome;
  /** True ⇒ runtime should NOT escalate this heuristic HV alarm (benign + high-conf + not dry-run). */
  suppress: boolean;
  review_reason: VisualJudgmentReviewReason;
}

/**
 * Map a model result (or `null` when unavailable) to one of the three outcomes.
 *
 *  - page_level_hv_wall  & conf ≥ HV threshold     → confident_human_needed
 *  - benign label        & conf ≥ benign threshold → confident_false_positive_or_benign
 *  - otherwise (incl. null)                         → uncertain
 *
 * `suppress` is true ONLY for a confident benign outcome when NOT in dry-run.
 * Confident-human-needed and uncertain never suppress — they keep the caller's
 * conservative behavior.
 */
export function decideOutcome(result: VisualJudgmentResult | null, dryRun: boolean): OutcomeDecision {
  if (!result) {
    return { outcome: "uncertain", suppress: false, review_reason: "classifier_unavailable" };
  }
  const hvThreshold = getVisualJudgmentHvThreshold();
  const benignThreshold = getVisualJudgmentBenignThreshold();

  if (result.predictedLabel === HV_WALL_LABEL && result.confidence >= hvThreshold) {
    // High-consequence: confirm human-needed, but DO NOT change behavior (the caller
    // already routes to the human path). Always logged for review.
    return { outcome: "confident_human_needed", suppress: false, review_reason: "high_consequence_prediction" };
  }
  if ((BENIGN_LABELS as readonly string[]).includes(result.predictedLabel) && result.confidence >= benignThreshold) {
    return {
      outcome: "confident_false_positive_or_benign",
      suppress: !dryRun,
      review_reason: "benign_suppression",
    };
  }
  // page_level_hv_wall predicted but below the conservative HV threshold also lands
  // here → uncertain → conservative fallback (still logged, flagged high-consequence).
  const review_reason: VisualJudgmentReviewReason =
    result.predictedLabel === HV_WALL_LABEL ? "high_consequence_prediction" : "uncertain_fallback";
  return { outcome: "uncertain", suppress: false, review_reason };
}

// ── Sidecar adapter (localhost HTTP; fail soft) ──────────────────────────────

interface SidecarPredictResponse {
  predicted_label?: unknown;
  confidence?: unknown;
  top_3?: unknown;
  model_version?: unknown;
  needs_human_review?: unknown;
}

/**
 * Ask the dev-only localhost sidecar to classify ONE already-redacted frame on disk.
 * Returns a `VisualJudgmentResult` or `null` on ANY failure (sidecar down, timeout,
 * non-200, malformed JSON) — the runtime must fail soft to `uncertain`, never throw.
 * The runtime does NOT import or shell out to the offline harness; it only speaks HTTP
 * to the sidecar, which owns the model.
 */
export async function callVisualJudgmentSidecar(absFramePath: string): Promise<VisualJudgmentResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
  try {
    const res = await fetch(`${getVisualJudgmentSidecarUrl().replace(/\/+$/, "")}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frame_path: absFramePath }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as SidecarPredictResponse;
    return normalizeSidecarResult(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce the sidecar's JSON into the safe result shape; null if unusable. */
function normalizeSidecarResult(body: SidecarPredictResponse): VisualJudgmentResult | null {
  const predictedLabel = typeof body.predicted_label === "string" ? body.predicted_label : null;
  if (!predictedLabel) return null;
  const confidence = typeof body.confidence === "number" && Number.isFinite(body.confidence) ? body.confidence : 0;
  const topLabels: VisualJudgmentLabelScore[] = Array.isArray(body.top_3)
    ? body.top_3
        .map((e): VisualJudgmentLabelScore | null => {
          if (e && typeof e === "object") {
            const label = (e as Record<string, unknown>).label;
            const prob = (e as Record<string, unknown>).prob;
            if (typeof label === "string") {
              return { label, confidence: typeof prob === "number" && Number.isFinite(prob) ? prob : 0 };
            }
          }
          return null;
        })
        .filter((x): x is VisualJudgmentLabelScore => x !== null)
    : [];
  return {
    predictedLabel,
    confidence,
    topLabels,
    needsHumanReview: body.needs_human_review === true,
    advisoryOnly: true,
    modelVersion: typeof body.model_version === "string" ? body.model_version : undefined,
    source: "model",
  };
}

// ── Dev-local path resolution (mirrors datasetCapture.ts) ────────────────────

/** Locate the gitignored `dev-artifacts` root from apps/api cwd. */
export function resolveDevArtifactsRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), "dev-artifacts"),
    path.resolve(process.cwd(), "../..", "dev-artifacts"),
    path.resolve(process.cwd(), "..", "dev-artifacts"),
  ];
  const existing = candidates.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });
  return existing ?? path.resolve(process.cwd(), "../..", "dev-artifacts");
}

/** Absolute path to the runtime judgment JSONL queue (env override wins). */
export function resolveQueuePath(): string {
  const env = process.env.ANTIGEN_VISUAL_JUDGMENT_QUEUE;
  if (env && env.trim()) return path.resolve(process.cwd(), env.trim());
  return path.join(resolveDevArtifactsRoot(), "hv-vision-review", "runtime-judgment-queue.jsonl");
}

/** UTC YYYY-MM-DD date-directory name. */
function dateDir(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Review queue (append-only JSONL; safe metadata only) ─────────────────────

/**
 * Record of what the live policy (`decideVisualLivePolicy`) decided for this event,
 * computed alongside `decideOutcome` and written to the offline review queue. The gate
 * fields now reflect the REAL flags/allowlist used at decision time (not literal false):
 * when the live-policy experiment is off/dry-run/non-allowlisted the policy returns
 * `dry_run_only`/`allow_heuristic_stop` and nothing is acted on (`shadow_only:true`,
 * `live_policy_runtime_action_taken:false`); when fully gated + a confident benign verdict
 * it returns `suppress_heuristic_stop` and a snapshot 409 is actually suppressed
 * (`shadow_only:false`, `live_policy_runtime_action_taken:true`).
 * Safe scalars/enums/fixed reason strings only — no URL/path/selector/coordinate/text.
 */
export interface VisualLivePolicyShadowTelemetry {
  /** True when nothing was acted on; false ONLY when live policy actually suppressed a stop. */
  shadow_only: boolean;
  /** Real live-policy flag state (ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY). */
  live_policy_enabled: boolean;
  /** Real allowlist-membership result for this origin (ANTIGEN_VISUAL_JUDGMENT_LIVE_ALLOWLIST). */
  domain_allowed: boolean;
  policy_decision: VisualLivePolicyDecisionLabel;
  policy_action: VisualLivePolicyAction;
  should_suppress_heuristic_stop: boolean;
  /** True ONLY for an actual live suppression. */
  live_policy_runtime_action_taken: boolean;
  hv_action_threshold: number;
  benign_suppression_threshold: number;
  /** Fixed English reason from the pure policy fn — no PII. */
  policy_reason: string;
}

export interface VisualJudgmentReviewEvent {
  schema_version: "hv-vision-runtime-judgment/v0";
  event_id: string;
  created_at: string;
  session_id: string;
  activation_reason: VisualJudgmentActivationReason;
  trigger_basis: string | null;
  /** Hostname only — never a full URL, path, or query. */
  origin_host: string;
  /**
   * Dev-local frame path relative to the repo root (includes the `dev-artifacts/`
   * segment, e.g. `dev-artifacts/hv-vision-runtime-frames/.../frame.png`), or null
   * when no frame was written. Never absolute; resolvable from the repo root.
   */
  frame_path: string | null;
  model_predicted_label: string | null;
  model_confidence: number | null;
  model_top_3: VisualJudgmentLabelScore[];
  outcome: VisualJudgmentOutcome;
  runtime_action_taken_by_model: boolean;
  /** Shadow-only live-policy decision (computed, never acted on). See type docs. */
  live_policy_shadow: VisualLivePolicyShadowTelemetry;
  /** Always null at capture — human label slot for offline review. */
  human_label: null;
  review_status: "pending";
  review_reason: VisualJudgmentReviewReason;
}

/** Append one JSONL line. Best-effort; NEVER throws (dev-local learning store). */
export function appendVisualJudgmentReviewEvent(event: VisualJudgmentReviewEvent): void {
  try {
    const file = resolveQueuePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    /* dev-only best-effort */
  }
}

// ── Safe telemetry (mirrors logHvActionDebug; gated by ANTIGEN_HV_DEBUG) ─────

/**
 * Behavior-neutral judgment telemetry. No-op unless ANTIGEN_HV_DEBUG is on. Callers
 * pass safe scalars only — never a frame path, base64, url, selector, or coordinate.
 */
export function logVisualJudgmentDebug(fields: Record<string, string | number | boolean>): void {
  if (process.env.ANTIGEN_HV_DEBUG !== "true") return;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  // eslint-disable-next-line no-console
  console.log(`[VisualJudgment] ${parts.join(" ")}`);
}

// ── Redacted frame capture (reuses the fail-closed primitive) ────────────────

/** Safe redacted-screenshot shape consumed here (default seam → captureRedactedScreenshot). */
type JudgmentScreenshot = { ok: true; base64: string } | { ok: false };

async function defaultCaptureRedactedFrame(cdpUrl: string): Promise<JudgmentScreenshot> {
  const resolved = await resolveSnapshotCdpTarget(cdpUrl);
  if (!resolved) return { ok: false };
  const shot = await captureRedactedScreenshot({
    browserWsUrl: resolved.browserWsUrl,
    pageTargetId: resolved.target.id,
  });
  return shot.ok ? { ok: true, base64: shot.base64 } : { ok: false };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface EvaluateVisualJudgmentArgs {
  sessionId: string;
  activationReason: VisualJudgmentActivationReason;
  cdpUrl: string | null | undefined;
  /** Hostname only (caller derives from snapshot.url). */
  originHost: string;
  triggerBasis?: string | null;
  /** Coarse failure-code strings already surfaced by runtime — no payloads. */
  recentFailureCodes?: string[];
  /** Coarse action kind only — never selectors/coords/values. */
  lastAgentAction?: string;
}

export interface EvaluateVisualJudgmentSeams {
  captureRedactedFrame?: (cdpUrl: string) => Promise<JudgmentScreenshot>;
  callSidecar?: (absFramePath: string) => Promise<VisualJudgmentResult | null>;
  now?: () => Date;
  /** Frame output root override (tests). */
  frameRoot?: string;
}

export interface VisualJudgmentEvaluation {
  ran: boolean;
  /** Runtime should skip the HV escalation (mint/409) for this snapshot when true. */
  suppress: boolean;
  outcome?: VisualJudgmentOutcome;
  result?: VisualJudgmentResult | null;
}

/**
 * Run one activation-gated visual judgment. Captures a redacted frame, asks the
 * sidecar, decides an outcome, ALWAYS appends a safe review event, and returns
 * whether the caller should suppress the HV escalation. NEVER throws; any failure
 * fails soft to `uncertain` / `suppress:false`.
 *
 * When the flag is OFF this returns immediately with no capture, no call, no queue
 * write — byte-identical to today.
 */
export async function evaluateVisualJudgment(
  args: EvaluateVisualJudgmentArgs,
  seams: EvaluateVisualJudgmentSeams = {},
): Promise<VisualJudgmentEvaluation> {
  if (!isVisualJudgmentEnabled()) return { ran: false, suppress: false };

  const now = seams.now ? seams.now() : new Date();
  const event_id = randomUUID();
  const created_at = now.toISOString();
  const dryRun = isVisualJudgmentDryRun();

  let result: VisualJudgmentResult | null = null;
  let frameRelPath: string | null = null;

  try {
    // 1. Capture the already-redacted frame (reused fail-closed primitive).
    const shot = args.cdpUrl
      ? await (seams.captureRedactedFrame ?? defaultCaptureRedactedFrame)(args.cdpUrl)
      : ({ ok: false } as JudgmentScreenshot);

    if (shot.ok) {
      // 2. Persist to a gitignored dev-local file so suppressions stay reviewable.
      const devArtifactsRoot = resolveDevArtifactsRoot();
      const root = seams.frameRoot ?? path.join(devArtifactsRoot, "hv-vision-runtime-frames");
      const rel = path.join(dateDir(now), event_id, "frame.png");
      const abs = path.join(root, rel);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(shot.base64, "base64"));
        // Repo-root-relative path (includes the dev-artifacts/ segment) so any consumer
        // resolves the frame from the repo root; round-trips via path.resolve and is
        // never an absolute path in the JSONL.
        frameRelPath = path.relative(path.dirname(devArtifactsRoot), abs);
        // 3. Ask the sidecar with the ACTUAL on-disk absolute path just written above
        //    (localhost HTTP; null on any failure).
        result = await (seams.callSidecar ?? callVisualJudgmentSidecar)(abs);
      } catch {
        result = null;
      }
    }
  } catch {
    result = null;
  }

  // 4. Outcome taxonomy ONLY. `decideOutcome` is retained for the review queue's
  //    `outcome` / `review_reason` enums (dataset stability) — it NO LONGER drives runtime
  //    suppression. The suppression authority is `decideVisualLivePolicy` (step 4b).
  const decision = decideOutcome(result, dryRun);

  // 4b. LIVE POLICY: the single source of runtime suppression. The gate inputs are now the
  //     REAL flags/allowlist — not shadow literals. Suppression happens ONLY when this fn
  //     returns `suppress_heuristic_stop`, which requires ENABLED (we are here) +
  //     ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY + !dry_run + origin in the allowlist + an
  //     available model + a benign label at/above the 0.95 benign threshold. Every other
  //     case (live flag off, dry-run, non-allowlisted, model unavailable, unknown label,
  //     page_level_hv_wall at any confidence, benign < 0.95) keeps the heuristic stop.
  const livePolicy = decideVisualLivePolicy({
    heuristic_hv_stop: true,
    heuristic_label: args.triggerBasis ?? null,
    trigger_basis: args.triggerBasis ?? null,
    model_predicted_label: result?.predictedLabel ?? null,
    model_confidence: result?.confidence ?? null,
    model_top_3: result?.topLabels ?? [],
    model_available: result !== null,
    visual_judgment_enabled: true, // already inside the enabled flow
    live_policy_enabled: isVisualJudgmentLivePolicyEnabled(),
    dry_run: dryRun,
    domain_allowed: isOriginAllowedForVisualJudgmentLivePolicy(args.originHost),
    hv_action_threshold: getVisualJudgmentHvThreshold(), // existing HV threshold, default 0.85
    benign_suppression_threshold: DEFAULT_BENIGN_SUPPRESSION_THRESHOLD, // 0.95 live threshold (NOT the 0.80 outcome-taxonomy threshold)
    origin_host: args.originHost,
  });

  // The ONLY runtime suppression signal. `suppress_heuristic_stop` is the sole action that
  // sets `runtime_action_taken_by_model:true`; any other action keeps the stop.
  const suppress = livePolicy.action === "suppress_heuristic_stop";

  // 5. ALWAYS append a safe review event (including suppressions and unavailability).
  appendVisualJudgmentReviewEvent({
    schema_version: "hv-vision-runtime-judgment/v0",
    event_id,
    created_at,
    session_id: args.sessionId,
    activation_reason: args.activationReason,
    trigger_basis: args.triggerBasis ?? null,
    origin_host: args.originHost,
    frame_path: frameRelPath,
    model_predicted_label: result?.predictedLabel ?? null,
    model_confidence: result?.confidence ?? null,
    model_top_3: result?.topLabels ?? [],
    outcome: decision.outcome,
    runtime_action_taken_by_model: suppress,
    live_policy_shadow: {
      // `shadow_only` is false ONLY when the live policy actually suppressed a stop.
      shadow_only: !livePolicy.runtime_action_taken_by_model,
      live_policy_enabled: isVisualJudgmentLivePolicyEnabled(),
      domain_allowed: isOriginAllowedForVisualJudgmentLivePolicy(args.originHost),
      policy_decision: livePolicy.policy_decision,
      policy_action: livePolicy.action,
      should_suppress_heuristic_stop: livePolicy.should_suppress_heuristic_stop,
      live_policy_runtime_action_taken: livePolicy.runtime_action_taken_by_model,
      hv_action_threshold: livePolicy.hv_action_threshold,
      benign_suppression_threshold: livePolicy.benign_suppression_threshold,
      policy_reason: livePolicy.reason,
    },
    human_label: null,
    review_status: "pending",
    review_reason: decision.review_reason,
  });

  // 6. Record the compact status for a future live-UI layer (safe scalars only).
  lastJudgmentBySession.set(args.sessionId, {
    event_id,
    created_at,
    activation_reason: args.activationReason,
    outcome: decision.outcome,
    model_predicted_label: result?.predictedLabel ?? null,
    model_confidence: result?.confidence ?? null,
    runtime_action_taken_by_model: suppress,
  });

  // 7. Safe telemetry — label/confidence/outcome + whether behavior changed. No frame path.
  logVisualJudgmentDebug({
    scope: "visual_judgment",
    activation_reason: args.activationReason,
    classifier_available: result !== null,
    model_predicted_label: result?.predictedLabel ?? "none",
    model_confidence: result?.confidence ?? -1,
    outcome: decision.outcome,
    dry_run: dryRun,
    runtime_behavior_changed: suppress,
    live_policy_enabled: isVisualJudgmentLivePolicyEnabled(),
    domain_allowed: isOriginAllowedForVisualJudgmentLivePolicy(args.originHost),
    live_policy_decision: livePolicy.policy_decision,
    live_policy_action: livePolicy.action,
    live_policy_runtime_action_taken: livePolicy.runtime_action_taken_by_model,
  });

  return { ran: true, suppress, outcome: decision.outcome, result };
}

/** Test-only: reset the in-memory last-judgment status map. */
export function __resetVisualJudgmentStatus(): void {
  lastJudgmentBySession.clear();
}
