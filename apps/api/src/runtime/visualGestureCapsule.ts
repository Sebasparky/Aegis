// ─── Visual Gesture Capsule (Visual User Presence Relay) — M1A foundation ─────
//
// Second, first-class user-presence path for opaque human-verification walls
// (cross-origin iframe / OOPIF, e.g. PerimeterX "Press & Hold") where the host
// DOM cannot locate a control (`control_box == null`) and the existing DOM
// Human Presence Relay degrades to manual completion. Here the user points/
// presses on a screenshot of the wall and the server maps the normalized point
// to CSS viewport coordinates for a future CDP relay.
//
// This file is FOUNDATION ONLY (M1A): lifecycle state, a memory-only capsule
// store, coordinate mapping, expiry/attempt accounting, and safe views. It does
// NOT capture screenshots, store screenshot bytes, dispatch CDP input, expose
// endpoints, touch humanPresenceRelay.ts, or add UI. Gated behind
// ANTIGEN_VISUAL_GESTURE_CAPSULE (default off, byte-identical when off).
//
// Memory-only by design (mirrors challengeInjection.ts `challengeCodes` and
// humanPresenceRelay.ts hold sessions): capsules are never persisted, never
// logged, and the safe view never carries screenshot bytes, coordinates,
// fractions, or any reusable strategy. See docs/VISUAL_GESTURE_CAPSULE_DESIGN.md.

import { HUMAN_VERIFICATION_TTL_MS } from "../lib/humanVerificationLifecycle.js";
import { newId } from "../store/index.js";

/** Visual Gesture Capsule flag — strictly opt-in; default off is byte-identical. */
export function isVisualGestureCapsuleEnabled(): boolean {
  return process.env.ANTIGEN_VISUAL_GESTURE_CAPSULE === "true";
}

/** Gestures supported in v1. Type stays open for drag/slider/grid later. */
export type VisualGestureKind = "tap" | "press_hold";

/**
 * Lifecycle states (see design §9).
 * Terminal: cleared, expired, failed, cancelled.
 * NON-terminal waiting states: awaiting_user_gesture, relaying, checking,
 * rejected_retryable, AND manual_fallback (the user may finish the wall in the
 * visible browser, then a recheck can still transition to `cleared`).
 */
export type VisualGestureCapsuleStatus =
  | "awaiting_user_gesture"
  | "relaying"
  | "checking"
  | "cleared"
  | "rejected_retryable"
  | "manual_fallback"
  | "expired"
  | "failed"
  | "cancelled";

/** Capsule TTL aligns with the HV TTL (~3 min), per design §9. */
export const VISUAL_GESTURE_CAPSULE_TTL_MS = HUMAN_VERIFICATION_TTL_MS;

/** Max gesture attempts per handoff before manual fallback (design §8). */
export const MAX_GESTURE_ATTEMPTS = 2;

/**
 * Terminal statuses. `manual_fallback` is intentionally NOT terminal — it is a
 * waiting state that can still resolve to `cleared` on recheck.
 */
const TERMINAL_STATUSES: ReadonlySet<VisualGestureCapsuleStatus> = new Set([
  "cleared",
  "expired",
  "failed",
  "cancelled",
]);

