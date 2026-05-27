import type { PointerTrace, PointerTracePoint, TracePurpose, ExportShape } from "./types";

export function generateTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function computeTotalDistance(points: PointerTracePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return Math.round(total);
}

export function computeDirection(
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  return Math.atan2(end.y - start.y, end.x - start.x);
}

export function buildTrace(
  points: PointerTracePoint[],
  purpose: TracePurpose,
  targetEl: Element | null,
  viewport: { width: number; height: number }
): PointerTrace {
  const start = points.length > 0
    ? { x: points[0].x, y: points[0].y }
    : { x: 0, y: 0 };
  const end = points.length > 0
    ? { x: points[points.length - 1].x, y: points[points.length - 1].y }
    : { x: 0, y: 0 };
  const duration_ms = points.length > 0
    ? points[points.length - 1].t_ms - points[0].t_ms
    : 0;

  let target_box: PointerTrace["target_box"] | undefined;
  if (targetEl) {
    const r = targetEl.getBoundingClientRect();
    target_box = { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  return {
    trace_id: generateTraceId(),
    purpose,
    start,
    end,
    target_box,
    viewport,
    duration_ms: Math.round(duration_ms),
    distance_px: computeTotalDistance(points),
    direction_rad: computeDirection(start, end),
    points,
  };
}

export function buildExportShape(
  traces: PointerTrace[],
  viewport: { width: number; height: number }
): ExportShape {
  return {
    profile_id: `local_dev_${Date.now()}`,
    created_at: new Date().toISOString(),
    viewport,
    traces,
  };
}
