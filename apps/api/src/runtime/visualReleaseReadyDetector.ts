// ─── Release-Ready Visual Progress Detector (press-and-hold HV) ───────────────
//
// A best-effort pixel estimator for a press-and-hold progress affordance inside an
// already-cropped, already-redacted challenge-card screenshot. It answers ONE
// question: "does the visible progress affordance read full?" so the live handoff
// status can switch from "Keep holding…" to "Release now" while the wall is up.
//
// Two affordance shapes are recognized, generically (no site/text/domain hardcode):
//   1. HORIZONTAL BAR  — a wide+thin two-level bar (left fill, right track).
//   2. BUTTON / RING    — a compact, roughly-square button whose progress reads as a
//                         radial arc (full ring, partial halo, or pressed border).
// The bar path is tried first and is byte-for-byte unchanged; the button/ring path
// runs only when no bar is found.
//
// ── HARD BOUNDARIES ──────────────────────────────────────────────────────────
// - UI GUIDANCE ONLY. This is NEVER completion authority. A full affordance means
//   the user should RELEASE — not that the challenge is solved. Completion remains
//   the monitor's stable visual-clear authority AFTER release.
// - No DOM, no OCR, no text matching, no site/provider hardcode, no challenge
//   solving, no click/press/hold/release. Pure luminance analysis of pixels.
// - FAIL CLOSED: any ambiguity (no candidate, weak two-level split, soft/gradient
//   transition, off-card geometry, non-compact / non-square button, solid disc with
//   no track gap) returns `{ found: false }`, which the caller treats as "keep
//   holding".
// - SAFE OUTPUT ONLY. Returns a coarse fill ratio + a NORMALIZED band descriptor
//   (fractions of the crop, for cross-frame stability) — never raw pixel
//   coordinates, never bytes, never anything that flows to an agent. The caller
//   publishes only a phase enum; it never serializes the band.
// - SELF-DIAGNOSTICS. `analyzeReleaseReady` also returns coarse, safe diagnostics
//   (enum/bucket/boolean only) explaining the candidate search. `estimateProgressFillRatio`
//   keeps its original signature (so the monitor is untouched) and, ONLY when both
//   ANTIGEN_HV_DEBUG and ANTIGEN_HV_RELEASE_READY are on, emits those diagnostics via
//   logHvDebug under a distinct scope. When either flag is off it is byte-identical
//   to before (no log, no behavior change).
//
// Operates on the BLOCKER-REGION crop (computed upstream by computeBlockerCropBox
// + cropPng), so page chrome / marketing banners are already excluded — this
// module does not re-find the card.

import { PNG } from "pngjs";

import { logHvDebug } from "./humanVerificationState.js";
import { noteDetectorDiagnostics } from "./releaseReadyDebugCrops.js";

// ─── Bar tunables (all heuristic; named for tuning) — UNCHANGED ───────────────

/** Min per-row luminance contrast (0–255) for a row to be a bar candidate. */
const MIN_ROW_CONTRAST = 40;
/** A bar is wide and thin: width / height must be at least this. */
const MIN_ASPECT = 6;
/** Reject sub-pixel "bands" — a real bar is at least this tall (image px). */
const MIN_BAR_PX = 3;
/** Reject big two-tone panels: band height must be ≤ this fraction of crop height. */
const MAX_BAR_FRACTION = 0.25;
/** The bar must sit in the lower/middle of the card (center-y fraction window). */
const CENTER_Y_LO = 0.35;
const CENTER_Y_HI = 0.95;
/** Min separation between the fill level and the track level (0–255). */
const MIN_SPLIT_CONTRAST = 45;
/** "Sharp transition": ambiguous mid-band columns must be ≤ max(this, frac·barW). */
const TRANSITION_MIN_PX = 4;
const TRANSITION_FRAC = 0.03;
/** Bar horizontal extent = central region of the crop (trim rounded corners / pad). */
const BAR_X_MARGIN_FRACTION = 0.1;
/**
 * Edge window (px) for sampling the fill level (left edge) and track level (right
 * edge). A NARROW window on purpose: at high fill the track is a thin right-hand
 * sliver, so a wide sample would be contaminated by fill and miss the very
 * "near-full" reads we care about. Capped to a small fraction of bar width.
 */
const EDGE_SAMPLE_PX = 4;
/** Reject tiny bars where a ratio is meaningless. */
const MIN_BAR_WIDTH_PX = 40;

// ─── Button / ring tunables ───────────────────────────────────────────────────