export function isTerminalVisualGestureStatus(status: VisualGestureCapsuleStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * One opaque-wall handoff. Owns the gesture lifecycle for a single
 * HumanVerificationRequest on a single browser session/domain.
 *
 * NOTE (M1A scope): no screenshot bytes are stored here yet. `viewport_css_*`
 * and `screenshot_captured_at` are capture METADATA only; the byte store is a
 * future step (M1B). `delegation_id`/`user_id` are optional now — the future
 * endpoint will populate them from the linked HV request.
 */
export interface VisualGestureCapsule {
  capsule_id: string;
  human_verification_request_id: string;
  browser_session_id: string;
  /** From the linked HV request; optional until endpoint wiring (M1B+). */
  delegation_id?: string;
  /** From the linked HV request; optional until endpoint wiring (M1B+). */
  user_id?: string;
  domain: string;
  page_url?: string;
  status: VisualGestureCapsuleStatus;
  supported_gestures: VisualGestureKind[];
  attempt_count: number;
  max_attempts: number;
  /** Capture metadata only — read at capture time via window.innerWidth/Height. */
  viewport_css_width?: number;
  viewport_css_height?: number;
  /** Capture metadata only — no bytes stored in M1A. */
  screenshot_captured_at?: string;
  /** Live presence is required and recorded; literal true. */
  user_presence_required: true;
  /** Live presence never authorizes a purchase; literal false. */
  purchase_authorized: false;
  /** Agents never receive gesture geometry; literal false. */
  raw_gesture_revealed_to_agent: false;
  /** Agents never receive the screenshot; literal false. */
  screenshot_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  cleared_at?: string;
  error?: string;
}

// Memory-only store. Key: capsule_id. Never persisted, never logged, never in
// any agent-facing response. Lazy-expired at read time.
const visualGestureCapsules = new Map<string, VisualGestureCapsule>();

export interface CreateVisualGestureCapsuleInput {
  human_verification_request_id: string;
  browser_session_id: string;
  domain: string;
  page_url?: string;
  delegation_id?: string;
  user_id?: string;
  viewport_css_width?: number;
  viewport_css_height?: number;
}

export function createVisualGestureCapsule(
  input: CreateVisualGestureCapsuleInput,
): VisualGestureCapsule {
  const now = Date.now();
  const capsule: VisualGestureCapsule = {
    capsule_id: newId("vgc"),
    human_verification_request_id: input.human_verification_request_id,
    browser_session_id: input.browser_session_id,
    ...(input.delegation_id ? { delegation_id: input.delegation_id } : {}),
    ...(input.user_id ? { user_id: input.user_id } : {}),
    domain: input.domain,
    ...(input.page_url ? { page_url: input.page_url } : {}),
    status: "awaiting_user_gesture",
    supported_gestures: ["tap", "press_hold"],
    attempt_count: 0,
    max_attempts: MAX_GESTURE_ATTEMPTS,
    ...(input.viewport_css_width !== undefined
      ? { viewport_css_width: input.viewport_css_width }
      : {}),
    ...(input.viewport_css_height !== undefined
      ? { viewport_css_height: input.viewport_css_height }
      : {}),
    user_presence_required: true,
    purchase_authorized: false,
    raw_gesture_revealed_to_agent: false,
    screenshot_revealed_to_agent: false,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + VISUAL_GESTURE_CAPSULE_TTL_MS).toISOString(),
  };
  visualGestureCapsules.set(capsule.capsule_id, capsule);
  return capsule;
}

/**
 * Lazy expiry: mark any non-terminal capsule past its TTL as `expired`. Called
 * by every read path so callers never observe a live-but-stale capsule. (No
 * screenshot bytes to delete in M1A; the byte purge hooks here in M1B.)
 */
export function expireVisualGestureCapsules(nowMs: number = Date.now()): void {
  for (const capsule of visualGestureCapsules.values()) {
    if (isTerminalVisualGestureStatus(capsule.status)) continue;
    if (new Date(capsule.expires_at).getTime() <= nowMs) {
      capsule.status = "expired";
    }
  }
}

export function getVisualGestureCapsule(capsuleId: string): VisualGestureCapsule | undefined {
  expireVisualGestureCapsules();
  return visualGestureCapsules.get(capsuleId);
}

export function listActiveVisualGestureCapsules(): VisualGestureCapsule[] {
  expireVisualGestureCapsules();
  return [...visualGestureCapsules.values()].filter(
    (c) => !isTerminalVisualGestureStatus(c.status),
  );
}

export interface TransitionResult {
  ok: boolean;
  /** Present on success. */
  capsule?: VisualGestureCapsule;
  /** Present on a blocked/no-op transition. */
  reason?: "not_found" | "terminal";
}

/**
 * Move a capsule to `nextStatus`, optionally applying a metadata patch. Blocked
 * transitions are a no-op that returns `{ ok: false, reason }` rather than
 * throwing (callers branch on `ok`; tests lock this). Transitions out of a
 * terminal state are never permitted.
 */
export function transitionVisualGestureCapsule(
  capsuleId: string,
  nextStatus: VisualGestureCapsuleStatus,
  patch?: Partial<
    Pick<VisualGestureCapsule, "error" | "viewport_css_width" | "viewport_css_height" | "screenshot_captured_at">
  >,
): TransitionResult {
  const capsule = getVisualGestureCapsule(capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };

  capsule.status = nextStatus;
  if (patch?.error !== undefined) capsule.error = patch.error;
  if (patch?.viewport_css_width !== undefined) capsule.viewport_css_width = patch.viewport_css_width;
  if (patch?.viewport_css_height !== undefined) {
    capsule.viewport_css_height = patch.viewport_css_height;
  }
  if (patch?.screenshot_captured_at !== undefined) {
    capsule.screenshot_captured_at = patch.screenshot_captured_at;
  }
  if (nextStatus === "cleared") capsule.cleared_at = new Date().toISOString();
  return { ok: true, capsule };
}

/**
 * Record a rejected gesture attempt. Increments `attempt_count`; if attempts
 * remain → `rejected_retryable` (recapture + retry), else → `manual_fallback`
 * (user finishes in the visible browser; a later recheck can still clear).
 */
