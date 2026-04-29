"use client";

import { useEffect, useState } from "react";
import type { Receipt } from "@aegis/types";
import { listReceipts } from "@/lib/api";

const DECISION_COLORS: Record<string, string> = {
  allowed: "bg-green-900 text-green-400",
  blocked: "bg-red-900 text-red-400",
  approved_by_user: "bg-indigo-900 text-indigo-400",
  denied_by_user: "bg-red-900 text-red-400",
  completed_by_runner: "bg-green-900 text-green-400",
  failed: "bg-red-900 text-red-400",
};

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listReceipts()
      .then(setReceipts)
      .finally(() => setLoading(false));
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

      {!loading && receipts.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-400">No receipts yet.</p>
          <p className="text-xs text-gray-600 mt-1">
            Receipts appear when Aegis handles sensitive actions.
          </p>
        </div>
      )}

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
    </div>
  );
}
