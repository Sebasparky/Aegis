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

/**
 * Per-screenshot freshness window (design §9). A static screenshot of a LIVE
 * wall goes stale fast (the bar fills, the wall re-renders, or it disappears),
 * so the held frame gets a short TTL independent of — and always shorter-capped
 * by — the capsule TTL. No shorter constant existed, so this is a dedicated one.
 * Each frame's `expires_at` is `min(now + this, capsule.expires_at)` so a frame
 * can never outlive its capsule.
 */
export const VISUAL_GESTURE_SCREENSHOT_FRAME_TTL_MS = 45_000;

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
  /** Capture metadata only — set when a screenshot frame is stored (M1B). */
  screenshot_captured_at?: string;
  /** Capture metadata only — frame freshness deadline (M1B); never bytes. */
  screenshot_expires_at?: string;
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

// ─── Screenshot frame store (M1B) ────────────────────────────────────────────
//
// One redacted viewport screenshot frame per capsule. SEPARATE from the capsule
// record (the record never holds bytes). Memory-only, never persisted, never
// logged, never in `getSafeVisualGestureCapsuleView` or any agent-facing
// response — mirrors the discipline of challengeInjection.ts `challengeCodes`.
// Deleted on recapture (before replacement), clear, terminal transition
// (cleared/cancelled/failed/expired), frame-TTL expiry, and test clear.
//
// M1B is storage/metadata only: bytes enter via `storeVisualGestureCapsuleScreenshotFrame`
// with a caller-supplied frame. Actual CDP `Page.captureScreenshot` capture
// (reusing screenshotRedaction.ts) is deferred to M1C — no CDP wiring here.

/** One held, redacted viewport screenshot frame. Internal/user-facing only. */
export interface VisualGestureCapsuleScreenshotFrame {
  capsule_id: string;
  /** Redacted PNG bytes (base64). NEVER returned to the agent or in safe views. */
  png_base64: string;
  mime_type: "image/png";
  viewport_css_width: number;
  viewport_css_height: number;
  captured_at: string;
  expires_at: string;
}

// Key: capsule_id. One frame per capsule, so storing replaces (no append).
const visualGestureCapsuleScreenshotFrames = new Map<
  string,
  VisualGestureCapsuleScreenshotFrame
>();

/**
 * Drop a capsule's frame AND clear the frame-derived capture metadata on the
 * record, so `screenshot_available` can never report stale truthiness. Internal;
 * reused by clear/recapture/terminal-transition/expiry.
 */
function purgeVisualGestureCapsuleFrame(capsuleId: string): void {
  visualGestureCapsuleScreenshotFrames.delete(capsuleId);
  const capsule = visualGestureCapsules.get(capsuleId);
  if (capsule) {
    delete capsule.screenshot_captured_at;
    delete capsule.screenshot_expires_at;
  }
}

/**
 * Lazy frame expiry: delete any frame past its own (shorter) freshness window
 * and clear its capture metadata. Called by frame read paths so callers never
 * observe a live-but-stale frame even if capsule expiry hasn't run.
 */
function expireVisualGestureCapsuleScreenshotFrames(nowMs: number = Date.now()): void {
  for (const frame of [...visualGestureCapsuleScreenshotFrames.values()]) {
    if (new Date(frame.expires_at).getTime() <= nowMs) {
      purgeVisualGestureCapsuleFrame(frame.capsule_id);
    }
  }
}

export interface StoreVisualGestureCapsuleScreenshotFrameInput {
  /** Redacted PNG bytes (base64). */
  png_base64: string;
  viewport_css_width: number;
  viewport_css_height: number;
}

export type StoreVisualGestureCapsuleScreenshotFrameResult =
  | { ok: true; frame: VisualGestureCapsuleScreenshotFrame }
  | { ok: false; reason: "flag_disabled" | "not_found" | "terminal" | "invalid_input" };

/**
 * Store (or replace) the single screenshot frame for a capsule. This is the
 * guarded entry point future wiring (M1C) calls after capture, so it is gated on
 * the flag: when off it refuses (`flag_disabled`) and stores NO bytes. The
 * frame's `expires_at` is `min(now + FRAME_TTL, capsule.expires_at)`; capsule
 * metadata (viewport dims + screenshot timestamps) is updated, but the record
 * never receives the bytes.
 */
