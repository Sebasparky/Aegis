/**
 * VisualBlockerClassifierPipeline — Phase 2A dev-only dataset capture.
 *
 * Asserts: capture is gated by ANTIGEN_HV_VISION_DATASET (off ⇒ no write, no behavior),
 * runs only for a real candidate with a session, reuses the redacted-screenshot seam,
 * writes frame.png + safe meta.json (label/outcome null, region full_viewport), carries
 * NO unsafe keys, and skips safely on every failure mode. No Chromium needed — the
 * screenshot seam is injected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureVisionDatasetRecord,
  decideDatasetCapture,
  resolveCrop,
  validateAndPadCrop,
  __resetVisionDatasetThrottle,
  type DatasetScreenshot,
  type VisualDatasetCropHint,
} from "../runtime/visualBlockerClassifier/datasetCapture.js";
import { getAntigenRuntimeStatus } from "../runtime/antigenRuntimeFlags.js";
import type { PipelineOutcome } from "../runtime/visualBlockerClassifier/types.js";

const FLAG = "ANTIGEN_HV_VISION_DATASET";

// 1x1 transparent PNG — stands in for a redacted frame.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A solid-grey PNG of the given size — a realistic full-viewport stand-in for crops. */
function solidPng(w: number, h: number): string {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 128;
    png.data[i + 1] = 128;
    png.data[i + 2] = 128;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png).toString("base64");
}

const VIEWPORT_PNG_B64 = solidPng(100, 100);

/** A crop probe that finds a centered blocker rect in a 100×100 viewport. */
const validCropProbe = async (): Promise<VisualDatasetCropHint> => ({
  box: { x: 30, y: 30, w: 30, h: 30 },
  viewport: { vw: 100, vh: 100 },
  source: "capture_reprobe",
});

/** A crop probe that misses (no safe geometry) → full_viewport fallback. */
const missCropProbe = async (): Promise<VisualDatasetCropHint | null> => null;

const FIXED_NOW = new Date("2026-06-20T12:00:00.000Z");
const fixedNow = () => FIXED_NOW;

function withFlag(on: boolean): void {
  if (on) process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

afterEach(() => {
  delete process.env[FLAG];
  __resetVisionDatasetThrottle();
});

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hv-dataset-"));
}

function ranOutcome(candidateId = "cand-test-1", sessionId = "bs_test"): PipelineOutcome {
  const ts = FIXED_NOW.toISOString();
  return {
    ran: true,
    candidate: {
      candidate_id: candidateId,
      browser_session_id: sessionId,
      domain: "example.com",
      trigger_basis: "unreadable_dominant_surface",
      candidate_reason: "unreadable_dominant_surface",
      dominant_surface_kind: "scrim_center_modal",
      signals: {
        scrim_seen: true,
        centered_modal_seen: true,
        opaque_iframe_seen: false,
        visual_dom_contradiction_seen: false,
        dominant_text_uninspectable: true,
        pointer_interceptor_seen: false,
      },
      created_at: ts,
    },
    result: {
      candidate_id: candidateId,
      blocker_type: "unknown_blocked",
      confidence_bucket: "low",
      user_presence_required: false,
      wall_visible: true,
      safe_to_resume: false,
      classifier_source: "shadow_stub",
      classified_at: ts,
    },
    policy: {
      candidate_id: candidateId,
      action: "fail_closed_or_ask_user",
      enforced: false,
      basis_blocker_type: "unknown_blocked",
      confidence_bucket: "low",
      decided_at: ts,
    },
  };
}

const okShot: DatasetScreenshot = { ok: true, base64: TINY_PNG_B64, redacted_field_count: 2 };
const okScreenshot = async (): Promise<DatasetScreenshot> => okShot;

function recordDir(root: string, candidateId = "cand-test-1"): string {
  return path.join(root, "2026-06-20", candidateId);
}

// ── Flag gating ───────────────────────────────────────────────────────────────

describe("dataset capture flag gating", () => {
  it("flag off → no write (flag_disabled)", async () => {
    withFlag(false);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot, disableThrottle: true },
    );
    expect(res.written).toBe(false);
    if (!res.written) expect(res.skip_reason).toBe("flag_disabled");
    expect(fs.existsSync(recordDir(root))).toBe(false);
  });

  it("decideDatasetCapture is pure and returns flag_disabled when off", () => {
    withFlag(false);
    const d = decideDatasetCapture({ outcome: ranOutcome(), cdpUrl: "http://localhost:9222" });
    expect(d.capture).toBe(false);
    expect(d.skip_reason).toBe("flag_disabled");
  });
});

