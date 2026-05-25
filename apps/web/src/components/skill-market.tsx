"use client";

import { useEffect, useRef, useState } from "react";
import type { AegisRoute, InstalledSkill, RoutePreviewAsset, RouteReplayAsset, RouteStep, RouteVerificationReport, Skill, StepVerificationResult } from "@aegis/types";
import { BASE } from "../lib/api";
import {
  getRoute, listRouteRuns, deleteRoute, verifyRoute, patchRoute, submitRouteForReview,
  installSkill, uninstallSkill,
} from "../lib/api";
import type { RouteRunWithSummary, SkillWithInstalled } from "../lib/api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const TIER_LABEL: Record<string, string> = {
  unverified_draft: "Draft",
  community: "Community",
  aegis_scanned: "Verified",
  aegis_reviewed: "Reviewed",
  run_verified: "Run Verified",
  business_official: "Business Official",
};

const VERIFIED_TIERS = new Set(["aegis_scanned", "aegis_reviewed", "run_verified", "business_official"]);
export function isRouteVerified(tier: string): boolean { return VERIFIED_TIERS.has(tier); }

export function trustBadgeVariant(tier: string): string {
  if (tier === "aegis_reviewed" || tier === "run_verified" || tier === "business_official") return "verified";
  if (tier === "aegis_scanned") return "scanned";
  if (tier === "community") return "pending";
  return "draft";
}

export function trustBadgeLabel(tier: string): string {
  if (tier === "aegis_reviewed") return "Marketplace Approved";
  if (tier === "run_verified") return "Run Verified";
  if (tier === "business_official") return "Business Official";
  if (tier === "aegis_scanned") return "Aegis Verified";
  if (tier === "community") return "Community";
  return "Needs Verification";
}

type PillColor = "green" | "amber" | "red" | "blue" | "graphite";
function pillStyle(color: PillColor): React.CSSProperties {
  const map: Record<PillColor, React.CSSProperties> = {
    green:    { background: "var(--green-soft)",    color: "oklch(0.42 0.09 150)", border: "1px solid var(--green-ring)" },
    amber:    { background: "var(--amber-soft)",    color: "oklch(0.45 0.12 75)",  border: "1px solid var(--amber-ring)" },
    red:      { background: "var(--red-soft)",      color: "oklch(0.45 0.13 25)",  border: "1px solid var(--red-ring)"  },
    blue:     { background: "var(--blue-soft)",     color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)" },
    graphite: { background: "var(--graphite-soft)", color: "var(--ink-3)",         border: "1px solid var(--hairline)"  },
  };
  return { ...map[color], fontSize: 11, fontWeight: 500, padding: "2px 9px", borderRadius: 999, display: "inline-flex", alignItems: "center" };
}

export function riskPillColor(level: string): PillColor {
  if (level === "low") return "green";
  if (level === "medium") return "amber";
  return "red";
}

export function friendlyDate(iso: string | undefined): string {
  if (!iso || iso === "1970-01-01T00:00:00.000Z") return "Never";
  return new Date(iso).toLocaleString();
}

export function friendlyShortDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function stepDescription(step: { description?: string; action: string; intent: string }): string {
  if (step.description?.trim()) return step.description;
  return `${step.action} — ${step.intent.replace(/_/g, " ")}`;
}

const ACTION_LABELS: Record<string, string> = {
  browse: "Browse pages", search: "Search", read: "Read content", compare: "Compare items",
  draft: "Draft text", add_to_cart: "Add to cart", login: "Log in", purchase: "Complete a purchase",
  payment: "Make a payment", subscription: "Start a subscription", post_publicly: "Post publicly",
  comment: "Post a comment", direct_message: "Send a direct message", send_email: "Send an email",
  forward_email: "Forward an email", upload_file: "Upload a file", download_file: "Download a file",
  submit_form: "Submit a form", create_account: "Create an account", share_email: "Share your email address",
  share_phone: "Share your phone number", share_address: "Share your address",
  identity_disclosure: "Disclose your identity", government_id_upload: "Upload a government ID",
  medical_data_disclosure: "Share medical data", financial_data_disclosure: "Share financial data",
  account_setting_change: "Change account settings", delete_account: "Delete an account",
  connect_app: "Connect an external app", oauth_authorize: "Authorize via OAuth",
};
export function friendlyAction(a: string): string { return ACTION_LABELS[a] ?? a; }

