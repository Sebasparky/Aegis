import { agentDelegations, passes, MOCK_USER_ID } from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

export type RevokeDelegationResult =
  | { ok: true; delegation_id: string }
  | { ok: false; error: "NOT_FOUND" | "ALREADY_REVOKED_OR_EXPIRED" };

export function revokeDelegationById(delegationId: string): RevokeDelegationResult {
  const delegation = agentDelegations.get(delegationId);
  if (!delegation || delegation.user_id !== MOCK_USER_ID) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (delegation.status !== "active") {
    return { ok: false, error: "ALREADY_REVOKED_OR_EXPIRED" };
  }

  const now = new Date().toISOString();
  delegation.status = "revoked";
  delegation.updated_at = now;

  const pass = passes.get(delegation.token_id);
  if (pass && pass.status === "active") {
    pass.status = "revoked";
    (pass as PassWithToken & { revoked_at: string }).revoked_at = now;
  }

  schedulePersist();
  return { ok: true, delegation_id: delegation.id };
}
