"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  AgentDelegation,
  ApprovalRequest,
  UserApprovalReceipt,
  SensitiveGrant,
} from "@aegis/types";
import {
  listDelegations,
  listApprovals,
  listSensitiveGrants,
  listUserApprovalReceipts,
  listWebsiteViolationReceipts,
  listVaultPasses,
} from "@/lib/api";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function CommandPage() {
  const [delegations, setDelegations] = useState<AgentDelegation[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [activeGrants, setActiveGrants] = useState<SensitiveGrant[]>([]);
  const [userApprovalReceipts, setUserApprovalReceipts] = useState<UserApprovalReceipt[]>([]);
  const [violationCount, setViolationCount] = useState<number | null>(null);
  const [criticalViolation, setCriticalViolation] = useState(false);
  const [vaultCount, setVaultCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      listDelegations(),
      listApprovals("pending"),
      listSensitiveGrants({ status: "active" }),
      listUserApprovalReceipts(),
      listWebsiteViolationReceipts(),
      listVaultPasses(),
    ]).then(([dels, apps, grants, uars, violations, vault]) => {
      if (dels.status === "fulfilled") setDelegations(dels.value);
      if (apps.status === "fulfilled") setPendingApprovals(apps.value);
      if (grants.status === "fulfilled") setActiveGrants(grants.value);
      if (uars.status === "fulfilled") setUserApprovalReceipts(uars.value);
      if (violations.status === "fulfilled") {
        setViolationCount(violations.value.count);
        setCriticalViolation(violations.value.receipts.some((r) => r.severity === "critical"));
      }
      if (vault.status === "fulfilled") setVaultCount(vault.value.length);
    }).finally(() => setLoading(false));
  }, []);

  const recentProofs = [...userApprovalReceipts]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  const attentionItems: Array<{ label: string; href: string }> = [];
  if (pendingApprovals.length > 0) {
    attentionItems.push({
      label: `${pendingApprovals.length} approval request${pendingApprovals.length !== 1 ? "s" : ""} waiting for your decision`,
      href: "/route-run-approvals",
    });
  }
  if (activeGrants.length > 0) {
    attentionItems.push({
      label: `${activeGrants.length} sensitive grant${activeGrants.length !== 1 ? "s" : ""} currently active`,
      href: "/sensitive-grants",
    });
  }
  if (criticalViolation) {
    attentionItems.push({
      label: "Critical website violation recorded",
      href: "/receipts",
    });
  }

  const trustSteps = [
    { step: "①", label: "Connect agent", href: "/delegations" },
    { step: "②", label: "Attach collar", href: "/collars" },
    { step: "③", label: "Approve authority", href: "/route-run-approvals" },
    { step: "④", label: "Verify receipt", href: "/receipts" },
  ];

  const activeDelegations = delegations.filter((d) => d.status === "active");
  const allClear = !loading && attentionItems.length === 0;

  function heroHeadline() {
    if (loading) return <>Your agentic operations are <em className="font-serif not-italic italic text-blue-600">loading.</em></>;
    if (attentionItems.length > 0) return <>Your agentic operations need <em className="font-serif not-italic italic text-amber-600">attention.</em></>;
    if (activeDelegations.length === 0) return <>Your trust layer is <em className="font-serif not-italic italic text-blue-600">ready.</em></>;
    return <>Your agentic operations are <em className="font-serif not-italic italic text-blue-600">secured.</em></>;
  }

  return (
    <div className="p-8 max-w-5xl space-y-6">
      {/* Hero Panel */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between p-8 gap-8">
          {/* Left: headline */}
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400 mb-3">
              Command
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-gray-900 leading-snug">
              {heroHeadline()}
            </h1>
            <p className="mt-3 text-sm text-gray-500 leading-relaxed max-w-md">
              Aegis verifies who acts, what they may touch, and what proof they leave behind.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  allClear ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
                }`}
              />
              <span className="text-xs text-gray-500">
                {loading
                  ? "Checking status…"
                  : allClear
                  ? `All systems secured · ${activeDelegations.length} agent${activeDelegations.length !== 1 ? "s" : ""} active`
                  : `${attentionItems.length} item${attentionItems.length !== 1 ? "s" : ""} need attention`}
                {!loading && userApprovalReceipts.length > 0 && allClear
                  ? ` · ${userApprovalReceipts.length} receipt${userApprovalReceipts.length !== 1 ? "s" : ""} signed`
                  : ""}
              </span>
            </div>
          </div>

          {/* Right: TrustCore orb */}
          <div className="shrink-0 hidden sm:flex items-center justify-center w-40 h-40 relative">
            <div className="absolute inset-0 rounded-full border border-blue-200/50 animate-ping opacity-20" />
            <div className="absolute inset-4 rounded-full border border-blue-100/60" />
            <div className="relative z-10 flex flex-col items-center justify-center w-28 h-28 rounded-full bg-gradient-to-br from-white to-blue-50 shadow-[0_8px_32px_rgba(59,130,246,0.12)] border border-blue-100">
              <span
                className={`w-2.5 h-2.5 rounded-full mb-1.5 ${
                  loading ? "bg-gray-300" : allClear ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
                }`}
              />
              <p className="text-lg font-bold text-gray-900 tabular-nums leading-none">
                {loading ? "—" : activeDelegations.length}
              </p>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mt-0.5">
                {activeDelegations.length === 1 ? "Agent" : "Agents"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        <MetricCard
          label="Agents"
          sub="secured"
          value={loading ? "—" : String(activeDelegations.length)}
          href="/delegations"
        />
        <MetricCard
          label="Approvals"
          sub="pending"
          value={loading ? "—" : String(pendingApprovals.length)}
          href="/route-run-approvals"
          highlight={!loading && pendingApprovals.length > 0}
          tone="amber"
        />
        <MetricCard
          label="Grants"
          sub="active"
          value={loading ? "—" : String(activeGrants.length)}
          href="/sensitive-grants"
          highlight={!loading && activeGrants.length > 0}
          tone="amber"
        />
        <MetricCard
          label="Receipts"
          sub="signed"
          value={loading ? "—" : String(userApprovalReceipts.length)}
          href="/receipts"
          tone="blue"
        />
        <MetricCard
          label="Violations"
          sub="detected"
          value={loading ? "—" : violationCount === null ? "–" : String(violationCount)}
          href="/receipts"
          highlight={!loading && criticalViolation}
          tone="red"
        />
        <MetricCard
          label="Secrets"
          sub="sealed"
          value={loading ? "—" : vaultCount === null ? "–" : String(vaultCount)}
          href="/passes"
          tone="blue"
        />
      </div>

      {/* Needs Attention */}
      {!loading && attentionItems.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl overflow-hidden shadow-[0_2px_16px_rgba(245,158,11,0.08)]">
          <div className="px-5 pt-4 pb-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-600">
              Needs Attention
            </p>
          </div>
          <div className="px-3 pb-3 space-y-1">
            {attentionItems.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="flex items-center justify-between rounded-xl px-3 py-2.5 hover:bg-amber-100/60 transition-colors group"
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                  <span className="text-sm text-amber-800">{item.label}</span>
                </div>
                <span className="text-xs text-amber-600 shrink-0 group-hover:text-amber-800 transition-colors">
                  Review →
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {!loading && attentionItems.length === 0 && (
        <div className="bg-emerald-50 border border-emerald-100 rounded-2xl px-5 py-4 flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
          <p className="text-sm text-emerald-700">
            All clear. No pending actions. All agents operating within bounds.
          </p>
        </div>
      )}

      {/* Two-column: agents + approvals */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Connected agents */}
        <GlassCard title="Connected Agents">
          {loading ? (
            <LoadingSkeleton />
          ) : delegations.length === 0 ? (
            <EmptyState
              headline="No agents connected yet."
              body="Delegations give agents a signed identity with scoped permissions."
              cta="Add agent"
              href="/delegations"
            />
          ) : (
            <div className="space-y-1.5">
              {delegations.slice(0, 5).map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-xl bg-gray-50 border border-gray-100 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-bold text-blue-600 uppercase">
                        {d.agent_name?.[0] ?? "A"}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-gray-900 truncate font-medium">{d.agent_name}</p>
                      <p className="text-[10px] text-gray-400">{d.channel}</p>
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full shrink-0 font-medium ${
                      d.status === "active"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : "bg-gray-100 text-gray-400 border border-gray-200"
                    }`}
                  >
                    {d.status}
                  </span>
                </div>
              ))}
              {delegations.length > 5 && (
                <Link
                  href="/delegations"
                  className="text-xs text-blue-600 hover:text-blue-700 block text-center pt-1"
                >
                  View all {delegations.length} agents →
                </Link>
              )}
            </div>
          )}
        </GlassCard>

        {/* Pending approvals */}
        <GlassCard title="Pending Approvals">
          {loading ? (
            <LoadingSkeleton />
          ) : pendingApprovals.length === 0 ? (
            <EmptyState
              headline="No approvals waiting."
              body="When an agent needs sensitive authority, it will appear here."
            />
          ) : (
            <div className="space-y-1.5">
              {pendingApprovals.slice(0, 3).map((a) => (
                <Link
                  key={a.id}
                  href="/route-run-approvals"
                  className="block rounded-xl bg-gray-50 border border-gray-100 px-3 py-2.5 hover:border-blue-200 hover:bg-blue-50/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className="text-sm text-gray-800 truncate font-medium">{a.summary}</p>
                    <RiskBadge level={a.risk_level} />
                  </div>
                  {a.domain && <p className="text-[10px] text-gray-400 font-mono">{a.domain}</p>}
                </Link>
              ))}
              <Link
                href="/route-run-approvals"
                className="text-xs text-blue-600 hover:text-blue-700 block text-center pt-1"
              >
                Review all in Approvals →
              </Link>
            </div>
          )}
        </GlassCard>
      </div>

      {/* Recent proofs */}
      <GlassCard title="Recent Proofs">
        {loading ? (
          <LoadingSkeleton />
        ) : recentProofs.length === 0 ? (
          <EmptyState
            headline="No signed receipts yet."
            body="UserApprovalReceipts appear after approval decisions are recorded."
            cta="View receipts"
            href="/receipts"
          />
        ) : (
          <div className="divide-y divide-gray-100">
            {recentProofs.map((r) => (
              <Link
                key={r.receipt_id}
                href="/receipts"
                className="flex items-center gap-4 py-3 px-1 hover:bg-gray-50 rounded-lg transition-colors -mx-1"
              >
                {/* Decision icon */}
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
                    r.decision === "approved"
                      ? "bg-emerald-50 border border-emerald-200 text-emerald-600"
                      : "bg-red-50 border border-red-200 text-red-500"
                  }`}
                >
                  {r.decision === "approved" ? "✓" : "✗"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {r.agent_name && (
                      <span className="text-sm text-gray-700 font-medium">{r.agent_name}</span>
                    )}
                    {(r.target_domain ?? r.action_type) && (
                      <span className="text-xs text-gray-400 font-mono truncate">
                        {r.target_domain ?? r.action_type}
                      </span>
                    )}
                    {r.risk_level && r.risk_level !== "low" && (
                      <RiskBadge level={r.risk_level} />
                    )}
                  </div>
                </div>
                <span className="text-xs text-gray-400 shrink-0">{timeAgo(r.decided_at)}</span>
              </Link>
            ))}
            <div className="pt-3">
              <Link href="/receipts" className="text-xs text-blue-600 hover:text-blue-700">
                View all receipts →
              </Link>
            </div>
          </div>
        )}
      </GlassCard>

      {/* Trust Setup strip */}
      <div className="pt-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 mb-4">
          Trust Setup
        </p>
        <div className="flex items-center gap-1 flex-wrap">
          {trustSteps.map((s, i) => (
            <div key={s.step} className="flex items-center gap-1">
              <Link
                href={s.href}
                className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 hover:border-blue-300 hover:bg-blue-50/50 hover:shadow-sm transition-all duration-150 group"
              >
                <span className="text-sm text-blue-600 font-medium">{s.step}</span>
                <span className="text-sm text-gray-600 group-hover:text-gray-900">{s.label}</span>
              </Link>
              {i < trustSteps.length - 1 && (
                <span className="text-gray-300 text-xs mx-0.5">→</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function GlassCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 mb-4">
        {title}
      </p>
      {children}
    </div>
  );
}

function MetricCard({
  label,
  sub,
  value,
  href,
  highlight,
  tone = "neutral",
}: {
  label: string;
  sub: string;
  value: string;
  href: string;
  highlight?: boolean;
  tone?: "blue" | "amber" | "red" | "neutral";
}) {
  const toneMap = {
    blue: {
      card: "border-blue-100 shadow-[0_2px_12px_rgba(59,130,246,0.07)]",
      value: "text-blue-700",
    },
    amber: {
      card: "border-amber-200 shadow-[0_2px_12px_rgba(245,158,11,0.10)]",
      value: "text-amber-600",
    },
    red: {
      card: "border-red-200 shadow-[0_2px_12px_rgba(239,68,68,0.10)]",
      value: "text-red-600",
    },
    neutral: {
      card: "",
      value: "text-gray-900",
    },
  };

  const active = highlight;
  const styles = active ? toneMap[tone] : toneMap.neutral;

  return (
    <Link
      href={href}
      className={`bg-white border rounded-2xl p-4 hover:-translate-y-0.5 hover:shadow-md transition-all duration-150 block ${
        active ? styles.card : "border-gray-100 shadow-sm"
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-gray-400">{label}</p>
      <p className={`text-2xl font-bold tabular-nums mt-1 ${active ? styles.value : "text-gray-900"}`}>
        {value}
      </p>
      <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
    </Link>
  );
}

function RiskBadge({ level }: { level?: string }) {
  if (!level) return null;
  const styles: Record<string, string> = {
    critical: "bg-red-50 text-red-600 border border-red-200",
    high: "bg-orange-50 text-orange-600 border border-orange-200",
    medium: "bg-amber-50 text-amber-600 border border-amber-200",
    low: "bg-gray-50 text-gray-500 border border-gray-200",
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${styles[level] ?? styles.low}`}>
      {level}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 py-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-10 bg-gray-100 rounded-xl animate-pulse" />
      ))}
    </div>
  );
}

function EmptyState({
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
      <p className="text-sm font-medium text-gray-500">{headline}</p>
      <p className="text-xs text-gray-400 mt-1 leading-relaxed">{body}</p>
      {cta && href && (
        <Link
          href={href}
          className="mt-4 inline-block text-xs bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors font-medium"
        >
          {cta}
        </Link>
      )}
    </div>
  );
}