const RUN_STATUS_VARIANT: Record<string, string> = {
  completed: "green", pending: "graphite", running: "blue",
  pending_approval: "amber", failed: "red", blocked: "red",
};

// ─── Route Preview Components ─────────────────────────────────────────────────

interface PreviewStep { order: number; action: string; intent: string; description?: string; }

function RealRoutePreview({ asset }: { asset: RoutePreviewAsset }) {
  return (
    <div className="route-preview-frame">
      <img
        className="route-preview-image"
        src={`${BASE}${asset.url_path}`}
        alt="Route start page preview"
        draggable={false}
      />
    </div>
  );
}

function NeutralFallback({ name, domain, steps }: { name: string; domain: string; steps: PreviewStep[] }) {
  return (
    <div className="route-preview-fallback">
      <div className="route-preview-fallback__domain">{domain}</div>
      <div className="route-preview-fallback__name">{name}</div>
      {steps.slice(0, 3).map((step) => (
        <div key={step.order} className="route-preview-step-marker">
          <span className="route-preview-step-marker__num">{step.order}</span>
          <span className="route-preview-step-marker__action">{step.action}</span>
          <span className="route-preview-step-marker__desc">{stepDescription(step)}</span>
        </div>
      ))}
      {steps.length > 3 && (
        <div className="route-preview-fallback__more">+{steps.length - 3} more step{steps.length - 3 !== 1 ? "s" : ""}</div>
      )}
      {steps.length === 0 && (
        <div className="route-preview-fallback__more" style={{ fontStyle: "italic" }}>No steps recorded</div>
      )}
      <div className="route-preview-fallback__caption">No captured start page yet.</div>
    </div>
  );
}

// ─── StepReplayOverlay ────────────────────────────────────────────────────────

