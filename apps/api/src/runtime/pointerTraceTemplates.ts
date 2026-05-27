/**
 * Pointer Trace Template Helpers — Native Pointer Runtime v2
 *
 * Types and helpers for normalizing, scoring, selecting, and transforming
 * recorded pointer traces into runtime movement paths.
 *
 * Agents describe targets semantically. Antigen executes physically.
 * These helpers bridge Track B calibration data (recorded templates) with
 * Track A runtime dispatch, enabling user-calibrated delegated interaction.
 *
 * Track B types (apps/web/src/app/dev/pointer-calibration/types.ts) share the
 * same shape by design. These are intentional API-side copies — no cross-app
 * import. See credentialProviders.ts for the established precedent.
 */

import type { TimedPoint } from "./nativePointerRuntime.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TracePurpose =
  | "button_click"
  | "input_focus"
  | "dropdown"
  | "drag"
  | "scroll"
  | "correction"
  | "long_move";

export interface PointerTracePoint {
  x: number;
  y: number;
  t_ms: number;
  event?: "move" | "down" | "up" | "click" | "scroll";
}

export interface PointerTrace {
  trace_id: string;
  purpose: TracePurpose;
  start: { x: number; y: number };
  end: { x: number; y: number };
  target_box?: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  duration_ms: number;
  distance_px: number;
  direction_rad: number;
  points: PointerTracePoint[];
}

export interface NormalizedPointerTrace {
  trace_id: string;
  purpose: TracePurpose;
  /** x=[0,1] progress along start→end, y=perpendicular deviation/distance, t_ms from 0 */
  points: Array<{ x: number; y: number; t_ms: number }>;
  duration_ms: number;
  original_distance_px: number;
}

export interface PointerTemplateRequest {
  purpose: TracePurpose;
  distance_px: number;
  direction_rad: number;
  target_box?: { x: number; y: number; width: number; height: number };
}

// ─── Internal constants ───────────────────────────────────────────────────────

const MIN_DISTANCE_PX = 5;
const MIN_MOVEMENT_POINTS = 2;
const MIN_USABLE_POINTS = 3;

type DistanceBucket = "short" | "medium" | "long";
const BUCKET_ORDER: Record<DistanceBucket, number> = { short: 0, medium: 1, long: 2 };

