/**
 * Visual Gesture Capsule — live guided press-and-hold relay (backend-only).
 *
 * The point-anchored counterpart to the DOM Human Presence Relay
 * (humanPresenceRelay.ts). For an OPAQUE / cross-origin human-verification wall
 * the host DOM cannot locate a control, so the user presses on a redacted
 * screenshot and we map a normalized point to CSS viewport coordinates. Unlike
 * the single-shot relay (visualGestureCapsuleRelay.ts), which REPLAYS a recorded
 * hold duration server-side, this path holds the browser mouse down ONLY while
 * fresh user heartbeats keep arriving from the Aegis web UI:
 *
 *   hold-start → press at the mapped point + arm a fail-closed timer
 *   heartbeat  → re-arm the fail-closed timer (silence → instant release)
 *   hold-end   → release + a definitive post-release recheck (cleared/retry)
 *
 * Hard rules (product principles this module enforces):
 * - The mouse-down exists ONLY while live heartbeats arrive. ~1.2s of silence,
 *   the max-duration ceiling, an in-hold cleared detection, or hold-end each
 *   release IMMEDIATELY. The press is NEVER replayed or extended past release.
 * - There is NO auto-solve path: every mousePressed is caused by a live user
 *   hold-start, every mouseReleased by the user's release / a fail-closed timer
 *   / the max ceiling / an in-hold "wall cleared" detection.
 * - Geometry stays function/session-scoped: the mapped CSS point lives only on
 *   the in-memory hold session and never appears in any API response or log.
 * - In-hold cleared detection is LOW-FREQUENCY and uses ONLY the same SAFE
 *   page-level presence probe the recheck slice uses (booleans in, booleans
 *   out) — no provider/iframe internals, no screenshot bytes, no coordinates.
 *
 * Memory-only by design (mirrors humanPresenceRelay.ts hold sessions): hold
 * sessions are never persisted, never logged, and carry no path/timing recording.
 *
 * Gated behind ANTIGEN_VISUAL_GESTURE_CAPSULE (default off, byte-identical when
 * off): startVgcHoldSession refuses with `flag_disabled` and presses nothing.
 */

import {
  isVisualGestureCapsuleEnabled,
  getVisualGestureCapsule,
  getVisualGestureCapsuleScreenshotFrame,
  isTerminalVisualGestureStatus,
  markGestureCapsuleCleared,
  mapNormalizedImagePointToViewport,
} from "./visualGestureCapsule.js";
import {
  openCdpPageClient,
  buildHumanVerificationProbeExpr,
  HOLD_FAIL_CLOSED_MS,
  type CdpPageClient,
} from "./humanPresenceRelay.js";
import {
  HOLD_MIN_DURATION_MS,
  isFrameStale,
  holdDurationBucket,
  targetPointBucket,
  screenshotScaleBucket,
  readPngWidthPx,
} from "./visualGestureCapsuleRelay.js";
import {
  recheckVisualGestureCapsule,
  classifyReleasePresence,
  geometryObstructionStrength,
} from "./visualGestureCapsuleRecheck.js";
import { buildAmbiguousVisualObstructionExpr } from "./antigenSnapshotRuntime.js";
import { defaultVgcReadViewport, type VgcReadViewportFn } from "./visualGestureCapsuleCapture.js";
import { logHvDebug } from "./humanVerificationState.js";

// ─── Tunables ─────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on a single VGC press-hold. Shorter than the DOM relay's 30s
 * ceiling, but large enough to accommodate the longest rung of the guided hold
 * ladder (15s) plus reaction headroom: a user prompted to "hold for 15 seconds"
 * may release a beat late, so the ceiling sits at 20s. Provider-agnostic — the
 * ladder timing comes from GESTURE_HOLD_TARGETS_MS, never from provider internals.
 */
export const VGC_HOLD_MAX_DURATION_MS = 20_000;

/** In-hold cleared-probe cadence. LOW-frequency, armed only after the min hold. */
export const VGC_IN_HOLD_PROBE_INTERVAL_MS = 1_000;

