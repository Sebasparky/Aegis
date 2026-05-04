"use client";

import { useEffect, useState } from "react";
import {
  listRouteRuns,
  approveRouteRun,
  rejectRouteRun,
  requestSpendingStepUp,
  listCredentialSessions,
  approveCredentialSession,
  getApprovalContext,
  listAuthenticatedSessions,
  approveAuthenticatedSession,
  rejectAuthenticatedSession,
  type RouteRunWithSummary,
  type CredentialSessionView,
  type RunApprovalContext,
  type ApprovalManifest,
  type ApprovalManifestLineItem,
  type AuthenticatedSessionHandleView,
} from "../../lib/api";

// ─── Tone helpers ─────────────────────────────────────────────────────────────

function toneClass(tone?: ApprovalManifestLineItem["tone"]): string {
  switch (tone) {
    case "money":
      return "text-emerald-400 font-medium";
    case "warning":
      return "text-amber-400";
    case "success":
      return "text-green-400";
    default:
      return "text-gray-200";
  }
}

function riskPillClass(riskTier: string) {
  if (riskTier === "high" || riskTier === "critical")
    return "bg-red-950 border-red-800 text-red-400";
  if (riskTier === "medium") return "bg-amber-950 border-amber-800 text-amber-400";
  return "bg-gray-800 border-gray-700 text-gray-400";
}

function riskLabel(riskTier: string): string {
  if (riskTier === "high") return "High risk";
  if (riskTier === "critical") return "Critical risk";
  if (riskTier === "medium") return "Medium risk";
  return "Low risk";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-800 bg-gray-900">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-gray-500">
          {label}
        </span>
      </div>
      <div className="px-4 py-3 space-y-2">{children}</div>
    </div>
  );
}

function LineItem({ item }: { item: ApprovalManifestLineItem }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-gray-500 shrink-0">{item.label}</span>
      <span className={`text-xs text-right ${toneClass(item.tone)}`}>{item.value}</span>
    </div>
  );
}

function CheckList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
          <span className="text-emerald-500 mt-0.5 shrink-0">✓</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Approval manifest panel ──────────────────────────────────────────────────

function ManifestPanel({ ctx }: { ctx: RunApprovalContext }) {
  const m: ApprovalManifest = ctx.manifest;

  return (
    <div className="space-y-3">
      {/* Title */}
      <div>
        <h3 className="text-lg font-semibold text-white leading-tight">{m.title}</h3>
        <p className="text-sm text-gray-400 mt-0.5">{m.subtitle}</p>
      </div>

      {/* Line items */}
      {m.line_items.length > 0 && (
        <SectionCard label="Details">
          {m.line_items.map((item, i) => (
            <LineItem key={i} item={item} />
          ))}
        </SectionCard>
      )}

      {/* Spending guardrails */}
      {m.spending_limit && (
        <SectionCard label="Spending guardrails">
          {m.spending_limit.max_amount_usd !== undefined && (
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-xs text-gray-500">Max approved</span>
              <span className="text-xs text-amber-400 font-medium">
                ${m.spending_limit.max_amount_usd.toFixed(2)}{" "}
                {m.spending_limit.currency ?? "USD"}
              </span>
            </div>
          )}
          {m.spending_limit.payment_instrument_label && (
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-xs text-gray-500">Payment method</span>
              <span className="text-xs text-gray-200">
                {m.spending_limit.payment_instrument_label}
              </span>
            </div>
          )}
          {m.spending_limit.currency && (
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-xs text-gray-500">Allowed types</span>
              <span className="text-xs text-gray-400">Demo card only</span>
            </div>
          )}
        </SectionCard>
      )}

      {/* Aegis protections */}
      <SectionCard label="What Aegis protects">
        <ul className="space-y-1.5">
          {m.capabilities_to_release.map((cap, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
              <span className="text-indigo-400 mt-0.5 shrink-0">⬡</span>
              <span>
                <span className="text-indigo-300 font-mono">{cap}</span> capability
                will be released by Aegis
              </span>
            </li>
          ))}
          {m.custody_guarantees.map((g, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
              <span className="text-emerald-500 mt-0.5 shrink-0">✓</span>
              <span>{g}</span>
            </li>
          ))}
        </ul>
      </SectionCard>

      {/* Runtime guarantees */}
      <SectionCard label="After you approve">
        <CheckList items={m.runtime_guarantees} />
      </SectionCard>
    </div>
  );
}

// ─── Skeleton while context loads ─────────────────────────────────────────────

function ManifestSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-5 bg-gray-800 rounded w-2/3" />
      <div className="h-3 bg-gray-800 rounded w-1/2" />
      <div className="rounded-lg border border-gray-800 bg-gray-950 h-24" />
      <div className="rounded-lg border border-gray-800 bg-gray-950 h-16" />
    </div>
  );
}

// ─── Technical details collapsible ───────────────────────────────────────────

function TechnicalDetails({ run }: { run: RouteRunWithSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-gray-800 pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
      >
        <span>{open ? "▾" : "▸"}</span> Technical details
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-gray-600">
          <span>
            Run ID:{" "}
            <span className="text-gray-500 font-mono">{run.run_id}</span>
          </span>
          <span>
            Route ID:{" "}
            <span className="text-gray-500 font-mono">
              {run.route_summary?.route_id ?? run.route_id}
            </span>
          </span>
          {run.collar_id && (
            <span>
              Collar:{" "}
              <span className="text-gray-500 font-mono">{run.collar_id}</span>
            </span>
          )}
          {run.delegation_id && (
            <span>
              Delegation:{" "}
              <span className="text-gray-500 font-mono">{run.delegation_id}</span>
            </span>
          )}
          {run.route_summary?.trust_tier && (
            <span>
              Trust tier:{" "}
              <span className="text-gray-500 font-mono">
                {run.route_summary.trust_tier}
              </span>
            </span>
          )}
          {run.approval_required_permissions &&
            run.approval_required_permissions.length > 0 && (
              <span className="col-span-2">
                Permissions:{" "}
                <span className="text-gray-500 font-mono">
                  {run.approval_required_permissions.join(", ")}
                </span>
              </span>
            )}
          <span className="col-span-2">
            Created:{" "}
            <span className="text-gray-500">
              {new Date(run.created_at).toLocaleString()}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Pending run card ─────────────────────────────────────────────────────────

function PendingRunCard({
  run,
  ctx,
  loadingCtx,
  onApprove,
  onReject,
  onContextUpdate,
}: {
  run: RouteRunWithSummary;
  ctx?: RunApprovalContext;
  loadingCtx: boolean;
  onApprove: () => void;
  onReject: () => void;
  onContextUpdate: (updated: RunApprovalContext) => void;
}) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [approved, setApproved] = useState(false);
  const [stepUpState, setStepUpState] = useState<"idle" | "confirming">("idle");
  const [stepUpWorking, setStepUpWorking] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  const riskTier = ctx?.manifest?.risk_tier ?? run.skill_summary?.risk_level ?? "medium";
  const agentId = ctx?.agent_id ?? run.agent_id;
  const m = ctx?.manifest;
  const isBlocked = m?.approval_blocked === true;
  const stepUpApproved = m?.spending_step_up?.status === "approved";

  async function handleApprove() {
    setApproving(true);
    setApproved(true);
    try {
      await onApprove();
    } finally {
      setApproving(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    try {
      await onReject();
    } finally {
      setRejecting(false);
    }
  }

  async function handleConfirmStepUp() {
    if (!m?.purchase_amount) return;
    setStepUpWorking(true);
    setStepUpError(null);
    try {
      const updated = await requestSpendingStepUp(run.run_id, m.purchase_amount.amount_usd);
      onContextUpdate(updated);
      setStepUpState("idle");
    } catch (err: any) {
      setStepUpError(err.message ?? "Failed to approve higher limit.");
    } finally {
      setStepUpWorking(false);
    }
  }

  if (approved) {
    return (
      <div className="bg-gray-900 border border-emerald-900 rounded-xl p-5">
        <p className="text-sm text-emerald-400 font-medium">
          Approved — Aegis is executing this safely.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {run.skill_summary?.name ?? run.skill_id} · {run.domain}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Card header */}
      <div className="px-5 py-4 border-b border-gray-800 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-indigo-950 border border-indigo-800 flex items-center justify-center shrink-0">
            <span className="text-sm">🤖</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">
              {agentId ?? "External agent"}
            </p>
            <p className="text-xs text-gray-500">via Aegis Delegation · {run.domain}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs px-2 py-1 rounded-full border border-amber-800 text-amber-400 bg-amber-950">
            Waiting for approval
          </span>
          <span
            className={`text-xs px-2 py-1 rounded-full border ${riskPillClass(riskTier)}`}
          >
            {riskLabel(riskTier)}
          </span>
        </div>
      </div>

      {/* Manifest */}
      <div className="px-5 py-4 space-y-4">
        {loadingCtx ? (
          <ManifestSkeleton />
        ) : ctx ? (
          <ManifestPanel ctx={ctx} />
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-white">
              {run.skill_summary?.name ?? run.skill_id}
            </p>
            <p className="text-xs text-gray-400">
              {run.route_summary?.workflow_name ?? run.route_id}
            </p>
            {run.approval_required_permissions && run.approval_required_permissions.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {run.approval_required_permissions.map((p) => (
                  <span
                    key={p}
                    className="text-xs px-2 py-0.5 rounded border border-amber-800 text-amber-300 bg-amber-950 font-mono"
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Over-limit warning banner */}
        {isBlocked && !stepUpApproved && (
          <div className="rounded-lg border border-amber-800 bg-amber-950/50 px-4 py-3 space-y-1">
            <p className="text-sm font-medium text-amber-300">This request exceeds your spending limit.</p>
            {m?.constraint_warnings?.map((w, i) => (
              <p key={i} className="text-xs text-amber-400/80">{w}</p>
            ))}
          </div>
        )}

        {/* One-time step-up approved banner */}
        {stepUpApproved && (
          <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 space-y-0.5">
            <p className="text-sm font-medium text-emerald-300">
              One-time limit approved for this run: ${m?.spending_step_up?.approved_amount_usd?.toFixed(2)} USD
            </p>
            {m?.spending_limit?.max_amount_usd !== undefined && (
              <p className="text-xs text-emerald-400/70">
                Default collar limit: ${m.spending_limit.max_amount_usd.toFixed(2)} — not changed.
              </p>
            )}
            <p className="text-xs text-emerald-400/50">This applies to this run only.</p>
          </div>
        )}

        {/* Step-up confirm panel */}
        {isBlocked && !stepUpApproved && stepUpState === "confirming" && m?.purchase_amount && (
          <div className="rounded-lg border border-indigo-800 bg-indigo-950/40 px-4 py-3 space-y-3">
            <div>
              <p className="text-sm font-medium text-white">
                Approve a one-time spending limit of ${m.purchase_amount.amount_usd.toFixed(2)} USD for this run only?
              </p>
              {m.spending_limit?.max_amount_usd !== undefined && (
                <p className="text-xs text-gray-400 mt-1">
                  Default collar limit: ${m.spending_limit.max_amount_usd.toFixed(2)} — this does not change the collar.
                </p>
              )}
              <p className="text-xs text-gray-500 mt-0.5">This applies only to this run.</p>
            </div>
            {stepUpError && (
              <p className="text-xs text-red-400">{stepUpError}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={handleConfirmStepUp}
                disabled={stepUpWorking}
                className="px-3 py-1.5 text-xs rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white font-medium transition-colors disabled:opacity-50"
              >
                {stepUpWorking ? "Approving…" : "Approve one-time limit"}
              </button>
              <button
                onClick={() => setStepUpState("idle")}
                className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-400 hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          {isBlocked && !stepUpApproved ? (
            <>
              {stepUpState === "idle" && (
                <button
                  onClick={() => setStepUpState("confirming")}
                  disabled={rejecting}
                  className="px-4 py-2 text-sm rounded-lg bg-amber-700 hover:bg-amber-600 text-white font-medium transition-colors disabled:opacity-50"
                >
                  Request higher limit
                </button>
              )}
              <button
                onClick={handleReject}
                disabled={approving || rejecting}
                className="px-4 py-2 text-sm rounded-lg border border-red-900 text-red-400 hover:bg-red-950 transition-colors disabled:opacity-50"
              >
                {rejecting ? "Rejecting…" : "Reject"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleApprove}
                disabled={approving || rejecting}
                className="px-4 py-2 text-sm rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white font-medium transition-colors disabled:opacity-50"
              >
                {approving ? "Approving…" : m?.primary_action_label ?? "Approve"}
              </button>
              <button
                onClick={handleReject}
                disabled={approving || rejecting}
                className="px-4 py-2 text-sm rounded-lg border border-red-900 text-red-400 hover:bg-red-950 transition-colors disabled:opacity-50"
              >
                {rejecting ? "Rejecting…" : "Reject"}
              </button>
            </>
          )}
        </div>

        <TechnicalDetails run={run} />
      </div>
    </div>
  );
}

// ─── Authenticated Session Login Request Card ─────────────────────────────────

function PendingAuthSessionCard({
  session,
  onApprove,
  onReject,
}: {
  session: AuthenticatedSessionHandleView;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  async function handleApprove() {
    setApproving(true);
    try { await onApprove(); } finally { setApproving(false); }
  }
  async function handleReject() {
    setRejecting(true);
    try { await onReject(); } finally { setRejecting(false); }
  }

  return (
    <div className="bg-gray-900 border border-purple-900 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-white">Aegis Login Request</p>
          <p className="text-xs text-purple-300 font-mono mt-0.5">{session.domain}</p>
        </div>
        <span className="text-xs px-2 py-1 rounded-full border border-purple-800 text-purple-300 bg-purple-950 shrink-0">
          Waiting for approval
        </span>
      </div>

      {/* Task */}
      <div className="rounded-lg bg-gray-950 border border-gray-800 px-4 py-3">
        <p className="text-[10px] font-semibold tracking-widest uppercase text-gray-500 mb-1">Task</p>
        <p className="text-sm text-gray-200">{session.task_summary}</p>
      </div>

      {/* Custody guarantees */}
      <div className="rounded-lg bg-gray-950 border border-gray-800 px-4 py-3 space-y-2">
        <p className="text-[10px] font-semibold tracking-widest uppercase text-gray-500 mb-1">
          Credential &amp; session custody
        </p>
        <ul className="space-y-1.5">
          {[
            "Aegis uses your stored credential to log in — you are not sharing your password with Claude.",
            "Claude does not see the password at any point.",
            "Claude does not receive cookies, session tokens, or browser storage.",
            "Aegis returns only an authenticated_session_id handle to Claude.",
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
              <span className="text-emerald-500 mt-0.5 shrink-0">✓</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          disabled={approving || rejecting}
          onClick={handleApprove}
          className="px-4 py-2 text-sm rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white font-medium transition-colors disabled:opacity-50"
        >
          {approving ? "Approving…" : "Approve login"}
        </button>
        <button
          disabled={approving || rejecting}
          onClick={handleReject}
          className="px-4 py-2 text-sm rounded-lg border border-red-800 text-red-400 hover:bg-red-950 transition-colors disabled:opacity-50"
        >
          {rejecting ? "Rejecting…" : "Reject"}
        </button>
      </div>

      <p className="text-xs text-gray-600 font-mono">{session.session_id}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RouteRunApprovalsPage() {
  const [runs, setRuns] = useState<RouteRunWithSummary[]>([]);
  const [credSessions, setCredSessions] = useState<CredentialSessionView[]>([]);
  const [authSessions, setAuthSessions] = useState<AuthenticatedSessionHandleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contexts, setContexts] = useState<Map<string, RunApprovalContext>>(new Map());
  const [loadingContexts, setLoadingContexts] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([
      listRouteRuns({ status: "pending_approval" }),
      listCredentialSessions("pending_approval"),
      listAuthenticatedSessions("pending_approval"),
    ])
      .then(([r, s, a]) => {
        setRuns(r);
        setCredSessions(s);
        setAuthSessions(a);
        // Fetch approval context for each pending run in parallel.
        if (r.length > 0) {
          const ids = r.map((run) => run.run_id);
          setLoadingContexts(new Set(ids));
          ids.forEach((id) => {
            getApprovalContext(id)
              .then((ctx) => {
                setContexts((prev) => new Map(prev).set(id, ctx));
              })
              .catch(() => {
                // Context fetch failure is non-fatal — card degrades gracefully.
              })
              .finally(() => {
                setLoadingContexts((prev) => {
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                });
              });
          });
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleApprove(runId: string) {
    setActionError(null);
    try {
      await approveRouteRun(runId);
      setRuns((prev) => prev.filter((r) => r.run_id !== runId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve run.");
    }
  }

  async function handleReject(runId: string) {
    setActionError(null);
    try {
      await rejectRouteRun(runId);
      setRuns((prev) => prev.filter((r) => r.run_id !== runId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to reject run.");
    }
  }

  function handleContextUpdate(runId: string, updated: RunApprovalContext) {
    setContexts((prev) => new Map(prev).set(runId, updated));
  }

  async function handleApproveCredSession(sessionId: string) {
    setActionError(null);
    try {
      await approveCredentialSession(sessionId);
      setCredSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve credential session.");
    }
  }

  async function handleApproveAuthSession(sessionId: string) {
    setActionError(null);
    try {
      await approveAuthenticatedSession(sessionId);
      setAuthSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve login session.");
    }
  }

  async function handleRejectAuthSession(sessionId: string) {
    setActionError(null);
    try {
      await rejectAuthenticatedSession(sessionId);
      setAuthSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to reject login session.");
    }
  }

  const pendingCount = runs.length + credSessions.length + authSessions.length;

  return (
    <div className="max-w-2xl space-y-12">
      {/* Page header */}
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-white">Agent approvals</h1>
          {pendingCount > 0 && !loading && (
            <span className="text-xs px-2.5 py-1 rounded-full bg-amber-950 border border-amber-800 text-amber-400 font-medium">
              {pendingCount} waiting
            </span>
          )}
        </div>
        <p className="text-gray-400 text-sm leading-relaxed">
          Review what your agents are asking Aegis to do before any sensitive capability is
          released.
        </p>
      </div>

      {actionError && (
        <div className="text-xs text-red-400 bg-red-950 border border-red-900 rounded-lg px-4 py-3">
          {actionError}
        </div>
      )}

      {/* Route run approvals */}
      <div className="space-y-4">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : runs.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-gray-800 rounded-xl">
            <p className="text-gray-400 font-medium">No agents are waiting right now.</p>
            <p className="text-gray-600 text-sm mt-1">
              When an external agent needs a sensitive capability approved, it will appear here.
            </p>
          </div>
        ) : (
          runs.map((run) => (
            <PendingRunCard
              key={run.run_id}
              run={run}
              ctx={contexts.get(run.run_id)}
              loadingCtx={loadingContexts.has(run.run_id)}
              onApprove={() => handleApprove(run.run_id)}
              onReject={() => handleReject(run.run_id)}
              onContextUpdate={(updated) => handleContextUpdate(run.run_id, updated)}
            />
          ))
        )}
      </div>

      {/* Credential session requests */}
      {(credSessions.length > 0 || (!loading && credSessions.length === 0)) && (
        <div className="space-y-4 border-t border-gray-800 pt-8">
          <div>
            <h2 className="text-lg font-semibold text-blue-300">Credential session requests</h2>
            <p className="mt-1 text-gray-400 text-sm leading-relaxed">
              An agent is requesting access to use one of your stored credentials for a login
              session. Approving lets Aegis fill credentials on the specified domain for up to 10
              minutes. Secrets are never returned to the agent.
            </p>
          </div>

          {loading ? null : credSessions.length === 0 ? (
            <p className="text-gray-600 text-sm">No credential session requests waiting for approval.</p>
          ) : (
            credSessions.map((session) => (
              <div
                key={session.session_id}
                className="bg-gray-900 border border-blue-900 rounded-xl p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">
                      Allow agent to use{" "}
                      <span className="text-blue-300">
                        {session.pass_label ?? "stored credential"}
                      </span>{" "}
                      on <span className="text-blue-300">{session.domain}</span>?
                    </p>
                    {session.pass_username && (
                      <p className="text-xs text-gray-500 mt-0.5 font-mono">
                        username: {session.pass_username}
                      </p>
                    )}
                    <p className="text-xs text-gray-700 mt-0.5 font-mono">
                      {session.session_id}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full border border-blue-800 text-blue-400 bg-blue-950 shrink-0">
                    Waiting
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-500">
                  <span>
                    Domain: <span className="text-gray-300">{session.domain}</span>
                  </span>
                  <span>
                    Created:{" "}
                    <span className="text-gray-300">
                      {new Date(session.created_at).toLocaleString()}
                    </span>
                  </span>
                </div>

                <div className="text-xs">
                  <span className="text-gray-500">Fields: </span>
                  {session.allowed_fields.map((f) => (
                    <span
                      key={f}
                      className="inline-block mr-1 px-1.5 py-0.5 rounded bg-blue-950 border border-blue-800 text-blue-300 font-mono"
                    >
                      {f}
                    </span>
                  ))}
                </div>

                <p className="text-xs text-gray-500">
                  Session expires 10 minutes after approval. Credentials are filled by Aegis
                  only — never returned to the agent.
                </p>

                <button
                  onClick={() => handleApproveCredSession(session.session_id)}
                  className="px-4 py-2 text-sm rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white font-medium transition-colors"
                >
                  Approve session
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Authenticated session login requests */}
      {(authSessions.length > 0 || (!loading && authSessions.length === 0)) && (
        <div className="space-y-4 border-t border-gray-800 pt-8">
          <div>
            <h2 className="text-lg font-semibold text-purple-300">Login session requests</h2>
            <p className="mt-1 text-gray-400 text-sm leading-relaxed">
              An agent is requesting Aegis to log in on its behalf. Approving lets Aegis perform
              the login using your stored credential — inside an Aegis-controlled browser. The
              agent receives only a session handle, never cookies, storage, or your password.
            </p>
          </div>

          {loading ? null : authSessions.length === 0 ? (
            <p className="text-gray-600 text-sm">No login session requests waiting for approval.</p>
          ) : (
            authSessions.map((session) => (
              <PendingAuthSessionCard
                key={session.session_id}
                session={session}
                onApprove={() => handleApproveAuthSession(session.session_id)}
                onReject={() => handleRejectAuthSession(session.session_id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