function StepReplayOverlay({ steps, playing }: { steps: PreviewStep[]; playing: boolean }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const reducedMotion = useRef(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  }, []);

  useEffect(() => {
    if (!playing) { setActiveIdx(0); return; }
    setActiveIdx(0);
    if (reducedMotion.current || steps.length <= 1) return;
    const id = setInterval(() => setActiveIdx(prev => (prev + 1) % steps.length), 1600);
    return () => clearInterval(id);
  }, [playing, steps.length]);

  const cls = `step-replay-overlay${playing ? " step-replay-overlay--playing" : ""}`;

  if (steps.length === 0) {
    return (
      <div className={cls}>
        <span className="step-replay-overlay__empty">No recorded steps yet.</span>
      </div>
    );
  }

  return (
    <div className={cls}>
      <p className="step-replay-overlay__header">Route replay</p>
      {steps.map((step, i) => {
        const isActive = reducedMotion.current || i === activeIdx;
        return (
          <div key={step.order} className={`step-replay-overlay__row${isActive ? " step-replay-overlay__row--active" : ""}`}>
            <span className="step-replay-overlay__dot" aria-hidden="true" />
            <span className="step-replay-overlay__num">{step.order}</span>
            <span className="step-replay-overlay__action">{step.action}</span>
            <span className="step-replay-overlay__desc">{stepDescription(step)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── SkillPreviewPane ─────────────────────────────────────────────────────────

export function SkillPreviewPane({ domain, name, steps, trustTier, executionMode, previewAssets, replayAssets, enableReplay, replaying }: {
  domain: string;
  name: string;
  steps: PreviewStep[];
  trustTier: string;
  executionMode?: string;
  previewAssets?: RoutePreviewAsset[];
  replayAssets?: RouteReplayAsset[];
  enableReplay?: boolean;
  replaying?: boolean;
}) {
  const isLocal = domain === "localhost" || domain === "127.0.0.1";
  const dotColor = isLocal ? "oklch(0.62 0.09 150)" : "oklch(0.62 0.09 240)";
  const startPageAsset = previewAssets?.find(a => a.kind === "start_page");
  const replayVideoAsset = replayAssets?.find(a => a.kind === "replay_video");
  const replayPosterAsset = replayAssets?.find(a => a.kind === "poster_frame");

  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoVisible, setVideoVisible] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (replaying) {
      setVideoVisible(false);
      video.currentTime = 0;
      video.play().catch(() => {});
    } else {
      setVideoVisible(false);
      video.pause();
      video.currentTime = 0;
    }
  }, [replaying]);

  const posterSrc = replayPosterAsset
    ? `${BASE}${replayPosterAsset.url_path}`
    : startPageAsset
    ? `${BASE}${startPageAsset.url_path}`
    : undefined;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "linear-gradient(160deg, #fff 0%, var(--bg-2) 100%)" }}>
      {/* Browser chrome bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", background: "rgba(255,255,255,0.92)", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "oklch(0.7 0.1 25 / 0.9)" }} />
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "oklch(0.75 0.1 75 / 0.9)" }} />
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "oklch(0.65 0.09 150 / 0.9)" }} />
        </div>
        <div style={{ flex: 1, height: 20, borderRadius: 6, background: "var(--graphite-soft)", border: "1px solid var(--hairline)", display: "flex", alignItems: "center", padding: "0 8px", gap: 5, overflow: "hidden" }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
          <span style={{ fontSize: 9.5, color: "var(--ink-3)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {domain}
          </span>
        </div>
      </div>

      {/* Preview content: replay video > static screenshot > neutral fallback */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", position: "relative" }}>
        {replayVideoAsset ? (
          <div
            className="route-replay-media"
            style={posterSrc ? {
              backgroundImage: `url(${posterSrc})`,
            } : undefined}
          >
            {/* Video opacity-0 until first frame confirmed painted; poster is the CSS background */}
            <video
              ref={videoRef}
              className={`route-replay-video${videoVisible ? " route-replay-video--visible" : ""}`}
              src={`${BASE}${replayVideoAsset.url_path}`}
              muted
              playsInline
              preload="auto"
              onPlaying={() => {
                if (!replaying) return;
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    if (videoRef.current && !videoRef.current.paused) {
                      setVideoVisible(true);
                    }
                  });
                });
              }}
            />
            {!posterSrc && (
              <div className={`route-replay-fallback-overlay${videoVisible ? " route-replay-fallback-overlay--hidden" : ""}`}>
                <NeutralFallback name={name} domain={domain} steps={steps} />
              </div>
            )}
          </div>
        ) : startPageAsset ? (
          <>
            <RealRoutePreview asset={startPageAsset} />
            {enableReplay && <StepReplayOverlay steps={steps} playing={replaying ?? false} />}
          </>
        ) : (
          <>
            <NeutralFallback name={name} domain={domain} steps={steps} />
            {enableReplay && <StepReplayOverlay steps={steps} playing={replaying ?? false} />}
          </>
        )}
      </div>

      {/* Trust strip */}
      <div style={{ padding: "5px 12px", borderTop: "1px solid var(--hairline)", background: "rgba(255,255,255,0.65)", display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
        <span className={`skill-badge skill-badge--${trustBadgeVariant(trustTier)}`}>{trustBadgeLabel(trustTier)}</span>
        {executionMode === "aegis_controlled" && (
          <span className="skill-badge skill-badge--scanned">Aegis Controlled</span>
        )}
      </div>
    </div>
  );
}

// ─── RenameModal ──────────────────────────────────────────────────────────────

