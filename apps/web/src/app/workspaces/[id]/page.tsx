"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { AgentDelegation, TaskKind, TaskMode, TaskPriority, WorkspaceArtifactKind } from "@aegis/types";
import {
  getWorkspace,
  listWorkspaceTasks,
  createWorkspaceTask,
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

// ─── Types ────────────────────────────────────────────────────────────────────

type Readiness = WorkspaceTaskWithReadiness["readiness"];

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

  if (loading) return <p className="text-sm text-gray-500 p-8">Loading…</p>;
  if (error || !workspace) {
    return (
      <div className="max-w-4xl">
        <Link href="/workspaces" className="text-xs text-gray-500 hover:text-gray-300 mb-4 inline-block">← Workspaces</Link>
        <p className="text-sm text-red-400">{error ?? "Workspace not found."}</p>
      </div>
    );
  }

  const { open, in_progress, completed, cancelled } = workspace.task_counts;
  const participantDelegations = delegations.filter((d) =>
    workspace.participant_delegation_ids.includes(d.id),
  );

  const byReadiness = (label: Readiness) => tasks.filter((t) => t.readiness === label);
  const ready = byReadiness("ready");
  const inProgress = byReadiness("in_progress_other");
  const blocked = byReadiness("blocked");
  const done = [...byReadiness("completed"), ...byReadiness("cancelled")];

  return (
    <div className="max-w-5xl">
      {/* Back link */}
      <Link href="/workspaces" className="text-xs text-gray-500 hover:text-gray-300 mb-4 inline-block">
        ← Workspaces
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-semibold text-white">{workspace.name}</h1>
            <StatusPill status={workspace.status} />
          </div>
          {workspace.description && (
            <p className="text-sm text-gray-400 mb-2">{workspace.description}</p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>collar: <span className="text-gray-400">{workspace.collar_id}</span></span>
            <span>{participantDelegations.length} participant{participantDelegations.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
        <button
          onClick={() => load()}
          className="shrink-0 text-xs text-gray-400 hover:text-white px-3 py-1.5 border border-gray-700 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-4 gap-3 mb-8">
        {[
          { label: "Open", value: open, color: "text-white" },
          { label: "In Progress", value: in_progress, color: "text-indigo-300" },
          { label: "Completed", value: completed, color: "text-green-400" },
          { label: "Artifacts", value: workspace.artifact_count, color: "text-amber-300" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-center">
            <div className={`text-2xl font-semibold ${color}`}>{value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Task Board */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium uppercase tracking-widest text-gray-500">Tasks</h2>
          <button
            onClick={() => { setShowTaskForm((s) => !s); setArtifactFormMode("none"); }}
            className="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1 border border-gray-700 rounded-md transition-colors"
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
        <TaskGroup label="In Progress" count={inProgress.length} accent="indigo" tasks={inProgress} />
        <TaskGroup label="Blocked" count={blocked.length} accent="amber" tasks={blocked} />
        <TaskGroup
          label="Completed / Cancelled"
          count={done.length}
          accent="gray"
          tasks={done}
          collapsed
        />
      </section>

      {/* Artifact Panel */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium uppercase tracking-widest text-gray-500">Artifacts</h2>
          <div className="flex gap-2">
            <button
              onClick={() => { setArtifactFormMode((m) => m === "text" ? "none" : "text"); setShowTaskForm(false); }}
              className="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1 border border-gray-700 rounded-md transition-colors"
            >
              {artifactFormMode === "text" ? "Cancel" : "+ Text"}
            </button>
            <button
              onClick={() => { setArtifactFormMode((m) => m === "file" ? "none" : "file"); setShowTaskForm(false); }}
              className="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1 border border-gray-700 rounded-md transition-colors"
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
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
            <p className="text-xs text-gray-500">
              No artifacts yet. Agents create artifacts when completing tasks, or you can add one above.
            </p>
          </div>
        )}

        {artifacts.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            {artifacts.map((a, i) => (
              <div
                key={a.artifact_id}
                className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-gray-800" : ""}`}
              >
                <KindBadge kind={a.kind} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-white font-medium">{a.name}</span>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 mt-0.5">
                    {a.task_id && <span>task: {a.task_id}</span>}
                    {a.created_by_delegation_id && <span>by: {a.created_by_delegation_id}</span>}
                    <span>{formatBytes(a.size_bytes)}</span>
                    {a.kind === "file" && a.mime_type && <span>{a.mime_type}</span>}
                  </div>
                </div>
                {a.kind === "file" ? (
                  <a
                    href={getArtifactDownloadUrl(workspaceId, a.artifact_id)}
                    download={a.name}
                    className="shrink-0 text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1 border border-gray-700 rounded-md transition-colors"
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
                    className="shrink-0 text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1 border border-gray-700 rounded-md transition-colors disabled:opacity-50"
                  >
                    {viewingArtifact?.artifact_id === a.artifact_id ? "Hide" : "View"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {viewingArtifact && (
          <div className="mt-3 bg-gray-950 border border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400 font-medium">{viewingArtifact.name}</span>
              <button onClick={() => setViewingArtifact(null)} className="text-xs text-gray-600 hover:text-gray-400">
                Close ✕
              </button>
            </div>
            <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words max-h-96 overflow-y-auto font-mono">
              {viewingArtifact.content}
            </pre>
          </div>
        )}
      </section>

      {/* Participants Panel */}
      <section>
        <h2 className="text-xs font-medium uppercase tracking-widest text-gray-500 mb-3">
          Participants ({workspace.participant_delegation_ids.length})
        </h2>
        {workspace.participant_delegation_ids.length === 0 ? (
          <p className="text-xs text-gray-600">No participants assigned.</p>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            {workspace.participant_delegation_ids.map((delgId, i) => {
              const delg = participantDelegations.find((d) => d.id === delgId);
              return (
                <div
                  key={delgId}
                  className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-gray-800" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-white font-medium">{delg?.agent_name ?? delgId}</span>
                    <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                      <span>{delgId}</span>
                      {delg?.default_collar_id && (
                        <span>collar: <span className="text-gray-400">{delg.default_collar_id}</span></span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-gray-600">participant</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Task Group ───────────────────────────────────────────────────────────────

function TaskGroup({
  label,
  count,
  accent,
  tasks,
  collapsed = false,
}: {
  label: string;
  count: number;
  accent: "green" | "indigo" | "amber" | "gray";
  tasks: WorkspaceTaskWithReadiness[];
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);

  const dotColor = {
    green: "bg-green-500",
    indigo: "bg-indigo-500",
    amber: "bg-amber-500",
    gray: "bg-gray-600",
  }[accent];

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((s) => !s)}
        className="flex items-center gap-2 w-full text-left mb-2 group"
      >
        <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />
        <span className="text-xs font-medium text-gray-400 group-hover:text-gray-300 transition-colors">
          {label}
        </span>
        <span className="text-xs text-gray-600">({count})</span>
        <span className="text-xs text-gray-600 ml-1">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="space-y-2 pl-4">
          {tasks.length === 0 && (
            <p className="text-xs text-gray-600 py-2">No {label.toLowerCase()} tasks.</p>
          )}
          {tasks.map((task) => (
            <TaskCard key={task.task_id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Task Card ────────────────────────────────────────────────────────────────

function TaskCard({ task }: { task: WorkspaceTaskWithReadiness }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-start gap-2 mb-2">
        <span className="text-sm font-medium text-white flex-1 leading-snug">{task.title}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <PriorityPill priority={task.priority ?? "normal"} />
          <ReadinessPill readiness={task.readiness} />
        </div>
      </div>

      {task.description && (
        <p className="text-xs text-gray-500 mb-2">{task.description}</p>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
        <span>{task.task_kind ?? "other"}</span>
        <span>·</span>
        <span>{task.task_mode ?? "direct"}</span>
        {task.assignment_type && task.assignment_type !== "open" && (
          <>
            <span>·</span>
            <span>
              {task.assignment_type === "collar"
                ? `collar: ${task.required_collar_id ?? "—"}`
                : `delegation: ${task.assigned_delegation_id ?? "—"}`}
            </span>
          </>
        )}
        {task.assignment_type === "open" && <><span>·</span><span>open</span></>}
      </div>

      {task.blocker_reasons && (
        <div className="mt-2 space-y-1">
          {task.blocker_reasons.incomplete_dependency_task_ids?.map((id) => (
            <p key={id} className="text-xs text-amber-600">
              ⏳ waiting on: <span className="font-mono">{id}</span>
            </p>
          ))}
          {task.blocker_reasons.missing_artifact_names?.map((name) => (
            <p key={name} className="text-xs text-amber-600">
              📎 missing artifact: <span className="font-mono">{name}</span>
            </p>
          ))}
        </div>
      )}

      {(task.required_artifact_names?.length ?? 0) > 0 && task.readiness !== "blocked" && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.required_artifact_names!.map((name) => (
            <span key={name} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Create Task Form ─────────────────────────────────────────────────────────

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
        required_artifact_names: requiredArtifacts
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onCreated();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "Failed to create task.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls = "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-md px-3 py-2 focus:outline-none focus:border-indigo-500";
  const selectCls = inputCls;
  const labelCls = "block text-xs text-gray-400 mb-1";

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900 border border-indigo-800 rounded-lg p-5 mb-4 space-y-4">
      <div className="text-xs font-medium uppercase tracking-widest text-indigo-400 mb-1">New Task</div>

      {err && <p className="text-xs text-red-400">{err}</p>}

      <div>
        <label className={labelCls}>Title *</label>
        <input
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          required
        />
      </div>

      <div>
        <label className={labelCls}>Description</label>
        <textarea
          className={inputCls + " resize-none"}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional context for the agent."
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>Kind</label>
          <select className={selectCls} value={taskKind} onChange={(e) => setTaskKind(e.target.value as TaskKind)}>
            {(["research","analysis","draft","review","shopping","coding","planning","approval_prep","execution","other"] as TaskKind[]).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Mode</label>
          <select className={selectCls} value={taskMode} onChange={(e) => setTaskMode(e.target.value as TaskMode)}>
            <option value="direct">direct</option>
            <option value="plan_first">plan_first</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Priority</label>
          <select className={selectCls} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
            <option value="urgent">urgent</option>
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls}>Assignment</label>
        <div className="flex gap-3">
          {(["open", "delegation", "collar"] as const).map((t) => (
            <label key={t} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="assignment_type"
                value={t}
                checked={assignmentType === t}
                onChange={() => setAssignmentType(t)}
                className="accent-indigo-500"
              />
              <span className="text-xs text-gray-300">{t}</span>
            </label>
          ))}
        </div>
      </div>

      {assignmentType === "delegation" && (
        <div>
          <label className={labelCls}>Delegation</label>
          <select
            className={selectCls}
            value={assignedDelegationId}
            onChange={(e) => setAssignedDelegationId(e.target.value)}
          >
            <option value="">— select participant —</option>
            {participantDelegations.map((d) => (
              <option key={d.id} value={d.id}>{d.agent_name} ({d.id})</option>
            ))}
          </select>
        </div>
      )}

      {assignmentType === "collar" && (
        <div>
          <label className={labelCls}>Required Collar ID</label>
          <input
            className={inputCls}
            value={requiredCollarId}
            onChange={(e) => setRequiredCollarId(e.target.value)}
            placeholder="collar_research_001"
          />
        </div>
      )}

      {tasks.length > 0 && (
        <div>
          <label className={labelCls}>Depends on tasks</label>
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {tasks.map((t) => (
              <label key={t.task_id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={dependsOn.includes(t.task_id)}
                  onChange={(e) =>
                    setDependsOn((prev) =>
                      e.target.checked ? [...prev, t.task_id] : prev.filter((id) => id !== t.task_id),
                    )
                  }
                  className="accent-indigo-500"
                />
                <span className="text-xs text-gray-300">{t.title}</span>
                <span className="text-xs text-gray-600">({t.task_id})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className={labelCls}>Required artifact names (comma-separated)</label>
        <input
          className={inputCls}
          value={requiredArtifacts}
          onChange={(e) => setRequiredArtifacts(e.target.value)}
          placeholder="aegis-pillars-summary.md, analysis-report.json"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="text-xs bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white px-4 py-2 rounded-md transition-colors"
        >
          {submitting ? "Creating…" : "Create Task"}
        </button>
      </div>
    </form>
  );
}

// ─── Create Artifact Form ─────────────────────────────────────────────────────

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
      await createWorkspaceArtifact(workspaceId, {
        name: name.trim(),
        kind,
        content,
        task_id: taskId || undefined,
      });
      onCreated();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "Failed to create artifact.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls = "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-md px-3 py-2 focus:outline-none focus:border-indigo-500";
  const labelCls = "block text-xs text-gray-400 mb-1";

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900 border border-indigo-800 rounded-lg p-5 mb-4 space-y-4">
      <div className="text-xs font-medium uppercase tracking-widest text-indigo-400 mb-1">New Text Artifact</div>
      <p className="text-xs text-gray-600">Supports text, markdown, JSON, and CSV. Max 50 KB.</p>

      {err && <p className="text-xs text-red-400">{err}</p>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Name *</label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="aegis-pillars-summary.md"
            required
          />
        </div>
        <div>
          <label className={labelCls}>Kind</label>
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as WorkspaceArtifactKind)}>
            <option value="text">text</option>
            <option value="markdown">markdown</option>
            <option value="json">json</option>
            <option value="csv">csv</option>
          </select>
        </div>
      </div>

      {tasks.length > 0 && (
        <div>
          <label className={labelCls}>Linked task (optional)</label>
          <select className={inputCls} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">— none —</option>
            {tasks.map((t) => (
              <option key={t.task_id} value={t.task_id}>{t.title}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className={labelCls}>Content *</label>
        <textarea
          className={inputCls + " resize-y font-mono text-xs"}
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste or type content here…"
          required
        />
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="text-xs bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white px-4 py-2 rounded-md transition-colors"
        >
          {submitting ? "Saving…" : "Save Artifact"}
        </button>
      </div>
    </form>
  );
}

// ─── Upload Artifact Form ─────────────────────────────────────────────────────

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

  const inputCls = "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-md px-3 py-2 focus:outline-none focus:border-indigo-500";
  const labelCls = "block text-xs text-gray-400 mb-1";

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900 border border-indigo-800 rounded-lg p-5 mb-4 space-y-4">
      <div className="text-xs font-medium uppercase tracking-widest text-indigo-400 mb-1">Upload File</div>
      <p className="text-xs text-gray-600">PDF, PNG, JPEG, TXT, CSV, JSON, DOCX. Max 10 MB.</p>

      {err && <p className="text-xs text-red-400">{err}</p>}

      <div>
        <label className={labelCls}>File *</label>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.json,.docx"
          onChange={handleFileChange}
          className="w-full text-sm text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:bg-gray-700 file:text-gray-300 hover:file:bg-gray-600"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Name *</label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="report.pdf"
            required
          />
        </div>
        {tasks.length > 0 && (
          <div>
            <label className={labelCls}>Linked task (optional)</label>
            <select className={inputCls} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">— none —</option>
              {tasks.map((t) => (
                <option key={t.task_id} value={t.task_id}>{t.title}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="text-xs bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white px-4 py-2 rounded-md transition-colors"
        >
          {submitting ? "Uploading…" : "Upload"}
        </button>
      </div>
    </form>
  );
}

// ─── Shared UI helpers ────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "active" ? "bg-green-900 text-green-400" : "bg-gray-800 text-gray-500";
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{status}</span>;
}

function ReadinessPill({ readiness }: { readiness: Readiness }) {
  const map: Record<Readiness, string> = {
    ready: "bg-green-900 text-green-400",
    in_progress_other: "bg-indigo-900 text-indigo-300",
    in_progress_mine: "bg-indigo-900 text-indigo-300",
    blocked: "bg-amber-900 text-amber-400",
    completed: "bg-gray-800 text-gray-400",
    cancelled: "bg-gray-800 text-gray-600",
  };
  const label: Record<Readiness, string> = {
    ready: "ready",
    in_progress_other: "in progress",
    in_progress_mine: "in progress",
    blocked: "blocked",
    completed: "completed",
    cancelled: "cancelled",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[readiness]}`}>
      {label[readiness]}
    </span>
  );
}

function PriorityPill({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    urgent: "bg-red-900 text-red-400",
    high: "bg-orange-900 text-orange-400",
    normal: "bg-gray-800 text-gray-400",
    low: "bg-gray-800 text-gray-600",
  };
  if (priority === "normal") return null;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[priority] ?? "bg-gray-800 text-gray-500"}`}>
      {priority}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const colors: Record<string, string> = {
    markdown: "bg-blue-900 text-blue-300",
    json: "bg-yellow-900 text-yellow-400",
    csv: "bg-green-900 text-green-400",
    text: "bg-gray-800 text-gray-400",
    file: "bg-purple-900 text-purple-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono font-medium ${colors[kind] ?? "bg-gray-800 text-gray-400"}`}>
      {kind}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
