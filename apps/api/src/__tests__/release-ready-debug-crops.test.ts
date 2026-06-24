/**
 * Release-Ready Debug Crop Capture — dev-only, double-flag-gated suite (no Chromium).
 *
 * Pins the safety-relevant behavior of the operator-only crop capture used to debug
 * B&BW press-and-hold `release_ready` false positives:
 *   - OFF by default: with either flag missing, NOTHING is written (byte-neutral);
 *   - ON (both flags): baseline/current/meta written, previous/diff appear on frame 2;
 *   - meta.json is allowlist-only — enums/buckets/booleans/ids, never a path/coord/dim;
 *   - capture failure NEVER throws (best-effort) — release-ready behavior is unaffected;
 *   - the first frame of a hold writes gracefully with no previous/diff.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PNG } from "pngjs";

import {
  isReleaseReadyDebugCropsEnabled,
  noteProbeCrop,
  noteDetectorDiagnostics,
  noteWholeCropDiagnostics,
  noteControlFillDiagnostics,
  noteControlOverlayGeometry,
  noteChosenSelection,
  commitProbeCrop,
  clearAllReleaseReadyDebugCropsForTests,
} from "../runtime/releaseReadyDebugCrops.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A solid-gray PNG (base64). Same construction the whole-crop suite uses. */
function solidPng(gray: number, w = 60, h = 40): string {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i << 2;
    png.data[o] = gray;
    png.data[o + 1] = gray;
    png.data[o + 2] = gray;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png).toString("base64");
}

const CAP = "vgc_debug_crop_test";

/** The exhaustive set of keys meta.json may contain — nothing else is allowed. */
const ALLOWED_META_KEYS = new Set([
  "capsule_id",
  "probe_id",
  "created_at",
  "crop_source",
  "candidate_kind",
  "found",
  "fill_bucket",
  "cumulative_bucket",
  "recent_bucket",
  "strict_strength",
  "temporally_confirmed",
  "control_candidate_seen",
  "control_rejection_reason",
  "whole_crop_mode",
  "whole_crop_release_triggered",
  "primary_candidate_kind",
  "primary_fill_bucket",
  "control_candidate_kind",
  "control_fill_bucket",
  "transitioned_columns_bucket",
  "changed_area_bucket",
  "center_completion_signal_seen",
  "completed_marker_seen",
  "chosen_release_reason",
  "chosen_candidate_kind",
  "chosen_fill_bucket",
  "control_bounds_status",
  "control_bounds_size_bucket",
  "control_bounds_horizontal_position_bucket",
  "control_bounds_vertical_position_bucket",
  "control_bounds_aspect_bucket",
  "base_edge_uniform_bucket",
  "cur_edge_uniform_bucket",
  "edge_off_level_side_bucket",
  "edge_sample_count_bucket",
  "uniform_signal_seen",
  "uniform_signal_failure_reason",
  "solid_state_guard_reason",
  "marker_delta_bucket",
  "marker_area_bucket",
  "marker_failure_reason",
  "consecutive_full",
  "fired",
  "has_previous",
  "has_diff",
  "has_control_overlay",
]);

let tmpRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function setFlags(hvDebug: string | undefined, debugCrops: string | undefined): void {
  if (hvDebug === undefined) delete process.env.ANTIGEN_HV_DEBUG;
  else process.env.ANTIGEN_HV_DEBUG = hvDebug;
  if (debugCrops === undefined) delete process.env.ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS;
  else process.env.ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS = debugCrops;
}

function capsuleDir(): string {
  return path.join(tmpRoot, CAP);
}

beforeEach(() => {
  clearAllReleaseReadyDebugCropsForTests();
  savedEnv.ANTIGEN_HV_DEBUG = process.env.ANTIGEN_HV_DEBUG;
  savedEnv.ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS = process.env.ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rr-debug-"));
});

