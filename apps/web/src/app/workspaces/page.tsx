"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listWorkspaces, type WorkspaceWithCounts } from "@/lib/api";

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

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Workspaces</h1>
        <p className="mt-1 text-sm text-gray-400">
          Shared coordination environments where collar-bearing agents collaborate on tasks.
        </p>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && workspaces.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-400">No workspaces yet.</p>
          <p className="text-xs text-gray-600 mt-1">
            Run <code className="text-gray-500">npm run seed:demo</code> to load the Coordination Trial Workspace.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {workspaces.map((w) => (
          <div key={w.workspace_id} className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-white">{w.name}</span>
                  <StatusPill status={w.status} />
                </div>
                {w.description && (
                  <p className="text-xs text-gray-500 mb-3">{w.description}</p>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                  <span>
                    <span className="text-white font-medium">{w.task_counts.open + w.task_counts.in_progress}</span>
                    {" "}active tasks
                  </span>
                  <span>
                    <span className="text-white font-medium">{w.task_counts.completed}</span>
                    {" "}completed
                  </span>
                  <span>
                    <span className="text-white font-medium">{w.artifact_count}</span>
                    {" "}artifacts
                  </span>
                  <span>
                    <span className="text-white font-medium">{w.participant_delegation_ids.length}</span>
                    {" "}participants
                  </span>
                </div>
                <div className="mt-2 text-xs text-gray-600">
                  collar: <span className="text-gray-500">{w.collar_id}</span>
                </div>
              </div>
              <Link
                href={`/workspaces/${w.workspace_id}`}
                className="shrink-0 text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1.5 border border-gray-700 rounded-md transition-colors"
              >
                Open →
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-green-900 text-green-400"
      : "bg-gray-800 text-gray-500";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{status}</span>
  );
}
