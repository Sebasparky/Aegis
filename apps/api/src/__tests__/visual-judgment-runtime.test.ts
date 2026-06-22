/**
 * Activation-Gated Visual Judgment v0 — runtime adapter.
 *
 * Asserts the safety contract: flag-off is byte-identical (no capture, no sidecar
 * call, no queue write); the three-outcome decision policy and conservative
 * thresholds; benign suppression only when high-confidence AND not dry-run;
 * fail-soft to `uncertain` when the sidecar is unavailable; and that every queued
 * review event carries SAFE metadata only (hostname, enums, label/confidence) —
 * never a full URL, selector, coordinate, or screenshot byte.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BENIGN_LABELS,
  HV_WALL_LABEL,
  decideOutcome,
  evaluateVisualJudgment,
  __resetVisualJudgmentStatus,
  type EvaluateVisualJudgmentSeams,
} from "../runtime/visualBlockerClassifier/visualJudgment.js";
import type { VisualJudgmentResult } from "../runtime/visualBlockerClassifier/runtimeSeam.js";

const ENABLE = "ANTIGEN_VISUAL_JUDGMENT_ENABLED";
const DRY = "ANTIGEN_VISUAL_JUDGMENT_DRY_RUN";
const QUEUE = "ANTIGEN_VISUAL_JUDGMENT_QUEUE";
const HV_T = "ANTIGEN_VISUAL_JUDGMENT_HV_THRESHOLD";
const BENIGN_T = "ANTIGEN_VISUAL_JUDGMENT_BENIGN_THRESHOLD";

// 1x1 transparent PNG — stands in for a redacted frame.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function mkResult(label: string, confidence: number): VisualJudgmentResult {
  return {
    predictedLabel: label,
    confidence,
    topLabels: [{ label, confidence }],
    needsHumanReview: confidence < 0.6,
    advisoryOnly: true,
    source: "model",
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aegis-vj-"));
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const k of [ENABLE, DRY, QUEUE, HV_T, BENIGN_T]) delete process.env[k];
  // restore anything the suite may have changed
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) if (process.env[k] === undefined) process.env[k] = v;
  __resetVisualJudgmentStatus();
});

describe("decideOutcome (pure policy)", () => {
  it("high-confidence page_level_hv_wall → confident_human_needed, never suppress", () => {
    const d = decideOutcome(mkResult(HV_WALL_LABEL, 0.92), false);
    expect(d.outcome).toBe("confident_human_needed");
    expect(d.suppress).toBe(false);
    expect(d.review_reason).toBe("high_consequence_prediction");
  });

  it("high-confidence benign → confident_false_positive_or_benign, suppress when not dry-run", () => {
    const d = decideOutcome(mkResult("cookie_banner", 0.95), false);
    expect(d.outcome).toBe("confident_false_positive_or_benign");
    expect(d.suppress).toBe(true);
    expect(d.review_reason).toBe("benign_suppression");
  });

  it("high-confidence benign in DRY-RUN → benign outcome but NO suppression", () => {
    const d = decideOutcome(mkResult("newsletter_modal", 0.99), true);
    expect(d.outcome).toBe("confident_false_positive_or_benign");
    expect(d.suppress).toBe(false);
  });

  it("page_level_hv_wall BELOW the HV threshold → uncertain (high-consequence reason)", () => {
    const d = decideOutcome(mkResult(HV_WALL_LABEL, 0.7), false);
    expect(d.outcome).toBe("uncertain");
    expect(d.suppress).toBe(false);
    expect(d.review_reason).toBe("high_consequence_prediction");
  });

  it("benign BELOW the benign threshold → uncertain, no suppression", () => {
    const d = decideOutcome(mkResult("sign_in_drawer", 0.5), false);
    expect(d.outcome).toBe("uncertain");
    expect(d.suppress).toBe(false);
    expect(d.review_reason).toBe("uncertain_fallback");
  });

  it("unknown label → uncertain", () => {
    const d = decideOutcome(mkResult("something_else", 0.99), false);
    expect(d.outcome).toBe("uncertain");
    expect(d.suppress).toBe(false);
  });

  it("null result (sidecar unavailable) → uncertain, classifier_unavailable, no suppression", () => {
    const d = decideOutcome(null, false);
    expect(d.outcome).toBe("uncertain");
    expect(d.suppress).toBe(false);
    expect(d.review_reason).toBe("classifier_unavailable");
  });

  it("all listed benign labels are suppressible at high confidence; HV label is not benign", () => {
    for (const label of BENIGN_LABELS) {
      expect(decideOutcome(mkResult(label, 0.9), false).suppress).toBe(true);
    }
    expect((BENIGN_LABELS as readonly string[]).includes(HV_WALL_LABEL)).toBe(false);
  });
});

describe("evaluateVisualJudgment — flag off (byte-identical)", () => {
  it("returns {ran:false,suppress:false} with NO capture, NO sidecar call, NO queue write", async () => {
    const queue = path.join(tmpDir(), "q.jsonl");
    process.env[QUEUE] = queue;
    // ENABLE intentionally unset.
    let captured = false;
    let asked = false;
    const seams: EvaluateVisualJudgmentSeams = {
      captureRedactedFrame: async () => {
        captured = true;
        return { ok: true, base64: TINY_PNG_B64 };
      },
      callSidecar: async () => {
        asked = true;
        return mkResult("cookie_banner", 0.99);
      },
    };
    const out = await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost: "example.com" },
      seams,
    );
    expect(out).toEqual({ ran: false, suppress: false });
    expect(captured).toBe(false);
    expect(asked).toBe(false);
    expect(fs.existsSync(queue)).toBe(false);
  });
});

describe("evaluateVisualJudgment — flag on", () => {
  function onSeams(over: Partial<EvaluateVisualJudgmentSeams> = {}): {
    seams: EvaluateVisualJudgmentSeams;
    frameRoot: string;
    queue: string;
  } {
    const dir = tmpDir();
    const frameRoot = path.join(dir, "frames");
    const queue = path.join(dir, "q.jsonl");
    process.env[ENABLE] = "true";
    process.env[QUEUE] = queue;
    const seams: EvaluateVisualJudgmentSeams = {
      captureRedactedFrame: async () => ({ ok: true, base64: TINY_PNG_B64 }),
      callSidecar: async () => mkResult("cookie_banner", 0.97),
      frameRoot,
      now: () => new Date("2026-06-22T00:00:00.000Z"),
      ...over,
    };
    return { seams, frameRoot, queue };
  }

  function readQueue(queue: string): Record<string, unknown>[] {
    return fs
      .readFileSync(queue, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("high-confidence benign → suppress, frame written, safe review event queued", async () => {
    const { seams, frameRoot, queue } = onSeams();
    const out = await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost: "shop.example.com" },
      seams,
    );
    expect(out.ran).toBe(true);
    expect(out.suppress).toBe(true);
    expect(out.outcome).toBe("confident_false_positive_or_benign");

    const events = readQueue(queue);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.outcome).toBe("confident_false_positive_or_benign");
    expect(ev.runtime_action_taken_by_model).toBe(true);
    expect(ev.origin_host).toBe("shop.example.com");
    expect(ev.review_status).toBe("pending");
    expect(ev.human_label).toBeNull();
    expect(ev.model_predicted_label).toBe("cookie_banner");
    // frame written under the dev-local root, path is relative (no absolute fs leak)
    expect(typeof ev.frame_path).toBe("string");
    expect(path.isAbsolute(ev.frame_path as string)).toBe(false);
    expect(fs.existsSync(path.join(frameRoot, "2026-06-22"))).toBe(true);
  });

  it("DRY-RUN: benign verdict is logged but does NOT suppress", async () => {
    process.env[DRY] = "true";
    const { seams, queue } = onSeams();
    const out = await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost: "h.example.com" },
      seams,
    );
    expect(out.suppress).toBe(false);
    const ev = readQueue(queue)[0];
    expect(ev.outcome).toBe("confident_false_positive_or_benign");
    expect(ev.runtime_action_taken_by_model).toBe(false);
  });

  it("sidecar unavailable → uncertain, no suppression, classifier_unavailable queued (no throw)", async () => {
    const { seams, queue } = onSeams({ callSidecar: async () => null });
    const out = await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost: "h.example.com" },
      seams,
    );
    expect(out.suppress).toBe(false);
    expect(out.outcome).toBe("uncertain");
    const ev = readQueue(queue)[0];
    expect(ev.review_reason).toBe("classifier_unavailable");
    expect(ev.model_predicted_label).toBeNull();
  });

  it("high-confidence page_level_hv_wall → NO suppression (conservative), high_consequence logged", async () => {
    const { seams, queue } = onSeams({ callSidecar: async () => mkResult(HV_WALL_LABEL, 0.95) });
    const out = await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost: "h.example.com" },
      seams,
    );
    expect(out.suppress).toBe(false);
    expect(out.outcome).toBe("confident_human_needed");
    expect(readQueue(queue)[0].review_reason).toBe("high_consequence_prediction");
  });

  it("queued review event contains ONLY the safe metadata keys", async () => {
    const { seams, queue } = onSeams();
    await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost: "h.example.com" },
      seams,
    );
    const ev = readQueue(queue)[0];
    const allowed = new Set([
      "schema_version",
      "event_id",
      "created_at",
      "session_id",
      "activation_reason",
      "trigger_basis",
      "origin_host",
      "frame_path",
      "model_predicted_label",
      "model_confidence",
      "model_top_3",
      "outcome",
      "runtime_action_taken_by_model",
      "human_label",
      "review_status",
      "review_reason",
    ]);
    for (const k of Object.keys(ev)) expect(allowed.has(k)).toBe(true);
    // explicit negative assertions against the forbidden classes
    for (const forbidden of ["url", "page_url", "selector", "x", "y", "base64", "png", "cdp_url", "raw_text"]) {
      expect(ev[forbidden]).toBeUndefined();
    }
    // origin_host must be a bare hostname, never a URL
    expect(String(ev.origin_host)).not.toContain("/");
  });

  it("no frame captured (cdpUrl null) → uncertain, frame_path null, still queued", async () => {
    const { seams, queue } = onSeams();
    const out = await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: null, originHost: "h.example.com" },
      seams,
    );
    expect(out.suppress).toBe(false);
    expect(out.outcome).toBe("uncertain");
    expect(readQueue(queue)[0].frame_path).toBeNull();
  });
});
