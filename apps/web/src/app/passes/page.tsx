"use client";

import { useEffect, useState } from "react";
import type { AegisPass, Collar } from "@aegis/types";
import {
  listPasses, listCollars, createPass, revokePass,
  listVaultPasses, createVaultPass, deleteVaultPass,
  listRoutePassBindings, setRoutePassBinding, clearRoutePassBinding,
} from "@/lib/api";
import type { VaultPassView, RoutePassBinding } from "@/lib/api";
import type { AegisRoute } from "@aegis/types";
import { listRoutes } from "@/lib/api";

export default function PassesPage() {
  const [passes, setPasses] = useState<AegisPass[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState<{ token: string; agent_name: string } | null>(null);

  // Agent pass form state
  const [agentName, setAgentName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [collarId, setCollarId] = useState("");
  const [expiresMin, setExpiresMin] = useState("120");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Vault pass state
  const [vaultPasses, setVaultPasses] = useState<VaultPassView[]>([]);
  const [vaultLabel, setVaultLabel] = useState("");
  const [vaultDomain, setVaultDomain] = useState("");
  const [vaultUsername, setVaultUsername] = useState("");
  const [vaultPassword, setVaultPassword] = useState("");
  const [creatingVault, setCreatingVault] = useState(false);
  const [vaultFormError, setVaultFormError] = useState<string | null>(null);
  const [vaultCreated, setVaultCreated] = useState(false);

  // Route-to-pass binding state
  const [controlledRoutes, setControlledRoutes] = useState<AegisRoute[]>([]);
  const [bindings, setBindings] = useState<RoutePassBinding[]>([]);
  // Map of route_id → selected pass_id in the UI (before saving)
  const [bindingDraft, setBindingDraft] = useState<Record<string, string>>({});
  const [savingBinding, setSavingBinding] = useState<Record<string, boolean>>({});
  const [bindingMsg, setBindingMsg] = useState<Record<string, string>>({});

  async function load() {
    const [p, c, vp, allRoutes, existingBindings] = await Promise.all([
      listPasses(), listCollars(), listVaultPasses(),
      listRoutes(), listRoutePassBindings(),
    ]);
    setPasses(p);
    const active = c.filter((c) => c.status === "active");
    setCollars(active);
    if (!collarId && active.length > 0) setCollarId(active[0].id);
    setVaultPasses(vp);

    // Only show aegis_controlled routes that have required_permissions (need credentials)
    const controlled = allRoutes.filter((r) => r.execution_mode === "aegis_controlled");
    setControlledRoutes(controlled);
    setBindings(existingBindings);

    // Initialise draft to current saved binding (or empty string = default)
    setBindingDraft((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const r of controlled) {
        if (next[r.route_id] === undefined) {
          const existing = existingBindings.find((b) => b.route_id === r.route_id);
          next[r.route_id] = existing?.pass_id ?? "";
        }
      }
      return next;
    });
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

  async function handleCreateVaultPass(e: React.FormEvent) {
    e.preventDefault();
    if (!vaultLabel.trim()) { setVaultFormError("Label is required."); return; }
    if (!vaultDomain.trim()) { setVaultFormError("Domain is required."); return; }
    if (!vaultUsername.trim()) { setVaultFormError("Username is required."); return; }
    if (!vaultPassword) { setVaultFormError("Password is required."); return; }
    setCreatingVault(true);
    setVaultFormError(null);
    setVaultCreated(false);
    try {
      await createVaultPass({
        label: vaultLabel.trim(),
        kind: "login_password",
        domain: vaultDomain.trim(),
        username: vaultUsername.trim(),
        password: vaultPassword,
      });
      setVaultLabel("");
      setVaultDomain("");
      setVaultUsername("");
      setVaultPassword(""); // clear immediately — never store in state after submit
      setVaultCreated(true);
      await load();
    } catch (e: any) {
      setVaultFormError(e.message ?? "Failed to create vault pass.");
    } finally {
      setCreatingVault(false);
    }
  }

  async function handleDeleteVaultPass(passId: string, label: string) {
    if (!confirm(`Delete vault pass "${label}"? This cannot be undone.`)) return;
    try {
      await deleteVaultPass(passId);
      await load();
    } catch {
      alert("Failed to delete vault pass.");
    }
  }

  async function handleSaveBinding(routeId: string) {
    const passId = bindingDraft[routeId];
    setSavingBinding((s) => ({ ...s, [routeId]: true }));
    setBindingMsg((m) => ({ ...m, [routeId]: "" }));
    try {
      if (!passId) {
        await clearRoutePassBinding(routeId);
        setBindingMsg((m) => ({ ...m, [routeId]: "Binding cleared — using route default." }));
      } else {
        await setRoutePassBinding({ route_id: routeId, pass_id: passId });
        setBindingMsg((m) => ({ ...m, [routeId]: "Binding saved." }));
      }
      await load();
    } catch (e: any) {
      setBindingMsg((m) => ({ ...m, [routeId]: e.message ?? "Failed to save binding." }));
    } finally {
      setSavingBinding((s) => ({ ...s, [routeId]: false }));
    }
  }

  const activeCollars = collars.filter((c) => c.status === "active");

  return (
    <div className="max-w-4xl space-y-10">

      {/* ── Agent Passes ───────────────────────────────────────────────────── */}
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-white">Aegis Passes</h1>
          <p className="mt-1 text-gray-400 text-sm">
            Passes let outside agents request Aegis-controlled capabilities — without receiving your raw secrets.
          </p>
        </div>

        {newToken && (
          <div className="mb-6 bg-indigo-950 border border-indigo-700 rounded-lg p-5">
            <p className="text-sm font-medium text-indigo-300 mb-1">Pass created for &ldquo;{newToken.agent_name}&rdquo;</p>
            <p className="text-xs text-indigo-400 mb-3">Copy this token now — it will not be shown again.</p>
            <code className="block bg-gray-900 text-indigo-300 text-xs px-4 py-3 rounded-md break-all font-mono mb-3">
              {newToken.token}
            </code>
            <button onClick={() => setNewToken(null)} className="text-xs text-indigo-400 hover:text-indigo-300">
              Dismiss
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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

      {/* ── Credential Assignments ────────────────────────────────────────── */}
      {controlledRoutes.length > 0 && (
        <div>
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-white">Credential Assignments</h2>
            <p className="mt-1 text-gray-400 text-sm">
              Choose which stored credential each Aegis-controlled skill uses at execution time.
              Overrides the route default — the agent never sees the password.
            </p>
          </div>
          <div className="space-y-4">
            {controlledRoutes.map((route) => {
              const domainPasses = vaultPasses.filter(
                (vp) => vp.domain === route.domain && vp.kind === "login_password"
              );
              const currentBinding = bindings.find((b) => b.route_id === route.route_id);
              const currentPass = currentBinding
                ? vaultPasses.find((vp) => vp.pass_id === currentBinding.pass_id)
                : null;
              const draft = bindingDraft[route.route_id] ?? "";
              const isDirty = draft !== (currentBinding?.pass_id ?? "");
              const msg = bindingMsg[route.route_id];

              return (
                <div key={route.route_id} className="bg-gray-900 border border-gray-800 rounded-lg p-5">
                  <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">{route.workflow_name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{route.domain} · {route.execution_mode}</p>

                      {/* Current binding summary */}
                      <div className="mt-2 text-xs text-gray-500">
                        {currentPass ? (
                          <span>
                            Current:{" "}
                            <span className="text-gray-300">{currentPass.label}</span>
                            {" · "}
                            <span className="font-mono">{currentPass.username}</span>
                            {" · "}
                            <span className="text-gray-600 font-mono text-xs">{currentPass.pass_id}</span>
                          </span>
                        ) : (
                          <span className="text-gray-600">Using route default pass</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {domainPasses.length === 0 ? (
                        <p className="text-xs text-yellow-500">No {route.domain} login passes yet.</p>
                      ) : (
                        <>
                          <select
                            value={draft}
                            onChange={(e) =>
                              setBindingDraft((d) => ({ ...d, [route.route_id]: e.target.value }))
                            }
                            className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                          >
                            <option value="">— route default —</option>
                            {domainPasses.map((vp) => (
                              <option key={vp.pass_id} value={vp.pass_id}>
                                {vp.label} ({vp.username})
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleSaveBinding(route.route_id)}
                            disabled={!isDirty || savingBinding[route.route_id]}
                            className="px-3 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white rounded-md transition-colors"
                          >
                            {savingBinding[route.route_id] ? "Saving…" : "Save"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {msg && (
                    <p className={`mt-2 text-xs ${msg.startsWith("Failed") || msg.includes("mismatch") ? "text-red-400" : "text-green-400"}`}>
                      {msg}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Credential Vault ───────────────────────────────────────────────── */}
      <div>
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-white">Credential Vault</h2>
          <p className="mt-1 text-gray-400 text-sm">
            Store login credentials here. Agents never see passwords — Aegis resolves them only during approved, controlled execution.
          </p>
        </div>

        {/* Dev-only warning */}
        <div className="mb-5 bg-yellow-950 border border-yellow-700 rounded-lg px-4 py-3">
          <p className="text-xs text-yellow-300 font-medium">Dev/MVP local KMS vault</p>
          <p className="text-xs text-yellow-500 mt-0.5">
            Dev/MVP vault uses encrypted secret storage through a temporary local KMS provider. This is designed to be swapped for cloud KMS later.
            Do not store production credentials until cloud KMS and auth are configured.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Vault pass list */}
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Stored Credentials</h3>
            {loading && <p className="text-gray-500 text-sm">Loading...</p>}
            {!loading && vaultPasses.length === 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
                <p className="text-sm text-gray-500">No credentials stored yet.</p>
                <p className="text-xs text-gray-600 mt-1">Add a login credential to use with controlled skills.</p>
              </div>
            )}
            <div className="space-y-3">
              {vaultPasses.map((vp) => (
                <div key={vp.pass_id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-white truncate">{vp.label}</p>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 shrink-0">
                          {vp.kind}
                        </span>
                        {vp.pass_id === "pass_vault_demo_login_001" && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-900 text-indigo-400 shrink-0">
                            seeded demo
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{vp.domain}</p>
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-gray-600 w-16 shrink-0">Username</span>
                          <span className="text-gray-300 font-mono">{vp.username ?? "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-gray-600 w-16 shrink-0">Password</span>
                          <span className="text-gray-400 font-mono tracking-widest">
                            {vp.has_password ? "••••••••" : <span className="text-red-400 tracking-normal">missing (run seed:demo?)</span>}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-gray-700 mt-2 font-mono">{vp.pass_id}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteVaultPass(vp.pass_id, vp.label)}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 border border-gray-700 rounded-md shrink-0 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Create vault pass form */}
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Add Login Credential</h3>
            <form onSubmit={handleCreateVaultPass} className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Label *</label>
                <input
                  value={vaultLabel}
                  onChange={(e) => setVaultLabel(e.target.value)}
                  placeholder="e.g. Demo Store Login"
                  className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Domain *</label>
                <input
                  value={vaultDomain}
                  onChange={(e) => setVaultDomain(e.target.value)}
                  placeholder="e.g. localhost"
                  className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Username *</label>
                <input
                  value={vaultUsername}
                  onChange={(e) => setVaultUsername(e.target.value)}
                  placeholder="e.g. demo_user"
                  autoComplete="username"
                  className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Password *</label>
                <input
                  type="password"
                  value={vaultPassword}
                  onChange={(e) => setVaultPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="new-password"
                  className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Kind</label>
                <input
                  value="login_password"
                  readOnly
                  className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-500 cursor-not-allowed"
                />
              </div>
              {vaultFormError && <p className="text-red-400 text-xs">{vaultFormError}</p>}
              {vaultCreated && (
                <p className="text-green-400 text-xs">Credential stored. Password will not be shown again.</p>
              )}
              <button
                type="submit"
                disabled={creatingVault}
                className="w-full bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm py-2 rounded-md transition-colors"
              >
                {creatingVault ? "Storing…" : "Store Credential"}
              </button>
            </form>
            <p className="text-xs text-gray-600 mt-2">
              Password is stored in the dev vault and never returned after creation. Agents resolve it only during approved Aegis-controlled execution.
            </p>
          </div>
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
