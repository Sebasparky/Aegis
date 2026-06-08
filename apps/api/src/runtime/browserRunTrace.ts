// ─── Dev-Only Antigen Browser Run Trace ──────────────────────────────────────
//
// A tiny, bounded, in-memory, sanitized trace of Antigen browser tool calls,
// keyed by browser_runtime_id. It exists so broad agent-realistic QA (e.g.
// "search shelves on Reddit, then add to cart on IKEA") can be evaluated from
// evidence — proving what the agent actually did across endpoint creation,
// navigation, snapshots, scrolls, typing, and clicks.
//
// This is behavior-neutral diagnostics: recording NEVER changes any agent-facing
// tool result, and is gated behind ANTIGEN_BROWSER_TRACE=true (off by default,
// zero overhead in production). Trace output is internal-only — it must never be
// returned to an agent.
//
// LEAK GUARANTEE: events are assembled field-by-field from an explicit allowlist
// (never spread from caller input). Trace output never contains cdp_url,
// user_data_dir, profile paths, pass_id, secret_ref, passwords, cookies,
// storage, raw DOM, coordinates (x/y/width/height/doc_x/doc_y), nearby_text, or
// raw typed text. URLs are reduced to host + clipped path with all query strings
// and fragments stripped.

import {
  ANTIGEN_RECOVERY_STATES,
  ANTIGEN_SANITIZED_STALE_REASONS,
  type AntigenRecoveryState,
  type AntigenSanitizedStaleReason,
} from "./antigenLogicalRecovery.js";

const MAX_EVENTS_PER_SESSION = 200;
const MAX_SESSIONS = 50;
// Retention is based on LAST ACTIVITY, not creation time — a trace that keeps
// receiving events stays alive, and only expires once it has been idle for the
// full TTL. The 60-minute window gives manual QA a long-enough evidence window
// while remaining bounded by MAX_SESSIONS / MAX_EVENTS_PER_SESSION.
const TRACE_TTL_MS = 60 * 60 * 1000; // 60 minutes (dev QA window)
const MAX_STR = 200;

export type BrowserTraceEventType =
  | "browser_endpoint_created"
  | "navigation_state"
  | "antigen_snapshot"
  | "browser_scroll_to_ref"
  | "browser_click"
  | "browser_type"
  // Rejected/orphan call: a runtime tool was invoked with a browser_runtime_id
  // that did not resolve to a live session (SESSION_NOT_FOUND). Recorded in the
  // route handler's !session branch — keyed by the supplied (stale) id — so a
  // stale-session continuity failure is visible in the trace instead of leaving
  // a silent gap. Carries only `tool` + `error_code` (no internals).
  | "browser_tool_rejected"
  // Tool-surface disposition: which surface handled a browser tool call and how
  // it resolved. Posted by the Antigen adapter (a separate process) via the
  // internal disposition route — it exists to make tool-surface BYPASS visible.
  // A trace can record navigation while sensitive snapshots/clicks happen through
  // a child @playwright/mcp (untraced); a disposition event marks that surface
  // explicitly. Carries only `tool`, `tool_surface`, `disposition`,
  // `result_code`, `error_code` (enum-gated; no internals).
  | "browser_tool_disposition"
  // Navigation discipline (Antigen Browser Realism v1): records whether a
  // browser_navigate was an acceptable direct jump or a shortcut around visible
  // refs, and (in QA hard mode) whether it was blocked. Posted by the Antigen
  // adapter via the internal navigation-disposition route. Carries only
  // `navigation_disposition` (enum-gated), a short clipped `navigation_reason`,
  // and host+path-reduced url_before/url_after — no query strings or internals.
  | "browser_navigation_disposition";

/** Which surface handled a browser tool call. */
export type BrowserToolSurface =
  | "aegis_backend"
  | "antigen_adapter"
  | "adapter_child_playwright"
  | "raw_playwright";

/** How an Antigen-adapter browser tool call resolved. */
export type BrowserToolDisposition =
  | "antigen_backend"
  | "adapter_child_forwarded"
  | "raw_fallback"
  | "failed"
  | "blocked_by_antigen_required";