// ─── Injectable dependency seam (production defaults below) ───────────────────

/** Combined SAFE presence verdict from a single already-open CDP client. */
export type VgcHoldPresence = "present" | "absent" | "unknown";

/**
 * Run the SAME page-level presence detection the recheck slice uses, but on an
 * ALREADY-OPEN hold client (no second connection). Combines the structural-HV and
 * geometry-obstruction probes via classifyReleasePresence; both IIFEs reduce
 * geometry to booleans inside the page, so control_box / rects / vw/vh / page text
 * never escape. Any throw → "unknown" (never clears, never burns) so a flaky probe
 * can't drop the hold.
 *
 * Mirrors the recheck clear discipline: it returns "absent" (→ in-hold auto-clear
 * or pre-press challenge_gone) ONLY on a CONFIDENT healthy reading — HV absent AND
 * no geometry obstruction. A weak/ambiguous reading (a lone pointer interceptor)
 * or a probe that could read only one detector keeps the hold alive ("unknown"),
 * so a still-active wall is never released prematurely.
 */
export async function probeHoldPresenceOnClient(
  client: Pick<CdpPageClient, "evaluate">,
): Promise<VgcHoldPresence> {
  let hvPresent: boolean | undefined;
  try {
    const hvRaw = await client.evaluate(buildHumanVerificationProbeExpr());
    const v = (hvRaw as { present?: unknown } | null | undefined)?.present;
    hvPresent = typeof v === "boolean" ? v : undefined;
  } catch {
    hvPresent = undefined;
  }
  let geoStrength: "none" | "weak" | "strong" | undefined;
  try {
    const geoRaw = await client.evaluate(buildAmbiguousVisualObstructionExpr());
    geoStrength = geometryObstructionStrength(geoRaw);
  } catch {
    geoStrength = undefined;
  }
  const decision = classifyReleasePresence(hvPresent, geoStrength);
  // Only a confident healthy "absent" releases; "present" keeps holding; a
  // weak_ambiguous / unknown reading is reported as "unknown" (keep holding).
  if (decision === "absent") return "absent";
  if (decision === "present") return "present";
  return "unknown";
}

export interface VgcHoldDeps {
  /** CDP page-client opener (defaults to the shared openCdpPageClient). */
  openCdpClient?: typeof openCdpPageClient;
  /** Live viewport reader for the staleness guard (defaults to a CDP read). */
  readLiveViewport?: VgcReadViewportFn;
  /** Definitive post-release recheck (defaults to recheckVisualGestureCapsule). */
  recheck?: typeof recheckVisualGestureCapsule;
  /** In-hold presence probe against the held client (defaults to the union probe). */
  probeOnClient?: (client: Pick<CdpPageClient, "evaluate">) => Promise<VgcHoldPresence>;
}

// ─── Hold sessions (memory-only, one per capsule) ────────────────────────────

export type VgcHoldReleaseReason = "user_release" | "fail_closed" | "max_duration" | "cleared" | "cancelled";

interface VgcHoldSession {
  capsule_id: string;
  cdp_url: string;
  target_id?: string;
  client: CdpPageClient;
  /** Mapped CSS viewport point — session-scoped only, never surfaced. */
  point: { x: number; y: number };
  /** Coarse telemetry context computed at start (never raw fx/fy). */
  target_point_bucket: ReturnType<typeof targetPointBucket>;
  screenshot_scale_bucket: ReturnType<typeof screenshotScaleBucket>;
  recheck: NonNullable<VgcHoldDeps["recheck"]>;
  probeOnClient: NonNullable<VgcHoldDeps["probeOnClient"]>;
  started_at_ms: number;
  released_at_ms?: number;
  released: boolean;
  release_reason?: VgcHoldReleaseReason;
  /** Set true once an in-hold probe (or hold-end recheck) marked the wall cleared. */
  cleared: boolean;
  failTimer: ReturnType<typeof setTimeout>;
  maxTimer: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setTimeout>;
  /** Guard so overlapping in-hold probe ticks never run concurrently. */
  probe_in_flight: boolean;
}

