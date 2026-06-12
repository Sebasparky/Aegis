/**
 * Antigen Runtime Flag / Status diagnostics.
 *
 * Proves the GET /api/runtime/status endpoint and the startup log line:
 *  - reflect effective flag values in this process,
 *  - return ONLY the explicit allowlist (no arbitrary process.env),
 *  - never leak secret-like env vars or the CDP URL,
 *  - return 404 in production.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { runtimeStatusRoutes } from "../routes/runtime-status.js";
import { formatAntigenRuntimeFlagsLine } from "../runtime/antigenRuntimeFlags.js";

const TOP_LEVEL_KEYS = ["ok", "service", "environment", "pid", "uptime_seconds", "antigen"];
const ANTIGEN_KEYS = [
  "click_verify",
  "active_surfaces",
  "surface_resolve",
  "logical_recovery",
  "human_verification",
  "fill_state",
  "pointer_timing",
  "browser_trace",
  "timing_debug",
  "require_antigen_tools",
  "headless",
  "cdp_port_configured",
];

// Env vars this suite mutates; restored in afterEach.
const MUTATED = [
  "NODE_ENV",
  "ANTIGEN_CLICK_VERIFY",
  "ANTIGEN_ACTIVE_SURFACES",
  "ANTIGEN_SURFACE_RESOLVE",
  "ANTIGEN_FILL_STATE",
  "ANTIGEN_POINTER_TIMING",
  "ANTIGEN_BROWSER_HEADLESS",
  "AEGIS_PLAYWRIGHT_CDP_URL",
  "FAKE_SECRET_TOKEN",
  "AEGIS_EXTENSION_SECRET",
];

let server: FastifyInstance;
const original: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of MUTATED) original[k] = process.env[k];
  server = Fastify({ logger: false });
  await server.register(runtimeStatusRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  for (const k of MUTATED) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

async function getStatus() {
  return server.inject({ method: "GET", url: "/api/runtime/status" });
}

describe("GET /api/runtime/status", () => {
  it("reflects effective flag values from the process env", async () => {
    delete process.env.NODE_ENV;
    process.env.ANTIGEN_CLICK_VERIFY = "true";
    process.env.ANTIGEN_ACTIVE_SURFACES = "true";
    process.env.ANTIGEN_POINTER_TIMING = "fast";

    const res = await getStatus();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("aegis-api");
    expect(body.antigen.click_verify).toBe(true);
    expect(body.antigen.active_surfaces).toBe(true);
    expect(body.antigen.pointer_timing).toBe("fast");
    expect(typeof body.pid).toBe("number");
    expect(typeof body.uptime_seconds).toBe("number");
  });

  it("reports fill_state=true when ANTIGEN_FILL_STATE is set — the live-smoke Step 0 gate", async () => {
    // The post_fill_state live-smoke absence was exactly this: the flag was set
    // in the adapter shell but not the API process. /api/runtime/status is the
    // mandatory pre-smoke check that catches it.
    process.env.ANTIGEN_FILL_STATE = "true";
    const body = (await getStatus()).json();
    expect(body.antigen.fill_state).toBe(true);
  });

  it("reports fill_state=false by default (flag unset)", async () => {
    delete process.env.ANTIGEN_FILL_STATE;
    const body = (await getStatus()).json();
    expect(body.antigen.fill_state).toBe(false);
  });

  it("non-'true' values resolve to false / realistic default", async () => {
    process.env.ANTIGEN_CLICK_VERIFY = "1";
    delete process.env.ANTIGEN_ACTIVE_SURFACES;
    delete process.env.ANTIGEN_POINTER_TIMING;

    const body = (await getStatus()).json();
    expect(body.antigen.click_verify).toBe(false);
    expect(body.antigen.active_surfaces).toBe(false);
    expect(body.antigen.pointer_timing).toBe("realistic");
  });

  it("returns ONLY the allowlisted keys (no arbitrary env)", async () => {
    const body = (await getStatus()).json();
    expect(Object.keys(body).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
    expect(Object.keys(body.antigen).sort()).toEqual([...ANTIGEN_KEYS].sort());
  });

  it("does not leak secret-like env vars or their values", async () => {
    process.env.FAKE_SECRET_TOKEN = "leakme-token-123";
    process.env.AEGIS_EXTENSION_SECRET = "extsecret-456";

    const raw = (await getStatus()).body;
    expect(raw).not.toContain("FAKE_SECRET_TOKEN");
    expect(raw).not.toContain("leakme-token-123");
    expect(raw).not.toContain("AEGIS_EXTENSION_SECRET");
    expect(raw).not.toContain("extsecret-456");
    // No general process.env dump.
    expect(raw).not.toContain(process.env.PATH ?? "__no_path__");
    expect(raw).not.toContain("HOME");
  });

  it("reports CDP as a boolean only, never the URL", async () => {
    process.env.AEGIS_PLAYWRIGHT_CDP_URL = "http://localhost:9222";
    const res = await getStatus();
    const body = res.json();
    expect(body.antigen.cdp_port_configured).toBe(true);
    expect(res.body).not.toContain("http://localhost:9222");
    expect(res.body).not.toContain("localhost:9222");
  });

  it("returns 404 in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await getStatus();
    expect(res.statusCode).toBe(404);
    expect(res.json().ok).toBe(false);
  });
});

describe("formatAntigenRuntimeFlagsLine", () => {
  it("produces a sanitized one-line summary with the expected tokens", () => {
    process.env.AEGIS_PLAYWRIGHT_CDP_URL = "http://localhost:9222";
    const line = formatAntigenRuntimeFlagsLine();
    expect(line.startsWith("[AntigenRuntimeFlags] ")).toBe(true);
    expect(line).toContain("pointer_timing=");
    expect(line).toContain("cdp_port_configured=true");
    // The raw CDP URL must never appear in the log line.
    expect(line).not.toContain("http://localhost:9222");
  });

  it("includes fill_state in the startup line, tracking the env flag", () => {
    process.env.ANTIGEN_FILL_STATE = "true";
    expect(formatAntigenRuntimeFlagsLine()).toContain("fill_state=true");
    delete process.env.ANTIGEN_FILL_STATE;
    expect(formatAntigenRuntimeFlagsLine()).toContain("fill_state=false");
  });
});
