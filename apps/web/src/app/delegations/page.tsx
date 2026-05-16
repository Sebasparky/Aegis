"use client";

import { useEffect, useState } from "react";
import type { AgentDelegation, Collar } from "@aegis/types";
import {
  listDelegations,
  createDelegation,
  revokeDelegation,
  listCollars,
} from "../../lib/api";

type Tab = "connected" | "connect" | "passports";

function statusClass(status: AgentDelegation["status"]) {
  if (status === "active") return "a-status a-status--green";
  if (status === "revoked") return "a-status a-status--red";
  return "a-status a-status--graphite";
}

function passportId(d: AgentDelegation) {
  return "#" + d.token_id.slice(-8).toUpperCase();
}

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div style={{ position: "relative" }}>
      <pre
        style={{
          background: "rgba(255,255,255,0.6)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--r-1)",
          padding: "12px 14px",
          fontSize: 12,
          fontFamily: "JetBrains Mono, SF Mono, monospace",
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--ink-1)",
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        {code}
      </pre>
      <button
        onClick={handleCopy}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          fontSize: 11,
          padding: "3px 9px",
          borderRadius: "var(--r-1)",
          background: "rgba(255,255,255,0.85)",
          border: "1px solid var(--hairline)",
          color: "var(--ink-2)",
          cursor: "pointer",
        }}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