// ── Preconditions ─────────────────────────────────────────────────────────────

describe("dataset capture preconditions", () => {
  it("flag on but no candidate → not_a_candidate, no write", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: { ran: false, skip_reason: "not_a_candidate" }, cdpUrl: "http://localhost:9222" },
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot, disableThrottle: true },
    );
    expect(res.written).toBe(false);
    if (!res.written) expect(res.skip_reason).toBe("not_a_candidate");
    expect(fs.readdirSync(root).length).toBe(0);
  });

  it("flag on + missing cdpUrl → no_session, no write", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: null },
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot, disableThrottle: true },
    );
    expect(res.written).toBe(false);
    if (!res.written) expect(res.skip_reason).toBe("no_session");
    expect(fs.readdirSync(root).length).toBe(0);
  });
});

// ── Successful write ──────────────────────────────────────────────────────────

describe("dataset capture writes redacted record", () => {
  it("flag on + candidate + screenshot success → writes frame.png and meta.json", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        screenshotProvider: okScreenshot,
        cropProbe: missCropProbe,
        disableThrottle: true,
      },
    );
    expect(res.written).toBe(true);
    const dir = recordDir(root);
    expect(fs.existsSync(path.join(dir, "frame.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
    expect(fs.statSync(path.join(dir, "frame.png")).size).toBeGreaterThan(0);
  });

  it("crop probe miss → meta region:full_viewport, crop_applied:false, fallback source", async () => {
    withFlag(true);
    const root = tmpRoot();
    await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        screenshotProvider: okScreenshot,
        cropProbe: missCropProbe,
        disableThrottle: true,
      },
    );
    const meta = JSON.parse(fs.readFileSync(path.join(recordDir(root), "meta.json"), "utf-8"));
    expect(meta.label).toBeNull();
    expect(meta.outcome).toBeNull();
    expect(meta.policy_enforced).toBe(false);
    expect(meta.region).toBe("full_viewport");
    expect(meta.crop_applied).toBe(false);
    expect(meta.crop_source).toBe("fallback_full_viewport");
    expect(meta.redaction_verified).toBe(true);
    expect(meta.redacted_field_count).toBe(2);
    expect(meta.blocker_type).toBe("unknown_blocked");
    expect(meta.classifier_source).toBe("shadow_stub");
  });

  it("valid crop hint → writes a cropped frame.png, meta region:blocker_crop/crop_applied:true", async () => {
    withFlag(true);
    const root = tmpRoot();
    const fullSize = Buffer.from(VIEWPORT_PNG_B64, "base64").length;
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        screenshotProvider: async () => ({ ok: true, base64: VIEWPORT_PNG_B64, redacted_field_count: 1 }),
        cropProbe: validCropProbe,
        disableThrottle: true,
      },
    );
    expect(res.written).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(recordDir(root), "meta.json"), "utf-8"));
    expect(meta.region).toBe("blocker_crop");
    expect(meta.crop_applied).toBe(true);
    expect(meta.crop_source).toBe("capture_reprobe");
    // The cropped frame is a real, smaller-than-full PNG.
    const framePath = path.join(recordDir(root), "frame.png");
    const frameBuf = fs.readFileSync(framePath);
    const decoded = PNG.sync.read(frameBuf);
    expect(decoded.width).toBeLessThan(100);
    expect(decoded.height).toBeLessThan(100);
    expect(frameBuf.length).toBeLessThan(fullSize);
  });

  it("cropPng failure (corrupt frame) → safe full_viewport fallback, write still succeeds", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        // A non-PNG body makes cropPng throw; resolveCrop must fall back to the full frame.
        screenshotProvider: async () => ({ ok: true, base64: "bm90LWEtcG5n", redacted_field_count: 0 }),
        cropProbe: validCropProbe,
        disableThrottle: true,
      },
    );
    expect(res.written).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(recordDir(root), "meta.json"), "utf-8"));
    expect(meta.region).toBe("full_viewport");
    expect(meta.crop_applied).toBe(false);
    expect(meta.crop_source).toBe("fallback_full_viewport");
  });

  it("crop probe throwing → safe full_viewport fallback, never throws", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        screenshotProvider: okScreenshot,
        cropProbe: async () => {
          throw new Error("probe blew up");
        },
        disableThrottle: true,
      },
    );
    expect(res.written).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(recordDir(root), "meta.json"), "utf-8"));
    expect(meta.region).toBe("full_viewport");
    expect(meta.crop_applied).toBe(false);
  });

  it("meta.json contains no unsafe keys or nested base64 (crop path)", async () => {
    withFlag(true);
    const root = tmpRoot();
    await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        screenshotProvider: async () => ({ ok: true, base64: VIEWPORT_PNG_B64, redacted_field_count: 1 }),
        cropProbe: validCropProbe,
        disableThrottle: true,
      },
    );
    const raw = fs.readFileSync(path.join(recordDir(root), "meta.json"), "utf-8");
    const meta = JSON.parse(raw);

    const UNSAFE_KEY =
      /(png_base64|base64|screenshot|raw_text|\btext\b|iframe_src|\bsrc\b|selector|xpath|rect|\bx\b|\by\b|width|height|\bvalue\b|\burl\b|coord)/i;
    const scan = (obj: unknown, p = "root"): void => {
      if (obj === null || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        expect(UNSAFE_KEY.test(k), `unsafe key "${k}" at ${p}`).toBe(false);
        scan(v, `${p}.${k}`);
      }
    };
    scan(meta);
    // No rect/coordinate keys, and the redacted PNG bytes are never embedded in meta.
    expect(meta.crop_applied).toBe(true);
    expect(raw.includes(VIEWPORT_PNG_B64)).toBe(false);
    expect(raw.includes(TINY_PNG_B64)).toBe(false);
  });
});

