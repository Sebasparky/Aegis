/**
 * API bind-address policy tests.
 *
 * The API's internal routes have no network authentication; the loopback bind is the
 * boundary. These tests pin: default is IPv4 loopback, IPv6 loopback and `localhost` are
 * the only alternatives, and every non-loopback value is refused with a typed error.
 */

import { describe, it, expect } from "vitest";
import {
  API_BIND_HOST_ENV,
  DEFAULT_API_BIND_HOST,
  LOOPBACK_BIND_HOSTS,
  UnsafeApiBindHostError,
  formatApiBindBanner,
  isLoopbackBindHost,
  normalizeBindHost,
  resolveApiBindHost,
} from "../lib/apiBindHost.js";

describe("resolveApiBindHost — default", () => {
  it("defaults to 127.0.0.1 when the env var is absent", () => {
    const target = resolveApiBindHost({});
    expect(target).toEqual({ host: "127.0.0.1", family: "ipv4", source: "default" });
    expect(DEFAULT_API_BIND_HOST).toBe("127.0.0.1");
  });

  it("treats an empty or whitespace-only env var as absent", () => {
    expect(resolveApiBindHost({ [API_BIND_HOST_ENV]: "" }).host).toBe("127.0.0.1");
    expect(resolveApiBindHost({ [API_BIND_HOST_ENV]: "   " }).host).toBe("127.0.0.1");
  });

  it("never defaults to 0.0.0.0", () => {
    expect(resolveApiBindHost({}).host).not.toBe("0.0.0.0");
  });
});

describe("resolveApiBindHost — explicit loopback values", () => {
  it("accepts IPv4 loopback", () => {
    expect(resolveApiBindHost({ [API_BIND_HOST_ENV]: "127.0.0.1" })).toEqual({
      host: "127.0.0.1",
      family: "ipv4",
      source: "env",
    });
  });

  it("accepts IPv6 loopback, with or without brackets", () => {
    expect(resolveApiBindHost({ [API_BIND_HOST_ENV]: "::1" })).toEqual({ host: "::1", family: "ipv6", source: "env" });
    expect(resolveApiBindHost({ [API_BIND_HOST_ENV]: "[::1]" })).toEqual({ host: "::1", family: "ipv6", source: "env" });
  });

  it("accepts localhost as the dual-family loopback option", () => {
    expect(resolveApiBindHost({ [API_BIND_HOST_ENV]: "localhost" })).toEqual({
      host: "localhost",
      family: "dual",
      source: "env",
    });
    expect(resolveApiBindHost({ [API_BIND_HOST_ENV]: " LocalHost " }).host).toBe("localhost");
  });

  it("exposes exactly the three loopback hosts as the allowlist", () => {
    expect([...LOOPBACK_BIND_HOSTS]).toEqual(["127.0.0.1", "::1", "localhost"]);
    for (const h of LOOPBACK_BIND_HOSTS) expect(isLoopbackBindHost(h)).toBe(true);
  });
});

describe("resolveApiBindHost — refuses non-loopback binds", () => {
  const unsafe = [
    "0.0.0.0",
    "::",
    "[::]",
    "0:0:0:0:0:0:0:0",
    "192.168.1.20",
    "10.0.0.5",
    "172.16.0.9",
    "127.0.0.2", // loopback range, but not on the explicit allowlist
    "localhost.localdomain",
    "example.com",
    "aegis.internal",
    "fe80::1",
    "*",
  ];

  for (const value of unsafe) {
    it(`refuses "${value}" with UnsafeApiBindHostError`, () => {
      let caught: unknown;
      try {
        resolveApiBindHost({ [API_BIND_HOST_ENV]: value });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnsafeApiBindHostError);
      const e = caught as UnsafeApiBindHostError;
      expect(e.code).toBe("UNSAFE_API_BIND_HOST");
      expect(e.requested).toBe(value);
      expect(e.message).toContain("no network authentication");
      expect(e.message).toContain("127.0.0.1");
      expect(isLoopbackBindHost(normalizeBindHost(value))).toBe(false);
    });
  }

  it("does not offer an override flag: no env var can force a non-loopback bind", () => {
    const attempts: NodeJS.ProcessEnv[] = [
      { [API_BIND_HOST_ENV]: "0.0.0.0", AEGIS_API_ALLOW_EXTERNAL_BIND: "true" },
      { [API_BIND_HOST_ENV]: "0.0.0.0", NODE_ENV: "production" },
      { [API_BIND_HOST_ENV]: "0.0.0.0", AEGIS_API_EXPOSE: "1" },
    ];
    for (const env of attempts) {
      expect(() => resolveApiBindHost(env)).toThrow(UnsafeApiBindHostError);
    }
  });
});

describe("normalizeBindHost", () => {
  it("trims, lower-cases, and strips IPv6 brackets", () => {
    expect(normalizeBindHost("  [::1] ")).toBe("::1");
    expect(normalizeBindHost("LOCALHOST")).toBe("localhost");
    expect(normalizeBindHost("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("formatApiBindBanner", () => {
  it("reports the actual bound addresses when provided", () => {
    const banner = formatApiBindBanner(
      { host: "localhost", family: "dual", source: "env" },
      4000,
      [
        { address: "127.0.0.1", port: 4000, family: "IPv4" },
        { address: "::1", port: 4000, family: "IPv6" },
      ],
    );
    expect(banner).toContain("http://127.0.0.1:4000");
    expect(banner).toContain("http://[::1]:4000");
    expect(banner).toContain("dual loopback");
    expect(banner).toContain("no network authentication");
  });

  it("falls back to the configured host when no bound addresses are known", () => {
    const banner = formatApiBindBanner({ host: "127.0.0.1", family: "ipv4", source: "default" }, 4000);
    expect(banner).toContain("http://127.0.0.1:4000");
    expect(banner).toContain("default");
    expect(banner).not.toContain("0.0.0.0");
  });

  it("brackets an IPv6 bind host in the fallback URL", () => {
    const banner = formatApiBindBanner({ host: "::1", family: "ipv6", source: "env" }, 4000);
    expect(banner).toContain("http://[::1]:4000");
  });
});
