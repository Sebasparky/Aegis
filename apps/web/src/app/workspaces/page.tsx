"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Collar } from "@aegis/types";
import { listWorkspaces, listCollars, createWorkspace, type WorkspaceWithCounts } from "@/lib/api";
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

const WS_ACCENTS = [
  { border: "oklch(0.68 0.07 240)", bg: "oklch(0.68 0.07 240 / 0.04)" },
  { border: "oklch(0.68 0.07 160)", bg: "oklch(0.68 0.07 160 / 0.04)" },
  { border: "oklch(0.68 0.07 290)", bg: "oklch(0.68 0.07 290 / 0.04)" },
  { border: "oklch(0.68 0.07 55)",  bg: "oklch(0.68 0.07 55  / 0.04)" },
  { border: "oklch(0.68 0.07 20)",  bg: "oklch(0.68 0.07 20  / 0.04)" },
] as const;

function wsAccent(id: string) {
  return WS_ACCENTS[djb2Hash(id) % WS_ACCENTS.length];
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceWithCounts[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createCollarId, setCreateCollarId] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  async function load() {
    try {
      const [wsList, collarList] = await Promise.allSettled([listWorkspaces(), listCollars()]);
      if (wsList.status === "fulfilled") setWorkspaces(wsList.value);
      else setError("Could not load workspaces.");
      if (collarList.status === "fulfilled") setCollars(collarList.value);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim()) { setCreateErr("Workspace name is required."); return; }
    if (!createCollarId) { setCreateErr("Select a rule set."); return; }
    setCreateSubmitting(true);
    setCreateErr(null);
    try {
      await createWorkspace({ name: createName.trim(), description: createDesc.trim() || undefined, collar_id: createCollarId });
      setShowCreate(false);
      setCreateName(""); setCreateDesc(""); setCreateCollarId("");
      await load();
    } catch (ex: unknown) {
      setCreateErr(ex instanceof Error ? ex.message : "Failed to create workspace.");
    } finally {
      setCreateSubmitting(false);
    }
  }

  function collarName(collarId: string): string {
    return collars.find((c) => c.id === collarId)?.name ?? collarId;
  }

  const totalOpen      = workspaces.reduce((s, w) => s + w.task_counts.open, 0);
  const totalProgress  = workspaces.reduce((s, w) => s + w.task_counts.in_progress, 0);
  const totalCompleted = workspaces.reduce((s, w) => s + w.task_counts.completed, 0);
  const totalArtifacts = workspaces.reduce((s, w) => s + w.artifact_count, 0);

  return (
    <div className="page">

      {/* ── Hero ── */}
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic" style={{ padding: "32px 36px 0" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div className="a-eyebrow" style={{ marginBottom: 8 }}>Workspaces</div>
              <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "0 0 10px" }}>
                Agents,{" "}
                <span className="cmd-hero__title-mark">coordinated.</span>
              </h1>
              <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0, maxWidth: 560 }}>
                Coordinate multiple agents through shared tasks, outputs, and audit-ready outcomes.
              </p>
            </div>
            <button
              className="a-btn a-btn--ghost"
              style={{ flexShrink: 0, marginTop: 4 }}
              onClick={() => setShowCreate(true)}
            >
              + New workspace
            </button>
          </div>
        </div>

        {!loading && workspaces.length > 0 && (
          <div className="header-stats" style={{ paddingBottom: 24 }}>
            <HeaderStat value={workspaces.length} label="Workspaces" />
            <HeaderStat value={totalOpen} label="Open tasks" />
            <HeaderStat value={totalProgress} label="In progress" />
            <HeaderStat value={totalCompleted} label="Completed" />
            <HeaderStat value={totalArtifacts} label="Outputs" />
          </div>
        )}
        {(loading || workspaces.length === 0) && <div style={{ paddingBottom: 28 }} />}
      </SpotlightHeroCard>

      {/* ── Create workspace modal ── */}
      {showCreate && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: "rgba(10, 12, 18, 0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 24,
        }}>
          <form
            onSubmit={handleCreate}
            style={{
              width: "100%", maxWidth: 560,
              padding: "28px 32px 24px",
              borderRadius: "var(--r-3)",
              border: "1px solid var(--hairline)",
              boxShadow: "var(--shadow-3), 0 0 0 1px rgba(255,255,255,0.6) inset",
              background: "var(--paper-solid)",
              display: "flex", flexDirection: "column", gap: 20,
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div className="a-eyebrow" style={{ marginBottom: 6 }}>New workspace</div>
                <h2 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 600, lineHeight: 1.25, color: "var(--ink-1)" }}>
                  Create a workspace
                </h2>
                <p style={{ margin: 0, fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>
                  Coordinate agents around shared tasks, outputs, and rules.
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setShowCreate(false); setCreateErr(null); }}
                style={{
                  fontSize: 18, lineHeight: 1, color: "var(--ink-4)",
                  background: "none", border: "none", cursor: "pointer",
                  padding: "2px 4px", marginTop: 2, flexShrink: 0,
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Divider */}
            <div style={{ borderTop: "1px solid var(--hairline)", margin: "0 -32px", paddingTop: 20 }} />

            {createErr && (
              <div style={{ fontSize: 12.5, color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-1)", padding: "8px 12px" }}>
                {createErr}
              </div>
            )}

            <div>
              <label className="ag-label">Workspace name *</label>
              <input
                className="ag-input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Research coordination"
                required
              />
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--ink-4)" }}>
                A name you will recognize later.
              </p>
            </div>

            <div>
              <label className="ag-label">Purpose</label>
              <textarea
                className="ag-input"
                style={{ resize: "none" }}
                rows={2}
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="What are agents working toward in this workspace?"
              />
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--ink-4)" }}>
                Describe the goal or project this workspace supports.
              </p>
            </div>

            <div>
              <label className="ag-label">Rule set *</label>
              <select
                className="ag-select"
                value={createCollarId}
                onChange={(e) => setCreateCollarId(e.target.value)}
                required
              >
                <option value="">— select a rule set —</option>
                {collars.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--ink-4)" }}>
                Agents in this workspace will follow this rule set.
              </p>
            </div>

            {/* Footer */}
            <div style={{ borderTop: "1px solid var(--hairline)", margin: "0 -32px", paddingTop: 20, paddingLeft: 32, paddingRight: 32 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-4)", lineHeight: 1.4 }}>
                  You can add agents and tasks after creating the workspace.
                </p>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setCreateErr(null); }}
                    className="a-btn a-btn--ghost"
                    style={{ fontSize: 13 }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={createSubmitting || !createName.trim() || !createCollarId}
                    className="a-btn a-btn--primary"
                  >
                    {createSubmitting ? "Creating…" : "Create workspace"}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              height: 88, borderRadius: "var(--r-2)",
              background: "var(--graphite-soft)", opacity: 0.45,
            }} />
          ))}
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{
          background: "var(--amber-soft)", border: "1px solid var(--amber-ring)",
          borderRadius: "var(--r-3)", padding: "14px 18px",
        }}>
          <div className="a-eyebrow" style={{ color: "var(--amber)", marginBottom: 4 }}>Error</div>
          <p style={{ fontSize: 13, color: "var(--ink-1)", margin: 0 }}>{error}</p>
        </div>
      )}

      {/* ── Empty ── */}
      {!loading && !error && workspaces.length === 0 && (
        <div className="a-card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 4px" }}>
            No workspaces yet.
          </p>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 6px", lineHeight: 1.5 }}>
            Create a shared execution space for agents, tasks, and outputs.
          </p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
            Run{" "}
            <code style={{ fontFamily: "monospace", fontSize: 11.5, color: "var(--ink-3)" }}>npm run seed:demo</code>
            {" "}to load the Coordination Trial Workspace.
          </p>
        </div>
      )}

      {/* ── Workspace list ── */}
      {!loading && workspaces.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {workspaces.map((w) => {
            const accent = wsAccent(w.workspace_id);
            const initials = w.name.slice(0, 2).toUpperCase();
            const ruleSet = collarName(w.collar_id);
            return (
              <div
                key={w.workspace_id}
                className="ag-row"
                style={{ borderLeft: `3px solid ${accent.border}`, background: accent.bg }}
              >
                <div
                  className="ag-avatar"
                  style={{ borderColor: accent.border, color: accent.border, fontSize: 11, fontWeight: 700 }}
                >
                  {initials}
                </div>

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)" }}>{w.name}</span>
                  </div>

                  {w.description && (
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 6px", lineHeight: 1.4 }}>
                      {w.description}
                    </p>
                  )}

                  <div className="a-meta-line" style={{ marginTop: w.description ? 0 : 4 }}>
                    <span>Status: {w.status === "active" ? "Active" : "Archived"}</span>
                    <span className="a-meta-line__sep">·</span>
                    <span>Active: {w.task_counts.open + w.task_counts.in_progress}</span>
                    <span className="a-meta-line__sep">·</span>
                    <span>Completed: {w.task_counts.completed}</span>
                    <span className="a-meta-line__sep">·</span>
                    <span>Agents: {w.participant_delegation_ids.length}</span>
                    <span className="a-meta-line__sep">·</span>
                    <span>Rule set: {ruleSet}</span>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                  <Link href={`/workspaces/${w.workspace_id}`} className="a-btn a-btn--ghost">
                    Open
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