/** A pixel is "ink" (part of the button affordance) when it differs from the card
 * background luminance by at least this (0–255). */
const INK_CONTRAST = 40;
/** Need at least this fraction of the crop to be ink before we look for a button. */
const RING_MIN_INK_FRACTION = 0.005;
/** A button is compact: its bbox must not span more than this fraction of either
 * crop dimension (else it is the whole card, not a button). */
const RING_MAX_BBOX_DIM_FRACTION = 0.92;
/** Reject buttons smaller than this (image px) — a radial read is meaningless. */
const RING_MIN_BBOX_PX = 24;
/** A button is roughly square: bbox width/height must fall in this window. */
const BUTTON_ASPECT_LO = 0.6;
const BUTTON_ASPECT_HI = 1.67;
/** Annulus radii to probe (as fractions of the button half-min-side). Covers a full
 * ring, an inset halo, and a pressed border near the rim. */
const RING_RADII_FRACS = [0.62, 0.78, 0.92];
/** Number of angular samples around each annulus. */
const RING_ANGLE_SAMPLES = 180;
/** Half-window (degrees) near the top of the ring used to anchor the FILL level.
 * Radial progress overwhelmingly starts at 12 o'clock and grows clockwise, so the
 * top is fill once a hold is in progress. Anchoring there disambiguates fill vs
 * track (a near-empty and a near-full ring are otherwise mirror images). */
const RING_TOP_ARC_DEG = 14;
/** Max fraction of angular samples allowed in the ambiguous mid-band before the ring
 * is treated as a soft gradient and rejected. */
const RING_AMBIGUOUS_MAX_FRAC = 0.12;
/** A sample within this luminance of the anchored fill level is "fill". */
const RING_FILL_TOL = 25;
/** Min fraction of angular samples that must read as a distinct track gap to confirm
 * a ring (and to reject a solid disc, which has no gap). */
const RING_MIN_TRACK_FRAC = 0.01;

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Normalized (crop-fraction) descriptor of the detected affordance. Used ONLY for
 * cross-frame position-stability — never logged with values, never returned to an
 * agent. All values are in [0,1] relative to the crop, so it is frame-size
 * independent. For a ring this is the button bounding box.
 */
export interface ReleaseReadyBand {
  /** Affordance vertical center as a fraction of crop height. */
  y_center: number;
  /** Affordance left edge as a fraction of crop width. */
  x0: number;
  /** Affordance right edge as a fraction of crop width. */
  x1: number;
}

/** Best-effort fill estimate for one frame. `found:false` ⇒ keep holding. */
export interface ProgressFillEstimate {
  found: boolean;
  /** Estimated fill ratio in [0,1] when found. */
  fill_ratio?: number;
  band?: ReleaseReadyBand;
  /**
   * Set ONLY by a detector path that has ALREADY established cross-frame temporal
   * stability internally — the whole-crop plateau fallback, whose strong read is itself
   * a multi-frame "filled a lot, then stopped" plateau. It lets the outer streak
   * (advanceReleaseReady) fire on the FIRST full frame instead of demanding
   * VGC_RELEASE_READY_CONSECUTIVE consecutive frames, so the temporal requirement is not
   * double-counted. The instantaneous per-shape (bar/ring) detector NEVER sets this.
   * UI guidance only — never affects completion, the hold, or agent resumption.
   */
  temporally_confirmed?: boolean;
}

/** Coarse, safe diagnostics for the candidate search. Enums/buckets/booleans only —
 * never coordinates, ratios, pixels, text, selectors, or URLs. */
export interface ReleaseReadyDiagnostics {
  /** Which affordance produced the returned estimate. */
  chosen_candidate_kind: "bar" | "ring" | "none";
  /** Coarse count of candidates considered across both detectors. */
  candidate_count_bucket: CountBucket;
  /** Coarse count of candidates rejected for shape (aspect / split / gradient). */
  rejected_shape_bucket: CountBucket;
  /** Coarse count of candidates rejected for size (too small / too tall / fills crop). */
  rejected_size_bucket: CountBucket;
  /** Coarse count of candidates rejected for location (off the center-y window). */
  rejected_location_bucket: CountBucket;
  /** Coarse count rejected for an insufficient two-level split / uniform region. */
  rejected_split_bucket: CountBucket;
  /** A compact, roughly-square button-like ink region was seen. */
  button_like_candidate_seen: boolean;
  /** A two-level radial (ring/halo/border) split was seen on the button. */
  ring_like_candidate_seen: boolean;
}

