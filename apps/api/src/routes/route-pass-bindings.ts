import type { FastifyInstance } from "fastify";
import type { RoutePassBinding } from "@aegis/types";
import { routePassBindings, aegisVaultPasses, routes, MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

function bindingKey(user_id: string, route_id: string, purpose: string) {
  return `${user_id}:${route_id}:${purpose}`;
}

export async function routePassBindingRoutes(server: FastifyInstance) {
  /**
   * GET /api/route-pass-bindings
   * List all route-to-pass bindings for the current user.
   * Optionally filter by route_id.
   */
  server.get<{ Querystring: { route_id?: string } }>("/api/route-pass-bindings", async (req) => {
    const { route_id } = req.query;
    const all = Array.from(routePassBindings.values()).filter(
      (b) => b.user_id === MOCK_USER_ID && (!route_id || b.route_id === route_id)
    );
    return { ok: true, data: all };
  });

  /**
   * POST /api/route-pass-bindings
   * Create or replace the binding for a given route + purpose.
   * Upserts using key `${user_id}:${route_id}:${purpose}`.
   */
  server.post<{
    Body: { route_id: string; pass_id: string; purpose?: "login_password" };
  }>("/api/route-pass-bindings", async (req, reply) => {
    const { route_id, pass_id, purpose = "login_password" } = req.body ?? {};

    if (!route_id?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "route_id is required." } });
    if (!pass_id?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "pass_id is required." } });

    const route = routes.get(route_id);
    if (!route)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });

    const pass = aegisVaultPasses.get(pass_id);
    if (!pass || pass.user_id !== MOCK_USER_ID)
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Vault pass not found." } });

    if (pass.kind !== "login_password")
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Pass kind must be login_password for v1." } });

    if (pass.domain !== route.domain)
      return reply.status(400).send({ ok: false, error: { code: "DOMAIN_MISMATCH", message: `Pass domain "${pass.domain}" does not match route domain "${route.domain}".` } });

    const key = bindingKey(MOCK_USER_ID, route_id, purpose);
    const now = new Date().toISOString();
    const existing = routePassBindings.get(key);

    const binding: RoutePassBinding = {
      binding_id: existing?.binding_id ?? newId("binding"),
      user_id: MOCK_USER_ID,
      route_id,
      pass_id,
      purpose,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    routePassBindings.set(key, binding);
    schedulePersist();

    return reply.status(existing ? 200 : 201).send({ ok: true, data: binding });
  });

  /**
   * DELETE /api/route-pass-bindings
   * Remove binding for a given route + purpose, restoring default step pass.
   */
  server.delete<{
    Body: { route_id: string; purpose?: "login_password" };
  }>("/api/route-pass-bindings", async (req, reply) => {
    const { route_id, purpose = "login_password" } = req.body ?? {};

    if (!route_id?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "route_id is required." } });

    const key = bindingKey(MOCK_USER_ID, route_id, purpose);
    if (!routePassBindings.has(key))
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Binding not found." } });

    routePassBindings.delete(key);
    schedulePersist();

    return { ok: true };
  });
}
