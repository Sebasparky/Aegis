"use client";

import { useEffect, useState } from "react";
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
    { step: "1", label: "Connect agent", href: "/delegations" },
    { step: "2", label: "Attach collar", href: "/collars" },
    { step: "3", label: "Approve authority", href: "/route-run-approvals" },
    { step: "4", label: "Verify receipt", href: "/receipts" },
  ];

  return (
    <div className="max-w-4xl space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Command</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Trust layer status. Agents act, Aegis enforces, receipts prove it.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <MetricCard
          label="Agents secured"
          value={loading ? "—" : String(delegations.filter((d) => d.status === "active").length)}
          href="/delegations"
        />
        <MetricCard
          label="Pending approvals"
          value={loading ? "—" : String(pendingApprovals.length)}
          href="/route-run-approvals"
          highlight={!loading && pendingApprovals.length > 0}
        />
        <MetricCard
          label="Active grants"
          value={loading ? "—" : String(activeGrants.length)}
          href="/sensitive-grants"
          highlight={!loading && activeGrants.length > 0}
        />
        <MetricCard
          label="Signed receipts"
          value={loading ? "—" : String(userApprovalReceipts.length)}
          href="/receipts"
        />
        <MetricCard
          label="Website violations"
          value={loading ? "—" : violationCount === null ? "–" : String(violationCount)}
          href="/receipts"
          highlight={!loading && criticalViolation}
        />
        <MetricCard
          label="Secrets sealed"
          value={loading ? "—" : vaultCount === null ? "–" : String(vaultCount)}
          href="/passes"
        />
      </div>

      {/* Needs attention */}
      <Section title="Needs attention">
        {loading ? (
          <p className="text-xs text-gray-500 py-2">Loading…</p>
        ) : attentionItems.length === 0 ? (
          <p className="text-sm text-gray-500 py-1">
            No pending actions. All agents operating within bounds.
          </p>
        ) : (
          <div className="space-y-2">
            {attentionItems.map((item, i) => (
              <a
                key={i}
                href={item.href}
                className="flex items-center justify-between rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-3 hover:bg-amber-950/70 transition-colors"
              >
                <span className="text-sm text-amber-300">{item.label}</span>
                <span className="text-xs text-amber-500 shrink-0">Review →</span>
              </a>
            ))}
          </div>
        )}
      </Section>

      {/* Two-column: agents + approvals */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Connected agents */}
        <Section title="Connected agents">
          {loading ? (
            <p className="text-xs text-gray-500 py-4 text-center">Loading…</p>
          ) : delegations.length === 0 ? (
            <Empty
              headline="No agents connected yet."
              body="Delegations give agents a signed identity with scoped permissions."
              cta="Add agent"
              href="/delegations"
            />
          ) : (
            <div className="space-y-2">
              {delegations.slice(0, 5).map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-md border border-gray-800 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-gray-200 truncate">{d.agent_name}</p>
                    <p className="text-xs text-gray-600">{d.channel}</p>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                      d.status === "active"
                        ? "bg-green-950 text-green-400 border border-green-900"
                        : "bg-gray-800 text-gray-500"
                    }`}
                  >
                    {d.status}
                  </span>
                </div>
              ))}
              {delegations.length > 5 && (
                <a
                  href="/delegations"
                  className="text-xs text-indigo-400 hover:underline block text-center pt-1"
                >
                  View all {delegations.length} agents →
                </a>
              )}
            </div>
          )}
        </Section>

        {/* Pending approvals — summary only, no inline decide */}
        <Section title="Pending approvals">
          {loading ? (
            <p className="text-xs text-gray-500 py-4 text-center">Loading…</p>
          ) : pendingApprovals.length === 0 ? (
            <Empty
              headline="No approvals waiting."
              body="When an agent needs sensitive authority, it will appear here."
            />
          ) : (
            <div className="space-y-3">
              {pendingApprovals.slice(0, 3).map((a) => (
                <a
                  key={a.id}
                  href="/route-run-approvals"
                  className="block rounded-md border border-indigo-900 px-3 py-2.5 hover:bg-indigo-950/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className="text-xs text-gray-300 truncate">{a.summary}</p>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
                        a.risk_level === "critical"
                          ? "bg-red-950 text-red-400 border border-red-900"
                          : a.risk_level === "high"
                          ? "bg-orange-950 text-orange-400 border border-orange-900"
                          : a.risk_level === "medium"
                          ? "bg-amber-950 text-amber-400 border border-amber-900"
                          : "bg-gray-800 text-gray-400"
                      }`}
                    >
                      {a.risk_level}
                    </span>
                  </div>
                  {a.domain && <p className="text-xs text-gray-600">{a.domain}</p>}
                </a>
              ))}
              <a
                href="/route-run-approvals"
                className="text-xs text-indigo-400 hover:underline block text-center pt-1"
              >
                Review all in Approvals →
              </a>
            </div>
          )}
        </Section>
      </div>

      {/* Recent proofs */}
      <Section title="Recent proofs">
        {loading ? (
          <p className="text-xs text-gray-500 py-4 text-center">Loading…</p>
        ) : recentProofs.length === 0 ? (
          <Empty
            headline="No signed receipts yet."
            body="UserApprovalReceipts appear after approval decisions are recorded."
            cta="View receipts"
            href="/receipts"
          />
        ) : (
          <div className="divide-y divide-gray-800">
            {recentProofs.map((r) => (
              <a
                key={r.receipt_id}
                href="/receipts"
                className="py-2.5 flex items-center justify-between gap-4 hover:bg-gray-800/30 px-2 -mx-2 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`text-xs font-medium shrink-0 ${
                      r.decision === "approved" ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {r.decision}
                  </span>
                  {r.agent_name && (
                    <span className="text-xs text-gray-400 shrink-0">{r.agent_name}</span>
                  )}
                  {(r.target_domain ?? r.action_type) && (
                    <span className="text-xs text-gray-600 font-mono truncate">
                      {r.target_domain ?? r.action_type}
                    </span>
                  )}
                  {r.risk_level && r.risk_level !== "low" && (
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                        r.risk_level === "critical"
                          ? "bg-red-950 text-red-400"
                          : r.risk_level === "high"
                          ? "bg-orange-950 text-orange-400"
                          : "bg-amber-950 text-amber-400"
                      }`}
                    >
                      {r.risk_level}
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-600 shrink-0">
                  {timeAgo(r.decided_at)}
                </span>
              </a>
            ))}
            <div className="pt-3">
              <a href="/receipts" className="text-xs text-indigo-400 hover:underline">
                View all receipts →
              </a>
            </div>
          </div>
        )}
      </Section>

      {/* Trust setup strip */}
      <div className="border-t border-gray-800 pt-8">
        <p className="text-xs text-gray-600 uppercase tracking-widest mb-4">Trust setup</p>
        <div className="flex items-center gap-2 flex-wrap">
          {trustSteps.map((s, i) => (
            <div key={s.step} className="flex items-center gap-2">
              <a
                href={s.href}
                className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-4 py-2.5 hover:border-indigo-800 hover:bg-indigo-950/40 transition-colors"
              >
                <span className="text-xs text-indigo-400 font-mono">{s.step}</span>
                <span className="text-sm text-gray-300">{s.label}</span>
              </a>
              {i < trustSteps.length - 1 && (
                <span className="text-gray-700 text-sm">→</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  href,
  highlight,
}: {
  label: string;
  value: string;
  href: string;
  highlight?: boolean;
}) {
  return (
    <a
      href={href}
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors block"
    >
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${highlight ? "text-amber-400" : "text-white"}`}>
        {value}
      </p>
    </a>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
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
          className="mt-4 inline-block text-xs bg-indigo-700 hover:bg-indigo-600 text-white px-4 py-2 rounded-md transition-colors"
        >
          {cta}
        </a>
      )}
    </div>
  );
}
