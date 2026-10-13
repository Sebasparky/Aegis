/**
 * antigen-browser-adapter stderr invariant tests.
 *
 * The adapter owns stdin/stdout for MCP protocol piping. All diagnostic
 * output — startup messages, errors, fatal exits — must go to stderr only.
 * Writing anything non-JSON-RPC to stdout would corrupt the MCP stream.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolves to <repo-root>/examples/antigen-browser-adapter.mjs
// from <repo-root>/apps/api/src/__tests__/
const ADAPTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/antigen-browser-adapter.mjs",
);

// Canonical diagnostic prefix: the adapter tags every stderr line with its
// contract version, e.g. "[antigen-browser@2026-05-29]" (ADAPTER_VERSION in
// examples/antigen-browser-adapter.mjs). Match the versioned form rather than a
// specific date so a version bump does not break the stderr-only invariant test.
const ADAPTER_STDERR_PREFIX = /\[antigen-browser@\d{4}-\d{2}-\d{2}\]/;

function runAdapter(env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  const result = spawnSync("node", [ADAPTER_PATH], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
  };
}

describe("antigen-browser-adapter — stderr-only diagnostic output", () => {
  it("writes missing-token error to stderr, not stdout", () => {
    const { stdout, stderr, exitCode } = runAdapter({
      AEGIS_AGENT_TOKEN: "",
      AEGIS_API_BASE: "http://localhost:4000",
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(ADAPTER_STDERR_PREFIX);
    expect(stderr).toMatch(/AEGIS_AGENT_TOKEN/i);
    // stdout must be empty — no diagnostic text should leak to the MCP channel
    expect(stdout).toBe("");
  });

  it("writes missing-base error to stderr, not stdout", () => {
    const { stdout, stderr, exitCode } = runAdapter({
      AEGIS_AGENT_TOKEN: "tok_test",
      AEGIS_API_BASE: "",
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(ADAPTER_STDERR_PREFIX);
    expect(stderr).toMatch(/AEGIS_API_BASE/i);
    expect(stdout).toBe("");
  });

  it("writes network error to stderr, not stdout", () => {
    // Point at an unreachable port so fetch() throws immediately
    const { stdout, stderr, exitCode } = runAdapter({
      AEGIS_AGENT_TOKEN: "tok_test",
      AEGIS_API_BASE: "http://localhost:19999",
    });

    expect(exitCode).not.toBe(0);
    // Error goes to stderr
    expect(stderr).toMatch(ADAPTER_STDERR_PREFIX);
    // stdout remains empty — MCP channel is not polluted
    expect(stdout).toBe("");
  });

  it("stdout contains only valid JSON-RPC or is empty (never plain-text diagnostic messages)", () => {
    const { stdout } = runAdapter({
      AEGIS_AGENT_TOKEN: "tok_test",
      AEGIS_API_BASE: "http://localhost:19999",
    });

    // If stdout is non-empty, each line must be valid JSON (MCP protocol frames)
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
