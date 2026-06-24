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

  it("strict plateau threshold is 0.012 (a tiny-shimmer plateau still reads strong)", () => {
    // The tune raised RECENT_PLATEAU_MAX 0.006 → 0.012, so a ~1% recent change now plateaus.
    expect(isStrongProgress(0.1, 0.01)).toBe(true); // recent 1% ≤ 1.2% → strong (was NOT under 0.006)
    expect(isStrongProgress(0.1, 0.012)).toBe(true); // exactly at the ceiling → strong
    expect(isStrongProgress(0.1, 0.013)).toBe(false); // just above the ceiling → not strong
  });

  it("ratioBucket returns coarse safe enums only", () => {
    const enums = ["lt0_5", "0_5_1", "1_1_5", "1_5_2", "2_3", "3_5", "ge5"];
    for (const b of [
      ratioBucket(0),
      ratioBucket(0.007),
      ratioBucket(0.013),
      ratioBucket(0.017),
      ratioBucket(0.025),
      ratioBucket(0.04),
      ratioBucket(0.5),
    ]) {
      expect(enums).toContain(b);
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

// ── Test 1b: plateau-threshold tune (strict 1.2%) + relaxed sustained (1.5–1.8% × 3). ──
// `filledLeft(frac)` gives precise control: cumulative = current frac (vs the blank baseline),
// recent = |current frac − previous frac| (the columns that flipped since the previous frame).
describe("evaluateWholeCropProgress — strict plateau + relaxed sustained acceleration", () => {
  it("strict: cumulative ≥ 3% and recent ≤ 1.2% reads strong on the next compared frame", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false); // baseline
    // recent 0.1 (vs blank) — still changing, no fire.
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.1)).found).toBe(false);
    // recent |0.105 − 0.1| = 0.005 ≤ 0.012, cumulative 0.105 ≥ 0.03 → STRICT strong.
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.105)).found).toBe(true);
  });

  it("old live-like case: cumulative strong + recent ~1% now reads strong (was not under 0.006)", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false); // baseline
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.1)).found).toBe(false); // recent 0.1
    // recent |0.11 − 0.1| = 0.01 (1%) ≤ 0.012 → strong now; under the old 0.006 ceiling it would not.
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.11)).found).toBe(true);
  });

  it("relaxed sustained: recent ~1.5% for 3 consecutive frames fires found:true, then outer streak needs 2", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false); // baseline
    // Prime prevLum so subsequent recent deltas are small (each step = 0.015 → recent 1.5%).
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.1)).found).toBe(false); // recent 0.1
    // Each frame: recent 0.015 (> strict 0.012, ≤ relaxed 0.018), cumulative grows ≥ 0.03.
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.115)).found).toBe(false); // relaxed count 1
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.13)).found).toBe(false); // relaxed count 2
    const r3 = evaluateWholeCropProgress(CAP, filledLeft(0.145)); // relaxed count 3 → strong
    expect(r3.found).toBe(true);
    const r4 = evaluateWholeCropProgress(CAP, filledLeft(0.16)); // still relaxed-ok → strong
    expect(r4.found).toBe(true);

    // The outer streak still requires TWO consecutive found frames to fire.
    const a3 = advanceReleaseReady(0, undefined, r3);
    expect(a3.fire).toBe(false);
    const a4 = advanceReleaseReady(a3.consecutiveFull, a3.lastBand, r4);
    expect(a4.fire).toBe(true);
    expect(a4.consecutiveFull).toBe(VGC_RELEASE_READY_CONSECUTIVE);
  });

  it("recent above the relaxed ceiling (2%) never sustains → never fires", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false); // baseline
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.1)).found).toBe(false); // recent 0.1
    // Each step = 0.02 → recent 2% > relaxed 1.8% → relaxed count resets every frame.
    for (const frac of [0.12, 0.14, 0.16, 0.18]) {
      expect(evaluateWholeCropProgress(CAP, filledLeft(frac)).found).toBe(false);
    }
  });

  it("weak cumulative (< 3%) never fires even when fully plateaued", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false); // baseline
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.02)).found).toBe(false); // cumulative 2%, recent 2%
    // Identical frames → recent 0 (plateaued) but cumulative 2% < 3% floor → still never strong.
    for (let i = 0; i < 4; i++) {
      expect(evaluateWholeCropProgress(CAP, filledLeft(0.02)).found).toBe(false);
    }
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
