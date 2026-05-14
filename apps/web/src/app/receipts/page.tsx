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
  { id: "approvals", label: "User Approvals" },
  { id: "profiles", label: "Trust Profiles" },
  { id: "violations", label: "Violations" },
  { id: "runs", label: "Route Runs" },
  { id: "actions", label: "Actions" },
];

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-gray-800 text-gray-400",
  medium: "bg-yellow-900 text-yellow-400",
  high: "bg-orange-900 text-orange-400",
  critical: "bg-red-900 text-red-400",
};

const VIOLATION_DECISION_COLORS: Record<string, string> = {
  blocked: "bg-red-900 text-red-400",
  warned: "bg-yellow-900 text-yellow-400",
  escalated: "bg-orange-900 text-orange-400",
  reputation_penalized: "bg-purple-900 text-purple-400",
  recorded_only: "bg-gray-800 text-gray-400",
};

const APPROVAL_DECISION_COLORS: Record<string, string> = {
  approved: "bg-green-900 text-green-400",
  denied: "bg-red-900 text-red-400",
};

const TRUST_STATUS_COLORS: Record<string, string> = {
  verified: "bg-green-900 text-green-400",
  unverified: "bg-gray-800 text-gray-400",
  suspended: "bg-red-900 text-red-400",
};

const PROFILE_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-900 text-green-400",
  revoked: "bg-red-900 text-red-400",
  superseded: "bg-yellow-900 text-yellow-400",
};

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

function Pill({ label, color }: { label: string; color: string }) {
  return <span className={`text-xs px-2 py-0.5 rounded-full ${color}`}>{label}</span>;
}

function VerificationBadge({ state }: { state?: VerifyState }) {
  if (!state || state.status === "idle") {
    return <span className="text-xs text-gray-600">Not verified</span>;
  }
  if (state.status === "loading") {
    return <span className="text-xs text-gray-500 animate-pulse">Verifying…</span>;
  }
  const r = state.result!;
  if (r.error === "SIGNING_KEY_UNAVAILABLE") {
    return <Pill label="Dev mode" color="bg-yellow-900 text-yellow-400" />;
  }
  if (r.valid) return <Pill label="Valid" color="bg-green-900 text-green-400" />;
  if (r.hash_valid) return <Pill label="Unsigned" color="bg-yellow-900 text-yellow-400" />;
  return <Pill label="Invalid" color="bg-red-900 text-red-400" />;
}

function EmptyState({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
      <p className="text-sm font-medium text-gray-400">{label}</p>
      <p className="text-xs text-gray-600 mt-1">{hint}</p>
    </div>
  );
}

