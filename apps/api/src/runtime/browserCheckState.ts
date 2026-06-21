// ─── Browser-Check Interstitial Telemetry v1 — runtime session state ──────────
//
// Tracks, per browser session, whether recent antigen_snapshots observed a
// passive browser-check interstitial (Cloudflare-style "Checking your browser" /
// "Just a moment"). These are NOT human-verification challenges: the agent's
// browser frequently passes them passively by waiting, and that behavior MUST be
// preserved. This module is instrumentation/classification ONLY — it never clicks,
// solves, waits, or bypasses anything.
//
// The marker lets us distinguish a transient interstitial that clears on a later
// snapshot (`passed`) from one that persists across snapshots (`stuck`), and to
// note when one escalates into a real challenge (`escalated_to_hv`). The "stuck"
// vs "passed" distinction is inherently cross-snapshot, so it needs this per-
// session memory — a single snapshot can never be "stuck".
//
// Memory-only by design: the marker is re-derived from each fresh snapshot and is
// cleared on resolution (passed / escalated) and on session teardown, so it never
// outlives the situation that armed it. It carries only a hostname plus internal
// timestamps/count — never page text, URLs, geometry, or refs. Only safe enums /
// booleans / coarse buckets are ever emitted as telemetry; `observation_count` is
// internal and surfaces only as a bucket.

/** Browser-check telemetry flag — strictly opt-in; default off is byte-identical. */
export function isBrowserCheckTelemetryEnabled(): boolean {
  return process.env.ANTIGEN_BROWSER_CHECK_TELEMETRY === "true";
}

/**
 * Safe browser-check telemetry logger. No-op unless ANTIGEN_BROWSER_CHECK_TELEMETRY
 * is set, so call sites are byte-identical when the flag is off. Callers MUST pass
 * only safe scalars (booleans, enums, coarse buckets, hostnames, ids that are
 * already non-sensitive) — never raw page text, coordinates, URLs, iframe src,
 * screenshot paths, or user values. Mirrors the logHvDebug discipline.
 */
export function logBrowserCheckDebug(
  fields: Record<string, string | number | boolean>,
): void {
  if (!isBrowserCheckTelemetryEnabled()) return;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  // eslint-disable-next-line no-console
  console.log(`[BrowserCheck] ${parts.join(" ")}`);
}

export interface BrowserCheckMarker {
  domain: string;
  first_seen_at: number; // epoch ms — first snapshot that saw the interstitial
  last_seen_at: number; // epoch ms — most recent snapshot that saw it
  observation_count: number; // number of snapshots that have seen it this episode
}

/** Outcome of a single snapshot's browser-check evaluation. */
export type BrowserCheckOutcome = "none" | "seen" | "passed" | "stuck" | "escalated_to_hv";

/** Coarse, safe-to-emit bucket for the internal observation count. */
export type BrowserCheckObservationBucket = "0" | "1" | "2" | "3+";

const browserCheckMarkers = new Map<string, BrowserCheckMarker>();

/**
 * Record that THIS snapshot saw the interstitial. Creates the marker on first
 * sight (count = 1) and increments + refreshes last_seen on subsequent sights.
 * first_seen_at is set once and never moved, so elapsed time grows monotonically
 * across the episode.
 */
export function recordBrowserCheckSeen(
  browserSessionId: string,
  domain: string,
  now: number = Date.now(),
): void {
  const existing = browserCheckMarkers.get(browserSessionId);
  if (existing) {
    existing.last_seen_at = now;
    existing.observation_count += 1;
    browserCheckMarkers.set(browserSessionId, existing);
    return;
  }
  browserCheckMarkers.set(browserSessionId, {
    domain,
    first_seen_at: now,
    last_seen_at: now,
    observation_count: 1,
  });
}

export function getBrowserCheckMarker(browserSessionId: string): BrowserCheckMarker | undefined {
  return browserCheckMarkers.get(browserSessionId);
}

export function clearBrowserCheck(browserSessionId: string): void {
  browserCheckMarkers.delete(browserSessionId);
}

export function clearAllBrowserCheckForTests(): void {
  browserCheckMarkers.clear();
}

/** Number of consecutive sightings before an interstitial is treated as stuck. */
const STUCK_MIN_OBSERVATIONS = 2;
/** Secondary safeguard: wall-clock since first sight before treating as stuck. */
const STUCK_MIN_ELAPSED_MS = 12_000;

/**
 * Whether a PRIOR marker (the state BEFORE this snapshot's increment) already
 * represents a stuck interstitial. Evaluated on the prior marker so that a first
 * sight (no prior marker) can never be classified as stuck. Count is the primary
 * trigger (the interstitial was already seen on an earlier snapshot and did not
 * clear); the elapsed window is a secondary safeguard for slow re-snapshot cadence.
 */
