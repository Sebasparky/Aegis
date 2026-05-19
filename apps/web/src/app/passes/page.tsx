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
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

function LockSVG() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function statusClass(status: string): string {
  if (status === "active")  return "quiet";
  if (status === "revoked") return "outline-red";
  return "graphite";
}

type Tab = "vault" | "seal" | "assignments";

function HeaderStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat__value">{value}</div>
      <div className="header-stat__label">{label}</div>
    </div>
  );
}

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
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
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
          <div className="header-stats">
            <HeaderStat value={loading ? "—" : vaultPasses.length} label="Credentials sealed" />
            <HeaderStat value={loading ? "—" : activePasses.length} label="Agent passes active" />
            <HeaderStat value={0} label="Raw secrets exposed" />
          </div>
        </div>
      </SpotlightHeroCard>

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
              <div className="a-eyebrow">Saved protected logins</div>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Passwords are encrypted. Agents never see the raw values.
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
                  Save a login so Antigen can use it during controlled workflows without revealing it to an agent.
                </p>
                <button type="button" onClick={() => setTab("seal")} className="a-btn a-btn--primary">
                  Save first login
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
                        <><span className="metadata-sep">·</span><span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--ink-3)" }}>{vpProvider.display_name}</span></>
                      )}
                      <span className="metadata-sep">·</span>
                      <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--ink-3)" }}>{vp.kind}</span>
                      {vp.pass_id === "pass_vault_demo_login_001" && (
                        <><span className="metadata-sep">·</span><span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>seeded demo</span></>
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

        </div>
      )}

      {/* ══ Tab: Seal ═══════════════════════════════════════════════════════ */}
      {tab === "seal" && (
        <div style={{ display: "grid", gridTemplateColumns: "1.65fr 1fr", gap: 20, alignItems: "start" }}>

          {/* Left — main form card */}
          <form
            onSubmit={handleCreateVaultPass}
            className="a-card"
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div>
              <div className="a-eyebrow" style={{ marginBottom: 4 }}>Save a protected login</div>
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Store a username and password once. Antigen can fill it later without revealing the password to an agent.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label className="ag-label">Name *</label>
                <input
                  value={vaultLabel}
                  onChange={(e) => setVaultLabel(e.target.value)}
                  placeholder="e.g. Demo Store Login"
                  className="ag-input"
                />
                <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: "4px 0 0", lineHeight: 1.4 }}>
                  A label you'll recognize, like Demo Store Login.
                </p>
              </div>
              <div>
                <label className="ag-label">Website or app *</label>
                <input
                  value={vaultDomain}
                  onChange={(e) => setVaultDomain(e.target.value)}
                  placeholder="e.g. github.com"
                  className="ag-input"
                />
                <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: "4px 0 0", lineHeight: 1.4 }}>
                  The domain where this login is used.
                </p>
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
            </div>

            {vaultFormError && (
              <p style={{ fontSize: 12, color: "oklch(0.45 0.13 25)", margin: 0 }}>{vaultFormError}</p>
            )}
            {vaultCreated && (
              <p style={{ fontSize: 12, color: "oklch(0.42 0.09 150)", margin: 0 }}>
                Protected login saved. You can assign it to a workflow now.
              </p>
            )}

            <button
              type="submit"
              disabled={creatingVault}
              className="a-btn a-btn--primary"
            >
              {creatingVault ? "Saving…" : "Save protected login"}
            </button>
          </form>

          {/* Right — safety explanation card */}
          <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 0, padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-1)" }}>What Antigen protects</div>
            </div>

            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-1)", marginBottom: 4 }}>
                Agents never see the password
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                Antigen fills the login only when the workflow is approved to use it.
              </p>
            </div>

            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-1)", marginBottom: 4 }}>
                You choose where it can be used
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                After saving, assign this login to specific workflows from the Assignments tab.
              </p>
            </div>

            <div style={{ padding: "14px 18px" }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-1)", marginBottom: 4 }}>
                Raw values stay sealed
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                The password is encrypted and never returned to an agent.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ══ Tab: Assignments ════════════════════════════════════════════════ */}
      {tab === "assignments" && controlledRoutes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="a-eyebrow" style={{ marginBottom: 2 }}>Workflow assignments</div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 12px", lineHeight: 1.5 }}>
            Choose which protected information each workflow can use. Antigen fills it when needed without revealing it to the agent.
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
              <div key={route.route_id} className="a-card" style={{ display: "flex", flexDirection: "column", gap: 0, padding: 0, overflow: "hidden" }}>
                {/* Card header */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 18px", borderBottom: "1px solid var(--hairline)",
                  gap: 12, flexWrap: "wrap",
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-1)", marginBottom: 2 }}>
                      {route.workflow_name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: '"JetBrains Mono", monospace' }}>
                      {route.domain}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: "var(--ink-3)", flexShrink: 0 }}>
                    {currentPass ? `Login: ${currentPass.label}` : "Login: workflow default"}
                  </span>
                </div>

                {/* Assignment rows */}
                <div style={{ display: "flex", flexDirection: "column" }}>

                  {/* Login row — functional */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "12px 18px", borderBottom: "1px solid var(--hairline)",
                    flexWrap: "wrap",
                  }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-2)", minWidth: 64 }}>Login</span>
                    {domainPasses.length === 0 ? (
                      <span style={{ fontSize: 12.5, color: "var(--ink-4)", flex: 1 }}>
                        No saved login for this website yet.
                      </span>
                    ) : (
                      <>
                        <select
                          value={draft}
                          onChange={(e) =>
                            setBindingDraft((d) => ({ ...d, [route.route_id]: e.target.value }))
                          }
                          className="ag-select"
                          style={{ flex: 1, minWidth: 180 }}
                        >
                          <option value="">Use workflow default</option>
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

                  <div style={{ padding: "10px 18px" }}>
                    <span style={{ fontSize: 12, color: "var(--ink-4)", fontStyle: "italic" }}>
                      More protected item types like payment methods and addresses are coming later.
                    </span>
                  </div>
                </div>

                {msg && (
                  <div style={{ padding: "8px 18px", borderTop: "1px solid var(--hairline)" }}>
                    <p style={{
                      fontSize: 12, margin: 0,
                      color: msg.startsWith("Failed") || msg.includes("mismatch")
                        ? "oklch(0.45 0.13 25)"
                        : "oklch(0.42 0.09 150)",
                    }}>
                      {msg}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
