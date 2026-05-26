"use client";

import { useEffect, useState } from "react";
import { listSkills, getSkill, type SkillWithInstalled } from "../../lib/api";
import { MarketplaceSkillCard, SkillDetailModal, riskPillColor } from "@/components/skill-market";

export default function MarketplacePage() {
  const [skills, setSkills] = useState<SkillWithInstalled[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalSkillId, setModalSkillId] = useState<string | null>(null);
  const [directSkill, setDirectSkill] = useState<SkillWithInstalled | null>(null);
  const [fromRails, setFromRails] = useState(false);

  useEffect(() => {
    listSkills().then(setSkills).finally(() => setLoading(false));
  }, []);

  // Read query params on mount (client-only)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const skillParam = params.get("skill");
    const fromParam = params.get("from");
    if (fromParam === "rails") setFromRails(true);
    if (skillParam) setModalSkillId(skillParam);
  }, []);

  // When skills are loaded and deep-linked skill isn't in the active list (e.g. unlisted), fetch it directly
  useEffect(() => {
    if (!modalSkillId || loading) return;
    const found = skills.find(s => s.skill_id === modalSkillId);
    if (!found) {
      getSkill(modalSkillId)
        .then(detail => setDirectSkill({ ...detail }))
        .catch(() => setDirectSkill(null));
    }
  }, [modalSkillId, skills, loading]);

  function handleInstallChange(skillId: string, installed: boolean) {
    setSkills(prev => prev.map(s => s.skill_id === skillId ? { ...s, installed } : s));
    if (directSkill?.skill_id === skillId) {
      setDirectSkill(prev => prev ? { ...prev, installed } : null);
    }
  }

  function handleCloseModal() {
    setModalSkillId(null);
    setDirectSkill(null);
    // Clear URL params without full navigation
    const url = new URL(window.location.href);
    if (url.searchParams.has("skill") || url.searchParams.has("from")) {
      url.searchParams.delete("skill");
      url.searchParams.delete("from");
      window.history.replaceState({}, "", url.pathname);
      setFromRails(false);
    }
  }

  const selectedSkill = modalSkillId
    ? (skills.find(s => s.skill_id === modalSkillId) ?? directSkill ?? null)
    : null;

  return (
    <div className="page">
      {selectedSkill && (
        <SkillDetailModal
          skillId={selectedSkill.skill_id}
          onClose={handleCloseModal}
          mode={{
            type: "marketplace",
            skill: selectedSkill,
            onInstallChange: handleInstallChange,
          }}
          backLink={fromRails ? { label: "Back to Rails", href: "/rails" } : undefined}
        />
      )}

      {/* Hero */}
      <div className="a-card" style={{ padding: "24px 28px 20px", marginBottom: 0 }}>
        {fromRails && !modalSkillId && (
          <a href="/rails" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--blue)", textDecoration: "none", marginBottom: 12 }}>
            ← Back to Rails
          </a>
        )}
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
            {skills.filter(s => s.installed).length > 0 && ` · ${skills.filter(s => s.installed).length} in your library`}
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
            <MarketplaceSkillCard
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
