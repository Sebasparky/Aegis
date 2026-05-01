import type { FastifyInstance } from "fastify";
import type { RouteRun } from "@aegis/types";
import { skills, installedSkills, routes, routeRuns, MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

const ALLOWED_DOMAINS = new Set(["en.wikipedia.org", "localhost"]);

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function routeRunRoutes(server: FastifyInstance) {
  /**
   * POST /api/skills/:skillId/runs
   *
   * A third-party agent requests execution of an installed skill.
   * Creates a RouteRun with status "pending". Does not execute browser actions.
   */
  server.post<{
    Params: { skillId: string };
    Body: { agent_id?: string; variables?: Record<string, string> };
  }>("/api/skills/:skillId/runs", async (req, reply) => {
    const { skillId } = req.params;
    const { agent_id, variables } = req.body ?? {};

    const skill = skills.get(skillId);
    if (!skill) return sendError(reply, 404, "SKILL_NOT_FOUND", "Skill not found.");

    const installedSkill = Array.from(installedSkills.values()).find(
      (i) => i.skill_id === skillId && i.user_id === MOCK_USER_ID && i.enabled
    );
    if (!installedSkill) {
      return sendError(reply, 403, "SKILL_NOT_INSTALLED", "Skill is not installed or is disabled for this user.");
    }

    const route = routes.get(skill.route_id);
    if (!route) {
      return sendError(reply, 500, "ROUTE_NOT_FOUND", "Underlying route not found for this skill.");
    }

    if (!ALLOWED_DOMAINS.has(skill.domain)) {
      return sendError(
        reply,
        400,
        "DOMAIN_NOT_SUPPORTED",
        `RouteRun is not supported for domain "${skill.domain}". Supported: ${[...ALLOWED_DOMAINS].join(", ")}.`
      );
    }

    if (route.variables && route.variables.length > 0) {
      const missingRequired: string[] = [];
      for (const v of route.variables) {
        const hasDefault = v.default_value !== undefined && v.default_value !== "";
        const supplied = variables && v.name in variables;
        if (!hasDefault && !supplied) {
          missingRequired.push(v.name);
        }
      }
      if (missingRequired.length > 0) {
        return sendError(
          reply,
          400,
          "MISSING_VARIABLES",
          `Required variables not supplied: ${missingRequired.join(", ")}.`
        );
      }
    }

    const run: RouteRun = {
      run_id: newId("run"),
      skill_id: skill.skill_id,
      route_id: route.route_id,
      installed_skill_id: installedSkill.installed_skill_id,
      user_id: MOCK_USER_ID,
      domain: skill.domain,
      status: "pending",
      created_at: new Date().toISOString(),
      ...(agent_id ? { agent_id } : {}),
      ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
    };

    routeRuns.set(run.run_id, run);
    schedulePersist();

    return { ok: true, data: run };
  });

  /**
   * GET /api/route-runs
   *
   * List route runs. Optional filters: ?domain= and ?status=
   * Each result is joined with a skill and route summary.
   */
  server.get<{ Querystring: { domain?: string; status?: string } }>(
    "/api/route-runs",
    async (req) => {
      const { domain, status } = req.query;
      let list = Array.from(routeRuns.values()).filter((r) => r.user_id === MOCK_USER_ID);

      if (domain) list = list.filter((r) => r.domain === domain);
      if (status) list = list.filter((r) => r.status === status);

      const result = list
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((run) => {
          const skill = skills.get(run.skill_id);
          const route = routes.get(run.route_id);
          return {
            ...run,
            skill_summary: skill
              ? { skill_id: skill.skill_id, name: skill.name, domain: skill.domain }
              : null,
            route_summary: route
              ? {
                  route_id: route.route_id,
                  workflow_name: route.workflow_name,
                  trust_tier: route.trust_tier,
                  step_count: route.steps.length,
                }
              : null,
          };
        });

      return { ok: true, data: result };
    }
  );

  /**
   * POST /api/route-runs/:runId/complete
   *
   * Mark a run as completed.
   */
  server.post<{ Params: { runId: string } }>(
    "/api/route-runs/:runId/complete",
    async (req, reply) => {
      const run = routeRuns.get(req.params.runId);
      if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
      if (run.status === "completed" || run.status === "failed") {
        return sendError(reply, 409, "ALREADY_TERMINAL", `Run is already in terminal status "${run.status}".`);
      }

      run.status = "completed";
      run.completed_at = new Date().toISOString();
      routeRuns.set(run.run_id, run);
      schedulePersist();

      return { ok: true, data: run };
    }
  );

  /**
   * POST /api/route-runs/:runId/fail
   *
   * Mark a run as failed. Body: { "error": "reason" }
   */
  server.post<{
    Params: { runId: string };
    Body: { error?: string };
  }>("/api/route-runs/:runId/fail", async (req, reply) => {
    const run = routeRuns.get(req.params.runId);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Route run not found.");
    if (run.status === "completed" || run.status === "failed") {
      return sendError(reply, 409, "ALREADY_TERMINAL", `Run is already in terminal status "${run.status}".`);
    }

    run.status = "failed";
    run.completed_at = new Date().toISOString();
    if (req.body?.error) run.error = req.body.error;
    routeRuns.set(run.run_id, run);
    schedulePersist();

    return { ok: true, data: run };
  });
}
