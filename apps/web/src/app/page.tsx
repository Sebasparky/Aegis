"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  AgentDelegation,
  ApprovalRequest,
  UserApprovalReceipt,
  SensitiveGrant,
} from "@aegis/types";
import {
  listDelegations,
  listApprovals,
  listSensitiveGrants,
  listUserApprovalReceipts,
  listWebsiteViolationReceipts,
  listVaultPasses,
} from "@/lib/api";

// ── Tiny SVG helpers ───────────────────────────────────────────────────────
function ShieldSVG({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3l7 3v6c0 4.5-3.2 7.5-7 9-3.8-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function ArrowSVG({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function timeAgo(iso: string): string {
  const ms   = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── RouteLine ──────────────────────────────────────────────────────────────
function RouteLine({ steps, active = 0 }: { steps: string[]; active?: number }) {
  const x2 = 14 + ((586 - 14) * active) / Math.max(steps.length - 1, 1);
  return (
    <div className="rline">
      <svg className="rline__svg" viewBox="0 0 600 36" preserveAspectRatio="none" aria-hidden="true">
        <line x1="14" y1="18" x2="586" y2="18" stroke="oklch(0.88 0.04 240)" strokeWidth="1" strokeDasharray="3 4" />
        <line x1="14" y1="18" x2={x2} y2="18" stroke="oklch(0.62 0.09 240)" strokeWidth="1.5" />
      </svg>
      <ol className="rline__list" style={{ margin: 0, padding: "0 8px" }}>
        {steps.map((s, i) => (
          <li key={s} className={`rline__step${i <= active ? " rline__step--on" : ""}`}>
            <span className="rline__bead" />
            <span className="rline__lab">{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── TrustCore ──────────────────────────────────────────────────────────────
type NodeStatus = "verified" | "limited" | "approval" | "blocked";
type OrbNode = { id: string; name: string; status: NodeStatus; angle: number; r: number };

const ANGLES = [-10, 70, 145, 215, 290];
const RADII  = [200, 230, 195, 235, 208];

function TrustCore({ delegations, loading }: { delegations: AgentDelegation[]; loading: boolean }) {
  const [hover, setHover] = useState<string | null>(null);

  const nodes: OrbNode[] = delegations.slice(0, 5).map((d, i) => ({
    id:     d.id,
    name:   d.agent_name,
    status: d.status === "active"  ? "verified"
          : d.status === "revoked" ? "blocked"
          : "limited",
    angle: ANGLES[i],
    r:     RADII[i],
  }));

  return (
    <div className="trust">
      <div className="trust__rings">
        <div className="trust__ring trust__ring--1" />
        <div className="trust__ring trust__ring--2" />
        <div className="trust__ring trust__ring--3" />
        <div className="trust__ring trust__ring--4" />
      </div>

      <svg className="trust__lines" viewBox="-300 -300 600 600" aria-hidden="true">
        {nodes.map((n) => {
          const rad = (n.angle * Math.PI) / 180;
          return (
            <line
              key={n.id}
              x1="0" y1="0"
              x2={Math.cos(rad) * n.r}
              y2={Math.sin(rad) * n.r}
              className={`trust__line trust__line--${n.status}${hover === n.id ? " trust__line--hover" : ""}`}
            />
          );
        })}
      </svg>

      <div className="trust__core">
        <span className="trust__core-pulse" aria-hidden="true" />
        <span className="trust__core-pulse trust__core-pulse--2" aria-hidden="true" />
        <div className="trust__core-inner">
          <span className="trust__core-bezel" aria-hidden="true" />
          <div className="trust__core-glyph"><ShieldSVG size={32} /></div>
          <div className="trust__core-label">AEGIS CORE</div>
        </div>
      </div>

      {nodes.map((n) => {
        const rad = (n.angle * Math.PI) / 180;
        const x   = Math.cos(rad) * n.r;
        const y   = Math.sin(rad) * n.r;
        return (
          <div
            key={n.id}
            className={`trust__node trust__node--${n.status}${hover === n.id ? " trust__node--hover" : ""}`}
            style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="trust__node-orb" />
            <div className="trust__node-card">
              <div className="trust__node-card__name">{n.name}</div>
            </div>
          </div>
        );
      })}

      {!loading && delegations.length === 0 && (
        <p className="trust__caption">No agents connected · Add one to begin</p>
      )}
    </div>
  );
}

// ── MetricCard ─────────────────────────────────────────────────────────────
function MetricCard({
  label, value, href, alert,
}: {
  label: string; value: string | number; href: string; alert?: boolean;
}) {
  return (
    <Link href={href} className="a-metric">
      <div className="a-metric__label">{label}</div>
      <div
        className="a-metric__value"
        style={alert ? { color: "var(--amber)" } : undefined}
      >
        {value}
      </div>
    </Link>
  );
}

// ── ConnectedAgents ────────────────────────────────────────────────────────
function ConnectedAgents({ delegations, loading }: { delegations: AgentDelegation[]; loading: boolean }) {
  return (
    <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="a-eyebrow">Connected Agents</div>
      {loading ? <CardSkeleton /> : delegations.length === 0 ? (
        <CardEmpty
          headline="No agents connected yet."
          body="Delegations give agents a signed identity with scoped permissions."
          cta="Add agent" href="/delegations"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {delegations.slice(0, 5).map((d) => (
            <div
              key={d.id}
              style={{
                display: "grid", gridTemplateColumns: "32px 1fr auto", alignItems: "center", gap: 12,
                padding: "10px 12px", border: "1px solid var(--hairline)",
                borderRadius: "var(--r-2)", background: "rgba(255,255,255,0.5)",
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 9, display: "grid", placeItems: "center",
                background: "var(--blue-soft)", border: "1px solid var(--blue-ring)",
                fontSize: 11, fontWeight: 600, color: "oklch(0.45 0.09 240)",
              }}>
                {d.agent_name?.[0]?.toUpperCase() ?? "A"}
              </div>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13.5, color: "var(--ink-1)" }}>{d.agent_name}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{d.channel}</div>
              </div>
              <span className={`a-status a-status--${d.status === "active" ? "green" : "graphite"}`}>
                <span className="a-status__dot" />{d.status}
              </span>
            </div>
          ))}
          {delegations.length > 5 && (
            <Link href="/delegations" className="a-link" style={{ justifyContent: "center", fontSize: 12 }}>
              View all {delegations.length} agents <ArrowSVG />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

// ── PendingApprovals ───────────────────────────────────────────────────────
function PendingApprovals({ approvals, loading }: { approvals: ApprovalRequest[]; loading: boolean }) {
  return (
    <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="a-eyebrow">Pending Approvals</div>
      {loading ? <CardSkeleton /> : approvals.length === 0 ? (
        <CardEmpty
          headline="No approvals waiting."
          body="When an agent needs sensitive authority, it will appear here."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {approvals.slice(0, 3).map((a) => (
            <Link
              key={a.id}
              href="/route-run-approvals"
              style={{
                display: "block", textDecoration: "none",
                border: "1px solid var(--hairline)", borderRadius: "var(--r-2)",
                padding: "10px 12px", background: "rgba(255,255,255,0.5)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{
                  fontWeight: 500, fontSize: 13.5, color: "var(--ink-1)",
                  flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {a.summary}
                </div>
                {a.risk_level && (
                  <span className={`a-status a-status--${
                    a.risk_level === "critical" || a.risk_level === "high" ? "red"
                    : a.risk_level === "medium" ? "amber" : "graphite"
                  }`}>
                    <span className="a-status__dot" />{a.risk_level}
                  </span>
                )}
              </div>
              {a.domain && (
                <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: '"JetBrains Mono", monospace', marginTop: 4 }}>
                  {a.domain}
                </div>
              )}
            </Link>
          ))}
          <Link href="/route-run-approvals" className="a-link" style={{ justifyContent: "center", fontSize: 12 }}>
            Review all approvals <ArrowSVG />
          </Link>
        </div>
      )}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ height: 44, borderRadius: "var(--r-2)", background: "var(--graphite-soft)", opacity: 0.5 }} />
      ))}
    </div>
  );
}
function CardEmpty({ headline, body, cta, href }: { headline: string; body: string; cta?: string; href?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "20px 8px" }}>
      <p style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 4px" }}>{headline}</p>
      <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>{body}</p>
      {cta && href && (
        <Link href={href} style={{
          display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12,
          padding: "7px 14px", borderRadius: "var(--r-2)",
          background: "var(--ink-1)", color: "#fff",
          fontSize: 13, fontWeight: 500, textDecoration: "none",
        }}>
          {cta}
        </Link>
      )}
    </div>
  );
}

// ── CommandPage ────────────────────────────────────────────────────────────
export default function CommandPage() {
  const router = useRouter();

  const [delegations,          setDelegations]          = useState<AgentDelegation[]>([]);
  const [pendingApprovals,     setPendingApprovals]     = useState<ApprovalRequest[]>([]);
  const [activeGrants,         setActiveGrants]         = useState<SensitiveGrant[]>([]);
  const [userApprovalReceipts, setUserApprovalReceipts] = useState<UserApprovalReceipt[]>([]);
  const [violationCount,       setViolationCount]       = useState<number | null>(null);
  const [criticalViolation,    setCriticalViolation]    = useState(false);
  const [vaultCount,           setVaultCount]           = useState<number | null>(null);
  const [loading,              setLoading]              = useState(true);
  const [showSetup,            setShowSetup]            = useState(true);

  useEffect(() => {
    Promise.allSettled([
      listDelegations(),
      listApprovals("pending"),
      listSensitiveGrants({ status: "active" }),
      listUserApprovalReceipts(),
      listWebsiteViolationReceipts(),
      listVaultPasses(),
    ]).then(([dels, apps, grants, uars, violations, vault]) => {
      if (dels.status       === "fulfilled") setDelegations(dels.value);
      if (apps.status       === "fulfilled") setPendingApprovals(apps.value);
      if (grants.status     === "fulfilled") setActiveGrants(grants.value);
      if (uars.status       === "fulfilled") setUserApprovalReceipts(uars.value);
      if (violations.status === "fulfilled") {
        setViolationCount(violations.value.count);
        setCriticalViolation(violations.value.receipts.some((r) => r.severity === "critical"));
      }
      if (vault.status === "fulfilled") setVaultCount(vault.value.length);
    }).finally(() => setLoading(false));
  }, []);

  const activeDelegations = delegations.filter((d) => d.status === "active");
  const recentProofs      = [...userApprovalReceipts]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  const attentionItems: Array<{ label: string; href: string }> = [];
  if (pendingApprovals.length > 0)
    attentionItems.push({ label: `${pendingApprovals.length} approval request${pendingApprovals.length !== 1 ? "s" : ""} waiting`, href: "/route-run-approvals" });
  if (activeGrants.length > 0)
    attentionItems.push({ label: `${activeGrants.length} sensitive grant${activeGrants.length !== 1 ? "s" : ""} active`, href: "/sensitive-grants" });
  if (criticalViolation)
    attentionItems.push({ label: "Critical website violation recorded", href: "/receipts" });

  function heroVerb() {
    if (loading)                    return "loading.";
    if (attentionItems.length > 0)  return "needs attention.";
    if (activeDelegations.length === 0) return "is ready.";
    return "is secured.";
  }

  return (
    <div className="page page--command">

      {/* ── Hero panel ─────────────────────────────────────────────────── */}
      <div className="cmd-hero cmd-hero--big cmd-hero--ceramic">
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />

        <div className="cmd-hero__head">
          <div className="a-eyebrow">Command</div>
          <h1 className="cmd-hero__title">
            <span className="cmd-hero__title-mark">Your agentic web </span>
            <span className="cmd-hero__title-mark">{heroVerb()}</span>
          </h1>
          <p className="cmd-hero__sub">
            Aegis verifies who acts, what they may touch, and what proof they leave.
          </p>
        </div>

        <TrustCore delegations={delegations} loading={loading} />

        <div className="cmd-pulse cmd-pulse--instr">
          <button className="cmd-pulse__item" type="button" onClick={() => router.push("/delegations")}>
            <span className="cmd-pulse__lab">AGENTS · SECURED</span>
            <span className="cmd-pulse__num">{loading ? "—" : activeDelegations.length}</span>
            <span className="cmd-pulse__tick" />
          </button>
          <span className="cmd-pulse__div" />
          <button className="cmd-pulse__item" type="button" onClick={() => router.push("/route-run-approvals")}>
            <span className="cmd-pulse__lab">APPROVALS · PENDING</span>
            <span className="cmd-pulse__num">{loading ? "—" : pendingApprovals.length}</span>
            <span className={`cmd-pulse__tick${!loading && pendingApprovals.length > 0 ? " cmd-pulse__tick--amber" : ""}`} />
          </button>
          <span className="cmd-pulse__div" />
          <button className="cmd-pulse__item" type="button" onClick={() => router.push("/passes")}>
            <span className="cmd-pulse__lab">SECRETS · SEALED</span>
            <span className="cmd-pulse__num">{loading ? "—" : (vaultCount ?? "—")}</span>
            <span className="cmd-pulse__tick" />
          </button>
        </div>
      </div>

      {/* ── Trust route setup strip ─────────────────────────────────────── */}
      {showSetup && (
        <div className="cmd-setup cmd-setup--route">
          <div className="cmd-setup__l">
            <span className="a-eyebrow">Trust route · guided setup</span>
            <RouteLine steps={["Connect", "Collar", "Approve", "Receipt"]} active={0} />
          </div>
          <div className="cmd-setup__r">
            <Link href="/delegations" className="a-btn a-btn--ghost">Begin</Link>
            <button
              type="button"
              onClick={() => setShowSetup(false)}
              aria-label="Dismiss"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", fontSize: 18, lineHeight: 1, padding: "4px 6px" }}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* ── Attention panel ─────────────────────────────────────────────── */}
      {!loading && attentionItems.length > 0 && (
        <div style={{
          background: "var(--amber-soft)", border: "1px solid var(--amber-ring)",
          borderRadius: "var(--r-3)", padding: "14px 18px",
        }}>
          <div className="a-eyebrow" style={{ color: "var(--amber)", marginBottom: 10 }}>Needs attention</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {attentionItems.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "8px 4px", textDecoration: "none", color: "var(--ink-1)", fontSize: 13.5,
                  borderBottom: i < attentionItems.length - 1 ? "1px solid var(--amber-ring)" : "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="a-dot a-dot--amber" />
                  {item.label}
                </div>
                <span style={{ fontSize: 12, color: "var(--amber)", display: "flex", alignItems: "center", gap: 4 }}>
                  Review <ArrowSVG size={11} />
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Metric cards ────────────────────────────────────────────────── */}
      <div className="cmd-metrics">
        <MetricCard label="Agents secured"    value={loading ? "—" : activeDelegations.length}  href="/delegations" />
        <MetricCard label="Approvals pending" value={loading ? "—" : pendingApprovals.length}    href="/route-run-approvals" alert={!loading && pendingApprovals.length > 0} />
        <MetricCard label="Active grants"     value={loading ? "—" : activeGrants.length}        href="/sensitive-grants"   alert={!loading && activeGrants.length > 0} />
        <MetricCard label="Signed receipts"   value={loading ? "—" : userApprovalReceipts.length}href="/receipts" />
        <MetricCard label="Website violations"value={loading ? "—" : (violationCount ?? "—")}    href="/receipts"           alert={!loading && criticalViolation} />
        <MetricCard label="Secrets sealed"    value={loading ? "—" : (vaultCount ?? "—")}        href="/passes" />
      </div>

      {/* ── Two-column: agents + approvals ──────────────────────────────── */}
      <div className="cmd-split">
        <ConnectedAgents delegations={delegations} loading={loading} />
        <PendingApprovals approvals={pendingApprovals} loading={loading} />
      </div>

      {/* ── Recent proofs ────────────────────────────────────────────────── */}
      <section className="cmd-recent">
        <header className="cmd-recent__h">
          <h2 className="a-h2">Recent proofs</h2>
          <Link href="/receipts" className="a-link">
            Open receipts <ArrowSVG size={12} />
          </Link>
        </header>
        {!loading && recentProofs.length === 0 ? (
          <p style={{
            color: "var(--ink-3)", fontSize: 13, padding: "16px 6px",
            fontFamily: '"Newsreader", Georgia, serif', fontStyle: "italic",
          }}>
            No signed receipts yet.
          </p>
        ) : (
          <ul className="cmd-recent__list" style={{ margin: 0, padding: 0 }}>
            {loading
              ? [1, 2, 3].map((i) => (
                  <li key={i} style={{ opacity: 0.35 }}>
                    <span className="a-dot a-dot--graphite" />
                    <span className="cmd-recent__who">—</span>
                    <span className="cmd-recent__what">Loading…</span>
                    <span className="cmd-recent__when">—</span>
                  </li>
                ))
              : recentProofs.map((r) => (
                  <li key={r.receipt_id}>
                    <span className={`a-dot a-dot--${r.decision === "approved" ? "green" : "red"}`} />
                    <span className="cmd-recent__who">{r.agent_name ?? "—"}</span>
                    <span className="cmd-recent__what">{r.target_domain ?? r.action_type ?? "—"}</span>
                    <span className="cmd-recent__when">{timeAgo(r.decided_at)}</span>
                  </li>
                ))
            }
          </ul>
        )}
      </section>
    </div>
  );
}