function RenameModal({ current, onSave, onCancel }: { current: string; onSave: (n: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) { setError("Name cannot be empty."); return; }
    setSaving(true); setError(null);
    try { await onSave(trimmed); }
    catch (err: any) { setError(err.message ?? "Save failed."); setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(20,22,30,0.45)", backdropFilter: "blur(4px)" }}>
      <div className="a-card" style={{ width: "100%", maxWidth: 360, margin: "0 16px", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>Rename skill</p>
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input ref={inputRef} type="text" value={value} onChange={e => setValue(e.target.value)} className="ag-input" placeholder="Skill name" disabled={saving} />
          {error && <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onCancel} disabled={saving} className="a-btn a-btn--ghost">Cancel</button>
            <button type="submit" disabled={saving || !value.trim()} className="a-btn a-btn--primary">{saving ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── SkillDetailModal ─────────────────────────────────────────────────────────

type ModalMode =
  | { type: "private_rail"; route: AegisRoute; onDelete: (id: string) => void; onVerified: (id: string) => void; onRenamed: (id: string, name: string) => void; }
  | { type: "marketplace"; skill: SkillWithInstalled; onInstallChange: (id: string, installed: boolean) => void; }
  | { type: "library"; skill: Skill; installedAt: string; onInstallChange: (id: string, installed: boolean) => void; };

export interface SkillDetailModalProps {
  routeId: string;
  mode: ModalMode;
  onClose: () => void;
}

export function SkillDetailModal({ routeId, mode, onClose }: SkillDetailModalProps) {
  const [route, setRoute] = useState<AegisRoute | null>(mode.type === "private_rail" ? mode.route : null);
  const [loadingRoute, setLoadingRoute] = useState(mode.type !== "private_rail");
  const [routeError, setRouteError] = useState<string | null>(null);

  const [runs, setRuns] = useState<RouteRunWithSummary[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  // Management state (private_rail only)
  const [showRename, setShowRename] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyReport, setVerifyReport] = useState<RouteVerificationReport | null>(
    mode.type === "private_rail" ? (mode.route.verification_report ?? null) : null
  );
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [localTier, setLocalTier] = useState(mode.type === "private_rail" ? mode.route.trust_tier : "");
  const [localName, setLocalName] = useState(mode.type === "private_rail" ? mode.route.workflow_name : (mode.type === "marketplace" ? mode.skill.name : mode.skill.name));
  const [localMktStatus, setLocalMktStatus] = useState(mode.type === "private_rail" ? (mode.route.marketplace_status ?? "private") : "");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Install state (marketplace/library)
  const [installed, setInstalled] = useState(
    mode.type === "marketplace" ? mode.skill.installed :
    mode.type === "library" ? true : false
  );
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const skillId = mode.type === "marketplace" ? mode.skill.skill_id : mode.type === "library" ? mode.skill.skill_id : null;

  // Fetch route if needed
  useEffect(() => {
    if (mode.type !== "private_rail") {
      setLoadingRoute(true);
      getRoute(routeId)
        .then(r => { setRoute(r); setLoadingRoute(false); })
        .catch(err => { setRouteError(err.message ?? "Could not load route."); setLoadingRoute(false); });
    }
  }, [routeId, mode.type]);

  // Fetch recent runs
  useEffect(() => {
    listRouteRuns({ route_id: routeId })
      .then(setRuns)
      .catch(() => {})
      .finally(() => setLoadingRuns(false));
  }, [routeId]);

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // Private rail actions
  async function handleVerify() {
    if (mode.type !== "private_rail") return;
    setVerifying(true); setVerifyError(null);
    try {
      const report = await verifyRoute(routeId);
      setVerifyReport(report);
      if (report.promoted_trust_tier) setLocalTier(report.promoted_trust_tier);
      mode.onVerified(routeId);
    } catch (err: any) {
      setVerifyError(err.message ?? "Verification failed.");
    } finally { setVerifying(false); }
  }

  async function handleRename(newName: string) {
    if (mode.type !== "private_rail") return;
    await patchRoute(routeId, { workflow_name: newName });
    setLocalName(newName);
    mode.onRenamed(routeId, newName);
    setShowRename(false);
  }

  async function handleSubmitForReview() {
    setSubmitting(true); setSubmitError(null);
    try {
      const updated = await submitRouteForReview(routeId);
      setLocalMktStatus(updated.marketplace_status ?? "pending_review");
    } catch (err: any) {
      setSubmitError(err.message ?? "Submission failed.");
    } finally { setSubmitting(false); }
  }

  async function handleDelete() {
    if (mode.type !== "private_rail") return;
    setDeleting(true);
    try { await deleteRoute(routeId); mode.onDelete(routeId); onClose(); }
    catch { setDeleting(false); }
  }

  // Install/uninstall actions
  async function handleInstall() {
    if (!skillId) return;
    setInstalling(true); setInstallError(null);
    try {
      await installSkill(skillId);
      setInstalled(true);
      if (mode.type === "marketplace") mode.onInstallChange(skillId, true);
      if (mode.type === "library") mode.onInstallChange(skillId, true);
    } catch (err: any) { setInstallError(err.message ?? "Install failed."); }
    finally { setInstalling(false); }
  }

  async function handleUninstall() {
    if (!skillId) return;
    setInstalling(true); setInstallError(null);
    try {
      await uninstallSkill(skillId);
      setInstalled(false);
      if (mode.type === "marketplace") mode.onInstallChange(skillId, false);
      if (mode.type === "library") mode.onInstallChange(skillId, false);
    } catch (err: any) { setInstallError(err.message ?? "Uninstall failed."); }
    finally { setInstalling(false); }
  }

  const sectionLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-3)", margin: "0 0 10px" };
  const effectiveTier = mode.type === "private_rail" ? localTier : (route?.trust_tier ?? "");
  const sourceBadge = mode.type === "private_rail" ? "Private Rail" : mode.type === "marketplace" ? "Marketplace" : "Installed";
  const sourceBadgeVariant = mode.type === "private_rail" ? "private" : mode.type === "marketplace" ? "mkt" : "installed";
  const displayName = mode.type === "private_rail" ? localName : (mode.type === "marketplace" ? mode.skill.name : mode.skill.name);

  return (
    <>
      {showRename && mode.type === "private_rail" && (
        <RenameModal current={localName} onSave={handleRename} onCancel={() => setShowRename(false)} />
      )}
      <div className="skill-modal-backdrop" onClick={handleBackdrop}>
        <div className="skill-modal" role="dialog" aria-modal="true">

          {/* Header */}
          <div className="skill-modal__header">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span className={`skill-badge skill-badge--${sourceBadgeVariant}`}>{sourceBadge}</span>
                {effectiveTier && (
                  <span className={`skill-badge skill-badge--${trustBadgeVariant(effectiveTier)}`}>{trustBadgeLabel(effectiveTier)}</span>
                )}
              </div>
              <h2 style={{ fontSize: 17, fontWeight: 600, color: "var(--ink-1)", margin: 0, lineHeight: 1.3 }}>{displayName}</h2>
              <p style={{ fontSize: 11.5, fontFamily: "monospace", color: "var(--ink-4)", margin: 0 }}>{routeId}</p>
            </div>
            <button className="skill-modal__close" onClick={onClose} aria-label="Close">×</button>
          </div>

          {/* Body */}
          <div className="skill-modal__body">

            {/* Domain + execution info */}
            {route && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <p style={sectionLabel}>Route details</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                  <div style={{ background: "var(--graphite-soft)", border: "1px solid var(--hairline)", borderRadius: "var(--r-1)", padding: "5px 10px" }}>
                    <span style={{ color: "var(--ink-4)", marginRight: 5 }}>Domain</span>
                    <span style={{ fontFamily: "monospace", color: "var(--ink-1)", fontWeight: 500 }}>{route.domain}</span>
                  </div>
                  {route.start_url && (
                    <div style={{ background: "var(--graphite-soft)", border: "1px solid var(--hairline)", borderRadius: "var(--r-1)", padding: "5px 10px" }}>
                      <span style={{ color: "var(--ink-4)", marginRight: 5 }}>Start URL</span>
                      <span style={{ fontFamily: "monospace", color: "var(--ink-2)", fontSize: 11.5 }}>{route.start_url}</span>
                    </div>
                  )}
                  <div style={{ background: "var(--graphite-soft)", border: "1px solid var(--hairline)", borderRadius: "var(--r-1)", padding: "5px 10px" }}>
                    <span style={{ color: "var(--ink-4)", marginRight: 5 }}>Mode</span>
                    <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>{route.execution_mode?.replace(/_/g, " ")}</span>
                  </div>
                  <div style={{ background: "var(--graphite-soft)", border: "1px solid var(--hairline)", borderRadius: "var(--r-1)", padding: "5px 10px" }}>
                    <span style={{ color: "var(--ink-4)", marginRight: 5 }}>Risk</span>
                    <span style={pillStyle(riskPillColor(route.risk_level))}>{route.risk_level}</span>
                  </div>
                  {route.sensitivity_level === "sensitive" && (
                    <div style={{ background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-1)", padding: "5px 10px" }}>
                      <span style={{ color: "oklch(0.45 0.12 75)", fontWeight: 500 }}>Sensitive workflow</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {loadingRoute && !route && (
              <div style={{ height: 60, borderRadius: "var(--r-2)", background: "var(--graphite-soft)", opacity: 0.5 }} />
            )}
            {routeError && (
              <div style={{ padding: "10px 14px", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-2)", fontSize: 12.5, color: "oklch(0.45 0.13 25)" }}>
                {routeError}
              </div>
            )}

            {/* Steps */}
            {route && route.steps.length > 0 && (
              <div>
                <p style={sectionLabel}>Workflow steps</p>
                <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {route.steps.map((step) => (
                    <li key={step.step_id} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12.5, color: "var(--ink-2)", background: "rgba(255,255,255,0.6)", border: "1px solid var(--hairline)", borderRadius: "var(--r-1)", padding: "8px 12px" }}>
                      <span style={{ flexShrink: 0, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--graphite-soft)", borderRadius: "var(--r-1)", fontSize: 10.5, color: "var(--ink-3)", fontFamily: "monospace", marginTop: 1 }}>
                        {step.order}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 11, color: "oklch(0.45 0.09 240)", fontFamily: "monospace", marginRight: 6 }}>{step.action}</span>
                        <span>{stepDescription(step)}</span>
                      </div>
                      {step.approval_required && (
                        <span style={{ ...pillStyle("amber"), flexShrink: 0, marginTop: 2 }}>approval required</span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* Forbidden actions */}
            {route && route.forbidden_actions.length > 0 && (
              <div>
                <p style={sectionLabel}>Will not do</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {route.forbidden_actions.map(a => (
                    <span key={a} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-1)", padding: "3px 10px" }}>
                      <span style={{ fontSize: 11 }}>✗</span>{friendlyAction(a)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Required permissions */}
            {route && route.required_permissions.length > 0 && (
              <div>
                <p style={sectionLabel}>Required permissions</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {route.required_permissions.map(p => (
                    <span key={p} style={{ fontSize: 12, color: "var(--ink-2)", background: "var(--graphite-soft)", border: "1px solid var(--hairline)", borderRadius: "var(--r-1)", padding: "3px 10px" }}>
                      {friendlyAction(p)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Skill summary */}
            {(mode.type === "marketplace" || mode.type === "library") && (
              <>
                {mode.skill.summary && (
                  <div>
                    <p style={sectionLabel}>About this skill</p>
                    <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0, lineHeight: 1.6 }}>{mode.skill.summary}</p>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {installError && <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{installError}</p>}
                  {installed ? (
                    <button onClick={handleUninstall} disabled={installing} style={{ ...pillStyle("red"), fontSize: 12.5, padding: "6px 14px", cursor: installing ? "not-allowed" : "pointer", opacity: installing ? 0.5 : 1, border: "1px solid var(--red-ring)" }}>
                      {installing ? "…" : "Uninstall"}
                    </button>
                  ) : (
                    <button onClick={handleInstall} disabled={installing} className="a-btn a-btn--primary" style={{ opacity: installing ? 0.5 : 1 }}>
                      {installing ? "Installing…" : "Install skill"}
                    </button>
                  )}
                  {installed && <span style={{ fontSize: 12, color: "oklch(0.42 0.09 150)", fontWeight: 500 }}>Installed in your Skill Library</span>}
                  {mode.type === "library" && (
                    <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Installed {friendlyShortDate(mode.installedAt)}</span>
                  )}
                </div>
              </>
            )}

            {/* Verification result (private rail) */}
            {mode.type === "private_rail" && verifyReport && (
              <div>
                <p style={sectionLabel}>Verification result</p>
                <div style={{ fontSize: 12.5, borderRadius: "var(--r-2)", padding: "8px 12px", marginBottom: 6, ...(verifyReport.passed ? { color: "oklch(0.42 0.09 150)", background: "var(--green-soft)", border: "1px solid var(--green-ring)" } : { color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)" }) }}>
                  {verifyReport.passed
                    ? `Verified — ${verifyReport.step_results.filter(r => r.passed).length}/${verifyReport.step_results.length} steps passed`
                    : `Failed — ${verifyReport.step_results.filter(r => r.passed).length}/${verifyReport.step_results.length} steps passed`}
                </div>
              </div>
            )}
            {verifyError && (
              <div style={{ fontSize: 12, padding: "8px 12px", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-2)", color: "oklch(0.45 0.13 25)" }}>
                Verification error: {verifyError}
              </div>
            )}
            {submitError && (
              <div style={{ fontSize: 12, padding: "8px 12px", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-2)", color: "oklch(0.45 0.13 25)" }}>
                {submitError}
              </div>
            )}

            {/* Management actions (private rail) */}
            {mode.type === "private_rail" && (
              <div>
                <p style={sectionLabel}>Manage</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <button onClick={handleVerify} disabled={verifying || deleting} className="a-btn a-btn--ghost" style={{ fontSize: 12.5, opacity: (verifying || deleting) ? 0.5 : 1 }}>
                    {verifying ? "Verifying…" : "Verify"}
                  </button>
                  <button onClick={() => setShowRename(true)} disabled={verifying || deleting} className="a-btn a-btn--ghost" style={{ fontSize: 12.5, opacity: (verifying || deleting) ? 0.5 : 1 }}>
                    Rename
                  </button>
                  {localMktStatus === "approved" ? (
                    <span style={{ fontSize: 12, color: "oklch(0.42 0.09 150)", fontWeight: 500 }}>Marketplace approved</span>
                  ) : localMktStatus === "rejected" ? (
                    <span style={{ ...pillStyle("red"), fontSize: 12 }}>Rejected</span>
                  ) : localMktStatus === "pending_review" ? (
                    <span style={{ ...pillStyle("amber"), fontSize: 12 }}>Pending review</span>
                  ) : isRouteVerified(localTier) ? (
                    <button onClick={handleSubmitForReview} disabled={submitting || deleting || verifying} className="a-btn a-btn--ghost" style={{ fontSize: 12.5, opacity: (submitting || deleting || verifying) ? 0.5 : 1 }}>
                      {submitting ? "Submitting…" : "Submit for Review"}
                    </button>
                  ) : (
                    <button disabled title="Verify first." className="a-btn a-btn--ghost" style={{ fontSize: 12.5, opacity: 0.35, cursor: "not-allowed" }}>Submit for Review</button>
                  )}
                  <button onClick={handleDelete} disabled={deleting || verifying} style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 500, padding: "6px 12px", borderRadius: "var(--r-1)", background: "var(--red-soft)", border: "1px solid var(--red-ring)", color: "oklch(0.45 0.13 25)", cursor: (deleting || verifying) ? "not-allowed" : "pointer", opacity: (deleting || verifying) ? 0.5 : 1 }}>
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            )}

            {/* Recent runs */}
            <div>
              <p style={sectionLabel}>Recent runs</p>
              {loadingRuns ? (
                <div style={{ height: 40, background: "var(--graphite-soft)", borderRadius: "var(--r-2)", opacity: 0.4 }} />
              ) : runs.length === 0 ? (
                <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: 0 }}>No runs recorded yet for this route.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {runs.slice(0, 8).map(run => (
                    <div key={run.run_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,0.6)", border: "1px solid var(--hairline)", borderRadius: "var(--r-1)", fontSize: 12 }}>
                      <span style={{ fontFamily: "monospace", color: "var(--ink-4)", fontSize: 11, flexShrink: 0 }}>{run.run_id.slice(0, 18)}…</span>
                      <span className={`a-status a-status--${RUN_STATUS_VARIANT[run.status] ?? "graphite"}`}>
                        <span className="a-status__dot" />{run.status}
                      </span>
                      <span style={{ color: "var(--ink-4)", fontSize: 11.5, marginLeft: "auto", flexShrink: 0 }}>
                        {friendlyShortDate(run.completed_at ?? run.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
