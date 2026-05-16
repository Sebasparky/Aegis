"use client";

import { useEffect, useState } from "react";
import type { RunnerTask } from "@aegis/types";
import { listRunners } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-900 text-green-400",
  running: "bg-indigo-900 text-indigo-400",
  pending: "bg-gray-800 text-gray-400",
  failed: "bg-red-900 text-red-400",
  expired: "bg-gray-800 text-gray-500",
  canceled: "bg-gray-800 text-gray-500",
};

const TASK_TYPE_LABELS: Record<string, string> = {
  complete_approved_purchase: "Approved Purchase",
  complete_approved_sensitive_action: "Approved Sensitive Action",
};

export default function RunnersPage() {
  const [runners, setRunners] = useState<RunnerTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listRunners()
      .then(setRunners)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Antigen Runners</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Runners complete approved sensitive steps so your agent never holds raw secrets.
        </p>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading...</p>}

      {!loading && runners.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-400">No runner tasks yet.</p>
          <p className="text-xs text-gray-600 mt-1">
            Runners are created automatically when you approve a sensitive action.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {runners.map((task) => (
          <div key={task.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-white">
                  {TASK_TYPE_LABELS[task.task_type] ?? task.task_type}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[task.status] ?? "bg-gray-800 text-gray-400"}`}
                >
                  {task.status}
                </span>
              </div>
              <time className="text-xs text-gray-600 shrink-0">
                {new Date(task.created_at).toLocaleString()}
              </time>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
              {task.domain && (
                <div>
                  <span className="text-gray-600">Domain: </span>
                  <span className="text-gray-400">{task.domain}</span>
                </div>
              )}
              <div className="col-span-2 font-mono">
                <span className="text-gray-600">Session: </span>
                <span className="text-gray-500">{task.session_id}</span>
              </div>
              {task.completed_at && (
                <div>
                  <span className="text-gray-600">Completed: </span>
                  <span className="text-gray-400">{new Date(task.completed_at).toLocaleTimeString()}</span>
                </div>
              )}
            </div>

            {task.constraints?.mock_vault_used === true && (
              <div className="flex items-center gap-3 text-xs mb-2">
                <span className="text-indigo-400 bg-indigo-950 border border-indigo-900 rounded px-2 py-0.5">
                  Mock vault used: yes
                </span>
                {typeof task.constraints.fields_filled_count === "number" && (
                  <span className="text-gray-500">
                    {task.constraints.fields_filled_count} fields filled
                  </span>
                )}
                <span className="text-green-500">sensitive data shared: no</span>
              </div>
            )}

            {task.result && (
              <p className="text-xs text-green-400 bg-green-950 border border-green-900 rounded px-3 py-2">
                {task.result}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
