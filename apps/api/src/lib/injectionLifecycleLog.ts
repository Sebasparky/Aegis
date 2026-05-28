import type { CredentialUseAuthorization, SecretFieldInjection } from "@aegis/types";

export function logInjectionLifecycle(
  event: string,
  inj: Pick<SecretFieldInjection, "injection_request_id" | "field_kind" | "domain" | "status" | "created_at">,
): void {
  const elapsed_ms = Date.now() - new Date(inj.created_at).getTime();
  console.log(`[InjectionLifecycle] ${event}`, {
    injection_request_id: inj.injection_request_id,
    field_kind: inj.field_kind,
    domain: inj.domain,
    status: inj.status,
    elapsed_ms,
  });
}

export function logAuthLifecycle(
  event: string,
  auth: Pick<CredentialUseAuthorization, "authorization_id" | "domain" | "status" | "created_at">,
): void {
  const elapsed_ms = Date.now() - new Date(auth.created_at).getTime();
  console.log(`[AuthLifecycle] ${event}`, {
    authorization_id: auth.authorization_id,
    domain: auth.domain,
    status: auth.status,
    elapsed_ms,
  });
}
