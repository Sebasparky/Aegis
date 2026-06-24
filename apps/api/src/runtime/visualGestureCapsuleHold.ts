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
  markGestureAttemptRejected,
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
import { renderVgcHoldOverlay } from "./nativePointerRuntime.js";
import {
  classifyHoldPresenceViaModel,
  type VgcHoldClassifierSeams,
  type VgcHoldModelVerdict,
} from "./visualGestureCapsuleHoldClassifier.js";
import {
  publishHvHandoffUpdate,
  type HvHandoffPhase,
  type HvHandoffPresenceSource,
} from "./humanVerificationHandoff.js";
import {
  isVisualHvHandoffEnabled,
  startVisualHandoffMonitor,
  registerVgcHoldReleaseHook,
  registerVgcHoldActiveProbe,
  registerVgcHoldAnchorProbe,
} from "./visualHandoffMonitor.js";
import { clearWholeCropProgress } from "./visualReleaseReadyWholeCrop.js";
import { clearControlFill } from "./visualControlFillDetector.js";

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

/**
 * Minimum spacing between ADVISORY model status judgments during a hold. The DOM
 * presence probe (the release authority) runs every tick; the model status
 * enrichment runs at most this often so a hold makes only a handful of sidecar
 * calls (≤ ~7 over the 20s ceiling) — cheap, and active ONLY during a live hold.
 */
export const VGC_HOLD_MODEL_STATUS_INTERVAL_MS = 3_000;

/**
 * Publish a safe handoff status update for a capsule, resolving the safe
 * correlation metadata (browser session / domain / HV request id) from the
 * capsule record. Best-effort; a missing capsule simply skips the publish. Never
 * throws into the hold path.
 */
function publishHoldHandoff(
  capsuleId: string,
  phase: HvHandoffPhase,
  extra?: {
    presence_source?: HvHandoffPresenceSource;
    model_label?: string;
    model_confidence?: number;
    /** Genuine hold-end / regression — lets a still_active publish through the non-downgrade latch. */
    allowReleaseReadyDowngrade?: boolean;
  },
): void {
  const capsule = getVisualGestureCapsule(capsuleId);
  if (!capsule) return;
  publishHvHandoffUpdate({
    browser_session_id: capsule.browser_session_id,
    source: "visual_gesture_capsule",
    phase,
    capsule_id: capsule.capsule_id,
    human_verification_request_id: capsule.human_verification_request_id,
    domain: capsule.domain,
    ...(extra?.presence_source ? { presence_source: extra.presence_source } : {}),
    ...(extra?.model_label ? { model_label: extra.model_label } : {}),
    ...(extra?.model_confidence !== undefined ? { model_confidence: extra.model_confidence } : {}),
    ...(extra?.allowReleaseReadyDowngrade ? { allow_release_ready_downgrade: true } : {}),
  });
}

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
  /**
   * ADVISORY model presence classifier for live status enrichment (defaults to
   * classifyHoldPresenceViaModel). NEVER an authority — informs status text only.
   * Returns `{ available:false }` when the visual-judgment flag is off.
   */
  classifyModel?: (args: {
    cdpUrl: string;
    seams?: VgcHoldClassifierSeams;
  }) => ReturnType<typeof classifyHoldPresenceViaModel>;
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
  classifyModel: NonNullable<VgcHoldDeps["classifyModel"]>;
  /** Last advisory model status judgment time (cadence-limits the sidecar calls). */
  last_model_probe_ms?: number;
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
 * Resolve the live hold's anchor for the release-ready crop seam: the user's mapped
 * press point (CSS viewport px) plus the capture viewport, and the coarse `point_bucket`
 * (the ONLY part safe to log). Returns undefined when no live/unreleased hold exists or
 * the capture frame's viewport is unavailable. The raw point lives only on the session
 * and is consumed internally to crop — it never appears in any API response or log.
 */
