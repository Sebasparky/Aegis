"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { listApprovals } from "@/lib/api";

const NAV_ITEMS = [
  { href: "/", label: "Command", group: "core" },
  { href: "/delegations", label: "Agents", group: "core" },
  { href: "/collars", label: "Collars", group: "core" },
  { href: "/route-run-approvals", label: "Approvals", group: "core", badge: true },
  { href: "/passes", label: "Secrets", group: "core" },
  { href: "/workspaces", label: "Workspaces", group: "core" },
  { href: "/rails", label: "Rails", group: "infra" },
  { href: "/receipts", label: "Receipts", group: "infra" },
  { href: "/website-aegis-id", label: "Websites", group: "infra" },
  { href: "/aegis-id", label: "Settings", group: "settings" },
] as const;

const LABEL_MAP: Record<string, string> = {
  "/": "Command",
  "/delegations": "Agents",
  "/collars": "Collars",
  "/route-run-approvals": "Approvals",
  "/passes": "Secrets",
  "/workspaces": "Workspaces",
  "/rails": "Rails",
  "/receipts": "Receipts",
  "/website-aegis-id": "Websites",
  "/aegis-id": "Settings",
};

function getPageLabel(pathname: string): string {
  if (pathname === "/") return "Command";
  for (const [route, label] of Object.entries(LABEL_MAP)) {
    if (route !== "/" && pathname.startsWith(route)) return label;
  }
  return "Aegis";
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    listApprovals("pending")
      .then((items) => setPendingCount(items.length))
      .catch(() => {});
  }, []);

  const allClear = pendingCount === 0;
  const pageLabel = getPageLabel(pathname);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-white border-r border-gray-100 flex flex-col">
        {/* Logo */}
        <div className="px-5 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-blue-600 text-lg leading-none select-none">◆</span>
            <span className="text-sm font-semibold text-gray-900 tracking-tight">Aegis</span>
          </div>
          <p className="text-[10px] text-gray-400 mt-1 ml-6">Trust layer for AI agents</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 overflow-y-auto">
          <NavGroup label="Core">
            {NAV_ITEMS.filter((n) => n.group === "core").map((item) => (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                active={isActive(pathname, item.href)}
                badge={"badge" in item && item.badge ? pendingCount : undefined}
              />
            ))}
          </NavGroup>

          <NavGroup label="Infrastructure">
            {NAV_ITEMS.filter((n) => n.group === "infra").map((item) => (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                active={isActive(pathname, item.href)}
              />
            ))}
          </NavGroup>

          <NavGroup label="">
            {NAV_ITEMS.filter((n) => n.group === "settings").map((item) => (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                active={isActive(pathname, item.href)}
              />
            ))}
          </NavGroup>
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-12 shrink-0 bg-white/90 backdrop-blur-sm border-b border-gray-100/80 flex items-center justify-between px-6">
          {/* Breadcrumb */}
          <p className="text-sm font-medium text-gray-700">{pageLabel}</p>

          {/* Trust Fabric pill */}
          <div
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              allClear
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : "bg-amber-50 border-amber-200 text-amber-700"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                allClear ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
              }`}
            />
            {allClear ? "Trust Fabric — All clear" : `Trust Fabric — ${pendingCount} pending`}
          </div>

          {/* Avatar placeholder */}
          <div className="w-7 h-7 rounded-full bg-gray-100 border border-gray-200" />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      {label && (
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 px-4 pt-4 pb-1">
          {label}
        </p>
      )}
      {children}
    </div>
  );
}

function NavItem({
  href,
  label,
  active,
  badge,
}: {
  href: string;
  label: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center justify-between mx-2 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? "bg-blue-50 text-blue-700 font-medium border-l-2 border-blue-500 rounded-l-none pl-[10px]"
          : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
      }`}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="text-xs bg-blue-100 text-blue-700 font-semibold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
          {badge}
        </span>
      )}
    </Link>
  );
}
