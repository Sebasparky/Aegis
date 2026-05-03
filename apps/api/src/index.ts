import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
const __filename = fileURLToPath(import.meta.url);
dotenv.config({ path: resolve(dirname(__filename), "../../../.env") });

import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadStore } from "./store/persistence.js";
import { userRoutes } from "./routes/user.js";
import { collarRoutes } from "./routes/collars.js";
import { passRoutes } from "./routes/passes.js";
import { sessionRoutes } from "./routes/sessions.js";
import { approvalRoutes } from "./routes/approvals.js";
import { receiptRoutes } from "./routes/receipts.js";
import { reputationRoutes } from "./routes/reputation.js";
import { aegisIdRoutes } from "./routes/aegis-id.js";
import { websiteAegisIdRoutes } from "./routes/website-aegis-id.js";
import { counterpartyRoutes } from "./routes/counterparty.js";
import { agentRoutes } from "./routes/agent.js";
import { runnerRoutes } from "./routes/runners.js";
import { taskRoutes } from "./routes/tasks.js";
import { delegationRoutes } from "./routes/delegations.js";
import { routeRoutes } from "./routes/routes.js";
import { skillRoutes } from "./routes/skills.js";
import { routeRunRoutes } from "./routes/route-runs.js";
import { actionRoutes } from "./routes/action.js";
import { vaultPassRoutes } from "./routes/vault-passes.js";
import { routePassBindingRoutes } from "./routes/route-pass-bindings.js";
import { credentialSessionRoutes } from "./routes/credential-sessions.js";
import { runtimeSessionRoutes } from "./routes/runtime-sessions.js";
import { delegationPassportRoutes } from "./routes/delegation-passports.js";
import { actionAuthorizationRoutes } from "./routes/action-authorizations.js";
import { delegationTrustRoutes } from "./routes/delegation-trust.js";
import { websiteAssertionRoutes } from "./routes/website-assertions.js";
import { devRoutes } from "./routes/dev.js";

async function main() {
  await loadStore();

  // Validate Supabase credentials at startup when supabase persistence is enabled.
  if (process.env.AEGIS_PERSISTENCE_PROVIDER === "supabase") {
    const { getSupabaseAdminClient } = await import("./lib/supabase.js");
    getSupabaseAdminClient();
    console.log("[startup] Supabase persistence provider active.");
  }

  const server = Fastify({ logger: { level: "info" } });

  await server.register(cors, {
    origin: ["http://localhost:3000", "http://localhost:3001"],
  });

  server.get("/health", async () => {
    return { ok: true, data: { status: "healthy" } };
  });

  server.get("/", async () => {
    return { ok: true, data: { name: "Aegis API", version: "0.1.0" } };
  });

  await server.register(userRoutes);
  await server.register(collarRoutes);
  await server.register(passRoutes);
  await server.register(sessionRoutes);
  await server.register(approvalRoutes);
  await server.register(receiptRoutes);
  await server.register(reputationRoutes);
  await server.register(aegisIdRoutes);
  await server.register(websiteAegisIdRoutes);
  await server.register(counterpartyRoutes);
  await server.register(agentRoutes);
  await server.register(runnerRoutes);
  await server.register(taskRoutes);
  await server.register(delegationRoutes);
  await server.register(routeRoutes);
  await server.register(skillRoutes);
  await server.register(routeRunRoutes);
  await server.register(actionRoutes);
  await server.register(vaultPassRoutes);
  await server.register(routePassBindingRoutes);
  await server.register(credentialSessionRoutes);
  await server.register(runtimeSessionRoutes);
  await server.register(delegationPassportRoutes);
  await server.register(actionAuthorizationRoutes);
  await server.register(delegationTrustRoutes);
  await server.register(websiteAssertionRoutes);

  if (process.env.NODE_ENV !== "production") {
    await server.register(devRoutes);
  }

  await server.listen({ port: 4000, host: "0.0.0.0" });
  console.log("Aegis API running on http://localhost:4000");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
