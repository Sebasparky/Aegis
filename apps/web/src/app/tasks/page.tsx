"use client";

import { useState, useEffect } from "react";
import type { AgentTask, Collar } from "@aegis/types";
import {
  listTasks,
  createTask,
  cancelTask,
  createTaskSession,
  listCollars,
} from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  ready: "bg-indigo-500/20 text-indigo-300",
  in_progress: "bg-yellow-500/20 text-yellow-300",
  waiting_for_approval: "bg-orange-500/20 text-orange-300",
  completed: "bg-green-500/20 text-green-300",
  failed: "bg-red-500/20 text-red-300",
  canceled: "bg-gray-500/20 text-gray-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[status] ?? "bg-gray-700 text-gray-300"}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ConstraintsSummary({ c }: { c: AgentTask["constraints"] }) {
  return (
    <div className="text-xs text-gray-400 space-y-0.5">
      <div>Max purchase: ${c.max_purchase_amount}</div>
      <div>Subscriptions: {c.subscriptions_allowed ? "allowed" : "blocked"}</div>
      <div>Purchase approval: {c.purchase_requires_approval ? "required" : "not required"}</div>
      <div>Identity disclosure: {c.identity_disclosure_blocked ? "blocked" : "allowed"}</div>
    </div>
  );
}

interface CreateResult {
  task: AgentTask;
  launch_token: string;
}

