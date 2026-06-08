/**
 * CDP target/page binding helper.
 *
 * Selects the best page target from a Chrome DevTools Protocol /json/list response.
 * Priority order ensures the injector attaches to the active page, not a stale about:blank
 * or an unrelated devtools/newtab target.
 *
 * Selection priority:
 *   1. Exact URL match      — t.url === preferredUrl
 *   2. Same-origin match    — origin of t.url matches origin of preferredUrl
 *   3. Domain match         — t.url hostname matches the domain hint
 *   4. Non-blank fallback   — first visible page (not about:blank / newtab / devtools)
 *   5. Last-target fallback — .at(-1); same as the original behavior, last resort
 *
 * Safe diagnostics: logs candidate URLs and selection reason. Never logs secrets.
 */

export interface CdpPageTarget {
  id: string;
  url: string;
  type: string;
  title?: string;
}

export type TargetSelectionReason =
  | "exact_url_match"
  | "same_origin_match"
  | "domain_match"
  | "non_blank_fallback"
  | "last_target_fallback"
  | "no_targets";

export interface TargetSelectionResult {
  target: CdpPageTarget | undefined;
  reason: TargetSelectionReason;
  /** Safe candidate metadata for diagnostics — URLs only, no secrets. */
  candidates: Array<{ targetId: string; url: string }>;
}

/** URL schemes that are never useful injection targets. */
const UNUSABLE_PREFIXES = ["about:", "chrome://", "devtools://", "chrome-extension://"];

function isUsable(url: string): boolean {
  return !UNUSABLE_PREFIXES.some((p) => url.startsWith(p));
}

export function pickBestPageTarget(
  targets: CdpPageTarget[],
  opts: { domain?: string; preferredUrl?: string } = {},
): TargetSelectionResult {
  const pageTargets = targets.filter((t) => t.type === "page");
  const candidates = pageTargets.map((t) => ({ targetId: t.id, url: t.url }));

  const noTargets: TargetSelectionResult = { target: undefined, reason: "no_targets", candidates };
  if (pageTargets.length === 0) {
    console.log("[CdpTargetSelection] no page targets available", { cdp_candidate_count: 0 });
    return noTargets;
  }

  const { preferredUrl, domain } = opts;

  // 1. Exact URL match
  if (preferredUrl) {
    const exact = pageTargets.find((t) => t.url === preferredUrl);
    if (exact) {
      logSelection(exact.url, "exact_url_match", candidates);
      return { target: exact, reason: "exact_url_match", candidates };
    }

    // 2. Same-origin match
    try {
      const preferredOrigin = new URL(preferredUrl).origin;
      const originMatch = pageTargets.find((t) => {
        try {
          return new URL(t.url).origin === preferredOrigin;
        } catch {
          return false;
        }
      });
      if (originMatch) {
        logSelection(originMatch.url, "same_origin_match", candidates);
        return { target: originMatch, reason: "same_origin_match", candidates };
      }
    } catch {
      // preferredUrl is not a parseable URL — skip origin check
    }
  }

  // 3. Domain match
  if (domain) {
    const domainMatch = pageTargets.find((t) => {
      try {
        const h = new URL(t.url).hostname;
        return h === domain || h.endsWith(`.${domain}`);
      } catch {
        return false;
      }
    });
    if (domainMatch) {
      logSelection(domainMatch.url, "domain_match", candidates);
      return { target: domainMatch, reason: "domain_match", candidates };
    }
  }

  // 4. Non-blank fallback — first usable page
  const nonBlank = pageTargets.find((t) => isUsable(t.url));
  if (nonBlank) {
    logSelection(nonBlank.url, "non_blank_fallback", candidates);
    return { target: nonBlank, reason: "non_blank_fallback", candidates };
  }

  // 5. Last-target fallback
  const last = pageTargets.at(-1);
  if (last) {
    logSelection(last.url, "last_target_fallback", candidates);
    return { target: last, reason: "last_target_fallback", candidates };
  }

  console.log("[CdpTargetSelection] no valid page target found", {
    cdp_candidate_count: candidates.length,
    cdp_candidate_urls: candidates.map((c) => c.url),
  });
  return noTargets;
}

function logSelection(
  selectedUrl: string,
  reason: TargetSelectionReason,
  candidates: Array<{ targetId: string; url: string }>,
): void {
  console.log("[CdpTargetSelection] injection target selection", {
    reason,
    selected_url: selectedUrl,
    cdp_candidate_count: candidates.length,
    cdp_candidate_urls: candidates.map((c) => c.url),
  });
}

/**
 * Reads the live URL of the active CDP page target.
 *
 * This is the SAME source the realistic click/type/scroll guards treat as
 * authoritative: fetch the CDP target list and run it through
 * `pickBestPageTarget`. Exposing it as a helper lets the snapshot path store the
 * live page URL at snapshot time instead of cached session metadata
 * (`session.current_url`), which can lag behind a navigation (Enter-submit,
 * client-side route change, redirect) and otherwise produce a false
 * ANTIGEN_REF_PAGE_CHANGED on the very next action.
 *
 * Fail-safe: returns null on any transport/parse failure or when no usable page
 * target exists, so callers can fall back conservatively without failing their
 * operation. Never throws, never logs secrets.
 */
export async function readLiveCdpPageUrl(cdpUrl: string): Promise<string | null> {
  let targets: CdpPageTarget[];
  try {
    const res = await fetch(`${cdpUrl}/json/list`);
    targets = (await res.json()) as CdpPageTarget[];
  } catch {
    return null;
  }
  if (!Array.isArray(targets)) return null;
  // Empty opts == the exact selection the click/type/scroll path uses.
  const { target } = pickBestPageTarget(targets, {});
  return target?.url ?? null;
}
