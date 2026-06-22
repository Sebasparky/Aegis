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
  resolveDevArtifactsRoot,
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

  it("the frame path sent to the sidecar exists on disk AND the queued frame_path resolves from repo root", async () => {
    let sentToSidecar: string | undefined;
    const { seams, queue } = onSeams({
      callSidecar: async (absFramePath: string) => {
        sentToSidecar = absFramePath;
        return mkResult("cookie_banner", 0.97);
      },
    });
    await evaluateVisualJudgment(
      { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost: "shop.example.com" },
      seams,
    );

    // 1. The runtime passes the ACTUAL on-disk absolute path to the sidecar.
    expect(typeof sentToSidecar).toBe("string");
    expect(path.isAbsolute(sentToSidecar as string)).toBe(true);
    expect(fs.existsSync(sentToSidecar as string)).toBe(true);

    // 2. The queued frame_path is non-absolute and resolves from the repo root to the
    //    same on-disk file (no dev-artifacts/ prefix drop, no absolute path leak).
    const ev = readQueue(queue)[0];
    expect(typeof ev.frame_path).toBe("string");
    expect(path.isAbsolute(ev.frame_path as string)).toBe(false);
    const repoRoot = path.dirname(resolveDevArtifactsRoot());
    const resolved = path.resolve(repoRoot, ev.frame_path as string);
    expect(resolved).toBe(sentToSidecar);
    expect(fs.existsSync(resolved)).toBe(true);
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
      "live_policy_shadow",
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

    // The shadow block also carries ONLY safe scalar/enum keys.
    const shadow = ev.live_policy_shadow as Record<string, unknown>;
    const allowedShadow = new Set([
      "shadow_only",
      "live_policy_enabled",
      "domain_allowed",
      "policy_decision",
      "policy_action",
      "should_suppress_heuristic_stop",
      "live_policy_runtime_action_taken",
      "hv_action_threshold",
      "benign_suppression_threshold",
      "policy_reason",
    ]);
    for (const k of Object.keys(shadow)) expect(allowedShadow.has(k)).toBe(true);
    for (const forbidden of ["url", "page_url", "selector", "x", "y", "base64", "png", "cdp_url", "raw_text", "origin_host"]) {
      expect(shadow[forbidden]).toBeUndefined();
    }
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

  // ── Live-policy SHADOW telemetry (computed, never acted on this slice) ──────
  describe("live-policy shadow", () => {
    type Shadow = {
      shadow_only: boolean;
      live_policy_enabled: boolean;
      domain_allowed: boolean;
      policy_decision: string;
      policy_action: string;
      should_suppress_heuristic_stop: boolean;
      live_policy_runtime_action_taken: boolean;
      hv_action_threshold: number;
      benign_suppression_threshold: number;
      policy_reason: string;
    };

    async function runWith(over: Partial<EvaluateVisualJudgmentSeams>, originHost = "h.example.com") {
      const { seams, queue } = onSeams(over);
      const out = await evaluateVisualJudgment(
        { sessionId: "s1", activationReason: "possible_human_verification", cdpUrl: "ws://x", originHost },
        seams,
      );
      const ev = readQueue(queue)[0];
      return { out, ev, shadow: ev.live_policy_shadow as unknown as Shadow };
    }

    it("high-confidence benign → shadow visual_benign_suppression_candidate, but NO live-policy runtime action", async () => {
      // 0.97 ≥ the 0.95 live benign-suppression threshold ⇒ suppression CANDIDATE in shadow.
      const { out, ev, shadow } = await runWith({ callSidecar: async () => mkResult("cookie_banner", 0.97) });
      expect(shadow.policy_decision).toBe("visual_benign_suppression_candidate");
      // Shadow never acts: live policy disabled this slice.
      expect(shadow.should_suppress_heuristic_stop).toBe(false);
      expect(shadow.live_policy_runtime_action_taken).toBe(false);
      // The REAL (existing) behavior is unchanged and still driven solely by decideOutcome:
      // benign ≥ 0.80 & not dry-run ⇒ the existing path suppresses and sets the top-level flag.
      expect(out.suppress).toBe(true);
      expect(ev.runtime_action_taken_by_model).toBe(true);
    });

    it("high-confidence page_level_hv_wall → shadow visual_hv_confirmed, no suppression", async () => {
      const { out, shadow } = await runWith({ callSidecar: async () => mkResult(HV_WALL_LABEL, 0.95) });
      expect(shadow.policy_decision).toBe("visual_hv_confirmed");
      expect(shadow.should_suppress_heuristic_stop).toBe(false);
      expect(shadow.live_policy_runtime_action_taken).toBe(false);
      expect(out.suppress).toBe(false);
    });

    it("low-confidence page_level_hv_wall → shadow visual_low_confidence_hv, no suppression", async () => {
      const { out, shadow } = await runWith({ callSidecar: async () => mkResult(HV_WALL_LABEL, 0.7) });
      expect(shadow.policy_decision).toBe("visual_low_confidence_hv");
      expect(shadow.live_policy_runtime_action_taken).toBe(false);
      expect(out.suppress).toBe(false);
    });

    it("sidecar/model unavailable → shadow visual_runtime_no_action, fail-safe to heuristic", async () => {
      const { out, shadow } = await runWith({ callSidecar: async () => null });
      expect(shadow.policy_decision).toBe("visual_runtime_no_action");
      expect(shadow.live_policy_runtime_action_taken).toBe(false);
      // Existing heuristic behavior preserved.
      expect(out.suppress).toBe(false);
      expect(out.outcome).toBe("uncertain");
    });

    it("DRY-RUN benign: existing path does not suppress; shadow still records the decision, no live action", async () => {
      process.env[DRY] = "true";
      const { out, ev, shadow } = await runWith({ callSidecar: async () => mkResult("cookie_banner", 0.97) });
      // Existing dry-run behavior unchanged: no suppression.
      expect(out.suppress).toBe(false);
      expect(ev.runtime_action_taken_by_model).toBe(false);
      // Shadow still surfaces the meaningful decision but takes no live action.
      expect(shadow.policy_decision).toBe("visual_benign_suppression_candidate");
      expect(shadow.live_policy_runtime_action_taken).toBe(false);
    });

    it("shadow block carries the full safe field set with the slice's literal gate values", async () => {
      const { shadow } = await runWith({ callSidecar: async () => mkResult("cookie_banner", 0.97) });
      expect(shadow.shadow_only).toBe(true);
      expect(shadow.live_policy_enabled).toBe(false);
      expect(shadow.domain_allowed).toBe(false);
      expect(shadow.policy_action).toBe("dry_run_only");
      expect(shadow.hv_action_threshold).toBe(0.85);
      expect(shadow.benign_suppression_threshold).toBe(0.95);
      expect(typeof shadow.policy_reason).toBe("string");
    });

    it("evaluateVisualJudgment return shape is unchanged (no new top-level return keys)", async () => {
      const { out } = await runWith({ callSidecar: async () => mkResult("cookie_banner", 0.97) });
      expect(Object.keys(out).sort()).toEqual(["outcome", "ran", "result", "suppress"]);
    });
  });
});