const BROWSER_TOOL_SURFACES = new Set<BrowserToolSurface>([
  "aegis_backend",
  "antigen_adapter",
  "adapter_child_playwright",
  "raw_playwright",
]);

const BROWSER_TOOL_DISPOSITIONS = new Set<BrowserToolDisposition>([
  "antigen_backend",
  "adapter_child_forwarded",
  "raw_fallback",
  "failed",
  "blocked_by_antigen_required",
]);

/**
 * Navigation-discipline outcome for a browser_navigate call (Antigen Browser
 * Realism v1). The three `direct_navigation_*` values are the primary outcome
 * recorded in `navigation_disposition`; the remaining values are category /
 * reason tags that may also flow through (enum-gated) for forward compatibility.
 */
export type NavigationDisposition =
  | "direct_navigation_allowed"
  | "direct_navigation_warned"
  | "direct_navigation_blocked"
  | "ref_based_navigation_preferred"
  | "initial_navigation"
  | "user_provided_url"
  | "top_level_site_entry"
  | "cross_site_navigation"
  | "same_site_product_deeplink"
  | "same_site_search_deeplink"
  | "cart_deeplink"
  | "no_recent_snapshot"
  | "no_matching_ref"
  | "no_cart_ref";

const NAVIGATION_DISPOSITIONS = new Set<NavigationDisposition>([
  "direct_navigation_allowed",
  "direct_navigation_warned",
  "direct_navigation_blocked",
  "ref_based_navigation_preferred",
  "initial_navigation",
  "user_provided_url",
  "top_level_site_entry",
  "cross_site_navigation",
  "same_site_product_deeplink",
  "same_site_search_deeplink",
  "cart_deeplink",
  "no_recent_snapshot",
  "no_matching_ref",
  "no_cart_ref",
]);

export interface BrowserTraceEvent {
  ts: string;
  event_type: BrowserTraceEventType;
  browser_runtime_id: string;
  url_before?: string;
  url_after?: string;
  tool?: string;
  ref?: string;
  element_name?: string;
  context?: { section?: string; label?: string };
  href_path?: string;
  result_code?: string;
  pointer_dispatch?: boolean;
  click_path?: "ag_ref" | "description";
  snapshot?: {
    viewport_only?: boolean;
    element_count?: number;
    clickable_count?: number;
    typeable_count?: number;
    // Snapshot v2 page-map counts (safe aggregates only — no text/refs/coords).
    primary_action_count?: number;
    warning_count?: number;
  };
  char_count_bucket?: string;
  submit?: boolean;
  error_code?: string;
  // Tool-surface disposition fields (enum-gated). Present on
  // `browser_tool_disposition` events; surface marks who handled the call and
  // disposition marks how it resolved.
  tool_surface?: BrowserToolSurface;
  disposition?: BrowserToolDisposition;
  // Navigation-discipline fields (enum-gated disposition + clipped reason).
  // Present on `browser_navigation_disposition` events.
  navigation_disposition?: NavigationDisposition;
  navigation_reason?: string;
  // Same-page logical-ref recovery fields (enum-gated). Present on browser_click
  // events when an ANTIGEN_REF_STALE was hit: `recovery_state` records the
  // recovery disposition and `stale_reason` is the SANITIZED stale signal (no
  // coordinates, boxes, values, or internal matching details).
  recovery_state?: AntigenRecoveryState;
  stale_reason?: AntigenSanitizedStaleReason;
}

/** Input accepted by recordBrowserTraceEvent — everything except the store-managed `ts`. */
export type BrowserTraceEventInput = Omit<BrowserTraceEvent, "ts">;

interface TraceEntry {
  browser_runtime_id: string;
  created_at: string;
  created_ms: number;
  // Updated on every recorded event — TTL expiry is measured from here, not
  // created_ms, so an actively-used trace does not disappear mid-QA.
  last_event_at: string;
  last_event_ms: number;
  event_count: number;
  events: BrowserTraceEvent[];
}

/**
 * Expiration metadata shared by the per-runtime view and the list summary, so
 * both surface identical fields. Derived purely from timestamps — no internals.
 */
