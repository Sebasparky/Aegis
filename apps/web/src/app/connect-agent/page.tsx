"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createAgentConnector,
  listAgentConnectors,
  getAgentConnectorStatus,
  revokeAgentConnector,
  listCollars,
} from "@/lib/api";
import type {
  AgentConnector,
  AgentConnectorPlatform,
  ConnectorPolicyMode,
  ConnectorStatus,
  Collar,
} from "@aegis/types";

// ── Local setup payload types ─────────────────────────────────────────────────

interface SetupMcp {
  connector_type: "mcp_local";
  agent_token: string;
  shown_once: boolean;
  requires_local_path: boolean;
  path_placeholder: string;
  mcp_config: unknown;
  instructions: string[];
}

interface SetupHttp {
  connector_type: "http_api";
  agent_token: string;
  shown_once: boolean;
  http_examples: {
    base_url: string;
    auth_header: string;
    curl_identity: string;
    curl_skills: string;
  };
  instructions: string[];
}

type ConnectorSetup = SetupMcp | SetupHttp;

// ── Copy helper ───────────────────────────────────────────────────────────────

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);
  return { copied, copy };
}

function CopyButton({
  text,
  copyKey,
  copy,
  copied,
  label = "Copy",
}: {
  text: string;
  copyKey: string;
  copy: (t: string, k: string) => void;
  copied: string | null;
  label?: string;
}) {
  const isCopied = copied === copyKey;
  return (
    <button
      className="a-btn a-btn--ghost"
      style={{ padding: "4px 10px", fontSize: 11.5 }}
      onClick={() => copy(text, copyKey)}
    >
      {isCopied ? "✓ Copied" : label}
    </button>
  );
}

// ── Code block with copy ──────────────────────────────────────────────────────

function CodeBlock({
  text,
  copyKey,
  copy,
  copied,
}: {
  text: string;
  copyKey: string;
  copy: (t: string, k: string) => void;
  copied: string | null;
}) {
  return (
    <div style={{ position: "relative" }}>
      <pre
        style={{
          background: "rgba(0,0,0,0.04)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--r-1)",
          padding: "10px 14px",
          paddingRight: 80,
          fontSize: 12,
          fontFamily: '"JetBrains Mono", monospace',
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: 0,
          color: "var(--ink-1)",
          lineHeight: 1.6,
        }}
      >
        {text}
      </pre>
      <div style={{ position: "absolute", top: 6, right: 8 }}>
        <CopyButton text={text} copyKey={copyKey} copy={copy} copied={copied} />
      </div>
    </div>
  );
}

// ── Platform config ───────────────────────────────────────────────────────────

