"use client";

import { useEffect, useState } from "react";
import type { ApprovalRequest } from "@aegis/types";
import { listApprovals, approveRequest, denyRequest } from "@/lib/api";

const RISK_COLORS: Record<string, string> = {
  low: "bg-gray-800 text-gray-400",
  medium: "bg-yellow-900 text-yellow-400",
  high: "bg-orange-900 text-orange-400",
  critical: "bg-red-900 text-red-400",
};

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  async function load() {
    setApprovals(await listApprovals());
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
      alert("Failed to approve.");
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
      alert("Failed to deny.");
    } finally {
      setActing(null);
    }
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Approvals</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Aegis pauses here when an agent tries to do something your collar requires approval for.
        </p>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading...</p>}

      {!loading && pending.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center mb-6">
          <p className="text-sm font-medium text-gray-400">No approvals waiting.</p>
          <p className="text-xs text-gray-600 mt-1">
            Aegis will notify you when an agent tries to do something sensitive.
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-4 mb-8">
          <h2 className="text-sm font-medium text-gray-300">Pending ({pending.length})</h2>
          {pending.map((approval) => (
            <div key={approval.id} className="bg-gray-900 border border-indigo-800 rounded-lg p-5">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white">{approval.summary}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${RISK_COLORS[approval.risk_level] ?? "bg-gray-800 text-gray-400"}`}>
                      {approval.risk_level}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">{approval.reason}</p>
                  {approval.domain && (
                    <p className="text-xs text-gray-600 mt-1">Domain: {approval.domain}</p>
                  )}
                </div>
                <span className="text-xs font-mono text-gray-600 shrink-0">{approval.action_type}</span>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={acting === approval.id}
                  onClick={() => handleApprove(approval.id)}
                  className="text-xs bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white px-4 py-1.5 rounded-md transition-colors"
                >
                  Approve
                </button>
                <button
                  disabled={acting === approval.id}
                  onClick={() => handleDeny(approval.id)}
                  className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 px-4 py-1.5 border border-gray-700 rounded-md transition-colors"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-gray-300 mb-2">Resolved</h2>
          {resolved.map((approval) => (
            <div key={approval.id} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center justify-between">
              <div>
                <span className="text-xs text-gray-400">{approval.summary}</span>
                {approval.domain && (
                  <span className="text-xs text-gray-600 ml-2">— {approval.domain}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-gray-600">{approval.action_type}</span>
                <StatusBadge status={approval.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-900 text-yellow-400",
    approved: "bg-green-900 text-green-400",
    denied: "bg-red-900 text-red-400",
    expired: "bg-gray-800 text-gray-500",
    canceled: "bg-gray-800 text-gray-500",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colors[status] ?? "bg-gray-800 text-gray-400"}`}>
      {status}
    </span>
  );
}
