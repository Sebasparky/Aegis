import type { FastifyInstance } from "fastify";
import {
  getHvHandoffHistory,
  getLatestHvHandoffUpdate,
  listHvHandoffUpdates,
  type HumanVerificationHandoffUpdate,
} from "../runtime/humanVerificationHandoff.js";

// ─── Human Verification Handoff status endpoint ──────────────────────────────
//
// Read-only poll surface for the Aegis UI / control plane to render the live HV
// handoff status while a VGC/HV handoff is active. The handoff store already
// builds safe-fields-only objects via an explicit allowlist; this route ALSO
// re-projects through an explicit allowlist (belt-and-suspenders, no spread) so a
// future store field can never silently leak. Returns ONLY safe scalars/enums —
// never URL/path/query, selectors, coordinates, screenshot bytes, or page text.

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

/** Explicit safe projection — no spread of the stored object. */
function safeHandoffView(u: HumanVerificationHandoffUpdate) {
  return {
    type: u.type,
    browser_session_id: u.browser_session_id,
    capsule_id: u.capsule_id,
    human_verification_request_id: u.human_verification_request_id,
    domain: u.domain,
    source: u.source,
    phase: u.phase,
    requires_user_attention: u.requires_user_attention,
    agent_should_wait: u.agent_should_wait,
    model_label: u.model_label,
    model_confidence: u.model_confidence,
    visual_policy_decision: u.visual_policy_decision,
    trigger_basis: u.trigger_basis,
    presence_source: u.presence_source,
    release_authority: u.release_authority,
    raw_surface_revealed_to_agent: false as const,
    created_at: u.created_at,
    expires_at: u.expires_at,
  };
}

export async function humanVerificationHandoffRoutes(server: FastifyInstance): Promise<void> {
  // List the latest live handoff update per session (latest-first). Lazy-expired.
  server.get("/api/internal/human-verification-handoff", async (_req, reply) => {
    const items = listHvHandoffUpdates().map(safeHandoffView);
    return reply.send({ ok: true, data: items });
  });

  // Latest handoff update for one browser session (or null when none/expired).
  // ?history=true returns the bounded latest-first ring instead.
  server.get<{ Params: { browserSessionId: string }; Querystring: { history?: string } }>(
    "/api/internal/human-verification-handoff/:browserSessionId",
    async (req, reply) => {
      const { browserSessionId } = req.params;
      if (!browserSessionId) {
        return sendError(reply, 400, "BAD_REQUEST", "browser_session_id is required.");
      }
      if (req.query?.history === "true") {
        const history = getHvHandoffHistory(browserSessionId).map(safeHandoffView);
        return reply.send({ ok: true, data: history });
      }
      const latest = getLatestHvHandoffUpdate(browserSessionId);
      return reply.send({ ok: true, data: latest ? safeHandoffView(latest) : null });
    },
  );
}
