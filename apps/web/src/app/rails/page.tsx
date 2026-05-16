"use client";

import { useEffect, useRef, useState } from "react";
import type { AegisRoute, ActionType, RouteStep, RouteVerificationReport, StepVerificationResult } from "@aegis/types";
import {
  listRoutes, recordRoute, deleteRoute, verifyRoute, patchRoute, submitRouteForReview,
  listSkills, installSkill, uninstallSkill,
} from "../../lib/api";
import type { SkillWithInstalled } from "../../lib/api";

// ─── Constants ────────────────────────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = {
  unverified_draft: "Draft",
  community: "Community",
  aegis_scanned: "Verified",
  aegis_reviewed: "Reviewed",
  run_verified: "Run Verified",
  business_official: "Business Official",
};

const TIER_VARIANT: Record<string, string> = {
  unverified_draft: "graphite",
  community: "blue",
  aegis_scanned: "green",
  aegis_reviewed: "green",
  run_verified: "green",
  business_official: "green",
};

const ACTION_LABELS: Partial<Record<ActionType, string>> = {
  browse: "Browse pages",
  search: "Search",
  read: "Read content",
  compare: "Compare items",
  draft: "Draft text",
  add_to_cart: "Add to cart",
  login: "Log in",
  purchase: "Complete a purchase",
  payment: "Make a payment",
  subscription: "Start a subscription",
  post_publicly: "Post publicly",
  comment: "Post a comment",
  direct_message: "Send a direct message",
  send_email: "Send an email",
  forward_email: "Forward an email",
  upload_file: "Upload a file",
  download_file: "Download a file",
  submit_form: "Submit a form",
  create_account: "Create an account",
  share_email: "Share your email address",
  share_phone: "Share your phone number",
  share_address: "Share your address",
  identity_disclosure: "Disclose your identity",
  government_id_upload: "Upload a government ID",
  medical_data_disclosure: "Share medical data",
  financial_data_disclosure: "Share financial data",
  account_setting_change: "Change account settings",
  delete_account: "Delete an account",
  connect_app: "Connect an external app",
  oauth_authorize: "Authorize via OAuth",
};

function friendlyAction(a: ActionType | string): string {
  return (ACTION_LABELS as Record<string, string>)[a] ?? a;
}

function friendlyDate(iso: string | undefined): string {
  if (!iso || iso === "1970-01-01T00:00:00.000Z") return "Never";
  return new Date(iso).toLocaleString();
}

function stepDescription(step: RouteStep): string {
  if (step.description && step.description.trim()) return step.description;
  return `${step.action} — ${step.intent.replace(/_/g, " ")}`;
}

function routeOrigin(domain: string): "local" | "wikipedia" | "external" {
  if (domain === "localhost" || domain === "127.0.0.1") return "local";
  if (domain === "en.wikipedia.org") return "wikipedia";
  return "external";
}

function hasVisualReplay(domain: string): boolean {
  const o = routeOrigin(domain);
  return o === "local" || o === "wikipedia";
}

const VERIFIED_TIERS = new Set(["aegis_scanned", "aegis_reviewed", "run_verified", "business_official"]);

function isRouteVerified(tier: string): boolean {
  return VERIFIED_TIERS.has(tier);
}

function hasSensitiveValues(steps: RouteStep[]): boolean {
  return steps.some(s => s.value_policy?.type === "sensitive_redacted");
}

function hasFillSteps(steps: RouteStep[]): boolean {
  return steps.some(s => s.action === "fill");
}

function locatorQuality(steps: RouteStep[]): { high: number; low: number } {
  let high = 0, low = 0;
  for (const step of steps) {
    const t = step.target.preferred_locator.type;
    if (t === "role" || t === "label" || t === "placeholder") high++;
    else low++;
  }
  return { high, low };
}

// ─── Design primitives ────────────────────────────────────────────────────────

type PillColor = "green" | "amber" | "red" | "blue" | "graphite";

function pillStyle(color: PillColor): React.CSSProperties {
  const map: Record<PillColor, React.CSSProperties> = {
    green:    { background: "var(--green-soft)",    color: "oklch(0.42 0.09 150)", border: "1px solid var(--green-ring)"    },
    amber:    { background: "var(--amber-soft)",    color: "oklch(0.45 0.12 75)",  border: "1px solid var(--amber-ring)"    },
    red:      { background: "var(--red-soft)",      color: "oklch(0.45 0.13 25)",  border: "1px solid var(--red-ring)"      },
    blue:     { background: "var(--blue-soft)",     color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)"     },
    graphite: { background: "var(--graphite-soft)", color: "var(--ink-3)",         border: "1px solid var(--hairline)"      },
  };
  return { ...map[color], fontSize: 11, fontWeight: 500, padding: "2px 9px", borderRadius: 999, display: "inline-flex", alignItems: "center" };
}

function riskPillColor(level: string): PillColor {
  if (level === "low") return "green";
  if (level === "medium") return "amber";
  return "red";
}

function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

function AStatus({ label, variant = "graphite" }: { label: string; variant?: string }) {
  return (
    <span className={`a-status a-status--${variant}`}>
      <span className="a-status__dot" />
      {label}
    </span>
  );
}

