/**
 * Color-Agnostic Control-Fill Detector — pure + stateful suite (no Chromium).
 *
 * This is the SOLE release-ready ("Release now") trigger after the safety patch. It answers
 * "is the actual visual progress control geometrically full?" — NOT "did the crop stop
 * changing?". It locks the control bounds from the hold's UNFILLED baseline, then measures
 * how many control columns have transitioned vs that baseline. It is color/polarity agnostic
 * (absolute luminance difference) and fill-direction agnostic (transitioned cols / total).
 *
 * Pins:
 *   - a short B&BW-like sequence (baseline → ~95% filled) reaches fill_ratio ≥ 0.92 and fires
 *     through the unchanged 0.92 / 2-frame streak machine at the visually complete frame;
 *   - a long, slow, plateau-like run stuck at 50–75% fill NEVER reaches 0.92 → never fires
 *     (the core premature-fire bug this replaces);
 *   - the same geometry with INVERTED luminance polarity yields the same fill estimate (no
 *     blue/hue assumptions);
 *   - low-contrast / too-small / too-broad / off-center baselines fail closed (found:false);
 *   - a found estimate is never temporally_confirmed (it must earn the 2-frame streak).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PNG } from "pngjs";

import {
  evaluateControlFill,
  clearControlFillForTests,
  controlFillStateKindForTests,
} from "../runtime/visualControlFillDetector.js";
import {
  advanceReleaseReady,
  VGC_RELEASE_READY_CONSECUTIVE,
  FULL_RATIO_THRESHOLD,
} from "../runtime/visualHandoffMonitor.js";

const W = 400;
const H = 300;

interface ControlOpts {
  bg?: number;
  track?: number;
  fill?: number;
  /** Fraction of the control width that is FILL (left-to-right). 0 = unfilled baseline. */
  fillFrac: number;
  /** Control pixel bounds (inclusive-ish: [x0,x1) × [y0,y1)). */
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
}

/**
 * Draw a horizontal pill/bar control on a solid card. The control region is TRACK; its left
 * `fillFrac` is FILL. Color-agnostic: pass any bg/track/fill luminances (incl. inverted
 * polarity) as long as |track−bg| and |fill−track| are large enough.
 */
function controlImage(opts: ControlOpts): string {
  const bg = opts.bg ?? 230;
  const track = opts.track ?? 190;
  const fill = opts.fill ?? 90;
  const x0 = opts.x0 ?? 80;
  const x1 = opts.x1 ?? 320; // width 240
  const y0 = opts.y0 ?? 130;
  const y1 = opts.y1 ?? 160; // height 30 → aspect 8 → bar_fill
  const png = new PNG({ width: W, height: H });
  const boundary = x0 + Math.round(opts.fillFrac * (x1 - x0));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (W * y + x) << 2;
      let v = bg;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        v = x < boundary ? fill : track;
      }
      png.data[o] = v;
      png.data[o + 1] = v;
      png.data[o + 2] = v;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

function blank(gray = 230): string {
  return controlImage({ fillFrac: 0, x0: 0, x1: 0, y0: 0, y1: 0, bg: gray });
}

const CAP = "vgc_control_fill_test";

beforeEach(() => {
  clearControlFillForTests();
});

