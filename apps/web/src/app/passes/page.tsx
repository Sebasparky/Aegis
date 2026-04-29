"use client";

import { useEffect, useState } from "react";
import type { AegisPass, Collar } from "@aegis/types";
import { listPasses, listCollars, createPass, revokePass } from "@/lib/api";

export default function PassesPage() {
  const [passes, setPasses] = useState<AegisPass[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState<{ token: string; agent_name: string } | null>(null);

  // Form state
  const [agentName, setAgentName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [collarId, setCollarId] = useState("");
  const [expiresMin, setExpiresMin] = useState("120");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    const [p, c] = await Promise.all([listPasses(), listCollars()]);
    setPasses(p);
    const active = c.filter((c) => c.status === "active");
    setCollars(active);
    if (!collarId && active.length > 0) setCollarId(active[0].id);
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!agentName.trim()) { setFormError("Agent name is required."); return; }
    if (!collarId) { setFormError("Select a collar."); return; }
    setCreating(true);
    setFormError(null);
    try {
      const pass = await createPass({
        agent_name: agentName.trim(),
        purpose: purpose.trim() || undefined,
        default_collar_id: collarId,
        expires_in_minutes: Number(expiresMin) || 120,
      });
      setNewToken({ token: pass.token ?? "", agent_name: pass.agent_name });
      setAgentName("");
      setPurpose("");
      await load();
    } catch (e: any) {
      setFormError(e.message ?? "Failed to create pass.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this pass? The agent will lose access.")) return;
    try {
      await revokePass(id);
      await load();
    } catch {
      alert("Failed to revoke pass.");
    }
  }

  const activeCollars = collars.filter((c) => c.status === "active");

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Aegis Passes</h1>
        <p className="mt-1 text-gray-400 text-sm">
          Passes let outside agents request Aegis-controlled capabilities — without receiving your raw secrets.
        </p>
      </div>

      {/* Token reveal modal */}
      {newToken && (
        <div className="mb-6 bg-indigo-950 border border-indigo-700 rounded-lg p-5">
          <p className="text-sm font-medium text-indigo-300 mb-1">Pass created for &ldquo;{newToken.agent_name}&rdquo;</p>
          <p className="text-xs text-indigo-400 mb-3">Copy this token now — it will not be shown again.</p>
          <code className="block bg-gray-900 text-indigo-300 text-xs px-4 py-3 rounded-md break-all font-mono mb-3">
            {newToken.token}
          </code>
          <button
            onClick={() => setNewToken(null)}
            className="text-xs text-indigo-400 hover:text-indigo-300"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Pass list */}
        <div>
          <h2 className="text-sm font-medium text-gray-300 mb-3">Your Passes</h2>
          {loading && <p className="text-gray-500 text-sm">Loading...</p>}
          {!loading && passes.length === 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
              <p className="text-sm text-gray-500">No passes yet.</p>
              <p className="text-xs text-gray-600 mt-1">Create a pass to secure an outside agent.</p>
            </div>
          )}
          <div className="space-y-3">
            {passes.map((pass) => (
              <div key={pass.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">{pass.agent_name}</p>
                    {pass.purpose && <p className="text-xs text-gray-500 mt-0.5">{pass.purpose}</p>}
                    <div className="flex gap-3 mt-2 text-xs text-gray-500">
                      <StatusBadge status={pass.status} />
                      <span>Expires {new Date(pass.expires_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {pass.status === "active" && (
                    <button
                      onClick={() => handleRevoke(pass.id)}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 border border-gray-700 rounded-md shrink-0 transition-colors"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Create pass form */}
        <div>
          <h2 className="text-sm font-medium text-gray-300 mb-3">Create Pass</h2>
          <form onSubmit={handleCreate} className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Agent Name *</label>
              <input
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="e.g. Shopping Agent"
                className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Task Purpose</label>
              <input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. Find running shoes under $100"
                className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Collar *</label>
              {activeCollars.length === 0 ? (
                <p className="text-xs text-yellow-500">
                  No active collars.{" "}
                  <a href="/collars/new" className="underline">Create one first.</a>
                </p>
              ) : (
                <select
                  value={collarId}
                  onChange={(e) => setCollarId(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  {activeCollars.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Expires in (minutes)</label>
              <input
                type="number"
                min="1"
                value={expiresMin}
                onChange={(e) => setExpiresMin(e.target.value)}
                className="w-24 bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            {formError && <p className="text-red-400 text-xs">{formError}</p>}
            <button
              type="submit"
              disabled={creating || activeCollars.length === 0}
              className="w-full bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm py-2 rounded-md transition-colors"
            >
              {creating ? "Creating…" : "Create Pass"}
            </button>
          </form>
          <p className="text-xs text-gray-600 mt-2">
            This pass does not contain your passwords, cards, or identity. It only lets the agent request controlled capabilities from Aegis.
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-900 text-green-400",
    revoked: "bg-red-900 text-red-400",
    expired: "bg-gray-800 text-gray-500",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colors[status] ?? "bg-gray-800 text-gray-400"}`}>
      {status}
    </span>
  );
}
