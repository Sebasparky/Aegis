"use client";

import { useEffect, useState } from "react";
import type {
  Receipt,
  RouteRunReceipt,
  UserApprovalReceipt,
  WebsiteTrustProfile,
  WebsiteViolationReceipt,
} from "@aegis/types";
import {
  listReceipts,
  listRouteRunReceipts,
  listUserApprovalReceipts,
  getUserApprovalReceipt,
  verifyUserApprovalReceipt,
  listWebsiteTrustProfiles,
  verifyWebsiteTrustProfile,
  listWebsiteViolationReceipts,
  verifyWebsiteViolationReceipt,
} from "@/lib/api";

type Tab = "approvals" | "profiles" | "violations" | "runs" | "actions";

type VerifyResult = {
  valid: boolean;
  hash_valid: boolean;
  signature_valid: boolean;
  error?: string;
};
type VerifyState = { status: "idle" | "loading" | "done"; result?: VerifyResult };

const TABS: { id: Tab; label: string }[] = [
  { id: "approvals", label: "Approvals" },
  { id: "profiles", label: "Trust Profiles" },
  { id: "violations", label: "Violations" },
  { id: "runs", label: "Route Runs" },
  { id: "actions", label: "Actions" },
];

// ── Status pill variant maps ───────────────────────────────────────────────────

type StatusVariant = "green" | "red" | "amber" | "blue" | "graphite" | "quiet" | "outline-red" | "outline-amber";

const DECISION_VARIANT: Record<string, StatusVariant> = {
  approved: "quiet",
  denied: "outline-red",
  allowed: "quiet",
  blocked: "outline-red",
  warned: "outline-amber",
  escalated: "outline-amber",
  reputation_penalized: "graphite",
  recorded_only: "graphite",
  approved_by_user: "quiet",
  denied_by_user: "outline-red",
  completed_by_runner: "quiet",
  failed: "outline-red",
};

const SEVERITY_VARIANT: Record<string, StatusVariant> = {
  low: "graphite",
  medium: "amber",
  high: "red",
  critical: "red",
};

const TRUST_STATUS_VARIANT: Record<string, StatusVariant> = {
  verified: "quiet",
  unverified: "quiet",
  suspended: "outline-red",
};

const PROFILE_STATUS_VARIANT: Record<string, StatusVariant> = {
  active: "quiet",
  revoked: "outline-red",
  superseded: "outline-amber",
};

const RUN_STATUS_VARIANT: Record<string, StatusVariant> = {
  completed: "quiet",
  failed: "outline-red",
};

// ── Primitives ─────────────────────────────────────────────────────────────────

function AStatus({ label, variant = "graphite" }: { label: string; variant?: StatusVariant }) {
  return (
    <span className={`a-status a-status--${variant}`}>
      <span className="a-status__dot" />
      {label}
    </span>
  );
}

function SignedBadge({ jws_present }: { jws_present: boolean }) {
  if (jws_present) {
    return (
      <span className="a-status a-status--quiet" style={{ fontSize: 11 }}>
        Signed
      </span>
    );
  }
  return <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Unsigned</span>;
}

function VerificationBadge({ state }: { state?: VerifyState }) {
  if (!state || state.status === "idle") {
    return <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Not verified</span>;
  }
  if (state.status === "loading") {
    return (
      <span style={{ fontSize: 11.5, color: "var(--ink-4)" }} className="animate-pulse">
        Verifying…
      </span>
    );
  }
  const r = state.result!;
  if (r.error === "SIGNING_KEY_UNAVAILABLE") return <AStatus label="Dev mode" variant="outline-amber" />;
  if (r.valid) return <AStatus label="Valid" variant="quiet" />;
  if (r.hash_valid) return <AStatus label="Unsigned" variant="amber" />;
  return <AStatus label="Invalid" variant="red" />;
}

function EmptyState({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="a-card" style={{ textAlign: "center", padding: "48px 24px" }}>
      <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>{label}</p>
      <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>{hint}</p>
    </div>
  );
}

function MetaGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 24px" }}>
      {children}
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{label}</span>
      <span
        style={{
          fontSize: 12,
          color: "var(--ink-2)",
          fontFamily: mono ? '"JetBrains Mono", monospace' : undefined,
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </>
  );
}

function JwsBlock({ jws }: { jws?: string }) {
  if (!jws) {
    return <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>Signature not available.</p>;
  }
  return (
    <pre
      style={{
        fontSize: 11.5,
        color: "var(--ink-3)",
        background: "var(--graphite-soft)",
        border: "1px solid var(--hairline)",
        borderRadius: "var(--r-1)",
        padding: "10px 12px",
        overflowX: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        fontFamily: '"JetBrains Mono", monospace',
        margin: 0,
      }}
    >
      {jws}
    </pre>
  );
}

function VerifyRow({
  verifyState,
  onVerify,
  onToggleExpand,
  expandLabel,
  isExpanded,
}: {
  verifyState?: VerifyState;
  onVerify: () => void;
  onToggleExpand: () => void;
  expandLabel: string;
  isExpanded: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <VerificationBadge state={verifyState} />
      <button
        onClick={onVerify}
        disabled={verifyState?.status === "loading"}
        className="a-btn a-btn--ghost"
        style={{ fontSize: 12, padding: "4px 10px" }}
      >
        Verify
      </button>
      <button
        onClick={onToggleExpand}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          color: "var(--blue)",
          padding: 0,
        }}
      >
        {isExpanded ? `Hide ${expandLabel}` : `View ${expandLabel}`}
      </button>
    </div>
  );
}

function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

function SigToggle({
  id,
  sigExpanded,
  onToggle,
}: {
  id: string;
  sigExpanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onToggle(id)}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        fontSize: 12,
        color: "var(--ink-4)",
        padding: 0,
        marginTop: 10,
        display: "block",
      }}
    >
      {sigExpanded[id] ? "Hide signature" : "Show signature"}
    </button>
  );
}

