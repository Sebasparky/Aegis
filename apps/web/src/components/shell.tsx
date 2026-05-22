"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { listApprovals, getUser } from "@/lib/api";

// ── Inline SVG icons ───────────────────────────────────────────────────────
function Ic({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      {children}
    </svg>
  );
}

const Icons = {
  shield:    (s = 16) => <Ic size={s}><path d="M12 3l7 3v6c0 4.5-3.2 7.5-7 9-3.8-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></Ic>,
  command:   (s = 16) => <Ic size={s}><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/></Ic>,
  agents:    (s = 16) => <Ic size={s}><circle cx="12" cy="9" r="3.2"/><path d="M5 19c1.4-3 4-4.5 7-4.5s5.6 1.5 7 4.5"/></Ic>,
  collars:   (s = 16) => <Ic size={s}><path d="M12 3l7 3v6c0 4.5-3.2 7.5-7 9-3.8-1.5-7-4.5-7-9V6l7-3z"/></Ic>,
  approvals: (s = 16) => <Ic size={s}><path d="M5 12l4 4 10-10"/></Ic>,
  secrets:   (s = 16) => <Ic size={s}><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></Ic>,
  workspaces:(s = 16) => <Ic size={s}><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></Ic>,
  rails:     (s = 16) => <Ic size={s}><path d="M5 4v16M19 4v16M5 9h14M5 15h14"/></Ic>,
  cards:     (s = 16) => <Ic size={s}><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></Ic>,
  receipts:  (s = 16) => <Ic size={s}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h4"/></Ic>,
  websites:  (s = 16) => <Ic size={s}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></Ic>,
  settings:  (s = 16) => <Ic size={s}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></Ic>,
  bell:      (s = 15) => <Ic size={s}><path d="M6 16V11a6 6 0 0112 0v5l1.5 2H4.5L6 16z"/><path d="M10 20a2 2 0 004 0"/></Ic>,
  connect:   (s = 16) => <Ic size={s}><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></Ic>,
};

// ── Nav config ─────────────────────────────────────────────────────────────
type NavItem = { href: string; label: string; icon: (s?: number) => React.ReactNode; badge?: true };

const NAV_ITEMS: NavItem[] = [
  { href: "/",                    label: "Command",    icon: Icons.command    },
  { href: "/delegations",         label: "Agents",     icon: Icons.agents     },
  { href: "/connect-agent",       label: "Connect",    icon: Icons.connect    },
  { href: "/collars",             label: "Collars",    icon: Icons.collars    },
  { href: "/route-run-approvals", label: "Approvals",  icon: Icons.approvals, badge: true },
  { href: "/passes",              label: "Secrets",    icon: Icons.secrets    },
  { href: "/payment-methods",    label: "Cards",      icon: Icons.cards      },
  { href: "/workspaces",          label: "Workspaces", icon: Icons.workspaces },
  { href: "/rails",               label: "Rails",      icon: Icons.rails      },
  { href: "/receipts",            label: "Receipts",   icon: Icons.receipts   },
  { href: "/website-aegis-id",    label: "Websites",   icon: Icons.websites   },
  { href: "/aegis-id",            label: "Settings",   icon: Icons.settings   },
];

const PAGE_LABELS: Record<string, string> = {
  "/":                    "Command",
  "/delegations":         "Agents",
  "/connect-agent":       "Connect Agent",
  "/collars":             "Collars",
  "/route-run-approvals": "Approvals",
  "/passes":              "Secrets",
  "/payment-methods":    "Payment Methods",
  "/workspaces":          "Workspaces",
  "/rails":               "Rails",
  "/receipts":            "Receipts",
  "/website-aegis-id":    "Websites",
  "/aegis-id":            "Settings",
};

function getPageLabel(pathname: string): string {
  if (pathname === "/") return "Command";
  for (const [route, label] of Object.entries(PAGE_LABELS)) {
    if (route !== "/" && pathname.startsWith(route)) return label;
  }
  return "Antigen";
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

// ── AppShell ───────────────────────────────────────────────────────────────
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingCount, setPendingCount] = useState(0);
  const [aegisId, setAegisId]           = useState("aegis://…");
  const [initials, setInitials]         = useState("?");

  useEffect(() => {
    listApprovals("pending")
      .then((items) => setPendingCount(items.length))
      .catch(() => {});

    getUser()
      .then((u) => {
        if (u.aegis_id) setAegisId(u.aegis_id);
        if (u.display_name) {
          setInitials(
            u.display_name.split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()
          );
        }
      })
      .catch(() => {});
  }, []);

  const pageLabel = getPageLabel(pathname);
  const allClear  = pendingCount === 0;

  return (
    <div className="shell">
      {/* ── Sidebar ── */}
      <aside className="sb">
        {/* Brand */}
        <div className="sb__brand">
          <div className="sb__brand-glyph">
            <span className="sb__brand-glyph-inner">{Icons.shield(14)}</span>
          </div>
          <div>
            <div className="sb__brand-name">Antigen</div>
            <div className="sb__brand-tag">TRUST LAYER · v0.4</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="sb__nav">
          <span className="sb__trustline" aria-hidden="true" />
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`sb__item${active ? " sb__item--active" : ""}`}
              >
                <span className="sb__item-ic">{item.icon(16)}</span>
                <span className="sb__item-l">{item.label}</span>
                {item.badge && pendingCount > 0 && (
                  <span className="sb__item-badge">{pendingCount}</span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* User passport */}
        <div className="sb__pass">
          <div className="sb__pass-mark">
            <span className="sb__pass-stamp">{Icons.shield(10)}</span>
            <span className="sb__pass-eyebrow">User Passport</span>
          </div>
          <div className="sb__pass-id">{aegisId}</div>
          <div className="sb__pass-foot">
            <span className="a-status a-status--green">
              <span className="a-status__dot" />
              Active
            </span>
            <span className="sb__pass-meta">v0.4</span>
          </div>
        </div>
      </aside>

      {/* ── Main column ── */}
      <div className="shell__main">
        {/* Topbar */}
        <header className="tb">
          <div className="tb__crumb">
            <span className="tb__crumb-org">My Antigen</span>
            <span className="tb__crumb-sep">/</span>
            <span className="tb__crumb-page">{pageLabel}</span>
          </div>

          <div className="tb__status tb__status--seal">
            <span className="tb__status-dot" />
            <span className="tb__status-eyebrow">TRUST FABRIC</span>
            <span className="tb__status-sep">·</span>
            <span>{allClear ? "Verified" : `${pendingCount} pending`}</span>
          </div>

          <div className="tb__right">
            <button className="tb__icon" title="Notifications" type="button">
              {Icons.bell(15)}
              {pendingCount > 0 && (
                <span className="tb__icon-badge">{pendingCount}</span>
              )}
            </button>
            <div className="tb__avatar">{initials}</div>
          </div>
        </header>

        {/* Page content */}
        <main className="shell__page">{children}</main>
      </div>
    </div>
  );
}
