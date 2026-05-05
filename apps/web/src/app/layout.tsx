import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aegis",
  description: "The trust and control layer for autonomous AI agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex">
        <aside className="w-56 shrink-0 border-r border-gray-800 bg-gray-950 flex flex-col p-4 gap-1">
          <div className="mb-6 px-2">
            <span className="text-lg font-semibold tracking-tight text-white">Aegis</span>
            <p className="text-xs text-gray-500 mt-0.5">Trust layer for AI agents</p>
          </div>
          <NavLink href="/" label="Dashboard" />
          <NavLink href="/demo" label="Demo" />
          <NavLink href="/agent-bridge" label="Agent Bridge" />
          <NavLink href="/rails" label="Aegis Rails" />
          <NavLink href="/marketplace-review" label="Marketplace Review" />
          <NavLink href="/marketplace" label="Marketplace" />
          <NavLink href="/skill-library" label="Skill Library" />
          <NavLink href="/passes" label="Passes" />
          <NavLink href="/vault-import" label="Import CSV" />
          <NavLink href="/collars" label="Collars" />
          <NavLink href="/sessions" label="Sessions" />
          <NavLink href="/approvals" label="Approvals" badge />
          <NavLink href="/receipts" label="Route Receipts" />
          <NavLink href="/sensitive-receipts" label="Sensitive Timeline" />
          <NavLink href="/runners" label="Runners" />
          <NavLink href="/aegis-id" label="AegisID" />
          <NavLink href="/website-aegis-id" label="Website AegisID" />
          <NavLink href="/counterparty-agent" label="Agent Verification" />
          <NavLink href="/tasks" label="Agent Tasks" />
          <NavLink href="/delegations" label="Delegations" />
          <NavLink href="/route-run-approvals" label="Run Approvals" />
        </aside>
        <main className="flex-1 overflow-auto p-8">{children}</main>
      </body>
    </html>
  );
}

function NavLink({
  href,
  label,
  badge,
}: {
  href: string;
  label: string;
  badge?: boolean;
}) {
  return (
    <a
      href={href}
      className="flex items-center justify-between px-3 py-2 rounded-md text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
    >
      {label}
      {badge && (
        <span className="text-xs bg-indigo-500 text-white px-1.5 py-0.5 rounded-full">
          0
        </span>
      )}
    </a>
  );
}
