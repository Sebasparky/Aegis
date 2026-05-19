"use client";

import { useEffect, useState } from "react";
import type { AgentDelegation, Collar } from "@aegis/types";
import {
  listDelegations,
  createDelegation,
  revokeDelegation,
  listCollars,
} from "../../lib/api";
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

type Tab = "connected" | "connect";

function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

function statusClass(status: AgentDelegation["status"]) {
  if (status === "revoked") return "a-status a-status--outline-red";
  return "a-status a-status--graphite";
}

function passportId(d: AgentDelegation) {
  return d.token_id.slice(-8).toUpperCase();
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

// Deterministic accent color from full agent ID — prevents first-character collisions.
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

const AGENT_ACCENTS = [
  { border: "oklch(0.68 0.07 240)", bg: "oklch(0.68 0.07 240 / 0.04)" },
  { border: "oklch(0.68 0.07 160)", bg: "oklch(0.68 0.07 160 / 0.04)" },
  { border: "oklch(0.68 0.07 290)", bg: "oklch(0.68 0.07 290 / 0.04)" },
  { border: "oklch(0.68 0.07 55)",  bg: "oklch(0.68 0.07 55  / 0.04)" },
  { border: "oklch(0.68 0.07 20)",  bg: "oklch(0.68 0.07 20  / 0.04)" },
] as const;

function agentAccent(d: AgentDelegation) {
  const key = d.id || d.agent_name || "";
  return AGENT_ACCENTS[djb2Hash(key) % AGENT_ACCENTS.length];
}

function skillAccessSummary(d: AgentDelegation) {
  if (d.skill_access_mode === "exclude") {
    const ids = d.skill_access_skill_ids ?? [];
    return ids.length > 0 ? `All tools except: ${ids.join(", ")}` : "Can use all approved tools";
  }
  if (d.skill_access_mode === "only") {
    const ids = d.skill_access_skill_ids ?? [];
    return ids.length > 0 ? `Only: ${ids.join(", ")}` : "No tools allowed";
  }
  return "Can use all approved tools";
}

export default function DelegationsPage() {
  const [delegations, setDelegations] = useState<AgentDelegation[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("connected");

  const [agentName, setAgentName] = useState("OpenClaw Shopping Agent");
  const [agentPlatform, setAgentPlatform] = useState("OpenClaw");
  const [collarId, setCollarId] = useState<string | null>(null);
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
        if (cols.length > 0) setCollarId(cols[0].id); // pre-select first; user can choose "None"
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
        channel: "api",
        default_collar_id: collarId ?? undefined,
        expires_in_minutes: 525600,
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

  const activeDelegations = delegations.filter((d) => d.status === "active");

  return (
    <div className="page">
      {/* ── Hero ── */}
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />

        <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 8 }}>Agents</div>
            <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "0 0 10px" }}>
              Agents,{" "}
              <span className="cmd-hero__title-mark">introduced.</span>
            </h1>
            <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0, maxWidth: 480 }}>
              Connect AI agents, give them limited access, and keep every action accountable.
            </p>
          </div>
          <button
            className="a-btn a-btn--ghost"
            onClick={() => setActiveTab("connect")}
            style={{ fontSize: 13, flexShrink: 0 }}
          >
            Connect agent
          </button>
        </div>

        {/* Stats strip */}
        <div className="header-stats">
          <HeaderStat value={loading ? "—" : delegations.length} label="Connections created" />
          <HeaderStat value={loading ? "—" : activeDelegations.length} label="Active agents" />
          <HeaderStat
            value={loading ? "—" : delegations.filter((d) => d.status === "revoked" || d.status === "expired").length}
            label="Disconnected"
          />
        </div>
      </SpotlightHeroCard>

      {/* ── One-time token banner ── */}
      {shownToken && (
        <div className="ag-token-banner">
          <div>
            <div
              style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.12 75)", marginBottom: 2 }}
            >
              Safe connection created
            </div>
            <div style={{ fontSize: 12, color: "oklch(0.5 0.1 75)" }}>
              Copy this key into your agent tool now. For safety, Antigen will only show it once.
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
              How to use this key
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
            onClick={() => { setShownToken(null); setActiveTab("connected"); }}
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
            View connected agents
          </button>
        </div>
      )}

      {/* ── Tab strip ── */}
      <div className="ag-tabs">
        {(["connected", "connect"] as Tab[]).map((tab) => (
          <button
            key={tab}
            className={`ag-tab${activeTab === tab ? " ag-tab--active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "connected" ? "Connected agents" : "Add agent"}
          </button>
        ))}
      </div>

      {/* ── Connected agents tab ── */}
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
              Disconnect failed: {revokeError}
            </div>
          )}
          {loading ? (
            <div style={{ color: "var(--ink-3)", fontSize: 13, padding: "24px 0" }}>
              Loading agents…
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
              <div>Add your first agent to give it limited access.</div>
              <button
                className="a-btn a-btn--ghost"
                style={{ marginTop: 4, fontSize: 13 }}
                onClick={() => setActiveTab("connect")}
              >
                Add agent
              </button>
            </div>
          ) : (
            activeDelegations.map((d) => {
              const collar = collars.find((c) => c.id === d.default_collar_id);
              const isEditing = editingPolicyId === d.id;
              const accent = agentAccent(d);
              return (
                <div key={d.id}>
                  <div
                    className="ag-row"
                    style={{ borderLeft: `3px solid ${accent.border}`, background: accent.bg }}
                  >
                    {/* Avatar */}
                    <div className="ag-avatar" style={{ borderColor: accent.border, color: accent.border }}>
                      {d.agent_name?.[0]?.toUpperCase() ?? "A"}
                    </div>

                    {/* Info */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <div
                        style={{ fontWeight: 500, fontSize: 14, color: "var(--ink-1)", lineHeight: 1.3 }}
                      >
                        {d.agent_name}
                      </div>
                      {d.agent_platform && (
                        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                          {d.agent_platform}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: collar ? "var(--ink-4)" : "var(--ink-3)" }}>
                        {collar ? `Rules: ${collar.name}` : "No rule set yet"}
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
                          <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
                            {skillAccessSummary(d)}
                          </span>
                          <span style={{ color: "var(--ink-4)", fontSize: 10 }}>·</span>
                          <span
                            style={{
                              fontFamily: "JetBrains Mono, monospace",
                              fontSize: 10,
                              color: "var(--ink-4)",
                            }}
                          >
                            ID: {passportId(d)}
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
                      {d.status === "active" ? (
                        <span className="metadata-state metadata-state--good">{d.status}</span>
                      ) : (
                        <span className={statusClass(d.status)}>{d.status}</span>
                      )}
                      <div style={{ display: "flex", gap: 4 }}>
                        {!isEditing && (
                          <button
                            className="a-btn a-btn--ghost"
                            style={{ fontSize: 11, padding: "4px 9px", color: "var(--ink-3)" }}
                            onClick={() => startEditPolicy(d)}
                          >
                            Review access
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
                          Disconnect
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Tool access editor */}
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
                        Tool access
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
                            <option value="all">All approved tools</option>
                            <option value="exclude">All except selected</option>
                            <option value="only">Only selected</option>
                          </select>
                        </div>
                        {policyMode !== "all" && (
                          <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 4 }}>
                            <label className="ag-label">Tool IDs (comma-separated)</label>
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

      {/* ── Add agent tab ── */}
      {activeTab === "connect" && (
        <div className="a-card" style={{ maxWidth: 640 }}>
          <div style={{ marginBottom: 20 }}>
            <div className="a-eyebrow" style={{ marginBottom: 4 }}>Safe connection</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)", letterSpacing: "-0.01em" }}>
              Connect an AI agent
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
              Give your agent a safe connection to Antigen. You can add rules, approvals, and limits
              whenever you need them.
            </div>
          </div>

          {/* Reassurance strip */}
          <div className="ag-trust-pills">
            <div className="ag-trust-pill">
              <div className="ag-trust-pill__label">Secrets stay hidden</div>
              <div className="ag-trust-pill__desc">Agents never see your passwords or private credentials.</div>
            </div>
            <div className="ag-trust-pill">
              <div className="ag-trust-pill__label">You stay in control</div>
              <div className="ag-trust-pill__desc">You can add rules or disconnect the agent anytime.</div>
            </div>
            <div className="ag-trust-pill">
              <div className="ag-trust-pill__label">Proof is recorded</div>
              <div className="ag-trust-pill__desc">Approvals and actions leave a signed record.</div>
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
                <div className="ag-helper">Give this agent a name you&rsquo;ll recognize.</div>
              </div>
              <div>
                <label className="ag-label">Platform</label>
                <input
                  className="ag-input"
                  value={agentPlatform}
                  onChange={(e) => setAgentPlatform(e.target.value)}
                  placeholder="OpenClaw"
                />
                <div className="ag-helper">Where this agent comes from — like Claude, OpenAI, or another tool.</div>
              </div>
            </div>
            <div>
              <label className="ag-label">Rule set</label>
              <select
                className="ag-select"
                value={collarId ?? ""}
                onChange={(e) => setCollarId(e.target.value === "" ? null : e.target.value)}
              >
                <option value="">None</option>
                {collars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <div className="ag-helper">
                {collarId
                  ? "This agent will follow the selected rule set. You can review or update it later."
                  : "No restrictions applied. You can add a rule set later."}
              </div>
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
                {creating ? "Creating connection…" : "Create safe connection"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
