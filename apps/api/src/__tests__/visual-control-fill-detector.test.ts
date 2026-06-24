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
  evaluateCompletionSignalsForTests,
  clearControlFillForTests,
  controlFillStateKindForTests,
  controlResolutionForTests,
  advanceControlPlateau,
  plateauWindowForTests,
} from "../runtime/visualControlFillDetector.js";
import type {
  PlateauWindow,
  PlateauFrame,
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
  /** Optional centred completion mark (checkmark) stamped over the control after fill. */
  mark?: { value: number; wFrac?: number; hFrac?: number };
  /** Optional per-pixel jitter amplitude added inside the control (center-shimmer noise). */
  noise?: number;
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
  // Centred completion-mark rectangle (checkmark stand-in), in control-relative pixels.
  const markW = opts.mark ? Math.round((opts.mark.wFrac ?? 0.2) * (x1 - x0)) : 0;
  const markH = opts.mark ? Math.round((opts.mark.hFrac ?? 0.5) * (y1 - y0)) : 0;
  const mcx = (x0 + x1) / 2;
  const mcy = (y0 + y1) / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (W * y + x) << 2;
      let v = bg;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        v = x < boundary ? fill : track;
        if (opts.noise) {
          // Deterministic per-pixel jitter (no Math.random → stable test) in the centre half.
          const jitter = (((x * 73856093) ^ (y * 19349663)) % 1000) / 1000; // [0,1)
          v += Math.round((jitter - 0.5) * 2 * opts.noise);
        }
        if (
          opts.mark &&
          Math.abs(x - mcx) <= markW / 2 &&
          Math.abs(y - mcy) <= markH / 2
        ) {
          v = opts.mark.value;
        }
        v = Math.max(0, Math.min(255, v));
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

// ── Test 4b: anchored row selection — a TALLER ink band OFF the anchor (e.g. a product
// carousel below a B&BW press-and-hold modal) must NOT capture the bounds. The hold-anchor
// crop is centred on the user's press point, so the control sits at the crop centre; a
// longest-run selection used to lock onto whichever ink band was tallest anywhere in the crop
// (the carousel → "near_end") and never measured the real pill filling. ──────────────────────
describe("evaluateControlFill — anchored bounds ignore a taller off-center band", () => {
  // A centred progress pill (y130–160, 30px tall) PLUS a TALLER high-contrast band near the
  // bottom (y220–295, 75px) that never changes between frames — the carousel/footer a
  // longest-run selection would wrongly lock onto.
  function pillPlusCarousel(pillFillFrac: number): string {
    const bg = 230;
    const track = 190;
    const fill = 90;
    const px0 = 80;
    const px1 = 320; // pill width 240, aspect 8 → bar_fill
    const py0 = 130;
    const py1 = 160; // pill centre y ≈ 145 → 0.483 of H
    const cx0 = 30;
    const cx1 = 370;
    const cy0 = 220;
    const cy1 = 295; // carousel 75px tall (> pill's 30) → would win a longest-run pick
    const boundary = px0 + Math.round(pillFillFrac * (px1 - px0));
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (W * y + x) << 2;
        let v = bg;
        if (x >= px0 && x < px1 && y >= py0 && y < py1) {
          v = x < boundary ? fill : track;
        } else if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
          // Deterministic high-contrast checkerboard (both tones are "ink" vs the card bg) so
          // every carousel row reads as a wide ink structure — and it is unchanging, so it can
          // never contribute fill if it were (wrongly) measured.
          v = ((x >> 4) + (y >> 4)) % 2 === 0 ? 40 : 150;
        }
        png.data[o] = v;
        png.data[o + 1] = v;
        png.data[o + 2] = v;
        png.data[o + 3] = 255;
      }
    }
    return PNG.sync.write(png).toString("base64");
  }

  it("locks the centred pill (not the taller bottom band) and fires when the pill fills", () => {
    // Baseline: bounds must resolve to the PILL even though the carousel is taller.
    const f0 = evaluateControlFill(CAP, pillPlusCarousel(0));
    expect(f0.found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_resolved");

    // Filling the PILL must register near-complete and the locked band must sit on the pill
    // (~0.48), not the bottom carousel (~0.86) a longest-run pick would have chosen.
    const f1 = evaluateControlFill(CAP, pillPlusCarousel(0.95));
    expect(f1.found).toBe(true);
    expect(f1.band!.y_center).toBeLessThan(0.6);
    expect(f1.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);

    // Earns the normal 2-frame, position-stable streak and fires.
    const f2 = evaluateControlFill(CAP, pillPlusCarousel(0.95));
    const a1 = advanceReleaseReady(0, undefined, f1);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, f2);
    expect(a2.fire).toBe(true);
  });
});

