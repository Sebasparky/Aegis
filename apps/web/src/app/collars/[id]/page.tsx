"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import type { Collar } from "@aegis/types";
import { getCollar, updateCollar, revokeCollar } from "@/lib/api";

const ACTION_OPTIONS = [
  "browse", "search", "read", "compare", "draft", "add_to_cart",
  "login", "purchase", "payment", "subscription", "post_publicly",
  "comment", "direct_message", "send_email", "forward_email",
  "upload_file", "download_file", "submit_form", "create_account",
  "share_email", "share_phone", "share_address", "identity_disclosure",
  "government_id_upload", "medical_data_disclosure", "financial_data_disclosure",
  "account_setting_change", "delete_account", "connect_app", "oauth_authorize",
];

type ActionBucket = "allowed" | "approval" | "blocked" | "";

function collarToBuckets(collar: Collar): Record<string, ActionBucket> {
  const result: Record<string, ActionBucket> = {};
  for (const a of collar.allowed_actions) result[a] = "allowed";
  for (const a of collar.approval_required_actions) result[a] = "approval";
  for (const a of collar.blocked_actions) result[a] = "blocked";
  return result;
}

const bucketLabel: Record<ActionBucket, string> = {
  "": "Unset",
  allowed: "Allow",
  approval: "Ask First",
  blocked: "Block",
};

const bucketColors: Record<ActionBucket, string> = {
  "": "bg-gray-800 text-gray-500",
  allowed: "bg-green-900 text-green-400",
  approval: "bg-yellow-900 text-yellow-400",
  blocked: "bg-red-900 text-red-400",
};

export default function EditCollarPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [collar, setCollar] = useState<Collar | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState("");
  const [maxWithApproval, setMaxWithApproval] = useState("100");
  const [subscriptionsAllowed, setSubscriptionsAllowed] = useState(false);
  const [buckets, setBuckets] = useState<Record<string, ActionBucket>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCollar(id).then((c) => {
      setCollar(c);
      setName(c.name);
      setDescription(c.description ?? "");
      setPurpose(c.purpose ?? "");
      setMaxWithApproval(String(c.spending_limits.max_with_approval));
      setSubscriptionsAllowed(c.spending_limits.subscriptions_allowed);
      setBuckets(collarToBuckets(c));
    }).catch(() => setError("Collar not found.")).finally(() => setLoading(false));
  }, [id]);

  function setActionBucket(action: string, bucket: ActionBucket) {
    setBuckets((prev) => ({ ...prev, [action]: bucket }));
  }

  function actionsInBucket(bucket: ActionBucket) {
    return ACTION_OPTIONS.filter((a) => buckets[a] === bucket);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required."); return; }
    setSaving(true);
    setError(null);
    try {
      await updateCollar(id, {
        name: name.trim(),
        description: description.trim() || undefined,
        purpose: purpose.trim() || undefined,
        allowed_actions: actionsInBucket("allowed") as any,
        approval_required_actions: actionsInBucket("approval") as any,
        blocked_actions: actionsInBucket("blocked") as any,
        spending_limits: {
          max_without_approval: 0,
          max_with_approval: Number(maxWithApproval) || 0,
          subscriptions_allowed: subscriptionsAllowed,
        },
      });
      router.push("/collars");
    } catch (e: any) {
      setError(e.message ?? "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke() {
    if (!confirm("Revoke this collar? This cannot be undone.")) return;
    try {
      await revokeCollar(id);
      router.push("/collars");
    } catch {
      setError("Failed to revoke collar.");
    }
  }

  if (loading) return <p className="text-gray-500 text-sm">Loading...</p>;
  if (!collar) return <p className="text-red-400 text-sm">{error}</p>;

  const isRevoked = collar.status === "revoked";

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Edit Collar</h1>
          <p className="mt-1 text-gray-400 text-sm">Collars are fully customizable. Templates are only starting points.</p>
        </div>
        {!isRevoked && (
          <button
            onClick={handleRevoke}
            className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 border border-gray-700 rounded-md transition-colors"
          >
            Revoke Collar
          </button>
        )}
      </div>

      {isRevoked && (
        <div className="mb-4 bg-red-950 border border-red-900 text-red-400 text-sm rounded-lg px-4 py-3">
          This collar has been revoked and cannot be edited.
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-medium text-gray-300">Basic Info</h2>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Collar Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isRevoked}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Purpose</label>
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              disabled={isRevoked}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isRevoked}
              rows={2}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-none disabled:opacity-50"
            />
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-1">Action Rules</h2>
          <p className="text-xs text-gray-600 mb-4">Set each action to Allow, Ask First, or Block.</p>
          <div className="space-y-2">
            {ACTION_OPTIONS.map((action) => {
              const current = buckets[action] ?? "";
              return (
                <div key={action} className="flex items-center justify-between gap-3">
                  <span className="text-xs text-gray-400 font-mono">{action}</span>
                  <div className="flex gap-1">
                    {(["allowed", "approval", "blocked", ""] as ActionBucket[]).map((b) => (
                      <button
                        key={b}
                        type="button"
                        disabled={isRevoked}
                        onClick={() => setActionBucket(action, b)}
                        className={`text-xs px-2 py-0.5 rounded transition-colors disabled:opacity-40 ${
                          current === b
                            ? bucketColors[b]
                            : "bg-gray-800 text-gray-600 hover:text-gray-400"
                        }`}
                      >
                        {bucketLabel[b]}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-medium text-gray-300">Spending Limits</h2>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Max with approval ($)</label>
            <input
              type="number"
              min="0"
              value={maxWithApproval}
              onChange={(e) => setMaxWithApproval(e.target.value)}
              disabled={isRevoked}
              className="w-32 bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={subscriptionsAllowed}
              onChange={(e) => setSubscriptionsAllowed(e.target.checked)}
              disabled={isRevoked}
              className="accent-indigo-500"
            />
            <span className="text-xs text-gray-400">Allow subscriptions</span>
          </label>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {!isRevoked && (
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={saving}
              className="bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm px-5 py-2 rounded-md transition-colors"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/collars")}
              className="text-sm text-gray-400 hover:text-white px-4 py-2 rounded-md transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
