import { newId } from "../store/index.js";

export type RuntimeSessionStatus =
  | "created"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed";

export interface RuntimeEvent {
  event_type: "password_field_detected" | "sensitive_button_click" | "form_submit";
  sensitivity: "high" | "medium" | "low";
  page_url: string;
  element_hint: string;
  covered_by_aegis: boolean;
  reason: string;
  timestamp: string;
}

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
}

// Ephemeral for v1 — not persisted across API restarts.
// Receipts (durable audit records) are persisted by getReceiptRepository().
export const runtimeSessions = new Map<string, RuntimeSession>();

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
