"use client";

import { useEffect, useState } from "react";
import type { ProtectedSession, ApprovalRequest, Receipt, ReputationSummary } from "@aegis/types";
import {
  listSessions,
  listApprovals,
  listReceipts,
  getReputationSummary,
  approveRequest,
  denyRequest,
} from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-900 text-green-400",
  waiting_for_approval: "bg-indigo-900 text-indigo-400",
  paused: "bg-yellow-900 text-yellow-400",
  revoked: "bg-red-900 text-red-400",
  expired: "bg-gray-800 text-gray-500",
  closed: "bg-gray-800 text-gray-500",
  error: "bg-red-900 text-red-400",
};

const RISK_COLORS: Record<string, string> = {
  low: "bg-gray-800 text-gray-400",
  medium: "bg-yellow-900 text-yellow-400",
  high: "bg-orange-900 text-orange-400",
  critical: "bg-red-900 text-red-400",
};

const DECISION_COLORS: Record<string, string> = {
  allowed: "text-green-400",
  approved_by_user: "text-green-400",
  completed_by_runner: "text-indigo-400",
  blocked: "text-red-400",
  denied_by_user: "text-red-400",
};

export default function Dashboard() {
  const [sessions, setSessions] = useState<ProtectedSession[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [summary, setSummary] = useState<ReputationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  async function load() {
    const [s, a, r, rep] = await Promise.allSettled([
      listSessions(),
      listApprovals(),
      listReceipts(),
      getReputationSummary(),
    ]);
    if (s.status === "fulfilled") setSessions(s.value);
    if (a.status === "fulfilled") setApprovals(a.value);
    if (r.status === "fulfilled") setReceipts(r.value);
    if (rep.status === "fulfilled") setSummary(rep.value);
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  async function handleApprove(id: string) {
    setActing(id);
    try {
      await approveRequest(id);
      await load();
    } catch {
      // silently ignore; user can use /approvals page
    } finally {
      setActing(null);
    }
  }

  async function handleDeny(id: string) {
    setActing(id);
    try {
      await denyRequest(id);
      await load();
    } catch {
      // silently ignore
    } finally {
      setActing(null);
    }
  }

  const activeSessions = sessions.filter(
    (s) => s.status === "active" || s.status === "waiting_for_approval"
  );
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const recentReceipts = [...receipts]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-white">Your agents are protected.</h1>
        <p className="mt-1 text-gray-400">
          Aegis watches for sensitive actions so your agents can work without holding your secrets.
        </p>
      </div>

      {/* Status summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        <StatCard label="Active Sessions" value={loading ? "—" : String(activeSessions.length)} />
        <StatCard
          label="Pending Approvals"
          value={loading ? "—" : String(pendingApprovals.length)}
          highlight
        />
        <StatCard
          label="Blocked Actions"
          value={loading ? "—" : String(summary?.risky_actions_blocked ?? 0)}
        />
        <StatCard
          label="Receipts Created"
          value={loading ? "—" : String(summary?.receipts_created ?? receipts.length)}
        />
        <StatCard
          label="Issues Reported"
          value={loading ? "—" : String(summary?.issues_reported ?? 0)}
        />
        <StatCard
          label="Runner Tasks"
          value={loading ? "—" : String(summary?.runner_tasks_completed ?? 0)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Active agents */}
        <Section title="Active Agents">
          {loading ? (
            <p className="text-xs text-gray-500 py-4 text-center">Loading…</p>
          ) : activeSessions.length === 0 ? (
            <Empty
              headline="No agents protected yet."
              body="Create an Aegis Pass to secure an agent built anywhere."
              cta="Secure a New Agent"
              href="/passes"
            />
          ) : (
            <div className="space-y-3">
              {activeSessions.map((session) => (
                <div key={session.id} className="border border-gray-800 rounded-md p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-gray-400 truncate">{session.id}</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[session.status] ?? "bg-gray-800 text-gray-400"}`}
                    >
                      {session.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {session.current_url ?? "No URL yet"}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">Mode: {session.mode}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Pending approvals */}
        <Section title="Pending Approvals">
          {loading ? (
            <p className="text-xs text-gray-500 py-4 text-center">Loading…</p>
          ) : pendingApprovals.length === 0 ? (
            <Empty
              headline="No approvals waiting."
              body="Aegis will notify you when an agent tries to do something sensitive."
            />
          ) : (
            <div className="space-y-3">
              {pendingApprovals.map((approval) => (
                <div key={approval.id} className="border border-indigo-900 rounded-md p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-xs text-gray-300 leading-snug">{approval.summary}</p>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${RISK_COLORS[approval.risk_level] ?? "bg-gray-800 text-gray-400"}`}
                    >
                      {approval.risk_level}
                    </span>
                  </div>
                  {approval.domain && (
                    <p className="text-xs text-gray-600 mb-2">{approval.domain}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      disabled={acting === approval.id}
                      onClick={() => handleApprove(approval.id)}
                      className="text-xs bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white px-3 py-1 rounded transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      disabled={acting === approval.id}
                      onClick={() => handleDeny(approval.id)}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 px-3 py-1 border border-gray-700 rounded transition-colors"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Recent activity */}
        <Section title="Recent Activity" className="md:col-span-2">
          {loading ? (
            <p className="text-xs text-gray-500 py-4 text-center">Loading…</p>
          ) : recentReceipts.length === 0 ? (
            <Empty
              headline="No activity yet."
              body="Trust-relevant events will appear here once an agent session starts."
            />
          ) : (
            <div className="divide-y divide-gray-800">
              {recentReceipts.map((receipt) => (
                <div
                  key={receipt.id}
                  className="py-2.5 flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`text-xs font-medium shrink-0 ${DECISION_COLORS[receipt.decision] ?? "text-gray-400"}`}
                    >
                      {receipt.decision}
                    </span>
                    <span className="text-xs text-gray-400 font-mono shrink-0">
                      {receipt.action_type}
                    </span>
                    {receipt.domain && (
                      <span className="text-xs text-gray-600 truncate">{receipt.domain}</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-600 shrink-0">
                    {new Date(receipt.created_at).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p
        className={`text-2xl font-semibold mt-1 ${highlight ? "text-indigo-400" : "text-white"}`}
      >
        {value}
      </p>
    </div>
  );
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-lg p-5 ${className ?? ""}`}>
      <h2 className="text-sm font-medium text-gray-300 mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Empty({
  headline,
  body,
  cta,
  href,
}: {
  headline: string;
  body: string;
  cta?: string;
  href?: string;
}) {
  return (
    <div className="text-center py-6">
      <p className="text-sm font-medium text-gray-400">{headline}</p>
      <p className="text-xs text-gray-600 mt-1">{body}</p>
      {cta && href && (
        <a
          href={href}
          className="mt-4 inline-block text-xs bg-indigo-500 hover:bg-indigo-400 text-white px-4 py-2 rounded-md transition-colors"
        >
          {cta}
        </a>
      )}
    </div>
  );
}
