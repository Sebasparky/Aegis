"use client";

import { useEffect, useRef, useState } from "react";
import type { AegisRoute } from "@aegis/types";
import { listRoutes, reviewRoute } from "../../lib/api";

const TIER_LABEL: Record<string, string> = {
  unverified_draft: "Draft",
  community: "Community",
  aegis_scanned: "Verified",
  aegis_reviewed: "Reviewed",
  run_verified: "Run Verified",
  business_official: "Business Official",
};

const RISK_COLORS: Record<string, string> = {
  low: "text-green-400",
  medium: "text-yellow-400",
  high: "text-orange-400",
  critical: "text-red-400",
};

function friendlyDate(iso: string | undefined): string {
  if (!iso || iso === "1970-01-01T00:00:00.000Z") return "—";
  return new Date(iso).toLocaleString();
}

function ReviewCard({ route, onDecision }: { route: AegisRoute; onDecision: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  async function handle(decision: "approved" | "rejected") {
    setActing(true);
    setError(null);
    try {
      await reviewRoute(route.route_id, decision, note.trim() || undefined);
      onDecision(route.route_id);
    } catch (err: any) {
      setError(err.message ?? "Action failed.");
      setActing(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-4">
          <span className="text-sm font-semibold text-white">{route.workflow_name}</span>
          <span className={`shrink-0 text-xs px-2 py-0.5 rounded border font-medium ${
            route.trust_tier === "aegis_scanned"
              ? "text-cyan-400 bg-cyan-950 border-cyan-900"
              : "text-green-400 bg-green-950 border-green-900"
          }`}>
            {TIER_LABEL[route.trust_tier] ?? route.trust_tier}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
          <span className="font-mono text-gray-400">{route.domain}</span>
          <span>{route.steps.length} step{route.steps.length !== 1 ? "s" : ""}</span>
          <span className={RISK_COLORS[route.risk_level] ?? "text-gray-400"}>{route.risk_level} risk</span>
          <span>Submitted {friendlyDate(route.submitted_for_review_at)}</span>
        </div>
      </div>

      {/* Workflow description */}
      {route.workflow_description && (
        <p className="text-xs text-gray-500 leading-relaxed">{route.workflow_description}</p>
      )}

      {/* Key signals */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <div className="flex items-center gap-1.5 text-gray-500">
          <span className="text-gray-700">·</span>
          <span>{route.approval_gates.length > 0
            ? `${route.approval_gates.length} approval gate${route.approval_gates.length !== 1 ? "s" : ""}`
            : "No approval gates"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-500">
          <span className="text-gray-700">·</span>
          <span>{route.forbidden_actions.length > 0
            ? `${route.forbidden_actions.length} forbidden action${route.forbidden_actions.length !== 1 ? "s" : ""}`
            : "No forbidden actions declared"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-500">
          <span className="text-gray-700">·</span>
          <span>{route.steps.some(s => s.value_policy?.type === "sensitive_redacted")
            ? "Sensitive values protected"
            : "No sensitive fields"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-500">
          <span className="text-gray-700">·</span>
          <span>{(route.variables?.length ?? 0) > 0
            ? `${route.variables!.length} variable${route.variables!.length !== 1 ? "s" : ""}`
            : "No variables"}</span>
        </div>
      </div>

      {/* Note input */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Review note (optional)</label>
        <textarea
          ref={noteRef}
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          disabled={acting}
          placeholder="Reason for approval or rejection…"
          className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-xs text-gray-300 placeholder-gray-700 focus:outline-none focus:border-indigo-500 resize-none disabled:opacity-50"
        />
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">{error}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => handle("approved")}
          disabled={acting}
          className="text-xs px-4 py-2 rounded-md bg-cyan-700 hover:bg-cyan-600 text-white font-medium disabled:opacity-50 transition-colors"
        >
          {acting ? "…" : "Approve"}
        </button>
        <button
          onClick={() => handle("rejected")}
          disabled={acting}
          className="text-xs px-4 py-2 rounded-md border border-red-800 text-red-400 hover:bg-red-950 disabled:opacity-50 transition-colors"
        >
          {acting ? "…" : "Reject"}
        </button>
        <span className="text-xs text-gray-700 ml-auto font-mono">{route.route_id.slice(0, 16)}…</span>
      </div>
    </div>
  );
}

export default function MarketplaceReviewPage() {
  const [pending, setPending] = useState<AegisRoute[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listRoutes()
      .then(all => setPending(all.filter(r => r.marketplace_status === "pending_review")))
      .finally(() => setLoading(false));
  }, []);

  function handleDecision(routeId: string) {
    setPending(prev => prev.filter(r => r.route_id !== routeId));
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Marketplace Review</h1>
        <p className="mt-2 text-gray-400 text-sm leading-relaxed">
          Routes submitted for marketplace listing. Review each route and approve or reject.
        </p>
        <p className="mt-1 text-xs text-gray-600">
          Internal prototype queue — approval means marketplace-ready in the demo, not real legal or security certification.
        </p>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : pending.length === 0 ? (
        <div className="text-center py-14 text-gray-600 text-sm border border-dashed border-gray-800 rounded-xl space-y-1">
          <p className="text-gray-500">No routes pending review.</p>
          <p className="text-gray-700 text-xs">
            Verified routes can be submitted from the{" "}
            <a href="/rails" className="text-indigo-400 hover:underline">Recorded Skills</a> page.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-600">
            {pending.length} route{pending.length !== 1 ? "s" : ""} pending review
          </p>
          {pending.map(route => (
            <ReviewCard key={route.route_id} route={route} onDecision={handleDecision} />
          ))}
        </div>
      )}
    </div>
  );
}
