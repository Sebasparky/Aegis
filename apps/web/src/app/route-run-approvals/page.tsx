"use client";

import { useEffect, useState } from "react";
import {
  listRouteRuns,
  approveRouteRun,
  rejectRouteRun,
  listCredentialSessions,
  approveCredentialSession,
  type RouteRunWithSummary,
  type CredentialSessionView,
} from "../../lib/api";

export default function RouteRunApprovalsPage() {
  const [runs, setRuns] = useState<RouteRunWithSummary[]>([]);
  const [credSessions, setCredSessions] = useState<CredentialSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      listRouteRuns({ status: "pending_approval" }),
      listCredentialSessions("pending_approval"),
    ])
      .then(([r, s]) => { setRuns(r); setCredSessions(s); })
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

  async function handleApproveCredSession(sessionId: string) {
    setActionError(null);
    try {
      await approveCredentialSession(sessionId);
      setCredSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve credential session.");
    }
  }

  return (
    <div className="max-w-3xl space-y-12">
      {/* ─── Route Run Approvals ─────────────────────────────────────────────── */}
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Route Run Approvals</h1>
          <p className="mt-2 text-gray-400 text-sm leading-relaxed">
            Review agent-requested runs that require collar approval before execution.
            Approved controlled runs are executed by the Aegis Playwright runtime when available. Rejected runs are blocked.
          </p>
        </div>

        {actionError && (
          <div className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">
            {actionError}
          </div>
        )}

        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-gray-600 text-sm">No route runs waiting for approval.</p>
        ) : (
          <div className="space-y-4">
            {runs.map((run) => (
              <div
                key={run.run_id}
                className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">
                      {run.skill_summary?.name ?? run.skill_id}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono">{run.run_id}</p>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded border border-amber-800 text-amber-400 bg-amber-950 font-mono shrink-0">
                    pending_approval
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-500">
                  <span>Agent: <span className="text-gray-300">{run.agent_id ?? "—"}</span></span>
                  <span>Domain: <span className="text-gray-300">{run.domain}</span></span>
                  {run.delegation_id && (
                    <span>Delegation: <span className="text-gray-300 font-mono">{run.delegation_id}</span></span>
                  )}
                  {run.collar_id && (
                    <span>Collar: <span className="text-gray-300 font-mono">{run.collar_id}</span></span>
                  )}
                  <span>
                    Created:{" "}
                    <span className="text-gray-300">{new Date(run.created_at).toLocaleString()}</span>
                  </span>
                </div>

                {run.approval_required_permissions && run.approval_required_permissions.length > 0 && (
                  <div className="text-xs">
                    <span className="text-gray-500">Needs approval for: </span>
                    {run.approval_required_permissions.map((p) => (
                      <span
                        key={p}
                        className="inline-block mr-1 px-1.5 py-0.5 rounded bg-amber-950 border border-amber-800 text-amber-300 font-mono"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}

                {run.variables && Object.keys(run.variables).length > 0 && (
                  <div className="text-xs text-gray-500">
                    Variables:{" "}
                    <span className="text-gray-400 font-mono">
                      {Object.entries(run.variables)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ")}
                    </span>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => handleApprove(run.run_id)}
                    className="px-3 py-1.5 text-xs rounded-md bg-green-800 hover:bg-green-700 text-white transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(run.run_id)}
                    className="px-3 py-1.5 text-xs rounded-md border border-red-800 text-red-400 hover:bg-red-950 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Credential Session Requests ──────────────────────────────────────── */}
      <div className="space-y-6 border-t border-gray-800 pt-8">
        <div>
          <h2 className="text-2xl font-semibold text-blue-300">Credential Session Requests</h2>
          <p className="mt-2 text-gray-400 text-sm leading-relaxed">
            An agent is requesting access to use one of your stored credentials for a login session.
            Approving grants the agent the ability to fill username and password fields on the
            specified domain for up to 10 minutes. Secrets are never returned to the agent.
          </p>
        </div>

        {!loading && credSessions.length === 0 ? (
          <p className="text-gray-600 text-sm">No credential sessions waiting for approval.</p>
        ) : !loading ? (
          <div className="space-y-4">
            {credSessions.map((session) => (
              <div
                key={session.session_id}
                className="bg-gray-900 border border-blue-900 rounded-lg p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">
                      Allow agent to use{" "}
                      <span className="text-blue-300">
                        {session.pass_label ?? session.pass_id}
                      </span>{" "}
                      on{" "}
                      <span className="text-blue-300">{session.domain}</span>{" "}
                      for this login session?
                    </p>
                    {session.pass_username && (
                      <p className="text-xs text-gray-500 mt-0.5 font-mono">
                        username: {session.pass_username}
                      </p>
                    )}
                    <p className="text-xs text-gray-600 mt-0.5 font-mono">{session.session_id}</p>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded border border-blue-800 text-blue-400 bg-blue-950 font-mono shrink-0">
                    pending_approval
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-500">
                  <span>Domain: <span className="text-gray-300">{session.domain}</span></span>
                  <span>
                    Created:{" "}
                    <span className="text-gray-300">{new Date(session.created_at).toLocaleString()}</span>
                  </span>
                </div>

                <div className="text-xs">
                  <span className="text-gray-500">Fields requested: </span>
                  {session.allowed_fields.map((f) => (
                    <span
                      key={f}
                      className="inline-block mr-1 px-1.5 py-0.5 rounded bg-blue-950 border border-blue-800 text-blue-300 font-mono"
                    >
                      {f}
                    </span>
                  ))}
                </div>

                <div className="text-xs text-gray-500">
                  Session expires 10 minutes after approval. Credentials are filled by the Aegis extension only — never returned to the agent.
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => handleApproveCredSession(session.session_id)}
                    className="px-3 py-1.5 text-xs rounded-md bg-green-800 hover:bg-green-700 text-white transition-colors"
                  >
                    Approve
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
