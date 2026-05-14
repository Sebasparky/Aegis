"use client";

import { useEffect, useState } from "react";
import type { SensitiveGrant } from "@aegis/types";
import {
  listSensitiveGrants,
  verifySensitiveGrant,
  revokeSensitiveGrant,
  type SensitiveGrantVerifyResult,
} from "@/lib/api";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_ORDER: SensitiveGrant["status"][] = ["active", "consumed", "expired", "revoked"];

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  consumed: "Consumed",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_BORDER: Record<string, string> = {
  active: "border-amber-800 bg-gray-900",
  consumed: "border-gray-800 bg-gray-900",
  expired: "border-gray-800 bg-gray-900",
  revoked: "border-gray-800 bg-gray-900",
};

const STATUS_PILL: Record<string, string> = {
  active: "bg-amber-950 text-amber-300 border border-amber-800",
  consumed: "bg-gray-800 text-gray-400",
  expired: "bg-gray-800 text-gray-500",
  revoked: "bg-red-950 text-red-400",
};

const TYPE_PILL: Record<string, string> = {
  credential_injection: "bg-indigo-950 text-indigo-300 border border-indigo-800",
  challenge_resolution: "bg-purple-950 text-purple-300 border border-purple-800",
};

const GRANT_TYPE_LABELS: Record<string, string> = {
  credential_injection: "Credential Injection",
  challenge_resolution: "Challenge Resolution",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(diff);
    const future = diff < 0;
    if (abs < 60_000) return future ? "in seconds" : "just now";
    const mins = Math.floor(abs / 60_000);
    if (abs < 3_600_000) return future ? `in ${mins}m` : `${mins}m ago`;
    const hrs = Math.floor(abs / 3_600_000);
    if (abs < 86_400_000) return future ? `in ${hrs}h` : `${hrs}h ago`;
    const days = Math.floor(abs / 86_400_000);
    return future ? `in ${days}d` : `${days}d ago`;
  } catch {
    return iso;
  }
}

