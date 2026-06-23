/**
 * Release-Ready Whole-Crop Active-Hold Fallback — pure + stateful + bridge suite
 * (no Chromium). Synthesizes redacted-crop-shaped PNGs with pngjs and exercises the
 * conservative TEMPORAL fallback that fires "Release now" when the per-shape detector
 * finds no bar/ring sub-candidate inside a valid `hold_anchor` crop.
 *
 * Pins the safety-relevant behavior:
 *   - a strong, PLATEAUED whole-crop change (lots filled vs baseline, then stopped)
 *     yields a full estimate that fires after the existing 2-frame streak;
 *   - a static crop (nothing filled) or a perpetually-changing crop (spinner) never fires;
 *   - the fallback runs ONLY for a `hold_anchor` crop — never dominant/inner/center;
 *   - it is UI guidance only (the estimate flows through the unchanged streak machine).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PNG } from "pngjs";

import {
  compareCropFrames,
  isStrongProgress,
  ratioBucket,
  evaluateWholeCropProgress,
  estimateReleaseReadyWithWholeCropFallback,
  clearWholeCropProgressForTests,
  wholeCropStateKindForTests,
  WHOLE_CROP_BAND,
} from "../runtime/visualReleaseReadyWholeCrop.js";
import {
  advanceReleaseReady,
  VGC_RELEASE_READY_CONSECUTIVE,
  FULL_RATIO_THRESHOLD,
} from "../runtime/visualHandoffMonitor.js";

const W = 400;
const H = 300;
const BG = 200; // uniform card background gray
const DARK = 40; // filled / "ink"

function blank(gray = BG): string {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    const o = i << 2;
    png.data[o] = gray;
    png.data[o + 1] = gray;
    png.data[o + 2] = gray;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png).toString("base64");
}

/**
 * Blank crop with the left `frac` of the FULL-HEIGHT crop filled DARK. This is a big
 * two-tone panel (full crop height), so the per-shape detector rejects it (band too
 * tall / not a compact square) → `found:false`, which is exactly the case the whole-crop
 * fallback must rescue. `frac` of the crop's pixels differ from a `blank()` baseline.
 */
function filledLeft(frac: number): string {
  const png = new PNG({ width: W, height: H });
  const boundary = Math.round(frac * W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (W * y + x) << 2;
      const v = x < boundary ? DARK : BG;
      png.data[o] = v;
      png.data[o + 1] = v;
      png.data[o + 2] = v;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

// Detector's fixed bar extent: central 80% of the crop width.
const CX0 = Math.floor(W * 0.1);
const CX1 = Math.ceil(W * 0.9);
const BAR_W = CX1 - CX0;

/** A clean centered wide+thin two-level bar the per-shape detector DOES recognize. */
function barImage(fillRatioOverBar: number): string {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    const o = i << 2;
    png.data[o] = BG;
    png.data[o + 1] = BG;
    png.data[o + 2] = BG;
    png.data[o + 3] = 255;
  }
  const y0 = Math.round(H * 0.7);
  const y1 = y0 + 11;
  const boundary = CX0 + Math.round(fillRatioOverBar * BAR_W);
  for (let x = CX0; x < CX1; x++) {
    const v = x < boundary ? DARK : 220;
    for (let y = y0; y <= y1; y++) {
      const o = (W * y + x) << 2;
      png.data[o] = v;
      png.data[o + 1] = v;
      png.data[o + 2] = v;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

const CAP = "vgc_whole_crop_test";

beforeEach(() => {
  clearWholeCropProgressForTests();
});

describe("compareCropFrames / isStrongProgress — pure signals", () => {
  it("cumulative is change vs baseline; recent is change vs previous", () => {
    const n = 1000;
    const base = new Float32Array(n).fill(0);
    const prev = new Float32Array(n).fill(0);
    const cur = new Float32Array(n).fill(0);
    // 100 of 1000 pixels jump high in the current frame.
    for (let i = 0; i < 100; i++) cur[i] = 255;
    const { cumulative_change_ratio, recent_change_ratio } = compareCropFrames(base, prev, cur);
    expect(cumulative_change_ratio).toBeCloseTo(0.1, 5);
    expect(recent_change_ratio).toBeCloseTo(0.1, 5);
  });

  it("strong = high cumulative AND ~0 recent (plateaued-full)", () => {
    expect(isStrongProgress(0.1, 0)).toBe(true); // filled a lot, stopped → strong
    expect(isStrongProgress(0.1, 0.1)).toBe(false); // still changing → not plateaued
    expect(isStrongProgress(0.0, 0)).toBe(false); // nothing filled → weak
    expect(isStrongProgress(0.02, 0)).toBe(false); // below cumulative floor
  });

  it("ratioBucket returns coarse safe enums only", () => {
    for (const b of [ratioBucket(0), ratioBucket(0.02), ratioBucket(0.029), ratioBucket(0.5)]) {
      expect(["lt1", "1_3", "3_strong", "ge_strong"]).toContain(b);
    }
  });
});

// ── Test 1: hold-anchor + no sub-candidate + strong whole-crop progress ⇒ fires. ──
describe("evaluateWholeCropProgress — strong plateaued progress fires after streak", () => {
  it("baseline → fill → plateau yields full estimates that fire on the 2nd stable frame", () => {
    // Frame 0: baseline (blank) — captured, cannot compare yet.
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false);

    // Frame 1: 10% filled — cumulative high but recent high (still changing) → no fire.
    const f1 = evaluateWholeCropProgress(CAP, filledLeft(0.1));
    expect(f1.found).toBe(false);

    // Frame 2: identical 10% — cumulative high, recent ~0 (plateaued) → STRONG.
    const f2 = evaluateWholeCropProgress(CAP, filledLeft(0.1));
    expect(f2.found).toBe(true);
    expect(f2.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    expect(f2.band).toEqual(WHOLE_CROP_BAND);

    // Frame 3: identical again — STRONG.
    const f3 = evaluateWholeCropProgress(CAP, filledLeft(0.1));
    expect(f3.found).toBe(true);

    // Two consecutive strong frames fire through the EXISTING outer streak.
    const a2 = advanceReleaseReady(0, undefined, f2);
    expect(a2.fire).toBe(false); // a single full frame never fires
    const a3 = advanceReleaseReady(a2.consecutiveFull, a2.lastBand, f3);
    expect(a3.fire).toBe(true);
    expect(a3.consecutiveFull).toBe(VGC_RELEASE_READY_CONSECUTIVE);
  });

  it("the per-shape detector alone finds nothing in a full-height two-tone panel (fallback is needed)", () => {
    // Sanity: a filledLeft panel is NOT a bar/ring → the detector path returns found:false,
    // so only the whole-crop fallback can rescue it.
    const viaDetectorOnly = estimateReleaseReadyWithWholeCropFallback(
      "other_cap",
      filledLeft(0.1),
      "dominant_surface", // non-hold-anchor → fallback NOT allowed → detector result stands
    );
    expect(viaDetectorOnly.found).toBe(false);
  });
});

// ── Test 2: hold-anchor + no sub-candidate + weak/no progress ⇒ no fire. ──────────
describe("evaluateWholeCropProgress — weak / non-plateaued progress never fires", () => {
  it("a static crop (nothing fills) never reads strong", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false);
    }
  });

  it("a perpetually-changing crop (spinner-like) never plateaus → never fires", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false);
    // Each frame changes a different amount → recent change always high → never strong.
    for (const frac of [0.1, 0.25, 0.4, 0.55, 0.7]) {
      const est = evaluateWholeCropProgress(CAP, filledLeft(frac));
      expect(est.found).toBe(false);
    }
  });
});