function truncateHash(hash: string) {
  return hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ReceiptsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("approvals");
  const [loading, setLoading] = useState(true);

  const [approvalReceipts, setApprovalReceipts] = useState<UserApprovalReceipt[]>([]);
  const [trustProfiles, setTrustProfiles] = useState<WebsiteTrustProfile[]>([]);
  const [violationReceipts, setViolationReceipts] = useState<WebsiteViolationReceipt[]>([]);
  const [runReceipts, setRunReceipts] = useState<RouteRunReceipt[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);

  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sigExpanded, setSigExpanded] = useState<Record<string, boolean>>({});
  const [approvalDetailCache, setApprovalDetailCache] = useState<Record<string, UserApprovalReceipt>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [arRes, tpRes, vrRes, rrRes, rRes] = await Promise.allSettled([
          listUserApprovalReceipts(),
          listWebsiteTrustProfiles(),
          listWebsiteViolationReceipts(),
          listRouteRunReceipts(),
          listReceipts(),
        ]);
        if (cancelled) return;
        if (arRes.status === "fulfilled") setApprovalReceipts(arRes.value);
        if (tpRes.status === "fulfilled") setTrustProfiles(tpRes.value);
        if (vrRes.status === "fulfilled") {
          const raw = vrRes.value;
          const normalized = Array.isArray(raw)
            ? raw
            : Array.isArray((raw as { receipts?: WebsiteViolationReceipt[] })?.receipts)
            ? (raw as { receipts: WebsiteViolationReceipt[] }).receipts
            : [];
          setViolationReceipts(normalized);
        }
        if (rrRes.status === "fulfilled") setRunReceipts(rrRes.value);
        if (rRes.status === "fulfilled") setReceipts(rRes.value);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function toggleExpand(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleSig(id: string) {
    setSigExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }

  async function showApprovalSig(id: string) {
    const nowExpanded = !sigExpanded[id];
    setSigExpanded(prev => ({ ...prev, [id]: nowExpanded }));
    if (nowExpanded && !approvalDetailCache[id]) {
      try {
        const detail = await getUserApprovalReceipt(id);
        setApprovalDetailCache(prev => ({ ...prev, [id]: detail }));
      } catch {
        // sigExpanded stays true; render shows "not available"
      }
    }
  }

  async function verifyApproval(id: string) {
    setVerifyStates(prev => ({ ...prev, [id]: { status: "loading" } }));
    try {
      const res = await verifyUserApprovalReceipt(id);
      setVerifyStates(prev => ({ ...prev, [id]: { status: "done", result: res } }));
    } catch {
      setVerifyStates(prev => ({
        ...prev,
        [id]: { status: "done", result: { valid: false, hash_valid: false, signature_valid: false, error: "FETCH_FAILED" } },
      }));
    }
  }

  async function verifyProfile(id: string) {
    setVerifyStates(prev => ({ ...prev, [id]: { status: "loading" } }));
    try {
      const res = await verifyWebsiteTrustProfile(id);
      setVerifyStates(prev => ({ ...prev, [id]: { status: "done", result: res } }));
    } catch {
      setVerifyStates(prev => ({
        ...prev,
        [id]: { status: "done", result: { valid: false, hash_valid: false, signature_valid: false, error: "FETCH_FAILED" } },
      }));
    }
  }

  async function verifyViolation(id: string) {
    setVerifyStates(prev => ({ ...prev, [id]: { status: "loading" } }));
    try {
      const res = await verifyWebsiteViolationReceipt(id);
      setVerifyStates(prev => ({ ...prev, [id]: { status: "done", result: res } }));
    } catch {
      setVerifyStates(prev => ({
        ...prev,
        [id]: { status: "done", result: { valid: false, hash_valid: false, signature_valid: false, error: "FETCH_FAILED" } },
      }));
    }
  }

  return (
    <div className="page">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div>
            <div className="a-eyebrow">Receipts</div>
            <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
              Proof,{" "}
              <span className="cmd-hero__title-mark">preserved.</span>
            </h1>
            <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
              Every sensitive decision and trust boundary leaves signed, verifiable proof.
            </p>
          </div>
          <div className="header-stats">
            <HeaderStat value={loading ? "—" : approvalReceipts.length} label="Signed approvals" />
            <HeaderStat value={loading ? "—" : trustProfiles.length} label="Trust profiles" />
            <HeaderStat value={loading ? "—" : violationReceipts.length} label="Violations" />
            <HeaderStat value={loading ? "—" : runReceipts.length} label="Route runs" />
          </div>
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>

        {/* Tabs */}
        <div className="ag-tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`ag-tab${activeTab === t.id ? " ag-tab--active" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Loading skeletons */}
        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2, 3].map(i => (
              <div
                key={i}
                style={{
                  height: 96,
                  borderRadius: "var(--r-3)",
                  background: "var(--graphite-soft)",
                  opacity: 0.5,
                }}
              />
            ))}
          </div>
        )}

        {!loading && (
          <>

            {/* ── User Approval Receipts ───────────────────────────────────── */}
            {activeTab === "approvals" && (
              approvalReceipts.length === 0 ? (
                <EmptyState
                  label="No user approval receipts yet."
                  hint="Receipts are created when you approve or deny an agent action request."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {approvalReceipts.map(r => {
                    const decisionVariant = DECISION_VARIANT[r.decision] ?? "graphite";
                    const cardBorder =
                      r.decision === "approved"
                        ? { borderColor: "var(--green-ring)" }
                        : r.decision === "denied"
                        ? { borderColor: "var(--red-ring)" }
                        : {};
                    return (
                      <div key={r.receipt_id} className="apr-card" style={cardBorder}>
                        <div className="apr-card__head">
                          <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <AStatus label={r.decision} variant={decisionVariant} />
                              <span className="a-status a-status--quiet">
                                {r.approval_source.replace(/_/g, " ")}
                              </span>
                              {r.risk_level && (
                                <AStatus
                                  label={r.risk_level}
                                  variant={SEVERITY_VARIANT[r.risk_level] ?? "graphite"}
                                />
                              )}
                            </div>
                            {r.action_type && (
                              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                                Action:{" "}
                                <span style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--ink-2)" }}>
                                  {r.action_type}
                                </span>
                              </p>
                            )}
                            {r.requested_action_summary && (
                              <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0 }}>
                                {r.requested_action_summary}
                              </p>
                            )}
                            {(r.target_domain || r.agent_name) && (
                              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                                {r.target_domain && <span>{r.target_domain}</span>}
                                {r.target_domain && r.agent_name && (
                                  <span style={{ margin: "0 6px", color: "var(--ink-4)" }}>·</span>
                                )}
                                {r.agent_name && (
                                  <span>
                                    {r.agent_name}
                                    {r.agent_platform ? ` · ${r.agent_platform}` : ""}
                                  </span>
                                )}
                              </p>
                            )}
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <time style={{ fontSize: 12, color: "var(--ink-4)", display: "block" }}>
                              {new Date(r.decided_at).toLocaleString()}
                            </time>
                            <div style={{ marginTop: 6 }}>
                              <SignedBadge jws_present={r.verification.jws_present} />
                            </div>
                          </div>
                        </div>

                        <div className="apr-card__body" style={{ gap: 10 }}>
                          <p
                            style={{
                              fontSize: 11.5,
                              color: "var(--ink-4)",
                              fontFamily: '"JetBrains Mono", monospace',
                              margin: 0,
                            }}
                          >
                            {r.receipt_id}
                          </p>
                          <VerifyRow
                            verifyState={verifyStates[r.receipt_id]}
                            onVerify={() => verifyApproval(r.receipt_id)}
                            onToggleExpand={() => toggleExpand(r.receipt_id)}
                            expandLabel="details"
                            isExpanded={!!expanded[r.receipt_id]}
                          />

                          {expanded[r.receipt_id] && (
                            <div className="apr-box">
                              <div className="apr-box__head">Verification details</div>
                              <MetaGrid>
                                {r.delegation_id && <MetaRow label="Delegation" value={r.delegation_id} mono />}
                                {r.collar_id && <MetaRow label="Collar" value={r.collar_id} mono />}
                                {r.approval_id && <MetaRow label="Approval" value={r.approval_id} mono />}
                                {r.route_run_id && <MetaRow label="Run" value={r.route_run_id} mono />}
                                <MetaRow label="Signing alg" value={r.verification.signing_alg} />
                                {r.verification.signed_at && (
                                  <MetaRow
                                    label="Signed at"
                                    value={new Date(r.verification.signed_at).toLocaleString()}
                                  />
                                )}
                                {r.verification.signing_key_id && (
                                  <MetaRow label="Key ID" value={r.verification.signing_key_id} mono />
                                )}
                                <MetaRow
                                  label="Payload hash"
                                  value={truncateHash(r.verification.canonical_payload_hash)}
                                  mono
                                />
                              </MetaGrid>
                              <p
                                style={{
                                  fontSize: 11,
                                  color: "var(--ink-4)",
                                  fontFamily: '"JetBrains Mono", monospace',
                                  margin: "10px 0 0",
                                }}
                              >
                                raw_secrets_in_receipt: false · raw_credentials_in_receipt: false
                              </p>
                              <SigToggle id={r.receipt_id} sigExpanded={sigExpanded} onToggle={showApprovalSig} />
                              {sigExpanded[r.receipt_id] && (
                                <div style={{ marginTop: 8 }}>
                                  <JwsBlock jws={approvalDetailCache[r.receipt_id]?.verification.jws} />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {/* ── Website Trust Profiles ───────────────────────────────────── */}
            {activeTab === "profiles" && (
              trustProfiles.length === 0 ? (
                <EmptyState
                  label="No website trust profiles yet."
                  hint="Trust profiles are signed promise snapshots created when a website registers with Antigen."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {trustProfiles.map(p => {
                    const cardBorder =
                      p.violation_count > 0
                        ? { borderColor: "var(--amber-ring)" }
                        : p.verification_status === "verified"
                        ? { borderColor: "var(--green-ring)" }
                        : {};
                    return (
                      <div key={p.profile_id} className="apr-card" style={cardBorder}>
                        <div className="apr-card__head">
                          <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)" }}>{p.domain}</span>
                              <AStatus
                                label={p.verification_status}
                                variant={TRUST_STATUS_VARIANT[p.verification_status] ?? "graphite"}
                              />
                              <AStatus
                                label={p.status}
                                variant={PROFILE_STATUS_VARIANT[p.status] ?? "graphite"}
                              />
                            </div>
                            <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0 }}>{p.company_name}</p>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                                {p.safety_promises.length} promises
                              </span>
                              {p.violation_count > 0 && (
                                <span style={{ fontSize: 12, color: "oklch(0.45 0.13 25)" }}>
                                  {p.violation_count} violations
                                </span>
                              )}
                              <SignedBadge jws_present={p.jws_present} />
                            </div>
                            <p
                              style={{
                                fontSize: 11.5,
                                color: "var(--ink-4)",
                                fontFamily: '"JetBrains Mono", monospace',
                                margin: 0,
                              }}
                            >
                              {truncateHash(p.profile_hash)}
                            </p>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <time style={{ fontSize: 12, color: "var(--ink-4)", display: "block" }}>
                              {new Date(p.created_at).toLocaleString()}
                            </time>
                            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>v{p.profile_version}</span>
                          </div>
                        </div>

                        <div className="apr-card__body" style={{ gap: 10 }}>
                          <VerifyRow
                            verifyState={verifyStates[p.profile_id]}
                            onVerify={() => verifyProfile(p.profile_id)}
                            onToggleExpand={() => toggleExpand(p.profile_id)}
                            expandLabel="promises"
                            isExpanded={!!expanded[p.profile_id]}
                          />

                          {expanded[p.profile_id] && (
                            <div className="apr-box">
                              <div className="apr-box__head">Safety Promises</div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                                {p.safety_promises.map(sp => (
                                  <div
                                    key={sp.promise_id}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "space-between",
                                      gap: 8,
                                    }}
                                  >
                                    <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{sp.title}</span>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                                      <AStatus
                                        label={sp.severity_if_violated}
                                        variant={SEVERITY_VARIANT[sp.severity_if_violated] ?? "graphite"}
                                      />
                                      <span
                                        style={{
                                          fontSize: 12,
                                          color: sp.committed ? "oklch(0.42 0.09 150)" : "var(--ink-4)",
                                        }}
                                      >
                                        {sp.committed ? "committed" : "not committed"}
                                      </span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <MetaGrid>
                                <MetaRow label="Profile ID" value={p.profile_id} mono />
                                {p.accountability_contact && (
                                  <MetaRow label="Contact" value={p.accountability_contact} />
                                )}
                                {p.policy_url && <MetaRow label="Policy URL" value={p.policy_url} />}
                                <MetaRow label="Full hash" value={p.profile_hash} mono />
                              </MetaGrid>
                              <SigToggle id={p.profile_id} sigExpanded={sigExpanded} onToggle={toggleSig} />
                              {sigExpanded[p.profile_id] && (
                                <div style={{ marginTop: 8 }}>
                                  <JwsBlock jws={p.profile_jws} />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {/* ── Website Violation Receipts ───────────────────────────────── */}
            {activeTab === "violations" && (
              violationReceipts.length === 0 ? (
                <EmptyState
                  label="No website violation receipts yet."
                  hint="Violation receipts are created when a website commits a breach of its signed safety promises."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {violationReceipts.map(v => {
                    const cardBorder =
                      v.severity === "critical" || v.severity === "high"
                        ? { borderColor: "var(--red-ring)" }
                        : v.severity === "medium"
                        ? { borderColor: "var(--amber-ring)" }
                        : {};
                    return (
                      <div key={v.receipt_id} className="apr-card" style={cardBorder}>
                        <div className="apr-card__head">
                          <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)" }}>{v.domain}</span>
                              <AStatus label={v.severity} variant={SEVERITY_VARIANT[v.severity] ?? "graphite"} />
                              <AStatus
                                label={v.decision.replace(/_/g, " ")}
                                variant={DECISION_VARIANT[v.decision] ?? "graphite"}
                              />
                            </div>
                            <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0 }}>
                              {v.violated_promise_title}
                            </p>
                            <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                              {v.violation_type.replace(/_/g, " ")}
                            </p>
                            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
                              Profile:{" "}
                              <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                                {truncateHash(v.profile_hash)}
                              </span>
                            </p>
                            <p
                              style={{
                                fontSize: 11.5,
                                color: "var(--ink-4)",
                                fontFamily: '"JetBrains Mono", monospace',
                                margin: 0,
                              }}
                            >
                              {v.receipt_id}
                            </p>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <time style={{ fontSize: 12, color: "var(--ink-4)", display: "block" }}>
                              {new Date(v.observed_at).toLocaleString()}
                            </time>
                            <div style={{ marginTop: 6 }}>
                              <SignedBadge jws_present={v.verification.jws_present} />
                            </div>
                          </div>
                        </div>

                        <div className="apr-card__body" style={{ gap: 10 }}>
                          <VerifyRow
                            verifyState={verifyStates[v.receipt_id]}
                            onVerify={() => verifyViolation(v.receipt_id)}
                            onToggleExpand={() => toggleExpand(v.receipt_id)}
                            expandLabel="evidence"
                            isExpanded={!!expanded[v.receipt_id]}
                          />

                          {expanded[v.receipt_id] && (
                            <div className="apr-box">
                              <div className="apr-box__head">Evidence</div>
                              <p
                                style={{
                                  fontSize: 12.5,
                                  color: "var(--ink-2)",
                                  margin: "0 0 12px",
                                  lineHeight: 1.5,
                                }}
                              >
                                {v.redacted_evidence_summary}
                              </p>
                              <MetaGrid>
                                <MetaRow
                                  label="Detection source"
                                  value={v.detection_source.replace(/_/g, " ")}
                                />
                                {v.target_url_or_origin && (
                                  <MetaRow label="Origin" value={v.target_url_or_origin} />
                                )}
                                {v.agent_name && <MetaRow label="Agent" value={v.agent_name} />}
                                {v.delegation_id && (
                                  <MetaRow label="Delegation" value={v.delegation_id} mono />
                                )}
                                {v.session_id && <MetaRow label="Session" value={v.session_id} mono />}
                                {v.detection_signals_count != null && (
                                  <MetaRow label="Signals" value={String(v.detection_signals_count)} />
                                )}
                                <MetaRow label="Followup required" value={String(v.followup_required)} />
                                <MetaRow
                                  label="Payload hash"
                                  value={truncateHash(v.verification.canonical_payload_hash)}
                                  mono
                                />
                                {v.verification.signed_at && (
                                  <MetaRow
                                    label="Signed at"
                                    value={new Date(v.verification.signed_at).toLocaleString()}
                                  />
                                )}
                                {v.verification.signing_key_id && (
                                  <MetaRow label="Key ID" value={v.verification.signing_key_id} mono />
                                )}
                              </MetaGrid>
                              <p
                                style={{
                                  fontSize: 11,
                                  color: "var(--ink-4)",
                                  fontFamily: '"JetBrains Mono", monospace',
                                  margin: "10px 0 0",
                                }}
                              >
                                raw_secrets_in_receipt: false · raw_credentials_in_receipt: false · raw_page_content_in_receipt: false
                              </p>
                              <SigToggle id={v.receipt_id} sigExpanded={sigExpanded} onToggle={toggleSig} />
                              {sigExpanded[v.receipt_id] && (
                                <div style={{ marginTop: 8 }}>
                                  <JwsBlock jws={v.verification.jws} />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {/* ── Route Run Receipts ───────────────────────────────────────── */}
            {activeTab === "runs" && (
              runReceipts.length === 0 ? (
                <EmptyState
                  label="No route run receipts yet."
                  hint="Receipts are created when an agent-requested skill run completes or fails."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {runReceipts.map(r => {
                    const statusVariant = RUN_STATUS_VARIANT[r.status] ?? "graphite";
                    const cardBorder = r.status === "failed" ? { borderColor: "var(--red-ring)" } : {};
                    return (
                      <div key={r.receipt_id} className="apr-card" style={cardBorder}>
                        <div className="apr-card__head">
                          <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)" }}>
                                {r.skill_name}
                              </span>
                              <AStatus label={r.status} variant={statusVariant} />
                              <span className="a-status a-status--quiet">
                                {r.route_trust_tier}
                              </span>
                            </div>
                            <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0 }}>{r.domain}</p>
                            {r.agent_id && (
                              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                                Agent:{" "}
                                <span
                                  style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--ink-2)" }}
                                >
                                  {r.agent_id}
                                </span>
                              </p>
                            )}
                            {r.variables && Object.keys(r.variables).length > 0 && (
                              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                                Variables:{" "}
                                <span
                                  style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--ink-2)" }}
                                >
                                  {Object.entries(r.variables)
                                    .map(([k, v]) => `${k}=${v}`)
                                    .join(", ")}
                                </span>
                              </p>
                            )}
                            {r.allowed_reason && (
                              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                                {r.allowed_reason}
                              </p>
                            )}
                            {r.error && (
                              <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>
                                Error: {r.error}
                              </p>
                            )}
                            <p
                              style={{
                                fontSize: 11.5,
                                color: "var(--ink-4)",
                                fontFamily: '"JetBrains Mono", monospace',
                                margin: 0,
                              }}
                            >
                              {r.receipt_id}
                            </p>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <time style={{ fontSize: 12, color: "var(--ink-4)", display: "block" }}>
                              {new Date(r.completed_at ?? r.created_at).toLocaleString()}
                            </time>
                            {r.execution_surface && (
                              <span style={{ fontSize: 11, color: "var(--ink-4)", display: "block", marginTop: 4 }}>
                                {r.execution_surface}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {/* ── Action Receipts ──────────────────────────────────────────── */}
            {activeTab === "actions" && (
              receipts.length === 0 ? (
                <EmptyState
                  label="No action receipts yet."
                  hint="Receipts appear when Antigen handles sensitive actions."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {receipts.map(receipt => {
                    const decisionVariant = DECISION_VARIANT[receipt.decision] ?? "graphite";
                    return (
                      <div key={receipt.id} className="apr-card">
                        <div className="apr-card__head">
                          <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span
                                style={{
                                  fontSize: 13.5,
                                  fontWeight: 600,
                                  color: "var(--ink-1)",
                                  fontFamily: '"JetBrains Mono", monospace',
                                }}
                              >
                                {receipt.action_type}
                              </span>
                              <AStatus
                                label={receipt.decision.replace(/_/g, " ")}
                                variant={decisionVariant}
                              />
                            </div>
                            {receipt.domain && (
                              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0 }}>{receipt.domain}</p>
                            )}
                            {receipt.reason && (
                              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                                {receipt.reason}
                              </p>
                            )}
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                                Outcome: {receipt.outcome}
                              </span>
                              {receipt.sensitive_data_shared_with_agent && (
                                <AStatus label="Sensitive data shared" variant="amber" />
                              )}
                            </div>
                          </div>
                          <time style={{ fontSize: 12, color: "var(--ink-4)", flexShrink: 0 }}>
                            {new Date(receipt.created_at).toLocaleString()}
                          </time>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

          </>
        )}
      </div>
    </div>
  );
}