// ── Crop geometry resolution (pure) ───────────────────────────────────────────

describe("resolveCrop / validateAndPadCrop", () => {
  const vp = { vw: 1000, vh: 800 };

  it("valid centered hint → blocker_crop with capture_reprobe source", () => {
    const hint: VisualDatasetCropHint = {
      box: { x: 400, y: 300, w: 200, h: 160 },
      viewport: vp,
      source: "capture_reprobe",
    };
    const out = resolveCrop(hint, solidPng(1000, 800));
    expect(out.region).toBe("blocker_crop");
    expect(out.crop_applied).toBe(true);
    expect(out.crop_source).toBe("capture_reprobe");
    const decoded = PNG.sync.read(Buffer.from(out.base64, "base64"));
    expect(decoded.width).toBeLessThan(1000);
    expect(decoded.height).toBeLessThan(800);
  });

  it("null hint → full_viewport fallback", () => {
    const full = solidPng(40, 40);
    const out = resolveCrop(null, full);
    expect(out.region).toBe("full_viewport");
    expect(out.crop_applied).toBe(false);
    expect(out.crop_source).toBe("fallback_full_viewport");
    expect(out.base64).toBe(full);
  });

  it("rejects NaN / negative / zero-area / off-screen / oversized geometry", () => {
    const bad: VisualDatasetCropHint[] = [
      { box: { x: NaN, y: 0, w: 10, h: 10 }, viewport: vp, source: "capture_reprobe" },
      { box: { x: 0, y: 0, w: -5, h: 10 }, viewport: vp, source: "capture_reprobe" },
      { box: { x: 0, y: 0, w: 0, h: 0 }, viewport: vp, source: "capture_reprobe" },
      { box: { x: 5000, y: 5000, w: 10, h: 10 }, viewport: vp, source: "capture_reprobe" },
      { box: { x: 0, y: 0, w: 10, h: 10 }, viewport: { vw: 0, vh: 0 }, source: "capture_reprobe" },
      // Covers ~the whole viewport → adds nothing over the full frame.
      { box: { x: 0, y: 0, w: 1000, h: 800 }, viewport: vp, source: "capture_reprobe" },
    ];
    for (const h of bad) expect(validateAndPadCrop(h)).toBeNull();
    // …and resolveCrop turns each into a safe full_viewport fallback.
    const full = solidPng(20, 20);
    for (const h of bad) {
      const out = resolveCrop(h, full);
      expect(out.region).toBe("full_viewport");
      expect(out.crop_applied).toBe(false);
    }
  });

  it("clamps padding to the viewport (never exceeds bounds)", () => {
    const hint: VisualDatasetCropHint = {
      box: { x: 10, y: 10, w: 200, h: 160 },
      viewport: { vw: 300, vh: 300 },
      source: "capture_reprobe",
    };
    const rect = validateAndPadCrop(hint);
    expect(rect).not.toBeNull();
    if (rect) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(300);
      expect(rect.y + rect.h).toBeLessThanOrEqual(300);
    }
  });
});