afterEach(() => {
  setFlags(savedEnv.ANTIGEN_HV_DEBUG, savedEnv.ANTIGEN_VGC_RELEASE_READY_DEBUG_CROPS);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── 1. Flag gating: OFF ⇒ no files ─────────────────────────────────────────────

describe("flag gating — off ⇒ no write, no state", () => {
  it("both flags unset: helper false and nothing written", () => {
    setFlags(undefined, undefined);
    expect(isReleaseReadyDebugCropsEnabled()).toBe(false);
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: true, consecutive_full: 2, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    expect(fs.existsSync(capsuleDir())).toBe(false);
  });

  it("only ANTIGEN_HV_DEBUG on ⇒ disabled, no write", () => {
    setFlags("true", undefined);
    expect(isReleaseReadyDebugCropsEnabled()).toBe(false);
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: true, consecutive_full: 2, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    expect(fs.existsSync(capsuleDir())).toBe(false);
  });

  it("only debug-crops flag on ⇒ disabled, no write", () => {
    setFlags(undefined, "true");
    expect(isReleaseReadyDebugCropsEnabled()).toBe(false);
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: true, consecutive_full: 2, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    expect(fs.existsSync(capsuleDir())).toBe(false);
  });
});

// ─── 2. Flag gating: ON ⇒ files + meta ──────────────────────────────────────────

describe("flag gating — on ⇒ files + meta written", () => {
  beforeEach(() => setFlags("true", "true"));

  it("first probe writes baseline/current/meta (no previous/diff)", () => {
    expect(isReleaseReadyDebugCropsEnabled()).toBe(true);
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: false, fired: false, consecutive_full: 0, fill_bucket: "none" },
      { outputRoot: tmpRoot, now: () => new Date("2026-06-24T00:00:00.000Z") },
    );
    const dir = path.join(capsuleDir(), "0001");
    expect(fs.existsSync(path.join(dir, "current.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "baseline.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "previous.png"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "diff.png"))).toBe(false);
  });

  it("second probe writes previous + diff (same dims) and carries whole-crop buckets", () => {
    // Frame 1 (baseline).
    noteDetectorDiagnostics(CAP, { chosen_candidate_kind: "none" });
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: false, fired: false, consecutive_full: 0, fill_bucket: "none" },
      { outputRoot: tmpRoot },
    );
    // Frame 2 (whole-crop compared path notes its buckets, then crop stashed).
    noteDetectorDiagnostics(CAP, { chosen_candidate_kind: "none" });
    noteWholeCropDiagnostics(CAP, {
      chosen_candidate_kind: "hold_anchor_whole_crop",
      cumulative_bucket: "3_5",
      recent_bucket: "0_5_1",
      strict_strength: "moderate",
      temporally_confirmed: false,
      whole_crop_mode: "strict_plateau",
    });
    noteProbeCrop(CAP, { croppedPngB64: solidPng(40), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: true, consecutive_full: 2, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    const dir = path.join(capsuleDir(), "0002");
    expect(fs.existsSync(path.join(dir, "current.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "previous.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "diff.png"))).toBe(true);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
    expect(meta.candidate_kind).toBe("hold_anchor_whole_crop");
    expect(meta.cumulative_bucket).toBe("3_5");
    expect(meta.recent_bucket).toBe("0_5_1");
    expect(meta.strict_strength).toBe("moderate");
    expect(meta.fired).toBe(true);
    expect(meta.has_previous).toBe(true);
    expect(meta.has_diff).toBe(true);
  });
});

