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

export type TargetPointBucket = "center" | "upper" | "lower" | "left" | "right" | "edge";

/**
 * Coarse region bucket for SAFE debug telemetry — maps a normalized point to one
 * of six regions so the actual fx/fy are never logged. `edge` wins when either
 * axis is within EDGE of a border (an unusually peripheral tap); otherwise the
 * axis with the larger deviation from center decides the cardinal region, and
 * `center` is reported when both axes are within BAND of 0.5. Pure + exported for
 * unit testing. Out-of-range / non-finite input falls back to `edge`.
 */
export function targetPointBucket(fx: number, fy: number): TargetPointBucket {
  const BAND = 0.15; // within ±0.15 of 0.5 on both axes => "center"
  const EDGE = 0.05; // within 0.05 of 0 or 1 on either axis => "edge"
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > 1 || fy < 0 || fy > 1) {
    return "edge";
  }
  if (fx <= EDGE || fx >= 1 - EDGE || fy <= EDGE || fy >= 1 - EDGE) return "edge";
  const dx = fx - 0.5;
  const dy = fy - 0.5;
  if (Math.abs(dx) <= BAND && Math.abs(dy) <= BAND) return "center";
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "upper" : "lower";
}

export type ScreenshotScaleBucket = "1x" | "downscaled" | "upscaled" | "unknown";

/**
 * Coarse capture-scale bucket for SAFE debug telemetry. The PNG's physical width
 * over the CSS viewport width approximates the capture devicePixelRatio: ~1 is a
 * standard display (`1x`), >1 a HiDPI/retina capture (`upscaled`), <1 a
 * downscaled capture (`downscaled`). Exposes only the bucket — never the PNG
 * width, viewport width, or ratio. Pure + exported for unit testing.
 */
export function screenshotScaleBucket(
  pngWidthPx: number | undefined,
  viewportCssWidth: number | undefined,
): ScreenshotScaleBucket {
  if (
    typeof pngWidthPx !== "number" ||
    !Number.isFinite(pngWidthPx) ||
    pngWidthPx <= 0 ||
    typeof viewportCssWidth !== "number" ||
    !Number.isFinite(viewportCssWidth) ||
    viewportCssWidth <= 0
  ) {
    return "unknown";
  }
  const ratio = pngWidthPx / viewportCssWidth;
  if (ratio >= 0.95 && ratio <= 1.05) return "1x";
  return ratio > 1 ? "upscaled" : "downscaled";
}

/**
 * Minimal PNG width reader: parse the IHDR width (bytes 16-19, big-endian) from
 * the first few base64-decoded header bytes. NO full decode, NO pixel access —
 * dimensions only, used solely to derive the coarse `screenshotScaleBucket`.
 * Returns undefined on any malformed/short input.
 */
export function readPngWidthPx(base64: string | undefined): number | undefined {
  if (typeof base64 !== "string" || base64.length === 0) return undefined;
  try {
    // 24 header bytes (8 sig + 8 IHDR chunk header + 4 width + 4 height) live in
    // the first ~32 base64 chars; decode just those.
    const head = Buffer.from(base64.slice(0, 64), "base64");
    if (head.length < 24) return undefined;
    // PNG signature check (first 8 bytes) keeps a non-PNG blob from being misread.
    const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (head[i] !== SIG[i]) return undefined;
    const width = head.readUInt32BE(16);
    return Number.isFinite(width) && width > 0 ? width : undefined;
  } catch {
    return undefined;
  }
}

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
        | "scroll_drifted"
        | "layout_drifted"
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

/**
 * Scroll-drift tolerance. A static screenshot maps a point in *viewport* space;
 * if the page scrolled after capture, the mapped point lands on whatever moved
 * into that viewport position (e.g. inside the modal but off the button). Scroll
 * offset has no captured magnitude to scale against, so this is an absolute-px
 * tolerance — a few px of sub-pixel rounding is tolerated, a real scroll is not.
 */
export const SCROLL_DRIFT_ABS_PX = 4;

/**
 * Layout-extent drift tolerance. A material change in documentElement
 * scrollWidth/scrollHeight means the page reflowed (content expanded/collapsed,
 * a modal opened/closed) — the screenshot no longer describes the live layout.
 */
export const LAYOUT_DRIFT_ABS_PX = 4;
export const LAYOUT_DRIFT_REL = 0.02;

function axisDrifted(live: number, captured: number): boolean {
  return Math.abs(live - captured) > Math.max(VIEWPORT_DRIFT_ABS_PX, VIEWPORT_DRIFT_REL * captured);
}

