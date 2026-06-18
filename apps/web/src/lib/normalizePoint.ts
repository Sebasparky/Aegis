// Pure coordinate helper for the internal Visual Gesture Capsule panel.
//
// Maps a pointer event's viewport coordinates to the normalized [0,1] image-space
// fraction the backend gesture relay expects. The backend maps fx/fy back to the
// capsule's captured CSS viewport, so the UI must send fractions relative to the
// RENDERED image content box (its getBoundingClientRect), never CSS pixels.
//
// Kept dependency-free and side-effect-free so it is trivially reviewable; there
// is no frontend test harness in this app, so correctness rests on inspection.

export interface PointRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormalizedPoint {
  fx: number;
  fy: number;
}

/**
 * Normalize a client (viewport) point to [0,1] fractions within `rect`.
 *
 * Returns `null` (caller should reject the gesture) when:
 *  - the rect has no positive area (image not laid out yet), or
 *  - the point falls outside the rect, i.e. fx or fy is outside [0,1].
 *
 * The rect center maps to `{ fx: 0.5, fy: 0.5 }`.
 */
export function normalizePointInRect(
  clientX: number,
  clientY: number,
  rect: PointRect,
): NormalizedPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return { fx, fy };
}
