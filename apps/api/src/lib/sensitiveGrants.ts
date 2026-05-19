import type { ActionType, SensitiveGrant, SensitiveGrantScope, SensitiveGrantStatus, SensitiveGrantType } from "@aegis/types";

// ─── Non-negotiable approval floors ──────────────────────────────────────────
// Action types for which a SensitiveGrant must NEVER be created, even after user approval.
// These actions require fresh per-action approval every time — no cached reusable grant.
// This is a grant-layer constraint, not a collar policy constraint.
// v1 grant types (credential_injection, challenge_resolution) are intentionally NOT in this
// set — they are exactly the use cases that benefit from a structured grant record.
// Extend this set when adding future grant types for higher-risk actions.
export const ALWAYS_REQUIRES_FRESH_APPROVAL: ReadonlySet<ActionType> = new Set<ActionType>([
  "government_id_upload",
  "medical_data_disclosure",
  "financial_data_disclosure",
  "delete_account",
  "oauth_authorize",
  "save_credential",
  "enable_persistence",
]);

// ─── Grant check ─────────────────────────────────────────────────────────────

export interface CheckGrantInput {
  user_id: string;
  delegation_id: string;
  domain: string;
  grant_type: SensitiveGrantType;
  pass_id?: string;           // required for credential_injection lookups
  challenge_id?: string;      // required for challenge_resolution lookups
  task_id?: string;           // if provided, grant.scope.task_id must match
  authorization_id?: string;  // preferred for credential_injection — avoids matching unrelated grants for the same pass
}

export type CheckGrantReason = "no_grant" | "expired" | "consumed" | "revoked";

export interface CheckGrantResult {
  valid: boolean;
  grant?: SensitiveGrant;
  reason?: CheckGrantReason;
}

/**
 * Check whether a valid, non-expired, non-consumed SensitiveGrant exists for the given context.
 * Pure function — accepts the Map as a parameter for testability without server setup.
 *
 * Check order:
 *   1. Filter by grant_type, user_id, delegation_id, domain
 *   2. If task_id provided in input, also filter by scope.task_id
 *   3. For credential_injection: also filter by scope.pass_id
 *   4. For challenge_resolution: also filter by scope.challenge_id
 *   5. On first match: check status (revoked → revoked, consumed → consumed)
 *   6. Check TTL: now > expires_at → expired
 *   7. Valid match → { valid: true, grant }
 *   8. No match → { valid: false, reason: "no_grant" }
 */
export function checkSensitiveGrant(
  grants: Map<string, SensitiveGrant>,
  input: CheckGrantInput,
): CheckGrantResult {
  const now = new Date();

  for (const grant of grants.values()) {
    if (grant.grant_type !== input.grant_type) continue;
    if (grant.scope.user_id !== input.user_id) continue;
    if (grant.scope.delegation_id !== input.delegation_id) continue;
    if (grant.scope.domain !== input.domain) continue;

    // Optional task scoping: if input specifies task_id, grant must match
    if (input.task_id !== undefined && grant.scope.task_id !== input.task_id) continue;

    // Type-specific scope matching
    if (input.grant_type === "credential_injection") {
      if (input.pass_id !== undefined && grant.scope.pass_id !== input.pass_id) continue;
      if (input.authorization_id !== undefined && grant.scope.authorization_id !== input.authorization_id) continue;
    }
    if (input.grant_type === "challenge_resolution") {
      if (input.challenge_id !== undefined && grant.scope.challenge_id !== input.challenge_id) continue;
    }

    // Match found — check status
    const s = grant.status as SensitiveGrantStatus;
    if (s === "revoked") return { valid: false, grant, reason: "revoked" };
    if (s === "consumed") return { valid: false, grant, reason: "consumed" };
    if (new Date(grant.expires_at) < now) return { valid: false, grant, reason: "expired" };

    return { valid: true, grant };
  }

  return { valid: false, reason: "no_grant" };
}

// ─── Grant builder ────────────────────────────────────────────────────────────

export interface BuildGrantInput {
  grant_id: string;
  grant_type: SensitiveGrantType;
  scope: SensitiveGrantScope;
  expires_at: string;
  linked_uar_id: string;
  created_at?: string;
}

/**
 * Build a SensitiveGrant record.
 * Does NOT sign with EdDSA — the linked UAR carries the cryptographic proof.
 * Does NOT write to the store — caller is responsible for that.
 * Caller generates grant_id (e.g. newId("sg")).
 */
export function buildSensitiveGrant(input: BuildGrantInput): SensitiveGrant {
  return {
    grant_id: input.grant_id,
    grant_type: input.grant_type,
    schema_version: "1.0",
    issuer: "aegis",
    created_at: input.created_at ?? new Date().toISOString(),
    expires_at: input.expires_at,
    scope: input.scope,
    linked_uar_id: input.linked_uar_id,
    status: "active",
    secret_exposed_to_agent: false,
    raw_credentials_in_grant: false,
  };
}
