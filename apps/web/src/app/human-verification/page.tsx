"use client";

// Internal Visual Gesture Capsule panel (M2A).
//
// Lets a user complete the user-presence loop for an opaque human-verification
// wall: see the redacted screenshot frame Antigen captured, tap or press-hold
// where the site asks them to confirm they're human, and let Antigen relay that
// gesture and recheck the wall. This is the USER providing fresh presence through
// Antigen — NOT an agent solving a challenge.
//
// Trust boundary:
//  - The UI never holds a cdp_url. The server derives the browser CDP context from
//    the capsule (M2B); every request body here is cdp_url-free.
//  - Screenshot bytes are used ONLY as an <img> src — never logged, never sent to
//    /gesture or /recheck. Only normalized fx/fy (+ duration for press-hold) leave
//    the client.
//  - No cdp_url / target_id / browser_session_id is rendered, stored, or sent.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listVisualGestureCapsules,
  getVisualGestureCapsuleScreenshot,
  submitVisualGestureCapsuleGesture,
  recheckVisualGestureCapsule,
  recaptureVisualGestureCapsule,
  cancelVisualGestureCapsule,
  createVisualGestureCapsuleSmoke,
  startVisualGestureCapsuleHold,
  sendVisualGestureCapsuleHeartbeat,
  endVisualGestureCapsuleHold,
  type VisualGestureCapsuleView,
  type VisualGestureKind,
} from "@/lib/api";
import { normalizePointInRect } from "@/lib/normalizePoint";

const POLL_MS = 2500;
// Live press-and-hold cadence (mirrors components/press-and-hold.tsx): a 300ms
// heartbeat keeps the browser mouse-down alive; a 100ms tick drives the timer.
const HEARTBEAT_INTERVAL_MS = 300;
const ELAPSED_TICK_MS = 100;

// Guided fixed-duration attempts. The duration ladder (generic Antigen timing —
// NOT tied to any provider) lives server-side and arrives as `recommended_hold_ms`
// on each capsule view: attempt 1 asks for a 5s hold, attempt 2 a longer 10s hold,
// attempt 3 a 15s hold; after the ladder is exhausted the user is sent to the
// visible browser (manual_fallback). The user always releases physically once
// prompted — Antigen never extends or replays the hold past release.
const DEFAULT_HOLD_MS = 5000;
function holdTargetMs(view: { recommended_hold_ms?: number } | null | undefined): number {
  return view?.recommended_hold_ms ?? DEFAULT_HOLD_MS;
}

// Dev-only affordance gate. Next.js inlines process.env.NODE_ENV in client code;
// the backend smoke route is itself NODE_ENV-gated, so this only hides the button.
const IS_DEV = process.env.NODE_ENV !== "production";

type GestureMode = "tap" | "press_hold";

// Statuses where a fresh gesture is actionable from the UI.
function isActionable(status: VisualGestureCapsuleView["status"]): boolean {
  return status === "awaiting_user_gesture" || status === "rejected_retryable";
}

function errCode(e: unknown): string | undefined {
  return (e as { code?: string } | undefined)?.code;
}

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

const STATUS_BADGE: Record<string, string> = {
  awaiting_user_gesture: "bg-amber-950 text-amber-300 border-amber-800",
  relaying: "bg-blue-950 text-blue-300 border-blue-800",
  checking: "bg-blue-950 text-blue-300 border-blue-800",
  cleared: "bg-emerald-950 text-emerald-300 border-emerald-800",
  rejected_retryable: "bg-orange-950 text-orange-300 border-orange-800",
  manual_fallback: "bg-rose-950 text-rose-300 border-rose-800",
  expired: "bg-gray-800 text-gray-400 border-gray-700",
  failed: "bg-rose-950 text-rose-300 border-rose-800",
  cancelled: "bg-gray-800 text-gray-400 border-gray-700",
};

const btn =
  "text-xs font-medium rounded-md px-3 py-1.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const btnDefault = `${btn} bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700`;
const btnPrimary = `${btn} bg-indigo-700 border-indigo-600 text-white hover:bg-indigo-600`;
const btnDanger = `${btn} bg-rose-900 border-rose-800 text-rose-100 hover:bg-rose-800`;

