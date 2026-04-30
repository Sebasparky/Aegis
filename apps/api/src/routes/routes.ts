import type { FastifyInstance } from "fastify";
import type { RecordingPayload, RouteTrustTier, RouteVerificationReport } from "@aegis/types";
import { routes, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { compileRoute } from "../services/routeCompiler.js";
import { verifyRouteWithPlaywright } from "../services/routeVerifier.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

// Trust tier sort order for query endpoint (higher = more trusted)
const TRUST_TIER_RANK: Record<RouteTrustTier, number> = {
  unverified_draft: 0,
  community: 1,
  aegis_scanned: 2,
  aegis_reviewed: 3,
  run_verified: 4,
  business_official: 5,
};

export async function routeRoutes(server: FastifyInstance) {
  /**
   * POST /api/routes/record
   *
   * Accepts a semantic recording payload, compiles it into an AegisRoute,
   * validates it, and saves it to the route store.
   */
  server.post<{ Body: RecordingPayload & { workflow_name?: string; domain?: string } }>(
    "/api/routes/record",
    async (req, reply) => {
      const body = req.body ?? {};

      if (!body.workflow_name || typeof body.workflow_name !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "workflow_name is required.");
      }
      if (!body.domain || typeof body.domain !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");
      }
      if (!Array.isArray(body.events) || body.events.length === 0) {
        return sendError(reply, 400, "VALIDATION_ERROR", "events must be a non-empty array.");
      }

      let route;
      try {
        route = compileRoute(body as RecordingPayload);
      } catch (err: any) {
        const msg = err?.message ?? "Compilation failed.";
        if (msg.startsWith("UNSAFE_LOCATOR")) {
          return sendError(reply, 400, "UNSAFE_LOCATOR", msg);
        }
        server.log.error(err, "Route compilation error");
        return sendError(reply, 500, "COMPILE_ERROR", msg);
      }

      routes.set(route.route_id, route);
      schedulePersist();

      return {
        ok: true,
        data: {
          route_id: route.route_id,
          workflow_name: route.workflow_name,
          domain: route.domain,
          trust_tier: route.trust_tier,
          risk_level: route.risk_level,
          step_count: route.steps.length,
          forbidden_action_count: route.forbidden_actions.length,
        },
      };
    }
  );

  /**
   * GET /api/routes
   *
   * List all routes. Optionally filter by ?domain= and/or ?trust_tier=
   */
  server.get<{ Querystring: { domain?: string; trust_tier?: string } }>(
    "/api/routes",
    async (req, _reply) => {
      const { domain, trust_tier } = req.query;
      let list = Array.from(routes.values());

      if (domain) list = list.filter((r) => r.domain === domain);
      if (trust_tier) list = list.filter((r) => r.trust_tier === trust_tier);

      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      return { ok: true, data: list };
    }
  );

  /**
   * GET /api/routes/:routeId
   */
  server.get<{ Params: { routeId: string } }>(
    "/api/routes/:routeId",
    async (req, reply) => {
      const route = routes.get(req.params.routeId);
      if (!route) return sendError(reply, 404, "NOT_FOUND", "Route not found.");
      return { ok: true, data: route };
    }
  );

  /**
   * PATCH /api/routes/:routeId
   *
   * Updates workflow_name and/or workflow_description only.
   * Route steps, trust_tier, permissions, and verification data are immutable via this endpoint.
   */
  server.patch<{ Params: { routeId: string }; Body: { workflow_name?: string; workflow_description?: string } }>(
    "/api/routes/:routeId",
    async (req, reply) => {
      const route = routes.get(req.params.routeId);
      if (!route) return sendError(reply, 404, "NOT_FOUND", "Route not found.");

      const { workflow_name, workflow_description } = req.body ?? {};

      if (workflow_name !== undefined) {
        if (typeof workflow_name !== "string" || !workflow_name.trim()) {
          return sendError(reply, 400, "VALIDATION_ERROR", "workflow_name must be a non-empty string.");
        }
        route.workflow_name = workflow_name.trim();
      }
      if (workflow_description !== undefined && typeof workflow_description === "string") {
        route.workflow_description = workflow_description;
      }

      routes.set(route.route_id, route);
      schedulePersist();
      return { ok: true, data: route };
    }
  );

  /**
   * DELETE /api/routes/:routeId
   */
  server.delete<{ Params: { routeId: string } }>(
    "/api/routes/:routeId",
    async (req, reply) => {
      if (!routes.has(req.params.routeId)) {
        return sendError(reply, 404, "NOT_FOUND", "Route not found.");
      }
      routes.delete(req.params.routeId);
      schedulePersist();
      return { ok: true, data: { deleted: true } };
    }
  );

  /**
   * POST /api/routes/:routeId/verify
   *
   * Replays a saved route with Playwright against the demo banking page.
   * If all steps pass, promotes trust_tier from unverified_draft to aegis_scanned.
   * Only localhost demo routes are supported for automated verification.
   */
  server.post<{ Params: { routeId: string } }>(
    "/api/routes/:routeId/verify",
    async (req, reply) => {
      const route = routes.get(req.params.routeId);
      if (!route) return sendError(reply, 404, "NOT_FOUND", "Route not found.");

      let report: RouteVerificationReport;
      try {
        report = await verifyRouteWithPlaywright(route);
      } catch (err: any) {
        server.log.error(err, "Route verification error");
        return sendError(reply, 500, "VERIFICATION_ERROR", err?.message ?? "Verification failed.");
      }

      route.verification_report = report;
      route.last_verified_at = report.completed_at;
      if (report.passed && route.trust_tier === "unverified_draft") {
        route.trust_tier = "aegis_scanned";
        report.promoted_trust_tier = "aegis_scanned";
      }
      routes.set(route.route_id, route);
      schedulePersist();

      return { ok: true, data: report };
    }
  );

  /**
   * POST /api/routes/:routeId/submit-review
   *
   * Marks a verified route as pending marketplace review.
   * Requires trust_tier aegis_scanned or higher.
   */
  server.post<{ Params: { routeId: string } }>(
    "/api/routes/:routeId/submit-review",
    async (req, reply) => {
      const route = routes.get(req.params.routeId);
      if (!route) return sendError(reply, 404, "NOT_FOUND", "Route not found.");

      if (TRUST_TIER_RANK[route.trust_tier] < TRUST_TIER_RANK["aegis_scanned"]) {
        return sendError(reply, 400, "UNVERIFIED_ROUTE", "Verify this route before submitting it for marketplace review.");
      }

      route.marketplace_status = "pending_review";
      route.submitted_for_review_at = new Date().toISOString();
      routes.set(route.route_id, route);
      schedulePersist();
      return { ok: true, data: route };
    }
  );

  /**
   * POST /api/routes/query
   *
   * Agent registry query. Returns the highest-trust route matching the domain.
   *
   * NOTE: Routes cannot override collar restrictions.
   * Collar enforcement happens at the action API layer, not here.
   */
  server.post<{ Body: { domain?: string; min_trust_tier?: RouteTrustTier } }>(
    "/api/routes/query",
    async (req, reply) => {
      const { domain, min_trust_tier } = req.body ?? {};

      if (!domain) return sendError(reply, 400, "VALIDATION_ERROR", "domain is required.");

      const minRank = min_trust_tier ? (TRUST_TIER_RANK[min_trust_tier] ?? 0) : 0;

      const candidates = Array.from(routes.values()).filter(
        (r) => r.domain === domain && TRUST_TIER_RANK[r.trust_tier] >= minRank
      );

      if (candidates.length === 0) {
        return { ok: true, data: { route: null, matched: false, reason: "No matching route found for this domain." } };
      }

      candidates.sort((a, b) => TRUST_TIER_RANK[b.trust_tier] - TRUST_TIER_RANK[a.trust_tier]);
      const best = candidates[0];

      return {
        ok: true,
        data: {
          route: best,
          matched: true,
          reason: `Matched route '${best.workflow_name}' at trust tier '${best.trust_tier}'.`,
        },
      };
    }
  );
}
