/**
 * Release-Ready Seam Decision — routing/short-circuit suite (no Chromium, detectors mocked).
 *
 * Pins the fix for the bug where a PARTIAL per-shape estimate (`found:true` with
 * `fill_ratio < FULL_RATIO_THRESHOLD`) short-circuited the seam and BLOCKED the
 * color-agnostic control-fill detector (the sole release trigger), so `release_ready`
 * never fired even when the control was visually complete.
 *
 * The two detectors run on the SAME crop in production, so divergent primary/control
 * results can only be exercised by mocking them. `FULL_RATIO_THRESHOLD` and the
 * test-only clear helpers are preserved from the real modules (spread of importOriginal);
 * only `estimateProgressFillRatio` and `evaluateControlFill` are overridden.
 *
 * Invariants pinned here:
 *   - a RELEASE-CAPABLE primary short-circuits (control-fill never runs);
 *   - a PARTIAL primary does NOT block control-fill;
 *   - the seam returns the more release-capable of {partial primary, control} (ties → control);
 *   - control-fill not found ⇒ the partial primary is surfaced (telemetry), never discarded;
 *   - whole-crop telemetry still runs but never changes the returned estimate;
 *   - the strict `hold_anchor` source gate is preserved (control-fill/whole-crop never run
 *     for other crop sources);
 *   - firing is unchanged downstream — a returned estimate only fires at ≥ threshold + streak.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PNG } from "pngjs";

// Shared mutable estimates the mocked detectors return; set per test. Hoisted so the
// vi.mock factories (evaluated before imports) can close over them.
const h = vi.hoisted(() => ({
  primary: { found: false } as { found: boolean; fill_ratio?: number; band?: unknown },
  control: { found: false } as { found: boolean; fill_ratio?: number; band?: unknown },
}));

vi.mock("../runtime/visualReleaseReadyDetector.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, estimateProgressFillRatio: vi.fn(() => h.primary) };
});

vi.mock("../runtime/visualControlFillDetector.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, evaluateControlFill: vi.fn(() => h.control) };
});

import {
  estimateReleaseReadyWithWholeCropFallback,
  clearWholeCropProgressForTests,
  wholeCropStateKindForTests,
} from "../runtime/visualReleaseReadyWholeCrop.js";
import { evaluateControlFill } from "../runtime/visualControlFillDetector.js";
import {
  advanceReleaseReady,
  VGC_RELEASE_READY_CONSECUTIVE,
  FULL_RATIO_THRESHOLD,
} from "../runtime/visualHandoffMonitor.js";

// A real, decodable crop so the (unmocked) whole-crop telemetry path can run on the
// "control not found" branch and create its tracking state — the observable proof it ran.
function solidPng(gray: number, w = 60, h2 = 40): string {
  const png = new PNG({ width: w, height: h2 });
  for (let i = 0; i < w * h2; i++) {
    const o = i << 2;
    png.data[o] = gray;
    png.data[o + 1] = gray;
    png.data[o + 2] = gray;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png).toString("base64");
}

const CAP = "vgc_seam_choice_test";
const BAND_A = { y_center: 0.7, x0: 0.1, x1: 0.9 };
const BAND_B = { y_center: 0.72, x0: 0.12, x1: 0.92 };

beforeEach(() => {
  vi.clearAllMocks();
  clearWholeCropProgressForTests();
  h.primary = { found: false };
  h.control = { found: false };
});

describe("estimateReleaseReadyWithWholeCropFallback — partial primary must not block control-fill", () => {
  it("partial primary (50_75) + ge92 control → chooses control; fires after the streak", () => {
    h.primary = { found: true, fill_ratio: 0.6, band: BAND_A };
    h.control = { found: true, fill_ratio: 0.95, band: BAND_B };

    const est = estimateReleaseReadyWithWholeCropFallback(CAP, solidPng(120), "hold_anchor");

    // The partial primary did NOT short-circuit — control-fill ran and won.
    expect(vi.mocked(evaluateControlFill)).toHaveBeenCalledTimes(1);
    expect(est).toBe(h.control);
    expect(est.fill_ratio!).toBeGreaterThanOrEqual(FULL_RATIO_THRESHOLD);
    expect(est.band).toBe(BAND_B);

    // Firing is unchanged: a single full frame does not fire; two stable frames do.
    const a1 = advanceReleaseReady(0, undefined, est);
    expect(a1.fire).toBe(false);
    const a2 = advanceReleaseReady(a1.consecutiveFull, a1.lastBand, est);
    expect(a2.fire).toBe(true);
    expect(a2.consecutiveFull).toBe(VGC_RELEASE_READY_CONSECUTIVE);
  });

  it("release-capable primary (ge92) → returns primary immediately; control-fill NEVER runs", () => {
    h.primary = { found: true, fill_ratio: 0.95, band: BAND_A };
    h.control = { found: true, fill_ratio: 0.99, band: BAND_B }; // would win IF reached

    const est = estimateReleaseReadyWithWholeCropFallback(CAP, solidPng(120), "hold_anchor");

    expect(est).toBe(h.primary);
    expect(vi.mocked(evaluateControlFill)).not.toHaveBeenCalled();
    // No control-fill / whole-crop state was created.
    expect(wholeCropStateKindForTests(CAP)).toBe("none");
  });

  it("partial primary + control NOT found → returns the partial primary; never fires", () => {
    h.primary = { found: true, fill_ratio: 0.6, band: BAND_A };
    h.control = { found: false };

    const est = estimateReleaseReadyWithWholeCropFallback(CAP, solidPng(120), "hold_anchor");

    expect(vi.mocked(evaluateControlFill)).toHaveBeenCalledTimes(1);
    // Partial primary is SURFACED (telemetry/progress), not discarded as {found:false}.
    expect(est).toBe(h.primary);
    expect(est.found).toBe(true);
    expect(est.fill_ratio!).toBeLessThan(FULL_RATIO_THRESHOLD);
    // Whole-crop telemetry ran (created tracking state) but did not change the return.
    expect(wholeCropStateKindForTests(CAP)).toBe("tracking");
    // Below threshold ⇒ resets the streak, never fires.
    const a = advanceReleaseReady(0, undefined, est);
    expect(a.fire).toBe(false);
    expect(a.consecutiveFull).toBe(0);
  });

  it("ties go to control (the intended release trigger with a stable band)", () => {
    h.primary = { found: true, fill_ratio: 0.9, band: BAND_A };
    h.control = { found: true, fill_ratio: 0.9, band: BAND_B };

    const est = estimateReleaseReadyWithWholeCropFallback(CAP, solidPng(120), "hold_anchor");
    expect(est).toBe(h.control);
  });

  it("nothing found (primary + control) → {found:false}; whole-crop telemetry still ran", () => {
    h.primary = { found: false };
    h.control = { found: false };

    const est = estimateReleaseReadyWithWholeCropFallback(CAP, solidPng(120), "hold_anchor");
    expect(est.found).toBe(false);
    expect(vi.mocked(evaluateControlFill)).toHaveBeenCalledTimes(1);
    expect(wholeCropStateKindForTests(CAP)).toBe("tracking");
  });

  it("strict source gate: non-hold_anchor partial primary returns primary; control-fill never runs", () => {
    h.primary = { found: true, fill_ratio: 0.6, band: BAND_A };
    h.control = { found: true, fill_ratio: 0.99, band: BAND_B }; // would win IF reached

    for (const src of ["dominant_surface", "inner_control", "center_region"] as const) {
      vi.clearAllMocks();
      clearWholeCropProgressForTests();
      const cap = `${CAP}_${src}`;
      const est = estimateReleaseReadyWithWholeCropFallback(cap, solidPng(120), src);
      expect(est).toBe(h.primary);
      expect(vi.mocked(evaluateControlFill)).not.toHaveBeenCalled();
      expect(wholeCropStateKindForTests(cap)).toBe("none");
    }
  });
});
