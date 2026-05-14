import type { FastifyInstance } from "fastify";
import type { WebsiteProfileStatus, WebsiteTrustProfile } from "@aegis/types";
import { websiteTrustProfiles, newId } from "../store/index.js";
import {
  buildSignedWebsiteTrustProfile,
  verifyStoredWebsiteTrustProfile,
} from "../lib/websiteTrustProfileSigning.js";
import { schedulePersist } from "../store/persistence.js";

function normalizeDomain(raw: string): string {
  let d = raw.replace(/^https?:\/\//i, "");
  d = d.split("/")[0];
  d = d.split(":")[0];
  return d.toLowerCase().trim();
}

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function websiteTrustProfileRoutes(app: FastifyInstance) {
  /**
   * GET /api/website-trust-profiles
   * List all website trust profiles, sorted by created_at descending.
   */
  app.get("/api/website-trust-profiles", async (_req, reply) => {
    const all = Array.from(websiteTrustProfiles.values()).sort(
      (a, b) => b.created_at.localeCompare(a.created_at)
    );
    return reply.send({ ok: true, data: all });
  });

  /**
   * GET /api/website-trust-profiles/by-domain/:domain
   * Find the active trust profile for a domain. Domain is normalized.
   * Must be registered before /:profileId to prevent Fastify matching "by-domain" as a profile_id.
   */
  app.get<{ Params: { domain: string } }>(
    "/api/website-trust-profiles/by-domain/:domain",
    async (req, reply) => {
      const domain = normalizeDomain(req.params.domain);
      const profile = Array.from(websiteTrustProfiles.values()).find(
        (p) => p.domain === domain && p.status === "active"
      );
      if (!profile) {
        return reply.status(404).send({
          ok: false,
          error: {
            code: "PROFILE_NOT_FOUND",
            message: `No active WebsiteTrustProfile found for domain '${domain}'.`,
          },
        });
      }
      return reply.send({ ok: true, data: profile });
    }
  );

  /**
   * GET /api/website-trust-profiles/:profileId/verify
   * Verify the cryptographic integrity of a profile.
   * Must be registered before /:profileId to avoid the broad dynamic route matching "…/verify".
   */
  app.get<{ Params: { profileId: string } }>(
    "/api/website-trust-profiles/:profileId/verify",
    async (req, reply) => {
      const profile = websiteTrustProfiles.get(req.params.profileId);
      if (!profile) {
        return reply.status(404).send({
          ok: false,
          error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
        });
      }
      const result = await verifyStoredWebsiteTrustProfile(profile);
      return reply.send({ ok: true, data: result });
    }
  );

  /**
   * GET /api/website-trust-profiles/:profileId
   * Get a trust profile by its profile_id.
   */
  app.get<{ Params: { profileId: string } }>(
    "/api/website-trust-profiles/:profileId",
    async (req, reply) => {
      const profile = websiteTrustProfiles.get(req.params.profileId);
      if (!profile) {
        return reply.status(404).send({
          ok: false,
          error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
        });
      }
      return reply.send({ ok: true, data: profile });
    }
  );

  /**
   * POST /api/website-trust-profiles
   * Create and sign a new website trust profile.
   */
  app.post<{
    Body: {
      website_aegis_id: string;
      domain: string;
      company_name: string;
      verification_status: "unverified" | "verified" | "suspended";
      profile_version?: string;
      agent_policy: WebsiteTrustProfile["agent_policy"];
      safety_promises: WebsiteTrustProfile["safety_promises"];
      reputation_score?: number;
      accountability_contact?: string;
      policy_url?: string;
    };
  }>("/api/website-trust-profiles", async (req, reply) => {
    const body = req.body;

    if (!body.website_aegis_id || !body.domain || !body.company_name || !body.verification_status) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "MISSING_REQUIRED_FIELDS",
          message: "website_aegis_id, domain, company_name, and verification_status are required.",
        },
      });
    }
    if (!body.agent_policy || !body.safety_promises) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "MISSING_REQUIRED_FIELDS",
          message: "agent_policy and safety_promises are required.",
        },
      });
    }

    const now = new Date().toISOString();
    const profile_id = newId("wtp");

    const fields: Omit<WebsiteTrustProfile, "profile_hash" | "profile_jws" | "jws_present"> = {
      profile_id,
      website_aegis_id: body.website_aegis_id,
      domain: normalizeDomain(body.domain),
      company_name: body.company_name,
      verification_status: body.verification_status,
      profile_version: body.profile_version ?? "1",
      status: "active",
      created_at: now,
      updated_at: now,
      agent_policy: body.agent_policy,
      safety_promises: body.safety_promises,
      violation_count: 0,
      ...(body.reputation_score !== undefined ? { reputation_score: body.reputation_score } : {}),
      ...(body.accountability_contact ? { accountability_contact: body.accountability_contact } : {}),
      ...(body.policy_url ? { policy_url: body.policy_url } : {}),
    };

    const signed = await buildSignedWebsiteTrustProfile(fields);
    websiteTrustProfiles.set(profile_id, signed);
    schedulePersist();

    return reply.status(201).send({ ok: true, data: signed });
  });

  /**
   * PATCH /api/website-trust-profiles/:profileId/status
   * Update operational status (active → revoked or active → superseded).
   * Does NOT re-sign — original profile_hash/profile_jws are preserved as the historical record.
   */
  app.patch<{
    Params: { profileId: string };
    Body: { status: "revoked" | "superseded"; suspension_reason?: string };
  }>("/api/website-trust-profiles/:profileId/status", async (req, reply) => {
    const profile = websiteTrustProfiles.get(req.params.profileId);
    if (!profile) {
      return reply.status(404).send({
        ok: false,
        error: { code: "PROFILE_NOT_FOUND", message: "Profile not found." },
      });
    }

    const { status: newStatus, suspension_reason } = req.body;

    if (!newStatus || !["revoked", "superseded"].includes(newStatus)) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "INVALID_STATUS",
          message: "status must be 'revoked' or 'superseded'.",
        },
      });
    }

    if (profile.status !== "active") {
      return reply.status(409).send({
        ok: false,
        error: {
          code: "INVALID_STATUS_TRANSITION",
          message: `Profile is already '${profile.status}'. Only active profiles can be revoked or superseded.`,
        },
      });
    }

    const updated: WebsiteTrustProfile = {
      ...profile,
      status: newStatus as WebsiteProfileStatus,
      updated_at: new Date().toISOString(),
      ...(suspension_reason ? { suspension_reason } : {}),
      // profile_hash and profile_jws are intentionally preserved — they record what was declared.
    };

    websiteTrustProfiles.set(profile.profile_id, updated);
    schedulePersist();

    return reply.send({ ok: true, data: updated });
  });
}
