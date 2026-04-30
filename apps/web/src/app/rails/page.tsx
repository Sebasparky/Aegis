"use client";

import { useEffect, useRef, useState } from "react";
import type { AegisRoute, ActionType, RouteStep, RouteVerificationReport, StepVerificationResult } from "@aegis/types";
import { listRoutes, recordRoute, deleteRoute, verifyRoute, patchRoute } from "../../lib/api";

// ─── Trust tier → friendly label ─────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = {
  unverified_draft: "Draft",
  community: "Community",
  aegis_scanned: "Verified",
  aegis_reviewed: "Reviewed",
  run_verified: "Run Verified",
  business_official: "Business Official",
};

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

// ─── Action type → plain-English label ───────────────────────────────────────

const ACTION_LABELS: Partial<Record<ActionType, string>> = {
  browse: "Browse pages",
  search: "Search",
  read: "Read content",
  compare: "Compare items",
  draft: "Draft text",
  add_to_cart: "Add to cart",
  login: "Log in",
  purchase: "Complete a purchase",
  payment: "Make a payment",
  subscription: "Start a subscription",
  post_publicly: "Post publicly",
  comment: "Post a comment",
  direct_message: "Send a direct message",
  send_email: "Send an email",
  forward_email: "Forward an email",
  upload_file: "Upload a file",
  download_file: "Download a file",
  submit_form: "Submit a form",
  create_account: "Create an account",
  share_email: "Share your email address",
  share_phone: "Share your phone number",
  share_address: "Share your address",
  identity_disclosure: "Disclose your identity",
  government_id_upload: "Upload a government ID",
  medical_data_disclosure: "Share medical data",
  financial_data_disclosure: "Share financial data",
  account_setting_change: "Change account settings",
  delete_account: "Delete an account",
  connect_app: "Connect an external app",
  oauth_authorize: "Authorize via OAuth",
};

