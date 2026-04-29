"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Collar } from "@aegis/types";
import { listCollars, revokeCollar } from "@/lib/api";

export default function CollarsPage() {
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setCollars(await listCollars());
    } catch (e) {
      setError("Could not load collars.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this collar? Passes using it will stop working.")) return;
    try {
      await revokeCollar(id);
      await load();
    } catch {
      alert("Failed to revoke collar.");
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Collars</h1>
          <p className="mt-1 text-gray-400 text-sm">Define what agents can do, what requires approval, and what is never allowed.</p>
        </div>
        <Link
          href="/collars/new"
          className="text-xs bg-indigo-500 hover:bg-indigo-400 text-white px-4 py-2 rounded-md transition-colors"
        >
          New Collar
        </Link>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading...</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!loading && collars.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-gray-400">No collars yet.</p>
          <p className="text-xs text-gray-600 mt-1">Create a collar to define an agent&apos;s permissions.</p>
          <Link href="/collars/new" className="mt-4 inline-block text-xs bg-indigo-500 hover:bg-indigo-400 text-white px-4 py-2 rounded-md transition-colors">
            Create Collar
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {collars.map((collar) => (
          <div key={collar.id} className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-white">{collar.name}</span>
                  <StatusBadge status={collar.status} />
                </div>
                {collar.purpose && (
                  <p className="text-xs text-gray-500 mb-3">{collar.purpose}</p>
                )}
                <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                  <span>{collar.allowed_actions.length} allowed</span>
                  <span>{collar.approval_required_actions.length} require approval</span>
                  <span>{collar.blocked_actions.length} blocked</span>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Link
                  href={`/collars/${collar.id}`}
                  className="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1.5 border border-gray-700 rounded-md transition-colors"
                >
                  Edit
                </Link>
                {collar.status === "active" && (
                  <button
                    onClick={() => handleRevoke(collar.id)}
                    className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 border border-gray-700 rounded-md transition-colors"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-900 text-green-400",
    revoked: "bg-red-900 text-red-400",
    archived: "bg-gray-800 text-gray-500",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colors[status] ?? "bg-gray-800 text-gray-400"}`}>
      {status}
    </span>
  );
}
