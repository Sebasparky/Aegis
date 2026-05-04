import type { KmsAuditEvent } from "@aegis/types";
import { newId } from "../store/index.js";

// In-memory only — no disk persistence in v1.
// Events accumulate for the lifetime of the process and reset on restart.
const kmsAuditEvents = new Map<string, KmsAuditEvent>();

export function recordKmsAuditEvent(
  fields: Omit<KmsAuditEvent, "kms_audit_id" | "created_at" | "raw_secret_exposed">
): KmsAuditEvent {
  const event: KmsAuditEvent = {
    ...fields,
    kms_audit_id: newId("kmsa"),
    created_at: new Date().toISOString(),
    raw_secret_exposed: false,
  };
  kmsAuditEvents.set(event.kms_audit_id, event);
  return event;
}

export function getKmsAuditEvents(): KmsAuditEvent[] {
  return Array.from(kmsAuditEvents.values());
}
