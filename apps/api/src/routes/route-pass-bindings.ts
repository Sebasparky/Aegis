import type { FastifyInstance } from "fastify";
import type { RoutePassBinding } from "@aegis/types";
import { routePassBindings, routes, MOCK_USER_ID, newId, makePassBindingKey } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function routePassBindingRoutes(server: FastifyInstance) {
  server.get<{ Querystring: { route_id?: string } }>("/api/route-pass-bindings", async (req) => {
    const { route_id } = req.query;

    if (route_id) {
      const key = makePassBindingKey(MOCK_USER_ID, route_id, "login_password");
      const binding = routePassBindings.get(key);
      return { ok: true, data: binding ? [binding] : [] };
    }

    const all = Array.from(routePassBindings.values()).filter(
      (b) => b.user_id === MOCK_USER_ID
    );
    return { ok: true, data: all };
  });

  server.post<{
    Body: { route_id: string; pass_id: string; purpose?: "login_password" };
  }>("/api/route-pass-bindings", async (req, reply) => {
    const { route_id, pass_id, purpose = "login_password" } = req.body ?? {};

    if (!route_id?.trim()) return sendError(reply, 400, "VALIDATION_ERROR", "route_id is required.");
    if (!pass_id?.trim()) return sendError(reply, 400, "VALIDATION_ERROR", "pass_id is required.");

    const route = routes.get(route_id);
    if (!route) return sendError(reply, 404, "NOT_FOUND", "Route not found.");

    const pass = await getVaultRepository().getVaultPass(pass_id);
    if (!pass || pass.user_id !== MOCK_USER_ID) return sendError(reply, 404, "NOT_FOUND", "Vault pass not found.");
    if (pass.kind !== "login_password") return sendError(reply, 400, "VALIDATION_ERROR", "Pass kind must be login_password for v1.");
    if (pass.domain !== route.domain) return sendError(reply, 400, "DOMAIN_MISMATCH", `Pass domain "${pass.domain}" does not match route domain "${route.domain}".`);

    const key = makePassBindingKey(MOCK_USER_ID, route_id, purpose);
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

  server.delete<{
    Body: { route_id: string; purpose?: "login_password" };
  }>("/api/route-pass-bindings", async (req, reply) => {
    const { route_id, purpose = "login_password" } = req.body ?? {};

    if (!route_id?.trim()) return sendError(reply, 400, "VALIDATION_ERROR", "route_id is required.");

    const key = makePassBindingKey(MOCK_USER_ID, route_id, purpose);
    if (!routePassBindings.has(key)) return sendError(reply, 404, "NOT_FOUND", "Binding not found.");

    routePassBindings.delete(key);
    schedulePersist();

    return { ok: true };
  });
}
