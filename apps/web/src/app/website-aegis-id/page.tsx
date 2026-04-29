"use client";

import { useEffect, useState } from "react";
import type { WebsiteAegisIDTrustClaims, WebsiteTrustStatus } from "@aegis/types";
import { getWebsiteTrustClaims, listWebsiteTrustClaims } from "@/lib/api";

export default function WebsiteAegisIDPage() {
  const [query, setQuery] = useState("localhost");
  const [inputValue, setInputValue] = useState("localhost");
  const [claims, setClaims] = useState<WebsiteAegisIDTrustClaims | null>(null);
  const [loadingClaims, setLoadingClaims] = useState(true);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [list, setList] = useState<WebsiteAegisIDTrustClaims[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  useEffect(() => {
    setLoadingClaims(true);
    setClaimsError(null);
    getWebsiteTrustClaims(query)
      .then(setClaims)
      .catch((e) => setClaimsError(e.message))
      .finally(() => setLoadingClaims(false));
  }, [query]);

  useEffect(() => {
    listWebsiteTrustClaims()
      .then(setList)
      .catch(() => {})
      .finally(() => setLoadingList(false));
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setQuery(inputValue.trim() || "localhost");
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Website AegisID</h1>
        <p className="mt-1 text-gray-400 text-sm">
          This is the counterparty side of Aegis. It helps agents and users decide whether a
          website or business is safe to interact with before committing sensitive actions.
        </p>
      </div>

      <div className="mb-6 px-4 py-3 rounded-lg bg-indigo-950 border border-indigo-800 text-indigo-300 text-sm">
        Local and demo only — this is not real domain verification, real business verification,
        or a public reputation score. Trust records are seeded locally for demo purposes.
      </div>

      <form onSubmit={handleSearch} className="mb-6 flex gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Enter domain (e.g. localhost, bad-store.local)"
          className="flex-1 px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
        >
          Look up
        </button>
      </form>

      {loadingClaims && <p className="text-gray-500 text-sm mb-6">Loading trust claims…</p>}
      {claimsError && (
        <p className="text-red-400 text-sm mb-6">Error: {claimsError}</p>
      )}

      {claims && !loadingClaims && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-base font-medium text-white">{claims.domain}</h2>
            <TrustBadge status={claims.trust_status} />
          </div>
          <p className="text-xs text-gray-500 font-mono mb-4">{claims.website_aegis_id}</p>

          <div className="space-y-2">
            <ClaimRow
              label="Business Name"
              value={<span className="text-sm text-gray-200">{claims.business_name}</span>}
            />
            <ClaimRow
              label="Domain Verified"
              value={<BoolBadge value={claims.domain_verified} />}
            />
            <ClaimRow
              label="Agent Policy Published"
              value={<BoolBadge value={claims.agent_policy_published} />}
            />
            <ClaimRow
              label="Prompt Injection Reports"
              value={<CountBadge n={claims.prompt_injection_reports} warningAbove={0} />}
            />
            <ClaimRow
              label="Successful Runner Transactions"
              value={<CountBadge n={claims.successful_runner_transactions} />}
            />
            <ClaimRow
              label="Blocked / Disputed Actions"
              value={<CountBadge n={claims.blocked_or_disputed_actions} warningAbove={0} />}
            />
            <ClaimRow
              label="Credential Exposure Incidents"
              value={
                <span className="text-xs font-semibold bg-green-900 text-green-300 px-2 py-0.5 rounded-full">
                  {claims.credential_exposure_incidents} (incident reporting not yet built)
                </span>
              }
            />
            <ClaimRow
              label="Recommended Agent Action"
              value={<ActionBadge action={claims.recommended_agent_action} />}
            />
          </div>

          <p className="mt-3 text-xs text-gray-600">
            Last updated:{" "}
            {new Date(claims.last_updated).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
      )}

      <div>
        <h2 className="text-base font-medium text-white mb-3">Known Website Identities</h2>
        {loadingList && <p className="text-gray-500 text-sm">Loading…</p>}
        {!loadingList && list.length === 0 && (
          <p className="text-gray-500 text-sm">No known identities yet.</p>
        )}
        <div className="space-y-2">
          {list.map((item) => (
            <button
              key={item.domain}
              onClick={() => {
                setInputValue(item.domain);
                setQuery(item.domain);
              }}
              className="w-full text-left flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-gray-900 border border-gray-800 hover:border-gray-600 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{item.domain}</p>
                <p className="text-xs text-gray-500 truncate">{item.business_name}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-500">{item.successful_runner_transactions} txn</span>
                <TrustBadge status={item.trust_status} />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TrustBadge({ status }: { status: WebsiteTrustStatus }) {
  if (status === "verified_demo_business") {
    return (
      <span className="text-xs font-semibold bg-green-900 text-green-300 px-2 py-0.5 rounded-full">
        Verified Demo Business
      </span>
    );
  }
  if (status === "flagged") {
    return (
      <span className="text-xs font-semibold bg-red-900 text-red-300 px-2 py-0.5 rounded-full">
        Flagged
      </span>
    );
  }
  return (
    <span className="text-xs font-semibold bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">
      Unverified
    </span>
  );
}

function BoolBadge({ value }: { value: boolean }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        value ? "bg-green-900 text-green-300" : "bg-gray-800 text-gray-400"
      }`}
    >
      {value ? "Yes" : "No"}
    </span>
  );
}

function CountBadge({ n, warningAbove }: { n: number; warningAbove?: number }) {
  const isWarning = warningAbove !== undefined && n > warningAbove;
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        isWarning
          ? "bg-red-900 text-red-300"
          : n > 0
          ? "bg-indigo-900 text-indigo-300"
          : "bg-gray-800 text-gray-400"
      }`}
    >
      {n}
    </span>
  );
}

function ActionBadge({
  action,
}: {
  action: "allow_normal_browsing" | "require_extra_approval" | "block_sensitive_actions";
}) {
  if (action === "allow_normal_browsing") {
    return (
      <span className="text-xs font-semibold bg-green-900 text-green-300 px-2 py-0.5 rounded-full">
        Allow Normal Browsing
      </span>
    );
  }
  if (action === "block_sensitive_actions") {
    return (
      <span className="text-xs font-semibold bg-red-900 text-red-300 px-2 py-0.5 rounded-full">
        Block Sensitive Actions
      </span>
    );
  }
  return (
    <span className="text-xs font-semibold bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded-full">
      Require Extra Approval
    </span>
  );
}

function ClaimRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg bg-gray-900 border border-gray-800">
      <p className="text-sm text-gray-300">{label}</p>
      <div className="shrink-0">{value}</div>
    </div>
  );
}