// ─── SVG icons ────────────────────────────────────────────────────────────────

function RouteSVG() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l3-9 4 18 3-9h4" />
    </svg>
  );
}

function ShopSVG() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 01-8 0" />
    </svg>
  );
}

// ─── StepRow ──────────────────────────────────────────────────────────────────

function StepRow({ step }: { step: RouteStep }) {
  const locType = step.target.preferred_locator.type;
  const locDisplay =
    step.target.preferred_locator.name ??
    step.target.preferred_locator.value ??
    step.target.preferred_locator.role ?? "";

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--hairline)" }}>
      <span style={{ flexShrink: 0, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--graphite-soft)", borderRadius: "var(--r-1)", fontSize: 11, color: "var(--ink-3)", fontFamily: "monospace" }}>
        {step.order}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, fontFamily: "monospace", color: "oklch(0.45 0.09 240)" }}>{step.action}</span>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step.intent}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <span style={{ fontSize: 11, color: "var(--ink-4)" }}>
            {locType}: <span style={{ fontFamily: "monospace", color: "var(--ink-3)" }}>{locDisplay}</span>
          </span>
          <span style={{ fontSize: 11, color: step.target.confidence >= 0.8 ? "oklch(0.42 0.09 150)" : "oklch(0.45 0.12 75)" }}>
            {(step.target.confidence * 100).toFixed(0)}% conf
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── VerificationStepRow ──────────────────────────────────────────────────────

function VerificationStepRow({ step, result }: { step: RouteStep; result: StepVerificationResult }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "6px 12px", borderBottom: "1px solid var(--hairline)" }}>
      <span style={{ flexShrink: 0, width: 14, textAlign: "center", color: result.passed ? "oklch(0.42 0.09 150)" : "oklch(0.45 0.13 25)", fontFamily: "monospace" }}>
        {result.passed ? "✓" : "✗"}
      </span>
      <span style={{ color: "var(--ink-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {step.intent.replace(/_/g, " ")}
      </span>
      {result.selected_locator && (
        <span style={{ color: "var(--ink-4)", fontFamily: "monospace", flexShrink: 0, fontSize: 11 }}>via {result.selected_locator.type}</span>
      )}
      {result.locator_attempts.length > 1 && (
        <span style={{ color: "var(--ink-4)", flexShrink: 0, fontSize: 11 }}>({result.locator_attempts.length} attempts)</span>
      )}
    </div>
  );
}

// ─── HealthRow ────────────────────────────────────────────────────────────────

function HealthRow({ ok, label, detail, neutral = false }: { ok: boolean; label: string; detail?: string; neutral?: boolean }) {
  const iconColor = neutral ? "var(--ink-4)" : ok ? "oklch(0.42 0.09 150)" : "oklch(0.45 0.12 75)";
  const labelColor = neutral ? "var(--ink-3)" : ok ? "var(--ink-2)" : "oklch(0.45 0.12 75)";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}>
      <span style={{ flexShrink: 0, width: 14, textAlign: "center", marginTop: 1, color: iconColor, fontFamily: "monospace" }}>
        {neutral ? "·" : ok ? "✓" : "○"}
      </span>
      <div style={{ minWidth: 0 }}>
        <span style={{ fontWeight: 500, color: labelColor }}>{label}</span>
        {detail && <span style={{ color: "var(--ink-4)", marginLeft: 6 }}>{detail}</span>}
      </div>
    </div>
  );
}

// ─── CapabilityBadges ─────────────────────────────────────────────────────────

function CapabilityBadges({ route }: { route: AegisRoute }) {
  const origin = routeOrigin(route.domain);
  const visualReplay = hasVisualReplay(route.domain);
  const parameterized = (route.variables?.length ?? 0) > 0;
  const sensProtected = hasSensitiveValues(route.steps);
  const hasFills = hasFillSteps(route.steps);

  const tags: Array<{ text: string; amber?: boolean }> = [];
  if (origin === "local") tags.push({ text: "Local demo" });
  else if (origin === "wikipedia") tags.push({ text: "Wikipedia" });
  else tags.push({ text: "External site" });
  if (visualReplay) tags.push({ text: "Visual replay" });
  if (parameterized) tags.push({ text: "Parameterized" });
  if (sensProtected) tags.push({ text: "Sensitive values protected", amber: true });
  else if (hasFills) tags.push({ text: "No sensitive fields" });

  return (
    <div className="metadata-row">
      {tags.flatMap((t, i) => [
        ...(i > 0 ? [<span key={`s${i}`} className="metadata-sep">·</span>] : []),
        <span key={t.text} style={t.amber ? { color: "var(--amber)" } : undefined}>{t.text}</span>,
      ])}
    </div>
  );
}

// ─── PreviewPanel ─────────────────────────────────────────────────────────────

