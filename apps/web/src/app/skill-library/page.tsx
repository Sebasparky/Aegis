"use client";

import { useEffect, useState } from "react";
import type { InstalledSkill, Skill } from "@aegis/types";
import { listInstalledSkills, uninstallSkill } from "../../lib/api";
import { SkillPreviewPane, SkillDetailModal, isRouteVerified, friendlyShortDate } from "@/components/skill-market";

const DEMO_CREATOR_AEGIS_ID = "aid_user_001";

type InstalledItem = InstalledSkill & { skill: Skill };

function InstalledSkillCard({ item, onClick }: { item: InstalledItem; onClick: () => void }) {
  const isOwn = item.skill.creator_aegis_id === DEMO_CREATOR_AEGIS_ID;
  const isUnlisted = item.skill.listing_status === "unlisted";

  return (
    <button className="skill-mcard" onClick={onClick} type="button">
      <div className="skill-mcard__preview">
        <SkillPreviewPane
          domain={item.skill.domain}
          name={item.skill.name}
          steps={[]}
          trustTier={item.skill.trust_tier}
          executionMode={item.skill.execution_mode}
          showTrustStrip={false}
        />
        <div className="skill-mcard__overlay">
          {item.skill.summary && (
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0, lineHeight: 1.5, flex: 1, overflow: "hidden" }}>
              {item.skill.summary}
            </p>
          )}
          <div style={{ flexShrink: 0, fontSize: 12, fontWeight: 500 }}>
            <span style={{ color: "var(--blue)" }}>View details →</span>
          </div>
        </div>
      </div>
      <div className="skill-mcard__body">
        <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)", lineHeight: 1.3 }}>{item.skill.name}</div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "monospace" }}>{item.skill.domain}</div>
        {item.skill.summary && (
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {item.skill.summary}
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", fontSize: 11.5, color: "var(--ink-4)" }}>
          <span style={{ color: isRouteVerified(item.skill.trust_tier) ? "oklch(0.42 0.09 150)" : "var(--ink-4)" }}>
            {isRouteVerified(item.skill.trust_tier) ? "✓ Verified" : "Needs verification"}
          </span>
          {item.skill.risk_level && item.skill.risk_level !== "low" && (
            <>
              <span>·</span>
              <span style={{ color: item.skill.risk_level === "high" ? "oklch(0.45 0.13 25)" : "oklch(0.45 0.12 75)" }}>
                {item.skill.risk_level} risk
              </span>
            </>
          )}
          {isOwn ? (
            <>
              <span>·</span>
              <span>Created by you</span>
            </>
          ) : isUnlisted ? (
            <>
              <span>·</span>
              <span>Unlisted, still in your library</span>
            </>
          ) : null}
          <span>·</span>
          <span>Installed {friendlyShortDate(item.installed_at)}</span>
        </div>
      </div>
    </button>
  );
}

export default function SkillLibraryPage() {
  const [items, setItems] = useState<InstalledItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalItemId, setModalItemId] = useState<string | null>(null);

  useEffect(() => {
    listInstalledSkills().then(setItems).finally(() => setLoading(false));
  }, []);

  function handleUninstall(installedSkillId: string) {
    setItems(prev => prev.filter(i => i.installed_skill_id !== installedSkillId));
    setModalItemId(null);
  }

  function handleInstallChange(skillId: string, installed: boolean) {
    if (!installed) {
      // Remove the item from the library on uninstall
      setItems(prev => prev.filter(i => i.skill.skill_id !== skillId));
      setModalItemId(null);
    }
  }

  const selectedItem = modalItemId ? items.find(i => i.skill.skill_id === modalItemId) ?? null : null;

  return (
    <div className="page">
      {selectedItem && (
        <SkillDetailModal
          skillId={selectedItem.skill.skill_id}
          onClose={() => setModalItemId(null)}
          mode={{
            type: "library",
            skill: selectedItem.skill,
            installedAt: selectedItem.installed_at,
            onInstallChange: handleInstallChange,
          }}
        />
      )}

      {/* Hero */}
      <div className="a-card" style={{ padding: "24px 28px 20px" }}>
        <div className="a-eyebrow">Skill Library</div>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--ink-1)", margin: "6px 0 8px", letterSpacing: "-0.02em" }}>
          Your Skill Library
        </h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0, lineHeight: 1.6, maxWidth: 560 }}>
          Installed skills available to your agents. Agents operating under your delegations can discover and use these
          skills on the matching domain.
        </p>
        {!loading && items.length > 0 && (
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "10px 0 0" }}>
            {items.length} skill{items.length !== 1 ? "s" : ""} installed
          </p>
        )}
      </div>

      {loading ? (
        <div className="skill-grid">
          {[1, 2, 3].map(i => (
            <div key={i} style={{ height: 260, borderRadius: "var(--r-3)", background: "var(--graphite-soft)", opacity: 0.35 }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="a-card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px" }}>No skills installed yet.</p>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
            Browse the{" "}
            <a href="/marketplace" style={{ color: "var(--blue)", textDecoration: "underline" }}>Marketplace</a>{" "}
            to find and install verified skills.
          </p>
        </div>
      ) : (
        <div className="skill-grid">
          {items.map(item => (
            <InstalledSkillCard
              key={item.installed_skill_id}
              item={item}
              onClick={() => setModalItemId(item.skill.skill_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