const vgcHoldSessions = new Map<string, VgcHoldSession>();

export function hasLiveVgcHoldSession(capsuleId: string): boolean {
  const hold = vgcHoldSessions.get(capsuleId);
  return !!hold && !hold.released;
}

/**
 * Idempotent, AWAITED release of the browser mouse. Uses client.call so the
 * mouseReleased ack flushes the input pipeline before the connection is torn
 * down — never leaves the button stuck down (the constraint this enforces). The
 * first reason wins.
 */
async function releaseHold(hold: VgcHoldSession, reason: VgcHoldReleaseReason): Promise<void> {
  if (hold.released) return;
  hold.released = true;
  hold.release_reason = reason;
  hold.released_at_ms = Date.now();
  clearTimeout(hold.failTimer);
  clearTimeout(hold.maxTimer);
  if (hold.probeTimer) clearTimeout(hold.probeTimer);
  try {
    await hold.client.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: hold.point.x,
      y: hold.point.y,
      button: "left",
      clickCount: 1,
    });
  } catch {
    /* connection may already be gone — disposed below by the caller */
  }
}

function disposeHold(capsuleId: string): void {
  const hold = vgcHoldSessions.get(capsuleId);
  if (!hold) return;
  vgcHoldSessions.delete(capsuleId);
  try {
    hold.client.close();
  } catch {
    /* best-effort */
  }
}

// ─── In-hold cleared detection (low-frequency) ───────────────────────────────

/**
 * Arm the next in-hold probe tick. Each tick re-locates the wall on the LIVE
 * page via the SAFE union probe on the held client. If the wall is gone, release
 * the mouse immediately and mark the capsule cleared so the user need not keep
 * holding (req: "If cleared, release mouseUp, mark capsule cleared"). Otherwise
 * re-arm. Bounded: stops once released. The interval is LOW-frequency and reads
 * only booleans — never provider internals, geometry, or screenshot bytes.
 */
function armInHoldProbe(hold: VgcHoldSession): void {
  hold.probeTimer = setTimeout(() => {
    void runInHoldProbe(hold);
  }, VGC_IN_HOLD_PROBE_INTERVAL_MS);
}

async function runInHoldProbe(hold: VgcHoldSession): Promise<void> {
  if (hold.released || hold.probe_in_flight) return;
  hold.probe_in_flight = true;
  let presence: VgcHoldPresence = "unknown";
  try {
    presence = await hold.probeOnClient(hold.client);
  } catch {
    presence = "unknown";
  } finally {
    hold.probe_in_flight = false;
  }
  if (hold.released) return;
  if (presence === "absent") {
    // Wall cleared mid-hold: release, mark cleared, leave the session resolved.
    await releaseHold(hold, "cleared");
    const cleared = markGestureCapsuleCleared(hold.capsule_id);
    hold.cleared = cleared.ok;
    logHvDebug({ scope: "vgc_hold", hold_event: "in_hold_cleared" });
    return;
  }
  // present / unknown → keep holding; re-arm the next low-frequency tick.
  armInHoldProbe(hold);
}

// ─── Public surface ──────────────────────────────────────────────────────────

export type StartVgcHoldResult =
  | { ok: true; hold_state: "holding" | "challenge_gone" }
  | {
      ok: false;
      reason:
        | "flag_disabled"
        | "not_found"
        | "terminal"
        | "manual_fallback"
        | "invalid_coordinates"
        | "screenshot_frame_unavailable"
        | "viewport_drifted"
        | "scroll_drifted"
        | "layout_drifted"
        | "hold_already_active"
        | "cdp_failed"
        | "pointer_dispatch_failed";
    };

/**
 * Begin mirroring a live user hold at a normalized screenshot point. Every
 * refusal path returns BEFORE any pointer press. Order: flag → capsule →
 * frame → open client → staleness guard → presence probe (gone → clear, no
 * press) → map point → move+press → arm timers + in-hold probe.
 */
