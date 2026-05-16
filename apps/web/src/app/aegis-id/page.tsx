"use client";

import { useEffect, useState } from "react";
import type { AegisIDTrustClaims } from "@aegis/types";
import { getAegisIDTrustClaims } from "@/lib/api";

// ── Primitives ─────────────────────────────────────────────────────────────────

type StatusVariant = "green" | "amber" | "red" | "graphite" | "blue";

function AStatus({ label, variant = "graphite" }: { label: string; variant?: StatusVariant }) {
  return (
    <span className={`a-status a-status--${variant}`}>
      <span className="a-status__dot" />
      {label}
    </span>
  );
}

function HeroStat({ value, label, loading }: { value: number; label: string; loading: boolean }) {
  return (
    <div>
      <div
        style={{
          fontFamily: "Newsreader, Georgia, serif",
          fontSize: 30,
          fontWeight: 400,
          color: "var(--ink-1)",
          lineHeight: 1,
        }}
      >
        {loading ? "—" : value}
      </div>
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-4)",
          marginTop: 4,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function BoolDisplay({ value }: { value: boolean }) {
  return <AStatus label={value ? "Yes" : "No"} variant={value ? "green" : "graphite"} />;
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={handleCopy}
      className="a-btn a-btn--ghost"
      style={{ fontSize: 11.5, padding: "3px 9px" }}
    >
      {copied ? "Copied" : "Copy ID"}
    </button>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AegisIDPage() {
  const [claims, setClaims] = useState<AegisIDTrustClaims | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [techExpanded, setTechExpanded] = useState(false);

  useEffect(() => {
    getAegisIDTrustClaims()
      .then(setClaims)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div className="a-eyebrow" style={{ marginBottom: 8 }}>Settings</div>
          <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "0 0 10px" }}>
            Identity,{" "}
            <span className="cmd-hero__title-mark">secured.</span>
          </h1>
          <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: "0 0 20px" }}>
            Manage your Antigen identity, trust claims, and control-plane settings for autonomous agents.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto auto auto 1fr",
              gap: 32,
              borderTop: "1px solid var(--hairline)",
              paddingTop: 16,
            }}
          >
            <HeroStat value={claims?.approvals_granted ?? 0} label="Approvals granted" loading={loading} />
            <HeroStat value={claims?.blocked_risky_actions ?? 0} label="Blocked actions" loading={loading} />
            <HeroStat value={claims?.runner_completed_purchases ?? 0} label="Runner purchases" loading={loading} />
          </div>
        </div>
      </div>

      {/* ── Loading skeletons ─────────────────────────────────────────────── */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2].map((i) => (
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

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && !loading && (
        <div
          style={{
            padding: "14px 18px",
            borderRadius: "var(--r-2)",
            background: "var(--amber-soft)",
            border: "1px solid var(--amber-ring)",
          }}
        >
          <p style={{ fontSize: 12.5, color: "oklch(0.45 0.12 75)", margin: 0 }}>
            Could not load identity: {error}
          </p>
        </div>
      )}

      {/* ── Identity card ─────────────────────────────────────────────────── */}
      {claims && !loading && (
        <>
          <div
            className="apr-card"
            style={{ borderColor: claims.verified_human_backed ? "var(--green-ring)" : undefined }}
          >
            <div className="apr-card__head">
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <AStatus
                    label={claims.verified_human_backed ? "Human-backed" : "Unverified"}
                    variant={claims.verified_human_backed ? "green" : "graphite"}
                  />
                  <AStatus
                    label={claims.purchase_history === "demo_clean" ? "Clean history" : "No history"}
                    variant={claims.purchase_history === "demo_clean" ? "green" : "graphite"}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--ink-2)",
                      fontFamily: '"JetBrains Mono", monospace',
                      wordBreak: "break-all",
                    }}
                  >
                    {claims.aegis_id}
                  </span>
                  <CopyButton text={claims.aegis_id} />
                </div>
              </div>
              <time style={{ fontSize: 12, color: "var(--ink-4)", flexShrink: 0 }}>
                Updated{" "}
                {new Date(claims.last_updated).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </time>
            </div>

            <div className="apr-card__body" style={{ gap: 0 }}>
              <div className="apr-box">
                <div className="apr-box__head">Trust Claims</div>

                <ClaimRow label="Human-Backed">
                  <BoolDisplay value={claims.verified_human_backed} />
                </ClaimRow>
                <ClaimRow label="Runner-Completed Purchases">
                  <CountDisplay n={claims.runner_completed_purchases} />
                </ClaimRow>
                <ClaimRow label="Blocked Risky Actions">
                  <CountDisplay n={claims.blocked_risky_actions} />
                </ClaimRow>
                <ClaimRow label="Approvals Granted">
                  <CountDisplay n={claims.approvals_granted} />
                </ClaimRow>
                <ClaimRow label="Approvals Denied">
                  <CountDisplay n={claims.approvals_denied} />
                </ClaimRow>
                <ClaimRow label="Credential Exposure Incidents">
                  <CountDisplay n={claims.credential_exposure_incidents} warningAbove={0} />
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
                    Sensitive Data Shared with Agent
                  </span>
                  <CountDisplay n={claims.sensitive_data_shared_with_agent_count} warningAbove={0} />
                </div>
              </div>

              {/* Technical details toggle */}
              <div style={{ marginTop: 12 }}>
                <button
                  onClick={() => setTechExpanded((v) => !v)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--blue)",
                    padding: 0,
                  }}
                >
                  {techExpanded ? "Hide technical details" : "View technical details"}
                </button>

                {techExpanded && (
                  <div className="apr-box" style={{ marginTop: 10 }}>
                    <div className="apr-box__head">Technical Details</div>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 24px" }}>
                      <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Last updated</span>
                      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                        {new Date(claims.last_updated).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Purchase history</span>
                      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{claims.purchase_history}</span>
                    </div>
                    <p
                      style={{
                        fontSize: 11,
                        color: "var(--ink-4)",
                        fontFamily: '"JetBrains Mono", monospace',
                        margin: "10px 0 0",
                      }}
                    >
                      not_a_guarantee: true · based_only_on_aegis_observed_events: true
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Demo disclaimer */}
          <div
            style={{
              padding: "12px 16px",
              borderRadius: "var(--r-2)",
              background: "var(--blue-soft)",
              border: "1px solid var(--blue-ring)",
            }}
          >
            <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
              Local demo only — trust claims are derived from receipts in this session, not a public
              reputation score. Only derived claims (not raw history) would be shared with counterparties
              in production, and only with your consent.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
