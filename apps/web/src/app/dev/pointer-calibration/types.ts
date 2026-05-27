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

export interface ExportShape {
  profile_id: string;
  created_at: string;
  viewport: { width: number; height: number };
  traces: PointerTrace[];
}