// ─── 2b. Seam decision breakdown — primary vs control vs chosen ─────────────────
// These pin that the sheet records each detector's read independently and the seam's
// FINAL winner — exactly the "partial primary did NOT block control-fill" routing.
describe("meta.json — primary / control / chosen breakdown", () => {
  beforeEach(() => setFlags("true", "true"));

  it("partial primary bar + ge92 control → chosen reflects control, not last-writer", () => {
    // Probe order mirrors the live seam: per-shape note first, then control-fill note,
    // then the seam's chosen-selection note (control won the higher-fill tiebreak).
    noteDetectorDiagnostics(CAP, { chosen_candidate_kind: "bar", fill_ratio: 0.6 });
    noteControlFillDiagnostics(CAP, {
      chosen_candidate_kind: "bar_fill",
      control_fill_ratio: 0.95,
      control_candidate_seen: true,
      control_rejection_reason: "none",
    });
    noteChosenSelection(CAP, "control");
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: false, consecutive_full: 1, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    const meta = JSON.parse(fs.readFileSync(path.join(capsuleDir(), "0001", "meta.json"), "utf-8"));
    expect(meta.primary_candidate_kind).toBe("bar");
    expect(meta.primary_fill_bucket).toBe("50_75");
    expect(meta.control_candidate_kind).toBe("bar_fill");
    expect(meta.control_fill_bucket).toBe("ge92");
    expect(meta.chosen_candidate_kind).toBe("bar_fill");
    expect(meta.chosen_fill_bucket).toBe("ge92");
    // Legacy column tracks the chosen winner.
    expect(meta.candidate_kind).toBe("bar_fill");
  });

  it("partial primary + control not found + whole-crop ran → chosen stays primary (not clobbered)", () => {
    noteDetectorDiagnostics(CAP, { chosen_candidate_kind: "bar", fill_ratio: 0.6 });
    noteControlFillDiagnostics(CAP, {
      control_candidate_seen: false,
      control_rejection_reason: "too_broad",
    });
    // Whole-crop telemetry note would clobber the legacy candidate_kind to
    // hold_anchor_whole_crop — the seam's chosen note runs AFTER and must win.
    noteWholeCropDiagnostics(CAP, {
      chosen_candidate_kind: "hold_anchor_whole_crop",
      cumulative_bucket: "3_5",
      recent_bucket: "0_5_1",
      strict_strength: "moderate",
      temporally_confirmed: false,
      whole_crop_mode: "strict_plateau",
    });
    noteChosenSelection(CAP, "primary");
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: false, consecutive_full: 0, fill_bucket: "50_75" },
      { outputRoot: tmpRoot },
    );
    const meta = JSON.parse(fs.readFileSync(path.join(capsuleDir(), "0001", "meta.json"), "utf-8"));
    expect(meta.primary_candidate_kind).toBe("bar");
    expect(meta.primary_fill_bucket).toBe("50_75");
    expect(meta.control_candidate_kind).toBe(null);
    expect(meta.control_fill_bucket).toBe(null);
    expect(meta.control_candidate_seen).toBe(false);
    expect(meta.chosen_candidate_kind).toBe("bar");
    expect(meta.chosen_fill_bucket).toBe("50_75");
    // Legacy column reflects the chosen winner, NOT the whole-crop clobber.
    expect(meta.candidate_kind).toBe("bar");
    // Whole-crop telemetry buckets are still recorded.
    expect(meta.whole_crop_mode).toBe("strict_plateau");
  });
});