// ── Test 4c: anchor-centered, shape-agnostic control resolution. ─────────────────────────
// The control is whatever CONTAINS the hold anchor (crop centre) — filled, outlined, or
// bordered; rectangular OR rounded/pill. No roundness, colour, or text requirement.
describe("evaluateControlFill — anchor-centered shape-agnostic resolution", () => {
  const bg = 235;
  const inkVal = 70; // border/fill luminance (any colour; |ink−bg| ≫ contrast)

  // Distance from (x,y) to a horizontal stadium spine — < r is inside a rounded pill, ≤ x0/x1
  // square ends is inside a plain rectangle. One builder covers both shapes + a L→R fill.
  function control(opts: {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    rounded: boolean;
    /** Border thickness in px. 0 ⇒ a solid filled block (filled_band). */
    border: number;
    /** Left-to-right interior fill fraction (0 = empty/unfilled baseline). */
    fillFrac: number;
    /** Optional taller solid band BELOW the control (a carousel/footer distractor). */
    carousel?: { y0: number; y1: number };
  }): string {
    const { x0, x1, y0, y1, rounded, border } = opts;
    const cy = (y0 + y1) / 2;
    const r = (y1 - y0) / 2;
    const xa = x0 + r;
    const xb = x1 - r;
    const boundary = x0 + opts.fillFrac * (x1 - x0);
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (W * y + x) << 2;
        let v = bg;
        // Distance into the control body (rounded → stadium SDF; square → box inset).
        let inside = false;
        let edgeDist = 0; // distance from the nearest control edge (for the border ring)
        if (rounded) {
          const px = Math.min(Math.max(x, xa), xb);
          const d = Math.hypot(x - px, y - cy);
          inside = d <= r;
          edgeDist = r - d;
        } else {
          inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
          edgeDist = Math.min(x - x0, x1 - x, y - y0, y1 - y);
        }
        if (inside) {
          if (border > 0 && edgeDist < border) {
            v = inkVal; // outline/border ring
          } else if (x <= boundary) {
            v = inkVal; // filled portion (or the whole body when border === 0)
          }
          // else: hollow interior stays background
        }
        if (opts.carousel && y >= opts.carousel.y0 && y <= opts.carousel.y1 && x >= 20 && x <= 380) {
          v = ((x >> 4) + (y >> 4)) % 2 === 0 ? 40 : 150; // high-contrast distractor band
        }
        png.data[o] = v;
        png.data[o + 1] = v;
        png.data[o + 2] = v;
        png.data[o + 3] = 255;
      }
    }
    return PNG.sync.write(png).toString("base64");
  }

  // 1. B&BW-style OUTLINED ROUNDED PILL: empty outline baseline → fills L→R → fires.
  it("resolves a B&BW-style outlined rounded pill and fires when it fills", () => {
    const box = { x0: 70, x1: 330, y0: 120, y1: 180, rounded: true, border: 5 };
    const f0 = evaluateControlFill(CAP, control({ ...box, fillFrac: 0 }));
    expect(f0.found).toBe(false);
    expect(controlResolutionForTests(CAP)).toBe("outlined_control");

    const f1 = evaluateControlFill(CAP, control({ ...box, fillFrac: 1.0 }));
    expect(f1.found).toBe(true);
    expect(f1.band!.y_center).toBeGreaterThan(0.4);
    expect(f1.band!.y_center).toBeLessThan(0.6);
    expect(f1.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    const f2 = evaluateControlFill(CAP, control({ ...box, fillFrac: 1.0 }));
    const a1 = advanceReleaseReady(0, undefined, f1);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, f2);
    expect(a2.fire).toBe(true);
  });

  // 2. PLAIN OUTLINED RECTANGLE (no rounded caps, no colour).
  it("resolves a plain outlined rectangle (square corners)", () => {
    const box = { x0: 80, x1: 320, y0: 120, y1: 180, rounded: false, border: 4 };
    const f0 = evaluateControlFill(CAP, control({ ...box, fillFrac: 0 }));
    expect(f0.found).toBe(false);
    expect(controlResolutionForTests(CAP)).toBe("outlined_control");
    const f1 = evaluateControlFill(CAP, control({ ...box, fillFrac: 1.0 }));
    expect(f1.found).toBe(true);
    expect(f1.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
  });

  // 3. SOLID FILLED RECTANGLE — anchor sits ON ink → filled_band.
  it("resolves a solid filled rectangle as filled_band", () => {
    // border 0 ⇒ the whole body is ink at every fillFrac; baseline is already solid.
    const box = { x0: 80, x1: 320, y0: 125, y1: 175, rounded: false, border: 0 };
    evaluateControlFill(CAP, control({ ...box, fillFrac: 1.0 })); // baseline (solid)
    expect(controlResolutionForTests(CAP)).toBe("filled_band");
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_resolved");
  });

  // 4. A TALLER carousel/background band below the anchor MUST NOT win — the centred control does.
  it("ignores a taller distractor band below the anchor", () => {
    const box = {
      x0: 80,
      x1: 320,
      y0: 120,
      y1: 175,
      rounded: true,
      border: 5,
      carousel: { y0: 215, y1: 295 }, // 80px tall — taller than the 55px pill
    };
    const f0 = evaluateControlFill(CAP, control({ ...box, fillFrac: 0 }));
    expect(f0.found).toBe(false);
    // Locked on the pill at the anchor, not the bottom band (~0.85).
    expect(["outlined_control", "bordered_control"]).toContain(controlResolutionForTests(CAP));
    const f1 = evaluateControlFill(CAP, control({ ...box, fillFrac: 1.0 }));
    expect(f1.found).toBe(true);
    expect(f1.band!.y_center).toBeLessThan(0.6);
  });

  // 5. AMBIGUOUS / NOISY anchor area — no enclosing control → fail closed.
  it("fails closed on a noisy anchor area with no enclosing control", () => {
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (W * y + x) << 2;
        // Deterministic scattered specks near the centre — never a connected frame around it.
        const speck = (((x * 49297) ^ (y * 233280)) % 100) < 6 && Math.abs(y - 150) < 70;
        const v = speck ? 60 : bg;
        png.data[o] = v;
        png.data[o + 1] = v;
        png.data[o + 2] = v;
        png.data[o + 3] = 255;
      }
    }
    const noisy = PNG.sync.write(png).toString("base64");
    expect(evaluateControlFill(CAP, noisy).found).toBe(false);
    expect(controlResolutionForTests(CAP)).toBe("unresolved");
    // A later strongly-filled frame still cannot fire — no bounds were ever locked.
    expect(evaluateControlFill(CAP, noisy).found).toBe(false);
  });
});