export async function startVgcHoldSession(args: {
  capsuleId: string;
  cdpUrl: string;
  targetId?: string;
  fx: number;
  fy: number;
  deps?: VgcHoldDeps;
}): Promise<StartVgcHoldResult> {
  // 1. Flag gate FIRST — never open a client or press when off.
  if (!isVisualGestureCapsuleEnabled()) return { ok: false, reason: "flag_disabled" };

  // 2. Resolve capsule; refuse missing/terminal/exhausted.
  const capsule = getVisualGestureCapsule(args.capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };
  if (capsule.status === "manual_fallback") return { ok: false, reason: "manual_fallback" };

  // 3. One live hold per capsule.
  const existing = vgcHoldSessions.get(args.capsuleId);
  if (existing && !existing.released) return { ok: false, reason: "hold_already_active" };
  if (existing) disposeHold(args.capsuleId);

  // 4. Validate the normalized point up front (range check; mapping is below).
  if (!Number.isFinite(args.fx) || args.fx < 0 || args.fx > 1 || !Number.isFinite(args.fy) || args.fy < 0 || args.fy > 1) {
    return { ok: false, reason: "invalid_coordinates" };
  }

  // 5. Require a live screenshot frame (lazy-expires; expired → undefined).
  const frame = getVisualGestureCapsuleScreenshotFrame(args.capsuleId);
  if (!frame) return { ok: false, reason: "screenshot_frame_unavailable" };

  const deps = args.deps ?? {};
  const openClient = deps.openCdpClient ?? openCdpPageClient;
  const readLiveViewport = deps.readLiveViewport ?? defaultVgcReadViewport;
  const recheck = deps.recheck ?? recheckVisualGestureCapsule;
  const probeOnClient = deps.probeOnClient ?? probeHoldPresenceOnClient;

  // Coarse, value-free debug base reused by every log below. Never fx/fy, coords,
  // dims, or PNG width. No-op unless ANTIGEN_HV_DEBUG is set.
  const targetBucket = targetPointBucket(args.fx, args.fy);
  const scaleBucket = screenshotScaleBucket(readPngWidthPx(frame.png_base64), frame.viewport_css_width);

  // 6. Open the long-lived CDP client.
  const opened = await openClient({
    cdpUrl: args.cdpUrl,
    domain: capsule.domain,
    ...(capsule.page_url !== undefined ? { preferredUrl: capsule.page_url } : {}),
  });
  if (!opened.ok) return { ok: false, reason: "cdp_failed" };
  const { client } = opened;

  // 7. Frame-staleness guard — refuse a mapped point the live page no longer
  //    matches (viewport resized, page scrolled/reflowed) BEFORE any press, with
  //    no attempt burned. SAFE: only the coarse stale_kind enum is logged.
  const liveViewport = await readLiveViewport({
    cdpUrl: args.cdpUrl,
    ...(args.targetId !== undefined ? { targetId: args.targetId } : {}),
  });
  if (!liveViewport) {
    client.close();
    logHvDebug({ scope: "vgc_hold", hold_event: "frame_stale", stale_kind: "viewport" });
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
    client.close();
    logHvDebug({ scope: "vgc_hold", hold_event: "frame_stale", stale_kind: stale.kind });
    return {
      ok: false,
      reason: stale.kind === "viewport" ? "viewport_drifted" : stale.kind === "scroll" ? "scroll_drifted" : "layout_drifted",
    };
  }

  // 8. Presence probe — if the wall already cleared, NEVER credit presence that
  //    didn't happen: mark cleared and return challenge_gone WITHOUT pressing.
  const preProbe = await probeOnClient(client);
  if (preProbe === "absent") {
    client.close();
    markGestureCapsuleCleared(args.capsuleId);
    logHvDebug({ scope: "vgc_hold", hold_event: "challenge_gone_at_start" });
    return { ok: true, hold_state: "challenge_gone" };
  }

  // 9. Map the normalized point to CSS viewport coords (server-only geometry).
  let point: { x: number; y: number };
  try {
    const mapped = mapNormalizedImagePointToViewport({
      fx: args.fx,
      fy: args.fy,
      viewportCssWidth: frame.viewport_css_width,
      viewportCssHeight: frame.viewport_css_height,
    });
    point = { x: mapped.cssX, y: mapped.cssY };
  } catch {
    client.close();
    return { ok: false, reason: "invalid_coordinates" };
  }

  // 10. Single deterministic move to arm hover, then press-and-hold. Both AWAITED
  //     so the press is acknowledged. If the press throws after landing, release
  //     immediately (constraint: release if pressed on any hold-start error).
  let pressed = false;
  try {
    await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    pressed = true;
  } catch {
    if (pressed) {
      try {
        await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      } catch {
        /* best-effort release */
      }
    }
    client.close();
    logHvDebug({ scope: "vgc_hold", hold_event: "press_failed", target_point_bucket: targetBucket });
    return { ok: false, reason: "pointer_dispatch_failed" };
  }

  // 11. Register the live session + arm fail-closed / max-cap / in-hold probe.
  const nowMs = Date.now();
  const hold: VgcHoldSession = {
    capsule_id: args.capsuleId,
    cdp_url: args.cdpUrl,
    ...(args.targetId !== undefined ? { target_id: args.targetId } : {}),
    client,
    point,
    target_point_bucket: targetBucket,
    screenshot_scale_bucket: scaleBucket,
    recheck,
    probeOnClient,
    started_at_ms: nowMs,
    released: false,
    cleared: false,
    probe_in_flight: false,
    failTimer: setTimeout(() => {
      void releaseHold(getOrSelf(args.capsuleId, hold), "fail_closed");
    }, HOLD_FAIL_CLOSED_MS),
    maxTimer: setTimeout(() => {
      void releaseHold(getOrSelf(args.capsuleId, hold), "max_duration");
    }, VGC_HOLD_MAX_DURATION_MS),
  };
  vgcHoldSessions.set(args.capsuleId, hold);
  // Arm the first in-hold probe only AFTER the minimum hold has elapsed, so a
  // too-short tap never triggers a clear and the cadence stays low-frequency.
  hold.probeTimer = setTimeout(() => {
    void runInHoldProbe(hold);
  }, Math.max(HOLD_MIN_DURATION_MS, VGC_IN_HOLD_PROBE_INTERVAL_MS));

  logHvDebug({ scope: "vgc_hold", hold_event: "hold_started", target_point_bucket: targetBucket, screenshot_scale_bucket: scaleBucket });
  return { ok: true, hold_state: "holding" };
}

