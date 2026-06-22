/**
 * Manual visual-review hard-negative capture (dev/QA-only).
 *
 * Asserts: capture is gated by ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE (off ⇒ no write,
 * no I/O), reuses the injected redacted-screenshot seam, writes ONE frame.png plus
 * exactly ONE safe runtime-judgment-queue line (label empty, review_status pending,
 * source manual, no classifier output, no URL/coords/bytes), and skips safely on a
 * screenshot failure. No Chromium needed — the screenshot seam is injected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureManualVisualReviewCandidate,
  MANUAL_CAPTURE_SOURCE,
  type ManualCaptureScreenshot,
} from "../runtime/visualBlockerClassifier/manualVisualReviewCapture.js";
import { getAntigenRuntimeStatus } from "../runtime/antigenRuntimeFlags.js";

const FLAG = "ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE";

// 1x1 transparent PNG — stands in for a redacted frame.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const FIXED_NOW = new Date("2026-06-22T12:00:00.000Z");
const fixedNow = () => FIXED_NOW;

const okShot = async (): Promise<ManualCaptureScreenshot> => ({ ok: true, base64: TINY_PNG_B64 });
const failShot = async (): Promise<ManualCaptureScreenshot> => ({ ok: false });

function withFlag(on: boolean): void {
  if (on) process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hv-manual-"));
}

function readQueueLines(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  delete process.env[FLAG];
});

describe("manual visual-review capture", () => {
  it("is reported in the runtime flag status", () => {
    withFlag(true);
    expect(getAntigenRuntimeStatus().manual_visual_review_capture).toBe(true);
    withFlag(false);
    expect(getAntigenRuntimeStatus().manual_visual_review_capture).toBe(false);
  });

  it("is a no-op when the flag is off (no I/O)", async () => {
    withFlag(false);
    const root = tmpRoot();
    const queue = path.join(root, "queue.jsonl");
    const result = await captureManualVisualReviewCandidate(
      { cdpUrl: "http://localhost:9222", originHost: "example.com", captureReason: "ecommerce_search_hard_negative" },
      { captureRedactedFrame: okShot, frameRoot: path.join(root, "frames"), queuePath: queue, now: fixedNow },
    );
    expect(result).toEqual({ captured: false, skip_reason: "flag_disabled" });
    expect(fs.existsSync(queue)).toBe(false);
    expect(fs.existsSync(path.join(root, "frames"))).toBe(false);
  });

  it("writes one frame + one safe pending event when on", async () => {
    withFlag(true);
    const root = tmpRoot();
    const frameRoot = path.join(root, "frames");
    const queue = path.join(root, "queue.jsonl");

    const result = await captureManualVisualReviewCandidate(
      {
        cdpUrl: "http://localhost:9222",
        originHost: "www.ebay.com",
        captureReason: "ecommerce_search_hard_negative",
        manualBasis: "normal product grid, no HV",
        sessionId: "bs_test_1",
      },
      { captureRedactedFrame: okShot, frameRoot, queuePath: queue, now: fixedNow },
    );

    expect(result.captured).toBe(true);
    if (!result.captured) return;
    expect(result.source).toBe(MANUAL_CAPTURE_SOURCE);
    expect(result.origin_host).toBe("www.ebay.com");
    expect(result.capture_reason).toBe("ecommerce_search_hard_negative");

    // Exactly one frame written under <frameRoot>/<date>/<event_id>/frame.png.
    const dayDir = path.join(frameRoot, "2026-06-22", result.event_id);
    expect(fs.existsSync(path.join(dayDir, "frame.png"))).toBe(true);

    // Exactly one queue line, with safe fields only.
    const lines = readQueueLines(queue);
    expect(lines).toHaveLength(1);
    const ev = lines[0];
    expect(ev.event_id).toBe(result.event_id);
    expect(ev.review_status).toBe("pending");
    expect(ev.human_label).toBeNull();
    expect(ev.source).toBe(MANUAL_CAPTURE_SOURCE);
    expect(ev.activation_reason).toBe(MANUAL_CAPTURE_SOURCE);
    expect(ev.capture_reason).toBe("ecommerce_search_hard_negative");
    expect(ev.review_reason).toBe("ecommerce_search_hard_negative");
    expect(ev.origin_host).toBe("www.ebay.com");
    // No classifier output for a manual capture.
    expect(ev.model_predicted_label).toBeNull();
    expect(ev.model_confidence).toBeNull();
    expect(ev.model_top_3).toEqual([]);
    expect(ev.runtime_action_taken_by_model).toBe(false);

    // No unsafe keys: no full URL, no coordinates, no raw bytes.
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("http://");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain(TINY_PNG_B64);
    expect(ev).not.toHaveProperty("url");
    expect(ev).not.toHaveProperty("current_url");
    expect(ev).not.toHaveProperty("cdp_url");
  });

  it("skips safely (no queue line) when the screenshot fails", async () => {
    withFlag(true);
    const root = tmpRoot();
    const queue = path.join(root, "queue.jsonl");
    const result = await captureManualVisualReviewCandidate(
      { cdpUrl: "http://localhost:9222", originHost: "example.com", captureReason: "ecommerce_search_hard_negative" },
      { captureRedactedFrame: failShot, frameRoot: path.join(root, "frames"), queuePath: queue, now: fixedNow },
    );
    expect(result).toEqual({ captured: false, skip_reason: "redaction_failed" });
    expect(readQueueLines(queue)).toHaveLength(0);
  });

  it("skips when there is no session (cdpUrl missing)", async () => {
    withFlag(true);
    const root = tmpRoot();
    const queue = path.join(root, "queue.jsonl");
    const result = await captureManualVisualReviewCandidate(
      { cdpUrl: null, originHost: "example.com", captureReason: "ecommerce_search_hard_negative" },
      { captureRedactedFrame: okShot, frameRoot: path.join(root, "frames"), queuePath: queue, now: fixedNow },
    );
    expect(result).toEqual({ captured: false, skip_reason: "no_session" });
    expect(readQueueLines(queue)).toHaveLength(0);
  });
});
