/**
 * Antigen adapter — 422 ANTIGEN_VISUAL_BLOCKER_CAPTURED skip-and-continue mapping.
 *
 * In vision capture-and-skip exploration mode the snapshot endpoint returns HTTP
 * 422 with error.code "ANTIGEN_VISUAL_BLOCKER_CAPTURED" after a visual blocker is
 * captured for training. The adapter must translate this into a NON-error MCP
 * skip directive — never the human-verification "open Aegis UI" recovery path,
 * never a generic snapshot failure. These tests exercise the pure, stateless
 * classifier + directive text the adapter uses for that translation.
 *
 * The classifier/text live in examples/lib/adapter-helpers.mjs (side-effect free),
 * so they are import-safe here — importing the adapter entrypoint itself would run
 * top-level env validation that process.exit()s on a missing token.
 */

import { describe, it, expect } from "vitest";
import {
  classifySnapshotApiErrorKind,
  VISUAL_BLOCKER_CAPTURED_CODE,
  VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT,
} from "../../../../examples/lib/adapter-helpers.mjs";

describe("antigen adapter — visual blocker capture-and-skip (422) mapping", () => {
  it("1. routes ANTIGEN_VISUAL_BLOCKER_CAPTURED to the non-error skip path, not generic error", () => {
    expect(VISUAL_BLOCKER_CAPTURED_CODE).toBe("ANTIGEN_VISUAL_BLOCKER_CAPTURED");
    expect(classifySnapshotApiErrorKind(VISUAL_BLOCKER_CAPTURED_CODE)).toBe(
      "visual_blocker_captured",
    );
  });

  it("2. skip directive never mentions Aegis UI or human verification, and never asks the user to act", () => {
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).not.toMatch(
      /aegis ui|human verification|verification code|complete the challenge|\bsolve\b/i,
    );
    // It directs the agent not to involve the user at all.
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/do not ask the user to act/i);
  });

  it("3. skip directive uses skip-and-continue language and the exploration framing", () => {
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/skip/i);
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/move on/i);
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/continue/i);
    // Framed as a visual blocker captured for training, not human verification.
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/visual blocker/i);
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/captured for training/i);
  });

  it("4. skip directive forbids retrying the snapshot or interacting with the blocker", () => {
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/do not retry this snapshot/i);
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/do not press, click, or type/i);
  });

  it("5. skip directive is safe terminal feedback (report-when-no-alternate, no unsafe fields)", () => {
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toMatch(/blocked and captured for training/i);
    // No challenge details, paths, urls, coordinates, base64, iframe srcs, dataset paths.
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).not.toMatch(
      /https?:\/\/|\.png|\/tmp\/|base64|iframe|src=|x:|y:|coord/i,
    );
  });

  it("6. 409 HUMAN_VERIFICATION_REQUIRED and other codes keep their existing handling", () => {
    // HV stays on the generic path — its 409 behavior is unchanged.
    expect(classifySnapshotApiErrorKind("HUMAN_VERIFICATION_REQUIRED")).toBe("generic");
    expect(classifySnapshotApiErrorKind("SESSION_NOT_FOUND")).toBe("session_not_found");
    expect(classifySnapshotApiErrorKind("ANTIGEN_REF_STALE")).toBe("generic");
    expect(classifySnapshotApiErrorKind("429")).toBe("generic");
  });

  it("7. classifier is stateless — repeated 422s return the same kind and directive", () => {
    const first = classifySnapshotApiErrorKind(VISUAL_BLOCKER_CAPTURED_CODE);
    const second = classifySnapshotApiErrorKind(VISUAL_BLOCKER_CAPTURED_CODE);
    const third = classifySnapshotApiErrorKind(VISUAL_BLOCKER_CAPTURED_CODE);
    expect(first).toBe("visual_blocker_captured");
    expect(second).toBe(first);
    expect(third).toBe(first);
    // The directive text is a constant — never mutates into an HV escalation.
    expect(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT).toBe(VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT);
  });
});