function layoutAxisDrifted(live: number, captured: number): boolean {
  return Math.abs(live - captured) > Math.max(LAYOUT_DRIFT_ABS_PX, LAYOUT_DRIFT_REL * captured);
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

/** The kind of staleness that makes a captured frame's mapped point untrustworthy. */
export type FrameStaleKind = "viewport" | "scroll" | "layout";

export type FrameStaleResult = { stale: true; kind: FrameStaleKind } | { stale: false };

/**
 * Decide whether a captured screenshot frame is too stale to dispatch a mapped
 * point against. Checks, in order: viewport-size drift (point scaling wrong),
 * scroll drift (viewport-space point now maps onto moved content), then layout
 * drift (page reflowed). Scroll/layout are checked only when BOTH the live read
 * and the captured frame carry the value — a legacy frame without them falls back
 * to size-only checking, so this is a pure superset of `isViewportDrifted`.
 *
 * SAFE: takes only structural geometry, returns only a boolean + coarse kind enum
 * — never the live/captured values or the delta.
 */
export function isFrameStale(
  live: {
    width: number;
    height: number;
    scrollX?: number;
    scrollY?: number;
    layoutW?: number;
    layoutH?: number;
  },
  captured: {
    width: number;
    height: number;
    scroll_x?: number;
    scroll_y?: number;
    layout_w?: number;
    layout_h?: number;
  },
): FrameStaleResult {
  if (isViewportDrifted(live, captured)) return { stale: true, kind: "viewport" };

  const scrollDrifted = (l?: number, c?: number): boolean =>
    typeof l === "number" && typeof c === "number" && Math.abs(l - c) > SCROLL_DRIFT_ABS_PX;
  if (
    scrollDrifted(live.scrollX, captured.scroll_x) ||
    scrollDrifted(live.scrollY, captured.scroll_y)
  ) {
    return { stale: true, kind: "scroll" };
  }

  const layoutDrifted = (l?: number, c?: number): boolean =>
    typeof l === "number" && typeof c === "number" && layoutAxisDrifted(l, c);
  if (
    layoutDrifted(live.layoutW, captured.layout_w) ||
    layoutDrifted(live.layoutH, captured.layout_h)
  ) {
    return { stale: true, kind: "layout" };
  }

  return { stale: false };
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

  // Coarse, value-free debug base: gesture kind + duration bucket, plus the
  // mapping-diagnostic buckets (frame contract, region of the point, capture
  // scale). Reused by the stale/failed/dispatched logs below. Every field is a
  // constant or a coarse enum/bucket — never fx/fy, coords, dims, or the PNG
  // width. No-op unless ANTIGEN_HV_DEBUG is set.
  const gestureDebugBase = {
    scope: "vgc_gesture",
    gesture_kind: args.gesture.kind,
    hold_duration_bucket: holdDurationBucket(
      args.gesture.kind === "press_hold" ? args.gesture.duration_ms : undefined,
    ),
    coordinate_frame: "normalized",
    target_point_bucket: targetPointBucket(args.gesture.fx, args.gesture.fy),
    screenshot_scale_bucket: screenshotScaleBucket(
      readPngWidthPx(frame.png_base64),
      frame.viewport_css_width,
    ),
  } as const;

  // 6b. Frame-staleness guard. The mapped point is only trustworthy while the live
  //     page still matches the captured frame: if the viewport can't be read, or
  //     the viewport SIZE, document SCROLL, or LAYOUT extent drifted beyond
  //     tolerance, the screenshot is stale and the mapped point would miss (e.g.
  //     land inside a modal but off the moved button). Refuse WITHOUT dispatching
  //     and WITHOUT burning an attempt — the capsule stays active so the UI
  //     recaptures (and the agent keeps seeing HUMAN_VERIFICATION_REQUIRED).
  //     SAFE: never surfaces live/captured dims, scroll, layout, the delta, coords,
  //     or fx/fy — only the coarse `stale_kind` enum.
  const readLiveViewport = args.readLiveViewport ?? defaultVgcReadViewport;
  const liveViewport = await readLiveViewport({
    cdpUrl: args.cdpUrl,
    ...(args.targetId !== undefined ? { targetId: args.targetId } : {}),
  });
  if (!liveViewport) {
    logHvDebug({ ...gestureDebugBase, relay_result: "frame_stale", stale_kind: "viewport" });
    return { ok: false, reason: "viewport_drifted" };
  }
  const stale = isFrameStale(liveViewport, {
    width: frame.viewport_css_width,
    height: frame.viewport_css_height,
    scroll_x: frame.scroll_x,
    scroll_y: frame.scroll_y,
    layout_w: frame.layout_w,
    layout_h: frame.layout_h,
  });
  if (stale.stale) {
    logHvDebug({ ...gestureDebugBase, relay_result: "frame_stale", stale_kind: stale.kind });
    return {
      ok: false,
      reason:
        stale.kind === "viewport"
          ? "viewport_drifted"
          : stale.kind === "scroll"
            ? "scroll_drifted"
            : "layout_drifted",
    };
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