export function getVgcHoldAnchor(
  capsuleId: string,
): { point: { x: number; y: number }; viewport: { vw: number; vh: number }; point_bucket: string } | undefined {
  const hold = vgcHoldSessions.get(capsuleId);
  if (!hold || hold.released) return undefined;
  const frame = getVisualGestureCapsuleScreenshotFrame(capsuleId);
  if (!frame || !(frame.viewport_css_width > 0) || !(frame.viewport_css_height > 0)) return undefined;
  return {
    point: { x: hold.point.x, y: hold.point.y },
    viewport: { vw: frame.viewport_css_width, vh: frame.viewport_css_height },
    point_bucket: hold.target_point_bucket,
  };
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

/**
 * Release + dispose any live press-hold for a capsule. The visual handoff monitor
 * (the model-driven completion authority) invokes this via a registered hook the
 * instant it confirms a stable visual clear, so the browser mouse is never left
 * down waiting for the next heartbeat / fail-closed timer. Best-effort, awaited
 * internally but fire-and-forget from the monitor's perspective.
 */
export function forceReleaseActiveHold(capsuleId: string): void {
  const hold = vgcHoldSessions.get(capsuleId);
  if (!hold || hold.released) {
    disposeHold(capsuleId);
    return;
  }
  hold.cleared = true;
  void releaseHold(hold, "cleared").finally(() => disposeHold(capsuleId));
}

// Register the release hook so the monitor can release a live hold on completion
// WITHOUT importing this module (no hold ⇄ monitor import cycle).
registerVgcHoldReleaseHook(forceReleaseActiveHold);

// Register the active-hold predicate so the monitor's release-ready ("Release now")
// detector runs ONLY while a live press is active — same seam pattern, no cycle.
registerVgcHoldActiveProbe(hasLiveVgcHoldSession);

// Register the hold-anchor resolver so the release-ready crop can center on the user's
// actual press point (the strongest signal for where the control is) — same seam, no cycle.
registerVgcHoldAnchorProbe(getVgcHoldAnchor);

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
    // CONSERVATIVE AUTHORITY: the DOM union probe alone decides release. The model
    // (below) never releases — it only enriches the advisory status text.
    presence = await hold.probeOnClient(hold.client);
  } catch {
    presence = "unknown";
  } finally {
    hold.probe_in_flight = false;
  }
  if (hold.released) return;
  if (presence === "absent") {
    // Wall cleared mid-hold: release, mark cleared, publish the authoritative
    // `completed` (the conservative DOM probe is the sole completion authority).
    await releaseHold(hold, "cleared");
    const cleared = markGestureCapsuleCleared(hold.capsule_id);
    hold.cleared = cleared.ok;
    publishHoldHandoff(hold.capsule_id, "completed", { presence_source: "dom_probe" });
    logHvDebug({ scope: "vgc_hold", hold_event: "in_hold_cleared" });
    return;
  }

  // ADVISORY model status enrichment (best-effort, NON-blocking on release). Runs
  // at most every VGC_HOLD_MODEL_STATUS_INTERVAL_MS and ONLY while the hold is
  // live, so a hold makes only a handful of sidecar calls and there is NO model
  // call outside an active handoff. A `looks_clear` verdict publishes the ADVISORY
  // `looks_complete_checking` (agent_should_wait stays true — never a release);
  // `wall_present` publishes `still_active`. `uncertain`/unavailable publishes
  // nothing (the DOM-driven status stands). The model is never the authority.
  try {
    const nowMs = Date.now();
    const due =
      hold.last_model_probe_ms === undefined ||
      nowMs - hold.last_model_probe_ms >= VGC_HOLD_MODEL_STATUS_INTERVAL_MS;
    if (due) {
      hold.last_model_probe_ms = nowMs;
      const verdict = await hold.classifyModel({ cdpUrl: hold.cdp_url });
      if (!hold.released && verdict.available) {
        const extra = {
          presence_source: "model" as HvHandoffPresenceSource,
          ...(verdict.model_label ? { model_label: verdict.model_label } : {}),
          ...(verdict.model_confidence !== undefined
            ? { model_confidence: verdict.model_confidence }
            : {}),
        };
        if (verdict.verdict === "looks_clear") {
          publishHoldHandoff(hold.capsule_id, "looks_complete_checking", extra);
        } else if (verdict.verdict === "wall_present") {
          publishHoldHandoff(hold.capsule_id, "still_active", extra);
        }
      }
    }
  } catch {
    /* advisory only — never affects the hold */
  }
  if (hold.released) return;

  // present / unknown → keep holding; re-arm the next low-frequency tick.
  armInHoldProbe(hold);
}