export function storeVisualGestureCapsuleScreenshotFrame(
  capsuleId: string,
  frameInput: StoreVisualGestureCapsuleScreenshotFrameInput,
): StoreVisualGestureCapsuleScreenshotFrameResult {
  if (!isVisualGestureCapsuleEnabled()) return { ok: false, reason: "flag_disabled" };

  const capsule = getVisualGestureCapsule(capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };

  const { png_base64, viewport_css_width, viewport_css_height } = frameInput;
  if (
    typeof png_base64 !== "string" ||
    png_base64.length === 0 ||
    !Number.isFinite(viewport_css_width) ||
    viewport_css_width <= 0 ||
    !Number.isFinite(viewport_css_height) ||
    viewport_css_height <= 0
  ) {
    return { ok: false, reason: "invalid_input" };
  }

  // Recapture discipline: drop any existing frame before storing the new one.
  purgeVisualGestureCapsuleFrame(capsuleId);

  const now = Date.now();
  const expiresMs = Math.min(
    now + VISUAL_GESTURE_SCREENSHOT_FRAME_TTL_MS,
    new Date(capsule.expires_at).getTime(),
  );
  const frame: VisualGestureCapsuleScreenshotFrame = {
    capsule_id: capsuleId,
    png_base64,
    mime_type: "image/png",
    viewport_css_width,
    viewport_css_height,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
  };
  visualGestureCapsuleScreenshotFrames.set(capsuleId, frame);

  // Capsule metadata only — NEVER bytes.
  capsule.viewport_css_width = viewport_css_width;
  capsule.viewport_css_height = viewport_css_height;
  capsule.screenshot_captured_at = frame.captured_at;
  capsule.screenshot_expires_at = frame.expires_at;

  return { ok: true, frame };
}

/** Internal/user-facing frame read. Runs lazy frame expiry; never agent-facing. */
export function getVisualGestureCapsuleScreenshotFrame(
  capsuleId: string,
): VisualGestureCapsuleScreenshotFrame | undefined {
  expireVisualGestureCapsuleScreenshotFrames();
  return visualGestureCapsuleScreenshotFrames.get(capsuleId);
}

/** Drop a capsule's frame + capture metadata. Idempotent. */
export function clearVisualGestureCapsuleScreenshotFrame(capsuleId: string): void {
  purgeVisualGestureCapsuleFrame(capsuleId);
}

/**
 * Replace the held frame: clear the old one first (no append), then store. For
 * now this is a replace-store helper — actual CDP capture is deferred to M1C.
 */
export function recaptureVisualGestureCapsuleScreenshotFrame(
  capsuleId: string,
  frameInput: StoreVisualGestureCapsuleScreenshotFrameInput,
): StoreVisualGestureCapsuleScreenshotFrameResult {
  clearVisualGestureCapsuleScreenshotFrame(capsuleId);
  return storeVisualGestureCapsuleScreenshotFrame(capsuleId, frameInput);
}

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
 * Lazy expiry: mark any non-terminal capsule past its TTL as `expired`, and
 * purge screenshot frames — both for newly/already terminal capsules and for any
 * frame past its own (shorter) freshness window. Called by every read path so
 * callers never observe a live-but-stale capsule or frame.
 */
export function expireVisualGestureCapsules(nowMs: number = Date.now()): void {
  for (const capsule of visualGestureCapsules.values()) {
    if (!isTerminalVisualGestureStatus(capsule.status)) {
      if (new Date(capsule.expires_at).getTime() <= nowMs) {
        capsule.status = "expired";
      }
    }
    if (isTerminalVisualGestureStatus(capsule.status)) {
      purgeVisualGestureCapsuleFrame(capsule.capsule_id);
    }
  }
  // Frames can expire before their capsule (shorter TTL) — drop those too.
  expireVisualGestureCapsuleScreenshotFrames(nowMs);
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
  // Entering any terminal state consumes/invalidates the held screenshot frame.
  if (isTerminalVisualGestureStatus(nextStatus)) purgeVisualGestureCapsuleFrame(capsuleId);
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
  /** Whether a live (non-expired) screenshot frame is held. Bytes never exposed. */
  screenshot_available: boolean;
  /** Present only when a live frame exists — capture metadata, never bytes. */
  screenshot_captured_at?: string;
  /** Present only when a live frame exists — freshness deadline, never bytes. */
  screenshot_expires_at?: string;
  user_presence_required: true;
  raw_gesture_revealed_to_agent: false;
  screenshot_revealed_to_agent: false;
  purchase_authorized: false;
}

export function getSafeVisualGestureCapsuleView(
  capsule: VisualGestureCapsule,
): SafeVisualGestureCapsuleView {
  // Derive availability from the live frame store (runs lazy frame expiry +
  // metadata purge), so a frame that expired before its capsule can never leak a
  // stale `screenshot_available: true` or stale timestamps. Bytes are never read.
  const frame = getVisualGestureCapsuleScreenshotFrame(capsule.capsule_id);
  return {
    capsule_id: capsule.capsule_id,
    status: capsule.status,
    supported_gestures: capsule.supported_gestures,
    attempt_count: capsule.attempt_count,
    max_attempts: capsule.max_attempts,
    domain: capsule.domain,
    ...(capsule.page_url ? { page_url: capsule.page_url } : {}),
    expires_at: capsule.expires_at,
    screenshot_available: !!frame,
    ...(frame
      ? {
          screenshot_captured_at: frame.captured_at,
          screenshot_expires_at: frame.expires_at,
        }
      : {}),
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

/** Test-only: drop all capsules AND screenshot frames between cases. */
export function clearVisualGestureCapsulesForTests(): void {
  visualGestureCapsules.clear();
  visualGestureCapsuleScreenshotFrames.clear();
}