// ── Test 1: short B&BW-like success — fills to ~95%, fires at the complete frame. ──
describe("evaluateControlFill — short success sequence reaches ≥0.92 and fires", () => {
  it("baseline → ~95% filled reaches fill_ratio ≥ 0.92 and the band is stable", () => {
    // Frame 0: unfilled baseline — locks bounds, cannot measure yet.
    const f0 = evaluateControlFill(CAP, controlImage({ fillFrac: 0 }));
    expect(f0.found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_resolved");

    // Frame 1: ~95% filled vs baseline → near-complete.
    const f1 = evaluateControlFill(CAP, controlImage({ fillFrac: 0.95 }));
    expect(f1.found).toBe(true);
    expect(f1.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    expect(f1.band).toBeDefined();
    // No single-frame confirmation: the instantaneous read must earn the outer streak.
    expect(f1.temporally_confirmed).toBeUndefined();

    // Frame 2: still ~95% — same locked band → streak completes and fires.
    const f2 = evaluateControlFill(CAP, controlImage({ fillFrac: 0.95 }));
    expect(f2.found).toBe(true);
    expect(f2.band).toEqual(f1.band); // baseline-locked bounds → stable across frames

    const a1 = advanceReleaseReady(0, undefined, f1);
    expect(a1.fire).toBe(false);
    expect(a1.consecutiveFull).toBe(1);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, f2);
    expect(a2.fire).toBe(true);
    expect(a2.consecutiveFull).toBe(VGC_RELEASE_READY_CONSECUTIVE);
  });

  it("fill_ratio tracks the visual fill fraction monotonically", () => {
    evaluateControlFill(CAP, controlImage({ fillFrac: 0 })); // baseline
    const quarter = evaluateControlFill(CAP, controlImage({ fillFrac: 0.25 }));
    const half = evaluateControlFill(CAP, controlImage({ fillFrac: 0.5 }));
    const full = evaluateControlFill(CAP, controlImage({ fillFrac: 1.0 }));
    expect(quarter.fill_ratio!).toBeGreaterThan(0.15);
    expect(quarter.fill_ratio!).toBeLessThan(0.4);
    expect(half.fill_ratio!).toBeGreaterThan(quarter.fill_ratio!);
    expect(full.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
  });
});

// ── Test 2: long, slow, plateau-like run at 50–75% NEVER fires (the core bug). ─────
describe("evaluateControlFill — slow long run stuck below complete never fires", () => {
  it("a plateau-like sequence at 50–75% fill stays < 0.92 and never fires", () => {
    evaluateControlFill(CAP, controlImage({ fillFrac: 0 })); // baseline
    // Slow per-frame movement (low recent change) that looks like a plateau to the temporal
    // detector, but the control is only ~half to three-quarters full.
    const fracs = [0.5, 0.52, 0.55, 0.6, 0.63, 0.66, 0.7, 0.72, 0.74];
    let streak = 0;
    let lastBand: ReturnType<typeof advanceReleaseReady>["lastBand"] = undefined;
    let everFired = false;
    for (const frac of fracs) {
      const est = evaluateControlFill(CAP, controlImage({ fillFrac: frac }));
      expect(est.found).toBe(true);
      expect(est.fill_ratio!).toBeLessThan(FULL_RATIO_THRESHOLD);
      const adv = advanceReleaseReady(streak, lastBand, est);
      streak = adv.consecutiveFull;
      lastBand = adv.lastBand;
      if (adv.fire) everFired = true;
    }
    expect(everFired).toBe(false);
  });
});

// ── Test 3: color-agnostic — inverted luminance polarity estimates the same fill. ──
describe("evaluateControlFill — color/polarity agnostic", () => {
  it("dark-on-light and light-on-dark geometry yield the same fill estimate", () => {
    // Variant A: light card, darker track, dark fill.
    evaluateControlFill("capA", controlImage({ fillFrac: 0, bg: 230, track: 190, fill: 90 }));
    const a = evaluateControlFill("capA", controlImage({ fillFrac: 0.6, bg: 230, track: 190, fill: 90 }));

    // Variant B: INVERTED — dark card, lighter track, light fill (no blue/hue assumption).
    evaluateControlFill("capB", controlImage({ fillFrac: 0, bg: 30, track: 70, fill: 170 }));
    const b = evaluateControlFill("capB", controlImage({ fillFrac: 0.6, bg: 30, track: 70, fill: 170 }));

    expect(a.found).toBe(true);
    expect(b.found).toBe(true);
    expect(a.fill_ratio!).toBeCloseTo(b.fill_ratio!, 5);
    expect(a.fill_ratio!).toBeGreaterThan(0.5);
    expect(a.fill_ratio!).toBeLessThan(0.75);
  });
});

// ── Test 4: bounds resolution fails closed for non-control baselines. ─────────────
describe("evaluateControlFill — baseline bounds rejection fails closed", () => {
  it("a uniform (no-contrast) baseline never resolves a control → always found:false", () => {
    expect(evaluateControlFill(CAP, blank()).found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_unresolved");
    // Even a later strongly-filled frame cannot fire — bounds were never locked.
    expect(evaluateControlFill(CAP, controlImage({ fillFrac: 1.0 })).found).toBe(false);
  });

  it("a thin (height < min) control baseline → found:false (too_small)", () => {
    // height 4 < MIN_CONTROL_H_PX.
    expect(evaluateControlFill(CAP, controlImage({ fillFrac: 0, y0: 148, y1: 152 })).found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_unresolved");
  });

  it("a near-full-height block baseline → found:false (too_broad, not a control)", () => {
    // height 240 (> 0.7·H) spanning most of the crop — engulfs the card.
    expect(evaluateControlFill(CAP, controlImage({ fillFrac: 0, x0: 20, x1: 380, y0: 40, y1: 280 })).found).toBe(
      false,
    );
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_unresolved");
  });

  it("a square (bad-aspect) control baseline → found:false", () => {
    // 130×130 → aspect ~1 < MIN_CONTROL_ASPECT (and wide enough to form a row band).
    expect(evaluateControlFill(CAP, controlImage({ fillFrac: 0, x0: 135, x1: 265, y0: 85, y1: 215 })).found).toBe(
      false,
    );
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_unresolved");
  });

  it("an off-center (bottom-edge) control baseline → found:false", () => {
    // cy ≈ 0.973 > CENTER_Y_HI.
    expect(evaluateControlFill(CAP, controlImage({ fillFrac: 0, y0: 288, y1: 296 })).found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_unresolved");
  });
});

// ── Test 5: fail-closed robustness. ──────────────────────────────────────────────
describe("evaluateControlFill — robustness", () => {
  it("garbage base64 fails closed (never throws, no state)", () => {
    expect(evaluateControlFill(CAP, "not-a-real-png").found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("none");
  });
});
