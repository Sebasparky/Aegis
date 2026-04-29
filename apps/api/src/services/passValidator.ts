import type { Collar } from "@aegis/types";
import { passes, collars } from "../store/index.js";
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
  collar: Collar;
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
    return { ok: false, code: "PASS_REVOKED", message: "This Aegis Pass has been revoked." };
  }

  if (pass.status === "expired" || new Date(pass.expires_at) < new Date()) {
    passes.set(pass.id, { ...pass, status: "expired" });
    schedulePersist();
    return { ok: false, code: "PASS_EXPIRED", message: "This Aegis Pass has expired." };
  }

  const collar = collars.get(pass.default_collar_id);
  if (!collar) {
    return { ok: false, code: "NOT_FOUND", message: "The collar attached to this pass was not found." };
  }

  if (collar.status !== "active") {
    return { ok: false, code: "COLLAR_REVOKED", message: "The collar attached to this pass is not active." };
  }

  // Update last_used_at on every successful validation
  passes.set(pass.id, { ...pass, last_used_at: new Date().toISOString() } as PassWithToken & { last_used_at: string });

  return { ok: true, pass, collar };
}
