// ─── Human Verification Handoff Status Layer v1 ──────────────────────────────
//
// Safe, memory-only, user-facing LIVE STATUS for an active human-verification
// (HV) / Visual Gesture Capsule (VGC) handoff. While a VGC handoff is active the
// runtime publishes phase updates here ("human verification detected" → "keep
// holding" → "verification still active" → "looks complete, checking…" →
// "all done" → "agent resumed"); the UI/control plane polls a small internal
// endpoint to render them. This REPLACES the hardcoded 5/10/15s countdown guess
// with stateful, real-signal updates.
//
// ── ARCHITECTURE BOUNDARY ────────────────────────────────────────────────────
// This is a STATUS CHANNEL ONLY. It never decides anything: it does not gate the
// 409, mint/clear capsules, release a hold, or resume the agent. The model may
// INFORM `looks_complete_checking` (advisory), but ONLY the conservative
// completion authority (the DOM in-hold probe / post-release recheck) ever
// publishes `completed`. `looks_complete_checking` must NEVER set
// `agent_should_wait = false`.
//
// ── DATA SAFETY ──────────────────────────────────────────────────────────────
// SAFE FIELDS ONLY. Never a full URL / path / query, selector, coordinate, DOM
// rect, raw/OCR page text, screenshot bytes / base64, frame path, viewport dims,
// or credentials. `domain` is hostname only. Booleans / enums / non-sensitive
// ids / ISO timestamps only. `requires_user_attention` and `agent_should_wait`
// are DERIVED from `phase` (a fixed table) — never taken from caller input.
//
// Leaf-level by design (mirrors humanVerificationState.ts): imports only the HV
// TTL const so no module that publishes here can form an import cycle through it.

import { HUMAN_VERIFICATION_TTL_MS } from "../lib/humanVerificationLifecycle.js";
import { logHvDebug } from "./humanVerificationState.js";

/** Where the update originated. */
export type HvHandoffSource = "visual_judgment" | "visual_gesture_capsule";

/**
 * Handoff phases (see the design table). `looks_complete_checking` is the only
 * model-informed phase and is ADVISORY: it never clears `agent_should_wait`.
 * Only the conservative authority sets `completed`.
 */
export type HvHandoffPhase =
  | "detected"
  | "presenting_to_user"
  | "user_interaction_required"
  | "holding"
  | "still_active"
  | "looks_complete_checking"
  | "completed"
  | "resumed"
  | "expired"
  | "cancelled";

/** Safe page-state policy decision enum echoed from the visual judgment seam. */
export type HvHandoffVisualPolicyDecision =
  | "visual_hv_confirmed"
  | "visual_uncertain"
  | "visual_low_confidence_hv"
  | "visual_runtime_no_action";

/** Safe trigger-basis enum (mirrors the classifier's surface trigger basis). */
export type HvHandoffTriggerBasis =
  | "opaque_dominant_surface"
  | "unreadable_dominant_surface"
  | "page_level_hv_wall"
  | "browser_check_interstitial";

/** Whether a transition was informed by the model, the DOM probe, or neither. */
export type HvHandoffPresenceSource = "model" | "dom_probe" | "none";

/**
 * One safe, user-facing live handoff status update. SAFE FIELDS ONLY (see header).
 */
export interface HumanVerificationHandoffUpdate {
  type: "human_verification_handoff_update";
  browser_session_id: string;
  /** Correlation id (the VGC capsule_id) — non-sensitive. */
  capsule_id?: string;
  /** The linked HV request id — non-sensitive. */
  human_verification_request_id?: string;
  /** Hostname only. */
  domain?: string;
  source: HvHandoffSource;
  phase: HvHandoffPhase;
  /** DERIVED from phase — never caller-supplied. */
  requires_user_attention: boolean;
  /** DERIVED from phase — never caller-supplied. */
  agent_should_wait: boolean;
  /** Classifier label enum (e.g. "page_level_hv_wall") — never raw page text. */
  model_label?: string;
  /** Model confidence in [0,1]. */
  model_confidence?: number;
  visual_policy_decision?: HvHandoffVisualPolicyDecision;
  trigger_basis?: HvHandoffTriggerBasis;
  presence_source?: HvHandoffPresenceSource;
  /** Literal — the model is never the release authority in v1. */
  release_authority: "conservative_probe";
  /** Literal — the handoff layer never reveals the surface to the agent. */
  raw_surface_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
}

