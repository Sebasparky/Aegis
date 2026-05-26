"use client";

import { useEffect, useState } from "react";
import { listSkills, installSkill, uninstallSkill, type SkillWithInstalled } from "../../lib/api";
import { SkillPreviewPane, SkillDetailModal, trustBadgeVariant, trustBadgeLabel, riskPillColor } from "@/components/skill-market";

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

function MarketplaceBrowseCard({ skill, onClick }: { skill: SkillWithInstalled; onClick: () => void }) {
  return (
    <button className="skill-mcard" onClick={onClick} type="button">
      <div className="skill-mcard__preview">
        <SkillPreviewPane
          domain={skill.domain}
          name={skill.name}
          steps={[]}
          trustTier={skill.trust_tier}
          executionMode={skill.execution_mode}
        />
        <div className="skill-mcard__overlay">
          {skill.summary && (
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0, lineHeight: 1.5, flex: 1, overflow: "hidden" }}>
              {skill.summary}
            </p>
          )}
          {skill.approval_gates.length > 0 && (
            <p style={{ fontSize: 11.5, color: "oklch(0.45 0.12 75)", margin: 0, flexShrink: 0 }}>
              {skill.approval_gates.length} approval gate{skill.approval_gates.length !== 1 ? "s" : ""}
            </p>
          )}
          <div style={{ flexShrink: 0 }}>
            {skill.installed ? (
              <span style={{ fontSize: 12, fontWeight: 500, color: "oklch(0.42 0.09 150)" }}>✓ Installed in your library</span>
            ) : (
              <span style={{ fontSize: 12, color: "var(--blue)", fontWeight: 500 }}>Click to view and install →</span>
            )}
          </div>
        </div>
      </div>
      <div className="skill-mcard__body">
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          <span className="skill-badge skill-badge--mkt">Marketplace</span>
          <span className={`skill-badge skill-badge--${trustBadgeVariant(skill.trust_tier)}`}>
            {trustBadgeLabel(skill.trust_tier)}
          </span>
          {skill.installed && <span className="skill-badge skill-badge--installed">Installed</span>}
        </div>
        <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)", lineHeight: 1.3 }}>{skill.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
          <span style={{ fontFamily: "monospace", color: "var(--ink-2)", fontSize: 11.5 }}>{skill.domain}</span>
          {skill.risk_level && skill.risk_level !== "low" && (
            <>
              <span className="dot-sep">·</span>
              <span style={pillStyle(riskPillColor(skill.risk_level))}>{skill.risk_level} risk</span>
            </>
          )}
        </div>
        {skill.summary && (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {skill.summary}
          </p>
        )}
      </div>
    </button>
  );
}

export default function MarketplacePage() {
  const [skills, setSkills] = useState<SkillWithInstalled[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalSkillId, setModalSkillId] = useState<string | null>(null);

  useEffect(() => {
    listSkills().then(setSkills).finally(() => setLoading(false));
  }, []);

  function handleInstallChange(skillId: string, installed: boolean) {
    setSkills(prev => prev.map(s => s.skill_id === skillId ? { ...s, installed } : s));
  }

  const selectedSkill = modalSkillId ? skills.find(s => s.skill_id === modalSkillId) ?? null : null;

  return (
    <div className="page">
      {selectedSkill && (
        <SkillDetailModal
          skillId={selectedSkill.skill_id}
          onClose={() => setModalSkillId(null)}
          mode={{
            type: "marketplace",
            skill: selectedSkill,
            onInstallChange: handleInstallChange,
          }}
        />
      )}

      {/* Hero */}
      <div className="a-card" style={{ padding: "24px 28px 20px", marginBottom: 0 }}>
        <div className="a-eyebrow">Marketplace</div>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--ink-1)", margin: "6px 0 8px", letterSpacing: "-0.02em" }}>
          Skill Marketplace
        </h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0, lineHeight: 1.6, maxWidth: 560 }}>
          Approved, verified workflow skills. Install any skill into your library — your agents will use installed skills
          when operating on the matching domain.
        </p>
        {!loading && skills.length > 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "10px 0 0" }}>
            {skills.length} skill{skills.length !== 1 ? "s" : ""} available
            {skills.filter(s => s.installed).length > 0 && ` · ${skills.filter(s => s.installed).length} installed`}
          </p>
        )}
      </div>

      {loading ? (
        <div className="skill-grid">
          {[1, 2, 3].map(i => (
            <div key={i} style={{ height: 260, borderRadius: "var(--r-3)", background: "var(--graphite-soft)", opacity: 0.35 }} />
          ))}
        </div>
      ) : skills.length === 0 ? (
        <div className="a-card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>No approved skills yet.</p>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
            Approve a route from{" "}
            <a href="/marketplace-review" style={{ color: "var(--blue)", textDecoration: "underline" }}>Marketplace Review</a>{" "}
            to publish a skill here.
          </p>
        </div>
      ) : (
        <div className="skill-grid">
          {skills.map(skill => (
            <MarketplaceBrowseCard
              key={skill.skill_id}
              skill={skill}
              onClick={() => setModalSkillId(skill.skill_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
