"use client";

import { useEffect, useState } from "react";
import { listSkills, installSkill, uninstallSkill, type SkillWithInstalled } from "../../lib/api";

const TIER_LABEL: Record<string, string> = {
  unverified_draft: "Draft",
  community: "Community",
  aegis_scanned: "Verified",
  aegis_reviewed: "Reviewed",
  run_verified: "Run Verified",
  business_official: "Business Official",
};

const TIER_COLORS: Record<string, string> = {
  aegis_scanned: "text-cyan-400 bg-cyan-950 border-cyan-900",
  aegis_reviewed: "text-green-400 bg-green-950 border-green-900",
  run_verified: "text-purple-400 bg-purple-950 border-purple-900",
  business_official: "text-yellow-400 bg-yellow-950 border-yellow-900",
};

const RISK_COLORS: Record<string, string> = {
  low: "text-green-400",
  medium: "text-yellow-400",
  high: "text-orange-400",
  critical: "text-red-400",
};

function SkillCard({
  skill,
  onInstallChange,
}: {
  skill: SkillWithInstalled;
  onInstallChange: (skillId: string, installed: boolean) => void;
}) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    setActing(true);
    setError(null);
    try {
      if (skill.installed) {
        await uninstallSkill(skill.skill_id);
        onInstallChange(skill.skill_id, false);
      } else {
        await installSkill(skill.skill_id);
        onInstallChange(skill.skill_id, true);
      }
    } catch (err: any) {
      setError(err.message ?? "Action failed.");
    } finally {
      setActing(false);
    }
  }

  const tierColor = TIER_COLORS[skill.trust_tier] ?? "text-gray-400 bg-gray-900 border-gray-700";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{skill.name}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
              <span className="font-mono text-gray-400">{skill.domain}</span>
              <span className={RISK_COLORS[skill.risk_level] ?? "text-gray-400"}>{skill.risk_level} risk</span>
              {skill.approval_gates.length > 0 && (
                <span>{skill.approval_gates.length} approval gate{skill.approval_gates.length !== 1 ? "s" : ""}</span>
              )}
            </div>
          </div>
          <span className={`shrink-0 text-xs px-2 py-0.5 rounded border font-medium ${tierColor}`}>
            {TIER_LABEL[skill.trust_tier] ?? skill.trust_tier}
          </span>
        </div>

        {/* Summary */}
        {skill.summary && (
          <p className="text-xs text-gray-500 leading-relaxed">{skill.summary}</p>
        )}

        {/* Permissions row */}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600">
          <span>
            {skill.required_permissions.length > 0
              ? `Needs: ${skill.required_permissions.join(", ")}`
              : "No required permissions"}
          </span>
          {skill.forbidden_actions.length > 0 && (
            <span className="text-orange-600">
              Blocks: {skill.forbidden_actions.join(", ")}
            </span>
          )}
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">{error}</p>
        )}

        {/* Action */}
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={handleToggle}
            disabled={acting}
            className={`text-xs px-4 py-2 rounded-md font-medium disabled:opacity-50 transition-colors ${
              skill.installed
                ? "border border-gray-700 text-gray-400 hover:text-red-400 hover:border-red-800"
                : "bg-indigo-600 hover:bg-indigo-500 text-white"
            }`}
          >
            {acting ? "…" : skill.installed ? "Uninstall" : "Install"}
          </button>
          {skill.installed && (
            <span className="text-xs text-green-500">Installed in your Skill Library</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MarketplacePage() {
  const [skills, setSkills] = useState<SkillWithInstalled[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listSkills().then(setSkills).finally(() => setLoading(false));
  }, []);

  function handleInstallChange(skillId: string, installed: boolean) {
    setSkills(prev =>
      prev.map(s => (s.skill_id === skillId ? { ...s, installed } : s))
    );
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Marketplace</h1>
        <p className="mt-2 text-gray-400 text-sm leading-relaxed">
          Approved verified workflow skills. Install any skill into your library — your agents will be able to
          use installed skills when operating on the matching domain.
        </p>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : skills.length === 0 ? (
        <div className="text-center py-14 text-gray-600 text-sm border border-dashed border-gray-800 rounded-xl space-y-1">
          <p className="text-gray-500">No approved skills in the marketplace yet.</p>
          <p className="text-gray-700 text-xs">
            Approve a route from{" "}
            <a href="/marketplace-review" className="text-indigo-400 hover:underline">Marketplace Review</a>{" "}
            to publish a skill here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-600">
            {skills.length} skill{skills.length !== 1 ? "s" : ""} available
          </p>
          {skills.map(skill => (
            <SkillCard key={skill.skill_id} skill={skill} onInstallChange={handleInstallChange} />
          ))}
        </div>
      )}
    </div>
  );
}
