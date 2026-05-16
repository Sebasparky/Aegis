"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { AgentDelegation, TaskKind, TaskMode, TaskPriority, WorkspaceArtifactKind } from "@aegis/types";
import {
  getWorkspace,
  listWorkspaceTasks,
  createWorkspaceTask,
  resetWorkspaceTask,
  listWorkspaceArtifacts,
  getWorkspaceArtifact,
  createWorkspaceArtifact,
  uploadWorkspaceArtifact,
  getArtifactDownloadUrl,
  listDelegations,
  type WorkspaceWithCounts,
  type WorkspaceTaskWithReadiness,
  type WorkspaceArtifactMeta,
  type WorkspaceArtifactFull,
} from "@/lib/api";

type Readiness = WorkspaceTaskWithReadiness["readiness"];
type TabId = "tasks" | "artifacts" | "participants";

// ─── Shared style helpers ──────────────────────────────────────────────────────

function permChip(color: "green" | "amber" | "red" | "graphite" | "blue"): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    green:    { background: "var(--green-soft)",    color: "oklch(0.42 0.09 150)", border: "1px solid var(--green-ring)" },
    blue:     { background: "var(--blue-soft)",     color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)" },
    amber:    { background: "var(--amber-soft)",    color: "oklch(0.45 0.12 75)",  border: "1px solid var(--amber-ring)" },
    red:      { background: "var(--red-soft)",      color: "oklch(0.45 0.13 25)",  border: "1px solid var(--red-ring)" },
    graphite: { background: "var(--graphite-soft)", color: "var(--ink-2)",         border: "1px solid var(--hairline)" },
  };
  return {
    ...map[color],
    fontSize: 11, fontWeight: 500,
    padding: "2px 9px", borderRadius: 999,
    display: "inline-flex", alignItems: "center", gap: 4,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkspaceDetailPage() {
  const params = useParams();
  const workspaceId = params.id as string;

  const [workspace, setWorkspace] = useState<WorkspaceWithCounts | null>(null);
  const [tasks, setTasks] = useState<WorkspaceTaskWithReadiness[]>([]);
  const [artifacts, setArtifacts] = useState<WorkspaceArtifactMeta[]>([]);
  const [delegations, setDelegations] = useState<AgentDelegation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("tasks");

  const [viewingArtifact, setViewingArtifact] = useState<WorkspaceArtifactFull | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);

  const [showTaskForm, setShowTaskForm] = useState(false);
  const [artifactFormMode, setArtifactFormMode] = useState<"none" | "text" | "file">("none");

  async function load() {
    try {
      const [ws, ts, arts, delgs] = await Promise.allSettled([
        getWorkspace(workspaceId),
        listWorkspaceTasks(workspaceId),
        listWorkspaceArtifacts(workspaceId),
        listDelegations(),
      ]);
      if (ws.status === "fulfilled") setWorkspace(ws.value);
      else setError("Workspace not found.");
      if (ts.status === "fulfilled") setTasks(ts.value);
      if (arts.status === "fulfilled") setArtifacts(arts.value);
      if (delgs.status === "fulfilled") setDelegations(delgs.value);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [workspaceId]);

  async function handleResetTask(taskId: string) {
    if (!confirm("Reset this task to open? The current agent claim will be released.")) return;
    try {
      await resetWorkspaceTask(workspaceId, taskId);
      await load();
    } catch {
      alert("Failed to reset task.");
    }
  }

  async function handleViewArtifact(artifactId: string) {
    setArtifactLoading(true);
    try {
      const full = await getWorkspaceArtifact(workspaceId, artifactId);
      setViewingArtifact(full);
    } catch {
      alert("Could not load artifact content.");
    } finally {
      setArtifactLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ height: 88, borderRadius: "var(--r-2)", background: "var(--graphite-soft)", opacity: 0.45 }} />
          ))}
        </div>
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <div className="page">
        <Link href="/workspaces" className="a-link" style={{ fontSize: 12.5, marginBottom: 12, display: "inline-flex" }}>
          ← Workspaces
        </Link>
        <div style={{ background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-3)", padding: "14px 18px" }}>
          <div className="a-eyebrow" style={{ color: "var(--red)", marginBottom: 4 }}>Error</div>
          <p style={{ fontSize: 13, color: "var(--ink-1)", margin: 0 }}>{error ?? "Workspace not found."}</p>
        </div>
      </div>
    );
  }

  const { open, in_progress, completed } = workspace.task_counts;
  const participantDelegations = delegations.filter((d) =>
    workspace.participant_delegation_ids?.includes(d.id) ?? false,
  );

  const byReadiness = (label: Readiness) => tasks.filter((t) => t.readiness === label);
  const ready      = byReadiness("ready");
  const inProgress = byReadiness("in_progress_other");
  const blocked    = byReadiness("blocked");
  const done       = [...byReadiness("completed"), ...byReadiness("cancelled")];

  return (
    <div className="page">

      {/* ── Back ── */}
      <Link href="/workspaces" className="a-link" style={{ fontSize: 12.5, alignSelf: "flex-start" }}>
        ← Workspaces
      </Link>

      {/* ── Hero ── */}
      <div className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 0" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="a-eyebrow" style={{ marginBottom: 8 }}>Workspace</div>
              <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "0 0 8px" }}>
                <span className="cmd-hero__title-mark">{workspace.name}</span>
              </h1>
              {workspace.description && (
                <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: "0 0 10px", maxWidth: 600 }}>
                  {workspace.description}
                </p>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className={`a-status a-status--${workspace.status === "active" ? "green" : "graphite"}`}>
                  <span className="a-status__dot" />
                  {workspace.status}
                </span>
                <span style={permChip("graphite")}>
                  collar: <span style={{ fontFamily: "monospace", fontSize: 10.5 }}>{workspace.collar_id}</span>
                </span>
                <span style={permChip("graphite")}>
                  {workspace.participant_delegation_ids.length} participant{workspace.participant_delegation_ids.length !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
            <button
              onClick={() => load()}
              className="a-btn a-btn--ghost"
              style={{ flexShrink: 0 }}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Stat strip */}
        <div className="cmd-pulse" style={{ marginTop: 24, paddingBottom: 24, borderTop: "1px solid var(--hairline)", justifyContent: "flex-start" }}>
          <div className="cmd-pulse__item" style={{ cursor: "default" }}>
            <span className="cmd-pulse__num">{open}</span>
            <span className="cmd-pulse__lab">Open</span>
          </div>
          <div className="cmd-pulse__div" />
          <div className="cmd-pulse__item" style={{ cursor: "default" }}>
            <span className="cmd-pulse__num">{in_progress}</span>
            <span className="cmd-pulse__lab">In Progress</span>
          </div>
          <div className="cmd-pulse__div" />
          <div className="cmd-pulse__item" style={{ cursor: "default" }}>
            <span className="cmd-pulse__num">{completed}</span>
            <span className="cmd-pulse__lab">Completed</span>
          </div>
          <div className="cmd-pulse__div" />
          <div className="cmd-pulse__item" style={{ cursor: "default" }}>
            <span className="cmd-pulse__num">{workspace.artifact_count}</span>
            <span className="cmd-pulse__lab">Artifacts</span>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="ag-tabs">
        {(["tasks", "artifacts", "participants"] as TabId[]).map((tab) => (
          <button
            key={tab}
            className={`ag-tab${activeTab === tab ? " ag-tab--active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === "tasks" && (
              <span style={{ marginLeft: 6, ...permChip("graphite"), fontSize: 10.5, padding: "1px 7px" }}>
                {tasks.length}
              </span>
            )}
            {tab === "artifacts" && (
              <span style={{ marginLeft: 6, ...permChip("graphite"), fontSize: 10.5, padding: "1px 7px" }}>
                {artifacts.length}
              </span>
            )}
            {tab === "participants" && (
              <span style={{ marginLeft: 6, ...permChip("graphite"), fontSize: 10.5, padding: "1px 7px" }}>
                {workspace.participant_delegation_ids.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tasks tab ── */}
      {activeTab === "tasks" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="a-eyebrow">Tasks</span>
            <button
              className="a-btn a-btn--ghost"
              style={{ fontSize: 12.5 }}
              onClick={() => { setShowTaskForm((s) => !s); setArtifactFormMode("none"); }}
            >
              {showTaskForm ? "Cancel" : "+ Create Task"}
            </button>
          </div>

          {showTaskForm && (
            <CreateTaskForm
              workspaceId={workspaceId}
              tasks={tasks}
              participantDelegations={participantDelegations}
              onCreated={() => { setShowTaskForm(false); load(); }}
            />
          )}

          <TaskGroup label="Ready" count={ready.length} accent="green" tasks={ready} />
          <TaskGroup label="In Progress" count={inProgress.length} accent="blue" tasks={inProgress} onResetTask={handleResetTask} />
          <TaskGroup label="Blocked" count={blocked.length} accent="amber" tasks={blocked} />
          <TaskGroup label="Completed / Cancelled" count={done.length} accent="graphite" tasks={done} collapsed />
        </div>
      )}

      {/* ── Artifacts tab ── */}
      {activeTab === "artifacts" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="a-eyebrow">Shared Context</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="a-btn a-btn--ghost"
                style={{ fontSize: 12.5 }}
                onClick={() => { setArtifactFormMode((m) => m === "text" ? "none" : "text"); setShowTaskForm(false); }}
              >
                {artifactFormMode === "text" ? "Cancel" : "+ Text"}
              </button>
              <button
                className="a-btn a-btn--ghost"
                style={{ fontSize: 12.5 }}
                onClick={() => { setArtifactFormMode((m) => m === "file" ? "none" : "file"); setShowTaskForm(false); }}
              >
                {artifactFormMode === "file" ? "Cancel" : "+ Upload File"}
              </button>
            </div>
          </div>

          {artifactFormMode === "text" && (
            <CreateArtifactForm
              workspaceId={workspaceId}
              tasks={tasks}
              onCreated={() => { setArtifactFormMode("none"); load(); }}
            />
          )}

          {artifactFormMode === "file" && (
            <UploadArtifactForm
              workspaceId={workspaceId}
              tasks={tasks}
              onCreated={() => { setArtifactFormMode("none"); load(); }}
            />
          )}

          {artifacts.length === 0 && artifactFormMode === "none" && (
            <div className="a-card" style={{ textAlign: "center", padding: "40px 24px" }}>
              <p style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 4px" }}>
                No artifacts yet.
              </p>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Agents create artifacts when completing tasks, or add one above.
              </p>
            </div>
          )}

          {artifacts.length > 0 && (
            <div className="a-card" style={{ padding: 0, overflow: "hidden" }}>
              {artifacts.map((a, i) => (
                <div
                  key={a.artifact_id}
                  style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "12px 18px",
                    borderTop: i > 0 ? "1px solid var(--hairline)" : undefined,
                  }}
                >
                  <KindBadge kind={a.kind} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-1)" }}>{a.name}</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0 12px", marginTop: 2 }}>
                      {a.task_id && (
                        <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>task: <span style={{ fontFamily: "monospace", fontSize: 11 }}>{a.task_id}</span></span>
                      )}
                      {a.created_by_delegation_id && (
                        <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>by: <span style={{ fontFamily: "monospace", fontSize: 11 }}>{a.created_by_delegation_id}</span></span>
                      )}
                      <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{formatBytes(a.size_bytes)}</span>
                      {a.kind === "file" && a.mime_type && (
                        <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{a.mime_type}</span>
                      )}
                    </div>
                  </div>
                  {a.kind === "file" ? (
                    <a
                      href={getArtifactDownloadUrl(workspaceId, a.artifact_id)}
                      download={a.name}
                      className="a-btn a-btn--ghost"
                      style={{ fontSize: 12.5, flexShrink: 0 }}
                    >
                      Download
                    </a>
                  ) : (
                    <button
                      onClick={() =>
                        viewingArtifact?.artifact_id === a.artifact_id
                          ? setViewingArtifact(null)
                          : handleViewArtifact(a.artifact_id)
                      }
                      disabled={artifactLoading}
                      className="a-btn a-btn--ghost"
                      style={{ fontSize: 12.5, flexShrink: 0 }}
                    >
                      {viewingArtifact?.artifact_id === a.artifact_id ? "Hide" : "View"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {viewingArtifact && (
            <div className="a-card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 16px", borderBottom: "1px solid var(--hairline)",
              }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-2)" }}>{viewingArtifact.name}</span>
                <button
                  onClick={() => setViewingArtifact(null)}
                  style={{ fontSize: 12, color: "var(--ink-4)", background: "none", border: "none", cursor: "pointer" }}
                >
                  Close ✕
                </button>
              </div>
              <pre style={{
                margin: 0, padding: "16px",
                fontSize: 12, color: "var(--ink-2)", fontFamily: "monospace",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
                maxHeight: 400, overflowY: "auto",
                background: "var(--graphite-soft)",
              }}>
                {viewingArtifact.content}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ── Participants tab ── */}
      {activeTab === "participants" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <span className="a-eyebrow">Participants ({workspace.participant_delegation_ids.length})</span>

          {workspace.participant_delegation_ids.length === 0 ? (
            <div className="a-card" style={{ textAlign: "center", padding: "40px 24px" }}>
              <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>No participants assigned.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {workspace.participant_delegation_ids.map((delgId) => {
                const delg = participantDelegations.find((d) => d.id === delgId);
                const name = delg?.agent_name ?? delgId;
                const initials = name.slice(0, 2).toUpperCase();
                return (
                  <div key={delgId} className="ag-row">
                    <div className="ag-avatar">
                      <span style={{ fontSize: 11, fontWeight: 700 }}>{initials}</span>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)" }}>
                        {delg?.agent_name ?? delgId}
                      </span>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                        <span style={{ fontSize: 11.5, color: "var(--ink-4)", fontFamily: "monospace" }}>{delgId}</span>
                        {delg?.default_collar_id && (
                          <span style={permChip("graphite")}>
                            collar: <span style={{ fontFamily: "monospace", fontSize: 10.5 }}>{delg.default_collar_id}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ flexShrink: 0 }}>
                      <span style={permChip("blue")}>participant</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// ─── Task Group ────────────────────────────────────────────────────────────────

function TaskGroup({
  label,
  count,
  accent,
  tasks,
  collapsed = false,
  onResetTask,
}: {
  label: string;
  count: number;
  accent: "green" | "blue" | "amber" | "graphite";
  tasks: WorkspaceTaskWithReadiness[];
  collapsed?: boolean;
  onResetTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(!collapsed);

  const dotColor: Record<string, string> = {
    green:    "var(--green)",
    blue:     "var(--blue)",
    amber:    "var(--amber)",
    graphite: "var(--graphite)",
  };

  return (
    <div>
      <button
        onClick={() => setOpen((s) => !s)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", textAlign: "left",
          background: "none", border: "none", cursor: "pointer",
          padding: "4px 0", marginBottom: open ? 8 : 0,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor[accent], display: "inline-block", flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", letterSpacing: "0.04em" }}>
          {label}
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-4)" }}>({count})</span>
        <span style={{ fontSize: 10, color: "var(--ink-4)", marginLeft: 2 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 16 }}>
          {tasks.length === 0 && (
            <p style={{ fontSize: 12.5, color: "var(--ink-4)", padding: "8px 0", margin: 0 }}>
              No {label.toLowerCase()} tasks.
            </p>
          )}
          {tasks.map((task) => (
            <TaskCard
              key={task.task_id}
              task={task}
              onReset={onResetTask ? () => onResetTask(task.task_id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Task Card ─────────────────────────────────────────────────────────────────

function TaskCard({ task, onReset }: { task: WorkspaceTaskWithReadiness; onReset?: () => void }) {
  const readinessColor: Record<Readiness, "green" | "blue" | "amber" | "graphite" | "red"> = {
    ready:            "green",
    in_progress_other: "blue",
    in_progress_mine:  "blue",
    blocked:          "amber",
    completed:        "graphite",
    cancelled:        "graphite",
  };
  const readinessLabel: Record<Readiness, string> = {
    ready:             "ready",
    in_progress_other: "in progress",
    in_progress_mine:  "in progress",
    blocked:           "blocked",
    completed:         "completed",
    cancelled:         "cancelled",
  };
  const statusClass = `a-status a-status--${readinessColor[task.readiness]}`;

  return (
    <div className="a-card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)", lineHeight: 1.4 }}>
          {task.title}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {task.priority && task.priority !== "normal" && (
            <PriorityChip priority={task.priority} />
          )}
          <span className={statusClass}>
            <span className="a-status__dot" />
            {readinessLabel[task.readiness]}
          </span>
          {task.status === "in_progress" && onReset && (
            <button
              onClick={onReset}
              className="a-btn a-btn--danger"
              style={{ fontSize: 11.5, padding: "3px 10px" }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {task.description && (
        <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 8px", lineHeight: 1.45 }}>
          {task.description}
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px", alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
        {task.task_kind && <span style={{ fontFamily: "monospace", fontSize: 11.5 }}>{task.task_kind}</span>}
        {task.task_kind && task.task_mode && <span style={{ color: "var(--ink-4)" }}>·</span>}
        {task.task_mode && <span style={{ fontFamily: "monospace", fontSize: 11.5 }}>{task.task_mode}</span>}
        {task.assignment_type && (
          <>
            <span style={{ color: "var(--ink-4)" }}>·</span>
            {task.assignment_type === "open" && (
              <span style={{ fontSize: 11.5, ...permChip("graphite"), padding: "1px 7px" }}>open</span>
            )}
            {task.assignment_type === "collar" && task.required_collar_id && (
              <span style={{ fontSize: 11.5, ...permChip("blue"), padding: "1px 7px" }}>
                collar: <span style={{ fontFamily: "monospace", fontSize: 10.5 }}>{task.required_collar_id}</span>
              </span>
            )}
            {task.assignment_type === "delegation" && task.assigned_delegation_id && (
              <span style={{ fontSize: 11.5, ...permChip("blue"), padding: "1px 7px" }}>
                <span style={{ fontFamily: "monospace", fontSize: 10.5 }}>{task.assigned_delegation_id}</span>
              </span>
            )}
          </>
        )}
      </div>

      {task.blocker_reasons && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
          {task.blocker_reasons.incomplete_dependency_task_ids?.map((id) => (
            <p key={id} style={{ margin: 0, fontSize: 12, color: "oklch(0.45 0.12 75)" }}>
              ⏳ waiting on: <span style={{ fontFamily: "monospace", fontSize: 11.5 }}>{id}</span>
            </p>
          ))}
          {task.blocker_reasons.missing_artifact_names?.map((name) => (
            <p key={name} style={{ margin: 0, fontSize: 12, color: "oklch(0.45 0.12 75)" }}>
              missing artifact: <span style={{ fontFamily: "monospace", fontSize: 11.5 }}>{name}</span>
            </p>
          ))}
        </div>
      )}

      {(task.required_artifact_names?.length ?? 0) > 0 && task.readiness !== "blocked" && (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
          {task.required_artifact_names!.map((name) => (
            <span key={name} style={{ ...permChip("graphite"), fontSize: 11, fontFamily: "monospace", padding: "1px 8px" }}>
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Create Task Form ──────────────────────────────────────────────────────────

function CreateTaskForm({
  workspaceId,
  tasks,
  participantDelegations,
  onCreated,
}: {
  workspaceId: string;
  tasks: WorkspaceTaskWithReadiness[];
  participantDelegations: AgentDelegation[];
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskKind, setTaskKind] = useState<TaskKind>("other");
  const [taskMode, setTaskMode] = useState<TaskMode>("direct");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [assignmentType, setAssignmentType] = useState<"open" | "delegation" | "collar">("open");
  const [assignedDelegationId, setAssignedDelegationId] = useState("");
  const [requiredCollarId, setRequiredCollarId] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [requiredArtifacts, setRequiredArtifacts] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setErr("Title is required."); return; }
    if (assignmentType === "delegation" && !assignedDelegationId) { setErr("Select a delegation to assign this task."); return; }
    if (assignmentType === "collar" && !requiredCollarId.trim()) { setErr("Enter a collar ID for collar-assigned tasks."); return; }
    setSubmitting(true);
    setErr(null);
    try {
      await createWorkspaceTask(workspaceId, {
        title: title.trim(),
        description: description.trim() || undefined,
        task_kind: taskKind,
        task_mode: taskMode,
        priority,
        assignment_type: assignmentType,
        assigned_delegation_id: assignmentType === "delegation" ? assignedDelegationId || undefined : undefined,
        required_collar_id: assignmentType === "collar" ? requiredCollarId.trim() || undefined : undefined,
        depends_on_task_ids: dependsOn,
        required_artifact_names: requiredArtifacts.split(",").map((s) => s.trim()).filter(Boolean),
      });
      onCreated();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "Failed to create task.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="a-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, border: "1px solid var(--blue-ring)" }}>
      <div className="a-eyebrow" style={{ color: "var(--blue)" }}>New Task</div>

      {err && (
        <div style={{ fontSize: 12.5, color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-1)", padding: "8px 12px" }}>
          {err}
        </div>
      )}

      <div>
        <label className="ag-label">Title *</label>
        <input className="ag-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?" required />
      </div>

      <div>
        <label className="ag-label">Description</label>
        <textarea className="ag-input" style={{ resize: "none" }} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional context for the agent." />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div>
          <label className="ag-label">Kind</label>
          <select className="ag-select" value={taskKind} onChange={(e) => setTaskKind(e.target.value as TaskKind)}>
            {(["research","analysis","draft","review","shopping","coding","planning","approval_prep","execution","other"] as TaskKind[]).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="ag-label">Mode</label>
          <select className="ag-select" value={taskMode} onChange={(e) => setTaskMode(e.target.value as TaskMode)}>
            <option value="direct">direct</option>
            <option value="plan_first">plan_first</option>
          </select>
        </div>
        <div>
          <label className="ag-label">Priority</label>
          <select className="ag-select" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
            <option value="urgent">urgent</option>
          </select>
        </div>
      </div>

      <div>
        <label className="ag-label">Assignment</label>
        <div style={{ display: "flex", gap: 16 }}>
          {(["open", "delegation", "collar"] as const).map((t) => (
            <label key={t} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
              <input
                type="radio"
                name="assignment_type"
                value={t}
                checked={assignmentType === t}
                onChange={() => setAssignmentType(t)}
                style={{ accentColor: "var(--blue)" }}
              />
              <span style={{ color: "var(--ink-2)" }}>{t}</span>
            </label>
          ))}
        </div>
      </div>

      {assignmentType === "delegation" && (
        <div>
          <label className="ag-label">Delegation</label>
          <select className="ag-select" value={assignedDelegationId} onChange={(e) => setAssignedDelegationId(e.target.value)}>
            <option value="">— select participant —</option>
            {participantDelegations.map((d) => (
              <option key={d.id} value={d.id}>{d.agent_name} ({d.id})</option>
            ))}
          </select>
        </div>
      )}

      {assignmentType === "collar" && (
        <div>
          <label className="ag-label">Required Collar ID</label>
          <input className="ag-input" value={requiredCollarId} onChange={(e) => setRequiredCollarId(e.target.value)} placeholder="collar_research_001" />
        </div>
      )}

      {tasks.length > 0 && (
        <div>
          <label className="ag-label">Depends on tasks</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 140, overflowY: "auto" }}>
            {tasks.map((t) => (
              <label key={t.task_id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={dependsOn.includes(t.task_id)}
                  onChange={(e) =>
                    setDependsOn((prev) =>
                      e.target.checked ? [...prev, t.task_id] : prev.filter((id) => id !== t.task_id),
                    )
                  }
                  style={{ accentColor: "var(--blue)" }}
                />
                <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{t.title}</span>
                <span style={{ fontSize: 11.5, color: "var(--ink-4)", fontFamily: "monospace" }}>({t.task_id})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="ag-label">Required artifact names (comma-separated)</label>
        <input className="ag-input" value={requiredArtifacts} onChange={(e) => setRequiredArtifacts(e.target.value)} placeholder="antigen-pillars-summary.md, analysis-report.json" />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" disabled={submitting} className="a-btn a-btn--primary">
          {submitting ? "Creating…" : "Create Task"}
        </button>
      </div>
    </form>
  );
}

// ─── Create Artifact Form ──────────────────────────────────────────────────────

function CreateArtifactForm({
  workspaceId,
  tasks,
  onCreated,
}: {
  workspaceId: string;
  tasks: WorkspaceTaskWithReadiness[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<WorkspaceArtifactKind>("text");
  const [content, setContent] = useState("");
  const [taskId, setTaskId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name is required."); return; }
    if (!content.trim()) { setErr("Content is required."); return; }
    setSubmitting(true);
    setErr(null);
    try {
      await createWorkspaceArtifact(workspaceId, { name: name.trim(), kind, content, task_id: taskId || undefined });
      onCreated();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "Failed to create artifact.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="a-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, border: "1px solid var(--blue-ring)" }}>
      <div className="a-eyebrow" style={{ color: "var(--blue)" }}>New Text Artifact</div>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-3)" }}>Supports text, markdown, JSON, and CSV. Max 50 KB.</p>

      {err && (
        <div style={{ fontSize: 12.5, color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-1)", padding: "8px 12px" }}>
          {err}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="ag-label">Name *</label>
          <input className="ag-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="antigen-pillars-summary.md" required />
        </div>
        <div>
          <label className="ag-label">Kind</label>
          <select className="ag-select" value={kind} onChange={(e) => setKind(e.target.value as WorkspaceArtifactKind)}>
            <option value="text">text</option>
            <option value="markdown">markdown</option>
            <option value="json">json</option>
            <option value="csv">csv</option>
          </select>
        </div>
      </div>

      {tasks.length > 0 && (
        <div>
          <label className="ag-label">Linked task (optional)</label>
          <select className="ag-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">— none —</option>
            {tasks.map((t) => (
              <option key={t.task_id} value={t.task_id}>{t.title}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="ag-label">Content *</label>
        <textarea className="ag-input" style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12.5 }} rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste or type content here…" required />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" disabled={submitting} className="a-btn a-btn--primary">
          {submitting ? "Saving…" : "Save Artifact"}
        </button>
      </div>
    </form>
  );
}

// ─── Upload Artifact Form ──────────────────────────────────────────────────────

function UploadArtifactForm({
  workspaceId,
  tasks,
  onCreated,
}: {
  workspaceId: string;
  tasks: WorkspaceTaskWithReadiness[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [taskId, setTaskId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f && !name) setName(f.name);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setErr("Please select a file."); return; }
    if (!name.trim()) { setErr("Name is required."); return; }
    setSubmitting(true);
    setErr(null);
    try {
      await uploadWorkspaceArtifact(workspaceId, file, name.trim(), taskId || undefined);
      onCreated();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "Upload failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="a-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, border: "1px solid var(--blue-ring)" }}>
      <div className="a-eyebrow" style={{ color: "var(--blue)" }}>Upload File</div>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-3)" }}>PDF, PNG, JPEG, TXT, CSV, JSON, DOCX. Max 10 MB.</p>

      {err && (
        <div style={{ fontSize: 12.5, color: "oklch(0.45 0.13 25)", background: "var(--red-soft)", border: "1px solid var(--red-ring)", borderRadius: "var(--r-1)", padding: "8px 12px" }}>
          {err}
        </div>
      )}

      <div>
        <label className="ag-label">File *</label>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.json,.docx"
          onChange={handleFileChange}
          style={{ width: "100%", fontSize: 13, color: "var(--ink-3)" }}
          required
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="ag-label">Name *</label>
          <input className="ag-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="report.pdf" required />
        </div>
        {tasks.length > 0 && (
          <div>
            <label className="ag-label">Linked task (optional)</label>
            <select className="ag-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">— none —</option>
              {tasks.map((t) => (
                <option key={t.task_id} value={t.task_id}>{t.title}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" disabled={submitting} className="a-btn a-btn--primary">
          {submitting ? "Uploading…" : "Upload"}
        </button>
      </div>
    </form>
  );
}

// ─── Shared UI helpers ─────────────────────────────────────────────────────────

function PriorityChip({ priority }: { priority: string }) {
  const color: Record<string, "red" | "amber" | "graphite"> = {
    urgent: "red",
    high:   "amber",
    low:    "graphite",
  };
  const c = color[priority] ?? "graphite";
  return (
    <span style={{ ...permChip(c), fontSize: 11, padding: "2px 8px" }}>
      {priority}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const styles: Record<string, React.CSSProperties> = {
    markdown: { background: "var(--blue-soft)",     color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)" },
    json:     { background: "var(--amber-soft)",    color: "oklch(0.45 0.12 75)",  border: "1px solid var(--amber-ring)" },
    csv:      { background: "var(--green-soft)",    color: "oklch(0.42 0.09 150)", border: "1px solid var(--green-ring)" },
    text:     { background: "var(--graphite-soft)", color: "var(--ink-2)",         border: "1px solid var(--hairline)" },
    file:     { background: "var(--graphite-soft)", color: "var(--ink-2)",         border: "1px solid var(--hairline)" },
  };
  const s = styles[kind] ?? styles.text;
  return (
    <span style={{ ...s, fontSize: 11, fontWeight: 500, fontFamily: "monospace", padding: "2px 9px", borderRadius: 6, flexShrink: 0 }}>
      {kind}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
