/**
 * Release-Ready Visual Progress Detector — pure pixel suite (no Chromium).
 *
 * Synthesizes redacted-crop-shaped PNGs with pngjs and exercises
 * `estimateProgressFillRatio`. Pins the safety-relevant behavior: a clean centered
 * wide+thin two-level bar yields a fill ratio; everything ambiguous (no bar,
 * uniform, gradient, too-tall panel, off-center, low fill) fails closed so the
 * caller keeps "Keep holding…". The detector is UI guidance only — never authority.
 */

import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";

import {
  analyzeReleaseReady,
  estimateProgressFillRatio,
} from "../runtime/visualReleaseReadyDetector.js";

const W = 400;
const H = 300;
const BG = 200; // uniform card background gray
const FILL = 40; // dark filled segment
const TRACK = 220; // light unfilled track

// Detector's fixed bar extent: central 80% of the crop width.
const CX0 = Math.floor(W * 0.1);
const CX1 = Math.ceil(W * 0.9);
const BAR_W = CX1 - CX0;

function blank(w = W, h = H, gray = BG): PNG {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2;
      png.data[i] = gray;
      png.data[i + 1] = gray;
      png.data[i + 2] = gray;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

function setRowsCol(png: PNG, y0: number, y1: number, x: number, v: number): void {
  for (let y = y0; y <= y1; y++) {
    const i = (png.width * y + x) << 2;
    png.data[i] = v;
    png.data[i + 1] = v;
    png.data[i + 2] = v;
    png.data[i + 3] = 255;
  }
}

function toB64(png: PNG): string {
  return PNG.sync.write(png).toString("base64");
}

/**
 * Build a crop with a centered, wide+thin progress bar. `fillRatioOverBar` is the
 * fraction of the central-80% bar that is filled (FILL on the left, TRACK on the
 * right). `rampPx` adds a linear anti-aliased transition of that width.
 */
function barImage(
  fillRatioOverBar: number,
  opts: { y0?: number; y1?: number; rampPx?: number; gradient?: boolean } = {},
): string {
  const y0 = opts.y0 ?? Math.round(H * 0.7);
  const y1 = opts.y1 ?? y0 + 11; // 12px tall band
  const png = blank();
  const boundary = CX0 + Math.round(fillRatioOverBar * BAR_W);
  const ramp = opts.rampPx ?? 0;
  for (let x = CX0; x < CX1; x++) {
    let v: number;
    if (opts.gradient) {
      // Full-width linear ramp FILL→TRACK (a soft fade, NOT a sharp bar).
      v = Math.round(FILL + ((TRACK - FILL) * (x - CX0)) / BAR_W);
    } else if (ramp > 0 && x >= boundary - ramp && x < boundary) {
      const t = (x - (boundary - ramp)) / ramp;
      v = Math.round(FILL + (TRACK - FILL) * t);
    } else {
      v = x < boundary ? FILL : TRACK;
    }
    setRowsCol(png, y0, y1, x, v);
  }
  return toB64(png);
}

describe("estimateProgressFillRatio — pure full-bar detection", () => {
  it("empty / uniform crop → found:false (fail closed)", () => {
    expect(estimateProgressFillRatio(toB64(blank())).found).toBe(false);
  });

  it("garbage base64 → found:false (never throws)", () => {
    expect(estimateProgressFillRatio("not-a-real-png").found).toBe(false);
  });

  it("centered 40% bar with a sharp edge → found, fill_ratio ≈ 0.4", () => {
    const est = estimateProgressFillRatio(barImage(0.4));
    expect(est.found).toBe(true);
    expect(est.fill_ratio).toBeCloseTo(0.4, 1);
    expect(est.band).toBeDefined();
  });

  it("nearly full (95%) bar → fill_ratio ≥ 0.92", () => {
    const est = estimateProgressFillRatio(barImage(0.95));
    expect(est.found).toBe(true);
    expect(est.fill_ratio!).toBeGreaterThanOrEqual(0.92);
  });

  it("anti-aliased (2px ramp) 95% bar → still found, fill_ratio ≥ 0.92", () => {
    const est = estimateProgressFillRatio(barImage(0.95, { rampPx: 2 }));
    expect(est.found).toBe(true);
    expect(est.fill_ratio!).toBeGreaterThanOrEqual(0.92);
  });

  it("gradient / soft-fade bar (wide mid-band) → found:false (sharp-transition gate)", () => {
    expect(estimateProgressFillRatio(barImage(0.5, { gradient: true })).found).toBe(false);
  });

  it("perfectly uniform (100% fill, no track) bar → found:false (no two-level split)", () => {
    // Whole bar is FILL — no track sliver ⇒ split < threshold ⇒ fail closed.
    const png = blank();
    const y0 = Math.round(H * 0.7);
    for (let x = CX0; x < CX1; x++) setRowsCol(png, y0, y0 + 11, x, FILL);
    expect(estimateProgressFillRatio(toB64(png)).found).toBe(false);
  });

  it("full-panel two-tone split (band too tall) → found:false (aspect/height gate)", () => {
    // A tall left/right split panel, not a thin bar.
    const est = estimateProgressFillRatio(barImage(0.5, { y0: 60, y1: 210 }));
    expect(est.found).toBe(false);
  });

  it("off-center / low-fill strip → never reads full (no false release_ready)", () => {
    const est = estimateProgressFillRatio(barImage(0.3));
    // Found as a partial bar is fine; the safety property is it is NOT full.
    expect(est.fill_ratio ?? 0).toBeLessThan(0.92);
  });
});

// ─── Button / ring affordance ────────────────────────────────────────────────

function setPixel(png: PNG, x: number, y: number, v: number): void {
  const i = (png.width * y + x) << 2;
  png.data[i] = v;
  png.data[i + 1] = v;
  png.data[i + 2] = v;
  png.data[i + 3] = 255;
}

const RING_FILL = 40; // dark progress arc
const RING_TRACK = 120; // mid-gray track (still "ink" vs BG=200)

/**
 * Build a crop with a compact, roughly-square BUTTON/RING affordance centered in the
 * crop. A contiguous progress arc of `fillFrac` is drawn FILL starting at the TOP
 * (12 o'clock) and sweeping CLOCKWISE; the remainder of the ring is TRACK. Matches
 * the detector's top-anchored, clockwise convention.
 *   - `solid`    → fill the whole disc (no ring gap): a fully filled button.
 *   - `gradient` → sweep FILL→TRACK around the ring (a soft fade, not a sharp arc).
 */
function ringImage(
  fillFrac: number,
  opts: { solid?: boolean; gradient?: boolean; cx?: number; cy?: number; R?: number } = {},
): string {
  const png = blank();
  const cx = opts.cx ?? W / 2;
  const cy = opts.cy ?? H / 2;
  const rOuter = opts.R ?? 80;
  const rInner = opts.solid ? 0 : rOuter - 24; // 24px-thick ring unless solid
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > rOuter || dist < rInner) continue;
      let ang = Math.atan2(dx, -dy); // top = 0, clockwise
      if (ang < 0) ang += 2 * Math.PI;
      const frac = ang / (2 * Math.PI);
      let v: number;
      if (opts.solid) v = RING_FILL;
      else if (opts.gradient) v = Math.round(RING_FILL + (RING_TRACK - RING_FILL) * frac);
      else v = frac <= fillFrac ? RING_FILL : RING_TRACK;
      setPixel(png, x, y, v);
    }
  }
  return toB64(png);
}