export default function DelegationsPage() {
  const [delegations, setDelegations] = useState<AgentDelegation[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("connected");

  const [agentName, setAgentName] = useState("OpenClaw Shopping Agent");
  const [agentPlatform, setAgentPlatform] = useState("OpenClaw");
  const [channel, setChannel] = useState<"slack" | "discord" | "api" | "other">("slack");
  const [collarId, setCollarId] = useState("");
  const [expiresIn, setExpiresIn] = useState(10080);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [shownToken, setShownToken] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [policyMode, setPolicyMode] = useState<string>("all");
  const [policySkillIds, setPolicySkillIds] = useState<string>("");
  const [policyError, setPolicyError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listDelegations(), listCollars()])
      .then(([dels, cols]) => {
        setDelegations(dels);
        setCollars(cols);
        if (cols.length > 0) setCollarId(cols[0].id);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    setShownToken(null);
    try {
      const result = await createDelegation({
        agent_name: agentName,
        agent_platform: agentPlatform || undefined,
        channel,
        default_collar_id: collarId || undefined,
        expires_in_minutes: expiresIn,
      });
      setShownToken(result.delegation_token);
      setDelegations((prev) => [result.delegation, ...prev]);
      setActiveTab("connected");
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create delegation.");
    } finally {
      setCreating(false);
    }
  }

  function startEditPolicy(d: AgentDelegation) {
    setEditingPolicyId(d.id);
    setPolicyMode(d.skill_access_mode ?? "all");
    setPolicySkillIds((d.skill_access_skill_ids ?? []).join(", "));
    setPolicyError(null);
  }

  async function handleSavePolicy(delegationId: string) {
    setPolicyError(null);
    try {
      const skill_ids = policySkillIds.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await fetch(`/api/delegations/${delegationId}/skill-access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: policyMode, skill_ids }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to save policy.");
      setDelegations((prev) => prev.map((d) => (d.id === delegationId ? json.data : d)));
      setEditingPolicyId(null);
    } catch (err: unknown) {
      setPolicyError(err instanceof Error ? err.message : "Failed to save policy.");
    }
  }

  async function handleRevoke(delegationId: string) {
    setRevokeError(null);
    try {
      await revokeDelegation(delegationId);
      setDelegations((prev) =>
        prev.map((d) =>
          d.id === delegationId
            ? { ...d, status: "revoked" as const, updated_at: new Date().toISOString() }
            : d
        )
      );
    } catch (err: unknown) {
      setRevokeError(err instanceof Error ? err.message : "Failed to revoke delegation.");
    }
  }

  function skillAccessSummary(d: AgentDelegation) {
    if (d.skill_access_mode === "exclude") {
      const ids = d.skill_access_skill_ids ?? [];
      return ids.length > 0 ? `All except ${ids.join(", ")}` : "All skills";
    }
    if (d.skill_access_mode === "only") {
      const ids = d.skill_access_skill_ids ?? [];
      return ids.length > 0 ? `Only: ${ids.join(", ")}` : "Only (none — blocks all)";
    }
    return "All installed skills";
  }

  const activeDelegations = delegations.filter((d) => d.status === "active");

  return (
    <div className="page">
      {/* ── Hero ── */}
      <div className="cmd-hero cmd-hero--ceramic">
        <div className="cmd-hero__aura" />
        <div className="cmd-hero__grain" />

        {/* Split: left text + right seal */}
        <div className="ag-hero">
          <div className="ag-hero__left">
            <div className="a-eyebrow" style={{ marginBottom: 10 }}>Agents</div>
            <h1
              className="cmd-hero__title"
              style={{ textAlign: "left", margin: "0 0 14px", fontSize: 38 }}
            >
              Agents,{" "}
              <span className="cmd-hero__title-mark">introduced.</span>
            </h1>
            <p
              style={{
                fontSize: 15,
                color: "var(--ink-2)",
                margin: "0 0 22px",
                lineHeight: 1.55,
                maxWidth: 440,
              }}
            >
              Add helpers, give them passports, and keep them inside your rules. Every agent earns
              an Antigen passport before it touches your accounts.
            </p>
            <button
              className="a-btn a-btn--ghost"
              onClick={() => setActiveTab("connect")}
              style={{ fontSize: 13 }}
            >
              Connect agent
            </button>
          </div>

          {/* Passport seal — CSS-only, decorative */}
          <div className="ag-seal" aria-hidden="true">
            <div className="ag-seal__glow" />
            <div className="ag-seal__ring" />
            <div className="ag-seal__disc">
              <span className="ag-seal__initial">A</span>
            </div>
          </div>
        </div>

        {/* Stats strip */}
        <div
          className="cmd-pulse"
          style={{
            borderTop: "1px solid var(--hairline)",
            marginTop: 28,
            paddingTop: 18,
            paddingBottom: 20,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <span
              style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--ink-1)" }}
            >
              {loading ? "—" : delegations.length}
            </span>
            <span style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.08em" }}>
              Passports issued
            </span>
          </div>
          <div className="cmd-pulse__div" />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <span
              style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--ink-1)" }}
            >
              {loading ? "—" : activeDelegations.length}
            </span>
            <span style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.08em" }}>
              Active
            </span>
          </div>
          <div className="cmd-pulse__div" />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <span
              style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--ink-1)" }}
            >
              {loading
                ? "—"
                : delegations.filter((d) => d.status === "revoked" || d.status === "expired").length}
            </span>
            <span style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.08em" }}>
              Revoked
            </span>
          </div>
        </div>
      </div>

      {/* ── One-time token banner ── */}
      {shownToken && (
        <div className="ag-token-banner">
          <div>
            <div
              style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.12 75)", marginBottom: 2 }}
            >
              Passport token — shown once only
            </div>
            <div style={{ fontSize: 12, color: "oklch(0.5 0.1 75)" }}>
              Copy this token now. It will not be shown again.
            </div>
          </div>
          <CopyBlock code={shownToken} />
          <div
            style={{
              background: "rgba(255,255,255,0.55)",
              border: "1px solid var(--hairline)",
              borderRadius: "var(--r-2)",
              padding: "12px 14px",
              fontSize: 12,
              color: "var(--ink-3)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--ink-2)", marginBottom: 2 }}>
              How to use this token
            </div>
            <p style={{ margin: 0 }}>
              Give this token to your agent runtime as{" "}
              <code
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  color: "oklch(0.45 0.12 75)",
                }}
              >
                AEGIS_PASS_TOKEN
              </code>
              . The agent uses it to call{" "}
              <code
                style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--ink-2)" }}
              >
                aegis_create_session
              </code>{" "}
              before every task.
            </p>
            <p style={{ margin: 0 }}>
              Configure the agent to use the Antigen MCP server. See{" "}
              <span style={{ color: "var(--blue)" }}>/agent-bridge</span> for the system prompt and
              tool list.
            </p>
          </div>
          <button
            onClick={() => setShownToken(null)}
            style={{
              background: "none",
              border: 0,
              padding: 0,
              fontSize: 12,
              color: "var(--ink-4)",
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            I've copied it — dismiss
          </button>
        </div>
      )}

      {/* ── Tab strip ── */}
      <div className="ag-tabs">
        {(["connected", "connect", "passports"] as Tab[]).map((tab) => (
          <button
            key={tab}
            className={`ag-tab${activeTab === tab ? " ag-tab--active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "connected"
              ? "Connected"
              : tab === "connect"
              ? "Connect agent"
              : "Passports"}
          </button>
        ))}
      </div>

      {/* ── Connected tab ── */}
      {activeTab === "connected" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {revokeError && (
            <div
              style={{
                fontSize: 12,
                color: "oklch(0.45 0.13 25)",
                background: "var(--red-soft)",
                border: "1px solid var(--red-ring)",
                borderRadius: "var(--r-1)",
                padding: "8px 12px",
              }}
            >
              Revoke failed: {revokeError}
            </div>
          )}
          {loading ? (
            <div style={{ color: "var(--ink-3)", fontSize: 13, padding: "24px 0" }}>
              Loading passports…
            </div>
          ) : activeDelegations.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "40px 24px",
                color: "var(--ink-3)",
                fontSize: 13,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 15, color: "var(--ink-2)", fontWeight: 500 }}>
                No active agents.
              </div>
              <div>Connect an agent to issue its first passport.</div>
              <button
                className="a-btn a-btn--ghost"
                style={{ marginTop: 4, fontSize: 13 }}
                onClick={() => setActiveTab("connect")}
              >
                Connect agent
              </button>
            </div>
          ) : (
            activeDelegations.map((d) => {
              const collar = collars.find((c) => c.id === d.default_collar_id);
              const isEditing = editingPolicyId === d.id;
              return (
                <div key={d.id}>
                  <div className="ag-row">
                    {/* Avatar */}
                    <div className="ag-avatar">
                      {d.agent_name?.[0]?.toUpperCase() ?? "A"}
                    </div>

                    {/* Info */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <div className="ag-passport-label">Agent Passport</div>
                      <div
                        style={{ fontWeight: 500, fontSize: 14, color: "var(--ink-1)", lineHeight: 1.3 }}
                      >
                        {d.agent_name}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {[d.agent_platform, d.channel].filter(Boolean).join(" · ")}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-4)" }}>
                        {collar?.name ?? d.default_collar_id}
                      </div>
                      {!isEditing && (
                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            marginTop: 1,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: "JetBrains Mono, monospace",
                              fontSize: 10.5,
                              color: "var(--ink-4)",
                            }}
                          >
                            {passportId(d)}
                          </span>
                          <span style={{ color: "var(--ink-4)", fontSize: 10 }}>·</span>
                          <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
                            {skillAccessSummary(d)}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Status + actions */}
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        gap: 8,
                      }}
                    >
                      <span className={statusClass(d.status)}>
                        <span className="a-status__dot" />
                        {d.status}
                      </span>
                      <div style={{ display: "flex", gap: 4 }}>
                        {!isEditing && (
                          <button
                            className="a-btn a-btn--ghost"
                            style={{ fontSize: 11, padding: "4px 9px", color: "var(--ink-3)" }}
                            onClick={() => startEditPolicy(d)}
                          >
                            Skills
                          </button>
                        )}
                        <button
                          className="a-btn a-btn--ghost"
                          style={{
                            fontSize: 11,
                            padding: "4px 9px",
                            color: "oklch(0.50 0.13 25)",
                            borderColor: "var(--red-ring)",
                          }}
                          onClick={() => handleRevoke(d.id)}
                        >
                          Revoke
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Skill policy editor */}
                  {isEditing && (
                    <div
                      style={{
                        marginTop: -1,
                        border: "1px solid var(--hairline)",
                        borderTop: "1px solid var(--hairline-2)",
                        borderRadius: `0 0 var(--r-2) var(--r-2)`,
                        background: "rgba(255,255,255,0.7)",
                        padding: "14px 16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}
                      >
                        Skill access policy
                      </div>
                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <label className="ag-label">Mode</label>
                          <select
                            className="ag-select"
                            style={{ width: "auto" }}
                            value={policyMode}
                            onChange={(e) => setPolicyMode(e.target.value)}
                          >
                            <option value="all">All installed skills</option>
                            <option value="exclude">All except selected</option>
                            <option value="only">Only selected</option>
                          </select>
                        </div>
                        {policyMode !== "all" && (
                          <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 4 }}>
                            <label className="ag-label">Skill IDs (comma-separated)</label>
                            <input
                              className="ag-input"
                              value={policySkillIds}
                              onChange={(e) => setPolicySkillIds(e.target.value)}
                              placeholder="skill_demo_wikipedia_001"
                              style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}
                            />
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            className="a-btn a-btn--primary"
                            style={{ fontSize: 12, padding: "5px 12px" }}
                            onClick={() => handleSavePolicy(d.id)}
                          >
                            Save
                          </button>
                          <button
                            className="a-btn a-btn--ghost"
                            style={{ fontSize: 12, padding: "5px 10px" }}
                            onClick={() => setEditingPolicyId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                      {policyError && (
                        <div style={{ fontSize: 12, color: "oklch(0.45 0.13 25)" }}>{policyError}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Connect tab ── */}
      {activeTab === "connect" && (
        <div className="a-card" style={{ maxWidth: 640 }}>
          <div style={{ marginBottom: 20 }}>
            <div className="a-eyebrow" style={{ marginBottom: 4 }}>Issue a passport</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)", letterSpacing: "-0.01em" }}>
              Connect an agent
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
              The agent receives a reusable signed token backed by an Antigen collar.
            </div>
          </div>
          <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="ag-label">Agent name</label>
                <input
                  className="ag-input"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="ag-label">Platform</label>
                <input
                  className="ag-input"
                  value={agentPlatform}
                  onChange={(e) => setAgentPlatform(e.target.value)}
                  placeholder="OpenClaw"
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="ag-label">Channel</label>
                <select
                  className="ag-select"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as typeof channel)}
                >
                  <option value="slack">Slack</option>
                  <option value="discord">Discord</option>
                  <option value="api">API</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="ag-label">Collar</label>
                <select
                  className="ag-select"
                  value={collarId}
                  onChange={(e) => setCollarId(e.target.value)}
                >
                  {collars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="ag-label">Expires in (minutes) — 10080 = 1 week</label>
              <input
                type="number"
                min={1}
                className="ag-input"
                value={expiresIn}
                onChange={(e) => setExpiresIn(Number(e.target.value))}
              />
            </div>
            {createError && (
              <div
                style={{
                  fontSize: 12,
                  color: "oklch(0.45 0.13 25)",
                  background: "var(--red-soft)",
                  border: "1px solid var(--red-ring)",
                  borderRadius: "var(--r-1)",
                  padding: "8px 12px",
                }}
              >
                {createError}
              </div>
            )}
            <div>
              <button
                type="submit"
                disabled={creating}
                className="a-btn a-btn--primary"
              >
                {creating ? "Issuing passport…" : "Issue passport"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Passports tab ── */}
      {activeTab === "passports" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--ink-4)", marginBottom: 4 }}>
            Passport ledger — all Antigen passports issued to agents on this account
          </div>
          {loading ? (
            <div style={{ color: "var(--ink-3)", fontSize: 13, padding: "24px 0" }}>
              Loading ledger…
            </div>
          ) : delegations.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "40px 24px",
                color: "var(--ink-3)",
                fontSize: 13,
              }}
            >
              No passports issued yet.
            </div>
          ) : (
            delegations.map((d) => {
              const collar = collars.find((c) => c.id === d.default_collar_id);
              return (
                <div key={d.id} className="ag-row">
                  {/* Avatar */}
                  <div
                    className="ag-avatar"
                    style={
                      d.status !== "active"
                        ? {
                            background: "var(--graphite-soft)",
                            border: "1px solid var(--hairline)",
                            color: "var(--ink-3)",
                          }
                        : undefined
                    }
                  >
                    {d.agent_name?.[0]?.toUpperCase() ?? "A"}
                  </div>

                  {/* Info */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <div className="ag-passport-label">Agent Passport</div>
                    <div
                      style={{
                        fontWeight: 500,
                        fontSize: 14,
                        color: d.status === "active" ? "var(--ink-1)" : "var(--ink-3)",
                        lineHeight: 1.3,
                      }}
                    >
                      {d.agent_name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      {[d.agent_platform, d.channel].filter(Boolean).join(" · ")}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-4)" }}>
                      {collar?.name ?? d.default_collar_id}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        fontSize: 11.5,
                        color: "var(--ink-4)",
                        flexWrap: "wrap",
                        marginTop: 2,
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 10.5,
                          color: "var(--ink-4)",
                        }}
                      >
                        {passportId(d)}
                      </span>
                      <span style={{ color: "var(--ink-4)", fontSize: 10 }}>·</span>
                      <span>
                        {new Date(d.created_at).toLocaleDateString()}
                      </span>
                      {d.expires_at && (
                        <>
                          <span style={{ color: "var(--ink-4)", fontSize: 10 }}>→</span>
                          <span>
                            {new Date(d.expires_at).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Status + subtle arrow — no operational controls */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={statusClass(d.status)}>
                      <span className="a-status__dot" />
                      {d.status}
                    </span>
                    <span
                      style={{
                        color: "var(--ink-4)",
                        fontSize: 16,
                        lineHeight: 1,
                        fontWeight: 300,
                      }}
                    >
                      ›
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
