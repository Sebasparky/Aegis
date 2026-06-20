/**
 * VisualBlockerClassifier capture-and-skip — pure helper unit tests.
 *
 * Covers the status mapping and the safe 422 response builder. The endpoint wiring
 * (flag gating, VGC suppression, 422 return) is covered in
 * antigen-capture-and-skip-endpoint.test.ts.
 */

import { describe, it, expect } from "vitest";

import {
  mapCaptureResultToBlockerStatus,
  buildVisualBlockerCapturedResponse,
} from "../runtime/visualBlockerClassifier/captureAndSkip.js";
import type {
  VisionDatasetCaptureResult,
  VisualClassifierCandidate,
} from "../runtime/visualBlockerClassifier/types.js";

function candidate(
  overrides: Partial<VisualClassifierCandidate> = {},
): VisualClassifierCandidate {
  return {
    candidate_id: "cand_unsafe_should_not_leak",
    browser_session_id: "tbsess_unsafe_should_not_leak",
    domain: "secret.example.com",
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
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("mapCaptureResultToBlockerStatus", () => {
  it("maps a written record to capture_written", () => {
    expect(mapCaptureResultToBlockerStatus({ written: true })).toBe("capture_written");
  });

  it("maps in-capture failures (redaction/write) to capture_attempted", () => {
    for (const skip_reason of ["redaction_failed", "redaction_unverified", "write_failed"] as const) {
      const r: VisionDatasetCaptureResult = { written: false, skip_reason };
      expect(mapCaptureResultToBlockerStatus(r)).toBe("capture_attempted");
    }
  });

  it("maps pre-capture skips (throttle/no-session/flags) to capture_skipped", () => {
    for (const skip_reason of ["rate_limited", "no_session", "flag_disabled", "not_a_candidate"] as const) {
      const r: VisionDatasetCaptureResult = { written: false, skip_reason };
      expect(mapCaptureResultToBlockerStatus(r)).toBe("capture_skipped");
    }
  });
});

describe("buildVisualBlockerCapturedResponse", () => {
  it("builds the canonical safe skip body", () => {
    const body = buildVisualBlockerCapturedResponse({
      candidate: candidate({
        trigger_basis: "opaque_dominant_surface",
        candidate_reason: "opaque_iframe",
      }),
      blocker_status: "capture_written",
    });
    expect(body).toEqual({
      ok: false,
      error: {
        code: "ANTIGEN_VISUAL_BLOCKER_CAPTURED",
        message:
          "A visual blocker was detected and captured for training. Skip this site or path and continue elsewhere.",
        blocker_status: "capture_written",
        suggested_agent_action: "skip_and_continue",
        trigger_basis: "opaque_dominant_surface",
        candidate_reason: "opaque_iframe",
      },
    });
  });

  it("sources trigger_basis / candidate_reason from the candidate", () => {
    const body = buildVisualBlockerCapturedResponse({
      candidate: candidate({
        trigger_basis: "unreadable_dominant_surface",
        candidate_reason: "visual_dom_mismatch",
      }),
      blocker_status: "capture_attempted",
    });
    expect(body.error.trigger_basis).toBe("unreadable_dominant_surface");
    expect(body.error.candidate_reason).toBe("visual_dom_mismatch");
    expect(body.error.blocker_status).toBe("capture_attempted");
  });

  it("never leaks unsafe fields (candidate_id, domain, session, signals, coords, bytes)", () => {
    const body = buildVisualBlockerCapturedResponse({
      candidate: candidate(),
      blocker_status: "capture_skipped",
    });
    const raw = JSON.stringify(body);
    for (const forbidden of [
      "cand_unsafe_should_not_leak",
      "tbsess_unsafe_should_not_leak",
      "secret.example.com",
      "candidate_id",
      "browser_session_id",
      "domain",
      "signals",
      "created_at",
      "dominant_surface_kind",
      "png_base64",
      "base64",
      "\"box\"",
      "\"x\":",
      "\"y\":",
      "frame.png",
      "meta.json",
      "http",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // Only the four safe error keys + code/message are present.
    expect(Object.keys(body)).toEqual(["ok", "error"]);
    expect(Object.keys(body.error).sort()).toEqual(
      [
        "blocker_status",
        "candidate_reason",
        "code",
        "message",
        "suggested_agent_action",
        "trigger_basis",
      ].sort(),
    );
  });
});
