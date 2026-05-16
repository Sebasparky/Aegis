"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AegisPass, Collar } from "@aegis/types";
import {
  listPasses, listCollars, createPass, revokePass,
  listVaultPasses, createVaultPass, deleteVaultPass,
  listRoutePassBindings, setRoutePassBinding, clearRoutePassBinding,
} from "@/lib/api";
import type { VaultPassView, RoutePassBinding } from "@/lib/api";
import { findCredentialProviderByDomain } from "@/lib/credentialProviders";
import type { AegisRoute } from "@aegis/types";
import { listRoutes } from "@/lib/api";

function LockSVG() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function statusClass(status: string): string {
  if (status === "active")  return "green";
  if (status === "revoked") return "red";
  return "graphite";
}

type Tab = "vault" | "seal" | "assignments";

export default function PassesPage() {
  const [passes, setPasses]   = useState<AegisPass[]>([]);
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState<{ token: string; agent_name: string } | null>(null);
  const [tab, setTab] = useState<Tab>("vault");

  // Agent pass form state
  const [agentName,   setAgentName]   = useState("");
  const [purpose,     setPurpose]     = useState("");
  const [collarId,    setCollarId]    = useState("");
  const [expiresMin,  setExpiresMin]  = useState("120");
  const [creating,    setCreating]    = useState(false);
  const [formError,   setFormError]   = useState<string | null>(null);

  // Vault pass state
  const [vaultPasses,    setVaultPasses]    = useState<VaultPassView[]>([]);
  const [vaultLabel,     setVaultLabel]     = useState("");
  const [vaultDomain,    setVaultDomain]    = useState("");
  const [vaultUsername,  setVaultUsername]  = useState("");
  const [vaultPassword,  setVaultPassword]  = useState("");
  const [creatingVault,  setCreatingVault]  = useState(false);
  const [vaultFormError, setVaultFormError] = useState<string | null>(null);
  const [vaultCreated,   setVaultCreated]   = useState(false);

  // Route-to-pass binding state
  const [controlledRoutes, setControlledRoutes] = useState<AegisRoute[]>([]);
  const [bindings,         setBindings]         = useState<RoutePassBinding[]>([]);
  const [bindingDraft,     setBindingDraft]     = useState<Record<string, string>>({});
  const [savingBinding,    setSavingBinding]    = useState<Record<string, boolean>>({});
  const [bindingMsg,       setBindingMsg]       = useState<Record<string, string>>({});

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
    const controlled = allRoutes.filter((r) => r.execution_mode === "aegis_controlled");
    setControlledRoutes(controlled);
    setBindings(existingBindings);
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

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!agentName.trim()) { setFormError("Agent name is required."); return; }
    if (!collarId)         { setFormError("Select a collar."); return; }
    setCreating(true);
    setFormError(null);
    try {
      const pass = await createPass({
        agent_name:           agentName.trim(),
        purpose:              purpose.trim() || undefined,
        default_collar_id:    collarId,
        expires_in_minutes:   Number(expiresMin) || 120,
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
    if (!vaultLabel.trim())    { setVaultFormError("Label is required.");    return; }
    if (!vaultDomain.trim())   { setVaultFormError("Domain is required.");   return; }
    if (!vaultUsername.trim()) { setVaultFormError("Username is required."); return; }
    if (!vaultPassword)        { setVaultFormError("Password is required."); return; }
    setCreatingVault(true);
    setVaultFormError(null);
    setVaultCreated(false);
    try {
      await createVaultPass({
        label:    vaultLabel.trim(),
        kind:     "login_password",
        domain:   vaultDomain.trim(),
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
    if (!confirm(`Delete vault entry "${label}"? This cannot be undone.`)) return;
    try {
      await deleteVaultPass(passId);
      await load();
    } catch {
      alert("Failed to delete vault entry.");
    }
  }

  async function handleSaveBinding(routeId: string) {
    const passId = bindingDraft[routeId];
    setSavingBinding((s) => ({ ...s, [routeId]: true }));
    setBindingMsg((m)    => ({ ...m, [routeId]: "" }));
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
  const activePasses  = passes.filter((p) => p.status === "active");

  return (
    <div className="page">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24 }}>
            <div>
              <div className="a-eyebrow">Secrets</div>
              <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
                Secrets,{" "}
                <span className="cmd-hero__title-mark">sealed.</span>
              </h1>
              <p className="cmd-hero__sub" style={{ textAlign: "left", fontSize: 13.5, margin: 0 }}>
                Store credentials once. Antigen releases scoped capability — never raw secrets — to agents operating under approved collars.
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end", flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setTab("seal")}
                className="a-btn a-btn--primary"
              >
                + Seal secret
              </button>
              <Link href="/vault-import" style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}>
                Import from CSV →
              </Link>
            </div>
          </div>

          {/* Stat counters */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1px 1fr 1px 1fr",
            gap: 18, alignItems: "center",
            borderTop: "1px solid var(--hairline)", marginTop: 20, paddingTop: 18,
          }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.18em", fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase" }}>
                Credentials · Sealed
              </span>
              <span style={{ fontFamily: '"Newsreader", Georgia, serif', fontWeight: 500, fontSize: 30, color: "var(--ink-1)", letterSpacing: "-0.02em" }}>
                {loading ? "—" : vaultPasses.length}
              </span>
            </div>
            <div style={{ width: 1, height: 40, background: "var(--hairline)", justifySelf: "center" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.18em", fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase" }}>
                Agent Passes · Active
              </span>
              <span style={{ fontFamily: '"Newsreader", Georgia, serif', fontWeight: 500, fontSize: 30, color: "var(--ink-1)", letterSpacing: "-0.02em" }}>
                {loading ? "—" : activePasses.length}
              </span>
            </div>
            <div style={{ width: 1, height: 40, background: "var(--hairline)", justifySelf: "center" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 9, letterSpacing: "0.18em", fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase" }}>
                Raw Secrets · Exposed
              </span>
              <span style={{ fontFamily: '"Newsreader", Georgia, serif', fontWeight: 500, fontSize: 30, color: "oklch(0.42 0.09 150)", letterSpacing: "-0.02em" }}>
                0
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── New token banner ──────────────────────────────────────────────── */}
      {newToken && (
        <div className="ag-token-banner">
          <div>
            <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)", marginBottom: 4 }}>
              Pass created · {newToken.agent_name}
            </div>
            <p style={{ fontSize: 12.5, color: "oklch(0.45 0.12 75)", margin: 0 }}>
              Copy this token now — it will not be shown again.
            </p>
          </div>
          <code style={{
            display: "block", background: "rgba(255,255,255,0.7)",
            border: "1px solid var(--amber-ring)", borderRadius: "var(--r-2)",
            padding: "12px 14px", fontSize: 12,
            fontFamily: '"JetBrains Mono", monospace',
            color: "var(--ink-1)", wordBreak: "break-all",
          }}>
            {newToken.token}
          </code>
          <div>
            <button
              type="button"
              onClick={() => setNewToken(null)}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "oklch(0.55 0.12 75)", padding: 0 }}
            >
              Dismiss ×
            </button>
          </div>
        </div>
      )}

      {/* ── KMS notice ───────────────────────────────────────────────────── */}
      <div style={{
        background: "var(--amber-soft)", border: "1px solid var(--amber-ring)",
        borderRadius: "var(--r-3)", padding: "12px 16px",
      }}>
        <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)", marginBottom: 4 }}>
          Dev / MVP · Local KMS vault
        </div>
        <p style={{ fontSize: 12.5, color: "oklch(0.55 0.12 75)", margin: 0, lineHeight: 1.5 }}>
          Encrypted storage via a temporary local KMS — designed to swap for cloud KMS before production.
          Do not store real credentials until cloud KMS and auth are configured.
        </p>
      </div>

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div className="ag-tabs">
        <button
          type="button"
          className={`ag-tab${tab === "vault" ? " ag-tab--active" : ""}`}
          onClick={() => setTab("vault")}
        >
          Vault
        </button>
        <button
          type="button"
          className={`ag-tab${tab === "seal" ? " ag-tab--active" : ""}`}
          onClick={() => setTab("seal")}
        >
          Seal secret
        </button>
        {controlledRoutes.length > 0 && (
          <button
            type="button"
            className={`ag-tab${tab === "assignments" ? " ag-tab--active" : ""}`}
            onClick={() => setTab("assignments")}
          >
            Assignments
          </button>
        )}
      </div>

      {/* ══ Tab: Vault ══════════════════════════════════════════════════════ */}
      {tab === "vault" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>

          {/* Stored credentials */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
              <div className="a-eyebrow">Stored credentials</div>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Passwords are encrypted — agents never receive raw values.
              </span>
            </div>

            {loading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[1, 2].map((i) => (
                  <div key={i} style={{ height: 80, borderRadius: "var(--r-2)", background: "var(--graphite-soft)", opacity: 0.45 }} />
                ))}
              </div>
            )}

            {!loading && vaultPasses.length === 0 && (
              <div className="a-card" style={{ textAlign: "center", padding: "32px 24px" }}>
                <p style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 4px" }}>
                  No credentials sealed yet.
                </p>
                <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 14px", lineHeight: 1.5 }}>
                  Seal a login credential so agents can use it during controlled execution.
                </p>
                <button type="button" onClick={() => setTab("seal")} className="a-btn a-btn--primary">
                  Seal first credential
                </button>
              </div>
            )}

            {vaultPasses.map((vp) => {
              const vpProvider = findCredentialProviderByDomain(vp.domain);
              return (
                <div key={vp.pass_id} className="ag-row">
                  {/* Avatar — green for credentials */}
                  <div style={{
                    width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center",
                    background: "var(--green-soft)", border: "1px solid var(--green-ring)",
                    color: "oklch(0.42 0.09 150)", flexShrink: 0, marginTop: 1,
                  }}>
                    <LockSVG />
                  </div>

                  {/* Content */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                      <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)" }}>{vp.label}</span>
                      {vpProvider && (
                        <span style={{
                          fontSize: 10.5, fontWeight: 500, padding: "1px 7px", borderRadius: 999,
                          background: "var(--blue-soft)", color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)",
                        }}>
                          {vpProvider.display_name}
                        </span>
                      )}
                      <span style={{
                        fontSize: 10.5, fontWeight: 500, padding: "1px 7px", borderRadius: 999,
                        background: "var(--graphite-soft)", color: "var(--ink-3)", border: "1px solid var(--hairline)",
                      }}>
                        {vp.kind}
                      </span>
                      {vp.pass_id === "pass_vault_demo_login_001" && (
                        <span style={{
                          fontSize: 10.5, fontWeight: 500, padding: "1px 7px", borderRadius: 999,
                          background: "var(--blue-soft)", color: "oklch(0.45 0.09 240)", border: "1px solid var(--blue-ring)",
                        }}>
                          seeded demo
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: '"JetBrains Mono", monospace', marginBottom: 6 }}>
                      {vp.domain}
                    </div>
                    <div style={{ display: "flex", gap: 20, fontSize: 12, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ color: "var(--ink-4)", minWidth: 58 }}>Username</span>
                        <span style={{ color: "var(--ink-2)", fontFamily: '"JetBrains Mono", monospace' }}>
                          {vp.username ?? "—"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ color: "var(--ink-4)", minWidth: 58 }}>Password</span>
                        {vp.has_password ? (
                          <span style={{ color: "var(--ink-3)", fontFamily: '"JetBrains Mono", monospace', letterSpacing: "0.12em" }}>
                            ••••••••
                          </span>
                        ) : (
                          <span style={{ color: "oklch(0.45 0.13 25)", fontSize: 11.5 }}>
                            missing — run seed:demo?
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => handleDeleteVaultPass(vp.pass_id, vp.label)}
                      className="a-btn a-btn--danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Agent passes */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
              <div className="a-eyebrow">Agent passes</div>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Delegation tokens — no raw secrets inside.
              </span>
            </div>

            {loading && (
              <div style={{ height: 64, borderRadius: "var(--r-2)", background: "var(--graphite-soft)", opacity: 0.45 }} />
            )}

            {!loading && passes.length === 0 && (
              <div className="a-card" style={{ textAlign: "center", padding: "24px" }}>
                <p style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 4px" }}>
                  No agent passes yet.
                </p>
                <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                  Create a pass to grant an outside agent delegated, collared access.
                </p>
              </div>
            )}

            {passes.map((pass) => (
              <div key={pass.id} className="ag-row">
                {/* Avatar — blue initial for agent passes */}
                <div className="ag-avatar">
                  {pass.agent_name?.[0]?.toUpperCase() ?? "A"}
                </div>

                {/* Content */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)" }}>
                      {pass.agent_name}
                    </span>
                    <span className={`a-status a-status--${statusClass(pass.status)}`}>
                      <span className="a-status__dot" />{pass.status}
                    </span>
                  </div>
                  {pass.purpose && (
                    <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 4px", lineHeight: 1.4 }}>
                      {pass.purpose}
                    </p>
                  )}
                  <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
                    Expires {new Date(pass.expires_at).toLocaleDateString()}
                  </span>
                </div>

                {/* Actions */}
                <div style={{ flexShrink: 0 }}>
                  {pass.status === "active" && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(pass.id)}
                      className="a-btn a-btn--danger"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══ Tab: Seal ═══════════════════════════════════════════════════════ */}
      {tab === "seal" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, alignItems: "start" }}>

          {/* Credential form */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div className="a-eyebrow" style={{ marginBottom: 4 }}>Seal a credential</div>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Store a login credential for Antigen-controlled injection.
                The password is encrypted on entry and never returned.
              </p>
            </div>

            <form
              onSubmit={handleCreateVaultPass}
              className="a-card"
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <div>
                <label className="ag-label">Label *</label>
                <input
                  value={vaultLabel}
                  onChange={(e) => setVaultLabel(e.target.value)}
                  placeholder="e.g. Demo Store Login"
                  className="ag-input"
                />
              </div>
              <div>
                <label className="ag-label">Domain *</label>
                <input
                  value={vaultDomain}
                  onChange={(e) => setVaultDomain(e.target.value)}
                  placeholder="e.g. github.com"
                  className="ag-input"
                />
              </div>
              <div>
                <label className="ag-label">Username *</label>
                <input
                  value={vaultUsername}
                  onChange={(e) => setVaultUsername(e.target.value)}
                  placeholder="e.g. demo_user"
                  autoComplete="username"
                  className="ag-input"
                />
              </div>
              <div>
                <label className="ag-label">Password *</label>
                <input
                  type="password"
                  value={vaultPassword}
                  onChange={(e) => setVaultPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="new-password"
                  className="ag-input"
                />
              </div>

              {vaultFormError && (
                <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{vaultFormError}</p>
              )}
              {vaultCreated && (
                <p style={{ fontSize: 12, color: "oklch(0.42 0.09 150)", margin: 0 }}>
                  Credential sealed. Password will not be shown again.
                </p>
              )}

              <button
                type="submit"
                disabled={creatingVault}
                className="a-btn a-btn--primary"
                style={{ justifyContent: "center" }}
              >
                {creatingVault ? "Sealing…" : "Seal credential"}
              </button>
            </form>

            <p style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: 1.5 }}>
              Password is stored encrypted in the dev vault and never returned after creation.
              Agents resolve it only during approved Antigen-controlled execution.
            </p>
          </div>

          {/* Agent pass form */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div className="a-eyebrow" style={{ marginBottom: 4 }}>Create agent pass</div>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Issue a delegation token to an outside agent, scoped to a collar.
                The token does not contain any raw secrets.
              </p>
            </div>

            <form
              onSubmit={handleCreate}
              className="a-card"
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <div>
                <label className="ag-label">Agent Name *</label>
                <input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="e.g. Shopping Agent"
                  className="ag-input"
                />
              </div>
              <div>
                <label className="ag-label">Task Purpose</label>
                <input
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="e.g. Find running shoes under $100"
                  className="ag-input"
                />
              </div>
              <div>
                <label className="ag-label">Collar *</label>
                {activeCollars.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: "oklch(0.45 0.12 75)", margin: 0 }}>
                    No active collars.{" "}
                    <Link
                      href="/collars/new"
                      style={{ color: "var(--blue)", textDecoration: "none", borderBottom: "1px solid var(--blue-ring)" }}
                    >
                      Create one first.
                    </Link>
                  </p>
                ) : (
                  <select
                    value={collarId}
                    onChange={(e) => setCollarId(e.target.value)}
                    className="ag-select"
                  >
                    {activeCollars.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="ag-label">Expires in (minutes)</label>
                <input
                  type="number"
                  min="1"
                  value={expiresMin}
                  onChange={(e) => setExpiresMin(e.target.value)}
                  className="ag-input"
                  style={{ maxWidth: 120 }}
                />
              </div>

              {formError && (
                <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{formError}</p>
              )}

              <button
                type="submit"
                disabled={creating || activeCollars.length === 0}
                className="a-btn a-btn--primary"
                style={{ justifyContent: "center" }}
              >
                {creating ? "Creating…" : "Create pass"}
              </button>
            </form>

            <p style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: 1.5 }}>
              This pass does not contain passwords, cards, or identity. It only lets the agent request controlled capabilities from Antigen.
            </p>
          </div>
        </div>
      )}

      {/* ══ Tab: Assignments ════════════════════════════════════════════════ */}
      {tab === "assignments" && controlledRoutes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="a-eyebrow" style={{ marginBottom: 2 }}>Credential assignments</div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 12px", lineHeight: 1.5 }}>
            Choose which stored credential each Antigen-controlled skill uses at execution time.
            The agent never sees the password.
          </p>

          {controlledRoutes.map((route) => {
            const domainPasses = vaultPasses.filter(
              (vp) => vp.domain === route.domain && vp.kind === "login_password"
            );
            const currentBinding = bindings.find((b) => b.route_id === route.route_id);
            const currentPass    = currentBinding
              ? vaultPasses.find((vp) => vp.pass_id === currentBinding.pass_id)
              : null;
            const draft   = bindingDraft[route.route_id] ?? "";
            const isDirty = draft !== (currentBinding?.pass_id ?? "");
            const msg     = bindingMsg[route.route_id];

            return (
              <div key={route.route_id} className="a-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)", marginBottom: 2 }}>
                      {route.workflow_name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: '"JetBrains Mono", monospace', marginBottom: 6 }}>
                      {route.domain} · {route.execution_mode}
                    </div>
                    {currentPass ? (
                      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        Current:{" "}
                        <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>{currentPass.label}</span>
                        {" · "}
                        <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>{currentPass.username}</span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "var(--ink-4)" }}>Using route default credential</div>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {domainPasses.length === 0 ? (
                      <p style={{ fontSize: 12, color: "oklch(0.45 0.12 75)", margin: 0 }}>
                        No {route.domain} login credentials yet.
                      </p>
                    ) : (
                      <>
                        <select
                          value={draft}
                          onChange={(e) =>
                            setBindingDraft((d) => ({ ...d, [route.route_id]: e.target.value }))
                          }
                          className="ag-select"
                          style={{ minWidth: 200 }}
                        >
                          <option value="">— route default —</option>
                          {domainPasses.map((vp) => (
                            <option key={vp.pass_id} value={vp.pass_id}>
                              {vp.label} ({vp.username})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleSaveBinding(route.route_id)}
                          disabled={!isDirty || !!savingBinding[route.route_id]}
                          className="a-btn a-btn--primary"
                        >
                          {savingBinding[route.route_id] ? "Saving…" : "Save"}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {msg && (
                  <p style={{
                    fontSize: 12, margin: 0,
                    color: msg.startsWith("Failed") || msg.includes("mismatch")
                      ? "oklch(0.45 0.13 25)"
                      : "oklch(0.42 0.09 150)",
                  }}>
                    {msg}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
