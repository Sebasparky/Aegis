"use client";

/**
 * Human Presence Relay — branded press-and-hold control.
 *
 * While the user physically holds this control, the page streams liveness to
 * the backend (hold-start → 300ms heartbeats → hold-end) and Aegis mirrors the
 * live hold into the agent's browser. Releasing — or leaving the control —
 * releases in the browser too; the backend also fail-closes after ~1.2s of
 * heartbeat silence. Nothing is recorded or replayed: the gesture exists only
 * while the user is holding.
 */

import { useEffect, useRef, useState } from "react";

const HEARTBEAT_INTERVAL_MS = 300;

export type HoldPhase = "idle" | "starting" | "holding" | "ending";

export function PressAndHoldButton({
  disabled,
  onHoldStart,
  onHeartbeat,
  onHoldEnd,
  onError,
}: {
  disabled?: boolean;
  /** Dispatches the browser mouse-down. Resolve true when the hold started. */
  onHoldStart: () => Promise<boolean>;
  /** Liveness ping. Resolve "released_fail_closed" when the backend dropped the hold. */
  onHeartbeat: () => Promise<"holding" | "released_fail_closed">;
  /** Releases the browser hold and probes whether the challenge cleared. */
  onHoldEnd: () => Promise<void>;
  onError?: (message: string) => void;
}) {
  const [phase, setPhase] = useState<HoldPhase>("idle");
  const [heldMs, setHeldMs] = useState(0);
  // Refs mirror the live interaction so pointer handlers and async callbacks
  // never act on stale state.
  const pointerDownRef = useRef(false);
  const phaseRef = useRef<HoldPhase>("idle");
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStartedAt = useRef(0);

  function setPhaseBoth(p: HoldPhase) {
    phaseRef.current = p;
    setPhase(p);
  }

  function stopTimers() {
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    heartbeatTimer.current = null;
    if (elapsedTimer.current) clearInterval(elapsedTimer.current);
    elapsedTimer.current = null;
  }

  useEffect(() => () => stopTimers(), []);

  async function endHold() {
    if (phaseRef.current !== "holding" && phaseRef.current !== "starting") return;
    stopTimers();
    setPhaseBoth("ending");
    try {
      await onHoldEnd();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to end the hold.");
    } finally {
      setPhaseBoth("idle");
      setHeldMs(0);
    }
  }

  async function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (disabled || phaseRef.current !== "idle") return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointerDownRef.current = true;
    setPhaseBoth("starting");
    setHeldMs(0);

    let started = false;
    try {
      started = await onHoldStart();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not start the hold.");
    }
    if (!started) {
      pointerDownRef.current = false;
      setPhaseBoth("idle");
      return;
    }
    // Released while the start round-trip was in flight → release immediately.
    if (!pointerDownRef.current) {
      setPhaseBoth("holding"); // endHold() requires an active phase
      void endHold();
      return;
    }

    setPhaseBoth("holding");
    holdStartedAt.current = Date.now();
    elapsedTimer.current = setInterval(() => {
      setHeldMs(Date.now() - holdStartedAt.current);
    }, 100);
    heartbeatTimer.current = setInterval(async () => {
      if (phaseRef.current !== "holding") return;
      try {
        const state = await onHeartbeat();
        if (state === "released_fail_closed") {
          // Backend dropped the hold (silence window). Stop locally.
          stopTimers();
          pointerDownRef.current = false;
          setPhaseBoth("idle");
          setHeldMs(0);
          onError?.("The hold was released for safety (connection gap). Press and hold again.");
        }
      } catch {
        /* transient heartbeat failure — the backend fail-closes on silence */
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function handleRelease() {
    pointerDownRef.current = false;
    void endHold();
  }

  const active = phase === "holding";
  const busy = phase === "starting" || phase === "ending";
  const seconds = (heldMs / 1000).toFixed(1);

  // Indeterminate progress ring: the site decides how long is long enough, so
  // the ring rotates while held instead of pretending to know the target.
  const ringSize = 168;
  const ringStroke = 5;
  const ringRadius = (ringSize - ringStroke) / 2;
  const circumference = 2 * Math.PI * ringRadius;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <div style={{ position: "relative", width: ringSize, height: ringSize }}>
        <svg
          width={ringSize}
          height={ringSize}
          style={{
            position: "absolute",
            inset: 0,
            transform: "rotate(-90deg)",
            animation: active ? "hv-ring-spin 1.4s linear infinite" : undefined,
          }}
          aria-hidden
        >
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={ringRadius}
            fill="none"
            stroke={active ? "var(--blue-ring)" : "var(--hairline)"}
            strokeWidth={ringStroke}
          />
          {active && (
            <circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={ringRadius}
              fill="none"
              stroke="oklch(0.55 0.11 240)"
              strokeWidth={ringStroke}
              strokeLinecap="round"
              strokeDasharray={`${circumference * 0.3} ${circumference * 0.7}`}
            />
          )}
        </svg>
        <button
          type="button"
          disabled={disabled || phase === "ending"}
          onPointerDown={handlePointerDown}
          onPointerUp={handleRelease}
          onPointerCancel={handleRelease}
          onPointerLeave={() => {
            if (pointerDownRef.current) handleRelease();
          }}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            position: "absolute",
            inset: 14,
            borderRadius: "50%",
            border: active ? "1px solid oklch(0.55 0.11 240)" : "1px solid var(--blue-ring)",
            background: active
              ? "radial-gradient(circle at 50% 35%, oklch(0.55 0.11 240), oklch(0.45 0.09 240))"
              : "radial-gradient(circle at 50% 35%, oklch(0.50 0.10 240), oklch(0.42 0.08 240))",
            color: "white",
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "0.02em",
            cursor: disabled ? "not-allowed" : "pointer",
            touchAction: "none",
            userSelect: "none",
            WebkitUserSelect: "none",
            boxShadow: active
              ? "0 0 0 8px oklch(0.62 0.09 240 / 0.18), 0 6px 22px oklch(0.45 0.09 240 / 0.45)"
              : "0 4px 14px oklch(0.45 0.09 240 / 0.30)",
            transform: active ? "scale(0.97)" : "scale(1)",
            transition: "transform 120ms ease, box-shadow 180ms ease",
            opacity: disabled ? 0.55 : 1,
          }}
        >
          {phase === "starting"
            ? "Connecting…"
            : phase === "ending"
              ? "Checking…"
              : active
                ? `Holding ${seconds}s`
                : "Press & hold"}
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: active ? "oklch(0.45 0.09 240)" : "var(--ink-3)", margin: 0, textAlign: "center" }}>
        {active
          ? "Keep holding — Aegis is mirroring your live hold into the browser. Releasing early releases there too."
          : busy
            ? "One moment…"
            : "Press and hold until the site accepts the verification."}
      </p>
      <style>{`@keyframes hv-ring-spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }`}</style>
    </div>
  );
}
