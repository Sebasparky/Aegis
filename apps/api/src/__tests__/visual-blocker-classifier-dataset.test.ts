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
import { afterEach, describe, expect, it } from "vitest";

import {
  captureVisionDatasetRecord,
  decideDatasetCapture,
  __resetVisionDatasetThrottle,
  type DatasetScreenshot,
} from "../runtime/visualBlockerClassifier/datasetCapture.js";
import { getAntigenRuntimeStatus } from "../runtime/antigenRuntimeFlags.js";
import type { PipelineOutcome } from "../runtime/visualBlockerClassifier/types.js";

const FLAG = "ANTIGEN_HV_VISION_DATASET";

// 1x1 transparent PNG — stands in for a redacted frame.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot, disableThrottle: true },
    );
    expect(res.written).toBe(true);
    const dir = recordDir(root);
    expect(fs.existsSync(path.join(dir, "frame.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
    expect(fs.statSync(path.join(dir, "frame.png")).size).toBeGreaterThan(0);
  });

  it("meta.json has label:null, outcome:null, policy_enforced:false, region:full_viewport", async () => {
    withFlag(true);
    const root = tmpRoot();
    await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot, disableThrottle: true },
    );
    const meta = JSON.parse(fs.readFileSync(path.join(recordDir(root), "meta.json"), "utf-8"));
    expect(meta.label).toBeNull();
    expect(meta.outcome).toBeNull();
    expect(meta.policy_enforced).toBe(false);
    expect(meta.region).toBe("full_viewport");
    expect(meta.redaction_verified).toBe(true);
    expect(meta.redacted_field_count).toBe(2);
    expect(meta.blocker_type).toBe("unknown_blocked");
    expect(meta.classifier_source).toBe("shadow_stub");
  });

  it("meta.json contains no unsafe keys or nested base64", async () => {
    withFlag(true);
    const root = tmpRoot();
    await captureVisionDatasetRecord(
      { outcome: ranOutcome(), cdpUrl: "http://localhost:9222" },
      { outputRoot: root, now: fixedNow, screenshotProvider: okScreenshot, disableThrottle: true },
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
    // The redacted PNG bytes must never be embedded as a string anywhere in meta.
    expect(raw.includes(TINY_PNG_B64)).toBe(false);
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
