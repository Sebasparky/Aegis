"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  generatePointerPath,
  type PointerTrace,
  type PointerInteractionMode,
  type TracePurpose,
  type TimedPoint,
  MODE_TIMING,
} from "./pointerMath";
import { SAMPLE_TRACES } from "./sampleTraces";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode = "bezier" | "template" | "compare";
type TemplateSource = "synthetic" | "paste" | "calibration_lab";

interface Target {
  id: "A" | "B" | "C";
  label: string;
  kind: "button_large" | "input" | "button_small";
  cx: number;
  cy: number;
  width: number;
  height: number;
  purpose: TracePurpose;
}

interface PathResult {
  path: TimedPoint[];
  algorithm: "template" | "bezier";
  totalMs: number;
  distance: number;
}

// ─── Canvas targets ───────────────────────────────────────────────────────────

const CANVAS_W = 700;
const CANVAS_H = 450;

const TARGETS: Target[] = [
  {
    id: "A",
    label: "Submit",
    kind: "button_large",
    cx: 200,
    cy: 150,
    width: 120,
    height: 48,
    purpose: "button_click",
  },
  {
    id: "B",
    label: "Email address",
    kind: "input",
    cx: 380,
    cy: 280,
    width: 170,
    height: 36,
    purpose: "input_focus",
  },
  {
    id: "C",
    label: "Save",
    kind: "button_small",
    cx: 560,
    cy: 380,
    width: 60,
    height: 28,
    purpose: "button_click",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTraceInput(raw: string): PointerTrace[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PointerTrace[];
    if (parsed && Array.isArray((parsed as { traces?: unknown }).traces)) {
      return (parsed as { traces: PointerTrace[] }).traces;
    }
    return null;
  } catch {
    return null;
  }
}

function loadCalibrationLabTraces(): PointerTrace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem("aegis_dev_pcl_draft");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PointerTrace[]) : [];
  } catch {
    return [];
  }
}

function pathTotalMs(path: TimedPoint[]): number {
  return path.reduce((sum, p) => sum + p.delay_ms, 0);
}

