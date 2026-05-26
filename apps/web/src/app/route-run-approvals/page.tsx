"use client";

import { useEffect, useState } from "react";
import {
  listRouteRuns,
  approveRouteRun,
  rejectRouteRun,
  requestSpendingStepUp,
  listCredentialSessions,
  approveCredentialSession,
  getApprovalContext,
  listAuthenticatedSessions,
  approveAuthenticatedSession,
  rejectAuthenticatedSession,
  listSecretFieldInjections,
  approveSecretFieldInjection,
  denySecretFieldInjection,
  listCredentialUseAuthorizations,
  approveCredentialUseAuthorization,
  denyCredentialUseAuthorization,
  listSecurityChallenges,
  submitSecurityChallengeCode,
  completeSecurityChallenge,
  cancelSecurityChallenge,
  getEmailResolverStatus,
  getChallengeEmailResolutions,
  startChallengeEmailResolution,
  cancelChallengeEmailResolution,
  listSensitiveGrants,
  listLoginDiagnostics,
  listPaymentCardFillAuthorizations,
  approvePaymentCardFillAuthorization,
  denyPaymentCardFillAuthorization,
  listPurchaseConfirmationAuthorizations,
  approvePurchaseConfirmationAuthorization,
  denyPurchaseConfirmationAuthorization,
  type RouteRunWithSummary,
  type CredentialSessionView,
  type RunApprovalContext,
  type ApprovalManifest,
  type ApprovalManifestLineItem,
  type AuthenticatedSessionHandleView,
  type SecretFieldInjectionView,
  type CredentialUseAuthorizationView,
  type SecurityChallengeView,
  type EmailResolverStatusView,
  type ChallengeEmailResolutionView,
  type LoginDiagnosticView,
  type PaymentCardFillAuthorizationView,
  type PaymentCardField,
  type PurchaseConfirmationAuthorizationView,
  listProfileMemoryRequests,
  submitProfileMemoryRequest,
  cancelProfileMemoryRequest,
  type ProfileMemoryRequestView,
  listAccountCreationRequests,
  approveAccountCreationRequest,
  denyAccountCreationRequest,
  type AccountCreationRequestView,
} from "../../lib/api";
import { findCredentialProviderByDomain, getInjectionSafetyCopy } from "../../lib/credentialProviders";
import type { SensitiveGrant } from "@aegis/types";
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

// ── Tone / risk helpers ────────────────────────────────────────────────────────

function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

function toneStyle(tone?: ApprovalManifestLineItem["tone"]): React.CSSProperties {
  switch (tone) {
    case "money":   return { color: "oklch(0.42 0.09 150)", fontWeight: 600 };
    case "warning": return { color: "oklch(0.45 0.12 75)" };
    case "success": return { color: "oklch(0.42 0.09 150)" };
    default:        return { color: "var(--ink-1)" };
  }
}

function riskPillClass(riskTier: string): string {
  if (riskTier === "high" || riskTier === "critical") return "a-status a-status--red";
  if (riskTier === "medium") return "a-status a-status--amber";
  return "a-status a-status--graphite";
}

function riskLabel(riskTier: string): string {
  if (riskTier === "high") return "High risk";
  if (riskTier === "critical") return "Critical risk";
  if (riskTier === "medium") return "Medium risk";
  return "Low risk";
}

function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  return `in ${Math.round(mins / 60)} hr`;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="apr-box">
      {label && <div className="apr-box__head">{label}</div>}
      {children}
    </div>
  );
}

function LineItem({ item }: { item: ApprovalManifestLineItem }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
      <span style={{ fontSize: 12, color: "var(--ink-4)", flexShrink: 0 }}>{item.label}</span>
      <span style={{ fontSize: 12, textAlign: "right", ...toneStyle(item.tone) }}>{item.value}</span>
    </div>
  );
}

function CheckList({ items, blue }: { items: string[]; blue?: boolean }) {
  return (
    <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item, i) => (
        <li key={i} className="apr-check">
          <span className={`apr-check__tick${blue ? " apr-check__tick--blue" : ""}`}>✓</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Manifest panel ─────────────────────────────────────────────────────────────

function ManifestPanel({ ctx }: { ctx: RunApprovalContext }) {
  const m: ApprovalManifest = ctx.manifest;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 4px", lineHeight: 1.3 }}>
          {m.title}
        </h3>
        <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0 }}>{m.subtitle}</p>
      </div>

      {m.line_items.length > 0 && (
        <SectionCard label="Details">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {m.line_items.map((item, i) => <LineItem key={i} item={item} />)}
          </div>
        </SectionCard>
      )}

      {m.spending_limit && (
        <SectionCard label="Spending guardrails">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {m.spending_limit.max_amount_usd !== undefined && (
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
                <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Max approved</span>
                <span style={{ fontSize: 12, color: "oklch(0.45 0.12 75)", fontWeight: 600 }}>
                  ${m.spending_limit.max_amount_usd.toFixed(2)} {m.spending_limit.currency ?? "USD"}
                </span>
              </div>
            )}
            {m.spending_limit.payment_instrument_label && (
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
                <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Payment method</span>
                <span style={{ fontSize: 12, color: "var(--ink-1)" }}>{m.spending_limit.payment_instrument_label}</span>
              </div>
            )}
            {m.spending_limit.currency && (
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
                <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Allowed types</span>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Demo card only</span>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard label="What Antigen protects">
        <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {m.capabilities_to_release.map((cap, i) => (
            <li key={i} className="apr-check">
              <span className="apr-check__tick apr-check__tick--blue">⬡</span>
              <span>
                <span style={{ color: "var(--blue)", fontFamily: "monospace", fontSize: 11.5 }}>{cap}</span>
                {" "}capability will be released by Antigen
              </span>
            </li>
          ))}
          {m.custody_guarantees.map((g, i) => (
            <li key={i} className="apr-check">
              <span className="apr-check__tick">✓</span>
              <span>{g}</span>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard label="After you approve">
        <CheckList items={m.runtime_guarantees} />
      </SectionCard>
    </div>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function ManifestSkeleton() {
  const rows = [{ w: "65%", h: 18 }, { w: "45%", h: 14 }, { w: "100%", h: 72 }, { w: "100%", h: 56 }];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ height: r.h, width: r.w, borderRadius: 6, background: "var(--graphite-soft)", opacity: 0.5 }} />
      ))}
    </div>
  );
}

// ── Technical details ──────────────────────────────────────────────────────────

function TechnicalDetails({ run }: { run: RouteRunWithSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 11.5, color: "var(--ink-4)", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: 0 }}
      >
        <span>{open ? "▾" : "▸"}</span> Technical details
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", fontSize: 11, color: "var(--ink-4)" }}>
          <span>Run ID: <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{run.run_id}</span></span>
          <span>Route ID: <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{run.route_summary?.route_id ?? run.route_id}</span></span>
          {run.collar_id && (
            <span>Collar: <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{run.collar_id}</span></span>
          )}
          {run.delegation_id && (
            <span>Delegation: <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{run.delegation_id}</span></span>
          )}
          {run.route_summary?.trust_tier && (
            <span>Trust tier: <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{run.route_summary.trust_tier}</span></span>
          )}
          {run.approval_required_permissions && run.approval_required_permissions.length > 0 && (
            <span style={{ gridColumn: "1 / -1" }}>
              Permissions: <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{run.approval_required_permissions.join(", ")}</span>
            </span>
          )}
          <span style={{ gridColumn: "1 / -1" }}>
            Created: <span style={{ color: "var(--ink-3)" }}>{new Date(run.created_at).toLocaleString()}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Pending run card ───────────────────────────────────────────────────────────

function PendingRunCard({
  run, ctx, loadingCtx, onApprove, onReject, onContextUpdate,
}: {
  run: RouteRunWithSummary;
  ctx?: RunApprovalContext;
  loadingCtx: boolean;
  onApprove: () => void;
  onReject: () => void;
  onContextUpdate: (updated: RunApprovalContext) => void;
}) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [approved, setApproved] = useState(false);
  const [stepUpState, setStepUpState] = useState<"idle" | "confirming">("idle");
  const [stepUpWorking, setStepUpWorking] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  const riskTier = ctx?.manifest?.risk_tier ?? run.skill_summary?.risk_level ?? "medium";
  const agentId = ctx?.agent_id ?? run.agent_id;
  const m = ctx?.manifest;
  const isBlocked = m?.approval_blocked === true;
  const stepUpApproved = m?.spending_step_up?.status === "approved";

  async function handleApprove() {
    setApproving(true);
    setApproved(true);
    try { await onApprove(); } finally { setApproving(false); }
  }

  async function handleReject() {
    setRejecting(true);
    try { await onReject(); } finally { setRejecting(false); }
  }

  async function handleConfirmStepUp() {
    if (!m?.purchase_amount) return;
    setStepUpWorking(true);
    setStepUpError(null);
    try {
      const updated = await requestSpendingStepUp(run.run_id, m.purchase_amount.amount_usd);
      onContextUpdate(updated);
      setStepUpState("idle");
    } catch (err: any) {
      setStepUpError(err.message ?? "Failed to approve higher limit.");
    } finally {
      setStepUpWorking(false);
    }
  }

  if (approved) {
    return (
      <div className="apr-card apr-card--green" style={{ padding: "20px" }}>
        <p style={{ fontSize: 13.5, fontWeight: 600, color: "oklch(0.42 0.09 150)", margin: "0 0 4px" }}>
          Decision recorded — Antigen is executing this safely.
        </p>
        <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "0 0 12px" }}>
          {run.skill_summary?.name ?? run.skill_id} · {run.domain}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/receipts" style={{ fontSize: 12, color: "var(--blue)", textDecoration: "none" }}>View receipts →</a>
          <span style={{ color: "var(--hairline)" }}>·</span>
          <a href="/sensitive-grants" style={{ fontSize: 12, color: "var(--blue)", textDecoration: "none" }}>View sensitive grants →</a>
        </div>
      </div>
    );
  }

  return (
    <div className="apr-card apr-card--amber">
      <div className="apr-card__head">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div className="ag-avatar" style={{ background: "var(--amber-soft)", color: "oklch(0.45 0.12 75)", fontSize: 14 }}>
            🤖
          </div>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {agentId ?? "External agent"}
            </p>
            <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: 0 }}>via Antigen Delegation · {run.domain}</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span className="a-status a-status--amber">Waiting</span>
          <span className={riskPillClass(riskTier)}><span className="a-status__dot" />{riskLabel(riskTier)}</span>
        </div>
      </div>

      <div className="apr-card__body">
        {loadingCtx ? <ManifestSkeleton /> : ctx ? <ManifestPanel ctx={ctx} /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>
              {run.skill_summary?.name ?? run.skill_id}
            </p>
            <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0 }}>
              {run.route_summary?.workflow_name ?? run.route_id}
            </p>
            {run.approval_required_permissions && run.approval_required_permissions.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                {run.approval_required_permissions.map((p) => (
                  <span key={p} className="a-status a-status--amber" style={{ fontFamily: "monospace" }}>{p}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {isBlocked && !stepUpApproved && (
          <div style={{ background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-2)", padding: "12px 16px" }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.12 75)", margin: "0 0 4px" }}>
              This request exceeds your spending limit.
            </p>
            {m?.constraint_warnings?.map((w, i) => (
              <p key={i} style={{ fontSize: 12, color: "oklch(0.45 0.12 75)", margin: 0, opacity: 0.85 }}>{w}</p>
            ))}
          </div>
        )}

        {stepUpApproved && (
          <div style={{ background: "var(--green-soft)", border: "1px solid var(--green-ring)", borderRadius: "var(--r-2)", padding: "12px 16px" }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.42 0.09 150)", margin: "0 0 2px" }}>
              One-time limit approved: ${m?.spending_step_up?.approved_amount_usd?.toFixed(2)} USD
            </p>
            {m?.spending_limit?.max_amount_usd !== undefined && (
              <p style={{ fontSize: 11.5, color: "oklch(0.42 0.09 150)", opacity: 0.75, margin: 0 }}>
                Default collar limit: ${m.spending_limit.max_amount_usd.toFixed(2)} — not changed.
              </p>
            )}
            <p style={{ fontSize: 11, color: "oklch(0.42 0.09 150)", opacity: 0.55, margin: 0 }}>This applies to this run only.</p>
          </div>
        )}

        {isBlocked && !stepUpApproved && stepUpState === "confirming" && m?.purchase_amount && (
          <div style={{ background: "var(--blue-soft)", border: "1px solid var(--blue-ring)", borderRadius: "var(--r-2)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 4px" }}>
                Approve a one-time spending limit of ${m.purchase_amount.amount_usd.toFixed(2)} USD for this run only?
              </p>
              {m.spending_limit?.max_amount_usd !== undefined && (
                <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 2px" }}>
                  Default collar limit: ${m.spending_limit.max_amount_usd.toFixed(2)} — this does not change the collar.
                </p>
              )}
              <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: 0 }}>This applies only to this run.</p>
            </div>
            {stepUpError && <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{stepUpError}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleConfirmStepUp} disabled={stepUpWorking} className="a-btn a-btn--primary">
                {stepUpWorking ? "Approving…" : "Approve one-time limit"}
              </button>
              <button onClick={() => setStepUpState("idle")} className="a-btn a-btn--ghost">Cancel</button>
            </div>
          </div>
        )}

        <SectionCard label="Approving this will">
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.6 }}>
            · Create a signed execution receipt linked to your decision<br />
            · Execute the route within your collar boundaries — sensitive steps are Antigen-verified
          </p>
        </SectionCard>

        <div style={{ display: "flex", gap: 10 }}>
          {isBlocked && !stepUpApproved ? (
            <>
              {stepUpState === "idle" && (
                <button onClick={() => setStepUpState("confirming")} disabled={rejecting} className="a-btn a-btn--ghost">
                  Request higher limit
                </button>
              )}
              <button onClick={handleReject} disabled={approving || rejecting} className="a-btn a-btn--danger">
                {rejecting ? "Rejecting…" : "Reject"}
              </button>
            </>
          ) : (
            <>
              <button onClick={handleApprove} disabled={approving || rejecting} className="a-btn a-btn--primary">
                {approving ? "Approving…" : m?.primary_action_label ?? "Approve"}
              </button>
              <button onClick={handleReject} disabled={approving || rejecting} className="a-btn a-btn--danger">
                {rejecting ? "Rejecting…" : "Reject"}
              </button>
            </>
          )}
        </div>

        <TechnicalDetails run={run} />
      </div>
    </div>
  );
}

