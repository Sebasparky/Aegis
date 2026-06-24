/**
 * Release-Ready Whole-Crop Active-Hold Fallback — pure + stateful + bridge suite
 * (no Chromium). Synthesizes redacted-crop-shaped PNGs with pngjs.
 *
 * SAFETY PATCH (color-agnostic release-ready): the whole-crop temporal read is now
 * PROGRESS / TELEMETRY ONLY — it NEVER fires `release_ready`. A "crop stopped changing"
 * plateau is not proof the visual control is geometrically complete (a slow half-full bar
 * plateaus too), so `evaluateWholeCropProgress` ALWAYS returns `{found:false}`. The sole
 * release trigger is the direct, color-agnostic control-fill detector (its own suite).
 *
 * This suite pins:
 *   - the pure temporal signals (compareCropFrames / isStrongProgress / ratioBucket) still
 *     compute correctly for telemetry — UNCHANGED;
 *   - even a strong / very-strong / relaxed-sustained / moderate plateau returns found:false,
 *     never increments the outer streak, and never fires after two frames;
 *   - the fallback still runs ONLY for a `hold_anchor` crop and still creates tracking state
 *     (so it can emit progress telemetry);
 *   - the per-shape detector still fires through the seam (unchanged), and is never
 *     temporally confirmed.
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
} from "../runtime/visualReleaseReadyWholeCrop.js";
import { clearControlFillForTests } from "../runtime/visualControlFillDetector.js";
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
 * Blank crop with the left `frac` of the FULL-HEIGHT crop filled DARK. A big two-tone panel
 * (full crop height) the per-shape detector rejects (band too tall) → `found:false`, and the
 * color-agnostic control-fill detector also rejects (control band would span the whole crop
 * height → too_broad), so this exercises the whole-crop telemetry path in isolation. `frac`
 * of the crop's pixels differ from a `blank()` baseline.
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
  clearControlFillForTests();
});

describe("compareCropFrames / isStrongProgress — pure signals (UNCHANGED, telemetry math)", () => {
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
    expect(isStrongProgress(0.1, 0)).toBe(true); // filled a lot, stopped → strong signal
    expect(isStrongProgress(0.1, 0.1)).toBe(false); // still changing → not plateaued
    expect(isStrongProgress(0.0, 0)).toBe(false); // nothing filled → weak
    expect(isStrongProgress(0.02, 0)).toBe(false); // below cumulative floor
  });

  it("strict plateau threshold is 0.012 (a tiny-shimmer plateau still reads strong)", () => {
    expect(isStrongProgress(0.1, 0.01)).toBe(true); // recent 1% ≤ 1.2% → strong
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

// ── Safety patch: the whole-crop temporal read NEVER fires release_ready. ──────────
// Every plateau strength (strong / very-strong / relaxed-sustained / moderate) is now
// telemetry-only: found:false, no fill_ratio, no band, no temporally_confirmed, and it can
// never advance the outer streak or fire — not even after two consecutive strong frames.
describe("evaluateWholeCropProgress — telemetry only, NEVER fires release_ready", () => {
  it("a strong plateaued whole-crop read returns found:false (never a full estimate)", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false); // baseline
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.1)).found).toBe(false); // still changing
    const f2 = evaluateWholeCropProgress(CAP, filledLeft(0.1)); // plateaued — strong SIGNAL
    expect(f2.found).toBe(false);
    expect(f2.fill_ratio).toBeUndefined();
    expect(f2.band).toBeUndefined();
    expect(f2.temporally_confirmed).toBeUndefined();
    // The underlying temporal signal IS strong (the computation survives for telemetry)…
    expect(isStrongProgress(0.1, 0)).toBe(true);
    // …but a found:false estimate can never advance the outer streak / fire.
    const a = advanceReleaseReady(0, undefined, f2);
    expect(a.fire).toBe(false);
    expect(a.consecutiveFull).toBe(0);
  });

  it("a very-strong (≥5%) strict plateau also returns found:false and never fires after two frames", () => {
    evaluateWholeCropProgress(CAP, blank()); // baseline
    evaluateWholeCropProgress(CAP, filledLeft(0.06)); // recent 0.06 → still changing
    const v1 = evaluateWholeCropProgress(CAP, filledLeft(0.06)); // plateau, cumulative 6% (ge5)
    const v2 = evaluateWholeCropProgress(CAP, filledLeft(0.06)); // second identical plateau frame
    expect(v1.found).toBe(false);
    expect(v2.found).toBe(false);
    const a1 = advanceReleaseReady(0, undefined, v1);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, v2);
    expect(a1.fire).toBe(false);
    expect(a2.fire).toBe(false);
    expect(a2.consecutiveFull).toBe(0);
  });

  it("a relaxed-sustained (3 consecutive relaxed-ok frames) plateau returns found:false", () => {
    evaluateWholeCropProgress(CAP, blank()); // baseline
    evaluateWholeCropProgress(CAP, filledLeft(0.1)); // recent 0.1
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.115)).found).toBe(false); // relaxed 1
    expect(evaluateWholeCropProgress(CAP, filledLeft(0.13)).found).toBe(false); // relaxed 2
    const r3 = evaluateWholeCropProgress(CAP, filledLeft(0.145)); // relaxed 3 → strong signal
    expect(r3.found).toBe(false);
    expect(r3.temporally_confirmed).toBeUndefined();
    expect(advanceReleaseReady(0, undefined, r3).fire).toBe(false);
  });

  it("a moderate (3–5%) strict plateau returns found:false and never fires after two frames", () => {
    evaluateWholeCropProgress(CAP, blank()); // baseline
    evaluateWholeCropProgress(CAP, filledLeft(0.04)); // recent 0.04 → still changing
    const m1 = evaluateWholeCropProgress(CAP, filledLeft(0.04)); // plateau, cumulative 4% (3_5)
    const m2 = evaluateWholeCropProgress(CAP, filledLeft(0.04)); // second identical plateau frame
    expect(m1.found).toBe(false);
    expect(m2.found).toBe(false);
    const a1 = advanceReleaseReady(0, undefined, m1);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, m2);
    expect(a1.fire).toBe(false);
    expect(a2.fire).toBe(false);
    expect(a2.consecutiveFull).toBe(0);
  });

  it("weak / static / spinner crops also return found:false (unchanged)", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false);
    for (let i = 0; i < 4; i++) expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false);
    for (const frac of [0.1, 0.25, 0.4, 0.55, 0.7]) {
      expect(evaluateWholeCropProgress(CAP, filledLeft(frac)).found).toBe(false);
    }
  });

  it("still creates per-capsule tracking state so it can emit progress telemetry", () => {
    expect(evaluateWholeCropProgress(CAP, blank()).found).toBe(false);
    expect(wholeCropStateKindForTests(CAP)).toBe("tracking");
  });

  it("garbage base64 fails closed (never throws)", () => {
    expect(evaluateWholeCropProgress(CAP, "not-a-real-png").found).toBe(false);
    expect(evaluateWholeCropProgress(CAP, "not-a-real-png").temporally_confirmed).toBeUndefined();
  });
});

// ── Strict `hold_anchor` source gate (the seam) — UNCHANGED for the per-shape detector. ──
describe("estimateReleaseReadyWithWholeCropFallback — strict hold_anchor source gate", () => {
  it("dominant_surface + a real bar → returns the existing detector estimate", () => {
    const est = estimateReleaseReadyWithWholeCropFallback(CAP, barImage(0.95), "dominant_surface");
    expect(est.found).toBe(true);
    expect(est.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    // Non-hold-anchor → neither whole-crop nor control-fill state is created.
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

  it("hold_anchor + no sub-candidate engages the telemetry fallback (baseline captured, found:false)", () => {
    const est = estimateReleaseReadyWithWholeCropFallback(CAP, blank(), "hold_anchor");
    expect(est.found).toBe(false); // first frame baselines, cannot compare yet
    expect(wholeCropStateKindForTests(CAP)).toBe("tracking");
  });

  it("hold_anchor + a strong whole-crop plateau STILL returns found:false (no release from the seam)", () => {
    expect(estimateReleaseReadyWithWholeCropFallback(CAP, blank(), "hold_anchor").found).toBe(false);
    expect(estimateReleaseReadyWithWholeCropFallback(CAP, filledLeft(0.1), "hold_anchor").found).toBe(false);
    // A plateaued strong whole-crop frame: telemetry runs, but the seam returns found:false.
    const seam = estimateReleaseReadyWithWholeCropFallback(CAP, filledLeft(0.1), "hold_anchor");
    expect(seam.found).toBe(false);
  });

  it("hold_anchor with a recognizable bar still prefers the per-shape detector (no fallback state)", () => {
    const est = estimateReleaseReadyWithWholeCropFallback(CAP, barImage(0.95), "hold_anchor");
    expect(est.found).toBe(true);
    // Detector found it → fallback short-circuited → no whole-crop state created.
    expect(wholeCropStateKindForTests(CAP)).toBe("none");
    // The instantaneous per-shape detector is NOT temporally confirmed: it must still earn
    // the 2-consecutive-frame streak, so a single full per-shape frame never fires.
    expect(est.temporally_confirmed).toBeUndefined();
    const a1 = advanceReleaseReady(0, undefined, est);
    expect(a1.fire).toBe(false);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, est);
    expect(a2.fire).toBe(true);
    expect(a2.consecutiveFull).toBe(VGC_RELEASE_READY_CONSECUTIVE);
  });
});