// ─── 2c. Control-measurement breakdown + optional overlay ───────────────────────
// Pins the new dev-only visibility: the measured-frame buckets/enums land in meta.json
// (still enums/buckets/booleans only), and the overlay PNG is written ONLY when locked
// geometry was noted — never leaking any coordinate into meta.
describe("control-measurement diagnostics — bucketed meta + optional overlay", () => {
  beforeEach(() => setFlags("true", "true"));

  it("measured-frame control diagnostics are bucketed/enum-only in meta (no geometry leak)", () => {
    noteDetectorDiagnostics(CAP, { chosen_candidate_kind: "bar_fill", fill_ratio: 0.96 });
    noteControlFillDiagnostics(CAP, {
      chosen_candidate_kind: "bar_fill",
      control_fill_ratio: 0.96,
      control_candidate_seen: true,
      control_rejection_reason: "none",
      transitioned_columns_ratio: 0.4,
      changed_area_ratio: 0.2,
      center_completion_signal_seen: false,
      completed_marker_seen: false,
      chosen_release_reason: "none",
      control_bounds_status: "locked",
      control_bounds_size_bucket: "large",
      control_bounds_horizontal_position_bucket: "center",
      control_bounds_vertical_position_bucket: "near_end",
      control_bounds_aspect_bucket: "ge8",
      base_edge_uniform_bucket: "lt50",
      cur_edge_uniform_bucket: "75_92",
      edge_off_level_side_bucket: "right",
      edge_sample_count_bucket: "8_24",
      uniform_signal_seen: false,
      uniform_signal_failure_reason: "current_not_uniform",
      solid_state_guard_reason: "failed_current_not_uniform",
      marker_delta_bucket: "below_min",
      marker_area_bucket: "lt50",
      marker_failure_reason: "marker_area_too_small",
    });
    noteChosenSelection(CAP, "control");
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: false, consecutive_full: 1, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    const raw = fs.readFileSync(path.join(capsuleDir(), "0001", "meta.json"), "utf-8");
    const meta = JSON.parse(raw);

    // Only allowlisted keys, only scalar enum/bucket/boolean/null values.
    for (const k of Object.keys(meta)) expect(ALLOWED_META_KEYS.has(k)).toBe(true);
    for (const v of Object.values(meta)) {
      const t = v === null ? "null" : typeof v;
      expect(["string", "number", "boolean", "null"]).toContain(t);
    }
    // The noted bucketed breakdown is faithfully recorded.
    expect(meta.control_bounds_status).toBe("locked");
    expect(meta.control_bounds_size_bucket).toBe("large");
    expect(meta.control_bounds_vertical_position_bucket).toBe("near_end");
    expect(meta.control_bounds_aspect_bucket).toBe("ge8");
    expect(meta.edge_off_level_side_bucket).toBe("right");
    expect(meta.edge_sample_count_bucket).toBe("8_24");
    expect(meta.uniform_signal_seen).toBe(false);
    expect(meta.uniform_signal_failure_reason).toBe("current_not_uniform");
    expect(meta.solid_state_guard_reason).toBe("failed_current_not_uniform");
    expect(meta.marker_delta_bucket).toBe("below_min");
    expect(meta.marker_failure_reason).toBe("marker_area_too_small");
    // No geometry / filesystem hint leaks into the serialized meta.
    expect(raw).not.toMatch(/\.png|\/|\\|x0|x1|width|height|viewport|cdp|http/i);
    // No overlay geometry was noted → no overlay artifact.
    expect(meta.has_control_overlay).toBe(false);
    expect(fs.existsSync(path.join(capsuleDir(), "0001", "control_overlay.png"))).toBe(false);
  });

  it("noted geometry → control_overlay.png written and has_control_overlay true", () => {
    noteControlFillDiagnostics(CAP, {
      chosen_candidate_kind: "bar_fill",
      control_fill_ratio: 0.96,
      control_candidate_seen: true,
      control_rejection_reason: "none",
      control_bounds_status: "locked",
    });
    // Geometry fits the default 60×40 solidPng crop.
    noteControlOverlayGeometry(CAP, {
      bounds: { x0: 8, x1: 50, y0: 14, y1: 26 },
      edgeInsetCols: 12,
      markerZone: { cx0: 20, cx1: 38, cy0: 16, cy1: 24 },
      offLevelLeft: false,
      offLevelRight: true,
    });
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: false, consecutive_full: 1, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    const dir = path.join(capsuleDir(), "0001");
    expect(fs.existsSync(path.join(dir, "control_overlay.png"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
    expect(meta.has_control_overlay).toBe(true);
    // The overlay never makes meta carry geometry.
    expect(JSON.stringify(meta)).not.toMatch(/x0|x1|markerZone|edgeInset/i);
  });

  it("no geometry noted → commit succeeds, no overlay file, flag false", () => {
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    expect(() =>
      commitProbeCrop(
        CAP,
        { found: false, fired: false, consecutive_full: 0, fill_bucket: "none" },
        { outputRoot: tmpRoot },
      ),
    ).not.toThrow();
    const dir = path.join(capsuleDir(), "0001");
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "control_overlay.png"))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
    expect(meta.has_control_overlay).toBe(false);
  });

  it("out-of-range overlay geometry → fail-soft (no overlay, no throw, flag false)", () => {
    noteControlOverlayGeometry(CAP, {
      bounds: { x0: 0, x1: 9999, y0: 0, y1: 9999 }, // exceeds the 60×40 crop
      edgeInsetCols: 4,
      markerZone: { cx0: 1, cx1: 2, cy0: 1, cy1: 2 },
      offLevelLeft: false,
      offLevelRight: false,
    });
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    expect(() =>
      commitProbeCrop(
        CAP,
        { found: true, fired: false, consecutive_full: 0, fill_bucket: "none" },
        { outputRoot: tmpRoot },
      ),
    ).not.toThrow();
    const dir = path.join(capsuleDir(), "0001");
    expect(fs.existsSync(path.join(dir, "control_overlay.png"))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
    expect(meta.has_control_overlay).toBe(false);
  });

  it("geometry noted but flags OFF → nothing written (byte-neutral)", () => {
    setFlags(undefined, undefined);
    noteControlOverlayGeometry(CAP, {
      bounds: { x0: 8, x1: 50, y0: 14, y1: 26 },
      edgeInsetCols: 12,
      markerZone: { cx0: 20, cx1: 38, cy0: 16, cy1: 24 },
      offLevelLeft: false,
      offLevelRight: false,
    });
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: true, consecutive_full: 2, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    expect(fs.existsSync(capsuleDir())).toBe(false);
  });
});

// ─── 3. meta.json is allowlist-safe ─────────────────────────────────────────────

describe("meta.json — safe enums/buckets/booleans only", () => {
  beforeEach(() => setFlags("true", "true"));

  it("contains only allowlisted keys and no path/coord/dimension/url substrings", () => {
    noteWholeCropDiagnostics(CAP, {
      chosen_candidate_kind: "hold_anchor_whole_crop",
      cumulative_bucket: "ge5",
      recent_bucket: "lt0_5",
      strict_strength: "very_strong",
      temporally_confirmed: true,
      whole_crop_mode: "strict_plateau",
    });
    noteProbeCrop(CAP, { croppedPngB64: solidPng(200), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: true, fired: true, consecutive_full: 1, fill_bucket: "ge92" },
      { outputRoot: tmpRoot },
    );
    const raw = fs.readFileSync(path.join(capsuleDir(), "0001", "meta.json"), "utf-8");
    const meta = JSON.parse(raw);

    for (const k of Object.keys(meta)) {
      expect(ALLOWED_META_KEYS.has(k)).toBe(true);
    }
    // Value types: only string/number/boolean/null — never nested objects/arrays.
    for (const v of Object.values(meta)) {
      const t = v === null ? "null" : typeof v;
      expect(["string", "number", "boolean", "null"]).toContain(t);
    }
    // The serialized blob must not leak geometry or filesystem hints.
    expect(raw).not.toMatch(/\.png|\/|\\|x0|x1|width|height|viewport|cdp|http/i);
    // consecutive_full is a small int, not a coordinate.
    expect(Number.isInteger(meta.consecutive_full)).toBe(true);
  });
});

// ─── 4. Capture failure never affects behavior ──────────────────────────────────

describe("best-effort — capture failure never throws", () => {
  beforeEach(() => setFlags("true", "true"));

  it("an unwritable output root does not throw and writes nothing", () => {
    // Point the root INSIDE a regular file so mkdirSync fails with ENOTDIR.
    const blocker = path.join(tmpRoot, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const badRoot = path.join(blocker, "sub");

    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    expect(() =>
      commitProbeCrop(
        CAP,
        { found: true, fired: true, consecutive_full: 2, fill_bucket: "ge92" },
        { outputRoot: badRoot },
      ),
    ).not.toThrow();
    expect(fs.existsSync(badRoot)).toBe(false);
  });

  it("malformed crop base64 still does not throw (diff omitted)", () => {
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "hold_anchor" });
    commitProbeCrop(
      CAP,
      { found: false, fired: false, consecutive_full: 0, fill_bucket: "none" },
      { outputRoot: tmpRoot },
    );
    // Frame 2 with a non-PNG "crop": current.png is written from raw bytes, diff decode
    // fails → diff omitted, no throw.
    noteProbeCrop(CAP, { croppedPngB64: "not-a-real-png", cropSource: "hold_anchor" });
    expect(() =>
      commitProbeCrop(
        CAP,
        { found: false, fired: false, consecutive_full: 0, fill_bucket: "none" },
        { outputRoot: tmpRoot },
      ),
    ).not.toThrow();
    const dir = path.join(capsuleDir(), "0002");
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "diff.png"))).toBe(false);
  });
});

// ─── 5. First-frame graceful ────────────────────────────────────────────────────

describe("first frame — graceful with no previous/diff", () => {
  beforeEach(() => setFlags("true", "true"));

  it("single probe writes current+baseline, meta marks no previous/diff", () => {
    noteProbeCrop(CAP, { croppedPngB64: solidPng(120), cropSource: "dominant_surface" });
    commitProbeCrop(
      CAP,
      { found: false, fired: false, consecutive_full: 0, fill_bucket: "none" },
      { outputRoot: tmpRoot },
    );
    const dir = path.join(capsuleDir(), "0001");
    expect(fs.existsSync(path.join(dir, "current.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "baseline.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "previous.png"))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
    expect(meta.has_previous).toBe(false);
    expect(meta.has_diff).toBe(false);
    expect(meta.crop_source).toBe("dominant_surface");
    expect(meta.candidate_kind).toBe("none");
  });

  it("commit with no pending probe is a no-op (no throw)", () => {
    expect(() =>
      commitProbeCrop(
        CAP,
        { found: false, fired: false, consecutive_full: 0, fill_bucket: "none" },
        { outputRoot: tmpRoot },
      ),
    ).not.toThrow();
    expect(fs.existsSync(capsuleDir())).toBe(false);
  });
});
