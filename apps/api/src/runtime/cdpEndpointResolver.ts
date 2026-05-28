/**
 * Pure CDP endpoint resolution for secret injection execute.
 * Encodes the 5-tier precedence without importing any route-level or store-level dependencies.
 * Accepts callbacks so callers control session lookup and URL validation.
 */

export type CdpEndpointSource =
  | "body_browser_session_id"
  | "stored_browser_session_id"
  | "body_external_cdp_url"
  | "stored_external_cdp_url"
  | "env_fallback";

export interface CdpEndpointResolution {
  cdpUrlOverride?: string;
  preferredTargetUrl?: string;
  source: CdpEndpointSource;
  error?: { code: string; message: string };
}

type SessionInfo = { cdp_url: string; current_url?: string; status: string };
type UrlValidation = { valid: true } | { valid: false; code: string; message: string };

interface InjectionEndpointHints {
  browser_session_id?: string;
  external_cdp_url?: string;
  page_url?: string;
}

/**
 * Resolve the CDP endpoint for a secret injection execute call.
 *
 * Precedence (first match wins):
 *   1. body.browser_session_id  — look up session, use cdp_url + current_url
 *   2. stored browser_session_id — same as above, but from the injection record
 *   3. body.external_cdp_url    — localhost-validated; use injection.page_url as preferredTargetUrl
 *   4. stored external_cdp_url  — same as above, from the injection record
 *   5. env fallback             — cdpUrlOverride=undefined; executeSecretInjectionViaCDP uses AEGIS_PLAYWRIGHT_CDP_URL
 *
 * Returns an error field instead of throwing; callers translate error → HTTP 4xx.
 */
export function resolveSecretInjectionCdpEndpoint(
  injection: InjectionEndpointHints,
  bodyBsId: string | undefined,
  bodyExtCdp: string | undefined,
  lookupSession: (id: string) => SessionInfo | undefined,
  validateUrl: (url: string) => UrlValidation,
): CdpEndpointResolution {
  // 1. body browser_session_id
  if (bodyBsId) {
    const bs = lookupSession(bodyBsId);
    if (!bs || bs.status !== "ready") {
      return {
        source: "body_browser_session_id",
        error: {
          code: "BROWSER_SESSION_NOT_READY",
          message:
            `Task browser session '${bodyBsId}' not found or not ready. ` +
            `Verify the session is active with get_task_browser_session before executing injection.`,
        },
      };
    }
    return {
      cdpUrlOverride: bs.cdp_url,
      preferredTargetUrl: bs.current_url,
      source: "body_browser_session_id",
    };
  }

  // 2. stored browser_session_id
  if (injection.browser_session_id) {
    const bs = lookupSession(injection.browser_session_id);
    if (bs?.status === "ready") {
      return {
        cdpUrlOverride: bs.cdp_url,
        preferredTargetUrl: bs.current_url,
        source: "stored_browser_session_id",
      };
    }
    // Session not ready — fall through to external_cdp_url tiers
  }

  // 3. body external_cdp_url
  if (bodyExtCdp) {
    const check = validateUrl(bodyExtCdp);
    if (!check.valid) {
      return {
        source: "body_external_cdp_url",
        error: { code: check.code, message: check.message },
      };
    }
    return {
      cdpUrlOverride: bodyExtCdp,
      preferredTargetUrl: injection.page_url || undefined,
      source: "body_external_cdp_url",
    };
  }

  // 4. stored external_cdp_url
  if (injection.external_cdp_url) {
    return {
      cdpUrlOverride: injection.external_cdp_url,
      preferredTargetUrl: injection.page_url || undefined,
      source: "stored_external_cdp_url",
    };
  }

  // 5. env fallback — cdpUrlOverride undefined; runtime reads AEGIS_PLAYWRIGHT_CDP_URL
  return { source: "env_fallback" };
}