export function isBrowserCheckStuck(
  marker: BrowserCheckMarker,
  now: number = Date.now(),
): boolean {
  return (
    marker.observation_count >= STUCK_MIN_OBSERVATIONS ||
    now - marker.first_seen_at >= STUCK_MIN_ELAPSED_MS
  );
}

/** Map an internal observation count to a safe, coarse bucket for telemetry. */
export function browserCheckObservationBucket(count: number): BrowserCheckObservationBucket {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  return "3+";
}

export interface EvaluateBrowserCheckTransitionArgs {
  /** A real HV / blocker path engaged on this snapshot (mint OR raw detection). */
  hvEscalated: boolean;
  /** This snapshot saw a passive browser-check phrase. */
  phraseSeen: boolean;
  /** Page is (near-)empty or fully scrimmed — the interstitial shape. */
  pageBlocked: boolean;
  /** Page has rich interactive content — strong "page is normally usable" signal. */
  richUsable: boolean;
  /** The marker BEFORE this snapshot (undefined ⇒ no prior sighting). */
  prior: BrowserCheckMarker | undefined;
  now: number;
}

export interface BrowserCheckTransition {
  outcome: BrowserCheckOutcome;
  /** Interstitial was seen this episode (seen / stuck / escalated). */
  seen: boolean;
  /** True ONLY for `stuck` — drives the surface-boundary route. */
  stuck_for_route: boolean;
  /** Caller should call recordBrowserCheckSeen after evaluation. */
  record: boolean;
  /** Caller should call clearBrowserCheck after evaluation (episode ended). */
  clear: boolean;
  /** Safe coarse bucket of the resulting observation count. */
  observation_count_bucket: BrowserCheckObservationBucket;
}

/**
 * Pure transition function for the browser-check state machine. Side-effect free
 * (the caller applies record/clear) and total. `now` is injected for testability.
 *
 * Precedence: a real HV/blocker (hvEscalated) always wins — the episode is handed
 * to the existing human-verification path and reported as escalated_to_hv. The
 * stuck determination reads the PRIOR marker so a first sight is always `seen`,
 * never `stuck`. `passed` requires the phrase to be gone AND the page to look
 * usable (rich content, or simply no longer blocked) — a phrase-gone page still
 * in the unusable "dead band" holds as `none` rather than prematurely declaring
 * the check passed.
 */
export function evaluateBrowserCheckTransition(
  a: EvaluateBrowserCheckTransitionArgs,
): BrowserCheckTransition {
  // 1. Escalation — a real challenge appeared. HV owns the episode; clear ours.
  if (a.hvEscalated) {
    if (a.prior || a.phraseSeen) {
      return {
        outcome: "escalated_to_hv",
        seen: true,
        stuck_for_route: false,
        record: false,
        clear: true,
        observation_count_bucket: browserCheckObservationBucket(a.prior?.observation_count ?? 0),
      };
    }
    // No browser-check involvement at all — leave HV to its own handling.
    return {
      outcome: "none",
      seen: false,
      stuck_for_route: false,
      record: false,
      clear: false,
      observation_count_bucket: "0",
    };
  }

  // 2. Interstitial present this snapshot.
  if (a.phraseSeen) {
    const priorStuck = a.prior ? isBrowserCheckStuck(a.prior, a.now) : false;
    const nextCount = (a.prior?.observation_count ?? 0) + 1;
    if (priorStuck) {
      return {
        outcome: "stuck",
        seen: true,
        stuck_for_route: true,
        record: true,
        clear: false,
        observation_count_bucket: browserCheckObservationBucket(nextCount),
      };
    }
    return {
      outcome: "seen",
      seen: true,
      stuck_for_route: false,
      record: true,
      clear: false,
      observation_count_bucket: browserCheckObservationBucket(nextCount),
    };
  }

  // 3. No interstitial this snapshot. Resolve a prior episode if the page is now
  //    usable; otherwise (dead band, still loading) hold without declaring passed.
  if (a.prior && (a.richUsable || !a.pageBlocked)) {
    return {
      outcome: "passed",
      seen: true,
      stuck_for_route: false,
      record: false,
      clear: true,
      observation_count_bucket: browserCheckObservationBucket(a.prior.observation_count),
    };
  }

  return {
    outcome: "none",
    seen: false,
    stuck_for_route: false,
    record: false,
    clear: false,
    observation_count_bucket: browserCheckObservationBucket(a.prior?.observation_count ?? 0),
  };
}