type CountBucket = "0" | "1" | "2_4" | "5_plus";

/**
 * Fill ratio at/above which a press-and-hold bar/control reads "full" (release-capable).
 * Canonical home: the per-shape detector is a true leaf module (no sibling runtime imports),
 * so the seam (`visualReleaseReadyWholeCrop`) and the monitor can both import this without
 * the `monitor → seam → monitor` runtime cycle that importing it from the monitor would
 * create. The monitor re-exports it for backward compatibility with existing import sites.
 */
export const FULL_RATIO_THRESHOLD = 0.92;

const NOT_FOUND: ProgressFillEstimate = { found: false };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function countBucket(n: number): CountBucket {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 4) return "2_4";
  return "5_plus";
}

// Mutable accumulator (internal). Bucketed into ReleaseReadyDiagnostics at the end.
interface DiagAccumulator {
  candidateCount: number;
  rejectedShape: number;
  rejectedSize: number;
  rejectedLocation: number;
  rejectedSplit: number;
  buttonLikeCandidateSeen: boolean;
  ringLikeCandidateSeen: boolean;
}

function newDiag(): DiagAccumulator {
  return {
    candidateCount: 0,
    rejectedShape: 0,
    rejectedSize: 0,
    rejectedLocation: 0,
    rejectedSplit: 0,
    buttonLikeCandidateSeen: false,
    ringLikeCandidateSeen: false,
  };
}

function finalizeDiag(
  diag: DiagAccumulator,
  chosen: "bar" | "ring" | "none",
): ReleaseReadyDiagnostics {
  return {
    chosen_candidate_kind: chosen,
    candidate_count_bucket: countBucket(diag.candidateCount),
    rejected_shape_bucket: countBucket(diag.rejectedShape),
    rejected_size_bucket: countBucket(diag.rejectedSize),
    rejected_location_bucket: countBucket(diag.rejectedLocation),
    rejected_split_bucket: countBucket(diag.rejectedSplit),
    button_like_candidate_seen: diag.buttonLikeCandidateSeen,
    ring_like_candidate_seen: diag.ringLikeCandidateSeen,
  };
}

// ─── Horizontal-bar detector (UNCHANGED behavior; now feeds diagnostics) ──────