// ─── Public surface ──────────────────────────────────────────────────────────

export type StartVgcHoldResult =
  | { ok: true; hold_state: "holding" | "challenge_gone" | "deferred_clear" }
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
  const classifyModel = deps.classifyModel ?? classifyHoldPresenceViaModel;

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

  // 8. Pre-press gate. When the visual handoff flag is ON, the VISUAL MODEL gates
  //    the press and the DOM `challenge_gone_at_start` instant-clear is bypassed:
  //    a DOM "absent" is unreliable for an opaque/cross-origin wall and must never
  //    complete a visual capsule by itself. The lifecycle monitor (running since
  //    mint) is the sole completion authority.
  //
  //    - model confidently clear  → do NOT press the live site (avoid a stray
  //      click on the underlying page); publish `looks_complete_checking` and let
  //      the monitor confirm a STABLE clear before `completed`. Returns
  //      `deferred_clear` (no press).
  //    - model wall_present       → relay the user's press (status `still_active`).
  //    - model uncertain/unavailable → proceed with the user's intended press
  //      (uncertain ≠ clear; never complete from here), status `holding`.
  const handoffActive = isVisualHvHandoffEnabled();
  let pressPhase: HvHandoffPhase = "holding";
  if (handoffActive) {
    const gate = await classifyModel({ cdpUrl: args.cdpUrl });
    const gateModel = {
      presence_source: "model" as HvHandoffPresenceSource,
      ...(gate.model_label ? { model_label: gate.model_label } : {}),
      ...(gate.model_confidence !== undefined ? { model_confidence: gate.model_confidence } : {}),
    };
    if (gate.available && gate.verdict === "looks_clear") {
      // Confidently clear — do not press. The monitor completes on a STABLE clear.
      client.close();
      startVisualHandoffMonitor({
        capsuleId: args.capsuleId,
        cdpUrl: args.cdpUrl,
        browserSessionId: capsule.browser_session_id,
      });
      publishHoldHandoff(args.capsuleId, "looks_complete_checking", gateModel);
      logHvDebug({ scope: "vgc_hold", hold_event: "model_gate_deferred_clear" });
      return { ok: true, hold_state: "deferred_clear" };
    }
    pressPhase = gate.available && gate.verdict === "wall_present" ? "still_active" : "holding";
  } else {
    // Flag OFF — legacy DOM pre-probe: if the wall already cleared, mark cleared
    // and return challenge_gone WITHOUT pressing (byte-identical to today).
    const preProbe = await probeOnClient(client);
    if (preProbe === "absent") {
      client.close();
      markGestureCapsuleCleared(args.capsuleId);
      publishHoldHandoff(args.capsuleId, "completed", { presence_source: "dom_probe" });
      logHvDebug({ scope: "vgc_hold", hold_event: "challenge_gone_at_start" });
      return { ok: true, hold_state: "challenge_gone" };
    }
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
    classifyModel,
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
  if (handoffActive) {
    // The lifecycle visual monitor (running since mint) owns polling + completion;
    // the DOM in-hold probe is NOT armed (DOM is auxiliary/debug only). Ensure the
    // monitor is running with this known-good cdp_url (idempotent).
    startVisualHandoffMonitor({
      capsuleId: args.capsuleId,
      cdpUrl: args.cdpUrl,
      browserSessionId: capsule.browser_session_id,
    });
  } else {
    // Flag OFF — arm the first in-hold DOM probe only AFTER the minimum hold has
    // elapsed, so a too-short tap never triggers a clear and the cadence stays low.
    hold.probeTimer = setTimeout(() => {
      void runInHoldProbe(hold);
    }, Math.max(HOLD_MIN_DURATION_MS, VGC_IN_HOLD_PROBE_INTERVAL_MS));
  }

  logHvDebug({ scope: "vgc_hold", hold_event: "hold_started", target_point_bucket: targetBucket, screenshot_scale_bucket: scaleBucket });

  // Dev-only headed-QA aid: place the pointer debug marker at the hold point. Strict
  // no-op (zero CDP traffic) unless ANTIGEN_POINTER_DEBUG_OVERLAY=true. Injection only —
  // no pointer dispatch — and invoked AFTER the press succeeded, so it can never block or
  // delay the press/release or alter hold timing. Fire-and-forget / fail-open.
  renderVgcHoldOverlay(client, point.x, point.y);

  // The live press is now mirrored into the browser — publish the handoff status.
  // Flag ON: `still_active`/`holding` from the model gate (presence_source already
  // set on pressPhase's model). Flag OFF: legacy `holding` (dom_probe). Safe-only.
  publishHoldHandoff(
    args.capsuleId,
    handoffActive ? pressPhase : "holding",
    { presence_source: handoffActive ? "model" : "dom_probe" },
  );

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
  const classifyModel = hold.classifyModel;
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

  // Visual handoff flag ON: a SINGLE post-release VISUAL model check, for guided
  // attempt-ladder accounting ONLY — it NEVER completes (the lifecycle monitor is
  // the sole completion authority, on a stable visual clear). DOM is never the
  // completer here.
  //   - model confidently clear → no burn; report `unknown` and let the monitor
  //     confirm a STABLE clear and publish `completed`.
  //   - model wall_present      → burn one attempt (steps 5s→10s→15s→manual), `still_present`.
  //   - uncertain/unavailable   → burn one attempt (fail-closed step-up), `inconclusive`.
  if (isVisualHvHandoffEnabled()) {
    let verdict: VgcHoldModelVerdict = "uncertain";
    try {
      const r = await classifyModel({ cdpUrl });
      verdict = r.available ? r.verdict : "uncertain";
    } catch {
      verdict = "uncertain";
    }
    if (verdict === "looks_clear") {
      logHvDebug({ scope: "vgc_hold", hold_event: "hold_ended", hold_duration_bucket: heldBucket, end_outcome: "model_clear_pending" });
      return { ok: true, hold_state: "unknown" };
    }
    const burned = markGestureAttemptRejected(capsuleId);
    // Genuine hold-end downgrade — pass the explicit marker so the non-downgrade latch lets this
    // still_active through even if "Release now" was the latest phase.
    publishHoldHandoff(capsuleId, "still_active", {
      presence_source: "model",
      allowReleaseReadyDowngrade: true,
    });
    // RETRY RESET. This attempt did not clear; drop the per-capsule whole-crop + control-fill
    // state so the next hold re-baselines from the retry's initial frame. Otherwise the failed
    // attempt's baseline / locked control bounds / prev-frame / relaxed-sustained streak poisons
    // the next attempt's release-ready read (a partially-filled-then-rejected first hold could
    // mis-resolve bounds or mis-fire "Release now" on retry).
    clearWholeCropProgress(capsuleId);
    clearControlFill(capsuleId);
    const endOutcome = verdict === "wall_present" ? "still_present" : "inconclusive";
    logHvDebug({ scope: "vgc_hold", hold_event: "hold_ended", hold_duration_bucket: heldBucket, end_outcome: endOutcome });
    // A failed state update still never completes — report unknown (no burn credited).
    if (!burned.ok) return { ok: true, hold_state: "unknown" };
    return { ok: true, hold_state: endOutcome };
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
  publishHoldHandoff(capsuleId, "cancelled");
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