// ── Test 3: non-hold-anchor crop still uses existing candidate logic. ─────────────
describe("estimateReleaseReadyWithWholeCropFallback — strict hold_anchor source gate", () => {
  it("dominant_surface + a real bar → returns the existing detector estimate", () => {
    const est = estimateReleaseReadyWithWholeCropFallback(CAP, barImage(0.95), "dominant_surface");
    expect(est.found).toBe(true);
    expect(est.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    // The whole-crop fallback was never engaged for a non-hold-anchor crop.
    expect(wholeCropStateKindForTests(CAP)).toBe("none");
  });

  it("non-hold-anchor crops never engage the fallback and never create state", () => {
    for (const src of ["dominant_surface", "inner_control", "center_region"] as const) {
      const cap = `cap_${src}`;
      const est = estimateReleaseReadyWithWholeCropFallback(cap, blank(), src);
      expect(est.found).toBe(false);
      expect(wholeCropStateKindForTests(cap)).toBe("none");
    }
  });

  it("hold_anchor + no sub-candidate engages the fallback (baseline captured, fail closed first)", () => {
    const est = estimateReleaseReadyWithWholeCropFallback(CAP, blank(), "hold_anchor");
    expect(est.found).toBe(false); // first frame baselines, cannot compare yet
    expect(wholeCropStateKindForTests(CAP)).toBe("tracking");
  });

  it("hold_anchor with a recognizable bar still prefers the per-shape detector (no fallback state)", () => {
    const est = estimateReleaseReadyWithWholeCropFallback(CAP, barImage(0.95), "hold_anchor");
    expect(est.found).toBe(true);
    // Detector found it → fallback short-circuited → no whole-crop state created.
    expect(wholeCropStateKindForTests(CAP)).toBe("none");
  });
});

describe("evaluateWholeCropProgress — safe output shape", () => {
  it("a strong estimate carries only the constant whole-crop band (no raw coords)", () => {
    evaluateWholeCropProgress(CAP, blank());
    evaluateWholeCropProgress(CAP, filledLeft(0.1));
    const strong = evaluateWholeCropProgress(CAP, filledLeft(0.1));
    expect(strong.found).toBe(true);
    expect(strong.band).toEqual({ y_center: 0.5, x0: 0, x1: 1 });
  });

  it("garbage base64 fails closed (never throws)", () => {
    expect(evaluateWholeCropProgress(CAP, "not-a-real-png").found).toBe(false);
  });
});