// ── Failure modes skip safely ─────────────────────────────────────────────────

describe("dataset capture skips safely on failure", () => {
  it("redaction mismatch → redaction_unverified, no write", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        disableThrottle: true,
        screenshotProvider: async () => ({ ok: false, redaction_mismatch: true }),
      },
    );
    expect(res.written).toBe(false);
    if (!res.written) expect(res.skip_reason).toBe("redaction_unverified");
    expect(fs.readdirSync(root).length).toBe(0);
  });

  it("generic screenshot failure → redaction_failed, no write", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      { outputRoot: root, now: fixedNow, disableThrottle: true, screenshotProvider: async () => ({ ok: false }) },
    );
    expect(res.written).toBe(false);
    if (!res.written) expect(res.skip_reason).toBe("redaction_failed");
    expect(fs.readdirSync(root).length).toBe(0);
  });

  it("screenshot provider throwing → redaction_failed, never throws", async () => {
    withFlag(true);
    const root = tmpRoot();
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      {
        outputRoot: root,
        now: fixedNow,
        disableThrottle: true,
        screenshotProvider: async () => {
          throw new Error("cdp blew up");
        },
      },
    );
    expect(res.written).toBe(false);
    if (!res.written) expect(res.skip_reason).toBe("redaction_failed");
  });

  it("fs write failure → write_failed, never throws", async () => {
    withFlag(true);
    // A path under a regular file cannot be mkdir'd (ENOTDIR).
    const badRoot = path.join("/dev/null", "cannot-create");
    const res = await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      { outputRoot: badRoot, now: fixedNow, disableThrottle: true, screenshotProvider: okScreenshot },
    );
    expect(res.written).toBe(false);
    if (!res.written) expect(res.skip_reason).toBe("write_failed");
  });
});

// ── Throttle ──────────────────────────────────────────────────────────────────

describe("dataset capture per-session throttle", () => {
  it("second capture for the same session within the window → rate_limited", async () => {
    withFlag(true);
    const root = tmpRoot();
    const first = await captureVisionDatasetRecord(
      { outcome: ranOutcome("cand-a"), cdpUrl: "http://localhost:9222" },
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot },
    );
    expect(first.written).toBe(true);
    const second = await captureVisionDatasetRecord(
      { outcome: ranOutcome("cand-b"), cdpUrl: "http://localhost:9222" },
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot },
    );
    expect(second.written).toBe(false);
    if (!second.written) expect(second.skip_reason).toBe("rate_limited");
  });
});

// ── Runtime status exposure ───────────────────────────────────────────────────

describe("runtime status flag exposure", () => {
  it("hv_vision_dataset present and false by default", () => {
    withFlag(false);
    expect(getAntigenRuntimeStatus().hv_vision_dataset).toBe(false);
  });

  it("hv_vision_dataset true when the flag is on", () => {
    withFlag(true);
    expect(getAntigenRuntimeStatus().hv_vision_dataset).toBe(true);
  });
});

// ── .gitignore covers the dataset directory ───────────────────────────────────

describe("gitignore", () => {
  it("includes the dev-only dataset directory", () => {
    const candidates = [
      path.resolve(process.cwd(), ".gitignore"),
      path.resolve(process.cwd(), "../..", ".gitignore"),
      path.resolve(process.cwd(), "..", ".gitignore"),
    ];
    const file = candidates.find((c) => fs.existsSync(c));
    expect(file, "found a .gitignore").toBeTruthy();
    const contents = fs.readFileSync(file as string, "utf-8");
    expect(/dev-artifacts\/hv-vision-dataset\/|dev-artifacts\//.test(contents)).toBe(true);
  });
});
