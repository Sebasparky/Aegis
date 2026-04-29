"use client";

import { useEffect, useState } from "react";
import type { AegisRoute, RouteStep, RouteVerificationReport, StepVerificationResult } from "@aegis/types";
import { listRoutes, recordRoute, deleteRoute, verifyRoute } from "../../lib/api";

const TIER_COLORS: Record<string, string> = {
  unverified_draft: "text-gray-400 bg-gray-800 border-gray-700",
  community: "text-blue-400 bg-blue-950 border-blue-900",
  aegis_scanned: "text-cyan-400 bg-cyan-950 border-cyan-900",
  aegis_reviewed: "text-green-400 bg-green-950 border-green-900",
  run_verified: "text-emerald-400 bg-emerald-950 border-emerald-900",
  business_official: "text-purple-400 bg-purple-950 border-purple-900",
};

const RISK_COLORS: Record<string, string> = {
  low: "text-green-400",
  medium: "text-yellow-400",
  high: "text-orange-400",
  critical: "text-red-400",
};

function ValuePolicyBadge({ policy }: { policy: RouteStep["value_policy"] }) {
  if (!policy) return null;
  const colors: Record<string, string> = {
    sensitive_redacted: "text-red-400 bg-red-950 border-red-900",
    runtime_variable: "text-yellow-400 bg-yellow-950 border-yellow-900",
    safe_literal: "text-green-400 bg-green-950 border-green-900",
    enum_selection: "text-blue-400 bg-blue-950 border-blue-900",
    user_approval_required: "text-orange-400 bg-orange-950 border-orange-900",
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${colors[policy.type] ?? ""}`}>
      {policy.type}
    </span>
  );
}

function StepRow({ step }: { step: RouteStep }) {
  const locType = step.target.preferred_locator.type;
  const locDisplay =
    step.target.preferred_locator.name ??
    step.target.preferred_locator.value ??
    `${step.target.preferred_locator.role ?? ""}`;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-gray-800 last:border-0">
      <span className="shrink-0 w-6 h-6 flex items-center justify-center bg-gray-800 rounded text-xs text-gray-400 font-mono">
        {step.order}
      </span>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-indigo-300">{step.action}</span>
          <span className="text-xs text-gray-400 truncate">{step.intent}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-600">
            {locType}:{" "}
            <span className="text-gray-400 font-mono truncate">{locDisplay}</span>
          </span>
          <span className="text-xs text-gray-600">
            conf: <span className={step.target.confidence >= 0.8 ? "text-green-400" : "text-yellow-400"}>
              {(step.target.confidence * 100).toFixed(0)}%
            </span>
          </span>
          <ValuePolicyBadge policy={step.value_policy} />
        </div>
      </div>
    </div>
  );
}

function VerificationStepBadge({ result }: { result: StepVerificationResult }) {
  return (
    <span className={`shrink-0 text-xs font-mono ${result.passed ? "text-cyan-400" : "text-red-400"}`}>
      {result.passed ? "✓" : "✗"}
      {result.selected_locator && (
        <span className="text-gray-600 ml-1">via {result.selected_locator.type}</span>
      )}
      {result.locator_attempts.length > 1 && (
        <span className="text-gray-700 ml-1">({result.locator_attempts.length} attempts)</span>
      )}
    </span>
  );
}

function RouteCard({
  route,
  onDelete,
  onVerified,
}: {
  route: AegisRoute;
  onDelete: (id: string) => void;
  onVerified: (routeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyReport, setVerifyReport] = useState<RouteVerificationReport | null>(
    route.verification_report ?? null,
  );
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [localTier, setLocalTier] = useState(route.trust_tier);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteRoute(route.route_id);
      onDelete(route.route_id);
    } catch {
      setDeleting(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyError(null);
    try {
      const report = await verifyRoute(route.route_id);
      setVerifyReport(report);
      if (report.promoted_trust_tier) {
        setLocalTier(report.promoted_trust_tier);
      }
      onVerified(route.route_id);
    } catch (err: any) {
      setVerifyError(err.message ?? "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* Card header */}
      <div className="p-4 flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white truncate">{route.workflow_name}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded border font-mono ${TIER_COLORS[localTier] ?? TIER_COLORS.unverified_draft}`}
            >
              {localTier}
            </span>
            <span className={`text-xs font-medium ${RISK_COLORS[route.risk_level] ?? "text-gray-400"}`}>
              {route.risk_level} risk
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
            <span>
              Domain: <span className="text-gray-400 font-mono">{route.domain}</span>
            </span>
            <span>
              Steps: <span className="text-gray-400">{route.steps.length}</span>
            </span>
            {route.forbidden_actions.length > 0 && (
              <span>
                Forbidden: <span className="text-red-400">{route.forbidden_actions.length}</span>
              </span>
            )}
            <span>
              Created: <span className="text-gray-400">{new Date(route.created_at).toLocaleString()}</span>
            </span>
            {verifyReport && (
              <span>
                Verified:{" "}
                <span className="text-gray-400">
                  {new Date(verifyReport.completed_at).toLocaleString()}
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs px-3 py-1.5 rounded-md border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
          >
            {expanded ? "Collapse" : "Details"}
          </button>
          <button
            onClick={handleVerify}
            disabled={verifying || deleting}
            className="text-xs px-3 py-1.5 rounded-md border border-indigo-800 text-indigo-400 hover:bg-indigo-950 disabled:opacity-50 transition-colors"
          >
            {verifying ? "Verifying…" : "Verify"}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting || verifying}
            className="text-xs px-3 py-1.5 rounded-md border border-red-900 text-red-500 hover:bg-red-950 disabled:opacity-50 transition-colors"
          >
            {deleting ? "…" : "Delete"}
          </button>
        </div>
      </div>

      {/* Verification status strip */}
      {(verifyReport || verifyError) && (
        <div className={`mx-4 mb-3 px-3 py-2 rounded text-xs border ${
          verifyError
            ? "text-red-300 bg-red-950 border-red-900"
            : verifyReport!.passed
            ? "text-cyan-300 bg-cyan-950 border-cyan-900"
            : "text-red-300 bg-red-950 border-red-900"
        }`}>
          {verifyError ? (
            <span>✗ Verification error: {verifyError}</span>
          ) : verifyReport!.passed ? (
            <span>
              ✓ Verification passed —{" "}
              {verifyReport!.step_results.filter((s) => s.passed).length}/{verifyReport!.step_results.length} steps
              {verifyReport!.promoted_trust_tier && (
                <span className="ml-2 text-cyan-400 font-mono">
                  → {verifyReport!.promoted_trust_tier}
                </span>
              )}
            </span>
          ) : (
            <span>
              ✗ Verification failed —{" "}
              {verifyReport!.step_results.filter((s) => s.passed).length}/{verifyReport!.step_results.length} steps passed
              {verifyReport!.errors.length > 0 && (
                <span className="block mt-1 text-red-400">{verifyReport!.errors[0]}</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 pb-4 pt-3 space-y-4">
          {/* Steps */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Steps
            </h3>
            <div>
              {route.steps.map((step) => {
                const vResult = verifyReport?.step_results.find((r) => r.step_id === step.step_id);
                return (
                  <div key={step.step_id} className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <StepRow step={step} />
                    </div>
                    {vResult && (
                      <div className="shrink-0 pt-2.5">
                        <VerificationStepBadge result={vResult} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Permissions */}
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-gray-500 uppercase tracking-wider mb-1 font-medium">Allowed actions</p>
              <div className="flex flex-wrap gap-1">
                {route.allowed_actions.length === 0 ? (
                  <span className="text-gray-600">none</span>
                ) : (
                  route.allowed_actions.map((a) => (
                    <span key={a} className="px-1.5 py-0.5 bg-green-950 border border-green-900 text-green-400 rounded font-mono">
                      {a}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div>
              <p className="text-gray-500 uppercase tracking-wider mb-1 font-medium">Forbidden actions</p>
              <div className="flex flex-wrap gap-1">
                {route.forbidden_actions.length === 0 ? (
                  <span className="text-gray-600">none</span>
                ) : (
                  route.forbidden_actions.map((a) => (
                    <span key={a} className="px-1.5 py-0.5 bg-red-950 border border-red-900 text-red-400 rounded font-mono">
                      {a}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Approval gates */}
          {route.approval_gates.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1 font-medium">Approval gates</p>
              {route.approval_gates.map((gate) => (
                <div key={gate.step_id} className="text-xs text-amber-400 bg-amber-950 border border-amber-900 rounded px-2 py-1">
                  Step {gate.step_id} — {gate.reason} ({gate.risk_level})
                </div>
              ))}
            </div>
          )}

          {/* Route ID */}
          <p className="text-xs text-gray-600 font-mono">
            ID: {route.route_id} · v{route.version}
          </p>
        </div>
      )}
    </div>
  );
}

export default function RailsPage() {
  const [routes, setRoutes] = useState<AegisRoute[]>([]);
  const [loading, setLoading] = useState(true);

  const [showRecorder, setShowRecorder] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileResult, setCompileResult] = useState<{
    route_id: string;
    step_count: number;
    trust_tier: string;
    forbidden_action_count: number;
  } | null>(null);

  useEffect(() => {
    listRoutes()
      .then(setRoutes)
      .finally(() => setLoading(false));
  }, []);

  function handleDelete(routeId: string) {
    setRoutes((prev) => prev.filter((r) => r.route_id !== routeId));
  }

  function handleVerified(_routeId: string) {
    // Refresh the route list so the persisted trust_tier and verification_report are reflected
    listRoutes().then(setRoutes).catch(() => {});
  }

  async function handleCompile(e: React.FormEvent) {
    e.preventDefault();
    setCompiling(true);
    setCompileError(null);
    setCompileResult(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonInput);
    } catch {
      setCompileError("Invalid JSON — paste the recording payload from the demo banking page.");
      setCompiling(false);
      return;
    }

    try {
      const result = await recordRoute(parsed as any);
      setCompileResult(result);
      const updated = await listRoutes();
      setRoutes(updated);
    } catch (err: any) {
      setCompileError(err.message ?? "Compilation failed.");
    } finally {
      setCompiling(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Aegis Rails</h1>
        <p className="mt-2 text-gray-400 text-sm leading-relaxed">
          Verified workflow routes for AI agents. A human demonstrates a workflow once — Aegis
          captures semantic telemetry and compiles it into a structured, inspectable route that
          agents can discover and follow.
        </p>
        <div className="mt-3 flex gap-3 text-xs text-gray-500">
          <span className="text-indigo-400">Teach once.</span>
          <span className="text-gray-600">·</span>
          <span className="text-indigo-400">Compile into a declarative route.</span>
          <span className="text-gray-600">·</span>
          <span className="text-indigo-400">Agents follow verified paths.</span>
        </div>
      </div>

      {/* What are Rails? */}
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-2 text-sm text-gray-400">
        <h2 className="text-white font-medium text-sm">What are Aegis Rails?</h2>
        <ul className="space-y-1.5 list-disc list-inside">
          <li>Routes are <strong className="text-gray-300">declarative</strong> — not executable scripts. Every step is readable, diffable, and enforceable.</li>
          <li>Routes declare <strong className="text-gray-300">forbidden actions</strong> explicitly — dangerous buttons like Transfer Money are identified at record time and blocked during execution.</li>
          <li>Sensitive field values are <strong className="text-gray-300">never stored</strong> — password and payment fields produce <code className="text-red-400 font-mono">sensitive_redacted</code> policies, not raw values.</li>
        </ul>
      </section>

      {/* Demo Recorder */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-white">New Recording</h2>
          <button
            onClick={() => { setShowRecorder((v) => !v); setCompileResult(null); setCompileError(null); }}
            className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            {showRecorder ? "Cancel" : "Record Workflow"}
          </button>
        </div>

        {showRecorder && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
            <div className="bg-gray-950 border border-indigo-900 rounded-lg p-4 text-sm space-y-2">
              <p className="text-indigo-300 font-medium">How to record a workflow</p>
              <ol className="list-decimal list-inside space-y-1 text-gray-400 text-sm">
                <li>
                  Open the{" "}
                  <a
                    href="http://localhost:3001/bank.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-400 hover:text-indigo-300 underline"
                  >
                    AegisDemo Banking page
                  </a>{" "}
                  in a new tab.
                </li>
                <li>Click <strong className="text-gray-300">Start Recording</strong> in the Aegis Recorder panel (bottom-right).</li>
                <li>
                  Perform the safe workflow:{" "}
                  <span className="text-gray-300">Statements tab → select month → Download Statement</span>
                </li>
                <li>Click <strong className="text-gray-300">Stop Recording</strong>, then click <strong className="text-gray-300">Copy JSON</strong>.</li>
                <li>Paste the JSON below and click <strong className="text-gray-300">Compile Route</strong>.</li>
              </ol>
            </div>

            <form onSubmit={handleCompile} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Recording payload JSON</label>
                <textarea
                  className="w-full h-40 bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-xs text-gray-300 font-mono focus:outline-none focus:border-indigo-500 resize-y"
                  placeholder='{ "workflow_name": "...", "domain": "localhost", "events": [...] }'
                  value={jsonInput}
                  onChange={(e) => setJsonInput(e.target.value)}
                />
              </div>

              {compileError && (
                <p className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">
                  {compileError}
                </p>
              )}

              {compileResult && (
                <div className="text-xs bg-green-950 border border-green-900 rounded px-3 py-2 space-y-1">
                  <p className="text-green-300 font-medium">Route compiled and saved</p>
                  <p className="text-green-400 font-mono">{compileResult.route_id}</p>
                  <p className="text-gray-400">
                    {compileResult.step_count} steps · trust_tier: {compileResult.trust_tier}
                    {compileResult.forbidden_action_count > 0 &&
                      ` · ${compileResult.forbidden_action_count} forbidden action${compileResult.forbidden_action_count !== 1 ? "s" : ""} detected`}
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={compiling || !jsonInput.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-md transition-colors"
              >
                {compiling ? "Compiling…" : "Compile Route"}
              </button>
            </form>
          </div>
        )}
      </section>

      {/* Saved Routes */}
      <section>
        <h2 className="text-base font-semibold text-white mb-4">Saved Routes</h2>
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : routes.length === 0 ? (
          <div className="text-center py-12 text-gray-600 text-sm border border-dashed border-gray-800 rounded-lg">
            <p>No routes recorded yet.</p>
            <p className="text-gray-700 mt-1 text-xs">
              Open the demo banking page, record a workflow, and compile it above.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {routes.map((route) => (
              <RouteCard key={route.route_id} route={route} onDelete={handleDelete} onVerified={handleVerified} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
