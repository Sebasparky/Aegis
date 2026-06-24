/**
 * Human Presence Relay v1 — HumanVerificationRequest lifecycle.
 *
 * Shared by the internal routes (routes/human-verification.ts), the agent API
 * (auto-create on snapshot + the HUMAN_VERIFICATION_REQUIRED guard + the agent
 * poll endpoint), and the receipts layer.
 *
 * State machine:
 *   pending_user → in_progress  (hold-start / confirm accepted)
 *   in_progress  → completed    (post-release/post-click probe: challenge gone)
 *   in_progress  → in_progress  (probe still present — retry until TTL; the
 *                                hold duration is user-controlled)
 *   *            → expired      (3-minute TTL, lazy; or API restart)
 *   *            → cancelled    (user cancel, or challenge vanished untouched)
 *   *            → failed       (unrecoverable CDP/browser-session error only —
 *                                "probe still present" is never a failure)
 *
 * SAFETY: requests carry metadata only — never selectors, coordinates, boxes,
 * CDP expressions, cookies, or gesture recordings. `purchase_authorized` is the
 * literal false on every request: live presence never authorizes a purchase.
 */

import type {
  HumanVerificationChallengeType,
  HumanVerificationRequest,
  HumanVerificationStatus,
} from "@aegis/types";

import {
  humanVerificationRequests,
  userApprovalReceipts,
  sensitiveGrants,
  newId,
  MOCK_USER_ID,
} from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { buildSignedUserApprovalReceipt } from "./userApprovalReceiptSigning.js";
import { buildSensitiveGrant } from "./sensitiveGrants.js";
import { deleteAntigenSnapshotsForSession } from "../runtime/antigenSnapshotStore.js";
import {
  clearActiveHumanVerification,
  setActiveHumanVerification,
} from "../runtime/humanVerificationState.js";
import { cancelHoldSession } from "../runtime/humanPresenceRelay.js";

/** Request TTL — tight by design: presence needs the user at the screen against
 * a live challenge whose site-side token expires quickly. Re-detection on the
 * next snapshot simply mints a fresh request. */
export const HUMAN_VERIFICATION_TTL_MS = 3 * 60 * 1000;

/** Presence-of-record grant TTL after completion (not standing authority). */
const HUMAN_PRESENCE_GRANT_TTL_MS = 10 * 60 * 1000;

const TERMINAL_STATUSES: ReadonlySet<HumanVerificationStatus> = new Set([
  "completed",
  "expired",
  "failed",
  "cancelled",
]);

