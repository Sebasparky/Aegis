"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Collar } from "@aegis/types";
import { listCollars, revokeCollar } from "@/lib/api";

function ShieldSVG() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3l7 3v6c0 4.5-3.2 7.5-7 9-3.8-1.5-7-4.5-7-9V6l7-3z" />
    </svg>
  );
}

function statusClass(status: string): string {
  if (status === "active")   return "quiet";
  if (status === "revoked")  return "outline-red";
  return "graphite";
}

export default function CollarsPage() {
  const [collars, setCollars] = useState<Collar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  async function load() {
    try {
      setCollars(await listCollars());
    } catch {
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
    <div className="page">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="cmd-hero cmd-hero--ceramic" style={{ padding: "28px 32px 24px" }}>
        <span className="cmd-hero__aura" aria-hidden="true" />
        <span className="cmd-hero__grain" aria-hidden="true" />
        <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <div>
            <div className="a-eyebrow">Collars</div>
            <h1 className="cmd-hero__title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
              Permission shells for{" "}
              <span className="cmd-hero__title-mark">delegated agents</span>
            </h1>
            <p className="cmd-hero__sub" style={{ fontSize: 13.5, textAlign: "left", margin: 0 }}>
              Each collar defines exactly what an agent may do, what requires your approval, and what is never allowed.
            </p>
          </div>
          <Link href="/collars/new" className="a-btn a-btn--primary" style={{ flexShrink: 0 }}>
            + New Collar
          </Link>
        </div>
      </div>

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: "var(--amber-soft)", border: "1px solid var(--amber-ring)",
          borderRadius: "var(--r-3)", padding: "14px 18px",
        }}>
          <div className="a-eyebrow" style={{ color: "var(--amber)", marginBottom: 4 }}>Error</div>
          <p style={{ fontSize: 13, color: "var(--ink-1)", margin: 0 }}>{error}</p>
        </div>
      )}

      {/* ── Loading skeletons ─────────────────────────────────────────────── */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              height: 80, borderRadius: "var(--r-2)",
              background: "var(--graphite-soft)", opacity: 0.45,
            }} />
          ))}
        </div>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {!loading && !error && collars.length === 0 && (
        <div className="a-card" style={{ textAlign: "center", padding: "40px 24px" }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 4px" }}>
            No collars yet.
          </p>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
            Create a collar to define an agent&apos;s permission boundary.
          </p>
          <Link href="/collars/new" className="a-btn a-btn--primary" style={{ marginTop: 16 }}>
            Create Collar
          </Link>
        </div>
      )}

      {/* ── Collar list ───────────────────────────────────────────────────── */}
      {!loading && collars.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {collars.map((collar) => (
            <div key={collar.id} className="ag-row">

              {/* Avatar */}
              <div className="ag-avatar" style={{ marginTop: 2 }}>
                <ShieldSVG />
              </div>

              {/* Main content */}
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)" }}>
                    {collar.name}
                  </span>
                  {collar.status === "active" ? (
                    <span className="metadata-state metadata-state--good">{collar.status}</span>
                  ) : (
                    <span className={`a-status a-status--${statusClass(collar.status)}`}>{collar.status}</span>
                  )}
                </div>

                {collar.purpose && (
                  <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 8px", lineHeight: 1.4 }}>
                    {collar.purpose}
                  </p>
                )}

                <div className="a-meta-line" style={{ marginTop: collar.purpose ? 0 : 6 }}>
                  <span>{(collar.allowed_actions ?? []).length} allowed</span>
                  {(collar.approval_required_actions ?? []).length > 0 && (
                    <>
                      <span className="a-meta-line__sep">·</span>
                      <span style={{ color: "var(--amber)" }}>
                        {(collar.approval_required_actions ?? []).length} ask first
                      </span>
                    </>
                  )}
                  {(collar.blocked_actions ?? []).length > 0 && (
                    <>
                      <span className="a-meta-line__sep">·</span>
                      <span style={{ color: "var(--red)" }}>
                        {(collar.blocked_actions ?? []).length} blocked
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                <Link href={`/collars/${collar.id}`} className="a-btn a-btn--ghost">
                  Edit
                </Link>
                {collar.status === "active" && (
                  <button
                    type="button"
                    onClick={() => handleRevoke(collar.id)}
                    className="a-btn a-btn--danger"
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
  );
}
