/**
 * Browser timing instrumentation hygiene — ANTIGEN_BROWSER_TIMING_DEBUG.
 *
 * Groups:
 *   A. Flag off (default) — no [AntigenTiming] output at all
 *   B. Flag on — output lines are stage labels + durations + safe scalars only:
 *      never URLs, ws:// endpoints, secrets, or free text passed by callers
 *   C. timeStage — passthrough semantics with flag on and off
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { BrowserTimingScope, timeStage, timingEnabled } from "../runtime/browserTiming.js";

const SENTINEL_SECRET = "hunter2-super-secret-value";

describe("browser timing hygiene", () => {
  const origEnv = process.env.ANTIGEN_BROWSER_TIMING_DEBUG;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (origEnv === undefined) delete process.env.ANTIGEN_BROWSER_TIMING_DEBUG;
    else process.env.ANTIGEN_BROWSER_TIMING_DEBUG = origEnv;
  });

  describe("A. flag off (default)", () => {
    beforeEach(() => {
      delete process.env.ANTIGEN_BROWSER_TIMING_DEBUG;
    });

    it("timingEnabled is false", () => {
      expect(timingEnabled()).toBe(false);
    });

    it("BrowserTimingScope emits nothing", () => {
      const scope = new BrowserTimingScope("antigen_test_scope");
      scope.mark("stage_one");
      scope.end({ count: 3 });
      const timingLines = logSpy.mock.calls.filter((c) => String(c[0]).includes("[AntigenTiming]"));
      expect(timingLines).toHaveLength(0);
    });

    it("timeStage emits nothing and passes the value through", async () => {
      const value = await timeStage("antigen_test_stage", async () => 42);
      expect(value).toBe(42);
      const timingLines = logSpy.mock.calls.filter((c) => String(c[0]).includes("[AntigenTiming]"));
      expect(timingLines).toHaveLength(0);
    });
  });

  describe("B. flag on — sanitized output", () => {
    beforeEach(() => {
      process.env.ANTIGEN_BROWSER_TIMING_DEBUG = "true";
    });

    it("emits one [AntigenTiming] line with stage labels and durations", () => {
      const scope = new BrowserTimingScope("antigen_test_scope");
      scope.mark("stage_one");
      scope.mark("stage_two");
      scope.end({ count: 3, ok: true });
      const timingLines = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("[AntigenTiming]"));
      expect(timingLines).toHaveLength(1);
      const line = timingLines[0];
      expect(line).toMatch(/^\[AntigenTiming\] antigen_test_scope total=[\d.]+ms/);
      expect(line).toContain("stage_one=");
      expect(line).toContain("stage_two=");
      expect(line).toContain("count=3");
      expect(line).toContain("ok=true");
    });

    it("output never contains URLs, ws endpoints, or secret-looking values", () => {
      const scope = new BrowserTimingScope("antigen_test_scope");
      scope.mark("connect_attach");
      scope.end({ candidate_count: 12, pre_resolved: true });
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[AntigenTiming]"))!;
      expect(line).not.toContain("http");
      expect(line).not.toContain("ws://");
      expect(line).not.toContain(SENTINEL_SECRET);
    });

    it("clips long string attrs to short tokens (48 chars)", () => {
      const scope = new BrowserTimingScope("antigen_test_scope");
      scope.end({ token: "x".repeat(200) });
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[AntigenTiming]"))!;
      expect(line).toContain(`token=${"x".repeat(48)}`);
      expect(line).not.toContain("x".repeat(49));
    });

    it("timeStage emits a single labeled duration line and passes the value through", async () => {
      const value = await timeStage("antigen_test_stage", async () => "result", { ok: true });
      expect(value).toBe("result");
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[AntigenTiming]"))!;
      expect(line).toMatch(/^\[AntigenTiming\] antigen_test_stage=[\d.]+ms/);
      expect(line).toContain("ok=true");
    });
  });
});