const PLATFORMS: { id: AgentConnectorPlatform; label: string; sub: string }[] = [
  { id: "claude_cowork",  label: "Claude Cowork",  sub: "claude.ai multi-agent sessions" },
  { id: "claude_desktop", label: "Claude Desktop", sub: "Local MCP via config file" },
  { id: "generic_mcp",    label: "Generic MCP",    sub: "Any MCP-compatible agent" },
  { id: "custom_http",    label: "Custom HTTP",     sub: "REST API integration" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusVariant(s: string) {
  if (s === "connected") return "a-status--green";
  if (s === "created")   return "a-status--amber";
  return "a-status--quiet";
}

function statusLabel(s: string) {
  if (s === "connected") return "Connected";
  if (s === "created")   return "Waiting";
  return "Revoked";
}

function platformLabel(p: AgentConnectorPlatform) {
  return PLATFORMS.find((x) => x.id === p)?.label ?? p;
}

function relativeTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1)  return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24)   return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function mcpConfigLabel(p: AgentConnectorPlatform) {
  if (p === "claude_desktop") return "Add to claude_desktop_config.json";
  if (p === "claude_cowork")  return "Add to your MCP configuration";
  return "MCP Config";
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ConnectAgentPage() {
  const [platform, setPlatform] = useState<AgentConnectorPlatform | null>(null);
  const [policyMode, setPolicyMode] = useState<ConnectorPolicyMode>("baseline");
  const [collarId, setCollarId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [created, setCreated] = useState<{ connector: AgentConnector; setup: ConnectorSetup } | null>(null);
  const [setupStatus, setSetupStatus] = useState<ConnectorStatus>("created");
  const [lastSeen, setLastSeen] = useState<string | undefined>(undefined);

  const [connectors, setConnectors] = useState<AgentConnector[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [collars, setCollars] = useState<Collar[]>([]);

  const { copied, copy } = useCopy();

  useEffect(() => {
    listCollars()
      .then((c) => setCollars(c.filter((x) => x.status === "active")))
      .catch(() => {});
    listAgentConnectors()
      .then(setConnectors)
      .catch(() => {})
      .finally(() => setListLoading(false));
  }, []);

  // Poll connector status after creation until connected
  useEffect(() => {
    if (!created || setupStatus === "connected" || setupStatus === "revoked") return;
    const interval = setInterval(async () => {
      try {
        const s = await getAgentConnectorStatus(created.connector.connector_id);
        setSetupStatus(s.status);
        setLastSeen(s.last_seen_at);
        if (s.status === "connected") {
          setConnectors((prev) =>
            prev.map((c): AgentConnector =>
              c.connector_id === created.connector.connector_id
                ? { ...c, status: "connected", last_seen_at: s.last_seen_at }
                : c
            )
          );
        }
      } catch {}
    }, 4000);
    return () => clearInterval(interval);
  }, [created, setupStatus]);

  async function handleCreate() {
    if (!platform) return setFormError("Select a platform to continue.");
    if (!displayName.trim()) return setFormError("Enter a display name for this connector.");
    if (policyMode === "collar" && !collarId) return setFormError("Select a collar.");
    setFormError(null);
    setCreating(true);
    try {
      const result = await createAgentConnector({
        display_name: displayName.trim(),
        platform,
        policy_mode: policyMode,
        collar_id: policyMode === "collar" ? collarId : undefined,
      });
      setCreated({ connector: result.connector, setup: result.setup as ConnectorSetup });
      setSetupStatus("created");
      setLastSeen(undefined);
      setConnectors((prev) => [result.connector, ...prev]);
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : "Failed to create connector.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    try {
      await revokeAgentConnector(id);
      setConnectors((prev) =>
        prev.map((c): AgentConnector =>
          c.connector_id === id ? { ...c, status: "revoked" } : c
        )
      );
    } catch {}
  }

  const mcpSetup  = created?.setup?.connector_type === "mcp_local"  ? (created.setup as SetupMcp)  : null;
  const httpSetup = created?.setup?.connector_type === "http_api"   ? (created.setup as SetupHttp) : null;

  return (
    <div className="page fadein" style={{ gap: 24 }}>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div className="cmd-hero cmd-hero--ceramic">
        <div className="cmd-hero__aura" aria-hidden />
        <div className="cmd-hero__grain" aria-hidden />
        <div className="cmd-hero__title">
          Connect an <span className="cmd-hero__title-mark">Agent</span>
        </div>
        <div className="cmd-hero__sub">
          Connect Claude, Cursor, or any MCP or HTTP agent. Antigen keeps secrets
          protected and asks before sensitive actions.
        </div>
      </div>

      {/* ── Create form OR Setup card ──────────────────────────────────────── */}
      {!created ? (
        <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 22 }}>

          {/* Platform selector */}
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 12 }}>Platform</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
              {PLATFORMS.map((p) => {
                const sel = platform === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setPlatform(p.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 4,
                      padding: "12px 14px",
                      borderRadius: "var(--r-2)",
                      border: sel ? "1px solid var(--blue-ring)" : "1px solid var(--hairline)",
                      background: sel ? "var(--blue-soft)" : "rgba(255,255,255,0.55)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color 0.14s, background 0.14s",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: sel ? "var(--blue)" : "var(--ink-1)" }}>
                      {p.label}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.4 }}>
                      {p.sub}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Safety policy selector */}
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 12 }}>Safety Policy</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button
                onClick={() => setPolicyMode("baseline")}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 6,
                  padding: "14px 16px",
                  borderRadius: "var(--r-2)",
                  border: policyMode === "baseline" ? "1px solid var(--blue-ring)" : "1px solid var(--hairline)",
                  background: policyMode === "baseline" ? "var(--blue-soft)" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "border-color 0.14s, background 0.14s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: policyMode === "baseline" ? "var(--blue)" : "var(--ink-1)" }}>
                    Baseline Safety
                  </span>
                  <span className="a-status a-status--green" style={{ fontSize: 10.5 }}>Recommended</span>
                </div>
                <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.45 }}>
                  Antigen applies standard guardrails. Good for most tasks.
                </span>
              </button>

              <button
                onClick={() => setPolicyMode("collar")}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 6,
                  padding: "14px 16px",
                  borderRadius: "var(--r-2)",
                  border: policyMode === "collar" ? "1px solid var(--blue-ring)" : "1px solid var(--hairline)",
                  background: policyMode === "collar" ? "var(--blue-soft)" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "border-color 0.14s, background 0.14s",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: policyMode === "collar" ? "var(--blue)" : "var(--ink-1)" }}>
                  Use a Collar
                </span>
                <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.45 }}>
                  Apply a named collar with custom policy rules for this agent.
                </span>
              </button>
            </div>

            {policyMode === "collar" && (
              <div style={{ marginTop: 10 }}>
                {collars.length === 0 ? (
                  <div className="ag-helper">
                    No active collars.{" "}
                    <a href="/collars" style={{ color: "var(--blue)", textDecoration: "none", borderBottom: "1px solid var(--blue-ring)" }}>
                      Create one in Collars.
                    </a>
                  </div>
                ) : (
                  <>
                    <label className="ag-label">Collar</label>
                    <select
                      className="ag-select"
                      value={collarId}
                      onChange={(e) => setCollarId(e.target.value)}
                    >
                      <option value="">Select a collar…</option>
                      {collars.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Display name */}
          <div>
            <label className="ag-label">Display Name</label>
            <input
              className="ag-input"
              placeholder="e.g. Research Agent, Booking Bot"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !creating && handleCreate()}
            />
            <div className="ag-helper">A short name to identify this connector in Antigen.</div>
          </div>

          {formError && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "var(--r-1)",
                background: "var(--red-soft)",
                border: "1px solid var(--red-ring)",
                color: "oklch(0.45 0.13 25)",
                fontSize: 13,
              }}
            >
              {formError}
            </div>
          )}

          <div>
            <button
              className="a-btn a-btn--primary"
              onClick={handleCreate}
              disabled={creating || !platform || !displayName.trim()}
            >
              {creating ? "Creating…" : "Connect Agent"}
            </button>
          </div>
        </div>
      ) : (
        /* ── Setup card (post-creation) ────────────────────────────────── */
        <div className="a-card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Shown-once warning */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "12px 16px",
              borderRadius: "var(--r-1)",
              background: "var(--amber-soft)",
              border: "1px solid var(--amber-ring)",
            }}
          >
            <svg
              width={15} height={15} viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5"
              style={{ color: "oklch(0.6 0.12 72)", flexShrink: 0, marginTop: 1 }}
            >
              <path d="M10.3 4.3L3 17a2 2 0 001.7 3h14.6a2 2 0 001.7-3L14 4.3a2 2 0 00-3.4 0z"/>
              <path d="M12 9v4M12 17h.01"/>
            </svg>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.52 0.11 72)" }}>
                Save this token — it will not be shown again.
              </div>
              <div style={{ fontSize: 12, color: "oklch(0.55 0.09 72)", marginTop: 2, lineHeight: 1.4 }}>
                Copy it now and store it securely before leaving this page.
              </div>
            </div>
          </div>

          {/* Agent token */}
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 8 }}>Agent Token</div>
            <CodeBlock
              text={created.setup.agent_token}
              copyKey="token"
              copy={copy}
              copied={copied}
            />
          </div>

          {/* MCP config (MCP platforms) */}
          {mcpSetup && (
            <div>
              <div className="a-eyebrow" style={{ marginBottom: 4 }}>
                {mcpConfigLabel(created.connector.platform)}
              </div>
              <div className="ag-helper" style={{ marginBottom: 8 }}>
                {mcpSetup.requires_local_path
                  ? `Replace ${mcpSetup.path_placeholder} with the absolute path to this repository.`
                  : "Add this block to your MCP configuration."}
              </div>
              <CodeBlock
                text={JSON.stringify(mcpSetup.mcp_config, null, 2)}
                copyKey="mcp_config"
                copy={copy}
                copied={copied}
              />
            </div>
          )}

          {/* HTTP examples (custom_http) */}
          {httpSetup && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div className="a-eyebrow" style={{ marginBottom: 4 }}>Verify Identity</div>
                <CodeBlock
                  text={httpSetup.http_examples.curl_identity}
                  copyKey="curl_identity"
                  copy={copy}
                  copied={copied}
                />
              </div>
              <div>
                <div className="a-eyebrow" style={{ marginBottom: 4 }}>List Skills</div>
                <CodeBlock
                  text={httpSetup.http_examples.curl_skills}
                  copyKey="curl_skills"
                  copy={copy}
                  copied={copied}
                />
              </div>
            </div>
          )}

          {/* Next steps */}
          {created.setup.instructions?.length > 0 && (
            <div>
              <div className="a-eyebrow" style={{ marginBottom: 8 }}>Next Steps</div>
              <ul
                style={{
                  margin: 0,
                  padding: "0 0 0 18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {created.setup.instructions.map((inst: string, i: number) => (
                  <li key={i} style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                    {inst}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Status strip */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingTop: 14,
              borderTop: "1px solid var(--hairline)",
            }}
          >
            {setupStatus === "connected" ? (
              <>
                <span className="a-status a-status--green">
                  <span className="a-status__dot" />
                  Agent connected
                </span>
                {lastSeen && (
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    · First seen {relativeTime(lastSeen)}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="a-status a-status--amber">
                  <span className="a-status__dot" />
                  Waiting for agent to connect
                </span>
                <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                  · Status updates automatically
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Existing connectors ────────────────────────────────────────────── */}
      <div>
        <div className="a-eyebrow" style={{ marginBottom: 12 }}>Connected Agents</div>

        {listLoading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  height: 72,
                  borderRadius: "var(--r-2)",
                  background: "var(--graphite-soft)",
                  opacity: 0.45,
                }}
              />
            ))}
          </div>
        ) : connectors.length === 0 ? (
          <div className="a-card" style={{ textAlign: "center", padding: "40px 24px" }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-2)" }}>
              No connectors yet
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 4 }}>
              Create one above to connect your first agent.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {connectors.map((c) => (
              <div key={c.connector_id} className="ag-row">
                <div className="ag-avatar">
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-1)" }}>
                      {c.display_name}
                    </span>
                    <span className="a-status a-status--quiet" style={{ fontSize: 10.5 }}>
                      {platformLabel(c.platform)}
                    </span>
                    {c.policy_mode === "collar" && (
                      <span className="a-status a-status--blue" style={{ fontSize: 10.5 }}>
                        Collar
                      </span>
                    )}
                  </div>
                  <div className="metadata-row">
                    <span>Created {relativeTime(c.created_at)}</span>
                    {c.last_seen_at && (
                      <>
                        <span className="metadata-sep">·</span>
                        <span>Last seen {relativeTime(c.last_seen_at)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className={`a-status ${statusVariant(c.status)}`}>
                    <span className="a-status__dot" />
                    {statusLabel(c.status)}
                  </span>
                  {c.status !== "revoked" && (
                    <button
                      className="a-btn a-btn--ghost"
                      style={{
                        fontSize: 12,
                        padding: "4px 10px",
                        color: "var(--red)",
                        borderColor: "var(--red-ring)",
                      }}
                      onClick={() => handleRevoke(c.connector_id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