function truncateHash(hash: string) {
  return hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

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
        if (vrRes.status === "fulfilled") setViolationReceipts(vrRes.value.receipts);
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
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Receipts</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Liability-grade records — user approvals, website promises, and violation evidence.
        </p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-gray-800">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm rounded-t-md transition-colors ${
              activeTab === t.id
                ? "text-white bg-gray-900 border border-b-0 border-gray-800"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading…</p>}

      {!loading && (
        <>
          {/* ── User Approval Receipts ── */}
          {activeTab === "approvals" && (
            <>
              {approvalReceipts.length === 0 ? (
                <EmptyState
                  label="No user approval receipts yet."
                  hint="Receipts are created when you approve or deny an agent action request."
                />
              ) : (
                <div className="space-y-3">
                  {approvalReceipts.map(r => (
                    <div key={r.receipt_id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Pill
                              label={r.decision}
                              color={APPROVAL_DECISION_COLORS[r.decision] ?? "bg-gray-800 text-gray-400"}
                            />
                            <Pill
                              label={r.approval_source.replace(/_/g, " ")}
                              color="bg-gray-800 text-gray-400"
                            />
                            {r.risk_level && (
                              <Pill
                                label={r.risk_level}
                                color={SEVERITY_COLORS[r.risk_level] ?? "bg-gray-800 text-gray-400"}
                              />
                            )}
                          </div>
                          {r.action_type && (
                            <p className="text-xs text-gray-400 mt-1">
                              Action: <span className="font-mono">{r.action_type}</span>
                            </p>
                          )}
                          {r.requested_action_summary && (
                            <p className="text-xs text-gray-500 mt-0.5">{r.requested_action_summary}</p>
                          )}
                          {r.target_domain && (
                            <p className="text-xs text-gray-500 mt-0.5">Domain: {r.target_domain}</p>
                          )}
                          {r.agent_name && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              Agent: {r.agent_name}
                              {r.agent_platform ? ` · ${r.agent_platform}` : ""}
                            </p>
                          )}
                          <p className="text-xs text-gray-700 mt-2 font-mono">{r.receipt_id}</p>
                          <div className="flex items-center gap-2 mt-2">
                            <VerificationBadge state={verifyStates[r.receipt_id]} />
                            <button
                              onClick={() => verifyApproval(r.receipt_id)}
                              disabled={verifyStates[r.receipt_id]?.status === "loading"}
                              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                            >
                              Verify
                            </button>
                            <button
                              onClick={() => toggleExpand(r.receipt_id)}
                              className="text-xs text-gray-500 hover:text-gray-300"
                            >
                              {expanded[r.receipt_id] ? "Hide details" : "View details"}
                            </button>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <time className="text-xs text-gray-600 block">
                            {new Date(r.decided_at).toLocaleString()}
                          </time>
                          <span
                            className={`text-xs mt-1 block ${
                              r.verification.jws_present ? "text-green-700" : "text-gray-700"
                            }`}
                          >
                            {r.verification.jws_present ? "signed" : "unsigned"}
                          </span>
                        </div>
                      </div>

                      {expanded[r.receipt_id] && (
                        <div className="mt-3 pt-3 border-t border-gray-800">
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                            {r.delegation_id && (
                              <>
                                <span className="text-gray-500">Delegation</span>
                                <span className="text-gray-400 font-mono truncate">{r.delegation_id}</span>
                              </>
                            )}
                            {r.collar_id && (
                              <>
                                <span className="text-gray-500">Collar</span>
                                <span className="text-gray-400 font-mono truncate">{r.collar_id}</span>
                              </>
                            )}
                            {r.approval_id && (
                              <>
                                <span className="text-gray-500">Approval</span>
                                <span className="text-gray-400 font-mono truncate">{r.approval_id}</span>
                              </>
                            )}
                            {r.route_run_id && (
                              <>
                                <span className="text-gray-500">Run</span>
                                <span className="text-gray-400 font-mono truncate">{r.route_run_id}</span>
                              </>
                            )}
                            <span className="text-gray-500">Signing alg</span>
                            <span className="text-gray-400">{r.verification.signing_alg}</span>
                            {r.verification.signed_at && (
                              <>
                                <span className="text-gray-500">Signed at</span>
                                <span className="text-gray-400">
                                  {new Date(r.verification.signed_at).toLocaleString()}
                                </span>
                              </>
                            )}
                            {r.verification.signing_key_id && (
                              <>
                                <span className="text-gray-500">Key ID</span>
                                <span className="text-gray-400 font-mono">{r.verification.signing_key_id}</span>
                              </>
                            )}
                            <span className="text-gray-500">Payload hash</span>
                            <span className="text-gray-400 font-mono">
                              {truncateHash(r.verification.canonical_payload_hash)}
                            </span>
                          </div>
                          <p className="text-xs text-gray-700 mt-2">
                            raw_secrets_in_receipt: false · raw_credentials_in_receipt: false
                          </p>
                          <button
                            onClick={() => showApprovalSig(r.receipt_id)}
                            className="text-xs text-gray-600 hover:text-gray-400 mt-2"
                          >
                            {sigExpanded[r.receipt_id] ? "Hide signature" : "Show signature"}
                          </button>
                          {sigExpanded[r.receipt_id] && (
                            <div className="mt-2">
                              {approvalDetailCache[r.receipt_id]?.verification.jws ? (
                                <pre className="text-xs text-gray-500 bg-gray-950 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                                  {approvalDetailCache[r.receipt_id].verification.jws}
                                </pre>
                              ) : (
                                <p className="text-xs text-gray-600">Signature not available.</p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Website Trust Profiles ── */}
          {activeTab === "profiles" && (
            <>
              {trustProfiles.length === 0 ? (
                <EmptyState
                  label="No website trust profiles yet."
                  hint="Trust profiles are signed promise snapshots created when a website registers with Aegis."
                />
              ) : (
                <div className="space-y-3">
                  {trustProfiles.map(p => (
                    <div key={p.profile_id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-sm font-medium text-white">{p.domain}</span>
                            <Pill
                              label={p.verification_status}
                              color={TRUST_STATUS_COLORS[p.verification_status] ?? "bg-gray-800 text-gray-400"}
                            />
                            <Pill
                              label={p.status}
                              color={PROFILE_STATUS_COLORS[p.status] ?? "bg-gray-800 text-gray-400"}
                            />
                          </div>
                          <p className="text-xs text-gray-400">{p.company_name}</p>
                          <div className="flex items-center gap-3 mt-1 text-xs">
                            <span className="text-gray-500">{p.safety_promises.length} promises</span>
                            {p.violation_count > 0 && (
                              <span className="text-red-500">{p.violation_count} violations</span>
                            )}
                            <span className={p.jws_present ? "text-green-700" : "text-gray-600"}>
                              {p.jws_present ? "signed" : "unsigned"}
                            </span>
                          </div>
                          <p className="text-xs text-gray-700 mt-1 font-mono">
                            {truncateHash(p.profile_hash)}
                          </p>
                          <div className="flex items-center gap-2 mt-2">
                            <VerificationBadge state={verifyStates[p.profile_id]} />
                            <button
                              onClick={() => verifyProfile(p.profile_id)}
                              disabled={verifyStates[p.profile_id]?.status === "loading"}
                              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                            >
                              Verify
                            </button>
                            <button
                              onClick={() => toggleExpand(p.profile_id)}
                              className="text-xs text-gray-500 hover:text-gray-300"
                            >
                              {expanded[p.profile_id] ? "Hide promises" : "View promises"}
                            </button>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <time className="text-xs text-gray-600 block">
                            {new Date(p.created_at).toLocaleString()}
                          </time>
                          <span className="text-xs text-gray-700">v{p.profile_version}</span>
                        </div>
                      </div>

                      {expanded[p.profile_id] && (
                        <div className="mt-3 pt-3 border-t border-gray-800">
                          <p className="text-xs text-gray-500 mb-2">Safety Promises</p>
                          <div className="space-y-1.5">
                            {p.safety_promises.map(sp => (
                              <div key={sp.promise_id} className="flex items-center justify-between gap-2">
                                <span className="text-xs text-gray-400">{sp.title}</span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <Pill
                                    label={sp.severity_if_violated}
                                    color={SEVERITY_COLORS[sp.severity_if_violated] ?? "bg-gray-800 text-gray-400"}
                                  />
                                  {sp.committed ? (
                                    <span className="text-xs text-green-700">committed</span>
                                  ) : (
                                    <span className="text-xs text-gray-600">not committed</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-3">
                            <span className="text-gray-500">Profile ID</span>
                            <span className="text-gray-400 font-mono">{p.profile_id}</span>
                            {p.accountability_contact && (
                              <>
                                <span className="text-gray-500">Contact</span>
                                <span className="text-gray-400">{p.accountability_contact}</span>
                              </>
                            )}
                            {p.policy_url && (
                              <>
                                <span className="text-gray-500">Policy URL</span>
                                <span className="text-gray-400 truncate">{p.policy_url}</span>
                              </>
                            )}
                            <span className="text-gray-500">Full hash</span>
                            <span className="text-gray-400 font-mono break-all">{p.profile_hash}</span>
                          </div>
                          <button
                            onClick={() => toggleSig(p.profile_id)}
                            className="text-xs text-gray-600 hover:text-gray-400 mt-3"
                          >
                            {sigExpanded[p.profile_id] ? "Hide signature" : "Show signature"}
                          </button>
                          {sigExpanded[p.profile_id] && (
                            <div className="mt-2">
                              {p.profile_jws ? (
                                <pre className="text-xs text-gray-500 bg-gray-950 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                                  {p.profile_jws}
                                </pre>
                              ) : (
                                <p className="text-xs text-gray-600">No signature available.</p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Website Violation Receipts ── */}
          {activeTab === "violations" && (
            <>
              {violationReceipts.length === 0 ? (
                <EmptyState
                  label="No website violation receipts yet."
                  hint="Violation receipts are created when a website commits a breach of its signed safety promises."
                />
              ) : (
                <div className="space-y-3">
                  {violationReceipts.map(v => (
                    <div key={v.receipt_id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-sm font-medium text-white">{v.domain}</span>
                            <Pill
                              label={v.severity}
                              color={SEVERITY_COLORS[v.severity] ?? "bg-gray-800 text-gray-400"}
                            />
                            <Pill
                              label={v.decision.replace(/_/g, " ")}
                              color={VIOLATION_DECISION_COLORS[v.decision] ?? "bg-gray-800 text-gray-400"}
                            />
                          </div>
                          <p className="text-xs text-gray-400">{v.violated_promise_title}</p>
                          <p className="text-xs text-gray-600 mt-0.5">
                            {v.violation_type.replace(/_/g, " ")}
                          </p>
                          <p className="text-xs text-gray-700 mt-1">
                            Profile: <span className="font-mono">{truncateHash(v.profile_hash)}</span>
                          </p>
                          <p className="text-xs text-gray-700 mt-0.5 font-mono">{v.receipt_id}</p>
                          <div className="flex items-center gap-2 mt-2">
                            <VerificationBadge state={verifyStates[v.receipt_id]} />
                            <button
                              onClick={() => verifyViolation(v.receipt_id)}
                              disabled={verifyStates[v.receipt_id]?.status === "loading"}
                              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                            >
                              Verify
                            </button>
                            <button
                              onClick={() => toggleExpand(v.receipt_id)}
                              className="text-xs text-gray-500 hover:text-gray-300"
                            >
                              {expanded[v.receipt_id] ? "Hide evidence" : "View evidence"}
                            </button>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <time className="text-xs text-gray-600 block">
                            {new Date(v.observed_at).toLocaleString()}
                          </time>
                          <span
                            className={`text-xs mt-1 block ${
                              v.verification.jws_present ? "text-green-700" : "text-gray-700"
                            }`}
                          >
                            {v.verification.jws_present ? "signed" : "unsigned"}
                          </span>
                        </div>
                      </div>

                      {expanded[v.receipt_id] && (
                        <div className="mt-3 pt-3 border-t border-gray-800">
                          <p className="text-xs text-gray-500 mb-1">Evidence summary</p>
                          <p className="text-xs text-gray-400 mb-2">{v.redacted_evidence_summary}</p>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                            <span className="text-gray-500">Detection source</span>
                            <span className="text-gray-400">{v.detection_source.replace(/_/g, " ")}</span>
                            {v.target_url_or_origin && (
                              <>
                                <span className="text-gray-500">Origin</span>
                                <span className="text-gray-400 truncate">{v.target_url_or_origin}</span>
                              </>
                            )}
                            {v.agent_name && (
                              <>
                                <span className="text-gray-500">Agent</span>
                                <span className="text-gray-400">{v.agent_name}</span>
                              </>
                            )}
                            {v.delegation_id && (
                              <>
                                <span className="text-gray-500">Delegation</span>
                                <span className="text-gray-400 font-mono truncate">{v.delegation_id}</span>
                              </>
                            )}
                            {v.session_id && (
                              <>
                                <span className="text-gray-500">Session</span>
                                <span className="text-gray-400 font-mono truncate">{v.session_id}</span>
                              </>
                            )}
                            {v.detection_signals_count != null && (
                              <>
                                <span className="text-gray-500">Signals</span>
                                <span className="text-gray-400">{v.detection_signals_count}</span>
                              </>
                            )}
                            <span className="text-gray-500">Followup required</span>
                            <span className={v.followup_required ? "text-yellow-400" : "text-gray-400"}>
                              {String(v.followup_required)}
                            </span>
                            <span className="text-gray-500">Payload hash</span>
                            <span className="text-gray-400 font-mono">
                              {truncateHash(v.verification.canonical_payload_hash)}
                            </span>
                            {v.verification.signed_at && (
                              <>
                                <span className="text-gray-500">Signed at</span>
                                <span className="text-gray-400">
                                  {new Date(v.verification.signed_at).toLocaleString()}
                                </span>
                              </>
                            )}
                            {v.verification.signing_key_id && (
                              <>
                                <span className="text-gray-500">Key ID</span>
                                <span className="text-gray-400 font-mono">{v.verification.signing_key_id}</span>
                              </>
                            )}
                          </div>
                          <p className="text-xs text-gray-700 mt-2">
                            raw_secrets_in_receipt: false · raw_credentials_in_receipt: false · raw_page_content_in_receipt: false
                          </p>
                          <button
                            onClick={() => toggleSig(v.receipt_id)}
                            className="text-xs text-gray-600 hover:text-gray-400 mt-2"
                          >
                            {sigExpanded[v.receipt_id] ? "Hide signature" : "Show signature"}
                          </button>
                          {sigExpanded[v.receipt_id] && (
                            <div className="mt-2">
                              {v.verification.jws ? (
                                <pre className="text-xs text-gray-500 bg-gray-950 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                                  {v.verification.jws}
                                </pre>
                              ) : (
                                <p className="text-xs text-gray-600">No signature available.</p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Route Run Receipts ── */}
          {activeTab === "runs" && (
            <>
              {runReceipts.length === 0 ? (
                <EmptyState
                  label="No route run receipts yet."
                  hint="Receipts are created when an agent-requested skill run completes or fails."
                />
              ) : (
                <div className="space-y-3">
                  {runReceipts.map(r => (
                    <div key={r.receipt_id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-sm font-medium text-white">{r.skill_name}</span>
                            <Pill
                              label={r.status}
                              color={RUN_STATUS_COLORS[r.status] ?? "bg-gray-800 text-gray-400"}
                            />
                            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
                              {r.route_trust_tier}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mb-1">{r.domain}</p>
                          {r.agent_id && (
                            <p className="text-xs text-gray-500">
                              Agent: <span className="font-mono text-gray-400">{r.agent_id}</span>
                            </p>
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
            </>
          )}

          {/* ── Action Receipts ── */}
          {activeTab === "actions" && (
            <>
              {receipts.length === 0 ? (
                <EmptyState
                  label="No action receipts yet."
                  hint="Receipts appear when Aegis handles sensitive actions."
                />
              ) : (
                <div className="space-y-3">
                  {receipts.map(receipt => (
                    <div key={receipt.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-white font-mono">
                              {receipt.action_type}
                            </span>
                            <Pill
                              label={receipt.decision.replace(/_/g, " ")}
                              color={DECISION_COLORS[receipt.decision] ?? "bg-gray-800 text-gray-400"}
                            />
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
            </>
          )}
        </>
      )}
    </div>
  );
}
