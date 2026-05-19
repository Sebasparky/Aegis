import type { Collar, AgentDelegation } from "@aegis/types";
import { passes, collars, agentDelegations } from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

export interface PassValidationError {
  ok: false;
  code: string;
  message: string;
}

export interface PassValidationSuccess {
  ok: true;
  pass: PassWithToken;
  delegation: AgentDelegation;
  collar: Collar | undefined;
}

export type PassValidationResult = PassValidationSuccess | PassValidationError;

/**
 * Validate an agent_pass_token and resolve its collar.
 *
 * Checks: token exists → not revoked → not expired → collar exists → collar active.
 * Updates last_used_at on success.
 *
 * NOTE: Tokens are stored in plaintext for MVP convenience.
 * Production must store only the hashed token and never return it after creation.
 */
export function validatePassToken(token: string | undefined): PassValidationResult {
  if (!token) {
    return { ok: false, code: "UNAUTHORIZED", message: "agent_pass_token is required." };
  }

  // Scan the passes map by raw token value (MVP — no index needed at this scale)
  const pass = Array.from(passes.values()).find((p) => p.token === token);

  if (!pass) {
    return { ok: false, code: "UNAUTHORIZED", message: "Invalid agent pass token." };
  }

  if (pass.status === "revoked") {
    return { ok: false, code: "PASS_REVOKED", message: "This Antigen Pass has been revoked." };
  }

  if (pass.status === "expired" || new Date(pass.expires_at) < new Date()) {
    passes.set(pass.id, { ...pass, status: "expired" });
    schedulePersist();
    return { ok: false, code: "PASS_EXPIRED", message: "This Antigen Pass has expired." };
  }

  // Collar is optional — agents may connect with no rule set and add one later.
  let collar: Collar | undefined;
  if (pass.default_collar_id) {
    collar = collars.get(pass.default_collar_id);
    if (!collar) {
      return { ok: false, code: "NOT_FOUND", message: "The collar attached to this pass was not found." };
    }
    if (collar.status !== "active") {
      return { ok: false, code: "COLLAR_REVOKED", message: "The collar attached to this pass is not active." };
    }
  }

  // Resolve and validate linked delegation — fail closed if missing or invalid
  const delegation = Array.from(agentDelegations.values()).find((d) => d.token_id === pass.id);
  if (!delegation) {
    return { ok: false, code: "DELEGATION_NOT_FOUND", message: "No active delegation is linked to this pass." };
  }
  if (delegation.status === "revoked") {
    return { ok: false, code: "DELEGATION_REVOKED", message: "The delegation linked to this pass has been revoked." };
  }
  if (delegation.status === "expired" || (delegation.expires_at && new Date(delegation.expires_at) < new Date())) {
    delegation.status = "expired";
    delegation.updated_at = new Date().toISOString();
    agentDelegations.set(delegation.id, delegation);
    schedulePersist();
    return { ok: false, code: "DELEGATION_EXPIRED", message: "The delegation linked to this pass has expired." };
  }

  // Update last_used_at only after both pass and delegation are confirmed valid
  passes.set(pass.id, { ...pass, last_used_at: new Date().toISOString() } as PassWithToken & { last_used_at: string });

  return { ok: true, pass, delegation, collar };
}