function truncateId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Pill({ label, className }: { label: string; className: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${className}`}>{label}</span>
  );
}

function PrivacyBadge({ label }: { label: string }) {
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-900">
      {label}
    </span>
  );
}

function EmptyState({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
      <p className="text-sm font-medium text-gray-400">{label}</p>
      <p className="text-xs text-gray-600 mt-1">{hint}</p>
    </div>
  );
}

function VerifyResultPanel({
  result,
  verifiedAt,
}: {
  result: SensitiveGrantVerifyResult;
  verifiedAt: string;
}) {
  return (
    <div className="mt-3 p-3 bg-gray-950 border border-gray-800 rounded-lg space-y-2">
      <div className="flex flex-wrap gap-2">
        <Pill
          label={result.uar_valid ? "UAR valid" : "UAR invalid"}
          className={
            result.uar_valid ? "bg-emerald-950 text-emerald-400 border border-emerald-900" : "bg-red-950 text-red-400 border border-red-900"
          }
        />
        <Pill
          label={result.scope_consistent ? "Scope consistent" : "Scope mismatch"}
          className={
            result.scope_consistent
              ? "bg-emerald-950 text-emerald-400 border border-emerald-900"
              : "bg-amber-950 text-amber-400 border border-amber-900"
          }
        />
        <Pill
          label={STATUS_LABELS[result.grant_status] ?? result.grant_status}
          className={STATUS_PILL[result.grant_status] ?? "bg-gray-800 text-gray-400"}
        />
      </div>
      {result.uar_error && (
        <p className="text-xs text-amber-400">
          UAR issue: <span className="font-mono">{result.uar_error}</span>
        </p>
      )}
      <p className="text-xs text-gray-600">
        Verified at {new Date(verifiedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}

function RevokePanel({
  onConfirm,
  onCancel,
}: {
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleConfirm() {
    setWorking(true);
    setErr(null);
    try {
      await onConfirm(reason.trim());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("INVALID_STATUS")) setErr("Grant is no longer active.");
      else if (msg.includes("NOT_FOUND")) setErr("Grant not found.");
      else if (msg.includes("FORBIDDEN")) setErr("Not authorized to revoke this grant.");
      else setErr(msg || "Revocation failed. Please try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="mt-3 p-3 bg-red-950/20 border border-red-900 rounded-lg space-y-3">
      <p className="text-sm text-red-200">
        Are you sure? This will revoke this sensitive grant immediately.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 200))}
        placeholder="Optional reason…"
        rows={2}
        className="w-full text-xs bg-gray-950 border border-gray-800 rounded-md px-2 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-red-800 resize-none"
      />
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={handleConfirm}
          disabled={working}
          className="px-3 py-1.5 text-xs rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium transition-colors disabled:opacity-50"
        >
          {working ? "Revoking…" : "Confirm Revoke"}
        </button>
        <button
          onClick={onCancel}
          disabled={working}
          className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

type VerifyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: SensitiveGrantVerifyResult; verifiedAt: string };

function GrantCard({
  grant,
  onRevoked,
}: {
  grant: SensitiveGrant;
  onRevoked: (grantId: string) => void;
}) {
  const [verifyState, setVerifyState] = useState<VerifyState>({ status: "idle" });
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);

  async function handleVerify() {
    setVerifyState({ status: "loading" });
    try {
      const result = await verifySensitiveGrant(grant.grant_id);
      setVerifyState({ status: "done", result, verifiedAt: new Date().toISOString() });
    } catch {
      setVerifyState({
        status: "done",
        result: {
          grant_id: grant.grant_id,
          linked_uar_id: grant.linked_uar_id,
          uar_valid: false,
          scope_consistent: false,
          grant_status: grant.status,
          uar_error: "FETCH_FAILED",
        },
        verifiedAt: new Date().toISOString(),
      });
    }
  }

  async function handleRevoke(reason: string) {
    await revokeSensitiveGrant(grant.grant_id, reason || undefined);
    onRevoked(grant.grant_id);
    setRevokeOpen(false);
  }

  return (
    <div
      id={`grant-${grant.grant_id}`}
      className={`border rounded-lg p-4 ${STATUS_BORDER[grant.status] ?? "border-gray-800 bg-gray-900"}`}
    >
      {/* Header: type + status pills + truncated grant_id */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <Pill
          label={GRANT_TYPE_LABELS[grant.grant_type] ?? grant.grant_type}
          className={TYPE_PILL[grant.grant_type] ?? "bg-gray-800 text-gray-400"}
        />
        <Pill
          label={STATUS_LABELS[grant.status] ?? grant.status}
          className={STATUS_PILL[grant.status] ?? "bg-gray-800 text-gray-400"}
        />
        <span className="text-xs font-mono text-gray-600 ml-auto">{truncateId(grant.grant_id)}</span>
      </div>

      {/* Domain + delegation + timing */}
      <div className="mb-2">
        <p className="text-sm font-medium text-white">{grant.scope.domain}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
          <span className="text-xs text-gray-500">
            Delegation:{" "}
            <span className="font-mono text-gray-400">{truncateId(grant.scope.delegation_id)}</span>
          </span>
          <span className="text-xs text-gray-500">
            Expires:{" "}
            <span className="text-gray-400">{formatRelativeTime(grant.expires_at)}</span>
          </span>
          {grant.status === "consumed" && grant.consumed_at && (
            <span className="text-xs text-gray-500">
              Consumed:{" "}
              <span className="text-gray-400">{formatRelativeTime(grant.consumed_at)}</span>
            </span>
          )}
          {grant.status === "revoked" && grant.revoked_at && (
            <span className="text-xs text-gray-500">
              Revoked:{" "}
              <span className="text-gray-400">{formatRelativeTime(grant.revoked_at)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Optional context: task / workspace / route run */}
      {(grant.scope.task_id || grant.scope.workspace_id || grant.scope.route_run_id) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-2">
          {grant.scope.task_id && (
            <span className="text-xs text-gray-600">
              Task: <span className="font-mono">{truncateId(grant.scope.task_id)}</span>
            </span>
          )}
          {grant.scope.workspace_id && (
            <span className="text-xs text-gray-600">
              Workspace: <span className="font-mono">{truncateId(grant.scope.workspace_id)}</span>
            </span>
          )}
          {grant.scope.route_run_id && (
            <span className="text-xs text-gray-600">
              Run: <span className="font-mono">{truncateId(grant.scope.route_run_id)}</span>
            </span>
          )}
        </div>
      )}

      {/* Privacy guarantees — always visible */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        <PrivacyBadge label="Secret exposed to agent: No" />
        <PrivacyBadge label="Raw credentials in grant: No" />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-4">
        <a
          href="/receipts"
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          title={`Linked UAR: ${grant.linked_uar_id}`}
        >
          View receipt →
        </a>
        <button
          onClick={handleVerify}
          disabled={verifyState.status === "loading"}
          className="text-xs text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
        >
          {verifyState.status === "loading" ? "Verifying…" : "Verify grant"}
        </button>
        {grant.status === "active" && !revokeOpen && (
          <button
            onClick={() => setRevokeOpen(true)}
            className="text-xs text-red-500 hover:text-red-400 transition-colors"
          >
            Revoke
          </button>
        )}
        <button
          onClick={() => setTechOpen((v) => !v)}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors ml-auto"
        >
          {techOpen ? "Hide details" : "Details"}
        </button>
      </div>

      {/* Verify result */}
      {verifyState.status === "done" && (
        <VerifyResultPanel result={verifyState.result} verifiedAt={verifyState.verifiedAt} />
      )}

      {/* Revoke panel */}
      {revokeOpen && (
        <RevokePanel
          onConfirm={handleRevoke}
          onCancel={() => setRevokeOpen(false)}
        />
      )}

      {/* Technical details */}
      {techOpen && (
        <div className="mt-3 pt-3 border-t border-gray-800">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <span className="text-gray-600">Grant ID</span>
            <span className="font-mono text-gray-500 break-all">{grant.grant_id}</span>
            <span className="text-gray-600">Schema</span>
            <span className="text-gray-500">v{grant.schema_version} · {grant.issuer}</span>
            <span className="text-gray-600">Linked UAR</span>
            <span className="font-mono text-gray-500 break-all">{grant.linked_uar_id}</span>
            <span className="text-gray-600">Created</span>
            <span className="text-gray-500">{new Date(grant.created_at).toLocaleString()}</span>
            <span className="text-gray-600">Expires</span>
            <span className="text-gray-500">{new Date(grant.expires_at).toLocaleString()}</span>
            {grant.revoke_reason && (
              <>
                <span className="text-gray-600">Revoke reason</span>
                <span className="text-gray-500">{grant.revoke_reason}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusGroup({
  status,
  grants,
  onGrantRevoked,
}: {
  status: SensitiveGrant["status"];
  grants: SensitiveGrant[];
  onGrantRevoked: (grantId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(status !== "active");

  if (grants.length === 0) {
    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="text-xs text-gray-700 font-medium">{STATUS_LABELS[status]}</span>
        <span className="text-xs text-gray-800">— 0 grants</span>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-2 text-sm font-medium text-gray-300 hover:text-white transition-colors mb-2 w-full text-left"
      >
        <span className="text-gray-600">{collapsed ? "▸" : "▾"}</span>
        <span>{STATUS_LABELS[status]}</span>
        <span className="text-xs text-gray-600 font-normal">({grants.length})</span>
      </button>
      {!collapsed && (
        <div className="space-y-3">
          {grants.map((g) => (
            <GrantCard key={g.grant_id} grant={g} onRevoked={onGrantRevoked} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SensitiveGrantsPage() {
  const [grants, setGrants] = useState<SensitiveGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  function loadGrants(type: string, status: string) {
    setLoading(true);
    setError(null);
    const filters = {
      ...(type ? { grant_type: type } : {}),
      ...(status ? { status } : {}),
    };
    listSensitiveGrants(Object.keys(filters).length ? filters : undefined)
      .then(setGrants)
      .catch(() =>
        setError("Could not load sensitive grants. Make sure the Aegis API is running.")
      )
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const filters = {
      ...(filterType ? { grant_type: filterType } : {}),
      ...(filterStatus ? { status: filterStatus } : {}),
    };
    listSensitiveGrants(Object.keys(filters).length ? filters : undefined)
      .then((data) => { if (active) setGrants(data); })
      .catch(() => {
        if (active) setError("Could not load sensitive grants. Make sure the Aegis API is running.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filterType, filterStatus]);

  function handleGrantRevoked(grantId: string) {
    setGrants((prev) =>
      prev.map((g) =>
        g.grant_id === grantId
          ? { ...g, status: "revoked" as const, revoked_at: new Date().toISOString() }
          : g
      )
    );
  }

  const grouped = STATUS_ORDER.reduce<Record<string, SensitiveGrant[]>>((acc, s) => {
    acc[s] = grants.filter((g) => g.status === s);
    return acc;
  }, {} as Record<string, SensitiveGrant[]>);

  const isFiltered = !!filterType || !!filterStatus;

  const selectClass =
    "text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-gray-600 cursor-pointer";

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-white">Sensitive Grants</h1>
        <p className="mt-1 text-sm text-gray-400 max-w-xl">
          Authority tokens issued when you approved a sensitive operation. Revoke any active grant
          to cancel the delegated authority immediately. No passwords or raw secrets are stored here.
        </p>
      </div>

      {/* Filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">Type</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className={selectClass}
          >
            <option value="">All types</option>
            <option value="credential_injection">Credential Injection</option>
            <option value="challenge_resolution">Challenge Resolution</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">Status</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className={selectClass}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="consumed">Consumed</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
        {isFiltered && (
          <button
            onClick={() => { setFilterType(""); setFilterStatus(""); }}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            Reset
          </button>
        )}
        <button
          onClick={() => loadGrants(filterType, filterStatus)}
          disabled={loading}
          className="ml-auto text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1 rounded-md transition-colors disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-950 border border-red-800 rounded-lg p-4 mb-4 text-sm text-red-400">
          {error}{" "}
          <button
            onClick={() => loadGrants(filterType, filterStatus)}
            className="underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-24" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && grants.length === 0 && (
        <EmptyState
          label="No sensitive grants found."
          hint="Grants are created when you approve a credential injection or challenge resolution. Run an Aegis login flow to create one."
        />
      )}

      {/* Status groups */}
      {!loading && !error && grants.length > 0 && (
        <div className="space-y-5">
          {STATUS_ORDER.map((status) => (
            <StatusGroup
              key={status}
              status={status}
              grants={grouped[status] ?? []}
              onGrantRevoked={handleGrantRevoked}
            />
          ))}
        </div>
      )}
    </div>
  );
}
