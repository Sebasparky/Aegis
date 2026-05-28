/**
 * Input Realism Typer — unit tests.
 *
 * Pure unit tests: no real browser, no real CDP connection.
 * sendCdp and sleep are injected mocks; Math.random is seeded via opts.random.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCharCountBucket,
  getInputRealismMode,
  typeCharsViaCDP,
} from "../runtime/inputRealismTyper.js";

// ─── getCharCountBucket ───────────────────────────────────────────────────────

describe("getCharCountBucket", () => {
  it.each([
    [1, "1-4"],
    [4, "1-4"],
    [5, "5-8"],
    [8, "5-8"],
    [9, "9-16"],
    [16, "9-16"],
    [17, "17+"],
    [30, "17+"],
    [100, "17+"],
  ])("len=%i → %s", (len, expected) => {
    expect(getCharCountBucket(len)).toBe(expected);
  });
});

// ─── getInputRealismMode ──────────────────────────────────────────────────────

describe("getInputRealismMode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns realistic when env is unset", () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "");
    expect(getInputRealismMode()).toBe("realistic");
  });

  it("returns direct for fast", () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "fast");
    expect(getInputRealismMode()).toBe("direct");
  });

  it("returns direct for disabled", () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "disabled");
    expect(getInputRealismMode()).toBe("direct");
  });

  it("returns direct for false", () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "false");
    expect(getInputRealismMode()).toBe("direct");
  });

  it("returns realistic when set to realistic", () => {
    vi.stubEnv("ANTIGEN_INPUT_REALISM", "realistic");
    expect(getInputRealismMode()).toBe("realistic");
  });
});

// ─── typeCharsViaCDP — dispatch count ────────────────────────────────────────

describe("typeCharsViaCDP — dispatch count", () => {
  const mockSleep = vi.fn().mockResolvedValue(undefined);
  const mockSend = vi.fn();

  beforeEach(() => {
    mockSleep.mockClear();
    mockSend.mockClear();
  });

  it("dispatches one Input.dispatchKeyEvent per character", async () => {
    const value = "test";
    await typeCharsViaCDP(mockSend, mockSleep, {
      value,
      fieldKind: "username",
      injectionRequestId: "inj_test",
      domain: "example.com",
      random: () => 0.5,
    });

    const keyEvents = mockSend.mock.calls.filter(
      (c) => c[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(value.length);
  });

  it("dispatches correct number of events for 8-char value", async () => {
    const value = "abcdefgh";
    await typeCharsViaCDP(mockSend, mockSleep, {
      value,
      fieldKind: "password",
      injectionRequestId: "inj_test",
      domain: "example.com",
      random: () => 0.5,
    });

    const keyEvents = mockSend.mock.calls.filter(
      (c) => c[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(8);
  });

  it("dispatches zero events for empty value", async () => {
    await typeCharsViaCDP(mockSend, mockSleep, {
      value: "",
      fieldKind: "username",
      injectionRequestId: "inj_test",
      domain: "example.com",
    });

    const keyEvents = mockSend.mock.calls.filter(
      (c) => c[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(0);
  });

  it("each key event has type:char", async () => {
    await typeCharsViaCDP(mockSend, mockSleep, {
      value: "ab",
      fieldKind: "username",
      injectionRequestId: "inj_test",
      domain: "example.com",
    });

    const keyEvents = mockSend.mock.calls.filter(
      (c) => c[0] === "Input.dispatchKeyEvent",
    );
    for (const [, params] of keyEvents) {
      expect((params as Record<string, unknown>).type).toBe("char");
    }
  });
});

// ─── typeCharsViaCDP — sleep timing ──────────────────────────────────────────

describe("typeCharsViaCDP — sleep timing", () => {
  const mockSend = vi.fn();

  beforeEach(() => {
    mockSend.mockClear();
  });

  it("sleeps within username profile range (25–75 ms) per char, plus pre-type 50ms", async () => {
    const sleepCalls: number[] = [];
    const captureSleep = async (ms: number) => { sleepCalls.push(ms); };
    const value = "user@eg.com"; // 11 chars

    await typeCharsViaCDP(mockSend, captureSleep, {
      value,
      fieldKind: "username",
      injectionRequestId: "inj_sleep",
      domain: "example.com",
      random: () => 0.5,
    });

    // First sleep is the pre-type 50ms pause
    expect(sleepCalls[0]).toBe(50);
    // Remaining sleeps are per-char (random=0.5 → midpoint)
    for (const ms of sleepCalls.slice(1)) {
      expect(ms).toBeGreaterThanOrEqual(25);
      expect(ms).toBeLessThanOrEqual(75);
    }
    // Total sleep calls = 1 (pre-type) + value.length
    expect(sleepCalls).toHaveLength(1 + value.length);
  });

  it("sleeps within password profile range (45–95 ms) per char", async () => {
    const sleepCalls: number[] = [];
    const captureSleep = async (ms: number) => { sleepCalls.push(ms); };

    await typeCharsViaCDP(mockSend, captureSleep, {
      value: "pass",
      fieldKind: "password",
      injectionRequestId: "inj_sleep_pw",
      domain: "example.com",
      random: () => 0.5,
    });

    for (const ms of sleepCalls.slice(1)) {
      expect(ms).toBeGreaterThanOrEqual(45);
      expect(ms).toBeLessThanOrEqual(95);
    }
  });
});

// ─── typeCharsViaCDP — result shape ──────────────────────────────────────────

describe("typeCharsViaCDP — result shape", () => {
  const mockSleep = vi.fn().mockResolvedValue(undefined);
  const mockSend = vi.fn();

  beforeEach(() => {
    mockSend.mockClear();
    mockSleep.mockClear();
  });

  it("returns strategy:key_events on normal path", async () => {
    const result = await typeCharsViaCDP(mockSend, mockSleep, {
      value: "hello",
      fieldKind: "username",
      injectionRequestId: "inj_res",
      domain: "example.com",
    });
    expect(result.strategy).toBe("key_events");
    expect(result.success).toBe(true);
  });

  it("returns correct char_count_bucket in result", async () => {
    const result = await typeCharsViaCDP(mockSend, mockSleep, {
      value: "sixsix", // length 6 → "5-8"
      fieldKind: "password",
      injectionRequestId: "inj_bucket",
      domain: "example.com",
    });
    expect(result.char_count_bucket).toBe("5-8");
  });

  it("returns success:false and failure_reason when sendCdp throws", async () => {
    const throwingSend = vi.fn().mockImplementation(() => {
      throw new Error("WebSocket closed");
    });

    const result = await typeCharsViaCDP(throwingSend, mockSleep, {
      value: "abc",
      fieldKind: "username",
      injectionRequestId: "inj_fail",
      domain: "example.com",
    });

    expect(result.success).toBe(false);
    expect(result.failure_reason).toBe("send_failed");
  });
});

// ─── typeCharsViaCDP — secret-safe logs ──────────────────────────────────────

describe("typeCharsViaCDP — secret-safe logs", () => {
  const mockSleep = vi.fn().mockResolvedValue(undefined);
  const mockSend = vi.fn();

  beforeEach(() => {
    mockSend.mockClear();
    mockSleep.mockClear();
  });

  it("never logs the full raw value", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const secretValue = "hunter2secure99";

    await typeCharsViaCDP(mockSend, mockSleep, {
      value: secretValue,
      fieldKind: "password",
      injectionRequestId: "inj_safe",
      domain: "example.com",
    });

    for (const call of consoleSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secretValue);
    }

    consoleSpy.mockRestore();
  });

  it("never logs forbidden keys in log objects", async () => {
    const loggedObjects: Record<string, unknown>[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      for (const arg of args) {
        if (arg && typeof arg === "object") {
          loggedObjects.push(arg as Record<string, unknown>);
        }
      }
    });

    await typeCharsViaCDP(mockSend, mockSleep, {
      value: "mypassword",
      fieldKind: "password",
      injectionRequestId: "inj_keys",
      domain: "example.com",
    });

    const forbiddenKeys = [
      "value", "text", "char", "chars", "raw_value",
      "resolvedValue", "password", "secret",
    ];

    for (const obj of loggedObjects) {
      for (const key of forbiddenKeys) {
        expect(Object.keys(obj)).not.toContain(key);
      }
    }

    consoleSpy.mockRestore();
  });

  it("logs only approved fields in typing_started event", async () => {
    const loggedObjects: Record<string, unknown>[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      for (const arg of args) {
        if (arg && typeof arg === "object") {
          loggedObjects.push(arg as Record<string, unknown>);
        }
      }
    });

    await typeCharsViaCDP(mockSend, mockSleep, {
      value: "abc",
      fieldKind: "username",
      injectionRequestId: "inj_approved",
      domain: "example.com",
    });

    const approvedKeys = new Set([
      "injection_request_id", "field_kind", "domain",
      "strategy", "duration_ms", "char_count_bucket", "success", "failure_reason",
    ]);

    for (const obj of loggedObjects) {
      for (const key of Object.keys(obj)) {
        expect(approvedKeys.has(key)).toBe(true);
      }
    }

    consoleSpy.mockRestore();
  });
});