describe("estimateProgressFillRatio — button/ring affordance", () => {
  it("partial (~50%) ring → found but NOT full (no false release_ready)", () => {
    const est = estimateProgressFillRatio(ringImage(0.5));
    expect(est.found).toBe(true);
    expect(est.fill_ratio ?? 0).toBeLessThan(0.92);
  });

  it("near-full (~96%) ring → found, fill_ratio ≥ 0.92 (Release now)", () => {
    const est = estimateProgressFillRatio(ringImage(0.96));
    expect(est.found).toBe(true);
    expect(est.fill_ratio!).toBeGreaterThanOrEqual(0.92);
    expect(est.band).toBeDefined();
  });

  it("early (~8%) ring → never reads full (top-anchored fill disambiguation)", () => {
    const est = estimateProgressFillRatio(ringImage(0.08));
    expect(est.fill_ratio ?? 0).toBeLessThan(0.92);
  });

  it("blank crop → found:false (no button candidate)", () => {
    expect(estimateProgressFillRatio(toB64(blank())).found).toBe(false);
  });

  it("solid filled disc (no track gap) → found:false (no two-level ring split)", () => {
    expect(estimateProgressFillRatio(ringImage(1, { solid: true })).found).toBe(false);
  });

  it("gradient ring (soft fade) → found:false (ambiguous mid-band gate)", () => {
    expect(estimateProgressFillRatio(ringImage(0.5, { gradient: true })).found).toBe(false);
  });
});

describe("analyzeReleaseReady — safe diagnostics", () => {
  it("blank crop → chosen none, no candidate, no button/ring seen", () => {
    const { diagnostics } = analyzeReleaseReady(toB64(blank()));
    expect(diagnostics.chosen_candidate_kind).toBe("none");
    expect(diagnostics.candidate_count_bucket).toBe("0");
    expect(diagnostics.button_like_candidate_seen).toBe(false);
    expect(diagnostics.ring_like_candidate_seen).toBe(false);
  });

  it("full horizontal bar → chosen bar (existing behavior preserved)", () => {
    const { estimate, diagnostics } = analyzeReleaseReady(barImage(0.95));
    expect(estimate.found).toBe(true);
    expect(diagnostics.chosen_candidate_kind).toBe("bar");
  });

  it("near-full ring → chosen ring, button + ring candidate seen", () => {
    const { estimate, diagnostics } = analyzeReleaseReady(ringImage(0.96));
    expect(estimate.found).toBe(true);
    expect(diagnostics.chosen_candidate_kind).toBe("ring");
    expect(diagnostics.button_like_candidate_seen).toBe(true);
    expect(diagnostics.ring_like_candidate_seen).toBe(true);
  });

  it("solid disc → button-like seen but split-rejected (fail closed)", () => {
    const { estimate, diagnostics } = analyzeReleaseReady(ringImage(1, { solid: true }));
    expect(estimate.found).toBe(false);
    expect(diagnostics.button_like_candidate_seen).toBe(true);
    expect(diagnostics.ring_like_candidate_seen).toBe(false);
    expect(diagnostics.rejected_split_bucket).not.toBe("0");
  });

  it("diagnostics fields are safe scalars only (no coords/pixels/text)", () => {
    const { diagnostics } = analyzeReleaseReady(ringImage(0.5));
    for (const v of Object.values(diagnostics)) {
      expect(["string", "boolean"].includes(typeof v)).toBe(true);
    }
  });
});
