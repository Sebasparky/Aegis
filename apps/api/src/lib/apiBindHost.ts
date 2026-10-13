/**
 * API bind-address policy.
 *
 * Internal routes (`/api/*`, `/api/internal/*`, `/api/dev/*`) and the product UI have no
 * network authentication: every request acts as the single mock user. The only thing that
 * keeps those routes private is that the API listens on a loopback interface. This module
 * enforces that assumption at startup instead of leaving it as a documentation note.
 *
 * - Default bind host is `127.0.0.1` (IPv4 loopback).
 * - `AEGIS_API_BIND_HOST` may select `::1` (IPv6 loopback) or `localhost` (Fastify 4 binds
 *   both loopback families when the host OS provides both).
 * - Anything else — `0.0.0.0`, `::`, a LAN address, a hostname — is refused with
 *   `UnsafeApiBindHostError`. There is no authenticated exposure mode in this codebase, so
 *   there is intentionally no override flag.
 *
 * IPv4 vs IPv6: binding `127.0.0.1` does not answer `http://[::1]:4000`. Browsers and Node 20
 * (`autoSelectFamily`) try both families when connecting to `localhost`, so the default works
 * for the web UI and the example clients. Set `AEGIS_API_BIND_HOST=localhost` if a client on
 * this machine can only reach IPv6 loopback.
 */

export const API_BIND_HOST_ENV = "AEGIS_API_BIND_HOST";
export const DEFAULT_API_BIND_HOST = "127.0.0.1";
export const LOOPBACK_BIND_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

export type LoopbackBindHost = (typeof LOOPBACK_BIND_HOSTS)[number];
export type BindFamily = "ipv4" | "ipv6" | "dual";

export interface ApiBindTarget {
  host: LoopbackBindHost;
  family: BindFamily;
  source: "default" | "env";
}

export class UnsafeApiBindHostError extends Error {
  readonly code = "UNSAFE_API_BIND_HOST" as const;
  readonly requested: string;

  constructor(requested: string) {
    super(
      `[startup] Refusing to bind the Antigen API to "${requested}". ` +
        `Internal routes have no network authentication, so the API only listens on a loopback ` +
        `interface. Allowed ${API_BIND_HOST_ENV} values: ${LOOPBACK_BIND_HOSTS.join(", ")} ` +
        `(default ${DEFAULT_API_BIND_HOST}). There is no authenticated exposure mode; ` +
        `if you need remote access, put the API behind an authenticating reverse proxy or a VPN ` +
        `and keep this bind on loopback.`,
    );
    this.name = "UnsafeApiBindHostError";
    this.requested = requested;
  }
}

/** Lower-cases, trims, and strips IPv6 brackets (`[::1]` → `::1`). */
export function normalizeBindHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

export function isLoopbackBindHost(host: string): host is LoopbackBindHost {
  return (LOOPBACK_BIND_HOSTS as readonly string[]).includes(host);
}

export function bindFamilyFor(host: LoopbackBindHost): BindFamily {
  if (host === "127.0.0.1") return "ipv4";
  if (host === "::1") return "ipv6";
  return "dual";
}

/**
 * Resolves the bind host from the environment. Throws `UnsafeApiBindHostError` for any
 * non-loopback value so a misconfiguration fails before the server starts listening.
 */
export function resolveApiBindHost(env: NodeJS.ProcessEnv = process.env): ApiBindTarget {
  const raw = env[API_BIND_HOST_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { host: DEFAULT_API_BIND_HOST, family: "ipv4", source: "default" };
  }
  const host = normalizeBindHost(raw);
  if (!isLoopbackBindHost(host)) {
    throw new UnsafeApiBindHostError(raw.trim());
  }
  return { host, family: bindFamilyFor(host), source: "env" };
}

/** One-line startup banner that reports the actual bound addresses, not an assumed URL. */
export function formatApiBindBanner(
  target: ApiBindTarget,
  port: number,
  boundAddresses: ReadonlyArray<{ address: string; port: number; family?: string }> = [],
): string {
  const bound = boundAddresses.length
    ? boundAddresses
        .map((a) => (a.address.includes(":") ? `http://[${a.address}]:${a.port}` : `http://${a.address}:${a.port}`))
        .join(", ")
    : `http://${target.host.includes(":") ? `[${target.host}]` : target.host}:${port}`;
  return (
    `Antigen API listening on ${bound} ` +
    `(bind host ${target.host}, ${target.family} loopback, ${target.source}). ` +
    `Loopback only: internal routes have no network authentication.`
  );
}
