import type { RuntimeCoverageSummary, RuntimeEventSensitivityKind } from "@aegis/types";
import { newId } from "../store/index.js";

export type RuntimeSessionStatus =
  | "created"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed";

export type RuntimeEventType =
  | "sensitive_field_focus"
  | "sensitive_field_input"
  | "sensitive_button_click"
  | "sensitive_form_submit";

export type RuntimeEventSensitivity = RuntimeEventSensitivityKind;

export type RuntimeCoverageStatus =
  | "covered_by_aegis"
  | "not_covered_by_aegis"
  | "unknown";

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
}

export type { RuntimeCoverageSummary };

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

  return {
    sensitive_events: events.length,
    covered_events: covered,
    uncovered_events: uncovered,
    unknown_events: unknown,
    highest_severity: highest,
    sensitivities: Array.from(sensitivities),
  };
}
