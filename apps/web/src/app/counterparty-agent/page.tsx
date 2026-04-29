"use client";

import { useEffect, useState } from "react";
import type { AgentTrustPassport } from "@aegis/types";
import { getAgentTrustPassport } from "@/lib/api";

export default function CounterpartyAgentPage() {
  const [aegisId, setAegisId] = useState("aid_user_001");
  const [inputValue, setInputValue] = useState("aid_user_001");
  const [passport, setPassport] = useState<AgentTrustPassport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setPassport(null);
    getAgentTrustPassport(aegisId)
      .then(setPassport)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [aegisId]);

  function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    setAegisId(inputValue.trim());
  }

  const actionColors: Record<string, string> = {
    allow_with_aegis_controls: "bg-green-900 text-green-300 border-green-800",
    require_extra_verification: "bg-yellow-900 text-yellow-300 border-yellow-800",
    block_sensitive_interaction: "bg-red-900 text-red-300 border-red-800",
  };

  const actionLabels: Record<string, string> = {
    allow_with_aegis_controls: "Allow with Aegis Controls",
    require_extra_verification: "Require Extra Verification",
    block_sensitive_interaction: "Block Sensitive Interaction",
  };

  const trustStatusColors: Record<string, string> = {
    demo_verified: "bg-green-900 text-green-300",
    limited_history: "bg-yellow-900 text-yellow-300",
    risk_flagged: "bg-red-900 text-red-300",
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Agent Verification</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Website view: verify whether an incoming agent-backed AegisID is accountable,
          policy-bound, and safe to interact with.
        </p>
      </div>

      <div className="mb-6 px-4 py-3 rounded-lg bg-indigo-950 border border-indigo-800 text-indigo-300 text-sm">
        This is the counterparty view — what a website or business sees when it receives an
        agent-backed AegisID. Only trust claims are shown. No raw browsing history, purchase
        details, vault data, or secrets are disclosed.
      </div>

      <form onSubmit={handleLookup} className="mb-6 flex gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="AegisID (e.g. aid_user_001)"
          className="flex-1 px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
        >
          Verify
        </button>
      </form>

      {loading && <p className="text-gray-500 text-sm">Loading trust passport…</p>}
      {error && (
        <p className="text-red-400 text-sm">
          {error.includes("404") || error.toLowerCase().includes("not found")
            ? `No trust passport found for "${aegisId}".`
            : `Error: ${error}`}
        </p>
      )}

      {passport && (
        <div className="space-y-4">
          {/* Recommended Business Action Badge */}
          <div
            className={`px-4 py-3 rounded-lg border text-sm font-semibold ${
              actionColors[passport.recommended_business_action]
            }`}
          >
            Recommended Action:{" "}
            <span className="uppercase tracking-wide">
              {actionLabels[passport.recommended_business_action]}
            </span>
          </div>

          {/* Trust Passport Card */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
              <p className="text-sm font-semibold text-white">Trust Passport</p>
              <p className="text-xs text-gray-500 font-mono mt-0.5">{passport.aegis_id}</p>
            </div>
            <div className="divide-y divide-gray-800">
              <ClaimRow
                label="Trust Status"
                value={
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      trustStatusColors[passport.trust_status]
                    }`}
                  >
                    {passport.trust_status.replace(/_/g, " ")}
                  </span>
                }
              />
              <ClaimRow
                label="Human-Backed"
                description="Backed by a verified human user (demo)"
                value={
                  <span className="text-xs font-semibold bg-green-900 text-green-300 px-2 py-0.5 rounded-full">
                    {passport.verified_human_backed ? "Yes (demo)" : "No"}
                  </span>
                }
              />
              <ClaimRow
                label="Runner-Completed Purchases"
                description="Purchases executed by Aegis Runner under approval — credentials never exposed"
                value={<CountBadge n={passport.runner_completed_purchases} />}
              />
              <ClaimRow
                label="Approvals Granted"
                description="Sensitive actions explicitly approved by the backing user"
                value={<CountBadge n={passport.approvals_granted} />}
              />
              <ClaimRow
                label="Approvals Denied"
                description="Sensitive actions reviewed and denied by the backing user"
                value={<CountBadge n={passport.approvals_denied} />}
              />
              <ClaimRow
                label="Blocked Risky Actions"
                description="Actions blocked by collar policy before execution"
                value={<CountBadge n={passport.blocked_risky_actions} />}
              />
              <ClaimRow
                label="Credential Exposure Incidents"
                description="Times raw credentials were exposed to an outside agent"
                value={
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      passport.credential_exposure_incidents === 0
                        ? "bg-green-900 text-green-300"
                        : "bg-red-900 text-red-300"
                    }`}
                  >
                    {passport.credential_exposure_incidents}
                  </span>
                }
              />
              <ClaimRow
                label="Sensitive Data Shared with Agent"
                description="Receipts where sensitive data was returned to the outside agent"
                value={
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      passport.sensitive_data_shared_with_agent_count === 0
                        ? "bg-green-900 text-green-300"
                        : "bg-red-900 text-red-300"
                    }`}
                  >
                    {passport.sensitive_data_shared_with_agent_count}
                  </span>
                }
              />
            </div>
          </div>

          {/* Active Policy Summary Card */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
              <p className="text-sm font-semibold text-white">Active Policy (Collar)</p>
              <p className="text-xs text-gray-500 mt-0.5">
                What this agent is authorized and constrained to do
              </p>
            </div>
            <div className="divide-y divide-gray-800">
              <ClaimRow
                label="Purchase Requires Approval"
                value={<BoolBadge value={passport.active_policy_summary.purchase_requires_approval} trueLabel="Yes" falseLabel="No" />}
              />
              <ClaimRow
                label="Payment Requires Approval"
                value={<BoolBadge value={passport.active_policy_summary.payment_requires_approval} trueLabel="Yes" falseLabel="No" />}
              />
              <ClaimRow
                label="Subscriptions Allowed"
                value={<BoolBadge value={passport.active_policy_summary.subscriptions_allowed} trueLabel="Yes" falseLabel="No (blocked)" invert />}
              />
              <ClaimRow
                label="Max Purchase Amount"
                value={
                  <span className="text-xs font-semibold bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">
                    ${passport.active_policy_summary.max_purchase_amount}
                  </span>
                }
              />
              <ClaimRow
                label="Identity Disclosure Blocked"
                value={<BoolBadge value={passport.active_policy_summary.identity_disclosure_blocked} trueLabel="Yes (protected)" falseLabel="No" />}
              />
            </div>
          </div>

          {/* Privacy Notice */}
          <div className="px-4 py-3 rounded-lg bg-gray-900 border border-gray-800 text-xs text-gray-500">
            <span className="font-semibold text-gray-400">Privacy: </span>
            Only claims are shown — not raw browsing history or secrets.
            Disclosure level: <span className="font-mono">{passport.disclosure_level}</span>.
            Last updated:{" "}
            {new Date(passport.last_updated).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </div>
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
  description?: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
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

function BoolBadge({
  value,
  trueLabel,
  falseLabel,
  invert = false,
}: {
  value: boolean;
  trueLabel: string;
  falseLabel: string;
  invert?: boolean;
}) {
  const isGood = invert ? !value : value;
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        isGood ? "bg-green-900 text-green-300" : "bg-gray-800 text-gray-400"
      }`}
    >
      {value ? trueLabel : falseLabel}
    </span>
  );
}
