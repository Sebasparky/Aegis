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

const STATUS_CSS: Record<string, string> = {
  active: "a-status--amber",
  consumed: "a-status--graphite",
  expired: "a-status--graphite",
  revoked: "a-status--red",
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

function VerifyResultPanel({
  result,
  verifiedAt,
}: {
  result: SensitiveGrantVerifyResult;
  verifiedAt: string;
}) {
  return (
    <div style={{ marginTop: 12, padding: "12px 16px", background: "var(--graphite-soft)", border: "1px solid var(--hairline)", borderRadius: "var(--r-2)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <span className={`a-status ${result.uar_valid ? "a-status--green" : "a-status--red"}`}>
          <span className="a-status__dot" />
          {result.uar_valid ? "UAR valid" : "UAR invalid"}
        </span>
        <span className={`a-status ${result.scope_consistent ? "a-status--green" : "a-status--amber"}`}>
          <span className="a-status__dot" />
          {result.scope_consistent ? "Scope consistent" : "Scope mismatch"}
        </span>
        <span className={`a-status ${STATUS_CSS[result.grant_status] ?? "a-status--graphite"}`}>
          <span className="a-status__dot" />
          {STATUS_LABELS[result.grant_status] ?? result.grant_status}
        </span>
      </div>
      {result.uar_error && (
        <p style={{ fontSize: 11.5, color: "var(--amber)", margin: "0 0 4px", fontFamily: "monospace" }}>
          UAR issue: {result.uar_error}
        </p>
      )}
      <p style={{ fontSize: 11, color: "var(--ink-4)", margin: 0 }}>
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
    <div style={{ marginTop: 12, padding: "12px 16px", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-2)" }}>
      <p style={{ fontSize: 13, color: "var(--red)", margin: "0 0 10px" }}>
        Are you sure? This will revoke this sensitive grant immediately.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 200))}
        placeholder="Optional reason…"
        rows={2}
        style={{
          width: "100%", fontSize: 12, fontFamily: "inherit",
          background: "white", border: "1px solid var(--red-ring)", borderRadius: "var(--r-2)",
          padding: "6px 10px", color: "var(--ink-1)", resize: "none",
          outline: "none", boxSizing: "border-box", marginBottom: 8,
        }}
      />
      {err && <p style={{ fontSize: 12, color: "var(--red)", margin: "0 0 8px" }}>{err}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={handleConfirm}
          disabled={working}
          className="a-btn a-btn--danger"
          style={{ fontSize: 12 }}
        >
          {working ? "Revoking…" : "Confirm Revoke"}
        </button>
        <button
          onClick={onCancel}
          disabled={working}
          className="a-btn a-btn--ghost"
          style={{ fontSize: 12 }}
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

  const isActive = grant.status === "active";
  const cardBorderColor = isActive ? "var(--amber-ring)" : "var(--hairline)";

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
      style={{
        border: `1px solid ${cardBorderColor}`,
        borderRadius: "var(--r-3)",
        background: "white",
        padding: "16px 20px",
      }}
    >
      {/* Header: type + status pills + truncated grant_id */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{
          fontSize: 10.5, fontWeight: 500, padding: "1px 8px", borderRadius: 999,
          background: "var(--blue-soft)", color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)",
        }}>
          {GRANT_TYPE_LABELS[grant.grant_type] ?? grant.grant_type}
        </span>
        <span className={`a-status ${STATUS_CSS[grant.status] ?? "a-status--graphite"}`}>
          <span className="a-status__dot" />
          {STATUS_LABELS[grant.status] ?? grant.status}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "monospace", marginLeft: "auto" }}>
          {truncateId(grant.grant_id)}
        </span>
      </div>

      {/* Domain + delegation + timing */}
      <div style={{ marginBottom: 8 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 3px" }}>
          {grant.scope.domain}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 16px" }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
            Delegation:{" "}
            <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{truncateId(grant.scope.delegation_id)}</span>
          </span>
          <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
            Expires:{" "}
            <span style={{ color: "var(--ink-3)" }}>{formatRelativeTime(grant.expires_at)}</span>
          </span>
          {grant.status === "consumed" && grant.consumed_at && (
            <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
              Consumed:{" "}
              <span style={{ color: "var(--ink-3)" }}>{formatRelativeTime(grant.consumed_at)}</span>
            </span>
          )}
          {grant.status === "revoked" && grant.revoked_at && (
            <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
              Revoked:{" "}
              <span style={{ color: "var(--ink-3)" }}>{formatRelativeTime(grant.revoked_at)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Optional context: task / workspace / route run */}
      {(grant.scope.task_id || grant.scope.workspace_id || grant.scope.route_run_id) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 16px", marginBottom: 8 }}>
          {grant.scope.task_id && (
            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>
              Task: <span style={{ fontFamily: "monospace" }}>{truncateId(grant.scope.task_id)}</span>
            </span>
          )}
          {grant.scope.workspace_id && (
            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>
              Workspace: <span style={{ fontFamily: "monospace" }}>{truncateId(grant.scope.workspace_id)}</span>
            </span>
          )}
          {grant.scope.route_run_id && (
            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>
              Run: <span style={{ fontFamily: "monospace" }}>{truncateId(grant.scope.route_run_id)}</span>
            </span>
          )}
        </div>
      )}

      {/* Privacy guarantees */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        <span style={{
          fontSize: 10.5, fontWeight: 500, padding: "1px 8px", borderRadius: 999,
          background: "var(--green-soft)", color: "var(--green)", border: "1px solid var(--green-ring)",
        }}>
          Secret exposed to agent: No
        </span>
        <span style={{
          fontSize: 10.5, fontWeight: 500, padding: "1px 8px", borderRadius: 999,
          background: "var(--green-soft)", color: "var(--green)", border: "1px solid var(--green-ring)",
        }}>
          Raw credentials in grant: No
        </span>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <a
          href="/receipts"
          className="a-link"
          style={{ fontSize: 12 }}
          title={`Linked UAR: ${grant.linked_uar_id}`}
        >
          View receipt →
        </a>
        <button
          onClick={handleVerify}
          disabled={verifyState.status === "loading"}
          style={{ fontSize: 12, color: "var(--ink-3)", background: "none", border: "none", padding: 0, cursor: "pointer", opacity: verifyState.status === "loading" ? 0.5 : 1 }}
        >
          {verifyState.status === "loading" ? "Verifying…" : "Verify grant"}
        </button>
        {isActive && !revokeOpen && (
          <button
            onClick={() => setRevokeOpen(true)}
            style={{ fontSize: 12, color: "var(--red)", background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            Revoke
          </button>
        )}
        <button
          onClick={() => setTechOpen((v) => !v)}
          style={{ fontSize: 12, color: "var(--ink-4)", background: "none", border: "none", padding: 0, cursor: "pointer", marginLeft: "auto" }}
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
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", fontSize: 11.5 }}>
            <span style={{ color: "var(--ink-4)" }}>Grant ID</span>
            <span style={{ fontFamily: "monospace", color: "var(--ink-3)", wordBreak: "break-all" }}>{grant.grant_id}</span>
            <span style={{ color: "var(--ink-4)" }}>Schema</span>
            <span style={{ color: "var(--ink-3)" }}>v{grant.schema_version} · {grant.issuer}</span>
            <span style={{ color: "var(--ink-4)" }}>Linked UAR</span>
            <span style={{ fontFamily: "monospace", color: "var(--ink-3)", wordBreak: "break-all" }}>{grant.linked_uar_id}</span>
            <span style={{ color: "var(--ink-4)" }}>Created</span>
            <span style={{ color: "var(--ink-3)" }}>{new Date(grant.created_at).toLocaleString()}</span>
            <span style={{ color: "var(--ink-4)" }}>Expires</span>
            <span style={{ color: "var(--ink-3)" }}>{new Date(grant.expires_at).toLocaleString()}</span>
            {grant.revoke_reason && (
              <>
                <span style={{ color: "var(--ink-4)" }}>Revoke reason</span>
                <span style={{ color: "var(--ink-3)" }}>{grant.revoke_reason}</span>
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
        <span style={{ fontSize: 12, color: "var(--ink-4)", fontWeight: 500 }}>{STATUS_LABELS[status]}</span>
        <span style={{ fontSize: 12, color: "var(--ink-4)" }}>— 0 grants</span>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setCollapsed((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 13, fontWeight: 600, color: "var(--ink-1)",
          background: "none", border: "none", padding: "0 0 8px", cursor: "pointer",
          width: "100%", textAlign: "left",
        }}
      >
        <span style={{ color: "var(--ink-4)", fontSize: 10 }}>{collapsed ? "▸" : "▾"}</span>
        <span>{STATUS_LABELS[status]}</span>
        <span style={{ fontSize: 12, color: "var(--ink-4)", fontWeight: 400 }}>({grants.length})</span>
      </button>
      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
      .catch(() => setError("Could not load sensitive grants. Make sure the Antigen API is running."))
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
        if (active) setError("Could not load sensitive grants. Make sure the Antigen API is running.");
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

  const selectStyle: React.CSSProperties = {
    fontSize: 12, background: "white", border: "1px solid var(--hairline)",
    color: "var(--ink-2)", borderRadius: "var(--r-2)", padding: "4px 10px",
    outline: "none", cursor: "pointer",
  };

  return (
    <div className="page">

      {/* ── Back nav ── */}
      <div style={{ marginBottom: 16 }}>
        <a
          href="/route-run-approvals"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 12.5, color: "var(--ink-3)", textDecoration: "none",
          }}
        >
          ← Back to approvals
        </a>
      </div>

      {/* ── Header ── */}
      <div style={{ marginBottom: 24 }}>
        <span className="a-eyebrow">Approvals</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-1)", margin: "4px 0 6px" }}>
          Temporary access
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--ink-3)", maxWidth: 520, margin: 0, lineHeight: 1.5 }}>
          These are approvals that are still active. Revoke one if you no longer want an agent to use that access.
        </p>
      </div>

      {/* ── Filter bar ── */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Type</span>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={selectStyle}>
            <option value="">All types</option>
            <option value="credential_injection">Credential Injection</option>
            <option value="challenge_resolution">Challenge Resolution</option>
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Status</span>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={selectStyle}>
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
            style={{ fontSize: 12, color: "var(--ink-4)", background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            Reset
          </button>
        )}
        <button
          onClick={() => loadGrants(filterType, filterStatus)}
          disabled={loading}
          className="a-btn a-btn--ghost"
          style={{ marginLeft: "auto", fontSize: 12 }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-3)", padding: "14px 18px", marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "var(--red)", margin: "0 0 6px" }}>{error}</p>
          <button
            onClick={() => loadGrants(filterType, filterStatus)}
            className="a-link"
            style={{ fontSize: 12, background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-3)", height: 96, background: "var(--graphite-soft)", opacity: 0.5 }} />
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !error && grants.length === 0 && (
        <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-3)", padding: "40px 32px", textAlign: "center" }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-2)", margin: "0 0 6px" }}>No temporary access is active.</p>
          <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: 0, maxWidth: 380, marginInline: "auto" }}>
            When you approve a sensitive request for a limited time, it will appear here so you can revoke it early.
          </p>
        </div>
      )}

      {/* ── Status groups ── */}
      {!loading && !error && grants.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
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