function detectHorizontalBar(
  L: Float32Array,
  W: number,
  H: number,
  diag: DiagAccumulator,
): ProgressFillEstimate {
  // 1. Candidate rows: high horizontal contrast over the central 80% of columns
  //    (trim 10%/side so rounded card corners / padding don't dominate).
  const cx0 = Math.floor(W * BAR_X_MARGIN_FRACTION);
  const cx1 = Math.ceil(W * (1 - BAR_X_MARGIN_FRACTION));
  const candidate = new Array<boolean>(H).fill(false);
  for (let y = 0; y < H; y++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = cx0; x < cx1; x++) {
      const v = L[W * y + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo >= MIN_ROW_CONTRAST) candidate[y] = true;
  }

  // 2. Group consecutive candidate rows into bands; keep bar-like ones.
  const bands: Array<{ y0: number; y1: number }> = [];
  let runStart = -1;
  for (let y = 0; y <= H; y++) {
    if (y < H && candidate[y]) {
      if (runStart < 0) runStart = y;
    } else if (runStart >= 0) {
      bands.push({ y0: runStart, y1: y - 1 });
      runStart = -1;
    }
  }

  const barWidthPx = cx1 - cx0;
  if (barWidthPx < MIN_BAR_WIDTH_PX) return NOT_FOUND;

  // 3. Evaluate each candidate band; pick the most bar-like full read.
  let best: ProgressFillEstimate | null = null;
  let bestScore = -Infinity;
  for (const band of bands) {
    diag.candidateCount += 1;
    const bandHeight = band.y1 - band.y0 + 1;
    if (bandHeight < MIN_BAR_PX) {
      diag.rejectedSize += 1;
      continue;
    }
    if (bandHeight > H * MAX_BAR_FRACTION) {
      diag.rejectedSize += 1; // big two-tone panel → reject
      continue;
    }
    if (barWidthPx / bandHeight < MIN_ASPECT) {
      diag.rejectedShape += 1; // not wide+thin → reject
      continue;
    }
    const yCenterFrac = (band.y0 + bandHeight / 2) / H;
    if (yCenterFrac < CENTER_Y_LO || yCenterFrac > CENTER_Y_HI) {
      diag.rejectedLocation += 1;
      continue;
    }

    // Column profile: median luminance across the band rows (kills AA / a stray glyph).
    const profile = new Float32Array(barWidthPx);
    const colSamples: number[] = new Array(bandHeight);
    for (let x = cx0; x < cx1; x++) {
      for (let y = band.y0; y <= band.y1; y++) colSamples[y - band.y0] = L[W * y + x];
      profile[x - cx0] = median(colSamples);
    }

    // Fill level = left edge (always fill when fill > 0); track level = right edge
    // (always track when fill < 100%). Narrow windows so a thin track sliver at
    // high fill is read cleanly rather than averaged away by the fill segment.
    const edge = Math.max(2, Math.min(EDGE_SAMPLE_PX, Math.floor(barWidthPx * 0.05)));
    const fillLevel = median(Array.from(profile.slice(0, edge)));
    const trackLevel = median(Array.from(profile.slice(barWidthPx - edge)));
    const delta = Math.abs(fillLevel - trackLevel);
    if (delta < MIN_SPLIT_CONTRAST) {
      diag.rejectedSplit += 1; // uniform / no two-level split → fail closed
      continue;
    }

    // Transition: first column crossing the midpoint, with a NARROW ambiguous band.
    const mid = (fillLevel + trackLevel) / 2;
    const fillIsHigh = fillLevel > trackLevel;
    const ambLo = Math.min(fillLevel, trackLevel) + 0.25 * delta;
    const ambHi = Math.min(fillLevel, trackLevel) + 0.75 * delta;
    let ambiguous = 0;
    let transition = -1;
    for (let i = 0; i < barWidthPx; i++) {
      const v = profile[i];
      if (v > ambLo && v < ambHi) ambiguous += 1;
      const isFill = fillIsHigh ? v >= mid : v <= mid;
      if (transition < 0 && !isFill) transition = i; // first non-fill column from the left
    }
    const transitionMax = Math.max(TRANSITION_MIN_PX, Math.floor(TRANSITION_FRAC * barWidthPx));
    if (ambiguous > transitionMax) {
      diag.rejectedShape += 1; // gradient / soft fade → reject
      continue;
    }

    // No crossing ⇒ the whole bar reads as fill ⇒ effectively full.
    const fillRatio = transition < 0 ? 1 : Math.min(1, Math.max(0, transition / barWidthPx));

    const estimate: ProgressFillEstimate = {
      found: true,
      fill_ratio: fillRatio,
      band: {
        y_center: yCenterFrac,
        x0: cx0 / W,
        x1: cx1 / W,
      },
    };
    // Prefer the most bar-like (highest aspect × split contrast).
    const score = (barWidthPx / bandHeight) * delta;
    if (score > bestScore) {
      bestScore = score;
      best = estimate;
    }
  }

  return best ?? NOT_FOUND;
}

// ─── Button / ring affordance detector ────────────────────────────────────────

/**
 * Generic, fail-closed detector for a compact button/ring press-hold progress
 * affordance (full ring, partial halo, or pressed border). Runs only when no
 * horizontal bar was found. Approach:
 *   1. Find the compact, roughly-square "ink" region (the button) vs the card bg.
 *   2. Probe a few annulus radii; on each, sample N angles into a luminance profile.
 *   3. Anchor the FILL level at the top of the ring (12-o'clock start convention) so
 *      a near-empty and a near-full ring — otherwise mirror images — are told apart.
 *   4. fill_ratio = fraction of angular samples closer to the fill level than the
 *      track level; require a strong two-level split and a non-gradient profile.
 * A solid disc (no remaining track gap) has no split and fails closed, exactly like
 * the bar path's "100% fill, no track" case — we read NEAR-full (a small track gap),
 * which is what a real progress ring shows just before completion.
 */
