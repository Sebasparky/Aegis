import type { FastifyInstance } from "fastify";
import { domainTrust, receipts, runnerTasks } from "../store/index.js";
import type { WebsiteAegisIDTrustClaims, WebsiteTrustStatus } from "@aegis/types";

function normalizeDomain(raw: string): string {
  let d = raw.replace(/^https?:\/\//i, "");
  d = d.split("/")[0];
  // Strip port — localhost:3001 → localhost
  d = d.split(":")[0];
  return d.toLowerCase();
}

function recommendedAction(
  status: WebsiteTrustStatus
): "allow_normal_browsing" | "require_extra_approval" | "block_sensitive_actions" {
  if (status === "verified_demo_business") return "allow_normal_browsing";
  if (status === "flagged") return "block_sensitive_actions";
  return "require_extra_approval";
}

function buildClaims(domain: string): WebsiteAegisIDTrustClaims {
  const record = domainTrust.get(domain);
  const trust_status = (record?.trust_label ?? "unverified") as WebsiteTrustStatus;

  const successful_runner_transactions = Array.from(runnerTasks.values()).filter(
    (t) => t.domain === domain && t.status === "completed"
  ).length;

  const blocked_or_disputed_actions = Array.from(receipts.values()).filter(
    (r) => r.domain === domain && (r.decision === "blocked" || r.outcome === "blocked")
  ).length;

  return {
    website_aegis_id: record?.website_aegis_id ?? `web_unknown_${domain.replace(/\./g, "_")}`,
    domain,
    business_name: record?.business_name ?? domain,
    trust_status,
    domain_verified: record?.domain_verified ?? false,
    agent_policy_published: record?.agent_policy_published ?? false,
    prompt_injection_reports: record?.known_prompt_injection_reports ?? 0,
    successful_runner_transactions,
    blocked_or_disputed_actions,
    // Incident reporting is not implemented yet; credential exposure is architecturally prevented in the current system.
    credential_exposure_incidents: 0,
    recommended_agent_action: recommendedAction(trust_status),
    last_updated: record?.updated_at ?? new Date().toISOString(),
  };
}

export async function websiteAegisIdRoutes(server: FastifyInstance) {
  server.get<{ Params: { domain: string } }>(
    "/api/website-aegis-id/:domain/trust-claims",
    async (req) => {
      const normalized = normalizeDomain(req.params.domain);
      return { ok: true, data: buildClaims(normalized) };
    }
  );

  server.get("/api/website-aegis-id", async () => {
    const knownDomains = new Set(domainTrust.keys());

    for (const r of receipts.values()) {
      if (r.domain) knownDomains.add(r.domain);
    }

    const data = Array.from(knownDomains).map(buildClaims);
    return { ok: true, data };
  });
}
