"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCollar } from "@/lib/api";
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

const ACTION_OPTIONS = [
  "browse", "search", "read", "compare", "draft", "add_to_cart",
  "login", "purchase", "payment", "subscription", "post_publicly",
  "comment", "direct_message", "send_email", "forward_email",
  "upload_file", "download_file", "submit_form", "create_account",
  "share_email", "share_phone", "share_address", "identity_disclosure",
  "government_id_upload", "medical_data_disclosure", "financial_data_disclosure",
  "account_setting_change", "delete_account", "connect_app", "oauth_authorize",
];

const ACTION_DISPLAY: Record<string, string> = {
  browse:                    "Browse websites",
  search:                    "Search the web",
  read:                      "Read page content",
  compare:                   "Compare options",
  draft:                     "Draft text or forms",
  add_to_cart:               "Add to cart",
  login:                     "Log in",
  purchase:                  "Make purchases",
  payment:                   "Use payment details",
  subscription:              "Start subscriptions",
  post_publicly:             "Publish publicly",
  comment:                   "Leave comments",
  direct_message:            "Send direct messages",
  send_email:                "Send emails",
  forward_email:             "Forward emails",
  upload_file:               "Upload files",
  download_file:             "Download files",
  submit_form:               "Submit forms",
  create_account:            "Create accounts",
  share_email:               "Share your email",
  share_phone:               "Share your phone",
  share_address:             "Share your address",
  identity_disclosure:       "Disclose identity",
  government_id_upload:      "Upload government ID",
  medical_data_disclosure:   "Share medical data",
  financial_data_disclosure: "Share financial data",
  account_setting_change:    "Change account settings",
  delete_account:            "Delete accounts",
  connect_app:               "Connect apps",
  oauth_authorize:           "Authorize via OAuth",
};

function displayName(action: string) {
  return ACTION_DISPLAY[action] ?? action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type ActionBucket = "allowed" | "approval" | "blocked" | "";

const bucketLabel: Record<ActionBucket, string> = {
  "":       "Default",
  allowed:  "Allow",
  approval: "Ask me first",
  blocked:  "Block",
};

const bucketCls: Record<ActionBucket, string> = {
  "":       "dflt",
  allowed:  "allow",
  approval: "ask",
  blocked:  "block",
};

export default function NewCollarPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState("");
  const [maxWithApproval, setMaxWithApproval] = useState("100");
  const [subscriptionsAllowed, setSubscriptionsAllowed] = useState(false);
  const [buckets, setBuckets] = useState<Record<string, ActionBucket>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setActionBucket(action: string, bucket: ActionBucket) {
    setBuckets((prev) => ({ ...prev, [action]: bucket }));
  }

  function actionsInBucket(bucket: ActionBucket) {
    return ACTION_OPTIONS.filter((a) => buckets[a] === bucket);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Rule set name is required."); return; }

    setSaving(true);
    setError(null);
    try {
      await createCollar({
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
        counterparty_rules: {
          sensitive_actions_require_verified_business: false,
          block_known_prompt_injection_sites: true,
        },
        session_limits: { max_duration_minutes: 120 },
      });
      router.push("/collars");
    } catch (e: any) {
      setError(e.message ?? "Failed to create rule set.");
    } finally {
      setSaving(false);
    }
  }

  const purchaseRelatedActions = ["purchase", "payment", "subscription"];
  const shouldShowSpendingLimits = purchaseRelatedActions.some((action) => {
    const bucket = buckets[action] ?? "";
    return bucket === "allowed" || bucket === "approval";
  });

  return (
    <div className="page">

      {/* ── Back nav ─────────────────────────────────────────────────────── */}
      <div>
        <Link href="/collars" className="a-btn a-btn--ghost" style={{ fontSize: 12.5, padding: "5px 10px", gap: 6 }}>
          ← Back to access rules
        </Link>
      </div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div className="a-eyebrow">Access Rules</div>
          <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
            Create a{" "}
            <span className="cmd-hero__title-mark">new rule set</span>
          </h1>
          <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
            Choose what an AI agent can do, what needs your approval, and what is always blocked.
          </p>
        </div>
      </SpotlightHeroCard>

      {/* ── Form ─────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 672 }}>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Rule set details */}
          <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="collar-section-label">Rule set details</div>
            <div>
              <label className="ag-label">Rule set name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Research & Shopping"
                className="ag-input"
              />
            </div>
            <div>
              <label className="ag-label">What this is for</label>
              <input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. Find running shoes under $100"
                className="ag-input"
              />
            </div>
            <div>
              <label className="ag-label">Notes</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Optional notes about this rule set"
                className="ag-input"
                style={{ resize: "none" }}
              />
            </div>
          </div>

          {/* Permissions */}
          <div className="a-card">
            <div className="collar-section-label">Permissions</div>
            <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 18px", lineHeight: 1.55 }}>
              <strong style={{ color: "var(--ink-2)", fontWeight: 500 }}>Allow</strong> — the agent acts automatically.{" "}
              <strong style={{ color: "var(--ink-2)", fontWeight: 500 }}>Ask me first</strong> — requires your approval.{" "}
              <strong style={{ color: "var(--ink-2)", fontWeight: 500 }}>Block</strong> — always prevented.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ACTION_OPTIONS.map((action) => {
                const current = buckets[action] ?? "";
                return (
                  <div key={action} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                    <span style={{ fontSize: 13.5, color: "var(--ink-1)", minWidth: 0 }}>{displayName(action)}</span>
                    <div className="collar-seg">
                      {(["allowed", "approval", "blocked"] as ActionBucket[]).map((b) => (
                        <button
                          key={b}
                          type="button"
                          onClick={() => setActionBucket(action, b)}
                          className={`collar-seg__btn${current === b ? ` collar-seg__btn--${bucketCls[b]}` : ""}`}
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

          {/* Spending limits — only shown when purchase-related actions are enabled */}
          {shouldShowSpendingLimits && (
            <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="collar-section-label">Spending limits</div>
              <div>
                <label className="ag-label">Max with approval ($)</label>
                <input
                  type="number"
                  min="0"
                  value={maxWithApproval}
                  onChange={(e) => setMaxWithApproval(e.target.value)}
                  className="ag-input"
                  style={{ maxWidth: 160 }}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={subscriptionsAllowed}
                  onChange={(e) => setSubscriptionsAllowed(e.target.checked)}
                  style={{ accentColor: "var(--blue)", width: 14, height: 14 }}
                />
                <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>Allow subscriptions</span>
              </label>
            </div>
          )}

          {error && (
            <p style={{ fontSize: 13, color: "var(--red)", margin: 0 }}>{error}</p>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" disabled={saving} className="a-btn a-btn--primary">
              {saving ? "Saving…" : "Create rule set"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/collars")}
              className="a-btn a-btn--ghost"
            >
              Cancel
            </button>
          </div>

        </form>
      </div>

    </div>
  );
}
