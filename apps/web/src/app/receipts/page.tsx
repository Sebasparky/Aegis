"use client";

import { useEffect, useState } from "react";
import type { Receipt, RouteRunReceipt } from "@aegis/types";
import { listReceipts, listRouteRunReceipts } from "@/lib/api";

const DECISION_COLORS: Record<string, string> = {
  allowed: "bg-green-900 text-green-400",
  blocked: "bg-red-900 text-red-400",
  approved_by_user: "bg-indigo-900 text-indigo-400",
  denied_by_user: "bg-red-900 text-red-400",
  completed_by_runner: "bg-green-900 text-green-400",
  failed: "bg-red-900 text-red-400",
};

const RUN_STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-900 text-green-400",
  failed: "bg-red-900 text-red-400",
};

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [runReceipts, setRunReceipts] = useState<RouteRunReceipt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [rrResult, rResult] = await Promise.allSettled([
          listRouteRunReceipts(),
          listReceipts(),
        ]);
        if (cancelled) return;
        if (rrResult.status === "fulfilled") setRunReceipts(rrResult.value);
        if (rResult.status === "fulfilled") setReceipts(rResult.value);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Receipts</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Receipts record trust-relevant events — not every click.
        </p>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading...</p>}

      {!loading && (
        <>
          {/* ── Route Run Receipts ── */}
          <div className="mb-8">
            <h2 className="text-base font-medium text-white mb-3">Agent Route Run Receipts</h2>

            {runReceipts.length === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
                <p className="text-sm font-medium text-gray-400">No route run receipts yet.</p>
                <p className="text-xs text-gray-600 mt-1">
                  Receipts are created when an agent-requested skill run completes or fails.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {runReceipts.map((r) => (
                  <div key={r.receipt_id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-sm font-medium text-white">{r.skill_name}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${RUN_STATUS_COLORS[r.status] ?? "bg-gray-800 text-gray-400"}`}>
                            {r.status}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
                            {r.route_trust_tier}
                          </span>
                        </div>

                        <p className="text-xs text-gray-500 mb-1">{r.domain}</p>

                        {r.agent_id && (
                          <p className="text-xs text-gray-500">Agent: <span className="font-mono text-gray-400">{r.agent_id}</span></p>
                        )}

                        {r.variables && Object.keys(r.variables).length > 0 && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            Variables:{" "}
                            <span className="font-mono text-gray-400">
                              {Object.entries(r.variables).map(([k, v]) => `${k}=${v}`).join(", ")}
                            </span>
                          </p>
                        )}

                        <p className="text-xs text-gray-600 mt-2 leading-relaxed">{r.allowed_reason}</p>

                        {r.error && (
                          <p className="text-xs text-red-500 mt-1">Error: {r.error}</p>
                        )}

                        <p className="text-xs text-gray-700 mt-2 font-mono">{r.receipt_id}</p>
                      </div>

                      <div className="text-right shrink-0">
                        <time className="text-xs text-gray-600 block">
                          {new Date(r.completed_at ?? r.created_at).toLocaleString()}
                        </time>
                        <span className="text-xs text-gray-700">{r.execution_surface}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Collar / Approval Receipts ── */}
          <div>
            <h2 className="text-base font-medium text-white mb-3">Action Receipts</h2>

            {receipts.length === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
                <p className="text-sm font-medium text-gray-400">No action receipts yet.</p>
                <p className="text-xs text-gray-600 mt-1">
                  Receipts appear when Aegis handles sensitive actions.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {receipts.map((receipt) => (
                  <div key={receipt.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-white font-mono">{receipt.action_type}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${DECISION_COLORS[receipt.decision] ?? "bg-gray-800 text-gray-400"}`}>
                            {receipt.decision.replace(/_/g, " ")}
                          </span>
                        </div>
                        {receipt.domain && (
                          <p className="text-xs text-gray-500">{receipt.domain}</p>
                        )}
                        {receipt.reason && (
                          <p className="text-xs text-gray-600 mt-0.5">{receipt.reason}</p>
                        )}
                        <div className="flex gap-3 mt-2 text-xs text-gray-600">
                          <span>Outcome: {receipt.outcome}</span>
                          {receipt.sensitive_data_shared_with_agent && (
                            <span className="text-yellow-500">Sensitive data shared</span>
                          )}
                        </div>
                      </div>
                      <time className="text-xs text-gray-600 shrink-0">
                        {new Date(receipt.created_at).toLocaleString()}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
