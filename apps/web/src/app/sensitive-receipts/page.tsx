"use client";

import { useEffect, useState } from "react";
import type { SensitiveActionTimelineItem, SensitiveActionEventType } from "@aegis/types";
import { listSensitiveReceiptTimeline } from "@/lib/api";

type SinceOption = "24h" | "today" | "7d" | "all";
type GroupOption = "all" | "browser" | "credential" | "challenge" | "email" | "payment" | "human_presence";

const SINCE_LABELS: Record<SinceOption, string> = {
  "24h": "Last 24h",
  today: "Today",
  "7d": "Last 7 days",
  all: "All time",
};

const GROUP_LABELS: Record<GroupOption, string> = {
  all: "All events",
  browser: "Browser",
  credential: "Credentials",
  challenge: "Challenges",
  email: "Email resolver",
  payment: "Payments",
  human_presence: "Human presence",
};

const EVENT_STYLES: Record<
  SensitiveActionEventType,
  { dot: string; badge: string; label: string }
> = {
  task_browser_session_started: {
    dot: "bg-slate-400",
    badge: "bg-slate-800 text-slate-300 border-slate-700",
    label: "Browser started",
  },
  task_browser_session_closed: {
    dot: "bg-slate-500",
    badge: "bg-slate-800 text-slate-400 border-slate-700",
    label: "Browser closed",
  },
  credential_authorization_approved: {
    dot: "bg-indigo-400",
    badge: "bg-indigo-950 text-indigo-300 border-indigo-800",
    label: "Credential approved",
  },
  credential_authorization_fulfilled: {
    dot: "bg-purple-400",
    badge: "bg-purple-950 text-purple-300 border-purple-800",
    label: "Credential fulfilled",
  },
  secret_field_injected: {
    dot: "bg-emerald-400",
    badge: "bg-emerald-950 text-emerald-300 border-emerald-800",
    label: "Field injected",
  },
  credential_step_handoff_executed: {
    dot: "bg-teal-400",
    badge: "bg-teal-950 text-teal-300 border-teal-800",
    label: "Handoff executed",
  },
  security_challenge_reported: {
    dot: "bg-amber-400",
    badge: "bg-amber-950 text-amber-300 border-amber-800",
    label: "Challenge detected",
  },
  challenge_code_submitted_manual: {
    dot: "bg-orange-400",
    badge: "bg-orange-950 text-orange-300 border-orange-800",
    label: "Code submitted",
  },
  challenge_code_injected: {
    dot: "bg-orange-500",
    badge: "bg-orange-950 text-orange-200 border-orange-800",
    label: "Code injected",
  },
  challenge_email_resolution_requested: {
    dot: "bg-sky-400",
    badge: "bg-sky-950 text-sky-300 border-sky-800",
    label: "Email search started",
  },
  challenge_email_code_found: {
    dot: "bg-cyan-400",
    badge: "bg-cyan-950 text-cyan-300 border-cyan-800",
    label: "Code found in email",
  },
  challenge_email_code_injected: {
    dot: "bg-cyan-500",
    badge: "bg-cyan-950 text-cyan-200 border-cyan-800",
    label: "Email code injected",
  },
  payment_card_fill_executed: {
    dot: "bg-amber-400",
    badge: "bg-amber-950 text-amber-300 border-amber-800",
    label: "Card field filled",
  },
  purchase_confirmation_submitted: {
    dot: "bg-red-400",
    badge: "bg-red-950 text-red-300 border-red-800",
    label: "Purchase submitted",
  },
  purchase_confirmation_failed: {
    dot: "bg-rose-500",
    badge: "bg-rose-950 text-rose-300 border-rose-800",
    label: "Purchase failed",
  },
  human_verification_detected: {
    dot: "bg-violet-400",
    badge: "bg-violet-950 text-violet-300 border-violet-800",
    label: "Human check detected",
  },
  human_presence_requested: {
    dot: "bg-violet-400",
    badge: "bg-violet-950 text-violet-300 border-violet-800",
    label: "Presence requested",
  },
  human_presence_started: {
    dot: "bg-fuchsia-400",
    badge: "bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800",
    label: "Presence started",
  },
  human_presence_completed: {
    dot: "bg-fuchsia-500",
    badge: "bg-fuchsia-950 text-fuchsia-200 border-fuchsia-800",
    label: "Presence completed",
  },
  human_verification_completed: {
    dot: "bg-emerald-400",
    badge: "bg-emerald-950 text-emerald-300 border-emerald-800",
    label: "Human check cleared",
  },
  agent_resumed_after_human_presence: {
    dot: "bg-emerald-500",
    badge: "bg-emerald-950 text-emerald-200 border-emerald-800",
    label: "Agent resumed",
  },
  human_verification_expired: {
    dot: "bg-gray-500",
    badge: "bg-gray-800 text-gray-400 border-gray-700",
    label: "Human check expired",
  },
  human_verification_failed: {
    dot: "bg-rose-500",
    badge: "bg-rose-950 text-rose-300 border-rose-800",
    label: "Human check failed",
  },
};