function detectButtonRingAffordance(
  L: Float32Array,
  W: number,
  H: number,
  diag: DiagAccumulator,
): ProgressFillEstimate {
  // Background = median of an outer border frame (the card behind the button).
  const m = Math.max(1, Math.floor(Math.min(W, H) * 0.05));
  const border: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < m || x >= W - m || y < m || y >= H - m) border.push(L[W * y + x]);
    }
  }
  const bg = median(border);

  // Ink bbox (pixels that differ strongly from the card background).
  let bx0 = W;
  let by0 = H;
  let bx1 = -1;
  let by1 = -1;
  let inkCount = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.abs(L[W * y + x] - bg) >= INK_CONTRAST) {
        inkCount += 1;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  if (inkCount < RING_MIN_INK_FRACTION * W * H || bx1 < 0) {
    diag.rejectedSize += 1;
    return NOT_FOUND;
  }

  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;
  // Too small to read radially, or fills the crop (not a compact button).
  if (bw < RING_MIN_BBOX_PX || bh < RING_MIN_BBOX_PX) {
    diag.rejectedSize += 1;
    return NOT_FOUND;
  }
  if (bw > W * RING_MAX_BBOX_DIM_FRACTION && bh > H * RING_MAX_BBOX_DIM_FRACTION) {
    diag.rejectedSize += 1;
    return NOT_FOUND;
  }
  const aspect = bw / bh;
  if (aspect < BUTTON_ASPECT_LO || aspect > BUTTON_ASPECT_HI) {
    diag.rejectedShape += 1; // not roughly square → not a button/ring
    return NOT_FOUND;
  }

  // A compact, roughly-square ink region: a button-like candidate.
  diag.candidateCount += 1;
  diag.buttonLikeCandidateSeen = true;

  const cx = (bx0 + bx1) / 2;
  const cy = (by0 + by1) / 2;
  const halfMin = Math.min(bw, bh) / 2;

  // Sample a radial luminance value (median over a short radial window) at an angle
  // measured from the top of the ring, clockwise. θ=0 → top (12 o'clock).
  const radialAt = (r: number, theta: number): number => {
    const samples: number[] = [];
    for (const rr of [r * 0.92, r, r * 1.08]) {
      const px = Math.round(cx + rr * Math.sin(theta));
      const py = Math.round(cy - rr * Math.cos(theta));
      if (px >= 0 && px < W && py >= 0 && py < H) samples.push(L[W * py + px]);
    }
    return samples.length ? median(samples) : bg;
  };

  let best: ProgressFillEstimate | null = null;
  let bestDelta = -Infinity;
  const topArc = (RING_TOP_ARC_DEG * Math.PI) / 180;

  for (const radiusFrac of RING_RADII_FRACS) {
    const r = radiusFrac * halfMin;
    if (r < 4) continue;
    const profile: number[] = new Array(RING_ANGLE_SAMPLES);
    const topSamples: number[] = [];
    for (let i = 0; i < RING_ANGLE_SAMPLES; i++) {
      const theta = (i / RING_ANGLE_SAMPLES) * 2 * Math.PI;
      const v = radialAt(r, theta);
      profile[i] = v;
      // Anchor fill on the START arc just CLOCKWISE of top ([0, +topArc]). The sweep
      // begins at top and grows clockwise, so this side is fill once a hold is in
      // progress, while the counter-clockwise side (just before top) is the LAST to
      // fill — sampling there would catch a near-full ring's remaining gap.
      if (theta <= topArc) topSamples.push(v);
    }

    const fillLevel = median(topSamples.length ? topSamples : profile);
    // Classify each angle by its absolute deviation from the anchored fill level.
    // A percentile-based track level misses a NEAR-FULL ring (a 4% gap never reaches
    // the 90th percentile), so instead gather the minority "far" samples directly:
    // those a clear split away from fill are the track gap; the in-between zone is
    // ambiguous (anti-aliasing / gradient).
    const farVals: number[] = [];
    let ambiguous = 0;
    for (let i = 0; i < RING_ANGLE_SAMPLES; i++) {
      const dev = Math.abs(profile[i] - fillLevel);
      if (dev >= MIN_SPLIT_CONTRAST) farVals.push(profile[i]);
      else if (dev > RING_FILL_TOL) ambiguous += 1;
    }
    // No coherent gap ⇒ solid disc / uniform annulus ⇒ fail closed.
    if (farVals.length < Math.max(2, Math.ceil(RING_MIN_TRACK_FRAC * RING_ANGLE_SAMPLES))) continue;
    if (ambiguous > RING_AMBIGUOUS_MAX_FRAC * RING_ANGLE_SAMPLES) continue; // soft/gradient

    const trackLevel = median(farVals);
    const delta = Math.abs(trackLevel - fillLevel);
    if (delta < MIN_SPLIT_CONTRAST) continue;

    // A genuine two-level ring split on a button: a ring-like candidate.
    diag.ringLikeCandidateSeen = true;

    let fillCount = 0;
    for (let i = 0; i < RING_ANGLE_SAMPLES; i++) {
      if (Math.abs(profile[i] - fillLevel) <= Math.abs(profile[i] - trackLevel)) fillCount += 1;
    }
    const fillRatio = Math.min(1, Math.max(0, fillCount / RING_ANGLE_SAMPLES));
    if (delta > bestDelta) {
      bestDelta = delta;
      best = {
        found: true,
        fill_ratio: fillRatio,
        band: { y_center: cy / H, x0: bx0 / W, x1: bx1 / W },
      };
    }
  }

  if (!best) {
    diag.rejectedSplit += 1; // button-like, but no valid radial ring split
    return NOT_FOUND;
  }
  return best;
}