export function isTerminalHumanVerificationStatus(status: HumanVerificationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const CHALLENGE_LABELS: Record<HumanVerificationChallengeType, string> = {
  press_and_hold: "Press & hold",
  checkbox_human: "Confirm presence",
  image_captcha: "Image captcha",
  text_captcha: "Text captcha",
  puzzle_captcha: "Puzzle captcha",
  unknown_human_verification: "Human verification",
};

/** v1 relay-capable challenge types; everything else is a manual user handoff. */
export const RELAY_CAPABLE_CHALLENGE_TYPES: ReadonlySet<HumanVerificationChallengeType> = new Set([
  "press_and_hold",
  "checkbox_human",
]);

export function buildHumanVerificationInstructions(
  challengeType: HumanVerificationChallengeType,
  domain: string,
  pageLevel?: boolean,
): string {
  // Page-level walls put the control inside a cross-origin iframe Aegis cannot
  // relay into — manual completion regardless of the detected sub-type.
  if (pageLevel) {
    return `${domain} is showing a full-page human-verification wall whose control is inside a secured frame Aegis can't relay into. Complete the visible challenge directly in the agent's browser window, then mark it done in the Aegis UI — the agent will take a fresh snapshot and resume.`;
  }
  switch (challengeType) {
    case "press_and_hold":
      return `${domain} is asking for a live human press-and-hold. Open the Aegis UI and press and hold the verification button — Aegis mirrors your live hold into the browser. Releasing early releases in the browser too.`;
    case "checkbox_human":
      return `${domain} is asking you to confirm you are human. Open the Aegis UI and tap "Confirm presence" — Aegis mirrors a single click into the browser challenge.`;
    case "image_captcha":
    case "text_captcha":
    case "puzzle_captcha":
      return `${domain} is showing a captcha that requires manual human solving. Aegis never auto-solves captchas — complete it directly in the agent's browser window, then mark it done in the Aegis UI.`;
    default:
      return `${domain} is showing a human-verification challenge Aegis could not classify. Complete it directly in the agent's browser window, then mark it done in the Aegis UI.`;
  }
}

export function challengeTypeLabel(challengeType: HumanVerificationChallengeType): string {
  return CHALLENGE_LABELS[challengeType] ?? "Human verification";
}

/**
 * Lazy expiry — call before reading a request anywhere. Returns true if mutated.
 *
 * NOTE: expiry does NOT clear the session's active-verification marker — the
 * challenge is presumably still blocking the live page, so the pre-action
 * guard must keep failing fast (with the terminal status) until a fresh
 * snapshot re-evaluates the page and either re-creates a request or clears
 * the marker. Only "challenge actually gone" paths clear the marker.
 */
export function lazyExpireHumanVerificationRequest(request: HumanVerificationRequest): boolean {
  if (isTerminalHumanVerificationStatus(request.status)) return false;
  if (new Date(request.expires_at).getTime() > Date.now()) return false;
  request.status = "expired";
  request.error = request.error ?? "ttl_expired";
  cancelHoldSession(request.request_id);
  humanVerificationRequests.set(request.request_id, request);
  schedulePersist();
  return true;
}

/** The one active (non-terminal, unexpired) request for a browser session, if any. */
export function findActiveHumanVerificationRequest(
  browserSessionId: string,
): HumanVerificationRequest | undefined {
  for (const request of humanVerificationRequests.values()) {
    if (request.browser_session_id !== browserSessionId) continue;
    if (isTerminalHumanVerificationStatus(request.status)) continue;
    lazyExpireHumanVerificationRequest(request);
    if (!isTerminalHumanVerificationStatus(request.status)) return request;
  }
  return undefined;
}

export interface CreateHumanVerificationParams {
  user_id: string;
  delegation_id: string;
  agent_name?: string;
  browser_session_id: string;
  domain: string;
  page_url: string;
  challenge_type: HumanVerificationChallengeType;
  surface_title?: string;
  /** Page-level cross-origin-iframe wall → manual completion only. */
  page_level?: boolean;
}

/**
 * Auto-create on snapshot detection. Dedupe: one active request per browser
 * session — an existing pending/in-progress request for the same domain is
 * reused (challenge type/title refreshed while still pending_user) instead of
 * spawning duplicates on every snapshot.
 */
export function createOrReuseHumanVerificationRequest(
  params: CreateHumanVerificationParams,
): HumanVerificationRequest {
  const existing = findActiveHumanVerificationRequest(params.browser_session_id);
  if (existing && existing.domain === params.domain) {
    if (existing.status === "pending_user") {
      // Refresh classification while the user hasn't engaged yet.
      if (
        existing.challenge_type !== params.challenge_type ||
        (existing.page_level ?? false) !== (params.page_level ?? false)
      ) {
        existing.challenge_type = params.challenge_type;
        if (params.page_level) existing.page_level = true;
        else delete existing.page_level;
        existing.instructions = buildHumanVerificationInstructions(
          params.challenge_type,
          params.domain,
          params.page_level,
        );
      }
      if (params.surface_title) existing.surface_title = params.surface_title;
      existing.page_url = params.page_url;
      humanVerificationRequests.set(existing.request_id, existing);
      schedulePersist();
    }
    setActiveHumanVerification(params.browser_session_id, {
      request_id: existing.request_id,
      domain: params.domain,
      detected_at: new Date().toISOString(),
    });
    return existing;
  }
  // A different-domain active request for this session is stale — the page
  // moved on. Cancel it before minting the new one.
  if (existing) {
    cancelHumanVerificationRequest(existing, "superseded_by_new_domain");
  }

  const now = new Date();
  const request: HumanVerificationRequest = {
    request_id: newId("hvr"),
    user_id: params.user_id,
    delegation_id: params.delegation_id,
    ...(params.agent_name ? { agent_name: params.agent_name } : {}),
    browser_session_id: params.browser_session_id,
    domain: params.domain,
    page_url: params.page_url,
    challenge_type: params.challenge_type,
    status: "pending_user",
    ...(params.surface_title ? { surface_title: params.surface_title } : {}),
    ...(params.page_level ? { page_level: true as const } : {}),
    instructions: buildHumanVerificationInstructions(
      params.challenge_type,
      params.domain,
      params.page_level,
    ),
    user_presence_required: true,
    purchase_authorized: false,
    hold_attempt_count: 0,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + HUMAN_VERIFICATION_TTL_MS).toISOString(),
  };
  humanVerificationRequests.set(request.request_id, request);
  setActiveHumanVerification(params.browser_session_id, {
    request_id: request.request_id,
    domain: params.domain,
    detected_at: now.toISOString(),
  });
  schedulePersist();
  return request;
}

