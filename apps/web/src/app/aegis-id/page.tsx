"use client";

import { useEffect, useState } from "react";
import type { AegisIDTrustClaims } from "@aegis/types";
import { getAegisIDTrustClaims } from "@/lib/api";

export default function AegisIDPage() {
  const [claims, setClaims] = useState<AegisIDTrustClaims | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAegisIDTrustClaims()
      .then(setClaims)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">AegisID</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Your portable trust identity for agent-mediated actions.
        </p>
        {claims && (
          <p className="mt-1 text-xs text-gray-600 font-mono">{claims.aegis_id}</p>
        )}
      </div>

      <div className="mb-6 px-4 py-3 rounded-lg bg-indigo-950 border border-indigo-800 text-indigo-300 text-sm">
        These are local demo trust claims generated from receipts — not raw browsing history and
        not a public reputation score. In production, only derived claims (not raw history) would
        be shared with counterparties, and only with your consent.
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading trust claims…</p>}
      {error && <p className="text-red-400 text-sm">Error: {error}</p>}

      {claims && (
        <div className="space-y-3">
          <ClaimRow
            label="Human-Backed"
            description="This AegisID is backed by a verified human user."
            value={
              <span className="text-xs font-semibold bg-green-900 text-green-300 px-2 py-0.5 rounded-full">
                Verified (demo)
              </span>
            }
          />

          <ClaimRow
            label="Runner-Completed Purchases"
            description="Purchases executed by Aegis Runner under approval constraints. Credentials never exposed to the agent."
            value={<CountBadge n={claims.runner_completed_purchases} />}
          />

          <ClaimRow
            label="Blocked Risky Actions"
            description="Actions blocked by collar policy before execution."
            value={<CountBadge n={claims.blocked_risky_actions} />}
          />

          <ClaimRow
            label="Approvals Granted"
            description="Sensitive actions you explicitly approved."
            value={<CountBadge n={claims.approvals_granted} />}
          />

          <ClaimRow
            label="Approvals Denied"
            description="Sensitive actions you reviewed and denied."
            value={<CountBadge n={claims.approvals_denied} />}
          />

          <ClaimRow
            label="Credential Exposure Incidents"
            description="Times raw credentials were exposed to an outside agent. Incident reporting is not yet implemented — this reflects the current demo system where exposure is architecturally prevented."
            value={
              <span className="text-xs font-semibold bg-green-900 text-green-300 px-2 py-0.5 rounded-full">
                {claims.credential_exposure_incidents} (demo-derived)
              </span>
            }
          />

          <ClaimRow
            label="Sensitive Data Shared with Agent"
            description="Receipts where sensitive data was returned to the outside agent. Should always be 0 in a correctly operating Aegis system."
            value={
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  claims.sensitive_data_shared_with_agent_count === 0
                    ? "bg-green-900 text-green-300"
                    : "bg-red-900 text-red-300"
                }`}
              >
                {claims.sensitive_data_shared_with_agent_count}
              </span>
            }
          />

          <ClaimRow
            label="Purchase History"
            description={
              claims.purchase_history === "demo_clean"
                ? "At least one runner-completed purchase with zero credential exposures."
                : "No runner-completed purchases yet. Run the demo to build history."
            }
            value={
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  claims.purchase_history === "demo_clean"
                    ? "bg-green-900 text-green-300"
                    : "bg-gray-800 text-gray-400"
                }`}
              >
                {claims.purchase_history}
              </span>
            }
          />

          <p className="pt-4 text-xs text-gray-600">
            Last updated:{" "}
            {new Date(claims.last_updated).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
      )}
    </div>
  );
}

function ClaimRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 rounded-lg bg-gray-900 border border-gray-800">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <div className="shrink-0 mt-0.5">{value}</div>
    </div>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        n > 0 ? "bg-indigo-900 text-indigo-300" : "bg-gray-800 text-gray-400"
      }`}
    >
      {n}
    </span>
  );
}
