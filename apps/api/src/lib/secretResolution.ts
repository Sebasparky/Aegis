import type { RouteRun, RouteStep } from "@aegis/types";
import { aegisVaultPasses, routePassBindings, makePassBindingKey } from "../store/index.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";
import { getKmsProvider, type KmsContext } from "./kms.js";
import { recordKmsAuditEvent } from "./kmsAudit.js";

export interface ResolvedValue {
  value: string;
  redacted: boolean;
  pass_id: string;
}

export async function resolveRouteStepValue(
  run: RouteRun,
  step: RouteStep
): Promise<ResolvedValue> {
  const vp = step.value_policy;
  if (!vp || (vp.type !== "pass_field" && vp.type !== "secret_ref")) {
    throw new Error("Step does not have a pass_field or secret_ref value policy.");
  }

  const binding = routePassBindings.get(makePassBindingKey(run.user_id, run.route_id, "login_password"));
  const effectivePassId = run.pass_overrides?.["login_password"] ?? binding?.pass_id ?? vp.pass_id!;

  const vaultRepo = getVaultRepository();
  const pass = aegisVaultPasses.get(effectivePassId) ?? await vaultRepo.getVaultPass(effectivePassId);
  if (!pass || pass.user_id !== run.user_id) {
    throw new Error(`Pass not found: ${effectivePassId}`);
  }

  if (vp.type === "pass_field") {
    if (vp.field === "username" && pass.username) {
      return { value: pass.username, redacted: false, pass_id: pass.pass_id };
    }
    throw new Error("Requested pass field is not available.");
  }

  // secret_ref — decrypt via KMS
  const blob = await vaultRepo.getEncryptedSecret(pass.secret_ref);
  if (!blob) {
    throw new Error(`Secret not available in vault for pass ${pass.pass_id}.`);
  }

  const kms = getKmsProvider();
  const kmsContext: KmsContext = {
    user_id: pass.user_id,
    pass_id: pass.pass_id,
    domain: pass.domain,
    purpose: "login_password",
  };
  let decrypted: string;
  try {
    decrypted = await kms.decryptSecret(blob, kmsContext);
    recordKmsAuditEvent({
      operation: "resolve_secret_for_runtime",
      provider: kms.provider,
      user_id: pass.user_id,
      pass_id: pass.pass_id,
      domain: pass.domain,
      run_id: run.run_id,
      route_id: run.route_id,
      route_step_id: step.step_id,
      success: true,
    });
  } catch (err) {
    recordKmsAuditEvent({
      operation: "resolve_secret_for_runtime",
      provider: kms.provider,
      user_id: pass.user_id,
      pass_id: pass.pass_id,
      domain: pass.domain,
      run_id: run.run_id,
      route_id: run.route_id,
      route_step_id: step.step_id,
      success: false,
      error_code: err instanceof Error ? err.message.split(":")[0] : "DECRYPT_ERROR",
    });
    throw err; // re-throw — playwrightRuntime.ts error handling must receive this
  }
  return { value: decrypted, redacted: true, pass_id: pass.pass_id };
}