// ── Auth session card ──────────────────────────────────────────────────────────

function PendingAuthSessionCard({
  session, onApprove, onReject,
}: {
  session: AuthenticatedSessionHandleView;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  async function handleApprove() { setApproving(true); try { await onApprove(); } finally { setApproving(false); } }
  async function handleReject() { setRejecting(true); try { await onReject(); } finally { setRejecting(false); } }

  return (
    <div className="apr-card apr-card--blue">
      <div className="apr-card__head">
        <div>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>Antigen Login Request</p>
          <p style={{ fontSize: 11.5, color: "var(--blue)", fontFamily: "monospace", margin: 0 }}>{session.domain}</p>
        </div>
        <span className="a-status a-status--amber" style={{ flexShrink: 0 }}>Waiting</span>
      </div>
      <div className="apr-card__body">
        <SectionCard label="Task">
          <p style={{ fontSize: 13, color: "var(--ink-1)", margin: 0 }}>{session.task_summary}</p>
        </SectionCard>

        <SectionCard label="Credential & session custody">
          <CheckList items={[
            "Antigen uses your stored credential to log in — you are not sharing your password with Claude.",
            "Claude does not see the password at any point.",
            "Claude does not receive cookies, session tokens, or browser storage.",
            "Antigen returns only an authenticated_session_id handle to Claude.",
          ]} />
        </SectionCard>

        <SectionCard label="Approving this will">
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.6 }}>
            · Create a signed approval receipt recording your decision<br />
            · Antigen performs the login using your vault credential — the agent receives only a session handle
            {session.expires_at && <><br />· Session handle expires {formatExpiry(session.expires_at)}</>}
          </p>
        </SectionCard>

        <div style={{ display: "flex", gap: 10 }}>
          <button disabled={approving || rejecting} onClick={handleApprove} className="a-btn a-btn--primary">
            {approving ? "Approving…" : "Approve login"}
          </button>
          <button disabled={approving || rejecting} onClick={handleReject} className="a-btn a-btn--danger">
            {rejecting ? "Rejecting…" : "Reject"}
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{session.session_id}</p>
      </div>
    </div>
  );
}

// ── Injection card ─────────────────────────────────────────────────────────────

function PendingInjectionCard({
  injection, onApprove, onDeny,
}: {
  injection: SecretFieldInjectionView;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);

  const isPassword = injection.field_kind === "password";
  const fieldKindStyle: React.CSSProperties = isPassword
    ? { background: "var(--red-soft)", color: "oklch(0.45 0.13 25)", border: "1px solid var(--red-ring)" }
    : { background: "var(--blue-soft)", color: "oklch(0.42 0.12 245)", border: "1px solid var(--blue-ring)" };
  const provider = findCredentialProviderByDomain(injection.domain);
  const safetyCopy = getInjectionSafetyCopy({
    provider_display_name: provider?.display_name ?? injection.domain,
    injection_domain: injection.domain,
  });

  return (
    <div className="apr-card apr-card--green">
      <div className="apr-card__head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>Secret Field Injection</p>
            {provider && (
              <span style={{ ...fieldKindStyle, fontSize: 11, fontWeight: 500, padding: "1px 7px", borderRadius: 999 }}>
                {provider.display_name}
              </span>
            )}
          </div>
          <p style={{ fontSize: 11.5, color: "oklch(0.42 0.09 150)", fontFamily: "monospace", margin: 0 }}>{injection.domain}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ ...fieldKindStyle, fontSize: 11, fontWeight: 500, padding: "2px 9px", borderRadius: 999, fontFamily: "monospace" }}>
            {injection.field_kind}
          </span>
          <span className="a-status a-status--amber">Waiting</span>
        </div>
      </div>

      <div className="apr-card__body">
        <SectionCard label="Agent reason">
          <p style={{ fontSize: 13, color: "var(--ink-1)", margin: 0 }}>{injection.reason}</p>
        </SectionCard>

        <SectionCard label="Target page">
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "monospace", margin: "0 0 6px", wordBreak: "break-all" }}>{injection.page_url}</p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>{safetyCopy}</p>
        </SectionCard>

        <SectionCard label="Credential custody">
          <CheckList items={[
            "Antigen resolves the credential server-side via KMS — the agent never sees the value.",
            "The value flows directly from the Antigen API into the browser field via CDP.",
            "The agent receives only injection metadata (id, status, field_kind). No raw value.",
            "raw_value_revealed_to_agent: false — enforced as a TypeScript literal type on every response.",
          ]} />
        </SectionCard>

        <SectionCard label="Approving this will">
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.6 }}>
            · Create a signed UserApprovalReceipt recording your decision<br />
            · Create a temporary SensitiveGrant — Antigen injects the secret directly, the raw value is never revealed to the agent
            {injection.expires_at && <><br />· Grant expires {formatExpiry(injection.expires_at)}</>}
            <br />· Revoke active grants from{" "}
            <a href="/sensitive-grants" style={{ color: "var(--blue)" }}>Sensitive Grants</a>
          </p>
        </SectionCard>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            disabled={approving || denying}
            onClick={async () => { setApproving(true); try { await onApprove(); } finally { setApproving(false); } }}
            className="a-btn a-btn--primary"
          >
            {approving ? "Approving…" : `Approve ${injection.field_kind} fill`}
          </button>
          <button
            disabled={approving || denying}
            onClick={async () => { setDenying(true); try { await onDeny(); } finally { setDenying(false); } }}
            className="a-btn a-btn--danger"
          >
            {denying ? "Denying…" : "Deny"}
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{injection.injection_request_id}</p>
      </div>
    </div>
  );
}