function expiryMeta(
  entry: TraceEntry,
  nowMs: number,
): { last_event_at: string; expires_at: string; ttl_ms: number; age_ms: number } {
  return {
    last_event_at: entry.last_event_at,
    expires_at: new Date(entry.last_event_ms + TRACE_TTL_MS).toISOString(),
    ttl_ms: TRACE_TTL_MS,
    age_ms: Math.max(0, nowMs - entry.last_event_ms),
  };
}

const traces = new Map<string, TraceEntry>();

/** Recording is enabled only when the dev flag is explicitly set. */
export function traceEnabled(): boolean {
  return process.env.ANTIGEN_BROWSER_TRACE === "true";
}

function clip(input: unknown, max = MAX_STR): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim();
  if (s.length === 0) return undefined;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Reduce a URL to `host + path`, stripping query strings and fragments so the
 * trace can distinguish google.com search results from reddit.com thread pages
 * from ikea.com product pages — without leaking query params or sensitive URL
 * data. Falls back to a clipped scheme-less string if the URL cannot be parsed.
 */
export function sanitizeTraceUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || input.trim().length === 0) return undefined;
  const raw = input.trim();
  try {
    const u = new URL(raw);
    const host = u.host;
    const path = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return clip(`${host}${path}`);
  } catch {
    // Not an absolute URL — strip any query/fragment manually and clip.
    const noQuery = raw.split(/[?#]/)[0];
    return clip(noQuery);
  }
}

function deleteExpired(nowMs: number): void {
  for (const [id, entry] of traces) {
    if (nowMs - entry.last_event_ms > TRACE_TTL_MS) traces.delete(id);
  }
}

/**
 * Record a single sanitized trace event. No-op when tracing is disabled. Never
 * throws — diagnostics must not break the tool path. Builds the stored event
 * field-by-field from an allowlist (no spread of caller input).
 */
export function recordBrowserTraceEvent(
  browserRuntimeId: unknown,
  event: BrowserTraceEventInput,
): void {
  if (!traceEnabled()) return;
  if (typeof browserRuntimeId !== "string" || browserRuntimeId.length === 0) return;

  try {
    const now = new Date();
    const nowMs = now.getTime();
    deleteExpired(nowMs);

    const safe: BrowserTraceEvent = {
      ts: now.toISOString(),
      event_type: event.event_type,
      browser_runtime_id: clip(browserRuntimeId) ?? browserRuntimeId,
    };

    const urlBefore = clip(event.url_before);
    if (urlBefore !== undefined) safe.url_before = urlBefore;
    const urlAfter = clip(event.url_after);
    if (urlAfter !== undefined) safe.url_after = urlAfter;
    const tool = clip(event.tool);
    if (tool !== undefined) safe.tool = tool;
    const ref = clip(event.ref);
    if (ref !== undefined) safe.ref = ref;
    const elementName = clip(event.element_name);
    if (elementName !== undefined) safe.element_name = elementName;
    if (event.context) {
      const ctx: { section?: string; label?: string } = {};
      const section = clip(event.context.section);
      if (section !== undefined) ctx.section = section;
      const label = clip(event.context.label);
      if (label !== undefined) ctx.label = label;
      if (ctx.section !== undefined || ctx.label !== undefined) safe.context = ctx;
    }
    const hrefPath = clip(event.href_path);
    if (hrefPath !== undefined) safe.href_path = hrefPath;
    const resultCode = clip(event.result_code);
    if (resultCode !== undefined) safe.result_code = resultCode;
    if (typeof event.pointer_dispatch === "boolean") safe.pointer_dispatch = event.pointer_dispatch;
    if (event.click_path === "ag_ref" || event.click_path === "description") safe.click_path = event.click_path;
    if (event.snapshot) {
      const snap: BrowserTraceEvent["snapshot"] = {};
      if (typeof event.snapshot.viewport_only === "boolean") snap.viewport_only = event.snapshot.viewport_only;
      if (Number.isFinite(event.snapshot.element_count)) snap.element_count = event.snapshot.element_count;
      if (Number.isFinite(event.snapshot.clickable_count)) snap.clickable_count = event.snapshot.clickable_count;
      if (Number.isFinite(event.snapshot.typeable_count)) snap.typeable_count = event.snapshot.typeable_count;
      if (Number.isFinite(event.snapshot.primary_action_count)) snap.primary_action_count = event.snapshot.primary_action_count;
      if (Number.isFinite(event.snapshot.warning_count)) snap.warning_count = event.snapshot.warning_count;
      safe.snapshot = snap;
    }
    const bucket = clip(event.char_count_bucket);
    if (bucket !== undefined) safe.char_count_bucket = bucket;
    if (typeof event.submit === "boolean") safe.submit = event.submit;
    const errorCode = clip(event.error_code);
    if (errorCode !== undefined) safe.error_code = errorCode;
    // Enum-gate disposition fields — never clip arbitrary strings into these.
    if (event.tool_surface !== undefined && BROWSER_TOOL_SURFACES.has(event.tool_surface)) {
      safe.tool_surface = event.tool_surface;
    }
    if (event.disposition !== undefined && BROWSER_TOOL_DISPOSITIONS.has(event.disposition)) {
      safe.disposition = event.disposition;
    }
    // Enum-gate navigation_disposition; clip the free-text navigation_reason.
    if (event.navigation_disposition !== undefined && NAVIGATION_DISPOSITIONS.has(event.navigation_disposition)) {
      safe.navigation_disposition = event.navigation_disposition;
    }
    const navReason = clip(event.navigation_reason);
    if (navReason !== undefined) safe.navigation_reason = navReason;
    // Enum-gate recovery_state + sanitized stale_reason — never clip arbitrary
    // strings into these (they carry no coordinates/values).
    if (event.recovery_state !== undefined && ANTIGEN_RECOVERY_STATES.has(event.recovery_state)) {
      safe.recovery_state = event.recovery_state;
    }
    if (event.stale_reason !== undefined && ANTIGEN_SANITIZED_STALE_REASONS.has(event.stale_reason)) {
      safe.stale_reason = event.stale_reason;
    }

    let entry = traces.get(browserRuntimeId);
    if (!entry) {
      // Bound the number of tracked sessions — drop the oldest on overflow.
      if (traces.size >= MAX_SESSIONS) {
        const oldest = traces.keys().next().value;
        if (oldest) traces.delete(oldest);
      }
      entry = {
        browser_runtime_id: browserRuntimeId,
        created_at: now.toISOString(),
        created_ms: nowMs,
        last_event_at: now.toISOString(),
        last_event_ms: nowMs,
        event_count: 0,
        events: [],
      };
      traces.set(browserRuntimeId, entry);
    }

    // Bound events per session — drop the oldest when full.
    if (entry.events.length >= MAX_EVENTS_PER_SESSION) entry.events.shift();
    entry.events.push(safe);
    entry.event_count += 1;
    // Refresh last-activity so the TTL window slides forward with use.
    entry.last_event_at = safe.ts;
    entry.last_event_ms = nowMs;
  } catch {
    // Diagnostics must never disrupt the tool path.
  }
}

// Antigen-owned action event types — events that prove the agent actually
// snapshotted/clicked/typed THROUGH Antigen. A `browser_tool_disposition` event
// (e.g. adapter_child_forwarded) is deliberately NOT in this set: a trace full of
// child-forwarded dispositions still counts as navigation-only.
const ANTIGEN_ACTION_EVENT_TYPES = new Set<BrowserTraceEventType>([
  "antigen_snapshot",
  "browser_click",
  "browser_type",
]);

/**
 * Compute safe, high-level warnings for a trace. Reveals only a coarse condition
 * (no internals). Currently emits `navigation_without_antigen_actions` when a
 * trace shows repeated navigation but no Antigen-owned snapshot/click/type — the
 * signature of tool-surface bypass (sensitive actions driven through a raw/child
 * Playwright surface off-trace). Single-navigation sessions are ignored to avoid
 * noise on freshly created sessions.
 */
function computeTraceWarnings(events: BrowserTraceEvent[]): string[] {
  let navCount = 0;
  let hasAntigenAction = false;
  let antigenActionCount = 0;
  let shortcutNavCount = 0;
  for (const e of events) {
    if (e.event_type === "navigation_state") navCount++;
    if (ANTIGEN_ACTION_EVENT_TYPES.has(e.event_type)) {
      hasAntigenAction = true;
      antigenActionCount++;
    }
    // A warned/blocked navigation disposition is a direct-navigation shortcut.
    if (
      e.event_type === "browser_navigation_disposition" &&
      (e.navigation_disposition === "direct_navigation_warned" ||
        e.navigation_disposition === "direct_navigation_blocked")
    ) {
      shortcutNavCount++;
    }
  }
  const warnings: string[] = [];
  if (navCount >= 2 && !hasAntigenAction) warnings.push("navigation_without_antigen_actions");
  // Direct-navigation shortcuts dominate when there are at least two of them and
  // they are not offset by an equal-or-greater amount of Antigen-owned
  // snapshot/click/type activity. A trace where shortcuts are followed by real
  // ref-based actions does not warn.
  if (shortcutNavCount >= 2 && antigenActionCount < shortcutNavCount) {
    warnings.push("direct_navigation_shortcuts_dominant");
  }
  return warnings;
}

export interface BrowserRunTraceView {
  browser_runtime_id: string;
  created_at: string;
  last_event_at: string;
  expires_at: string;
  ttl_ms: number;
  age_ms: number;
  event_count: number;
  events: BrowserTraceEvent[];
  warnings?: string[];
}

/** Read the sanitized trace for a runtime id, optionally limited to the most recent N events. */
export function getBrowserRunTrace(
  browserRuntimeId: string,
  limit?: number,
): BrowserRunTraceView | undefined {
  const entry = traces.get(browserRuntimeId);
  if (!entry) return undefined;
  const nowMs = Date.now();
  if (nowMs - entry.last_event_ms > TRACE_TTL_MS) {
    traces.delete(browserRuntimeId);
    return undefined;
  }
  const events =
    typeof limit === "number" && limit > 0 && limit < entry.events.length
      ? entry.events.slice(-limit)
      : entry.events.slice();
  // Compute warnings over the full retained event set, not the limited slice.
  const warnings = computeTraceWarnings(entry.events);
  return {
    browser_runtime_id: entry.browser_runtime_id,
    created_at: entry.created_at,
    ...expiryMeta(entry, nowMs),
    event_count: entry.event_count,
    events,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Sanitized summary of a single trace, returned by the list/index endpoint. */
export interface BrowserRunTraceSummary {
  browser_runtime_id: string;
  created_at: string;
  last_event_at: string;
  expires_at: string;
  ttl_ms: number;
  age_ms: number;
  event_count: number;
  last_event_type?: BrowserTraceEventType;
  last_ts?: string;
  last_url?: string;
  warnings?: string[];
}

/**
 * List sanitized summaries of active traces, most recent first, so QA can
 * discover active `browser_runtime_id`s without already knowing them. Returns
 * metadata only — never the full event bodies. Empty (never throws) when
 * tracing is disabled. `last_url` reuses the already-sanitized host+path values
 * stored on events; no query strings, coordinates, secrets, or internals.
 */
export function listBrowserRunTraces(limit = 50): BrowserRunTraceSummary[] {
  if (!traceEnabled()) return [];
  const nowMs = Date.now();
  deleteExpired(nowMs);
  const safeLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 50;

  const summaries: BrowserRunTraceSummary[] = [...traces.values()].map((entry) => {
    const last = entry.events[entry.events.length - 1];
    // Most recent event carrying a (sanitized) url_after or url_before.
    let lastUrl: string | undefined;
    for (let i = entry.events.length - 1; i >= 0; i--) {
      const u = entry.events[i].url_after ?? entry.events[i].url_before;
      if (u) {
        lastUrl = u;
        break;
      }
    }
    const warnings = computeTraceWarnings(entry.events);
    return {
      browser_runtime_id: entry.browser_runtime_id,
      created_at: entry.created_at,
      ...expiryMeta(entry, nowMs),
      event_count: entry.event_count,
      last_event_type: last?.event_type,
      last_ts: last?.ts,
      last_url: lastUrl,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });

  // Most recent first — sort by last event ts, falling back to created_at.
  summaries.sort((a, b) => (b.last_ts ?? b.created_at).localeCompare(a.last_ts ?? a.created_at));
  return summaries.slice(0, safeLimit);
}

/** Test support — clears all traces. */
export function clearBrowserRunTraces(): void {
  traces.clear();
}
