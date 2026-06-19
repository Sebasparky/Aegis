/**
 * Visual Gesture Capsule M1E — point-explicit gesture relay seam (backend-only).
 *
 * Relays a fresh, user-originated tap or press-and-hold into an opaque
 * human-verification wall at explicit CSS viewport coordinates derived from
 * screenshot-fraction mapping. Unlike the DOM Human Presence Relay
 * (humanPresenceRelay.ts), this path does NOT depend on locating a DOM
 * control_box — it dispatches at a mapped point.
 *
 * This is NOT "give the agent coordinates." The agent stays paused and never
 * receives fx/fy, cssX/cssY, duration, path points, screenshot bytes, or any
 * reusable strategy. Aegis maps the user-provided normalized point to viewport
 * CSS coordinates and dispatches the gesture itself.
 *
 * Scope (M1E): no UI, no agent-facing tools, no route/endpoint, no live-site
 * wiring, no cleared-state detection, no attempt burning on dispatch success.
 * Heartbeat / live-hold phases land in a later endpoint/UI slice; M1E performs
 * a single bounded press-hold.
 */

import {
  isVisualGestureCapsuleEnabled,
  getVisualGestureCapsule,
  getVisualGestureCapsuleScreenshotFrame,
  isTerminalVisualGestureStatus,
  transitionVisualGestureCapsule,
  mapNormalizedImagePointToViewport,
  type VisualGestureCapsuleStatus,
} from "./visualGestureCapsule.js";
import {
  HOLD_MAX_DURATION_MS,
  openCdpPageClient,
  type CdpPageClient,
} from "./humanPresenceRelay.js";
import { defaultVgcReadViewport, type VgcReadViewportFn } from "./visualGestureCapsuleCapture.js";
import { logHvDebug } from "./humanVerificationState.js";

/** Reject press-holds shorter than this — too brief to be a real human hold. */
export const HOLD_MIN_DURATION_MS = 300;

/**
 * Coarse hold-duration bucket for SAFE debug telemetry. Maps a raw duration (ms)
 * to one of four buckets so the actual hold time is never logged. Taps and any
 * sub-250ms input fall in the lowest bucket. Pure + exported for unit testing.
 */
export function holdDurationBucket(ms: number | undefined): "<250ms" | "250-999ms" | "1-3s" | "3s+" {
  const d = typeof ms === "number" && Number.isFinite(ms) ? ms : 0;
  if (d < 250) return "<250ms";
  if (d < 1000) return "250-999ms";
  if (d < 3000) return "1-3s";
  return "3s+";
}
// Upper bound reuses the existing Human Presence Relay ceiling (30_000ms).

/** V1 supports only tap and press_hold. Everything else is rejected. */
export type VisualGestureRelayGesture =
  | { kind: "tap"; fx: number; fy: number }
  | { kind: "press_hold"; fx: number; fy: number; duration_ms: number };

/**
 * Injectable pointer adapter. Production default wraps the native CDP pointer
 * primitives; tests inject a fake that records the mapped CSS coordinates.
 * The adapter receives ONLY mapped CSS viewport coords — never fractions.
 */
export interface VisualGesturePointerRelay {
  tapAtPoint(args: {
    cdpUrl: string;
    targetId?: string;
    x: number;
    y: number;
  }): Promise<{ ok: true } | { ok: false; error?: string }>;
  pressHoldAtPoint(args: {
    cdpUrl: string;
    targetId?: string;
    x: number;
    y: number;
    durationMs: number;
  }): Promise<{ ok: true } | { ok: false; error?: string }>;
}

export type VisualGestureRelayResult =
  | {
      ok: true;
      capsule_id: string;
      status: VisualGestureCapsuleStatus;
      gesture_relayed: true;
    }
  | {
      ok: false;
      reason:
        | "flag_disabled"
        | "not_found"
        | "terminal"
        | "manual_fallback"
        | "invalid_gesture"
        | "invalid_coordinates"
        | "screenshot_frame_unavailable"
        | "viewport_drifted"
        | "pointer_dispatch_failed"
        | "store_or_state_failed";
    };

/**
 * Pure validation of a relay gesture payload. Exported for direct unit testing.
 * - Unknown kind (drag/slider/grid/multi-tap/etc.) -> invalid_gesture.
 * - fx/fy not finite or outside [0,1]               -> invalid_coordinates.
 * - press_hold duration out of [MIN, MAX]            -> invalid_gesture.
 */