/**
 * Completion: the challenge cleared after live user presence. Invalidates every
 * prior ag_* ref for the session (deleteAntigenSnapshotsForSession) so the
 * agent MUST take a fresh antigen_snapshot before any further action, clears
 * the guard marker, and (non-blocking) creates the signed UserApprovalReceipt +
 * SensitiveGrant presence record.
 */
export function markHumanVerificationCompleted(
  request: HumanVerificationRequest,
  completionMode: "relayed_live_presence" | "manual_user_completion" = "relayed_live_presence",
): void {
  if (isTerminalHumanVerificationStatus(request.status)) return;
  request.status = "completed";
  request.completed_at = new Date().toISOString();
  request.completion_mode = completionMode;
  delete request.error;
  humanVerificationRequests.set(request.request_id, request);
  // Fresh-snapshot requirement, enforced mechanically: old refs now resolve
  // no_snapshot → ANTIGEN_REF_NOT_FOUND → "Take a fresh antigen_snapshot."
  deleteAntigenSnapshotsForSession(request.browser_session_id, request.user_id);
  clearActiveHumanVerification(request.browser_session_id);
  schedulePersist();
  createHumanPresenceGrant(request).catch((err) => {
    console.error("[human-verification] Failed to create presence grant:", err);
  });
}

/**
 * The challenge disappeared from a fresh snapshot. Completed only if the user
 * actually relayed presence (a hold/confirm attempt happened) — presence that
 * didn't happen is never credited.
 */
export function resolveChallengeNoLongerPresent(request: HumanVerificationRequest): void {
  if (isTerminalHumanVerificationStatus(request.status)) return;
  if (request.hold_attempt_count > 0) {
    markHumanVerificationCompleted(request);
    return;
  }
  request.status = "cancelled";
  request.error = "challenge_no_longer_present";
  humanVerificationRequests.set(request.request_id, request);
  clearActiveHumanVerification(request.browser_session_id);
  schedulePersist();
}

/**
 * User cancel / supersession. The guard marker is NOT cleared — the challenge
 * is still blocking the live page; only a fresh snapshot clears or re-creates.
 */
export function cancelHumanVerificationRequest(
  request: HumanVerificationRequest,
  reason?: string,
): void {
  if (isTerminalHumanVerificationStatus(request.status)) return;
  request.status = "cancelled";
  if (reason) request.error = reason;
  cancelHoldSession(request.request_id);
  humanVerificationRequests.set(request.request_id, request);
  schedulePersist();
}

/** Unrecoverable browser/CDP failure. Guard marker stays (see cancel note). */
export function failHumanVerificationRequest(
  request: HumanVerificationRequest,
  reason: string,
): void {
  if (isTerminalHumanVerificationStatus(request.status)) return;
  request.status = "failed";
  request.error = reason;
  cancelHoldSession(request.request_id);
  humanVerificationRequests.set(request.request_id, request);
  schedulePersist();
}

/**
 * Signed UserApprovalReceipt + SensitiveGrant for a completed live-presence
 * relay. Mirrors createChallengeGrant (security-challenges.ts). The grant is a
 * RECORD of presence, not standing authority (short TTL), and never carries
 * gesture data — only the request id. Grant only exists if the UAR signed.
 */