// ── Test 5: fail-closed robustness. ──────────────────────────────────────────────
describe("evaluateControlFill — robustness", () => {
  it("garbage base64 fails closed (never throws, no state)", () => {
    expect(evaluateControlFill(CAP, "not-a-real-png").found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("none");
  });
});

// ── Test 6: the B&BW bug — two-tone baseline + solid completion. ──────────────────
// The locked baseline is ALREADY half-filled (two-tone), so the previously-filled columns
// never transition and the geometric column count stays ~0.5 (lt50). The uniform-solid
// completion signal recognises completion regardless, and fires through the SAME 2-frame
// streak (no temporally_confirmed).
describe("evaluateControlFill — two-tone baseline + solid completion (B&BW)", () => {
  it("column fill stays < 0.92 but uniformFillSignal lifts it to release-capable", () => {
    const baseline = controlImage({ fillFrac: 0.5 }); // already half-blue at lock time
    const solid = controlImage({ fillFrac: 1.0 }); // uniform solid completion

    const signals = evaluateCompletionSignalsForTests(baseline, solid)!;
    expect(signals).not.toBeNull();
    // The geometric estimate alone is the bug: it under-reads the completed control.
    expect(signals.columnFillRatio).toBeLessThan(FULL_RATIO_THRESHOLD);
    expect(signals.uniformFillSignal).toBe(true);
    expect(signals.effectiveFillRatio).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    expect(signals.chosenReleaseReason).toBe("solid_state");

    // End-to-end: baseline locks, two solid frames earn the normal 2-frame streak.
    expect(evaluateControlFill(CAP, baseline).found).toBe(false);
    const f1 = evaluateControlFill(CAP, solid);
    const f2 = evaluateControlFill(CAP, solid);
    expect(f1.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    expect(f1.temporally_confirmed).toBeUndefined();
    const a1 = advanceReleaseReady(0, undefined, f1);
    expect(a1.fire).toBe(false);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, f2);
    expect(a2.fire).toBe(true);
    expect(a2.consecutiveFull).toBe(VGC_RELEASE_READY_CONSECUTIVE);
  });

  it("a still-half-filled current with weak center noise is NOT release-capable", () => {
    const baseline = controlImage({ fillFrac: 0.5 });
    // Still two-tone (no completion), just mild sub-threshold shimmer in the control.
    const noisy = controlImage({ fillFrac: 0.5, noise: 18 });
    const signals = evaluateCompletionSignalsForTests(baseline, noisy)!;
    expect(signals.uniformFillSignal).toBe(false);
    expect(signals.completedMarkerSeen).toBe(false);
    expect(signals.chosenReleaseReason).toBe("none");
    expect(signals.effectiveFillRatio).toBeLessThan(FULL_RATIO_THRESHOLD);
  });
});

// ── Test 7: completed state with a centre checkmark fires after 2-frame confirm. ──
describe("evaluateControlFill — completed state with centre checkmark", () => {
  it("two-tone baseline → solid + checkmark fires only after the 2-frame streak", () => {
    const baseline = controlImage({ fillFrac: 0.5 });
    const done = controlImage({ fillFrac: 1.0, mark: { value: 255, wFrac: 0.22, hFrac: 0.4 } });

    expect(evaluateControlFill(CAP, baseline).found).toBe(false);
    const f1 = evaluateControlFill(CAP, done);
    const f2 = evaluateControlFill(CAP, done);
    expect(f1.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    const a1 = advanceReleaseReady(0, undefined, f1);
    expect(a1.fire).toBe(false); // never fires on a single full frame
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, f2);
    expect(a2.fire).toBe(true);
  });

  it("a checkmark on an ALREADY-solid baseline fires via the completed_marker path", () => {
    // Baseline already uniform-solid (little area changes), so the ONLY completion evidence
    // is the compact centre mark appearing — exercises the completed_marker branch directly.
    const baseSolid = controlImage({ fillFrac: 1.0 });
    const withMark = controlImage({ fillFrac: 1.0, mark: { value: 255, wFrac: 0.2, hFrac: 0.2 } });
    const signals = evaluateCompletionSignalsForTests(baseSolid, withMark)!;
    expect(signals.uniformFillSignal).toBe(false); // little area change vs a uniform baseline
    expect(signals.completedMarkerSeen).toBe(true);
    expect(signals.chosenReleaseReason).toBe("completed_marker");
    expect(signals.effectiveFillRatio).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
  });
});

// ── Test 8: completed-state signals are color/polarity agnostic. ──────────────────
describe("evaluateControlFill — completed-state signals are color/polarity agnostic", () => {
  it("darker-fill, lighter-fill, and inverted-polarity completions all read solid_state", () => {
    const variants = [
      { bg: 230, track: 190, fill: 90 }, // dark fill on light card
      { bg: 60, track: 110, fill: 30 }, // darker overall
      { bg: 30, track: 70, fill: 170 }, // INVERTED: light fill on dark card
    ];
    for (const v of variants) {
      const baseline = controlImage({ fillFrac: 0.5, ...v });
      const solid = controlImage({ fillFrac: 1.0, ...v });
      const signals = evaluateCompletionSignalsForTests(baseline, solid)!;
      expect(signals).not.toBeNull();
      expect(signals.uniformFillSignal).toBe(true);
      expect(signals.chosenReleaseReason).toBe("solid_state");
      expect(signals.effectiveFillRatio).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    }
  });
});

// ── Test 9: strong centre shimmer over a PARTIAL bar must not false-fire. ─────────
describe("evaluateControlFill — centre shimmer over a partial bar never fires", () => {
  it("a strong centre mark on a non-solid surround stays not-release-capable", () => {
    const baseline = controlImage({ fillFrac: 0.5 });
    // Still bimodal (no completion) but with a strong bright centre mark (false 'completion').
    const shimmer = controlImage({ fillFrac: 0.5, mark: { value: 255, wFrac: 0.2, hFrac: 0.5 } });
    const signals = evaluateCompletionSignalsForTests(baseline, shimmer)!;
    // The surround is NOT solid, so the marker gate refuses it and uniform is false.
    expect(signals.uniformFillSignal).toBe(false);
    expect(signals.completedMarkerSeen).toBe(false);
    expect(signals.chosenReleaseReason).toBe("none");
    expect(signals.effectiveFillRatio).toBeLessThan(FULL_RATIO_THRESHOLD);
  });

  it("the slow 50–75% plateau keeps the completed-state signals off", () => {
    const baseline = controlImage({ fillFrac: 0 });
    for (const frac of [0.5, 0.6, 0.7, 0.74]) {
      const s = evaluateCompletionSignalsForTests(baseline, controlImage({ fillFrac: frac }))!;
      expect(s.uniformFillSignal).toBe(false);
      expect(s.completedMarkerSeen).toBe(false);
      expect(s.chosenReleaseReason).toBe("none");
    }
  });
});

// ── Test 10: the dev-only measurement-diagnostics patch must not change the agent-facing
// return shape. `evaluateControlFill` still returns ONLY the ProgressFillEstimate fields —
// the new bucket/enum diagnostics live in disk-only debug crops, never on the estimate. ──
describe("evaluateControlFill — agent-facing return shape is unchanged", () => {
  it("a measured estimate exposes only found/fill_ratio/band (no diagnostics leak)", () => {
    evaluateControlFill(CAP, controlImage({ fillFrac: 0 })); // baseline lock
    const est = evaluateControlFill(CAP, controlImage({ fillFrac: 0.6 }));
    expect(est.found).toBe(true);
    // The estimate carries no measurement-diagnostic fields — those are disk-only.
    const allowed = new Set(["found", "fill_ratio", "band", "temporally_confirmed"]);
    for (const k of Object.keys(est)) expect(allowed.has(k)).toBe(true);
    expect((est as unknown as Record<string, unknown>).measurement).toBeUndefined();
    expect((est as unknown as Record<string, unknown>).control_bounds_status).toBeUndefined();
  });

  it("a not-found estimate is just { found:false }", () => {
    const est = evaluateControlFill(CAP, blank());
    expect(est.found).toBe(false);
    for (const k of Object.keys(est)) expect(k).toBe("found");
  });
});

// ── Test 11: high-stable-control-plateau — a control that holds a high (75_92) fill with
// material change but never reaches ge92 (the live B&BW completed state that plateaus below
// ge92). The pure `advanceControlPlateau` decision is tested directly with synthetic per-frame
// scalars (mirrors the `advanceReleaseReady` style); two end-to-end pixel paths confirm the
// wiring. This path is STRICTLY MORE CONSERVATIVE than the instantaneous reasons (≥4 probes,
// ≥3s, "most of window" material change) and only RAISES the ratio so the unchanged outer
// 0.92 / 2-frame streak still owns the fire. It NEVER lowers the global ge92 threshold and is
// never the whole-crop temporal plateau. ──
describe("evaluateControlFill — high-stable-control-plateau (75_92 sustained release)", () => {
  const EMPTY: PlateauWindow = {
    count: 0,
    startMs: 0,
    changedAreaOkCount: 0,
    regressionSeen: false,
  };

  /** Drive a sequence of frames through the pure helper, returning the last advance + whether it
   *  ever fired across the run. `gateOk` defaults true (resolved, locked, anchor-centered control,
   *  no stronger reason). */
  function runPlateau(
    frames: PlateauFrame[],
    gateOk = true,
  ): { everFired: boolean; window: PlateauWindow } {
    let window = EMPTY;
    let everFired = false;
    for (const f of frames) {
      const adv = advanceControlPlateau(window, f, gateOk);
      window = adv.window;
      if (adv.fired) {
        everFired = true;
        expect(adv.reason).toBe("high_stable_control_plateau");
      } else {
        expect(adv.reason).toBe("none");
      }
    }
    return { everFired, window };
  }

  // 1. Sustained 75_92 with material change for ≥4 probes and ≥3s → release-capable, then fires
  //    through the existing 2-frame streak.
  it("ramps to 75_92 and holds with material change → fires after the required streak", () => {
    // Four in-band frames (columnFill 0.85), strong changed-area, 1s apart (window spans 3s).
    const frames: PlateauFrame[] = [0, 1000, 2000, 3000].map((nowMs) => ({
      columnFillRatio: 0.85,
      changedAreaRatio: 0.85,
      nowMs,
    }));
    // Frames 1–3 cannot fire (count < 4 and/or < 3s); the 4th frame satisfies every gate.
    let window = EMPTY;
    const fires: boolean[] = [];
    for (const f of frames) {
      const adv = advanceControlPlateau(window, f, true);
      window = adv.window;
      fires.push(adv.fired);
    }
    expect(fires).toEqual([false, false, false, true]);
    expect(window.count).toBe(4);
    expect(window.regressionSeen).toBe(false);

    // End-to-end through the pixel pipeline: a control stuck at ~85% fill (never ge92, never
    // uniform) reaches release-capable via the plateau and then fires the outer 2-frame streak.
    clearControlFillForTests();
    // Baseline (unfilled) at t=0 → locks bounds, cannot measure yet.
    expect(evaluateControlFill(CAP, controlImage({ fillFrac: 0 }), 0).found).toBe(false);
    // Frames 1–3 at 85% fill: found, but below 0.92 (plateau not yet earned).
    for (const t of [1000, 2000, 3000]) {
      const e = evaluateControlFill(CAP, controlImage({ fillFrac: 0.85 }), t);
      expect(e.found).toBe(true);
      expect(e.fill_ratio!).toBeLessThan(FULL_RATIO_THRESHOLD);
    }
    // Frame 4 (t=4000): window count 4, spans ≥3s from the first in-band frame → release-capable.
    const f4 = evaluateControlFill(CAP, controlImage({ fillFrac: 0.85 }), 4000);
    expect(f4.found).toBe(true);
    expect(f4.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    expect(f4.temporally_confirmed).toBeUndefined(); // still earns the outer streak
    const f5 = evaluateControlFill(CAP, controlImage({ fillFrac: 0.85 }), 5000);
    const a1 = advanceReleaseReady(0, undefined, f4);
    expect(a1.fire).toBe(false); // a single release-capable plateau frame never fires
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, f5);
    expect(a2.fire).toBe(true);
    expect(a2.consecutiveFull).toBe(VGC_RELEASE_READY_CONSECUTIVE);
  });

  // 2. A control stuck at 50–75% (below the 75_92 band) never enters the window → never fires.
  it("stuck at 50_75 (below the band) → never enters the window, never fires", () => {
    const frames: PlateauFrame[] = [0, 1000, 2000, 3000, 4000, 5000].map((nowMs) => ({
      columnFillRatio: 0.6,
      changedAreaRatio: 0.85,
      nowMs,
    }));
    const { everFired, window } = runPlateau(frames);
    expect(everFired).toBe(false);
    expect(window.count).toBe(0); // every frame is a regression (below PLATEAU_FILL_LO)
  });

  // 3. Briefly hits 75_92 then regresses below the band → window resets, never reaches 4, no fire.
  it("hits 75_92 briefly then regresses → window resets, regression flagged, never fires", () => {
    const frames: PlateauFrame[] = [
      { columnFillRatio: 0.85, changedAreaRatio: 0.85, nowMs: 0 },
      { columnFillRatio: 0.85, changedAreaRatio: 0.85, nowMs: 1000 },
      { columnFillRatio: 0.85, changedAreaRatio: 0.85, nowMs: 2000 },
      { columnFillRatio: 0.5, changedAreaRatio: 0.85, nowMs: 3000 }, // regression below the band
      { columnFillRatio: 0.85, changedAreaRatio: 0.85, nowMs: 4000 }, // window restarts at 1
    ];
    const { everFired, window } = runPlateau(frames);
    expect(everFired).toBe(false);
    expect(window.regressionSeen).toBe(true); // sticky across the reset
    expect(window.count).toBe(1); // restarted after the regression
  });

  // 4. Held at 75_92 long enough, but changed-area stays too low (< 50_75) → no material change,
  //    no fire (coverage + firing-frame guards both refuse it).
  it("75_92 sustained but changed_area too low → never fires", () => {
    const frames: PlateauFrame[] = [0, 1000, 2000, 3000, 4000, 5000].map((nowMs) => ({
      columnFillRatio: 0.85,
      changedAreaRatio: 0.3, // below PLATEAU_CHANGED_AREA_MIN (0.5)
      nowMs,
    }));
    const { everFired, window } = runPlateau(frames);
    expect(everFired).toBe(false);
    expect(window.count).toBe(6); // window grows (in-band) ...
    expect(window.changedAreaOkCount).toBe(0); // ... but no frame cleared the change floor
  });

  // 5a. Gate closed (e.g. unresolved/non-anchor bounds or a stronger reason already fired) → an
  //     otherwise-qualifying sequence still never fires.
  it("gate closed → otherwise-qualifying frames never fire", () => {
    const frames: PlateauFrame[] = [0, 1000, 2000, 3000, 4000].map((nowMs) => ({
      columnFillRatio: 0.85,
      changedAreaRatio: 0.85,
      nowMs,
    }));
    const { everFired } = runPlateau(frames, /* gateOk */ false);
    expect(everFired).toBe(false);
  });

  // 5b. End-to-end: an unresolved baseline (no control bounds) never produces a plateau window —
  //     fails closed for the whole hold regardless of later high-fill frames.
  it("unresolved baseline → no plateau window, always found:false", () => {
    clearControlFillForTests();
    expect(evaluateControlFill(CAP, blank(), 0).found).toBe(false);
    expect(controlFillStateKindForTests(CAP)).toBe("tracking_unresolved");
    for (const t of [1000, 2000, 3000, 4000, 5000]) {
      expect(evaluateControlFill(CAP, controlImage({ fillFrac: 0.85 }), t).found).toBe(false);
    }
    expect(plateauWindowForTests(CAP)!.count).toBe(0);
  });

  // 6. The instantaneous ge92 path is unchanged: a full bar still fires via `column_fill_ge92`
  //    in the normal 2 frames WITHOUT the plateau's ≥3s / ≥4-probe gate (proves the plateau did
  //    not replace or weaken the existing release reasons, and never lowers the ge92 threshold).
  it("a ge92 frame still fires via column_fill_ge92 in 2 frames (no plateau gate)", () => {
    const signals = evaluateCompletionSignalsForTests(
      controlImage({ fillFrac: 0 }),
      controlImage({ fillFrac: 1.0 }),
    )!;
    expect(signals.chosenReleaseReason).toBe("column_fill_ge92");

    clearControlFillForTests();
    // Two full frames only ~1ms apart in wall-clock (far under PLATEAU_MIN_HOLD_MS) still fire —
    // the instantaneous ge92 path owns this, the plateau gate is irrelevant here.
    expect(evaluateControlFill(CAP, controlImage({ fillFrac: 0 }), 0).found).toBe(false);
    const f1 = evaluateControlFill(CAP, controlImage({ fillFrac: 1.0 }), 1);
    const f2 = evaluateControlFill(CAP, controlImage({ fillFrac: 1.0 }), 2);
    expect(f1.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    const a1 = advanceReleaseReady(0, undefined, f1);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, f2);
    expect(a2.fire).toBe(true);
  });
});