/** Resolve the current session for a capsule, falling back to the closure ref. */
function getOrSelf(capsuleId: string, fallback: VgcHoldSession): VgcHoldSession {
  return vgcHoldSessions.get(capsuleId) ?? fallback;
}

export interface HeartbeatVgcHoldResult {
  hold_state: "holding" | "released_fail_closed" | "cleared" | "no_hold";
}

/**
 * Live user heartbeat: re-arms the fail-closed timer. Reports `cleared` when an
 * in-hold probe already detected the wall gone (UI stops + resumes the agent),
 * `released_fail_closed` when the hold was force-released, `holding` otherwise.
 */
export function heartbeatVgcHoldSession(capsuleId: string): HeartbeatVgcHoldResult {
  const hold = vgcHoldSessions.get(capsuleId);
  if (!hold) return { hold_state: "no_hold" };
  if (hold.released) {
    return { hold_state: hold.cleared || hold.release_reason === "cleared" ? "cleared" : "released_fail_closed" };
  }
  clearTimeout(hold.failTimer);
  hold.failTimer = setTimeout(() => {
    void releaseHold(getOrSelf(capsuleId, hold), "fail_closed");
  }, HOLD_FAIL_CLOSED_MS);
  return { hold_state: "holding" };
}

export interface EndVgcHoldResult {
  ok: true;
  /** `too_short` when released under the min threshold — no attempt burned. */
  hold_state: "cleared" | "still_present" | "inconclusive" | "unknown" | "too_short" | "no_hold";
}