function distanceBucket(d: number): DistanceBucket {
  if (d < 100) return "short";
  if (d < 400) return "medium";
  return "long";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns only the movement points from a trace — points with event "move" or
 * no event field set. Excludes down/up/click/scroll events, which are handled
 * separately by clickAtPoint and are not part of the movement arc template.
 */
export function getMovementPoints(trace: PointerTrace): PointerTracePoint[] {
  return trace.points.filter(
    (p) => p.event === "move" || p.event === undefined,
  );
}

/**
 * Normalizes a pointer trace into a coordinate-independent template.
 *
 * Transforms movement points so that:
 * - first point becomes (0, 0), last point becomes (1, 0)
 * - x is progress [0,1] along the start→end vector
 * - y is perpendicular deviation divided by distance
 * - t_ms starts at 0 (relative to first movement point)
 *
 * Returns null for degenerate traces (too few movement points, distance < 5px).
 */
export function normalizePointerTrace(trace: PointerTrace): NormalizedPointerTrace | null {
  const movPts = getMovementPoints(trace);
  if (movPts.length < MIN_MOVEMENT_POINTS) return null;

  const startPt = movPts[0];
  const endPt = movPts[movPts.length - 1];
  const dx = endPt.x - startPt.x;
  const dy = endPt.y - startPt.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  if (d < MIN_DISTANCE_PX) return null;

  const ux = dx / d;
  const uy = dy / d;
  // Left-normal perpendicular unit vector
  const px = -uy;
  const py = ux;
  const t0 = startPt.t_ms;

  const points = movPts.map((p) => ({
    x: ((p.x - startPt.x) * ux + (p.y - startPt.y) * uy) / d,
    y: ((p.x - startPt.x) * px + (p.y - startPt.y) * py) / d,
    t_ms: p.t_ms - t0,
  }));

  return {
    trace_id: trace.trace_id,
    purpose: trace.purpose,
    points,
    duration_ms: endPt.t_ms - t0,
    original_distance_px: d,
  };
}

/**
 * Scales and rotates a normalized trace template onto a runtime start→end vector,
 * producing absolute TimedPoint values ready for CDP dispatch.
 *
 * - First returned point is exactly start with delay_ms = 0
 * - Last returned point is exactly end
 * - delay_ms is the delay from the previous point, never negative
 * - Total timing is rescaled to targetDuration_ms (clamped to [50, 2000] ms)
 */
export function transformNormalizedTemplate(
  template: NormalizedPointerTrace,
  start: { x: number; y: number },
  end: { x: number; y: number },
  opts?: { targetDuration_ms?: number },
): TimedPoint[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  if (d < 1) {
    return [{ x: start.x, y: start.y, delay_ms: 0 }];
  }

  const ux = dx / d;
  const uy = dy / d;
  const px = -uy;
  const py = ux;

  const rawDur = Math.max(template.duration_ms, 1);
  const targetDur = Math.min(Math.max(opts?.targetDuration_ms ?? rawDur, 50), 2000);
  const timeScale = targetDur / rawDur;

  const scaledT = template.points.map((p) => p.t_ms * timeScale);

  const pts: TimedPoint[] = template.points.map((np, i) => ({
    x: np.x * d * ux + np.y * d * px + start.x,
    y: np.x * d * uy + np.y * d * py + start.y,
    delay_ms: i === 0 ? 0 : Math.max(0, Math.round(scaledT[i] - scaledT[i - 1])),
  }));

  // Force exact start/end regardless of floating-point drift
  pts[0] = { x: start.x, y: start.y, delay_ms: 0 };
  pts[pts.length - 1] = { x: end.x, y: end.y, delay_ms: pts[pts.length - 1].delay_ms };

  return pts;
}

/**
 * Scores a pointer trace against a template request.
 * Returns -Infinity for unusable traces (too few movement points, incompatible purpose).
 * Higher scores indicate a better match.
 */
export function scorePointerTrace(
  trace: PointerTrace,
  request: PointerTemplateRequest,
): number {
  const movPts = getMovementPoints(trace);
  if (movPts.length < MIN_USABLE_POINTS) return -Infinity;

  const isClickFocusPurpose = request.purpose === "button_click" || request.purpose === "input_focus";
  const isIncompatiblePurpose = trace.purpose === "scroll" || trace.purpose === "drag";
  if (isClickFocusPurpose && isIncompatiblePurpose) return -Infinity;

  let score = 0;

  if (trace.purpose === request.purpose) score += 100;

  const reqBucket = distanceBucket(request.distance_px);
  const traceBucket = distanceBucket(trace.distance_px);
  if (reqBucket === traceBucket) {
    score += 20;
  } else if (Math.abs(BUCKET_ORDER[reqBucket] - BUCKET_ORDER[traceBucket]) === 1) {
    score += 10;
  }

  // Reward more movement points (up to a ceiling)
  score += Math.min(movPts.length, 15);

  return score;
}

/**
 * Selects the best matching pointer trace template for a given request.
 * Filters out unusable traces, then returns the highest-scoring trace.
 * Tie-breaks deterministically by trace_id (lexicographic ascending).
 * Returns null if no usable trace exists.
 */
export function selectPointerTraceTemplate(
  traces: PointerTrace[],
  request: PointerTemplateRequest,
): PointerTrace | null {
  const scored = traces
    .map((t) => ({ trace: t, score: scorePointerTrace(t, request) }))
    .filter((e) => e.score > -Infinity)
    .sort((a, b) => b.score - a.score || a.trace.trace_id.localeCompare(b.trace.trace_id));

  return scored[0]?.trace ?? null;
}