function friendlyAction(a: ActionType): string {
  return ACTION_LABELS[a] ?? a;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function friendlyDate(iso: string | undefined): string {
  if (!iso || iso === "1970-01-01T00:00:00.000Z") return "Never";
  return new Date(iso).toLocaleString();
}

function stepDescription(step: RouteStep): string {
  if (step.description && step.description.trim()) return step.description;
  const intentLabel = step.intent.replace(/_/g, " ");
  return `${step.action} — ${intentLabel}`;
}

// ─── Route capability helpers ─────────────────────────────────────────────────

function routeOrigin(domain: string): 'local' | 'wikipedia' | 'external' {
  if (domain === 'localhost' || domain === '127.0.0.1') return 'local';
  if (domain === 'en.wikipedia.org') return 'wikipedia';
  return 'external';
}

function hasVisualReplay(domain: string): boolean {
  const o = routeOrigin(domain);
  return o === 'local' || o === 'wikipedia';
}

const VERIFIED_TIERS = new Set(['aegis_scanned', 'aegis_reviewed', 'run_verified', 'business_official']);

function isRouteVerified(tier: string): boolean {
  return VERIFIED_TIERS.has(tier);
}

function hasSensitiveValues(steps: RouteStep[]): boolean {
  return steps.some(s => s.value_policy?.type === 'sensitive_redacted');
}

function hasFillSteps(steps: RouteStep[]): boolean {
  return steps.some(s => s.action === 'fill');
}

function locatorQuality(steps: RouteStep[]): { high: number; low: number } {
  let high = 0, low = 0;
  for (const step of steps) {
    const t = step.target.preferred_locator.type;
    if (t === 'role' || t === 'label' || t === 'placeholder') high++;
    else low++;
  }
  return { high, low };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ tier }: { tier: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-medium ${TIER_COLORS[tier] ?? TIER_COLORS.unverified_draft}`}>
      {TIER_LABEL[tier] ?? tier}
    </span>
  );
}

function PrivateBadge() {
  return (
    <span className="text-xs px-2 py-0.5 rounded border border-gray-700 text-gray-500 bg-gray-800">
      Private
    </span>
  );
}

function StepRow({ step }: { step: RouteStep }) {
  const locType = step.target.preferred_locator.type;
  const locDisplay =
    step.target.preferred_locator.name ??
    step.target.preferred_locator.value ??
    step.target.preferred_locator.role ?? "";

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
            {locType}: <span className="text-gray-400 font-mono truncate">{locDisplay}</span>
          </span>
          <span className="text-xs text-gray-600">
            conf:{" "}
            <span className={step.target.confidence >= 0.8 ? "text-green-400" : "text-yellow-400"}>
              {(step.target.confidence * 100).toFixed(0)}%
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function VerificationStepRow({ step, result }: { step: RouteStep; result: StepVerificationResult }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1 border-b border-gray-800 last:border-0">
      <span className={`shrink-0 w-4 text-center font-mono ${result.passed ? "text-cyan-400" : "text-red-400"}`}>
        {result.passed ? "✓" : "✗"}
      </span>
      <span className="text-gray-400 flex-1 truncate">{step.intent.replace(/_/g, " ")}</span>
      {result.selected_locator && (
        <span className="text-gray-600 font-mono shrink-0">
          via {result.selected_locator.type}
        </span>
      )}
      {result.locator_attempts.length > 1 && (
        <span className="text-gray-700 shrink-0">
          ({result.locator_attempts.length} attempts)
        </span>
      )}
    </div>
  );
}

// ─── Health Row ───────────────────────────────────────────────────────────────

function HealthRow({
  ok,
  label,
  detail,
  neutral = false,
}: {
  ok: boolean;
  label: string;
  detail?: string;
  neutral?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={`shrink-0 font-mono mt-0.5 w-3 text-center ${neutral ? 'text-gray-600' : ok ? 'text-green-400' : 'text-yellow-500'}`}>
        {neutral ? '·' : ok ? '✓' : '○'}
      </span>
      <div className="min-w-0">
        <span className={`font-medium ${neutral ? 'text-gray-500' : ok ? 'text-gray-300' : 'text-yellow-300'}`}>
          {label}
        </span>
        {detail && <span className="text-gray-600 ml-1.5">{detail}</span>}
      </div>
    </div>
  );
}

// ─── Capability Badges ────────────────────────────────────────────────────────

function CapabilityBadges({ route }: { route: AegisRoute }) {
  const origin = routeOrigin(route.domain);
  const visualReplay = hasVisualReplay(route.domain);
  const parameterized = (route.variables?.length ?? 0) > 0;
  const sensProtected = hasSensitiveValues(route.steps);
  const hasFills = hasFillSteps(route.steps);

  return (
    <div className="flex flex-wrap gap-1.5">
      {origin === 'local' && (
        <span className="text-xs px-2 py-0.5 rounded border text-teal-400 bg-teal-950 border-teal-900">
          Local demo
        </span>
      )}
      {origin === 'wikipedia' && (
        <span className="text-xs px-2 py-0.5 rounded border text-blue-400 bg-blue-950 border-blue-900">
          Wikipedia
        </span>
      )}
      {origin === 'external' && (
        <span className="text-xs px-2 py-0.5 rounded border text-gray-500 bg-gray-800 border-gray-700">
          External site
        </span>
      )}
      {visualReplay && (
        <span className="text-xs px-2 py-0.5 rounded border text-indigo-400 bg-indigo-950 border-indigo-800">
          Visual replay
        </span>
      )}
      {parameterized && (
        <span className="text-xs px-2 py-0.5 rounded border text-purple-400 bg-purple-950 border-purple-900">
          Parameterized
        </span>
      )}
      {sensProtected && (
        <span className="text-xs px-2 py-0.5 rounded border text-amber-400 bg-amber-950 border-amber-900">
          Sensitive values protected
        </span>
      )}
      {!sensProtected && hasFills && (
        <span className="text-xs px-2 py-0.5 rounded border text-gray-500 bg-gray-800 border-gray-700">
          No sensitive fields
        </span>
      )}
    </div>
  );
}

// ─── Preview Panel ────────────────────────────────────────────────────────────

function PreviewPanel({ route, verifyReport }: { route: AegisRoute; verifyReport: RouteVerificationReport | null }) {
  const origin = routeOrigin(route.domain);
  const visualReplay = hasVisualReplay(route.domain);
  const verified = isRouteVerified(route.trust_tier);
  const sensProtected = hasSensitiveValues(route.steps);
  const hasVars = (route.variables?.length ?? 0) > 0;
  const { high: highLocators, low: lowLocators } = locatorQuality(route.steps);

  return (
    <div className="border-t border-gray-800 bg-gray-950 px-5 py-4 space-y-5">
      {/* What this skill does */}
      <div>
        <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">
          What this skill does
        </h4>
        {route.workflow_description && (
          <p className="text-sm text-gray-400 mb-3 leading-relaxed">{route.workflow_description}</p>
        )}
        <ol className="space-y-1.5">
          {route.steps.map((step) => (
            <li key={step.step_id} className="flex items-start gap-2.5 text-sm text-gray-300">
              <span className="shrink-0 w-5 h-5 flex items-center justify-center rounded bg-gray-800 text-xs text-gray-500 font-mono mt-0.5">
                {step.order}
              </span>
              <span className="leading-relaxed">{stepDescription(step)}</span>
              {step.approval_required && (
                <span className="shrink-0 text-xs text-amber-400 bg-amber-950 border border-amber-900 rounded px-1.5 py-0.5 mt-0.5">
                  requires approval
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      {/* What this skill will not do */}
      <div>
        <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">
          What this skill will not do
        </h4>
        {route.forbidden_actions.length === 0 ? (
          <p className="text-sm text-gray-600">No explicit restrictions recorded.</p>
        ) : (
          <ul className="space-y-1">
            {route.forbidden_actions.map((a) => (
              <li key={a} className="flex items-center gap-2 text-sm text-red-400">
                <span className="text-red-700">✗</span>
                {friendlyAction(a)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Approval required before */}
      <div>
        <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">
          Approval required before
        </h4>
        {route.approval_gates.length === 0 ? (
          <p className="text-sm text-gray-600">No approval gates on this skill.</p>
        ) : (
          <ul className="space-y-1.5">
            {route.approval_gates.map((gate) => (
              <li key={gate.step_id} className="text-sm text-amber-300 bg-amber-950 border border-amber-900 rounded px-3 py-1.5">
                {gate.reason}
                <span className={`ml-2 text-xs ${RISK_COLORS[gate.risk_level] ?? "text-gray-400"}`}>
                  ({gate.risk_level} risk)
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Required permissions */}
      {route.required_permissions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">
            Required permissions
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {route.required_permissions.map((p) => (
              <span key={p} className="text-xs px-2 py-0.5 rounded border border-indigo-800 text-indigo-300 bg-indigo-950">
                {friendlyAction(p)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Route Health */}
      <div>
        <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">
          Route Health
        </h4>
        <div className="space-y-1.5">
          <HealthRow
            ok={true}
            label="Domain locked"
            detail={`Restricted to ${route.domain}`}
          />
          <HealthRow
            ok={verified}
            label={verified ? `Verified — ${TIER_LABEL[route.trust_tier] ?? route.trust_tier}` : "Not yet verified"}
            detail={verified ? undefined : "Run Verify to confirm all steps resolve"}
          />
          <HealthRow
            ok={visualReplay}
            label={visualReplay ? "Visual replay available" : "Visual replay not supported"}
            detail={
              origin === 'local' ? "Via demo bank page" :
              origin === 'wikipedia' ? "Via Chrome extension" :
              "Not yet supported for this domain"
            }
          />
          <HealthRow
            ok={sensProtected}
            label={sensProtected ? "Sensitive values protected" : "No sensitive fields detected"}
            detail={
              sensProtected
                ? "Redacted at record time; supplied at runtime"
                : "All recorded values are safe literals or selectors"
            }
          />
          <HealthRow
            ok={hasVars}
            label={
              hasVars
                ? `Parameterized — ${route.variables!.length} variable${route.variables!.length !== 1 ? 's' : ''}`
                : "No variables"
            }
            detail={hasVars ? "Route accepts runtime inputs" : "Route uses fixed recorded values"}
            neutral={!hasVars}
          />
          <HealthRow
            ok={lowLocators === 0}
            label={
              lowLocators === 0
                ? `${highLocators} semantic locator${highLocators !== 1 ? 's' : ''}`
                : `${lowLocators} fragile locator${lowLocators !== 1 ? 's' : ''}`
            }
            detail={
              lowLocators === 0
                ? "All steps use role, label, or placeholder targeting"
                : `${lowLocators} step${lowLocators !== 1 ? 's' : ''} use css/xpath — may break on layout changes`
            }
          />
        </div>
      </div>

      {/* Verification summary */}
      {verifyReport && (
        <div>
          <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">
            Verification summary
          </h4>
          <div className={`rounded px-3 py-2 text-xs border mb-2 ${
            verifyReport.passed
              ? "text-cyan-300 bg-cyan-950 border-cyan-900"
              : "text-red-300 bg-red-950 border-red-900"
          }`}>
            {verifyReport.passed
              ? `Aegis verified this skill — ${verifyReport.step_results.filter(r => r.passed).length}/${verifyReport.step_results.length} steps passed`
              : `Verification failed — ${verifyReport.step_results.filter(r => r.passed).length}/${verifyReport.step_results.length} steps passed`}
          </div>
          <div className="border border-gray-800 rounded divide-y divide-gray-800">
            {verifyReport.step_results.map((result) => {
              const step = route.steps.find(s => s.step_id === result.step_id);
              if (!step) return null;
              return <VerificationStepRow key={result.step_id} step={step} result={result} />;
            })}
          </div>
          <p className="text-xs text-gray-600 mt-1.5">
            Last verified: {friendlyDate(verifyReport.completed_at)}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Rename Modal ─────────────────────────────────────────────────────────────

function RenameModal({
  current,
  onSave,
  onCancel,
}: {
  current: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) { setError("Name cannot be empty."); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err: any) {
      setError(err.message ?? "Save failed.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">Rename skill</h3>
        <form onSubmit={handleSave} className="space-y-3">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            placeholder="Skill name"
            disabled={saving}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="text-xs px-4 py-2 rounded-md border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !value.trim()}
              className="text-xs px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Skill Card ───────────────────────────────────────────────────────────────

function SkillCard({
  route,
  onDelete,
  onVerified,
  onRenamed,
}: {
  route: AegisRoute;
  onDelete: (id: string) => void;
  onVerified: (routeId: string) => void;
  onRenamed: (routeId: string, newName: string) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyReport, setVerifyReport] = useState<RouteVerificationReport | null>(
    route.verification_report ?? null,
  );
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [localTier, setLocalTier] = useState(route.trust_tier);
  const [localName, setLocalName] = useState(route.workflow_name);

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

  async function handleRename(newName: string) {
    await patchRoute(route.route_id, { workflow_name: newName });
    setLocalName(newName);
    onRenamed(route.route_id, newName);
    setShowRename(false);
  }

  const lastVerified = verifyReport?.completed_at ?? route.last_verified_at;
  const hasVerification = !!verifyReport;

  return (
    <>
      {showRename && (
        <RenameModal
          current={localName}
          onSave={handleRename}
          onCancel={() => setShowRename(false)}
        />
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {/* Card header */}
        <div className="p-4 space-y-3">
          {/* Name row */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5 min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-white truncate">{localName}</span>
                <StatusBadge tier={localTier} />
                <PrivateBadge />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
                <span>
                  <span className="font-mono text-gray-400">{route.domain}</span>
                </span>
                <span>
                  {route.steps.length} step{route.steps.length !== 1 ? "s" : ""}
                </span>
                <span className={RISK_COLORS[route.risk_level] ?? "text-gray-400"}>
                  {route.risk_level} risk
                </span>
                <span>
                  {hasVerification
                    ? `Verified ${friendlyDate(lastVerified)}`
                    : "Not yet verified"}
                </span>
              </div>
            </div>
          </div>

          {/* Capability badges */}
          <CapabilityBadges route={{ ...route, trust_tier: localTier }} />

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { setShowPreview(v => !v); setShowAdvanced(false); }}
              className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                showPreview
                  ? "border-indigo-600 text-indigo-300 bg-indigo-950"
                  : "border-gray-700 text-gray-400 hover:text-white hover:border-gray-500"
              }`}
            >
              {showPreview ? "Hide preview" : "Preview"}
            </button>
            {(route.domain === "localhost" || route.domain === "127.0.0.1") && (
              <a
                href={`http://localhost:3001/bank?previewRoute=${encodeURIComponent(route.route_id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 rounded-md border border-indigo-800 text-indigo-400 hover:bg-indigo-950 transition-colors"
              >
                Open visual replay
              </a>
            )}
            {route.domain === "en.wikipedia.org" && (
              <a
                href={`https://en.wikipedia.org/wiki/Main_Page#aegis-preview=${encodeURIComponent(route.route_id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 rounded-md border border-indigo-800 text-indigo-400 hover:bg-indigo-950 transition-colors"
              >
                Open external replay
              </a>
            )}
            <button
              onClick={handleVerify}
              disabled={verifying || deleting}
              className="text-xs px-3 py-1.5 rounded-md border border-indigo-800 text-indigo-400 hover:bg-indigo-950 disabled:opacity-50 transition-colors"
            >
              {verifying ? "Verifying…" : "Verify"}
            </button>
            <button
              onClick={() => setShowRename(true)}
              disabled={deleting || verifying}
              className="text-xs px-3 py-1.5 rounded-md border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-50 transition-colors"
            >
              Rename
            </button>
            <span
              title="Marketplace submission will require Aegis verification, Aegis review, and a route safety audit."
              className="inline-block"
            >
              <button
                disabled
                className="text-xs px-3 py-1.5 rounded-md border border-gray-800 text-gray-700 cursor-not-allowed"
              >
                Submit for Review
              </button>
            </span>
            <button
              onClick={handleDelete}
              disabled={deleting || verifying}
              className="text-xs px-3 py-1.5 rounded-md border border-red-900 text-red-500 hover:bg-red-950 disabled:opacity-50 transition-colors ml-auto"
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
              <span>Verification error: {verifyError}</span>
            ) : verifyReport!.passed ? (
              <span>
                Verification passed —{" "}
                {verifyReport!.step_results.filter(s => s.passed).length}/{verifyReport!.step_results.length} steps
                {verifyReport!.promoted_trust_tier && (
                  <span className="ml-2 text-cyan-400 font-medium">
                    → {TIER_LABEL[verifyReport!.promoted_trust_tier] ?? verifyReport!.promoted_trust_tier}
                  </span>
                )}
              </span>
            ) : (
              <span>
                Verification failed —{" "}
                {verifyReport!.step_results.filter(s => s.passed).length}/{verifyReport!.step_results.length} steps passed
                {verifyReport!.errors.length > 0 && (
                  <span className="block mt-1 text-red-400">{verifyReport!.errors[0]}</span>
                )}
              </span>
            )}
          </div>
        )}

        {/* Preview panel */}
        {showPreview && (
          <PreviewPanel route={{ ...route, workflow_name: localName }} verifyReport={verifyReport} />
        )}

        {/* Advanced route details */}
        <div className="border-t border-gray-800">
          <button
            onClick={() => { setShowAdvanced(v => !v); setShowPreview(false); }}
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            <span>Advanced route details</span>
            <span>{showAdvanced ? "▲" : "▼"}</span>
          </button>

          {showAdvanced && (
            <div className="px-4 pb-4 pt-1 space-y-4">
              {/* Steps */}
              <div>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Steps</h3>
                <div>
                  {route.steps.map((step) => {
                    const vResult = verifyReport?.step_results.find(r => r.step_id === step.step_id);
                    return (
                      <div key={step.step_id} className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <StepRow step={step} />
                        </div>
                        {vResult && (
                          <div className="shrink-0 pt-2.5">
                            <span className={`text-xs font-mono ${vResult.passed ? "text-cyan-400" : "text-red-400"}`}>
                              {vResult.passed ? "✓" : "✗"}
                              {vResult.selected_locator && (
                                <span className="text-gray-600 ml-1">via {vResult.selected_locator.type}</span>
                              )}
                            </span>
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
                      route.allowed_actions.map(a => (
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
                      route.forbidden_actions.map(a => (
                        <span key={a} className="px-1.5 py-0.5 bg-red-950 border border-red-900 text-red-400 rounded font-mono">
                          {a}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Route ID */}
              <p className="text-xs text-gray-700 font-mono">
                ID: {route.route_id} · v{route.version}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RailsPage() {
  const [routes, setRoutes] = useState<AegisRoute[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAdvancedRecorder, setShowAdvancedRecorder] = useState(false);
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
    setRoutes(prev => prev.filter(r => r.route_id !== routeId));
  }

  function handleVerified(_routeId: string) {
    listRoutes().then(setRoutes).catch(() => {});
  }

  function handleRenamed(routeId: string, newName: string) {
    setRoutes(prev => prev.map(r => r.route_id === routeId ? { ...r, workflow_name: newName } : r));
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
      setCompileError("Invalid JSON — paste the recording payload from the demo bank page.");
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
        <h1 className="text-2xl font-semibold text-white">Recorded Skills</h1>
        <p className="mt-2 text-gray-400 text-sm leading-relaxed">
          Teach Aegis a workflow once, verify it, then let agents follow it safely.
        </p>
      </div>

      {/* How it works — flow chips */}
      <div className="flex items-center gap-0 overflow-x-auto">
        {[
          { step: "1", label: "Record", sub: "Demonstrate a workflow on the demo bank page" },
          { step: "2", label: "Verify", sub: "Aegis replays it and confirms every step resolves" },
          { step: "3", label: "Preview", sub: "Inspect what the skill does in plain English" },
          { step: "4", label: "Keep or submit", sub: "Stay private or submit for marketplace review" },
        ].map((item, i, arr) => (
          <div key={item.step} className="flex items-center shrink-0">
            <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-center min-w-[140px]">
              <div className="flex items-center justify-center gap-1.5 mb-1">
                <span className="w-5 h-5 flex items-center justify-center rounded-full bg-indigo-900 text-indigo-300 text-xs font-bold">
                  {item.step}
                </span>
                <span className="text-xs font-semibold text-white">{item.label}</span>
              </div>
              <p className="text-xs text-gray-600 leading-snug">{item.sub}</p>
            </div>
            {i < arr.length - 1 && (
              <span className="text-gray-700 mx-1 text-sm shrink-0">→</span>
            )}
          </div>
        ))}
      </div>

      {/* Record a new skill */}
      <section>
        <h2 className="text-base font-semibold text-white mb-4">Record a new skill</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex-1 space-y-2">
              <p className="text-sm text-gray-300 leading-relaxed">
                Open the demo bank page, click <strong className="text-white">Start Recording</strong>, perform
                the workflow, then click <strong className="text-white">Stop Recording</strong> and{" "}
                <strong className="text-white">Submit to Aegis</strong>. Return here when done.
              </p>
              <p className="text-xs text-gray-600">
                Aegis captures semantic telemetry — element roles, labels, and accessibility context — not raw
                coordinates or screenshots.
              </p>
            </div>
            <a
              href="http://localhost:3001/bank.html"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors font-medium"
            >
              Open demo bank page ↗
            </a>
          </div>

          {/* Advanced: JSON paste */}
          <div className="border-t border-gray-800 pt-3">
            <button
              onClick={() => { setShowAdvancedRecorder(v => !v); setCompileResult(null); setCompileError(null); }}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
            >
              <span>{showAdvancedRecorder ? "▲" : "▼"}</span>
              <span>Advanced — paste recording JSON manually</span>
            </button>

            {showAdvancedRecorder && (
              <form onSubmit={handleCompile} className="mt-3 space-y-3">
                <p className="text-xs text-gray-500">
                  If the bank page's Submit button doesn't reach Aegis automatically, copy the JSON from the
                  recorder panel and paste it here.
                </p>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Recording payload JSON</label>
                  <textarea
                    className="w-full h-36 bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-xs text-gray-300 font-mono focus:outline-none focus:border-indigo-500 resize-y"
                    placeholder='{ "workflow_name": "...", "domain": "localhost", "events": [...] }'
                    value={jsonInput}
                    onChange={e => setJsonInput(e.target.value)}
                  />
                </div>

                {compileError && (
                  <p className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">
                    {compileError}
                  </p>
                )}

                {compileResult && (
                  <div className="text-xs bg-green-950 border border-green-900 rounded px-3 py-2 space-y-0.5">
                    <p className="text-green-300 font-medium">Skill compiled and saved</p>
                    <p className="text-gray-400">
                      {compileResult.step_count} steps · status: {TIER_LABEL[compileResult.trust_tier] ?? compileResult.trust_tier}
                      {compileResult.forbidden_action_count > 0 &&
                        ` · ${compileResult.forbidden_action_count} forbidden action${compileResult.forbidden_action_count !== 1 ? "s" : ""} identified`}
                    </p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={compiling || !jsonInput.trim()}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-md transition-colors"
                >
                  {compiling ? "Compiling…" : "Compile skill"}
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      {/* Saved Skills */}
      <section>
        <h2 className="text-base font-semibold text-white mb-4">
          Your recorded skills
          {routes.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-600">({routes.length})</span>
          )}
        </h2>

        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : routes.length === 0 ? (
          <div className="text-center py-14 text-gray-600 text-sm border border-dashed border-gray-800 rounded-xl space-y-1">
            <p className="text-gray-500">No skills recorded yet.</p>
            <p className="text-gray-700 text-xs">
              Open the demo bank page above, record a workflow, and it will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {routes.map(route => (
              <SkillCard
                key={route.route_id}
                route={route}
                onDelete={handleDelete}
                onVerified={handleVerified}
                onRenamed={handleRenamed}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
