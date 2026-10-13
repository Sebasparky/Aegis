import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { readFile } from "fs/promises";
const __filename = fileURLToPath(import.meta.url);
dotenv.config({ path: resolve(dirname(__filename), "../../../.env") });

import Fastify from "fastify";
import cors from "@fastify/cors";
import { resolveApiBindHost, formatApiBindBanner } from "./lib/apiBindHost.js";
import multipart from "@fastify/multipart";
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
import { agentConnectorRoutes } from "./routes/agent-connectors.js";
import { routeRoutes } from "./routes/routes.js";
import { skillRoutes } from "./routes/skills.js";
import { routeRunRoutes } from "./routes/route-runs.js";
import { actionRoutes } from "./routes/action.js";
import { vaultPassRoutes } from "./routes/vault-passes.js";
import { paymentMethodRoutes } from "./routes/payment-methods.js";
import { kmsAuditRoutes } from "./routes/kms-audit.js";
import { routePassBindingRoutes } from "./routes/route-pass-bindings.js";
import { credentialSessionRoutes } from "./routes/credential-sessions.js";
import { runtimeSessionRoutes } from "./routes/runtime-sessions.js";
import { delegationPassportRoutes } from "./routes/delegation-passports.js";
import { actionAuthorizationRoutes } from "./routes/action-authorizations.js";
import { userApprovalReceiptRoutes } from "./routes/user-approval-receipts.js";
import { websiteTrustProfileRoutes } from "./routes/website-trust-profiles.js";
import { websiteViolationReceiptRoutes } from "./routes/website-violation-receipts.js";
import { delegationTrustRoutes } from "./routes/delegation-trust.js";
import { websiteAssertionRoutes } from "./routes/website-assertions.js";
import { runtimeObservationRoutes } from "./routes/runtime-observations.js";
import { websiteAgentSafetyRoutes } from "./routes/website-agent-safety.js";
import { websiteAegisPolicyRoutes } from "./routes/website-aegis-policy.js";
import { agentApiRoutes } from "./routes/agent-api.js";
import { authenticatedSessionRoutes } from "./routes/authenticated-sessions.js";
import { secretFieldInjectionRoutes } from "./routes/secret-field-injections.js";
import { paymentCardFillRoutes } from "./routes/payment-card-fills.js";
import { purchaseConfirmationRoutes } from "./routes/purchase-confirmations.js";
import { profileFieldFillRoutes } from "./routes/profile-field-fills.js";
import { profileMemoryRequestRoutes } from "./routes/profile-memory-requests.js";
import { accountCreationRoutes } from "./routes/account-creation.js";
import { taskBrowserSessionRoutes } from "./routes/task-browser-sessions.js";
import {
  expireInactiveTaskBrowserSessions,
  cleanupOrphanedBrowserProcesses,
  closeAllTaskBrowserSessions,
} from "./runtime/taskBrowserSessions.js";
import { securityChallengeRoutes } from "./routes/security-challenges.js";
import { humanVerificationRoutes } from "./routes/human-verification.js";
import { visualGestureCapsuleRoutes } from "./routes/visual-gesture-capsules.js";
import { emailChallengeResolverRoutes } from "./routes/email-challenge-resolver.js";
import { sensitiveReceiptsRouter } from "./routes/sensitive-receipts.js";
import { browserRunTraceRoutes } from "./routes/browser-run-trace.js";
import { sensitiveGrantRoutes } from "./routes/sensitive-grants.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { verificationRoutes } from "./routes/verifications.js";
import { runtimeStatusRoutes } from "./routes/runtime-status.js";
import { formatAntigenRuntimeFlagsLine } from "./runtime/antigenRuntimeFlags.js";
import { devRoutes } from "./routes/dev.js";

async function main() {
  // Network boundary first: internal routes have no auth, so refuse any non-loopback bind
  // before touching the store or spawning anything (throws UnsafeApiBindHostError).
  const bind = resolveApiBindHost();

  await loadStore();
  expireInactiveTaskBrowserSessions();
  await cleanupOrphanedBrowserProcesses();

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

  await server.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, fieldSize: 1024 },
  });

  server.get("/health", async () => {
    return { ok: true, data: { status: "healthy" } };
  });

  server.get("/", async () => {
    return { ok: true, data: { name: "Antigen API", version: "0.1.0" } };
  });

  server.get<{ Params: { filename: string } }>(
    "/api/route-preview-assets/:filename",
    async (req, reply) => {
      const { filename } = req.params;
      if (!/^[a-zA-Z0-9_-]+\.(png|webm|mp4)$/.test(filename)) {
        return reply.status(400).send({ ok: false, error: { code: "INVALID_FILENAME", message: "Invalid filename." } });
      }
      const contentType = filename.endsWith(".webm") ? "video/webm"
        : filename.endsWith(".mp4") ? "video/mp4"
        : "image/png";
      const previewDir = join(dirname(fileURLToPath(import.meta.url)), "../.data/route-previews");
      try {
        const buf = await readFile(join(previewDir, filename));
        reply.header("Content-Type", contentType);
        reply.header("Cache-Control", "public, max-age=86400");
        return reply.send(buf);
      } catch {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Preview asset not found." } });
      }
    }
  );

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
  await server.register(agentConnectorRoutes);
  await server.register(routeRoutes);
  await server.register(skillRoutes);
  await server.register(routeRunRoutes);
  await server.register(actionRoutes);
  await server.register(vaultPassRoutes);
  await server.register(paymentMethodRoutes);
  await server.register(kmsAuditRoutes);
  await server.register(routePassBindingRoutes);
  await server.register(credentialSessionRoutes);
  await server.register(runtimeSessionRoutes);
  await server.register(delegationPassportRoutes);
  await server.register(actionAuthorizationRoutes);
  await server.register(userApprovalReceiptRoutes);
  await server.register(delegationTrustRoutes);
  await server.register(websiteAssertionRoutes);
  await server.register(runtimeObservationRoutes);
  await server.register(websiteAgentSafetyRoutes);
  await server.register(websiteAegisPolicyRoutes);
  await server.register(websiteTrustProfileRoutes);
  await server.register(websiteViolationReceiptRoutes);
  await server.register(authenticatedSessionRoutes);
  await server.register(secretFieldInjectionRoutes);
  await server.register(paymentCardFillRoutes);
  await server.register(purchaseConfirmationRoutes);
  await server.register(profileFieldFillRoutes);
  await server.register(profileMemoryRequestRoutes);
  await server.register(accountCreationRoutes);
  await server.register(taskBrowserSessionRoutes);
  await server.register(securityChallengeRoutes);
  await server.register(humanVerificationRoutes);
  await server.register(visualGestureCapsuleRoutes);
  await server.register(emailChallengeResolverRoutes);
  await server.register(sensitiveReceiptsRouter);
  await server.register(browserRunTraceRoutes);
  await server.register(sensitiveGrantRoutes);
  await server.register(workspaceRoutes);
  await server.register(verificationRoutes);
  await server.register(runtimeStatusRoutes);
  await server.register(agentApiRoutes);

  if (process.env.NODE_ENV !== "production") {
    await server.register(devRoutes);
  }

  await server.listen({ port: 4000, host: bind.host });
  console.log(formatApiBindBanner(bind, 4000, server.addresses()));
  console.log(formatAntigenRuntimeFlagsLine());

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[shutdown] Closing all task browser sessions...");
    await closeAllTaskBrowserSessions();
    await server.close();
  };
  process.on("SIGTERM", () => { shutdown().catch(console.error); });
  process.on("SIGINT", () => { shutdown().catch(console.error); });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
