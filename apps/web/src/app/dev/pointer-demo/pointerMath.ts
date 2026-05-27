/**
 * Pointer Math — Browser-safe dev harness copy.
 *
 * This file is a browser-safe copy of the pure math from:
 *   apps/api/src/runtime/nativePointerRuntime.ts  (Track A — Bézier generation)
 *   apps/api/src/runtime/pointerTraceTemplates.ts  (Track B — template selection)
 *
 * apps/api remains the runtime source of truth. This copy exists solely to
 * power the /dev/pointer-demo visual harness without a cross-app import.
 * No CDP, no async runtime functions included here.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TracePurpose =
  | "button_click"
  | "input_focus"
  | "dropdown"
  | "drag"
  | "scroll"
  | "correction"
  | "long_move";

export type PointerInteractionMode = "fast" | "native" | "realistic" | "careful";

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

export interface TimedPoint {
  x: number;
  y: number;
  delay_ms: number;
}

// ─── Mode timing ──────────────────────────────────────────────────────────────

interface ModeTiming {
  point_count: number;
  total_move_ms: number;
  hover_ms: number;
  click_gap_ms: number;
}

export const MODE_TIMING: Record<PointerInteractionMode, ModeTiming> = {
  fast:      { point_count: 5,  total_move_ms: 30,   hover_ms: 15,  click_gap_ms: 10  },
  native:    { point_count: 12, total_move_ms: 120,  hover_ms: 50,  click_gap_ms: 30  },
  realistic: { point_count: 20, total_move_ms: 400,  hover_ms: 150, click_gap_ms: 80  },
  careful:   { point_count: 28, total_move_ms: 750,  hover_ms: 300, click_gap_ms: 150 },
};

// ─── Template helpers (Track B) ───────────────────────────────────────────────

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

export function getMovementPoints(trace: PointerTrace): PointerTracePoint[] {
  return trace.points.filter((p) => p.event === "move" || p.event === undefined);
}

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

  pts[0] = { x: start.x, y: start.y, delay_ms: 0 };
  pts[pts.length - 1] = { x: end.x, y: end.y, delay_ms: pts[pts.length - 1].delay_ms };

  return pts;
}

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

  score += Math.min(movPts.length, 15);
  return score;
}

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

// ─── Path generation (Track A + Track B fallback) ────────────────────────────

export function generatePointerPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  options?: {
    mode?: PointerInteractionMode;
    random?: () => number;
    templateTraces?: PointerTrace[];
    purpose?: TracePurpose;
  },
): { path: TimedPoint[]; algorithm: "template" | "bezier" } {
  const mode = options?.mode ?? "native";
  const rng = options?.random ?? Math.random;
  const timing = MODE_TIMING[mode];
  const n = timing.point_count;

  if (options?.templateTraces && options.templateTraces.length > 0) {
    const dx0 = end.x - start.x;
    const dy0 = end.y - start.y;
    const distance_px = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    const direction_rad = Math.atan2(dy0, dx0);
    const request: PointerTemplateRequest = {
      purpose: options.purpose ?? "button_click",
      distance_px,
      direction_rad,
    };
    const selected = selectPointerTraceTemplate(options.templateTraces, request);
    if (selected) {
      const normalized = normalizePointerTrace(selected);
      if (normalized) {
        return {
          path: transformNormalizedTemplate(normalized, start, end, {
            targetDuration_ms: timing.total_move_ms,
          }),
          algorithm: "template",
        };
      }
    }
  }

  // Bézier fallback
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  let perpX = 0;
  let perpY = 0;
  if (dist > 0) {
    perpX = -dy / dist;
    perpY = dx / dist;
  }

  const biasMagnitude = dist * (0.10 + rng() * 0.10);
  const biasSign = rng() < 0.5 ? 1 : -1;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const cx = midX + perpX * biasMagnitude * biasSign;
  const cy = midY + perpY * biasMagnitude * biasSign;

  const bezier = (t: number): { x: number; y: number } => ({
    x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * cx + t * t * end.x,
    y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * cy + t * t * end.y,
  });

  const n_intervals = n - 1;
  let weightSum = 0;
  const weights: number[] = [];
  for (let i = 0; i < n_intervals; i++) {
    const t_mid = (i + 0.5) / n_intervals;
    const w = Math.sin(t_mid * Math.PI);
    weights.push(w);
    weightSum += w;
  }

  const points: TimedPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const pos = bezier(t);
    const delay_ms = i === 0 ? 0 : Math.round((weights[i - 1] / weightSum) * timing.total_move_ms);
    points.push({ x: pos.x, y: pos.y, delay_ms });
  }

  points[0] = { x: start.x, y: start.y, delay_ms: 0 };
  points[n - 1] = { x: end.x, y: end.y, delay_ms: points[n - 1].delay_ms };

  return { path: points, algorithm: "bezier" };
}