function pathDistance(path: TimedPoint[]): number {
  if (path.length < 2) return 0;
  const dx = path[path.length - 1].x - path[0].x;
  const dy = path[path.length - 1].y - path[0].y;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

function interpolatePath(path: TimedPoint[], elapsed: number): { x: number; y: number } {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return { x: path[0].x, y: path[0].y };

  let accumulated = 0;
  for (let i = 1; i < path.length; i++) {
    const segDur = path[i].delay_ms;
    if (elapsed <= accumulated + segDur || i === path.length - 1) {
      const t = segDur > 0 ? Math.min((elapsed - accumulated) / segDur, 1) : 1;
      return {
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
      };
    }
    accumulated += segDur;
  }
  return { x: path[path.length - 1].x, y: path[path.length - 1].y };
}

function pointsToPolyline(pts: TimedPoint[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(" ");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TargetElement({
  target,
  selected,
  onClick,
}: {
  target: Target;
  selected: boolean;
  onClick: () => void;
}) {
  const x = target.cx - target.width / 2;
  const y = target.cy - target.height / 2;

  if (target.kind === "input") {
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={target.width}
          height={target.height}
          rx={4}
          fill="#1f2937"
          stroke={selected ? "#6366f1" : "#374151"}
          strokeWidth={selected ? 2 : 1}
          style={{ cursor: "pointer" }}
          onClick={onClick}
        />
        <text
          x={x + 8}
          y={target.cy + 5}
          fontSize={11}
          fill="#6b7280"
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {target.label}
        </text>
        {selected && (
          <rect
            x={x + target.width - 2}
            y={y + 6}
            width={2}
            height={target.height - 12}
            fill="#6366f1"
            opacity={0.9}
          />
        )}
      </g>
    );
  }

  const isSmall = target.kind === "button_small";

  return (
    <g style={{ cursor: "pointer" }} onClick={onClick}>
      <rect
        x={x}
        y={y}
        width={target.width}
        height={target.height}
        rx={isSmall ? 4 : 6}
        fill={selected ? "#4338ca" : "#1e3a5f"}
        stroke={selected ? "#6366f1" : "#2563eb"}
        strokeWidth={selected ? 2 : 1}
      />
      <text
        x={target.cx}
        y={target.cy + 4}
        fontSize={isSmall ? 10 : 12}
        fill="#e5e7eb"
        textAnchor="middle"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {target.label}
      </text>
    </g>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PointerDemoPage() {
  const [startPt, setStartPt] = useState({ x: 80, y: 80 });
  const [trackMouse, setTrackMouse] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<"A" | "B" | "C">("A");
  const [viewMode, setViewMode] = useState<ViewMode>("compare");
  const [timingMode, setTimingMode] = useState<PointerInteractionMode>("native");
  const [templateSource, setTemplateSource] = useState<TemplateSource>("synthetic");
  const [pasteJSON, setPasteJSON] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [calLabCount, setCalLabCount] = useState(0);

  const [bezierResult, setBezierResult] = useState<PathResult | null>(null);
  const [templateResult, setTemplateResult] = useState<PathResult | null>(null);

  const [animating, setAnimating] = useState(false);
  const [animElapsed, setAnimElapsed] = useState(0);

  const canvasRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const animStartRef = useRef<number | null>(null);

  // ── Template trace resolution ────────────────────────────────────────────
  const resolvedTraces = useCallback((): PointerTrace[] => {
    if (templateSource === "synthetic") return SAMPLE_TRACES;
    if (templateSource === "calibration_lab") return loadCalibrationLabTraces();
    if (templateSource === "paste") {
      if (!pasteJSON.trim()) return [];
      return parseTraceInput(pasteJSON) ?? [];
    }
    return [];
  }, [templateSource, pasteJSON]);

  useEffect(() => {
    const count = loadCalibrationLabTraces().length;
    setCalLabCount(count);
  }, []);

  // ── Path generation ──────────────────────────────────────────────────────
  const generate = useCallback(() => {
    const target = TARGETS.find((t) => t.id === selectedTarget)!;
    const end = { x: target.cx, y: target.cy };
    const traces = resolvedTraces();

    const bezier = generatePointerPath(startPt, end, {
      mode: timingMode,
      purpose: target.purpose,
    });

    const template = generatePointerPath(startPt, end, {
      mode: timingMode,
      purpose: target.purpose,
      templateTraces: traces,
    });

    setBezierResult({
      path: bezier.path,
      algorithm: bezier.algorithm,
      totalMs: pathTotalMs(bezier.path),
      distance: pathDistance(bezier.path),
    });

    setTemplateResult({
      path: template.path,
      algorithm: template.algorithm,
      totalMs: pathTotalMs(template.path),
      distance: pathDistance(template.path),
    });

    setAnimElapsed(0);
    setAnimating(false);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, [startPt, selectedTarget, timingMode, resolvedTraces]);

  // Auto-generate on mount and on changes
  useEffect(() => {
    generate();
  }, [generate]);

  // ── Animation ────────────────────────────────────────────────────────────
  const activePath =
    viewMode === "bezier" ? bezierResult?.path :
    viewMode === "template" ? templateResult?.path :
    bezierResult?.path; // compare mode animates bézier dot

  const totalDuration = activePath ? pathTotalMs(activePath) : 0;

  const startAnimation = useCallback(() => {
    if (!activePath || activePath.length === 0) return;
    setAnimating(true);
    setAnimElapsed(0);
    animStartRef.current = null;

    const tick = (ts: number) => {
      if (animStartRef.current === null) animStartRef.current = ts;
      const elapsed = ts - animStartRef.current;
      setAnimElapsed(elapsed);
      if (elapsed < totalDuration) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setAnimElapsed(totalDuration);
        setAnimating(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [activePath, totalDuration]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Mouse tracking ───────────────────────────────────────────────────────
  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!trackMouse || animating) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setStartPt({
        x: Math.round(e.clientX - rect.left),
        y: Math.round(e.clientY - rect.top),
      });
    },
    [trackMouse, animating],
  );

  // ── Dot positions ────────────────────────────────────────────────────────
  const bezierDot =
    bezierResult && viewMode !== "template"
      ? interpolatePath(bezierResult.path, animElapsed)
      : null;

  const templateDot =
    templateResult && viewMode !== "bezier"
      ? interpolatePath(templateResult.path, animElapsed)
      : null;

  // ── Paste validation ─────────────────────────────────────────────────────
  const handlePasteChange = (val: string) => {
    setPasteJSON(val);
    if (!val.trim()) {
      setPasteError(null);
      return;
    }
    const result = parseTraceInput(val);
    if (!result) {
      setPasteError("Invalid JSON — expected PointerTrace[] or ExportShape with .traces");
    } else {
      setPasteError(null);
    }
  };

  // ── Computed stats ───────────────────────────────────────────────────────
  const templates = resolvedTraces();
  const showTemplateFallbackWarning =
    templateResult?.algorithm === "bezier" && viewMode !== "bezier";

  const activeResult = viewMode === "bezier" ? bezierResult : templateResult;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "#e5e7eb", margin: 0 }}>
          Pointer Runtime Demo Harness
        </h1>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#6b7280",
            background: "#1f2937",
            border: "1px solid #374151",
            borderRadius: 4,
            padding: "2px 8px",
          }}
        >
          dev only
        </span>
      </div>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 28, marginTop: 4 }}>
        Visual comparison of Bézier fallback and template-driven native paths for delegated interaction.
      </p>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* ── Controls ─────────────────────────────────────────────────── */}
        <div
          style={{
            width: 240,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {/* View mode */}
          <section>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
              Display Mode
            </div>
            {(["bezier", "template", "compare"] as ViewMode[]).map((m) => (
              <label
                key={m}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="viewMode"
                  value={m}
                  checked={viewMode === m}
                  onChange={() => setViewMode(m)}
                  style={{ accentColor: "#6366f1" }}
                />
                <span style={{ fontSize: 13, color: "#d1d5db" }}>
                  {m === "bezier" ? "Bézier only" : m === "template" ? "Template only" : "Compare both"}
                </span>
              </label>
            ))}
          </section>

          {/* Timing mode */}
          <section>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
              Timing Mode
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(["fast", "native", "realistic", "careful"] as PointerInteractionMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setTimingMode(m)}
                  style={{
                    fontSize: 11,
                    padding: "3px 10px",
                    borderRadius: 4,
                    border: "1px solid",
                    borderColor: timingMode === m ? "#6366f1" : "#374151",
                    background: timingMode === m ? "#312e81" : "#111827",
                    color: timingMode === m ? "#c7d2fe" : "#9ca3af",
                    cursor: "pointer",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
              {MODE_TIMING[timingMode].point_count} pts · {MODE_TIMING[timingMode].total_move_ms}ms move
            </div>
          </section>

          {/* Target */}
          <section>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
              Target Element
            </div>
            {TARGETS.map((t) => (
              <label
                key={t.id}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="target"
                  value={t.id}
                  checked={selectedTarget === t.id}
                  onChange={() => setSelectedTarget(t.id)}
                  style={{ accentColor: "#6366f1" }}
                />
                <span style={{ fontSize: 13, color: "#d1d5db" }}>
                  {t.id} — {t.label}
                  <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 4 }}>({t.purpose})</span>
                </span>
              </label>
            ))}
          </section>

          {/* Template source */}
          <section>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
              Template Traces
            </div>
            {(["synthetic", "paste", "calibration_lab"] as TemplateSource[]).map((s) => (
              <label
                key={s}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="templateSource"
                  value={s}
                  checked={templateSource === s}
                  onChange={() => setTemplateSource(s)}
                  style={{ accentColor: "#6366f1" }}
                />
                <span style={{ fontSize: 13, color: "#d1d5db" }}>
                  {s === "synthetic"
                    ? `Synthetic (${SAMPLE_TRACES.length})`
                    : s === "calibration_lab"
                    ? `Calibration Lab${calLabCount > 0 ? ` (${calLabCount})` : " — none"}`
                    : "Paste JSON"}
                </span>
              </label>
            ))}

            {templateSource === "paste" && (
              <div style={{ marginTop: 8 }}>
                <textarea
                  value={pasteJSON}
                  onChange={(e) => handlePasteChange(e.target.value)}
                  placeholder={"Paste PointerTrace[] or ExportShape JSON"}
                  rows={5}
                  style={{
                    width: "100%",
                    fontSize: 11,
                    fontFamily: "monospace",
                    background: "#0d1117",
                    border: `1px solid ${pasteError ? "#ef4444" : "#374151"}`,
                    borderRadius: 4,
                    color: "#d1d5db",
                    padding: "6px 8px",
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
                {pasteError && (
                  <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>{pasteError}</div>
                )}
                {!pasteError && pasteJSON && (
                  <div style={{ fontSize: 11, color: "#10b981", marginTop: 4 }}>
                    {templates.length} trace{templates.length !== 1 ? "s" : ""} loaded
                  </div>
                )}
              </div>
            )}

            {templateSource === "calibration_lab" && calLabCount === 0 && (
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
                No calibration data found. Run{" "}
                <a href="/dev/pointer-calibration" style={{ color: "#6366f1" }}>
                  /dev/pointer-calibration
                </a>{" "}
                first.
              </div>
            )}
          </section>

          {/* Start point */}
          <section>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
              Start Point
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={trackMouse}
                onChange={(e) => setTrackMouse(e.target.checked)}
                style={{ accentColor: "#6366f1" }}
              />
              <span style={{ fontSize: 13, color: "#d1d5db" }}>Track mouse</span>
            </label>
            <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "monospace" }}>
              ({startPt.x}, {startPt.y})
            </div>
          </section>

          {/* Stats */}
          {activeResult && (
            <section>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
                Path Stats
              </div>
              {viewMode === "compare" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12 }}>
                    <span style={{ color: "#818cf8" }}>Bézier</span>
                    <span style={{ color: "#6b7280" }}>
                      {" "}· {bezierResult?.path.length ?? 0} pts · {bezierResult?.totalMs ?? 0}ms · {bezierResult?.distance ?? 0}px
                    </span>
                  </div>
                  <div style={{ fontSize: 12 }}>
                    <span style={{ color: "#34d399" }}>Template</span>
                    <span style={{ color: "#6b7280" }}>
                      {" "}· {templateResult?.path.length ?? 0} pts · {templateResult?.totalMs ?? 0}ms · {templateResult?.distance ?? 0}px
                    </span>
                    {templateResult?.algorithm === "bezier" && (
                      <span style={{ color: "#f59e0b", fontSize: 11 }}> (fallback)</span>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <Stat label="Points" value={activeResult.path.length} />
                  <Stat label="Move ms" value={activeResult.totalMs} />
                  <Stat label="Distance" value={`${activeResult.distance}px`} />
                  <Stat
                    label="Algorithm"
                    value={activeResult.algorithm}
                    highlight={activeResult.algorithm === "template" ? "#10b981" : "#818cf8"}
                  />
                </div>
              )}
            </section>
          )}

          {/* Fallback warning */}
          {showTemplateFallbackWarning && (
            <div
              style={{
                fontSize: 11,
                color: "#f59e0b",
                background: "#451a03",
                border: "1px solid #78350f",
                borderRadius: 6,
                padding: "8px 10px",
              }}
            >
              No matching template found — showing Bézier fallback. Try a different purpose or load more traces.
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              onClick={generate}
              disabled={animating}
              style={btnStyle(false, animating)}
            >
              Regenerate paths
            </button>
            <button
              onClick={startAnimation}
              disabled={animating || !activePath}
              style={btnStyle(true, animating || !activePath)}
            >
              {animating ? "Animating…" : "Animate"}
            </button>
          </div>
        </div>

        {/* ── Canvas ───────────────────────────────────────────────────── */}
        <div style={{ flex: 1 }}>
          <div
            ref={canvasRef}
            onMouseMove={handleCanvasMouseMove}
            style={{
              position: "relative",
              width: CANVAS_W,
              height: CANVAS_H,
              background: "#0d1117",
              border: "1px solid #1f2937",
              borderRadius: 8,
              overflow: "hidden",
              cursor: trackMouse ? "crosshair" : "default",
            }}
          >
            <svg
              width={CANVAS_W}
              height={CANVAS_H}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              {/* Grid */}
              <defs>
                <pattern id="grid" width={40} height={40} patternUnits="userSpaceOnUse">
                  <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1f2937" strokeWidth={0.5} />
                </pattern>
              </defs>
              <rect width={CANVAS_W} height={CANVAS_H} fill="url(#grid)" />

              {/* Bézier path */}
              {bezierResult && viewMode !== "template" && (
                <>
                  <polyline
                    points={pointsToPolyline(bezierResult.path)}
                    fill="none"
                    stroke="#6366f1"
                    strokeWidth={1.5}
                    strokeOpacity={0.55}
                    strokeDasharray={viewMode === "compare" ? "4 3" : undefined}
                  />
                  {bezierResult.path.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r={2}
                      fill="#6366f1"
                      opacity={0.5}
                    />
                  ))}
                </>
              )}

              {/* Template path */}
              {templateResult && viewMode !== "bezier" && (
                <>
                  <polyline
                    points={pointsToPolyline(templateResult.path)}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth={1.5}
                    strokeOpacity={0.55}
                  />
                  {templateResult.path.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r={2}
                      fill="#10b981"
                      opacity={0.5}
                    />
                  ))}
                </>
              )}

              {/* Targets */}
              {TARGETS.map((t) => (
                <TargetElement
                  key={t.id}
                  target={t}
                  selected={selectedTarget === t.id}
                  onClick={() => setSelectedTarget(t.id)}
                />
              ))}

              {/* Target labels */}
              {TARGETS.map((t) => (
                <text
                  key={`lbl-${t.id}`}
                  x={t.cx - t.width / 2}
                  y={t.cy - t.height / 2 - 4}
                  fontSize={9}
                  fill="#4b5563"
                  style={{ userSelect: "none" }}
                >
                  Target {t.id}
                </text>
              ))}

              {/* Start marker */}
              <circle cx={startPt.x} cy={startPt.y} r={10} fill="#1f2937" stroke="#374151" strokeWidth={1} />
              <circle cx={startPt.x} cy={startPt.y} r={3} fill="#9ca3af" />
              <text
                x={startPt.x + 14}
                y={startPt.y + 4}
                fontSize={10}
                fill="#6b7280"
                style={{ userSelect: "none" }}
              >
                start
              </text>

              {/* Bézier animated dot */}
              {bezierDot && viewMode !== "template" && (
                <circle
                  cx={bezierDot.x}
                  cy={bezierDot.y}
                  r={6}
                  fill="#818cf8"
                  style={{ filter: "drop-shadow(0 0 4px #6366f1)" }}
                />
              )}

              {/* Template animated dot */}
              {templateDot && viewMode !== "bezier" && (
                <circle
                  cx={templateDot.x}
                  cy={templateDot.y}
                  r={6}
                  fill="#34d399"
                  style={{ filter: "drop-shadow(0 0 4px #10b981)" }}
                />
              )}
            </svg>
          </div>

          {/* Legend */}
          <div style={{ display: "flex", gap: 20, marginTop: 10, paddingLeft: 4 }}>
            {viewMode !== "template" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <svg width={24} height={4}>
                  <line x1={0} y1={2} x2={24} y2={2} stroke="#6366f1" strokeWidth={2} strokeDasharray="4 3" />
                </svg>
                <span style={{ fontSize: 11, color: "#818cf8" }}>Bézier path</span>
              </div>
            )}
            {viewMode !== "bezier" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <svg width={24} height={4}>
                  <line x1={0} y1={2} x2={24} y2={2} stroke="#10b981" strokeWidth={2} />
                </svg>
                <span style={{ fontSize: 11, color: "#34d399" }}>
                  Template path
                  {templateResult?.algorithm === "bezier" && (
                    <span style={{ color: "#f59e0b" }}> (fallback)</span>
                  )}
                </span>
              </div>
            )}
            <div style={{ fontSize: 11, color: "#4b5563", marginLeft: "auto" }}>
              Click a target to select it · Toggle "Track mouse" to move start point
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ color: highlight ?? "#d1d5db", fontFamily: "monospace" }}>{value}</span>
    </div>
  );
}

function btnStyle(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: 6,
    border: "1px solid",
    borderColor: disabled ? "#374151" : primary ? "#4338ca" : "#374151",
    background: disabled
      ? "#111827"
      : primary
      ? "#312e81"
      : "#1f2937",
    color: disabled ? "#4b5563" : primary ? "#c7d2fe" : "#d1d5db",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
  };
}
