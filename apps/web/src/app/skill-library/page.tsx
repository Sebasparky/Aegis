"use client";

import { useEffect, useState } from "react";
import type { InstalledSkill, Skill } from "@aegis/types";
import { listInstalledSkills, uninstallSkill } from "../../lib/api";

const TIER_LABEL: Record<string, string> = {
  unverified_draft: "Draft",
  community: "Community",
  aegis_scanned: "Verified",
  aegis_reviewed: "Reviewed",
  run_verified: "Run Verified",
  business_official: "Business Official",
};

const RISK_COLORS: Record<string, string> = {
  low: "text-green-400",
  medium: "text-yellow-400",
  high: "text-orange-400",
  critical: "text-red-400",
};

function friendlyDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

type InstalledItem = InstalledSkill & { skill: Skill };

function SkillLibraryCard({
  item,
  onUninstall,
}: {
  item: InstalledItem;
  onUninstall: (installedSkillId: string) => void;
}) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUninstall() {
    setActing(true);
    setError(null);
    try {
      await uninstallSkill(item.skill.skill_id);
      onUninstall(item.installed_skill_id);
    } catch (err: any) {
      setError(err.message ?? "Action failed.");
      setActing(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.skill.name}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
              <span className="font-mono text-gray-400">{item.skill.domain}</span>
              <span className={RISK_COLORS[item.skill.risk_level] ?? "text-gray-400"}>
                {item.skill.risk_level} risk
              </span>
              <span className="text-gray-600">
                {TIER_LABEL[item.skill.trust_tier] ?? item.skill.trust_tier}
              </span>
            </div>
          </div>
          <span className="shrink-0 text-xs text-gray-600">
            Installed {friendlyDate(item.installed_at)}
          </span>
        </div>

        {item.skill.summary && (
          <p className="text-xs text-gray-500 leading-relaxed">{item.skill.summary}</p>
        )}

        {error && (
          <p className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">{error}</p>
        )}

        <div>
          <button
            onClick={handleUninstall}
            disabled={acting}
            className="text-xs px-3 py-1.5 rounded-md border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-800 disabled:opacity-50 transition-colors"
          >
            {acting ? "…" : "Uninstall"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SkillLibraryPage() {
  const [items, setItems] = useState<InstalledItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listInstalledSkills().then(setItems).finally(() => setLoading(false));
  }, []);

  function handleUninstall(installedSkillId: string) {
    setItems(prev => prev.filter(i => i.installed_skill_id !== installedSkillId));
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Skill Library</h1>
        <p className="mt-2 text-gray-400 text-sm leading-relaxed">
          Your installed skills. Agents operating under your delegations can discover and use these
          skills when working on the matching domain.
        </p>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-14 text-gray-600 text-sm border border-dashed border-gray-800 rounded-xl space-y-1">
          <p className="text-gray-500">No skills installed yet.</p>
          <p className="text-gray-700 text-xs">
            Browse the{" "}
            <a href="/marketplace" className="text-indigo-400 hover:underline">Marketplace</a>{" "}
            to install verified skills.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-600">
            {items.length} skill{items.length !== 1 ? "s" : ""} installed
          </p>
          {items.map(item => (
            <SkillLibraryCard key={item.installed_skill_id} item={item} onUninstall={handleUninstall} />
          ))}
        </div>
      )}
    </div>
  );
}