// ── Cred auth card ─────────────────────────────────────────────────────────────

function PendingCredAuthCard({
  auth, onApprove, onDeny,
}: {
  auth: CredentialUseAuthorizationView;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);
  const provider = findCredentialProviderByDomain(auth.domain);
  const providerLabel = provider ? `${provider.display_name} · ${auth.pass_label}` : auth.pass_label;

  return (
    <div className="apr-card apr-card--blue">
      <div className="apr-card__head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>Login credential request</p>
            {provider && (
              <span style={{ background: "var(--blue-soft)", color: "oklch(0.42 0.12 245)", border: "1px solid var(--blue-ring)", fontSize: 11, fontWeight: 500, padding: "1px 7px", borderRadius: 999 }}>
                {provider.display_name}
              </span>
            )}
          </div>
          <p style={{ fontSize: 11.5, color: "oklch(0.42 0.12 245)", fontFamily: "monospace", margin: 0 }}>{auth.domain}</p>
        </div>
        <span className="a-status a-status--amber" style={{ flexShrink: 0 }}>Waiting</span>
      </div>

      <div className="apr-card__body">
        <SectionCard label="Account">
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>{providerLabel}</p>
          {auth.pass_username && (
            <p style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "monospace", margin: 0 }}>{auth.pass_username}</p>
          )}
        </SectionCard>

        <SectionCard label="This approval covers">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {auth.allowed_field_kinds.map((kind) => (
              <span key={kind} style={{
                background: kind === "password" ? "var(--red-soft)" : "var(--blue-soft)",
                color: kind === "password" ? "oklch(0.45 0.13 25)" : "oklch(0.42 0.12 245)",
                border: `1px solid ${kind === "password" ? "var(--red-ring)" : "var(--blue-ring)"}`,
                fontSize: 11, fontWeight: 500, padding: "2px 9px", borderRadius: 999, fontFamily: "monospace",
              }}>
                {kind} (max {auth.max_uses_per_field[kind] ?? 1}×)
              </span>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0, lineHeight: 1.5 }}>
            One approval for this login attempt. Expires 5 minutes after approval. Each field can be filled once — after both are filled the authorization is closed.
          </p>
        </SectionCard>

        <SectionCard label="Credential custody">
          <CheckList blue items={[
            "Antigen resolves credentials server-side via KMS — the agent never sees username or password.",
            "Values are injected directly into browser fields via CDP. No raw credential in any API response.",
            "The agent receives only injection metadata (id, status, field_kind). raw_values_revealed_to_agent: false.",
            "The agent owns all navigation and form submission. Antigen only fills the protected fields.",
            "Default Antigen agent browsers disable password/card saving. This approval does not authorize 'remember me', 'keep me signed in', 'trust this device', or saving credentials to the browser or website.",
          ]} />
        </SectionCard>

        <SectionCard label="Approving this will">
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.6 }}>
            · Create a signed UserApprovalReceipt recording your decision<br />
            · Create a temporary SensitiveGrant — Antigen injects credentials directly, the raw values are never revealed to the agent
            {auth.expires_at && <><br />· Grant expires {formatExpiry(auth.expires_at)}</>}
            <br />· Revoke active grants from{" "}
            <a href="/sensitive-grants" style={{ color: "var(--blue)" }}>Sensitive Grants</a>
          </p>
        </SectionCard>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            disabled={approving || denying}
            onClick={async () => { setApproving(true); try { await onApprove(); } finally { setApproving(false); } }}
            className="a-btn a-btn--primary"
          >
            {approving ? "Approving…" : `Allow use of ${providerLabel}`}
          </button>
          <button
            disabled={approving || denying}
            onClick={async () => { setDenying(true); try { await onDeny(); } finally { setDenying(false); } }}
            className="a-btn a-btn--danger"
          >
            {denying ? "Denying…" : "Deny"}
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{auth.authorization_id}</p>
      </div>
    </div>
  );
}

// ── Payment Card Fill Auth card ───────────────────────────────────────────────

const SENSITIVE_CARD_FIELDS = new Set<PaymentCardField>(["card_number", "cvv"]);
const CARD_FIELD_LABELS: Record<PaymentCardField, string> = {
  card_number: "card number",
  cvv: "CVV",
  expiry_month: "expiry month",
  expiry_year: "expiry year",
  expiry_combined: "expiry (MM/YY)",
  cardholder_name: "cardholder name",
  billing_zip: "billing ZIP",
};

function PendingCardFillAuthCard({
  auth, onApprove, onDeny,
}: {
  auth: PaymentCardFillAuthorizationView;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);

  return (
    <div className="apr-card apr-card--amber">
      <div className="apr-card__head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>Payment card fill request</p>
            {auth.is_default && (
              <span style={{ background: "var(--amber-soft, oklch(0.97 0.05 90))", color: "oklch(0.45 0.12 75)", border: "1px solid oklch(0.85 0.08 90)", fontSize: 11, fontWeight: 500, padding: "1px 7px", borderRadius: 999 }}>
                default
              </span>
            )}
          </div>
          <p style={{ fontSize: 11.5, color: "oklch(0.45 0.12 75)", fontFamily: "monospace", margin: 0 }}>{auth.domain}</p>
        </div>
        <span className="a-status a-status--amber" style={{ flexShrink: 0 }}>Waiting</span>
      </div>

      <div className="apr-card__body">
        <SectionCard label="Payment method">
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>
            {auth.payment_method_label} ···{auth.last4}
          </p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
            Fields requested: {auth.allowed_fields.map((f) => CARD_FIELD_LABELS[f] ?? f).join(", ")}
          </p>
        </SectionCard>

        <SectionCard label="Fields to fill">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {auth.allowed_fields.map((field) => {
              const isSensitive = SENSITIVE_CARD_FIELDS.has(field);
              return (
                <span key={field} style={{
                  background: isSensitive ? "var(--red-soft)" : "oklch(0.97 0.01 0)",
                  color: isSensitive ? "oklch(0.45 0.13 25)" : "var(--ink-2)",
                  border: `1px solid ${isSensitive ? "var(--red-ring)" : "oklch(0.88 0.01 0)"}`,
                  fontSize: 11, fontWeight: 500, padding: "2px 9px", borderRadius: 999, fontFamily: "monospace",
                }}>
                  {CARD_FIELD_LABELS[field] ?? field}
                </span>
              );
            })}
          </div>
          {auth.fields_filled.length > 0 && (
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              Already filled: {auth.fields_filled.map((f) => CARD_FIELD_LABELS[f] ?? f).join(", ")}
            </p>
          )}
        </SectionCard>

        <SectionCard label="Important">
          <div style={{ background: "oklch(0.97 0.05 90)", border: "1px solid oklch(0.85 0.08 90)", borderRadius: 8, padding: "10px 14px", marginBottom: 4 }}>
            <p style={{ fontSize: 12.5, color: "oklch(0.42 0.12 75)", fontWeight: 600, margin: "0 0 4px" }}>
              This fills card details only.
            </p>
            <p style={{ fontSize: 12, color: "oklch(0.45 0.10 75)", margin: 0, lineHeight: 1.55 }}>
              It does not authorize a purchase. A separate approval is required before any payment is submitted.
            </p>
          </div>
        </SectionCard>

        <SectionCard label="Card data custody">
          <CheckList items={[
            "Antigen resolves card_number and CVV server-side via KMS — the agent never sees the raw value.",
            "Values are injected directly into browser fields via CDP. No raw card data in any API response.",
            "card_number and CVV fields are masked in the DOM after fill (agent cannot read them back).",
            "The agent owns all navigation and form submission. Antigen only fills the requested fields.",
            "This approval covers card FIELD FILL only — not a purchase, charge, or any liability action.",
          ]} />
        </SectionCard>

        <SectionCard label="Approving this will">
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.6 }}>
            · Create a signed UserApprovalReceipt recording your decision<br />
            · Create a temporary SensitiveGrant — Antigen injects card fields directly, raw values never revealed<br />
            {auth.expires_at && <span>· Grant expires {formatExpiry(auth.expires_at)}<br /></span>}
            · Does NOT authorize any purchase, payment, or form submission
          </p>
        </SectionCard>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            disabled={approving || denying}
            onClick={async () => { setApproving(true); try { await onApprove(); } finally { setApproving(false); } }}
            className="a-btn a-btn--primary"
          >
            {approving ? "Approving…" : `Allow card fill for ${auth.payment_method_label} ···${auth.last4}`}
          </button>
          <button
            disabled={approving || denying}
            onClick={async () => { setDenying(true); try { await onDeny(); } finally { setDenying(false); } }}
            className="a-btn a-btn--danger"
          >
            {denying ? "Denying…" : "Deny"}
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{auth.authorization_id}</p>
      </div>
    </div>
  );
}

// ── Purchase confirmation card ─────────────────────────────────────────────────