/** Handoff status TTL aligns with the HV/VGC TTL (memory-only, lazy-expired). */
export const HV_HANDOFF_TTL_MS = HUMAN_VERIFICATION_TTL_MS;

/** Bounded per-session history depth (latest is index 0). */
export const HV_HANDOFF_HISTORY_MAX = 10;

/**
 * Fixed phase → (attention, wait) mapping. The LOAD-BEARING safety contract:
 * derived here, never from caller input. `looks_complete_checking` deliberately
 * keeps BOTH true — it is advisory and must not let the agent resume. Only the
 * terminal-ish phases (completed/resumed/expired/cancelled) clear the wait.
 */
const PHASE_FLAGS: Record<
  HvHandoffPhase,
  { requires_user_attention: boolean; agent_should_wait: boolean }
> = {
  detected: { requires_user_attention: true, agent_should_wait: true },
  presenting_to_user: { requires_user_attention: true, agent_should_wait: true },
  user_interaction_required: { requires_user_attention: true, agent_should_wait: true },
  holding: { requires_user_attention: true, agent_should_wait: true },
  still_active: { requires_user_attention: true, agent_should_wait: true },
  looks_complete_checking: { requires_user_attention: true, agent_should_wait: true },
  completed: { requires_user_attention: false, agent_should_wait: false },
  resumed: { requires_user_attention: false, agent_should_wait: false },
  expired: { requires_user_attention: false, agent_should_wait: false },
  cancelled: { requires_user_attention: false, agent_should_wait: false },
};

interface HandoffSessionState {
  latest: HumanVerificationHandoffUpdate;
  history: HumanVerificationHandoffUpdate[];
}

// Memory-only. Key: browser_session_id. Never persisted, never logged with
// content, never in any agent-facing response. Lazy-expired at read time.
const handoffBySession = new Map<string, HandoffSessionState>();

