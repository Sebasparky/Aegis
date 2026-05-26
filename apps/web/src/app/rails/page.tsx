"use client";

import { useEffect, useState } from "react";
import type { AegisRoute } from "@aegis/types";
import {
  listRoutes, recordRoute,
  listSkills,
} from "../../lib/api";
import type { SkillWithInstalled } from "../../lib/api";
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";
import {
  SkillPreviewPane, SkillDetailModal,
  isRouteVerified, TIER_LABEL,
} from "@/components/skill-market";

// ─── Design primitives ────────────────────────────────────────────────────────

function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

// ─── PrivateRailCard ──────────────────────────────────────────────────────────

function PrivateRailCard({ route, onClick }: { route: AegisRoute; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      className="skill-mcard"
      onClick={onClick}
      type="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="skill-mcard__preview skill-mcard__preview--lg">
        <SkillPreviewPane
          domain={route.domain}
          name={route.workflow_name}
          steps={route.steps}
          trustTier={route.trust_tier}
          executionMode={route.execution_mode}
          previewAssets={route.preview_assets}
          replayAssets={route.replay_assets}
          enableReplay={true}
          replaying={hovered}
          showTrustStrip={false}
        />
      </div>

      <div className="skill-mcard__body">
        <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)", lineHeight: 1.3 }}>
          {route.workflow_name}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "monospace" }}>{route.domain}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", fontSize: 11.5, color: "var(--ink-4)" }}>
          <span style={{ color: isRouteVerified(route.trust_tier) ? "oklch(0.42 0.09 150)" : "var(--ink-4)" }}>
            {isRouteVerified(route.trust_tier) ? "✓ Verified" : "Needs verification"}
          </span>
          {route.risk_level !== "low" && (
            <>
              <span>·</span>
              <span style={{ color: route.risk_level === "high" ? "oklch(0.45 0.13 25)" : "oklch(0.45 0.12 75)" }}>
                {route.risk_level} risk
              </span>
            </>
          )}
          {route.marketplace_status === "approved" && (
            <>
              <span>·</span>
              <span>Listed</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── MarketplaceGridCard ──────────────────────────────────────────────────────

function MarketplaceGridCard({ skill, onClick }: { skill: SkillWithInstalled; onClick: () => void }) {
  return (
    <button className="skill-mcard" onClick={onClick} type="button">
      <div className="skill-mcard__preview">
        <SkillPreviewPane
          domain={skill.domain}
          name={skill.name}
          steps={[]}
          trustTier={skill.trust_tier}
          executionMode={skill.execution_mode}
          showTrustStrip={false}
        />
        <div className="skill-mcard__overlay">
          {skill.summary && (
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0, lineHeight: 1.5, flex: 1, overflow: "hidden" }}>
              {skill.summary}
            </p>
          )}
          <div style={{ flexShrink: 0, fontSize: 12, fontWeight: 500 }}>
            {skill.created_by_you ? (
              <span style={{ color: "var(--blue)" }}>View your listing →</span>
            ) : skill.installed ? (
              <span style={{ color: "oklch(0.42 0.09 150)" }}>✓ In library</span>
            ) : (
              <span style={{ color: "var(--blue)" }}>Install →</span>
            )}
          </div>
        </div>
      </div>

      <div className="skill-mcard__body">
        <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)", lineHeight: 1.3 }}>{skill.name}</div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "monospace" }}>{skill.domain}</div>
        {skill.summary && (
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {skill.summary}
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", fontSize: 11.5, color: "var(--ink-4)" }}>
          <span style={{ color: isRouteVerified(skill.trust_tier) ? "oklch(0.42 0.09 150)" : "var(--ink-4)" }}>
            {isRouteVerified(skill.trust_tier) ? "✓ Verified" : "Needs verification"}
          </span>
          {skill.risk_level && skill.risk_level !== "low" && (
            <>
              <span>·</span>
              <span style={{ color: skill.risk_level === "high" ? "oklch(0.45 0.13 25)" : "oklch(0.45 0.12 75)" }}>
                {skill.risk_level} risk
              </span>
            </>
          )}
          {skill.created_by_you && (
            <>
              <span>·</span>
              <span>Created by you</span>
            </>
          )}
          {!skill.created_by_you && skill.installed && (
            <>
              <span>·</span>
              <span style={{ color: "oklch(0.42 0.09 150)" }}>In library</span>
            </>
          )}
        </div>
      </div>
    </button>
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

  // Modal state
  const [modalRouteId, setModalRouteId] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<"private_rail" | "marketplace" | null>(null);

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
    setModalRouteId(null);
    setModalMode(null);
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

  function openRailModal(routeId: string) {
    setModalRouteId(routeId);
    setModalMode("private_rail");
  }

  function openMarketplaceModal(routeId: string) {
    setModalRouteId(routeId);
    setModalMode("marketplace");
  }

  function closeModal() {
    setModalRouteId(null);
    setModalMode(null);
  }

  async function handleCompile(e: React.FormEvent) {
    e.preventDefault();
    setCompiling(true); setCompileError(null); setCompileResult(null);
    let parsed: unknown;
    try { parsed = JSON.parse(jsonInput); }
    catch { setCompileError("Invalid JSON — paste the recording payload from the demo bank page."); setCompiling(false); return; }
    try {
      const result = await recordRoute(parsed as any);
      setCompileResult(result);
      const updated = await listRoutes();
      setRoutes(updated);
    } catch (err: any) {
      setCompileError(err.message ?? "Compilation failed.");
    } finally { setCompiling(false); }
  }

  const verifiedCount = routes.filter(r => isRouteVerified(r.trust_tier)).length;
  const installedCount = skills.filter(s => s.installed).length;

  // Find the selected route and skill for the modal
  const selectedRoute = modalRouteId ? routes.find(r => r.route_id === modalRouteId) ?? null : null;
  const selectedSkill = modalRouteId && modalMode === "marketplace"
    ? skills.find(s => s.route_id === modalRouteId) ?? null
    : null;

  return (
    <div className="page">

      {/* ── Detail modal ─────────────────────────────────────────────────── */}
      {modalRouteId && modalMode === "private_rail" && selectedRoute && (
        <SkillDetailModal
          routeId={modalRouteId}
          onClose={closeModal}
          mode={{
            type: "private_rail",
            route: selectedRoute,
            onDelete: handleDelete,
            onVerified: handleVerified,
            onRenamed: handleRenamed,
          }}
        />
      )}
      {modalRouteId && modalMode === "marketplace" && selectedSkill && (
        <SkillDetailModal
          skillId={selectedSkill.skill_id}
          routeId={modalRouteId}
          onClose={closeModal}
          mode={{
            type: "marketplace",
            skill: selectedSkill,
            onInstallChange: handleInstallChange,
          }}
        />
      )}

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div className="a-eyebrow">Rails</div>
          <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
            Skills,{" "}
            <span className="cmd-hero__title-mark">marketplace.</span>
          </h1>
          <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
            Browse verified workflows agents can run on your behalf. Private rails are yours alone. Marketplace skills are reviewed and trusted.
          </p>
          <div className="header-stats">
            <HeaderStat value={loading ? "—" : routes.length} label="My Rails" />
            <HeaderStat value={loading ? "—" : verifiedCount} label="Verified" />
            <HeaderStat value={skillsLoading ? "—" : installedCount} label="Installed" />
          </div>
        </div>
      </SpotlightHeroCard>

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
              {i < arr.length - 1 && <span style={{ fontSize: 11, color: "var(--ink-4)", margin: "0 1px" }}>→</span>}
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
              </div>
              <a href="http://localhost:3001/bank.html" target="_blank" rel="noopener noreferrer" className="a-btn a-btn--primary" style={{ flexShrink: 0 }}>
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

          {/* Route grid */}
          {loading ? (
            <div className="skill-grid skill-grid--rails">
              {[1, 2, 3].map(i => (
                <div key={i} style={{ height: 360, borderRadius: "var(--r-3)", background: "var(--graphite-soft)", opacity: 0.35 }} />
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
            <div className="skill-grid skill-grid--rails">
              {routes.map(route => (
                <PrivateRailCard
                  key={route.route_id}
                  route={route}
                  onClick={() => openRailModal(route.route_id)}
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
            <div className="skill-grid">
              {[1, 2, 3].map(i => (
                <div key={i} style={{ height: 260, borderRadius: "var(--r-3)", background: "var(--graphite-soft)", opacity: 0.35 }} />
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
              <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>No skills in the marketplace yet.</p>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Verify a route and submit it for review to publish it here.
              </p>
            </div>
          )}
          {!skillsLoading && skills.length > 0 && (
            <div className="skill-grid">
              {skills.map(skill => (
                <MarketplaceGridCard
                  key={skill.skill_id}
                  skill={skill}
                  onClick={() => openMarketplaceModal(skill.route_id)}
                />
              ))}
            </div>
          )}
        </>
      )}

    </div>
  );
}
