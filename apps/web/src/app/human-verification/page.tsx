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
  type VisualGestureCapsuleView,
  type VisualGestureKind,
} from "@/lib/api";
import { normalizePointInRect } from "@/lib/normalizePoint";

const POLL_MS = 2500;
const PRESS_HOLD_MIN_MS = 300;
const PRESS_HOLD_MAX_MS = 30000;

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
  const pressStartRef = useRef<{ t: number; fx: number; fy: number } | null>(null);

  const selected = capsules.find((c) => c.capsule_id === selectedId) ?? null;

  // ── Poll active capsules ────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    async function poll() {
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
    void sendGesture(selected.capsule_id, "tap", pt.fx, pt.fy);
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (mode !== "press_hold" || !selected || busy || !isActionable(selected.status)) return;
    const pt = pointFromEvent(e.clientX, e.clientY);
    if (!pt) {
      setHint("That point is outside the image. Press inside the screenshot.");
      pressStartRef.current = null;
      return;
    }
    pressStartRef.current = { t: Date.now(), fx: pt.fx, fy: pt.fy };
    setHint("Holding… release to send.");
  }

  function handlePointerUp() {
    if (mode !== "press_hold" || !selected) return;
    const start = pressStartRef.current;
    pressStartRef.current = null;
    if (!start) return;
    const raw = Date.now() - start.t;
    if (raw < PRESS_HOLD_MIN_MS) {
      setHint(`Hold a little longer (at least ${PRESS_HOLD_MIN_MS}ms).`);
      return;
    }
    const durationMs = Math.min(raw, PRESS_HOLD_MAX_MS);
    void sendGesture(selected.capsule_id, "press_hold", start.fx, start.fy, durationMs);
  }

  // ── Button actions ──────────────────────────────────────────────────────────
  async function handleRecapture() {
    if (!selected || busy) return;
    setBusy(true);
    setHint(null);
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
    setBusy(true);
    setStatusMsg("Cancelling…");
    try {
      await cancelVisualGestureCapsule(selected.capsule_id);
      setStatusMsg("Cancelled.");
      setScreenshotDataUrl(null);
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
                    onPointerDown={handlePointerDown}
                    onPointerUp={handlePointerUp}
                    onPointerLeave={() => {
                      pressStartRef.current = null;
                    }}
                  />
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
