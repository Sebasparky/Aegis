"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { PointerTrace, PointerTracePoint } from "./types";
import { buildTrace, buildExportShape } from "./helpers";
import { CALIBRATION_TASKS } from "./tasks";
import type { CalibrationTask } from "./tasks";

// ── localStorage ────────────────────────────────────────────────────────────
const STORAGE_KEY = "aegis_dev_pcl_draft";

function loadDraft(): PointerTrace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PointerTrace[]) : [];
  } catch {
    return [];
  }
}

function saveDraft(traces: PointerTrace[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(traces));
  } catch {
    // storage quota — silently skip
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Viewport helper ──────────────────────────────────────────────────────────
function getViewport() {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

// ── Task stage components ────────────────────────────────────────────────────

function ClickTarget({
  task,
  onSuccess,
  targetRef,
}: {
  task: CalibrationTask;
  onSuccess: () => void;
  targetRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const w = task.targetSize?.w ?? 100;
  const h = task.targetSize?.h ?? 40;

  if (task.edgePosition === "top_right") {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <button
          ref={targetRef as React.RefObject<HTMLButtonElement>}
          onClick={onSuccess}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: w,
            height: h,
            background: "var(--blue)",
            color: "#fff",
            border: "none",
            borderRadius: "var(--r-1)",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          Click me
        </button>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink-3)",
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          Target is near the top-right corner ↗
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      <button
        ref={targetRef as React.RefObject<HTMLButtonElement>}
        onClick={onSuccess}
        style={{
          width: w,
          height: h,
          background: "var(--blue)",
          color: "#fff",
          border: "none",
          borderRadius: "var(--r-1)",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        Click me
      </button>
    </div>
  );
}

function InputFocusTarget({
  onSuccess,
  targetRef,
}: {
  onSuccess: () => void;
  targetRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      <input
        ref={targetRef as React.RefObject<HTMLInputElement>}
        type="text"
        placeholder="Click here to focus…"
        onFocus={onSuccess}
        readOnly
        style={{
          width: 260,
          height: 44,
          padding: "0 14px",
          fontSize: 14,
          background: "var(--bg-2)",
          border: "2px solid var(--ink-3)",
          borderRadius: "var(--r-1)",
          color: "var(--ink-1)",
          outline: "none",
          cursor: "pointer",
        }}
      />
    </div>
  );
}

function DropdownTarget({
  onSuccess,
  targetRef,
}: {
  onSuccess: () => void;
  targetRef: React.RefObject<HTMLSelectElement | null>;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      <select
        ref={targetRef as React.RefObject<HTMLSelectElement>}
        onClick={onSuccess}
        style={{
          width: 200,
          height: 44,
          padding: "0 12px",
          fontSize: 14,
          background: "var(--bg-2)",
          border: "2px solid var(--ink-3)",
          borderRadius: "var(--r-1)",
          color: "var(--ink-1)",
          cursor: "pointer",
        }}
        defaultValue=""
      >
        <option value="" disabled>Select an option…</option>
        <option value="a">Option A</option>
        <option value="b">Option B</option>
        <option value="c">Option C</option>
      </select>
    </div>
  );
}

function DragTarget({
  sliderTarget,
  onSuccess,
  targetRef,
}: {
  sliderTarget: number;
  onSuccess: () => void;
  targetRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [value, setValue] = useState(0);

  function handlePointerUp() {
    if (value >= sliderTarget - 3) {
      onSuccess();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 20 }}>
      <div style={{ position: "relative", width: 320 }}>
        <input
          ref={targetRef as React.RefObject<HTMLInputElement>}
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          onPointerUp={handlePointerUp}
          style={{ width: "100%", cursor: "grab" }}
        />
        {/* 75% marker */}
        <div
          style={{
            position: "absolute",
            left: `${sliderTarget}%`,
            top: -18,
            transform: "translateX(-50%)",
            fontSize: 11,
            color: "var(--green)",
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          ▼ {sliderTarget}%
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
        Current: <strong>{value}%</strong>
        {value >= sliderTarget - 3 && (
          <span style={{ color: "var(--green)", marginLeft: 8 }}>✓ Target reached — release to complete</span>
        )}
      </div>
    </div>
  );
}

function ScrollTarget({
  threshold,
  onSuccess,
  showButton,
  containerRef,
}: {
  threshold: number;
  onSuccess: () => void;
  showButton?: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [buttonClicked, setButtonClicked] = useState(false);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollTop >= threshold;
    if (!scrolled && atBottom) {
      setScrolled(true);
      if (!showButton) onSuccess();
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        onScroll={handleScroll}
        style={{
          width: 360,
          height: 220,
          overflowY: "auto",
          border: "2px solid var(--ink-3)",
          borderRadius: "var(--r-1)",
          background: "var(--bg-2)",
          padding: "16px 20px",
        }}
      >
        {Array.from({ length: 12 }, (_, i) => (
          <div
            key={i}
            style={{
              padding: "10px 0",
              borderBottom: i < 11 ? "1px solid var(--bg-1)" : "none",
              fontSize: 13,
              color: i === 0 ? "var(--ink-2)" : "var(--ink-3)",
            }}
          >
            {i === 0 ? "↓ Scroll down to continue" : `Content row ${i}`}
          </div>
        ))}
        {showButton && (
          <div style={{ marginTop: 24, textAlign: "center" }}>
            {scrolled && !buttonClicked ? (
              <button
                onClick={() => { setButtonClicked(true); onSuccess(); }}
                style={{
                  padding: "10px 28px",
                  background: "var(--green)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                Found it — Click me
              </button>
            ) : !scrolled ? (
              <div style={{ color: "var(--ink-3)", fontSize: 12 }}>Keep scrolling…</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const MOVEMENT_CONFIG: Record<
  string,
  { startLabel: string; endLabel: string; startStyle: React.CSSProperties; endStyle: React.CSSProperties }
> = {
  ltr: {
    startLabel: "START",
    endLabel: "END",
    startStyle: { left: 24, top: "50%", transform: "translateY(-50%)" },
    endStyle: { right: 24, top: "50%", transform: "translateY(-50%)" },
  },
  rtl: {
    startLabel: "START",
    endLabel: "END",
    startStyle: { right: 24, top: "50%", transform: "translateY(-50%)" },
    endStyle: { left: 24, top: "50%", transform: "translateY(-50%)" },
  },
  ttb: {
    startLabel: "START",
    endLabel: "END",
    startStyle: { top: 20, left: "50%", transform: "translateX(-50%)" },
    endStyle: { bottom: 20, left: "50%", transform: "translateX(-50%)" },
  },
  btt: {
    startLabel: "START",
    endLabel: "END",
    startStyle: { bottom: 20, left: "50%", transform: "translateX(-50%)" },
    endStyle: { top: 20, left: "50%", transform: "translateX(-50%)" },
  },
  diag_ur: {
    startLabel: "START",
    endLabel: "END",
    startStyle: { bottom: 20, left: 24 },
    endStyle: { top: 20, right: 24 },
  },
  diag_dl: {
    startLabel: "START",
    endLabel: "END",
    startStyle: { top: 20, right: 24 },
    endStyle: { bottom: 20, left: 24 },
  },
};

function MovementTarget({
  dir,
  onSuccess,
  endZoneRef,
}: {
  dir: string;
  onSuccess: () => void;
  endZoneRef: React.RefObject<HTMLDivElement | null>;
}) {
  const cfg = MOVEMENT_CONFIG[dir] ?? MOVEMENT_CONFIG.ltr;
  const [inEnd, setInEnd] = useState(false);

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const endEl = endZoneRef.current;
    if (!endEl) return;
    const r = endEl.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside && !inEnd) {
      setInEnd(true);
      onSuccess();
    }
  }

  const dotStyle: React.CSSProperties = {
    position: "absolute",
    width: 48,
    height: 48,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
  };

  return (
    <div
      onPointerMove={handlePointerMove}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <div
        style={{
          ...dotStyle,
          ...cfg.startStyle,
          background: "var(--amber)",
          color: "#fff",
        }}
      >
        {cfg.startLabel}
      </div>
      <div
        ref={endZoneRef as React.RefObject<HTMLDivElement>}
        style={{
          ...dotStyle,
          ...cfg.endStyle,
          background: inEnd ? "var(--green)" : "var(--blue)",
          color: "#fff",
          transition: "background 0.15s",
        }}
      >
        {cfg.endLabel}
      </div>
    </div>
  );
}

function CorrectionTarget({
  taskId,
  onSuccess,
  targetRef,
}: {
  taskId: string;
  onSuccess: () => void;
  targetRef: React.RefObject<HTMLButtonElement | null>;
}) {
  // Two variants: truly off-center button inside a bordered box, or off-center among faint guides
  const isOffCenter = taskId === "off_center";

  if (isOffCenter) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <div
          style={{
            position: "relative",
            width: 280,
            height: 140,
            border: "2px dashed var(--ink-3)",
            borderRadius: "var(--r-2)",
            background: "var(--bg-2)",
          }}
        >
          {/* Button is shifted right and down from center */}
          <button
            ref={targetRef as React.RefObject<HTMLButtonElement>}
            onClick={onSuccess}
            style={{
              position: "absolute",
              right: 28,
              bottom: 22,
              padding: "8px 20px",
              background: "var(--blue)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--r-1)",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            Click me
          </button>
          <div
            style={{
              position: "absolute",
              top: 14,
              left: 16,
              fontSize: 11,
              color: "var(--ink-3)",
            }}
          >
            container boundary
          </div>
        </div>
      </div>
    );
  }

  // Correction task: small target slightly off where a natural center-click would land
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      <div style={{ position: "relative", width: 200, height: 120 }}>
        {/* Faint grid lines to create expectation of center */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(var(--bg-1) 1px, transparent 1px), linear-gradient(90deg, var(--bg-1) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
            borderRadius: "var(--r-1)",
          }}
        />
        {/* Actual target is shifted ~30px right and 20px down from visual center */}
        <button
          ref={targetRef as React.RefObject<HTMLButtonElement>}
          onClick={onSuccess}
          style={{
            position: "absolute",
            left: "calc(50% + 30px)",
            top: "calc(50% + 20px)",
            transform: "translate(-50%, -50%)",
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "var(--blue)",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            fontWeight: 700,
            fontSize: 12,
          }}
        >
          ●
        </button>
      </div>
    </div>
  );
}

function VisualSearchTarget({
  onSuccess,
  targetRef,
}: {
  onSuccess: () => void;
  targetRef: React.RefObject<HTMLButtonElement | null>;
}) {
  // Pick a fixed highlighted index at mount
  const highlightedIdx = useRef(Math.floor(Math.random() * 9));

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
          width: 280,
        }}
      >
        {Array.from({ length: 9 }, (_, i) => {
          const isTarget = i === highlightedIdx.current;
          return (
            <button
              key={i}
              ref={isTarget ? (targetRef as React.RefObject<HTMLButtonElement>) : undefined}
              onClick={isTarget ? onSuccess : undefined}
              style={{
                padding: "10px 0",
                fontSize: 13,
                fontWeight: isTarget ? 700 : 400,
                background: isTarget ? "var(--blue)" : "var(--bg-2)",
                color: isTarget ? "#fff" : "var(--ink-2)",
                border: isTarget ? "2px solid var(--blue)" : "2px solid var(--bg-1)",
                borderRadius: "var(--r-1)",
                cursor: isTarget ? "pointer" : "default",
              }}
            >
              {isTarget ? "Click me" : `Item ${i + 1}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Trace summary ────────────────────────────────────────────────────────────
function TraceSummaryCard({ trace }: { trace: PointerTrace }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 24,
        flexWrap: "wrap",
        padding: "14px 20px",
        background: "var(--bg-2)",
        borderRadius: "var(--r-1)",
        border: "1px solid var(--bg-1)",
        fontSize: 13,
      }}
    >
      <Stat label="Duration" value={`${(trace.duration_ms / 1000).toFixed(2)} s`} />
      <Stat label="Distance" value={`${trace.distance_px} px`} />
      <Stat label="Points" value={String(trace.points.length)} />
      <Stat label="Purpose" value={trace.purpose} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.6 }}>
        {label}
      </span>
      <span style={{ fontWeight: 600, color: "var(--ink-1)" }}>{value}</span>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
type AppPhase = "intro" | "running" | "done";
type TaskPhase = "ready" | "recording" | "success";

export default function PointerCalibrationPage() {
  const [appPhase, setAppPhase] = useState<AppPhase>("intro");
  const [taskIndex, setTaskIndex] = useState(0);
  const [taskPhase, setTaskPhase] = useState<TaskPhase>("ready");
  const [completedTraces, setCompletedTraces] = useState<PointerTrace[]>([]);
  const [lastTrace, setLastTrace] = useState<PointerTrace | null>(null);
  const [copyMsg, setCopyMsg] = useState("");

  // High-frequency pointer recording — mutable refs to avoid setState on every pointermove
  const pointsRef = useRef<PointerTracePoint[]>([]);
  const recordingStartRef = useRef<number>(0);
  const isRecordingRef = useRef(false);

  // Target element refs (generic — cast as needed per task)
  const targetRef = useRef<HTMLButtonElement | null>(null);
  const inputTargetRef = useRef<HTMLInputElement | null>(null);
  const selectTargetRef = useRef<HTMLSelectElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const endZoneRef = useRef<HTMLDivElement | null>(null);

  // Task area ref for attaching listeners
  const taskAreaRef = useRef<HTMLDivElement | null>(null);

  const task: CalibrationTask | undefined = CALIBRATION_TASKS[taskIndex];

  // Load draft from localStorage on mount
  useEffect(() => {
    const draft = loadDraft();
    if (draft.length > 0) setCompletedTraces(draft);
  }, []);

  // Attach/detach pointer event listeners when recording starts
  useEffect(() => {
    const area = taskAreaRef.current;
    if (!area || taskPhase !== "recording") return;

    function onMove(e: PointerEvent) {
      if (!isRecordingRef.current) return;
      pointsRef.current.push({
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        t_ms: Math.round(e.timeStamp - recordingStartRef.current),
        event: "move",
      });
    }
    function onDown(e: PointerEvent) {
      if (!isRecordingRef.current) return;
      pointsRef.current.push({
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        t_ms: Math.round(e.timeStamp - recordingStartRef.current),
        event: "down",
      });
    }
    function onUp(e: PointerEvent) {
      if (!isRecordingRef.current) return;
      pointsRef.current.push({
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        t_ms: Math.round(e.timeStamp - recordingStartRef.current),
        event: "up",
      });
    }
    function onWheel(e: WheelEvent) {
      if (!isRecordingRef.current) return;
      const now = performance.now();
      pointsRef.current.push({
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        t_ms: Math.round(now - recordingStartRef.current),
        event: "scroll",
      });
    }

    area.addEventListener("pointermove", onMove);
    area.addEventListener("pointerdown", onDown);
    area.addEventListener("pointerup", onUp);
    area.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      area.removeEventListener("pointermove", onMove);
      area.removeEventListener("pointerdown", onDown);
      area.removeEventListener("pointerup", onUp);
      area.removeEventListener("wheel", onWheel);
    };
  }, [taskPhase]);

  const startRecording = useCallback(() => {
    pointsRef.current = [];
    recordingStartRef.current = performance.now();
    isRecordingRef.current = true;
    setTaskPhase("recording");
  }, []);

  const finishRecording = useCallback(
    (targetEl: Element | null = null) => {
      isRecordingRef.current = false;
      const points = [...pointsRef.current];
      const viewport = getViewport();

      // Add a final click point if last event wasn't already a click
      if (task) {
        const trace = buildTrace(points, task.purpose, targetEl, viewport);
        const next = [...completedTraces, trace];
        setCompletedTraces(next);
        saveDraft(next);
        setLastTrace(trace);
      }
      setTaskPhase("success");
    },
    [task, completedTraces]
  );

  const onTaskSuccess = useCallback(
    (targetEl: Element | null = null) => {
      if (!isRecordingRef.current) return;
      finishRecording(targetEl);
    },
    [finishRecording]
  );

  function handleBegin() {
    startRecording();
  }

  function handleSkip() {
    isRecordingRef.current = false;
    pointsRef.current = [];
    advanceTask();
  }

  function handleRestartTask() {
    isRecordingRef.current = false;
    pointsRef.current = [];
    setTaskPhase("ready");
    setLastTrace(null);
  }

  function advanceTask() {
    setLastTrace(null);
    setTaskPhase("ready");
    const next = taskIndex + 1;
    if (next >= CALIBRATION_TASKS.length) {
      setAppPhase("done");
    } else {
      setTaskIndex(next);
    }
  }

  function handleExport() {
    const viewport = getViewport();
    const exportShape = buildExportShape(completedTraces, viewport);
    const json = JSON.stringify(exportShape, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aegis_pcl_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopy() {
    const viewport = getViewport();
    const exportShape = buildExportShape(completedTraces, viewport);
    const json = JSON.stringify(exportShape, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopyMsg("Copied!");
    } catch {
      setCopyMsg("Copy failed — check clipboard permissions");
    }
    setTimeout(() => setCopyMsg(""), 2500);
  }

  function handleClearData() {
    if (!confirm("Clear all recorded traces from local storage? This cannot be undone.")) return;
    clearDraft();
    setCompletedTraces([]);
    setLastTrace(null);
    setTaskIndex(0);
    setTaskPhase("ready");
    setAppPhase("intro");
  }

  // ── Task stage renderer ──────────────────────────────────────────────────
  function renderTaskStage() {
    if (!task) return null;

    const successCallback = (el: Element | null) => onTaskSuccess(el);

    switch (task.kind) {
      case "click":
        return (
          <ClickTarget
            task={task}
            targetRef={targetRef}
            onSuccess={() => successCallback(targetRef.current)}
          />
        );
      case "input_focus":
        return (
          <InputFocusTarget
            targetRef={inputTargetRef}
            onSuccess={() => successCallback(inputTargetRef.current)}
          />
        );
      case "dropdown":
        return (
          <DropdownTarget
            targetRef={selectTargetRef}
            onSuccess={() => successCallback(selectTargetRef.current)}
          />
        );
      case "drag":
        return (
          <DragTarget
            sliderTarget={task.sliderTarget ?? 75}
            targetRef={sliderRef}
            onSuccess={() => successCallback(sliderRef.current)}
          />
        );
      case "scroll":
        return (
          <ScrollTarget
            threshold={task.scrollThreshold ?? 200}
            onSuccess={() => successCallback(scrollContainerRef.current)}
            containerRef={scrollContainerRef}
          />
        );
      case "scroll_then_click":
        return (
          <ScrollTarget
            threshold={150}
            onSuccess={() => successCallback(scrollContainerRef.current)}
            containerRef={scrollContainerRef}
            showButton
          />
        );
      case "movement":
        return (
          <MovementTarget
            dir={task.movementDir ?? "ltr"}
            onSuccess={() => successCallback(endZoneRef.current)}
            endZoneRef={endZoneRef}
          />
        );
      case "correction":
        return (
          <CorrectionTarget
            taskId={task.id}
            targetRef={targetRef}
            onSuccess={() => successCallback(targetRef.current)}
          />
        );
      case "visual_search":
        return (
          <VisualSearchTarget
            targetRef={targetRef}
            onSuccess={() => successCallback(targetRef.current)}
          />
        );
      default:
        return <div style={{ color: "var(--ink-3)" }}>Unknown task kind</div>;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-1)", padding: "0 0 60px" }}>
      {/* Dev banner */}
      <div
        style={{
          background: "#7c6101",
          color: "#fef9c3",
          padding: "8px 20px",
          fontSize: 12,
          fontWeight: 600,
          textAlign: "center",
          letterSpacing: 0.3,
        }}
      >
        ⚠ DEV ONLY — Pointer Calibration Lab · No data leaves this page · Local storage only
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px" }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            Antigen · Native Delegated Interaction
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-1)", margin: 0 }}>
            Pointer Calibration Lab
          </h1>
          <p style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.5 }}>
            Complete the guided tasks to record labeled pointer movement traces.
            These traces are used to improve native delegated interaction runtime reliability.
          </p>
        </div>

        {/* Progress bar */}
        {appPhase === "running" && (
          <div style={{ marginBottom: 28 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--ink-3)",
                marginBottom: 6,
              }}
            >
              <span>
                Task {taskIndex + 1} of {CALIBRATION_TASKS.length}
              </span>
              <span>{completedTraces.length} trace{completedTraces.length !== 1 ? "s" : ""} recorded</span>
            </div>
            <div
              style={{
                height: 4,
                background: "var(--bg-2)",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${((taskIndex + (taskPhase === "success" ? 1 : 0)) / CALIBRATION_TASKS.length) * 100}%`,
                  background: "var(--blue)",
                  transition: "width 0.3s",
                  borderRadius: 2,
                }}
              />
            </div>
          </div>
        )}

        {/* Intro screen */}
        {appPhase === "intro" && (
          <div
            style={{
              background: "var(--paper)",
              border: "1px solid var(--bg-2)",
              borderRadius: "var(--r-2)",
              padding: 32,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 16 }}>🖱</div>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--ink-1)", marginBottom: 12 }}>
              {completedTraces.length > 0
                ? `Resume — ${completedTraces.length} trace${completedTraces.length !== 1 ? "s" : ""} already recorded`
                : `${CALIBRATION_TASKS.length} guided tasks`}
            </h2>
            <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, maxWidth: 440, margin: "0 auto 24px" }}>
              Each task records your natural pointer movement. Move and click as you normally
              would — no special technique required. Data stays in your browser only.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => { setAppPhase("running"); setTaskIndex(completedTraces.length >= CALIBRATION_TASKS.length ? 0 : taskIndex); }}
                style={{
                  padding: "10px 28px",
                  background: "var(--blue)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                {completedTraces.length > 0 ? "Continue" : "Start calibration"}
              </button>
              {completedTraces.length > 0 && (
                <>
                  <button
                    onClick={handleExport}
                    style={{
                      padding: "10px 20px",
                      background: "var(--bg-2)",
                      color: "var(--ink-1)",
                      border: "1px solid var(--bg-1)",
                      borderRadius: "var(--r-1)",
                      cursor: "pointer",
                      fontWeight: 500,
                      fontSize: 14,
                    }}
                  >
                    Export JSON
                  </button>
                  <button
                    onClick={handleCopy}
                    style={{
                      padding: "10px 20px",
                      background: "var(--bg-2)",
                      color: "var(--ink-1)",
                      border: "1px solid var(--bg-1)",
                      borderRadius: "var(--r-1)",
                      cursor: "pointer",
                      fontWeight: 500,
                      fontSize: 14,
                    }}
                  >
                    {copyMsg || "Copy JSON"}
                  </button>
                  <button
                    onClick={handleClearData}
                    style={{
                      padding: "10px 20px",
                      background: "transparent",
                      color: "var(--red)",
                      border: "1px solid var(--red)",
                      borderRadius: "var(--r-1)",
                      cursor: "pointer",
                      fontWeight: 500,
                      fontSize: 14,
                    }}
                  >
                    Clear local data
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Running — task card */}
        {appPhase === "running" && task && (
          <div
            style={{
              background: "var(--paper)",
              border: "1px solid var(--bg-2)",
              borderRadius: "var(--r-2)",
              overflow: "hidden",
            }}
          >
            {/* Task header */}
            <div
              style={{
                padding: "20px 24px 16px",
                borderBottom: "1px solid var(--bg-2)",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                  marginBottom: 4,
                }}
              >
                Task {taskIndex + 1} · {task.purpose}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink-1)" }}>
                {task.label}
              </div>
              {task.detail && (
                <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4 }}>
                  {task.detail}
                </div>
              )}
            </div>

            {/* Recording indicator */}
            {taskPhase === "recording" && (
              <div
                style={{
                  padding: "8px 24px",
                  background: "#1a1a0a",
                  borderBottom: "1px solid var(--bg-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: "#d4a800",
                  fontWeight: 600,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#d4a800",
                    display: "inline-block",
                    animation: "pcl-pulse 1s ease-in-out infinite",
                  }}
                />
                Recording — complete the task to stop
              </div>
            )}

            {/* Task stage area */}
            <div
              ref={taskAreaRef}
              style={{
                height: 320,
                position: "relative",
                background: "var(--bg-1)",
                userSelect: "none",
                touchAction: "none",
              }}
            >
              {taskPhase !== "success" && renderTaskStage()}
              {taskPhase === "success" && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    gap: 12,
                  }}
                >
                  <div style={{ fontSize: 32 }}>✓</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--green)" }}>
                    Task complete
                  </div>
                </div>
              )}
            </div>

            {/* Controls */}
            <div
              style={{
                padding: "16px 24px",
                borderTop: "1px solid var(--bg-2)",
                display: "flex",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {taskPhase === "ready" && (
                <button
                  onClick={handleBegin}
                  style={{
                    padding: "9px 22px",
                    background: "var(--blue)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "var(--r-1)",
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  Begin recording
                </button>
              )}
              {taskPhase === "success" && (
                <button
                  onClick={advanceTask}
                  style={{
                    padding: "9px 22px",
                    background: "var(--green)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "var(--r-1)",
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  Next task →
                </button>
              )}
              {taskPhase !== "success" && (
                <button
                  onClick={handleSkip}
                  style={{
                    padding: "9px 18px",
                    background: "transparent",
                    color: "var(--ink-2)",
                    border: "1px solid var(--bg-1)",
                    borderRadius: "var(--r-1)",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  Skip
                </button>
              )}
              <button
                onClick={handleRestartTask}
                style={{
                  padding: "9px 18px",
                  background: "transparent",
                  color: "var(--ink-2)",
                  border: "1px solid var(--bg-1)",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Restart task
              </button>
              <div style={{ flex: 1 }} />
              <button
                onClick={handleExport}
                disabled={completedTraces.length === 0}
                style={{
                  padding: "9px 16px",
                  background: "var(--bg-2)",
                  color: completedTraces.length === 0 ? "var(--ink-3)" : "var(--ink-1)",
                  border: "1px solid var(--bg-1)",
                  borderRadius: "var(--r-1)",
                  cursor: completedTraces.length === 0 ? "not-allowed" : "pointer",
                  fontSize: 12,
                }}
              >
                Export JSON
              </button>
              <button
                onClick={handleCopy}
                disabled={completedTraces.length === 0}
                style={{
                  padding: "9px 16px",
                  background: "var(--bg-2)",
                  color: completedTraces.length === 0 ? "var(--ink-3)" : "var(--ink-1)",
                  border: "1px solid var(--bg-1)",
                  borderRadius: "var(--r-1)",
                  cursor: completedTraces.length === 0 ? "not-allowed" : "pointer",
                  fontSize: 12,
                }}
              >
                {copyMsg || "Copy JSON"}
              </button>
            </div>

            {/* Trace summary */}
            {taskPhase === "success" && lastTrace && (
              <div style={{ padding: "0 24px 20px" }}>
                <TraceSummaryCard trace={lastTrace} />
              </div>
            )}
          </div>
        )}

        {/* Done screen */}
        {appPhase === "done" && (
          <div
            style={{
              background: "var(--paper)",
              border: "1px solid var(--bg-2)",
              borderRadius: "var(--r-2)",
              padding: 40,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 16 }}>🎉</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink-1)", marginBottom: 8 }}>
              All tasks complete
            </h2>
            <p style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 28, lineHeight: 1.5 }}>
              {completedTraces.length} trace{completedTraces.length !== 1 ? "s" : ""} recorded and saved locally.
              Export the JSON to use in the native delegated interaction runtime v2.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={handleExport}
                style={{
                  padding: "10px 28px",
                  background: "var(--blue)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                Export JSON
              </button>
              <button
                onClick={handleCopy}
                style={{
                  padding: "10px 20px",
                  background: "var(--bg-2)",
                  color: "var(--ink-1)",
                  border: "1px solid var(--bg-1)",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                  fontWeight: 500,
                  fontSize: 14,
                }}
              >
                {copyMsg || "Copy JSON"}
              </button>
              <button
                onClick={() => { setAppPhase("intro"); }}
                style={{
                  padding: "10px 20px",
                  background: "transparent",
                  color: "var(--ink-2)",
                  border: "1px solid var(--bg-1)",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Back to overview
              </button>
              <button
                onClick={handleClearData}
                style={{
                  padding: "10px 20px",
                  background: "transparent",
                  color: "var(--red)",
                  border: "1px solid var(--red)",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Clear &amp; restart
              </button>
            </div>
          </div>
        )}

        {/* Trace count footer */}
        {completedTraces.length > 0 && (
          <div
            style={{
              marginTop: 20,
              fontSize: 12,
              color: "var(--ink-3)",
              textAlign: "center",
            }}
          >
            {completedTraces.length} trace{completedTraces.length !== 1 ? "s" : ""} in local storage ·{" "}
            <button
              onClick={handleClearData}
              style={{
                background: "none",
                border: "none",
                color: "var(--red)",
                cursor: "pointer",
                fontSize: 12,
                padding: 0,
                textDecoration: "underline",
              }}
            >
              Clear local data
            </button>
          </div>
        )}
      </div>

      {/* Pulse animation for recording dot */}
      <style>{`
        @keyframes pcl-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
