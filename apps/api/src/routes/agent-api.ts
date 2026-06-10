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
import { realisticClickByDescription, realisticClickKnownBox, realisticTypeTextViaCDP, realisticTypeKnownBox, setFieldValueKnownBox, scrollKnownBoxIntoView, injectNavigationMediationBannerViaCDP } from "../runtime/realisticBrowserActions.js";
import { extractAntigenSnapshotCandidatesViaCDP, extractAntigenPageMetaViaCDP } from "../runtime/antigenSnapshotRuntime.js";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import { createAntigenSnapshotRecord, toExternalAntigenSnapshotElement, resolveAntigenRefForSession, refreshAntigenSnapshotLease, ANTIGEN_SNAPSHOT_TTL_MS } from "../runtime/antigenSnapshotStore.js";
import { buildAntigenPageMap } from "../runtime/antigenSnapshotPageMap.js";
import { readLiveCdpPageUrl, resolveSnapshotCdpTarget } from "../runtime/cdpTargetSelection.js";
// Dev-only, behavior-neutral, sanitized browser run trace (gated by
// ANTIGEN_BROWSER_TRACE=true). Recording never alters tool results and never
// leaks cdp_url, coordinates, profile paths, secrets, or raw typed text.
import { recordBrowserTraceEvent, sanitizeTraceUrl } from "../runtime/browserRunTrace.js";
import { BrowserTimingScope } from "../runtime/browserTiming.js";
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
import { executeSecretInjectionViaCDP } from "../runtime/secretInjection.js";
import { resolveSecretInjectionCdpEndpoint } from "../runtime/cdpEndpointResolver.js";
import { executePaymentCardFillViaCDP, validateCardFillSelector } from "../runtime/paymentCardFill.js";
import { captureRedactedScreenshot } from "../runtime/screenshotRedaction.js";
import {
  registerProtectedIframeRedaction,
  getProtectedIframeRedactionFields,
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

  // Resolve whether the dev pointer overlay should be injected for this action.
  // Tri-state: an explicit ANTIGEN_POINTER_DEBUG_OVERLAY env wins in both
  // directions; otherwise the overlay follows the headed window (visible session).
  // This decouples overlay activation from the lone API env var so headed QA shows
  // the overlay without separately setting it on the API process — mirroring how
  // headed launch is driven by the session's visible mode.
  const resolveOverlayEnabled = (s: { mode: "headless" | "visible" }): boolean => {
    const env = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY;
    if (env === "true") return true;
    if (env === "false") return false;
    return s.mode === "visible";
  };

  server.post("/api/agent/v1/runtime/browser-click", async (req, reply) => {
    const delegation = await requireAgentToken(req, reply);
    if (!delegation) return;

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

      let refResult = await realisticClickKnownBox({
        cdpUrl: session.cdp_url,
        box: el.box,
        sessionId: session.browser_session_id,
        userId: MOCK_USER_ID,
        debugOverlay: resolveOverlayEnabled(session),
        // Live-URL guard: fail closed if the page navigated since the snapshot.
        expectedUrl: snapshotUrl,
        expected,
      });

      // Same-page logical-ref recovery (env-gated, default-off). A recoverable
      // ANTIGEN_REF_STALE on a CLEARLY low-risk click target is retried against a
      // unique logically-equivalent element re-found on the same page. Strict
      // Phase 4B already ran above and failed; recovery only PROPOSES a fresh box
      // and re-runs the unchanged realisticClickKnownBox (Phase 4B is still the
      // authoritative gate). recovery_state records the disposition; the raw stale
      // reason is surfaced only as a SANITIZED stale_reason / stability_hint.
      let recoveryState: AntigenRecoveryState = "disabled";
      let recoveredFromStaleReason: ReturnType<typeof sanitizeStaleReason> | undefined;
      if (!refResult.success && refResult.error === "ANTIGEN_REF_STALE") {
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
          ...(failCode === "ANTIGEN_REF_STALE" ? { recovery_state: recoveryState } : {}),
          ...(staleSignal ? { stale_reason: staleSignal.stale_reason } : {}),
          ...(ttlFail ? { ttl_recovery_state: ttlFail } : {}),
        });
        const ttlFailField = ttlFail ? { ttl_recovery_state: ttlFail } : {};
        if (refResult.error === "ANTIGEN_REF_PAGE_CHANGED") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_PAGE_CHANGED", message: "The page changed since this snapshot. Take a fresh antigen_snapshot.", ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_OUT_OF_VIEWPORT") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_OUT_OF_VIEWPORT", message: "Antigen ref is outside the current viewport. Scroll the target into view, take a new antigen_snapshot, and retry.", ...(staleSignal ?? {}), ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_STALE") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_STALE", message: "Antigen ref is stale. Take a new antigen_snapshot and retry.", ...(staleSignal ?? {}), recovery_state: recoveryState, ...ttlFailField } });
        }
        const code = refResult.error === "REALISM_DISABLED" ? "REALISM_DISABLED" : "REALISTIC_CLICK_FAILED";
        return reply.status(422).send({ ok: false, error: { code, message: refResult.error ?? "Realistic click failed.", ...ttlFailField } });
      }

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
        ...(recoveryState === "recovered" ? { recovery_state: recoveryState, ...(recoveredFromStaleReason ? { stale_reason: recoveredFromStaleReason.stale_reason } : {}) } : {}),
        ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
      });

      return reply.send({
        ok: true,
        data: {
          mode: "realistic_pointer_click",
          ...(refResult.pointer_start_source !== undefined ? { pointer_start_source: refResult.pointer_start_source } : {}),
          ...(refResult.pointer_path_point_count !== undefined ? { pointer_path_point_count: refResult.pointer_path_point_count } : {}),
          ...(refResult.pointer_state_persisted !== undefined ? { pointer_state_persisted: refResult.pointer_state_persisted } : {}),
          // Recovery telemetry: present only when same-page logical recovery saved
          // this action, so we can measure how often it helps. Enum + sanitized
          // stale reason only — never boxes/coordinates/hrefs.
          ...(recoveryState === "recovered"
            ? {
                recovery_state: recoveryState,
                ...(recoveredFromStaleReason ? { recovered_from_stale_reason: recoveredFromStaleReason.stale_reason } : {}),
              }
            : {}),
          ...(ttlRecovered ? { ttl_recovery_state: "ttl_expired_recovered" as const } : {}),
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

    recordBrowserTraceEvent(session.browser_session_id, {
      event_type: "browser_click", browser_runtime_id: session.browser_session_id,
      tool: "browser_click", click_path: "description",
      pointer_dispatch: true, result_code: "realistic_success",
      url_after: sanitizeTraceUrl(result.current_url),
    });

    return reply.send({
      ok: true,
      data: {
        mode: "realistic_pointer_click",
        ...(result.pointer_start_source !== undefined ? { pointer_start_source: result.pointer_start_source } : {}),
        ...(result.pointer_path_point_count !== undefined ? { pointer_path_point_count: result.pointer_path_point_count } : {}),
        ...(result.pointer_state_persisted !== undefined ? { pointer_state_persisted: result.pointer_state_persisted } : {}),
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
        if (refResult.error === "ANTIGEN_REF_PAGE_CHANGED") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_PAGE_CHANGED", message: "The page changed since this snapshot. Take a fresh antigen_snapshot.", ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_OUT_OF_VIEWPORT") {
          return reply.status(422).send({ ok: false, error: { code: "ANTIGEN_REF_OUT_OF_VIEWPORT", message: "Antigen ref is outside the current viewport. Scroll the target into view, take a new antigen_snapshot, and retry.", ...ttlFailField } });
        }
        if (refResult.error === "ANTIGEN_REF_STALE") {
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

    // Visible-session trust signal: @playwright/mcp owns the navigation and the new
    // page DOM destroyed any prior overlay, so re-inject a brief "Antigen is
    // mediating this browser" banner + cursor. Fire-and-forget and fail-open — never
    // awaited, so a slow/failed banner can never block or fail this response (the
    // adapter calls this with a short timeout).
    if (resolveOverlayEnabled(session)) {
      void injectNavigationMediationBannerViaCDP({
        cdpUrl: session.cdp_url,
        pointer: { x: proxyX, y: proxyY },
      }).catch(() => {});
    }

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

    let candidates: AntigenSnapshotCandidate[];
    try {
      candidates = await extractAntigenSnapshotCandidatesViaCDP({
        cdpUrl: session.cdp_url,
        maxCandidates,
        viewportOnly,
        resolvedTarget,
      });
      timing.mark("candidate_extract");
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

    // Best-effort page metadata for the Snapshot v2 page map. NEVER fails the
    // snapshot — candidate extraction above is the authoritative path. The raw
    // viewport/scroll numbers are consumed server-side to derive qualitative
    // fields only; they are never emitted to the agent.
    const pageMeta = await extractAntigenPageMetaViaCDP({ cdpUrl: session.cdp_url, resolvedTarget });
    timing.mark("page_metadata");

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
      return st
        ? {
            ...ext,
            viewport_status: st.viewport_status,
            scroll_required: st.scroll_required,
            stability_hint: st.stability_hint,
          }
        : ext;
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
    });

    timing.mark("serialize");
    // Sanitized: stage labels + durations + scalar counts only. No URLs/refs/geometry.
    timing.end({ element_count: snapshot.element_count, viewport_only: viewportOnly, rebound });

    return reply.send({
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
        action_hints: pageMap.action_hints,
        elements: externalElements,
      },
    });
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
    const shot = await captureRedactedScreenshot({
      browserWsUrl: resolved.browserWsUrl,
      pageTargetId: resolved.target.id,
      expectedIframeFields,
    });

    if (!shot.ok) {
      // Counts/booleans only — never boxes, values, or base64.
      recordBrowserTraceEvent(session.browser_session_id, {
        event_type: "browser_tool_rejected",
        browser_runtime_id: session.browser_session_id,
        tool: "browser_take_screenshot",
        error_code: "SCREENSHOT_REDACTION_FAILED",
      });
      return sendError(
        reply,
        502,
        "SCREENSHOT_REDACTION_FAILED",
        "Antigen could not capture a redacted screenshot. To protect filled sensitive values it will not return an unredacted image.",
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
        const hint = rawMsg.toLowerCase().includes("element not found") || rawMsg.toLowerCase().includes("not found")
          ? `${rawMsg}. Verify the browser_session_id in the fill request targets the runtime page that has the checkout form open.`
          : rawMsg;
        return sendError(reply, 500, "CDP_FILL_FAILED", hint);
      }

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
          // Iframe metadata — present only when fill was routed through an iframe provider
          ...(fillResult.iframeProvider ? {
            iframe_provider: fillResult.iframeProvider,
            iframe_origin: fillResult.iframeOrigin,
            iframe_path: fillResult.iframePath,
          } : {}),
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

      // Update last_used_at and uses on each memory item
      for (const entry of entries) {
        if (entry.status === "filled") {
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

      // Determine final status
      const filledCount = entries.filter((e) => e.status === "filled").length;
      let finalStatus: ProfileFieldFillRequest["status"];
      if (filledCount === entries.length) finalStatus = "filled";
      else if (filledCount > 0) finalStatus = "partial";
      else finalStatus = "failed";

      fillRequest.status = finalStatus;
      fillRequest.filled_at = NOW;
      profileFieldFillRequests.set(fillRequestId, fillRequest);
      schedulePersist();

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