const FALLBACK_STYLE = {
  dot: "bg-gray-500",
  badge: "bg-gray-800 text-gray-400 border-gray-700",
  label: "Event",
};

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

const selectClass =
  "text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-gray-600 cursor-pointer";

export default function SensitiveReceiptsPage() {
  const [items, setItems] = useState<SensitiveActionTimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState<SinceOption>("24h");
  const [eventGroup, setEventGroup] = useState<GroupOption>("all");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listSensitiveReceiptTimeline({ since, event_group: eventGroup })
      .then((r) => { if (active) setItems(r.items); })
      .catch(() => {
        if (active) setError("Could not load the timeline. Make sure the Antigen API is running.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [since, eventGroup]);

  function handleRefresh() {
    setLoading(true);
    setError(null);
    listSensitiveReceiptTimeline({ since, event_group: eventGroup })
      .then((r) => setItems(r.items))
      .catch(() => setError("Could not load the timeline. Make sure the Antigen API is running."))
      .finally(() => setLoading(false));
  }

  const isFiltered = since !== "24h" || eventGroup !== "all";

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-white">Sensitive Action Timeline</h1>
        <p className="mt-1 text-sm text-gray-400 max-w-xl">
          A record of what Antigen did on your behalf. No passwords, codes, cookies, or email
          contents are stored or shown here.
        </p>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">Time</span>
          <select
            value={since}
            onChange={(e) => setSince(e.target.value as SinceOption)}
            className={selectClass}
          >
            {(Object.keys(SINCE_LABELS) as SinceOption[]).map((k) => (
              <option key={k} value={k}>{SINCE_LABELS[k]}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">Events</span>
          <select
            value={eventGroup}
            onChange={(e) => setEventGroup(e.target.value as GroupOption)}
            className={selectClass}
          >
            {(Object.keys(GROUP_LABELS) as GroupOption[]).map((k) => (
              <option key={k} value={k}>{GROUP_LABELS[k]}</option>
            ))}
          </select>
        </div>

        {/* Quick link */}
        <button
          onClick={() => { setSince("24h"); setEventGroup("credential"); }}
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          title="Filter to credential events from the last 24h"
        >
          Latest credential use
        </button>

        {isFiltered && (
          <button
            onClick={() => { setSince("24h"); setEventGroup("all"); }}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            Reset
          </button>
        )}

        <button
          onClick={handleRefresh}
          disabled={loading}
          className="ml-auto text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1 rounded-md transition-colors disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="bg-red-950 border border-red-800 rounded-lg p-4 mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
          <p className="text-sm font-medium text-gray-400">
            No sensitive action events match the current filters.
          </p>
          <p className="text-xs text-gray-600 mt-1">
            {since !== "all"
              ? 'Try changing the time range to "All time", or run an Antigen login flow to generate events.'
              : "Run an Antigen login or challenge flow to see events here."}
          </p>
        </div>
      )}

      {/* Timeline */}
      {items.length > 0 && (
        <div className="relative pl-8">
          {/* vertical connector line */}
          <div className="absolute left-3 top-2 bottom-2 w-px bg-gray-800" />

          <div className="space-y-4">
            {items.map((item) => {
              const style = EVENT_STYLES[item.event_type] ?? FALLBACK_STYLE;
              const metaEntries = Object.entries(item.metadata);

              return (
                <div key={item.item_id} className="relative flex gap-4">
                  {/* dot */}
                  <div
                    className={`absolute -left-5 mt-1.5 w-4 h-4 rounded-full z-10 ring-2 ring-gray-950 ${style.dot}`}
                  />

                  {/* card */}
                  <div className="flex-1 bg-gray-900 border border-gray-800 rounded-lg p-4 min-w-0">
                    {/* top row: badge + timestamp */}
                    <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border font-medium ${style.badge}`}
                      >
                        {style.label}
                      </span>
                      <time className="text-xs text-gray-600 shrink-0 tabular-nums">
                        {formatTs(item.timestamp)}
                      </time>
                    </div>

                    {/* description */}
                    <p className="text-sm text-white leading-snug mb-2">{item.description}</p>

                    {/* metadata */}
                    {metaEntries.length > 0 && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
                        {metaEntries.map(([k, v]) => (
                          <span key={k} className="text-xs">
                            <span className="text-gray-600">{k.replace(/_/g, " ")}: </span>
                            <span className="font-mono text-gray-400">{String(v)}</span>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* privacy guarantees */}
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {item.privacy_guarantees.map((g) => (
                        <span
                          key={g}
                          className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-900"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
