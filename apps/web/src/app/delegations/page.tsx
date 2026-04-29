"use client";

import { useEffect, useState } from "react";
import type { AgentDelegation, Collar } from "@aegis/types";
import {
  listDelegations,
  createDelegation,
  revokeDelegation,
  listCollars,
} from "../../lib/api";

const STATUS_COLORS: Record<string, string> = {
  active: "text-green-400 bg-green-950 border-green-900",
  revoked: "text-red-400 bg-red-950 border-red-900",
  expired: "text-gray-400 bg-gray-800 border-gray-700",
};

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="relative">
      <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
        {code}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

export default function DelegationsPage() {
  const [delegations, setDelegations] = useState<AgentDelegation[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);

  const [agentName, setAgentName] = useState("OpenClaw Shopping Agent");
  const [agentPlatform, setAgentPlatform] = useState("OpenClaw");
  const [channel, setChannel] = useState<"slack" | "discord" | "api" | "other">("slack");
  const [collarId, setCollarId] = useState("");
  const [expiresIn, setExpiresIn] = useState(10080);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [shownToken, setShownToken] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listDelegations(), listCollars()])
      .then(([dels, cols]) => {
        setDelegations(dels);
        setCollars(cols);
        if (cols.length > 0) setCollarId(cols[0].id);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    setShownToken(null);
    try {
      const result = await createDelegation({
        agent_name: agentName,
        agent_platform: agentPlatform || undefined,
        channel,
        default_collar_id: collarId || undefined,
        expires_in_minutes: expiresIn,
      });
      setShownToken(result.delegation_token);
      setDelegations((prev) => [result.delegation, ...prev]);
    } catch (err: any) {
      setCreateError(err.message ?? "Failed to create delegation.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(delegationId: string) {
    setRevokeError(null);
    try {
      await revokeDelegation(delegationId);
      setDelegations((prev) =>
        prev.map((d) =>
          d.id === delegationId ? { ...d, status: "revoked" as const, updated_at: new Date().toISOString() } : d
        )
      );
    } catch (err: any) {
      setRevokeError(err.message ?? "Failed to revoke delegation.");
    }
  }

  return (
    <div className="max-w-3xl space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Agent Delegations</h1>
        <p className="mt-2 text-gray-400 text-sm leading-relaxed">
          Create a reusable Aegis delegation for an outside agent like OpenClaw. The user keeps
          texting the agent normally through Slack or another channel; the agent uses Aegis as its
          protected browser runtime — browsing freely, pausing at every sensitive action, and never
          holding your secrets.
        </p>
        <div className="mt-3 flex gap-3 text-xs text-gray-500">
          <span className="text-green-400">Agent gets a reusable token.</span>
          <span className="text-gray-600">·</span>
          <span className="text-amber-400">Aegis enforces collars on every action.</span>
          <span className="text-gray-600">·</span>
          <span className="text-red-400">Revoke anytime to cut off access.</span>
        </div>
      </div>

      {/* One-time token display */}
      {shownToken && (
        <div className="bg-amber-950 border border-amber-800 rounded-lg p-5 space-y-4">
          <p className="text-sm font-semibold text-amber-300">
            Delegation token — shown once only
          </p>
          <p className="text-xs text-amber-200 leading-relaxed">
            Copy this token now. It will not be shown again.
          </p>
          <CopyBlock code={shownToken} />
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-400 space-y-1">
            <p className="text-gray-300 font-medium mb-2">How to use this token</p>
            <p>
              Give this token to your agent runtime as{" "}
              <code className="font-mono text-amber-300">AEGIS_PASS_TOKEN</code>. The agent
              uses it to call <code className="font-mono text-gray-300">aegis_create_session</code>{" "}
              (or <code className="font-mono text-gray-300">POST /api/agent/create-session</code>)
              before every task. No start URL required — the agent chooses where to go.
            </p>
            <p className="pt-1">
              Configure the agent to use the Aegis MCP server for all browser actions. See{" "}
              <span className="text-indigo-400">/agent-bridge</span> for the system prompt and
              tool list.
            </p>
          </div>
          <button
            onClick={() => setShownToken(null)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            I've copied it — dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <section>
        <h2 className="text-base font-semibold text-white mb-4">Create Delegation</h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Agent Name</label>
              <input
                className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Agent Platform</label>
              <input
                className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                value={agentPlatform}
                onChange={(e) => setAgentPlatform(e.target.value)}
                placeholder="OpenClaw"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Channel</label>
              <select
                className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                value={channel}
                onChange={(e) => setChannel(e.target.value as typeof channel)}
              >
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="api">API</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Collar</label>
              <select
                className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                value={collarId}
                onChange={(e) => setCollarId(e.target.value)}
              >
                {collars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Expires in (minutes) — default 10080 = 1 week
            </label>
            <input
              type="number"
              min={1}
              className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              value={expiresIn}
              onChange={(e) => setExpiresIn(Number(e.target.value))}
            />
          </div>

          {createError && (
            <p className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">
              {createError}
            </p>
          )}

          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-md transition-colors"
          >
            {creating ? "Creating…" : "Create Delegation"}
          </button>
        </form>
      </section>

      {/* Delegations list */}
      <section>
        <h2 className="text-base font-semibold text-white mb-4">Delegations</h2>
        {revokeError && (
          <div className="mb-3 text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">
            Revoke failed: {revokeError}
          </div>
        )}
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : delegations.length === 0 ? (
          <p className="text-gray-600 text-sm">No delegations yet.</p>
        ) : (
          <div className="space-y-3">
            {delegations.map((d) => {
              const collar = collars.find((c) => c.id === d.default_collar_id);
              return (
                <div
                  key={d.id}
                  className="bg-gray-900 border border-gray-800 rounded-lg p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white truncate">
                          {d.agent_name}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded border font-mono ${STATUS_COLORS[d.status] ?? STATUS_COLORS.expired}`}
                        >
                          {d.status}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
                        {d.agent_platform && (
                          <span>
                            Platform:{" "}
                            <span className="text-gray-400">{d.agent_platform}</span>
                          </span>
                        )}
                        <span>
                          Channel:{" "}
                          <span className="text-gray-400">{d.channel}</span>
                        </span>
                        <span>
                          Collar:{" "}
                          <span className="text-gray-400">{collar?.name ?? d.default_collar_id}</span>
                        </span>
                        <span>
                          Created:{" "}
                          <span className="text-gray-400">
                            {new Date(d.created_at).toLocaleString()}
                          </span>
                        </span>
                        {d.expires_at && (
                          <span>
                            Expires:{" "}
                            <span className="text-gray-400">
                              {new Date(d.expires_at).toLocaleString()}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                    {d.status === "active" && (
                      <button
                        onClick={() => handleRevoke(d.id)}
                        className="shrink-0 text-xs px-3 py-1.5 rounded-md border border-red-800 text-red-400 hover:bg-red-950 transition-colors"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