/**
 * User released (or a timer already released): release the browser mouse
 * immediately (idempotent), then resolve. A sub-threshold hold is `too_short`
 * (no recheck, NO attempt burned). Otherwise — unless an in-hold probe already
 * cleared it — run the definitive post-release recheck, whose outcome flows
 * straight through (`cleared` / `still_present` / `inconclusive` → attempt burn /
 * `unknown` → no burn). The mouse is always released before this returns.
 */
export async function endVgcHoldSession(capsuleId: string): Promise<EndVgcHoldResult> {
  const hold = vgcHoldSessions.get(capsuleId);
  if (!hold) return { ok: true, hold_state: "no_hold" };

  const wasClearedInHold = hold.cleared || hold.release_reason === "cleared";
  // Release first (idempotent) so the mouse is never left down past this call.
  await releaseHold(hold, "user_release");
  const endMs = hold.released_at_ms ?? Date.now();
  const heldMs = endMs - hold.started_at_ms;
  const cdpUrl = hold.cdp_url;
  const targetId = hold.target_id;
  const recheck = hold.recheck;
  const heldBucket = holdDurationBucket(heldMs);

  // The held client is single-purpose; recheck opens its own connection.
  disposeHold(capsuleId);

  // Already cleared by an in-hold probe → report cleared without re-probing.
  if (wasClearedInHold) {
    logHvDebug({ scope: "vgc_hold", hold_event: "hold_ended", hold_duration_bucket: heldBucket, end_outcome: "cleared" });
    return { ok: true, hold_state: "cleared" };
  }

  // Sub-threshold: too brief to be a real hold — no recheck, no attempt burned.
  if (heldMs < HOLD_MIN_DURATION_MS) {
    logHvDebug({ scope: "vgc_hold", hold_event: "hold_ended", hold_duration_bucket: heldBucket, end_outcome: "too_short" });
    return { ok: true, hold_state: "too_short" };
  }

  // Definitive post-release recheck. The post-release SETTLE, the structural-HV
  // + geometry-strength union, and the single WEAK-geometry retry all live in the
  // recheck helper, which owns the cleared / attempt-burn / manual_fallback state
  // transitions. A lone pointer interceptor on a settled page no longer keeps the
  // capsule pending; unknown / probe failure never burn an attempt.
  const result = await recheck({
    capsuleId,
    cdpUrl,
    ...(targetId !== undefined ? { targetId } : {}),
  });

  if (!result.ok) {
    logHvDebug({ scope: "vgc_hold", hold_event: "hold_ended", hold_duration_bucket: heldBucket, end_outcome: "recheck_failed" });
    return { ok: true, hold_state: "unknown" };
  }
  logHvDebug({ scope: "vgc_hold", hold_event: "hold_ended", hold_duration_bucket: heldBucket, end_outcome: result.outcome });
  return { ok: true, hold_state: result.outcome };
}

/** Cancel any live hold for the capsule (user cancel / expiry). Fail-closed. */
export async function cancelVgcHoldSession(capsuleId: string): Promise<void> {
  const hold = vgcHoldSessions.get(capsuleId);
  if (!hold) return;
  await releaseHold(hold, "cancelled");
  disposeHold(capsuleId);
}

/** Test-only: release + drop all hold sessions between cases. */
export function clearVgcHoldSessionsForTests(): void {
  for (const [id, hold] of vgcHoldSessions) {
    clearTimeout(hold.failTimer);
    clearTimeout(hold.maxTimer);
    if (hold.probeTimer) clearTimeout(hold.probeTimer);
    try {
      hold.client.close();
    } catch {
      /* best-effort */
    }
    vgcHoldSessions.delete(id);
  }
  vgcHoldSessions.clear();
}
