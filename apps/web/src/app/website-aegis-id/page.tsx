"use client";

import { useEffect, useState } from "react";
import type {
  WebsiteAegisIDTrustClaims,
  WebsiteTrustProfile,
  WebsiteViolationReceipt,
  WebsiteTrustProfileVerificationResult,
} from "@aegis/types";
import {
  getWebsiteTrustClaims,
  listWebsiteTrustClaims,
  listWebsiteTrustProfiles,
  listWebsiteViolationReceipts,
  verifyWebsiteTrustProfile,
} from "@/lib/api";
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

// ── Types ──────────────────────────────────────────────────────────────────────
type VerifyState = { status: "idle" | "loading" | "done"; result?: WebsiteTrustProfileVerificationResult };

// ── Helpers ────────────────────────────────────────────────────────────────────
function truncateHash(hash: string) {
  return hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TRUST_STATUS_LABEL: Record<string, string> = {
  verified_demo_business: "Verified",
  flagged: "Flagged",
  unverified: "Unverified",
};

const ACTION_LABEL: Record<string, string> = {
  allow_normal_browsing: "Normal browsing allowed",
  require_extra_approval: "Approval required",
  block_sensitive_actions: "Blocked",
};

// ── Color helpers ──────────────────────────────────────────────────────────────
function trustStatusColor(status: string): string {
  if (status === "flagged") return "oklch(0.45 0.13 25)";
  return "var(--ink-2)";
}

function actionColor(action: string): string {
  if (action === "block_sensitive_actions") return "oklch(0.45 0.13 25)";
  if (action === "require_extra_approval") return "oklch(0.45 0.12 75)";
  return "var(--ink-2)";
}

function profileStatusColor(status: string): string {
  if (status === "suspended" || status === "revoked") return "oklch(0.45 0.13 25)";
  if (status === "superseded") return "oklch(0.45 0.12 75)";
  return "var(--ink-3)";
}

function severityColor(severity: string): string {
  if (severity === "critical" || severity === "high") return "oklch(0.45 0.13 25)";
  if (severity === "medium") return "oklch(0.45 0.12 75)";
  return "var(--ink-4)";
}

// ── Primitives ─────────────────────────────────────────────────────────────────
function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

function EmptyState({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="a-card" style={{ textAlign: "center", padding: "48px 24px" }}>
      <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>{label}</p>
      <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>{hint}</p>
    </div>
  );
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
  if (r.error === "SIGNING_KEY_UNAVAILABLE")
    return <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Dev mode</span>;
  if (r.valid)
    return <span style={{ fontSize: 11.5, color: "oklch(0.42 0.09 150)", fontWeight: 500 }}>Valid</span>;
  if (r.hash_valid)
    return <span style={{ fontSize: 11.5, color: "oklch(0.45 0.12 75)", fontWeight: 500 }}>Unsigned</span>;
  return <span style={{ fontSize: 11.5, color: "oklch(0.45 0.13 25)", fontWeight: 500 }}>Invalid</span>;
}

function BoolDisplay({ value }: { value: boolean }) {
  return <span style={{ fontSize: 12.5, color: "var(--ink-2)", fontWeight: 500 }}>{value ? "Yes" : "No"}</span>;
}

function CountDisplay({ n, warningAbove }: { n: number; warningAbove?: number }) {
  const isWarning = warningAbove !== undefined && n > warningAbove;
  return (
    <span
      style={{
        fontSize: 12.5,
        fontWeight: 600,
        color: isWarning ? "oklch(0.45 0.13 25)" : n > 0 ? "var(--ink-2)" : "var(--ink-4)",
      }}
    >
      {n}
    </span>
  );
}

function ClaimRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 0",
        borderBottom: "1px solid var(--hairline)",
      }}
    >
      <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{label}</span>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function WebsiteAegisIDPage() {
  const [query, setQuery] = useState("localhost");
  const [inputValue, setInputValue] = useState("localhost");
  const [claims, setClaims] = useState<WebsiteAegisIDTrustClaims | null>(null);
  const [loadingClaims, setLoadingClaims] = useState(true);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [list, setList] = useState<WebsiteAegisIDTrustClaims[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [trustProfiles, setTrustProfiles] = useState<WebsiteTrustProfile[]>([]);
  const [violationReceipts, setViolationReceipts] = useState<WebsiteViolationReceipt[]>([]);
  const [loadingGlobal, setLoadingGlobal] = useState(true);
  const [profileVerifyStates, setProfileVerifyStates] = useState<Record<string, VerifyState>>({});
  const [expandedPromises, setExpandedPromises] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setLoadingClaims(true);
    setClaimsError(null);
    getWebsiteTrustClaims(query)
      .then(setClaims)
      .catch((e) => setClaimsError(e.message))
      .finally(() => setLoadingClaims(false));
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [listRes, profilesRes, violationsRes] = await Promise.allSettled([
          listWebsiteTrustClaims(),
          listWebsiteTrustProfiles(),
          listWebsiteViolationReceipts(),
        ]);
        if (cancelled) return;
        if (listRes.status === "fulfilled") setList(listRes.value);
        if (profilesRes.status === "fulfilled") setTrustProfiles(profilesRes.value);
        if (violationsRes.status === "fulfilled") {
          const raw = violationsRes.value;
          const normalized: WebsiteViolationReceipt[] = Array.isArray(raw)
            ? raw
            : Array.isArray((raw as { receipts?: WebsiteViolationReceipt[] })?.receipts)
            ? (raw as { receipts: WebsiteViolationReceipt[] }).receipts
            : [];
          setViolationReceipts(normalized);
        }
      } finally {
        if (!cancelled) {
          setLoadingList(false);
          setLoadingGlobal(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setQuery(inputValue.trim() || "localhost");
  }

  async function verifyProfile(id: string) {
    setProfileVerifyStates((prev) => ({ ...prev, [id]: { status: "loading" } }));
    try {
      const res = await verifyWebsiteTrustProfile(id);
      setProfileVerifyStates((prev) => ({ ...prev, [id]: { status: "done", result: res } }));
    } catch {
      setProfileVerifyStates((prev) => ({
        ...prev,
        [id]: {
          status: "done",
          result: { profile_id: id, valid: false, hash_valid: false, signature_valid: false, error: "FETCH_FAILED" },
        },
      }));
    }
  }

  function togglePromises(id: string) {
    setExpandedPromises((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const matchedProfile = trustProfiles.find((p) => p.domain === claims?.domain);
  const domainViolationCount = violationReceipts.filter((r) => r.domain === claims?.domain).length;
  const verifiedCount = trustProfiles.filter((p) => p.verification_status === "verified").length;

  return (
    <div className="page">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div>
            <div className="a-eyebrow">Websites</div>
            <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
              Websites,{" "}
              <span className="cmd-hero__title-mark">verified.</span>
            </h1>
            <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
              See which domains are agent-ready, which require approval, and which have broken trust promises.
            </p>
          </div>
          <div className="header-stats">
            <HeaderStat value={loadingGlobal ? "—" : verifiedCount} label="Verified profiles" />
            <HeaderStat value={loadingGlobal ? "—" : violationReceipts.length} label="Violation receipts" />
            <HeaderStat value={loadingList ? "—" : list.length} label="Known identities" />
          </div>
        </div>
      </SpotlightHeroCard>

      <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 720 }}>

        {/* ── Domain lookup ─────────────────────────────────────────────── */}
        <div className="a-card" style={{ padding: "20px 24px" }}>
          <form onSubmit={handleSearch} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label className="ag-label" htmlFor="domain-input">
                Domain lookup
              </label>
              <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "2px 0 0" }}>
                Look up a domain&apos;s trust claims, safety promises, and violation history.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="domain-input"
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Search a domain… e.g. localhost, bad-store.local"
                className="ag-input"
                style={{ flex: 1 }}
              />
              <button type="submit" className="a-btn a-btn--primary">
                Look up
              </button>
            </div>
          </form>
        </div>

        {/* ── Lookup result ─────────────────────────────────────────────── */}
        {loadingClaims && (
          <div
            style={{
              height: 120,
              borderRadius: "var(--r-3)",
              background: "var(--graphite-soft)",
              opacity: 0.5,
            }}
          />
        )}

        {claimsError && !loadingClaims && (
          <div
            style={{
              padding: "14px 18px",
              borderRadius: "var(--r-2)",
              background: "var(--amber-soft)",
              border: "1px solid var(--amber-ring)",
            }}
          >
            <p style={{ fontSize: 12.5, color: "oklch(0.45 0.12 75)", margin: 0 }}>
              Could not load trust claims for <strong>{query}</strong>: {claimsError}
            </p>
          </div>
        )}

        {claims && !loadingClaims && (
          <div className="apr-card">
            {/* Domain header — structured two-column layout */}
            <div className="apr-card__head">
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)" }}>{claims.domain}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{claims.business_name}</span>
                <div style={{ display: "flex", gap: 20, marginTop: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                    Status:{" "}
                    <span style={{ color: trustStatusColor(claims.trust_status), fontWeight: 500 }}>
                      {TRUST_STATUS_LABEL[claims.trust_status] ?? claims.trust_status}
                    </span>
                  </span>
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                    Browsing:{" "}
                    <span style={{ color: actionColor(claims.recommended_agent_action), fontWeight: 500 }}>
                      {ACTION_LABEL[claims.recommended_agent_action] ?? claims.recommended_agent_action}
                    </span>
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--ink-4)",
                    fontFamily: '"JetBrains Mono", monospace',
                    margin: "4px 0 0",
                  }}
                >
                  {claims.website_aegis_id}
                </p>
              </div>
              <time style={{ fontSize: 12, color: "var(--ink-4)", flexShrink: 0, textAlign: "right" }}>
                Updated{" "}
                {new Date(claims.last_updated).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </time>
            </div>

            <div className="apr-card__body" style={{ gap: 0 }}>
              <div className="apr-box">
                <div className="apr-box__head">Trust Claims</div>
                <ClaimRow label="Business Name">
                  <span style={{ fontSize: 12.5, color: "var(--ink-2)", fontWeight: 500 }}>
                    {claims.business_name}
                  </span>
                </ClaimRow>
                <ClaimRow label="Domain Verified">
                  <BoolDisplay value={claims.domain_verified} />
                </ClaimRow>
                <ClaimRow label="Agent Policy Published">
                  <BoolDisplay value={claims.agent_policy_published} />
                </ClaimRow>
                <ClaimRow label="Successful Runner Transactions">
                  <CountDisplay n={claims.successful_runner_transactions} />
                </ClaimRow>
                <ClaimRow label="Blocked / Disputed Actions">
                  <CountDisplay n={claims.blocked_or_disputed_actions} warningAbove={0} />
                </ClaimRow>
                <ClaimRow label="Prompt Injection Reports">
                  <CountDisplay n={claims.prompt_injection_reports} warningAbove={0} />
                </ClaimRow>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "10px 0",
                  }}
                >
                  <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                    Violation Receipts (this domain)
                  </span>
                  <CountDisplay n={domainViolationCount} warningAbove={0} />
                </div>
              </div>

              {/* Matching trust profile for this domain */}
              {matchedProfile && (
                <div className="apr-box" style={{ marginTop: 12 }}>
                  <div className="apr-box__head">Trust Profile</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, color: profileStatusColor(matchedProfile.verification_status) }}>
                        {capitalize(matchedProfile.verification_status)}
                      </span>
                      {matchedProfile.status !== "active" && (
                        <span style={{ fontSize: 12, color: profileStatusColor(matchedProfile.status) }}>
                          {capitalize(matchedProfile.status)}
                        </span>
                      )}
                      <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                        {matchedProfile.safety_promises.length} promises
                      </span>
                      {matchedProfile.violation_count > 0 && (
                        <span style={{ fontSize: 12, color: "oklch(0.45 0.13 25)" }}>
                          {matchedProfile.violation_count} violations
                        </span>
                      )}
                    </div>
                    <p
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-4)",
                        fontFamily: '"JetBrains Mono", monospace',
                        margin: 0,
                      }}
                    >
                      {truncateHash(matchedProfile.profile_hash)}
                    </p>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <VerificationBadge state={profileVerifyStates[matchedProfile.profile_id]} />
                      <button
                        onClick={() => verifyProfile(matchedProfile.profile_id)}
                        disabled={profileVerifyStates[matchedProfile.profile_id]?.status === "loading"}
                        className="a-btn a-btn--ghost"
                        style={{ fontSize: 12, padding: "4px 10px" }}
                      >
                        Verify
                      </button>
                      <button
                        onClick={() => togglePromises(matchedProfile.profile_id)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 12,
                          color: "var(--blue)",
                          padding: 0,
                        }}
                      >
                        {expandedPromises[matchedProfile.profile_id] ? "Hide promises" : "View promises"}
                      </button>
                    </div>
                    {expandedPromises[matchedProfile.profile_id] && matchedProfile.safety_promises.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {matchedProfile.safety_promises.map((sp) => (
                          <div
                            key={sp.promise_id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 8,
                              padding: "6px 0",
                              borderBottom: "1px solid var(--hairline)",
                            }}
                          >
                            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{sp.title}</span>
                            <span
                              style={{
                                fontSize: 11.5,
                                fontWeight: 500,
                                color: severityColor(sp.severity_if_violated),
                                flexShrink: 0,
                              }}
                            >
                              {capitalize(sp.severity_if_violated)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Trust Profiles ────────────────────────────────────────────── */}
        {!loadingGlobal && trustProfiles.length > 0 && (
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 12 }}>Trust Profiles</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {trustProfiles.map((p) => {
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
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)" }}>
                            {p.domain}
                          </span>
                          <span style={{ fontSize: 12, color: profileStatusColor(p.verification_status) }}>
                            {capitalize(p.verification_status)}
                          </span>
                          {p.status !== "active" && (
                            <span style={{ fontSize: 12, color: profileStatusColor(p.status) }}>
                              {capitalize(p.status)}
                            </span>
                          )}
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
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <VerificationBadge state={profileVerifyStates[p.profile_id]} />
                        <button
                          onClick={() => verifyProfile(p.profile_id)}
                          disabled={profileVerifyStates[p.profile_id]?.status === "loading"}
                          className="a-btn a-btn--ghost"
                          style={{ fontSize: 12, padding: "4px 10px" }}
                        >
                          Verify
                        </button>
                        <button
                          onClick={() => togglePromises(p.profile_id)}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: 12,
                            color: "var(--blue)",
                            padding: 0,
                          }}
                        >
                          {expandedPromises[p.profile_id] ? "Hide promises" : "View promises"}
                        </button>
                      </div>
                      {expandedPromises[p.profile_id] && (
                        <div className="apr-box">
                          <div className="apr-box__head">Safety Promises</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                            {p.safety_promises.map((sp) => (
                              <div
                                key={sp.promise_id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 8,
                                  padding: "7px 0",
                                  borderBottom: "1px solid var(--hairline)",
                                }}
                              >
                                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{sp.title}</span>
                                <span
                                  style={{
                                    fontSize: 11.5,
                                    fontWeight: 500,
                                    color: severityColor(sp.severity_if_violated),
                                    flexShrink: 0,
                                  }}
                                >
                                  {capitalize(sp.severity_if_violated)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Known Website Identities ───────────────────────────────────── */}
        <div>
          <div className="a-eyebrow" style={{ marginBottom: 12 }}>Known Identities</div>
          {loadingList && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    height: 64,
                    borderRadius: "var(--r-2)",
                    background: "var(--graphite-soft)",
                    opacity: 0.5,
                  }}
                />
              ))}
            </div>
          )}
          {!loadingList && list.length === 0 && (
            <EmptyState
              label="No known website identities yet."
              hint="Website identities are created when a domain registers with Antigen or is seeded locally."
            />
          )}
          {!loadingList && list.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((item) => (
                <button
                  key={item.domain}
                  onClick={() => {
                    setInputValue(item.domain);
                    setQuery(item.domain);
                  }}
                  style={{
                    all: "unset",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "14px 16px",
                    borderRadius: "var(--r-2)",
                    border: "1px solid var(--hairline)",
                    borderLeft: item.trust_status === "flagged"
                      ? "2px solid oklch(0.65 0.15 25)"
                      : "2px solid transparent",
                    background: "var(--paper)",
                    cursor: "pointer",
                    transition: "border-color 120ms",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--hairline-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--hairline)")}
                >
                  <div
                    className="ag-avatar"
                    style={{ fontWeight: 600, fontSize: 13, color: "var(--ink-2)", flexShrink: 0 }}
                  >
                    {item.domain.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: "var(--ink-1)",
                        margin: 0,
                        lineHeight: 1.3,
                      }}
                    >
                      {item.domain}
                    </p>
                    <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "2px 0 0" }}>
                      {item.business_name}
                    </p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                    <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                      {item.successful_runner_transactions} transactions
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: item.trust_status === "flagged" ? "oklch(0.45 0.13 25)" : "var(--ink-3)",
                        fontWeight: item.trust_status === "flagged" ? 500 : 400,
                      }}
                    >
                      {TRUST_STATUS_LABEL[item.trust_status] ?? item.trust_status}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Demo disclaimer */}
        <div
          style={{
            padding: "14px 18px",
            borderRadius: "var(--r-2)",
            background: "var(--graphite-soft)",
            border: "1px solid var(--hairline)",
          }}
        >
          <p style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Demo data
          </p>
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
            Local and demo only — this is not real domain verification, real business verification,
            or a public reputation score. Trust records are seeded locally for demo purposes.
          </p>
        </div>

      </div>
    </div>
  );
}