// ─── Detector core + public wrapper ───────────────────────────────────────────

/** Detector debug gate: ONLY when both ANTIGEN_HV_DEBUG and ANTIGEN_HV_RELEASE_READY
 * are on. When either is off, `estimateProgressFillRatio` is byte-identical to before
 * (no log, no behavior change). */
function shouldEmitDetectorDebug(): boolean {
  return (
    process.env.ANTIGEN_HV_DEBUG === "true" &&
    process.env.ANTIGEN_HV_RELEASE_READY === "true"
  );
}

/**
 * Pure analysis core: decode → luminance grid → horizontal bar → button/ring →
 * none. Returns the estimate AND coarse safe diagnostics. Exported so tests (and any
 * future caller) can inspect the candidate search without capturing logs. Never throws.
 */
export function analyzeReleaseReady(croppedPngBase64: string): {
  estimate: ProgressFillEstimate;
  diagnostics: ReleaseReadyDiagnostics;
} {
  const diag = newDiag();

  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(croppedPngBase64, "base64"));
  } catch {
    return { estimate: NOT_FOUND, diagnostics: finalizeDiag(diag, "none") };
  }
  const W = png.width;
  const H = png.height;
  if (!(W >= MIN_BAR_WIDTH_PX && H >= MIN_BAR_PX * 2)) {
    return { estimate: NOT_FOUND, diagnostics: finalizeDiag(diag, "none") };
  }

  // Per-pixel luminance grid (row-major) — built once, shared by both detectors.
  const L = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (W * y + x) << 2;
      L[W * y + x] = luminance(png.data[idx], png.data[idx + 1], png.data[idx + 2]);
    }
  }

  const bar = detectHorizontalBar(L, W, H, diag);
  if (bar.found) {
    return { estimate: bar, diagnostics: finalizeDiag(diag, "bar") };
  }

  const ring = detectButtonRingAffordance(L, W, H, diag);
  if (ring.found) {
    return { estimate: ring, diagnostics: finalizeDiag(diag, "ring") };
  }

  return { estimate: NOT_FOUND, diagnostics: finalizeDiag(diag, "none") };
}

/**
 * Estimate the press-and-hold progress fill ratio from a cropped, redacted PNG
 * (base64). PURE result; never throws — any decode/analysis problem returns
 * `{ found:false }` (fail closed). Signature is unchanged so the handoff monitor is
 * untouched. Emits coarse, safe diagnostics ONLY when both ANTIGEN_HV_DEBUG and
 * ANTIGEN_HV_RELEASE_READY are on (otherwise byte-identical to before).
 */
export function estimateProgressFillRatio(
  croppedPngBase64: string,
  capsuleId?: string,
): ProgressFillEstimate {
  // Entry marker (coarse booleans only — no pixels/coords/image data): if the probe
  // logs stage=detector_invoked, this proves the detector wrapper actually ran. Paired
  // with the post-analysis log below so "entered" is distinguishable from "analyzed".
  if (shouldEmitDetectorDebug()) {
    logHvDebug({ scope: "vgc_release_ready_detect", entered: true, release_ready_flag: true });
  }
  const { estimate, diagnostics } = analyzeReleaseReady(croppedPngBase64);
  if (shouldEmitDetectorDebug()) {
    logHvDebug({ scope: "vgc_release_ready_detect", found: estimate.found, ...diagnostics });
  }
  // Dev-only debug-crop note (double-flag-gated inside; no-op otherwise). Records which
  // affordance shape the per-shape detector chose for this probe; the whole-crop fallback
  // overrides it later in the same probe when the temporal read is the one that fires.
  if (capsuleId !== undefined) {
    noteDetectorDiagnostics(capsuleId, {
      chosen_candidate_kind: diagnostics.chosen_candidate_kind,
      // Raw ratio is bucketed inside the note (disk-only debug); never returned to an agent.
      fill_ratio: estimate.found ? estimate.fill_ratio : undefined,
    });
  }
  return estimate;
}
