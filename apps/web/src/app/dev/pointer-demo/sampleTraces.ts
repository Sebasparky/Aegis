/**
 * Synthetic sample pointer traces for the demo harness.
 *
 * These are manually constructed traces that approximate natural movement
 * characteristics — not personal data. They exist only to exercise the
 * template path system in /dev/pointer-demo without requiring a real
 * calibration session.
 *
 * Four traces covering the main template request scenarios:
 *   1. button_click, short distance (~150px), horizontal
 *   2. button_click, medium distance (~280px), diagonal
 *   3. input_focus, medium distance (~200px), downward
 *   4. long_move, long distance (~420px), horizontal
 */

import type { PointerTrace } from "./pointerMath";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Build a synthetic trace with slight sinusoidal perpendicular drift. */
function buildSyntheticTrace(opts: {
  trace_id: string;
  purpose: PointerTrace["purpose"];
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  pointCount: number;
  driftAmplitude: number;
  durationMs: number;
}): PointerTrace {
  const { startX, startY, endX, endY, pointCount, driftAmplitude, durationMs } = opts;

  const dx = endX - startX;
  const dy = endY - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;

  const points: PointerTrace["points"] = [];
  for (let i = 0; i < pointCount; i++) {
    const t = i / (pointCount - 1);
    // sin-envelope drift: peaks around middle of arc
    const drift = Math.sin(t * Math.PI) * driftAmplitude;
    const x = lerp(startX, endX, t) + perpX * drift;
    const y = lerp(startY, endY, t) + perpY * drift;
    // ease-in-out timing: slower at start/end
    const tEased = t * t * (3 - 2 * t);
    const t_ms = Math.round(tEased * durationMs);
    points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, t_ms });
  }

  return {
    trace_id: opts.trace_id,
    purpose: opts.purpose,
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
    viewport: { width: 1280, height: 800 },
    duration_ms: durationMs,
    distance_px: Math.round(dist),
    direction_rad: Math.atan2(dy, dx),
    points,
  };
}

export const SAMPLE_TRACES: PointerTrace[] = [
  // 1. Short horizontal button click (~150px)
  buildSyntheticTrace({
    trace_id: "synthetic_btn_short_h",
    purpose: "button_click",
    startX: 100,
    startY: 200,
    endX: 250,
    endY: 200,
    pointCount: 18,
    driftAmplitude: 8,
    durationMs: 220,
  }),

  // 2. Medium diagonal button click (~280px)
  buildSyntheticTrace({
    trace_id: "synthetic_btn_med_diag",
    purpose: "button_click",
    startX: 80,
    startY: 80,
    endX: 280,
    endY: 230,
    pointCount: 22,
    driftAmplitude: 14,
    durationMs: 310,
  }),

  // 3. Medium downward input focus (~200px)
  buildSyntheticTrace({
    trace_id: "synthetic_input_focus_down",
    purpose: "input_focus",
    startX: 300,
    startY: 100,
    endX: 330,
    endY: 300,
    pointCount: 20,
    driftAmplitude: 10,
    durationMs: 270,
  }),

  // 4. Long horizontal move (~420px)
  buildSyntheticTrace({
    trace_id: "synthetic_long_move_h",
    purpose: "long_move",
    startX: 60,
    startY: 350,
    endX: 480,
    endY: 350,
    pointCount: 30,
    driftAmplitude: 18,
    durationMs: 480,
  }),
];