export async function createHumanPresenceGrant(request: HumanVerificationRequest): Promise<void> {
  const now = new Date().toISOString();
  const uarId = newId("uar");

  const uar = await buildSignedUserApprovalReceipt({
    receipt_id: uarId,
    receipt_type: "user_approval",
    schema_version: "1.0",
    issuer: "aegis",
    created_at: now,
    user_id: request.user_id,
    delegation_id: request.delegation_id,
    ...(request.agent_name ? { agent_name: request.agent_name } : {}),
    approval_id: request.request_id,
    approval_source: "human_presence_verification",
    target_domain: request.domain,
    requested_action_summary:
      request.completion_mode === "manual_user_completion"
        ? `User manually completed a ${challengeTypeLabel(request.challenge_type).toLowerCase()} challenge in the browser and confirmed it in the Aegis UI. Does not authorize any purchase or payment.`
        : `Live human presence relayed through the Aegis UI to clear a ${challengeTypeLabel(request.challenge_type).toLowerCase()} challenge. No gesture was stored or replayed. Does not authorize any purchase or payment.`,
    risk_level: "high",
    decision: "approved",
    decided_at: request.completed_at ?? now,
    decision_source: "user_click",
    raw_secrets_in_receipt: false,
    raw_credentials_in_receipt: false,
  });

  userApprovalReceipts.set(uarId, uar);

  const grant = buildSensitiveGrant({
    grant_id: newId("sg"),
    grant_type: "human_presence_verification",
    scope: {
      user_id: request.user_id,
      delegation_id: request.delegation_id,
      domain: request.domain,
      human_verification_request_id: request.request_id,
    },
    expires_at: new Date(Date.now() + HUMAN_PRESENCE_GRANT_TTL_MS).toISOString(),
    linked_uar_id: uarId,
    created_at: now,
  });

  sensitiveGrants.set(grant.grant_id, grant);
  schedulePersist();
}

// ─── Safe views ───────────────────────────────────────────────────────────────

/**
 * Safe view shared by the internal UI and the agent API. Excludes `user_id`.
 * Contains NO selectors, coordinates, boxes, CDP expressions, or gesture data
 * (the underlying record never holds them either — defense in depth).
 */
export function toHumanVerificationRequestView(request: HumanVerificationRequest) {
  return {
    request_id: request.request_id,
    delegation_id: request.delegation_id,
    agent_name: request.agent_name,
    browser_session_id: request.browser_session_id,
    domain: request.domain,
    page_url: request.page_url,
    challenge_type: request.challenge_type,
    challenge_label: challengeTypeLabel(request.challenge_type),
    // A page-level wall's control is inside a cross-origin iframe the relay can't
    // mirror into — never relay-capable regardless of the detected sub-type.
    relay_capable: !request.page_level && RELAY_CAPABLE_CHALLENGE_TYPES.has(request.challenge_type),
    page_level: request.page_level,
    status: request.status,
    surface_title: request.surface_title,
    instructions: request.instructions,
    user_presence_required: true as const,
    purchase_authorized: false as const,
    hold_attempt_count: request.hold_attempt_count,
    completion_mode: request.completion_mode,
    created_at: request.created_at,
    expires_at: request.expires_at,
    started_at: request.started_at,
    completed_at: request.completed_at,
    resumed_at: request.resumed_at,
    error: request.error,
  };
}

/** Per-status agent guidance appended to the agent-facing view. */
export function humanVerificationAgentNextAction(request: HumanVerificationRequest): string {
  switch (request.status) {
    case "pending_user":
    case "in_progress":
      return (
        "Antigen owns this Human Verification handoff. A confirmed human-verification challenge is blocking this page and " +
        "requires live user presence relayed through the Antigen UI. Tell the user Antigen has surfaced a Human verification " +
        "handoff to complete (Approvals → Human verification) — do NOT tell the user to solve it outside Antigen and do NOT " +
        "invent a manual workaround. Then wait: if the wait_for_human_verification tool is available, call it with " +
        `request_id ${request.request_id}; if that tool is not loaded, simply wait and re-run antigen_snapshot after the user ` +
        "confirms Antigen shows the challenge cleared. When verification completes, take a fresh antigen_snapshot before any " +
        "other action. Do not attempt to click, hold, retry, or bypass the challenge yourself."
      );
    case "completed":
      return "Human verification is complete. Take a fresh antigen_snapshot now — all prior ag_* refs are invalid — then resume the task.";
    case "expired":
      return "The human-verification request expired before the user completed it. Take a fresh antigen_snapshot; if the challenge is still present, a new request will be created.";
    case "cancelled":
      return "The user cancelled (or the challenge disappeared before any live interaction). Take a fresh antigen_snapshot to re-evaluate the page.";
    case "failed":
      return "The live presence relay failed (browser/CDP error). Take a fresh antigen_snapshot; if the challenge is still present, a new request will be created.";
    default:
      return "Take a fresh antigen_snapshot to re-evaluate the page.";
  }
}
