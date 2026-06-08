// ─── Antigen browser latency instrumentation (dev-only, gated) ───────────────
//
// Lightweight wall-clock timing for the snapshot/click hot paths, gated behind
// ANTIGEN_BROWSER_TIMING_DEBUG=true. Off by default → zero overhead (single env
// read + early return).
//
// SAFETY: timing output carries ONLY a stage label, a duration in ms, and an
// optional small set of pre-sanitized scalar attributes (numbers/booleans/short
// enum-like strings). It must NEVER include cookies, secrets, HTML, raw
// credential/card/profile values, CDP URLs/tokens, coordinates/boxes, or
// query-bearing hrefs. Callers are responsible for passing only safe scalars in
// `attrs`; do not pass URLs, refs with embedded values, or geometry here.

/** Timing logs are emitted only when the dev flag is explicitly set. */
export function timingEnabled(): boolean {
  return process.env.ANTIGEN_BROWSER_TIMING_DEBUG === "true";
}

type SafeAttr = string | number | boolean | null | undefined;

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function msSince(startNs: bigint): number {
  // Nanoseconds → milliseconds with 2-decimal precision.
  return Number(nowNs() - startNs) / 1_000_000;
}

/** Clip a free-text attribute to a short, log-safe enum-like token. */
function safeToken(value: SafeAttr): SafeAttr {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (s.length === 0) return undefined;
  // Allow only short, low-cardinality tokens (profile names, status codes).
  return s.length > 48 ? s.slice(0, 48) : s;
}

function formatAttrs(attrs?: Record<string, SafeAttr>): string {
  if (!attrs) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    const safe = safeToken(v);
    if (safe === undefined) continue;
    parts.push(`${k}=${safe}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/**
 * A measurement scope for one hot-path operation (e.g. one snapshot or one
 * click). Collects per-stage durations and emits a single sanitized summary
 * line. When timing is disabled, every method is a no-op.
 */
export class BrowserTimingScope {
  private readonly label: string;
  private readonly enabled: boolean;
  private readonly startNs: bigint;
  private lastNs: bigint;
  private readonly stages: Array<{ name: string; ms: number }> = [];

  constructor(label: string) {
    this.label = label;
    this.enabled = timingEnabled();
    this.startNs = nowNs();
    this.lastNs = this.startNs;
  }

  /** Record the elapsed time since the previous mark (or scope start). */
  mark(stage: string): void {
    if (!this.enabled) return;
    const now = nowNs();
    const ms = Number(now - this.lastNs) / 1_000_000;
    this.lastNs = now;
    this.stages.push({ name: stage, ms: Math.round(ms * 100) / 100 });
  }

  /** Emit the sanitized per-stage timing summary for this scope. */
  end(attrs?: Record<string, SafeAttr>): void {
    if (!this.enabled) return;
    const total = Math.round(msSince(this.startNs) * 100) / 100;
    const breakdown = this.stages.map((s) => `${s.name}=${s.ms}ms`).join(" ");
    // eslint-disable-next-line no-console
    console.log(`[AntigenTiming] ${this.label} total=${total}ms ${breakdown}${formatAttrs(attrs)}`);
  }
}

/**
 * Time a single awaited stage in isolation and emit one sanitized line. Returns
 * the awaited value untouched. No-op wrapper (just awaits) when disabled.
 */
export async function timeStage<T>(
  label: string,
  fn: () => Promise<T>,
  attrs?: Record<string, SafeAttr>,
): Promise<T> {
  if (!timingEnabled()) return fn();
  const startNs = nowNs();
  try {
    return await fn();
  } finally {
    const ms = Math.round(msSince(startNs) * 100) / 100;
    // eslint-disable-next-line no-console
    console.log(`[AntigenTiming] ${label}=${ms}ms${formatAttrs(attrs)}`);
  }
}