interface SessionResult {
  task_id: string;
  session_id: string;
  start_url: string;
  collar_id: string;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startUrl, setStartUrl] = useState("http://localhost:3001/checkout.html");
  const [collarId, setCollarId] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Post-create state (token lives here only; gone on refresh)
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);
  const [sessionResult, setSessionResult] = useState<SessionResult | null>(null);
  const [launchingSession, setLaunchingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  async function load() {
    try {
      const [t, c] = await Promise.all([listTasks(), listCollars()]);
      setTasks(t);
      setCollars(c.filter((col) => col.status === "active"));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!title.trim()) {
      setFormError("Title is required.");
      return;
    }
    if (!startUrl.trim()) {
      setFormError("Start URL is required.");
      return;
    }
    setCreating(true);
    try {
      const result = await createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        start_url: startUrl.trim(),
        collar_id: collarId || undefined,
      });
      setCreateResult(result);
      setSessionResult(null);
      setSessionError(null);
      setTitle("");
      setDescription("");
      setStartUrl("http://localhost:3001/checkout.html");
      setCollarId("");
      await load();
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleCancel(taskId: string) {
    if (!confirm("Cancel this task? Its pass will be revoked.")) return;
    try {
      await cancelTask(taskId);
      await load();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleCreateSession() {
    if (!createResult) return;
    setLaunchingSession(true);
    setSessionError(null);
    try {
      const result = await createTaskSession(
        createResult.task.id,
        createResult.launch_token,
        "headless"
      );
      setSessionResult(result);
      await load();
    } catch (e: any) {
      setSessionError(e.message);
    } finally {
      setLaunchingSession(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Agent Tasks</h1>
        <p className="text-sm text-gray-400 mt-1">
          Create a scoped task package for an outside agent. Bundles a start URL,
          collar policy, and a one-time pass token.
        </p>
      </div>

      {/* Create form */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
        <h2 className="text-base font-medium text-white">Create Task</h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Title *</label>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              placeholder="Buy running shoes"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description</label>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              placeholder="Optional description for the agent"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Start URL *</label>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Collar{" "}
              <span className="text-gray-500">(leave blank to use most recent active collar)</span>
            </label>
            <select
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              value={collarId}
              onChange={(e) => setCollarId(e.target.value)}
            >
              <option value="">— auto-select active collar —</option>
              {collars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {formError && (
            <p className="text-sm text-red-400">{formError}</p>
          )}
          <button
            type="submit"
            disabled={creating}
            className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
          >
            {creating ? "Creating…" : "Create Task"}
          </button>
        </form>
      </div>

      {/* Post-create result */}
      {createResult && (
        <div className="bg-gray-900 border border-yellow-700 rounded-lg p-6 space-y-4">
          <h2 className="text-base font-medium text-white">Task Created</h2>

          {/* Launch token — shown once */}
          <div className="bg-gray-800 border border-yellow-600 rounded p-4 space-y-2">
            <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide">
              Launch Token — shown once only
            </p>
            <p className="text-xs text-yellow-200">
              Treat this like a password. Copy it now — it will not be shown again after
              you leave or refresh this page.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-gray-950 text-green-300 px-3 py-2 rounded font-mono break-all">
                {createResult.launch_token}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(createResult.launch_token)}
                className="text-xs text-gray-400 hover:text-white border border-gray-700 px-2 py-1 rounded transition-colors shrink-0"
              >
                Copy
              </button>
            </div>
          </div>

          {/* Task details */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
            <div>
              <span className="text-gray-500">Task ID</span>
              <p className="text-gray-200 font-mono">{createResult.task.id}</p>
            </div>
            <div>
              <span className="text-gray-500">Status</span>
              <p className="mt-0.5">
                <StatusBadge status={createResult.task.status} />
              </p>
            </div>
            <div>
              <span className="text-gray-500">Start URL</span>
              <p className="text-gray-200 break-all">{createResult.task.start_url}</p>
            </div>
            <div>
              <span className="text-gray-500">Domain</span>
              <p className="text-gray-200">{createResult.task.start_domain}</p>
            </div>
            {createResult.task.website_aegis_id && (
              <div>
                <span className="text-gray-500">Website AntigenID</span>
                <p className="text-gray-200 font-mono">{createResult.task.website_aegis_id}</p>
              </div>
            )}
            <div>
              <span className="text-gray-500">Collar</span>
              <p className="text-gray-200 font-mono">{createResult.task.collar_id}</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-2">Constraints</p>
            <ConstraintsSummary c={createResult.task.constraints} />
          </div>

          {/* Create session (only while token is in memory) */}
          {!sessionResult && (
            <div className="pt-2 border-t border-gray-800">
              <p className="text-xs text-gray-400 mb-2">
                You can launch a browser session now using the token above. After
                leaving this page the token is gone and you must create a new task.
              </p>
              {sessionError && (
                <p className="text-xs text-red-400 mb-2">{sessionError}</p>
              )}
              <button
                onClick={handleCreateSession}
                disabled={launchingSession}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
              >
                {launchingSession ? "Launching…" : "Create Session"}
              </button>
            </div>
          )}

          {sessionResult && (
            <div className="pt-2 border-t border-gray-800 space-y-1">
              <p className="text-xs font-semibold text-green-400">Session launched</p>
              <p className="text-xs text-gray-400">
                Session ID:{" "}
                <span className="font-mono text-gray-200">{sessionResult.session_id}</span>
              </p>
              <p className="text-xs text-gray-400">
                Navigate the session to:{" "}
                <span className="text-gray-200">{sessionResult.start_url}</span>
              </p>
            </div>
          )}
        </div>
      )}

      {/* Task list */}
      <div>
        <h2 className="text-base font-medium text-white mb-3">Existing Tasks</h2>
        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!loading && tasks.length === 0 && (
          <p className="text-sm text-gray-500">No tasks yet. Create one above.</p>
        )}
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">{task.title}</p>
                  {task.description && (
                    <p className="text-xs text-gray-400 mt-0.5">{task.description}</p>
                  )}
                </div>
                <StatusBadge status={task.status} />
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <div>
                  <span className="text-gray-500">Domain</span>
                  <p className="text-gray-300">{task.start_domain}</p>
                </div>
                {task.website_aegis_id && (
                  <div>
                    <span className="text-gray-500">Website AntigenID</span>
                    <p className="text-gray-300 font-mono">{task.website_aegis_id}</p>
                  </div>
                )}
                <div>
                  <span className="text-gray-500">Created</span>
                  <p className="text-gray-300">
                    {new Date(task.created_at).toLocaleString()}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Pass ID</span>
                  <p className="text-gray-300 font-mono">{task.pass_id}</p>
                </div>
              </div>
              <details className="text-xs">
                <summary className="text-gray-500 cursor-pointer hover:text-gray-300">
                  Constraints
                </summary>
                <div className="mt-2">
                  <ConstraintsSummary c={task.constraints} />
                </div>
              </details>
              {task.status === "ready" && (
                <button
                  onClick={() => handleCancel(task.id)}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Cancel task
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