export function validateVisualGesturePayload(
  gesture: VisualGestureRelayGesture,
): { ok: true } | { ok: false; reason: "invalid_gesture" | "invalid_coordinates" } {
  if (!gesture || (gesture.kind !== "tap" && gesture.kind !== "press_hold")) {
    return { ok: false, reason: "invalid_gesture" };
  }
  const { fx, fy } = gesture;
  if (
    !Number.isFinite(fx) ||
    fx < 0 ||
    fx > 1 ||
    !Number.isFinite(fy) ||
    fy < 0 ||
    fy > 1
  ) {
    return { ok: false, reason: "invalid_coordinates" };
  }
  if (gesture.kind === "press_hold") {
    const d = gesture.duration_ms;
    if (!Number.isFinite(d) || d < HOLD_MIN_DURATION_MS || d > HOLD_MAX_DURATION_MS) {
      return { ok: false, reason: "invalid_gesture" };
    }
  }
  return { ok: true };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Tap dwell between press and release (ms) — long enough to register a click. */
export const TAP_DWELL_MS = 60;

/**
 * Viewport-drift tolerance. The mapped point is only trustworthy while the live
 * viewport still matches the captured frame: drifted if the live/captured delta
 * on either axis exceeds max(ABS_PX, REL * capturedDim). A few px of rounding is
 * tolerated; a real scroll/resize is not.
 */
export const VIEWPORT_DRIFT_ABS_PX = 2;
export const VIEWPORT_DRIFT_REL = 0.02;

function axisDrifted(live: number, captured: number): boolean {
  return Math.abs(live - captured) > Math.max(VIEWPORT_DRIFT_ABS_PX, VIEWPORT_DRIFT_REL * captured);
}

/**
 * True when the live viewport has drifted from the captured frame beyond
 * tolerance on either axis. Exported for direct unit testing. Takes only sizes,
 * returns only a boolean — never surfaces the dims or the delta.
 */
export function isViewportDrifted(
  live: { width: number; height: number },
  captured: { width: number; height: number },
): boolean {
  return axisDrifted(live.width, captured.width) || axisDrifted(live.height, captured.height);
}

/**
 * Dispatch a single faithful pointer gesture through an ALREADY-OPEN CDP page
 * client, awaiting every `Input.dispatchMouseEvent` so the browser acknowledges
 * each event. Critically, the final `mouseReleased` is AWAITED — its ack is the
 * flush that the old fire-and-forget `send()` + immediate `close()` path dropped
 * (the pointerup never reached the page, so the wall never cleared).
 *
 * Movement is a SINGLE deterministic move to the mapped point (arms hover /
 * pointerenter on widgets that require it) — no path, jitter, easing, or
 * randomization. The caller owns client lifecycle; this never closes the client,
 * so the caller can close only AFTER this resolves (i.e. after the release ack).
 *
 * Fail-closed: if the press landed but the hold/release threw, a best-effort
 * release is still attempted so the button is never left stuck down.
 */
export async function dispatchVisualGesturePointerViaClient(
  client: Pick<CdpPageClient, "call">,
  args: { kind: "tap" | "press_hold"; x: number; y: number; durationMs?: number },
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<{ ok: true } | { ok: false; error?: string }> {
  const { kind, x, y } = args;
  const mouse = (type: "mouseMoved" | "mousePressed" | "mouseReleased") =>
    client.call("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  let pressed = false;
  let released = false;
  try {
    // 1. Single deterministic move to the target point.
    await mouse("mouseMoved");
    // 2. Press and hold the button down.
    await mouse("mousePressed");
    pressed = true;
    // 3. Hold for the user's hold duration (press_hold) or a short tap dwell.
    await sleepFn(kind === "press_hold" ? (args.durationMs ?? 0) : TAP_DWELL_MS);
    // 4. Release — AWAITED. This ack flushes the input pipeline before any close.
    await mouse("mouseReleased");
    released = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Fail-closed: never leave the button stuck down if the hold/release threw.
    if (pressed && !released) {
      try {
        await mouse("mouseReleased");
      } catch {
        /* best-effort release */
      }
    }
  }
}

/**
 * Production default relay: opens a CDP page client, dispatches the fully-awaited
 * gesture, and closes the client ONLY AFTER dispatch (incl. the awaited release)
 * resolves. targetId is accepted for forward-compat; the default resolves the
 * active page via openCdpPageClient's best-target selection.
 */
export const defaultVisualGesturePointerRelay: VisualGesturePointerRelay = {
  async tapAtPoint({ cdpUrl, x, y }) {
    const opened = await openCdpPageClient({ cdpUrl });
    if (!opened.ok) return { ok: false, error: opened.error };
    try {
      return await dispatchVisualGesturePointerViaClient(opened.client, { kind: "tap", x, y });
    } finally {
      opened.client.close();
    }
  },
  async pressHoldAtPoint({ cdpUrl, x, y, durationMs }) {
    const opened = await openCdpPageClient({ cdpUrl });
    if (!opened.ok) return { ok: false, error: opened.error };
    try {
      return await dispatchVisualGesturePointerViaClient(opened.client, {
        kind: "press_hold",
        x,
        y,
        durationMs,
      });
    } finally {
      opened.client.close();
    }
  },
};

/**
 * Relay a user-provided normalized screenshot point as a tap or bounded
 * press-hold into the capsule's verification wall.
 *
 * Order matters: every refusal path returns before any pointer dispatch.
 * Success transitions the capsule to "checking" (never "cleared") and does NOT
 * burn an attempt — a completed dispatch is not a failed attempt. Attempt
 * accounting on uncleared challenges is handled by a future recheck slice.
 */
export async function relayVisualGestureCapsuleGesture(args: {
  capsuleId: string;
  cdpUrl: string;
  targetId?: string;
  gesture: VisualGestureRelayGesture;
  pointerRelay?: VisualGesturePointerRelay;
  /** Injectable live-viewport reader for the drift guard; defaults to a CDP read. */
  readLiveViewport?: VgcReadViewportFn;
}): Promise<VisualGestureRelayResult> {
  // 1. Flag gate FIRST — never read the capsule/frame or dispatch when off.
  if (!isVisualGestureCapsuleEnabled()) return { ok: false, reason: "flag_disabled" };

  // 2/3. Resolve capsule (lazy-expiring); refuse missing/terminal.
  const capsule = getVisualGestureCapsule(args.capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };

  // 4. manual_fallback is non-terminal but means gesture attempts are exhausted
  //    — refuse and let the user finish in the visible browser.
  if (capsule.status === "manual_fallback") return { ok: false, reason: "manual_fallback" };

  // 5. Validate gesture payload before any geometry or dispatch.
  const valid = validateVisualGesturePayload(args.gesture);
  if (!valid.ok) return { ok: false, reason: valid.reason };

  // 6. Require a live screenshot frame (lazy-expires; expired -> undefined). The
  //    frame store guarantees viewport dims > 0 for any present frame.
  const frame = getVisualGestureCapsuleScreenshotFrame(args.capsuleId);
  if (!frame) return { ok: false, reason: "screenshot_frame_unavailable" };

  // 6b. Viewport-drift guard. The point is only trustworthy while the live
  //     viewport still matches the captured frame: if it cannot be read or has
  //     drifted beyond tolerance, the screenshot is stale and the mapped point
  //     would miss. Refuse WITHOUT dispatching and WITHOUT burning an attempt —
  //     the capsule stays active so the UI recaptures or falls back to manual.
  //     SAFE: never surfaces live/captured dims, the delta, coords, or fx/fy.
  const readLiveViewport = args.readLiveViewport ?? defaultVgcReadViewport;
  const liveViewport = await readLiveViewport({
    cdpUrl: args.cdpUrl,
    ...(args.targetId !== undefined ? { targetId: args.targetId } : {}),
  });
  if (
    !liveViewport ||
    isViewportDrifted(liveViewport, {
      width: frame.viewport_css_width,
      height: frame.viewport_css_height,
    })
  ) {
    logHvDebug({
      scope: "vgc_gesture",
      gesture_kind: args.gesture.kind,
      hold_duration_bucket: holdDurationBucket(
        args.gesture.kind === "press_hold" ? args.gesture.duration_ms : undefined,
      ),
      relay_result: "viewport_drifted",
    });
    return { ok: false, reason: "viewport_drifted" };
  }

  // 7. Map the normalized point to CSS viewport coords. mapNormalized... throws
  //    RangeError on bad input; step 5 already validated, this is belt-and-suspenders.
  let cssX: number;
  let cssY: number;
  try {
    const mapped = mapNormalizedImagePointToViewport({
      fx: args.gesture.fx,
      fy: args.gesture.fy,
      viewportCssWidth: frame.viewport_css_width,
      viewportCssHeight: frame.viewport_css_height,
    });
    cssX = mapped.cssX;
    cssY = mapped.cssY;
  } catch {
    return { ok: false, reason: "invalid_coordinates" };
  }

  // 8. Dispatch via the injected or default pointer relay.
  const relay = args.pointerRelay ?? defaultVisualGesturePointerRelay;
  const pointerArgs = {
    cdpUrl: args.cdpUrl,
    ...(args.targetId !== undefined ? { targetId: args.targetId } : {}),
    x: cssX,
    y: cssY,
  };
  const dispatched =
    args.gesture.kind === "tap"
      ? await relay.tapAtPoint(pointerArgs)
      : await relay.pressHoldAtPoint({ ...pointerArgs, durationMs: args.gesture.duration_ms });

  // Coarse, value-free debug base: gesture kind + duration bucket only. Reused by
  // the failed/dispatched logs below. No-op unless ANTIGEN_HV_DEBUG is set.
  const gestureDebugBase = {
    scope: "vgc_gesture",
    gesture_kind: args.gesture.kind,
    hold_duration_bucket: holdDurationBucket(
      args.gesture.kind === "press_hold" ? args.gesture.duration_ms : undefined,
    ),
  } as const;

  // Failure surfaces a reason only — never the coords, duration, or path. No
  // attempt is burned merely because dispatch failed to land.
  if (!dispatched.ok) {
    logHvDebug({ ...gestureDebugBase, relay_result: "failed" });
    return { ok: false, reason: "pointer_dispatch_failed" };
  }

  // 9. Dispatch landed: move to "checking" (recheck slice decides cleared/retry).
  const transitioned = transitionVisualGestureCapsule(args.capsuleId, "checking");
  if (!transitioned.ok) return { ok: false, reason: "store_or_state_failed" };

  logHvDebug({ ...gestureDebugBase, relay_result: "dispatched" });

  return {
    ok: true,
    capsule_id: args.capsuleId,
    status: transitioned.capsule?.status ?? "checking",
    gesture_relayed: true,
  };
}