export default function HumanVerificationPage() {
  const [capsules, setCapsules] = useState<VisualGestureCapsuleView[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Screenshot bytes as a data URL — held ONLY to feed the <img> src.
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [screenshotMissing, setScreenshotMissing] = useState(false);

  // Default to press-and-hold: opaque HV walls (PerimeterX-style) are press-and-hold
  // challenges, so a normal press in the UI should relay a real hold, not a tap. The
  // tap toggle stays available for the rarer tap/checkbox challenges.
  const [mode, setMode] = useState<GestureMode>("press_hold");
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);

  // ── Live press-and-hold state ───────────────────────────────────────────────
  // The browser mouse stays down only while we keep sending heartbeats; on
  // release (or a fail-closed / cleared signal) we end the hold and recheck.
  const [holding, setHolding] = useState(false);
  const [holdElapsedMs, setHoldElapsedMs] = useState(0);
  const holdingRef = useRef(false); // pauses the capsule-list poll while holding
  const endingRef = useRef(false); // idempotency guard for finalizeHold
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStartMsRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);
  const captureElRef = useRef<Element | null>(null);
  // The capsule whose live hold is currently active, so a capsule switch /
  // unmount / cancel can explicitly release the browser mouse rather than waiting
  // for the server's 1.2s fail-closed backstop.
  const heldCapsuleIdRef = useRef<string | null>(null);

  // Dev-only diagnostic: the last interpreted normalized point we sent, rendered
  // as a marker over the screenshot so we can visually confirm the click landed
  // where the user intended. UI-only — this is the SAME fx/fy already sent in the
  // gesture body; it is never sent anywhere extra and is gated behind IS_DEV.
  const [markerPoint, setMarkerPoint] = useState<{ fx: number; fy: number } | null>(null);

  const selected = capsules.find((c) => c.capsule_id === selectedId) ?? null;

  // ── Poll active capsules ────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    async function poll() {
      // Pause polling while a live hold is in progress — the list churning would
      // drop the selected capsule mid-hold and race the heartbeat loop.
      if (holdingRef.current) return;
      try {
        const res = await listVisualGestureCapsules();
        if (!active) return;
        setDisabled(Boolean(res.disabled));
        setCapsules(res.data);
        setLoadError(null);
      } catch {
        if (active) setLoadError("Could not reach Antigen. Make sure the API is running.");
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Keep a valid selection as the list churns.
  useEffect(() => {
    if (selectedId && !capsules.some((c) => c.capsule_id === selectedId)) {
      setSelectedId(null);
      setScreenshotDataUrl(null);
    } else if (!selectedId && capsules.length > 0) {
      setSelectedId(capsules[0].capsule_id);
    }
  }, [capsules, selectedId]);

  // Drop the diagnostic marker whenever the selected capsule changes — it only
  // describes the current capsule's last gesture.
  useEffect(() => {
    setMarkerPoint(null);
  }, [selectedId]);

  // ── Screenshot fetch (bytes used only as <img> src) ─────────────────────────
  const loadScreenshot = useCallback(async (capsuleId: string) => {
    setScreenshotMissing(false);
    try {
      const shot = await getVisualGestureCapsuleScreenshot(capsuleId);
      setScreenshotDataUrl(`data:${shot.mime_type};base64,${shot.png_base64}`);
    } catch {
      // Any failure (typically SCREENSHOT_FRAME_UNAVAILABLE: never captured,
      // expired, or purged) means there is no frame to show — prompt recapture.
      setScreenshotDataUrl(null);
      setScreenshotMissing(true);
    }
  }, []);

  // Load the screenshot when the selection changes (if a frame is available).
  useEffect(() => {
    if (!selected) {
      setScreenshotDataUrl(null);
      setScreenshotMissing(false);
      return;
    }
    if (selected.screenshot_available) {
      void loadScreenshot(selected.capsule_id);
    } else {
      setScreenshotDataUrl(null);
      setScreenshotMissing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.screenshot_available]);

  // ── Gesture → recheck loop ──────────────────────────────────────────────────
  const runRecheck = useCallback(
    async (capsuleId: string) => {
      const res = await recheckVisualGestureCapsule(capsuleId);
      if (res.recheck === "cleared" || res.status === "cleared") {
        setStatusMsg("Cleared — presence confirmed. This request will clear from the list.");
        setHint(null);
        return;
      }
      if (res.status === "manual_fallback") {
        setStatusMsg("Please complete this in the visible browser.");
        setHint(null);
        return;
      }
      if (res.recheck === "still_present") {
        setStatusMsg(`Still present — try again. (attempt ${res.attempt_count}/${selected?.max_attempts ?? "?"})`);
        setHint("The frame may have changed — recapture to see the current view.");
        await loadScreenshot(capsuleId);
        return;
      }
      if (res.recheck === "inconclusive") {
        // Weak/ambiguous — NOT cleared. Prompt a longer hold; never claim presence.
        setStatusMsg(
          `Couldn't confirm it cleared — try a longer ${Math.round(holdTargetMs(res.data) / 1000)}-second hold. (attempt ${res.attempt_count}/${selected?.max_attempts ?? "?"})`,
        );
        setHint("The frame may have changed — recapture to see the current view.");
        await loadScreenshot(capsuleId);
        return;
      }
      // unknown / probe could not decide.
      setStatusMsg("Could not confirm yet. Try Recheck or Recapture.");
      setHint(null);
    },
    [loadScreenshot, selected?.max_attempts],
  );

  const sendGesture = useCallback(
    async (capsuleId: string, kind: VisualGestureKind, fx: number, fy: number, durationMs?: number) => {
      setBusy(true);
      setHint(null);
      setStatusMsg(kind === "tap" ? "Relaying tap…" : "Relaying press & hold…");
      try {
        const g = await submitVisualGestureCapsuleGesture(capsuleId, {
          kind,
          fx,
          fy,
          ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        });
        if (g.status === "manual_fallback") {
          setStatusMsg("Please complete this in the visible browser.");
          return;
        }
        setStatusMsg("Gesture relayed — checking the page…");
        await runRecheck(capsuleId);
      } catch (e) {
        const code = errCode(e);
        if (code === "MANUAL_FALLBACK") {
          setStatusMsg("Please complete this in the visible browser.");
        } else if (code === "SCREENSHOT_FRAME_UNAVAILABLE") {
          setStatusMsg("The screenshot expired before the gesture landed. Recapture and try again.");
          setScreenshotMissing(true);
          setScreenshotDataUrl(null);
        } else if (code === "BROWSER_SESSION_UNAVAILABLE") {
          setStatusMsg("No live browser session is available for this request.");
        } else if (code === "FRAME_STALE_RECAPTURE_REQUIRED" || code === "VIEWPORT_DRIFTED") {
          // The page scrolled/resized/reflowed after capture, so the screenshot no
          // longer matches the live layout and the gesture was NOT dispatched.
          setStatusMsg("Frame changed — recapture and try again.");
          setHint("The page moved since this view was captured. Recapture to see the current layout.");
        } else if (code === "INVALID_COORDINATES" || code === "INVALID_GESTURE") {
          setStatusMsg("That gesture was rejected. Try tapping inside the highlighted area.");
        } else {
          setStatusMsg("Could not relay the gesture. Try again or recapture.");
        }
      } finally {
        setBusy(false);
      }
    },
    [runRecheck],
  );

  // ── Pointer handlers on the screenshot overlay ──────────────────────────────
  function pointFromEvent(clientX: number, clientY: number): { fx: number; fy: number } | null {
    const el = imgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return normalizePointInRect(clientX, clientY, rect);
  }

  function handleTapClick(e: React.MouseEvent) {
    if (mode !== "tap" || !selected || busy || !isActionable(selected.status)) return;
    const pt = pointFromEvent(e.clientX, e.clientY);
    if (!pt) {
      setHint("That point is outside the image. Tap inside the screenshot.");
      return;
    }
    if (IS_DEV) setMarkerPoint({ fx: pt.fx, fy: pt.fy });
    void sendGesture(selected.capsule_id, "tap", pt.fx, pt.fy);
  }

  // Stop the heartbeat + elapsed-timer intervals (idempotent).
  const stopHoldTimers = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  // Explicitly release an active live hold without awaiting or touching the
  // outcome — used on capsule switch / unmount / route cleanup, where we cannot
  // safely run the full finalizeHold (it updates component state). Fire-and-forget
  // + idempotent: a hold already released through the server's fail-closed backstop
  // simply returns NO_ACTIVE_HOLD, which we swallow so no error surfaces.
  const bestEffortReleaseHold = useCallback(() => {
    const capsuleId = heldCapsuleIdRef.current;
    if (!capsuleId) return;
    heldCapsuleIdRef.current = null;
    holdingRef.current = false;
    endingRef.current = true; // block any in-flight finalizeHold from racing
    stopHoldTimers();
    setHolding(false);
    setHoldElapsedMs(0);
    void endVisualGestureCapsuleHold(capsuleId).catch(() => {});
  }, [stopHoldTimers]);

  // End the live hold: release the browser mouse (via hold-end) and surface the
  // definitive recheck outcome. Idempotent — the user's release, a fail-closed /
  // cleared heartbeat, or unmount all funnel here exactly once.
  const finalizeHold = useCallback(
    async (capsuleId: string) => {
      if (endingRef.current) return;
      endingRef.current = true;
      stopHoldTimers();
      holdingRef.current = false;
      heldCapsuleIdRef.current = null;
      setHolding(false);
      const el = captureElRef.current;
      if (el && pointerIdRef.current !== null) {
        try {
          el.releasePointerCapture(pointerIdRef.current);
        } catch {
          /* pointer may already be released */
        }
      }
      pointerIdRef.current = null;
      captureElRef.current = null;
      setBusy(true);
      setStatusMsg("Checking whether it cleared…");
      setHint(null);
      try {
        const res = await endVisualGestureCapsuleHold(capsuleId);
        // Refresh the selected capsule with the post-recheck server view so the next
        // hold's countdown uses the updated recommended_hold_ms (5s → 10s → 15s) tied
        // to the incremented attempt_count — not the stale local value. Polling is
        // paused during a hold, so without this the countdown would show 5s again.
        setCapsules((prev) =>
          prev.map((c) => (c.capsule_id === capsuleId ? res.data : c)),
        );
        if (res.data.status === "manual_fallback") {
          // Both guided attempts used and the wall is still up — hand off.
          setStatusMsg("Please complete this in the visible browser.");
          setHint(null);
        } else if (res.hold_state === "cleared") {
          setStatusMsg("Cleared — presence confirmed. The agent can resume.");
          setHint(null);
        } else if (res.hold_state === "too_short") {
          // No attempt burned — guide the user to redo the same attempt fully.
          setStatusMsg(
            `That was too short — hold for the full ${Math.round(holdTargetMs(res.data) / 1000)} seconds.`,
          );
          setHint(null);
        } else if (res.hold_state === "still_present") {
          // res.data is post-recheck, so recommended_hold_ms is the longer next rung.
          setStatusMsg(
            `Still present. Try a longer ${Math.round(holdTargetMs(res.data) / 1000)}-second hold.`,
          );
          setHint("The frame may have changed — recapture to see the current view.");
          await loadScreenshot(capsuleId);
        } else if (res.hold_state === "inconclusive") {
          // Couldn't confirm the wall cleared — do NOT claim presence confirmed.
          // res.data is post-recheck, so recommended_hold_ms is the longer next rung.
          setStatusMsg(
            `Couldn't confirm it cleared — try a longer ${Math.round(holdTargetMs(res.data) / 1000)}-second hold.`,
          );
          setHint("The frame may have changed — recapture to see the current view.");
          await loadScreenshot(capsuleId);
        } else {
          setStatusMsg("Could not confirm yet. Hold again or recapture.");
          setHint(null);
        }
      } catch (e) {
        const code = errCode(e);
        // NO_ACTIVE_HOLD: the hold already ended (e.g. an earlier finalize) — leave
        // any prior status message in place rather than overwriting it.
        if (code !== "NO_ACTIVE_HOLD") {
          setStatusMsg("Could not finish the hold. Try again or recapture.");
        }
      } finally {
        setBusy(false);
        endingRef.current = false;
      }
    },
    [loadScreenshot, stopHoldTimers],
  );

  // Heartbeat tick: keep the browser mouse-down alive. A `cleared` /
  // `released_fail_closed` signal ends the hold and runs the recheck.
  const heartbeatTick = useCallback(
    async (capsuleId: string) => {
      if (!holdingRef.current) return;
      try {
        const res = await sendVisualGestureCapsuleHeartbeat(capsuleId);
        if (!holdingRef.current) return;
        if (res.hold_state === "cleared") {
          setStatusMsg("Verification cleared — finishing up…");
          void finalizeHold(capsuleId);
        } else if (res.hold_state === "released_fail_closed") {
          // The browser hold dropped (heartbeat gap or the max-duration ceiling).
          // End and recheck — the wall may still have cleared during the hold.
          void finalizeHold(capsuleId);
        }
      } catch {
        // A transient heartbeat failure shouldn't kill the hold; the next tick
        // retries. Sustained silence is handled server-side (fail-closed release).
      }
    },
    [finalizeHold],
  );

  function handlePressHoldDown(e: React.PointerEvent) {
    if (mode !== "press_hold" || !selected || busy || holdingRef.current || !isActionable(selected.status)) {
      return;
    }
    const pt = pointFromEvent(e.clientX, e.clientY);
    if (!pt) {
      setHint("That point is outside the image. Press inside the screenshot.");
      return;
    }
    if (IS_DEV) setMarkerPoint({ fx: pt.fx, fy: pt.fy });

    const capsuleId = selected.capsule_id;
    const targetMs = holdTargetMs(selected);
    // Capture the pointer so release/leave outside the image still ends the hold.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      pointerIdRef.current = e.pointerId;
      captureElRef.current = e.currentTarget;
    } catch {
      /* capture is best-effort */
    }

    setStatusMsg("Starting hold…");
    setHint(null);
    void (async () => {
      try {
        const res = await startVisualGestureCapsuleHold(capsuleId, { fx: pt.fx, fy: pt.fy });
        if (res.hold_state === "challenge_gone") {
          setStatusMsg("The challenge already cleared. The agent can resume.");
          return;
        }
        // Holding: arm heartbeat + elapsed timer.
        holdingRef.current = true;
        heldCapsuleIdRef.current = capsuleId;
        endingRef.current = false;
        setHolding(true);
        holdStartMsRef.current = Date.now();
        setHoldElapsedMs(0);
        setStatusMsg(null);
        setHint(`Hold for ${Math.round(targetMs / 1000)} seconds.`);
        heartbeatTimerRef.current = setInterval(() => void heartbeatTick(capsuleId), HEARTBEAT_INTERVAL_MS);
        elapsedTimerRef.current = setInterval(
          () => setHoldElapsedMs(Date.now() - holdStartMsRef.current),
          ELAPSED_TICK_MS,
        );
      } catch (err) {
        const code = errCode(err);
        if (code === "MANUAL_FALLBACK") {
          setStatusMsg("Please complete this in the visible browser.");
        } else if (code === "SCREENSHOT_FRAME_UNAVAILABLE") {
          setStatusMsg("The screenshot expired before the hold started. Recapture and try again.");
          setScreenshotMissing(true);
          setScreenshotDataUrl(null);
        } else if (code === "BROWSER_SESSION_UNAVAILABLE") {
          setStatusMsg("No live browser session is available for this request.");
        } else if (code === "FRAME_STALE_RECAPTURE_REQUIRED" || code === "VIEWPORT_DRIFTED") {
          setStatusMsg("Frame changed — recapture and try again.");
          setHint("The page moved since this view was captured. Recapture to see the current layout.");
        } else if (code === "INVALID_COORDINATES") {
          setStatusMsg("That press point was rejected. Try pressing inside the highlighted area.");
        } else {
          setStatusMsg("Could not start the hold. Try again or recapture.");
        }
      }
    })();
  }

  function handlePressHoldEnd() {
    if (mode !== "press_hold" || !holdingRef.current || !selected) return;
    void finalizeHold(selected.capsule_id);
  }

  // Explicitly release any live hold when the selection changes or the page
  // unmounts — the cleanup runs on both. No-op when nothing is being held.
  useEffect(() => {
    return () => {
      bestEffortReleaseHold();
    };
  }, [selectedId, bestEffortReleaseHold]);

  // ── Button actions ──────────────────────────────────────────────────────────
  async function handleRecapture() {
    if (!selected || busy) return;
    setBusy(true);
    setHint(null);
    setMarkerPoint(null);
    setStatusMsg("Recapturing the current view…");
    try {
      await recaptureVisualGestureCapsule(selected.capsule_id);
      await loadScreenshot(selected.capsule_id);
      setStatusMsg("Screenshot refreshed.");
    } catch (e) {
      const code = errCode(e);
      setStatusMsg(
        code === "BROWSER_SESSION_UNAVAILABLE"
          ? "No live browser session is available for this request."
          : "Could not recapture the screenshot.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRecheck() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await runRecheck(selected.capsule_id);
    } catch {
      setStatusMsg("Could not recheck the page. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!selected || busy) return;
    // Tear down the live hold UI loop; the backend cancel releases the browser
    // mouse server-side (cancelVgcHoldSession) — no reliance on fail-closed.
    stopHoldTimers();
    holdingRef.current = false;
    heldCapsuleIdRef.current = null;
    endingRef.current = false;
    setHolding(false);
    setBusy(true);
    setStatusMsg("Cancelling…");
    try {
      await cancelVisualGestureCapsule(selected.capsule_id);
      setStatusMsg("Cancelled.");
      setScreenshotDataUrl(null);
      setMarkerPoint(null);
    } catch {
      setStatusMsg("Could not cancel this request.");
    } finally {
      setBusy(false);
    }
  }

  // Dev-only smoke: create a fake smoke.test capsule + frame and refresh the list,
  // so the list → screenshot render → cancel flow can be exercised without a live
  // wall. Gesture/recheck/recapture stay BROWSER_SESSION_UNAVAILABLE (no session).
  async function handleCreateSmoke() {
    if (busy) return;
    setBusy(true);
    setStatusMsg("Creating smoke request…");
    try {
      const res = await createVisualGestureCapsuleSmoke();
      const list = await listVisualGestureCapsules();
      setDisabled(Boolean(list.disabled));
      setCapsules(list.data);
      setSelectedId(res.data.capsule_id);
      setStatusMsg("Smoke request created.");
    } catch (e) {
      setStatusMsg(
        errCode(e) === "VISUAL_GESTURE_CAPSULE_DISABLED"
          ? "Set ANTIGEN_VISUAL_GESTURE_CAPSULE=true on the API to create a smoke request."
          : "Could not create a smoke request.",
      );
    } finally {
      setBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">User presence required</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-400">
            A site is asking you to confirm you&apos;re human. Antigen captured a redacted view of the
            page — tap or press &amp; hold where the site asks you to confirm, and Antigen will relay
            your action and recheck the page. No passwords, cookies, or browser details are shown or
            stored here.
          </p>
        </div>
        {IS_DEV && (
          <button
            className={`${btnDefault} shrink-0`}
            onClick={handleCreateSmoke}
            disabled={busy}
            title="Dev only — creates a fake smoke.test request to render the panel"
          >
            Create smoke request
          </button>
        )}
      </div>

      {loadError && (
        <div className="mb-4 rounded-md border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {loadError}
        </div>
      )}

      {disabled && (
        <div className="mb-4 rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-400">
          The visual gesture capsule feature is not enabled.
        </div>
      )}

      {capsules.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-10 text-center text-sm text-gray-500">
          No user-presence requests.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-[260px_1fr]">
          {/* Capsule list */}
          <div className="flex flex-col gap-2">
            {capsules.map((c) => {
              const active = c.capsule_id === selectedId;
              return (
                <button
                  key={c.capsule_id}
                  onClick={() => setSelectedId(c.capsule_id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "border-indigo-600 bg-indigo-950/40"
                      : "border-gray-800 bg-gray-900 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-gray-100">{c.domain}</span>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                        STATUS_BADGE[c.status] ?? "bg-gray-800 text-gray-400 border-gray-700"
                      }`}
                    >
                      {c.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                    <span>
                      attempt {c.attempt_count}/{c.max_attempts}
                    </span>
                    <span>·</span>
                    <span>{c.screenshot_available ? "frame ready" : "no frame"}</span>
                    <span>·</span>
                    <span>exp {formatExpiry(c.expires_at)}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected capsule detail */}
          {selected && (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-gray-300">
                  <span className="font-medium text-gray-100">{selected.domain}</span>
                  <span className="ml-2 text-gray-500">
                    {selected.supported_gestures.join(" · ")}
                  </span>
                </div>
                <span
                  className={`rounded border px-2 py-0.5 text-xs font-medium ${
                    STATUS_BADGE[selected.status] ?? "bg-gray-800 text-gray-400 border-gray-700"
                  }`}
                >
                  {selected.status.replace(/_/g, " ")}
                </span>
              </div>

              {/* Mode toggle */}
              <div className="mb-3 flex items-center gap-2">
                <button
                  className={mode === "tap" ? btnPrimary : btnDefault}
                  onClick={() => setMode("tap")}
                >
                  Tap mode
                </button>
                <button
                  className={mode === "press_hold" ? btnPrimary : btnDefault}
                  onClick={() => setMode("press_hold")}
                >
                  Press &amp; Hold mode
                </button>
              </div>

              {/* Screenshot + capture overlay */}
              {screenshotDataUrl ? (
                <div className="relative inline-block max-w-full overflow-hidden rounded-md border border-gray-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={imgRef}
                    src={screenshotDataUrl}
                    alt="Redacted page view awaiting your confirmation"
                    className="block max-w-full select-none"
                    draggable={false}
                  />
                  {/* Transparent capture layer covering the image exactly. */}
                  <div
                    className={`absolute inset-0 ${
                      isActionable(selected.status) && !busy
                        ? mode === "tap"
                          ? "cursor-crosshair"
                          : "cursor-pointer"
                        : "cursor-not-allowed"
                    }`}
                    onClick={handleTapClick}
                    onPointerDown={handlePressHoldDown}
                    onPointerUp={handlePressHoldEnd}
                    onPointerCancel={handlePressHoldEnd}
                    onPointerLeave={handlePressHoldEnd}
                  />
                  {/* Dev-only diagnostic marker at the interpreted point. Positioned
                      by percentage against the container content box (= the image
                      box), so it lands exactly where the gesture was sent. UI-only;
                      never sent to the agent or any endpoint. */}
                  {IS_DEV && markerPoint && (
                    <div
                      className="pointer-events-none absolute z-10"
                      style={{
                        left: `${markerPoint.fx * 100}%`,
                        top: `${markerPoint.fy * 100}%`,
                        transform: "translate(-50%, -50%)",
                      }}
                    >
                      <div className="h-4 w-4 rounded-full border-2 border-fuchsia-400 bg-fuchsia-500/30 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
                      <span className="absolute left-1/2 top-full mt-0.5 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-1 py-0.5 text-[9px] font-medium text-fuchsia-200">
                        interpreted point (dev)
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-gray-700 bg-gray-950 px-4 py-10 text-center">
                  <span className="text-sm text-gray-500">
                    {screenshotMissing ? "Screenshot expired" : "No screenshot available"}
                  </span>
                  <button className={btnDefault} onClick={handleRecapture} disabled={busy}>
                    Recapture
                  </button>
                </div>
              )}

              {/* Live hold timer — guides a fixed-duration attempt: hold to the
                  target, then release on the prompt. The browser mouse is down
                  only while the user physically holds. */}
              {holding &&
                (() => {
                  const targetMs = holdTargetMs(selected);
                  const reached = holdElapsedMs >= targetMs;
                  const remainingS = Math.max(0, Math.ceil((targetMs - holdElapsedMs) / 1000));
                  return (
                    <div
                      className={`mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                        reached
                          ? "border-emerald-700 bg-emerald-950/40 text-emerald-200"
                          : "border-indigo-700 bg-indigo-950/40 text-indigo-200"
                      }`}
                    >
                      <span
                        className={`inline-block h-2 w-2 animate-pulse rounded-full ${
                          reached ? "bg-emerald-400" : "bg-indigo-400"
                        }`}
                      />
                      <span>
                        {reached
                          ? "Release now — checking…"
                          : `Hold for ${Math.round(targetMs / 1000)} seconds — ${remainingS}s left.`}
                      </span>
                    </div>
                  );
                })()}

              {/* Status + hint */}
              {statusMsg && <div className="mt-3 text-sm text-gray-300">{statusMsg}</div>}
              {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
              {!isActionable(selected.status) &&
                selected.status !== "cleared" &&
                selected.status !== "manual_fallback" && (
                  <div className="mt-1 text-xs text-gray-500">
                    This request is {selected.status.replace(/_/g, " ")} — gestures are paused.
                  </div>
                )}

              {/* Actions */}
              <div className="mt-4 flex flex-wrap gap-2">
                <button className={btnDefault} onClick={handleRecapture} disabled={busy}>
                  Recapture
                </button>
                <button className={btnDefault} onClick={handleRecheck} disabled={busy}>
                  Recheck
                </button>
                <button className={btnDanger} onClick={handleCancel} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