function PurchaseConfirmationApprovalCard({
  auth, onApprove, onDeny,
}: {
  auth: PurchaseConfirmationAuthorizationView;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
}) {
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);
  const [approved, setApproved] = useState(false);

  const amountDisplay = auth.amount_unknown
    ? null
    : auth.amount != null
    ? `${auth.currency} ${auth.amount.toFixed(2)}`
    : null;

  return (
    <div className="apr-card apr-card--red">
      <div className="apr-card__head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>Purchase confirmation</p>
            <span style={{ background: "var(--red-soft)", color: "oklch(0.45 0.13 25)", border: "1px solid var(--red-ring)", fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999, letterSpacing: 0.3 }}>
              CRITICAL
            </span>
          </div>
          <p style={{ fontSize: 11.5, color: "oklch(0.45 0.13 25)", fontFamily: "monospace", margin: 0 }}>{auth.domain}</p>
        </div>
        <span className="a-status a-status--red" style={{ flexShrink: 0 }}>Waiting</span>
      </div>

      <div className="apr-card__body">

        {/* Amount — large and prominent */}
        <div style={{ background: auth.amount_unknown ? "var(--red-soft)" : "oklch(0.97 0.02 150)", border: `1px solid ${auth.amount_unknown ? "var(--red-ring)" : "oklch(0.88 0.03 150)"}`, borderRadius: 10, padding: "16px 20px", marginBottom: 4 }}>
          {auth.amount_unknown ? (
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: "oklch(0.45 0.13 25)", textTransform: "uppercase", letterSpacing: 0.4, margin: "0 0 4px" }}>⚠ Amount unknown</p>
              <p style={{ fontSize: 14, color: "oklch(0.45 0.13 25)", margin: 0, lineHeight: 1.5 }}>
                The agent could not determine the purchase amount. Verify the cart total in your browser before approving.
              </p>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: "oklch(0.42 0.09 150)", textTransform: "uppercase", letterSpacing: 0.4, margin: "0 0 4px" }}>Total</p>
              <p style={{ fontSize: 32, fontWeight: 700, color: "var(--ink-1)", margin: 0, lineHeight: 1 }}>{amountDisplay}</p>
            </div>
          )}
        </div>

        <SectionCard label="Merchant">
          <p style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>{auth.merchant}</p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>{auth.item_summary}</p>
        </SectionCard>

        <SectionCard label="Payment method">
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>
            {auth.payment_method_label} ···{auth.payment_method_last4}
          </p>
        </SectionCard>

        <SectionCard label="Button that will be clicked">
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: 6, padding: "6px 14px" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.13 25)", fontFamily: "monospace" }}>{auth.button_text}</span>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: "6px 0 0" }}>Antigen will click exactly this button. No other buttons will be clicked.</p>
        </SectionCard>

        <SectionCard label="Warning">
          <div style={{ background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: 8, padding: "10px 14px" }}>
            <p style={{ fontSize: 12.5, color: "oklch(0.45 0.13 25)", fontWeight: 700, margin: "0 0 4px" }}>
              Approving this may complete a purchase, payment, or subscription.
            </p>
            <p style={{ fontSize: 12, color: "oklch(0.45 0.10 25)", margin: 0, lineHeight: 1.55 }}>
              This is separate from the card fill approval. Approving this authorizes the final payment submission action.
            </p>
          </div>
        </SectionCard>

        {auth.card_fill_authorization_id && (
          <SectionCard label="Linked to card fill">
            <p style={{ fontSize: 12, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{auth.card_fill_authorization_id}</p>
          </SectionCard>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button
            disabled={approving || denying || approved}
            onClick={async () => {
              setApproving(true);
              try {
                await onApprove();
                setApproved(true);
              } finally {
                setApproving(false);
              }
            }}
            className="a-btn a-btn--danger"
            style={{ opacity: approved ? 0.7 : 1 }}
          >
            {approved ? "Approved" : approving ? "Approving…" : "Approve payment submission"}
          </button>
          <button
            disabled={approving || denying || approved}
            onClick={async () => { setDenying(true); try { await onDeny(); } finally { setDenying(false); } }}
            className="a-btn a-btn--ghost"
          >
            {denying ? "Denying…" : "Deny"}
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{auth.purchase_confirmation_id}</p>
      </div>
    </div>
  );
}

// ── Challenge card ─────────────────────────────────────────────────────────────

function PendingChallengeCard({
  challenge, onSubmitCode, onComplete, onCancel, emailResolverStatus,
}: {
  challenge: SecurityChallengeView;
  onSubmitCode: (code: string) => Promise<void>;
  onComplete: () => Promise<void>;
  onCancel: () => Promise<void>;
  emailResolverStatus: EmailResolverStatusView | null;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [emailResolution, setEmailResolution] = useState<ChallengeEmailResolutionView | null>(null);
  const [emailSearching, setEmailSearching] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [isExpired, setIsExpired] = useState(
    challenge.status === "expired" || new Date(challenge.expires_at) < new Date(),
  );
  useEffect(() => {
    if (isExpired) return;
    const ms = new Date(challenge.expires_at).getTime() - Date.now();
    if (ms <= 0) { setIsExpired(true); return; }
    const t = setTimeout(() => setIsExpired(true), ms);
    return () => clearTimeout(t);
  }, [challenge.expires_at, isExpired]);

  const challengeLabel: Record<string, string> = {
    email_device_verification: "Email verification",
    sms_code: "SMS code",
    totp: "Authenticator code",
    device_verification: "Device verification",
    passkey: "Passkey",
    captcha: "CAPTCHA",
    unknown: "Security challenge",
  };

  async function handleSubmit() {
    if (!code.trim()) return;
    setSubmitting(true);
    try {
      await onSubmitCode(code.trim());
      setCode("");
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFindInGmail() {
    setEmailSearching(true);
    setEmailError(null);
    try {
      const res = await startChallengeEmailResolution(challenge.challenge_id);
      setEmailResolution(res);
    } catch (err: unknown) {
      setEmailError(err instanceof Error ? err.message : "Gmail search failed.");
    } finally {
      setEmailSearching(false);
    }
  }

  async function handleCancelEmailResolution() {
    if (!emailResolution) return;
    try {
      await cancelChallengeEmailResolution(emailResolution.resolution_id);
      setEmailResolution(null);
    } catch { /* ignore */ }
  }

  const isEmailTypeChallenge = challenge.challenge_type === "email_device_verification";

  function renderEmailResolverSection() {
    if (!isEmailTypeChallenge || isExpired) return null;

    if (!emailResolverStatus?.connected) {
      return (
        <SectionCard label="Or: Find code automatically">
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>Gmail resolver is not connected.</p>
        </SectionCard>
      );
    }

    if (!emailResolution || emailResolution.status === "cancelled") {
      return (
        <SectionCard label="Or: Find code automatically">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              disabled={emailSearching || submitted}
              onClick={handleFindInGmail}
              className="a-btn a-btn--primary"
              style={{ alignSelf: "flex-start" }}
            >
              {emailSearching ? "Searching Gmail…" : "Find code in connected Gmail"}
            </button>
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              Antigen only searches for this live verification request after you approve. The code is never shown to the agent.
            </p>
            {emailError && <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{emailError}</p>}
          </div>
        </SectionCard>
      );
    }

    const { status, sender_domain, received_at, error, email_search_error_code } = emailResolution;

    if (status === "code_found") {
      const seconds = received_at
        ? Math.round((Date.now() - new Date(received_at).getTime()) / 1000)
        : null;
      return (
        <div style={{ background: "var(--green-soft)", border: "1px solid var(--green-ring)", borderRadius: "var(--r-2)", padding: "12px 16px" }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.42 0.09 150)", margin: "0 0 2px" }}>Code found</p>
          <p style={{ fontSize: 12, color: "oklch(0.42 0.09 150)", margin: "0 0 2px" }}>
            From {sender_domain ?? "unknown domain"}{seconds !== null ? `, received ${seconds}s ago` : ""}.
          </p>
          <p style={{ fontSize: 11.5, color: "oklch(0.42 0.09 150)", opacity: 0.75, margin: 0 }}>
            The agent will inject it when it calls inject_challenge_email_code.
          </p>
        </div>
      );
    }

    if (status === "injected") {
      return (
        <div style={{ background: "var(--green-soft)", border: "1px solid var(--green-ring)", borderRadius: "var(--r-2)", padding: "12px 16px" }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.42 0.09 150)", margin: "0 0 2px" }}>Code injected.</p>
          <p style={{ fontSize: 12, color: "oklch(0.42 0.09 150)", opacity: 0.75, margin: 0 }}>
            The agent will click Verify/Continue in the browser.
          </p>
        </div>
      );
    }

    if (status === "not_found") {
      return (
        <SectionCard label="Or: Find code automatically">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>No code found in recent emails. Enter the code manually below.</p>
            <button onClick={handleFindInGmail} disabled={emailSearching} className="a-btn a-btn--ghost" style={{ alignSelf: "flex-start", fontSize: 12 }}>
              {emailSearching ? "Searching…" : "Try again"}
            </button>
          </div>
        </SectionCard>
      );
    }

    if (status === "failed") {
      const isReconnectRequired = email_search_error_code === "GMAIL_RECONNECT_REQUIRED";
      return (
        <SectionCard label="Email search unavailable">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {isReconnectRequired ? (
              <>
                <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", fontWeight: 500, margin: 0 }}>
                  Your Gmail connection expired or was revoked. Reconnect Gmail to let Antigen find verification codes automatically.
                </p>
                <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
                  Reconnect Gmail is not available in this local build. You can still enter the code manually below.
                </p>
                <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>
                  Developer note: update <code>GOOGLE_REFRESH_TOKEN</code> and restart Antigen.
                </p>
              </>
            ) : (
              <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>
                Gmail search is currently unavailable.
              </p>
            )}
            <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: 0 }}>
              You can still enter the code manually below. The agent will never see it.
            </p>
          </div>
        </SectionCard>
      );
    }

    return null;
  }

  if (isExpired) {
    return (
      <div className="apr-card" style={{ opacity: 0.6 }}>
        <div className="apr-card__head">
          <div>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-3)", margin: "0 0 2px" }}>
              {challengeLabel[challenge.challenge_type] ?? "Security challenge"}
            </p>
            <p style={{ fontSize: 11.5, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{challenge.domain}</p>
          </div>
          <span className="a-status a-status--quiet" style={{ flexShrink: 0 }}>Expired</span>
        </div>
        <div className="apr-card__body">
          <div className="apr-box">
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              This verification request expired. Start the login again to request a new code.
            </p>
          </div>
          <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{challenge.challenge_id}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="apr-card apr-card--amber">
      <div className="apr-card__head">
        <div>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>
            {challengeLabel[challenge.challenge_type] ?? "Security challenge"}
          </p>
          <p style={{ fontSize: 11.5, color: "oklch(0.45 0.12 75)", fontFamily: "monospace", margin: 0 }}>{challenge.domain}</p>
        </div>
        <span className="a-status a-status--amber" style={{ flexShrink: 0 }}>
          <span className="a-status__dot" />{submitted ? "Code submitted" : "Waiting for you"}
        </span>
      </div>

      <div className="apr-card__body">
        <SectionCard label="What's happening">
          <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: "0 0 4px" }}>{challenge.instructions}</p>
          {challenge.masked_destination && (
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              Code sent to <span style={{ fontFamily: "monospace", color: "var(--ink-2)" }}>{challenge.masked_destination}</span>
            </p>
          )}
        </SectionCard>

        <SectionCard label="Antigen guarantees">
          <CheckList items={[
            "Enter the code here — do not paste it into the agent chat.",
            "Antigen injects the code directly into the browser field once.",
            "The agent never sees the code.",
            "Code expires immediately after injection.",
            "Submitting creates a signed approval receipt. The raw code is not stored in the receipt or grant.",
          ]} />
        </SectionCard>

        {renderEmailResolverSection()}

        {!submitted ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 12, color: "var(--ink-3)" }}>Or enter code manually</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
                placeholder="Enter code…"
                maxLength={10}
                disabled={submitting}
                className="ag-input"
                style={{ fontFamily: "monospace", letterSpacing: "0.12em", flex: 1 }}
              />
              <button disabled={submitting || !code.trim()} onClick={handleSubmit} className="a-btn a-btn--ghost">
                {submitting ? "Injecting…" : "Inject code"}
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              The agent will click Verify/Continue after Antigen fills the field.
            </p>
          </div>
        ) : (
          <p style={{ fontSize: 12.5, color: "oklch(0.42 0.09 150)", margin: 0 }}>
            Code submitted. Antigen will inject it into the browser field when the agent calls inject_security_challenge_code.
          </p>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button
            disabled={submitting || completing || cancelling}
            onClick={async () => { setCompleting(true); try { await onComplete(); } finally { setCompleting(false); } }}
            className="a-btn a-btn--ghost"
          >
            {completing ? "Marking done…" : "I completed it in the browser"}
          </button>
          <button
            disabled={submitting || completing || cancelling}
            onClick={async () => { setCancelling(true); try { await onCancel(); } finally { setCancelling(false); } }}
            className="a-btn a-btn--danger"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{challenge.challenge_id}</p>
      </div>
    </div>
  );
}

// ── Login diagnostic card ──────────────────────────────────────────────────────

function LoginDiagnosticCard({
  diagnostic,
  onDismiss,
}: {
  diagnostic: LoginDiagnosticView;
  onDismiss: () => void;
}) {
  const isInvalidCreds = diagnostic.outcome === "invalid_credentials";
  const isChallengeRequired = diagnostic.outcome === "manual_challenge_required";
  const outcomeLabel =
    isInvalidCreds ? "Wrong credentials" :
    isChallengeRequired ? "Verification required" :
    diagnostic.outcome === "captcha_required" ? "CAPTCHA detected" :
    diagnostic.outcome === "rate_limited" ? "Rate limited" :
    "Login failed";

  return (
    <div
      className="apr-card"
      style={{
        borderColor: isInvalidCreds ? "var(--amber-ring)" : "var(--hairline)",
        background: isInvalidCreds ? "var(--amber-soft)" : "rgba(255,255,255,0.78)",
      }}
    >
      <div className="apr-card__head" style={{ alignItems: "flex-start" }}>
        <div>
          <span className="a-status a-status--amber" style={{ marginBottom: 8, display: "inline-flex" }}>
            {outcomeLabel}
          </span>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "6px 0 2px" }}>
            {diagnostic.pass_label ?? diagnostic.domain}
          </p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0, fontFamily: "monospace" }}>
            {diagnostic.domain} · {new Date(diagnostic.detected_at).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={onDismiss}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-4)", fontSize: 16, padding: "0 0 0 8px", flexShrink: 0 }}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      <div className="apr-card__body">
        <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 12px", lineHeight: 1.55 }}>
          {diagnostic.user_message}
        </p>
        <div style={{ background: "var(--green-soft)", border: "1px solid var(--green-ring)", borderRadius: "var(--r-2)", padding: "10px 14px", marginBottom: 14 }}>
          <p style={{ fontSize: 12.5, color: "oklch(0.42 0.09 150)", margin: 0, lineHeight: 1.5 }}>
            The agent never saw your password — credentials remain in your vault.
          </p>
        </div>
        <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "0 0 14px", lineHeight: 1.5 }}>
          <strong style={{ color: "var(--ink-2)" }}>Recommended:</strong> {diagnostic.recommended_action}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {isInvalidCreds && (
            <a href="/passes" className="a-btn a-btn--primary" style={{ fontSize: 13 }}>
              Update saved credential
            </a>
          )}
          <button onClick={onDismiss} className="a-btn a-btn--ghost" style={{ fontSize: 13 }}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Active grants panel ────────────────────────────────────────────────────────

