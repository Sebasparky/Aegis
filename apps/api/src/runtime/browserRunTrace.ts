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

const MAX_EVENTS_PER_SESSION = 200;
const MAX_SESSIONS = 50;
const TRACE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_STR = 200;

export type BrowserTraceEventType =
  | "browser_endpoint_created"
  | "navigation_state"
  | "antigen_snapshot"
  | "browser_scroll_to_ref"
  | "browser_click"
  | "browser_type";

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
  };
  char_count_bucket?: string;
  submit?: boolean;
  error_code?: string;
}

/** Input accepted by recordBrowserTraceEvent — everything except the store-managed `ts`. */
export type BrowserTraceEventInput = Omit<BrowserTraceEvent, "ts">;

interface TraceEntry {
  browser_runtime_id: string;
  created_at: string;
  created_ms: number;
  event_count: number;
  events: BrowserTraceEvent[];
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
    if (nowMs - entry.created_ms > TRACE_TTL_MS) traces.delete(id);
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
      safe.snapshot = snap;
    }
    const bucket = clip(event.char_count_bucket);
    if (bucket !== undefined) safe.char_count_bucket = bucket;
    if (typeof event.submit === "boolean") safe.submit = event.submit;
    const errorCode = clip(event.error_code);
    if (errorCode !== undefined) safe.error_code = errorCode;

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
        event_count: 0,
        events: [],
      };
      traces.set(browserRuntimeId, entry);
    }

    // Bound events per session — drop the oldest when full.
    if (entry.events.length >= MAX_EVENTS_PER_SESSION) entry.events.shift();
    entry.events.push(safe);
    entry.event_count += 1;
  } catch {
    // Diagnostics must never disrupt the tool path.
  }
}

export interface BrowserRunTraceView {
  browser_runtime_id: string;
  created_at: string;
  event_count: number;
  events: BrowserTraceEvent[];
}

/** Read the sanitized trace for a runtime id, optionally limited to the most recent N events. */
export function getBrowserRunTrace(
  browserRuntimeId: string,
  limit?: number,
): BrowserRunTraceView | undefined {
  const entry = traces.get(browserRuntimeId);
  if (!entry) return undefined;
  if (Date.now() - entry.created_ms > TRACE_TTL_MS) {
    traces.delete(browserRuntimeId);
    return undefined;
  }
  const events =
    typeof limit === "number" && limit > 0 && limit < entry.events.length
      ? entry.events.slice(-limit)
      : entry.events.slice();
  return {
    browser_runtime_id: entry.browser_runtime_id,
    created_at: entry.created_at,
    event_count: entry.event_count,
    events,
  };
}

/** Sanitized summary of a single trace, returned by the list/index endpoint. */
export interface BrowserRunTraceSummary {
  browser_runtime_id: string;
  created_at: string;
  event_count: number;
  last_event_type?: BrowserTraceEventType;
  last_ts?: string;
  last_url?: string;
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
  deleteExpired(Date.now());
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
    return {
      browser_runtime_id: entry.browser_runtime_id,
      created_at: entry.created_at,
      event_count: entry.event_count,
      last_event_type: last?.event_type,
      last_ts: last?.ts,
      last_url: lastUrl,
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