export function markGestureAttemptRejected(capsuleId: string): TransitionResult {
  const capsule = getVisualGestureCapsule(capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };

  capsule.attempt_count += 1;
  capsule.status =
    capsule.attempt_count < capsule.max_attempts ? "rejected_retryable" : "manual_fallback";
  return { ok: true, capsule };
}

/** Terminal clear — wall gone, resume the agent. */
export function markGestureCapsuleCleared(capsuleId: string): TransitionResult {
  return transitionVisualGestureCapsule(capsuleId, "cleared");
}

/** Terminal cancel. */
export function cancelVisualGestureCapsule(capsuleId: string): TransitionResult {
  return transitionVisualGestureCapsule(capsuleId, "cancelled");
}

/**
 * Agent/UI-safe view. NEVER includes screenshot bytes, raw or mapped
 * coordinates, normalized fractions, viewport dimensions, gesture traces, or any
 * reusable strategy. The three `*_revealed_to_agent`/`purchase_authorized`
 * booleans are echoed as the literals they are.
 */
export interface SafeVisualGestureCapsuleView {
  capsule_id: string;
  status: VisualGestureCapsuleStatus;
  supported_gestures: VisualGestureKind[];
  attempt_count: number;
  max_attempts: number;
  domain: string;
  page_url?: string;
  expires_at: string;
  user_presence_required: true;
  raw_gesture_revealed_to_agent: false;
  screenshot_revealed_to_agent: false;
  purchase_authorized: false;
}

export function getSafeVisualGestureCapsuleView(
  capsule: VisualGestureCapsule,
): SafeVisualGestureCapsuleView {
  return {
    capsule_id: capsule.capsule_id,
    status: capsule.status,
    supported_gestures: capsule.supported_gestures,
    attempt_count: capsule.attempt_count,
    max_attempts: capsule.max_attempts,
    domain: capsule.domain,
    ...(capsule.page_url ? { page_url: capsule.page_url } : {}),
    expires_at: capsule.expires_at,
    user_presence_required: true,
    raw_gesture_revealed_to_agent: false,
    screenshot_revealed_to_agent: false,
    purchase_authorized: false,
  };
}

export interface MapNormalizedImagePointInput {
  /** Normalized x in [0,1] relative to the image content area's top-left. */
  fx: number;
  /** Normalized y in [0,1] relative to the image content area's top-left. */
  fy: number;
  viewportCssWidth: number;
  viewportCssHeight: number;
}

/**
 * Map a normalized gesture point on the displayed image content area to CSS
 * viewport coordinates.
 *
 *   cssX = fx * viewportCssWidth
 *   cssY = fy * viewportCssHeight
 *
 * deviceScaleFactor is intentionally NOT applied: CDP Input.dispatchMouseEvent
 * uses CSS pixels, and a viewport-only screenshot shares the live viewport's
 * top-left origin, so (cssX, cssY) addresses the same pixel the user pointed at
 * even though the PNG's physical pixel size is viewportCss * deviceScaleFactor
 * (the PNG pixel dims are display-only, never used for mapping — design §6).
 *
 * Invalid input is REJECTED (throws RangeError) rather than clamped, for API
 * correctness: fx/fy must be finite and within [0,1]; the viewport dims must be
 * finite and > 0. All geometry stays on the server; the agent never sees it.
 */
export function mapNormalizedImagePointToViewport(
  input: MapNormalizedImagePointInput,
): { cssX: number; cssY: number } {
  const { fx, fy, viewportCssWidth, viewportCssHeight } = input;
  if (!Number.isFinite(fx) || fx < 0 || fx > 1) {
    throw new RangeError(`fx out of range: expected a finite value in [0,1], got ${fx}`);
  }
  if (!Number.isFinite(fy) || fy < 0 || fy > 1) {
    throw new RangeError(`fy out of range: expected a finite value in [0,1], got ${fy}`);
  }
  if (!Number.isFinite(viewportCssWidth) || viewportCssWidth <= 0) {
    throw new RangeError(`viewportCssWidth must be a finite value > 0, got ${viewportCssWidth}`);
  }
  if (!Number.isFinite(viewportCssHeight) || viewportCssHeight <= 0) {
    throw new RangeError(`viewportCssHeight must be a finite value > 0, got ${viewportCssHeight}`);
  }
  return { cssX: fx * viewportCssWidth, cssY: fy * viewportCssHeight };
}

/** Test-only: drop all capsules between cases. */
export function clearVisualGestureCapsulesForTests(): void {
  visualGestureCapsules.clear();
}
