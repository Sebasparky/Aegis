"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listWorkspaces, type WorkspaceWithCounts } from "@/lib/api";

function GridIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function CountChip({ value, label, color }: { value: number; label: string; color: "green" | "blue" | "amber" | "graphite" }) {
  const styles: Record<string, React.CSSProperties> = {
    green:    { background: "var(--green-soft)",    color: "oklch(0.42 0.09 150)", border: "1px solid var(--green-ring)" },
    blue:     { background: "var(--blue-soft)",     color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)" },
    amber:    { background: "var(--amber-soft)",    color: "oklch(0.45 0.12 75)",  border: "1px solid var(--amber-ring)" },
    graphite: { background: "var(--graphite-soft)", color: "var(--ink-2)",         border: "1px solid var(--hairline)" },
  };
  return (
    <span style={{
      ...styles[color],
      fontSize: 11, fontWeight: 500,
      padding: "2px 9px", borderRadius: 999,
      display: "inline-flex", alignItems: "center", gap: 4,
    }}>
      <span style={{ fontWeight: 600 }}>{value}</span>{" "}{label}
    </span>
  );
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setWorkspaces(await listWorkspaces());
    } catch {
      setError("Could not load workspaces.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const totalOpen      = workspaces.reduce((s, w) => s + w.task_counts.open, 0);
  const totalProgress  = workspaces.reduce((s, w) => s + w.task_counts.in_progress, 0);
  const totalCompleted = workspaces.reduce((s, w) => s + w.task_counts.completed, 0);
  const totalArtifacts = workspaces.reduce((s, w) => s + w.artifact_count, 0);

  return (
    <div className="page">

      {/* ── Hero ── */}
      <div className="cmd-hero cmd-hero--ceramic" style={{ padding: "32px 36px 0" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div className="a-eyebrow" style={{ marginBottom: 8 }}>Workspaces</div>
          <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "0 0 10px" }}>
            Agents,{" "}
            <span className="cmd-hero__title-mark">coordinated.</span>
          </h1>
          <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0, maxWidth: 560 }}>
            Coordinate multiple agents through shared tasks, artifacts, collars, and audit-ready outcomes.
          </p>
        </div>

        {!loading && workspaces.length > 0 && (
          <div className="cmd-pulse" style={{ marginTop: 24, paddingBottom: 24, borderTop: "1px solid var(--hairline)", justifyContent: "flex-start" }}>
            <div className="cmd-pulse__item" style={{ cursor: "default" }}>
              <span className="cmd-pulse__num">{workspaces.length}</span>
              <span className="cmd-pulse__lab">Workspaces</span>
            </div>
            <div className="cmd-pulse__div" />
            <div className="cmd-pulse__item" style={{ cursor: "default" }}>
              <span className="cmd-pulse__num">{totalOpen}</span>
              <span className="cmd-pulse__lab">Open Tasks</span>
            </div>
            <div className="cmd-pulse__div" />
            <div className="cmd-pulse__item" style={{ cursor: "default" }}>
              <span className="cmd-pulse__num">{totalProgress}</span>
              <span className="cmd-pulse__lab">In Progress</span>
            </div>
            <div className="cmd-pulse__div" />
            <div className="cmd-pulse__item" style={{ cursor: "default" }}>
              <span className="cmd-pulse__num">{totalCompleted}</span>
              <span className="cmd-pulse__lab">Completed</span>
            </div>
            <div className="cmd-pulse__div" />
            <div className="cmd-pulse__item" style={{ cursor: "default" }}>
              <span className="cmd-pulse__num">{totalArtifacts}</span>
              <span className="cmd-pulse__lab">Artifacts</span>
            </div>
          </div>
        )}
        {(loading || workspaces.length === 0) && <div style={{ paddingBottom: 28 }} />}
      </div>

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
            Create a shared execution space for agents, tasks, and artifacts.
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
          {workspaces.map((w) => (
            <div key={w.workspace_id} className="ag-row">

              <div className="ag-avatar" style={{ marginTop: 2 }}>
                <GridIcon />
              </div>

              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)" }}>
                    {w.name}
                  </span>
                  <span className={`a-status a-status--${w.status === "active" ? "green" : "graphite"}`}>
                    <span className="a-status__dot" />
                    {w.status}
                  </span>
                </div>

                {w.description && (
                  <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 8px", lineHeight: 1.4 }}>
                    {w.description}
                  </p>
                )}

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: w.description ? 0 : 6 }}>
                  <CountChip value={w.task_counts.open + w.task_counts.in_progress} label="active" color="blue" />
                  <CountChip value={w.task_counts.completed} label="done" color="green" />
                  <CountChip value={w.artifact_count} label="artifacts" color="amber" />
                  <CountChip value={w.participant_delegation_ids.length} label="participants" color="graphite" />
                </div>

                <div style={{ marginTop: 8, fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace" }}>
                  collar: {w.collar_id}
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                <Link href={`/workspaces/${w.workspace_id}`} className="a-btn a-btn--ghost">
                  Open →
                </Link>
              </div>

            </div>
          ))}
        </div>
      )}

    </div>
  );
}