/** Bounded ISO confidence clamp; non-finite → undefined (dropped). */
function safeConfidence(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

/** Coerce a free string to a hostname-only token (drop any path/query/scheme). */
function safeDomain(input: unknown): string | undefined {
  if (typeof input !== "string" || input.trim().length === 0) return undefined;
  const raw = input.trim();
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || undefined;
  } catch {
    // Not a URL — keep only a bare host token (no slashes / spaces / queries).
    const token = raw.split(/[/\\?#\s]/)[0];
    return token && /^[a-zA-Z0-9.:-]+$/.test(token) ? token : undefined;
  }
}

export interface PublishHvHandoffInput {
  browser_session_id: string;
  source: HvHandoffSource;
  phase: HvHandoffPhase;
  capsule_id?: string;
  human_verification_request_id?: string;
  domain?: string;
  model_label?: string;
  model_confidence?: number;
  visual_policy_decision?: HvHandoffVisualPolicyDecision;
  trigger_basis?: HvHandoffTriggerBasis;
  presence_source?: HvHandoffPresenceSource;
}

/**
 * Publish a handoff update. Best-effort (NEVER throws). Builds the update via an
 * EXPLICIT allowlist (no spread of caller input), derives the attention/wait
 * flags from `phase`, stamps timestamps, and stores latest + bounded history.
 *
 * Dedup: if the new phase equals the latest stored phase for this session, the
 * call is a no-op (prevents status spam from the ~1s in-hold probe). Returns the
 * stored update, or `undefined` when the input is unusable or deduped.
 */
export function publishHvHandoffUpdate(
  input: PublishHvHandoffInput,
): HumanVerificationHandoffUpdate | undefined {
  try {
    if (
      !input ||
      typeof input.browser_session_id !== "string" ||
      input.browser_session_id.length === 0 ||
      !PHASE_FLAGS[input.phase] ||
      (input.source !== "visual_judgment" && input.source !== "visual_gesture_capsule")
    ) {
      return undefined;
    }

    const existing = handoffBySession.get(input.browser_session_id);
    // Publish only on phase change to avoid ring spam.
    if (existing && existing.latest.phase === input.phase) return undefined;

    const flags = PHASE_FLAGS[input.phase];
    const now = Date.now();
    const update: HumanVerificationHandoffUpdate = {
      type: "human_verification_handoff_update",
      browser_session_id: input.browser_session_id,
      ...(typeof input.capsule_id === "string" && input.capsule_id
        ? { capsule_id: input.capsule_id }
        : {}),
      ...(typeof input.human_verification_request_id === "string" &&
      input.human_verification_request_id
        ? { human_verification_request_id: input.human_verification_request_id }
        : {}),
      ...(safeDomain(input.domain) ? { domain: safeDomain(input.domain) } : {}),
      source: input.source,
      phase: input.phase,
      requires_user_attention: flags.requires_user_attention,
      agent_should_wait: flags.agent_should_wait,
      ...(typeof input.model_label === "string" && input.model_label
        ? { model_label: input.model_label }
        : {}),
      ...(safeConfidence(input.model_confidence) !== undefined
        ? { model_confidence: safeConfidence(input.model_confidence) }
        : {}),
      ...(input.visual_policy_decision
        ? { visual_policy_decision: input.visual_policy_decision }
        : {}),
      ...(input.trigger_basis ? { trigger_basis: input.trigger_basis } : {}),
      ...(input.presence_source ? { presence_source: input.presence_source } : {}),
      release_authority: "conservative_probe",
      raw_surface_revealed_to_agent: false,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + HV_HANDOFF_TTL_MS).toISOString(),
    };

    const history = existing ? existing.history : [];
    const nextHistory = [update, ...history].slice(0, HV_HANDOFF_HISTORY_MAX);
    handoffBySession.set(input.browser_session_id, { latest: update, history: nextHistory });

    logHvDebug({
      scope: "hv_handoff",
      phase: update.phase,
      source: update.source,
      requires_user_attention: update.requires_user_attention,
      agent_should_wait: update.agent_should_wait,
      presence_source: update.presence_source ?? "none",
    });
    return update;
  } catch {
    return undefined;
  }
}

/** Lazy expiry: drop any session whose latest update is past TTL. */
export function expireHvHandoffUpdates(nowMs: number = Date.now()): void {
  for (const [sessionId, state] of [...handoffBySession.entries()]) {
    if (new Date(state.latest.expires_at).getTime() <= nowMs) {
      handoffBySession.delete(sessionId);
    }
  }
}

/** Latest update for a session (runs lazy expiry; expired → undefined). */
export function getLatestHvHandoffUpdate(
  browserSessionId: string,
): HumanVerificationHandoffUpdate | undefined {
  expireHvHandoffUpdates();
  return handoffBySession.get(browserSessionId)?.latest;
}

/** Bounded history for a session (latest-first; runs lazy expiry). */
export function getHvHandoffHistory(
  browserSessionId: string,
): HumanVerificationHandoffUpdate[] {
  expireHvHandoffUpdates();
  return handoffBySession.get(browserSessionId)?.history ?? [];
}

/** All live latest updates (latest-first), optionally filtered by session. */
export function listHvHandoffUpdates(
  browserSessionId?: string,
): HumanVerificationHandoffUpdate[] {
  expireHvHandoffUpdates();
  const items = [...handoffBySession.values()].map((s) => s.latest);
  const filtered = browserSessionId
    ? items.filter((u) => u.browser_session_id === browserSessionId)
    : items;
  return filtered.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/** Test-only: drop all handoff state between cases. */
export function clearHvHandoffUpdatesForTests(): void {
  handoffBySession.clear();
}
