/**
 * Native Pointer Runtime v1 — Track A
 *
 * Provides browser-native pointer execution for delegated interactions.
 * Maintains persistent mouse state per session, resolves target bounding
 * boxes to interior points, generates smooth Bézier movement paths, and
 * dispatches CDP Input.dispatchMouseEvent events along those paths.
 *
 * Agents describe targets semantically ("click Continue"). This runtime
 * translates that intent into physical pointer continuity: movement arc,
 * hover pause, and risk-aware timing — without skipping states the browser
 * observes during natural interaction.
 *
 * Track B (Pointer Calibration Lab) supplies recorded PointerTrace templates.
 * generatePointerPath accepts optional templateTraces (v2) that scale a recorded
 * arc into the current coordinate space. Falls back to Bézier when no match exists.
 */

import {
  type PointerTrace,
  type TracePurpose,
  type PointerTemplateRequest,
  normalizePointerTrace,
  selectPointerTraceTemplate,
  transformNormalizedTemplate,
} from "./pointerTraceTemplates.js";

export type PointerInteractionMode = "fast" | "native" | "realistic" | "careful";

export interface PointerRuntimeState {
  browser_session_id?: string;
  current_x: number;
  current_y: number;
  viewport_width: number;
  viewport_height: number;
  last_action_at?: string;
  interaction_mode: PointerInteractionMode;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TimedPoint {
  x: number;
  y: number;
  /** Delay in ms to wait before dispatching this point's mouseMoved event. First point is always 0. */
  delay_ms: number;
}

interface ModeTiming {
  point_count: number;
  total_move_ms: number;
  hover_ms: number;
  click_gap_ms: number;
}

const MODE_TIMING: Record<PointerInteractionMode, ModeTiming> = {
  fast:      { point_count: 5,  total_move_ms: 30,   hover_ms: 15,  click_gap_ms: 10  },
  native:    { point_count: 12, total_move_ms: 120,  hover_ms: 50,  click_gap_ms: 30  },
  realistic: { point_count: 20, total_move_ms: 400,  hover_ms: 150, click_gap_ms: 80  },
  careful:   { point_count: 28, total_move_ms: 750,  hover_ms: 300, click_gap_ms: 150 },
};

// Dev-only pointer debug overlay — controlled by ANTIGEN_POINTER_DEBUG_OVERLAY=true.
// Injects a visible dot into the page to trace native pointer paths during manual verification.
// Never includes secret or profile values in evaluated expressions.
const OVERLAY_DOT_ID = "__aegis_pointer_debug_dot";
const OVERLAY_TRAIL_ID = "__aegis_pointer_debug_trail";

function ensurePointerDebugOverlay(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
): void {
  const expression = `(function(){if(document.getElementById('${OVERLAY_DOT_ID}'))return;var d=document.createElement('div');d.id='${OVERLAY_DOT_ID}';d.style.cssText='position:fixed;width:24px;height:24px;border-radius:50%;background:rgba(255,80,0,0.9);border:2px solid #fff;pointer-events:none;z-index:2147483647;box-shadow:0 0 10px rgba(0,0,0,0.8),0 0 20px rgba(255,80,0,0.5);transform:translate(-50%,-50%);top:0;left:0;';document.body&&document.body.appendChild(d);var t=document.createElement('div');t.id='${OVERLAY_TRAIL_ID}';t.style.cssText='position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;';document.body&&document.body.appendChild(t);})()`;
  sendCdp("Runtime.evaluate", { expression });
}

function updatePointerDebugOverlay(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  x: number,
  y: number,
  eventType: "move" | "pressed" | "released",
): void {
  if (typeof x !== "number" || typeof y !== "number") return;
  const bg = eventType === "pressed" ? "rgba(0,200,0,0.95)" : "rgba(255,80,0,0.9)";
  const scale = eventType === "pressed" ? "1.4" : "1";
  let expression = `(function(){var d=document.getElementById('${OVERLAY_DOT_ID}');if(!d)return;d.style.left='${x}px';d.style.top='${y}px';d.style.background='${bg}';d.style.transform='translate(-50%,-50%) scale(${scale})';`;
  if (eventType === "move") {
    expression += `var t=document.getElementById('${OVERLAY_TRAIL_ID}');if(t){var td=document.createElement('div');td.style.cssText='position:fixed;width:8px;height:8px;border-radius:50%;background:rgba(255,140,0,0.45);pointer-events:none;transform:translate(-50%,-50%);left:${x}px;top:${y}px;';t.appendChild(td);while(t.childNodes.length>15)t.removeChild(t.firstChild);}`;
  }
  if (eventType === "released") {
    expression += `setTimeout(function(){var d2=document.getElementById('${OVERLAY_DOT_ID}');if(d2&&d2.parentNode)d2.parentNode.removeChild(d2);var t2=document.getElementById('${OVERLAY_TRAIL_ID}');if(t2&&t2.parentNode)t2.parentNode.removeChild(t2);},3000);`;
  }
  expression += `})()`;
  sendCdp("Runtime.evaluate", { expression });
}

export function makePointerRuntimeState(overrides?: Partial<PointerRuntimeState>): PointerRuntimeState {
  return {
    current_x: 0,
    current_y: 0,
    viewport_width: 1280,
    viewport_height: 800,
    interaction_mode: "native",
    ...overrides,
  };
}

/**
 * Picks a landing point inside the element box, avoiding both the exact center
 * and the outer edges. The inner zone spans 30%–70% of width and height.
 */
export function pickTargetPoint(
  box: ElementBox,
  options?: { random?: () => number },
): { x: number; y: number } {
  const rng = options?.random ?? Math.random;
  const x = box.x + box.width  * (0.30 + rng() * 0.40);
  const y = box.y + box.height * (0.30 + rng() * 0.40);
  return { x, y };
}

/**
 * Generates a smooth pointer path from start to end using a quadratic Bézier
 * curve with an ease-in-out timing envelope.
 *
 * The control point is offset perpendicular to the straight-line trajectory
 * by 10–20% of the path length, giving the arc a gentle curve. Delays between
 * points follow a sin(t·π) distribution — slow at the edges, faster through
 * the middle — matching natural pointer deceleration.
 *
 * The first point is always start with delay_ms = 0.
 * The last point is always exactly end.
 *
 * v2: accepts optional `templateTraces` and `purpose` in options. When a suitable
 * template is found, the recorded arc is normalized and scaled into the current
 * coordinate space. Falls back to the Bézier path if no match is found.
 */
export function generatePointerPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  options?: {
    mode?: PointerInteractionMode;
    random?: () => number;
    templateTraces?: PointerTrace[];
    purpose?: TracePurpose;
  },
): TimedPoint[] {
  const mode = options?.mode ?? "native";
  const rng = options?.random ?? Math.random;
  const timing = MODE_TIMING[mode];
  const n = timing.point_count;

  // v2 template path: use a recorded trace when suitable templates are provided
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
        return transformNormalizedTemplate(normalized, start, end, {
          targetDuration_ms: timing.total_move_ms,
        });
      }
    }
  }

  // Compute a control point for the quadratic Bézier, displaced perpendicular
  // to the start→end vector by a randomized fraction of the path length.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  let perpX = 0;
  let perpY = 0;
  if (dist > 0) {
    // Perpendicular unit vector (rotate 90°)
    perpX = -dy / dist;
    perpY =  dx / dist;
  }

  const biasMagnitude = dist * (0.10 + rng() * 0.10);
  const biasSign = rng() < 0.5 ? 1 : -1;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const cx = midX + perpX * biasMagnitude * biasSign;
  const cy = midY + perpY * biasMagnitude * biasSign;

  // Bézier position at parameter t ∈ [0, 1]
  const bezier = (t: number): { x: number; y: number } => ({
    x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * cx + t * t * end.x,
    y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * cy + t * t * end.y,
  });

  // Build timing weights using sin(t·π) envelope over n-1 intervals.
  // Interval i spans from point i to point i+1; its midpoint parameter is
  // (i + 0.5) / (n - 1). High sin values → more time spent in that region.
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
    const delay_ms = i === 0
      ? 0
      : Math.round((weights[i - 1] / weightSum) * timing.total_move_ms);

    points.push({ x: pos.x, y: pos.y, delay_ms });
  }

  // Enforce exact start/end values regardless of floating-point drift.
  points[0] = { x: start.x, y: start.y, delay_ms: 0 };
  points[n - 1] = { x: end.x, y: end.y, delay_ms: points[n - 1].delay_ms };

  return points;
}

