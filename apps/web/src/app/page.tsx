"use client";

import { useEffect, useState, Fragment } from "react";
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
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

// ── Tiny SVG helpers ───────────────────────────────────────────────────────
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
  return (
    <div className="rline">
      <ol className="rline__list">
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

// ── Agent Identity Accent ──────────────────────────────────────────────────
// Muted premium palette — 6 tinted grays with restrained chroma.
// Colors help distinguish agents without breaking the ceramic/white aesthetic.
const AGENT_ACCENT_PALETTE = [
  { base: "oklch(0.58 0.09 240)", soft: "oklch(0.58 0.09 240 / 0.09)", ring: "oklch(0.58 0.09 240 / 0.50)" }, // steel blue
  { base: "oklch(0.57 0.08 190)", soft: "oklch(0.57 0.08 190 / 0.09)", ring: "oklch(0.57 0.08 190 / 0.50)" }, // teal
  { base: "oklch(0.56 0.07 150)", soft: "oklch(0.56 0.07 150 / 0.09)", ring: "oklch(0.56 0.07 150 / 0.50)" }, // sage
  { base: "oklch(0.62 0.09 75)",  soft: "oklch(0.62 0.09 75  / 0.09)", ring: "oklch(0.62 0.09 75  / 0.50)" }, // warm amber
  { base: "oklch(0.56 0.08 300)", soft: "oklch(0.56 0.08 300 / 0.09)", ring: "oklch(0.56 0.08 300 / 0.50)" }, // muted violet
  { base: "oklch(0.60 0.09 20)",  soft: "oklch(0.60 0.09 20  / 0.09)", ring: "oklch(0.60 0.09 20  / 0.50)" }, // dusty rose
] as const;

function getAgentAccent(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return AGENT_ACCENT_PALETTE[h % AGENT_ACCENT_PALETTE.length];
}

// ── AntigenCoreMap ─────────────────────────────────────────────────────────
const ANGLES   = [-10, 70, 145, 215, 290, 340];
const RADII    = [200, 230, 195, 235, 208, 220];
const MAX_NODES = 6;

/**
 * AntigenCoreGlyph — abstract authority-A recognition mark.
 * Named so it can be swapped for the final Antigen logo SVG later.
 */
function AntigenCoreGlyph() {
  return (
    <svg width={22} height={22} viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="9" stroke="currentColor" strokeWidth="0.8" opacity="0.45" />
      <path
        d="M8.5 16 L11 7 L13.5 16"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
      <line x1="9.3" y1="13" x2="12.7" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

type NodeStatus = "verified" | "limited" | "blocked";
type OrbNode = {
  id: string; name: string; status: NodeStatus;
  channel: string; platform: string;
  angle: number; r: number; overflow: false;
};
type OverflowNode = { id: "__overflow__"; overflow: true; angle: number; r: number; count: number };
type MapNode = OrbNode | OverflowNode;

function AntigenCoreMap({ delegations, loading }: { delegations: AgentDelegation[]; loading: boolean }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const visible  = delegations.slice(0, MAX_NODES);
  const overflow = delegations.length - MAX_NODES;

  const nodes: MapNode[] = visible.map((d, i) => ({
    id:       d.id,
    name:     d.agent_name,
    status:   d.status === "active"  ? "verified"
            : d.status === "revoked" ? "blocked"
            : "limited",
    channel:  d.channel,
    platform: d.agent_platform ?? "",
    angle:    ANGLES[i],
    r:        RADII[i],
    overflow: false as const,
  }));

  if (overflow > 0) {
    nodes.push({
      id: "__overflow__", overflow: true,
      angle: ANGLES[MAX_NODES] ?? 340,
      r:     RADII[MAX_NODES]  ?? 220,
      count: overflow,
    });
  }

  return (
    <div style={{ position: "relative", width: 540, height: 540, margin: "0 auto" }}>

      {/* Animated SVG line — draws only for the hovered node */}
      <svg
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }}
        viewBox="-300 -300 600 600"
        aria-hidden="true"
      >
        {nodes.map((n) => {
          const rad = (n.angle * Math.PI) / 180;
          const accent = n.overflow ? null : getAgentAccent(n.id);
          const isVisible = hoveredId === n.id;
          return (
            <line
              key={n.id}
              x1="0" y1="0"
              x2={Math.cos(rad) * n.r}
              y2={Math.sin(rad) * n.r}
              className={`antigen-line${isVisible ? " antigen-line--visible" : ""}`}
              style={isVisible && accent ? { stroke: accent.base } : undefined}
              strokeLinecap="round"
            />
          );
        })}
      </svg>

      {/* Antigen core recognition mark */}
      <div className="antigen-core" style={{ color: "var(--blue)" }}>
        <AntigenCoreGlyph />
      </div>

      {/* Agent nodes */}
      {nodes.map((n) => {
        const rad = (n.angle * Math.PI) / 180;
        const x   = Math.cos(rad) * n.r;
        const y   = Math.sin(rad) * n.r;

        if (n.overflow) {
          return (
            <div
              key={n.id}
              className="antigen-node antigen-node--overflow"
              style={{
                position: "absolute", top: "50%", left: "50%",
                transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
                width: 22, height: 22, fontSize: 9,
              }}
              aria-label={`${n.count} more agents`}
            >
              +{n.count}
            </div>
          );
        }

        const isHovered = hoveredId === n.id;
        const statusMod = n.status === "verified" ? "verified" : n.status === "blocked" ? "blocked" : "limited";
        const statusColor = n.status === "verified" ? "green" : n.status === "blocked" ? "red" : "amber";
        const cardX = x + (x >= 0 ? 28 : -28);
        const cardY = y + (y >= 0 ? 22 : -22);
        const accent = getAgentAccent(n.id);
        const accentVars = {
          "--agent-accent":      accent.base,
          "--agent-accent-soft": accent.soft,
          "--agent-accent-ring": accent.ring,
        } as React.CSSProperties;

        return (
          <Fragment key={n.id}>
            <button
              type="button"
              className={`antigen-node antigen-node--${statusMod}`}
              style={{
                position: "absolute", top: "50%", left: "50%",
                transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
                zIndex: 3,
                ...accentVars,
              }}
              onMouseEnter={() => setHoveredId(n.id)}
              onMouseLeave={() => setHoveredId(null)}
              onFocus={() => setHoveredId(n.id)}
              onBlur={() => setHoveredId(null)}
              aria-label={n.name}
            />

            {isHovered && (
              <div
                style={{
                  position: "absolute", top: "50%", left: "50%",
                  transform: `translate(calc(-50% + ${cardX}px), calc(-50% + ${cardY}px))`,
                  zIndex: 10, pointerEvents: "none",
                }}
              >
                <div className="antigen-card" style={accentVars}>
                  <div className="antigen-card__accent" />
                  <div className="antigen-card__eyebrow">Agent Passport</div>
                  <div className="antigen-card__head">
                    <div className="antigen-card__avatar">
                      {n.name[0]?.toUpperCase() ?? "A"}
                    </div>
                    <div>
                      <div className="antigen-card__name">{n.name}</div>
                      {(n.platform || n.channel) && (
                        <div className="antigen-card__meta">
                          {[n.platform, n.channel].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="antigen-card__divider" />
                  <span className={`a-status a-status--${statusColor}`} style={{ fontSize: 11 }}>
                    <span className="a-status__dot" />
                    {n.status}
                  </span>
                  <div className="antigen-card__footer">Protected by Antigen</div>
                </div>
              </div>
            )}
          </Fragment>
        );
      })}

      {!loading && delegations.length === 0 && (
        <p style={{
          position: "absolute", bottom: 60, left: "50%", transform: "translateX(-50%)",
          color: "var(--ink-3)", fontSize: 12.5, fontFamily: '"Newsreader", "Georgia", serif',
          fontStyle: "italic", whiteSpace: "nowrap",
        }}>
          No agents connected
        </p>
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
          {delegations.slice(0, 5).map((d) => {
            const accent = getAgentAccent(d.id);
            return (
            <div key={d.id} className="cmd-agent-row">
              <div
                className="cmd-agent-row__avatar"
                style={{
                  "--agent-accent":      accent.base,
                  "--agent-accent-soft": accent.soft,
                  "--agent-accent-ring": accent.ring,
                } as React.CSSProperties}
              >
                {d.agent_name?.[0]?.toUpperCase() ?? "A"}
              </div>
              <div>
                <div className="cmd-agent-row__name">{d.agent_name}</div>
                <div className="cmd-agent-row__channel">{d.channel}</div>
              </div>
              {d.status === "active" ? (
                <span className="metadata-state metadata-state--good">{d.status}</span>
              ) : (
                <span className="a-status a-status--graphite">{d.status}</span>
              )}
            </div>
            );
          })}
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
        const rawViolationValue = violations.value;
        const receipts = Array.isArray(rawViolationValue)
          ? rawViolationValue
          : Array.isArray(rawViolationValue?.receipts)
            ? rawViolationValue.receipts
            : [];
        const count =
          typeof rawViolationValue?.count === "number"
            ? rawViolationValue.count
            : receipts.length;
        setViolationCount(count);
        setCriticalViolation(receipts.some((r: { severity?: string }) => r.severity === "critical"));
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
      <SpotlightHeroCard className="cmd-hero cmd-hero--big cmd-hero--ceramic">
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />

        <div className="cmd-hero__head">
          <div className="a-eyebrow">Command</div>
          <h1 className="cmd-hero__title">
            <span className="cmd-hero__title-mark">Your agentic web </span>
            <span className="cmd-hero__title-mark">{heroVerb()}</span>
          </h1>
          <p className="cmd-hero__sub">
            Antigen verifies who acts, what they may touch, and what proof they leave.
          </p>
        </div>

        <AntigenCoreMap delegations={delegations} loading={loading} />

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
      </SpotlightHeroCard>

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
              className="cmd-setup__dismiss"
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
