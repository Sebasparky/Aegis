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
  pressAtPoint,
  releaseAtPoint,
  clickAtPoint,
  resolvePointerTimingMode,
} from "./nativePointerRuntime.js";
import { HOLD_MAX_DURATION_MS, openCdpPageClient } from "./humanPresenceRelay.js";

/** Reject press-holds shorter than this — too brief to be a real human hold. */
export const HOLD_MIN_DURATION_MS = 300;
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

/**
 * Production default relay: opens a CDP page client and dispatches through the
 * native pointer primitives. Not unit-tested in this slice (tests inject a
 * fake). targetId is accepted for forward-compat; the default resolves the
 * active page via openCdpPageClient's best-target selection (precise targetId
 * attach lands in a later slice).
 */
export const defaultVisualGesturePointerRelay: VisualGesturePointerRelay = {
  async tapAtPoint({ cdpUrl, x, y }) {
    const opened = await openCdpPageClient({ cdpUrl });
    if (!opened.ok) return { ok: false, error: opened.error };
    const sendCdp = (method: string, params: Record<string, unknown>): void =>
      opened.client.send(method, params);
    try {
      await clickAtPoint(sendCdp, { x, y }, resolvePointerTimingMode(), sleep);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      opened.client.close();
    }
  },
  async pressHoldAtPoint({ cdpUrl, x, y, durationMs }) {
    const opened = await openCdpPageClient({ cdpUrl });
    if (!opened.ok) return { ok: false, error: opened.error };
    const sendCdp = (method: string, params: Record<string, unknown>): void =>
      opened.client.send(method, params);
    let pressed = false;
    try {
      await pressAtPoint(sendCdp, { x, y }, resolvePointerTimingMode(), sleep);
      pressed = true;
      await sleep(durationMs);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Fail-closed: always attempt to release if the press landed, even if the
      // hold threw partway through.
      if (pressed) {
        try {
          releaseAtPoint(sendCdp, { x, y });
        } catch {
          /* best-effort release */
        }
      }
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

  // Failure surfaces a reason only — never the coords, duration, or path. No
  // attempt is burned merely because dispatch failed to land.
  if (!dispatched.ok) return { ok: false, reason: "pointer_dispatch_failed" };

  // 9. Dispatch landed: move to "checking" (recheck slice decides cleared/retry).
  const transitioned = transitionVisualGestureCapsule(args.capsuleId, "checking");
  if (!transitioned.ok) return { ok: false, reason: "store_or_state_failed" };

  return {
    ok: true,
    capsule_id: args.capsuleId,
    status: transitioned.capsule?.status ?? "checking",
    gesture_relayed: true,
  };
}
