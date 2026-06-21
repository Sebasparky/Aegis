import { existsSync, createReadStream } from "fs";
import { randomBytes } from "crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type {
  AgentDelegation,
  Collar,
  DelegationTrustTaskCategory,
  ExternalAgentIdentity,
  ExternalAgentSkillSummary,
  ExternalAgentRunSummary,
  RouteRun,
  RouteRunReceipt,
  AegisExecutionSurface,
  RuntimeCoverageSummary,
  RuntimeObservationModeState,
  AuthenticatedSessionLoginRequest,
  SecretFieldInjection,
  SecretFieldInjectionStatus,
  TaskBrowserSession,
  CredentialUseAuthorization,
  SecurityChallenge,
  SecurityChallengeType,
  SecurityChallengeStatus,
  ChallengeEmailResolution,
  ChallengeEmailResolutionStatus,
  WorkspaceArtifactKind,
  CredentialStepHandoffResult,
  PaymentCardFillAuthorization,
  PaymentCardFillRequest,
  PaymentCardField,
  PurchaseConfirmationAuthorization,
  PurchaseConfirmationHandoffRecord,
  ProfileFieldKind,
  ProfileFieldRequest,
  ProfileFieldFillRequest,
  ProfileMemoryRequest,
  AccountCreationRequest,
  AccountCreationStepRequest,
  AccountCreationStepKind,
  AccountAccessMethod,
  HumanVerificationChallengeType,
  HumanVerificationRequest,
} from "@aegis/types";
import {
  createAuthenticatedSession,
  getAuthenticatedSessionHandle,
  observeAuthenticatedSession,
  navigateAuthenticatedSession,
} from "../runtime/authenticatedSessions.js";
import { getTaskBrowserSessionForReuse, getTaskBrowserSession, createTaskBrowserSession, closeTaskBrowserSession, findReadySessionByDelegationId, setTaskBrowserSessionCurrentUrl, getTaskBrowserSessionPointerState, setTaskBrowserSessionPointerState, advanceRiskState, type CreateTaskBrowserResult } from "../runtime/taskBrowserSessions.js";
import { classifyActionIntent } from "../detection/actionIntent.js";
import { evaluateActionGate } from "../detection/actionGate.js";
import { connectAndNavigateWithPointer, connectAndObserve, connectAndClick } from "../runtime/taskBrowserControl.js";
import { realisticClickByDescription, realisticClickKnownBox, realisticTypeTextViaCDP, realisticTypeKnownBox, setFieldValueKnownBox, scrollKnownBoxIntoView, injectNavigationMediationBannerViaCDP, type ClickVerifyOption } from "../runtime/realisticBrowserActions.js";
import { isClickVerifyEnabled } from "../runtime/antigenClickVerification.js";
import {
  extractAntigenSnapshotBundleViaCDP,
  detectPageHumanVerificationWallViaCDP,
  detectAmbiguousVisualObstructionViaCDP,
  classifyAmbiguousVisualObstruction,
  collectPageHvWallDebugViaCDP,
  type AntigenPageMeta,
  type AmbiguousVisualObstructionSignals,
  type HumanVerificationDebug,
  type PageHumanVerificationWall,
  type PageWallProbeReason,
  type PageWallProbeResult,
  type ScreenHvWallSignals,
} from "../runtime/antigenSnapshotRuntime.js";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import { classifySurfaceBoundary, type SurfaceBoundarySignals } from "../runtime/surfaceBoundary.js";
import { isHvVisionClassifierEnabled, isHvVisionDatasetEnabled, isVisionCaptureAndSkipEnabled } from "../runtime/visualBlockerClassifier/flags.js";
import { runVisualBlockerClassifierPipeline } from "../runtime/visualBlockerClassifier/pipeline.js";
import { captureVisionDatasetRecord } from "../runtime/visualBlockerClassifier/datasetCapture.js";
import { mapCaptureResultToBlockerStatus, buildVisualBlockerCapturedResponse, type VisualBlockerSkip } from "../runtime/visualBlockerClassifier/captureAndSkip.js";
import { createAntigenSnapshotRecord, toExternalAntigenSnapshotElement, resolveAntigenRefForSession, refreshAntigenSnapshotLease, ANTIGEN_SNAPSHOT_TTL_MS } from "../runtime/antigenSnapshotStore.js";
import { buildAntigenPageMap, buildActiveSurfaces, isActiveSurfacesEnabled, buildPostClickState, buildPostFillState, POST_CLICK_CHANGES } from "../runtime/antigenSnapshotPageMap.js";
import { isFillStateEnabled, runPostFillProbe } from "../runtime/postFillProbe.js";
import { readLiveCdpPageUrl, resolveSnapshotCdpTarget } from "../runtime/cdpTargetSelection.js";
// Dev-only, behavior-neutral, sanitized browser run trace (gated by
// ANTIGEN_BROWSER_TRACE=true). Recording never alters tool results and never
// leaks cdp_url, coordinates, profile paths, secrets, or raw typed text.
import { recordBrowserTraceEvent, sanitizeTraceUrl, type ActionPreflightStage } from "../runtime/browserRunTrace.js";
import { BrowserTimingScope, timingEnabled } from "../runtime/browserTiming.js";
// Same-page logical-ref recovery (env-gated, default-off). When enabled, a
// recoverable ANTIGEN_REF_STALE on a clearly low-risk click target is retried
// against a unique logically-equivalent element re-found on the same page; the
// unchanged realisticClickKnownBox + Phase 4B remain the authoritative gate.
import {
  isLogicalRefRecoveryEnabled,
  classifyLogicalRecoveryEligibility,
  recoverAntigenRefBox,
  sanitizeStaleReason,
  mapTtlRecoveryFailureReason,
  type AntigenRecoveryState,
  type AntigenTtlRecoveryState,
} from "../runtime/antigenLogicalRecovery.js";
// Surface-scoped live resolution (ANTIGEN_SURFACE_RESOLVE, default-off). A stale
// ag_* ref that belongs to an active surface (modal/drawer/popover) is re-resolved
// by SEMANTIC identity inside its live surface — never page-wide — and the
// unchanged realisticClickKnownBox + Phase 4B remain the authoritative final gate.
import {
  isSurfaceResolveEnabled,
  isSurfaceResolutionEligible,
  checkSurfaceLiveIntent,
  resolveSurfaceActionBox,
  type AntigenSurfaceResolutionState,
} from "../runtime/antigenSurfaceResolution.js";
// Human Presence Relay v1 (ANTIGEN_HUMAN_VERIFICATION, default-off): blocking
// human-verification surfaces auto-create a HumanVerificationRequest and arm a
// pre-action guard that fails background clicks/types fast with
// HUMAN_VERIFICATION_REQUIRED instead of producing stale-ref loops or logical
// recovery behind the challenge.
import {
  isHumanVerificationEnabled,
  isHvDebugEnabled,
  getActiveHumanVerification,
  clearActiveHumanVerification,
  recordActionNoProgress,
  hasRecentActionNoProgress,
  clearActionNoProgress,
} from "../runtime/humanVerificationState.js";
import {
  createOrReuseHumanVerificationRequest,
  findActiveHumanVerificationRequest,
  resolveChallengeNoLongerPresent,
  lazyExpireHumanVerificationRequest,
  humanVerificationAgentNextAction,
} from "../lib/humanVerificationLifecycle.js";
import { toAgentHumanVerificationView } from "./human-verification.js";
import {
  isVisualGestureCapsuleEnabled,
  getActiveVisualGestureCapsuleForBrowserSession,
  getSafeVisualGestureCapsuleView,
  type SafeVisualGestureCapsuleView,
} from "../runtime/visualGestureCapsule.js";
import { createVisualGestureCapsuleForOpaqueHv } from "../runtime/visualGestureCapsuleOrchestrator.js";
import { geometryObstructionStrength } from "../runtime/visualGestureCapsuleRecheck.js";
import { executeSecretInjectionViaCDP } from "../runtime/secretInjection.js";
import { resolveSecretInjectionCdpEndpoint } from "../runtime/cdpEndpointResolver.js";
import { executePaymentCardFillViaCDP, validateCardFillSelector, isAntigenRef, orderPaymentFillFields, isIframeCapablePaymentField } from "../runtime/paymentCardFill.js";
import { captureRedactedScreenshot } from "../runtime/screenshotRedaction.js";
import {
  registerProtectedIframeRedaction,
  getProtectedIframeRedactionFields,
  registerProtectedTopLevelRedaction,
  getProtectedTopLevelRedactionFields,
} from "../runtime/protectedIframeRedaction.js";
import { executeProfileFieldFillViaCDP, validateProfileFillSelector } from "../runtime/profileFieldFill.js";
import { executePurchaseConfirmation } from "../runtime/purchaseConfirmationHandoff.js";
import { performSubmitAndWait, SUBMIT_BLOCKLIST } from "../runtime/credentialStepHandoff.js";
import {
  agentDelegations,
  passes,
  skills,
  installedSkills,
  routes,
  routeRuns,
  collars,
  aegisVaultPasses,
  secretFieldInjections,
  credentialUseAuthorizations,
  sensitiveGrants,
  securityChallenges,
  humanVerificationRequests,
  paymentMethods,
  paymentCardFillAuthorizations,
  paymentCardFillRequests,
  paymentCardFillHandoffs,
  type PaymentCardFillHandoffRecord,
  purchaseConfirmationAuthorizations,
  purchaseConfirmationHandoffs,
  privateProfileMemory,
  profileFieldFillRequests,
  profileMemoryRequests,
  encryptedSecretVault,
  accountCreationRequests,
  accountCreationStepRequests,
  challengeEmailResolutions,
  aegisWorkspaces,
  workspaceTasks,
  workspaceArtifacts,
  websiteTrustProfiles,
  agentConnectors,
  credentialStepHandoffs,
  type CredentialStepHandoffRecord,
  MOCK_USER_ID,
  newId,
} from "../store/index.js";
import { requireWorkspaceAccess, checkWorkspacePermission, emitWorkspaceAudit, buildEffectivePermissionsMap, checkTaskEligibility, enrichTaskForManifest, buildWorkQueue, computeTaskReadiness, buildWorkspaceArtifactNames } from "../lib/workspaceDomain.js";
import { challengeCodes, executeChallengeInjectionViaCDP } from "../runtime/challengeInjection.js";
import { resolutionCodes, searchGmailForChallengeCode, isEmailChallengeSupported } from "../runtime/emailChallengeResolver.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";
import { getKmsProvider } from "../lib/kms.js";
import { recordKmsAuditEvent } from "../lib/kmsAudit.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { schedulePersist } from "../store/persistence.js";
import { computeWebsiteAgentSafetyProfile } from "./website-agent-safety.js";
import { getWebsiteAegisPolicyForDomain } from "./website-aegis-policy.js";
import { checkSensitiveGrant } from "../lib/sensitiveGrants.js";
import { runObservationDryRun } from "../runtime/observationDryRun.js";
import { resolveEffectiveCollar } from "../lib/collarPolicy.js";
import { classifyLoginOutcome, storeDiagnostic } from "../lib/loginDiagnostics.js";
import { normalizeAccountDomain, accountCreationNextAction, accountCreationPassIdForAgent } from "./account-creation.js";
import { createAndStoreVaultPass } from "./vault-passes.js";
import { logInjectionLifecycle, logAuthLifecycle } from "../lib/injectionLifecycleLog.js";

const ALLOWED_DOMAINS = new Set(["en.wikipedia.org", "localhost", "test.aegis.local"]);

const VALID_TASK_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "login",
  "credential_fill",
  "purchase",
  "payment",
  "travel_booking",
  "financial_action",
  "identity_disclosure",
  "account_change",
  "destructive_action",
  "message_send",
]);

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: string) {
  return reply.status(status).send({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

// Refusal returned when a generic fill/type tool targets a sensitive field. Payment fields
// route to the protected payment-card fill path (request_payment_card_fill); credential /
// identity / financial fields route to the secret-injection path (request_secret_field_injection).
// The value is never set and never echoed. `sensitivity` comes from value_meta.sensitivity
// (credential | payment | identity | financial) — see antigenSnapshotRuntime classifySensitivity.
function sensitiveFieldRefusal(sensitivity: string | null | undefined): { code: string; message: string } {
  if (sensitivity === "payment") {
    return {
      code: "SENSITIVE_FIELD_REQUIRES_PAYMENT_CARD_FILL",
      message:
        "This is a payment card field. Aegis does not fill it through generic browser tools — use request_payment_card_fill so the saved card is filled through the protected, approval-gated path. Raw card values are never revealed to the agent.",
    };
  }
  return {
    code: "SENSITIVE_FIELD_REQUIRES_INJECTION",
    message:
      "This field is sensitive (credential/identity). Aegis does not fill it through generic browser tools — use request_secret_field_injection / the Aegis injection path instead.",
  };
}

// ─── Navigation Proxy Landing Zones ──────────────────────────────────────────

const NAVIGATION_LANDING_ZONES = [
  { xFracMin: 0.45, xFracMax: 0.55, yMin: 70,  yMax: 110 }, // address/header center
  { xFracMin: 0.20, xFracMax: 0.35, yMin: 120, yMax: 180 }, // upper-left content
  { xFracMin: 0.40, xFracMax: 0.60, yMin: 130, yMax: 220 }, // upper-middle content scan
  { xFracMin: 0.30, xFracMax: 0.45, yMin: 80,  yMax: 135 }, // left-of-center header
];

/** FNV-1a 32-bit hash — deterministic, no external deps. */
export function navHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * Chooses a natural upper-page landing zone for a browser_navigate pointer proxy.
 * Zone and position are seeded from url + sessionId so the result is stable per navigation,
 * but varies across different URLs and sessions.
 */
export function computeNavigationProxyPointerState(params: {
  existingPointerState?: { x: number; y: number; initialized: boolean } | undefined;
  viewportWidth?: number;
  url: string;
  sessionId?: string;
}): { x: number; y: number; pointer_start_source: "session" | "viewport_center" } {
  const vw = params.viewportWidth ?? 1280;
  const seed = `${params.url}:${params.sessionId ?? ""}`;

  const zoneIdx = navHash(seed + ":z") % NAVIGATION_LANDING_ZONES.length;
  const zone = NAVIGATION_LANDING_ZONES[zoneIdx];

  const xRange = Math.max(1, Math.round((zone.xFracMax - zone.xFracMin) * vw));
  const rawX = Math.round(zone.xFracMin * vw + (navHash(seed + ":x") % xRange));
  const yRange = Math.max(1, zone.yMax - zone.yMin);
  const rawY = zone.yMin + (navHash(seed + ":y") % yRange);

  const x = Math.max(80, Math.min(vw - 80, rawX));
  const y = Math.max(70, Math.min(220, rawY));

  const pointer_start_source: "session" | "viewport_center" =
    params.existingPointerState?.initialized === true ? "session" : "viewport_center";

  return { x, y, pointer_start_source };
}

/** Validates Bearer token and returns the matched AgentDelegation, or writes an error and returns null.
 *
 * Auth path: Bearer token is pass.token → find pass by token → find delegation via pass.id.
 * Collar validation is intentionally omitted here — it is handled downstream by resolveEffectiveCollar()
 * or workspace-domain logic, which can return appropriate workspace-specific error codes.
 */
export async function requireAgentToken(req: FastifyRequest, reply: FastifyReply): Promise<AgentDelegation | null> {
  const authHeader = (req.headers["authorization"] as string | undefined) ?? "";
  const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
  const token = bearerMatch?.[1]?.trim();

  if (!token) {
    sendError(reply, 401, "AUTH_REQUIRED", "Authorization: Bearer <token> is required.");
    return null;
  }

  // Step 1: resolve the pass by its raw token value.
  const pass = Array.from(passes.values()).find(
    (p) => p.user_id === MOCK_USER_ID && p.token === token
  );

  if (!pass) {
    sendError(reply, 401, "INVALID_TOKEN", "Token does not match any delegation.");
    return null;
  }

  if (pass.status === "revoked") {
    sendError(reply, 401, "DELEGATION_REVOKED", "This delegation has been revoked.");
    return null;
  }

  if (pass.status === "expired" || new Date(pass.expires_at) < new Date()) {
    sendError(reply, 401, "DELEGATION_EXPIRED", "This delegation has expired. Request a new delegation.");
    return null;
  }

  // Step 2: resolve the delegation via the pass ID.
  const delegation = Array.from(agentDelegations.values()).find(
    (d) => d.user_id === MOCK_USER_ID && d.token_id === pass.id
  );

  if (!delegation) {
    sendError(reply, 401, "INVALID_TOKEN", "Token does not match any delegation.");
    return null;
  }

  if (delegation.status === "revoked") {
    sendError(reply, 401, "DELEGATION_REVOKED", "This delegation has been revoked.");
    return null;
  }

  if (delegation.status === "expired" || (delegation.expires_at && new Date(delegation.expires_at) < new Date())) {
    delegation.status = "expired";
    delegation.updated_at = new Date().toISOString();
    agentDelegations.set(delegation.id, delegation);
    schedulePersist();
    sendError(reply, 401, "DELEGATION_EXPIRED", "This delegation has expired. Request a new delegation.");
    return null;
  }

  // Update last_used_at after both pass and delegation are confirmed valid.
  passes.set(pass.id, { ...pass, last_used_at: new Date().toISOString() });

  return delegation;
}


function filterBySkillAccessPolicy(skillIds: string[], delegation: AgentDelegation): string[] {
  const mode = delegation.skill_access_mode ?? "all";
  const ids = delegation.skill_access_skill_ids ?? [];
  if (mode === "only") return skillIds.filter((id) => ids.includes(id));
  if (mode === "exclude") return skillIds.filter((id) => !ids.includes(id));
  return skillIds;
}

function buildRunSummary(run: RouteRun, receiptIds: string[]): ExternalAgentRunSummary {
  return {
    run_id: run.run_id,
    skill_id: run.skill_id,
    route_id: run.route_id,
    status: run.status,
    approval_required: run.status === "pending_approval" || (run.approval_required_permissions?.length ?? 0) > 0,
    ...(run.approval_required_permissions?.length ? { approval_required_permissions: run.approval_required_permissions } : {}),
    created_at: run.created_at,
    ...(run.completed_at ? { completed_at: run.completed_at } : {}),
    ...(run.error ? { error: run.error } : {}),
    receipt_ids: receiptIds,
  };
}

interface SafeReceiptSummary {
  receipt_id: string;
  run_id: string;
  skill_name: string;
  route_name: string;
  domain: string;
  status: "completed" | "failed";
  execution_surface: AegisExecutionSurface;
  created_at: string;
  completed_at?: string;
  error?: string;
  credential_used?: boolean;
  secret_values_revealed_to_agent: false | undefined;
  authorization_context?: {
    authorization_id: string;
    authorization_hash: string;
  };
  runtime_coverage_summary?: RuntimeCoverageSummary;
  capability_release_summary?: {
    releases_created: number;
    login_credential_releases: number;
    payment_method_releases: number;
    identity_profile_releases: number;
    raw_secret_revealed_to_agent: false;
  };
  observation_mode_summary?: RuntimeObservationModeState;
  jws_present: boolean;
}

function toSafeReceiptSummary(r: RouteRunReceipt): SafeReceiptSummary {
  return {
    receipt_id: r.receipt_id,
    run_id: r.run_id,
    skill_name: r.skill_name,
    route_name: r.route_name,
    domain: r.domain,
    status: r.status,
    execution_surface: r.execution_surface,
    created_at: r.created_at,
    ...(r.completed_at ? { completed_at: r.completed_at } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.credential_used !== undefined ? { credential_used: r.credential_used } : {}),
    secret_values_revealed_to_agent: r.secret_values_revealed_to_agent,
    ...(r.authorization_context
      ? {
          authorization_context: {
            authorization_id: r.authorization_context.authorization_id,
            authorization_hash: r.authorization_context.authorization_hash,
          },
        }
      : {}),
    ...(r.runtime_coverage_summary ? { runtime_coverage_summary: r.runtime_coverage_summary } : {}),
    ...(r.capability_release_summary ? { capability_release_summary: r.capability_release_summary } : {}),
    ...(r.observation_mode_summary ? { observation_mode_summary: r.observation_mode_summary } : {}),
    jws_present: false, // JWS is stored in Supabase row metadata; not available in in-memory path
  };
}

// Terminal runtime statuses: a session in any of these is no longer usable and
// must never be treated as a live target. Used by resolveReadyRuntimeSession to
// decide when to attempt a rebind to the delegation's current ready runtime.
const TERMINAL_RUNTIME_STATUSES = new Set<TaskBrowserSession["status"]>([
  "closed",
  "expired",
  "failed",
]);

/**
 * Discriminated resolution of a caller-supplied browser_runtime_id against the
 * delegation's live runtime state. Centralizes the "stale runtime id" handling
 * shared by the Antigen runtime endpoints (snapshot, click, type, scroll-to-ref).
 *
 *  - `ready`     — the id maps to an owned, ready session; use it directly.
 *  - `rebound`   — the id is stale (terminal) or unknown, but the delegation has a
 *                  current ready runtime. Snapshot may transparently rebind to it
 *                  (it produces a fresh snapshot_id/ref set). Ref-consuming endpoints
 *                  must NOT silently carry stale ag_* refs across the change — they
 *                  surface RUNTIME_SESSION_CHANGED and tell the agent to re-snapshot.
 *  - `starting`  — the session exists but is still launching; a true transient
 *                  not-ready (a rebind would target the wrong session).
 *  - `forbidden` — the id maps to a session owned by a different delegation.
 *  - `none`      — no usable session and no rebind candidate; recoverable via a
 *                  fresh get_runtime_browser_endpoint provision.
 *
 * Never returns cdp_url/paths/PIDs — callers read only session metadata.
 */
type RuntimeSessionResolution =
  | { kind: "ready"; session: TaskBrowserSession }
  | { kind: "rebound"; session: TaskBrowserSession; previous_runtime_id: string }
  | { kind: "starting"; session: TaskBrowserSession }
  | { kind: "forbidden" }
  | { kind: "none" };

function resolveReadyRuntimeSession(
  runtimeId: string,
  delegationId: string,
  userId: string,
): RuntimeSessionResolution {
  const direct = getTaskBrowserSession(runtimeId, userId);
  if (direct) {
    if (direct.delegation_id !== delegationId) return { kind: "forbidden" };
    if (direct.status === "ready") return { kind: "ready", session: direct };
    if (direct.status === "starting") return { kind: "starting", session: direct };
    // Terminal (closed/expired/failed) — fall through to the rebind attempt.
  }
  // Stale or unknown id: bind to the delegation's current ready runtime, if any.
  // findReadySessionByDelegationId is already scoped to delegation + user, so a
  // rebind can never cross delegations.
  const ready = findReadySessionByDelegationId(delegationId, userId);
  if (ready) return { kind: "rebound", session: ready, previous_runtime_id: runtimeId };
  return { kind: "none" };
}

/**
 * Page-level human-verification wall probe runs only when a snapshot returned at
 * most this many candidate elements — the full-page cross-origin-iframe denial
 * wall shape (zero/near-zero candidates). Keeps the extra CDP probe off normal
 * pages (which have many candidates) entirely.
 */
const PAGE_HV_PROBE_MAX_ELEMENTS = 3;

/**
 * Minimum snapshot interactive-ref count for STRONG usable-page evidence. Well above
 * the unusable floor (PAGE_HV_PROBE_MAX_ELEMENTS = 3) and above small cookie/login
 * modals, but far below a normal product grid. Drives the surface-boundary Route 2
 * usable-page veto (a benign hero/widget tripping scrim+centered on a usable page).
 */
const USABLE_PAGE_RICH_INTERACTIVE_MIN = 12;

/**
 * Value-free preflight-ordering trace helper. No-op unless ANTIGEN_BROWSER_TRACE
 * is on. Emits only the enum-gated stage plus two booleans — never refs,
 * selectors, challenge text, iframe details, URLs, or any page content.
 */
function recordActionPreflight(
  session: TaskBrowserSession,
  tool: string,
  stage: ActionPreflightStage,
  extra?: { hv_marker_present?: boolean; hv_detected?: boolean },
): void {
  recordBrowserTraceEvent(session.browser_session_id, {
    event_type: "action_preflight",
    browser_runtime_id: session.browser_session_id,
    tool,
    preflight_stage: stage,
    ...extra,
  });
}

/**
 * Sends the canonical 409 HUMAN_VERIFICATION_REQUIRED response for an active
 * request and records the rejection trace. Shared by the cached-marker guard and
 * the stale-ref live-probe path so both emit an identical, internals-free payload.
 */
function sendHumanVerificationRequired(
  session: TaskBrowserSession,
  reply: any,
  tool: string,
  request: { request_id: string; status: string; challenge_type: string; domain: string },
  visualGestureCapsule?: { available: true; capsule: SafeVisualGestureCapsuleView },
  // Dev-only HV/VGC 409 attribution (ANTIGEN_HV_DEBUG). Booleans / enums / buckets
  // only — never refs, coords, iframe srcs, capsule ids, or page text. Emitted to
  // the [HvDebug] log here (the single 409 chokepoint, so it survives the snapshot
  // early-return) and attached to the response body ONLY when the flag is on. When
  // the flag is off this is a no-op and the payload is byte-identical.
  hvDebug?: Record<string, string | number | boolean>,
): void {
  recordActionPreflight(session, tool, "returned_human_verification_required");
  recordBrowserTraceEvent(session.browser_session_id, {
    event_type: "browser_tool_rejected",
    browser_runtime_id: session.browser_session_id,
    tool,
    error_code: "HUMAN_VERIFICATION_REQUIRED",
  });
  if (hvDebug) logHvActionDebug(hvDebug);
  reply.status(409).send({
    ok: false,
    error: {
      code: "HUMAN_VERIFICATION_REQUIRED",
      message:
        "A human-verification challenge is blocking this page. It requires live user presence via the Aegis UI — do not attempt to click, type, or bypass it.",
      request_id: request.request_id,
      status: request.status,
      challenge_type: request.challenge_type,
      domain: request.domain,
      user_presence_required: true,
      purchase_authorized: false,
      next_action: humanVerificationAgentNextAction(request as any),
      // Safe metadata only — present ONLY for opaque/page-level walls when a
      // Visual Gesture Capsule was minted. Bytes/coords/viewport/cdp/strategy are
      // never included (the safe view carries none of them). Absent otherwise →
      // payload byte-identical to the pre-VGC shape.
      ...(visualGestureCapsule ? { visual_gesture_capsule: visualGestureCapsule } : {}),
      // Dev-only attribution — present ONLY when ANTIGEN_HV_DEBUG is on. Absent
      // otherwise → payload byte-identical to the pre-telemetry shape.
      ...(isHvDebugEnabled() && hvDebug ? { hv_debug: hvDebug } : {}),
    },
  });
}

/**
 * Live page-level human-verification probe. Resolves the session's CDP target the
 * SAME way antigen_snapshot does and runs the SAME page-level wall detector
 * (detectPageHumanVerificationWallViaCDP), so a challenge raised AFTER the last
 * snapshot — the live B&BW "Press & Hold" case, where no prior snapshot armed the
 * marker — is detectable at action time rather than being misreported as stale.
 *
 * Best-effort and fail-safe: a missing target or any transport/parse error yields
 * null, so a probe failure always fails OPEN (the action returns its original
 * result). Returns enum/booleans only — it never reads iframe internals or page
 * content.
 */
async function detectLiveHumanVerificationWall(session: TaskBrowserSession): Promise<{
  wall: PageHumanVerificationWall | null;
  resolvedTarget?: { browserWsUrl: string; pageTarget: { id: string; url: string } };
}> {
  try {
    const resolved = await resolveSnapshotCdpTarget(session.cdp_url);
    const resolvedTarget = resolved
      ? { browserWsUrl: resolved.browserWsUrl, pageTarget: { id: resolved.target.id, url: resolved.target.url } }
      : undefined;
    if (!resolvedTarget) return { wall: null };
    const wall = await detectPageHumanVerificationWallViaCDP({ cdpUrl: session.cdp_url, resolvedTarget });
    return { wall, resolvedTarget };
  } catch {
    return { wall: null };
  }
}

/**
 * Ambiguous visual-obstruction VGC fallback. Shared by the stale-ref action
 * backstop and the snapshot endpoint. When the VGC flag is on and a live CDP
 * session exists, classifies coarse value-free obstruction signals and — only on
 * a concrete static signal — mints a Visual Gesture Capsule (reusing the opaque-HV
 * orchestrator with a broader `ambiguous_visual_obstruction` reason) plus a safe
 * HV request whose user-facing copy notes a redacted view was captured. Returns
 * the HV request + safe capsule view, or undefined when the flag is off, no live
 * session exists, the signals are not a candidate, or anything fails. Never throws
 * — a failure degrades to the caller's existing behavior. When VGC is off the
 * function returns immediately, so behavior is byte-identical.
 */
async function maybeCreateVisualGestureCapsuleForAmbiguousVisualBlock(input: {
  session: TaskBrowserSession;
  delegation: { id: string; agent_name?: string };
  domain: string;
  pageUrl: string;
  signals: AmbiguousVisualObstructionSignals;
}): Promise<
  | { request: HumanVerificationRequest; vgc: { available: true; capsule: SafeVisualGestureCapsuleView } }
  | undefined
> {
  if (!isVisualGestureCapsuleEnabled() || !input.session.cdp_url) return undefined;
  if (!classifyAmbiguousVisualObstruction(input.signals)) return undefined;
  try {
    const request = createOrReuseHumanVerificationRequest({
      user_id: MOCK_USER_ID,
      delegation_id: input.delegation.id,
      agent_name: input.delegation.agent_name,
      browser_session_id: input.session.browser_session_id,
      domain: input.domain,
      page_url: input.pageUrl,
      challenge_type: "unknown_human_verification",
      // Ambiguous-specific copy lives ONLY in safe user-facing request metadata —
      // the shared HUMAN_VERIFICATION_REQUIRED top-level message stays byte-identical.
      surface_title: "User presence may be required. Antigen captured a redacted view for review.",
      page_level: false,
    });
    const created = await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: request.request_id,
      browserSessionId: input.session.browser_session_id,
      domain: input.domain,
      cdpUrl: input.session.cdp_url,
      pageUrl: input.pageUrl,
      delegationId: input.delegation.id,
      userId: MOCK_USER_ID,
      reason: "ambiguous_visual_obstruction",
    });
    if (!created.ok) return undefined;
    return { request, vgc: { available: true, capsule: created.capsule } };
  } catch {
    return undefined;
  }
}

/**
 * Active Visual Gesture Capsule guard. When the VGC flag is on and the session has
 * an active (non-terminal) capsule, fails closed with the canonical
 * HUMAN_VERIFICATION_REQUIRED 409 + safe capsule view BEFORE any generic
 * snapshot/action/navigation-state result. This is the authority that keeps a
 * later zero-element / access-denied / stale-ref / 422 pass from masking a gesture
 * the user still has pending in the Aegis UI. The capsule's lifecycle stays driven
 * by the internal UI gesture/recheck routes + TTL expiry — this guard never mutates
 * it. Returns true when it sent the response. Byte-identical when the flag is off
 * (helper short-circuits). Never leaks bytes/coords/cdp/session ids — the shared
 * sendHumanVerificationRequired + getSafeVisualGestureCapsuleView enforce that.
 */
function rejectIfVisualGestureCapsuleActive(
  session: TaskBrowserSession,
  reply: any,
  tool: string,
): boolean {
  if (!isVisualGestureCapsuleEnabled()) return false;
  const capsule = getActiveVisualGestureCapsuleForBrowserSession(session.browser_session_id);
  if (!capsule) return false;
  const safe = getSafeVisualGestureCapsuleView(capsule);
  // Prefer the linked HV request's live status/type; synthesize a minimal
  // pending_user request when it was GC'd so the stop signal is never lost
  // (humanVerificationAgentNextAction reads only status + request_id).
  const linked = humanVerificationRequests.get(capsule.human_verification_request_id);
  const request = linked
    ? {
        request_id: linked.request_id,
        status: linked.status,
        challenge_type: linked.challenge_type,
        domain: linked.domain,
      }
    : {
        request_id: capsule.human_verification_request_id,
        status: "pending_user",
        challenge_type: "unknown_human_verification",
        domain: capsule.domain,
      };
  sendHumanVerificationRequired(session, reply, tool, request, { available: true, capsule: safe }, {
    scope: "hv_active_guard",
    tool,
    returned_409: true,
    reason: "reused_existing_capsule",
    reused_existing_capsule: true,
    created_capsule: false,
    capsule_status: capsule.status,
  });
  return true;
}

/**
 * Human Presence Relay pre-action guard. Runs in browser-click/type/set-value/
 * scroll IMMEDIATELY after session resolution and BEFORE any ref resolution.
 *
 * This guard is the CHEAP, cached-marker half of the invariant: it consults only
 * the in-memory marker armed by a prior snapshot (or by an earlier stale-ref live
 * probe). It runs NO CDP probe, so it adds no latency to the common path. The
 * complementary live probe runs lazily ONLY on a no-progress action-failure branch
 * (rejectNoProgressActionAsHumanVerification) — together they enforce: a ref-based
 * action may NOT surface a no-progress 422 until human verification is ruled out.
 * browser-snapshot is deliberately NOT guarded: it is the resume path.
 *
 * Returns true when the request was rejected (409 HUMAN_VERIFICATION_REQUIRED
 * already sent). The payload carries metadata + agent guidance only — never
 * selectors, coordinates, or refs.
 */
function rejectIfHumanVerificationActive(
  session: TaskBrowserSession,
  reply: any,
  tool: string,
): boolean {
  // An active Visual Gesture Capsule is authoritative — a gesture is pending in the
  // Aegis UI; fail closed before the cheap HV-marker path and regardless of the HV
  // flag (the VGC flag is independent of ANTIGEN_HUMAN_VERIFICATION).
  if (rejectIfVisualGestureCapsuleActive(session, reply, tool)) return true;
  if (!isHumanVerificationEnabled()) return false;

  recordActionPreflight(session, tool, "action_started");

  const marker = getActiveHumanVerification(session.browser_session_id);
  const request = marker ? humanVerificationRequests.get(marker.request_id) : undefined;
  if (marker && !request) {
    // Marker points at a GC'd request — drop it; the action proceeds and the
    // stale-ref live probe (if reached) is the backstop.
    clearActiveHumanVerification(session.browser_session_id);
  }
  recordActionPreflight(session, tool, "hv_marker_checked", { hv_marker_present: !!request });

  if (!request) {
    // No active cached marker → let the action proceed to ref resolution. A
    // challenge that appeared after the last snapshot is caught lazily on the
    // stale-ref branch, never here, so the happy path pays no probe cost.
    recordActionPreflight(session, tool, "ref_resolution_started");
    return false;
  }

  // A known challenge is up. Terminal requests keep blocking until a fresh
  // snapshot re-evaluates the page — clicking behind it would only loop on stale.
  lazyExpireHumanVerificationRequest(request);
  sendHumanVerificationRequired(session, reply, tool, request);
  return true;
}

/**
 * Ref-based action failure codes that represent a *no-progress* stop: the action
 * did not realize because the page is stale, navigated, scrolled away, or the
 * realistic action simply could not land. These are the failures that may be a
 * visual overlay blocking progress over an otherwise-normal page, so they all run
 * the live HV / ambiguous-obstruction backstop before surfacing their 422.
 *
 * Deliberately EXCLUDES config/field-shape failures that are NOT visual blocks:
 * REALISM_DISABLED (feature off), NOT_FILLABLE / NOT_TYPEABLE (wrong field kind),
 * and VALUE_MISMATCH (the field WAS reachable but rejected/reformatted the value).
 */
const NO_PROGRESS_ACTION_FAIL_CODES = new Set<string>([
  "ANTIGEN_REF_STALE",
  "ANTIGEN_REF_PAGE_CHANGED",
  "ANTIGEN_REF_OUT_OF_VIEWPORT",
  "REALISTIC_CLICK_FAILED",
  "REALISTIC_TYPE_FAILED",
  "SET_VALUE_FAILED",
  "ELEMENT_DETACHED",
]);

/**
 * Dev-only HV action-path telemetry (ANTIGEN_HV_DEBUG). Booleans / enums only —
 * NEVER a capsule id (only the `created_capsule` boolean), cdp_url, target id,
 * coords, raw text, or iframe src. The whole call is a no-op when the flag is off,
 * so behavior is byte-identical. Mirrors the `[Scope] key=value` log style.
 */
function logHvActionDebug(fields: Record<string, string | number | boolean>): void {
  if (!isHvDebugEnabled()) return;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  console.log(`[HvDebug] ${parts.join(" ")}`);
}

/**
 * Coarse element-count bucket for HV 409 attribution. A bucket — never the raw
 * count — so candidate_count is never recorded as (or mistaken for) a health
 * proxy: real walls can preserve a high-element background, so the raw number is
 * not evidence either way. Used only in dev HV telemetry.
 */
function hvElementCountBucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n <= 3) return "1-3";
  if (n <= 20) return "4-20";
  return "21+";
}

/**
 * Dev-only attribution for WHY a screen-level HV wall did NOT mint on a snapshot.
 * Reports the EARLIEST failed gate so a live miss is self-explaining without the
 * classifier loosening. Reads only the already-sanitized, value-free `screenHv`
 * signals (booleans/enum) — no text, coords, or DOM. `"none"` = detected (not a
 * failure). `sanitization_dropped` is folded into `not_plumbed` at this layer
 * (we only ever see the post-sanitize `screenHv`); distinguishing it would need a
 * flag from the bundle extractor — deferred, not required for this diagnosis.
 */
type ScreenHvFailureReason =
  | "disabled"
  | "no_scrim"
  | "no_hv_phrase"
  | "no_foreground_container"
  | "no_press_hold_affordance"
  | "sanitization_dropped"
  | "not_plumbed"
  | "unknown"
  | "none";

function deriveScreenHvFailureReason(
  s: ScreenHvWallSignals | undefined,
): ScreenHvFailureReason {
  if (!isHumanVerificationEnabled()) return "disabled";
  if (s === undefined) return "not_plumbed"; // eval threw/timed out or sanitize rejected
  if (s.wall) return "none"; // detected — not a failure
  if (!s.viewport_scrim_seen) return "no_scrim"; // step-1 blocker (fixedCoverage>=0.5) failed
  if (!s.centered_modal_seen) return "no_foreground_container";
  if (!s.hv_phrase_seen && !s.press_hold_affordance_seen) return "no_hv_phrase";
  if (s.hv_phrase_seen && !s.press_hold_affordance_seen) return "no_press_hold_affordance";
  return "unknown"; // scrim + phrase present, but hvTypeFromScan still returned null
}

/**
 * No-progress live HV backstop. Called when a ref-based action is about to return
 * a NO_PROGRESS_ACTION_FAIL_CODES 422 (stale / page-changed / out-of-viewport /
 * realization failure). Runs the live page-level wall probe; if a structural wall
 * is present it creates/reuses the HV request (which arms the marker so the NEXT
 * action short-circuits in the cheap guard) and sends 409 HUMAN_VERIFICATION_-
 * REQUIRED. If no structural wall is found, it tries the conservative ambiguous
 * visual-obstruction fallback (a static signal — denial text or an inaccessible
 * visible iframe — is required; `repeated_stale` is corroborating-only and never
 * fires alone). Returns true when it sent a 409 (caller must return immediately);
 * false when no HV/ambiguous block was detected OR a probe failed open — in which
 * case the caller proceeds with the original 422 response.
 *
 * This placement preserves the invariant (HV is ruled out before any no-progress
 * stop is surfaced) while keeping the live CDP probe OFF the successful path.
 */
async function rejectNoProgressActionAsHumanVerification(
  session: TaskBrowserSession,
  reply: any,
  tool: string,
  delegation: { id: string; agent_name?: string },
): Promise<boolean> {
  if (!isHumanVerificationEnabled()) return false;

  // ANTIGEN_VISION_CAPTURE_AND_SKIP exploration/dataset mode: never mint a VGC or HV
  // request from an action no-progress failure — a durable capsule/marker would poison
  // every later site in the run. Return false so the original no-progress action failure
  // surfaces; the agent's next antigen_snapshot runs the existing visual classifier /
  // dataset capture path and returns the 422 ANTIGEN_VISUAL_BLOCKER_CAPTURED skip
  // directive. Guarded so normal mode is byte-identical.
  if (isVisionCaptureAndSkipEnabled()) {
    logHvActionDebug({
      scope: "no_progress_backstop",
      tool,
      capture_and_skip_suppressed_vgc: true,
      created_capsule: false,
    });
    return false;
  }

  const { wall, resolvedTarget } = await detectLiveHumanVerificationWall(session);
  recordActionPreflight(session, tool, "hv_probe_checked", { hv_detected: !!wall });
  if (!wall) {
    // No structural HV wall. Before surfacing ANTIGEN_REF_STALE, try the ambiguous
    // visual-obstruction fallback: a live page may be visually blocked by an opaque
    // overlay/denial wall the DOM/ref pipeline can't expose. Flag-off / no live
    // session / no concrete signal ⇒ undefined ⇒ unchanged stale behavior.
    // Wrapped: the probe is fail-safe (returns null on error), but any unexpected
    // throw must degrade to the original stale response — never 500 the action.
    if (isVisualGestureCapsuleEnabled() && session.cdp_url) {
      try {
        const probe = await detectAmbiguousVisualObstructionViaCDP({
          cdpUrl: session.cdp_url,
          resolvedTarget,
        });
        if (probe) {
          let ambiguousDomain = "unknown";
          try {
            if (session.current_url) ambiguousDomain = new URL(session.current_url).hostname;
          } catch {
            /* keep "unknown" */
          }
          // repeated_stale is corroborating-only in the classifier (never fires
          // alone) — safe to set on this action-failure branch. A concrete STATIC
          // signal (denial text or an inaccessible visible iframe) is still required.
          const fallback = await maybeCreateVisualGestureCapsuleForAmbiguousVisualBlock({
            session,
            delegation,
            domain: ambiguousDomain,
            pageUrl: session.current_url ?? "",
            signals: { ...probe, repeated_stale: true },
          });
          // Surface-Boundary Router SHADOW decision — computed ONLY when HV debug is
          // on (otherwise byte-identical, no overhead). This path is the repeated-
          // stale / no-progress backstop, so the trigger basis marks fallback origin.
          const sb = isHvDebugEnabled()
            ? classifySurfaceBoundary(probe, { fromNoProgressFallback: true })
            : null;
          logHvActionDebug({
            scope: "no_progress_backstop",
            tool,
            structural_wall_seen: false,
            ambiguous_considered: true,
            denial_text_seen: probe.denial_text_seen,
            near_zero_interactive: probe.near_zero_interactive,
            visible_inaccessible_iframe_seen: probe.visible_inaccessible_iframe_seen,
            large_centered_overlay_seen: probe.large_centered_overlay_seen,
            viewport_scrim_seen: probe.viewport_scrim_seen,
            pointer_interceptor_seen: probe.pointer_interceptor_seen,
            top_layer_dialog_seen: probe.top_layer_dialog_seen,
            repeated_stale: true,
            created_capsule: !!fallback,
            ...(sb
              ? {
                  surface_boundary_route_decided: sb.route_decided,
                  surface_boundary_trigger_basis: sb.trigger_basis,
                  surface_inspectability_class: sb.inspectability_class,
                  surface_visual_classifier_candidate_reason: sb.visual_classifier_candidate_reason,
                  surface_opaque_iframe_seen: probe.opaque_iframe_seen === true,
                  surface_off_path_iframe_seen: probe.off_path_iframe_seen === true,
                  surface_visual_dom_contradiction_seen:
                    probe.visual_dom_contradiction_seen === true,
                }
              : {}),
          });
          if (fallback) {
            sendHumanVerificationRequired(session, reply, tool, fallback.request, fallback.vgc);
            return true;
          }
        } else {
          logHvActionDebug({
            scope: "no_progress_backstop",
            tool,
            structural_wall_seen: false,
            ambiguous_considered: true,
            probe_returned_null: true,
            created_capsule: false,
          });
        }
      } catch {
        /* fall through to the original 422 response */
      }
    } else {
      logHvActionDebug({
        scope: "no_progress_backstop",
        tool,
        structural_wall_seen: false,
        ambiguous_considered: false,
        skip_reason: !isVisualGestureCapsuleEnabled() ? "vgc_flag_off" : "no_live_session_or_cdp",
        created_capsule: false,
      });
    }
    return false; // no HV, no ambiguous candidate, or probe failed open → original 422
  }

  logHvActionDebug({
    scope: "no_progress_backstop",
    tool,
    structural_wall_seen: true,
    ambiguous_considered: false,
    created_capsule: false,
  });

  let hvDomain = "unknown";
  try {
    if (session.current_url) hvDomain = new URL(session.current_url).hostname;
  } catch {
    /* keep "unknown" */
  }
  // Create/reuse the request — this also arms the session marker, so the NEXT
  // action short-circuits in rejectIfHumanVerificationActive without re-probing.
  const request = createOrReuseHumanVerificationRequest({
    user_id: MOCK_USER_ID,
    delegation_id: delegation.id,
    agent_name: delegation.agent_name,
    browser_session_id: session.browser_session_id,
    domain: hvDomain,
    page_url: session.current_url ?? "",
    challenge_type: wall.hv_challenge_type,
    surface_title: "Access challenge",
    page_level: wall.page_level === true,
  });

  // Opaque/page-level wall ONLY: the control lives in an inaccessible cross-origin
  // iframe, so the DOM Human Presence Relay has no `control_box` to target. When
  // the VGC flag is on, mint a Visual Gesture Capsule + first redacted frame so the
  // internal UI can drive a screenshot-point relay. Fail-safe: the orchestrator
  // never throws, and a failed create/capture leaves `vgc` undefined → the
  // response shape is unchanged from the pre-VGC behavior.
  let vgc: { available: true; capsule: SafeVisualGestureCapsuleView } | undefined;
  if (wall.page_level === true && isVisualGestureCapsuleEnabled()) {
    const created = await createVisualGestureCapsuleForOpaqueHv({
      humanVerificationRequestId: request.request_id,
      browserSessionId: session.browser_session_id,
      domain: hvDomain,
      cdpUrl: session.cdp_url,
      pageUrl: session.current_url ?? "",
      delegationId: delegation.id,
      userId: MOCK_USER_ID,
      reason: "opaque_hv_no_control_box",
    });
    if (created.ok) vgc = { available: true, capsule: created.capsule };
  }

  sendHumanVerificationRequired(session, reply, tool, request, vgc);
  return true;
}

export async function agentApiRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/agent/v1/me
   * Returns the token-scoped identity of the calling agent.
   */
  server.get("/api/agent/v1/me", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const mode = delegation.skill_access_mode ?? "all";
    const ids = delegation.skill_access_skill_ids ?? [];

    const collarResult = resolveEffectiveCollar(delegation, collars);
    const collar_active = collarResult.ok && collarResult.policy_mode === "collar";
    const execution_blocked = !collarResult.ok;
    const baseline_policy_active = collarResult.ok && collarResult.policy_mode === "baseline";

    const identity: ExternalAgentIdentity = {
      agent_id: delegation.agent_name,
      agent_name: delegation.agent_name,
      ...(delegation.agent_platform ? { agent_platform: delegation.agent_platform } : {}),
      delegation_id: delegation.id,
      user_aegis_id: delegation.user_aegis_id,
      ...(delegation.default_collar_id ? { default_collar_id: delegation.default_collar_id } : {}),
      delegation_status: delegation.status,
      ...(delegation.expires_at ? { expires_at: delegation.expires_at } : {}),
      collar_active,
      execution_blocked,
      ...(baseline_policy_active ? { baseline_policy_active: true } : {}),
      ...(collarResult.ok ? { policy_mode: collarResult.policy_mode } : {}),
      ...(collar_active && collarResult.ok ? {
        collar_spending_limits: {
          max_without_approval: collarResult.collar.spending_limits.max_without_approval,
          max_with_approval: collarResult.collar.spending_limits.max_with_approval,
        },
      } : {}),
      token_scope: {
        skill_access_mode: mode,
        ...(mode === "only" ? { allowed_skill_ids: ids } : {}),
        ...(mode === "exclude" ? { excluded_skill_ids: ids } : {}),
      },
    };

    // Update connector status when agent successfully calls /me
    const connector = Array.from(agentConnectors.values()).find(
      (c) => c.delegation_id === delegation.id
    );
    if (connector && connector.status !== "revoked") {
      const now = new Date().toISOString();
      agentConnectors.set(connector.connector_id, {
        ...connector,
        status: "connected",
        last_seen_at: now,
        updated_at: now,
      });
      schedulePersist();
    }

    return reply.send({ ok: true, data: identity });
  });

  /**
   * GET /api/agent/v1/skills
   * Lists installed skills visible to this delegation's skill access policy.
   * Optional ?domain= filter by exact domain match.
   */
  server.get<{ Querystring: { domain?: string } }>("/api/agent/v1/skills", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const { domain } = req.query;

    const collarResult = resolveEffectiveCollar(delegation, collars);

    const userInstalled = Array.from(installedSkills.values()).filter(
      (i) => i.user_id === MOCK_USER_ID && i.enabled
    );

    const visibleSkillIds = filterBySkillAccessPolicy(
      userInstalled.map((i) => i.skill_id),
      delegation
    );

    const installedResult: ExternalAgentSkillSummary[] = visibleSkillIds
      .map((skillId) => skills.get(skillId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .filter((s) => !domain || s.domain === domain)
      .map((s) => {
        const execution_available = collarResult.ok
          ? s.required_permissions.every(
              (perm) =>
                !collarResult.collar.blocked_actions.includes(perm as any) &&
                (collarResult.collar.allowed_actions.includes(perm as any) ||
                  collarResult.collar.approval_required_actions.includes(perm as any))
            )
          : false;
        return {
          skill_id: s.skill_id,
          route_id: s.route_id,
          source: "installed_skill" as const,
          installed: true,
          name: s.name,
          summary: s.summary,
          domain: s.domain,
          required_permissions: s.required_permissions,
          ...(s.risk_level ? { risk_level: s.risk_level } : {}),
          ...(s.trust_tier ? { trust_tier: s.trust_tier } : {}),
          ...(s.execution_mode ? { execution_mode: s.execution_mode } : {}),
          ...(s.sensitivity_level ? { sensitivity_level: s.sensitivity_level } : {}),
          execution_available,
        };
      });

    // Collect private verified routes owned by this user's delegation.
    // A route qualifies if: owned by this user, verified (trust_tier !== unverified_draft),
    // and not already covered by an installed skill (deduplicate by route_id).
    const installedRouteIds = new Set(
      visibleSkillIds
        .map((id) => skills.get(id)?.route_id)
        .filter((id): id is string => id !== undefined)
    );
    const userAegisId = `aid_${delegation.user_id}`;
    const privateRoutes: ExternalAgentSkillSummary[] = [];

    for (const route of routes.values()) {
      if (route.creator_aegis_id !== userAegisId) continue;
      if (route.trust_tier === "unverified_draft") continue;
      if (installedRouteIds.has(route.route_id)) continue;
      if (domain && route.domain !== domain) continue;

      const requiredPerms = route.required_permissions ?? [];
      const execution_available = collarResult.ok
        ? requiredPerms.every(
            (p) =>
              !collarResult.collar.blocked_actions.includes(p as any) &&
              (collarResult.collar.allowed_actions.includes(p as any) ||
                collarResult.collar.approval_required_actions.includes(p as any))
          )
        : false;

      privateRoutes.push({
        skill_id: `private_route:${route.route_id}`,
        route_id: route.route_id,
        source: "private_route",
        private_use_ready: true,
        installed: false,
        name: route.workflow_name,
        summary: route.workflow_description,
        domain: route.domain,
        required_permissions: requiredPerms,
        ...(route.risk_level ? { risk_level: route.risk_level } : {}),
        ...(route.trust_tier ? { trust_tier: route.trust_tier } : {}),
        ...(route.execution_mode ? { execution_mode: route.execution_mode } : {}),
        ...(route.sensitivity_level ? { sensitivity_level: route.sensitivity_level } : {}),
        execution_available,
      });
    }

    return reply.send({ ok: true, data: [...installedResult, ...privateRoutes] });
  });

  /**
   * POST /api/agent/v1/runs
   * Requests execution of an installed skill under this delegation.
   */
  server.post<{ Body: { skill_id?: string; variables?: Record<string, string> } }>(
    "/api/agent/v1/runs",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { skill_id: skillId, variables } = req.body ?? {};

      if (!skillId) {
        return sendError(reply, 400, "MISSING_SKILL_ID", "skill_id is required.");
      }

      const skill = skills.get(skillId);
      if (!skill) return sendError(reply, 404, "SKILL_NOT_FOUND", "Skill not found.");

      const installedSkill = Array.from(installedSkills.values()).find(
        (i) => i.skill_id === skillId && i.user_id === MOCK_USER_ID && i.enabled
      );
      if (!installedSkill) {
        return sendError(reply, 403, "SKILL_NOT_INSTALLED", "Skill is not installed or is disabled for this user.");
      }

      // Apply skill access policy
      const mode = delegation.skill_access_mode ?? "all";
      const ids = delegation.skill_access_skill_ids ?? [];
      if (mode === "exclude" && ids.includes(skillId)) {
        return sendError(reply, 403, "SKILL_ACCESS_DENIED", "This delegation does not allow this skill.");
      }
      if (mode === "only" && !ids.includes(skillId)) {
        return sendError(reply, 403, "SKILL_ACCESS_DENIED", "This delegation does not allow this skill.");
      }

      const route = routes.get(skill.route_id);
      if (!route) {
        return sendError(reply, 500, "ROUTE_NOT_FOUND", "Underlying route not found for this skill.");
      }

      if (!ALLOWED_DOMAINS.has(skill.domain)) {
        return sendError(
          reply,
          400,
          "DOMAIN_NOT_SUPPORTED",
          `Runs are not supported for domain "${skill.domain}".`
        );
      }

      // Check required variables
      if (route.variables && route.variables.length > 0) {
        const internalValuePolicyTypes = new Set(["pass_field", "secret_ref", "safe_literal"]);
        const missingRequired: string[] = [];
        for (const v of route.variables) {
          const hasDefault = v.default_value !== undefined && v.default_value !== "";
          const supplied = variables && v.name in variables;
          const boundStep = route.steps.find((s) => s.step_id === v.step_id);
          const isInternallyResolved =
            boundStep?.value_policy && internalValuePolicyTypes.has(boundStep.value_policy.type);
          if (!hasDefault && !supplied && !isInternallyResolved) {
            missingRequired.push(v.name);
          }
        }
        if (missingRequired.length > 0) {
          return sendError(reply, 400, "MISSING_VARIABLES", `Required variables not supplied: ${missingRequired.join(", ")}.`);
        }
      }

      const agent_id = delegation.agent_name;
      const delegation_id = delegation.id;

      const collarResult = resolveEffectiveCollar(delegation, collars);
      if (!collarResult.ok) {
        return sendError(reply, collarResult.status, collarResult.code, collarResult.message);
      }
      const { collar, policy_mode } = collarResult;
      const effectiveCollarId = policy_mode === "collar" ? collar.id : undefined;

      // Permission enforcement — works identically for real collar and baseline policy.
      const needsApproval: string[] = [];
      const hardBlocked: string[] = [];

      for (const perm of route.required_permissions) {
        if (collar.blocked_actions.includes(perm as any)) {
          hardBlocked.push(perm);
        } else if (
          !collar.allowed_actions.includes(perm as any) &&
          !collar.approval_required_actions.includes(perm as any)
        ) {
          hardBlocked.push(perm);
        } else if (collar.approval_required_actions.includes(perm as any)) {
          needsApproval.push(perm);
        }
      }

      if (hardBlocked.length > 0) {
        return sendError(
          reply,
          403,
          "COLLAR_BLOCKED",
          "This delegation's collar does not allow this route.",
          `Blocked permission(s): ${hardBlocked.join(", ")}.`
        );
      }

      if (needsApproval.length > 0) {
        const run: RouteRun = {
          run_id: newId("run"),
          skill_id: skill.skill_id,
          route_id: route.route_id,
          installed_skill_id: installedSkill.installed_skill_id,
          user_id: MOCK_USER_ID,
          domain: skill.domain,
          status: "pending_approval",
          approval_required_permissions: needsApproval,
          created_at: new Date().toISOString(),
          ...(agent_id ? { agent_id } : {}),
          ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
          ...(delegation_id ? { delegation_id } : {}),
          ...(effectiveCollarId ? { collar_id: effectiveCollarId } : {}),
        };
        routeRuns.set(run.run_id, run);
        schedulePersist();
        return reply.send({
          ok: true,
          data: {
            run: buildRunSummary(run, []),
            approval_required: true,
            next_action: "wait_for_user_approval",
            message: `Approval required for: ${needsApproval.join(", ")}. Approve at /route-run-approvals in the Antigen UI.`,
          },
        });
      }

      const run: RouteRun = {
        run_id: newId("run"),
        skill_id: skill.skill_id,
        route_id: route.route_id,
        installed_skill_id: installedSkill.installed_skill_id,
        user_id: MOCK_USER_ID,
        domain: skill.domain,
        status: "pending",
        created_at: new Date().toISOString(),
        ...(agent_id ? { agent_id } : {}),
        ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
        ...(delegation_id ? { delegation_id } : {}),
        ...(effectiveCollarId ? { collar_id: effectiveCollarId } : {}),
      };

      routeRuns.set(run.run_id, run);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          run: buildRunSummary(run, []),
          approval_required: false,
          next_action: "poll_run_status",
        },
      });
    }
  );

  /**
   * GET /api/agent/v1/runs/:runId
   * Returns a safe status summary for a run owned by this delegation.
   */
  server.get<{ Params: { runId: string } }>(
    "/api/agent/v1/runs/:runId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { runId } = req.params;
      const run = routeRuns.get(runId);
      if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.");

      if (run.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This run does not belong to your delegation.");
      }

      const receipts = Array.from(
        (await getReceiptRepository().listReceipts(MOCK_USER_ID))
      ).filter((r) => r.run_id === runId);

      return reply.send({
        ok: true,
        data: buildRunSummary(run, receipts.map((r) => r.receipt_id)),
      });
    }
  );

  /**
   * GET /api/agent/v1/runs/:runId/receipts
   * Returns safe receipt summaries for a run owned by this delegation.
   * Does not expose: pass_ids_used, runtime_capability_releases, variables, or internal IDs.
   */
  server.get<{ Params: { runId: string } }>(
    "/api/agent/v1/runs/:runId/receipts",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { runId } = req.params;
      const run = routeRuns.get(runId);
      if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.");

      if (run.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This run does not belong to your delegation.");
      }

      const receipts = (await getReceiptRepository().listReceipts(MOCK_USER_ID)).filter(
        (r) => r.run_id === runId
      );

      return reply.send({
        ok: true,
        data: receipts.map(toSafeReceiptSummary),
      });
    }
  );

  /**
   * GET /api/agent/v1/websites/:domain/safety-profile
   * Returns a compact domain safety profile for the given task category.
   * Query param: ?task_category= (required)
   */
  server.get<{ Params: { domain: string }; Querystring: { task_category?: string } }>(
    "/api/agent/v1/websites/:domain/safety-profile",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { domain } = req.params;
      const { task_category } = req.query;

      if (!task_category) {
        return sendError(reply, 400, "MISSING_TASK_CATEGORY", "task_category query parameter is required.");
      }
      if (!VALID_TASK_CATEGORIES.has(task_category as DelegationTrustTaskCategory)) {
        return sendError(reply, 400, "INVALID_TASK_CATEGORY", `Unknown task_category: "${task_category}".`);
      }

      const profile = await computeWebsiteAgentSafetyProfile(
        domain,
        task_category as DelegationTrustTaskCategory
      );

      return reply.send({ ok: true, data: profile });
    }
  );

  /**
   * GET /api/agent/v1/websites/:domain/policy
   * Returns the well-known Antigen policy for the domain (localhost-only in v1).
   */
  server.get<{ Params: { domain: string } }>(
    "/api/agent/v1/websites/:domain/policy",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { domain } = req.params;
      const result = await getWebsiteAegisPolicyForDomain(domain);
      const available = result.policy !== undefined || result.validation !== undefined;

      return reply.send({
        ok: true,
        data: {
          available,
          ...(result.policy ? { policy: result.policy } : {}),
          ...(result.validation
            ? { validation: { valid: result.validation.valid, errors: result.validation.errors, warnings: result.validation.warnings } }
            : {}),
        },
      });
    }
  );

  /**
   * GET /api/agent/v1/website-trust/:domain
   * Agent-safe lookup of the registered WebsiteTrustProfile for a domain.
   * Returns an agent-safe subset: policy, committed safety promises, profile_hash, verification status.
   * Excludes: profile_jws, accountability_contact, suspension_reason, internal notes.
   */
  server.get<{ Params: { domain: string } }>(
    "/api/agent/v1/website-trust/:domain",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const domain = req.params.domain.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0].toLowerCase().trim();

      const profile = Array.from(websiteTrustProfiles.values()).find(
        (p) => p.domain === domain && p.status === "active"
      );

      if (!profile) {
        return reply.send({
          ok: true,
          data: {
            domain,
            profile_found: false,
            warning: `No active WebsiteTrustProfile registered with Antigen for domain '${domain}'. This domain has not declared its agent commitments. Require user approval for any sensitive actions.`,
          },
        });
      }

      const warnings: string[] = [];
      if (profile.verification_status !== "verified") {
        warnings.push(
          `Trust profile is '${profile.verification_status}' — declarations have not been verified by Antigen.`
        );
      }
      if (profile.status !== "active") {
        warnings.push(`Trust profile status is '${profile.status}'.`);
      }

      return reply.send({
        ok: true,
        data: {
          profile_found: true,
          profile_id: profile.profile_id,
          domain: profile.domain,
          company_name: profile.company_name,
          verification_status: profile.verification_status,
          status: profile.status,
          profile_version: profile.profile_version,
          agent_policy: profile.agent_policy,
          // Only committed promises are returned — uncommitted promises are not actionable for agents.
          safety_promises: profile.safety_promises.filter((p) => p.committed),
          profile_hash: profile.profile_hash,
          jws_present: profile.jws_present,
          violation_count: profile.violation_count,
          warning: warnings.length > 0 ? warnings.join(" ") : null,
        },
      });
    }
  );

  /**
   * POST /api/agent/v1/observation-dry-runs
   * Navigate to a URL in an isolated headless browser, inspect DOM for sensitive signals,
   * and return a structured observation report. Observe-only — no clicks, no typing,
   * no form submit, no credential fill, no capability release, no KMS, no route execution.
   */
  server.post(
    "/api/agent/v1/observation-dry-runs",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = req.body as { url?: unknown; task_category?: unknown };

      if (!body.url || typeof body.url !== "string") {
        return sendError(reply, 400, "INVALID_URL", "url is required and must be a string.");
      }
      if (
        body.task_category !== undefined &&
        !VALID_TASK_CATEGORIES.has(body.task_category as DelegationTrustTaskCategory)
      ) {
        return sendError(reply, 400, "INVALID_TASK_CATEGORY", `Unknown task_category: "${body.task_category}".`);
      }

      try {
        const result = await runObservationDryRun({
          requested_url: body.url,
          task_category: body.task_category as DelegationTrustTaskCategory | undefined,
          user_id: MOCK_USER_ID,
        });
        return reply.send({ ok: true, data: result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unexpected error during observation dry run.";
        return sendError(reply, 500, "OBSERVATION_DRY_RUN_FAILED", msg);
      }
    }
  );

  // ─── Authenticated Session Boundary v1 ─────────────────────────────────────

  // Request Antigen to perform a login on the agent's behalf.
  // Agent never receives cookies, storage, password, or session secrets.
  // Returns a session handle with status pending_approval.
  // Login runs after user approval; stops on 2FA/CAPTCHA/passkey/security challenge.
  server.post(
    "/api/agent/v1/authenticated-sessions/login-request",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = (req.body ?? {}) as {
        domain?: unknown;
        login_url?: unknown;
        task_summary?: unknown;
        pass_id?: unknown;
        browser_session_id?: unknown;
      };

      if (!body.domain || typeof body.domain !== "string" || !body.domain.trim()) {
        return sendError(reply, 400, "MISSING_DOMAIN", "domain is required and must be a non-empty string.");
      }
      if (!body.login_url || typeof body.login_url !== "string") {
        return sendError(reply, 400, "MISSING_LOGIN_URL", "login_url is required.");
      }
      if (!/^https?:\/\//i.test(body.login_url)) {
        return sendError(reply, 400, "INVALID_LOGIN_URL", "login_url must start with http:// or https://.");
      }
      if (!body.task_summary || typeof body.task_summary !== "string" || !body.task_summary.trim()) {
        return sendError(reply, 400, "MISSING_TASK_SUMMARY", "task_summary is required and must be a non-empty string.");
      }
      if (body.browser_session_id !== undefined && typeof body.browser_session_id !== "string") {
        return sendError(reply, 400, "INVALID_BROWSER_SESSION_ID", "browser_session_id must be a string if provided.");
      }

      let resolvedBrowserSessionId: string | undefined;
      if (typeof body.browser_session_id === "string" && body.browser_session_id.trim()) {
        const reuse = getTaskBrowserSessionForReuse(body.browser_session_id.trim(), delegation.user_id);
        if (!reuse) {
          return sendError(
            reply, 400, "TASK_BROWSER_SESSION_NOT_AVAILABLE",
            "The referenced task browser session is not available, not in 'ready' status, or does not belong to this delegation.",
          );
        }
        resolvedBrowserSessionId = reuse.browser_session_id;
      }

      const loginReq: AuthenticatedSessionLoginRequest = {
        domain: (body.domain as string).trim(),
        login_url: body.login_url as string,
        task_summary: (body.task_summary as string).trim(),
        pass_id: typeof body.pass_id === "string" ? body.pass_id : undefined,
        browser_session_id: resolvedBrowserSessionId,
      };

      const handle = createAuthenticatedSession(loginReq, delegation);
      return reply.send({ ok: true, data: handle });
    },
  );

  // Get the current handle for an authenticated session.
  server.get<{ Params: { sessionId: string } }>(
    "/api/agent/v1/authenticated-sessions/:sessionId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const handle = getAuthenticatedSessionHandle(req.params.sessionId, delegation.user_id);
      if (!handle) return sendError(reply, 404, "SESSION_NOT_FOUND", "Authenticated session not found.");
      return reply.send({ ok: true, data: handle });
    },
  );

  // Observe the current state of an authenticated session.
  // Returns safe observation only — never cookies, storage, or credentials.
  server.get<{ Params: { sessionId: string } }>(
    "/api/agent/v1/authenticated-sessions/:sessionId/observe",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const handle = getAuthenticatedSessionHandle(req.params.sessionId, delegation.user_id);
      if (!handle) return sendError(reply, 404, "SESSION_NOT_FOUND", "Authenticated session not found.");
      // Allow observation for authenticated and manual_step_required — browser is kept open in both states.
      // For other statuses (pending_approval, login_in_progress, failed, expired) return handle only.
      const canObserve = handle.status === "authenticated" || handle.status === "manual_step_required";
      if (!canObserve) {
        return reply.send({ ok: true, data: { session_id: handle.session_id, status: handle.status, handle } });
      }
      try {
        const result = await observeAuthenticatedSession(req.params.sessionId, delegation.user_id);
        return reply.send({ ok: true, data: result });
      } catch (err: unknown) {
        const e = err as { code?: string; status?: number; message?: string };
        return sendError(reply, e.status ?? 500, e.code ?? "OBSERVE_FAILED", e.message ?? "Observation failed.");
      }
    },
  );

  // Navigate to a same-domain URL within an authenticated session, then return safe observation.
  // No form submission, POST, credential fill, or arbitrary clicking allowed.
  server.post<{ Params: { sessionId: string }; Body: { url?: unknown } }>(
    "/api/agent/v1/authenticated-sessions/:sessionId/navigate",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const handle = getAuthenticatedSessionHandle(req.params.sessionId, delegation.user_id);
      if (!handle) return sendError(reply, 404, "SESSION_NOT_FOUND", "Authenticated session not found.");
      if (handle.status !== "authenticated") {
        return sendError(
          reply, 400, "SESSION_NOT_AUTHENTICATED",
          `Session status is '${handle.status}'; must be 'authenticated' to navigate.`,
        );
      }
      if (!handle.capabilities.includes("safe_navigation")) {
        return sendError(reply, 403, "CAPABILITY_NOT_GRANTED", "safe_navigation capability is not available.");
      }
      const url = req.body?.url;
      if (!url || typeof url !== "string") {
        return sendError(reply, 400, "INVALID_URL", "url is required and must be a string.");
      }
      try {
        const result = await navigateAuthenticatedSession(req.params.sessionId, delegation.user_id, url);
        return reply.send({ ok: true, data: result });
      } catch (err: unknown) {
        const e = err as { code?: string; status?: number; message?: string };
        return sendError(reply, e.status ?? 500, e.code ?? "NAVIGATE_FAILED", e.message ?? "Navigation failed.");
      }
    },
  );

  // ─── Controlled Browser Bridge v1 ──────────────────────────────────────────
  // Compatibility mode for agents that do not bring their own browser runtime.
  // Navigate, observe, and click inside an Aegis-owned task browser session.
  // If the agent already has @playwright/mcp or another browser tool, it should
  // use External Browser Handoff instead: navigate with its own tools, then call
  // request_secret_field_injection with external_cdp_url for credential fields.

  function validateTaskBrowserSession(
    id: string,
    delegation: AgentDelegation,
    reply: FastifyReply,
  ): TaskBrowserSession | null {
    const session = getTaskBrowserSession(id, MOCK_USER_ID);
    if (!session) {
      sendError(reply, 404, "SESSION_NOT_FOUND", "Task browser session not found.");
      return null;
    }
    if (session.delegation_id !== delegation.id) {
      sendError(reply, 403, "FORBIDDEN", "This task browser session does not belong to your delegation.");
      return null;
    }
    if (session.status !== "ready") {
      sendError(reply, 400, "SESSION_NOT_READY", `Session status is '${session.status}'; must be 'ready'.`);
      return null;
    }
    return session;
  }

  server.post<{ Params: { id: string } }>(
    "/api/agent/v1/task-browser-sessions/:id/navigate",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const session = validateTaskBrowserSession(req.params.id, delegation, reply);
      if (!session) return;

      const body = req.body as { url?: unknown };
      if (!body.url || typeof body.url !== "string") {
        return sendError(reply, 400, "MISSING_URL", "url is required and must be a string.");
      }
      let parsed: URL;
      try {
        parsed = new URL(body.url);
      } catch {
        return sendError(reply, 400, "INVALID_URL", "url is not a valid URL.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return sendError(reply, 400, "INVALID_PROTOCOL", "Only http:// and https:// URLs are allowed.");
      }

      try {
        const pointerState = getTaskBrowserSessionPointerState(session.browser_session_id, session.user_id);
        const result = await connectAndNavigateWithPointer(session.cdp_url, body.url, {
          pointer_state: pointerState,
          browser_session_id: session.browser_session_id,
          debug_overlay: process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true",
        });
        // Store the navigated URL so CDP injection can resolve the active page target.
        setTaskBrowserSessionCurrentUrl(session.browser_session_id, result.current_url);
        if (result.final_pointer) {
          setTaskBrowserSessionPointerState(session.browser_session_id, session.user_id, {
            x: result.final_pointer.x,
            y: result.final_pointer.y,
            initialized: true,
            updated_at: new Date().toISOString(),
          });
          if (process.env.ANTIGEN_CDP_DIAGNOSTICS === "true" || process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true") {
            console.log("[PointerState] saved", {
              browser_session_id: session.browser_session_id,
              x: Math.round(result.final_pointer.x),
              y: Math.round(result.final_pointer.y),
              surface: "navigation",
            });
          }
        }
        return reply.send({
          ok: true,
          data: {
            agent_browser_mode: "controlled_browser_bridge",
            browser_session_id: session.browser_session_id,
            current_url: result.current_url,
            snapshot: result.snapshot,
            raw_cookies_revealed_to_agent: false,
            raw_storage_revealed_to_agent: false,
          },
        });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e.code === "CDP_CONNECT_FAILED") return sendError(reply, 503, "CDP_CONNECT_FAILED", e.message ?? "Failed to connect to browser.");
        if (e.code === "NAVIGATION_FAILED") return sendError(reply, 502, "NAVIGATION_FAILED", e.message ?? "Navigation failed.");
        return sendError(reply, 500, "NAVIGATE_ERROR", e.message ?? "Unexpected error during navigation.");
      }
    },
  );

  server.get<{ Params: { id: string } }>(
    "/api/agent/v1/task-browser-sessions/:id/observe",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const session = validateTaskBrowserSession(req.params.id, delegation, reply);
      if (!session) return;

      try {
        const result = await connectAndObserve(session.cdp_url);
        return reply.send({
          ok: true,
          data: {
            agent_browser_mode: "controlled_browser_bridge",
            browser_session_id: session.browser_session_id,
            current_url: result.current_url,
            snapshot: result.snapshot,
            raw_cookies_revealed_to_agent: false,
            raw_storage_revealed_to_agent: false,
          },
        });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e.code === "CDP_CONNECT_FAILED") return sendError(reply, 503, "CDP_CONNECT_FAILED", e.message ?? "Failed to connect to browser.");
        return sendError(reply, 500, "OBSERVE_ERROR", e.message ?? "Unexpected error during observation.");
      }
    },
  );

  server.post<{ Params: { id: string } }>(
    "/api/agent/v1/task-browser-sessions/:id/click",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;
      const session = validateTaskBrowserSession(req.params.id, delegation, reply);
      if (!session) return;

      const body = req.body as { selector?: unknown; description?: unknown };
      if (!body.selector || typeof body.selector !== "string" || !body.selector.trim()) {
        return sendError(reply, 400, "MISSING_SELECTOR", "selector is required and must be a non-empty string.");
      }

      try {
        const result = await connectAndClick(session.cdp_url, body.selector);
        const { _page_text_signals, ...safeResult } = result;

        // Classify login outcome from page text signals (never exposed to agent directly)
        const loginDiagnostic = _page_text_signals ? classifyLoginOutcome(_page_text_signals) : null;
        if (loginDiagnostic) {
          // Link to vault pass via any injection tied to this browser session
          const linkedInjection = [...secretFieldInjections.values()].find(
            (inj) => inj.browser_session_id === session.browser_session_id,
          );
          loginDiagnostic.browser_session_id = session.browser_session_id;
          loginDiagnostic.related_pass_id = linkedInjection?.pass_id;

          let domain = session.browser_session_id;
          try { domain = new URL(safeResult.current_url).hostname; } catch { /* keep fallback */ }

          storeDiagnostic({
            user_id: delegation.user_id,
            browser_session_id: session.browser_session_id,
            delegation_id: delegation.id,
            domain,
            pass_label: linkedInjection ? aegisVaultPasses.get(linkedInjection.pass_id)?.pass_label : undefined,
            related_pass_id: linkedInjection?.pass_id,
            outcome: loginDiagnostic.outcome,
            user_message: loginDiagnostic.user_message,
            recommended_action: loginDiagnostic.recommended_action,
            failure_reason: loginDiagnostic.failure_reason,
            signals_detected: loginDiagnostic.signals_detected,
            raw_secret_revealed_to_agent: false,
          });
        }

        return reply.send({
          ok: true,
          data: {
            agent_browser_mode: "controlled_browser_bridge",
            browser_session_id: session.browser_session_id,
            clicked: true,
            current_url: safeResult.current_url,
            snapshot: safeResult.snapshot,
            ...(loginDiagnostic ? { login_diagnostic: loginDiagnostic } : {}),
            raw_cookies_revealed_to_agent: false,
            raw_storage_revealed_to_agent: false,
          },
        });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e.code === "SELECTOR_NOT_FOUND" || e.code === "CLICK_FAILED") return sendError(reply, 422, e.code, e.message ?? "Selector not found or not clickable.");
        if (e.code === "CDP_CONNECT_FAILED") return sendError(reply, 503, "CDP_CONNECT_FAILED", e.message ?? "Failed to connect to browser.");
        return sendError(reply, 500, "CLICK_ERROR", e.message ?? "Unexpected error during click.");
      }
    },
  );

  // ─── Agent-Browser Secret Injection v1 ─────────────────────────────────────
  // Primary path for agents that own their browser (e.g. Claude Code + @playwright/mcp).
  // The agent navigates with its own tools; Aegis fills only the protected credential
  // fields via CDP injection and returns a status receipt — no page content is returned.

  type CdpUrlValidationResult = { valid: true } | { valid: false; code: string; message: string };
  function validateExternalCdpUrl(raw: string): CdpUrlValidationResult {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { valid: false, code: "INVALID_CDP_URL", message: "external_cdp_url is not a valid URL." };
    }
    if (url.protocol !== "http:") {
      return {
        valid: false, code: "INVALID_CDP_PROTOCOL",
        message: "external_cdp_url must use http:// — HTTPS and other schemes are not supported for local CDP endpoints.",
      };
    }
    const allowedHosts = ["localhost", "127.0.0.1", "[::1]"];
    if (!allowedHosts.includes(url.hostname)) {
      return {
        valid: false, code: "EXTERNAL_CDP_LOCALHOST_ONLY",
        message: "external_cdp_url must target localhost (http://localhost:<port> or http://127.0.0.1:<port>). Remote injection targets are not permitted.",
      };
    }
    const port = parseInt(url.port, 10);
    if (!url.port || isNaN(port) || port < 1024 || port > 65535) {
      return {
        valid: false, code: "INVALID_CDP_PORT",
        message: "external_cdp_url must include a valid port in the range 1024–65535 (e.g. http://localhost:9222).",
      };
    }
    return { valid: true };
  }

  function injectionNextAction(status: SecretFieldInjectionStatus, authCovered?: boolean): string {
    switch (status) {
      case "pending_approval":
        return authCovered
          ? "Tell the user to approve in the Antigen UI at /route-run-approvals under 'Login credential requests'. Then call wait_for_credential_authorization with the authorization_id from this response — it will return automatically when approved. Do NOT ask the user to type 'done'."
          : "Tell the user to approve in the Antigen UI at /route-run-approvals under 'Login credential requests'. Then call wait_for_credential_authorization with the authorization_id. Do NOT ask the user to type 'done'.";
      case "approved":
        return "Injection is approved. Call execute_secret_field_injection with this injection_request_id.";
      case "executing":
        return "Injection is in progress. Poll get_secret_injection_status again shortly.";
      case "filled":
        return "Field was filled successfully. Continue your workflow — navigate, click submit, etc.";
      case "denied":
        return "Injection was denied by the user. Do not retry without user direction.";
      case "failed":
        return "Injection failed. Check error for details. Request a new injection if the issue is transient.";
      case "expired":
        return "Injection expired (5-minute TTL or API restart). Call request_secret_field_injection to start a new login attempt — a new user approval will be required.";
    }
  }

  // POST /api/agent/v1/injections — create a secret field injection request
  server.post(
    "/api/agent/v1/injections",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const injCollarResult = resolveEffectiveCollar(delegation, collars);
      if (!injCollarResult.ok) {
        return sendError(reply, injCollarResult.status, injCollarResult.code, injCollarResult.message);
      }

      const body = req.body as {
        domain?: string;
        pass_id?: string;
        field_kind?: string;
        page_url?: string;
        element_hint?: {
          label?: string;
          placeholder?: string;
          input_type?: string;
          selector_hint?: string;
        };
        reason?: string;
        browser_session_id?: string;
        external_cdp_url?: string;
      };

      if (!body.domain || typeof body.domain !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!body.field_kind || !["username", "password"].includes(body.field_kind)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "field_kind must be 'username' or 'password'.");
      }
      if (!body.page_url || typeof body.page_url !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "page_url is required.");
      }
      if (!body.reason || typeof body.reason !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "reason is required.");
      }

      // Domain must match the page_url hostname to prevent cross-domain injection
      let pageHostname: string;
      try {
        pageHostname = new URL(body.page_url).hostname;
      } catch {
        return sendError(reply, 400, "INVALID_URL", "page_url is not a valid URL.");
      }
      if (pageHostname !== body.domain && !pageHostname.endsWith(`.${body.domain}`)) {
        return sendError(
          reply, 400, "DOMAIN_MISMATCH",
          `Antigen will not inject ${body.domain} credentials into ${pageHostname}. ` +
          `Navigate to the ${body.domain} login page (using username/password, not OAuth) before requesting injection.`,
        );
      }

      // Validate optional browser_session_id binding
      let resolvedBrowserSessionId: string | undefined;
      if (typeof body.browser_session_id === "string" && body.browser_session_id.trim()) {
        const bs = getTaskBrowserSession(body.browser_session_id.trim(), MOCK_USER_ID);
        if (!bs) {
          return sendError(reply, 404, "TASK_BROWSER_SESSION_NOT_FOUND", "The referenced task browser session does not exist.");
        }
        if (bs.delegation_id !== delegation.id) {
          return sendError(reply, 403, "TASK_BROWSER_SESSION_FORBIDDEN", "The referenced task browser session does not belong to your delegation.");
        }
        if (bs.status !== "ready") {
          return sendError(reply, 400, "TASK_BROWSER_SESSION_NOT_READY", `Session status is '${bs.status}'; must be 'ready' to bind to an injection.`);
        }
        resolvedBrowserSessionId = bs.browser_session_id;
      }

      // Validate optional external_cdp_url — mutually exclusive with browser_session_id
      let resolvedExternalCdpUrl: string | undefined;
      if (typeof body.external_cdp_url === "string" && body.external_cdp_url.trim()) {
        if (resolvedBrowserSessionId) {
          return sendError(
            reply, 400, "CONFLICT",
            "Provide either external_cdp_url or browser_session_id, not both. " +
            "Use external_cdp_url when you own the browser; use browser_session_id for an Aegis-managed task browser session.",
          );
        }
        const cdpCheck = validateExternalCdpUrl(body.external_cdp_url.trim());
        if (!cdpCheck.valid) {
          return sendError(reply, 400, cdpCheck.code, cdpCheck.message);
        }
        resolvedExternalCdpUrl = body.external_cdp_url.trim();
      }

      // Find the vault pass
      const vaultRepo = getVaultRepository();
      let pass: Awaited<ReturnType<typeof vaultRepo.getVaultPass>> | undefined;
      if (body.pass_id) {
        pass = aegisVaultPasses.get(body.pass_id) ?? await vaultRepo.getVaultPass(body.pass_id);
        if (!pass || pass.user_id !== MOCK_USER_ID || pass.domain !== body.domain) {
          return sendError(reply, 404, "PASS_NOT_FOUND", `No vault pass found for pass_id '${body.pass_id}' on domain '${body.domain}'.`);
        }
      } else {
        pass = Array.from(aegisVaultPasses.values()).find(
          (p) => p.user_id === MOCK_USER_ID && p.domain === body.domain,
        );
        if (!pass) {
          return sendError(reply, 404, "PASS_NOT_FOUND", `No vault pass found for domain '${body.domain}'. Add credentials for this domain first.`);
        }
      }

      // Find or create a CredentialUseAuthorization for this login attempt.
      // One approval covers both username and password for the same pass/domain/delegation.
      const now = new Date();
      const fieldKind = body.field_kind as "username" | "password";

      // An approved auth is only reusable if the field_kind has remaining uses.
      const approvedAuth = Array.from(credentialUseAuthorizations.values()).find(
        (a) =>
          a.user_id === MOCK_USER_ID &&
          a.delegation_id === delegation.id &&
          a.domain === body.domain &&
          a.pass_id === pass.pass_id &&
          a.purpose === "login" &&
          a.status === "approved" &&
          new Date(a.expires_at) > now &&
          a.allowed_field_kinds.includes(fieldKind) &&
          (a.use_counts[fieldKind] ?? 0) < (a.max_uses_per_field[fieldKind] ?? 1),
      );

      const pendingAuth = !approvedAuth
        ? Array.from(credentialUseAuthorizations.values()).find(
            (a) =>
              a.user_id === MOCK_USER_ID &&
              a.delegation_id === delegation.id &&
              a.domain === body.domain &&
              a.pass_id === pass.pass_id &&
              a.purpose === "login" &&
              a.status === "pending_approval" &&
              new Date(a.expires_at) > now,
          )
        : undefined;

      let auth: CredentialUseAuthorization;
      let injectionStatus: SecretFieldInjectionStatus;

      if (approvedAuth) {
        auth = approvedAuth;
        injectionStatus = "approved";
      } else if (pendingAuth) {
        auth = pendingAuth;
        injectionStatus = "pending_approval";
      } else {
        auth = {
          authorization_id: newId("credauth"),
          user_id: MOCK_USER_ID,
          delegation_id: delegation.id,
          domain: body.domain,
          pass_id: pass.pass_id,
          pass_label: pass.label,
          pass_username: pass.username,
          allowed_field_kinds: ["username", "password"],
          max_uses_per_field: { username: 1, password: 1 },
          purpose: "login",
          status: "pending_approval",
          raw_values_revealed_to_agent: false,
          persistence_allowed: false,
          browser_storage_allowed: false,
          website_save_allowed: false,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          used_field_kinds: [],
          use_counts: { username: 0, password: 0 },
        };
        credentialUseAuthorizations.set(auth.authorization_id, auth);
        logAuthLifecycle("auth_created", auth);
        injectionStatus = "pending_approval";
      }

      const injection: SecretFieldInjection = {
        injection_request_id: newId("inj"),
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        domain: body.domain,
        field_kind: fieldKind,
        pass_id: pass.pass_id,
        page_url: body.page_url,
        element_hint: body.element_hint,
        reason: body.reason,
        status: injectionStatus,
        authorization_id: auth.authorization_id,
        ...(resolvedBrowserSessionId ? { browser_session_id: resolvedBrowserSessionId } : {}),
        ...(resolvedExternalCdpUrl ? { external_cdp_url: resolvedExternalCdpUrl } : {}),
        raw_value_revealed_to_agent: false,
        created_at: new Date().toISOString(),
        expires_at: auth.expires_at,
      };
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();
      logInjectionLifecycle("injection_created", injection);

      const authCovered = injectionStatus === "pending_approval";
      const remainingUses = auth.allowed_field_kinds.reduce(
        (acc, fk) => {
          acc[fk] = (auth.max_uses_per_field[fk] ?? 1) - (auth.use_counts[fk] ?? 0);
          return acc;
        },
        {} as Record<string, number>,
      );
      return reply.send({
        ok: true,
        data: {
          injection_request_id: injection.injection_request_id,
          status: injection.status,
          domain: injection.domain,
          field_kind: injection.field_kind,
          pass_label: pass.label,
          raw_value_revealed_to_agent: false,
          expires_at: injection.expires_at,
          authorization_id: auth.authorization_id,
          authorization_covers: "username and password for this login attempt — one approval, one use each, 5-minute TTL",
          remaining_uses: remainingUses,
          next_action: injectionNextAction(injection.status, authCovered),
        },
      });
    },
  );

  // GET /api/agent/v1/injections/:injectionId — poll status
  server.get<{ Params: { injectionId: string } }>(
    "/api/agent/v1/injections/:injectionId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const injection = secretFieldInjections.get(req.params.injectionId);
      if (!injection) return sendError(reply, 404, "INJECTION_NOT_FOUND", "Injection not found.");
      if (injection.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This injection does not belong to your delegation.");
      }

      // Lazily promote injection status from linked authorization if approved/denied/expired
      const terminalStatuses = ["filled", "denied", "failed", "expired"] as const;
      if (!terminalStatuses.includes(injection.status as any)) {
        if (new Date(injection.expires_at) < new Date()) {
          injection.status = "expired";
          secretFieldInjections.set(injection.injection_request_id, injection);
          schedulePersist();
          logInjectionLifecycle("injection_expired", injection);
        } else if (injection.status === "pending_approval" && injection.authorization_id) {
          const auth = credentialUseAuthorizations.get(injection.authorization_id);
          if (auth) {
            if (auth.status === "approved" && auth.allowed_field_kinds.includes(injection.field_kind)) {
              injection.status = "approved";
              injection.approved_at = auth.approved_at;
              secretFieldInjections.set(injection.injection_request_id, injection);
              schedulePersist();
              logInjectionLifecycle("injection_approved_via_poll", injection);
            } else if (["denied", "expired", "fulfilled", "revoked"].includes(auth.status)) {
              injection.status = auth.status === "fulfilled" ? "denied" : auth.status as any;
              secretFieldInjections.set(injection.injection_request_id, injection);
              schedulePersist();
              logInjectionLifecycle("injection_denied", injection);
            }
          }
        }
      }

      return reply.send({
        ok: true,
        data: {
          injection_request_id: injection.injection_request_id,
          status: injection.status,
          domain: injection.domain,
          field_kind: injection.field_kind,
          raw_value_revealed_to_agent: false,
          expires_at: injection.expires_at,
          ...(injection.filled_at ? { filled_at: injection.filled_at } : {}),
          ...(injection.error ? { error: injection.error } : {}),
          next_action: injectionNextAction(injection.status),
        },
      });
    },
  );

  // POST /api/agent/v1/injections/:injectionId/execute — CDP fill trigger
  server.post<{
    Params: { injectionId: string };
    Body: { browser_session_id?: string; external_cdp_url?: string };
  }>(
    "/api/agent/v1/injections/:injectionId/execute",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const execCollarResult = resolveEffectiveCollar(delegation, collars);
      if (!execCollarResult.ok) {
        return sendError(reply, execCollarResult.status, execCollarResult.code, execCollarResult.message);
      }

      const injection = secretFieldInjections.get(req.params.injectionId);
      if (!injection) return sendError(reply, 404, "INJECTION_NOT_FOUND", "Injection not found.");
      if (injection.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This injection does not belong to your delegation.");
      }

      // Expiry check
      if (new Date(injection.expires_at) < new Date() && injection.status !== "filled") {
        injection.status = "expired";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        logInjectionLifecycle("injection_expired", injection);
        return sendError(reply, 400, "INJECTION_EXPIRED", "Injection has expired. Request a new injection.");
      }

      // Promote via authorization if still pending; also enforce use limits
      if (injection.authorization_id) {
        const auth = credentialUseAuthorizations.get(injection.authorization_id);
        if (auth) {
          // Lazy expire the auth if past TTL
          if (new Date(auth.expires_at) < new Date() && auth.status === "approved") {
            auth.status = "expired";
            credentialUseAuthorizations.set(auth.authorization_id, auth);
            schedulePersist();
            logAuthLifecycle("auth_expired_lazy", auth);
          }
          // Promote pending injection to approved if auth is now approved
          if (
            injection.status === "pending_approval" &&
            auth.status === "approved" &&
            auth.allowed_field_kinds.includes(injection.field_kind)
          ) {
            injection.status = "approved";
            injection.approved_at = auth.approved_at;
            secretFieldInjections.set(injection.injection_request_id, injection);
            schedulePersist();
            logInjectionLifecycle("injection_approved_via_execute", injection);
          }
          // Block if authorization is fulfilled (all uses exhausted)
          if (auth.status === "fulfilled") {
            return sendError(
              reply, 400, "AUTHORIZATION_FULFILLED",
              `The credential-use authorization for this login attempt has already been fulfilled. ` +
              `Request a new injection to start a new login attempt — a new approval will be required.`,
            );
          }
          // Enforce per-field use limit
          if (injection.status === "approved" || auth.status === "approved") {
            const used = auth.use_counts[injection.field_kind] ?? 0;
            const max = auth.max_uses_per_field[injection.field_kind] ?? 1;
            if (used >= max) {
              return sendError(
                reply, 400, "USE_LIMIT_EXCEEDED",
                `The ${injection.field_kind} field has already been filled once for this login attempt. ` +
                `Request a new injection to start a new login attempt.`,
              );
            }
          }
        }
      }

      if (injection.status !== "approved") {
        return sendError(
          reply, 400, "INJECTION_NOT_APPROVED",
          `Injection status is '${injection.status}'; only 'approved' injections can be executed. ${injectionNextAction(injection.status)}`,
        );
      }

      // SensitiveGrant enforcement — active, non-consumed, non-revoked, non-expired grant required
      const grantCheck = checkSensitiveGrant(sensitiveGrants, {
        user_id: injection.user_id,
        delegation_id: injection.delegation_id,
        domain: injection.domain,
        grant_type: "credential_injection",
        pass_id: injection.pass_id,
        authorization_id: injection.authorization_id,
      });
      if (!grantCheck.valid) {
        const grantErrorDetails: Record<string, [number, string, string]> = {
          consumed: [409, "SENSITIVE_GRANT_CONSUMED",  "This credential injection grant has already been consumed. Request a new injection."],
          expired:  [400, "SENSITIVE_GRANT_EXPIRED",   "The sensitive grant for this injection has expired. Request a new injection."],
          revoked:  [403, "SENSITIVE_GRANT_REVOKED",   "The sensitive grant for this injection has been revoked."],
          no_grant: [403, "SENSITIVE_GRANT_REQUIRED",  "No valid sensitive grant found for this injection. Approval is required."],
        };
        const [st, code, msg] = grantErrorDetails[grantCheck.reason ?? "no_grant"] ?? [403, "SENSITIVE_GRANT_INVALID", "Grant check failed."];
        return sendError(reply, st, code, msg);
      }
      const activeGrant = grantCheck.grant!;

      // Transition to executing
      injection.status = "executing";
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();

      // Resolve credential — resolvedValue never leaves this function into any response or log
      const vaultRepo = getVaultRepository();
      const pass = aegisVaultPasses.get(injection.pass_id) ?? await vaultRepo.getVaultPass(injection.pass_id);
      if (!pass || pass.user_id !== MOCK_USER_ID) {
        injection.status = "failed";
        injection.error = "Vault pass not found or access denied.";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        logInjectionLifecycle("injection_failed", injection);
        return sendError(reply, 404, "PASS_NOT_FOUND", "Vault pass not found.");
      }

      let resolvedValue: string;
      const kms = getKmsProvider();

      try {
        if (injection.field_kind === "username") {
          if (!pass.username) throw new Error("Pass has no username stored.");
          resolvedValue = pass.username;
          // Username is non-secret metadata — no KMS needed, no audit event
        } else {
          // Password — decrypt via KMS
          const blob = await vaultRepo.getEncryptedSecret(pass.secret_ref);
          if (!blob) throw new Error(`Secret not available for pass ${pass.pass_id}.`);
          const kmsCtx = {
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            purpose: "login_password" as const,
          };
          resolvedValue = await kms.decryptSecret(blob, kmsCtx);
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            run_id: `injection:${injection.injection_request_id}`,
            success: true,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Credential resolution failed";
        if (injection.field_kind === "password") {
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            run_id: `injection:${injection.injection_request_id}`,
            success: false,
            error_code: "RESOLVE_FAILED",
          });
        }
        injection.status = "failed";
        injection.error = msg;
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        logInjectionLifecycle("injection_failed", injection);
        return sendError(reply, 500, "CREDENTIAL_RESOLVE_FAILED", msg);
      }

      // CDP fill — resolvedValue used here and immediately discarded; never returned in response
      // Precedence: body.browser_session_id → stored browser_session_id →
      //             body.external_cdp_url → stored external_cdp_url → AEGIS_PLAYWRIGHT_CDP_URL env
      const bodyBsId = typeof req.body?.browser_session_id === "string"
        ? req.body.browser_session_id.trim() : undefined;
      const bodyExtCdp = typeof req.body?.external_cdp_url === "string"
        ? req.body.external_cdp_url.trim() : undefined;

      const cdpResolution = resolveSecretInjectionCdpEndpoint(
        injection,
        bodyBsId,
        bodyExtCdp,
        (id) => getTaskBrowserSession(id, MOCK_USER_ID),
        validateExternalCdpUrl,
      );

      if (cdpResolution.error) {
        injection.status = "failed";
        injection.error = cdpResolution.error.message;
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        logInjectionLifecycle("injection_failed", injection);
        return sendError(reply, 400, cdpResolution.error.code, cdpResolution.error.message);
      }

      if (process.env.ANTIGEN_CDP_DIAGNOSTICS === "true") {
        console.log("[CdpInjection] endpoint selection", {
          path: "secret",
          source: cdpResolution.source,
          cdp_url: cdpResolution.cdpUrlOverride ?? process.env.AEGIS_PLAYWRIGHT_CDP_URL ?? null,
          preferred_target_url: cdpResolution.preferredTargetUrl ?? null,
        });
      }

      const resolvedBrowserSessionId: string | undefined =
        cdpResolution.source === "body_browser_session_id" ? bodyBsId :
        cdpResolution.source === "stored_browser_session_id" ? injection.browser_session_id :
        undefined;

      // Set executing_at immediately before CDP fill — marks when the fill attempt began
      if (!injection.executing_at) {
        injection.executing_at = new Date().toISOString();
        secretFieldInjections.set(injection.injection_request_id, injection);
      }
      logInjectionLifecycle("injection_executing", injection);

      const fillResult = await executeSecretInjectionViaCDP(
        injection, resolvedValue, cdpResolution.cdpUrlOverride, cdpResolution.preferredTargetUrl,
        resolvedBrowserSessionId,
      );

      if (fillResult.success) {
        injection.status = "filled";
        injection.filled_at = new Date().toISOString();
        injection.error = undefined;
        // Update use counts and check for fulfillment
        if (injection.authorization_id) {
          const auth = credentialUseAuthorizations.get(injection.authorization_id);
          if (auth) {
            const now = new Date().toISOString();
            auth.use_counts[injection.field_kind] = (auth.use_counts[injection.field_kind] ?? 0) + 1;
            if (!auth.used_field_kinds.includes(injection.field_kind)) {
              auth.used_field_kinds = [...auth.used_field_kinds, injection.field_kind];
            }
            auth.last_used_at = now;
            // Fulfilled when all allowed fields have hit their max use count
            const allFulfilled = auth.allowed_field_kinds.every(
              (fk) => (auth.use_counts[fk] ?? 0) >= (auth.max_uses_per_field[fk] ?? 1),
            );
            if (allFulfilled) {
              auth.status = "fulfilled";
              auth.fulfilled_at = now;
              // Consume the SensitiveGrant — all authorized fields delivered; authority is spent
              activeGrant.status = "consumed";
              activeGrant.consumed_at = now;
              sensitiveGrants.set(activeGrant.grant_id, activeGrant);
              logAuthLifecycle("auth_fulfilled", auth);
            }
            credentialUseAuthorizations.set(auth.authorization_id, auth);
          }
        }
      } else {
        injection.status = "failed";
        injection.error = fillResult.error ?? "CDP fill failed";
      }
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();
      logInjectionLifecycle(fillResult.success ? "injection_filled" : "injection_failed", injection);

      if (!fillResult.success) {
        return sendError(reply, 500, "CDP_FILL_FAILED", fillResult.error ?? "CDP fill failed");
      }

      // Response NEVER includes resolvedValue or pass_id
      return reply.send({
        ok: true,
        data: {
          injection_request_id: injection.injection_request_id,
          status: "filled",
          field_kind: injection.field_kind,
          domain: injection.domain,
          filled_at: injection.filled_at,
          raw_value_revealed_to_agent: false,
          note: "Antigen injected the field value directly via CDP. The raw credential was never returned to the agent.",
        },
      });
    },
  );

  // POST /api/agent/v1/credential-step-handoff — fill a credential field + submit atomically
  server.post<{ Body: {
    injection_request_id: string;
    step_kind: "username_next" | "password_submit";
    submit?: { selector_hint?: string; button_text?: string };
    reason: string;
  } }>(
    "/api/agent/v1/credential-step-handoff",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { injection_request_id, step_kind, submit, reason } = req.body ?? {};

      if (!injection_request_id || typeof injection_request_id !== "string") {
        return sendError(reply, 400, "MISSING_INJECTION_ID", "injection_request_id is required.");
      }
      if (step_kind !== "username_next" && step_kind !== "password_submit") {
        return sendError(reply, 400, "INVALID_STEP_KIND", "step_kind must be 'username_next' or 'password_submit'.");
      }
      if (!reason || typeof reason !== "string") {
        return sendError(reply, 400, "MISSING_REASON", "reason is required.");
      }

      const injection = secretFieldInjections.get(injection_request_id);
      if (!injection) return sendError(reply, 404, "INJECTION_NOT_FOUND", "Injection request not found.");
      if (injection.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This injection does not belong to your delegation.");
      }

      // step_kind must match the injection's field_kind
      const expectedFieldKind = step_kind === "username_next" ? "username" : "password";
      if (injection.field_kind !== expectedFieldKind) {
        return sendError(
          reply, 400, "STEP_KIND_MISMATCH",
          `step_kind '${step_kind}' requires field_kind '${expectedFieldKind}', but this injection is for '${injection.field_kind}'.`,
        );
      }

      // Expiry check
      if (new Date(injection.expires_at) < new Date() && injection.status !== "filled") {
        injection.status = "expired";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        return sendError(reply, 400, "INJECTION_EXPIRED", "Injection has expired. Request a new injection.");
      }

      // Promote via authorization if still pending; enforce use limits
      if (injection.authorization_id) {
        const auth = credentialUseAuthorizations.get(injection.authorization_id);
        if (auth) {
          if (new Date(auth.expires_at) < new Date() && auth.status === "approved") {
            auth.status = "expired";
            credentialUseAuthorizations.set(auth.authorization_id, auth);
            schedulePersist();
          }
          if (
            injection.status === "pending_approval" &&
            auth.status === "approved" &&
            auth.allowed_field_kinds.includes(injection.field_kind)
          ) {
            injection.status = "approved";
            injection.approved_at = auth.approved_at;
            secretFieldInjections.set(injection.injection_request_id, injection);
            schedulePersist();
          }
          if (auth.status === "fulfilled") {
            return sendError(
              reply, 400, "AUTHORIZATION_FULFILLED",
              "The credential-use authorization has already been fulfilled. Request a new injection to start a new login attempt.",
            );
          }
          if (injection.status === "approved" || auth.status === "approved") {
            const used = auth.use_counts[injection.field_kind] ?? 0;
            const max = auth.max_uses_per_field[injection.field_kind] ?? 1;
            if (used >= max) {
              return sendError(
                reply, 400, "USE_LIMIT_EXCEEDED",
                `The ${injection.field_kind} field has already been filled once for this login attempt.`,
              );
            }
          }
        }
      }

      if (injection.status !== "approved") {
        return sendError(
          reply, 400, "INJECTION_NOT_APPROVED",
          `Injection status is '${injection.status}'; only 'approved' injections can be executed for a step handoff.`,
        );
      }

      // SensitiveGrant enforcement
      const grantCheck = checkSensitiveGrant(sensitiveGrants, {
        user_id: injection.user_id,
        delegation_id: injection.delegation_id,
        domain: injection.domain,
        grant_type: "credential_injection",
        pass_id: injection.pass_id,
        authorization_id: injection.authorization_id,
      });
      if (!grantCheck.valid) {
        const grantErrors: Record<string, [number, string, string]> = {
          consumed: [409, "SENSITIVE_GRANT_CONSUMED", "This credential injection grant has already been consumed."],
          expired:  [400, "SENSITIVE_GRANT_EXPIRED",   "The sensitive grant for this injection has expired."],
          revoked:  [403, "SENSITIVE_GRANT_REVOKED",   "The sensitive grant has been revoked."],
          no_grant: [403, "SENSITIVE_GRANT_REQUIRED",  "No valid sensitive grant found. Approval is required."],
        };
        const [st, code, msg] = grantErrors[grantCheck.reason ?? "no_grant"] ?? [403, "SENSITIVE_GRANT_INVALID", "Grant check failed."];
        return sendError(reply, st, code, msg);
      }
      const activeGrant = grantCheck.grant!;

      // Transition to executing
      injection.status = "executing";
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();

      // Resolve credential
      const vaultRepo = getVaultRepository();
      const pass = aegisVaultPasses.get(injection.pass_id) ?? await vaultRepo.getVaultPass(injection.pass_id);
      if (!pass || pass.user_id !== MOCK_USER_ID) {
        injection.status = "failed";
        injection.error = "Vault pass not found or access denied.";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        logInjectionLifecycle("injection_failed", injection);
        return sendError(reply, 404, "PASS_NOT_FOUND", "Vault pass not found.");
      }

      let resolvedValue: string;
      const kms = getKmsProvider();
      try {
        if (injection.field_kind === "username") {
          if (!pass.username) throw new Error("Pass has no username stored.");
          resolvedValue = pass.username;
        } else {
          const blob = await vaultRepo.getEncryptedSecret(pass.secret_ref);
          if (!blob) throw new Error(`Secret not available for pass ${pass.pass_id}.`);
          resolvedValue = await kms.decryptSecret(blob, {
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            purpose: "login_password" as const,
          });
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            run_id: `handoff:${injection.injection_request_id}`,
            success: true,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Credential resolution failed";
        if (injection.field_kind === "password") {
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pass.user_id,
            pass_id: pass.pass_id,
            domain: pass.domain,
            run_id: `handoff:${injection.injection_request_id}`,
            success: false,
            error_code: "RESOLVE_FAILED",
          });
        }
        injection.status = "failed";
        injection.error = msg;
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        logInjectionLifecycle("injection_failed", injection);
        return sendError(reply, 500, "CREDENTIAL_RESOLVE_FAILED", msg);
      }

      // Pre-flight: validate button_text against blocklist before resolving credentials or touching CDP
      if (submit?.button_text) {
        const bt = submit.button_text.trim();
        if (SUBMIT_BLOCKLIST.test(bt)) {
          const handoffId = newId("csh");
          const completedAt = new Date().toISOString();
          credentialStepHandoffs.set(handoffId, {
            handoff_id: handoffId,
            injection_request_id,
            delegation_id: delegation.id,
            user_id: injection.user_id,
            domain: injection.domain,
            step_kind,
            pass_label: aegisVaultPasses.get(injection.pass_id)?.pass_label ?? injection.domain,
            outcome: "blocked_policy",
            raw_value_revealed_to_agent: false,
            completed_at: completedAt,
            ...(injection.authorization_id ? { authorization_id: injection.authorization_id } : {}),
          } satisfies CredentialStepHandoffRecord);
          return reply.send({
            ok: true,
            data: {
              handoff_id: handoffId,
              status: "blocked_policy" as const,
              step_kind,
              domain: injection.domain,
              completed_at: completedAt,
              raw_value_revealed_to_agent: false,
              blocked_reason: `Submit button text "${bt.slice(0, 60)}" is on the payment/destructive action blocklist. Credential was not filled.`,
              next_action: { recommended: "stop_and_ask_user" as const, reason: "Blocked before credential fill — no credential was resolved or injected." },
            } satisfies CredentialStepHandoffResult,
          });
        }
      }

      // Phase 1: CDP fill — same path as execute_secret_field_injection
      let cdpUrlOverride: string | undefined;
      let preferredTargetUrlHandoff: string | undefined;
      if (injection.browser_session_id) {
        const bs = getTaskBrowserSession(injection.browser_session_id, MOCK_USER_ID);
        if (bs?.status === "ready") {
          cdpUrlOverride = bs.cdp_url;
          preferredTargetUrlHandoff = bs.current_url;
        }
      } else if (injection.external_cdp_url) {
        cdpUrlOverride = injection.external_cdp_url;
      }

      // Set executing_at immediately before CDP fill — marks when the fill attempt began
      if (!injection.executing_at) {
        injection.executing_at = new Date().toISOString();
        secretFieldInjections.set(injection.injection_request_id, injection);
      }
      logInjectionLifecycle("injection_executing", injection);

      const fillResult = await executeSecretInjectionViaCDP(
        injection, resolvedValue, cdpUrlOverride, preferredTargetUrlHandoff, injection.browser_session_id,
      );

      if (!fillResult.success) {
        injection.status = "failed";
        injection.error = fillResult.error ?? "CDP fill failed";
        secretFieldInjections.set(injection.injection_request_id, injection);
        schedulePersist();
        logInjectionLifecycle("injection_failed", injection);
        const handoffId = newId("csh");
        const completedAt = new Date().toISOString();
        credentialStepHandoffs.set(handoffId, {
          handoff_id: handoffId,
          injection_request_id,
          delegation_id: delegation.id,
          user_id: injection.user_id,
          domain: injection.domain,
          step_kind,
          pass_label: pass.pass_label ?? pass.domain,
          outcome: "submit_failed",
          raw_value_revealed_to_agent: false,
          completed_at: completedAt,
          ...(injection.authorization_id ? { authorization_id: injection.authorization_id } : {}),
        } satisfies CredentialStepHandoffRecord);
        return reply.status(500).send({
          ok: false,
          data: {
            handoff_id: handoffId,
            status: "submit_failed",
            step_kind,
            domain: injection.domain,
            completed_at: completedAt,
            raw_value_revealed_to_agent: false,
            blocked_reason: "Field fill (CDP) failed before submit could be attempted.",
            next_action: { recommended: "stop_and_ask_user", reason: fillResult.error ?? "CDP fill failed." },
          },
        });
      }

      // Fill succeeded — mark injection filled and update use counts before the submit phase
      injection.status = "filled";
      injection.filled_at = new Date().toISOString();
      injection.error = undefined;
      if (injection.authorization_id) {
        const auth = credentialUseAuthorizations.get(injection.authorization_id);
        if (auth) {
          const now = new Date().toISOString();
          auth.use_counts[injection.field_kind] = (auth.use_counts[injection.field_kind] ?? 0) + 1;
          if (!auth.used_field_kinds.includes(injection.field_kind)) {
            auth.used_field_kinds = [...auth.used_field_kinds, injection.field_kind];
          }
          auth.last_used_at = now;
          const allFulfilled = auth.allowed_field_kinds.every(
            (fk) => (auth.use_counts[fk] ?? 0) >= (auth.max_uses_per_field[fk] ?? 1),
          );
          if (allFulfilled) {
            auth.status = "fulfilled";
            auth.fulfilled_at = now;
            activeGrant.status = "consumed";
            activeGrant.consumed_at = now;
            sensitiveGrants.set(activeGrant.grant_id, activeGrant);
            logAuthLifecycle("auth_fulfilled", auth);
          }
          credentialUseAuthorizations.set(auth.authorization_id, auth);
        }
      }
      secretFieldInjections.set(injection.injection_request_id, injection);
      schedulePersist();
      logInjectionLifecycle("injection_filled", injection);

      // Phase 2: Submit + Wait — resolvedValue is discarded, never returned
      resolvedValue = "";
      const cdpUrl = cdpUrlOverride ?? process.env.AEGIS_PLAYWRIGHT_CDP_URL ?? "";
      const submitResult = await performSubmitAndWait({
        domain: injection.domain,
        cdpUrl,
        step_kind,
        submit: {
          selector_hint: submit?.selector_hint,
          button_text: submit?.button_text,
        },
      });

      const handoffId = newId("csh");
      const completedAt = new Date().toISOString();

      credentialStepHandoffs.set(handoffId, {
        handoff_id: handoffId,
        injection_request_id,
        delegation_id: delegation.id,
        user_id: injection.user_id,
        domain: injection.domain,
        step_kind,
        pass_label: pass.pass_label ?? pass.domain,
        outcome: submitResult.status,
        raw_value_revealed_to_agent: false,
        completed_at: completedAt,
        ...(submitResult.challenge_kind ? { challenge_kind: submitResult.challenge_kind } : {}),
        ...(injection.authorization_id ? { authorization_id: injection.authorization_id } : {}),
      } satisfies CredentialStepHandoffRecord);

      return reply.send({
        ok: true,
        data: {
          handoff_id: handoffId,
          status: submitResult.status,
          step_kind,
          domain: injection.domain,
          completed_at: completedAt,
          raw_value_revealed_to_agent: false,
          ...(submitResult.current_url ? { current_url: submitResult.current_url } : {}),
          ...(submitResult.page_title ? { page_title: submitResult.page_title } : {}),
          ...(submitResult.challenge_kind ? { challenge_kind: submitResult.challenge_kind } : {}),
          ...(submitResult.signals_detected?.length ? { signals_detected: submitResult.signals_detected } : {}),
          ...(submitResult.blocked_reason ? { blocked_reason: submitResult.blocked_reason } : {}),
          ...(submitResult.next_action ? { next_action: submitResult.next_action } : {}),
        } satisfies CredentialStepHandoffResult,
      });
    },
  );

  // GET /api/agent/v1/credential-authorizations/:authorizationId — poll authorization status
  server.get<{ Params: { authorizationId: string } }>(
    "/api/agent/v1/credential-authorizations/:authorizationId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const auth = credentialUseAuthorizations.get(req.params.authorizationId);
      if (!auth) return sendError(reply, 404, "AUTHORIZATION_NOT_FOUND", "Credential authorization not found.");
      if (auth.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This authorization does not belong to your delegation.");
      }

      // Lazy expire if past TTL and still in a non-terminal pre-approved state
      const terminalStatuses = ["fulfilled", "denied", "expired", "revoked"];
      if (!terminalStatuses.includes(auth.status) && new Date(auth.expires_at) < new Date()) {
        auth.status = "expired";
        credentialUseAuthorizations.set(auth.authorization_id, auth);
        schedulePersist();
        logAuthLifecycle("auth_expired_lazy", auth);
      }

      const remainingUses = auth.allowed_field_kinds.reduce(
        (acc, fk) => {
          acc[fk] = (auth.max_uses_per_field[fk] ?? 1) - (auth.use_counts[fk] ?? 0);
          return acc;
        },
        {} as Record<string, number>,
      );

      // Safe metadata only — no pass_id, secret_ref, raw values, cookies, KMS material
      return reply.send({
        ok: true,
        data: {
          authorization_id: auth.authorization_id,
          domain: auth.domain,
          pass_label: auth.pass_label,
          allowed_field_kinds: auth.allowed_field_kinds,
          max_uses_per_field: auth.max_uses_per_field,
          use_counts: auth.use_counts,
          remaining_uses: remainingUses,
          status: auth.status,
          raw_values_revealed_to_agent: false,
          expires_at: auth.expires_at,
          approved_at: auth.approved_at,
          fulfilled_at: auth.fulfilled_at,
          last_used_at: auth.last_used_at,
          used_field_kinds: auth.used_field_kinds,
        },
      });
    },
  );

  // ─── Challenge Relay v1 ────────────────────────────────────────────────────

  const VALID_CHALLENGE_TYPES = new Set<SecurityChallengeType>([
    "email_device_verification", "sms_code", "totp", "passkey",
    "captcha", "device_verification", "unknown",
  ]);

  function challengeNextAction(status: SecurityChallengeStatus): string {
    switch (status) {
      case "pending_user":
        return 'Tell the user: "A verification code is needed. Please enter it in the Antigen UI at /route-run-approvals under \'Security challenges\'." Do NOT ask the user to paste the code into chat. Call wait_for_security_challenge again.';
      case "code_submitted":
        return "User has submitted the code. Call inject_security_challenge_code now.";
      case "code_injected":
        return "Code was injected into the browser field. Click 'Verify', 'Continue', or 'Submit' in your Playwright browser to complete the challenge.";
      case "user_completed":
        return "User completed the challenge directly in the browser. Continue your workflow.";
      case "cancelled":
        return "Challenge was cancelled by the user. Do not retry without user direction.";
      case "expired":
        return "Challenge expired. Navigate back to the challenge page and call report_security_challenge again.";
      case "failed":
        return "Challenge injection failed. Check the error field. The user may submit the code again via the Antigen UI.";
    }
  }

  // POST /api/agent/v1/security-challenges — agent reports a detected challenge
  server.post(
    "/api/agent/v1/security-challenges",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = req.body as {
        domain?: unknown;
        page_url?: unknown;
        challenge_type?: unknown;
        masked_destination?: unknown;
        browser_session_id?: unknown;
        element_hint?: unknown;
        instructions?: unknown;
      };

      if (!body.domain || typeof body.domain !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!body.page_url || typeof body.page_url !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "page_url is required.");
      }

      let pageHostname: string;
      try {
        pageHostname = new URL(body.page_url).hostname;
      } catch {
        return sendError(reply, 400, "INVALID_URL", "page_url is not a valid URL.");
      }
      if (pageHostname !== body.domain && !pageHostname.endsWith(`.${body.domain}`)) {
        return sendError(
          reply, 400, "DOMAIN_MISMATCH",
          `page_url hostname '${pageHostname}' must match domain '${body.domain}'.`,
        );
      }

      const challengeType = (typeof body.challenge_type === "string" && VALID_CHALLENGE_TYPES.has(body.challenge_type as SecurityChallengeType))
        ? body.challenge_type as SecurityChallengeType
        : "unknown";

      const now = new Date();
      const challenge: SecurityChallenge = {
        challenge_id: newId("chlg"),
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        browser_session_id: typeof body.browser_session_id === "string" ? body.browser_session_id : undefined,
        domain: body.domain,
        page_url: body.page_url,
        challenge_type: challengeType,
        status: "pending_user",
        masked_destination: typeof body.masked_destination === "string" ? body.masked_destination : undefined,
        element_hint: (body.element_hint && typeof body.element_hint === "object") ? body.element_hint as SecurityChallenge["element_hint"] : undefined,
        instructions: (typeof body.instructions === "string" && body.instructions.trim())
          ? body.instructions.trim()
          : `${body.domain} requires a security verification code. Enter the code in the Antigen UI.`,
        raw_code_revealed_to_agent: false,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      };

      securityChallenges.set(challenge.challenge_id, challenge);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          challenge_id: challenge.challenge_id,
          status: challenge.status,
          challenge_type: challenge.challenge_type,
          domain: challenge.domain,
          masked_destination: challenge.masked_destination,
          expires_at: challenge.expires_at,
          raw_code_revealed_to_agent: false as const,
          next_action: `Tell the user: "A security challenge was detected on ${challenge.domain}. Please enter the verification code in the Antigen UI at /route-run-approvals under 'Security challenges'." Do NOT ask the user to paste the code into chat. Then call wait_for_security_challenge with challenge_id="${challenge.challenge_id}".`,
        },
      });
    },
  );

  // GET /api/agent/v1/security-challenges/:challengeId — poll challenge status
  server.get<{ Params: { challengeId: string } }>(
    "/api/agent/v1/security-challenges/:challengeId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "CHALLENGE_NOT_FOUND", "Security challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID || challenge.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this challenge.");
      }

      // Lazy expire
      if (
        (challenge.status === "pending_user" || challenge.status === "code_submitted") &&
        new Date(challenge.expires_at) < new Date()
      ) {
        challenge.status = "expired";
        challengeCodes.delete(challenge.challenge_id);
        securityChallenges.set(challenge.challenge_id, challenge);
        schedulePersist();
      }

      return reply.send({
        ok: true,
        data: {
          challenge_id: challenge.challenge_id,
          status: challenge.status,
          challenge_type: challenge.challenge_type,
          domain: challenge.domain,
          masked_destination: challenge.masked_destination,
          expires_at: challenge.expires_at,
          submitted_at: challenge.submitted_at,
          injected_at: challenge.injected_at,
          completed_at: challenge.completed_at,
          error: challenge.error,
          raw_code_revealed_to_agent: false as const,
          next_action: challengeNextAction(challenge.status),
        },
      });
    },
  );

  // ─── Human Presence Relay v1 ─────────────────────────────────────────────────

  // GET /api/agent/v1/human-verification-requests/:requestId — agent polls the
  // relay status (wait_for_human_verification). Safe view + next_action only:
  // no selectors, coordinates, boxes, or gesture data. External agents cannot
  // act on the request through this namespace — completion is user-only via
  // the Aegis UI.
  server.get<{ Params: { requestId: string } }>(
    "/api/agent/v1/human-verification-requests/:requestId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const request = humanVerificationRequests.get(req.params.requestId);
      if (!request) {
        return sendError(reply, 404, "HUMAN_VERIFICATION_REQUEST_NOT_FOUND", "Human-verification request not found.");
      }
      if (request.user_id !== MOCK_USER_ID || request.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this human-verification request.");
      }
      lazyExpireHumanVerificationRequest(request);
      return reply.send({ ok: true, data: toAgentHumanVerificationView(request) });
    },
  );

  // ─── Connected Email Challenge Resolver v1 ──────────────────────────────────

  function resolutionNextAction(status: ChallengeEmailResolutionStatus): string {
    switch (status) {
      case "pending_approval":
        return "Wait for the user to approve the Gmail search in the Antigen UI at /route-run-approvals under 'Security challenges'. Then call wait_for_challenge_email_resolution again.";
      case "code_found":
        return "Call inject_challenge_email_code to inject the code into the browser field. The agent never sees the code.";
      case "injected":
        return "Code was injected into the browser field. Click 'Verify', 'Continue', or 'Submit' in your Playwright browser to complete the challenge. Antigen does not click for you.";
      case "not_found":
        return "No code found in recent verification emails. Tell the user: 'Antigen could not find the verification code in Gmail. Please enter it manually in the Antigen UI at /route-run-approvals under Security challenges.'";
      case "failed":
        return "Email resolution failed. Tell the user to enter the verification code manually in the Antigen UI.";
      case "cancelled":
        return "Resolution was cancelled. The user can enter the code manually in the Antigen UI.";
      case "expired":
        return "Resolution expired. Request a new resolution if the challenge is still active.";
      case "searching":
        return "Gmail search is in progress. Call wait_for_challenge_email_resolution again shortly.";
    }
  }

  function safeEmailResolution(res: ChallengeEmailResolution) {
    return {
      resolution_id: res.resolution_id,
      challenge_id: res.challenge_id,
      provider: res.provider,
      domain: res.domain,
      status: res.status,
      raw_code_revealed_to_agent: false as const,
      email_body_revealed_to_agent: false as const,
      search_window_started_at: res.search_window_started_at,
      searched_at: res.searched_at,
      found_at: res.found_at,
      injected_at: res.injected_at,
      sender_domain: res.sender_domain,
      received_at: res.received_at,
      extraction_source: res.extraction_source,
      error: res.error,
      created_at: res.created_at,
      updated_at: res.updated_at,
    };
  }

  // POST /api/agent/v1/security-challenges/:challengeId/email-resolution-request
  // Agent requests Gmail-based email resolution for a live challenge.
  server.post<{ Params: { challengeId: string } }>(
    "/api/agent/v1/security-challenges/:challengeId/email-resolution-request",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "CHALLENGE_NOT_FOUND", "Security challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID || challenge.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this challenge.");
      }

      if (challenge.status !== "pending_user") {
        return sendError(
          reply, 400, "INVALID_CHALLENGE_STATUS",
          `Challenge status is '${challenge.status}'. Gmail resolver requires status 'pending_user'.`,
        );
      }
      if (!isEmailChallengeSupported(challenge.domain)) {
        return sendError(
          reply, 400, "DOMAIN_NOT_SUPPORTED",
          `Email resolver does not support '${challenge.domain}' challenges. Use report_security_challenge for unsupported domains.`,
        );
      }
      if (challenge.challenge_type !== "email_device_verification") {
        return sendError(
          reply, 400, "CHALLENGE_TYPE_NOT_SUPPORTED",
          `Email resolver v1 only supports 'email_device_verification'. This challenge is '${challenge.challenge_type}'.`,
        );
      }

      // Deduplication: return existing non-terminal resolution for this challenge
      const existing = Array.from(challengeEmailResolutions.values()).find(
        (r) =>
          r.challenge_id === challenge.challenge_id &&
          !["injected", "not_found", "failed", "expired", "cancelled"].includes(r.status),
      );
      if (existing) {
        return reply.send({
          ok: true,
          data: {
            ...safeEmailResolution(existing),
            next_action: resolutionNextAction(existing.status),
          },
        });
      }

      const now = new Date().toISOString();
      const resolution: ChallengeEmailResolution = {
        resolution_id: newId("ceres"),
        challenge_id: challenge.challenge_id,
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        provider: "gmail",
        domain: challenge.domain,
        status: "pending_approval",
        raw_code_revealed_to_agent: false,
        email_body_revealed_to_agent: false,
        search_window_started_at: challenge.created_at,
        created_at: now,
        updated_at: now,
      };

      challengeEmailResolutions.set(resolution.resolution_id, resolution);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          ...safeEmailResolution(resolution),
          next_action: resolutionNextAction(resolution.status),
        },
      });
    },
  );

  // GET /api/agent/v1/challenge-email-resolutions/:resolutionId — poll resolution status
  server.get<{ Params: { resolutionId: string } }>(
    "/api/agent/v1/challenge-email-resolutions/:resolutionId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const resolution = challengeEmailResolutions.get(req.params.resolutionId);
      if (!resolution) return sendError(reply, 404, "RESOLUTION_NOT_FOUND", "Email resolution not found.");
      if (resolution.user_id !== MOCK_USER_ID || resolution.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this resolution.");
      }

      // Lazy expiry: resolutions expire 10 minutes after creation if not completed
      const RESOLUTION_TTL_MS = 10 * 60 * 1000;
      const isNonTerminal = !["injected", "not_found", "failed", "expired", "cancelled"].includes(resolution.status);
      if (isNonTerminal && new Date(resolution.created_at).getTime() + RESOLUTION_TTL_MS < Date.now()) {
        resolution.status = "expired";
        resolution.updated_at = new Date().toISOString();
        resolutionCodes.delete(resolution.resolution_id);
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
      }

      return reply.send({
        ok: true,
        data: {
          ...safeEmailResolution(resolution),
          next_action: resolutionNextAction(resolution.status),
        },
      });
    },
  );

  // POST /api/agent/v1/challenge-email-resolutions/:resolutionId/inject
  // Agent triggers CDP injection of the found code.
  server.post<{ Params: { resolutionId: string } }>(
    "/api/agent/v1/challenge-email-resolutions/:resolutionId/inject",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const resolution = challengeEmailResolutions.get(req.params.resolutionId);
      if (!resolution) return sendError(reply, 404, "RESOLUTION_NOT_FOUND", "Email resolution not found.");
      if (resolution.user_id !== MOCK_USER_ID || resolution.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this resolution.");
      }
      if (resolution.status !== "code_found") {
        return sendError(
          reply, 400, "INVALID_STATUS",
          `Cannot inject for resolution with status '${resolution.status}'. Status must be 'code_found'.`,
        );
      }

      const codeEntry = resolutionCodes.get(resolution.resolution_id);
      if (!codeEntry) {
        resolution.status = "failed";
        resolution.error = "Code is no longer available. It may have expired. Request a new resolution.";
        resolution.updated_at = new Date().toISOString();
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
        return sendError(reply, 400, "CODE_NOT_AVAILABLE", resolution.error);
      }
      if (new Date(codeEntry.expires_at) < new Date()) {
        resolutionCodes.delete(resolution.resolution_id);
        resolution.status = "expired";
        resolution.error = "The retrieved code has expired. Request a new resolution.";
        resolution.updated_at = new Date().toISOString();
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
        return sendError(reply, 400, "CODE_EXPIRED", resolution.error);
      }

      // Retrieve the original challenge for CDP targeting
      const challenge = securityChallenges.get(resolution.challenge_id);
      if (!challenge) {
        resolutionCodes.delete(resolution.resolution_id);
        resolution.status = "failed";
        resolution.error = "Associated challenge not found.";
        resolution.updated_at = new Date().toISOString();
        challengeEmailResolutions.set(resolution.resolution_id, resolution);
        schedulePersist();
        return sendError(reply, 400, "CHALLENGE_NOT_FOUND", resolution.error);
      }

      // Consume the code immediately — deleted regardless of outcome
      const { code } = codeEntry;
      resolutionCodes.delete(resolution.resolution_id);

      const fillResult = await executeChallengeInjectionViaCDP(challenge, code);

      if (fillResult.success) {
        resolution.status = "injected";
        resolution.injected_at = new Date().toISOString();
        resolution.error = undefined;
      } else {
        resolution.status = "failed";
        resolution.error = fillResult.error;
      }
      resolution.updated_at = new Date().toISOString();
      challengeEmailResolutions.set(resolution.resolution_id, resolution);
      schedulePersist();

      return reply.send({
        ok: fillResult.success,
        data: {
          resolution_id: resolution.resolution_id,
          status: resolution.status,
          injected_at: resolution.injected_at,
          raw_code_revealed_to_agent: false as const,
          email_body_revealed_to_agent: false as const,
          ...(resolution.error ? { error: resolution.error } : {}),
          next_action: resolutionNextAction(resolution.status),
        },
      });
    },
  );

  // POST /api/agent/v1/security-challenges/:challengeId/inject — CDP code injection
  server.post<{ Params: { challengeId: string } }>(
    "/api/agent/v1/security-challenges/:challengeId/inject",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const challenge = securityChallenges.get(req.params.challengeId);
      if (!challenge) return sendError(reply, 404, "CHALLENGE_NOT_FOUND", "Security challenge not found.");
      if (challenge.user_id !== MOCK_USER_ID || challenge.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "Access denied to this challenge.");
      }
      if (challenge.status !== "code_submitted") {
        return sendError(
          reply, 400, "INVALID_STATUS",
          `Cannot inject code for challenge with status '${challenge.status}'. The user must submit the code in the Antigen UI first.`,
        );
      }

      const entry = challengeCodes.get(challenge.challenge_id);
      if (!entry) {
        return sendError(
          reply, 400, "CODE_NOT_AVAILABLE",
          "No code found for this challenge. It may have been cleared after submission. Ask the user to submit again in the Antigen UI.",
        );
      }
      if (new Date(entry.expires_at) < new Date()) {
        challengeCodes.delete(challenge.challenge_id);
        challenge.status = "expired";
        securityChallenges.set(challenge.challenge_id, challenge);
        schedulePersist();
        return sendError(reply, 400, "CODE_EXPIRED", "The submitted code has expired. Ask the user to submit again.");
      }

      // Consume the code immediately — deleted regardless of outcome
      const { code } = entry;
      challengeCodes.delete(challenge.challenge_id);

      const fillResult = await executeChallengeInjectionViaCDP(challenge, code);

      if (fillResult.success) {
        challenge.status = "code_injected";
        challenge.injected_at = new Date().toISOString();
        challenge.error = undefined;
      } else {
        challenge.status = "failed";
        challenge.error = fillResult.error;
      }
      securityChallenges.set(challenge.challenge_id, challenge);
      schedulePersist();

      return reply.send({
        ok: fillResult.success,
        data: {
          challenge_id: challenge.challenge_id,
          status: challenge.status,
          raw_code_revealed_to_agent: false as const,
          ...(challenge.error ? { error: challenge.error } : {}),
          next_action: challenge.status === "code_injected"
            ? "Code injected into the browser field. Click 'Verify', 'Continue', or 'Submit' in your Playwright browser to complete the challenge. Antigen does not click for you."
            : `Injection failed: ${challenge.error ?? "unknown error"}. Ensure the browser is still open on the challenge page. Ask the user to submit the code again in the Antigen UI.`,
        },
      });
    },
  );

  // ─── Workspaces v0 ────────────────────────────────────────────────────────────

  // "file" kind is owner-upload-only via POST /artifacts/upload — agents cannot create file artifacts
  const VALID_ARTIFACT_KINDS = new Set<WorkspaceArtifactKind>(["text", "json", "csv", "markdown"]);
  const ARTIFACT_MAX_BYTES = 50 * 1024; // 50KB

  /**
   * GET /api/agent/v1/workspaces/:workspaceId
   * Returns workspace metadata for participants. Never exposes owner_user_id or full participant list.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId",
    async (req: FastifyRequest<{ Params: { workspaceId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_read");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const taskList = Array.from(workspaceTasks.values()).filter(
        (t) => t.workspace_id === workspace.workspace_id,
      );
      const artifactList = Array.from(workspaceArtifacts.values()).filter(
        (a) => a.workspace_id === workspace.workspace_id,
      );

      return reply.send({
        ok: true,
        data: {
          workspace_id: workspace.workspace_id,
          name: workspace.name,
          description: workspace.description,
          collar_id: workspace.collar_id,
          status: workspace.status,
          participant_count: workspace.participant_delegation_ids.length,
          task_counts: {
            open: taskList.filter((t) => t.status === "open").length,
            in_progress: taskList.filter((t) => t.status === "in_progress").length,
            completed: taskList.filter((t) => t.status === "completed").length,
          },
          artifact_count: artifactList.length,
          created_at: workspace.created_at,
        },
      });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/manifest
   * Orientation manifest for agents joining a workspace. Returns identity, effective
   * permissions, task summary, artifact metadata, workflow rules, and next actions.
   * No audit event emitted — read-only orientation call.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/manifest",
    async (req: FastifyRequest<{ Params: { workspaceId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;

      const workspaceCollar = collars.get(workspace.collar_id);
      if (!workspaceCollar || workspaceCollar.status !== "active") {
        return sendError(reply, 403, "WORKSPACE_COLLAR_INACTIVE", "The workspace collar is inactive or missing.");
      }

      const delegationCollar = delegation.default_collar_id ? collars.get(delegation.default_collar_id) : undefined;
      if (!delegationCollar || delegationCollar.status !== "active") {
        return sendError(reply, 403, "WORKSPACE_COLLAR_INACTIVE", "Your delegation collar is inactive or missing.");
      }

      const permResult = checkWorkspacePermission(workspace, workspaceCollar, delegation, "workspace_read");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const perms = buildEffectivePermissionsMap(workspaceCollar, delegationCollar);

      // Build task summary — classify open tasks by eligibility
      const allTasks = Array.from(workspaceTasks.values()).filter(
        (t) => t.workspace_id === workspace.workspace_id,
      );

      // assigned_delegation_id dual role:
      //   assignment_type="delegation" + status="open"  → reserved for that delegation (pre-assigned)
      //   status="in_progress" (any type)               → the actual claimant
      const assignedToMe: typeof allTasks = [];
      const eligible: typeof allTasks = [];
      const openUnassigned: typeof allTasks = [];
      const notEligible: { task_id: string; title: string; status: string; reason: string }[] = [];

      for (const t of allTasks) {
        if (t.status !== "open") continue;
        const type = t.assignment_type ?? "open";
        if (type === "delegation") {
          if (t.assigned_delegation_id === delegation.id) {
            assignedToMe.push(t);
          } else {
            notEligible.push({ task_id: t.task_id, title: t.title, status: t.status, reason: "assigned_to_other_delegation" });
          }
        } else if (type === "collar") {
          // Omit tasks whose required collar is inactive/missing from all buckets
          const rc = t.required_collar_id ? collars.get(t.required_collar_id) : undefined;
          if (!rc || rc.status !== "active") {
            notEligible.push({ task_id: t.task_id, title: t.title, status: t.status, reason: "required_collar_inactive_or_missing" });
          } else if (delegation.default_collar_id === t.required_collar_id) {
            eligible.push(t);
          } else {
            notEligible.push({ task_id: t.task_id, title: t.title, status: t.status, reason: `requires_collar:${t.required_collar_id}` });
          }
        } else {
          // "open" or absent — any participant may claim
          openUnassigned.push(t);
        }
      }

      const mineTasks = allTasks.filter(
        (t) => t.assigned_delegation_id === delegation.id && t.status === "in_progress",
      );
      const recentlyCompleted = allTasks
        .filter((t) => t.status === "completed")
        .sort((a, b) => (b.completed_at ?? "0").localeCompare(a.completed_at ?? "0"))
        .slice(0, 3);

      // Build artifact metadata list (no content)
      const allArtifacts = Array.from(workspaceArtifacts.values()).filter(
        (a) => a.workspace_id === workspace.workspace_id,
      );

      // Build recommended_work_queue — per-task enriched entries sorted by priority/readiness
      const artifactNameSet = buildWorkspaceArtifactNames(workspace.workspace_id);
      const enrichedEntries = allTasks.map((t) =>
        enrichTaskForManifest(t, delegation.id, delegation.default_collar_id ?? "", allTasks, artifactNameSet),
      );
      const recommendedWorkQueue = buildWorkQueue(enrichedEntries, allTasks);

      // Compute next_actions — priority: assigned_to_me > eligible > open > complete > artifact > read
      const nextActions: string[] = [];
      const wsPath = `/api/agent/v1/workspaces/${workspace.workspace_id}`;
      const canClaim = perms.workspace_task_claim === "allow";

      if (canClaim && assignedToMe.length > 0 && mineTasks.length === 0) {
        nextActions.push(`Claim your assigned task: PATCH ${wsPath}/tasks/{taskId} {"action":"claim"}`);
      }
      if (canClaim && eligible.length > 0 && mineTasks.length === 0 && assignedToMe.length === 0) {
        nextActions.push(`Claim an eligible task (your collar qualifies): PATCH ${wsPath}/tasks/{taskId} {"action":"claim"}`);
      }
      if (canClaim && openUnassigned.length > 0 && mineTasks.length === 0 && assignedToMe.length === 0 && eligible.length === 0) {
        nextActions.push(`Claim an open task: PATCH ${wsPath}/tasks/{taskId} {"action":"claim"}`);
      }
      if (mineTasks.length > 0) {
        nextActions.push(`Complete your in-progress task when done: PATCH ${wsPath}/tasks/{taskId} {"action":"complete"}`);
      }
      if (mineTasks.length > 0 && perms.workspace_artifact_create === "allow") {
        nextActions.push(`Create an artifact for your task: POST ${wsPath}/artifacts`);
      }
      if (allArtifacts.length > 0 && perms.workspace_artifact_read === "allow") {
        const firstId = allArtifacts[0].artifact_id;
        nextActions.push(`Read artifact content by ID: GET ${wsPath}/artifacts/${firstId}`);
      }
      if (nextActions.length === 0) {
        const allOpen = assignedToMe.length + eligible.length + openUnassigned.length;
        if (allOpen === 0 && mineTasks.length === 0) {
          nextActions.push("All tasks are done or claimed. Check the artifact list for results from other agents.");
        } else {
          nextActions.push("No actions available. Check your effective_permissions or contact the workspace owner.");
        }
      }

      // Build operations catalog
      const wsId = workspace.workspace_id;
      const operations = [
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/manifest`,
          description: "This endpoint. Orientation manifest — identity, permissions, tasks, artifacts, next actions.",
          available: true,
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}`,
          description: "Workspace metadata: task counts, artifact count.",
          available: perms.workspace_read === "allow",
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/tasks`,
          description: "List open tasks and your assigned tasks. Optional ?status= filter.",
          available: perms.workspace_task_list === "allow",
        },
        {
          method: "PATCH",
          path: `/api/agent/v1/workspaces/${wsId}/tasks/{taskId}`,
          description: 'Claim: {"action":"claim"} · Complete: {"action":"complete"}',
          body_schema: { action: '"claim" | "complete"' },
          available: perms.workspace_task_claim === "allow" || perms.workspace_task_complete === "allow",
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/artifacts`,
          description: "List artifact metadata (no content). Discover outputs from other agents.",
          available: perms.workspace_artifact_list === "allow",
        },
        {
          method: "GET",
          path: `/api/agent/v1/workspaces/${wsId}/artifacts/{artifactId}`,
          description: "Read full artifact content by ID.",
          available: perms.workspace_artifact_read === "allow",
        },
        {
          method: "POST",
          path: `/api/agent/v1/workspaces/${wsId}/artifacts`,
          description: "Create artifact (text/json/csv/markdown, max 50KB). Optionally link task_id.",
          body_schema: {
            name: "string (required)",
            kind: '"text" | "json" | "csv" | "markdown" (required)',
            content: "string (required, max 50KB)",
            task_id: "string (optional)",
          },
          available: perms.workspace_artifact_create === "allow",
        },
      ];

      const workflowRules = [
        "Claim a task before working on it — only one delegation may hold a task at a time.",
        'Claim: PATCH .../tasks/{taskId} {"action":"claim"}. Idempotent if already yours.',
        'Complete: PATCH .../tasks/{taskId} {"action":"complete"}. Only the assigned delegation can complete.',
        "Artifacts are shared with all participants. Create them to hand off results to other agents.",
        "POST artifact response omits content — use GET .../artifacts/{artifactId} to read.",
        "Both the workspace collar and your delegation collar must allow an action (stricter wins).",
        "Tasks have a readiness status — only ready tasks can be claimed; blocked tasks must wait for dependencies or artifacts.",
        "task_mode='plan_first' signals you should draft an approach before executing (advisory only).",
        "If a claim returns 409 TASK_ALREADY_CLAIMED, another agent took it — refresh the manifest and pick the next ready eligible task.",
        "If a claim returns 409 TASK_NOT_READY, the task's dependencies are not yet met — pick another ready task or re-poll the manifest until readiness changes.",
      ];

      return reply.send({
        ok: true,
        data: {
          workspace: {
            workspace_id: workspace.workspace_id,
            name: workspace.name,
            description: workspace.description,
            collar_id: workspace.collar_id,
            status: workspace.status,
            participant_count: workspace.participant_delegation_ids.length,
            task_counts: {
              open: allTasks.filter((t) => t.status === "open").length,
              in_progress: allTasks.filter((t) => t.status === "in_progress").length,
              completed: allTasks.filter((t) => t.status === "completed").length,
            },
            artifact_count: allArtifacts.length,
            created_at: workspace.created_at,
          },
          identity: {
            delegation_id: delegation.id,
            agent_name: delegation.agent_name,
          },
          effective_permissions: perms,
          recommended_work_queue: recommendedWorkQueue,
          task_summary: {
            assigned_to_me: assignedToMe.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              assignment_type: t.assignment_type,
              created_at: t.created_at,
              updated_at: t.updated_at,
            })),
            eligible: eligible.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              assignment_type: t.assignment_type,
              required_collar_id: t.required_collar_id,
              created_at: t.created_at,
              updated_at: t.updated_at,
            })),
            open: openUnassigned.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              created_at: t.created_at,
              updated_at: t.updated_at,
            })),
            mine: mineTasks.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              description: t.description,
              status: t.status,
              created_at: t.created_at,
              updated_at: t.updated_at,
              completed_at: t.completed_at,
            })),
            recently_completed: recentlyCompleted.map((t) => ({
              task_id: t.task_id,
              title: t.title,
              completed_at: t.completed_at,
              assigned_delegation_id: t.assigned_delegation_id,
            })),
            not_eligible: notEligible,
          },
          artifacts: allArtifacts.map((a) => ({
            artifact_id: a.artifact_id,
            name: a.name,
            kind: a.kind,
            size_bytes: a.kind === "file" ? a.size_bytes : Buffer.byteLength(a.content, "utf8"),
            ...(a.kind === "file" ? { mime_type: a.mime_type } : {}),
            task_id: a.task_id,
            created_by_delegation_id: a.created_by_delegation_id,
            created_at: a.created_at,
          })),
          workflow_rules: workflowRules,
          operations,
          next_actions: nextActions,
        },
      });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/tasks
   * Lists open tasks and tasks assigned to the calling delegation.
   * Optional ?status= filter (open | in_progress | completed | cancelled).
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/tasks",
    async (req: FastifyRequest<{ Params: { workspaceId: string }; Querystring: { status?: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_task_list");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      let tasks = Array.from(workspaceTasks.values()).filter(
        (t) => t.workspace_id === workspace.workspace_id,
      );

      const statusFilter = req.query.status;
      if (statusFilter) {
        tasks = tasks.filter((t) => t.status === statusFilter);
      } else {
        // Default: open tasks + tasks assigned to this delegation
        tasks = tasks.filter(
          (t) => t.status === "open" || t.assigned_delegation_id === delegation.id,
        );
      }

      return reply.send({
        ok: true,
        data: tasks.map((t) => ({
          task_id: t.task_id,
          title: t.title,
          description: t.description,
          status: t.status,
          is_mine: t.assigned_delegation_id === delegation.id,
          created_at: t.created_at,
          updated_at: t.updated_at,
          completed_at: t.completed_at,
        })),
      });
    },
  );

  /**
   * PATCH /api/agent/v1/workspaces/:workspaceId/tasks/:taskId
   * Body: { action: "claim" | "complete" }
   * claim    — enforce eligibility, then set status=in_progress (idempotent if already mine)
   *            assigned_delegation_id on an open/delegation task = reserved claimant;
   *            once in_progress it becomes the actual claimant (same field, different semantic).
   * complete — set status=completed (only if assigned to this delegation)
   */
  server.patch(
    "/api/agent/v1/workspaces/:workspaceId/tasks/:taskId",
    async (req: FastifyRequest<{ Params: { workspaceId: string; taskId: string }; Body: { action?: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;

      const { action } = req.body ?? {};

      // Validate action before permission check so unknown actions always return INVALID_ACTION
      if (action !== "claim" && action !== "complete") {
        return sendError(reply, 400, "INVALID_ACTION", "action must be \"claim\" or \"complete\".");
      }

      const wsAction = action === "complete" ? "workspace_task_complete" : "workspace_task_claim";
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, wsAction);
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const task = workspaceTasks.get(req.params.taskId);
      if (!task || task.workspace_id !== workspace.workspace_id) {
        return sendError(reply, 404, "TASK_NOT_FOUND", "Task not found in this workspace.");
      }

      if (action === "claim") {
        // Idempotent: already claimed by this delegation
        if (task.status === "in_progress" && task.assigned_delegation_id === delegation.id) {
          return reply.send({ ok: true, data: { ...task, is_mine: true } });
        }
        // Already claimed by someone else
        if (task.status === "in_progress") {
          return reply.status(409).send({
            ok: false,
            error: { code: "TASK_ALREADY_CLAIMED", message: "Task is already claimed by another agent.", recovery_hint: "refresh_manifest" },
          });
        }
        if (task.status !== "open") {
          return reply.status(409).send({
            ok: false,
            error: { code: "TASK_ALREADY_CLAIMED", message: "Task is not open.", recovery_hint: "refresh_manifest" },
          });
        }
        // Eligibility check: assignment_type governs who may claim an open task
        const eligibility = checkTaskEligibility(task, delegation);
        if (!eligibility.ok) {
          return sendError(reply, 403, eligibility.code, eligibility.message);
        }
        // Readiness check: blocked tasks (unmet deps or missing artifacts) cannot be claimed
        const claimArtifactNames = buildWorkspaceArtifactNames(workspace.workspace_id);
        const claimAllTasks = Array.from(workspaceTasks.values()).filter(
          (t) => t.workspace_id === workspace.workspace_id,
        );
        const { readiness: claimReadiness, blockers: claimBlockers } = computeTaskReadiness(
          task,
          delegation.id,
          claimAllTasks,
          claimArtifactNames,
        );
        if (claimReadiness === "blocked") {
          return reply.status(409).send({
            ok: false,
            error: { code: "TASK_NOT_READY", message: "Task cannot be claimed until its dependencies are met.", recovery_hint: "refresh_manifest" },
            blocker_reasons: claimBlockers,
          });
        }
        const now = new Date().toISOString();
        task.status = "in_progress";
        task.assigned_delegation_id = delegation.id;
        task.updated_at = now;
        workspaceTasks.set(task.task_id, task);
        emitWorkspaceAudit({ workspace_id: workspace.workspace_id, task_id: task.task_id, delegation_id: delegation.id, event_type: "task_claimed" });
        return reply.send({ ok: true, data: { ...task, is_mine: true } });
      }

      if (task.assigned_delegation_id !== delegation.id) {
        return sendError(reply, 403, "TASK_NOT_ASSIGNED", "You can only complete tasks assigned to your delegation.");
      }
      if (task.status !== "in_progress") {
        return sendError(reply, 409, "TASK_NOT_IN_PROGRESS", "Task must be in_progress to complete.");
      }
      const now = new Date().toISOString();
      task.status = "completed";
      task.completed_at = now;
      task.updated_at = now;
      workspaceTasks.set(task.task_id, task);
      emitWorkspaceAudit({ workspace_id: workspace.workspace_id, task_id: task.task_id, delegation_id: delegation.id, event_type: "task_completed" });
      return reply.send({ ok: true, data: { ...task, is_mine: true } });
    },
  );

  /**
   * POST /api/agent/v1/workspaces/:workspaceId/artifacts
   * Creates a text artifact. Content max 50KB. Never returns content in the response.
   */
  server.post(
    "/api/agent/v1/workspaces/:workspaceId/artifacts",
    async (req: FastifyRequest<{ Params: { workspaceId: string }; Body: { name?: string; kind?: string; content?: string; task_id?: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_artifact_create");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const { name, kind, content, task_id } = req.body ?? {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return sendError(reply, 400, "MISSING_NAME", "name is required.");
      }
      if (!kind || !VALID_ARTIFACT_KINDS.has(kind as WorkspaceArtifactKind)) {
        return sendError(reply, 400, "INVALID_ARTIFACT_KIND", `kind must be one of: ${[...VALID_ARTIFACT_KINDS].join(", ")}.`);
      }
      if (typeof content !== "string") {
        return sendError(reply, 400, "MISSING_CONTENT", "content is required and must be a string.");
      }
      if (Buffer.byteLength(content, "utf8") > ARTIFACT_MAX_BYTES) {
        return sendError(reply, 400, "ARTIFACT_TOO_LARGE", "Artifact content exceeds 50KB limit.");
      }
      if (task_id !== undefined) {
        const linkedTask = workspaceTasks.get(task_id);
        if (!linkedTask || linkedTask.workspace_id !== workspace.workspace_id) {
          return sendError(reply, 400, "INVALID_TASK_REFERENCE", "task_id does not reference a task in this workspace.");
        }
      }

      const now = new Date().toISOString();
      const artifact = {
        artifact_id: newId("artifact"),
        workspace_id: workspace.workspace_id,
        name: name.trim(),
        kind: kind as "text" | "json" | "csv" | "markdown",
        content,
        ...(task_id !== undefined ? { task_id } : {}),
        created_by_delegation_id: delegation.id,
        created_at: now,
      };
      workspaceArtifacts.set(artifact.artifact_id, artifact);
      emitWorkspaceAudit({ workspace_id: workspace.workspace_id, artifact_id: artifact.artifact_id, task_id, delegation_id: delegation.id, event_type: "artifact_created" });

      // Never return content in POST response
      return reply.status(201).send({
        ok: true,
        data: {
          artifact_id: artifact.artifact_id,
          workspace_id: artifact.workspace_id,
          name: artifact.name,
          kind: artifact.kind,
          size_bytes: Buffer.byteLength(content, "utf8"),
          ...(task_id !== undefined ? { task_id } : {}),
          created_by_delegation_id: artifact.created_by_delegation_id,
          created_at: artifact.created_at,
        },
      });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/artifacts
   * Lists artifact metadata. Never includes content.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/artifacts",
    async (req: FastifyRequest<{ Params: { workspaceId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_artifact_list");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const artifacts = Array.from(workspaceArtifacts.values())
        .filter((a) => a.workspace_id === workspace.workspace_id)
        .map((a) => {
          const base = {
            artifact_id: a.artifact_id,
            workspace_id: a.workspace_id,
            name: a.name,
            kind: a.kind,
            task_id: a.task_id,
            created_by_delegation_id: a.created_by_delegation_id,
            created_at: a.created_at,
          };
          if (a.kind === "file") {
            return { ...base, size_bytes: a.size_bytes, mime_type: a.mime_type };
          }
          return { ...base, size_bytes: Buffer.byteLength(a.content, "utf8") };
        });

      return reply.send({ ok: true, data: artifacts });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/artifacts/:artifactId
   * Returns artifact including content. Participant access only.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/artifacts/:artifactId",
    async (req: FastifyRequest<{ Params: { workspaceId: string; artifactId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_artifact_read");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const artifact = workspaceArtifacts.get(req.params.artifactId);
      if (!artifact || artifact.workspace_id !== workspace.workspace_id) {
        return sendError(reply, 404, "ARTIFACT_NOT_FOUND", "Artifact not found in this workspace.");
      }

      if (artifact.kind === "file") {
        return reply.send({
          ok: true,
          data: {
            artifact_id: artifact.artifact_id,
            workspace_id: artifact.workspace_id,
            name: artifact.name,
            kind: artifact.kind,
            mime_type: artifact.mime_type,
            size_bytes: artifact.size_bytes,
            task_id: artifact.task_id,
            created_by_delegation_id: artifact.created_by_delegation_id,
            created_at: artifact.created_at,
            note: "File artifact — binary content not available inline.",
          },
        });
      }

      return reply.send({
        ok: true,
        data: {
          artifact_id: artifact.artifact_id,
          workspace_id: artifact.workspace_id,
          name: artifact.name,
          kind: artifact.kind,
          content: artifact.content,
          size_bytes: Buffer.byteLength(artifact.content, "utf8"),
          task_id: artifact.task_id,
          created_by_delegation_id: artifact.created_by_delegation_id,
          created_at: artifact.created_at,
        },
      });
    },
  );

  /**
   * GET /api/agent/v1/workspaces/:workspaceId/artifacts/:artifactId/download
   * Download a file artifact. Gated by workspace_artifact_read collar permission.
   * local_path is never returned to agents.
   */
  server.get(
    "/api/agent/v1/workspaces/:workspaceId/artifacts/:artifactId/download",
    async (req: FastifyRequest<{ Params: { workspaceId: string; artifactId: string } }>, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const result = requireWorkspaceAccess(req.params.workspaceId, delegation);
      if (!result.ok) {
        return sendError(reply, result.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, result.code, result.message);
      }
      const { workspace } = result;
      const permResult = checkWorkspacePermission(workspace, collars.get(workspace.collar_id)!, delegation, "workspace_artifact_read");
      if (!permResult.ok) {
        return sendError(reply, 403, permResult.code, permResult.message);
      }

      const artifact = workspaceArtifacts.get(req.params.artifactId);
      if (!artifact || artifact.workspace_id !== workspace.workspace_id) {
        return sendError(reply, 404, "ARTIFACT_NOT_FOUND", "Artifact not found in this workspace.");
      }
      if (artifact.kind !== "file") {
        return sendError(reply, 400, "NOT_A_FILE", "This artifact is not a file artifact.");
      }

      if (!existsSync(artifact.local_path)) {
        return sendError(reply, 404, "FILE_NOT_FOUND", "File not found on disk.");
      }
      reply.header("Content-Type", artifact.mime_type);
      reply.header("Content-Disposition", `attachment; filename="${artifact.name}"`);
      reply.header("Content-Length", String(artifact.size_bytes));
      return reply.send(createReadStream(artifact.local_path));
    },
  );

  /**
   * POST /api/agent/v1/runtime/browser-endpoint
   *
   * Initialize or retrieve the Aegis local browser runtime for this delegation.
   * Agent browser tooling should attach to the returned cdp_url for ordinary browsing.
   * Aegis handles only sensitive handoffs (credential injection, payment fields, approvals).
   * Users should not manually manage this session.
   *
   * Reuses an existing ready session for the delegation if one exists.
   * Provisions a new ephemeral session otherwise, using the same port-conflict logic
   * as POST /api/task-browser-sessions (Cases A–D).
   */
  server.post("/api/agent/v1/runtime/browser-endpoint", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const body = (req.body ?? {}) as { mode?: string; persistent_profile?: boolean };
    // Tri-state requested mode: explicit "visible"/"headless", or undefined when the
    // caller expresses no preference. An absent mode (e.g. the adapter's reinit posts
    // {}) must NEVER flip an existing visible session back to headless — so undefined
    // means "reuse whatever exists", never "headless requested".
    const requested_mode: "visible" | "headless" | undefined =
      body.mode === "visible" ? "visible" : body.mode === "headless" ? "headless" : undefined;
    const debug_visible = requested_mode === "visible";
    const persistent_profile = body.persistent_profile === true;

    // Return an existing ready session for this delegation rather than provisioning a
    // duplicate — UNLESS the caller explicitly requested a visibility mode that differs
    // from the existing runtime's effective mode.
    let existing = findReadySessionByDelegationId(delegation.id, MOCK_USER_ID);
    if (existing && requested_mode !== undefined && requested_mode !== existing.mode) {
      // Mode mismatch on an ephemeral local runtime: relaunch rather than silently
      // honoring the wrong mode. Close fully (frees the port) before re-provisioning;
      // createTaskBrowserSession then relaunches on the freed port (same cdp_url keeps
      // any attached agent browser tooling valid). Metadata-only log — no paths/PIDs.
      console.log(
        `[RuntimeEndpoint] mode_change relaunch delegation_id=${delegation.id}` +
          ` old_runtime_id=${existing.browser_session_id} existing_mode=${existing.mode}` +
          ` requested_mode=${requested_mode}`,
      );
      recordBrowserTraceEvent(existing.browser_session_id, {
        event_type: "browser_endpoint_created",
        browser_runtime_id: existing.browser_session_id,
        tool: "get_runtime_browser_endpoint",
        result_code: "relaunched_mode_change",
      });
      try {
        await closeTaskBrowserSession(existing.browser_session_id, MOCK_USER_ID);
      } catch {
        // Best-effort close — proceed to relaunch regardless. createTaskBrowserSession
        // performs its own port sweep/recycle before binding.
      }
      existing = undefined;
    }
    if (existing) {
      // Metadata-only runtime-binding log (no paths, PIDs, cookies, storage, or secrets).
      console.log(
        `[RuntimeEndpoint] reused browser_runtime_id=${existing.browser_session_id}` +
          ` delegation_id=${delegation.id} cdp_url=${existing.cdp_url}` +
          ` runtime_mode=${existing.runtime_mode ?? "local_runtime_endpoint"}` +
          ` reused_existing=true existing_mode=${existing.mode}` +
          ` requested_mode=${requested_mode ?? "(none)"}`,
      );
      recordBrowserTraceEvent(existing.browser_session_id, {
        event_type: "browser_endpoint_created",
        browser_runtime_id: existing.browser_session_id,
        tool: "get_runtime_browser_endpoint",
        result_code: "reused_existing",
      });
      return reply.send({
        ok: true,
        data: {
          browser_runtime_id: existing.browser_session_id,
          browser_session_id: existing.browser_session_id,
          cdp_url: existing.cdp_url,
          status: existing.status,
          runtime_mode: existing.runtime_mode ?? "local_runtime_endpoint",
          ...(requested_mode !== undefined ? { requested_mode } : {}),
          effective_mode: existing.mode,
          session_ready: existing.status === "ready",
          ephemeral: true as const,
          reused_existing: true,
          port_auto_selected: false,
          expires_at: existing.expires_at,
          persistent_profile_enabled: existing.persistent_profile_enabled ?? false,
          ...(existing.profile_state !== undefined ? { profile_state: existing.profile_state } : {}),
          protection: {
            raw_cookies_revealed_to_agent: false as const,
            raw_storage_revealed_to_agent: false as const,
          },
        },
      });
    }

    let result: CreateTaskBrowserResult;
    try {
      result = await createTaskBrowserSession({
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        debug_visible,
        runtime_mode: "local_runtime_endpoint",
        persistent_profile,
      });
    } catch (err: unknown) {
      const e = err as Error & { code?: string; occupied_port_range?: string; tracked_occupied_sessions?: unknown[] };
      if (e.code === "NO_PORTS_AVAILABLE") {
        return reply.status(503).send({
          ok: false,
          error: {
            code: "NO_PORTS_AVAILABLE",
            message: e.message,
            ...(e.occupied_port_range ? { occupied_port_range: e.occupied_port_range } : {}),
            tracked_occupied_sessions: e.tracked_occupied_sessions ?? [],
          },
        });
      }
      if (e.code === "CHROME_NOT_FOUND") return sendError(reply, 503, "CHROME_NOT_FOUND", e.message ?? "Chrome not found.");
      return sendError(reply, 500, "BROWSER_LAUNCH_FAILED", e.message ?? "Failed to provision browser runtime.");
    }

    const session = result.session;
    // Metadata-only runtime-binding log (no paths, PIDs, cookies, storage, or secrets).
    console.log(
      `[RuntimeEndpoint] created browser_runtime_id=${session.browser_session_id}` +
        ` delegation_id=${delegation.id} cdp_url=${session.cdp_url}` +
        ` runtime_mode=${session.runtime_mode ?? "local_runtime_endpoint"}` +
        ` reused_existing=false requested_visible=${debug_visible} session_mode=${session.mode}` +
        ` port_auto_selected=${result.port_auto_selected === true}`,
    );
    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "browser_endpoint_created",
      browser_runtime_id: session.browser_session_id,
      tool: "get_runtime_browser_endpoint",
      result_code: "created",
    });
    return reply.status(201).send({
      ok: true,
      data: {
        browser_runtime_id: session.browser_session_id,
        browser_session_id: session.browser_session_id,
        cdp_url: session.cdp_url,
        status: session.status,
        runtime_mode: session.runtime_mode ?? "local_runtime_endpoint",
        ...(requested_mode !== undefined ? { requested_mode } : {}),
        effective_mode: session.mode,
        session_ready: session.status === "ready",
        ephemeral: true as const,
        reused_existing: false,
        port_auto_selected: result.port_auto_selected === true,
        expires_at: session.expires_at,
        persistent_profile_enabled: session.persistent_profile_enabled ?? false,
        ...(session.profile_state !== undefined ? { profile_state: session.profile_state } : {}),
        protection: {
          raw_cookies_revealed_to_agent: false as const,
          raw_storage_revealed_to_agent: false as const,
        },
      },
    });
  });

  // ─── Realistic Browser Actions — visible browsing path ───────────────────────
  // CDP-backed realistic pointer movement and per-character typing for ordinary
  // agent browsing (browser_click, browser_fill). Non-credential path — no KMS,
  // no secret resolution, no credential authorization. Caller falls back to
  // @playwright/mcp on any non-2xx response.

  // Resolve whether the dev pointer overlay / nav-mediation banner should be injected.
  // EXPLICIT-OPT-IN only: these write __aegis_pointer_debug_* nodes / a banner into the
  // live page, so they must NOT appear on normal headed QA runs (Follow-up 1, runtime DOM
  // footprint audit). Activation requires ANTIGEN_POINTER_DEBUG_OVERLAY=true regardless of
  // the session's headless/visible mode. The param is kept for call-site compatibility but
  // is no longer read.
  const resolveOverlayEnabled = (_s?: { mode: "headless" | "visible" }): boolean =>
    process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true";

  // Clearly low-risk click intents that may receive the single safe verify-retry.
  // Final / sensitive intents are blocked pre-dispatch by the action gate and
  // never reach verification, but this allowlist is an explicit second guard so a
  // retry can never fire for final_commit / payment / publish / account-security.
  const LOW_RISK_CLICK_INTENTS = new Set<string>(["navigation", "cart_mutation", "checkout_transition"]);

  server.post("/api/agent/v1/runtime/browser-click", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;
    const tToolStart = Date.now();

    const body = (req.body ?? {}) as { browser_runtime_id?: unknown; element_description?: unknown; selector_hint?: unknown; ref?: unknown };

    if (!body.browser_runtime_id || typeof body.browser_runtime_id !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "browser_runtime_id is required.");
    }

    const runtimeResolution = resolveReadyRuntimeSession(body.browser_runtime_id, delegation.id, MOCK_USER_ID);
    if (runtimeResolution.kind === "forbidden") return sendError(reply, 403, "FORBIDDEN", "This browser session does not belong to your delegation.");
    if (runtimeResolution.kind === "none") {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_click",
        error_code: "SESSION_NOT_FOUND",
      });
      return sendError(reply, 404, "SESSION_NOT_FOUND", "Browser runtime session not found.");
    }
    if (runtimeResolution.kind === "starting") return sendError(reply, 400, "SESSION_NOT_READY", `Session status is '${runtimeResolution.session.status}'; must be 'ready'.`);
    if (runtimeResolution.kind === "rebound") {
      // Fail closed: the runtime changed since this ref was captured. Never resolve a
      // stale ag_* ref against a different runtime. RUNTIME_SESSION_CHANGED is agent-
      // recoverable but must NOT be auto-retried with the same ref — reinitialize the
      // runtime if needed, take a fresh antigen_snapshot, then act on the new refs.
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_click",
        error_code: "RUNTIME_SESSION_CHANGED",
      });
      return reply.status(409).send({ ok: false, error: { code: "RUNTIME_SESSION_CHANGED", message: "The browser runtime changed since this ref was captured. Reinitialize the runtime if needed, take a fresh antigen_snapshot, then act on the new refs — stale refs are not carried across runtime changes." } });
    }
    const session = runtimeResolution.session; // ready
    if (rejectIfHumanVerificationActive(session, reply, "browser_click")) return;

    // Antigen exact-ref path (Phase 4A): when ref is an Antigen ref (ag_<n>),
    // resolve the exact element box from the latest active snapshot for this
    // session+user and click it via the realistic pointer runtime. No scoring,
    // no fuzzy matching, no text rediscovery — exact ref only. Non-ag refs fall
    // through to the unchanged description path below.
    const refRaw = typeof body.ref === "string" ? body.ref : undefined;
    if (refRaw && refRaw.startsWith("ag_")) {
      if (!/^ag_\d+$/.test(refRaw)) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_click", browser_runtime_id: session.browser_session_id,
          tool: "browser_click", click_path: "ag_ref", ref: refRaw,
          pointer_dispatch: false, error_code: "ANTIGEN_REF_INVALID",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_INVALID", message: `Malformed Antigen ref '${refRaw}'; expected ag_<number>.` } });
      }

      const resolution = resolveAntigenRefForSession(session.browser_session_id, MOCK_USER_ID, refRaw);
      if (resolution.status === "no_snapshot" || resolution.status === "ref_not_found") {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_click", browser_runtime_id: session.browser_session_id,
          tool: "browser_click", click_path: "ag_ref", ref: refRaw,
          pointer_dispatch: false, error_code: "ANTIGEN_REF_NOT_FOUND",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
      }
      // TTL-expiry recovery (gated by the SAME ANTIGEN_LOGICAL_REF_RECOVERY flag).
      // Elapsed time never authorizes the action. Flag off OR element already
      // GC'd ⇒ keep the strict hard-fail (byte-for-byte current behavior). Flag
      // on AND the element survives ⇒ mark ttlExpired and force the ref through
      // the SAME safety stack below (action gate, live-URL guard, Phase 4B,
      // logical recovery); only a fully-validated dispatch refreshes the lease.
      let ttlExpired = false;
      if (resolution.status === "expired") {
        if (!isLogicalRefRecoveryEnabled() || !resolution.element) {
          recordBrowserTraceEvent(session.browser_session_id, {
            event_type: "browser_click", browser_runtime_id: session.browser_session_id,
            tool: "browser_click", click_path: "ag_ref", ref: refRaw,
            pointer_dispatch: false, error_code: "ANTIGEN_REF_EXPIRED",
          });
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_EXPIRED", message: "The Antigen snapshot has expired. Take a fresh antigen_snapshot." } });
        }
        ttlExpired = true;
      }

      const el = resolution.element;
      const snapshotUrl = resolution.snapshot_url ?? null;
      const snapshotId = resolution.snapshot_id;
      if (!el) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_click", browser_runtime_id: session.browser_session_id,
          tool: "browser_click", click_path: "ag_ref", ref: refRaw,
          pointer_dispatch: false, error_code: "ANTIGEN_REF_NOT_FOUND",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
      }
      if (!el.enabled || !el.clickable || el.box.width <= 0 || el.box.height <= 0) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_click", browser_runtime_id: session.browser_session_id,
          tool: "browser_click", click_path: "ag_ref", ref: refRaw,
          element_name: el.name, context: el.context, href_path: el.href_path ?? undefined,
          pointer_dispatch: false, error_code: "ANTIGEN_REF_NOT_CLICKABLE",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_CLICKABLE", message: `Antigen ref '${refRaw}' is not clickable.` } });
      }

      // Phase 4B: snapshot metadata for live-element revalidation before click.
      const expected = {
        tag: el.tag,
        kind: el.kind,
        role: el.role,
        name: el.name,
        normalized_name: el.normalized_name,
        href_path: el.href_path,
      };

      // ── Capability-state action gate (runs BEFORE pointer dispatch) ──────────
      // Classifies the action intent from STRUCTURAL element metadata only and
      // refuses clear final / irreversible / identity-committing actions, routing
      // the agent to the existing handoff tool (which owns the user approval,
      // SensitiveGrant, and signed receipt). Reversible navigation / cart /
      // checkout-transition falls through to the unchanged URL/TTL/viewport/Phase
      // 4B click path below. The gate never creates an approval, never prompts the
      // user, and never touches secrets. For clicks the only outcomes are
      // allowed_without_user_prompt (fall through) or blocked_by_antigen_platform.
      const gate = evaluateActionGate(
        classifyActionIntent({
          action: "click",
          text: el.name,
          normalized_text: el.normalized_name,
          role: el.role,
          kind: el.kind,
          tag: el.tag,
          href_path: el.href_path,
          context: el.context ? { label: el.context.label, section: el.context.section } : undefined,
          url: session.current_url,
          risk_state: session.risk_state,
        }),
        session.risk_state,
      );
      // Expired ref + sensitive/final target: never dispatch from stale metadata,
      // and do NOT route an expired ref to a handoff (its classification can no
      // longer be trusted). Fail closed and require a fresh snapshot so the action
      // is re-classified. For clicks the gate only ever returns `allowed_*` or
      // `blocked_by_antigen_platform`, so anything non-allowed here is sensitive.
      if (ttlExpired && gate.disposition !== "allowed_without_user_prompt") {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_click", browser_runtime_id: session.browser_session_id,
          tool: "browser_click", click_path: "ag_ref", ref: refRaw,
          element_name: el.name, context: el.context, href_path: el.href_path ?? undefined,
          pointer_dispatch: false, error_code: "ANTIGEN_REF_EXPIRED",
          action_intent: gate.action_intent, ttl_recovery_state: "sensitive_requires_fresh_ref",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_EXPIRED", message: "This Antigen ref expired and the target is a sensitive or final action. Take a fresh antigen_snapshot so the action can be re-classified before acting.", ttl_recovery_state: "sensitive_requires_fresh_ref" } });
      }
      if (gate.disposition === "blocked_by_antigen_platform") {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_tool_disposition",
          browser_runtime_id: session.browser_session_id,
          tool: "browser_click",
          disposition: "blocked_by_antigen_platform",
          action_intent: gate.action_intent,
        });
        advanceRiskState(session.browser_session_id, gate.action_intent);
        return reply.send({
          ok: true,
          data: {
            mode: "blocked_by_antigen_platform",
            dispatched: false,
            action_intent: gate.action_intent,
            ...(gate.recommended_handoff ? { recommended_handoff: gate.recommended_handoff } : {}),
            reason: gate.reason,
          },
        });
      }
      // Allowed: record the observed intent for advisory risk-state, then dispatch.
      advanceRiskState(session.browser_session_id, gate.action_intent);

      // Post-click intent verification (ANTIGEN_CLICK_VERIFY, default-off). When
      // off, verifyOption is undefined and the runtime path is byte-identical to
      // today. editableTarget → success is FOCUS (cheap focus probe, no polling);
      // targetWasBehindBlockingModal comes from the snapshot's structural
      // background marker and drives the modal-trap guard.
      const verifyEditableTarget =
        el.typeable === true || el.kind === "input" || el.kind === "textarea" || el.kind === "select" || el.kind === "editable";
      const verifyBehindBlockingModal = el.overlay?.background === true;
      const verifyOption: ClickVerifyOption | undefined = isClickVerifyEnabled()
        ? {
            enabled: true,
            editableTarget: verifyEditableTarget,
            targetWasBehindBlockingModal: verifyBehindBlockingModal,
            cartMutationIntent: gate.action_intent === "cart_mutation",
            checkoutTransitionIntent: gate.action_intent === "checkout_transition",
            collectSurfaceDetail: isActiveSurfacesEnabled(),
          }
        : undefined;

      let refResult = await realisticClickKnownBox({
        cdpUrl: session.cdp_url,
        box: el.box,
        sessionId: session.browser_session_id,
        userId: MOCK_USER_ID,
        debugOverlay: resolveOverlayEnabled(session),
        // Live-URL guard: fail closed if the page navigated since the snapshot.
        expectedUrl: snapshotUrl,
        expected,
        verify: verifyOption,
      });

      // ── Stale-ref resolution (two flag-gated, default-off paths) ─────────────
      //
      // Surface-scoped live resolution (ANTIGEN_SURFACE_RESOLVE) — for a stale ref
      // that BELONGS to an active surface (modal/drawer/popover member): re-resolve
      // the action by SEMANTIC identity inside its live surface (overlay type +
      // accessible title, unique unoccluded match) and re-click the fresh box.
      // Surface members NEVER fall back to a page-wide match — a gone surface
      // fails closed (the panel dismissed; that is signal, not an error to bridge).
      //
      // Same-page logical-ref recovery (ANTIGEN_LOGICAL_REF_RECOVERY) — unchanged
      // page-wide path for NON-surface refs: a recoverable stale on a clearly
      // low-risk target is retried against a unique logically-equivalent element.
      //
      // Both paths only PROPOSE a fresh box; the unchanged realisticClickKnownBox
      // + Phase 4B remain the authoritative final gate. Sensitive / final /
      // non-low-risk targets never re-resolve on either path.
      let recoveryState: AntigenRecoveryState = "disabled";
      let surfaceState: AntigenSurfaceResolutionState | undefined;
      let recoveredFromStaleReason: ReturnType<typeof sanitizeStaleReason> | undefined;
      if (!refResult.success && refResult.error === "ANTIGEN_REF_STALE") {
        const surfaceMembership =
          isSurfaceResolveEnabled() && el.overlay && el.overlay.background !== true
            ? el.overlay
            : undefined;
        if (surfaceMembership) {
          // Surface path. Eligibility is default-deny: low-risk reversible intent
          // (already gate-allowed above) AND not on the sensitive-commit denylist
          // AND not a sensitive field. Ineligible surface members fail closed
          // WITHOUT page-wide recovery.
          if (
            el.value_meta?.sensitive === true ||
            !isSurfaceResolutionEligible(expected, gate.action_intent)
          ) {
            surfaceState = "skipped_ineligible";
          } else {
            const originalStale = sanitizeStaleReason(refResult.stale_reason);
            const sr = await resolveSurfaceActionBox({
              cdpUrl: session.cdp_url,
              expected,
              expectedUrl: snapshotUrl,
              surface: {
                overlay_type: surfaceMembership.overlay_type,
                modal_title: surfaceMembership.modal_title ?? null,
              },
            });
            if (sr.status === "resolved") {
              // Defense in depth: the unique live match must still classify as a
              // low-risk reversible intent. compareLiveToExpected makes drift
              // near-impossible; this guarantees it can never dispatch.
              const drift = checkSurfaceLiveIntent(sr.live, {
                url: session.current_url,
                risk_state: session.risk_state,
              });
              if (!drift.ok) {
                surfaceState = "failed_intent_drift";
              } else {
                // Re-run the trusted click path on the proposed box. Phase 4B
                // runs again and remains the final safety gate; one attempt only.
                const retry = await realisticClickKnownBox({
                  cdpUrl: session.cdp_url,
                  box: sr.box,
                  sessionId: session.browser_session_id,
                  userId: MOCK_USER_ID,
                  debugOverlay: resolveOverlayEnabled(session),
                  expectedUrl: snapshotUrl,
                  expected,
                  verify: verifyOption,
                });
                if (retry.success) {
                  refResult = retry;
                  surfaceState = "resolved";
                  recoveredFromStaleReason = originalStale;
                } else {
                  surfaceState = "failed_revalidation";
                }
              }
            } else if (sr.status === "surface_gone") {
              surfaceState = "failed_surface_gone";
            } else if (sr.status === "surface_ambiguous") {
              surfaceState = "failed_surface_ambiguous";
            } else if (sr.status === "action_ambiguous") {
              surfaceState = "failed_action_ambiguous";
            } else if (sr.status === "action_not_found") {
              surfaceState = "failed_action_not_found";
            } else if (sr.status === "page_changed") {
              surfaceState = "failed_page_changed";
            } else {
              surfaceState = "failed_cdp";
            }
          }
        } else {
          const eligibility = isLogicalRefRecoveryEnabled()
            ? classifyLogicalRecoveryEligibility(expected, "click")
            : null;
          if (!eligibility) {
            recoveryState = "disabled";
          } else if (!eligibility.eligible) {
            recoveryState = "skipped_ineligible";
          } else {
            const originalStale = sanitizeStaleReason(refResult.stale_reason);
            const recovery = await recoverAntigenRefBox({
              cdpUrl: session.cdp_url,
              expected,
              expectedUrl: snapshotUrl,
              riskClass: eligibility.risk_class,
            });
            if (recovery.status === "recovered") {
              // Re-run the trusted click path on the proposed box. Phase 4B runs
              // again and remains the final safety gate; we attempt recovery once.
              const retry = await realisticClickKnownBox({
                cdpUrl: session.cdp_url,
                box: recovery.box,
                sessionId: session.browser_session_id,
                userId: MOCK_USER_ID,
                debugOverlay: resolveOverlayEnabled(session),
                expectedUrl: snapshotUrl,
                expected,
                verify: verifyOption,
              });
              if (retry.success) {
                refResult = retry;
                recoveryState = "recovered";
                recoveredFromStaleReason = originalStale;
              } else {
                recoveryState = "failed_revalidation";
              }
            } else if (recovery.status === "ambiguous") {
              recoveryState = "failed_ambiguous";
            } else if (recovery.status === "not_found") {
              recoveryState = "failed_not_found";
            } else if (recovery.status === "out_of_viewport") {
              recoveryState = "failed_out_of_viewport";
            } else if (recovery.status === "page_changed") {
              recoveryState = "failed_page_changed";
            } else {
              recoveryState = "failed_cdp";
            }
          }
        }
      }

      if (!refResult.success) {
        // No successful pointer dispatch on any failure (out-of-viewport / stale aborts before dispatch).
        const failCode =
          refResult.error === "ANTIGEN_REF_PAGE_CHANGED" ? "ANTIGEN_REF_PAGE_CHANGED"
          : refResult.error === "ANTIGEN_REF_OUT_OF_VIEWPORT" ? "ANTIGEN_REF_OUT_OF_VIEWPORT"
          : refResult.error === "ANTIGEN_REF_STALE" ? "ANTIGEN_REF_STALE"
          : refResult.error === "REALISM_DISABLED" ? "REALISM_DISABLED"
          : "REALISTIC_CLICK_FAILED";
        // Sanitized stale signal for stale / out-of-viewport (enum only, no values).
        const staleSignal =
          failCode === "ANTIGEN_REF_STALE" || failCode === "ANTIGEN_REF_OUT_OF_VIEWPORT"
            ? sanitizeStaleReason(refResult.stale_reason)
            : undefined;
        // An expired ref that failed re-validation: surface why the meaning changed
        // (page_changed / semantic_mismatch / generic). Time alone never recovers.
        const ttlFail: AntigenTtlRecoveryState | undefined = ttlExpired
          ? mapTtlRecoveryFailureReason(refResult.error)
          : undefined;
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_click", browser_runtime_id: session.browser_session_id,
          tool: "browser_click", click_path: "ag_ref", ref: refRaw,
          element_name: el.name, context: el.context, href_path: el.href_path ?? undefined,
          pointer_dispatch: false, error_code: failCode,
          // When the surface path handled this stale, surface_resolution_state is
          // the disposition and recovery_state is omitted (page-wide recovery did
          // not run for the surface member). Otherwise the legacy field stands.
          ...(failCode === "ANTIGEN_REF_STALE"
            ? surfaceState !== undefined
              ? { surface_resolution_state: surfaceState }
              : { recovery_state: recoveryState }
            : {}),
          ...(staleSignal ? { stale_reason: staleSignal.stale_reason } : {}),
          ...(ttlFail ? { ttl_recovery_state: ttlFail } : {}),
        });
        const ttlFailField = ttlFail ? { ttl_recovery_state: ttlFail } : {};
        // No-progress HV backstop. Any ref-based failure that represents a stop with
        // NO progress (stale / page-changed / out-of-viewport / realization failure)
        // may be a visual overlay blocking an otherwise-normal page — the live B&BW
        // "Press & Hold" wall lands here as REALISTIC_CLICK_FAILED, not stale. Rule
        // out HV (and the conservative ambiguous-obstruction fallback) before any of
        // the specific 422 returns below. If it fires it sends 409 and we return;
        // otherwise we arm a recent-no-progress marker so the NEXT antigen_snapshot
        // can re-probe even on a high-element page. HV-flag-gated → byte-identical off.
        if (NO_PROGRESS_ACTION_FAIL_CODES.has(failCode)) {
          if (await rejectNoProgressActionAsHumanVerification(session, reply, "browser_click", delegation)) return;
          if (isHumanVerificationEnabled()) recordActionNoProgress(session.browser_session_id);
        }
        if (refResult.error === "ANTIGEN_REF_PAGE_CHANGED") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_PAGE_CHANGED", message: "The page changed since this snapshot. Take a fresh antigen_snapshot.", ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_OUT_OF_VIEWPORT") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_OUT_OF_VIEWPORT", message: "Antigen ref is outside the current viewport. Scroll the target into view, take a new antigen_snapshot, and retry.", ...(staleSignal ?? {}), ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_STALE") {
          // Surface-aware stale message: a gone surface is useful signal (the
          // panel/dialog closed) — tell the agent that instead of a generic stale.
          // HV was already ruled out by the no-progress backstop above.
          const staleMessage =
            surfaceState === "failed_surface_gone"
              ? "The active surface (panel/dialog) this ref belonged to is no longer present — it likely closed. Take a fresh antigen_snapshot and act on the current page state."
              : "Antigen ref is stale. Take a new antigen_snapshot and retry.";
          // Closes the preflight ordering trace: ANTIGEN_REF_STALE is reached only
          // AFTER human verification was ruled out by the live probe above.
          recordActionPreflight(session, "browser_click", "returned_ref_stale");
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_STALE", message: staleMessage, ...(staleSignal ?? {}), ...(surfaceState !== undefined ? { surface_resolution_state: surfaceState } : { recovery_state: recoveryState }), ...ttlFailField } });
        }
        const code = refResult.error === "REALISM_DISABLED" ? "REALISM_DISABLED" : "REALISTIC_CLICK_FAILED";
        return reply.status(422).send({ ok: false, error: { code, message: refResult.error ?? "Realistic click failed.", ...ttlFailField } });
      }

      // ── Single safe verify-retry (ANTIGEN_CLICK_VERIFY + ANTIGEN_LOGICAL_REF_RECOVERY) ──
      // The click physically dispatched but verifiably produced NO effect. Retry
      // exactly once, only for a clearly low-risk intent, only against a unique
      // semantically-identical target re-found on the same page. Extremely
      // conservative — NEVER on:
      //   • CLICK_INTENT_UNVERIFIED (an unreadable probe is not evidence of a miss),
      //   • editable targets (success is focus; re-clicking can't help),
      //   • modal-trap / background-behind-modal clicks,
      //   • sensitive/final actions (already blocked pre-dispatch; asserted here),
      //   • a click that already consumed the stale-recovery retry (shared flag).
      // A verified click (e.g. cart_changed) never retries, so a successful
      // add-to-cart can't be duplicated. recoverAntigenRefBox is the SAME unique-
      // match machinery the stale path uses; only status:"recovered" proceeds.
      let retriedOnce = recoveryState === "recovered" || surfaceState === "resolved";
      if (
        !retriedOnce &&
        isClickVerifyEnabled() &&
        isLogicalRefRecoveryEnabled() &&
        refResult.verification?.outcome === "CLICK_DISPATCHED_NO_EFFECT" &&
        !verifyEditableTarget &&
        !verifyBehindBlockingModal &&
        LOW_RISK_CLICK_INTENTS.has(gate.action_intent)
      ) {
        const eligibility = classifyLogicalRecoveryEligibility(expected, "click");
        if (eligibility.eligible) {
          const recovery = await recoverAntigenRefBox({
            cdpUrl: session.cdp_url,
            expected,
            expectedUrl: snapshotUrl,
            riskClass: eligibility.risk_class,
          });
          if (recovery.status === "recovered") {
            retriedOnce = true;
            const retry = await realisticClickKnownBox({
              cdpUrl: session.cdp_url,
              box: recovery.box,
              sessionId: session.browser_session_id,
              userId: MOCK_USER_ID,
              debugOverlay: resolveOverlayEnabled(session),
              expectedUrl: snapshotUrl,
              expected,
              verify: verifyOption,
            });
            // Adopt the retry only if it physically dispatched. A retry that fails
            // to dispatch leaves the original (dispatched) result intact — the
            // first click still physically happened, so we never downgrade to an
            // HTTP error here.
            if (retry.success) refResult = retry;
          }
        }
      }
      const verification = refResult.verification;
      // Generalized post-click realization summary (sanitized: query-free paths,
      // clipped value-free titles, names-only surface actions). undefined when
      // ANTIGEN_CLICK_VERIFY is off — the response stays byte-identical.
      const postClickState = buildPostClickState(verification, {
        includeActions: isActiveSurfacesEnabled(),
      });

      // Refresh session.current_url so the next Antigen snapshot is not stale after a
      // click-triggered navigation. Internal session state only — never in the response.
      if (typeof refResult.current_url === "string" && refResult.current_url.length > 0) {
        setTaskBrowserSessionCurrentUrl(session.browser_session_id, refResult.current_url);
      }

      // Lease refresh: only after a fully-validated dispatch, and only when the
      // recovery flag is on. Keeps an actively-used ref alive so a live flow rarely
      // hits the TTL; idle refs still GC at the bound. `ttl_recovery_state` is
      // surfaced only when this success came from a TTL-expired ref.
      const leaseRefreshed = isLogicalRefRecoveryEnabled() && snapshotId
        ? refreshAntigenSnapshotLease(snapshotId, MOCK_USER_ID)
        : false;
      const ttlRecovered = ttlExpired && leaseRefreshed;

      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_click", browser_runtime_id: session.browser_session_id,
        tool: "browser_click", click_path: "ag_ref", ref: refRaw,
        element_name: el.name, context: el.context, href_path: el.href_path ?? undefined,
        pointer_dispatch: true, result_code: "realistic_success",
        url_after: sanitizeTraceUrl(refResult.current_url),
        total_ms: Date.now() - tToolStart,
        ...(recoveryState === "recovered" ? { recovery_state: recoveryState, ...(recoveredFromStaleReason ? { stale_reason: recoveredFromStaleReason.stale_reason } : {}) } : {}),
        ...(surfaceState === "resolved" ? { surface_resolution_state: surfaceState, ...(recoveredFromStaleReason ? { stale_reason: recoveredFromStaleReason.stale_reason } : {}) } : {}),
        ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
        ...(verification ? {
          click_dispatched: verification.click_dispatched,
          intent_verified: verification.intent_verified,
          verification_signal: verification.verification_signal,
          url_changed: verification.url_changed,
          overlay_before_present: verification.overlay_before_present,
          overlay_before_blocking: verification.overlay_before_blocking,
          overlay_after_present: verification.overlay_after_present,
          overlay_after_blocking: verification.overlay_after_blocking,
          ...(verification.overlay_before_type ? { overlay_before_type: verification.overlay_before_type } : {}),
          ...(verification.overlay_after_type ? { overlay_after_type: verification.overlay_after_type } : {}),
          ...(typeof verification.verify_ms === "number" ? { verify_ms: verification.verify_ms } : {}),
          ...(typeof verification.settle_polls === "number" ? { settle_polls: verification.settle_polls } : {}),
          retried_once: retriedOnce,
          stale_recovered: recoveryState === "recovered" || surfaceState === "resolved",
          ...(postClickState ? {
            post_click_change: postClickState.change,
            post_click_actions_count: postClickState.surface?.surface_actions?.length ?? 0,
          } : {}),
        } : {}),
      });

      return reply.send({
        ok: true,
        data: {
          mode: "realistic_pointer_click",
          ...(refResult.pointer_start_source !== undefined ? { pointer_start_source: refResult.pointer_start_source } : {}),
          ...(refResult.pointer_path_point_count !== undefined ? { pointer_path_point_count: refResult.pointer_path_point_count } : {}),
          ...(refResult.pointer_state_persisted !== undefined ? { pointer_state_persisted: refResult.pointer_state_persisted } : {}),
          // Recovery telemetry: present only when same-page logical recovery or
          // surface-scoped live resolution saved this action, so we can measure
          // how often each helps. Enum + sanitized stale reason only — never
          // boxes/coordinates/hrefs/surface titles.
          ...(recoveryState === "recovered"
            ? {
                recovery_state: recoveryState,
                ...(recoveredFromStaleReason ? { recovered_from_stale_reason: recoveredFromStaleReason.stale_reason } : {}),
              }
            : {}),
          ...(surfaceState === "resolved"
            ? {
                surface_resolution_state: surfaceState,
                ...(recoveredFromStaleReason ? { recovered_from_stale_reason: recoveredFromStaleReason.stale_reason } : {}),
              }
            : {}),
          ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
          // Post-click intent verification (only present when ANTIGEN_CLICK_VERIFY
          // is on). A dispatched-but-unverified click stays ok:true with
          // intent_verified:false + an outcome + recommended_next_step — never an
          // HTTP error. The agent treats intent_verified:false as a reason to
          // re-snapshot before retrying.
          ...(verification
            ? {
                click_dispatched: verification.click_dispatched,
                intent_verified: verification.intent_verified,
                verification_signal: verification.verification_signal,
                outcome: verification.outcome,
                recommended_next_step: verification.recommended_next_step,
                ...(retriedOnce ? { retried_once: true } : {}),
                // Bounded timing telemetry — lets the agent (and QA) see what the
                // settle cost, instead of guessing from wall-clock.
                ...(typeof verification.verify_ms === "number" && Number.isFinite(verification.verify_ms)
                  ? { verify_ms: Math.max(0, Math.min(600_000, Math.floor(verification.verify_ms))) }
                  : {}),
                ...(typeof verification.settle_polls === "number" && Number.isFinite(verification.settle_polls)
                  ? { settle_polls: Math.max(0, Math.min(32, Math.floor(verification.settle_polls))) }
                  : {}),
                // Generalized post-click realization summary. Built ONLY via
                // buildPostClickState (explicit allowlist) — never spread
                // verification.post_click_internal (raw URLs) into a response.
                ...(postClickState ? { post_click_state: postClickState } : {}),
              }
            : {}),
        },
      });
    }

    if (!body.element_description || typeof body.element_description !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "element_description is required and must be a non-empty string.");
    }

    const selectorHint = typeof body.selector_hint === "string" && body.selector_hint.length > 0
      ? body.selector_hint
      : undefined;

    // Capability-state action gate (description path). Only the description text
    // is available here (no structural metadata), so classification is best-
    // effort and fails closed on clear final/irreversible verbs. The ag_* path is
    // the primary, fully-structural surface.
    const descGate = evaluateActionGate(
      classifyActionIntent({
        action: "click",
        text: body.element_description,
        url: session.current_url,
        risk_state: session.risk_state,
      }),
      session.risk_state,
    );
    if (descGate.disposition === "blocked_by_antigen_platform") {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_tool_disposition",
        browser_runtime_id: session.browser_session_id,
        tool: "browser_click",
        disposition: "blocked_by_antigen_platform",
        action_intent: descGate.action_intent,
      });
      advanceRiskState(session.browser_session_id, descGate.action_intent);
      return reply.send({
        ok: true,
        data: {
          mode: "blocked_by_antigen_platform",
          dispatched: false,
          action_intent: descGate.action_intent,
          ...(descGate.recommended_handoff ? { recommended_handoff: descGate.recommended_handoff } : {}),
          reason: descGate.reason,
        },
      });
    }
    advanceRiskState(session.browser_session_id, descGate.action_intent);

    const result = await realisticClickByDescription({
      cdpUrl: session.cdp_url,
      elementDescription: body.element_description,
      sessionId: session.browser_session_id,
      userId: MOCK_USER_ID,
      selectorHint,
      debugOverlay: resolveOverlayEnabled(session),
      // Verification-only (no retry on this path — no structural metadata to
      // re-find a unique target). editable / modal-trap context unknown here.
      verify: isClickVerifyEnabled()
        ? {
            enabled: true,
            editableTarget: false,
            targetWasBehindBlockingModal: false,
            cartMutationIntent: descGate.action_intent === "cart_mutation",
            checkoutTransitionIntent: descGate.action_intent === "checkout_transition",
            collectSurfaceDetail: isActiveSurfacesEnabled(),
          }
        : undefined,
    });

    if (!result.success) {
      const code =
        result.error === "ELEMENT_NOT_FOUND" ? "ELEMENT_NOT_FOUND"
        : result.error === "AMBIGUOUS_ELEMENT" ? "AMBIGUOUS_ELEMENT"
        : result.error === "REALISM_DISABLED" ? "REALISM_DISABLED"
        : "REALISTIC_CLICK_FAILED";
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_click", browser_runtime_id: session.browser_session_id,
        tool: "browser_click", click_path: "description",
        pointer_dispatch: false, error_code: code,
      });
      return reply.status(422).send({ ok: false, error: { code, message: result.error ?? "Realistic click failed." } });
    }

    // Refresh session.current_url so the next Antigen snapshot is not stale after a
    // click-triggered navigation. Internal session state only — never in the response.
    if (typeof result.current_url === "string" && result.current_url.length > 0) {
      setTaskBrowserSessionCurrentUrl(session.browser_session_id, result.current_url);
    }

    const descVerification = result.verification;
    const descPostClickState = buildPostClickState(descVerification, {
      includeActions: isActiveSurfacesEnabled(),
    });
    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "browser_click", browser_runtime_id: session.browser_session_id,
      tool: "browser_click", click_path: "description",
      pointer_dispatch: true, result_code: "realistic_success",
      url_after: sanitizeTraceUrl(result.current_url),
      total_ms: Date.now() - tToolStart,
      ...(descVerification ? {
        click_dispatched: descVerification.click_dispatched,
        intent_verified: descVerification.intent_verified,
        verification_signal: descVerification.verification_signal,
        url_changed: descVerification.url_changed,
        overlay_before_present: descVerification.overlay_before_present,
        overlay_before_blocking: descVerification.overlay_before_blocking,
        overlay_after_present: descVerification.overlay_after_present,
        overlay_after_blocking: descVerification.overlay_after_blocking,
        ...(descVerification.overlay_before_type ? { overlay_before_type: descVerification.overlay_before_type } : {}),
        ...(descVerification.overlay_after_type ? { overlay_after_type: descVerification.overlay_after_type } : {}),
        ...(typeof descVerification.verify_ms === "number" ? { verify_ms: descVerification.verify_ms } : {}),
        ...(typeof descVerification.settle_polls === "number" ? { settle_polls: descVerification.settle_polls } : {}),
        ...(descPostClickState ? {
          post_click_change: descPostClickState.change,
          post_click_actions_count: descPostClickState.surface?.surface_actions?.length ?? 0,
        } : {}),
      } : {}),
    });

    return reply.send({
      ok: true,
      data: {
        mode: "realistic_pointer_click",
        ...(result.pointer_start_source !== undefined ? { pointer_start_source: result.pointer_start_source } : {}),
        ...(result.pointer_path_point_count !== undefined ? { pointer_path_point_count: result.pointer_path_point_count } : {}),
        ...(result.pointer_state_persisted !== undefined ? { pointer_state_persisted: result.pointer_state_persisted } : {}),
        ...(descVerification
          ? {
              click_dispatched: descVerification.click_dispatched,
              intent_verified: descVerification.intent_verified,
              verification_signal: descVerification.verification_signal,
              outcome: descVerification.outcome,
              recommended_next_step: descVerification.recommended_next_step,
              ...(typeof descVerification.verify_ms === "number" && Number.isFinite(descVerification.verify_ms)
                ? { verify_ms: Math.max(0, Math.min(600_000, Math.floor(descVerification.verify_ms))) }
                : {}),
              ...(typeof descVerification.settle_polls === "number" && Number.isFinite(descVerification.settle_polls)
                ? { settle_polls: Math.max(0, Math.min(32, Math.floor(descVerification.settle_polls))) }
                : {}),
              ...(descPostClickState ? { post_click_state: descPostClickState } : {}),
            }
          : {}),
      },
    });
  });

  // Antigen scroll-to-ref recovery (Phase 5C). Scrolls an offscreen ag_* ref
  // near the current viewport so the agent can take a fresh antigen_snapshot and
  // click the new in-viewport ref. SCROLL ONLY — never clicks, never auto-refreshes
  // the snapshot, never returns coordinates/box/cdp_url. The old offscreen ref is
  // a scroll target only, never a click target.
  server.post("/api/agent/v1/runtime/browser-scroll-to-ref", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const body = (req.body ?? {}) as { browser_runtime_id?: unknown; ref?: unknown };

    if (!body.browser_runtime_id || typeof body.browser_runtime_id !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "browser_runtime_id is required.");
    }

    const runtimeResolution = resolveReadyRuntimeSession(body.browser_runtime_id, delegation.id, MOCK_USER_ID);
    if (runtimeResolution.kind === "forbidden") return sendError(reply, 403, "FORBIDDEN", "This browser session does not belong to your delegation.");
    if (runtimeResolution.kind === "none") {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_scroll_to_ref",
        error_code: "SESSION_NOT_FOUND",
      });
      return sendError(reply, 404, "SESSION_NOT_FOUND", "Browser runtime session not found.");
    }
    if (runtimeResolution.kind === "starting") return sendError(reply, 400, "SESSION_NOT_READY", `Session status is '${runtimeResolution.session.status}'; must be 'ready'.`);
    if (runtimeResolution.kind === "rebound") {
      // Fail closed: the runtime changed since this ref was captured. Never resolve a
      // stale ag_* ref against a different runtime. RUNTIME_SESSION_CHANGED is agent-
      // recoverable but must NOT be auto-retried with the same ref — reinitialize the
      // runtime if needed, take a fresh antigen_snapshot, then act on the new refs.
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_scroll_to_ref",
        error_code: "RUNTIME_SESSION_CHANGED",
      });
      return reply.status(409).send({ ok: false, error: { code: "RUNTIME_SESSION_CHANGED", message: "The browser runtime changed since this ref was captured. Reinitialize the runtime if needed, take a fresh antigen_snapshot, then act on the new refs — stale refs are not carried across runtime changes." } });
    }
    const session = runtimeResolution.session; // ready
    if (rejectIfHumanVerificationActive(session, reply, "browser_scroll_to_ref")) return;

    const refRaw = typeof body.ref === "string" ? body.ref : undefined;
    if (!refRaw || !/^ag_\d+$/.test(refRaw)) {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_scroll_to_ref", browser_runtime_id: session.browser_session_id,
        tool: "browser_scroll_to_ref", ref: refRaw, error_code: "ANTIGEN_REF_INVALID",
      });
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_INVALID", message: `Malformed Antigen ref '${refRaw ?? ""}'; expected ag_<number>.` } });
    }

    const resolution = resolveAntigenRefForSession(session.browser_session_id, MOCK_USER_ID, refRaw);
    if (resolution.status === "no_snapshot" || resolution.status === "ref_not_found") {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_scroll_to_ref", browser_runtime_id: session.browser_session_id,
        tool: "browser_scroll_to_ref", ref: refRaw, error_code: "ANTIGEN_REF_NOT_FOUND",
      });
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
    }
    // TTL-expiry recovery (same ANTIGEN_LOGICAL_REF_RECOVERY flag). Scroll is a
    // non-mutating, low-risk action; an expired-but-present ref is re-validated by
    // the live-URL guard only (no Phase 4B for scroll). Flag off / element GC'd ⇒
    // strict hard-fail. A validated scroll refreshes the lease.
    let ttlExpired = false;
    if (resolution.status === "expired") {
      if (!isLogicalRefRecoveryEnabled() || !resolution.element) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_scroll_to_ref", browser_runtime_id: session.browser_session_id,
          tool: "browser_scroll_to_ref", ref: refRaw, error_code: "ANTIGEN_REF_EXPIRED",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_EXPIRED", message: "The Antigen snapshot has expired. Take a fresh antigen_snapshot." } });
      }
      ttlExpired = true;
    }

    // A scrollable ref needs a positive-dimension box and document-space geometry.
    const el = resolution.element;
    const snapshotUrl = resolution.snapshot_url ?? null;
    const snapshotId = resolution.snapshot_id;
    if (!el) {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_scroll_to_ref", browser_runtime_id: session.browser_session_id,
        tool: "browser_scroll_to_ref", ref: refRaw, error_code: "ANTIGEN_REF_NOT_FOUND",
      });
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
    }
    if (el.box.width <= 0 || el.box.height <= 0 || !Number.isFinite(el.box.doc_y)) {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_scroll_to_ref", browser_runtime_id: session.browser_session_id,
        tool: "browser_scroll_to_ref", ref: refRaw, element_name: el.name,
        context: el.context, error_code: "ANTIGEN_REF_NOT_SCROLLABLE",
      });
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_SCROLLABLE", message: `Antigen ref '${refRaw}' has no scrollable geometry. Take a fresh antigen_snapshot.` } });
    }

    const scrollResult = await scrollKnownBoxIntoView({
      cdpUrl: session.cdp_url,
      box: { width: el.box.width, height: el.box.height, doc_y: el.box.doc_y as number },
      sessionId: session.browser_session_id,
      userId: MOCK_USER_ID,
      // Live-URL guard: fail closed if the page navigated since the snapshot, so a
      // scroll never proceeds on a page that click/type would reject.
      expectedUrl: snapshotUrl,
    });

    if (!scrollResult.success) {
      const scrollFailCode = scrollResult.error === "ANTIGEN_REF_PAGE_CHANGED" ? "ANTIGEN_REF_PAGE_CHANGED" : "ANTIGEN_SCROLL_FAILED";
      const ttlFail: AntigenTtlRecoveryState | undefined = ttlExpired
        ? mapTtlRecoveryFailureReason(scrollResult.error)
        : undefined;
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_scroll_to_ref", browser_runtime_id: session.browser_session_id,
        tool: "browser_scroll_to_ref", ref: refRaw, element_name: el.name,
        context: el.context, error_code: scrollFailCode,
        ...(ttlFail ? { ttl_recovery_state: ttlFail } : {}),
      });
      const ttlFailField = ttlFail ? { ttl_recovery_state: ttlFail } : {};
      if (scrollResult.error === "ANTIGEN_REF_PAGE_CHANGED") {
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_PAGE_CHANGED", message: "The page changed since this snapshot. Take a fresh antigen_snapshot.", ...ttlFailField } });
      }
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_SCROLL_FAILED", message: "Antigen could not scroll the ref into view. Take a fresh antigen_snapshot and retry.", ...ttlFailField } });
    }

    // Lease refresh: only after a validated scroll, and only when the flag is on.
    const leaseRefreshed = isLogicalRefRecoveryEnabled() && snapshotId
      ? refreshAntigenSnapshotLease(snapshotId, MOCK_USER_ID)
      : false;
    const ttlRecovered = ttlExpired && leaseRefreshed;

    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "browser_scroll_to_ref", browser_runtime_id: session.browser_session_id,
      tool: "browser_scroll_to_ref", ref: refRaw, element_name: el.name,
      context: el.context, result_code: "scroll_to_ref_success",
      ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
    });

    // Success is intentionally minimal: the agent must take a NEW antigen_snapshot
    // and click the fresh in-viewport ref. The old ref is not now clickable.
    return reply.send({
      ok: true,
      data: {
        mode: "scroll_to_ref",
        hint: "take_new_snapshot",
        ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
      },
    });
  });

  server.post("/api/agent/v1/runtime/browser-type", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;
    const tToolStart = Date.now();

    const body = (req.body ?? {}) as {
      browser_runtime_id?: unknown;
      text?: unknown;
      element_description?: unknown;
      selector_hint?: unknown;
      submit?: unknown;
      ref?: unknown;
    };

    if (!body.browser_runtime_id || typeof body.browser_runtime_id !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "browser_runtime_id is required.");
    }
    if (body.text === undefined || body.text === null || typeof body.text !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "text is required and must be a string.");
    }

    const runtimeResolution = resolveReadyRuntimeSession(body.browser_runtime_id, delegation.id, MOCK_USER_ID);
    if (runtimeResolution.kind === "forbidden") return sendError(reply, 403, "FORBIDDEN", "This browser session does not belong to your delegation.");
    if (runtimeResolution.kind === "none") {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_type",
        error_code: "SESSION_NOT_FOUND",
      });
      return sendError(reply, 404, "SESSION_NOT_FOUND", "Browser runtime session not found.");
    }
    if (runtimeResolution.kind === "starting") return sendError(reply, 400, "SESSION_NOT_READY", `Session status is '${runtimeResolution.session.status}'; must be 'ready'.`);
    if (runtimeResolution.kind === "rebound") {
      // Fail closed: the runtime changed since this ref was captured. Never resolve a
      // stale ag_* ref against a different runtime. RUNTIME_SESSION_CHANGED is agent-
      // recoverable but must NOT be auto-retried with the same ref — reinitialize the
      // runtime if needed, take a fresh antigen_snapshot, then act on the new refs.
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_type",
        error_code: "RUNTIME_SESSION_CHANGED",
      });
      return reply.status(409).send({ ok: false, error: { code: "RUNTIME_SESSION_CHANGED", message: "The browser runtime changed since this ref was captured. Reinitialize the runtime if needed, take a fresh antigen_snapshot, then act on the new refs — stale refs are not carried across runtime changes." } });
    }
    const session = runtimeResolution.session; // ready
    if (rejectIfHumanVerificationActive(session, reply, "browser_type")) return;

    const submitFlag = body.submit === true;

    // Antigen exact-ref path (Phase 4A/4B): when ref is an Antigen ref (ag_<n>),
    // resolve the exact typeable element box from the latest active snapshot for
    // this session+user and type into it via the realistic known-box typing
    // runtime. No scoring, no fuzzy matching, no text rediscovery — exact ref
    // only, mirroring the browser-click ag_* path. Non-ag refs / no ref fall
    // through to the description path below. text is never logged beyond
    // char_count_bucket.
    const refRaw = typeof body.ref === "string" ? body.ref : undefined;
    if (refRaw && refRaw.startsWith("ag_")) {
      if (!/^ag_\d+$/.test(refRaw)) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_type", browser_runtime_id: session.browser_session_id,
          tool: "browser_type", submit: submitFlag, pointer_dispatch: false,
          error_code: "ANTIGEN_REF_INVALID",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_INVALID", message: `Malformed Antigen ref '${refRaw}'; expected ag_<number>.` } });
      }

      const resolution = resolveAntigenRefForSession(session.browser_session_id, MOCK_USER_ID, refRaw);
      if (resolution.status === "no_snapshot" || resolution.status === "ref_not_found") {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_type", browser_runtime_id: session.browser_session_id,
          tool: "browser_type", submit: submitFlag, pointer_dispatch: false,
          error_code: "ANTIGEN_REF_NOT_FOUND",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
      }
      // TTL-expiry recovery (same ANTIGEN_LOGICAL_REF_RECOVERY flag). Flag off /
      // element GC'd ⇒ strict hard-fail. Flag on + element present ⇒ mark
      // ttlExpired and force the ref through the live-URL guard + Phase 4B below;
      // sensitive fields are refused outright (fresh ref required), and only a
      // validated keystroke dispatch refreshes the lease.
      let ttlExpired = false;
      if (resolution.status === "expired") {
        if (!isLogicalRefRecoveryEnabled() || !resolution.element) {
          recordBrowserTraceEvent(session.browser_session_id, {
            event_type: "browser_type", browser_runtime_id: session.browser_session_id,
            tool: "browser_type", submit: submitFlag, pointer_dispatch: false,
            error_code: "ANTIGEN_REF_EXPIRED",
          });
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_EXPIRED", message: "The Antigen snapshot has expired. Take a fresh antigen_snapshot." } });
        }
        ttlExpired = true;
      }

      const el = resolution.element;
      const snapshotUrl = resolution.snapshot_url ?? null;
      const snapshotId = resolution.snapshot_id;
      if (!el) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_type", browser_runtime_id: session.browser_session_id,
          tool: "browser_type", submit: submitFlag, pointer_dispatch: false,
          error_code: "ANTIGEN_REF_NOT_FOUND",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
      }
      if (!el.enabled || !el.typeable || el.box.width <= 0 || el.box.height <= 0) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_type", browser_runtime_id: session.browser_session_id,
          tool: "browser_type", submit: submitFlag, element_name: el.name, context: el.context,
          href_path: el.href_path ?? undefined, pointer_dispatch: false,
          error_code: "ANTIGEN_REF_NOT_TYPEABLE",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_TYPEABLE", message: `Antigen ref '${refRaw}' is not a typeable field. Take a fresh antigen_snapshot and use a typeable ref.` } });
      }

      // Expired ref into a sensitive field: fail closed with the explicit
      // fresh-ref signal. (Non-expired sensitive fields are refused below by the
      // generic sensitive boundary; an expired sensitive ref must never recover.)
      if (ttlExpired && el.value_meta?.sensitive === true) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_type", browser_runtime_id: session.browser_session_id,
          tool: "browser_type", submit: submitFlag, element_name: el.name, context: el.context,
          href_path: el.href_path ?? undefined, pointer_dispatch: false,
          error_code: "ANTIGEN_REF_EXPIRED", ttl_recovery_state: "sensitive_requires_fresh_ref",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_EXPIRED", message: "This Antigen ref expired and targets a sensitive field. Sensitive values go through Aegis injection — take a fresh antigen_snapshot.", ttl_recovery_state: "sensitive_requires_fresh_ref" } });
      }

      // SENSITIVE BOUNDARY: never append keystrokes into a credential/payment/identity/
      // financial field through this generic tool. Payment fields route to the protected
      // payment-card fill path; credential/identity route to secret injection. No keystroke
      // is dispatched and the text is never echoed.
      if (el.value_meta?.sensitive === true) {
        const refusal = sensitiveFieldRefusal(el.value_meta.sensitivity);
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_type", browser_runtime_id: session.browser_session_id,
          tool: "browser_type", submit: submitFlag, element_name: el.name, context: el.context,
          href_path: el.href_path ?? undefined, pointer_dispatch: false,
          error_code: refusal.code,
        });
        return reply.status(422).send({ ok: false, error: refusal });
      }

      const refResult = await realisticTypeKnownBox({
        cdpUrl: session.cdp_url,
        box: el.box,
        text: body.text,
        sessionId: session.browser_session_id,
        userId: MOCK_USER_ID,
        submit: submitFlag,
        debugOverlay: resolveOverlayEnabled(session),
        // Live-URL guard: fail closed if the page navigated since the snapshot.
        expectedUrl: snapshotUrl,
        // Phase 4B: snapshot metadata for live-element revalidation before typing.
        expected: {
          tag: el.tag,
          kind: el.kind,
          role: el.role,
          name: el.name,
          normalized_name: el.normalized_name,
          href_path: el.href_path,
        },
      });

      if (!refResult.success) {
        // No successful keystroke dispatch on any failure (out-of-viewport / stale
        // aborts before dispatch).
        const failCode =
          refResult.error === "ANTIGEN_REF_PAGE_CHANGED" ? "ANTIGEN_REF_PAGE_CHANGED"
          : refResult.error === "ANTIGEN_REF_OUT_OF_VIEWPORT" ? "ANTIGEN_REF_OUT_OF_VIEWPORT"
          : refResult.error === "ANTIGEN_REF_STALE" ? "ANTIGEN_REF_STALE"
          : refResult.error === "REALISM_DISABLED" ? "REALISM_DISABLED"
          : "REALISTIC_TYPE_FAILED";
        const ttlFail: AntigenTtlRecoveryState | undefined = ttlExpired
          ? mapTtlRecoveryFailureReason(refResult.error)
          : undefined;
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_type", browser_runtime_id: session.browser_session_id,
          tool: "browser_type", submit: submitFlag, char_count_bucket: refResult.char_count_bucket,
          element_name: el.name, context: el.context, href_path: el.href_path ?? undefined,
          pointer_dispatch: false, error_code: failCode,
          ...(ttlFail ? { ttl_recovery_state: ttlFail } : {}),
        });
        const ttlFailField = ttlFail ? { ttl_recovery_state: ttlFail } : {};
        // No-progress HV backstop (see browser-click): rule out HV + ambiguous
        // visual obstruction for any no-progress failure before surfacing the 422,
        // then arm the recent-no-progress marker for the next snapshot.
        if (NO_PROGRESS_ACTION_FAIL_CODES.has(failCode)) {
          if (await rejectNoProgressActionAsHumanVerification(session, reply, "browser_type", delegation)) return;
          if (isHumanVerificationEnabled()) recordActionNoProgress(session.browser_session_id);
        }
        if (refResult.error === "ANTIGEN_REF_PAGE_CHANGED") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_PAGE_CHANGED", message: "The page changed since this snapshot. Take a fresh antigen_snapshot.", ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_OUT_OF_VIEWPORT") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_OUT_OF_VIEWPORT", message: "Antigen ref is outside the current viewport. Scroll the target into view, take a new antigen_snapshot, and retry.", ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_STALE") {
          // HV was already ruled out by the no-progress backstop above.
          recordActionPreflight(session, "browser_type", "returned_ref_stale");
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_STALE", message: "Antigen ref is stale. Take a new antigen_snapshot and retry.", ...ttlFailField } });
        }
        return reply.status(422).send({ ok: false, error: { code: failCode, message: refResult.error ?? "Realistic typing failed.", ...ttlFailField }, data: { char_count_bucket: refResult.char_count_bucket, duration_ms: refResult.duration_ms } });
      }

      // Lease refresh: only after a validated keystroke dispatch, flag-gated.
      const leaseRefreshed = isLogicalRefRecoveryEnabled() && snapshotId
        ? refreshAntigenSnapshotLease(snapshotId, MOCK_USER_ID)
        : false;
      const ttlRecovered = ttlExpired && leaseRefreshed;

      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_type", browser_runtime_id: session.browser_session_id,
        tool: "browser_type", char_count_bucket: refResult.char_count_bucket,
        submit: typeof refResult.submitted === "boolean" ? refResult.submitted : submitFlag,
        element_name: el.name, context: el.context, href_path: el.href_path ?? undefined,
        pointer_dispatch: refResult.pointer_path_point_count !== undefined,
        result_code: "realistic_type_success",
        total_ms: Date.now() - tToolStart,
        ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
      });

      return reply.send({
        ok: true,
        data: {
          char_count_bucket: refResult.char_count_bucket,
          duration_ms: refResult.duration_ms,
          ...(refResult.focused !== undefined ? { focused: refResult.focused } : {}),
          ...(refResult.submitted !== undefined ? { submitted: refResult.submitted } : {}),
          ...(refResult.submit_method !== undefined ? { submit_method: refResult.submit_method } : {}),
          ...(refResult.pointer_path_point_count !== undefined ? { pointer_path_point_count: refResult.pointer_path_point_count } : {}),
          ...(refResult.pointer_start_source !== undefined ? { pointer_start_source: refResult.pointer_start_source } : {}),
          ...(refResult.pointer_state_persisted !== undefined ? { pointer_state_persisted: refResult.pointer_state_persisted } : {}),
          ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
        },
      });
    }

    const elementDescription =
      typeof body.element_description === "string" && body.element_description.trim()
        ? body.element_description.trim()
        : undefined;
    const selectorHint =
      typeof body.selector_hint === "string" && body.selector_hint.trim()
        ? body.selector_hint.trim()
        : undefined;

    // text is never logged beyond char_count_bucket — see realisticBrowserActions.ts invariants
    const result = await realisticTypeTextViaCDP({
      cdpUrl: session.cdp_url,
      text: body.text,
      sessionId: session.browser_session_id,
      userId: MOCK_USER_ID,
      elementDescription,
      selectorHint,
      submit: submitFlag,
      debugOverlay: resolveOverlayEnabled(session),
    });

    if (!result.success) {
      // text is never traced — only the char-count bucket, submit flag, and result code.
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_type", browser_runtime_id: session.browser_session_id,
        tool: "browser_type", char_count_bucket: result.char_count_bucket,
        submit: submitFlag, pointer_dispatch: false,
        error_code: result.error ?? "REALISTIC_TYPE_FAILED",
      });
      return reply.status(422).send({
        ok: false,
        error: { code: result.error ?? "REALISTIC_TYPE_FAILED", message: "Realistic typing failed." },
        data: { char_count_bucket: result.char_count_bucket, duration_ms: result.duration_ms },
      });
    }

    // text is never traced — only the char-count bucket, submit flag, and result code.
    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "browser_type", browser_runtime_id: session.browser_session_id,
      tool: "browser_type", char_count_bucket: result.char_count_bucket,
      submit: typeof result.submitted === "boolean" ? result.submitted : submitFlag,
      pointer_dispatch: result.pointer_path_point_count !== undefined,
      result_code: "realistic_type_success",
      total_ms: Date.now() - tToolStart,
    });

    return reply.send({
      ok: true,
      data: {
        char_count_bucket: result.char_count_bucket,
        duration_ms: result.duration_ms,
        ...(result.focused !== undefined ? { focused: result.focused } : {}),
        ...(result.submitted !== undefined ? { submitted: result.submitted } : {}),
        ...(result.submit_method !== undefined ? { submit_method: result.submit_method } : {}),
        ...(result.pointer_path_point_count !== undefined ? { pointer_path_point_count: result.pointer_path_point_count } : {}),
        ...(result.pointer_start_source !== undefined ? { pointer_start_source: result.pointer_start_source } : {}),
        ...(result.pointer_state_persisted !== undefined ? { pointer_state_persisted: result.pointer_state_persisted } : {}),
      },
    });
  });

  // ─── Antigen exact-replacement field set (browser_set_value / browser_fill) ──
  // EXACT REPLACEMENT semantics: clears the field and sets the requested value via
  // the native property setter (React/Vue-safe), then reads back and verifies.
  // Idempotent — a second identical call reports changed=false and mutates nothing.
  // This is NOT browser_type (which appends keystrokes). Ref-only: callers must
  // supply an ag_* ref from the latest antigen_snapshot. Sensitive fields are refused:
  // payment fields → SENSITIVE_FIELD_REQUIRES_PAYMENT_CARD_FILL (request_payment_card_fill);
  // credential/identity/financial → SENSITIVE_FIELD_REQUIRES_INJECTION (request_secret_field_injection).
  // Credential/payment/identity values never flow through this generic tool, and their
  // values are never echoed back. The requested/actual value is never logged.
  server.post("/api/agent/v1/runtime/browser-set-value", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;
    const tToolStart = Date.now();

    const body = (req.body ?? {}) as {
      browser_runtime_id?: unknown;
      ref?: unknown;
      value?: unknown;
      select_by_label?: unknown;
    };

    if (!body.browser_runtime_id || typeof body.browser_runtime_id !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "browser_runtime_id is required.");
    }
    if (body.value === undefined || body.value === null || typeof body.value !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "value is required and must be a string.");
    }
    const refRaw = typeof body.ref === "string" ? body.ref : undefined;
    if (!refRaw || !refRaw.startsWith("ag_")) {
      return sendError(reply, 400, "REF_REQUIRED", "browser-set-value is ref-only: supply an ag_<n> ref from the latest antigen_snapshot.");
    }
    if (!/^ag_\d+$/.test(refRaw)) {
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_INVALID", message: `Malformed Antigen ref '${refRaw}'; expected ag_<number>.` } });
    }
    const selectByLabel = body.select_by_label === true;

    const runtimeResolution = resolveReadyRuntimeSession(body.browser_runtime_id, delegation.id, MOCK_USER_ID);
    if (runtimeResolution.kind === "forbidden") return sendError(reply, 403, "FORBIDDEN", "This browser session does not belong to your delegation.");
    if (runtimeResolution.kind === "none") {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected", browser_runtime_id: body.browser_runtime_id,
        tool: "browser_set_value", error_code: "SESSION_NOT_FOUND",
      });
      return sendError(reply, 404, "SESSION_NOT_FOUND", "Browser runtime session not found.");
    }
    if (runtimeResolution.kind === "starting") return sendError(reply, 400, "SESSION_NOT_READY", `Session status is '${runtimeResolution.session.status}'; must be 'ready'.`);
    if (runtimeResolution.kind === "rebound") {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected", browser_runtime_id: body.browser_runtime_id,
        tool: "browser_set_value", error_code: "RUNTIME_SESSION_CHANGED",
      });
      return reply.status(409).send({ ok: false, error: { code: "RUNTIME_SESSION_CHANGED", message: "The browser runtime changed since this ref was captured. Reinitialize the runtime if needed, take a fresh antigen_snapshot, then act on the new refs — stale refs are not carried across runtime changes." } });
    }
    const session = runtimeResolution.session; // ready
    if (rejectIfHumanVerificationActive(session, reply, "browser_set_value")) return;

    const resolution = resolveAntigenRefForSession(session.browser_session_id, MOCK_USER_ID, refRaw);
    if (resolution.status === "no_snapshot" || resolution.status === "ref_not_found") {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
        tool: "browser_set_value", error_code: "ANTIGEN_REF_NOT_FOUND",
      });
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
    }
    // TTL-expiry recovery (same ANTIGEN_LOGICAL_REF_RECOVERY flag). Flag off /
    // element GC'd ⇒ strict hard-fail. Flag on + element present ⇒ mark ttlExpired
    // and force the ref through the live-URL guard + Phase 4B exact read-back
    // below; sensitive fields are refused (fresh ref required), and only a
    // validated set refreshes the lease.
    let ttlExpired = false;
    if (resolution.status === "expired") {
      if (!isLogicalRefRecoveryEnabled() || !resolution.element) {
        recordBrowserTraceEvent(session.browser_session_id, {
          event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
          tool: "browser_set_value", error_code: "ANTIGEN_REF_EXPIRED",
        });
        return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_EXPIRED", message: "The Antigen snapshot has expired. Take a fresh antigen_snapshot." } });
      }
      ttlExpired = true;
    }

    const el = resolution.element;
    const snapshotUrl = resolution.snapshot_url ?? null;
    const snapshotId = resolution.snapshot_id;
    if (!el) {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
        tool: "browser_set_value", error_code: "ANTIGEN_REF_NOT_FOUND",
      });
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_NOT_FOUND", message: `Antigen ref '${refRaw}' was not found in the latest snapshot. Take a fresh antigen_snapshot.` } });
    }
    const fillableKinds = new Set(["input", "textarea", "select", "editable"]);
    if (!fillableKinds.has(el.kind) || !el.enabled || el.box.width <= 0 || el.box.height <= 0) {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
        tool: "browser_set_value", element_name: el.name, context: el.context,
        error_code: "NOT_FILLABLE",
      });
      return reply.status(422).send({ ok: false, error: { code: "NOT_FILLABLE", message: `Antigen ref '${refRaw}' is not an exact-fillable field (input/textarea/select). Take a fresh antigen_snapshot and use a fillable ref.` } });
    }

    // Expired ref into a sensitive field: fail closed with the explicit fresh-ref
    // signal (an expired sensitive ref must never recover, even before the generic
    // injection-required refusal below).
    if (ttlExpired && el.value_meta?.sensitive === true) {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
        tool: "browser_set_value", element_name: el.name, context: el.context,
        error_code: "ANTIGEN_REF_EXPIRED", ttl_recovery_state: "sensitive_requires_fresh_ref",
      });
      return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_EXPIRED", message: "This Antigen ref expired and targets a sensitive field. Sensitive values go through Aegis injection — take a fresh antigen_snapshot.", ttl_recovery_state: "sensitive_requires_fresh_ref" } });
    }

    // SENSITIVE BOUNDARY: never exact-fill a credential/payment/identity/financial
    // field through this generic tool. Route to the Aegis CDP injection path. The
    // value is never set and never echoed.
    if (el.value_meta?.sensitive === true) {
      const refusal = sensitiveFieldRefusal(el.value_meta.sensitivity);
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
        tool: "browser_set_value", element_name: el.name, context: el.context,
        error_code: refusal.code,
      });
      return reply.status(422).send({ ok: false, error: refusal });
    }

    // value is never logged beyond changed/verified/element_kind.
    const setResult = await setFieldValueKnownBox({
      cdpUrl: session.cdp_url,
      box: el.box,
      value: body.value,
      selectByLabel,
      sessionId: session.browser_session_id,
      userId: MOCK_USER_ID,
      expectedUrl: snapshotUrl,
      expected: {
        tag: el.tag,
        kind: el.kind,
        role: el.role,
        name: el.name,
        normalized_name: el.normalized_name,
        href_path: el.href_path,
      },
    });

    if (!setResult.success) {
      const failCode =
        setResult.error === "ANTIGEN_REF_PAGE_CHANGED" ? "ANTIGEN_REF_PAGE_CHANGED"
        : setResult.error === "ANTIGEN_REF_OUT_OF_VIEWPORT" ? "ANTIGEN_REF_OUT_OF_VIEWPORT"
        : setResult.error === "ANTIGEN_REF_STALE" ? "ANTIGEN_REF_STALE"
        : setResult.error === "NOT_FILLABLE" ? "NOT_FILLABLE"
        : setResult.error === "ELEMENT_DETACHED" ? "ELEMENT_DETACHED"
        : setResult.error === "VALUE_MISMATCH" ? "VALUE_MISMATCH"
        : "SET_VALUE_FAILED";
      const ttlFail: AntigenTtlRecoveryState | undefined = ttlExpired
        ? mapTtlRecoveryFailureReason(setResult.error)
        : undefined;
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
        tool: "browser_set_value", element_name: el.name, context: el.context,
        error_code: failCode,
        ...(ttlFail ? { ttl_recovery_state: ttlFail } : {}),
      });
      // No-progress HV backstop (see browser-click): rule out HV + ambiguous visual
      // obstruction for any no-progress failure before surfacing the 422, then arm
      // the recent-no-progress marker for the next snapshot. NOT_FILLABLE and
      // VALUE_MISMATCH are excluded (the field was reachable — not a visual block).
      if (NO_PROGRESS_ACTION_FAIL_CODES.has(failCode)) {
        if (await rejectNoProgressActionAsHumanVerification(session, reply, "browser_set_value", delegation)) return;
        if (isHumanVerificationEnabled()) recordActionNoProgress(session.browser_session_id);
        if (failCode === "ANTIGEN_REF_STALE") {
          recordActionPreflight(session, "browser_set_value", "returned_ref_stale");
        }
      }
      const messages: Record<string, string> = {
        ANTIGEN_REF_PAGE_CHANGED: "The page changed since this snapshot. Take a fresh antigen_snapshot.",
        ANTIGEN_REF_OUT_OF_VIEWPORT: "Antigen ref is outside the current viewport. Scroll the target into view, take a new antigen_snapshot, and retry.",
        ANTIGEN_REF_STALE: "Antigen ref is stale. Take a new antigen_snapshot and retry.",
        NOT_FILLABLE: "The element under this ref is not an exact-fillable field.",
        ELEMENT_DETACHED: "No element was found at the ref's position; the element was likely removed. Take a fresh antigen_snapshot.",
        VALUE_MISMATCH: "Aegis set the field but the read-back value did not match the requested value (the field may reject or reformat input). Inspect the snapshot value and retry.",
      };
      return reply.status(422).send({
        ok: false,
        error: { code: failCode, message: messages[failCode] ?? "Exact field set failed.", ...(ttlFail ? { ttl_recovery_state: ttlFail } : {}) },
        data: {
          ...(setResult.changed !== undefined ? { changed: setResult.changed } : {}),
          ...(setResult.verified !== undefined ? { verified: setResult.verified } : {}),
          ...(setResult.element_kind !== undefined ? { element_kind: setResult.element_kind } : {}),
          // actual_value is safe to surface here: sensitive fields were refused above.
          ...(setResult.actual_value !== undefined ? { actual_value: setResult.actual_value } : {}),
          duration_ms: setResult.duration_ms,
        },
      });
    }

    // Lease refresh: only after a validated exact set, flag-gated.
    const leaseRefreshed = isLogicalRefRecoveryEnabled() && snapshotId
      ? refreshAntigenSnapshotLease(snapshotId, MOCK_USER_ID)
      : false;
    const ttlRecovered = ttlExpired && leaseRefreshed;

    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "browser_set_value", browser_runtime_id: session.browser_session_id,
      tool: "browser_set_value", element_name: el.name, context: el.context,
      result_code: "set_value_success",
      total_ms: Date.now() - tToolStart,
      ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
    });

    return reply.send({
      ok: true,
      data: {
        changed: setResult.changed === true,
        verified: setResult.verified === true,
        requested_value: body.value,
        actual_value: setResult.actual_value ?? body.value,
        ...(setResult.element_kind !== undefined ? { element_kind: setResult.element_kind } : {}),
        duration_ms: setResult.duration_ms,
        ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
      },
    });
  });

  // ─── Navigation-Aware Pointer Continuity ─────────────────────────────────────
  // Called by antigen-browser-adapter after @playwright/mcp handles browser_navigate.
  // Updates current_url and persists a navigation_proxy pointer state so the next
  // browser_type / browser_click starts from pointer_start_source=session.

  server.post("/api/agent/v1/runtime/browser-navigation-state", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const body = (req.body ?? {}) as { browser_runtime_id?: unknown; url?: unknown; action?: unknown };

    if (!body.browser_runtime_id || typeof body.browser_runtime_id !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "browser_runtime_id is required.");
    }
    if (!body.url || typeof body.url !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "url is required.");
    }
    if (body.action !== "navigation_proxy") {
      return sendError(reply, 400, "INVALID_FIELD", "action must be \"navigation_proxy\".");
    }

    const session = getTaskBrowserSession(body.browser_runtime_id, MOCK_USER_ID);
    if (!session) {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_navigation_state",
        error_code: "SESSION_NOT_FOUND",
      });
      return sendError(reply, 404, "SESSION_NOT_FOUND", "Browser runtime session not found.");
    }
    if (session.delegation_id !== delegation.id) return sendError(reply, 403, "FORBIDDEN", "This browser session does not belong to your delegation.");
    if (session.status !== "ready") return sendError(reply, 400, "SESSION_NOT_READY", `Session status is '${session.status}'; must be 'ready'.`);

    // Sanitized host + path only (query strings and fragments stripped) so the
    // trace distinguishes google.com search vs reddit.com thread vs ikea.com
    // product pages without leaking URL params.
    const urlBefore = sanitizeTraceUrl(session.current_url);
    setTaskBrowserSessionCurrentUrl(session.browser_session_id, body.url);
    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "navigation_state", browser_runtime_id: session.browser_session_id,
      tool: "browser_navigation_state",
      url_before: urlBefore, url_after: sanitizeTraceUrl(body.url),
    });

    const existingPointerState = getTaskBrowserSessionPointerState(session.browser_session_id, MOCK_USER_ID);
    const { x: proxyX, y: proxyY, pointer_start_source: pointerStartSource } = computeNavigationProxyPointerState({
      existingPointerState: existingPointerState ?? undefined,
      viewportWidth: 1280,
      url: body.url,
      sessionId: session.browser_session_id,
    });

    setTaskBrowserSessionPointerState(session.browser_session_id, MOCK_USER_ID, {
      x: proxyX,
      y: proxyY,
      initialized: true,
      updated_at: new Date().toISOString(),
    });

    // Debug-only trust signal (ANTIGEN_POINTER_DEBUG_OVERLAY=true): @playwright/mcp owns
    // the navigation and the new page DOM destroyed any prior overlay, so re-inject a brief
    // "Antigen is mediating this browser" banner + cursor. Gated behind the explicit debug
    // flag so normal headed QA injects no banner. Fire-and-forget and fail-open — never
    // awaited, so a slow/failed banner can never block or fail this response (the adapter
    // calls this with a short timeout).
    if (resolveOverlayEnabled(session)) {
      void injectNavigationMediationBannerViaCDP({
        cdpUrl: session.cdp_url,
        pointer: { x: proxyX, y: proxyY },
      }).catch(() => {});
    }

    // Internal bookkeeping above (current_url, pointer state, mediation banner) has
    // run and is preserved. But if a Visual Gesture Capsule is pending for this
    // session, the agent-facing response must NOT look like a normal navigation-state
    // success — fail closed with HUMAN_VERIFICATION_REQUIRED instead.
    if (rejectIfVisualGestureCapsuleActive(session, reply, "browser_navigation_state")) return;

    return reply.send({
      ok: true,
      data: {
        pointer_state_persisted: true,
        pointer_start_source: pointerStartSource,
        pointer_action: "navigation_proxy",
      },
    });
  });

  // ─── Antigen Snapshot v1 ─────────────────────────────────────────────────────
  // Antigen-owned page snapshot. Extracts visible interactive DOM candidates over
  // CDP, stores internal records (with bounding boxes) keyed by ag_* refs, and
  // returns a SAFE external view — semantic metadata only, never coordinates,
  // cdp_url, profile paths, selector hints, or field values. No ag_* resolution
  // for click/type yet; this endpoint only extracts, stores, and returns refs.

  server.post("/api/agent/v1/runtime/browser-snapshot", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;
    const tToolStart = Date.now();

    const body = (req.body ?? {}) as {
      browser_runtime_id?: unknown;
      action?: unknown;
      max_candidates?: unknown;
      viewport_only?: unknown;
    };

    if (!body.browser_runtime_id || typeof body.browser_runtime_id !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "browser_runtime_id is required.");
    }
    if (body.action !== "dom_snapshot") {
      return sendError(reply, 400, "INVALID_FIELD", 'action must be "dom_snapshot".');
    }
    if (body.max_candidates !== undefined && typeof body.max_candidates !== "number") {
      return sendError(reply, 400, "INVALID_FIELD", "max_candidates must be a number if provided.");
    }

    // Bound max_candidates to [1, 500]; default 200 (extraction runtime default).
    const maxCandidates =
      typeof body.max_candidates === "number"
        ? Math.max(1, Math.min(500, Math.floor(body.max_candidates)))
        : 200;
    // viewport_only defaults true; only an explicit false opts out.
    const viewportOnly = body.viewport_only === false ? false : true;

    // Resolve the caller's runtime id against live state. Snapshot is the ONE
    // endpoint that may transparently rebind a stale id to the delegation's current
    // ready runtime — it captures a fresh snapshot_id/ref set bound to that session,
    // so no stale refs are carried across the change. "starting" stays a true
    // transient not-ready; "none" stays recoverable (re-provision).
    const runtimeResolution = resolveReadyRuntimeSession(body.browser_runtime_id, delegation.id, MOCK_USER_ID);
    if (runtimeResolution.kind === "forbidden") {
      return sendError(reply, 403, "FORBIDDEN", "This browser session does not belong to your delegation.");
    }
    if (runtimeResolution.kind === "starting") {
      return sendError(reply, 400, "SESSION_NOT_READY", `Session status is '${runtimeResolution.session.status}'; must be 'ready'.`);
    }
    if (runtimeResolution.kind === "none") {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "antigen_snapshot",
        error_code: "SESSION_NOT_FOUND",
      });
      return sendError(reply, 404, "SESSION_NOT_FOUND", "Browser runtime session not found.");
    }
    const session = runtimeResolution.session; // ready | rebound
    const rebound = runtimeResolution.kind === "rebound";
    if (!session.cdp_url) {
      return sendError(reply, 400, "SESSION_NOT_READY", "Browser runtime session has no active CDP endpoint.");
    }
    if (rebound) {
      // Metadata-only rebind audit — no paths, PIDs, or cdp_url.
      console.log(
        `[AntigenSnapshot] rebound stale_runtime_id=${runtimeResolution.previous_runtime_id}` +
          ` -> browser_runtime_id=${session.browser_session_id} delegation_id=${delegation.id}`,
      );
    }

    // An active Visual Gesture Capsule means a user gesture is pending in the Aegis
    // UI. Fail closed BEFORE extraction so a transient zero-element / access-denied
    // re-extract (and the clear-state branch it would otherwise hit) can't mask the
    // pending challenge as a normal snapshot. The capsule clears via the internal UI
    // gesture/recheck routes + TTL expiry, after which this snapshot resumes normally.
    if (rejectIfVisualGestureCapsuleActive(session, reply, "antigen_snapshot")) return;

    const timing = new BrowserTimingScope("antigen_snapshot");

    // Resolve the live CDP target ONCE (browser WS endpoint + the single page
    // target) using the same pickBestPageTarget selection the click/type/scroll
    // guards use. Threaded into DOM extraction, page-metadata, and the stored URL
    // so all three bind to the SAME page. Fail-safe: on null (transport/parse
    // failure or no usable target) each extraction falls back to its own fetch
    // and liveUrl falls back to readLiveCdpPageUrl — legacy behavior preserved.
    const resolved = await resolveSnapshotCdpTarget(session.cdp_url);
    timing.mark("target_resolve");
    const resolvedTarget = resolved
      ? { browserWsUrl: resolved.browserWsUrl, pageTarget: { id: resolved.target.id, url: resolved.target.url } }
      : undefined;

    // Single-connection bundle: candidate extraction AND the best-effort page
    // metadata run on one WebSocket + CDP session (extractAntigenSnapshotBundleViaCDP)
    // instead of two connect+attach cycles. Error semantics are unchanged:
    // candidate failures throw (→ SNAPSHOT_EXTRACTION_FAILED below); page-meta
    // problems never fail a snapshot (pageMeta is simply undefined). The raw
    // viewport/scroll numbers are consumed server-side to derive qualitative
    // fields only; they are never emitted to the agent.
    let candidates: AntigenSnapshotCandidate[];
    let pageMeta: AntigenPageMeta | undefined;
    // Cheap page-level HV hint from the same extraction session (present only
    // when ANTIGEN_HUMAN_VERIFICATION is on). Gates the confirming wall probe on
    // overlay-wall snapshots whose background DOM is preserved (high element
    // count), where the low-element fast path would otherwise skip the probe.
    let hvWallHint = false;
    // Page-level screen-HV verdict from the SAME extraction session. Iframe- and
    // element-count-independent: `screenHv.wall === true` mints a VGC for a
    // visible same-origin / top-level "Press & Hold" wall sitting over a
    // high-element background page (the case hvWallHint structurally misses).
    let screenHv: ScreenHvWallSignals | undefined;
    try {
      const bundle = await extractAntigenSnapshotBundleViaCDP({
        cdpUrl: session.cdp_url,
        maxCandidates,
        viewportOnly,
        resolvedTarget,
      });
      candidates = bundle.candidates;
      pageMeta = bundle.pageMeta;
      hvWallHint = bundle.hvWallHint === true;
      screenHv = bundle.screenHv;
      timing.mark("candidate_and_meta_extract");
    } catch {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "antigen_snapshot", browser_runtime_id: session.browser_session_id,
        tool: "antigen_snapshot", url_before: sanitizeTraceUrl(session.current_url),
        snapshot: { viewport_only: viewportOnly },
        error_code: "SNAPSHOT_EXTRACTION_FAILED",
      });
      // Never leak CDP URLs, filesystem paths, or stack detail.
      return sendError(reply, 502, "SNAPSHOT_EXTRACTION_FAILED", "Failed to capture an Antigen snapshot of the page.");
    }

    // The LIVE page URL is taken from the SAME single resolved target the DOM
    // extraction bound to — the same pickBestPageTarget source the click/type/
    // scroll live-URL guards compare against — so the snapshot stores the exact
    // page the refs were captured on. Cached session.current_url can lag a
    // navigation (Enter-submit, SPA route change, redirect) and would otherwise
    // make the next action fail with a false ANTIGEN_REF_PAGE_CHANGED. Fail-safe:
    // only when target resolution was unavailable do we fall back to a fresh
    // readLiveCdpPageUrl, then to cached session metadata.
    const liveUrl =
      resolved?.target.url ?? (await readLiveCdpPageUrl(session.cdp_url)) ?? session.current_url ?? null;
    timing.mark("live_url_capture");
    // Keep cached session metadata in lockstep with the live URL so the next
    // snapshot (and trace) sees the same page the refs were captured on.
    if (liveUrl && liveUrl !== session.current_url) {
      setTaskBrowserSessionCurrentUrl(session.browser_session_id, liveUrl);
    }

    const { snapshot, elements } = createAntigenSnapshotRecord({
      browser_session_id: session.browser_session_id,
      // Bind the record to the RESOLVED session — never the (possibly stale) request
      // id — so resolveAntigenRefForSession finds refs under the runtime that was
      // actually snapshotted, including after a rebind.
      browser_runtime_id: session.browser_session_id,
      user_id: MOCK_USER_ID,
      url: liveUrl,
      title: null, // v1: document.title extraction is out of scope
      candidates,
    });

    // Snapshot v2: derive the agent-readable page map (page summary, prioritized
    // actions, hints, qualitative status, forms, best-effort product cards,
    // warnings, evidence). Pure/derived — no raw geometry leaves this layer.
    const pageMap = buildAntigenPageMap({
      records: elements,
      pageMeta,
      viewportOnly,
      url: snapshot.url,
    });

    // Active Surfaces v1 (ANTIGEN_ACTIVE_SURFACES, default-off). Read-only
    // enrichment derived from the SAME stored records — flag off is
    // byte-identical (no new response fields, no element annotation).
    const activeSurfaces = isActiveSurfacesEnabled()
      ? buildActiveSurfaces(elements, snapshot.url)
      : undefined;
    const likelyBlockedRefs = new Set(activeSurfaces?.likely_blocked_refs ?? []);

    // Human Presence Relay v1 (ANTIGEN_HUMAN_VERIFICATION, default-off, byte-
    // identical when off). A blocking human-verification surface in THIS
    // snapshot auto-creates (or reuses) the HumanVerificationRequest and arms
    // the pre-action guard for the session. A snapshot with NO such surface
    // resolves any open request (completed only if the user actually relayed
    // presence), clears the guard, and stamps resumed_at on the first fresh
    // snapshot after completion.
    let hvSnapshotInfo:
      | { request_id: string; status: string; challenge_type: string; domain: string; expires_at: string; instructions: string; next_action: string; page_level?: true }
      | undefined;
    // Safe Visual Gesture Capsule view, set only by the ambiguous visual-obstruction
    // fallback (VGC flag on + concrete obstruction signal + no structural HV wall).
    let vgcSnapshotInfo: { available: true; capsule: SafeVisualGestureCapsuleView } | undefined;
    // Set when THIS snapshot freshly minted a Visual Gesture Capsule (page-level
    // structural wall OR ambiguous visual obstruction). When set, the snapshot fails
    // closed with 409 HUMAN_VERIFICATION_REQUIRED instead of returning a 200 — the
    // same shape the action-triggered path uses, so the user can relay the gesture in
    // the Aegis UI immediately rather than on the next snapshot. The pre-extract guard
    // (rejectIfVisualGestureCapsuleActive) already returned for pre-existing capsules,
    // so any capsule reached here is new this call and safe to fail closed on.
    let snapshotMintedHv:
      | {
          request: { request_id: string; status: string; challenge_type: string; domain: string };
          vgc: { available: true; capsule: SafeVisualGestureCapsuleView };
        }
      | undefined;
    // Set ONLY in ANTIGEN_VISION_CAPTURE_AND_SKIP exploration mode when this snapshot's
    // surface is a captured visual_classifier_candidate. Drives the 422 skip response
    // below (which takes precedence over — and in this mode replaces — any VGC/409).
    let snapshotVisualBlockerSkip: VisualBlockerSkip | undefined;
    // Dev-only attribution for a snapshot-minted 409 (ANTIGEN_HV_DEBUG). Set in
    // lockstep with snapshotMintedHv so the [HvDebug] log + response body name the
    // exact branch (structural_page_level_wall vs ambiguous_fired) and the signal
    // combination that fired. Booleans / enums / buckets only — never refs/coords.
    let snapshotHvDebug: Record<string, string | number | boolean> | undefined;
    // Set when the detected challenge is a page-level full-page denial wall whose
    // control is inside a cross-origin iframe (zero candidate elements). Drives a
    // synthesized blocking active surface + manual-completion guidance.
    let pageLevelHv = false;
    // Dev-only HV diagnostic (ANTIGEN_HV_DEBUG). Populated below, attached to the
    // response only when BOTH HV flags are on. Purely observational — it never
    // influences detection or response classification.
    let hvDebug: HumanVerificationDebug | undefined;
    if (isHumanVerificationEnabled()) {
      const hvMember = elements.find(
        (el) => el.overlay?.human_verification === true && el.overlay?.blocking === true,
      );
      // ── Snapshot-level screen-HV visible-wall mint ──────────────────────────
      // A visible same-origin / top-level "Press & Hold" wall can sit ABOVE a
      // high-element background page. screenHumanVerification() detects it via a
      // full-page scrim + a strong HV phrase WITHOUT an inaccessible iframe, a low
      // element count, or a stale/no-progress signal — the exact gap that let the
      // preserved background DOM return a healthy 200. When detected and no
      // per-candidate HV control attached (hvMember), mint a PAGE-LEVEL Visual
      // Gesture Capsule (the control box is opaque) and fail closed with 409 —
      // independent of hvWallHint / element_count / stale. It deliberately does
      // NOT use large-centered / pointer-interceptor geometry, so a benign
      // marketing hero (no scrim / no HV phrase) and a normal product/search page
      // both still return 200. Fail-safe: a failed create degrades to the existing
      // structural/ambiguous paths (screenHvMinted stays false).
      let screenHvMinted = false;
      // capture-and-skip exploration mode wins over VGC minting: suppress the mint so
      // this blocker episode is captured + returned as a 422 skip, never a 409 VGC.
      if (
        !hvMember &&
        screenHv?.wall === true &&
        isVisualGestureCapsuleEnabled() &&
        !isVisionCaptureAndSkipEnabled() &&
        session.cdp_url
      ) {
        let hvDomain = "unknown";
        try {
          if (snapshot.url) hvDomain = new URL(snapshot.url).hostname;
        } catch {
          /* keep "unknown" */
        }
        const hvRequest = createOrReuseHumanVerificationRequest({
          user_id: MOCK_USER_ID,
          delegation_id: delegation.id,
          agent_name: delegation.agent_name,
          browser_session_id: session.browser_session_id,
          domain: hvDomain,
          page_url: snapshot.url ?? "",
          challenge_type: screenHv.challenge_type ?? "unknown_human_verification",
          surface_title: "Verification required",
          page_level: true,
        });
        pageLevelHv = hvRequest.page_level === true;
        const created = await createVisualGestureCapsuleForOpaqueHv({
          humanVerificationRequestId: hvRequest.request_id,
          browserSessionId: session.browser_session_id,
          domain: hvDomain,
          cdpUrl: session.cdp_url,
          pageUrl: snapshot.url ?? "",
          delegationId: delegation.id,
          userId: MOCK_USER_ID,
          reason: "screen_hv_visible_wall",
        });
        if (created.ok) {
          screenHvMinted = true;
          vgcSnapshotInfo = { available: true, capsule: created.capsule };
          hvSnapshotInfo = {
            request_id: hvRequest.request_id,
            status: hvRequest.status,
            challenge_type: hvRequest.challenge_type,
            domain: hvRequest.domain,
            expires_at: hvRequest.expires_at,
            instructions: hvRequest.instructions,
            next_action: humanVerificationAgentNextAction(hvRequest),
            page_level: true as const,
          };
          snapshotMintedHv = {
            request: {
              request_id: hvRequest.request_id,
              status: hvRequest.status,
              challenge_type: hvRequest.challenge_type,
              domain: hvRequest.domain,
            },
            vgc: vgcSnapshotInfo,
          };
          snapshotHvDebug = {
            scope: "snapshot_screen_hv",
            tool: "antigen_snapshot",
            returned_409: true,
            reason: "screen_hv_visible_wall",
            screen_hv_detected: true,
            page_level: true,
            hv_wall_hint: hvWallHint,
            viewport_scrim_seen: screenHv.viewport_scrim_seen,
            centered_modal_seen: screenHv.centered_modal_seen,
            press_hold_affordance_seen: screenHv.press_hold_affordance_seen,
            hv_phrase_seen: screenHv.hv_phrase_seen,
            top_layer_dialog_seen: screenHv.top_layer_dialog_seen,
            created_capsule: true,
            element_count_bucket: hvElementCountBucket(elements.length),
          };
        }
      }
      // Page-level fallback: run the confirming probe when NO per-candidate HV
      // member was found AND either (a) the cheap hint fired — strong HV text +
      // an inaccessible iframe — which catches the live B&BW OVERLAY wall whose
      // background DOM is preserved (high element_count), OR (b) the page is
      // (near-)empty of candidates — the full-denial wall shape. Best-effort and
      // fail-safe (null on any error). The hint is false on clean pages, so
      // normal snapshots pay no extra round-trip; never runs when flag off.
      const pageWallAttempted =
        !hvMember && !screenHvMinted && (hvWallHint || elements.length <= PAGE_HV_PROBE_MAX_ELEMENTS);
      const pageWall = pageWallAttempted
        ? await detectPageHumanVerificationWallViaCDP({
            cdpUrl: session.cdp_url,
            resolvedTarget,
          })
        : null;

      // ── HV debug telemetry (dev-only; gated by ANTIGEN_HV_DEBUG below) ──
      // page_wall_probe_result reflects the PRODUCTION probe outcome only; the
      // separate debug probe contributes the granular *_flags and an error code
      // for the null-vs-error question. Both never affect classification.
      if (isHvDebugEnabled()) {
        const reason: PageWallProbeReason = hvMember
          ? "skipped_hv_member"
          : hvWallHint
            ? "hv_wall_hint"
            : elements.length <= PAGE_HV_PROBE_MAX_ELEMENTS
              ? "low_element_count"
              : "skipped_clean";
        const prodResult: PageWallProbeResult = !pageWallAttempted
          ? "not_attempted"
          : pageWall
            ? "positive"
            : "null";
        hvDebug = {
          hv_enabled: true,
          elements_count: elements.length,
          hv_member_found: !!hvMember,
          hv_wall_hint: hvWallHint,
          page_wall_probe_considered: !hvMember,
          page_wall_probe_attempted: pageWallAttempted,
          page_wall_probe_reason: reason,
          page_wall_probe_result: prodResult,
          // Screen-HV visible-wall consideration (populated whether or not it
          // minted). screen_hv_detected reflects the iframe-independent verdict.
          screen_hv_considered: !hvMember,
          screen_hv_detected: screenHv?.wall === true,
          ...(screenHv?.challenge_type ? { screen_hv_challenge_type: screenHv.challenge_type } : {}),
          screen_hv_viewport_scrim_seen: screenHv?.viewport_scrim_seen === true,
          screen_hv_centered_modal_seen: screenHv?.centered_modal_seen === true,
          screen_hv_press_hold_affordance_seen: screenHv?.press_hold_affordance_seen === true,
          screen_hv_phrase_seen: screenHv?.hv_phrase_seen === true,
          screen_hv_top_layer_dialog_seen: screenHv?.top_layer_dialog_seen === true,
          screen_hv_created_capsule: screenHvMinted,
          screen_hv_failure_reason: deriveScreenHvFailureReason(screenHv),
        };
        // Only run the extra debug probe when production actually attempted —
        // never on clean snapshots — so it can reveal WHICH gate failed.
        if (pageWallAttempted) {
          const dbg = await collectPageHvWallDebugViaCDP({ resolvedTarget });
          if (dbg.result === "error") {
            hvDebug.page_wall_probe_error_code = dbg.error_code;
          } else {
            hvDebug.top_doc_title_flags = dbg.signals.top_doc_title_flags;
            hvDebug.top_doc_text_flags = dbg.signals.top_doc_text_flags;
            hvDebug.iframe_flags = dbg.signals.iframe_flags;
            hvDebug.blocker_flags = dbg.signals.blocker_flags;
            hvDebug.overlay_intercept_flags = dbg.signals.overlay_intercept_flags;
            hvDebug.oopif_flags = dbg.signals.oopif_flags;
            hvDebug.would_classify_oopif = dbg.signals.would_classify_oopif;
          }
        }
      }

      if (hvMember || pageWall) {
        let hvDomain = "unknown";
        try {
          if (snapshot.url) hvDomain = new URL(snapshot.url).hostname;
        } catch {
          /* keep "unknown" */
        }
        const isPageLevel = !hvMember && !!pageWall;
        const hvRequest = createOrReuseHumanVerificationRequest({
          user_id: MOCK_USER_ID,
          delegation_id: delegation.id,
          agent_name: delegation.agent_name,
          browser_session_id: session.browser_session_id,
          domain: hvDomain,
          page_url: snapshot.url ?? "",
          challenge_type: hvMember
            ? hvMember.overlay?.hv_challenge_type ?? "unknown_human_verification"
            : pageWall!.hv_challenge_type,
          surface_title: hvMember ? hvMember.overlay?.modal_title : "Access challenge",
          page_level: isPageLevel,
        });
        pageLevelHv = hvRequest.page_level === true;
        hvSnapshotInfo = {
          request_id: hvRequest.request_id,
          status: hvRequest.status,
          challenge_type: hvRequest.challenge_type,
          domain: hvRequest.domain,
          expires_at: hvRequest.expires_at,
          instructions: hvRequest.instructions,
          next_action: humanVerificationAgentNextAction(hvRequest),
          ...(hvRequest.page_level ? { page_level: true as const } : {}),
        };
        // Page-level (opaque) wall ONLY: the control lives in an inaccessible
        // cross-origin iframe (zero/near-zero candidates — the full-page denied /
        // press-and-hold shape), so there is no DOM control_box for a live relay.
        // When the VGC flag is on, mint a Visual Gesture Capsule + first redacted
        // frame so the snapshot can fail closed with a screenshot-point relay — the
        // SAME behavior as the action-triggered path (rejectNoProgressActionAs-
        // HumanVerification). Fail-safe: the orchestrator never throws, and a failed
        // create/capture leaves snapshotMintedHv undefined → the response degrades to
        // the pre-VGC 200 synthesized-surface behavior (byte-identical when off).
        // hvMember (a per-element overlay with a real control box) is deliberately
        // excluded — it keeps the DOM live-relay path.
        // capture-and-skip exploration mode wins over VGC minting (see above).
        if (
          isPageLevel &&
          isVisualGestureCapsuleEnabled() &&
          !isVisionCaptureAndSkipEnabled() &&
          session.cdp_url
        ) {
          const created = await createVisualGestureCapsuleForOpaqueHv({
            humanVerificationRequestId: hvRequest.request_id,
            browserSessionId: session.browser_session_id,
            domain: hvDomain,
            cdpUrl: session.cdp_url,
            pageUrl: snapshot.url ?? "",
            delegationId: delegation.id,
            userId: MOCK_USER_ID,
            reason: "opaque_hv_no_control_box",
          });
          if (created.ok) {
            vgcSnapshotInfo = { available: true, capsule: created.capsule };
            snapshotMintedHv = {
              request: {
                request_id: hvRequest.request_id,
                status: hvRequest.status,
                challenge_type: hvRequest.challenge_type,
                domain: hvRequest.domain,
              },
              vgc: vgcSnapshotInfo,
            };
            snapshotHvDebug = {
              scope: "snapshot_hv",
              tool: "antigen_snapshot",
              returned_409: true,
              reason: "structural_page_level_wall",
              structural_wall_seen: true,
              page_level: true,
              ambiguous_considered: false,
              created_capsule: true,
              element_count_bucket: hvElementCountBucket(elements.length),
            };
          }
        }
      } else {
        // No structural HV wall. Ambiguous visual-obstruction fallback: a live page
        // may be visually blocked (opaque overlay / denial wall) without the DOM/ref
        // pipeline exposing a control. Probe on the same cost discipline as the wall
        // probe (low element count or the cheap hint) — clean, element-rich pages pay
        // nothing and behavior is byte-identical when off. Part D: ALSO probe a
        // high-element page when a recent no-progress marker is set (a prior action
        // failed to realize, likely behind a visual overlay), which is the overlay-
        // over-normal-page shape element_count alone would otherwise skip.
        let ambiguous:
          | { request: HumanVerificationRequest; vgc: { available: true; capsule: SafeVisualGestureCapsuleView } }
          | undefined;
        const noProgressSignal = hasRecentActionNoProgress(session.browser_session_id);
        const ambiguousGateOpen =
          !screenHvMinted &&
          isVisualGestureCapsuleEnabled() &&
          // capture-and-skip exploration mode wins over VGC minting (see above).
          !isVisionCaptureAndSkipEnabled() &&
          (hvWallHint || elements.length <= PAGE_HV_PROBE_MAX_ELEMENTS || noProgressSignal);
        let ambiguousProbe: Awaited<ReturnType<typeof detectAmbiguousVisualObstructionViaCDP>> = null;
        let ambiguousSkipReason: HumanVerificationDebug["ambiguous_skip_reason"];
        if (ambiguousGateOpen) {
          // Fail-safe: a probe/create throw must never fail the snapshot — it
          // degrades to the existing clear-state path (ambiguous stays undefined).
          try {
            ambiguousProbe = await detectAmbiguousVisualObstructionViaCDP({
              cdpUrl: session.cdp_url,
              resolvedTarget,
            });
            if (ambiguousProbe) {
              let ambiguousDomain = "unknown";
              try {
                if (snapshot.url) ambiguousDomain = new URL(snapshot.url).hostname;
              } catch {
                /* keep "unknown" */
              }
              ambiguous = await maybeCreateVisualGestureCapsuleForAmbiguousVisualBlock({
                session,
                delegation,
                domain: ambiguousDomain,
                pageUrl: snapshot.url ?? "",
                // The authoritative interactive count is the extracted element_count.
                // repeated_stale is corroborating-only (never fires alone): set it
                // ONLY when a recent no-progress marker corroborates a high-element
                // overlay — the low-element path stays byte-identical.
                signals: {
                  ...ambiguousProbe,
                  near_zero_interactive: elements.length <= PAGE_HV_PROBE_MAX_ELEMENTS,
                  ...(noProgressSignal ? { repeated_stale: true } : {}),
                },
              });
              ambiguousSkipReason = ambiguous ? "fired" : "classifier_false";
            } else {
              ambiguousSkipReason = "probe_returned_null";
            }
          } catch {
            ambiguous = undefined;
            ambiguousSkipReason = "helper_failed";
          }
        } else {
          ambiguousSkipReason = !isVisualGestureCapsuleEnabled()
            ? "vgc_flag_off"
            : "element_count_too_high_and_no_hint";
        }
        // Dev-only ambiguous-fallback telemetry — only when hvDebug was built (i.e.
        // ANTIGEN_HV_DEBUG on). Booleans / enums only; never a capsule id.
        if (hvDebug) {
          hvDebug.ambiguous_fallback_considered = ambiguousGateOpen;
          hvDebug.ambiguous_skip_reason = ambiguousSkipReason;
          hvDebug.ambiguous_element_count = elements.length;
          hvDebug.ambiguous_hv_wall_hint = !!hvWallHint;
          hvDebug.ambiguous_repeated_stale = noProgressSignal;
          if (ambiguousProbe) {
            hvDebug.ambiguous_denial_text_seen = ambiguousProbe.denial_text_seen;
            hvDebug.ambiguous_near_zero_interactive = ambiguousProbe.near_zero_interactive;
            hvDebug.ambiguous_visible_inaccessible_iframe_seen =
              ambiguousProbe.visible_inaccessible_iframe_seen;
            hvDebug.ambiguous_large_centered_overlay_seen =
              ambiguousProbe.large_centered_overlay_seen;
            hvDebug.ambiguous_viewport_scrim_seen = ambiguousProbe.viewport_scrim_seen;
            hvDebug.ambiguous_pointer_interceptor_seen = ambiguousProbe.pointer_interceptor_seen;
            hvDebug.ambiguous_top_layer_dialog_seen = ambiguousProbe.top_layer_dialog_seen;
            // ── Surface-Boundary Router SHADOW decision (observational only) ──
            // What a future router WOULD do with this surface. Never branched on.
            const sb = classifySurfaceBoundary(ambiguousProbe);
            hvDebug.surface_boundary_route_decided = sb.route_decided;
            hvDebug.surface_boundary_trigger_basis = sb.trigger_basis;
            hvDebug.surface_inspectability_class = sb.inspectability_class;
            hvDebug.surface_opaque_dominant_with_bg_dom_contradiction =
              sb.opaque_dominant_surface_with_background_dom_contradiction;
            hvDebug.surface_newly_appeared = sb.surface_newly_appeared;
            hvDebug.surface_overlaps_agent_target = sb.surface_overlaps_agent_target;
            hvDebug.surface_visible_cross_origin_iframe_seen =
              ambiguousProbe.visible_cross_origin_iframe_seen;
            hvDebug.surface_opaque_iframe_seen = ambiguousProbe.opaque_iframe_seen;
            hvDebug.surface_off_path_iframe_seen = ambiguousProbe.off_path_iframe_seen;
            hvDebug.surface_opaque_dominant_surface_seen =
              ambiguousProbe.opaque_dominant_surface_seen;
            hvDebug.surface_text_inspectable = ambiguousProbe.surface_text_inspectable;
            hvDebug.surface_text_uninspectable = ambiguousProbe.surface_text_uninspectable;
            hvDebug.surface_over_main_content = ambiguousProbe.surface_over_main_content;
            hvDebug.surface_blocks_viewport_center = ambiguousProbe.surface_blocks_viewport_center;
            hvDebug.surface_normal_page_dom_present_behind =
              ambiguousProbe.normal_page_dom_present_behind_surface;
            hvDebug.surface_visual_dom_contradiction_seen =
              ambiguousProbe.visual_dom_contradiction_seen;
          }
          hvDebug.ambiguous_created_capsule = !!ambiguous;
        }
        if (ambiguous) {
          const r = ambiguous.request;
          hvSnapshotInfo = {
            request_id: r.request_id,
            status: r.status,
            challenge_type: r.challenge_type,
            domain: r.domain,
            expires_at: r.expires_at,
            instructions: r.instructions,
            next_action: humanVerificationAgentNextAction(r),
          };
          vgcSnapshotInfo = ambiguous.vgc;
          // A capsule was freshly minted — fail closed with 409 below (same as the
          // structural page-level wall and the action-triggered path) so the user can
          // relay the gesture immediately rather than on the next snapshot.
          snapshotMintedHv = {
            request: {
              request_id: r.request_id,
              status: r.status,
              challenge_type: r.challenge_type,
              domain: r.domain,
            },
            vgc: ambiguous.vgc,
          };
          // Attribution for the ambiguous branch — the suspected healthy-cart false-
          // positive path. repeated_stale_source = "no_progress_marker" means the
          // corroborating stale signal was re-derived from a lingering action marker
          // (NOT a fresh action), and geometry_strength comes from the RAW probe
          // (before repeated_stale was synthesized in) so a "weak" reading (lone
          // pointer_interceptor / sticky header) is distinguishable from a "strong"
          // occlusion. This is what makes the next /cart 409 self-attributing.
          snapshotHvDebug = {
            scope: "snapshot_hv",
            tool: "antigen_snapshot",
            returned_409: true,
            reason: "ambiguous_fired",
            structural_wall_seen: false,
            ambiguous_considered: true,
            created_capsule: true,
            no_progress_signal: noProgressSignal,
            repeated_stale_source: noProgressSignal ? "no_progress_marker" : "none",
            geometry_strength: geometryObstructionStrength(ambiguousProbe) ?? "none",
            element_count_bucket: hvElementCountBucket(elements.length),
            ...(ambiguousProbe
              ? {
                  denial_text_seen: ambiguousProbe.denial_text_seen,
                  near_zero_interactive: ambiguousProbe.near_zero_interactive,
                  visible_inaccessible_iframe_seen: ambiguousProbe.visible_inaccessible_iframe_seen,
                  large_centered_overlay_seen: ambiguousProbe.large_centered_overlay_seen,
                  viewport_scrim_seen: ambiguousProbe.viewport_scrim_seen,
                  pointer_interceptor_seen: ambiguousProbe.pointer_interceptor_seen,
                  top_layer_dialog_seen: ambiguousProbe.top_layer_dialog_seen,
                }
              : {}),
          };
          // HV is now active for this session — the no-progress marker has served
          // its purpose and must not linger to re-probe later snapshots.
          clearActionNoProgress(session.browser_session_id);
        } else if (!screenHvMinted) {
          // Skipped when the screen-HV path just minted this snapshot's capsule —
          // the page IS blocked, so the no-longer-present cleanup must not run and
          // tear down the request/capsule we just created.
          const openRequest = findActiveHumanVerificationRequest(session.browser_session_id);
          if (openRequest) resolveChallengeNoLongerPresent(openRequest);
          clearActiveHumanVerification(session.browser_session_id);
          // Clear state: the page is no longer blocked, so drop the no-progress
          // marker too (it must not survive into a healthy resumed session).
          clearActionNoProgress(session.browser_session_id);
          // First fresh snapshot after a completion drives agent-resume audit.
          for (const r of humanVerificationRequests.values()) {
            if (
              r.browser_session_id === session.browser_session_id &&
              r.status === "completed" &&
              !r.resumed_at
            ) {
              r.resumed_at = new Date().toISOString();
              humanVerificationRequests.set(r.request_id, r);
              schedulePersist();
            }
          }
        }
      }

      // ── Always-on snapshot HV gate telemetry (dev-only; ANTIGEN_HV_DEBUG) ──
      // The rich `hvDebug` object above is only attached to the 200 RESPONSE BODY
      // (human_verification_debug). When a snapshot does NOT mint (the preserved-
      // background wall case), nothing reaches the LOG stream — exactly why a live
      // screen-HV miss was invisible while `no_progress_backstop` lines showed up.
      // This single console line emits the screen-HV consideration on EVERY snapshot
      // (mint or not) so the failing sub-gate is attributable from logs alone.
      // Booleans/enums/buckets only — never text, selectors, coords, iframe src,
      // screenshots, target ids, or raw DOM. Byte-identical when the flag is off.
      //
      // The surface signals + shadow decision are also the input to the (shadow)
      // VisualBlockerClassifierPipeline, so this block runs when EITHER hv_debug or
      // the vision-classifier flag is on. hv_debug still controls ONLY the debug
      // output below; the vision flag independently controls the pipeline. Both off
      // ⇒ byte-identical.
      if (isHvDebugEnabled() || isHvVisionClassifierEnabled()) {
        // ── Surface-Boundary Router SHADOW decision on EVERY snapshot ──
        // Merge BOTH probes: the ambiguous geometry probe's booleans (copied onto
        // hvDebug above when it ran) and the always-present screen-scan signals. The
        // screen scan is what catches the same-origin / textless dominant wall (the
        // live B&BW/PerimeterX "Press & Hold" case) that the iframe-only signals miss.
        // Observational ONLY — never branched on, never mints a capsule.
        const surfaceSignals: SurfaceBoundarySignals = {
          opaque_iframe_seen: hvDebug?.surface_opaque_iframe_seen,
          off_path_iframe_seen: hvDebug?.surface_off_path_iframe_seen,
          visual_dom_contradiction_seen: hvDebug?.surface_visual_dom_contradiction_seen,
          surface_over_main_content: hvDebug?.surface_over_main_content,
          surface_blocks_viewport_center: hvDebug?.surface_blocks_viewport_center,
          surface_text_inspectable: hvDebug?.surface_text_inspectable,
          viewport_scrim_seen: hvDebug?.ambiguous_viewport_scrim_seen,
          large_centered_overlay_seen: hvDebug?.ambiguous_large_centered_overlay_seen,
          normal_page_dom_present_behind_surface: hvDebug?.surface_normal_page_dom_present_behind,
          screen_viewport_scrim_seen: screenHv?.viewport_scrim_seen === true,
          screen_centered_modal_seen: screenHv?.centered_modal_seen === true,
          surface_dominant_visible_surface_seen: screenHv?.dominant_visible_surface_seen === true,
          surface_dominant_visible_surface_kind: screenHv?.dominant_visible_surface_kind,
          surface_dominant_text_extraction_attempted:
            screenHv?.dominant_text_extraction_attempted === true,
          surface_dominant_text_extractable: screenHv?.dominant_text_extractable === true,
          surface_dominant_text_uninspectable: screenHv?.dominant_text_uninspectable === true,
          surface_visible_but_semantically_unclassified:
            screenHv?.visible_but_semantically_unclassified === true,
          // Page-level HV wall inputs: a full-page terminal blocker DOCUMENT (no scrim,
          // no iframe, near-zero usable refs) where the page itself is the wall. The
          // strong screen-HV TEXT signals are reported independently of the scrim gate.
          // page_wall_attempted is corroborating telemetry only (never a trigger).
          screen_hv_phrase_seen: screenHv?.hv_phrase_seen === true,
          screen_press_hold_affordance_seen: screenHv?.press_hold_affordance_seen === true,
          page_appears_unusable: elements.length <= PAGE_HV_PROBE_MAX_ELEMENTS,
          // Strong usable-page evidence: a normal product grid / nav / search / cart
          // page has many interactive refs (well above the unusable floor of 3 and
          // above small cookie/login modals). Drives the Route 2 usable-page veto.
          page_has_rich_interactive_content:
            elements.length >= USABLE_PAGE_RICH_INTERACTIVE_MIN,
          page_wall_attempted: pageWallAttempted,
        };
        const surfaceDecision = classifySurfaceBoundary(surfaceSignals);
        // hv_debug controls ONLY the existing snapshot_hv_gate debug output and the
        // surface_* fields on the response's human_verification_debug object. Keeping
        // these inside this guard preserves byte-identical responses when hv_debug is
        // off (even if the vision-classifier flag is on).
        if (isHvDebugEnabled()) {
        if (hvDebug) {
          hvDebug.surface_boundary_route_decided = surfaceDecision.route_decided;
          hvDebug.surface_boundary_trigger_basis = surfaceDecision.trigger_basis;
          hvDebug.surface_inspectability_class = surfaceDecision.inspectability_class;
          hvDebug.surface_visual_classifier_candidate_reason =
            surfaceDecision.visual_classifier_candidate_reason;
          hvDebug.surface_boundary_usable_page_veto = surfaceDecision.usable_page_veto_applied;
          hvDebug.surface_boundary_veto_reason = surfaceDecision.usable_page_veto_reason;
          hvDebug.surface_dominant_visible_surface_seen =
            screenHv?.dominant_visible_surface_seen === true;
          hvDebug.surface_dominant_visible_surface_kind =
            screenHv?.dominant_visible_surface_kind ?? "unknown";
          hvDebug.surface_dominant_text_extraction_attempted =
            screenHv?.dominant_text_extraction_attempted === true;
          hvDebug.surface_dominant_text_extractable = screenHv?.dominant_text_extractable === true;
          hvDebug.surface_dominant_text_uninspectable =
            screenHv?.dominant_text_uninspectable === true;
          hvDebug.surface_visible_but_semantically_unclassified =
            screenHv?.visible_but_semantically_unclassified === true;
          hvDebug.surface_dominant_surface_contains_iframe =
            screenHv?.dominant_surface_contains_iframe === true;
          hvDebug.surface_dominant_surface_iframe_text_not_harvested =
            screenHv?.dominant_surface_iframe_text_not_harvested === true;
          hvDebug.surface_unreadable_dominant_surface_seen =
            screenHv?.unreadable_dominant_surface_seen === true;
        }
        logHvActionDebug({
          scope: "snapshot_hv_gate",
          tool: "antigen_snapshot",
          hv_member_present: !!hvMember,
          hv_wall_hint: hvWallHint,
          screen_hv_considered: !hvMember,
          screen_hv_detected: screenHv?.wall === true,
          screen_hv_challenge_type: screenHv?.challenge_type ?? "none",
          screen_viewport_scrim_seen: screenHv?.viewport_scrim_seen === true,
          screen_centered_modal_seen: screenHv?.centered_modal_seen === true,
          screen_press_hold_affordance_seen: screenHv?.press_hold_affordance_seen === true,
          screen_hv_phrase_seen: screenHv?.hv_phrase_seen === true,
          screen_top_layer_dialog_seen: screenHv?.top_layer_dialog_seen === true,
          page_wall_attempted: pageWallAttempted,
          ambiguous_gate_open: hvDebug?.ambiguous_fallback_considered === true,
          element_count_bucket: hvElementCountBucket(elements.length),
          returned_409: !!snapshotMintedHv,
          created_capsule: !!snapshotMintedHv,
          screen_hv_failure_reason: deriveScreenHvFailureReason(screenHv),
          // Surface-boundary shadow decision (route a future router WOULD take).
          surface_boundary_route_decided: surfaceDecision.route_decided,
          surface_boundary_trigger_basis: surfaceDecision.trigger_basis,
          surface_inspectability_class: surfaceDecision.inspectability_class,
          surface_visual_classifier_candidate_reason:
            surfaceDecision.visual_classifier_candidate_reason,
          surface_boundary_usable_page_veto: surfaceDecision.usable_page_veto_applied,
          surface_boundary_veto_reason: surfaceDecision.usable_page_veto_reason,
          surface_dominant_visible_surface_seen: screenHv?.dominant_visible_surface_seen === true,
          surface_dominant_visible_surface_kind: screenHv?.dominant_visible_surface_kind ?? "unknown",
          surface_dominant_text_extractable: screenHv?.dominant_text_extractable === true,
          surface_dominant_text_uninspectable: screenHv?.dominant_text_uninspectable === true,
          surface_visible_but_semantically_unclassified:
            screenHv?.visible_but_semantically_unclassified === true,
          surface_dominant_surface_contains_iframe:
            screenHv?.dominant_surface_contains_iframe === true,
          surface_dominant_surface_iframe_text_not_harvested:
            screenHv?.dominant_surface_iframe_text_not_harvested === true,
          surface_unreadable_dominant_surface_seen:
            screenHv?.unreadable_dominant_surface_seen === true,
        });
        } // end hv_debug-only output

        // ── VisualBlockerClassifierPipeline — Phase 1 SHADOW (vision-flag-gated) ──
        // Runs only when the SurfaceBoundaryRouter already decided this surface needs
        // visual classification. SHADOW ONLY: the outcome is discarded — never branched
        // on, never mints a VGC, never returns a 409, never mutates the response body.
        // It emits safe booleans/enums/buckets/ids telemetry and a stub policy with
        // enforced:false. Independent of hv_debug.
        if (
          isHvVisionClassifierEnabled() &&
          surfaceDecision.route_decided === "visual_classifier_candidate"
        ) {
          let visionDomain = "unknown";
          try {
            if (snapshot.url) visionDomain = new URL(snapshot.url).hostname;
          } catch {
            /* keep "unknown" — never throw from the shadow path */
          }
          const visionOutcome = runVisualBlockerClassifierPipeline({
            surfaceDecision,
            surfaceSignals,
            browserSessionId: session.browser_session_id,
            domain: visionDomain,
          });

          // ── Phase 2A — dev-only redacted dataset capture (dataset-flag-gated) ──
          // Additional opt-in on top of the classifier flag. Off-flag ⇒ this branch is
          // skipped entirely — behavior byte-identical. No bytes/paths/values leak into
          // the response in either mode.
          if (isVisionCaptureAndSkipEnabled() && isHvVisionDatasetEnabled() && visionOutcome.ran) {
            // ── Exploration / data-gathering mode ──
            // AWAIT the existing capture so we can honestly report written/attempted/
            // skipped, then return a 422 skip below. cdp_url may be absent → capture
            // returns no_session → capture_skipped → we STILL skip (blocker is present).
            // The capture never throws; any rejection maps to capture_attempted.
            const captureResult = await captureVisionDatasetRecord({
              outcome: visionOutcome,
              cdpUrl: session.cdp_url ?? null,
            }).catch(() => ({ written: false as const, skip_reason: "write_failed" as const }));
            snapshotVisualBlockerSkip = {
              candidate: visionOutcome.candidate,
              blocker_status: mapCaptureResultToBlockerStatus(captureResult),
            };
            // Safe telemetry (no-op when ANTIGEN_HV_DEBUG off). Booleans/enums only.
            logHvActionDebug({
              scope: "snapshot_capture_and_skip",
              tool: "antigen_snapshot",
              capture_and_skip_enabled: true,
              capture_and_skip_returned_422: true,
              capture_and_skip_blocker_status: snapshotVisualBlockerSkip.blocker_status,
              capture_and_skip_suppressed_vgc: true,
              trigger_basis: snapshotVisualBlockerSkip.candidate.trigger_basis,
              candidate_reason: snapshotVisualBlockerSkip.candidate.candidate_reason,
            });
          } else if (isHvVisionDatasetEnabled() && visionOutcome.ran && session.cdp_url) {
            // ── Normal dataset mode — UNCHANGED fire-and-forget ──
            // It writes a gitignored frame.png + safe meta.json LOCALLY and can never
            // affect this request (void + .catch, never awaited, never throws).
            void captureVisionDatasetRecord({
              outcome: visionOutcome,
              cdpUrl: session.cdp_url,
            }).catch(() => {
              /* dev-only capture is best-effort and must never surface to the agent */
            });
          }
        }
      }
    }

    // ── ANTIGEN_VISION_CAPTURE_AND_SKIP exploration mode ──
    // A visual_classifier_candidate was captured for the training set. Return a safe
    // 422 skip signal so the agent abandons this path — NOT a VGC, NOT a 409
    // HUMAN_VERIFICATION_REQUIRED (VGC minting is suppressed above in this mode, so
    // snapshotMintedHv is undefined here; ordering this first makes precedence explicit).
    // The body is safe-fields only (buildVisualBlockerCapturedResponse enforces it):
    // no screenshot path, base64, crop geometry, URL, iframe src, raw text,
    // candidate_id, domain, or challenge details.
    if (snapshotVisualBlockerSkip) {
      reply.status(422).send(buildVisualBlockerCapturedResponse(snapshotVisualBlockerSkip));
      return;
    }

    // Fail closed when THIS snapshot freshly minted a Visual Gesture Capsule (a
    // full-page denied / press-and-hold wall at element_count 0, or an ambiguous
    // visual obstruction). Return the canonical 409 HUMAN_VERIFICATION_REQUIRED with
    // the safe capsule view — the SAME shape the action-triggered path emits — so the
    // user relays the gesture in the Aegis UI now, not on a later snapshot. Subsequent
    // snapshots short-circuit on the pre-extract guard (rejectIfVisualGestureCapsuleActive)
    // until the capsule clears. No bytes/coords/cdp/refs leak — sendHumanVerification-
    // Required + getSafeVisualGestureCapsuleView enforce that.
    if (snapshotMintedHv) {
      sendHumanVerificationRequired(
        session,
        reply,
        "antigen_snapshot",
        snapshotMintedHv.request,
        snapshotMintedHv.vgc,
        snapshotHvDebug,
      );
      return;
    }

    timing.mark("record_store_and_pagemap");

    // External elements + per-element qualitative status (additive, safe). When
    // a ref is the active overlay's primary CTA, flag it so the agent can act on
    // the modal first. `is_primary` comes from the page map's primary set — never
    // recomputed from raw names here.
    const overlayPrimaryRefs = new Set(pageMap.active_overlay?.primary_action_refs ?? []);
    const externalElements = elements.map((el) => {
      const ext = toExternalAntigenSnapshotElement(el);
      if (ext.overlay && overlayPrimaryRefs.has(el.ref)) {
        ext.overlay = { ...ext.overlay, is_primary: true };
      }
      const st = pageMap.ref_status[el.ref];
      const base = st
        ? {
            ...ext,
            viewport_status: st.viewport_status,
            scroll_required: st.scroll_required,
            stability_hint: st.stability_hint,
          }
        : ext;
      // Background-behind-blocking-surface annotation (flag-gated, boolean only):
      // tells the agent this ref is likely unclickable/churning while a blocking
      // surface is up, so it prefers the surface's recommended actions instead.
      return likelyBlockedRefs.has(el.ref)
        ? { ...base, likely_blocked_by_overlay: true as const }
        : base;
    });

    const evidence = {
      snapshot_id: snapshot.snapshot_id,
      captured_at: snapshot.created_at,
      ...(pageMap.page_summary.url_host ? { url_host: pageMap.page_summary.url_host } : {}),
      ...(pageMap.page_summary.url_path ? { url_path: pageMap.page_summary.url_path } : {}),
      viewport_only: viewportOnly,
      element_count: pageMap.evidence_partial.element_count,
      clickable_count: pageMap.evidence_partial.clickable_count,
      typeable_count: pageMap.evidence_partial.typeable_count,
      ...(pageMap.evidence_partial.visible_text_hash
        ? { visible_text_hash: pageMap.evidence_partial.visible_text_hash }
        : {}),
    };

    // Counts only — never element names, values, refs, text, or coordinates.
    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "antigen_snapshot", browser_runtime_id: session.browser_session_id,
      tool: "antigen_snapshot", url_after: sanitizeTraceUrl(snapshot.url),
      snapshot: {
        viewport_only: viewportOnly,
        element_count: snapshot.element_count,
        clickable_count: pageMap.evidence_partial.clickable_count,
        typeable_count: pageMap.evidence_partial.typeable_count,
        primary_action_count: pageMap.primary_actions.length,
        warning_count: pageMap.warnings_or_modals.length,
        // Booleans only — never overlay titles, refs, or text.
        overlay_present: pageMap.active_overlay !== undefined,
        overlay_blocking: pageMap.active_overlay?.blocking === true,
      },
      result_code: "antigen_snapshot_success",
      total_ms: Date.now() - tToolStart,
    });

    timing.mark("serialize");

    // Page-level human-verification wall: synthesize a single blocking active
    // surface so the agent gets a useful blocking surface even though
    // element_count is 0 and the candidate-based surface builder produced none.
    // No actions — the control is in a cross-origin iframe; manual completion
    // only. Emitted under ANTIGEN_HUMAN_VERIFICATION (independent of the
    // ANTIGEN_ACTIVE_SURFACES flag).
    const pageLevelSurfaces =
      pageLevelHv && hvSnapshotInfo
        ? [
            {
              surface_id: "surf_hv_page",
              surface_type: "dialog" as const,
              blocking: true,
              dismissible: false,
              actions: [],
              surface_kind: "human_verification" as const,
              challenge_type: hvSnapshotInfo.challenge_type as HumanVerificationChallengeType,
              user_presence_required: true as const,
              page_level: true as const,
            },
          ]
        : [];

    const responsePayload = {
      ok: true,
      data: {
        snapshot_id: snapshot.snapshot_id,
        // The runtime this snapshot is actually bound to. After a rebind this differs
        // from the request id — callers should adopt it for subsequent ref actions.
        browser_runtime_id: session.browser_session_id,
        rebound,
        effective_mode: session.mode,
        snapshot_ready: true,
        url: snapshot.url,
        title: snapshot.title,
        expires_at: snapshot.expires_at,
        snapshot_ttl_ms: ANTIGEN_SNAPSHOT_TTL_MS,
        // Remaining lifetime at response time so the adapter/agent can plan a
        // proactive re-snapshot before a long reasoning step rather than
        // discovering expiry on a failed action.
        ref_expires_in_ms: Math.max(0, new Date(snapshot.expires_at).getTime() - Date.now()),
        element_count: snapshot.element_count,
        page_summary: pageMap.page_summary,
        current_scroll: pageMap.current_scroll,
        evidence,
        primary_actions: pageMap.primary_actions,
        secondary_actions: pageMap.secondary_actions,
        navigation: pageMap.navigation,
        forms: pageMap.forms,
        product_cards: pageMap.product_cards,
        warnings_or_modals: pageMap.warnings_or_modals,
        ...(pageMap.active_overlay ? { active_overlay: pageMap.active_overlay } : {}),
        // Active Surfaces v1 (flag-gated): semantic surface view + recommended
        // safe actions. `likely_blocked_refs` stays internal — elements carry the
        // boolean annotation instead.
        ...(activeSurfaces || pageLevelSurfaces.length > 0
          ? {
              active_surfaces: [...pageLevelSurfaces, ...(activeSurfaces?.surfaces ?? [])],
              recommended_actions: activeSurfaces?.recommended_actions ?? [],
              // The page-level HV block below sets the authoritative next step.
              ...(activeSurfaces?.recommended_next_step && !pageLevelHv
                ? { recommended_next_step: activeSurfaces.recommended_next_step }
                : {}),
            }
          : {}),
        // Human Presence Relay (flag-gated): metadata + guidance only — never
        // selectors, coordinates, or refs of the challenge control. `page_level`
        // marks a cross-origin-iframe wall (manual completion, not live relay).
        ...(hvSnapshotInfo
          ? {
              recommended_next_step: "human_presence_relay_required" as const,
              ...(pageLevelHv ? { page_level_human_verification: true as const } : {}),
              human_verification: {
                ...hvSnapshotInfo,
                user_presence_required: true as const,
                purchase_authorized: false as const,
              },
            }
          : {}),
        // Visual Gesture Capsule (ambiguous visual-obstruction fallback only):
        // safe view ONLY — { available, capsule } with no bytes/coords/cdp/geometry.
        ...(vgcSnapshotInfo ? { visual_gesture_capsule: vgcSnapshotInfo } : {}),
        action_hints: pageMap.action_hints,
        elements: externalElements,
        // Dev-only HV diagnostic — present only when BOTH ANTIGEN_HUMAN_VERIFICATION
        // and ANTIGEN_HV_DEBUG are on (hvDebug is otherwise undefined). Booleans,
        // enums, and buckets only; never raw text/URLs/selectors/geometry/refs.
        ...(hvDebug ? { human_verification_debug: hvDebug } : {}),
      },
    };

    // Sanitized: stage labels + durations + scalar counts only. No URLs/refs/geometry.
    // payload_bytes is computed only when the timing flag is on (stringify is not free).
    timing.end({
      element_count: snapshot.element_count,
      viewport_only: viewportOnly,
      rebound,
      payload_elements: externalElements.length,
      ...(timingEnabled() ? { payload_bytes: JSON.stringify(responsePayload).length } : {}),
    });

    return reply.send(responsePayload);
  });

  // ─── Redacted Screenshot — vision-channel protection ──────────────────────────
  // browser_take_screenshot is intercepted by the Antigen adapter and routed here so
  // protected sensitive values (PAN/CVV/expiry/cardholder/password) that the page
  // renders are never returned to the agent through the vision channel. Redaction is
  // keyed to the REGISTERED protected fields only (`data-antigen-masked="true"`) —
  // never the whole page — and combines a pre-capture DOM overlay with a pixel pass.
  // FAIL-CLOSED: no Aegis runtime / no live target / redaction failure → error, never
  // an unredacted image. The response carries only the redacted image + an aggregate
  // count; no field values, boxes, cdp_url, or raw base64 are ever logged.
  server.post("/api/agent/v1/runtime/browser-screenshot", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

    const body = (req.body ?? {}) as { browser_runtime_id?: unknown };
    if (!body.browser_runtime_id || typeof body.browser_runtime_id !== "string") {
      return sendError(reply, 400, "MISSING_FIELD", "browser_runtime_id is required.");
    }

    // The screenshot path is Aegis-mediated only. Any not-ready / unknown runtime
    // fails closed — there is no native screenshot fallback. (browser-snapshot is the
    // one endpoint that rebinds a stale id; a screenshot must not silently retarget.)
    const runtimeResolution = resolveReadyRuntimeSession(body.browser_runtime_id, delegation.id, MOCK_USER_ID);
    if (runtimeResolution.kind === "forbidden") {
      return sendError(reply, 403, "FORBIDDEN", "This browser session does not belong to your delegation.");
    }
    if (runtimeResolution.kind === "starting" || runtimeResolution.kind === "none" || !runtimeResolution.session.cdp_url) {
      recordBrowserTraceEvent(body.browser_runtime_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: body.browser_runtime_id,
        tool: "browser_take_screenshot",
        error_code: "SCREENSHOT_REQUIRES_ANTIGEN_RUNTIME",
      });
      return sendError(
        reply,
        422,
        "SCREENSHOT_REQUIRES_ANTIGEN_RUNTIME",
        "Screenshots must go through the Aegis-mediated runtime so protected sensitive fields are redacted. Start a task browser session and retry.",
      );
    }
    const session = runtimeResolution.session;

    // Resolve the live CDP target the same way the snapshot/click guards do.
    const resolved = await resolveSnapshotCdpTarget(session.cdp_url);
    if (!resolved) {
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: session.browser_session_id,
        tool: "browser_take_screenshot",
        error_code: "SCREENSHOT_REQUIRES_ANTIGEN_RUNTIME",
      });
      return sendError(
        reply,
        422,
        "SCREENSHOT_REQUIRES_ANTIGEN_RUNTIME",
        "No live page target is available for the Aegis-mediated runtime. Take an antigen_snapshot to confirm the session, then retry.",
      );
    }

    // Protected card fields filled inside cross-origin OPPWA PCI iframes are not
    // discoverable from the top document, so the screenshot path must be told which
    // ones to mark + redact (field-kind enums only). If any cannot be located at
    // capture time, captureRedactedScreenshot fails closed.
    const expectedIframeFields = getProtectedIframeRedactionFields(session.browser_session_id);
    // Top-level protected fields (expiry, cardholder, non-iframe PAN/CVV) must be
    // verified/re-masked at capture time — fill-time DOM markers do not survive
    // hydrated checkout re-renders (the live IKEA expiry leak).
    const expectedTopLevelFields = getProtectedTopLevelRedactionFields(session.browser_session_id);
    const shot = await captureRedactedScreenshot({
      browserWsUrl: resolved.browserWsUrl,
      pageTargetId: resolved.target.id,
      expectedIframeFields,
      expectedTopLevelFields,
    });

    if (!shot.ok) {
      // Counts/booleans/field-kind enums only — never boxes, values, or base64.
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: session.browser_session_id,
        tool: "browser_take_screenshot",
        error_code: shot.redaction_mismatch ? "SCREENSHOT_REDACTION_MISMATCH" : "SCREENSHOT_REDACTION_FAILED",
      });
      const mismatchDetail = shot.redaction_mismatch
        ? ` A protected filled field could not be verified as masked after a page re-render` +
          (shot.missing_field_kinds?.length ? ` (${shot.missing_field_kinds.join(", ")})` : "") +
          `. Redaction is reported honestly — never a full-redaction claim while a protected value may be visible.`
        : "";
      return sendError(
        reply,
        502,
        "SCREENSHOT_REDACTION_FAILED",
        "Antigen could not capture a redacted screenshot. To protect filled sensitive values it will not return an unredacted image." +
          mismatchDetail,
      );
    }

    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "browser_tool_disposition",
      browser_runtime_id: session.browser_session_id,
      tool: "browser_take_screenshot",
      result_code: "screenshot_redacted",
      redacted_field_count: shot.redacted_field_count,
      redacted_iframe_field_count: expectedIframeFields.length,
    });

    return reply.send({
      ok: true,
      data: {
        browser_runtime_id: session.browser_session_id,
        mime_type: shot.mimeType,
        image_base64: shot.base64,
        redacted_field_count: shot.redacted_field_count,
      },
    });
  });

  // ─── Payment Card Fill Handoff v1 ─────────────────────────────────────────────
  // Agent-facing endpoints for requesting, polling, and executing card field fills.
  // Purchase confirmation is NOT implemented — card fill does not authorize any purchase.

  const VALID_CARD_FIELDS = new Set<PaymentCardField>([
    "card_number", "cvv", "expiry_month", "expiry_year", "expiry_combined",
    "cardholder_name", "billing_zip",
  ]);

  function cardFillNextAction(status: string, pendingApproval = false): string {
    switch (status) {
      case "pending_approval":
        return pendingApproval
          ? `Direct the user to /route-run-approvals (under "Payment card requests") to approve. Then call wait_for_payment_card_fill_authorization.`
          : "Waiting for user approval. Call wait_for_payment_card_fill_authorization.";
      case "approved":
        return "Call execute_payment_card_fill_handoff to fill the field.";
      case "executing":
        return "Fill is in progress. Wait briefly and poll status.";
      case "filled":
        return "Field has been filled. Continue with your task. NOTE: this does NOT authorize a purchase.";
      case "denied":
        return "User denied the fill request. Do not attempt to fill card fields without user approval.";
      case "expired":
        return "Request has expired. Create a new fill request if still needed.";
      case "failed":
        return "CDP fill failed. Check error. You may retry with a new request.";
      default:
        return "Unknown status.";
    }
  }

  // POST /api/agent/v1/payment-card-fills — create a card field fill request
  server.post(
    "/api/agent/v1/payment-card-fills",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = req.body as {
        domain?: string;
        payment_method_id?: string;
        field?: string;
        page_url?: string;
        element_hint?: {
          label?: string;
          placeholder?: string;
          input_type?: string;
          selector_hint?: string;
          antigen_ref?: string;
        };
        reason?: string;
        browser_session_id?: string;
        external_cdp_url?: string;
      };

      if (!body.domain || typeof body.domain !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!body.field || !VALID_CARD_FIELDS.has(body.field as PaymentCardField)) {
        return sendError(reply, 400, "VALIDATION_ERROR", `field must be one of: ${[...VALID_CARD_FIELDS].join(", ")}.`);
      }
      if (!body.page_url || typeof body.page_url !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "page_url is required.");
      }
      if (!body.reason || typeof body.reason !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "reason is required.");
      }

      // Domain must match page_url hostname
      let pageHostname: string;
      try {
        pageHostname = new URL(body.page_url).hostname;
      } catch {
        return sendError(reply, 400, "INVALID_URL", "page_url is not a valid URL.");
      }
      if (pageHostname !== body.domain && !pageHostname.endsWith(`.${body.domain}`)) {
        return sendError(
          reply, 400, "DOMAIN_MISMATCH",
          `page_url hostname '${pageHostname}' does not match domain '${body.domain}'. ` +
          `Navigate to the ${body.domain} checkout page before requesting card fill.`,
        );
      }

      // Validate selector_hint if provided
      if (body.element_hint?.selector_hint) {
        const selectorCheck = validateCardFillSelector(body.element_hint.selector_hint);
        if (!selectorCheck.valid) {
          return sendError(reply, 400, "DANGEROUS_SELECTOR", selectorCheck.reason ?? "Selector targets a prohibited element.");
        }
      }

      // Validate antigen_ref if provided — it must be an opaque ag_* snapshot token,
      // never a raw selector. Resolution to a concrete element happens server-side at
      // execution time against the session's active snapshot.
      if (body.element_hint?.antigen_ref !== undefined && !isAntigenRef(body.element_hint.antigen_ref)) {
        return sendError(
          reply, 400, "INVALID_ANTIGEN_REF",
          "antigen_ref must be an opaque Antigen snapshot ref of the form 'ag_<n>' (from antigen_snapshot). It is not a CSS selector.",
        );
      }

      // Validate browser_session_id / external_cdp_url mutual exclusion
      let resolvedBrowserSessionId: string | undefined;
      if (typeof body.browser_session_id === "string" && body.browser_session_id.trim()) {
        const bs = getTaskBrowserSession(body.browser_session_id.trim(), MOCK_USER_ID);
        if (!bs) return sendError(reply, 404, "TASK_BROWSER_SESSION_NOT_FOUND", "Task browser session not found.");
        if (bs.delegation_id !== delegation.id) return sendError(reply, 403, "TASK_BROWSER_SESSION_FORBIDDEN", "This browser session belongs to a different delegation. Ensure the Aegis MCP token (AEGIS_AGENT_TOKEN) matches the antigen-browser token so this action and the browser session run under the same delegation.");
        if (bs.status !== "ready") return sendError(reply, 400, "TASK_BROWSER_SESSION_NOT_READY", `Session status is '${bs.status}'; must be 'ready'.`);
        resolvedBrowserSessionId = bs.browser_session_id;
      }
      let resolvedExternalCdpUrl: string | undefined;
      if (typeof body.external_cdp_url === "string" && body.external_cdp_url.trim()) {
        if (resolvedBrowserSessionId) {
          return sendError(reply, 400, "CONFLICT", "Provide either external_cdp_url or browser_session_id, not both.");
        }
        resolvedExternalCdpUrl = body.external_cdp_url.trim();
      }

      // Resolve payment method — explicit ID or default
      const field = body.field as PaymentCardField;
      let pm = body.payment_method_id
        ? paymentMethods.get(body.payment_method_id)
        : Array.from(paymentMethods.values()).find(
            (p) => p.user_id === MOCK_USER_ID && p.is_default && p.status === "active",
          );

      if (!pm) {
        return sendError(
          reply, 404, "PAYMENT_METHOD_NOT_FOUND",
          body.payment_method_id
            ? `No payment method found with id '${body.payment_method_id}'.`
            : "No default payment method found. Add a payment method and set it as default, or provide payment_method_id.",
        );
      }
      if (pm.user_id !== MOCK_USER_ID) {
        return sendError(reply, 403, "FORBIDDEN", "Payment method does not belong to this user.");
      }
      if (pm.status !== "active") {
        return sendError(reply, 400, "PAYMENT_METHOD_NOT_ACTIVE", `Payment method status is '${pm.status}'; only active payment methods can be used.`);
      }

      const now = new Date();

      // Reuse an existing approved authorization for the same (user, delegation, domain, pm)
      const approvedAuth = Array.from(paymentCardFillAuthorizations.values()).find(
        (a) =>
          a.user_id === MOCK_USER_ID &&
          a.delegation_id === delegation.id &&
          a.domain === body.domain &&
          a.payment_method_id === pm!.payment_method_id &&
          a.status === "approved" &&
          new Date(a.expires_at) > now,
      );

      const pendingAuth = !approvedAuth
        ? Array.from(paymentCardFillAuthorizations.values()).find(
            (a) =>
              a.user_id === MOCK_USER_ID &&
              a.delegation_id === delegation.id &&
              a.domain === body.domain &&
              a.payment_method_id === pm!.payment_method_id &&
              a.status === "pending_approval" &&
              new Date(a.expires_at) > now,
          )
        : undefined;

      let auth: PaymentCardFillAuthorization;
      let fillStatus: PaymentCardFillRequest["status"];

      if (approvedAuth) {
        auth = approvedAuth;
        fillStatus = "approved";
      } else if (pendingAuth) {
        auth = pendingAuth;
        fillStatus = "pending_approval";
      } else {
        auth = {
          authorization_id: newId("pca"),
          user_id: MOCK_USER_ID,
          delegation_id: delegation.id,
          domain: body.domain,
          payment_method_id: pm.payment_method_id,
          payment_method_label: pm.label,
          last4: pm.last4,
          is_default: pm.is_default,
          allowed_fields: [...VALID_CARD_FIELDS] as PaymentCardField[],
          fields_filled: [],
          status: "pending_approval",
          raw_values_revealed_to_agent: false,
          purchase_not_authorized: true,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        };
        paymentCardFillAuthorizations.set(auth.authorization_id, auth);
        fillStatus = "pending_approval";
      }

      const fillRequest: PaymentCardFillRequest = {
        fill_request_id: newId("pcfr"),
        authorization_id: auth.authorization_id,
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        domain: body.domain,
        payment_method_id: pm.payment_method_id,
        field,
        page_url: body.page_url,
        element_hint: body.element_hint,
        reason: body.reason,
        status: fillStatus,
        ...(resolvedBrowserSessionId ? { browser_session_id: resolvedBrowserSessionId } : {}),
        ...(resolvedExternalCdpUrl ? { external_cdp_url: resolvedExternalCdpUrl } : {}),
        raw_values_revealed_to_agent: false,
        created_at: new Date().toISOString(),
        expires_at: auth.expires_at,
        ...(fillStatus === "approved" ? { approved_at: auth.approved_at } : {}),
      };
      paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
      schedulePersist();

      const isPendingApproval = fillStatus === "pending_approval";
      return reply.send({
        ok: true,
        data: {
          fill_request_id: fillRequest.fill_request_id,
          authorization_id: auth.authorization_id,
          status: fillRequest.status,
          field: fillRequest.field,
          domain: fillRequest.domain,
          payment_method_label: pm.label,
          last4: pm.last4,
          raw_values_revealed_to_agent: false,
          purchase_not_authorized: true,
          expires_at: fillRequest.expires_at,
          next_action: cardFillNextAction(fillRequest.status, isPendingApproval),
          note: "This approval covers card field fill only. It does NOT authorize a purchase.",
          // Execution-order guidance (field-kind enums only — no values, refs, or selectors).
          // Iframe fills (card_number/cvv) can re-render the page and stale top-level ag_*
          // refs, so parent-page antigen_ref fields must execute first.
          iframe_capable_field: isIframeCapablePaymentField(fillRequest.field),
          recommended_fill_order: orderPaymentFillFields(
            auth.allowed_fields.filter((f) => !auth.fields_filled.includes(f)),
          ),
          execution_order_note:
            "When filling multiple card fields under this authorization, execute parent-page " +
            "antigen_ref fields FIRST (expiry, cardholder_name, billing_zip), then iframe-capable " +
            "fields LAST (card_number, cvv). Iframe fills can re-render the page and invalidate " +
            "snapshot refs needed for the remaining top-level fields.",
        },
      });
    },
  );

  // GET /api/agent/v1/payment-card-fills/:fillRequestId — poll status
  server.get<{ Params: { fillRequestId: string } }>(
    "/api/agent/v1/payment-card-fills/:fillRequestId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const fillRequest = paymentCardFillRequests.get(req.params.fillRequestId);
      if (!fillRequest) return sendError(reply, 404, "FILL_REQUEST_NOT_FOUND", "Fill request not found.");
      if (fillRequest.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This fill request does not belong to your delegation.");
      }

      // Lazy status promotion from linked authorization
      const terminalStatuses = ["filled", "denied", "failed", "expired"] as const;
      if (!terminalStatuses.includes(fillRequest.status as any)) {
        if (new Date(fillRequest.expires_at) < new Date()) {
          fillRequest.status = "expired";
          paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
          schedulePersist();
        } else if (fillRequest.status === "pending_approval" && fillRequest.authorization_id) {
          const auth = paymentCardFillAuthorizations.get(fillRequest.authorization_id);
          if (auth) {
            if (auth.status === "approved") {
              fillRequest.status = "approved";
              fillRequest.approved_at = auth.approved_at;
              paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
              schedulePersist();
            } else if (["denied", "expired", "fulfilled", "revoked"].includes(auth.status)) {
              fillRequest.status = auth.status === "fulfilled" ? "denied" : (auth.status as any);
              paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
              schedulePersist();
            }
          }
        }
      }

      return reply.send({
        ok: true,
        data: {
          fill_request_id: fillRequest.fill_request_id,
          authorization_id: fillRequest.authorization_id,
          status: fillRequest.status,
          field: fillRequest.field,
          domain: fillRequest.domain,
          raw_values_revealed_to_agent: false,
          purchase_not_authorized: true,
          expires_at: fillRequest.expires_at,
          ...(fillRequest.filled_at ? { filled_at: fillRequest.filled_at } : {}),
          ...(fillRequest.error ? { error: fillRequest.error } : {}),
          next_action: cardFillNextAction(fillRequest.status),
        },
      });
    },
  );

  // POST /api/agent/v1/payment-card-fills/:fillRequestId/execute — CDP card fill trigger
  server.post<{ Params: { fillRequestId: string } }>(
    "/api/agent/v1/payment-card-fills/:fillRequestId/execute",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const fillRequest = paymentCardFillRequests.get(req.params.fillRequestId);
      if (!fillRequest) return sendError(reply, 404, "FILL_REQUEST_NOT_FOUND", "Fill request not found.");
      if (fillRequest.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This fill request does not belong to your delegation.");
      }

      // Expiry check
      if (new Date(fillRequest.expires_at) < new Date() && fillRequest.status !== "filled") {
        fillRequest.status = "expired";
        paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
        schedulePersist();
        return sendError(reply, 400, "FILL_EXPIRED", "Fill request has expired. Create a new request.");
      }

      // Lazy promotion from authorization
      if (fillRequest.status === "pending_approval" && fillRequest.authorization_id) {
        const auth = paymentCardFillAuthorizations.get(fillRequest.authorization_id);
        if (auth?.status === "approved") {
          fillRequest.status = "approved";
          fillRequest.approved_at = auth.approved_at;
          paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
          schedulePersist();
        }
      }

      if (fillRequest.status !== "approved") {
        return sendError(
          reply, 400, "FILL_NOT_APPROVED",
          `Fill request status is '${fillRequest.status}'; only 'approved' requests can be executed. ` +
          cardFillNextAction(fillRequest.status),
        );
      }

      // SensitiveGrant enforcement
      const auth = paymentCardFillAuthorizations.get(fillRequest.authorization_id);
      if (!auth) {
        return sendError(reply, 400, "AUTHORIZATION_NOT_FOUND", "Linked authorization not found.");
      }

      const grantCheck = checkSensitiveGrant(sensitiveGrants, {
        user_id: fillRequest.user_id,
        delegation_id: fillRequest.delegation_id,
        domain: fillRequest.domain,
        grant_type: "payment_card_fill",
        payment_method_id: fillRequest.payment_method_id,
        authorization_id: fillRequest.authorization_id,
      });
      if (!grantCheck.valid) {
        const grantErrorDetails: Record<string, [number, string, string]> = {
          consumed: [409, "SENSITIVE_GRANT_CONSUMED", "This card fill grant has already been consumed. Create a new fill request."],
          expired:  [400, "SENSITIVE_GRANT_EXPIRED",  "The sensitive grant has expired. Create a new fill request."],
          revoked:  [403, "SENSITIVE_GRANT_REVOKED",  "The sensitive grant has been revoked."],
          no_grant: [403, "SENSITIVE_GRANT_REQUIRED", "No valid sensitive grant found. Approval is required."],
        };
        const [st, code, msg] = grantErrorDetails[grantCheck.reason ?? "no_grant"] ?? [403, "SENSITIVE_GRANT_INVALID", "Grant check failed."];
        return sendError(reply, st, code, msg);
      }
      const activeGrant = grantCheck.grant!;

      // Resolve payment method
      const pm = paymentMethods.get(fillRequest.payment_method_id);
      if (!pm || pm.user_id !== MOCK_USER_ID || pm.status !== "active") {
        fillRequest.status = "failed";
        fillRequest.error = "Payment method not found or no longer active.";
        paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
        schedulePersist();
        return sendError(reply, 404, "PAYMENT_METHOD_NOT_FOUND", "Payment method not found or no longer active.");
      }

      // Transition to executing
      fillRequest.status = "executing";
      paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
      schedulePersist();

      // Resolve field value — KMS for card_number and cvv; pm struct for others
      const vaultRepo = getVaultRepository();
      const kms = getKmsProvider();
      const kmsContext = {
        user_id: pm.user_id,
        pass_id: pm.payment_method_id,
        domain: "aegis.payment",
      };

      let resolvedValue: string;
      try {
        if (fillRequest.field === "card_number") {
          const blob = await vaultRepo.getEncryptedSecret(pm.card_number_ref);
          if (!blob) throw new Error("Card number secret not available.");
          resolvedValue = await kms.decryptSecret(blob, { ...kmsContext, purpose: "payment_card_number" });
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pm.user_id,
            pass_id: pm.payment_method_id,
            domain: "aegis.payment",
            run_id: `card_fill:${fillRequest.fill_request_id}`,
            success: true,
          });
        } else if (fillRequest.field === "cvv") {
          const blob = await vaultRepo.getEncryptedSecret(pm.cvv_ref);
          if (!blob) throw new Error("CVV secret not available.");
          resolvedValue = await kms.decryptSecret(blob, { ...kmsContext, purpose: "payment_cvv" });
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pm.user_id,
            pass_id: pm.payment_method_id,
            domain: "aegis.payment",
            run_id: `card_fill:${fillRequest.fill_request_id}`,
            success: true,
          });
        } else if (fillRequest.field === "expiry_month") {
          resolvedValue = String(pm.exp_month);
        } else if (fillRequest.field === "expiry_year") {
          resolvedValue = String(pm.exp_year);
        } else if (fillRequest.field === "expiry_combined") {
          resolvedValue = `${String(pm.exp_month).padStart(2, "0")}/${String(pm.exp_year).slice(-2)}`;
        } else if (fillRequest.field === "cardholder_name") {
          resolvedValue = pm.cardholder_name;
        } else if (fillRequest.field === "billing_zip") {
          resolvedValue = pm.billing_zip ?? "";
        } else {
          throw new Error(`Unknown field: ${fillRequest.field}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Field resolution failed";
        if (fillRequest.field === "card_number" || fillRequest.field === "cvv") {
          recordKmsAuditEvent({
            operation: "resolve_secret_for_runtime",
            provider: kms.provider,
            user_id: pm.user_id,
            pass_id: pm.payment_method_id,
            domain: "aegis.payment",
            run_id: `card_fill:${fillRequest.fill_request_id}`,
            success: false,
            error_code: "RESOLVE_FAILED",
          });
        }
        fillRequest.status = "failed";
        fillRequest.error = msg;
        paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);
        schedulePersist();
        return sendError(reply, 500, "FIELD_RESOLVE_FAILED", msg);
      }

      // CDP fill — resolvedValue used here and immediately discarded; never returned in response
      let cdpUrlOverride: string | undefined;
      // Overlay follows the session's visible mode via the same tri-state helper the
      // click/type paths use — so a headed QA session shows the pointer/cursor overlay
      // during card fill without a separate env var. Defaults off when no tracked session.
      let overlayForFill = false;
      if (fillRequest.browser_session_id) {
        const bs = getTaskBrowserSession(fillRequest.browser_session_id, MOCK_USER_ID);
        if (bs?.status === "ready") {
          cdpUrlOverride = bs.cdp_url;
          overlayForFill = resolveOverlayEnabled(bs);
        }
      } else if (fillRequest.external_cdp_url) {
        cdpUrlOverride = fillRequest.external_cdp_url;
      }

      const fillResult = await executePaymentCardFillViaCDP(fillRequest, resolvedValue, cdpUrlOverride, {
        debugOverlay: overlayForFill,
      });
      // resolvedValue is no longer referenced after this point

      const completedAt = new Date().toISOString();
      if (fillResult.success) {
        fillRequest.status = "filled";
        fillRequest.filled_at = completedAt;
        fillRequest.error = undefined;

        // Record cross-origin OPPWA iframe fills so the screenshot path redacts the
        // iframe container region and fails closed if it later cannot locate it.
        // Registry holds only the field-kind enum — no raw value, URL, or coordinate.
        if (
          fillResult.iframeProvider === "oppwa" &&
          fillRequest.browser_session_id &&
          fillResult.iframeFieldKind
        ) {
          registerProtectedIframeRedaction(fillRequest.browser_session_id, fillResult.iframeFieldKind, "oppwa");
        } else if (fillRequest.browser_session_id && fillRequest.field !== "billing_zip") {
          // Parent-page fill of a visually-masked card field (expiry, cardholder, or
          // PAN/CVV on non-iframe checkouts). Register it so the screenshot path can
          // verify the mask survived later re-renders and re-mask or fail closed —
          // the fill-time DOM marker alone is not durable (OPPWA re-init wipes it).
          registerProtectedTopLevelRedaction(fillRequest.browser_session_id, fillRequest.field);
        }

        // Update authorization fields_filled
        if (!auth.fields_filled.includes(fillRequest.field)) {
          auth.fields_filled = [...auth.fields_filled, fillRequest.field];
        }
        // Fulfill authorization when all allowed_fields have been filled
        const allFulfilled = auth.allowed_fields.every((f) => auth.fields_filled.includes(f));
        if (allFulfilled) {
          auth.status = "fulfilled";
          auth.fulfilled_at = completedAt;
          activeGrant.status = "consumed";
          (activeGrant as any).consumed_at = completedAt;
          sensitiveGrants.set(activeGrant.grant_id, activeGrant);
        }
        paymentCardFillAuthorizations.set(auth.authorization_id, auth);
      } else {
        fillRequest.status = "failed";
        fillRequest.error = fillResult.error ?? "CDP fill failed";
      }
      paymentCardFillRequests.set(fillRequest.fill_request_id, fillRequest);

      // Record audit trail — no raw values, no payment_method_id
      const handoff: PaymentCardFillHandoffRecord = {
        handoff_id: newId("pcfh"),
        fill_request_id: fillRequest.fill_request_id,
        authorization_id: fillRequest.authorization_id,
        delegation_id: fillRequest.delegation_id,
        user_id: fillRequest.user_id,
        domain: fillRequest.domain,
        field: fillRequest.field,
        payment_method_label: pm.label,
        last4: pm.last4,
        outcome: fillResult.success ? "filled" : "failed",
        raw_values_revealed_to_agent: false,
        purchase_not_authorized: true,
        completed_at: completedAt,
      };
      paymentCardFillHandoffs.set(handoff.handoff_id, handoff);
      schedulePersist();

      if (!fillResult.success) {
        const rawMsg = fillResult.error ?? "CDP fill failed";
        let hint = rawMsg;
        if (rawMsg === "ANTIGEN_REF_STALE") {
          hint =
            "The antigen_ref no longer resolves for this session (the snapshot expired, the page changed, or the ref belongs to a different session). " +
            "Take a fresh antigen_snapshot of the current payment page and retry the fill with the new ref.";
        } else if (rawMsg === "INVALID_ANTIGEN_REF") {
          hint = "antigen_ref must be an opaque 'ag_<n>' token from antigen_snapshot, not a selector.";
        } else if (rawMsg.includes("TARGET_NOT_FILLABLE")) {
          hint =
            `${rawMsg}. The element resolved for this field is not a fillable control (input/select/textarea) — ` +
            "common with floating-label markup where an overlay covers the field. " +
            "Take a fresh antigen_snapshot and retry with the ag_* ref of the actual input control.";
        } else if (rawMsg.toLowerCase().includes("element not found") || rawMsg.toLowerCase().includes("not found")) {
          hint = `${rawMsg}. Verify the browser_session_id in the fill request targets the runtime page that has the checkout form open.`;
        }
        return sendError(reply, 500, "CDP_FILL_FAILED", hint);
      }

      // Post-Fill State v1 (ANTIGEN_FILL_STATE, default-off): one short probe of
      // the TOP document so the agent learns — in this response — whether the
      // next action is enabled, validation errors appeared, and masking /
      // iframe-redaction registry state is in order. Fail-closed: a probe
      // failure degrades to outcome "unknown" and never affects the fill result.
      // The internal probe is mapped ONLY through buildPostFillState (explicit
      // allowlist) — never spread into the response.
      let postFillState: ReturnType<typeof buildPostFillState> | undefined;
      if (isFillStateEnabled()) {
        const probeCdpUrl = cdpUrlOverride ?? process.env.AEGIS_PLAYWRIGHT_CDP_URL;
        if (probeCdpUrl) {
          const probeResult = await runPostFillProbe({
            cdpUrl: probeCdpUrl,
            domain: fillRequest.domain,
          });
          const iframeFields = fillRequest.browser_session_id
            ? getProtectedIframeRedactionFields(fillRequest.browser_session_id)
            : undefined;
          // Registry-derived count of top-level masked fields — surfaces a wiped
          // mask (re-rendered node) in this response as top_level_mask_missing.
          const expectedTopLevelMasked = fillRequest.browser_session_id
            ? getProtectedTopLevelRedactionFields(fillRequest.browser_session_id).length
            : 0;
          postFillState = buildPostFillState(
            {
              probe: probeResult?.probe,
              probe_ms: probeResult?.probe_ms,
              filled_count: 1,
              failed_count: 0,
              iframe_redaction_fields: iframeFields,
              ...(expectedTopLevelMasked > 0
                ? { expected_top_level_masked: expectedTopLevelMasked }
                : {}),
              // Mismatch check mirrors the registration condition above — only
              // when the fill actually went through a session-tracked iframe.
              ...(fillResult.iframeProvider === "oppwa" &&
              fillRequest.browser_session_id &&
              fillResult.iframeFieldKind
                ? { expected_iframe_field: fillResult.iframeFieldKind }
                : {}),
              pageUrl: probeResult?.probe?.url ?? null,
            },
            { includeActions: isActiveSurfacesEnabled() },
          );
        }
      }

      // Remaining unfilled fields under this authorization, in safe execution order
      // (field-kind enums only). After an iframe fill, any remaining parent-page fields
      // mean the agent's held ag_* refs are likely stale — say so explicitly instead of
      // letting the resolver's fail-closed path eat a round trip.
      const remainingFields = orderPaymentFillFields(
        auth.allowed_fields.filter((f) => !auth.fields_filled.includes(f)),
      );
      const remainingParentPageFields = remainingFields.filter((f) => !isIframeCapablePaymentField(f));
      const iframeFillStaledRefs = !!fillResult.iframeProvider;

      // Response NEVER includes resolvedValue, payment_method_id, card_number_ref, cvv_ref
      return reply.send({
        ok: true,
        data: {
          fill_request_id: fillRequest.fill_request_id,
          authorization_id: fillRequest.authorization_id,
          status: "filled",
          field: fillRequest.field,
          domain: fillRequest.domain,
          payment_method_label: pm.label,
          last4: pm.last4,
          filled_at: fillRequest.filled_at,
          raw_values_revealed_to_agent: false,
          purchase_not_authorized: true,
          note: "Antigen injected the card field value directly via CDP. Raw values were never returned to the agent. This does NOT authorize a purchase.",
          recommended_fill_order: remainingFields,
          // Iframe metadata — present only when fill was routed through an iframe provider
          ...(fillResult.iframeProvider ? {
            iframe_provider: fillResult.iframeProvider,
            iframe_origin: fillResult.iframeOrigin,
            iframe_path: fillResult.iframePath,
            page_refs_likely_stale: true,
            ...(remainingParentPageFields.length > 0 ? {
              stale_ref_warning:
                "This iframe fill may have re-rendered the page — previously captured ag_* refs " +
                "are likely stale. Take a fresh antigen_snapshot before filling the remaining " +
                `top-level fields (${remainingParentPageFields.join(", ")}). Next time, fill ` +
                "parent-page antigen_ref fields BEFORE iframe fields (card_number, cvv).",
            } : {}),
          } : {}),
          // Sanitized post-fill realization summary (ANTIGEN_FILL_STATE only).
          ...(postFillState ? { post_fill_state: postFillState } : {}),
        },
      });
    },
  );

  // ─── Purchase Confirmation Handoff v1 ─────────────────────────────────────────
  // Separate approval and execution path for final payment submission.
  // PaymentCardFillAuthorization never authorizes purchase submission.

  // POST /api/agent/v1/purchase-confirmations — create a pending purchase confirmation authorization
  server.post(
    "/api/agent/v1/purchase-confirmations",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = (req.body ?? {}) as {
        domain?: string;
        page_url?: string;
        merchant?: string;
        amount?: number;
        currency?: string;
        amount_unknown?: boolean;
        item_summary?: string;
        payment_method_label?: string;
        payment_method_last4?: string;
        button_text?: string;
        button_selector_hint?: string;
        card_fill_authorization_id?: string;
        reason?: string;
      };

      const { domain, page_url, merchant, amount, currency, amount_unknown, item_summary,
              payment_method_label, payment_method_last4, button_text, button_selector_hint,
              card_fill_authorization_id, reason } = body;

      if (!domain || typeof domain !== "string") {
        return sendError(reply, 400, "MISSING_DOMAIN", "domain is required.");
      }
      if (!page_url || typeof page_url !== "string") {
        return sendError(reply, 400, "MISSING_PAGE_URL", "page_url is required.");
      }
      if (!merchant || typeof merchant !== "string") {
        return sendError(reply, 400, "MISSING_MERCHANT", "merchant is required.");
      }
      if (!item_summary || typeof item_summary !== "string") {
        return sendError(reply, 400, "MISSING_ITEM_SUMMARY", "item_summary is required.");
      }
      if (!payment_method_label || typeof payment_method_label !== "string") {
        return sendError(reply, 400, "MISSING_PAYMENT_METHOD_LABEL", "payment_method_label is required.");
      }
      if (!payment_method_last4 || typeof payment_method_last4 !== "string") {
        return sendError(reply, 400, "MISSING_PAYMENT_METHOD_LAST4", "payment_method_last4 is required.");
      }
      if (!button_text || typeof button_text !== "string") {
        return sendError(reply, 400, "MISSING_BUTTON_TEXT", "button_text is required.");
      }
      if (!reason || typeof reason !== "string") {
        return sendError(reply, 400, "MISSING_REASON", "reason is required.");
      }

      // Validate domain matches page_url hostname
      try {
        const hostname = new URL(page_url).hostname;
        if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
          return sendError(reply, 400, "DOMAIN_MISMATCH", `page_url hostname "${hostname}" does not match domain "${domain}".`);
        }
      } catch {
        return sendError(reply, 400, "INVALID_PAGE_URL", "page_url is not a valid URL.");
      }

      const now = new Date().toISOString();
      const pconfId = newId("pconf");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const auth: PurchaseConfirmationAuthorization = {
        purchase_confirmation_id: pconfId,
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        domain,
        page_url,
        merchant,
        amount: typeof amount === "number" ? amount : undefined,
        currency: currency ?? "USD",
        amount_unknown: amount_unknown === true || (amount === undefined || amount === null),
        item_summary,
        payment_method_label,
        payment_method_last4,
        button_text,
        button_selector_hint,
        card_fill_authorization_id,
        reason,
        status: "pending_approval",
        risk_level: "critical",
        raw_values_revealed_to_agent: false,
        purchase_action_authorized: false,
        created_at: now,
        expires_at: expiresAt,
      };

      purchaseConfirmationAuthorizations.set(pconfId, auth);
      schedulePersist();

      return reply.status(201).send({
        ok: true,
        data: {
          purchase_confirmation_id: pconfId,
          status: "pending_approval",
          domain,
          merchant,
          amount: auth.amount,
          currency: auth.currency,
          amount_unknown: auth.amount_unknown,
          button_text,
          raw_values_revealed_to_agent: false,
          purchase_action_authorized: false,
          expires_at: expiresAt,
          next_action: "Request pending. Tell the user to approve at /route-run-approvals under 'Purchase confirmations'.",
        },
      });
    },
  );

  // GET /api/agent/v1/purchase-confirmations/:id — poll status
  server.get<{ Params: { id: string } }>(
    "/api/agent/v1/purchase-confirmations/:id",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const auth = purchaseConfirmationAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Purchase confirmation authorization not found.");
      if (auth.delegation_id !== delegation.id) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");

      // Lazy expiry
      if (auth.status === "pending_approval" && new Date(auth.expires_at) < new Date()) {
        auth.status = "expired";
        purchaseConfirmationAuthorizations.set(auth.purchase_confirmation_id, auth);
        schedulePersist();
      }

      const TERMINAL = new Set(["fulfilled", "denied", "expired", "revoked"]);
      const nextAction = auth.status === "approved"
        ? "Authorization approved. Call execute_purchase_confirmation_handoff to complete the purchase."
        : auth.status === "pending_approval"
        ? "Waiting for user approval at /route-run-approvals under 'Purchase confirmations'."
        : TERMINAL.has(auth.status)
        ? `Authorization is ${auth.status}. Do not attempt purchase without a new approval.`
        : undefined;

      return reply.send({
        ok: true,
        data: {
          purchase_confirmation_id: auth.purchase_confirmation_id,
          status: auth.status,
          domain: auth.domain,
          merchant: auth.merchant,
          amount: auth.amount,
          currency: auth.currency,
          amount_unknown: auth.amount_unknown,
          button_text: auth.button_text,
          raw_values_revealed_to_agent: false,
          purchase_action_authorized: auth.purchase_action_authorized,
          expires_at: auth.expires_at,
          approved_at: auth.approved_at,
          fulfilled_at: auth.fulfilled_at,
          next_action: nextAction,
        },
      });
    },
  );

  // POST /api/agent/v1/purchase-confirmations/:id/execute — click the approved payment button
  server.post<{ Params: { id: string } }>(
    "/api/agent/v1/purchase-confirmations/:id/execute",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      // Reject card fill authorization IDs — they do not authorize purchase submission
      if (req.params.id.startsWith("pca_")) {
        return sendError(
          reply, 403, "CARD_FILL_AUTH_NOT_SUFFICIENT",
          "A PaymentCardFillAuthorization (pca_...) cannot authorize purchase submission. " +
          "Call request_purchase_confirmation to create a separate PurchaseConfirmationAuthorization.",
        );
      }

      const auth = purchaseConfirmationAuthorizations.get(req.params.id);
      if (!auth) return sendError(reply, 404, "NOT_FOUND", "Purchase confirmation authorization not found.");
      if (auth.delegation_id !== delegation.id) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");

      if (auth.status === "pending_approval") {
        return sendError(reply, 400, "PENDING_APPROVAL", "Authorization is still pending user approval.");
      }
      if (auth.status !== "approved") {
        return sendError(reply, 400, "INVALID_STATUS", `Cannot execute purchase confirmation with status '${auth.status}'. Authorization must be 'approved'.`);
      }
      if (!auth.purchase_action_authorized) {
        return sendError(reply, 403, "PURCHASE_NOT_AUTHORIZED", "purchase_action_authorized is false. User approval is required.");
      }
      if (new Date(auth.expires_at) < new Date()) {
        auth.status = "expired";
        purchaseConfirmationAuthorizations.set(auth.purchase_confirmation_id, auth);
        schedulePersist();
        return sendError(reply, 400, "EXPIRED", "Authorization has expired.");
      }

      // Resolve CDP URL
      const body = (req.body ?? {}) as { browser_session_id?: string; external_cdp_url?: string };
      let cdpUrl = process.env.AEGIS_PLAYWRIGHT_CDP_URL ?? "http://localhost:9222";
      if (body.browser_session_id) {
        const { taskBrowserSessions } = await import("../runtime/taskBrowserSessions.js");
        const session = taskBrowserSessions.get(body.browser_session_id);
        if (!session) return sendError(reply, 404, "SESSION_NOT_FOUND", "Task browser session not found.");
        if (session.delegation_id !== delegation.id) return sendError(reply, 403, "FORBIDDEN", "Forbidden.");
        cdpUrl = session.cdp_url;
      } else if (body.external_cdp_url) {
        cdpUrl = body.external_cdp_url;
      }

      const result = await executePurchaseConfirmation({
        domain: auth.domain,
        page_url: auth.page_url,
        button_text: auth.button_text,
        button_selector_hint: auth.button_selector_hint,
        cdpUrl,
      });

      const completedAt = new Date().toISOString();

      // Record audit trail — never includes card number, CVV, refs, ciphertext, cookies, storage, KMS material
      const handoff: PurchaseConfirmationHandoffRecord = {
        handoff_id: newId("pchoff"),
        purchase_confirmation_id: auth.purchase_confirmation_id,
        user_id: auth.user_id,
        delegation_id: auth.delegation_id,
        domain: auth.domain,
        merchant: auth.merchant,
        amount: auth.amount,
        currency: auth.currency,
        item_summary: auth.item_summary,
        payment_method_label: auth.payment_method_label,
        payment_method_last4: auth.payment_method_last4,
        button_text: auth.button_text,
        outcome: result.outcome,
        card_fill_authorization_id: auth.card_fill_authorization_id,
        raw_values_revealed_to_agent: false,
        completed_at: completedAt,
      };
      purchaseConfirmationHandoffs.set(handoff.handoff_id, handoff);

      if (result.outcome === "submitted") {
        auth.status = "fulfilled";
        auth.fulfilled_at = completedAt;
      }
      purchaseConfirmationAuthorizations.set(auth.purchase_confirmation_id, auth);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          purchase_confirmation_id: auth.purchase_confirmation_id,
          handoff_id: handoff.handoff_id,
          outcome: result.outcome,
          domain: auth.domain,
          merchant: auth.merchant,
          amount: auth.amount,
          currency: auth.currency,
          button_text: auth.button_text,
          current_url: result.current_url,
          page_title: result.page_title,
          raw_values_revealed_to_agent: false,
          blocked_reason: result.blocked_reason,
          note: "Purchase confirmation handoff completed. This receipt contains no card values, CVV, card refs, ciphertext, cookies, storage, or KMS material.",
        },
      });
    },
  );

  // ─── Private Profile Memory v1 ───────────────────────────────────────────────

  // Class 1 secrets that must be rejected at request time — they belong to other handoff systems.
  const CLASS_1_PROFILE_FIELD_KINDS = new Set([
    "card_number", "cvv", "password", "ssn", "pin",
    "bank_account", "routing_number", "one_time_code",
  ]);

  const VALID_PROFILE_FIELD_KINDS = new Set<ProfileFieldKind>([
    "first_name", "last_name", "email", "phone",
    "shipping_address_line1", "shipping_address_line2",
    "city", "region", "postal_code", "country",
  ]);

  // POST /api/agent/v1/profile-field-fills — create a profile field fill request
  server.post(
    "/api/agent/v1/profile-field-fills",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const body = req.body as {
        domain?: string;
        page_url?: string;
        requested_fields?: Array<{
          key?: string;
          selector_hint?: string;
          label?: string;
          placeholder?: string;
          reason?: string;
        }>;
        reason?: string;
        browser_session_id?: string;
      };

      if (!body.domain || typeof body.domain !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!body.page_url || typeof body.page_url !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "page_url is required.");
      }
      if (!body.reason || typeof body.reason !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "reason is required.");
      }
      if (!Array.isArray(body.requested_fields) || body.requested_fields.length === 0) {
        return sendError(reply, 400, "VALIDATION_ERROR", "requested_fields must be a non-empty array.");
      }
      if (body.requested_fields.length > 10) {
        return sendError(reply, 400, "VALIDATION_ERROR", "requested_fields may not exceed 10 items per call.");
      }

      // Domain must match page_url hostname
      let pageHostname: string;
      try {
        pageHostname = new URL(body.page_url).hostname;
      } catch {
        return sendError(reply, 400, "INVALID_URL", "page_url is not a valid URL.");
      }
      if (pageHostname !== body.domain && !pageHostname.endsWith(`.${body.domain}`)) {
        return sendError(
          reply, 400, "DOMAIN_MISMATCH",
          `page_url hostname '${pageHostname}' does not match domain '${body.domain}'.`,
        );
      }

      // Validate each requested field
      for (const f of body.requested_fields) {
        if (!f.key || typeof f.key !== "string") {
          return sendError(reply, 400, "VALIDATION_ERROR", "Each requested_fields item must have a key.");
        }
        if (CLASS_1_PROFILE_FIELD_KINDS.has(f.key)) {
          return sendError(
            reply, 400, "CLASS_1_OUT_OF_SCOPE",
            `'${f.key}' is a Class 1 secret and cannot be filled via profile fill. ` +
            `Use request_secret_field_injection for credentials or request_payment_card_fill for card fields.`,
          );
        }
        if (!VALID_PROFILE_FIELD_KINDS.has(f.key as ProfileFieldKind)) {
          return sendError(
            reply, 400, "VALIDATION_ERROR",
            `'${f.key}' is not a supported profile field kind. ` +
            `Valid kinds: ${[...VALID_PROFILE_FIELD_KINDS].join(", ")}.`,
          );
        }
        if (f.selector_hint) {
          const selectorCheck = validateProfileFillSelector(f.selector_hint);
          if (!selectorCheck.valid) {
            return sendError(reply, 400, "DANGEROUS_SELECTOR", selectorCheck.reason ?? "Selector targets a prohibited element.");
          }
        }
      }

      // Validate browser_session_id if provided
      let resolvedBrowserSessionId: string | undefined;
      if (typeof body.browser_session_id === "string" && body.browser_session_id.trim()) {
        const bs = getTaskBrowserSession(body.browser_session_id.trim(), MOCK_USER_ID);
        if (!bs) return sendError(reply, 404, "TASK_BROWSER_SESSION_NOT_FOUND", "Task browser session not found.");
        if (bs.delegation_id !== delegation.id) return sendError(reply, 403, "TASK_BROWSER_SESSION_FORBIDDEN", "This browser session belongs to a different delegation. Ensure the Aegis MCP token (AEGIS_AGENT_TOKEN) matches the antigen-browser token so this action and the browser session run under the same delegation.");
        if (bs.status !== "ready") return sendError(reply, 400, "TASK_BROWSER_SESSION_NOT_READY", `Session status is '${bs.status}'; must be 'ready'.`);
        resolvedBrowserSessionId = bs.browser_session_id;
      }

      // Check all requested fields exist in memory for this user
      const missingFields: string[] = [];
      for (const f of body.requested_fields) {
        const found = Array.from(privateProfileMemory.values()).find(
          (m) => m.field_kind === (f.key as ProfileFieldKind) && m.user_id === MOCK_USER_ID,
        );
        if (!found) missingFields.push(f.key!);
      }
      if (missingFields.length > 0) {
        const MR_NOW = new Date().toISOString();
        const memReqId = newId("pmreq");
        const memReq: ProfileMemoryRequest = {
          request_id: memReqId,
          user_id: MOCK_USER_ID,
          delegation_id: delegation.id,
          domain: body.domain,
          page_url: body.page_url,
          missing_fields: missingFields as ProfileFieldKind[],
          reason: body.reason,
          status: "pending_user",
          raw_profile_value_revealed_to_agent: false,
          created_at: MR_NOW,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
        profileMemoryRequests.set(memReqId, memReq);
        schedulePersist();
        return reply.send({
          ok: true,
          data: {
            status: "pending_user",
            profile_memory_request_id: memReqId,
            missing_fields: missingFields,
            next_action: "Call wait_for_profile_memory_request with this profile_memory_request_id. Do not ask the user for values in chat. When wait returns status ‘completed’, retry request_profile_field_fill with the same parameters.",
            raw_profile_value_revealed_to_agent: false,
          },
        });
      }

      const NOW = new Date().toISOString();
      const fillRequestId = newId("pffr");
      const requestedFields: ProfileFieldRequest[] = body.requested_fields.map((f) => ({
        key: f.key as ProfileFieldKind,
        ...(f.selector_hint ? { selector_hint: f.selector_hint } : {}),
        ...(f.label ? { label: f.label } : {}),
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
        ...(f.reason ? { reason: f.reason } : {}),
      }));

      const fillRequest: ProfileFieldFillRequest = {
        fill_request_id: fillRequestId,
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        domain: body.domain,
        page_url: body.page_url,
        ...(resolvedBrowserSessionId ? { browser_session_id: resolvedBrowserSessionId } : {}),
        requested_fields: requestedFields,
        reason: body.reason,
        status: "pending",
        raw_profile_value_revealed_to_agent: false,
        raw_profile_values_revealed_to_agent: false,
        created_at: NOW,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };

      profileFieldFillRequests.set(fillRequestId, fillRequest);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          fill_request_id: fillRequestId,
          domain: body.domain,
          status: "pending",
          field_count: requestedFields.length,
          raw_profile_value_revealed_to_agent: false,
          raw_profile_values_revealed_to_agent: false,
        },
      });
    },
  );

  // GET /api/agent/v1/profile-memory-requests/:id — poll status of a pending profile memory request
  server.get(
    "/api/agent/v1/profile-memory-requests/:id",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { id } = req.params as { id: string };
      const r = profileMemoryRequests.get(id);
      if (!r || r.user_id !== MOCK_USER_ID) {
        return sendError(reply, 404, "NOT_FOUND", "Profile memory request not found.");
      }
      if (r.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This profile memory request does not belong to your delegation.");
      }

      // Lazy expiry
      if (r.status === "pending_user" && new Date(r.expires_at) <= new Date()) {
        r.status = "expired";
        profileMemoryRequests.set(id, r);
        schedulePersist();
      }

      const nextActionByStatus: Record<string, string> = {
        pending_user: "Still waiting for user to fill values in Antigen's approvals page. Continue polling.",
        completed: "User has submitted all missing values. Retry request_profile_field_fill with the same parameters.",
        expired: "Request expired. Create a new request by calling request_profile_field_fill again.",
        cancelled: "Request was cancelled. Confirm with the user before retrying.",
      };

      return reply.send({
        ok: true,
        data: {
          profile_memory_request_id: r.request_id,
          status: r.status,
          domain: r.domain,
          missing_fields: r.missing_fields,
          expires_at: r.expires_at,
          ...(r.completed_at ? { completed_at: r.completed_at } : {}),
          raw_profile_value_revealed_to_agent: false as const,
          next_action: nextActionByStatus[r.status] ?? "Unknown status.",
        },
      });
    },
  );

  // POST /api/agent/v1/profile-field-fills/:fillRequestId/execute — execute CDP fill for all fields
  server.post(
    "/api/agent/v1/profile-field-fills/:fillRequestId/execute",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { fillRequestId } = req.params as { fillRequestId: string };
      const fillRequest = profileFieldFillRequests.get(fillRequestId);
      if (!fillRequest) {
        return sendError(reply, 404, "FILL_REQUEST_NOT_FOUND", `No profile fill request found with id '${fillRequestId}'.`);
      }
      if (fillRequest.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This fill request does not belong to your delegation.");
      }
      if (fillRequest.status !== "pending") {
        return sendError(reply, 400, "FILL_ALREADY_EXECUTED", `Fill request status is '${fillRequest.status}'; only 'pending' requests can be executed.`);
      }
      if (new Date(fillRequest.expires_at) < new Date()) {
        fillRequest.status = "expired";
        profileFieldFillRequests.set(fillRequestId, fillRequest);
        schedulePersist();
        return sendError(reply, 400, "FILL_EXPIRED", "This fill request has expired. Create a new one.");
      }

      fillRequest.status = "executing";
      profileFieldFillRequests.set(fillRequestId, fillRequest);

      // Resolve all field values via KMS
      const resolvedValues = new Map<ProfileFieldKind, string>();
      const kms = getKmsProvider();
      try {
        for (const fieldReq of fillRequest.requested_fields) {
          const item = Array.from(privateProfileMemory.values()).find(
            (m) => m.field_kind === fieldReq.key && m.user_id === MOCK_USER_ID,
          );
          if (!item) {
            return sendError(reply, 500, "VALUE_MISSING_AT_EXECUTE", `Stored value for '${fieldReq.key}' could not be found at execute time.`);
          }
          const blob = encryptedSecretVault.get(item.memory_id);
          if (!blob) {
            return sendError(reply, 500, "VALUE_MISSING_AT_EXECUTE", `Encrypted blob for '${fieldReq.key}' could not be found at execute time.`);
          }
          const plain = await kms.decryptSecret(blob, {
            user_id: MOCK_USER_ID,
            pass_id: item.memory_id,
            domain: item.provenance.domain_at_creation,
            purpose: "profile_field",
          });
          resolvedValues.set(fieldReq.key, plain);
        }
      } catch {
        resolvedValues.clear();
        fillRequest.status = "failed";
        fillRequest.error = "KMS decryption failed.";
        profileFieldFillRequests.set(fillRequestId, fillRequest);
        schedulePersist();
        return sendError(reply, 500, "KMS_DECRYPT_FAILED", "Failed to decrypt one or more profile field values. No values were revealed.");
      }

      // Determine CDP URL and preferred target: browser_session_id → session, else env var
      let cdpUrl: string | undefined;
      let preferredTargetUrlProfile: string | undefined;
      if (fillRequest.browser_session_id) {
        const bs = getTaskBrowserSession(fillRequest.browser_session_id, MOCK_USER_ID);
        if (bs?.status === "ready") {
          cdpUrl = bs.cdp_url;
          preferredTargetUrlProfile = bs.current_url;
        }
      }
      if (!cdpUrl) cdpUrl = process.env.AEGIS_PLAYWRIGHT_CDP_URL;

      // Execute CDP fills
      const entries = await executeProfileFieldFillViaCDP(fillRequest, resolvedValues, cdpUrl, preferredTargetUrlProfile);
      // Discard resolved plaintext values immediately
      resolvedValues.clear();

      const NOW = new Date().toISOString();

      // Update last_used_at and uses on each memory item. "corrected_existing_value" is a
      // real injection (untrusted prefill overwritten); "already_correct" wrote nothing and
      // records no use.
      for (const entry of entries) {
        if (entry.status === "filled" || entry.status === "corrected_existing_value") {
          const item = Array.from(privateProfileMemory.values()).find(
            (m) => m.field_kind === entry.key && m.user_id === MOCK_USER_ID,
          );
          if (item) {
            item.last_used_at = NOW;
            item.uses.push({
              used_at: NOW,
              domain: fillRequest.domain,
              disclosure_mode_applied: "fill_only",
              agent_visible: false,
            });
            privateProfileMemory.set(item.memory_id, item);
          }
        }
      }

      // Determine final status — field_filled covers "filled", "already_correct"
      // (verified match, nothing written), and "corrected_existing_value".
      const filledCount = entries.filter((e) => e.field_filled).length;
      let finalStatus: ProfileFieldFillRequest["status"];
      if (filledCount === entries.length) finalStatus = "filled";
      else if (filledCount > 0) finalStatus = "partial";
      else finalStatus = "failed";

      fillRequest.status = finalStatus;
      fillRequest.filled_at = NOW;
      profileFieldFillRequests.set(fillRequestId, fillRequest);
      schedulePersist();

      // Post-Fill State v1 (ANTIGEN_FILL_STATE, default-off): one short probe of
      // the just-filled page so the agent learns — in this response — whether
      // validation errors appeared and the next "Continue" is enabled, instead
      // of re-snapshotting and scroll-hunting. Fail-closed: a probe failure
      // degrades to outcome "unknown" and never affects the fill result. The
      // internal probe is mapped ONLY through buildPostFillState (explicit
      // allowlist) — never spread into the response.
      let postFillState: ReturnType<typeof buildPostFillState> | undefined;
      if (isFillStateEnabled() && cdpUrl) {
        const probeResult = await runPostFillProbe({
          cdpUrl,
          domain: fillRequest.domain,
          preferredTargetUrl: preferredTargetUrlProfile,
        });
        postFillState = buildPostFillState(
          {
            probe: probeResult?.probe,
            probe_ms: probeResult?.probe_ms,
            filled_count: filledCount,
            failed_count: entries.length - filledCount,
            pageUrl: probeResult?.probe?.url ?? null,
          },
          { includeActions: isActiveSurfacesEnabled() },
        );
      }

      return reply.send({
        ok: true,
        data: {
          fill_request_id: fillRequestId,
          domain: fillRequest.domain,
          filled_fields: entries,
          all_filled: filledCount === entries.length,
          raw_profile_value_revealed_to_agent: false,
          raw_profile_values_revealed_to_agent: false,
          note: "Antigen injected profile field values directly via CDP. Raw values were never returned to the agent.",
          // Sanitized post-fill realization summary (ANTIGEN_FILL_STATE only).
          ...(postFillState ? { post_fill_state: postFillState } : {}),
        },
      });
    },
  );

  // ─── Account Access Resolution v1 ─────────────────────────────────────────

  // POST /api/agent/v1/account-access-resolutions
  // Called when the agent reaches a login/signup wall. Checks the vault for an existing
  // credential for the domain. If found, returns credential_available and the agent should
  // observe the current page first, then choose the appropriate handoff:
  // request_secret_field_injection (password field), request_account_creation_step (email/username
  // field), or report_security_challenge (OTP/verification). If not found, creates a pending AccountCreationRequest
  // and returns pending_user — the user approves in /route-run-approvals.
  server.post<{
    Body: {
      domain?: string;
      page_url?: string;
      reason?: string;
      wall_type?: "login" | "signup" | "unknown";
    };
  }>(
    "/api/agent/v1/account-access-resolutions",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const collarResult = resolveEffectiveCollar(delegation, collars);
      if (!collarResult.ok) {
        return reply.status(collarResult.status as number).send({
          ok: false,
          error: { code: collarResult.code, message: collarResult.message },
        });
      }

      const { domain: rawDomain, page_url, reason, wall_type = "unknown" } = req.body ?? {};

      if (!rawDomain || typeof rawDomain !== "string" || rawDomain.trim() === "") {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "domain is required." } });
      }
      if (!page_url || typeof page_url !== "string" || page_url.trim() === "") {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "page_url is required." } });
      }
      if (!reason || typeof reason !== "string" || reason.trim() === "") {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "reason is required." } });
      }

      const domain = normalizeAccountDomain(rawDomain);

      // Domain-URL match guard: the URL's hostname must match the normalized domain
      // or be a subdomain of it. Prevents creating IKEA credentials for an evil.com page.
      let pageHostname: string;
      try {
        pageHostname = new URL(page_url).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        return reply.status(400).send({ ok: false, error: { code: "INVALID_PAGE_URL", message: "page_url is not a valid URL." } });
      }
      if (pageHostname !== domain && !pageHostname.endsWith(`.${domain}`)) {
        return reply.status(400).send({
          ok: false,
          error: {
            code: "DOMAIN_MISMATCH",
            message: `page_url hostname '${pageHostname}' does not match domain '${domain}'. Antigen will not create credentials for a different domain than the page you are on.`,
          },
        });
      }

      // Vault lookup — check if a credential already exists for this domain.
      const existingPass = Array.from(aegisVaultPasses.values()).find(
        p => p.user_id === MOCK_USER_ID && p.domain === domain,
      );

      if (existingPass) {
        return reply.send({
          ok: true,
          data: {
            resolution: "credential_available",
            domain,
            pass_id: existingPass.pass_id,
            pass_label: existingPass.label,
            has_password: true,
            raw_password_revealed_to_agent: false,
            otp_revealed_to_agent: false,
            next_action: "observe_page_then_proceed",
            guidance: `A vault credential exists for ${domain}. Observe the current visible page before acting. If the page shows a password field, call request_secret_field_injection with the returned pass_id. If the page shows an email or username field, call request_account_creation_step with the matching requested_fields. If the page shows an OTP or verification code field, this is a login step-up challenge — call report_security_challenge, then wait_for_security_challenge, then inject_security_challenge_code. Do not call request_account_creation_step for OTP on the credential_available path — no AccountCreationRequest exists. Do not force a password-login path if the page is not currently asking for a password.`,
          },
        });
      }

      // No credential — create a pending account creation request.
      const requestId = newId("acreq");
      const now = new Date();
      const expires = new Date(now.getTime() + 10 * 60 * 1000); // 10-minute TTL

      const acr: AccountCreationRequest = {
        request_id: requestId,
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        domain,
        signup_url: page_url.trim(),
        reason: reason.trim(),
        wall_type,
        status: "pending_user",
        raw_password_revealed_to_agent: false,
        otp_revealed_to_agent: false,
        created_at: now.toISOString(),
        expires_at: expires.toISOString(),
      };

      accountCreationRequests.set(requestId, acr);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          resolution: "pending_user",
          account_creation_request_id: requestId,
          domain,
          raw_password_revealed_to_agent: false,
          otp_revealed_to_agent: false,
          expires_at: expires.toISOString(),
          next_action: "poll_account_creation_request",
          guidance: `No credential exists for ${domain}. An account creation request has been created. Tell the user to approve it in the Antigen UI at /route-run-approvals. Poll get_account_access_resolution with request_id '${requestId}' until status is 'credential_generated', then call request_secret_field_injection with the returned pass_id.`,
        },
      });
    },
  );

  // GET /api/agent/v1/account-access-resolutions/:requestId
  // Agent polls for status. Returns pass_id only when credential_generated or completed.
  server.get<{ Params: { requestId: string } }>(
    "/api/agent/v1/account-access-resolutions/:requestId",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { requestId } = req.params;
      const r = accountCreationRequests.get(requestId);
      if (!r) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Account creation request not found." } });
      }
      if (r.delegation_id !== delegation.id) {
        return reply.status(403).send({ ok: false, error: { code: "FORBIDDEN", message: "This account creation request belongs to a different delegation." } });
      }

      // Lazy expiry.
      if (r.status === "pending_user" && new Date(r.expires_at) <= new Date()) {
        r.status = "expired";
        accountCreationRequests.set(requestId, r);
      }

      const passId = accountCreationPassIdForAgent(r);

      return reply.send({
        ok: true,
        data: {
          request_id: r.request_id,
          status: r.status,
          domain: r.domain,
          raw_password_revealed_to_agent: false,
          otp_revealed_to_agent: false,
          ...(passId ? { pass_id: passId, pass_label: `${r.domain} (auto-created)` } : {}),
          ...(r.error ? { error: r.error } : {}),
          next_action: accountCreationNextAction(r.status),
          expires_at: r.expires_at,
        },
      });
    },
  );

  // POST /api/agent/v1/account-access-resolutions/:requestId/complete
  // Called by the agent after the signup form has been submitted and the outcome is known.
  // Only valid when status is credential_generated. Accepts optional access_method for v2 flows.
  server.post<{
    Params: { requestId: string };
    Body: { outcome?: "authenticated" | "signup_failed" | "email_verification_pending"; access_method?: AccountAccessMethod };
  }>(
    "/api/agent/v1/account-access-resolutions/:requestId/complete",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { requestId } = req.params;
      const { outcome, access_method } = req.body ?? {};

      const VALID_OUTCOMES = ["authenticated", "signup_failed", "email_verification_pending"];
      if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
        return reply.status(400).send({
          ok: false,
          error: { code: "VALIDATION_ERROR", message: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}.` },
        });
      }

      const r = accountCreationRequests.get(requestId);
      if (!r) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Account creation request not found." } });
      }
      if (r.delegation_id !== delegation.id) {
        return reply.status(403).send({ ok: false, error: { code: "FORBIDDEN", message: "This account creation request belongs to a different delegation." } });
      }
      if (r.status !== "credential_generated") {
        return reply.status(409).send({
          ok: false,
          error: { code: "INVALID_STATE", message: `Cannot complete: request status is '${r.status}'. Only credential_generated requests can be completed.` },
        });
      }

      const now = new Date().toISOString();
      if (outcome === "authenticated") {
        r.status = "completed";
        r.completed_at = now;
        // Infer access_method for v2 flows. Agent can provide it explicitly; otherwise infer from vault state.
        if (access_method) {
          r.access_method = access_method;
        } else if (r.vault_pass_id) {
          r.access_method = "login_password";
        } else if (r.email_verified) {
          r.access_method = "passwordless_email_otp";
        } else {
          r.access_method = "unknown";
        }
      } else {
        r.status = "failed";
        r.error = outcome === "signup_failed"
          ? "Agent reported signup failed."
          : "Email verification required before login is possible.";
      }
      accountCreationRequests.set(requestId, r);
      schedulePersist();

      return reply.send({
        ok: true,
        data: {
          request_id: r.request_id,
          status: r.status,
          domain: r.domain,
          raw_password_revealed_to_agent: false,
          otp_revealed_to_agent: false,
          ...(r.access_method ? { access_method: r.access_method } : {}),
          ...(r.completed_at ? { completed_at: r.completed_at } : {}),
          ...(r.error ? { error: r.error } : {}),
        },
      });
    },
  );

  // POST /api/agent/v1/account-creation-steps
  // v2: After an AccountCreationRequest is approved, the agent calls this once per
  // sensitive page field (email, password, email_otp, etc.). Antigen resolves each
  // field privately and returns a next_action. Raw secrets are never returned.
  server.post<{
    Body: {
      account_creation_request_id?: string;
      browser_session_id?: string;
      domain?: string;
      page_url?: string;
      requested_fields?: AccountCreationStepKind[];
      element_hints?: Array<{
        field_kind: AccountCreationStepKind;
        selector_hint?: string;
        label_hint?: string;
        placeholder_hint?: string;
      }>;
      reason?: string;
    };
  }>(
    "/api/agent/v1/account-creation-steps",
    async (req, reply) => {
      const delegation = await requireAgentToken(req, reply);
      if (!delegation) return;

      const { account_creation_request_id, browser_session_id, page_url, requested_fields, element_hints, reason } = req.body ?? {};
      const rawDomain = req.body?.domain;

      if (!account_creation_request_id || typeof account_creation_request_id !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "account_creation_request_id is required.");
      }
      if (!rawDomain || typeof rawDomain !== "string" || rawDomain.trim() === "") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!page_url || typeof page_url !== "string" || page_url.trim() === "") {
        return sendError(reply, 400, "VALIDATION_ERROR", "page_url is required.");
      }
      if (!reason || typeof reason !== "string" || reason.trim() === "") {
        return sendError(reply, 400, "VALIDATION_ERROR", "reason is required.");
      }
      if (!Array.isArray(requested_fields) || requested_fields.length === 0) {
        return sendError(reply, 400, "VALIDATION_ERROR", "requested_fields must be a non-empty array.");
      }

      const domain = normalizeAccountDomain(rawDomain);

      // Domain-URL match guard
      let pageHostname: string;
      try {
        pageHostname = new URL(page_url).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        return sendError(reply, 400, "INVALID_PAGE_URL", "page_url is not a valid URL.");
      }
      if (pageHostname !== domain && !pageHostname.endsWith(`.${domain}`)) {
        return sendError(reply, 422, "DOMAIN_MISMATCH",
          `page_url hostname '${pageHostname}' does not match domain '${domain}'. Antigen will not resolve credentials for a different domain.`);
      }

      // Validate ownership of the AccountCreationRequest
      const acReq = accountCreationRequests.get(account_creation_request_id);
      if (!acReq) {
        return sendError(reply, 404, "NOT_FOUND", "Account creation request not found.");
      }
      if (acReq.delegation_id !== delegation.id) {
        return sendError(reply, 403, "FORBIDDEN", "This account creation request belongs to a different delegation.");
      }
      if (acReq.status !== "approved" && acReq.status !== "credential_generated") {
        return sendError(reply, 409, "INVALID_STATE",
          `Cannot request steps: account creation request status is '${acReq.status}'. Must be approved or credential_generated.`);
      }

      const now = new Date();
      const stepRequestId = newId("acrstep");
      const stepRequest: AccountCreationStepRequest = {
        step_request_id: stepRequestId,
        account_creation_request_id,
        user_id: MOCK_USER_ID,
        delegation_id: delegation.id,
        domain,
        page_url: page_url.trim(),
        requested_fields,
        status: "pending_user",
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        raw_email_revealed_to_agent: false,
        raw_username_revealed_to_agent: false,
        raw_password_revealed_to_agent: false,
        otp_revealed_to_agent: false,
      };

      // Process the first requested field (v2 scope: one field per call)
      const primaryField = requested_fields[0];

      if (primaryField === "account_email" || primaryField === "username") {
        // Look up account_creation_email preference in privateProfileMemory
        const emailMemory = Array.from(privateProfileMemory.values()).find(
          (m) => m.field_kind === "account_creation_email" && m.user_id === MOCK_USER_ID,
        );

        if (emailMemory) {
          // Create a ProfileFieldFillRequest directly (bypasses the public endpoint's
          // field-kind restriction — account_creation_email is not agent-fillable via
          // the public profile fill API, but is valid here under Antigen supervision).
          const fillRequestId = newId("pffr");
          const hint = element_hints?.find((h) => h.field_kind === primaryField);
          const pffr: ProfileFieldFillRequest = {
            fill_request_id: fillRequestId,
            user_id: MOCK_USER_ID,
            delegation_id: delegation.id,
            domain,
            page_url: page_url.trim(),
            ...(browser_session_id ? { browser_session_id } : {}),
            requested_fields: [{
              key: "account_creation_email" as ProfileFieldKind,
              ...(hint?.selector_hint ? { selector_hint: hint.selector_hint } : {}),
              ...(hint?.label_hint ? { label: hint.label_hint } : {}),
              ...(hint?.placeholder_hint ? { placeholder: hint.placeholder_hint } : {}),
              reason: "Account creation email field fill",
            }],
            reason: reason.trim(),
            status: "pending",
            raw_profile_value_revealed_to_agent: false,
            raw_profile_values_revealed_to_agent: false,
            created_at: now.toISOString(),
            expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
          };
          profileFieldFillRequests.set(fillRequestId, pffr);
          schedulePersist();

          stepRequest.status = "resolved";
          stepRequest.profile_fill_request_id = fillRequestId;
          stepRequest.resolved_at = now.toISOString();
          accountCreationStepRequests.set(stepRequestId, stepRequest);
          schedulePersist();

          return reply.send({
            ok: true,
            data: {
              step_request_id: stepRequestId,
              account_creation_request_id,
              status: "resolved" as const,
              resolved_fields: [primaryField],
              next_action: "execute_profile_field_fill" as const,
              profile_fill_request_id: fillRequestId,
              raw_email_revealed_to_agent: false,
              raw_username_revealed_to_agent: false,
              raw_password_revealed_to_agent: false,
              otp_revealed_to_agent: false,
            },
          });
        }

        // Email preference not found — surface to user via step card
        stepRequest.status = "pending_user";
        accountCreationStepRequests.set(stepRequestId, stepRequest);
        schedulePersist();

        return reply.send({
          ok: true,
          data: {
            step_request_id: stepRequestId,
            account_creation_request_id,
            status: "pending_user" as const,
            resolved_fields: [],
            next_action: "wait_for_user" as const,
            raw_email_revealed_to_agent: false,
            raw_username_revealed_to_agent: false,
            raw_password_revealed_to_agent: false,
            otp_revealed_to_agent: false,
          },
        });

      } else if (primaryField === "password") {
        // Idempotent: reuse existing vault_pass_id if already generated
        let passId = acReq.vault_pass_id;

        if (!passId) {
          // Generate a strong random password — 32 bytes → base64url → 24 chars (~143 bits).
          // Never stored in plaintext; immediately passed to createAndStoreVaultPass.
          const generatedPassword = randomBytes(32).toString("base64url").slice(0, 24);
          const result = await createAndStoreVaultPass({
            label: `${acReq.domain} (auto-created)`,
            kind: "login_password",
            domain: acReq.domain,
            username: `agent-created@${acReq.domain}`,
            password: generatedPassword,
          });

          if (!result.ok) {
            stepRequest.status = "failed";
            stepRequest.error = "VAULT_STORE_ERROR";
            accountCreationStepRequests.set(stepRequestId, stepRequest);
            schedulePersist();
            return sendError(reply, 500, "VAULT_STORE_ERROR", "Failed to generate and store credential in vault.");
          }

          passId = result.pass.pass_id;
          acReq.vault_pass_id = passId;
          acReq.credential_material_created = true;
          // Ensure the request moves to credential_generated if it was only approved
          if (acReq.status === "approved") {
            acReq.status = "credential_generated";
          }
          accountCreationRequests.set(account_creation_request_id, acReq);
        }

        stepRequest.status = "resolved";
        stepRequest.pass_id = passId;
        stepRequest.resolved_at = now.toISOString();
        accountCreationStepRequests.set(stepRequestId, stepRequest);
        schedulePersist();

        return reply.send({
          ok: true,
          data: {
            step_request_id: stepRequestId,
            account_creation_request_id,
            status: "resolved" as const,
            resolved_fields: [primaryField],
            next_action: "request_secret_field_injection" as const,
            pass_id: passId,
            raw_email_revealed_to_agent: false,
            raw_username_revealed_to_agent: false,
            raw_password_revealed_to_agent: false,
            otp_revealed_to_agent: false,
          },
        });

      } else if (primaryField === "email_otp") {
        // Create a SecurityChallenge for email verification.
        // The agent then uses wait_for_security_challenge + inject_security_challenge_code.
        const challengeId = newId("chlg");
        const challenge: SecurityChallenge = {
          challenge_id: challengeId,
          user_id: MOCK_USER_ID,
          delegation_id: delegation.id,
          browser_session_id: typeof browser_session_id === "string" ? browser_session_id : undefined,
          domain,
          page_url: page_url.trim(),
          challenge_type: "email_device_verification",
          status: "pending_user",
          masked_destination: undefined,
          instructions: `${domain} requires an email verification code. Enter the code in the Antigen UI at /route-run-approvals.`,
          raw_code_revealed_to_agent: false,
          created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
        };
        securityChallenges.set(challengeId, challenge);

        // Mark email_verified on the parent request so completion can infer passwordless_email_otp
        acReq.email_verified = true;
        accountCreationRequests.set(account_creation_request_id, acReq);

        stepRequest.status = "pending_external";
        stepRequest.email_verification_request_id = challengeId;
        accountCreationStepRequests.set(stepRequestId, stepRequest);
        schedulePersist();

        return reply.send({
          ok: true,
          data: {
            step_request_id: stepRequestId,
            account_creation_request_id,
            status: "pending_external" as const,
            resolved_fields: [],
            next_action: "wait_for_email_otp" as const,
            email_verification_request_id: challengeId,
            raw_email_revealed_to_agent: false,
            raw_username_revealed_to_agent: false,
            raw_password_revealed_to_agent: false,
            otp_revealed_to_agent: false,
          },
        });

      } else {
        // Unsupported step kind
        stepRequest.status = "failed";
        stepRequest.error = "UNSUPPORTED_ACCOUNT_CREATION_STEP";
        accountCreationStepRequests.set(stepRequestId, stepRequest);
        schedulePersist();

        return reply.send({
          ok: true,
          data: {
            step_request_id: stepRequestId,
            account_creation_request_id,
            status: "failed" as const,
            resolved_fields: [],
            next_action: "retry" as const,
            error: `UNSUPPORTED_ACCOUNT_CREATION_STEP: '${primaryField}' is not supported in v2. Supported: account_email, username, password, email_otp.`,
            raw_email_revealed_to_agent: false,
            raw_username_revealed_to_agent: false,
            raw_password_revealed_to_agent: false,
            otp_revealed_to_agent: false,
          },
        });
      }
    },
  );
}
