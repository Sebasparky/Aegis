"use client";

import { useEffect, useState } from "react";
import type { ProtectedSession } from "@aegis/types";
import { listSessions } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-900 text-green-400",
  paused: "bg-yellow-900 text-yellow-400",
  waiting_for_approval: "bg-indigo-900 text-indigo-400",
  revoked: "bg-red-900 text-red-400",
  expired: "bg-gray-800 text-gray-500",
  closed: "bg-gray-800 text-gray-500",
  error: "bg-red-900 text-red-400",
};

export default function SessionsPage() {
  const [sessions, setSessions] = useState<ProtectedSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Sessions</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Protected browser sessions start when an agent requests web access through Antigen.
        </p>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading...</p>}

      {!loading && sessions.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-400">No active sessions.</p>
          <p className="text-xs text-gray-600 mt-1">
            Agents can request protected sessions using an Antigen Pass.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {sessions.map((session) => (
          <div key={session.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-white">{session.id}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[session.status] ?? "bg-gray-800 text-gray-400"}`}>
                    {session.status}
                  </span>
                </div>
                {session.current_url && (
                  <p className="text-xs text-gray-500">{session.current_url}</p>
                )}
                <p className="text-xs text-gray-600 mt-1">
                  Mode: {session.mode} · Expires {new Date(session.expires_at).toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
