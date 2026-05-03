import type {
  RuntimeCoverageSummary,
  RuntimeEventSensitivityKind,
  RuntimeEventType,
  RuntimeCoverageStatus,
  RuntimeIntervention,
  RuntimeCapabilityRelease,
  RuntimeCapabilityType,
} from "@aegis/types";
import { newId } from "../store/index.js";

export type RuntimeSessionStatus =
  | "created"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed";

export type RuntimeEventSensitivity = RuntimeEventSensitivityKind;

export type { RuntimeEventType, RuntimeCoverageStatus, RuntimeIntervention };

export interface RuntimeEvent {
  event_id: string;
  runtime_session_id: string;
  run_id?: string;
  user_id: string;
  domain: string;
  page_url: string;
  event_type: RuntimeEventType;
  sensitivity: RuntimeEventSensitivity;
  coverage_status: RuntimeCoverageStatus;
  severity: "info" | "warning" | "high" | "critical";
  element_hint?: string;
  reason: string;
  created_at: string;
  capability_type_required?: RuntimeCapabilityType;
  capability_release_id?: string;
  capability_release_present?: boolean;
}

export type { RuntimeCoverageSummary, RuntimeCapabilityRelease, RuntimeCapabilityType };

export interface RuntimeSession {
  runtime_session_id: string;
  run_id?: string;
  user_id: string;
  domain: string;
  start_url: string;
  status: RuntimeSessionStatus;
  execution_surface: "aegis_playwright";
  created_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;
  // Metadata-only event log — never contains field values.
  runtime_events: RuntimeEvent[];
  coverage_summary?: RuntimeCoverageSummary;
}

// Ephemeral for v1 — not persisted across API restarts.
// Receipts (durable audit records) are persisted by getReceiptRepository().
export const runtimeSessions = new Map<string, RuntimeSession>();

// All runtime events indexed by event_id.
export const runtimeEvents = new Map<string, RuntimeEvent>();

// All runtime interventions indexed by intervention_id.
// Created when uncovered high/critical sensitive events block a run.
export const runtimeInterventions = new Map<string, RuntimeIntervention>();

// Ephemeral capability releases for v1 — copied into receipts on run completion/failure.
export const runtimeCapabilityReleases = new Map<string, RuntimeCapabilityRelease>();

export function createRuntimeCapabilityRelease(
  fields: Omit<RuntimeCapabilityRelease, "capability_release_id" | "created_at" | "expires_at">
    & { expires_in_ms?: number }
): RuntimeCapabilityRelease {
  const now = Date.now();
  const { expires_in_ms, ...rest } = fields;
  const release: RuntimeCapabilityRelease = {
    capability_release_id: newId("caprel"),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + (expires_in_ms ?? 600_000)).toISOString(),
    ...rest,
  };
  runtimeCapabilityReleases.set(release.capability_release_id, release);
  return release;
}

export function getRuntimeCapabilityReleasesForRun(runId: string): RuntimeCapabilityRelease[] {
  return Array.from(runtimeCapabilityReleases.values()).filter((r) => r.run_id === runId);
}

export function findMatchingCapabilityRelease(args: {
  run_id: string;
  user_id: string;
  domain: string;
  capability_type: RuntimeCapabilityType;
  capability_ref?: string;
}): RuntimeCapabilityRelease | undefined {
  const now = Date.now();
  return Array.from(runtimeCapabilityReleases.values()).find(
    (r) =>
      r.run_id === args.run_id &&
      r.user_id === args.user_id &&
      r.domain === args.domain &&
      r.capability_type === args.capability_type &&
      r.released_to === "aegis_playwright_runtime" &&
      new Date(r.expires_at).getTime() > now &&
      (args.capability_ref === undefined || r.capability_ref === args.capability_ref)
  );
}

export function createRuntimeIntervention(
  fields: Omit<RuntimeIntervention, "intervention_id">
): RuntimeIntervention {
  const intervention: RuntimeIntervention = {
    intervention_id: newId("rtintv"),
    ...fields,
  };
  runtimeInterventions.set(intervention.intervention_id, intervention);
  return intervention;
}

export function createRuntimeSession(fields: {
  run_id?: string;
  user_id: string;
  domain: string;
  start_url: string;
}): RuntimeSession {
  const now = new Date().toISOString();
  const session: RuntimeSession = {
    runtime_session_id: newId("rtsession"),
    execution_surface: "aegis_playwright",
    status: "created",
    runtime_events: [],
    created_at: now,
    updated_at: now,
    ...fields,
  };
  runtimeSessions.set(session.runtime_session_id, session);
  return session;
}

const SEVERITY_ORDER = { info: 0, warning: 1, high: 2, critical: 3 } as const;

export function getCoverageSummary(runtimeSessionId: string): RuntimeCoverageSummary {
  const events = Array.from(runtimeEvents.values()).filter(
    (e) => e.runtime_session_id === runtimeSessionId
  );

  let highest: "info" | "warning" | "high" | "critical" = "info";
  let covered = 0;
  let uncovered = 0;
  let unknown = 0;
  const sensitivities = new Set<RuntimeEventSensitivity>();

  for (const e of events) {
    sensitivities.add(e.sensitivity);
    if (SEVERITY_ORDER[e.severity] > SEVERITY_ORDER[highest]) {
      highest = e.severity;
    }
    if (e.coverage_status === "covered_by_aegis") covered++;
    else if (e.coverage_status === "not_covered_by_aegis") uncovered++;
    else unknown++;
  }

  const interventionList = Array.from(runtimeInterventions.values()).filter(
    (i) => i.runtime_session_id === runtimeSessionId
  );

  return {
    sensitive_events: events.length,
    covered_events: covered,
    uncovered_events: uncovered,
    unknown_events: unknown,
    highest_severity: highest,
    sensitivities: Array.from(sensitivities),
    blocked_events: interventionList.length > 0 ? interventionList.length : undefined,
    interventions: interventionList.length > 0 ? interventionList.length : undefined,
  };
}
