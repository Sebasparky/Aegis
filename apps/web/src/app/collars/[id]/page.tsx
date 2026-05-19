"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import type { Collar } from "@aegis/types";
import { getCollar, updateCollar, revokeCollar } from "@/lib/api";
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

function collarToBuckets(collar: Collar): Record<string, ActionBucket> {
  const result: Record<string, ActionBucket> = {};
  for (const a of collar.allowed_actions) result[a] = "allowed";
  for (const a of collar.approval_required_actions) result[a] = "approval";
  for (const a of collar.blocked_actions) result[a] = "blocked";
  return result;
}

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
  const [showRevokeModal, setShowRevokeModal] = useState(false);

  useEffect(() => {
    getCollar(id).then((c) => {
      setCollar(c);
      setName(c.name);
      setDescription(c.description ?? "");
      setPurpose(c.purpose ?? "");
      setMaxWithApproval(String(c.spending_limits.max_with_approval));
      setSubscriptionsAllowed(c.spending_limits.subscriptions_allowed);
      setBuckets(collarToBuckets(c));
    }).catch(() => setError("Rule set not found.")).finally(() => setLoading(false));
  }, [id]);

  function setActionBucket(action: string, bucket: ActionBucket) {
    setBuckets((prev) => ({ ...prev, [action]: bucket }));
  }

  function actionsInBucket(bucket: ActionBucket) {
    return ACTION_OPTIONS.filter((a) => buckets[a] === bucket);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Rule set name is required."); return; }
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

  function handleRevoke() {
    setShowRevokeModal(true);
  }

  async function handleConfirmRevoke() {
    try {
      await revokeCollar(id);
      router.push("/collars");
    } catch {
      setError("Failed to revoke rule set.");
      setShowRevokeModal(false);
    }
  }

  if (loading) return <p style={{ fontSize: 13, color: "var(--ink-3)", padding: "28px 36px" }}>Loading…</p>;
  if (!collar) return <p style={{ fontSize: 13, color: "var(--red)", padding: "28px 36px" }}>{error}</p>;

  const isRevoked = collar.status === "revoked";

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
            Edit{" "}
            <span className="cmd-hero__title-mark">access rules</span>
          </h1>
          <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
            Update what agents using this rule set are allowed to do.
          </p>
        </div>
      </SpotlightHeroCard>

      {/* ── Form ─────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 672 }}>

        {isRevoked && (
          <div style={{
            background: "var(--red-soft)", border: "1px solid var(--red-ring)",
            borderRadius: "var(--r-2)", padding: "14px 18px", marginBottom: 20,
          }}>
            <p style={{ fontSize: 13, color: "var(--red)", margin: 0 }}>
              This rule set has been revoked and cannot be edited.
            </p>
          </div>
        )}

        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Rule set details */}
          <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="collar-section-label">Rule set details</div>
            <div>
              <label className="ag-label">Rule set name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isRevoked}
                className="ag-input"
                style={isRevoked ? { opacity: 0.5 } : undefined}
              />
            </div>
            <div>
              <label className="ag-label">What this is for</label>
              <input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                disabled={isRevoked}
                className="ag-input"
                style={isRevoked ? { opacity: 0.5 } : undefined}
              />
            </div>
            <div>
              <label className="ag-label">Notes</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isRevoked}
                rows={2}
                className="ag-input"
                style={{ resize: "none", ...(isRevoked ? { opacity: 0.5 } : {}) }}
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
                          disabled={isRevoked}
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
                  disabled={isRevoked}
                  className="ag-input"
                  style={{ maxWidth: 160, ...(isRevoked ? { opacity: 0.5 } : {}) }}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: isRevoked ? "default" : "pointer", opacity: isRevoked ? 0.5 : 1 }}>
                <input
                  type="checkbox"
                  checked={subscriptionsAllowed}
                  onChange={(e) => setSubscriptionsAllowed(e.target.checked)}
                  disabled={isRevoked}
                  style={{ accentColor: "var(--blue)", width: 14, height: 14 }}
                />
                <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>Allow subscriptions</span>
              </label>
            </div>
          )}

          {error && (
            <p style={{ fontSize: 13, color: "var(--red)", margin: 0 }}>{error}</p>
          )}

          {!isRevoked && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="submit" disabled={saving} className="a-btn a-btn--primary">
                  {saving ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/collars")}
                  className="a-btn a-btn--ghost"
                >
                  Cancel
                </button>
              </div>

              <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-1)", margin: "0 0 2px" }}>Revoke rule set</p>
                  <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0 }}>Agents using this rule set will lose access.</p>
                </div>
                <button
                  type="button"
                  onClick={handleRevoke}
                  className="a-btn a-btn--danger"
                  style={{ flexShrink: 0 }}
                >
                  Revoke rule set
                </button>
              </div>
            </div>
          )}

        </form>
      </div>

      {/* ── Revoke modal ────────────────────────────────────────────────── */}
      {showRevokeModal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: "rgba(20,22,30,0.35)",
          backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
        }}>
          <div className="a-card" style={{ maxWidth: 400, width: "100%", boxShadow: "var(--shadow-3)", padding: "28px 28px 24px" }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 10px", letterSpacing: "-0.012em", color: "var(--ink-1)" }}>
              Revoke this rule set?
            </h2>
            <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: "0 0 24px", lineHeight: 1.55 }}>
              Agents using these access rules may stop working. You can create a new rule set later if needed.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="a-btn a-btn--ghost" onClick={() => setShowRevokeModal(false)}>
                Cancel
              </button>
              <button
                className="a-btn"
                style={{ background: "var(--red-soft)", color: "oklch(0.45 0.13 25)", border: "1px solid var(--red-ring)" }}
                onClick={handleConfirmRevoke}
              >
                Revoke rule set
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