function PreviewPanel({ route, verifyReport }: { route: AegisRoute; verifyReport: RouteVerificationReport | null }) {
  const origin = routeOrigin(route.domain);
  const visualReplay = hasVisualReplay(route.domain);
  const verified = isRouteVerified(route.trust_tier);
  const sensProtected = hasSensitiveValues(route.steps);
  const hasVars = (route.variables?.length ?? 0) > 0;
  const { high: highLocators, low: lowLocators } = locatorQuality(route.steps);

  const sectionHead: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase",
    color: "var(--ink-3)", margin: "0 0 10px",
  };

  return (
    <div style={{ borderTop: "1px solid var(--hairline)", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 20 }}>

      {/* What this skill does */}
      <div>
        <p style={sectionHead}>What this skill does</p>
        {route.workflow_description && (
          <p style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 10, lineHeight: 1.6, marginTop: 0 }}>{route.workflow_description}</p>
        )}
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {route.steps.map((step) => (
            <li key={step.step_id} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12.5, color: "var(--ink-2)" }}>
              <span style={{ flexShrink: 0, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--graphite-soft)", borderRadius: "var(--r-1)", fontSize: 11, color: "var(--ink-3)", fontFamily: "monospace", marginTop: 1 }}>
                {step.order}
              </span>
              <span style={{ lineHeight: 1.5, flex: 1 }}>{stepDescription(step)}</span>
              {step.approval_required && (
                <span style={{ ...pillStyle("amber"), flexShrink: 0, marginTop: 1 }}>approval required</span>
              )}
            </li>
          ))}
        </ol>
      </div>

      {/* What this skill will not do */}
      <div>
        <p style={sectionHead}>What this skill will not do</p>
        {route.forbidden_actions.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: 0 }}>No explicit restrictions recorded.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {route.forbidden_actions.map((a) => (
              <li key={a} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "oklch(0.45 0.13 25)" }}>
                <span>✗</span>{friendlyAction(a)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Approval gates */}
      <div>
        <p style={sectionHead}>Approval required before</p>
        {route.approval_gates.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: 0 }}>No approval gates on this skill.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {route.approval_gates.map((gate) => (
              <li key={gate.step_id} style={{ fontSize: 12.5, color: "oklch(0.45 0.12 75)", background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-2)", padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1 }}>{gate.reason}</span>
                <span style={pillStyle(riskPillColor(gate.risk_level))}>{gate.risk_level} risk</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Required permissions */}
      {route.required_permissions.length > 0 && (
        <div>
          <p style={sectionHead}>Required permissions</p>
          <div className="metadata-row">
            {route.required_permissions.flatMap((p, i) => [
              ...(i > 0 ? [<span key={`s${i}`} className="metadata-sep">·</span>] : []),
              <span key={p}>{friendlyAction(p)}</span>,
            ])}
          </div>
        </div>
      )}

      {/* Route Health */}
      <div>
        <p style={sectionHead}>Route Health</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <HealthRow ok={true} label="Private use" detail="Available — only visible to you, not discoverable by other agents" />
          <HealthRow ok={true} label="Domain locked" detail={`Restricted to ${route.domain}`} />
          <HealthRow
            ok={verified}
            label={verified ? `Verified — ${TIER_LABEL[route.trust_tier] ?? route.trust_tier}` : "Not yet verified"}
            detail={verified ? "Eligible for marketplace review submission" : "Optional for private use — required before marketplace submission"}
          />
          <HealthRow
            ok={visualReplay}
            label={visualReplay ? "Visual replay available" : "Visual replay not supported"}
            detail={origin === "local" ? "Via demo bank page" : origin === "wikipedia" ? "Via Chrome extension" : "Not yet supported for this domain"}
          />
          <HealthRow
            ok={sensProtected}
            label={sensProtected ? "Sensitive values protected" : "No sensitive fields detected"}
            detail={sensProtected ? "Redacted at record time; supplied at runtime" : "All recorded values are safe literals or selectors"}
          />
          <HealthRow
            ok={hasVars}
            label={hasVars ? `Parameterized — ${route.variables!.length} variable${route.variables!.length !== 1 ? "s" : ""}` : "No variables"}
            detail={hasVars ? "Route accepts runtime inputs" : "Route uses fixed recorded values"}
            neutral={!hasVars}
          />
          <HealthRow
            ok={lowLocators === 0}
            label={lowLocators === 0 ? `${highLocators} semantic locator${highLocators !== 1 ? "s" : ""}` : `${lowLocators} fragile locator${lowLocators !== 1 ? "s" : ""}`}
            detail={lowLocators === 0 ? "All steps use role, label, or placeholder targeting" : `${lowLocators} step${lowLocators !== 1 ? "s" : ""} use css/xpath — may break on layout changes`}
          />
        </div>
      </div>

      {/* Verification summary */}
      {verifyReport && (
        <div>
          <p style={sectionHead}>Verification summary</p>
          <div style={{
            fontSize: 12.5, borderRadius: "var(--r-2)", padding: "8px 12px", marginBottom: 10,
            ...(verifyReport.passed
              ? { color: "oklch(0.42 0.09 150)", background: "var(--green-soft)", border: "1px solid var(--green-ring)" }
              : { color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)" }),
          }}>
            {verifyReport.passed
              ? `Antigen verified this skill — ${verifyReport.step_results.filter(r => r.passed).length}/${verifyReport.step_results.length} steps passed`
              : `Verification failed — ${verifyReport.step_results.filter(r => r.passed).length}/${verifyReport.step_results.length} steps passed`}
          </div>
          <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-2)", overflow: "hidden" }}>
            {verifyReport.step_results.map((result) => {
              const step = route.steps.find(s => s.step_id === result.step_id);
              if (!step) return null;
              return <VerificationStepRow key={result.step_id} step={step} result={result} />;
            })}
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-4)", marginTop: 6, marginBottom: 0 }}>
            Last verified: {friendlyDate(verifyReport.completed_at)}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── RenameModal ──────────────────────────────────────────────────────────────

function RenameModal({ current, onSave, onCancel }: {
  current: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) { setError("Name cannot be empty."); return; }
    setSaving(true);
    setError(null);
    try { await onSave(trimmed); }
    catch (err: any) { setError(err.message ?? "Save failed."); setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(20,22,30,0.35)", backdropFilter: "blur(4px)" }}>
      <div className="a-card" style={{ width: "100%", maxWidth: 360, margin: "0 16px", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>Rename skill</p>
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            className="ag-input"
            placeholder="Skill name"
            disabled={saving}
          />
          {error && <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onCancel} disabled={saving} className="a-btn a-btn--ghost">Cancel</button>
            <button type="submit" disabled={saving || !value.trim()} className="a-btn a-btn--primary">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── SkillCard ────────────────────────────────────────────────────────────────

function SkillCard({ route, onDelete, onVerified, onRenamed }: {
  route: AegisRoute;
  onDelete: (id: string) => void;
  onVerified: (routeId: string) => void;
  onRenamed: (routeId: string, newName: string) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyReport, setVerifyReport] = useState<RouteVerificationReport | null>(route.verification_report ?? null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [localTier, setLocalTier] = useState(route.trust_tier);
  const [localName, setLocalName] = useState(route.workflow_name);
  const [localMarketplaceStatus, setLocalMarketplaceStatus] = useState(route.marketplace_status ?? "private");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    try { await deleteRoute(route.route_id); onDelete(route.route_id); }
    catch { setDeleting(false); }
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyError(null);
    try {
      const report = await verifyRoute(route.route_id);
      setVerifyReport(report);
      if (report.promoted_trust_tier) setLocalTier(report.promoted_trust_tier);
      onVerified(route.route_id);
    } catch (err: any) {
      setVerifyError(err.message ?? "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmitForReview() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await submitRouteForReview(route.route_id);
      setLocalMarketplaceStatus(updated.marketplace_status ?? "pending_review");
    } catch (err: any) {
      setSubmitError(err.message ?? "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRename(newName: string) {
    await patchRoute(route.route_id, { workflow_name: newName });
    setLocalName(newName);
    onRenamed(route.route_id, newName);
    setShowRename(false);
  }

  const lastVerified = verifyReport?.completed_at ?? route.last_verified_at;
  const hasVerification = !!verifyReport;

  const mktVariant =
    localMarketplaceStatus === "approved" ? "green" :
    localMarketplaceStatus === "rejected" ? "red" :
    localMarketplaceStatus === "pending_review" ? "amber" :
    isRouteVerified(localTier) ? "blue" : "graphite";

  const mktLabel =
    localMarketplaceStatus === "approved" ? "Approved" :
    localMarketplaceStatus === "rejected" ? "Rejected" :
    localMarketplaceStatus === "pending_review" ? "Pending review" :
    isRouteVerified(localTier) ? "Ready for review" : "Needs verification";

  const ghostBtn: React.CSSProperties = {
    fontSize: 12, fontWeight: 500, padding: "5px 12px", borderRadius: "var(--r-1)",
    background: "rgba(255,255,255,0.7)", border: "1px solid var(--hairline)",
    color: "var(--ink-1)", cursor: "pointer", display: "inline-flex", alignItems: "center",
  };
  const ghostBtnActive: React.CSSProperties = {
    ...ghostBtn, background: "var(--blue-soft)", border: "1px solid var(--blue-ring)", color: "oklch(0.45 0.09 240)",
  };

  return (
    <>
      {showRename && <RenameModal current={localName} onSave={handleRename} onCancel={() => setShowRename(false)} />}

      <div className="a-card" style={{ overflow: "hidden", padding: 0 }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Name row */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div className="ag-avatar" style={{ marginTop: 2, flexShrink: 0 }}>
              <RouteSVG />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)" }}>{localName}</span>
                <span className="metadata-state">{TIER_LABEL[localTier] ?? localTier}</span>
                <span className="metadata-sep">·</span>
                <span className="metadata-state">Private</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", fontSize: 12, color: "var(--ink-3)" }}>
                <span style={{ fontFamily: "monospace", color: "var(--ink-2)" }}>{route.domain}</span>
                <span>{route.steps.length} step{route.steps.length !== 1 ? "s" : ""}</span>
                {route.risk_level === "low"
                  ? <span>{route.risk_level} risk</span>
                  : <span style={pillStyle(riskPillColor(route.risk_level))}>{route.risk_level} risk</span>
                }
                <span>{hasVerification ? `Verified ${friendlyDate(lastVerified)}` : "Not yet verified"}</span>
              </div>
            </div>
          </div>

          {/* Marketplace status */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ color: "oklch(0.42 0.09 150)", fontFamily: "monospace", fontSize: 11 }}>✓</span>
              <span style={{ color: "var(--ink-3)" }}>Private use:</span>
              <span style={{ color: "oklch(0.42 0.09 150)", fontWeight: 500 }}>Ready</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ color: "var(--ink-3)" }}>Marketplace:</span>
              {localMarketplaceStatus === "approved" ? (
                <span className="metadata-state--good">marketplace approved</span>
              ) : localMarketplaceStatus === "rejected" ? (
                <span className="metadata-state--red">Rejected</span>
              ) : localMarketplaceStatus === "pending_review" ? (
                <span className="a-status a-status--amber">Pending review</span>
              ) : isRouteVerified(localTier) ? (
                <span className="metadata-state">Ready for review</span>
              ) : (
                <span className="metadata-state">Needs verification</span>
              )}
            </span>
          </div>

          {/* Capability badges */}
          <CapabilityBadges route={{ ...route, trust_tier: localTier }} />

          {/* Required permissions */}
          {route.required_permissions.length > 0 && (
            <div className="metadata-row">
              {route.required_permissions.flatMap((p, i) => [
                ...(i > 0 ? [<span key={`sp${i}`} className="metadata-sep">·</span>] : []),
                <span key={p}>{friendlyAction(p)}</span>,
              ])}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => { setShowPreview(v => !v); setShowAdvanced(false); }}
              style={showPreview ? ghostBtnActive : ghostBtn}
            >
              {showPreview ? "Hide preview" : "Preview"}
            </button>
            {(route.domain === "localhost" || route.domain === "127.0.0.1") && (
              <a
                href={`http://localhost:3001/bank?previewRoute=${encodeURIComponent(route.route_id)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={ghostBtn}
              >
                Visual replay ↗
              </a>
            )}
            {route.domain === "en.wikipedia.org" && (
              <a
                href={`https://en.wikipedia.org/wiki/Main_Page#aegis-preview=${encodeURIComponent(route.route_id)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={ghostBtn}
              >
                External replay ↗
              </a>
            )}
            <button onClick={handleVerify} disabled={verifying || deleting} style={{ ...ghostBtn, opacity: (verifying || deleting) ? 0.5 : 1, cursor: (verifying || deleting) ? "not-allowed" : "pointer" }}>
              {verifying ? "Verifying…" : "Verify"}
            </button>
            <button onClick={() => setShowRename(true)} disabled={deleting || verifying} style={{ ...ghostBtn, opacity: (deleting || verifying) ? 0.5 : 1, cursor: (deleting || verifying) ? "not-allowed" : "pointer" }}>
              Rename
            </button>
            {localMarketplaceStatus === "approved" ? (
              <span style={{ fontSize: 12, color: "oklch(0.42 0.09 150)", fontWeight: 500 }}>marketplace approved</span>
            ) : localMarketplaceStatus === "rejected" ? (
              <button disabled style={{ ...ghostBtn, ...pillStyle("red"), cursor: "not-allowed" }}>Rejected</button>
            ) : localMarketplaceStatus === "pending_review" ? (
              <button disabled style={{ ...ghostBtn, ...pillStyle("amber"), cursor: "not-allowed" }}>Pending review</button>
            ) : isRouteVerified(localTier) ? (
              <button
                onClick={handleSubmitForReview}
                disabled={submitting || deleting || verifying}
                style={{ ...ghostBtn, opacity: (submitting || deleting || verifying) ? 0.5 : 1, cursor: (submitting || deleting || verifying) ? "not-allowed" : "pointer" }}
              >
                {submitting ? "Submitting…" : "Submit for Review"}
              </button>
            ) : (
              <button disabled title="Verify this route before marketplace review." style={{ ...ghostBtn, opacity: 0.35, cursor: "not-allowed" }}>
                Submit for Review
              </button>
            )}
            <button
              onClick={handleDelete}
              disabled={deleting || verifying}
              style={{
                ...ghostBtn,
                marginLeft: "auto",
                background: "var(--red-soft)",
                border: "1px solid var(--red-ring)",
                color: "oklch(0.45 0.13 25)",
                opacity: (deleting || verifying) ? 0.5 : 1,
                cursor: (deleting || verifying) ? "not-allowed" : "pointer",
              }}
            >
              {deleting ? "…" : "Delete"}
            </button>
          </div>
        </div>

        {/* Submit error strip */}
        {submitError && (
          <div style={{ margin: "0 20px 12px", fontSize: 12, borderRadius: "var(--r-2)", padding: "8px 12px", color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)" }}>
            Submission error: {submitError}
          </div>
        )}

        {/* Verification strip */}
        {(verifyReport || verifyError) && (
          <div style={{
            margin: "0 20px 12px", fontSize: 12, borderRadius: "var(--r-2)", padding: "8px 12px",
            ...(verifyError
              ? { color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)" }
              : verifyReport!.passed
              ? { color: "oklch(0.42 0.09 150)", background: "var(--green-soft)", border: "1px solid var(--green-ring)" }
              : { color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)" }),
          }}>
            {verifyError ? (
              `Verification error: ${verifyError}`
            ) : verifyReport!.passed ? (
              <>
                Verification passed — {verifyReport!.step_results.filter(s => s.passed).length}/{verifyReport!.step_results.length} steps
                {verifyReport!.promoted_trust_tier && (
                  <span style={{ marginLeft: 8, fontWeight: 600 }}>
                    → {TIER_LABEL[verifyReport!.promoted_trust_tier] ?? verifyReport!.promoted_trust_tier}
                  </span>
                )}
              </>
            ) : (
              <>
                Verification failed — {verifyReport!.step_results.filter(s => s.passed).length}/{verifyReport!.step_results.length} steps passed
                {verifyReport!.errors.length > 0 && <span style={{ display: "block", marginTop: 3 }}>{verifyReport!.errors[0]}</span>}
              </>
            )}
          </div>
        )}

        {/* Preview panel */}
        {showPreview && <PreviewPanel route={{ ...route, workflow_name: localName }} verifyReport={verifyReport} />}

        {/* Advanced route details */}
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <button
            onClick={() => { setShowAdvanced(v => !v); setShowPreview(false); }}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", fontSize: 12, color: "var(--ink-4)", background: "none", border: "none", cursor: "pointer" }}
          >
            <span>Advanced route details</span>
            <span>{showAdvanced ? "▲" : "▼"}</span>
          </button>

          {showAdvanced && (
            <div style={{ padding: "4px 20px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Steps */}
              <div>
                <p style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 8px" }}>Steps</p>
                {route.steps.map((step) => {
                  const vResult = verifyReport?.step_results.find(r => r.step_id === step.step_id);
                  return (
                    <div key={step.step_id} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}><StepRow step={step} /></div>
                      {vResult && (
                        <div style={{ flexShrink: 0, paddingTop: 10 }}>
                          <span style={{ fontSize: 11.5, fontFamily: "monospace", color: vResult.passed ? "oklch(0.42 0.09 150)" : "oklch(0.45 0.13 25)" }}>
                            {vResult.passed ? "✓" : "✗"}
                            {vResult.selected_locator && <span style={{ color: "var(--ink-4)", marginLeft: 4 }}>via {vResult.selected_locator.type}</span>}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Allowed / Forbidden */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 12 }}>
                <div>
                  <p style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 6px" }}>Allowed actions</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {route.allowed_actions.length === 0
                      ? <span style={{ color: "var(--ink-4)" }}>none</span>
                      : route.allowed_actions.flatMap((a, i) => [
                          ...(i > 0 ? [<span key={`sa${i}`} className="metadata-sep">·</span>] : []),
                          <span key={a} style={{ fontSize: 12, color: "var(--ink-3)" }}>{a}</span>,
                        ])
                    }
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 6px" }}>Forbidden actions</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {route.forbidden_actions.length === 0
                      ? <span style={{ color: "var(--ink-4)" }}>none</span>
                      : route.forbidden_actions.map(a => <span key={a} style={pillStyle("red")}>{a}</span>)
                    }
                  </div>
                </div>
              </div>

              <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>
                ID: {route.route_id} · v{route.version}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── MarketplaceCard ──────────────────────────────────────────────────────────

function MarketplaceCard({ skill, onInstallChange }: {
  skill: SkillWithInstalled;
  onInstallChange: (skillId: string, installed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInstall() {
    setBusy(true); setError(null);
    try { await installSkill(skill.skill_id); onInstallChange(skill.skill_id, true); }
    catch (err: any) { setError(err.message ?? "Install failed."); }
    finally { setBusy(false); }
  }

  async function handleUninstall() {
    setBusy(true); setError(null);
    try { await uninstallSkill(skill.skill_id); onInstallChange(skill.skill_id, false); }
    catch (err: any) { setError(err.message ?? "Uninstall failed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="ag-row">
      <div className="ag-avatar" style={{ marginTop: 2 }}>
        <ShopSVG />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)" }}>{skill.name}</span>
          <span className="metadata-state">{TIER_LABEL[skill.trust_tier] ?? skill.trust_tier}</span>
          {skill.installed && <><span className="metadata-sep">·</span><span className="metadata-state--good">installed</span></>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--ink-2)" }}>{skill.domain}</span>
          {skill.risk_level && (
            skill.risk_level === "low"
              ? <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{skill.risk_level} risk</span>
              : <span style={pillStyle(riskPillColor(skill.risk_level))}>{skill.risk_level} risk</span>
          )}
        </div>
        {skill.summary && (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 6px", lineHeight: 1.5 }}>{skill.summary}</p>
        )}
        {skill.required_permissions.length > 0 && (
          <div className="metadata-row">
            {skill.required_permissions.flatMap((p, i) => [
              ...(i > 0 ? [<span key={`sm${i}`} className="metadata-sep">·</span>] : []),
              <span key={p}>{friendlyAction(p)}</span>,
            ])}
          </div>
        )}
        {error && <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: "4px 0 0" }}>{error}</p>}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
        {skill.installed ? (
          <button
            onClick={handleUninstall}
            disabled={busy}
            style={{
              fontSize: 12, fontWeight: 500, padding: "5px 12px", borderRadius: "var(--r-1)",
              background: "var(--red-soft)", border: "1px solid var(--red-ring)", color: "oklch(0.45 0.13 25)",
              cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? "…" : "Uninstall"}
          </button>
        ) : (
          <button
            onClick={handleInstall}
            disabled={busy}
            className="a-btn a-btn--primary"
            style={{ opacity: busy ? 0.5 : 1 }}
          >
            {busy ? "…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = "rails" | "marketplace";

export default function RailsPage() {
  const [routes, setRoutes] = useState<AegisRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("rails");

  const [skills, setSkills] = useState<SkillWithInstalled[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  const [showAdvancedRecorder, setShowAdvancedRecorder] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileResult, setCompileResult] = useState<{
    route_id: string; step_count: number; trust_tier: string; forbidden_action_count: number;
  } | null>(null);

  useEffect(() => {
    listRoutes().then(setRoutes).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (tab === "marketplace" && !skillsLoaded) {
      setSkillsLoading(true);
      setSkillsError(null);
      listSkills()
        .then(setSkills)
        .catch((err: any) => setSkillsError(err.message ?? "Could not load marketplace."))
        .finally(() => { setSkillsLoading(false); setSkillsLoaded(true); });
    }
  }, [tab, skillsLoaded]);

  function handleDelete(routeId: string) {
    setRoutes(prev => prev.filter(r => r.route_id !== routeId));
  }

  function handleVerified(_routeId: string) {
    listRoutes().then(setRoutes).catch(() => {});
  }

  function handleRenamed(routeId: string, newName: string) {
    setRoutes(prev => prev.map(r => r.route_id === routeId ? { ...r, workflow_name: newName } : r));
  }

  function handleInstallChange(skillId: string, installed: boolean) {
    setSkills(prev => prev.map(s => s.skill_id === skillId ? { ...s, installed } : s));
  }

  async function handleCompile(e: React.FormEvent) {
    e.preventDefault();
    setCompiling(true);
    setCompileError(null);
    setCompileResult(null);
    let parsed: unknown;
    try { parsed = JSON.parse(jsonInput); }
    catch {
      setCompileError("Invalid JSON — paste the recording payload from the demo bank page.");
      setCompiling(false);
      return;
    }
    try {
      const result = await recordRoute(parsed as any);
      setCompileResult(result);
      const updated = await listRoutes();
      setRoutes(updated);
    } catch (err: any) {
      setCompileError(err.message ?? "Compilation failed.");
    } finally {
      setCompiling(false);
    }
  }

  const verifiedCount = routes.filter(r => isRouteVerified(r.trust_tier)).length;
  const installedCount = skills.filter(s => s.installed).length;

  return (
    <div className="page">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div className="a-eyebrow">Rails</div>
          <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
            Routes,{" "}
            <span className="cmd-hero__title-mark">verified.</span>
          </h1>
          <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
            Teach agents safe paths through websites. Antigen records, verifies, and replays workflows under your rules.
          </p>
          <div className="header-stats">
            <HeaderStat value={loading ? "—" : routes.length} label="Routes" />
            <HeaderStat value={loading ? "—" : verifiedCount} label="Verified" />
            <HeaderStat value={skillsLoading ? "—" : installedCount} label="Installed" />
          </div>
        </div>
      </div>

      {/* ── Lifecycle strip ───────────────────────────────────────────────── */}
      <div className="a-card" style={{ padding: "12px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0 }}>
          {(["Observe", "Compile", "Verify", "Run", "Receipt"] as const).map((step, i, arr) => (
            <span key={step} style={{ display: "flex", alignItems: "center" }}>
              <span style={{
                fontSize: 12, fontWeight: 500, padding: "3px 10px", borderRadius: 999,
                color: i === 2 ? "oklch(0.45 0.09 240)" : i === 4 ? "oklch(0.42 0.09 150)" : "var(--ink-3)",
                background: i === 2 ? "var(--blue-soft)" : i === 4 ? "var(--green-soft)" : "transparent",
              }}>
                {step}
              </span>
              {i < arr.length - 1 && (
                <span style={{ fontSize: 11, color: "var(--ink-4)", margin: "0 1px" }}>→</span>
              )}
            </span>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-4)", paddingLeft: 16 }}>
            Safe paths through websites, from first click to signed receipt.
          </span>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="ag-tabs">
        <button className={`ag-tab${tab === "rails" ? " ag-tab--active" : ""}`} onClick={() => setTab("rails")}>
          My Rails{!loading && routes.length > 0 ? ` (${routes.length})` : ""}
        </button>
        <button className={`ag-tab${tab === "marketplace" ? " ag-tab--active" : ""}`} onClick={() => setTab("marketplace")}>
          Marketplace
        </button>
      </div>

      {/* ── My Rails tab ─────────────────────────────────────────────────── */}
      {tab === "rails" && (
        <>
          {/* Record CTA */}
          <div className="a-card" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 4px" }}>Record a new route</p>
                <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                  Open the demo bank page, click <strong style={{ color: "var(--ink-2)" }}>Start Recording</strong>, perform the workflow, then click{" "}
                  <strong style={{ color: "var(--ink-2)" }}>Stop Recording</strong> and{" "}
                  <strong style={{ color: "var(--ink-2)" }}>Submit to Antigen</strong>. Return here when done.
                </p>
                <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "4px 0 0" }}>
                  Antigen captures semantic telemetry — element roles, labels, and accessibility context — not raw coordinates or screenshots.
                </p>
              </div>
              <a
                href="http://localhost:3001/bank.html"
                target="_blank"
                rel="noopener noreferrer"
                className="a-btn a-btn--primary"
                style={{ flexShrink: 0 }}
              >
                Open demo bank ↗
              </a>
            </div>

            <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
              <button
                onClick={() => { setShowAdvancedRecorder(v => !v); setCompileResult(null); setCompileError(null); }}
                style={{ fontSize: 12, color: "var(--ink-4)", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: 0 }}
              >
                <span>{showAdvancedRecorder ? "▲" : "▼"}</span>
                <span>Advanced — paste recording JSON manually</span>
              </button>

              {showAdvancedRecorder && (
                <form onSubmit={handleCompile} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                    If the bank page&apos;s Submit button doesn&apos;t reach Antigen automatically, copy the JSON from the recorder panel and paste it here.
                  </p>
                  <div>
                    <label className="ag-label">Recording payload JSON</label>
                    <textarea
                      className="ag-input"
                      style={{ height: 120, fontFamily: "monospace", fontSize: 12, resize: "vertical", display: "block", width: "100%", boxSizing: "border-box" }}
                      placeholder='{ "workflow_name": "...", "domain": "localhost", "events": [...] }'
                      value={jsonInput}
                      onChange={e => setJsonInput(e.target.value)}
                    />
                  </div>
                  {compileError && (
                    <p style={{ fontSize: 12, margin: 0, borderRadius: "var(--r-2)", padding: "8px 12px", color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)" }}>
                      {compileError}
                    </p>
                  )}
                  {compileResult && (
                    <div style={{ fontSize: 12, borderRadius: "var(--r-2)", padding: "8px 12px", background: "var(--green-soft)", border: "1px solid var(--green-ring)" }}>
                      <p style={{ color: "oklch(0.42 0.09 150)", fontWeight: 600, margin: "0 0 2px" }}>Skill compiled and saved</p>
                      <p style={{ color: "var(--ink-3)", margin: 0 }}>
                        {compileResult.step_count} steps · {TIER_LABEL[compileResult.trust_tier] ?? compileResult.trust_tier}
                        {compileResult.forbidden_action_count > 0 && ` · ${compileResult.forbidden_action_count} forbidden action${compileResult.forbidden_action_count !== 1 ? "s" : ""}`}
                      </p>
                    </div>
                  )}
                  <div>
                    <button type="submit" disabled={compiling || !jsonInput.trim()} className="a-btn a-btn--primary" style={{ opacity: (compiling || !jsonInput.trim()) ? 0.5 : 1 }}>
                      {compiling ? "Compiling…" : "Compile skill"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>

          {/* Route list */}
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map(i => (
                <div key={i} style={{ height: 80, borderRadius: "var(--r-2)", background: "var(--graphite-soft)", opacity: 0.45 }} />
              ))}
            </div>
          ) : routes.length === 0 ? (
            <div className="a-card" style={{ textAlign: "center", padding: "48px 24px" }}>
              <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>No routes recorded yet.</p>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Open the demo bank page above, record a workflow, and it will appear here.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {routes.map(route => (
                <SkillCard
                  key={route.route_id}
                  route={route}
                  onDelete={handleDelete}
                  onVerified={handleVerified}
                  onRenamed={handleRenamed}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Marketplace tab ──────────────────────────────────────────────── */}
      {tab === "marketplace" && (
        <>
          {skillsLoading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map(i => (
                <div key={i} style={{ height: 80, borderRadius: "var(--r-2)", background: "var(--graphite-soft)", opacity: 0.45 }} />
              ))}
            </div>
          )}
          {skillsError && (
            <div style={{ background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-3)", padding: "14px 18px" }}>
              <div className="a-eyebrow" style={{ color: "var(--amber)", marginBottom: 4 }}>Error</div>
              <p style={{ fontSize: 13, color: "var(--ink-1)", margin: 0 }}>{skillsError}</p>
            </div>
          )}
          {!skillsLoading && !skillsError && skills.length === 0 && (
            <div className="a-card" style={{ textAlign: "center", padding: "48px 24px" }}>
              <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>No routes in the marketplace yet.</p>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Verify a route and submit it for review to publish it here.
              </p>
            </div>
          )}
          {!skillsLoading && skills.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {skills.map(skill => (
                <MarketplaceCard key={skill.skill_id} skill={skill} onInstallChange={handleInstallChange} />
              ))}
            </div>
          )}
        </>
      )}

    </div>
  );
}