/**
 * Dispatches a sequence of CDP mouseMoved events along the given path.
 * Waits delay_ms before each event. No mousePressed or mouseReleased events
 * are sent here — use clickAtPoint for the click.
 *
 * sendCdp mirrors the pattern used in secretInjection.ts and profileFieldFill.ts:
 * a synchronous fire of a CDP command with no wait for the response.
 */
export async function dispatchPointerMovePath(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  path: TimedPoint[],
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (const point of path) {
    await sleep(point.delay_ms);
    sendCdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      clickCount: 0,
    });
  }
}

/**
 * Dispatches a mousePressed + mouseReleased pair at the given point.
 * A brief hover pause before the press and a gap between press and release
 * vary by interaction mode, reflecting the risk profile of the action.
 */
export async function clickAtPoint(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  point: { x: number; y: number },
  mode: PointerInteractionMode,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const timing = MODE_TIMING[mode];
  await sleep(timing.hover_ms);
  sendCdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(timing.click_gap_ms);
  sendCdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

/**
 * High-level helper: picks a target point inside box, generates a path from
 * the current pointer position, dispatches the movement, and returns the
 * point reached. Does not mutate state — caller updates state after.
 */
export async function movePointerToBox(
  state: PointerRuntimeState,
  box: ElementBox,
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  sleep: (ms: number) => Promise<void>,
  options?: { random?: () => number; mode?: PointerInteractionMode; debugLabel?: string },
): Promise<{ x: number; y: number }> {
  const mode = options?.mode ?? state.interaction_mode;
  const target = pickTargetPoint(box, { random: options?.random });
  const path = generatePointerPath(
    { x: state.current_x, y: state.current_y },
    target,
    { mode, random: options?.random },
  );
  if (
    options?.debugLabel &&
    (process.env.ANTIGEN_CDP_DIAGNOSTICS === "true" || process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true")
  ) {
    console.log("[PointerFocus] dispatch start", {
      path: options.debugLabel,
      mode,
      point_count: path.length,
    });
  }
  await dispatchPointerMovePath(sendCdp, path, sleep);
  return target;
}

/**
 * High-level helper: moves the pointer to an interior point of the target box,
 * clicks, and updates the state to reflect the new pointer position.
 *
 * When options.debugOverlay is true (ANTIGEN_POINTER_DEBUG_OVERLAY=true), injects a
 * visible dot into the page that tracks the pointer path for manual verification.
 * The overlay uses fire-and-forget Runtime.evaluate — if injection fails, the fill
 * proceeds normally. No secret or profile values appear in overlay expressions.
 */
export async function clickBoxWithPointer(
  state: PointerRuntimeState,
  box: ElementBox,
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  sleep: (ms: number) => Promise<void>,
  options?: { random?: () => number; mode?: PointerInteractionMode; debugOverlay?: boolean; debugLabel?: string },
): Promise<void> {
  let effectiveSendCdp = sendCdp;
  if (options?.debugOverlay) {
    console.log("[PointerDebugOverlay] enabled");
    ensurePointerDebugOverlay(sendCdp);
    effectiveSendCdp = (method, params) => {
      if (method === "Input.dispatchMouseEvent") {
        const { type, x, y } = params as { type: string; x?: number; y?: number };
        if (typeof x === "number" && typeof y === "number") {
          const evType = type === "mousePressed" ? "pressed" : type === "mouseReleased" ? "released" : "move";
          console.log(`[PointerDebugOverlay] update x=${Math.round(x)} y=${Math.round(y)} type=${evType}`);
          updatePointerDebugOverlay(sendCdp, x, y, evType);
        }
      }
      sendCdp(method, params);
    };
  }
  const mode = options?.mode ?? state.interaction_mode;
  const target = await movePointerToBox(state, box, effectiveSendCdp, sleep, options);
  await clickAtPoint(effectiveSendCdp, target, mode, sleep);
  state.current_x = target.x;
  state.current_y = target.y;
  state.last_action_at = new Date().toISOString();
}