function ActiveGrantsPanel({ grants }: { grants: SensitiveGrant[] }) {
  const displayed = grants.slice(0, 5);
  const remaining = grants.length - displayed.length;
  return (
    <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 24, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)" }}>Temporary access you approved</span>
          {grants.length > 0 && (
            <span className="a-status a-status--quiet">{grants.length}</span>
          )}
        </div>
        <a href="/sensitive-grants" style={{ fontSize: 12, color: "var(--blue)", textDecoration: "none" }}>View all →</a>
      </div>
      {grants.length === 0 ? (
        <div>
          <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: "0 0 4px" }}>No active temporary access.</p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0, lineHeight: 1.5 }}>
            When you approve access for a limited time, it will appear here so you can revoke it early.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {displayed.map((g) => (
            <div key={g.grant_id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "rgba(255,255,255,0.65)", border: "1px solid var(--hairline)",
              borderRadius: "var(--r-2)", padding: "10px 16px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "oklch(0.42 0.09 150)", fontSize: 10 }}>●</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{g.scope.domain}</span>
                <span style={{ fontSize: 12, color: "var(--hairline)" }}>·</span>
                <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                  {g.grant_type === "credential_injection" ? "credential injection" : "challenge relay"}
                </span>
              </div>
              <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{formatExpiry(g.expires_at)}</span>
            </div>
          ))}
          {remaining > 0 && (
            <p style={{ fontSize: 12, color: "var(--ink-4)", textAlign: "center", margin: 0 }}>and {remaining} more</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Profile memory request card ───────────────────────────────────────────────

const PROFILE_FIELD_LABELS: Record<string, string> = {
  first_name: "First name",
  last_name: "Last name",
  email: "Email address",
  phone: "Phone number",
  shipping_address_line1: "Street address",
  shipping_address_line2: "Address line 2 (optional)",
  city: "City",
  region: "State / Province",
  postal_code: "Postal code",
  country: "Country",
};

function profileFieldInputType(field: string): string {
  if (field === "email") return "email";
  if (field === "phone") return "tel";
  return "text";
}

function PendingProfileMemoryRequestCard({
  req,
  onSaved,
  onCancelled,
}: {
  req: ProfileMemoryRequestView;
  onSaved: () => void;
  onCancelled: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(req.missing_fields.map((f) => [f, ""])),
  );
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  function setValue(field: string, val: string) {
    setValues((prev) => ({ ...prev, [field]: val }));
  }

  const allFilled = req.missing_fields.every((f) => (values[f] ?? "").trim() !== "");

  async function handleSave() {
    if (saving || !allFilled) return;
    setSaving(true);
    try {
      await submitProfileMemoryRequest(req.request_id, values, true);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelProfileMemoryRequest(req.request_id);
      onCancelled();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="apr-card apr-card--amber">
      <div className="apr-card__head">
        <div>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>
            Profile information needed
          </p>
          <p style={{ fontSize: 11.5, color: "oklch(0.45 0.12 75)", fontFamily: "monospace", margin: 0 }}>{req.domain}</p>
        </div>
        <span className="a-status a-status--amber" style={{ flexShrink: 0 }}>Waiting</span>
      </div>

      <div className="apr-card__body">
        <SectionCard label="Why Antigen needs this">
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0, lineHeight: 1.55 }}>{req.reason}</p>
        </SectionCard>

        <SectionCard label="Provide missing values">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {req.missing_fields.map((field) => (
              <div key={field}>
                <label style={{ fontSize: 12, color: "var(--ink-3)", display: "block", marginBottom: 4 }}>
                  {PROFILE_FIELD_LABELS[field] ?? field}
                </label>
                <input
                  type={profileFieldInputType(field)}
                  value={values[field] ?? ""}
                  onChange={(e) => setValue(field, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && allFilled) handleSave(); }}
                  placeholder={PROFILE_FIELD_LABELS[field] ?? field}
                  disabled={saving}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    background: "var(--surface-1)", border: "1px solid var(--hairline)",
                    borderRadius: "var(--r-2)", padding: "8px 12px",
                    fontSize: 13, color: "var(--ink-1)",
                    fontFamily: "inherit",
                  }}
                />
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard label="Privacy">
          <CheckList items={[
            "Antigen encrypts these values with KMS — raw values are never returned to the agent.",
            "Values are injected directly into the website form. The agent only receives masked summaries.",
            "You can update stored profile values at any time.",
          ]} />
        </SectionCard>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            disabled={saving || cancelling || !allFilled}
            onClick={handleSave}
            className="a-btn a-btn--primary"
          >
            {saving ? "Saving…" : "Save to Antigen"}
          </button>
          <button
            disabled={saving || cancelling}
            onClick={handleCancel}
            className="a-btn a-btn--ghost"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{req.request_id}</p>
      </div>
    </div>
  );
}

function PendingAccountCreationCard({
  req,
  onApproved,
  onDenied,
}: {
  req: AccountCreationRequestView;
  onApproved: () => void;
  onDenied: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);
  const [approved, setApproved] = useState(false);

  async function handleApprove() {
    if (approving || denying) return;
    setApproving(true);
    try {
      await approveAccountCreationRequest(req.request_id, {
        email_strategy: "primary_email",
        password_strategy: "aegis_generated",
      });
      setApproved(true);
      onApproved();
    } finally {
      setApproving(false);
    }
  }

  async function handleDeny() {
    if (approving || denying) return;
    setDenying(true);
    try {
      await denyAccountCreationRequest(req.request_id);
      onDenied();
    } finally {
      setDenying(false);
    }
  }

  const expiresAt = req.expires_at ? new Date(req.expires_at) : null;
  const isExpired = expiresAt !== null && expiresAt <= new Date();

  return (
    <div className="apr-card apr-card--amber">
      <div className="apr-card__head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>
              Account Creation Request
            </p>
            <span style={{
              background: "oklch(0.97 0.03 75)",
              color: "oklch(0.45 0.12 75)",
              border: "1px solid oklch(0.88 0.06 75)",
              fontSize: 11,
              fontWeight: 700,
              padding: "1px 7px",
              borderRadius: 999,
            }}>
              NEEDS APPROVAL
            </span>
          </div>
          <p style={{ fontSize: 11.5, color: "oklch(0.45 0.12 75)", fontFamily: "monospace", margin: 0 }}>
            {req.domain}
          </p>
        </div>
        <span className="a-status a-status--amber" style={{ flexShrink: 0 }}>
          {isExpired ? "Expired" : approved ? "Approved" : "Waiting"}
        </span>
      </div>

      <div className="apr-card__body">
        <SectionCard label="Why the agent needs an account">
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0, lineHeight: 1.55 }}>{req.reason}</p>
        </SectionCard>

        <SectionCard label="Signup page">
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "monospace", margin: 0, wordBreak: "break-all" }}>
            {req.signup_url}
          </p>
        </SectionCard>

        <SectionCard label="Email">
          <p style={{ fontSize: 13, color: "var(--ink-1)", fontWeight: 600, margin: "0 0 4px" }}>
            Your Antigen primary email
          </p>
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
            Antigen uses the email stored in your profile. The agent never sees the raw email address.
          </p>
        </SectionCard>

        <SectionCard label="Password">
          <CheckList items={[
            "Antigen generates a strong random password (24 characters, ~143 bits of entropy).",
            "The password is stored in your vault immediately on approval — encrypted via KMS.",
            "The agent never sees the generated password. raw_password_revealed_to_agent: false.",
            "After approval, the agent fills the signup form using your vault credential via CDP injection.",
          ]} />
        </SectionCard>

        <SectionCard label="Approving this will">
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.7 }}>
            · Antigen generates and encrypts a password into your vault<br />
            · The agent fills the signup form using request_secret_field_injection<br />
            · The credential is saved for future logins to {req.domain}<br />
            {expiresAt && !isExpired && (
              <>· Request expires {expiresAt.toLocaleTimeString()}</>
            )}
          </p>
        </SectionCard>

        {isExpired ? (
          <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>
            This request has expired. The agent will need to request account access again.
          </p>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              disabled={approving || denying || approved}
              onClick={handleApprove}
              className="a-btn a-btn--primary"
            >
              {approving ? "Creating credential…" : approved ? "Approved" : "Approve and create credential"}
            </button>
            <button
              disabled={approving || denying || approved}
              onClick={handleDeny}
              className="a-btn a-btn--danger"
            >
              {denying ? "Denying…" : "Deny"}
            </button>
          </div>
        )}

        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{req.request_id}</p>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function RouteRunApprovalsPage() {
  const [runs, setRuns] = useState<RouteRunWithSummary[]>([]);
  const [credSessions, setCredSessions] = useState<CredentialSessionView[]>([]);
  const [authSessions, setAuthSessions] = useState<AuthenticatedSessionHandleView[]>([]);
  const [injections, setInjections] = useState<SecretFieldInjectionView[]>([]);
  const [credAuths, setCredAuths] = useState<CredentialUseAuthorizationView[]>([]);
  const [cardFillAuths, setCardFillAuths] = useState<PaymentCardFillAuthorizationView[]>([]);
  const [purchaseConfirmations, setPurchaseConfirmations] = useState<PurchaseConfirmationAuthorizationView[]>([]);
  const [challenges, setChallenges] = useState<SecurityChallengeView[]>([]);
  const [profileMemReqs, setProfileMemReqs] = useState<ProfileMemoryRequestView[]>([]);
  const [accountCreationReqs, setAccountCreationReqs] = useState<AccountCreationRequestView[]>([]);
  const [emailResolverStatus, setEmailResolverStatus] = useState<EmailResolverStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contexts, setContexts] = useState<Map<string, RunApprovalContext>>(new Map());
  const [loadingContexts, setLoadingContexts] = useState<Set<string>>(new Set());
  const [activeGrants, setActiveGrants] = useState<SensitiveGrant[]>([]);
  const [lastDecision, setLastDecision] = useState<{ action: "approved" | "denied"; note: string } | null>(null);
  const [loginDiagnostics, setLoginDiagnostics] = useState<LoginDiagnosticView[]>([]);
  const [dismissedDiagnostics, setDismissedDiagnostics] = useState<Set<string>>(new Set());
  const [showDisclosure, setShowDisclosure] = useState(false);

  useEffect(() => {
    Promise.all([
      listRouteRuns({ status: "pending_approval" }),
      listCredentialSessions("pending_approval"),
      listAuthenticatedSessions("pending_approval"),
      listSecretFieldInjections("pending_approval"),
      listCredentialUseAuthorizations("pending_approval"),
      listSecurityChallenges(),
      getEmailResolverStatus().catch(() => null),
      listSensitiveGrants({ status: "active" }).catch(() => []),
      listLoginDiagnostics().catch(() => []),
      listPaymentCardFillAuthorizations("pending_approval").catch(() => []),
      listPurchaseConfirmationAuthorizations("pending_approval").catch(() => []),
      listProfileMemoryRequests("pending_user").catch(() => []),
      listAccountCreationRequests("pending_user").catch(() => []),
    ])
      .then(([r, s, a, inj, auths, chlgs, emailStatus, grants, diags, cardAuths, pconfs, pmreqs, acreqs]) => {
        setRuns(r);
        setCredSessions(s);
        setAuthSessions(a);
        setInjections(inj);
        setCredAuths(auths);
        setChallenges(chlgs);
        setEmailResolverStatus(emailStatus);
        setActiveGrants(grants);
        setLoginDiagnostics(diags);
        setCardFillAuths(cardAuths);
        setPurchaseConfirmations(pconfs);
        setProfileMemReqs(pmreqs);
        setAccountCreationReqs(acreqs);
        if (r.length > 0) {
          const ids = r.map((run) => run.run_id);
          setLoadingContexts(new Set(ids));
          ids.forEach((id) => {
            getApprovalContext(id)
              .then((ctx) => { setContexts((prev) => new Map(prev).set(id, ctx)); })
              .catch(() => { /* degraded gracefully */ })
              .finally(() => {
                setLoadingContexts((prev) => {
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                });
              });
          });
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (challenges.length === 0) return;
    const id = setInterval(async () => {
      try {
        const fresh = await listSecurityChallenges();
        setChallenges(fresh);
      } catch { /* non-fatal */ }
    }, 8000);
    return () => clearInterval(id);
  }, [challenges.length]);

  // Poll for login diagnostics every 10 seconds
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const fresh = await listLoginDiagnostics();
        setLoginDiagnostics(fresh);
      } catch { /* non-fatal */ }
    }, 10000);
    return () => clearInterval(id);
  }, []);

  async function handleApprove(runId: string) {
    setActionError(null);
    try {
      await approveRouteRun(runId);
      setRuns((prev) => prev.filter((r) => r.run_id !== runId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve run.");
    }
  }

  async function handleReject(runId: string) {
    setActionError(null);
    try {
      await rejectRouteRun(runId);
      setRuns((prev) => prev.filter((r) => r.run_id !== runId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to reject run.");
    }
  }

  function handleContextUpdate(runId: string, updated: RunApprovalContext) {
    setContexts((prev) => new Map(prev).set(runId, updated));
  }

  async function handleApproveCredSession(sessionId: string) {
    setActionError(null);
    try {
      await approveCredentialSession(sessionId);
      setCredSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve credential session.");
    }
  }

  async function handleApproveAuthSession(sessionId: string) {
    setActionError(null);
    try {
      await approveAuthenticatedSession(sessionId);
      setAuthSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
      setLastDecision({ action: "approved", note: "Login session approved. Antigen is logging in." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve login session.");
    }
  }

  async function handleRejectAuthSession(sessionId: string) {
    setActionError(null);
    try {
      await rejectAuthenticatedSession(sessionId);
      setAuthSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
      setLastDecision({ action: "denied", note: "Login session rejected." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to reject login session.");
    }
  }

  async function handleApproveInjection(id: string) {
    setActionError(null);
    try {
      await approveSecretFieldInjection(id);
      setInjections((prev) => prev.filter((i) => i.injection_request_id !== id));
      setLastDecision({ action: "approved", note: "Field injection approved. A SensitiveGrant is now active." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve injection.");
    }
  }

  async function handleDenyInjection(id: string) {
    setActionError(null);
    try {
      await denySecretFieldInjection(id);
      setInjections((prev) => prev.filter((i) => i.injection_request_id !== id));
      setLastDecision({ action: "denied", note: "Field injection denied." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to deny injection.");
    }
  }

  async function handleApproveCredAuth(id: string) {
    setActionError(null);
    try {
      await approveCredentialUseAuthorization(id);
      setCredAuths((prev) => prev.filter((a) => a.authorization_id !== id));
      setLastDecision({ action: "approved", note: "Credential authorization approved. A SensitiveGrant is now active." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to approve credential authorization.");
    }
  }

  async function handleDenyCredAuth(id: string) {
    setActionError(null);
    try {
      await denyCredentialUseAuthorization(id);
      setCredAuths((prev) => prev.filter((a) => a.authorization_id !== id));
      setLastDecision({ action: "denied", note: "Credential authorization denied." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to deny credential authorization.");
    }
  }

  async function handleApproveCardFillAuth(id: string) {
    setActionError(null);
    try {
      await approvePaymentCardFillAuthorization(id);
      setCardFillAuths((prev) => prev.filter((a) => a.authorization_id !== id));
      setLastDecision({ action: "approved", note: "Card fill approved. A SensitiveGrant is now active. This does NOT authorize a purchase." });
    } catch (err: any) {
      if (err.message?.includes("INVALID_STATUS")) {
        setCardFillAuths((prev) => prev.filter((a) => a.authorization_id !== id));
      } else {
        setActionError(err.message ?? "Failed to approve card fill authorization.");
      }
    }
  }

  async function handleDenyCardFillAuth(id: string) {
    setActionError(null);
    try {
      await denyPaymentCardFillAuthorization(id);
      setCardFillAuths((prev) => prev.filter((a) => a.authorization_id !== id));
      setLastDecision({ action: "denied", note: "Card fill denied." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to deny card fill authorization.");
    }
  }

  async function handleApprovePurchaseConfirmation(id: string) {
    setActionError(null);
    try {
      await approvePurchaseConfirmationAuthorization(id);
      setPurchaseConfirmations((prev) => prev.filter((a) => a.purchase_confirmation_id !== id));
      setLastDecision({ action: "approved", note: "Purchase confirmation approved. Antigen will click the payment button." });
    } catch (err: any) {
      // If already approved (idempotent), just remove from list
      if (err.message?.includes("INVALID_STATUS")) {
        setPurchaseConfirmations((prev) => prev.filter((a) => a.purchase_confirmation_id !== id));
      } else {
        setActionError(err.message ?? "Failed to approve purchase confirmation.");
      }
    }
  }

  async function handleDenyPurchaseConfirmation(id: string) {
    setActionError(null);
    try {
      await denyPurchaseConfirmationAuthorization(id);
      setPurchaseConfirmations((prev) => prev.filter((a) => a.purchase_confirmation_id !== id));
      setLastDecision({ action: "denied", note: "Purchase confirmation denied." });
    } catch (err: any) {
      setActionError(err.message ?? "Failed to deny purchase confirmation.");
    }
  }

  async function handleSubmitChallengeCode(challengeId: string, code: string) {
    setActionError(null);
    try {
      await submitSecurityChallengeCode(challengeId, code);
      setChallenges((prev) =>
        prev.map((c) => c.challenge_id === challengeId ? { ...c, status: "code_submitted" } : c),
      );
    } catch (err: any) {
      setActionError(err.message ?? "Failed to submit code.");
    }
  }

  async function handleCompleteChallenge(challengeId: string) {
    setActionError(null);
    try {
      await completeSecurityChallenge(challengeId);
      setChallenges((prev) => prev.filter((c) => c.challenge_id !== challengeId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to mark challenge complete.");
    }
  }

  async function handleCancelChallenge(challengeId: string) {
    setActionError(null);
    try {
      await cancelSecurityChallenge(challengeId);
      setChallenges((prev) => prev.filter((c) => c.challenge_id !== challengeId));
    } catch (err: any) {
      setActionError(err.message ?? "Failed to cancel challenge.");
    }
  }

  function handleProfileMemReqSaved(id: string) {
    setProfileMemReqs((prev) => prev.filter((r) => r.request_id !== id));
  }

  function handleProfileMemReqCancelled(id: string) {
    setProfileMemReqs((prev) => prev.filter((r) => r.request_id !== id));
  }

  function handleDismissDiagnostic(id: string) {
    setDismissedDiagnostics((prev) => new Set(prev).add(id));
  }

  function handleAccountCreationApproved(id: string) {
    setAccountCreationReqs((prev) => prev.filter((r) => r.request_id !== id));
  }

  function handleAccountCreationDenied(id: string) {
    setAccountCreationReqs((prev) => prev.filter((r) => r.request_id !== id));
  }

  const visibleDiagnostics = loginDiagnostics.filter((d) => !dismissedDiagnostics.has(d.diagnostic_id));

  const pendingCount = runs.length + credSessions.length + authSessions.length + injections.length + credAuths.length + cardFillAuths.length + purchaseConfirmations.length + challenges.length + profileMemReqs.length + accountCreationReqs.length;

  return (
    <div className="page">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, marginBottom: 20 }}>
            <div>
              <div className="a-eyebrow">Approvals</div>
              <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
                Approve, with{" "}<span className="cmd-hero__title-mark">proof.</span>
              </h1>
              <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
                Review what your agents are asking Antigen to do before any sensitive capability is released.
              </p>
            </div>
            {!loading && pendingCount > 0 && (
              <span className="a-status a-status--amber" style={{ flexShrink: 0, marginTop: 4 }}>
                <span className="a-status__dot" />{pendingCount} waiting
              </span>
            )}
          </div>
          <div className="header-stats">
            <HeaderStat value={loading ? "—" : pendingCount} label="Pending" />
            <HeaderStat value={loading ? "—" : activeGrants.length} label="Active grants" />
          </div>
        </div>
      </SpotlightHeroCard>

      {/* ── Content column ────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 720 }}>

        {/* Error banner */}
        {actionError && (
          <div style={{ background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-3)", padding: "12px 16px" }}>
            <div className="a-eyebrow" style={{ color: "oklch(0.45 0.13 25)", marginBottom: 4 }}>Error</div>
            <p style={{ fontSize: 13, color: "var(--ink-1)", margin: 0 }}>{actionError}</p>
          </div>
        )}

        {/* Last decision banner */}
        {lastDecision && (
          <div style={{
            background: lastDecision.action === "approved" ? "var(--green-soft)" : "var(--graphite-soft)",
            border: `1px solid ${lastDecision.action === "approved" ? "var(--green-ring)" : "var(--hairline)"}`,
            borderRadius: "var(--r-3)", padding: "12px 16px",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
          }}>
            <span style={{ fontSize: 13, color: lastDecision.action === "approved" ? "oklch(0.42 0.09 150)" : "var(--ink-3)" }}>
              {lastDecision.note}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
              <a href="/receipts" style={{ fontSize: 12, color: "var(--blue)", textDecoration: "none" }}>View receipts</a>
              {lastDecision.action === "approved" && (
                <a href="/sensitive-grants" style={{ fontSize: 12, color: "var(--blue)", textDecoration: "none" }}>View grants</a>
              )}
              <button
                onClick={() => setLastDecision(null)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-4)", fontSize: 14, padding: 0 }}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ── Review queue ─────────────────────────────────────────────── */}
        <div className="a-card" style={{ padding: "28px 32px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div className="a-eyebrow">Review queue</div>
            {!loading && pendingCount > 0 && (
              <span className="a-status a-status--amber">
                <span className="a-status__dot" />{pendingCount} waiting
              </span>
            )}
          </div>

          {/* Loading skeletons */}
          {loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2].map((i) => (
                <div key={i} style={{ height: 96, borderRadius: "var(--r-3)", background: "var(--graphite-soft)", opacity: 0.4 }} />
              ))}
            </div>
          )}

          {/* Unified empty state */}
          {!loading && pendingCount === 0 && (
            <div style={{ textAlign: "center", padding: "32px 24px" }}>
              <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>
                No agents are waiting right now.
              </p>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5, maxWidth: 360, marginInline: "auto" }}>
                When an agent needs your approval, Antigen will show what it wants to do before anything sensitive happens.
              </p>
            </div>
          )}

          {/* Populated: all request types in one unified list */}
          {!loading && pendingCount > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Route runs */}
              {runs.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {runs.map((run) => (
                    <PendingRunCard
                      key={run.run_id}
                      run={run}
                      ctx={contexts.get(run.run_id)}
                      loadingCtx={loadingContexts.has(run.run_id)}
                      onApprove={() => handleApprove(run.run_id)}
                      onReject={() => handleReject(run.run_id)}
                      onContextUpdate={(updated) => handleContextUpdate(run.run_id, updated)}
                    />
                  ))}
                </div>
              )}

              {/* Credential sessions */}
              {credSessions.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "var(--blue)", marginBottom: 4 }}>Use a saved login</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent is asking Antigen to use saved login details without revealing them to the agent.
                    </p>
                  </div>
                  {credSessions.map((session) => (
                    <div key={session.session_id} className="apr-card apr-card--blue">
                      <div className="apr-card__head">
                        <div>
                          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>
                            Allow agent to use{" "}
                            <span style={{ color: "var(--blue)" }}>{session.pass_label ?? "stored credential"}</span>
                            {" "}on <span style={{ color: "var(--blue)" }}>{session.domain}</span>?
                          </p>
                          {session.pass_username && (
                            <p style={{ fontSize: 11.5, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>
                              username: {session.pass_username}
                            </p>
                          )}
                        </div>
                        <span style={{
                          background: "var(--blue-soft)", color: "oklch(0.42 0.12 245)", border: "1px solid var(--blue-ring)",
                          fontSize: 11, fontWeight: 500, padding: "2px 9px", borderRadius: 999, flexShrink: 0,
                          display: "inline-flex", alignItems: "center", gap: 5,
                        }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                          Waiting
                        </span>
                      </div>
                      <div className="apr-card__body">
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", fontSize: 12, color: "var(--ink-4)" }}>
                          <span>Domain: <span style={{ color: "var(--ink-2)" }}>{session.domain}</span></span>
                          <span>Created: <span style={{ color: "var(--ink-2)" }}>{new Date(session.created_at).toLocaleString()}</span></span>
                        </div>
                        <div style={{ fontSize: 12 }}>
                          <span style={{ color: "var(--ink-4)" }}>Fields: </span>
                          {session.allowed_fields.map((f) => (
                            <span key={f} style={{
                              display: "inline-block", marginRight: 4,
                              background: "var(--blue-soft)", border: "1px solid var(--blue-ring)",
                              color: "oklch(0.42 0.12 245)", fontSize: 11, padding: "1px 7px", borderRadius: 999, fontFamily: "monospace",
                            }}>{f}</span>
                          ))}
                        </div>
                        <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
                          Session expires 10 minutes after approval. Credentials are filled by Antigen only — never returned to the agent.
                        </p>
                        <button onClick={() => handleApproveCredSession(session.session_id)} className="a-btn a-btn--primary">
                          Approve session
                        </button>
                        <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{session.session_id}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Auth sessions */}
              {authSessions.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "var(--blue)", marginBottom: 4 }}>Start a login session</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent wants Antigen to log in on its behalf. The agent receives a session, not your password.
                    </p>
                  </div>
                  {authSessions.map((session) => (
                    <PendingAuthSessionCard
                      key={session.session_id}
                      session={session}
                      onApprove={() => handleApproveAuthSession(session.session_id)}
                      onReject={() => handleRejectAuthSession(session.session_id)}
                    />
                  ))}
                </div>
              )}

              {/* Login credentials */}
              {credAuths.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "var(--blue)", marginBottom: 4 }}>Fill login credentials</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent is requesting permission to use stored credentials to log in. Antigen resolves and injects — the agent never receives them.
                    </p>
                  </div>
                  {credAuths.map((auth) => (
                    <PendingCredAuthCard
                      key={auth.authorization_id}
                      auth={auth}
                      onApprove={() => handleApproveCredAuth(auth.authorization_id)}
                      onDeny={() => handleDenyCredAuth(auth.authorization_id)}
                    />
                  ))}
                </div>
              )}

              {/* Payment card fill requests */}
              {cardFillAuths.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)", marginBottom: 4 }}>Payment card requests</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent is requesting permission to fill saved card details into checkout fields. Antigen resolves and injects — the agent never receives raw card values. This does not authorize any purchase.
                    </p>
                  </div>
                  {cardFillAuths.map((auth) => (
                    <PendingCardFillAuthCard
                      key={auth.authorization_id}
                      auth={auth}
                      onApprove={() => handleApproveCardFillAuth(auth.authorization_id)}
                      onDeny={() => handleDenyCardFillAuth(auth.authorization_id)}
                    />
                  ))}
                </div>
              )}

              {/* Purchase confirmations */}
              {purchaseConfirmations.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "oklch(0.45 0.13 25)", marginBottom: 4 }}>Purchase confirmations</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent is ready to submit payment. This is a separate approval from the card fill — approving this authorizes the final payment button click.
                    </p>
                  </div>
                  {purchaseConfirmations.map((auth) => (
                    <PurchaseConfirmationApprovalCard
                      key={auth.purchase_confirmation_id}
                      auth={auth}
                      onApprove={() => handleApprovePurchaseConfirmation(auth.purchase_confirmation_id)}
                      onDeny={() => handleDenyPurchaseConfirmation(auth.purchase_confirmation_id)}
                    />
                  ))}
                </div>
              )}

              {/* Field injections */}
              {injections.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "oklch(0.42 0.09 150)", marginBottom: 4 }}>Fill a protected field</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent wants Antigen to fill a protected field directly. The agent never sees the secret.
                    </p>
                  </div>
                  {injections.map((inj) => (
                    <PendingInjectionCard
                      key={inj.injection_request_id}
                      injection={inj}
                      onApprove={() => handleApproveInjection(inj.injection_request_id)}
                      onDeny={() => handleDenyInjection(inj.injection_request_id)}
                    />
                  ))}
                </div>
              )}

              {/* Security challenges */}
              {challenges.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)", marginBottom: 4 }}>Enter a security code</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent hit a verification step, like an email code or device check. You can provide the code without showing it to the agent.
                    </p>
                  </div>
                  {challenges.map((ch) => (
                    <PendingChallengeCard
                      key={ch.challenge_id}
                      challenge={ch}
                      onSubmitCode={(code) => handleSubmitChallengeCode(ch.challenge_id, code)}
                      onComplete={() => handleCompleteChallenge(ch.challenge_id)}
                      onCancel={() => handleCancelChallenge(ch.challenge_id)}
                      emailResolverStatus={emailResolverStatus}
                    />
                  ))}
                </div>
              )}

              {/* Profile information needed */}
              {profileMemReqs.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)", marginBottom: 4 }}>Profile information needed</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent needs profile values to fill a checkout form. Provide them here — Antigen stores and fills them without revealing raw values to the agent.
                    </p>
                  </div>
                  {profileMemReqs.map((r) => (
                    <PendingProfileMemoryRequestCard
                      key={r.request_id}
                      req={r}
                      onSaved={() => handleProfileMemReqSaved(r.request_id)}
                      onCancelled={() => handleProfileMemReqCancelled(r.request_id)}
                    />
                  ))}
                </div>
              )}

              {/* Account creation requests */}
              {accountCreationReqs.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)", marginBottom: 4 }}>Account creation needed</div>
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                      An agent reached a login wall but no credential exists for this domain. Approve to have Antigen generate a password and store it in your vault.
                    </p>
                  </div>
                  {accountCreationReqs.map((r) => (
                    <PendingAccountCreationCard
                      key={r.request_id}
                      req={r}
                      onApproved={() => handleAccountCreationApproved(r.request_id)}
                      onDenied={() => handleAccountCreationDenied(r.request_id)}
                    />
                  ))}
                </div>
              )}

            </div>
          )}
        </div>

        {/* ── Login failure diagnostics ─────────────────────────────────── */}
        {visibleDiagnostics.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)" }}>Recent login results</div>
              <span className="a-status a-status--amber">{visibleDiagnostics.length} issue{visibleDiagnostics.length !== 1 ? "s" : ""}</span>
            </div>
            {visibleDiagnostics.map((d) => (
              <LoginDiagnosticCard
                key={d.diagnostic_id}
                diagnostic={d}
                onDismiss={() => handleDismissDiagnostic(d.diagnostic_id)}
              />
            ))}
          </div>
        )}

        {/* ── How Antigen protects approvals ───────────────────────────── */}
        <div style={{
          background: "rgba(255,255,255,0.55)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--r-3)",
          boxShadow: "var(--shadow-1)",
          overflow: "hidden",
        }}>
          <button
            onClick={() => setShowDisclosure((v) => !v)}
            style={{
              width: "100%", background: "none", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
              padding: "16px 20px", textAlign: "left",
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)", marginBottom: 2 }}>
                How Antigen protects approvals
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: 1.4 }}>
                Learn what agents may request and what Antigen keeps hidden.
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, fontSize: 12, color: "var(--ink-4)" }}>
              {showDisclosure ? "Hide" : "Show"}
              <span style={{
                fontSize: 8, display: "inline-block",
                transform: showDisclosure ? "rotate(180deg)" : "none",
                transition: "transform 0.2s",
              }}>▼</span>
            </div>
          </button>

          {showDisclosure && (
            <div style={{
              borderTop: "1px solid var(--hairline)",
              padding: "20px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "20px 28px",
            }}>
              {([
                {
                  dot: "var(--blue)",
                  title: "Review sensitive actions",
                  desc: "Agents pause before purchases, submissions, or account changes you want to approve first.",
                },
                {
                  dot: "var(--green)",
                  title: "Keep secrets hidden",
                  desc: "Antigen can fill passwords or protected fields without revealing the secret to the agent.",
                },
                {
                  dot: "var(--blue)",
                  title: "Handle login safely",
                  desc: "Agents can ask Antigen to start a session. They receive access, not your password or cookies.",
                },
                {
                  dot: "var(--amber)",
                  title: "Resolve security checks",
                  desc: "Verification codes and device checks are handled through Antigen so the agent never sees the code.",
                },
                {
                  dot: "oklch(0.65 0.003 250)",
                  title: "Limit temporary access",
                  desc: "Approvals create temporary access that you can review or revoke at any time.",
                },
                {
                  dot: "oklch(0.50 0.10 150)",
                  title: "Record proof",
                  desc: "Important approvals and sensitive actions leave a signed record for accountability.",
                },
              ]).map(({ dot, title, desc }) => (
                <div key={title} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: dot, flexShrink: 0, marginTop: 4,
                  }} />
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", marginBottom: 3 }}>
                      {title}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: 1.5 }}>
                      {desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Temporary access ──────────────────────────────────────────── */}
        {!loading && <ActiveGrantsPanel grants={activeGrants} />}

      </div>
    </div>
  );
}
